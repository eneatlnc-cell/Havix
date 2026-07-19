/**
 * M8.3 4 节点集成测试
 * ───────────────────────────────────────────────
 * 测试目标：在真实 4 节点网络中验证 M1-M8 全部能力端到端可用。
 *
 * 拓扑：star（中心节点 A，叶子节点 B/C/D 通过 bootstrap 连到 A）
 *   A (9801)  ←  B (9802)
 *     ↑           ↑
 *   C (9803)     D (9804)
 *
 * 设计原则：
 *   - 真实启动 4 个 SNode 进程内实例（in-process），各自独立端口 + 独立 dataDir
 *   - 禁用 mDNS（强制走 bootstrap，确定性）；禁用 web/repl（避免端口/readline 冲突）
 *   - HAVIX_SKIP_E2E=1 跳过（与 bootstrap-e2e / dht-gate-e2e 一致，CI 慢机可跳过）
 *   - 端口段 9801-9804（避开 bootstrap-e2e 的 9701-9703 与 dht-gate-e2e 的 9401-9402）
 *
 * M8.3-1：4 节点 harness + star 拓扑连接验证
 *   - 4 节点全部启动成功（各有 peerId）
 *   - B/C/D 各自通过 bootstrap 连到 A（neighbors.size === 1）
 *   - A 看到 3 个邻居（B、C、D）
 *   - 4 节点都订阅了 3 个公共层 topic（announce / reputation / alert）
 *
 * M8.3-2：gossipsub 公共层消息跨节点传播
 *   - vouch 跨节点传播（A vouch B 的 context-D DID → B/C/D vouchRegistry 累积 +1）
 *   - wiki-announce 跨节点传播（A 达阈值后 publishEntry → B/C/D wiki.entries 索引到 manifest）
 *   - credit 跨节点镜像（A issueCredit → B/C/D creditLedger + reputationLedger.frozen 同步）
 *
 * M8.3-3：持久化 + 重启恢复端到端
 *   - 节点 stop → 重新 start（同 dataDir）→ 8 个 ledger 全部从磁盘恢复
 *   - 验证 external-holder 的 credit 余额跨重启保持
 *   - 验证 nonce 去重集合跨重启保持（防双花重放）
 *
 * 设计注意：
 *   - libp2p 重启后 peerId + 4-context DID 全部变化（随机密钥对），
 *     所以持久化的 DID-keyed 状态变成"无主"（orphan）状态，
 *     但旧 DID 的 ledger 数据仍可被查询（getBalance(anyDid) 仍能取到）
 *   - 真正可重启恢复的场景是：持久化的"外部 DID"数据（如 external-holder credit）跨重启保持
 *   - nonce 重放保护是跨重启的关键安全性质：重启后再次收到同一 nonce 消息应被拒绝
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { SNode } from '../src/s-node.js'
import { loadConfig } from '../src/config.js'
import { DEFAULT_TOPICS } from '../src/s-node.js'

const SKIP = process.env.HAVIX_SKIP_E2E === '1'

// ──────────────────────────────────────────────
// 测试专用端口 / dataDir
// ──────────────────────────────────────────────

const PORT_A = 9801
const PORT_B = 9802
const PORT_C = 9803
const PORT_D = 9804

/**
 * 构造测试配置。
 * @param {string} name   节点名（用于日志 + dataDir 命名）
 * @param {number} port   监听端口
 * @param {object} [extra]
 */
function makeConfig(name, port, extra = {}) {
  const c = loadConfig()
  c.name = name
  c.port = port
  c.logLevel = 'error'           // 静默大部分日志（失败时改 'info' 调试）
  c.dataDir = `.data-m83-${name}-${port}`
  c.mdns = false                 // 禁用 mDNS，强制走 bootstrap
  c.repl = false                 // 禁用 REPL（CI 无 stdin）
  c.web = false                  // 禁用 Web 面板（避免 7331 端口冲突）
  Object.assign(c, extra)
  return c
}

/**
 * 等待条件满足，超时抛错。
 * @param {() => boolean} cond      条件函数
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=15000]  超时
 * @param {number} [opts.intervalMs=250]   轮询间隔
 * @param {string} [opts.msg]             超时错误信息
 */
async function waitFor(cond, opts = {}) {
  const { timeoutMs = 15_000, intervalMs = 250, msg = '等待超时' } = opts
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (cond()) return
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(`${msg}（${timeoutMs}ms 内条件未满足）`)
}

/** 清理 dataDir（容错） */
function cleanupDataDir(node) {
  if (node?.config?.dataDir) {
    try { fs.rmSync(node.config.dataDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

// ──────────────────────────────────────────────
// M8.3-1: 4 节点 harness + star 拓扑连接验证
// ──────────────────────────────────────────────

test('M8.3-1 4 节点 star 拓扑连接', { skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用', timeout: 90_000 }, async (t) => {
  const nodes = []

  // 保证清理：即使中途断言失败也要停掉所有节点 + 删 dataDir
  t.after(async () => {
    for (const node of [...nodes].reverse()) {
      try { await node.stop() } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[teardown] 节点 ${node?.config?.name} stop 失败:`, err.message)
      }
    }
    for (const node of nodes) cleanupDataDir(node)
  })

  let nodeA, nodeB, nodeC, nodeD

  await t.test('setup: A 启动（中心节点，无 bootstrap）', async () => {
    nodeA = new SNode(makeConfig('alpha', PORT_A))
    await nodeA.start()
    nodes.push(nodeA)
    assert.ok(nodeA.peerId, 'A 应有 peerId')
    assert.equal(nodeA.neighbors.size, 0, 'A 初始无邻居')
  })

  await t.test('setup: B/C/D 通过 bootstrap 连到 A', async () => {
    const aMultiaddr = `/ip4/127.0.0.1/tcp/${PORT_A}/p2p/${nodeA.peerId.toString()}`

    nodeB = new SNode(makeConfig('beta', PORT_B, { bootstrap: [aMultiaddr] }))
    nodeC = new SNode(makeConfig('gamma', PORT_C, { bootstrap: [aMultiaddr] }))
    nodeD = new SNode(makeConfig('delta', PORT_D, { bootstrap: [aMultiaddr] }))

    await nodeB.start()
    await nodeC.start()
    await nodeD.start()
    nodes.push(nodeB, nodeC, nodeD)

    assert.ok(nodeB.peerId, 'B 应有 peerId')
    assert.ok(nodeC.peerId, 'C 应有 peerId')
    assert.ok(nodeD.peerId, 'D 应有 peerId')
  })

  await t.test('verify: B/C/D 各自连到 A（neighbors.size === 1）', async () => {
    await waitFor(() => nodeB.neighbors.size >= 1, {
      timeoutMs: 20_000, msg: 'B 未能在 20s 内连到 A',
    })
    await waitFor(() => nodeC.neighbors.size >= 1, {
      timeoutMs: 20_000, msg: 'C 未能在 20s 内连到 A',
    })
    await waitFor(() => nodeD.neighbors.size >= 1, {
      timeoutMs: 20_000, msg: 'D 未能在 20s 内连到 A',
    })

    assert.equal(nodeB.neighbors.size, 1, 'B 应只连到 A（1 个邻居）')
    assert.equal(nodeC.neighbors.size, 1, 'C 应只连到 A（1 个邻居）')
    assert.equal(nodeD.neighbors.size, 1, 'D 应只连到 A（1 个邻居）')

    const aPeerId = nodeA.peerId.toString()
    assert.ok(nodeB.neighbors.has(aPeerId), 'B 的邻居应是 A')
    assert.ok(nodeC.neighbors.has(aPeerId), 'C 的邻居应是 A')
    assert.ok(nodeD.neighbors.has(aPeerId), 'D 的邻居应是 A')
  })

  await t.test('verify: A 看到 3 个邻居（B、C、D）', async () => {
    await waitFor(() => nodeA.neighbors.size >= 3, {
      timeoutMs: 20_000, msg: 'A 未能在 20s 内感知到 3 个邻居',
    })
    assert.equal(nodeA.neighbors.size, 3, 'A 应有 3 个邻居（B/C/D）')

    assert.ok(nodeA.neighbors.has(nodeB.peerId.toString()), 'A 的邻居应包含 B')
    assert.ok(nodeA.neighbors.has(nodeC.peerId.toString()), 'A 的邻居应包含 C')
    assert.ok(nodeA.neighbors.has(nodeD.peerId.toString()), 'A 的邻居应包含 D')
  })

  await t.test('verify: 4 节点都订阅了 3 个公共层 topic', () => {
    for (const node of nodes) {
      const topics = node.libp2p.services.pubsub.getTopics()
      for (const topic of DEFAULT_TOPICS) {
        assert.ok(
          topics.includes(topic),
          `节点 ${node.config.name} 应订阅 ${topic}（实际：${topics.join(', ')}）`,
        )
      }
    }
  })
})

// ──────────────────────────────────────────────
// M8.3-2: gossipsub 公共层消息跨节点传播
// ──────────────────────────────────────────────
//
// 复用 M8.3-1 的 harness（同一份 setup），独立 test 块让 node:test 隔离状态。
// gossipsub 默认 emitSelf=false，发送方不会收到自己的消息，所以只断言接收方状态。

test('M8.3-2 gossipsub 跨节点消息传播', { skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用', timeout: 120_000 }, async (t) => {
  const nodes = []
  let nodeA, nodeB, nodeC, nodeD

  t.after(async () => {
    for (const node of [...nodes].reverse()) {
      try { await node.stop() } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[teardown] 节点 ${node?.config?.name} stop 失败:`, err.message)
      }
    }
    for (const node of nodes) cleanupDataDir(node)
  })

  await t.test('setup: 4 节点 star 拓扑就绪', async () => {
    nodeA = new SNode(makeConfig('alpha', PORT_A))
    await nodeA.start()
    nodes.push(nodeA)

    const aMultiaddr = `/ip4/127.0.0.1/tcp/${PORT_A}/p2p/${nodeA.peerId.toString()}`
    nodeB = new SNode(makeConfig('beta', PORT_B, { bootstrap: [aMultiaddr] }))
    nodeC = new SNode(makeConfig('gamma', PORT_C, { bootstrap: [aMultiaddr] }))
    nodeD = new SNode(makeConfig('delta', PORT_D, { bootstrap: [aMultiaddr] }))
    await nodeB.start()
    await nodeC.start()
    await nodeD.start()
    nodes.push(nodeB, nodeC, nodeD)

    // 等待 4 节点全联通（star：B/C/D→A 单向 + A→B/C/D 反向感知）
    await waitFor(() => nodeB.neighbors.size >= 1, { timeoutMs: 20_000, msg: 'B 未连到 A' })
    await waitFor(() => nodeC.neighbors.size >= 1, { timeoutMs: 20_000, msg: 'C 未连到 A' })
    await waitFor(() => nodeD.neighbors.size >= 1, { timeoutMs: 20_000, msg: 'D 未连到 A' })
    await waitFor(() => nodeA.neighbors.size >= 3, { timeoutMs: 20_000, msg: 'A 未看到 3 邻居' })
  })

  await t.test('vouch: A vouch endorseDid → B/C/D vouchRegistry 同步 +1', async () => {
    // endorseDid 是某个"第三方"context-D 子 DID（不在这 4 个节点里）
    // 任取 A 钱包 context-D 作为 endorseDid（用于测试传播；A 自己作为背书人）
    const endorseDid = 'did:havix:D:external-editor-xyz'

    const before = {
      B: nodeB.vouchRegistry.getVouchCount(endorseDid),
      C: nodeC.vouchRegistry.getVouchCount(endorseDid),
      D: nodeD.vouchRegistry.getVouchCount(endorseDid),
    }

    // A 用 context-A 子身份 vouch 这个外部 context-D DID
    const { recipients } = await nodeA.vouch(endorseDid, 'e2e-test vouch')

    // gossipsub 至少要送达 B/C/D 之一（star 拓扑下通常送达全部 3 个叶子）
    assert.ok(recipients >= 1, `vouch 应至少送达 1 个对端，实际 ${recipients}`)

    // 等待 B/C/D 接收并镜像（gossipsub mesh 建立 + 消息传播通常 <2s）
    await waitFor(() => nodeB.vouchRegistry.getVouchCount(endorseDid) > before.B, {
      timeoutMs: 10_000, msg: 'B 未收到 vouch',
    })
    await waitFor(() => nodeC.vouchRegistry.getVouchCount(endorseDid) > before.C, {
      timeoutMs: 10_000, msg: 'C 未收到 vouch',
    })
    await waitFor(() => nodeD.vouchRegistry.getVouchCount(endorseDid) > before.D, {
      timeoutMs: 10_000, msg: 'D 未收到 vouch',
    })

    // 各节点都应见到 1 次 vouch（来自 A 的 context-A 子 DID）
    assert.equal(
      nodeB.vouchRegistry.getVouchCount(endorseDid), before.B + 1,
      'B vouch 计数应 +1',
    )
    assert.equal(
      nodeC.vouchRegistry.getVouchCount(endorseDid), before.C + 1,
      'C vouch 计数应 +1',
    )
    assert.equal(
      nodeD.vouchRegistry.getVouchCount(endorseDid), before.D + 1,
      'D vouch 计数应 +1',
    )

    // voucherDid 应是 A 的 context-A 子 DID
    const aContextA = nodeA.wallet.get('A').did
    for (const node of [nodeB, nodeC, nodeD]) {
      const vouchers = node.vouchRegistry.getVouchers(endorseDid)
      assert.ok(
        vouchers.includes(aContextA),
        `${node.config.name} 应记录 vouch 来自 A 的 context-A DID`,
      )
    }
  })

  await t.test('wiki-announce: A 达阈值后 publishEntry → B/C/D 索引 manifest', async () => {
    // 让 A 给自己的 context-D 背书 2 次（来自不同背书人），达阈值 N=2
    // 这里用 A 自己 vouch 自己会失败（防自吹自擂），所以改用 reputationLedger.credit
    // 让 A 满足信誉加权阈值（M4 起可用信誉加权 score 替代计数）
    //
    // 简单方案：B、C 各自 vouch A 的 context-D DID → A 累积 2 个 vouch 满足计数阈值
    const aContextD = nodeA.wallet.get('D').did

    await nodeB.vouch(aContextD, 'B vouch A as editor')
    await nodeC.vouch(aContextD, 'C vouch A as editor')

    // 等待 A 本地收到 B 和 C 的 vouch
    await waitFor(() => nodeA.vouchRegistry.getVouchCount(aContextD) >= 2, {
      timeoutMs: 10_000, msg: 'A 未累积到 2 个 vouch',
    })

    // A 现在达阈值，可以 publishEntry
    const title = `e2e-test-${Date.now()}`
    const content = `Hello from A at ${new Date().toISOString()}`

    const publishResult = await nodeA.wiki.publishEntry({ title, content })
    const cid = publishResult.cid
    assert.ok(cid, 'A 应得到 CID')

    // 等待 B/C/D 收到 wiki-announce 并索引到本地
    await waitFor(() => nodeB.wiki.entries.has(cid), {
      timeoutMs: 15_000, msg: 'B 未索引到 wiki 条目',
    })
    await waitFor(() => nodeC.wiki.entries.has(cid), {
      timeoutMs: 15_000, msg: 'C 未索引到 wiki 条目',
    })
    await waitFor(() => nodeD.wiki.entries.has(cid), {
      timeoutMs: 15_000, msg: 'D 未索引到 wiki 条目',
    })

    // 验证 manifest 字段一致性
    for (const node of [nodeB, nodeC, nodeD]) {
      const entry = node.wiki.entries.get(cid)
      assert.ok(entry, `${node.config.name} 应有 manifest`)
      assert.equal(entry.cid, cid, `${node.config.name} manifest.cid 应匹配`)
      assert.equal(entry.title, title, `${node.config.name} manifest.title 应匹配`)
      assert.equal(entry.authorDid, aContextD, `${node.config.name} manifest.authorDid 应是 A 的 context-D`)
    }
  })

  await t.test('credit: A issueCredit → B/C/D 镜像 freeze + credit', async () => {
    // Faucet 要求 issuer 总信誉 ≥ minReputation (默认 10.0)，且 freeze(amount) 需 available ≥ amount。
    // M4 设计：信誉只通过 slash/issueCredit 副作用变化，无 gossipsub 同步。
    // 因此要让 4 节点都看到 A 的可用信誉 ≥ amount，必须在每个节点本地都先 credit A 一次。
    // 这模拟的是"A 已通过其他途径积累足够信誉"的稳态场景。
    const aContextA = nodeA.wallet.get('A').did
    const holderDid = 'did:havix:A:external-holder'

    // 在 4 个节点本地都给 A 涨到 50（够签发 10 credit 且保留 ≥10 minReputation）
    for (const node of nodes) {
      node.reputationLedger.credit(aContextA, 50)
    }

    const aRepBefore = nodeA.reputationLedger.getAvailable(aContextA)
    assert.equal(aRepBefore, 51, 'A 信誉应是 50+1（初始 1.0）')

    // 记录接收方初始状态
    const before = {
      B: {
        credit: nodeB.creditLedger.getBalance(holderDid),
        frozen: nodeB.reputationLedger.getAvailable(aContextA),
      },
      C: {
        credit: nodeC.creditLedger.getBalance(holderDid),
        frozen: nodeC.reputationLedger.getAvailable(aContextA),
      },
      D: {
        credit: nodeD.creditLedger.getBalance(holderDid),
        frozen: nodeD.reputationLedger.getAvailable(aContextA),
      },
    }

    // A 签发 10 credit 给 holderDid
    const amount = 10
    const { recipients } = await nodeA.issueCredit({ holderDid, amount })
    assert.ok(recipients >= 1, `credit 消息应至少送达 1 个对端，实际 ${recipients}`)

    // 等待 B/C/D 镜像本地账本
    await waitFor(() => nodeB.creditLedger.getBalance(holderDid) >= before.B.credit + amount, {
      timeoutMs: 10_000, msg: 'B 未镜像 credit 余额',
    })
    await waitFor(() => nodeC.creditLedger.getBalance(holderDid) >= before.C.credit + amount, {
      timeoutMs: 10_000, msg: 'C 未镜像 credit 余额',
    })
    await waitFor(() => nodeD.creditLedger.getBalance(holderDid) >= before.D.credit + amount, {
      timeoutMs: 10_000, msg: 'D 未镜像 credit 余额',
    })

    // 验证余额镜像
    assert.equal(
      nodeB.creditLedger.getBalance(holderDid), before.B.credit + amount,
      'B holder 余额应 +amount',
    )
    assert.equal(
      nodeC.creditLedger.getBalance(holderDid), before.C.credit + amount,
      'C holder 余额应 +amount',
    )
    assert.equal(
      nodeD.creditLedger.getBalance(holderDid), before.D.credit + amount,
      'D holder 余额应 +amount',
    )

    // 验证 issuer 信誉冻结镜像
    // getAvailable 返回 available 池（不含 frozen），签发后应减少 amount
    assert.equal(
      nodeB.reputationLedger.getAvailable(aContextA), before.B.frozen - amount,
      'B 应镜像冻结 A 的信誉',
    )
    assert.equal(
      nodeC.reputationLedger.getAvailable(aContextA), before.C.frozen - amount,
      'C 应镜像冻结 A 的信誉',
    )
    assert.equal(
      nodeD.reputationLedger.getAvailable(aContextA), before.D.frozen - amount,
      'D 应镜像冻结 A 的信誉',
    )
  })
})

// ──────────────────────────────────────────────
// M8.3-3: 持久化 + 重启恢复端到端
// ──────────────────────────────────────────────
//
// 用 2 节点（A 单独 + B 单独）即可验证持久化 + 重启恢复，不需要 4 节点完整 mesh。
// 测试场景：
//   1. A 启动，issueCredit 给 external-holder（A 本地落盘 + nonce 落盘）
//   2. A.stop()（flush 所有 registry）
//   3. A 同 dataDir 重新 start()（新 peerId / 新 DID，但 loadState 恢复旧数据）
//   4. 验证 external-holder 的 credit 余额跨重启保持 = 10
//   5. 验证 nonce 去重集合跨重启保持：再次传入同一 note → 拒绝（幂等）

test('M8.3-3 持久化 + 重启恢复', { skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用', timeout: 60_000 }, async (t) => {
  const nodes = []
  let nodeA

  t.after(async () => {
    for (const node of [...nodes].reverse()) {
      try { await node.stop() } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[teardown] 节点 ${node?.config?.name} stop 失败:`, err.message)
      }
    }
    for (const node of nodes) cleanupDataDir(node)
  })

  // 记录第一轮的关键状态，重启后比对
  let firstRun = {
    holderDid: null,
    creditBalance: null,
    nonce: null,
    note: null,
    issuerDid: null,
    creditNonceSetSize: 0,
  }

  await t.test('round 1: A 启动 + issueCredit 给 external-holder', async () => {
    nodeA = new SNode(makeConfig('alpha', PORT_A))
    await nodeA.start()
    nodes.push(nodeA)

    const aContextA = nodeA.wallet.get('A').did
    const holderDid = 'did:havix:A:external-holder'

    // 给 A 涨到 50（够签发 10 credit 且保留 ≥10 minReputation）
    nodeA.reputationLedger.credit(aContextA, 50)

    // A 签发 10 credit 给 holderDid
    const { note } = await nodeA.issueCredit({ holderDid, amount: 10 })

    firstRun = {
      holderDid,
      creditBalance: nodeA.creditLedger.getBalance(holderDid),
      nonce: note.nonce,
      note,
      issuerDid: note.issuerDid,
      creditNonceSetSize: nodeA._processedCreditNonces.size,
    }

    assert.equal(firstRun.creditBalance, 10, 'A 本地 holder 余额应为 10')
    assert.equal(firstRun.issuerDid, aContextA, 'issuerDid 应是 A 的 context-A')
    assert.ok(firstRun.nonce, 'note 应有 nonce')
    assert.equal(firstRun.creditNonceSetSize, 1, 'A nonce 集合应有 1 条')
  })

  await t.test('round 1: A.stop() flush 所有 ledger 到磁盘', async () => {
    await nodeA.stop()
    // stop 后 _flushAllRegistries 已调用，8 个 ledger 文件应存在
    const persistDir = nodeA.persistDir
    assert.ok(fs.existsSync(persistDir), `persistDir 应存在：${persistDir}`)

    const expectedFiles = [
      'reputation.json', 'credit.json', 'vouches.json', 'wiki-index.json',
      'arbitration.json', 'treasury.json', 'markets.json', 'credit-nonces.json',
    ]
    for (const f of expectedFiles) {
      const p = path.join(persistDir, f)
      assert.ok(fs.existsSync(p), `ledger 文件应存在：${f}`)
    }

    // 验证 credit.json 内容包含 external-holder 的余额
    const creditJson = JSON.parse(fs.readFileSync(path.join(persistDir, 'credit.json'), 'utf8'))
    const balances = new Map(creditJson.balances ?? [])
    assert.equal(balances.get(firstRun.holderDid), 10, '磁盘 credit.json 应含 holderDid=10')

    // 验证 credit-nonces.json 包含第一轮的 nonce
    const nonceJson = JSON.parse(fs.readFileSync(path.join(persistDir, 'credit-nonces.json'), 'utf8'))
    const nonces = nonceJson.nonces ?? []
    assert.ok(nonces.includes(firstRun.nonce), '磁盘 credit-nonces.json 应含第一轮 nonce')
  })

  await t.test('round 2: A 同 dataDir 重新 start() → 从磁盘恢复', async () => {
    // 重新构造同 dataDir 的配置（同端口）
    // 注意：libp2p 会重新生成随机密钥对 → 新 peerId / 新 4-context DID
    // 但 loadState 会从磁盘加载旧 DID 的 ledger 数据
    nodeA = new SNode(makeConfig('alpha', PORT_A))
    await nodeA.start()
    nodes.push(nodeA)

    // 验证 external-holder 余额跨重启保持
    const restoredBalance = nodeA.creditLedger.getBalance(firstRun.holderDid)
    assert.equal(restoredBalance, 10, '重启后 external-holder 余额应保持 10（从磁盘恢复）')

    // 验证 nonce 去重集合跨重启保持
    assert.equal(
      nodeA._processedCreditNonces.size, 1,
      '重启后 nonce 集合应含 1 条（从磁盘恢复）',
    )
    assert.ok(
      nodeA._processedCreditNonces.has(firstRun.nonce),
      '重启后 nonce 集合应含第一轮的 nonce',
    )
  })

  await t.test('replay protection: 重启后重放同 nonce note → 拒绝', async () => {
    // 构造一个完整的 credit 消息（包含外层 message 包装）
    // 注意：重启后 A 的新 context-A DID ≠ 原 issuerDid，但 message.senderId 用原 issuerDid
    // 模拟"攻击者重放历史消息"场景
    const replayMessage = {
      version: 1,
      type: 'credit',
      senderId: firstRun.issuerDid,   // 用第一轮的 issuerDid（与 note.issuerDid 一致）
      timestamp: Date.now(),
      payload: { note: firstRun.note },
    }

    const result = await nodeA._handleCreditMessage(replayMessage, { fromPeerId: null })

    assert.equal(result.applied, false, '重放同 nonce 消息应被拒绝（applied=false）')
    assert.ok(
      result.reason?.includes('幂等') || result.reason?.includes('已处理过'),
      `拒绝原因应含"幂等"，实际：${result.reason}`,
    )

    // 余额不变（防双花）
    const balanceAfterReplay = nodeA.creditLedger.getBalance(firstRun.holderDid)
    assert.equal(balanceAfterReplay, 10, '重放后余额应保持 10（未双花）')
  })

  await t.test('fresh issue: 重启后新 issueCredit → 正常应用（新 nonce）', async () => {
    // A 重启后用新 context-A DID 签发新 credit（新 nonce）应正常工作
    const newContextA = nodeA.wallet.get('A').did
    assert.notEqual(
      newContextA, firstRun.issuerDid,
      '重启后 A 的 context-A DID 应不同（libp2p 重新生成密钥对）',
    )

    // 给新 A 涨信誉（够签发）
    nodeA.reputationLedger.credit(newContextA, 50)

    const newHolderDid = 'did:havix:A:external-holder-2'
    const { note: newNote } = await nodeA.issueCredit({
      holderDid: newHolderDid,
      amount: 5,
    })

    // 新余额应为 5（与旧 holder 互不影响）
    assert.equal(
      nodeA.creditLedger.getBalance(newHolderDid), 5,
      '新 issueCredit 后新 holder 余额应为 5',
    )
    // 旧 holder 余额仍为 10（不受新 issue 影响）
    assert.equal(
      nodeA.creditLedger.getBalance(firstRun.holderDid), 10,
      '旧 holder 余额应仍为 10（未受新 issue 影响）',
    )
    // nonce 集合应增加（共 2 条）
    assert.equal(
      nodeA._processedCreditNonces.size, 2,
      'nonce 集合应含 2 条（旧 + 新）',
    )
    assert.ok(
      nodeA._processedCreditNonces.has(newNote.nonce),
      'nonce 集合应含新 nonce',
    )
  })
})
