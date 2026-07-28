// SPDX-License-Identifier: Apache-2.0

/**
 * M9.4 WebPanel × AppManager 路由分发集成测试
 * ───────────────────────────────────────────────
 * 测试范围：
 *   - /api/apps 端点：返回已加载 App 列表
 *   - /apps HTML 索引页
 *   - /apps/<appName>/... 路由分发到 AppManager.handleAppWebRequest
 *   - /api/apps/<appName>/... 路由分发到 AppManager.handleAppWebRequest
 *   - AppManager 未启用时降级（503）
 *   - App 未加载：404
 *   - 严格 GET-only（POST/PUT/DELETE 返回 405）
 *   - HTML 首页侧边栏含 Apps 区块
 *
 * 不依赖 libp2p / helia：mock SNode + 真实 AppManager + 临时 apps 目录。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { WebPanel } from '../src/app/web-panel.js'
import { AppManager } from '../src/app/app-manager.js'
import { createSnodeMock } from '../sdk/__mocks__/snode-mock.js'

// ──────────────────────────────────────────────
// 测试辅助
// ──────────────────────────────────────────────

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'havix-webpanel-apps-'))
}

function createTestApp(rootDir, opts) {
  const {
    name,
    version = '1.0.0',
    capability = 'custom',
    permissions = [],
    entryPoint = 'index.js',
    entryCode = '',
    extraManifest = {},
  } = opts

  const appDir = path.join(rootDir, name)
  fs.mkdirSync(appDir, { recursive: true })

  const manifestYaml = [
    `name: ${name}`,
    `version: ${version}`,
    `capability: ${capability}`,
    `permissions: [${permissions.map(p => `"${p}"`).join(', ')}]`,
    `entryPoint: ${entryPoint}`,
    ...Object.entries(extraManifest).map(([k, v]) =>
      `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`),
  ].join('\n')

  fs.writeFileSync(path.join(appDir, 'manifest.yaml'), manifestYaml, 'utf8')
  fs.writeFileSync(path.join(appDir, entryPoint), entryCode || '// empty', 'utf8')

  return appDir
}

/**
 * 创建一个 mock SNode（带 appManager 字段，模拟 s-node.js startApp 流程后的状态）。
 */
function makeMockNode() {
  return {
    log: () => {},
    libp2p: {
      peerId: { toString: () => '12D3KooWmockpeer' },
      getMultiaddrs: () => ['/ip4/127.0.0.1/tcp/9001/p2p/12D3KooWmockpeer'],
      getPeers: () => [],
      services: { pubsub: { getTopics: () => [] } },
    },
    wallet: {
      get: () => ({ did: 'did:havix:mock' }),
    },
    appManager: null,  // 测试中可注入
  }
}

async function startPanel(node, opts = {}) {
  const panel = new WebPanel(node, { port: 0, host: '127.0.0.1', ...opts })
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

describe('M9.4 WebPanel: /api/apps 端点', () => {
  test('AppManager 已启用 + 有 1 个 App：返回 ok:true + apps 列表', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, {
      name: 'demo-app',
      version: '1.2.0',
      capability: 'market',
      permissions: ['market:create'],
      extraManifest: { description: '"测试 App"' },
    })

    const node = makeMockNode()
    const am = new AppManager(node, null, { appsDir: tmpDir })
    await am.start()
    node.appManager = am

    const panel = await startPanel(node)
    const r = await fetchJson(panel, '/api/apps')

    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.count, 1)
    assert.equal(r.body.apps[0].name, 'demo-app')
    assert.equal(r.body.apps[0].version, '1.2.0')
    assert.equal(r.body.apps[0].capability, 'market')
    assert.deepEqual(r.body.apps[0].permissions, ['market:create'])

    await panel.stop()
    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('AppManager 已启用 + 无 App：返回 ok:true + count=0', async () => {
    const tmpDir = makeTempDir()
    const node = makeMockNode()
    const am = new AppManager(node, null, { appsDir: tmpDir })
    await am.start()
    node.appManager = am

    const panel = await startPanel(node)
    const r = await fetchJson(panel, '/api/apps')

    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.count, 0)
    assert.deepEqual(r.body.apps, [])

    await panel.stop()
    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('AppManager 未启用（node.appManager=null）：返回 503 + 错误信息', async () => {
    const node = makeMockNode()
    const panel = await startPanel(node)
    const r = await fetchJson(panel, '/api/apps')

    assert.equal(r.status, 503)
    assert.equal(r.body.ok, false)
    assert.match(r.body.error, /AppManager 未启用/)

    await panel.stop()
  })
})

describe('M9.4 WebPanel: /apps HTML 索引页', () => {
  test('有 App 时返回 HTML 表格', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, {
      name: 'web-demo',
      version: '0.9.0',
      capability: 'wiki',
      extraManifest: { description: '"Web 演示"' },
    })

    const node = makeMockNode()
    const am = new AppManager(node, null, { appsDir: tmpDir })
    await am.start()
    node.appManager = am

    const panel = await startPanel(node)
    const r = await fetchText(panel, '/apps')

    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /text\/html/)
    assert.match(r.body, /Havix Apps/)
    assert.match(r.body, /web-demo/)
    assert.match(r.body, /0\.9\.0/)
    assert.match(r.body, /wiki/)
    assert.match(r.body, /\/apps\/web-demo\//)

    await panel.stop()
    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('无 App 时返回 HTML 空状态', async () => {
    const tmpDir = makeTempDir()
    const node = makeMockNode()
    const am = new AppManager(node, null, { appsDir: tmpDir })
    await am.start()
    node.appManager = am

    const panel = await startPanel(node)
    const r = await fetchText(panel, '/apps')

    assert.equal(r.status, 200)
    assert.match(r.body, /暂无已加载的 App/)

    await panel.stop()
    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('AppManager 未启用时 /apps 返回 503', async () => {
    const node = makeMockNode()
    const panel = await startPanel(node)
    const r = await fetchJson(panel, '/apps')

    assert.equal(r.status, 503)
    assert.match(r.body.error, /AppManager 未启用/)

    await panel.stop()
  })
})

describe('M9.4 WebPanel: /apps/<appName>/... 路由分发', () => {
  test('分发到 App 的 web.handle（API 路由）', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, {
      name: 'route-app',
      permissions: [],
      entryCode: [
        'export async function start(snode, manifest, app) {',
        '  app.web.get("/api/apps/route-app/hello", () => ({ ok: true, msg: "hi-from-app" }))',
        '}',
      ].join('\n'),
    })

    const node = makeMockNode()
    const am = new AppManager(node, null, { appsDir: tmpDir })
    await am.start()
    node.appManager = am

    const panel = await startPanel(node)
    const r = await fetchJson(panel, '/api/apps/route-app/hello')

    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.msg, 'hi-from-app')

    await panel.stop()
    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('分发到 App 静态挂载点（/apps/<appName>/...）', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, {
      name: 'static-app',
      permissions: [],
      entryCode: [
        'export async function start(snode, manifest, app) {',
        '  app.web.mount("/apps/static-app/", { type: "static", dir: "./webui/" })',
        '}',
      ].join('\n'),
    })

    const node = makeMockNode()
    const am = new AppManager(node, null, { appsDir: tmpDir })
    await am.start()
    node.appManager = am

    const panel = await startPanel(node)
    const r = await fetchJson(panel, '/apps/static-app/index.html')

    assert.equal(r.status, 200)
    assert.equal(r.body._static, true)
    assert.equal(r.body.dir, './webui/')

    await panel.stop()
    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('App 未加载：404', async () => {
    const tmpDir = makeTempDir()
    const node = makeMockNode()
    const am = new AppManager(node, null, { appsDir: tmpDir })
    await am.start()
    node.appManager = am

    const panel = await startPanel(node)
    const r = await fetchJson(panel, '/api/apps/unknown-app/foo')

    assert.equal(r.status, 404)
    assert.match(r.body.error, /unknown-app/)

    await panel.stop()
    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('App 路径不存在：404', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, {
      name: 'minimal-app',
      permissions: [],
      entryCode: 'export async function start() {}',
    })

    const node = makeMockNode()
    const am = new AppManager(node, null, { appsDir: tmpDir })
    await am.start()
    node.appManager = am

    const panel = await startPanel(node)
    const r = await fetchJson(panel, '/api/apps/minimal-app/nonexistent')

    assert.equal(r.status, 404)

    await panel.stop()
    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('AppManager 未启用时 /apps/<appName>/... 返回 503', async () => {
    const node = makeMockNode()
    const panel = await startPanel(node)
    const r = await fetchJson(panel, '/api/apps/foo/bar')

    assert.equal(r.status, 503)
    assert.match(r.body.error, /AppManager 未启用/)

    await panel.stop()
  })
})

describe('M9.4 WebPanel: 严格 GET-only 约束', () => {
  test('POST /api/apps 返回 405', async () => {
    const node = makeMockNode()
    const panel = await startPanel(node)
    const r = await fetchJson(panel, '/api/apps', { method: 'POST' })

    assert.equal(r.status, 405)
    assert.match(r.body.error, /仅支持 GET/)

    await panel.stop()
  })

  test('PUT /apps/foo/ 返回 405', async () => {
    const node = makeMockNode()
    const panel = await startPanel(node)
    const r = await fetchJson(panel, '/apps/foo/', { method: 'PUT' })

    assert.equal(r.status, 405)
    assert.match(r.body.hint, /M9 理论修正/)

    await panel.stop()
  })

  test('DELETE /api/apps/foo 返回 405', async () => {
    const node = makeMockNode()
    const panel = await startPanel(node)
    const r = await fetchJson(panel, '/api/apps/foo', { method: 'DELETE' })

    assert.equal(r.status, 405)

    await panel.stop()
  })
})

describe('M9.4 WebPanel: /api/status 新增 apps 字段', () => {
  test('AppManager 已启用：apps.enabled=true + apps.count', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, { name: 'status-app' })

    const node = makeMockNode()
    const am = new AppManager(node, null, { appsDir: tmpDir })
    await am.start()
    node.appManager = am

    const panel = await startPanel(node)
    const r = await fetchJson(panel, '/api/status')

    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.apps.enabled, true)
    assert.equal(r.body.apps.count, 1)
    assert.deepEqual(r.body.apps.names, ['status-app'])

    await panel.stop()
    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('AppManager 未启用：apps.enabled=false', async () => {
    const node = makeMockNode()
    const panel = await startPanel(node)
    const r = await fetchJson(panel, '/api/status')

    assert.equal(r.body.apps.enabled, false)
    assert.equal(r.body.apps.count, 0)
    assert.deepEqual(r.body.apps.names, [])

    await panel.stop()
  })
})

describe('M9.4 WebPanel: HTML 首页侧边栏 Apps 区块', () => {
  test('HTML 首页包含 Apps 区块标题', async () => {
    const node = makeMockNode()
    const panel = await startPanel(node)
    const r = await fetchText(panel, '/')

    assert.equal(r.status, 200)
    assert.match(r.body, /Apps（M9\.4）/)
    assert.match(r.body, /AppManager 启用/)

    await panel.stop()
  })

  test('HTML 首页包含 /apps 链接', async () => {
    const node = makeMockNode()
    const panel = await startPanel(node)
    const r = await fetchText(panel, '/')

    assert.match(r.body, /href="\/apps"/)
    assert.match(r.body, /href="\/api\/apps"/)

    await panel.stop()
  })

  test('HTML 首页不泄露私钥', async () => {
    const node = makeMockNode()
    const panel = await startPanel(node)
    const r = await fetchText(panel, '/')

    assert.doesNotMatch(r.body, /privateKey|secret/i)

    await panel.stop()
  })
})

describe('M9.4 WebPanel: App 返回 HTML 内容', () => {
  test('App 返回 Content-Type: text/html 时按 HTML 响应', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, {
      name: 'html-app',
      permissions: [],
      entryCode: [
        'export async function start(snode, manifest, app) {',
        '  app.web.get("/api/apps/html-app/page", () => ({',
        '    status: 200,',
        '    body: "<h1>Hello from App</h1>",',
        '    headers: { "Content-Type": "text/html" },',
        '  }))',
        '}',
      ].join('\n'),
    })

    const node = makeMockNode()
    const am = new AppManager(node, null, { appsDir: tmpDir })
    await am.start()
    node.appManager = am

    const panel = await startPanel(node)
    const r = await fetchText(panel, '/api/apps/html-app/page')

    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /text\/html/)
    assert.match(r.body, /Hello from App/)

    await panel.stop()
    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('M9.4 WebPanel: 现有路由不破坏', () => {
  test('现有 /api/status 仍可用', async () => {
    const node = makeMockNode()
    const panel = await startPanel(node)
    const r = await fetchJson(panel, '/api/status')

    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)

    await panel.stop()
  })

  test('现有 /healthz 仍可用', async () => {
    const node = makeMockNode()
    const panel = await startPanel(node)
    const r = await fetchJson(panel, '/healthz')

    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)

    await panel.stop()
  })

  test('现有 / 页面仍可用', async () => {
    const node = makeMockNode()
    const panel = await startPanel(node)
    const r = await fetchText(panel, '/')

    assert.equal(r.status, 200)
    assert.match(r.body, /<!DOCTYPE html>/)

    await panel.stop()
  })

  test('未注册路径 /unknown 仍 404', async () => {
    const node = makeMockNode()
    const panel = await startPanel(node)
    const r = await fetchJson(panel, '/unknown')

    assert.equal(r.status, 404)

    await panel.stop()
  })
})
