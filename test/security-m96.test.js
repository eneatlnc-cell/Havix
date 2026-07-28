// SPDX-License-Identifier: Apache-2.0

/**
 * M9.6 安全加固 P0 测试（27 项）
 * ───────────────────────────────────────────────
 * 覆盖 6 项立即修复的安全回归测试：
 *   - P0-1: state.js opts.dataDir 路径穿越（任意文件写入）—— 6 项
 *   - P1-1: AppManager entryPoint 路径穿越（任意代码执行）—— 4 项
 *   - P1-5: web.mount opts.dir 路径穿越（任意文件读）—— 3 项
 *   - P1-7: app.stop() 跨 App 影响订阅与 handler（DoS / 跨 App 隔离）—— 6 项
 *   - P1-8: issueInvite fail-closed（信誉门槛失效）—— 3 项
 *   - P1-10: 仲裁裁决 fail-closed（防伪造裁决）—— 3 项
 *   - validateDataDir 单元测试（共享校验函数）—— 2 项
 *
 * 测试原则：每个修复点都要有"被拒绝路径"+"合法路径"对照，确保不是误拒合法输入。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { createStateApi } from '../sdk/state.js'
import { createWebApi } from '../sdk/web.js'
import { createApp } from '../sdk/app.js'
import { AppManifest, validateDataDir } from '../sdk/manifest.js'
import { createSnodeMock } from '../sdk/__mocks__/snode-mock.js'
import { AppManager } from '../src/app/app-manager.js'
import { SNode } from '../src/s-node.js'
import { ReputationLedger, InsufficientReputationError } from '../src/protocol/credit.js'
import { VouchRegistry } from '../src/protocol/vouch.js'
import { ArbitrationRegistry } from '../src/protocol/arbitration.js'
import {
  MarketRegistry,
  AppManifest as SnodeAppManifest,
  issueInviteToken,
  InviteToken,
} from '../src/protocol/market.js'
import { IdentityWallet } from '../src/identity.js'

// ──────────────────────────────────────────────
// 辅助函数
// ──────────────────────────────────────────────

function makeManifest(overrides = {}) {
  return new AppManifest({
    name: 'test-app',
    version: '1.0.0',
    capability: 'custom',
    permissions: ['transport:subscribe', 'transport:publish', 'credit:balance'],
    entryPoint: 'index.js',
    ...overrides,
  })
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'havix-sec-'))
}

function createTestApp(rootDir, opts) {
  const {
    name,
    permissions = [],
    entryPoint = 'index.js',
    entryCode = '',
    extraManifest = {},
  } = opts
  const appDir = path.join(rootDir, name)
  fs.mkdirSync(appDir, { recursive: true })
  const manifestLines = [
    `name: ${name}`,
    `version: 1.0.0`,
    `capability: custom`,
    `permissions: [${permissions.map(p => `"${p}"`).join(', ')}]`,
    `entryPoint: ${entryPoint}`,
    ...Object.entries(extraManifest).map(([k, v]) =>
      `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`),
  ]
  fs.writeFileSync(path.join(appDir, 'manifest.yaml'), manifestLines.join('\n'), 'utf8')
  // 创建 entryPoint 所在的目录（支持 nested paths 如 sub/index.js）
  const entryFull = path.join(appDir, entryPoint)
  fs.mkdirSync(path.dirname(entryFull), { recursive: true })
  fs.writeFileSync(entryFull, entryCode || '// empty', 'utf8')
  return { appDir, entryFull }
}

// ──────────────────────────────────────────────
// P0-1: state.js opts.dataDir 路径穿越（6 项）
// ──────────────────────────────────────────────

describe('P0-1: state.js opts.dataDir 路径穿越校验', () => {
  test('拒绝 Linux 绝对路径 /etc/passwd', () => {
    const snode = createSnodeMock()
    const manifest = makeManifest()
    assert.throws(
      () => createStateApi(snode, manifest, { dataDir: '/etc/passwd' }),
      /dataDir 字段必须是相对路径/,
    )
  })

  test('拒绝 Windows 绝对路径 C:\\foo', () => {
    const snode = createSnodeMock()
    const manifest = makeManifest()
    assert.throws(
      () => createStateApi(snode, manifest, { dataDir: 'C:\\foo' }),
      /dataDir 字段必须是相对路径/,
    )
  })

  test('拒绝 ../../../etc/cron.d（路径穿越）', () => {
    const snode = createSnodeMock()
    const manifest = makeManifest()
    assert.throws(
      () => createStateApi(snode, manifest, { dataDir: '../../../etc/cron.d' }),
      /dataDir 字段不允许包含 ".." 路径穿越/,
    )
  })

  test('拒绝嵌套穿越 a/../../b', () => {
    const snode = createSnodeMock()
    const manifest = makeManifest()
    assert.throws(
      () => createStateApi(snode, manifest, { dataDir: 'a/../../b' }),
      /dataDir 字段不允许包含 ".." 路径穿越/,
    )
  })

  test('拒绝 M9.2 兼容形式字符串路径穿越（第三参数字符串）', () => {
    const snode = createSnodeMock()
    const manifest = makeManifest()
    assert.throws(
      () => createStateApi(snode, manifest, '../../../etc/cron.d'),
      /dataDir 字段不允许包含 ".." 路径穿越/,
    )
  })

  test('接受合法相对路径，persistDir 不含 .. 段', () => {
    const snode = createSnodeMock({ config: { dataDir: '/tmp/test-app-data' } })
    const manifest = makeManifest()
    const state = createStateApi(snode, manifest, { dataDir: 'my-app-data' })
    assert.ok(state.persistDir.includes('my-app-data'))
    assert.ok(!state.persistDir.includes('..'))
    // 路径穿越已校验通过：合法相对路径被接受，path.join 规整后无 .. 段
  })
})

// ──────────────────────────────────────────────
// P1-1: AppManager entryPoint 路径穿越（4 项）
// ──────────────────────────────────────────────

describe('P1-1: AppManager entryPoint 路径穿越校验', () => {
  test('拒绝 ../../../etc/passwd 作 entryPoint', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, {
      name: 'evil-app',
      entryPoint: '../../../etc/passwd',
      entryCode: '',
    })
    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: tmpDir })
    await am.start()  // 单 App 失败不抛错，只 log
    assert.equal(am.listApps().length, 0, '路径穿越的 App 不应被加载')
    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('拒绝绝对路径 /etc/passwd 作 entryPoint', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, {
      name: 'evil-app2',
      entryPoint: '/etc/passwd',
      entryCode: '',
    })
    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: tmpDir })
    await am.start()
    assert.equal(am.listApps().length, 0, '绝对路径 entryPoint 不应被加载')
    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('拒绝跨目录 entryPoint（../sibling/index.js）', async () => {
    const tmpDir = makeTempDir()
    // 先在 tmpDir 同级创建一个 sibling 目录与文件（模拟攻击目标）
    const siblingDir = path.join(tmpDir, '..', 'sibling-target')
    fs.mkdirSync(siblingDir, { recursive: true })
    const siblingFile = path.join(siblingDir, 'evil.js')
    fs.writeFileSync(siblingFile, 'export function start() {}', 'utf8')

    // 创建 App，entryPoint 指向 sibling
    const appDir = path.join(tmpDir, 'cross-dir-app')
    fs.mkdirSync(appDir, { recursive: true })
    fs.writeFileSync(
      path.join(appDir, 'manifest.yaml'),
      [
        'name: cross-dir-app',
        'version: 1.0.0',
        'capability: custom',
        'permissions: []',
        `entryPoint: ${path.join('..', 'sibling-target', 'evil.js')}`,
      ].join('\n'),
      'utf8',
    )

    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: tmpDir })
    await am.start()
    assert.equal(am.listApps().length, 0, '跨目录 entryPoint 不应被加载')
    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(siblingDir, { recursive: true, force: true })
  })

  test('接受合法 ./index.js（同目录入口）', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, {
      name: 'normal-app',
      entryPoint: 'index.js',
      entryCode: 'export async function start() {}',
    })
    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: tmpDir })
    await am.start()
    assert.equal(am.listApps().length, 1, '合法 entryPoint 应被加载')
    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ──────────────────────────────────────────────
// P1-5: web.mount opts.dir 路径穿越（3 项）
// ──────────────────────────────────────────────

describe('P1-5: web.mount opts.dir 路径穿越校验', () => {
  test('拒绝 ../../../etc 作 opts.dir', () => {
    const snode = createSnodeMock()
    const manifest = makeManifest()
    const web = createWebApi(snode, manifest)
    assert.throws(
      () => web.mount('/apps/test-app/static/', { type: 'static', dir: '../../../etc' }),
      /dataDir 字段不允许包含 ".." 路径穿越/,
    )
  })

  test('拒绝绝对路径 /var/www 作 opts.dir', () => {
    const snode = createSnodeMock()
    const manifest = makeManifest()
    const web = createWebApi(snode, manifest)
    assert.throws(
      () => web.mount('/apps/test-app/static/', { type: 'static', dir: '/var/www' }),
      /dataDir 字段必须是相对路径/,
    )
  })

  test('接受合法相对路径 ./webui', () => {
    const snode = createSnodeMock()
    const manifest = makeManifest()
    const web = createWebApi(snode, manifest)
    web.mount('/apps/test-app/static/', { type: 'static', dir: './webui' })
    const routes = web.listRoutes()
    assert.equal(routes.length, 1)
    assert.equal(routes[0].dir, './webui')
  })
})

// ──────────────────────────────────────────────
// P1-7: app.stop() 跨 App 影响订阅与 handler（6 项）
// ──────────────────────────────────────────────

describe('P1-7: app.stop() 跨 App 隔离', () => {
  test('本 App transport 订阅被清理（自身注册的）', async () => {
    const snode = createSnodeMock()
    const manifest = makeManifest()
    const app = await createApp(snode, manifest)
    await app.transport.subscribe('/havix-app/my-topic', () => {})
    assert.equal(snode._transportSubscriptions.size, 1, '订阅前应有 1 个 topic')
    await app.stop()
    // 本 App 注册的全部被清理
    const remaining = [...snode._transportSubscriptions.values()].reduce((s, set) => s + set.size, 0)
    assert.equal(remaining, 0, '本 App 注册的订阅应被清理')
  })

  test('其他 App transport 订阅保留（跨 App 不影响）', async () => {
    const snode = createSnodeMock()
    const manifest = makeManifest()

    // 模拟"其他 App"直接在 snode 共享状态注册的订阅
    const otherHandler = () => {}
    snode._transportSubscriptions = new Map([['/other-app/x', new Set([otherHandler])]])

    const app = await createApp(snode, manifest)
    await app.transport.subscribe('/havix-app/my-topic', () => {})
    await app.stop()

    // 其他 App 的订阅应保留
    assert.ok(snode._transportSubscriptions.has('/other-app/x'), '其他 App topic 应保留')
    const remaining = snode._transportSubscriptions.get('/other-app/x')
    assert.equal(remaining.size, 1, '其他 App handler 不应被清理')
  })

  test('本 App market 订阅被清理（自身注册的）', async () => {
    const snode = createSnodeMock()
    const manifest = makeManifest({ permissions: ['market:subscribe'] })
    const app = await createApp(snode, manifest)

    // 直接 stub getMarketTopic 让 market.subscribe 不抛错
    snode.getMarketTopic = (marketId) => `/s-network/market/${marketId}`
    const fakeMarketId = 'fake-market-id'
    await app.market.subscribe(fakeMarketId, () => {})
    assert.equal(snode._marketSubscriptions.size, 1)
    await app.stop()
    // 本 App 注册的全部被清理
    const remaining = [...snode._marketSubscriptions.values()].reduce((s, set) => s + set.size, 0)
    assert.equal(remaining, 0, '本 App 注册的市场订阅应被清理')
  })

  test('其他 App market 订阅保留', async () => {
    const snode = createSnodeMock()
    const manifest = makeManifest({ permissions: ['market:subscribe'] })
    // 模拟"其他 App"已注册的市场订阅
    const otherHandler = () => {}
    snode._marketSubscriptions = new Map([['other-market', new Set([otherHandler])]])

    const app = await createApp(snode, manifest)
    snode.getMarketTopic = (marketId) => `/s-network/market/${marketId}`
    await app.market.subscribe('my-market', () => {})
    await app.stop()

    // 其他 App 的市场订阅保留
    assert.ok(snode._marketSubscriptions.has('other-market'), '其他 App market 应保留')
    assert.equal(
      snode._marketSubscriptions.get('other-market').size, 1,
      '其他 App market handler 不应被清理',
    )
  })

  test('本 App credit handler 被清理', async () => {
    const snode = createSnodeMock()
    const manifest = makeManifest({ permissions: ['credit:balance'] })
    const app = await createApp(snode, manifest)
    app.credit.onReceived(() => { /* handler 1 */ })
    app.credit.onReceived(() => { /* handler 2 */ })
    assert.equal(snode._creditHandlers.length, 2, '应有 2 个本 App 注册的 handler')
    await app.stop()
    // 本 App 注册的全部被清理（其他 App 的不算）
    assert.equal(snode._creditHandlers.length, 0, '本 App handler 应被清理')
  })

  test('其他 App credit handler 保留', async () => {
    const snode = createSnodeMock()
    const manifest = makeManifest({ permissions: ['credit:balance'] })
    // 模拟"其他 App"已注册的 handler（直接塞入 snode 共享数组）
    const otherHandler = () => {}
    snode._creditHandlers = [otherHandler]

    const app = await createApp(snode, manifest)
    app.credit.onReceived(() => { /* 本 App handler */ })
    assert.equal(snode._creditHandlers.length, 2, '应有 2 个 handler（其他 App + 本 App）')
    await app.stop()
    // 本 App 注册的被清理，其他 App 的保留
    assert.equal(snode._creditHandlers.length, 1, '其他 App handler 应保留')
    assert.equal(snode._creditHandlers[0], otherHandler, '保留的是其他 App 的 handler')
  })
})

// ──────────────────────────────────────────────
// P1-8: issueInvite fail-closed（3 项）
// ──────────────────────────────────────────────

describe('P1-8: SNode.issueInvite fail-closed', () => {
  async function setupSnodeWithMarket({ manifest, inviteeRep }) {
    const wallet = await makeWallet()
    const node = new SNode({ logLevel: 'error' })
    const issuerA = wallet.get('A')
    node.wallet = {
      get: (ctx) => ctx === 'A' ? issuerA : { did: `did:havix:${ctx}:self` },
    }
    node.log = () => {}
    node.libp2p = { services: { pubsub: { subscribe: async () => {} } } }

    if (inviteeRep !== undefined) {
      node.reputationLedger = new ReputationLedger({ initialReputation: 0 })
      node.reputationLedger.credit('did:havix:B:invitee', inviteeRep)
    } else {
      // 显式删除 reputationLedger（确保 SNode 构造时未注入的属性是 null）
      node.reputationLedger = null
    }

    const marketRegistry = new MarketRegistry({ log: () => {} })
    node.marketRegistry = marketRegistry
    const creatorToken = await issueInviteToken({
      marketId: manifest.marketId,
      inviteeDid: issuerA.did,
      issuerIdentity: issuerA,
    })
    marketRegistry.createMarket({ manifest, creatorToken })
    return node
  }

  async function makeWallet() {
    // 用 IdentityWallet.fromSeed 创建一个真实可签名的 context-A
    const seed = new Uint8Array(32).fill(42)
    return await IdentityWallet.fromSeed(seed)
  }

  test('reputationLedger 缺失时 fail-closed 抛错', async () => {
    const manifest = new SnodeAppManifest({
      name: 'high-rep-market',
      version: '1.0.0',
      capability: 'market',
      min_reputation: 30,
    })
    const node = await setupSnodeWithMarket({ manifest, inviteeRep: undefined })
    // reputationLedger 未注入（显式 null）
    assert.equal(node.reputationLedger, null)
    await assert.rejects(
      () => node.issueInvite({
        marketId: manifest.marketId,
        inviteeDid: 'did:havix:B:invitee',
      }),
      /未注入 reputationLedger.*fail-closed/,
    )
  })

  test('manifest 缺失时 fail-closed 抛错', async () => {
    const node = new SNode({ logLevel: 'error' })
    const wallet = await makeWallet()
    const issuerA = wallet.get('A')
    node.wallet = { get: (ctx) => ctx === 'A' ? issuerA : { did: `did:havix:${ctx}:self` } }
    node.log = () => {}
    node.libp2p = { services: { pubsub: { subscribe: async () => {} } } }

    // 创建一个 manifest 为 null 的 market（模拟数据损坏）
    node.reputationLedger = new ReputationLedger({ initialReputation: 0 })
    const marketRegistry = new MarketRegistry({ log: () => {} })
    node.marketRegistry = marketRegistry
    // 直接构造一个 market 对象，跳过 createMarket 的 manifest 校验
    const fakeMarket = {
      isCreator: true,
      manifest: null,
      getTopic: () => '/s-network/market/fake',
    }
    marketRegistry.markets = new Map([['m-fake', fakeMarket]])

    await assert.rejects(
      () => node.issueInvite({
        marketId: 'm-fake',
        inviteeDid: 'did:havix:B:invitee',
      }),
      /缺少 manifest.*fail-closed/,
    )
  })

  test('信誉达标时正常放行（fail-closed 不误拒合法请求）', async () => {
    const manifest = new SnodeAppManifest({
      name: 'ok-rep-market',
      version: '1.0.0',
      capability: 'market',
      min_reputation: 30,
    })
    const node = await setupSnodeWithMarket({ manifest, inviteeRep: 50 })
    const token = await node.issueInvite({
      marketId: manifest.marketId,
      inviteeDid: 'did:havix:B:invitee',
    })
    assert.ok(token instanceof InviteToken)
    assert.equal(token.inviteeDid, 'did:havix:B:invitee')
  })
})

// ──────────────────────────────────────────────
// P1-10: 仲裁裁决 fail-closed（3 项）
// ──────────────────────────────────────────────

describe('P1-10: 仲裁裁决 fail-closed', () => {
  function setupSnodeWithDispute({ panel }) {
    const node = new SNode({ logLevel: 'error' })
    const ledger = new ReputationLedger()
    const vouch = new VouchRegistry({ threshold: 1 })
    node.arbitrationRegistry = new ArbitrationRegistry({
      reputationLedger: ledger,
      vouchRegistry: vouch,
      panelSize: 3,
      verdictMajority: 3,
      reputationMultiplier: 0,
    })
    node.log = () => {}
    // 先 fileDispute 创建 dispute
    node.arbitrationRegistry.fileDispute({
      disputeId: 'd1',
      claimant: 'did:havix:A:claimant',
      respondent: 'did:havix:A:respondent',
      type: 'offer-breach',
      evidence: 'evidence-uri',
      amount: 10,
    })
    const dispute = node.arbitrationRegistry.getDispute('d1')
    if (panel) {
      // 直接设置 panel（模拟"已镜像 panel"的状态）
      dispute.panel = panel
    }
    return node
  }

  test('panel 为空时 fail-closed 拒绝裁决', async () => {
    const node = setupSnodeWithDispute({ panel: null })
    const r = await node._handleArbitrationMessage({
      senderId: 'did:havix:A:fake-juror',
      payload: {
        disputeId: 'd1',
        action: 'verdict',
        claimant: 'did:havix:A:claimant',
        respondent: 'did:havix:A:respondent',
        type: 'offer-breach',
        amount: 10,
        verdict: 'guilty',
      },
    }, {})
    assert.equal(r.applied, false, 'panel 未镜像时应拒绝')
    assert.match(r.reason, /本地未镜像 panel.*fail-closed/)
  })

  test('senderId 不在 panel 中时拒绝裁决', async () => {
    const node = setupSnodeWithDispute({
      panel: ['did:havix:A:juror1', 'did:havix:A:juror2', 'did:havix:A:juror3'],
    })
    const r = await node._handleArbitrationMessage({
      senderId: 'did:havix:A:attacker',
      payload: {
        disputeId: 'd1',
        action: 'verdict',
        claimant: 'did:havix:A:claimant',
        respondent: 'did:havix:A:respondent',
        type: 'offer-breach',
        amount: 10,
        verdict: 'guilty',
      },
    }, {})
    assert.equal(r.applied, false, '攻击者不在 panel 中应拒绝')
    assert.match(r.reason, /senderId 不在仲裁团 panel 中/)
  })

  test('senderId 在 panel 中时接受裁决', async () => {
    const node = setupSnodeWithDispute({
      panel: ['did:havix:A:juror1', 'did:havix:A:juror2', 'did:havix:A:juror3'],
    })
    const r = await node._handleArbitrationMessage({
      senderId: 'did:havix:A:juror1',
      payload: {
        disputeId: 'd1',
        action: 'verdict',
        claimant: 'did:havix:A:claimant',
        respondent: 'did:havix:A:respondent',
        type: 'offer-breach',
        amount: 10,
        verdict: 'guilty',
      },
    }, {})
    assert.equal(r.applied, true, 'panel 内的 senderId 应接受')
    const dispute = node.arbitrationRegistry.getDispute('d1')
    assert.equal(dispute.verdict, 'guilty', '裁决应被镜像')
  })
})

// ──────────────────────────────────────────────
// validateDataDir 单元测试（2 项，共享校验函数）
// ──────────────────────────────────────────────

describe('validateDataDir 单元测试', () => {
  test('undefined / null / 空字符串默认返回 manifest.name', () => {
    assert.equal(validateDataDir(undefined, 'my-app'), 'my-app')
    assert.equal(validateDataDir(null, 'my-app'), 'my-app')
    assert.equal(validateDataDir('', 'my-app'), 'my-app')
  })

  test('接受合法相对路径原样返回，拒绝非字符串类型', () => {
    assert.equal(validateDataDir('my-data-dir', 'fallback'), 'my-data-dir')
    assert.equal(validateDataDir('nested/path/ok', 'fallback'), 'nested/path/ok')
    assert.throws(
      () => validateDataDir(123, 'fallback'),
      /dataDir 字段必须是字符串/,
    )
    assert.throws(
      () => validateDataDir({ evil: true }, 'fallback'),
      /dataDir 字段必须是字符串/,
    )
  })
})
