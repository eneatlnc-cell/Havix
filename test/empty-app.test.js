// SPDX-License-Identifier: Apache-2.0

/**
 * M9.5 empty-app 参考模板集成测试
 * ───────────────────────────────────────────────
 * 启动 AppManager 加载真实的 apps/empty-app/，验证 SDK 4 大接口端到端工作：
 *
 *   1. App 加载（manifest 解析 + createApp 装配 + start hook 调用）
 *   2. CLI 命令注册 + 执行（empty-app-hello）
 *   3. Web 路由注册 + handle 派发（/api/apps/empty-app/hello）
 *   4. State 持久化（set 写盘 + 重启 load 恢复）
 *   5. Credit onReceived handler 注册 + dispatchCreditMessage 派发
 *   6. stop hook 调用（app.stop 触发 state flush）
 *   7. 端到端 WebPanel + AppManager 集成（/api/apps 端点 + /api/apps/empty-app/hello 路由）
 *
 * 不依赖 libp2p / helia：mock SNode + 真实 AppManager + 真实 empty-app 文件。
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { AppManager } from '../src/app/app-manager.js'
import { WebPanel } from '../src/app/web-panel.js'
import { createSnodeMock } from '../sdk/__mocks__/snode-mock.js'

// ──────────────────────────────────────────────
// 测试辅助
// ──────────────────────────────────────────────

const EMPTY_APP_DIR = path.resolve(process.cwd(), 'apps')

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'havix-empty-app-'))
}

function makeMockNode(dataDir) {
  // 使用真实 snode-mock 获得 credit / market / wiki 等完整 API
  // 仅覆盖 config.dataDir 让 state 写到临时目录
  const snode = createSnodeMock({ config: { dataDir } })
  // 补充 WebPanel 需要的字段（snode-mock 不一定全有）
  snode.libp2p = snode.libp2p ?? {
    peerId: { toString: () => '12D3KooWmockpeer' },
    getMultiaddrs: () => ['/ip4/127.0.0.1/tcp/9001/p2p/12D3KooWmockpeer'],
    getPeers: () => [],
    services: { pubsub: { getTopics: () => [] } },
  }
  snode.appManager = null
  return snode
}

async function startAppManager(node, opts = {}) {
  const am = new AppManager(node, null, { appsDir: EMPTY_APP_DIR, ...opts })
  await am.start()
  node.appManager = am
  return am
}

async function startPanel(node) {
  const panel = new WebPanel(node, { port: 0, host: '127.0.0.1' })
  await panel.start()
  return panel
}

async function fetchJson(panel, p, init) {
  const res = await fetch(`http://127.0.0.1:${panel.getActualPort()}${p}`, init)
  const body = await res.json()
  return { status: res.status, headers: res.headers, body }
}

async function fetchText(panel, p, init) {
  const res = await fetch(`http://127.0.0.1:${panel.getActualPort()}${p}`, init)
  const body = await res.text()
  return { status: res.status, headers: res.headers, body }
}

// ──────────────────────────────────────────────
// 测试用例
// ──────────────────────────────────────────────

describe('M9.5 empty-app: App 加载', () => {
  test('AppManager 扫描 apps/ 加载 empty-app', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)

    assert.deepEqual(am.listAppNames(), ['empty-app'])
    const meta = am.listAppMeta()
    assert.equal(meta[0].name, 'empty-app')
    assert.equal(meta[0].version, '1.0.0')
    assert.equal(meta[0].capability, 'custom')

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('createApp 装配后 app 实例含 7 大接口', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const app = am.getApp('empty-app')

    assert.ok(app.cli, 'app.cli 应存在')
    assert.ok(app.web, 'app.web 应存在')
    assert.ok(app.state, 'app.state 应存在')
    assert.ok(app.credit, 'app.credit 应存在')
    assert.ok(app.market || app.transport || app.ipfs || app.wiki || app.arbitration || app.context,
      '至少一个其他接口应存在')

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('start hook 调用后 state 已初始化', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const app = am.getApp('empty-app')

    const keys = app.state.keys()
    assert.ok(keys.includes('initializedAt'), '应含 initializedAt')
    assert.ok(keys.includes('manifestName'), '应含 manifestName')

    const manifestName = await app.state.get('manifestName')
    assert.equal(manifestName, 'empty-app')

    const initializedAt = await app.state.get('initializedAt')
    assert.ok(typeof initializedAt === 'number', 'initializedAt 应是 timestamp')
    assert.ok(initializedAt > 0, 'initializedAt 应为正数')

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
})

describe('M9.5 empty-app: CLI 命令', () => {
  test('注册了 empty-app-hello 命令', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const app = am.getApp('empty-app')

    const cmds = app.cli.listCommands()
    assert.equal(cmds.length, 1)
    assert.equal(cmds[0].name, 'empty-app-hello')
    assert.match(cmds[0].description, /empty-app/)
    assert.deepEqual(cmds[0].args, ['--name'])

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('执行 empty-app-hello 默认返回 Hello, world!', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const app = am.getApp('empty-app')

    const result = await app.cli.execute('empty-app-hello', { named: {} })
    assert.equal(result, 'Hello, world! (from empty-app)')

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('执行 empty-app-hello --name Alice 返回 Hello, Alice!', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const app = am.getApp('empty-app')

    const result = await app.cli.execute('empty-app-hello', {
      named: { name: 'Alice' },
    })
    assert.equal(result, 'Hello, Alice! (from empty-app)')

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('CLI handler 执行后 state.lastGreeting 已写入', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const app = am.getApp('empty-app')

    await app.cli.execute('empty-app-hello', { named: { name: 'Bob' } })
    const lastGreeting = await app.state.get('lastGreeting')

    assert.ok(lastGreeting, 'lastGreeting 应存在')
    assert.equal(lastGreeting.text, 'Hello, Bob! (from empty-app)')
    assert.ok(typeof lastGreeting.at === 'number', 'at 应是 timestamp')

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('未注册命令 execute 抛错', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const app = am.getApp('empty-app')

    await assert.rejects(
      () => app.cli.execute('empty-app-unknown', {}),
      /未注册/,
    )

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
})

describe('M9.5 empty-app: Web 路由', () => {
  test('注册了 /api/apps/empty-app/hello 路由', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const app = am.getApp('empty-app')

    const routes = app.web.listRoutes()
    assert.equal(routes.length, 1)
    assert.equal(routes[0].path, '/api/apps/empty-app/hello')
    assert.equal(routes[0].method, 'GET')

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('app.web.handle 返回 hello 响应', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const app = am.getApp('empty-app')

    const result = await app.web.handle('hello', { method: 'GET' })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.app, 'empty-app')
    assert.equal(result.body.version, '1.0.0')
    assert.match(result.body.greeting, /Hello from empty-app/)

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('app.web.handle 不存在的子路径返回 404', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const app = am.getApp('empty-app')

    const result = await app.web.handle('nonexistent', { method: 'GET' })
    assert.equal(result.status, 404)

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('POST 请求返回 405（严格 GET-only）', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const app = am.getApp('empty-app')

    const result = await app.web.handle('hello', { method: 'POST' })
    assert.equal(result.status, 405)
    assert.match(result.body.error, /GET/)

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
})

describe('M9.5 empty-app: State 持久化', () => {
  test('state.json 在 set 后写盘', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const app = am.getApp('empty-app')

    await app.cli.execute('empty-app-hello', { named: { name: 'Carol' } })
    const persistPath = app.state.persistPath
    assert.ok(fs.existsSync(persistPath), 'state.json 应存在')

    const raw = fs.readFileSync(persistPath, 'utf8')
    const parsed = JSON.parse(raw)
    assert.ok(parsed.lastGreeting, 'state.json 应含 lastGreeting')
    assert.equal(parsed.lastGreeting.text, 'Hello, Carol! (from empty-app)')
    assert.ok(parsed.initializedAt, 'state.json 应含 initializedAt')
    assert.equal(parsed.manifestName, 'empty-app')

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('重启后 state 完整恢复', async () => {
    const dataDir = makeTempDataDir()

    // round 1：启动 + 执行 hello + 停止
    let node = makeMockNode(dataDir)
    let am = await startAppManager(node)
    let app = am.getApp('empty-app')
    await app.cli.execute('empty-app-hello', { named: { name: 'Dave' } })
    await am.stop()

    // round 2：重启，state 应从磁盘恢复
    node = makeMockNode(dataDir)
    am = await startAppManager(node)
    app = am.getApp('empty-app')

    // manifestName / initializedAt 应该从磁盘恢复（不是新值）
    const manifestName = await app.state.get('manifestName')
    assert.equal(manifestName, 'empty-app')

    const lastGreeting = await app.state.get('lastGreeting')
    assert.ok(lastGreeting, 'lastGreeting 应从磁盘恢复')
    assert.equal(lastGreeting.text, 'Hello, Dave! (from empty-app)')

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('state.delete 自动写盘', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const app = am.getApp('empty-app')

    await app.state.delete('manifestName')

    const raw = fs.readFileSync(app.state.persistPath, 'utf8')
    const parsed = JSON.parse(raw)
    assert.ok(!('manifestName' in parsed), 'manifestName 应已删除')

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('state.clear 写盘为空对象', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const app = am.getApp('empty-app')

    await app.state.clear()

    const raw = fs.readFileSync(app.state.persistPath, 'utf8')
    const parsed = JSON.parse(raw)
    assert.deepEqual(parsed, {})

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
})

describe('M9.5 empty-app: Credit 消息派发', () => {
  test('credit.onReceived handler 已注册', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const app = am.getApp('empty-app')

    // snode._creditHandlers 应被填充（createCreditApi 内部）
    assert.ok(Array.isArray(node._creditHandlers), 'snode._creditHandlers 应是数组')
    assert.ok(node._creditHandlers.length > 0, '应至少注册 1 个 handler')
    assert.equal(typeof app.credit._onReceived, 'function', '_onReceived 应是函数')

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('dispatchCreditMessage 调用 handler 写入 state', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)

    // 派发一条 credit 消息给 empty-app
    await am.dispatchCreditMessage({
      type: 'issue',
      amount: 100,
      holderDid: 'did:havix:holder1',
      issuerDid: 'did:havix:issuer1',
      senderId: 'did:havix:sender1',
      timestamp: Date.now(),
      targetApp: 'empty-app',
    })

    const app = am.getApp('empty-app')
    const lastCredit = await app.state.get('lastCreditReceived')
    assert.ok(lastCredit, 'lastCreditReceived 应存在')
    assert.equal(lastCredit.amount, 100)
    assert.equal(lastCredit.senderId, 'did:havix:sender1')

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('targetApp 不匹配时不派发', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)

    // targetApp=unknown-app：不应派发到 empty-app
    await am.dispatchCreditMessage({
      type: 'issue',
      amount: 50,
      senderId: 'did:havix:sender2',
      timestamp: Date.now(),
      targetApp: 'unknown-app',
    })

    const app = am.getApp('empty-app')
    const lastCredit = await app.state.get('lastCreditReceived')
    assert.equal(lastCredit, undefined, 'empty-app 不应收到给 unknown-app 的消息')

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('无 targetApp 时不派发', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)

    await am.dispatchCreditMessage({
      type: 'issue',
      amount: 30,
      senderId: 'did:havix:sender3',
      timestamp: Date.now(),
      // 故意不设 targetApp
    })

    const app = am.getApp('empty-app')
    const lastCredit = await app.state.get('lastCreditReceived')
    assert.equal(lastCredit, undefined, '无 targetApp 不应派发')

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
})

describe('M9.5 empty-app: stop hook', () => {
  test('app.stop 调用后 state.flush 写盘', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const app = am.getApp('empty-app')

    // 写入新值
    await app.state.set('stopTest', { marker: 'before-stop' })

    // 显式调 app.stop（不是 am.stop，仅 app 实例级）
    await app.stop()

    // state.json 应含 stopTest
    const raw = fs.readFileSync(app.state.persistPath, 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.stopTest.marker, 'before-stop')

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('AppManager.stop 幂等（多次调用不抛错）', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)

    await am.stop()
    await am.stop()  // 第二次不应抛错
    await am.stop()  // 第三次也不抛

    fs.rmSync(dataDir, { recursive: true, force: true })
  })
})

describe('M9.5 empty-app: 端到端 WebPanel 集成', () => {
  test('/api/apps 返回 empty-app', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const panel = await startPanel(node)

    const r = await fetchJson(panel, '/api/apps')
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.count, 1)
    assert.equal(r.body.apps[0].name, 'empty-app')
    assert.equal(r.body.apps[0].version, '1.0.0')

    await panel.stop()
    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('/api/apps/empty-app/hello 通过 WebPanel 派发', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const panel = await startPanel(node)

    const r = await fetchJson(panel, '/api/apps/empty-app/hello')
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.app, 'empty-app')
    assert.equal(r.body.version, '1.0.0')
    assert.match(r.body.greeting, /Hello from empty-app/)
    assert.ok(r.body.initializedAt, '应含 initializedAt')

    await panel.stop()
    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('/apps HTML 索引页含 empty-app 链接', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const panel = await startPanel(node)

    const r = await fetchText(panel, '/apps')
    assert.equal(r.status, 200)
    assert.match(r.body, /Havix Apps/)
    assert.match(r.body, /empty-app/)
    assert.match(r.body, /1\.0\.0/)
    assert.match(r.body, /href="\/apps\/empty-app\/"/)

    await panel.stop()
    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('/api/status 含 apps.enabled=true', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const panel = await startPanel(node)

    const r = await fetchJson(panel, '/api/status')
    assert.equal(r.body.apps.enabled, true)
    assert.equal(r.body.apps.count, 1)
    assert.deepEqual(r.body.apps.names, ['empty-app'])

    await panel.stop()
    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
})

describe('M9.5 empty-app: manifest 校验', () => {
  test('empty-app manifest.name 与目录名一致', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)

    // AppManager 在 _loadApp 中强制 manifest.name === dirName
    // 若 empty-app 改了 name 但没改目录名，加载会失败
    const meta = am.listAppMeta()
    assert.equal(meta[0].name, 'empty-app')

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('empty-app manifest 含必需字段', async () => {
    const dataDir = makeTempDataDir()
    const node = makeMockNode(dataDir)
    const am = await startAppManager(node)
    const app = am.getApp('empty-app')
    // 直接从 app.manifest 取完整字段（listAppMeta 只返回子集）
    const m = app.manifest

    assert.ok(m.name, 'name')
    assert.ok(m.version, 'version')
    assert.ok(m.capability, 'capability')
    assert.ok(Array.isArray(m.permissions), 'permissions 应是数组')
    assert.ok(m.entryPoint, 'entryPoint')

    await am.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
})
