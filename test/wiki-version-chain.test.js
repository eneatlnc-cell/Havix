// SPDX-License-Identifier: Apache-2.0

/**
 * M3.3 维基版本链单元测试
 * ───────────────────────────────────────────────
 * 测试范围：
 *   - publishEntry 接受 parentCid，根条目 parentCid=null
 *   - 续写时作者一致性校验（不一致抛 ParentCidMismatchError）
 *   - lazy 验证（父 CID 本地不存在时不阻塞发布）
 *   - handleAnnounce 归一化 parentCid（旧消息无字段视为根）
 *   - listHistory / getLineage / isRootEntry / getLatestVersion 查询接口
 *   - 防环保护
 *   - 签名覆盖 parentCid（篡改会被验签失败）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import process from 'node:process'
import { createHeliaLight } from 'helia'

import { IdentityWallet } from '../src/identity.js'
import {
  WikiProtocol,
  ParentCidMismatchError,
} from '../src/protocol/wiki.js'
import { MESSAGE_TYPES } from '../src/protocol/message-types.js'
import { verifyMessageSignature } from '../src/s-node.js'

const SKIP = process.env.HAVIX_SKIP_E2E === '1'

function makeMockPubsub() {
  const calls = []
  return {
    calls,
    publish: async (topic, bytes) => {
      calls.push({ topic, bytes })
      return { recipients: [] }
    },
  }
}

async function makeWallet(seedByte) {
  const seed = new Uint8Array(32).fill(seedByte)
  return await IdentityWallet.fromSeed(seed)
}

// ──────────────────────────────────────────────
// 基本版本链构造
// ──────────────────────────────────────────────

test('publishEntry：不传 parentCid 默认为根条目（parentCid=null）', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const wallet = await makeWallet(1)
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: wallet.get('D'),
    })
    const { cid, message } = await wiki.publishEntry({ title: 't', content: 'x' })

    // payload.parentCid 应为 null
    assert.equal(message.payload.parentCid, null)
    // manifest.parentCid 应为 null
    const entry = wiki.getEntry(cid)
    assert.equal(entry.parentCid, null)
    assert.ok(wiki.isRootEntry(cid), '无 parentCid 的应为根条目')
  } finally {
    await helia.stop()
  }
})

test('publishEntry：续写版本正确记录 parentCid', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const wallet = await makeWallet(2)
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: wallet.get('D'),
    })

    // 根版本
    const r1 = await wiki.publishEntry({ title: 'evolution', content: 'v1' })
    assert.equal(r1.message.payload.parentCid, null)

    // 续写 v2
    const r2 = await wiki.publishEntry({
      title: 'evolution',
      content: 'v2',
      parentCid: r1.cid,
    })
    assert.equal(r2.message.payload.parentCid, r1.cid)

    // 续写 v3
    const r3 = await wiki.publishEntry({
      title: 'evolution',
      content: 'v3',
      parentCid: r2.cid,
    })
    assert.equal(r3.message.payload.parentCid, r2.cid)

    // 链路应有 3 条
    assert.equal(wiki.listEntries().length, 3)
  } finally {
    await helia.stop()
  }
})

// ──────────────────────────────────────────────
// 作者一致性校验
// ──────────────────────────────────────────────

test('publishEntry：续写时作者不一致抛 ParentCidMismatchError', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const walletA = await makeWallet(10)
    const walletB = await makeWallet(11)

    // A 发布根版本
    const wikiA = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: walletA.get('D'),
    })
    const { cid: rootCid } = await wikiA.publishEntry({ title: 't', content: 'A的版本' })

    // B 用自己的 wallet 续写 A 的根版本 —— 应拒绝
    const wikiB = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: walletB.get('D'),
    })
    // 先把 A 的根版本索引到 wikiB（模拟 B 已收到 A 的 announce）
    wikiB.handleAnnounce({
      version: 'v1.0',
      type: MESSAGE_TYPES.WIKI_ANNOUNCE,
      senderId: walletA.get('D').did,
      timestamp: Date.now(),
      payload: { cid: rootCid, title: 't', timestamp: Date.now() },
    })

    await assert.rejects(
      () => wikiB.publishEntry({ title: 't', content: 'B想劫持', parentCid: rootCid }),
      (err) => {
        assert.equal(err.name, 'ParentCidMismatchError')
        assert.equal(err.code, 'PARENT_CID_AUTHOR_MISMATCH')
        assert.equal(err.parentCid, rootCid)
        assert.equal(err.expectedAuthor, walletA.get('D').did)
        assert.equal(err.actualAuthor, walletB.get('D').did)
        return true
      },
    )

    // B 不应有新条目
    assert.equal(wikiB.listEntries().length, 1)
  } finally {
    await helia.stop()
  }
})

test('publishEntry：父版本不在本地索引时 lazy 放行（不阻塞）', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const wallet = await makeWallet(20)
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: wallet.get('D'),
    })

    // 父 CID 是一个本地未索引的 CID（lazy 验证）
    const fakeParentCid = 'bafkreieq5j6a4g6p5q3w2y5l3a5r4n3g2z1m4r6k5l3a2s1d3f5g7h9j0k1l2m3n4o5p6'

    // 应能发布（lazy 放行）
    const { cid, message } = await wiki.publishEntry({
      title: 'lazy',
      content: 'content',
      parentCid: fakeParentCid,
    })
    assert.equal(message.payload.parentCid, fakeParentCid)

    const entry = wiki.getEntry(cid)
    assert.equal(entry.parentCid, fakeParentCid)
    assert.equal(wiki.isRootEntry(cid), false)
  } finally {
    await helia.stop()
  }
})

test('publishEntry：parentCid 为空字符串/undefined/null 都归一化为根条目', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const wallet = await makeWallet(30)
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: wallet.get('D'),
    })

    // 注：3 个 content 必须不同，否则同 content 同 CID 会触发幂等去重
    const variants = [
      { pc: undefined, content: 'content-1' },
      { pc: null, content: 'content-2' },
      { pc: '', content: 'content-3' },
    ]
    for (const { pc, content } of variants) {
      const { message } = await wiki.publishEntry({ title: 't', content, parentCid: pc })
      assert.equal(message.payload.parentCid, null, `parentCid=${JSON.stringify(pc)} 应归一为 null`)
    }
    assert.equal(wiki.listEntries().length, 3)
  } finally {
    await helia.stop()
  }
})

// ──────────────────────────────────────────────
// handleAnnounce 兼容旧消息（无 parentCid 字段）
// ──────────────────────────────────────────────

test('handleAnnounce：旧消息无 parentCid 字段时视为根条目', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const wallet = await makeWallet(40)
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: wallet.get('D'),
    })

    // 旧消息（M3.1 风格）：payload 无 parentCid 字段
    const oldMessage = {
      version: 'v1.0',
      type: MESSAGE_TYPES.WIKI_ANNOUNCE,
      senderId: wallet.get('D').did,
      timestamp: Date.now(),
      payload: { cid: 'bafkreifake', title: 'old', timestamp: Date.now() },
    }

    const r = wiki.handleAnnounce(oldMessage)
    assert.equal(r.indexed, true)
    const entry = wiki.getEntry('bafkreifake')
    assert.equal(entry.parentCid, null, '旧消息应视为根条目')
    assert.ok(wiki.isRootEntry('bafkreifake'))
  } finally {
    await helia.stop()
  }
})

test('handleAnnounce：新消息带 parentCid 时正确索引', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const wallet = await makeWallet(41)
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: wallet.get('D'),
    })

    // 先放一个根条目
    const root = {
      version: 'v1.0',
      type: MESSAGE_TYPES.WIKI_ANNOUNCE,
      senderId: wallet.get('D').did,
      timestamp: Date.now(),
      payload: { cid: 'bafkrei-root', title: 't', timestamp: Date.now(), parentCid: null },
    }
    wiki.handleAnnounce(root)

    // 再放一个续写条目
    const child = {
      version: 'v1.0',
      type: MESSAGE_TYPES.WIKI_ANNOUNCE,
      senderId: wallet.get('D').did,
      timestamp: Date.now(),
      payload: { cid: 'bafkrei-child', title: 't', timestamp: Date.now(), parentCid: 'bafkrei-root' },
    }
    wiki.handleAnnounce(child)

    const entry = wiki.getEntry('bafkrei-child')
    assert.equal(entry.parentCid, 'bafkrei-root')
    assert.equal(wiki.isRootEntry('bafkrei-child'), false)
    assert.equal(wiki.isRootEntry('bafkrei-root'), true)
  } finally {
    await helia.stop()
  }
})

// ──────────────────────────────────────────────
// listHistory / getLineage / getLatestVersion
// ──────────────────────────────────────────────

test('listHistory：按 timestamp 升序列出同标题版本', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const wallet = await makeWallet(50)
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: wallet.get('D'),
    })

    const r1 = await wiki.publishEntry({ title: 'history', content: 'v1' })
    await new Promise(r => setTimeout(r, 5))
    const r2 = await wiki.publishEntry({ title: 'history', content: 'v2', parentCid: r1.cid })
    await new Promise(r => setTimeout(r, 5))
    const r3 = await wiki.publishEntry({ title: 'history', content: 'v3', parentCid: r2.cid })

    // 另一个标题的条目不应混入
    await wiki.publishEntry({ title: 'other', content: 'x' })

    const history = wiki.listHistory('history')
    assert.equal(history.length, 3)
    assert.equal(history[0].cid, r1.cid)
    assert.equal(history[1].cid, r2.cid)
    assert.equal(history[2].cid, r3.cid)
    assert.ok(history[0].timestamp <= history[1].timestamp)
    assert.ok(history[1].timestamp <= history[2].timestamp)
  } finally {
    await helia.stop()
  }
})

test('getLineage：从最新版本回溯到根', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const wallet = await makeWallet(51)
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: wallet.get('D'),
    })

    const r1 = await wiki.publishEntry({ title: 'lineage', content: 'v1' })
    await new Promise(r => setTimeout(r, 5))
    const r2 = await wiki.publishEntry({ title: 'lineage', content: 'v2', parentCid: r1.cid })
    await new Promise(r => setTimeout(r, 5))
    const r3 = await wiki.publishEntry({ title: 'lineage', content: 'v3', parentCid: r2.cid })

    const lineage = wiki.getLineage(r3.cid)
    assert.equal(lineage.length, 3)
    // 按 time 倒序（最新在前）
    assert.equal(lineage[0].cid, r3.cid)
    assert.equal(lineage[1].cid, r2.cid)
    assert.equal(lineage[2].cid, r1.cid)
    // 根条目应在最后
    assert.ok(wiki.isRootEntry(lineage[lineage.length - 1].cid))
  } finally {
    await helia.stop()
  }
})

test('getLineage：未知 CID 返回空数组', () => {
  const wallet = { get: () => ({ did: 'x' }) }
  const wiki = new WikiProtocol({
    helia: {},
    pubsub: {},
    editorIdentity: wallet.get('D'),
  })
  const lineage = wiki.getLineage('bafkrei-unknown')
  assert.equal(lineage.length, 0)
})

test('getLineage：链中含未知 parentCid 时停止回溯（lazy）', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const wallet = await makeWallet(52)
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: wallet.get('D'),
    })

    // 直接 handleAnnounce 一个引用了未知 parentCid 的条目
    wiki.handleAnnounce({
      version: 'v1.0',
      type: MESSAGE_TYPES.WIKI_ANNOUNCE,
      senderId: wallet.get('D').did,
      timestamp: Date.now(),
      payload: {
        cid: 'bafkrei-orphan',
        title: 'orphan',
        timestamp: Date.now(),
        parentCid: 'bafkrei-unknown-parent',
      },
    })

    const lineage = wiki.getLineage('bafkrei-orphan')
    // 只能回溯到自己，parent 未知
    assert.equal(lineage.length, 1)
    assert.equal(lineage[0].cid, 'bafkrei-orphan')
  } finally {
    await helia.stop()
  }
})

test('getLineage：防环保护（脏数据下不无限循环）', () => {
  const wiki = new WikiProtocol({
    helia: {},
    pubsub: {},
    editorIdentity: { did: 'x' },
  })

  // 手动构造环：A → B → A
  wiki._indexEntry({ cid: 'A', title: 't', authorDid: 'x', timestamp: 1, parentCid: 'B', fromPeerId: null })
  wiki._indexEntry({ cid: 'B', title: 't', authorDid: 'x', timestamp: 2, parentCid: 'A', fromPeerId: null })

  const lineage = wiki.getLineage('A')
  // 应在检测到环时停止，不会无限循环
  assert.ok(lineage.length <= 2, `防环应限制 ≤2，实际 ${lineage.length}`)
  assert.equal(lineage[0].cid, 'A')
})

test('getLatestVersion：返回同作者同标题的最新版本', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const walletA = await makeWallet(60)
    const walletB = await makeWallet(61)
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: walletA.get('D'),
    })

    // A 写两个版本
    const a1 = await wiki.publishEntry({ title: 'shared', content: 'A1' })
    await new Promise(r => setTimeout(r, 5))
    const a2 = await wiki.publishEntry({ title: 'shared', content: 'A2', parentCid: a1.cid })

    // 模拟 B 也写过同标题（用 handleAnnounce 注入）
    wiki.handleAnnounce({
      version: 'v1.0',
      type: MESSAGE_TYPES.WIKI_ANNOUNCE,
      senderId: walletB.get('D').did,
      timestamp: Date.now() + 100,
      payload: { cid: 'bafkrei-b1', title: 'shared', timestamp: Date.now() + 100, parentCid: null },
    })

    // A 的最新版本应是 a2
    const latestA = wiki.getLatestVersion('shared', walletA.get('D').did)
    assert.ok(latestA)
    assert.equal(latestA.cid, a2.cid)

    // B 的最新版本应是 b1
    const latestB = wiki.getLatestVersion('shared', walletB.get('D').did)
    assert.ok(latestB)
    assert.equal(latestB.cid, 'bafkrei-b1')

    // 未知作者返回 undefined
    const latestX = wiki.getLatestVersion('shared', 'did:unknown')
    assert.equal(latestX, undefined)
  } finally {
    await helia.stop()
  }
})

// ──────────────────────────────────────────────
// 签名覆盖 parentCid（篡改 parentCid 会验签失败）
// ──────────────────────────────────────────────

test('签名覆盖 parentCid：篡改 parentCid 字段会验签失败', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const wallet = await makeWallet(70)
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: wallet.get('D'),
    })

    const r1 = await wiki.publishEntry({ title: 'sig', content: 'root' })
    const r2 = await wiki.publishEntry({ title: 'sig', content: 'v2', parentCid: r1.cid })

    // 验签原始消息应通过
    const verify1 = await verifyMessageSignature(r2.message)
    assert.equal(verify1.valid, true)

    // 篡改 parentCid
    const tampered = JSON.parse(JSON.stringify(r2.message))
    tampered.payload.parentCid = 'bafkrei-fake'
    const verify2 = await verifyMessageSignature(tampered)
    assert.equal(verify2.valid, false, '篡改 parentCid 后应验签失败')
  } finally {
    await helia.stop()
  }
})

// ──────────────────────────────────────────────
// 端到端：跨节点版本链传递
// ──────────────────────────────────────────────

test('端到端：A 发布 v1→v2→v3，B 收到消息后能重建版本链', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const heliaA = await createHeliaLight()
  await heliaA.start()
  const heliaB = await createHeliaLight()
  await heliaB.start()
  try {
    // A 发布 3 个版本
    const walletA = await makeWallet(80)
    const wikiA = new WikiProtocol({
      helia: heliaA,
      pubsub: makeMockPubsub(),
      editorIdentity: walletA.get('D'),
    })
    const r1 = await wikiA.publishEntry({ title: 'e2e', content: 'v1' })
    await new Promise(r => setTimeout(r, 5))
    const r2 = await wikiA.publishEntry({ title: 'e2e', content: 'v2', parentCid: r1.cid })
    await new Promise(r => setTimeout(r, 5))
    const r3 = await wikiA.publishEntry({ title: 'e2e', content: 'v3', parentCid: r2.cid })

    // B 收到 3 条 announce 消息（按时间顺序到达）
    const walletB = await makeWallet(81)
    const wikiB = new WikiProtocol({
      helia: heliaB,
      pubsub: makeMockPubsub(),
      editorIdentity: walletB.get('D'),
    })
    // 注：实际链路是 gossipsub 自动投递；这里手动模拟
    wikiB.handleAnnounce(r1.message)
    wikiB.handleAnnounce(r2.message)
    wikiB.handleAnnounce(r3.message)

    // B 应能重建完整版本链
    const lineage = wikiB.getLineage(r3.cid)
    assert.equal(lineage.length, 3)
    assert.equal(lineage[0].cid, r3.cid)
    assert.equal(lineage[1].cid, r2.cid)
    assert.equal(lineage[2].cid, r1.cid)
    assert.ok(wikiB.isRootEntry(r1.cid))

    // B 的 listHistory 应有 3 个版本
    assert.equal(wikiB.listHistory('e2e').length, 3)

    // B 的 getLatestVersion 应返回 r3
    const latest = wikiB.getLatestVersion('e2e', walletA.get('D').did)
    assert.equal(latest.cid, r3.cid)
  } finally {
    await heliaA.stop()
    await heliaB.stop()
  }
})

// ──────────────────────────────────────────────
// 乱序到达：B 先收到 v3（parentCid 指向 v2），再收到 v2、v1
// ──────────────────────────────────────────────

test('乱序到达：getLineage 仍能正确回溯（依赖本地索引完整）', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const heliaA = await createHeliaLight()
  await heliaA.start()
  const heliaB = await createHeliaLight()
  await heliaB.start()
  try {
    const walletA = await makeWallet(90)
    const wikiA = new WikiProtocol({
      helia: heliaA,
      pubsub: makeMockPubsub(),
      editorIdentity: walletA.get('D'),
    })
    const r1 = await wikiA.publishEntry({ title: 'oOO', content: 'v1' })
    await new Promise(r => setTimeout(r, 5))
    const r2 = await wikiA.publishEntry({ title: 'oOO', content: 'v2', parentCid: r1.cid })
    await new Promise(r => setTimeout(r, 5))
    const r3 = await wikiA.publishEntry({ title: 'oOO', content: 'v3', parentCid: r2.cid })

    const walletB = await makeWallet(91)
    const wikiB = new WikiProtocol({
      helia: heliaB,
      pubsub: makeMockPubsub(),
      editorIdentity: walletB.get('D'),
    })

    // 乱序到达：v3 先到
    wikiB.handleAnnounce(r3.message)
    // 此时 B 的 getLineage(r3.cid) 只能返回 [r3]，因为 r2 还没到
    let lineage = wikiB.getLineage(r3.cid)
    assert.equal(lineage.length, 1)

    // v2 到达
    wikiB.handleAnnounce(r2.message)
    lineage = wikiB.getLineage(r3.cid)
    assert.equal(lineage.length, 2)

    // v1 到达
    wikiB.handleAnnounce(r1.message)
    lineage = wikiB.getLineage(r3.cid)
    assert.equal(lineage.length, 3)
    assert.equal(lineage[2].cid, r1.cid)
  } finally {
    await heliaA.stop()
    await heliaB.stop()
  }
})
