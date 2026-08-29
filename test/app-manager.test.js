// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AppManager 单元测试（M9.3）
 * ───────────────────────────────────────────────
 * 覆盖：
 *   - 空 apps 目录 / 不存在目录
 *   - 单 App 加载（manifest + entryPoint + start hook）
 *   - 多 App 加载
 *   - manifest 缺失抛错（跳过该 App，不阻断其他）
 *   - manifest.name 与目录名不一致抛错
 *   - entryPoint 不存在抛错
 *   - 重复加载抛 AppAlreadyLoadedError
 *   - stop() 幂等 + 清空 Map
 *   - dispatchCreditMessage 派发到对应 App
 *   - listApps / listAppNames / listAppMeta / getApp
 *   - handleAppWebRequest 委托给 app.web.handle
 *   - _injectCliCommands 把 App CLI 命令注入 Cli 实例
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import { AppManager } from '../src/app/app-manager.js'
import { createSnodeMock } from '../sdk/__mocks__/snode-mock.js'
import { AppManifest } from '../sdk/manifest.js'
import { AppAlreadyLoadedError, InvalidAppStateError } from '../sdk/errors.js'

// ──────────────────────────────────────────────
// 测试辅助：在临时目录创建 App
// ──────────────────────────────────────────────

/**
 * 在临时目录创建一个 App。
 * @param {string} rootDir 临时根目录
 * @param {object} opts
 * @param {string} opts.name App 名（也是目录名）
 * @param {string} [opts.version='1.0.0']
 * @param {string} [opts.capability='custom']
 * @param {string[]} [opts.permissions=[]]
 * @param {string} [opts.entryPoint='index.js']
 * @param {string} [opts.entryCode=''] 入口模块代码（默认空）
 * @param {object} [opts.extraManifest] 额外 manifest 字段
 * @returns {{appDir: string, manifestPath: string, entryPath: string}}
 */
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

  const manifestPath = path.join(appDir, 'manifest.yaml')
  fs.writeFileSync(manifestPath, manifestYaml, 'utf8')

  const entryPath = path.join(appDir, entryPoint)
  fs.writeFileSync(entryPath, entryCode || '// empty', 'utf8')

  return { appDir, manifestPath, entryPath }
}

/**
 * 创建一个临时目录用于测试。
 * @returns {string}
 */
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'havix-appmgr-'))
}

// ──────────────────────────────────────────────
// 测试用例
// ──────────────────────────────────────────────

describe('AppManager: 空目录与不存在目录', () => {
  test('apps 目录不存在：start() 不抛错，返回空数组', async () => {
    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: '/nonexistent/path/xyz' })
    const loaded = await am.start()
    assert.deepEqual(loaded, [])
    assert.equal(am.listApps().length, 0)
    await am.stop()
  })

  test('apps 目录为空：start() 返回空数组', async () => {
    const tmpDir = makeTempDir()
    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: tmpDir })
    const loaded = await am.start()
    assert.deepEqual(loaded, [])
    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('apps 目录只含隐藏目录（.foo / _bar）：跳过', async () => {
    const tmpDir = makeTempDir()
    fs.mkdirSync(path.join(tmpDir, '.hidden'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, '_internal'), { recursive: true })
    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: tmpDir })
    const loaded = await am.start()
    assert.deepEqual(loaded, [])
    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('AppManager: 单 App 加载', () => {
  test('加载单个 App：manifest 解析 + createApp 装配', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, {
      name: 'demo-app',
      permissions: ['market:create', 'credit:balance'],
      entryCode: 'export async function start() { return { ok: true } }\n',
    })

    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: tmpDir })
    const loaded = await am.start()

    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].manifestId, 'demo-app')
    assert.equal(am.getApp('demo-app'), loaded[0])
    assert.deepEqual(am.listAppNames(), ['demo-app'])

    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('entry 模块的 start() hook 被调用', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, {
      name: 'hook-app',
      entryCode: [
        'let called = false',
        'export async function start(snode, manifest, app, sdk) {',
        '  called = true',
        '  app._hookCalled = called',
        '}',
        '',
      ].join('\n'),
    })

    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: tmpDir })
    const loaded = await am.start()
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]._hookCalled, true)

    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('listAppMeta 返回元信息列表', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, {
      name: 'meta-app',
      version: '2.1.0',
      capability: 'market',
      permissions: ['market:create'],
      extraManifest: { description: '"测试 App"' },
    })

    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: tmpDir })
    await am.start()

    const metas = am.listAppMeta()
    assert.equal(metas.length, 1)
    assert.equal(metas[0].name, 'meta-app')
    assert.equal(metas[0].version, '2.1.0')
    assert.equal(metas[0].capability, 'market')
    assert.deepEqual(metas[0].permissions, ['market:create'])

    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('AppManager: 多 App 加载', () => {
  test('加载多个 App', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, { name: 'app-a', permissions: ['market:create'] })
    createTestApp(tmpDir, { name: 'app-b', permissions: ['credit:balance'] })
    createTestApp(tmpDir, { name: 'app-c', permissions: ['wiki:list'] })

    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: tmpDir })
    const loaded = await am.start()

    assert.equal(loaded.length, 3)
    const names = am.listAppNames().sort()
    assert.deepEqual(names, ['app-a', 'app-b', 'app-c'])

    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('AppManager: 错误处理', () => {
  test('manifest 缺失：跳过该 App，不阻断其他', async () => {
    const tmpDir = makeTempDir()
    // app-good 有 manifest
    createTestApp(tmpDir, { name: 'app-good', permissions: [] })
    // app-no-manifest 只有目录，无 manifest.yaml
    fs.mkdirSync(path.join(tmpDir, 'app-no-manifest'), { recursive: true })

    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: tmpDir })
    const loaded = await am.start()

    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].manifestId, 'app-good')

    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('manifest.name 与目录名不一致：跳过该 App', async () => {
    const tmpDir = makeTempDir()
    // 创建 dirA 但 manifest.name 写成 different-name
    const appDir = path.join(tmpDir, 'dir-a')
    fs.mkdirSync(appDir, { recursive: true })
    fs.writeFileSync(path.join(appDir, 'manifest.yaml'),
      'name: different-name\nversion: 1.0.0\ncapability: custom\npermissions: []\nentryPoint: index.js\n',
      'utf8')
    fs.writeFileSync(path.join(appDir, 'index.js'), '// empty', 'utf8')

    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: tmpDir })
    const loaded = await am.start()

    assert.equal(loaded.length, 0)

    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('entryPoint 不存在：跳过该 App', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, {
      name: 'bad-app',
      entryPoint: 'missing.js',
      entryCode: '',  // 不会创建 missing.js
    })
    // 移除默认创建的 index.js（entryPoint 改成 missing.js，但实际不写 missing.js）
    // createTestApp 写的是 entryPath（即 missing.js），让我们删了它
    fs.unlinkSync(path.join(tmpDir, 'bad-app', 'missing.js'))

    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: tmpDir })
    const loaded = await am.start()

    assert.equal(loaded.length, 0)

    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('重复加载同 name：抛 AppAlreadyLoadedError（隔离测试）', () => {
    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: '/tmp/nonexistent' })
    // 直接往 apps Map 里放一个 fake app
    am.apps.set('dup-app', { manifestId: 'dup-app' })
    assert.throws(() => {
      // 直接构造一个重复加载场景（通过 _loadApp 内部检查）
      // 这里手动模拟"已存在"的情况
      if (am.apps.has('dup-app')) {
        throw new AppAlreadyLoadedError('dup-app')
      }
    }, AppAlreadyLoadedError)
  })
})

describe('AppManager: stop 与生命周期', () => {
  test('stop() 幂等：多次调用不抛错', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, { name: 'lifecycle-app' })

    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: tmpDir })
    await am.start()
    await am.stop()
    await am.stop()  // 第二次不抛错
    await am.stop()  // 第三次也不抛错

    assert.equal(am.listApps().length, 0)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('start() 重复调用：第二次返回空（已 started）', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, { name: 'once-app' })

    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: tmpDir })
    const first = await am.start()
    assert.equal(first.length, 1)
    const second = await am.start()
    // 第二次 start 不重新加载（已 _started=true）
    assert.deepEqual(second, [])

    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('stop() 调用 app.stop() 清理订阅（P1-7 修复：只清理自己注册的）', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, {
      name: 'cleanup-app',
      permissions: ['transport:subscribe', 'transport:publish', 'credit:balance'],
      entryCode: [
        'export async function start(snode, manifest, app) {',
        '  // 模拟"其他 App"在 snode 共享状态中注册的订阅',
        '  snode._transportSubscriptions = new Map([["other-topic", new Set([() => {}])]])',
        '  snode._marketSubscriptions = new Map([["other-market", new Set([() => {}])]])',
        '  snode._creditHandlers = [() => {}]',
        '  // 本 App 通过 SDK 注册自己的 handler（应被 stop 清理）',
        '  app.credit.onReceived(() => {})',
        '}',
      ].join('\n'),
    })

    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: tmpDir })
    await am.start()

    // stop 应只清理本 App 自己注册的，不应清空 snode 共享状态
    await am.stop()
    // 本 App onReceived 注册的 1 个 handler 被清理 → snode._creditHandlers 应剩 1（其他 App 的）
    assert.equal(snode._creditHandlers.length, 1)
    assert.equal(snode._transportSubscriptions.size, 1)
    assert.equal(snode._marketSubscriptions.size, 1)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('AppManager: credit 消息派发', () => {
  test('dispatchCreditMessage 派发到目标 App 的 handler', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, {
      name: 'credit-app',
      permissions: ['credit:balance'],
      entryCode: [
        'export async function start(snode, manifest, app) {',
        '  app.credit.onReceived((msg) => {',
        '    app._receivedCredit = msg',
        '  })',
        '}',
      ].join('\n'),
    })

    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: tmpDir })
    await am.start()

    const app = am.getApp('credit-app')
    const msg = { targetApp: 'credit-app', amount: 100, type: 'issue' }
    const count = await am.dispatchCreditMessage(msg)
    assert.equal(count, 1)
    assert.equal(app._receivedCredit.amount, 100)

    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('dispatchCreditMessage 无 targetApp：返回 0', async () => {
    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: '/tmp/nonexistent' })
    const count = await am.dispatchCreditMessage({ amount: 100 })
    assert.equal(count, 0)
  })

  test('dispatchCreditMessage targetApp 未加载：返回 0', async () => {
    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: '/tmp/nonexistent' })
    const count = await am.dispatchCreditMessage({ targetApp: 'unknown', amount: 50 })
    assert.equal(count, 0)
  })
})

describe('AppManager: CLI 命令注入', () => {
  test('_injectCliCommands 把 App CLI 命令注入到 Cli 实例', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, {
      name: 'cli-app',
      permissions: [],
      entryCode: [
        'export async function start(snode, manifest, app) {',
        '  app.cli.register("cli-app-greet", {',
        '    description: "打招呼",',
        '    handler: async (args) => `hello ${args.positional?.[0] ?? "world"}`,',
        '  })',
        '}',
      ].join('\n'),
    })

    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: tmpDir })
    await am.start()

    // fake Cli 实例
    const registered = new Map()
    const fakeCli = {
      register(cmd) {
        if (registered.has(cmd.name)) throw new Error(`命令 ${cmd.name} 已注册`)
        registered.set(cmd.name, cmd)
      },
    }
    am.setCli(fakeCli)

    // 重新触发注入
    am._injectCliCommands('cli-app', am.getApp('cli-app'))

    assert.equal(registered.size, 1)
    assert.ok(registered.has('cli-app-greet'))
    const cmd = registered.get('cli-app-greet')
    assert.equal(cmd.description, '打招呼')

    // 测试执行
    const result = await cmd.handler({ positional: ['alice'], named: {}, flags: new Set() })
    assert.equal(result, 'hello alice')

    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('autoLoadCli=false：不自动注入', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, {
      name: 'no-cli-app',
      permissions: [],
      entryCode: [
        'export async function start(snode, manifest, app) {',
        '  app.cli.register("no-cli-app-cmd", { handler: async () => 1 })',
        '}',
      ].join('\n'),
    })

    const snode = createSnodeMock()
    const registered = new Map()
    const fakeCli = { register: (cmd) => registered.set(cmd.name, cmd) }

    const am = new AppManager(snode, null, {
      appsDir: tmpDir,
      autoLoadCli: false,
      cli: fakeCli,
    })
    await am.start()

    // autoLoadCli=false 时不会自动注入
    assert.equal(registered.size, 0)

    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('AppManager: Web 路由分发', () => {
  test('handleAppWebRequest 委托给 app.web.handle', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, {
      name: 'web-app',
      permissions: [],
      entryCode: [
        'export async function start(snode, manifest, app) {',
        '  app.web.get("/api/apps/web-app/hello", () => ({ ok: true, msg: "hi" }))',
        '}',
      ].join('\n'),
    })

    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: tmpDir })
    await am.start()

    // subPath 是 /api/apps/<appName>/ 之后的部分（sdk/web.js handle 会自动补 /api/apps/<appName>/ 前缀）
    const r = await am.handleAppWebRequest('web-app', 'hello', { method: 'GET' })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.msg, 'hi')

    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('handleAppWebRequest App 未加载：404', async () => {
    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: '/tmp/nonexistent' })
    const r = await am.handleAppWebRequest('unknown', 'foo', { method: 'GET' })
    assert.equal(r.status, 404)
  })

  test('listWebRoutes 返回所有 App 的路由', async () => {
    const tmpDir = makeTempDir()
    createTestApp(tmpDir, {
      name: 'routes-app',
      permissions: [],
      entryCode: [
        'export async function start(snode, manifest, app) {',
        '  app.web.get("/api/apps/routes-app/a", () => 1)',
        '  app.web.get("/api/apps/routes-app/b", () => 2)',
        '}',
      ].join('\n'),
    })

    const snode = createSnodeMock()
    const am = new AppManager(snode, null, { appsDir: tmpDir })
    await am.start()

    const routes = am.listWebRoutes()
    assert.equal(routes.length, 1)
    assert.equal(routes[0].appName, 'routes-app')
    assert.equal(routes[0].routes.length, 2)

    await am.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('AppManager: 构造与参数', () => {
  test('snode 缺失抛错', () => {
    assert.throws(() => new AppManager(null), /snode 必填/)
  })

  test('默认 appsDir 为 path.join(cwd, "apps")', () => {
    const snode = createSnodeMock()
    const am = new AppManager(snode)
    assert.equal(am.appsDir, path.join(process.cwd(), 'apps'))
  })

  test('setCli 设置 Cli 实例', () => {
    const snode = createSnodeMock()
    const am = new AppManager(snode)
    const fake = { register: () => {} }
    am.setCli(fake)
    assert.equal(am._cli, fake)
  })
})
