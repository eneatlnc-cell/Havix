/**
 * Havix App 容器管理器（M9.3）
 * ───────────────────────────────────────────────
 * AppManager 负责：
 *   1. 扫描 apps/ 目录下的子目录
 *   2. 每个子目录读 manifest.yaml 解析为 AppManifest
 *   3. 加载 entryPoint（ES module default export { start(snode, manifest, sdk) }）
 *   4. 调用 sdk.createApp(snode, manifest, options) 装配子模块
 *   5. 把 App 注册的 CLI 命令汇总注入 SNode 的 Cli 实例（<appName>-<cmd>）
 *   6. SNode 接收 credit 消息时按 appName 派发到对应 App 的 credit.onReceived
 *   7. stop() 时按启动反序停止所有 App，清空订阅与状态
 *
 * 设计要点：
 *   - 单一 App 加载失败不阻断其他 App（log warn 跳过）
 *   - App 加载是异步的（await import()）
 *   - manifest.yaml 解析失败 / entryPoint 加载失败 / start() 抛错都视为加载失败
 *   - AppManager 不持有 libp2p / helia 句柄；只持有 app 实例 Map
 *   - stop() 是幂等的（多次调用不抛错）
 *
 * 测试策略：
 *   - 单元测试用临时目录 + 内存 fake SNode + createSnodeMock
 *   - 测试覆盖：空目录 / 单 App 多 App / manifest 缺失 / start 抛错 / stop 幂等
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AppManifest } from '../../sdk/manifest.js'
import { createApp } from '../../sdk/app.js'
import { AppAlreadyLoadedError, InvalidAppStateError } from '../../sdk/errors.js'

/**
 * @typedef {Object} AppManagerOptions
 * @property {string} [appsDir] App 目录路径（默认 path.join(cwd, 'apps')）
 * @property {object} [sdk] SDK 模块（默认懒加载 ../../sdk/index.js；测试可注入）
 * @property {boolean} [autoStart] 是否在构造时立即 start（默认 false；startApp 流程控制）
 * @property {boolean} [autoLoadCli] 是否自动把 App.cli 命令注入 Cli 实例（默认 true）
 */

export class AppManager {
  /**
   * @param {object} snode SNode 实例
   * @param {object} [sdk] SDK 模块（含 createApp / AppManifest 等；可省略用懒加载）
   * @param {AppManagerOptions} [options]
   */
  constructor(snode, sdk = null, options = {}) {
    if (!snode) throw new Error('AppManager: snode 必填')
    this.snode = snode
    this.log = snode.log ?? (() => {})
    this.sdk = sdk
    this.appsDir = options.appsDir ?? path.join(process.cwd(), 'apps')
    this.autoLoadCli = options.autoLoadCli !== false
    /** @type {Map<string, object>} manifestId → app 实例 */
    this.apps = new Map()
    /** @type {Map<string, object>} manifestId → manifest 对象 */
    this.manifests = new Map()
    /** @type {Map<string, string>} appName → appDir 绝对路径 */
    this.appDirs = new Map()
    this._cli = options.cli ?? null  // 可选 Cli 实例（用于注入 App 命令）
    this._started = false
  }

  /**
   * 注入 Cli 实例（供 s-node.js startApp 在 AppManager.start() 前调用）。
   * 设置后，AppManager.start() 会把每个 App 注册的 cli 命令注入到此实例。
   * @param {object} cli Cli 实例
   */
  setCli(cli) {
    this._cli = cli
  }

  /**
   * 扫描 apps/ 目录加载所有 App。
   * 单个 App 加载失败不阻断其他 App。
   * @returns {Promise<object[]>} 成功加载的 App 实例列表
   */
  async start() {
    if (this._started) {
      this.log('warn', 'app-manager', 'start() 已调用过，跳过重复调用')
      return []  // 第二次调用返回空（已加载的 App 可通过 listApps() 获取）
    }
    this._started = true

    // apps 目录不存在视为空（首次启动）
    if (!fs.existsSync(this.appsDir)) {
      this.log('info', 'app-manager', `apps 目录不存在: ${this.appsDir}（无 App 加载）`)
      return []
    }

    let entries
    try {
      entries = await fs.promises.readdir(this.appsDir, { withFileTypes: true })
    } catch (err) {
      this.log('warn', 'app-manager', `读取 apps 目录失败: ${err.message}`)
      return []
    }

    const loaded = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // 跳过隐藏目录（如 .git / .cache）
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue

      try {
        const app = await this._loadApp(entry.name)
        loaded.push(app)
      } catch (err) {
        // 单 App 失败不阻断其他 App
        this.log('warn', 'app-manager',
          `加载 App "${entry.name}" 失败: ${err.message}`)
      }
    }

    this.log('info', 'app-manager',
      `加载完成：${loaded.length} 个 App（${loaded.map(a => a.manifestId).join(', ') || '空'}）`)

    return loaded
  }

  /**
   * 加载单个 App（内部用）。
   * @param {string} dirName apps/ 下的子目录名
   * @returns {Promise<object>} app 实例
   * @private
   */
  async _loadApp(dirName) {
    const appDir = path.resolve(this.appsDir, dirName)
    const manifestPath = path.join(appDir, 'manifest.yaml')

    // 1. manifest.yaml 必须存在
    if (!fs.existsSync(manifestPath)) {
      throw new InvalidAppStateError(
        `App "${dirName}" 缺少 manifest.yaml（路径: ${manifestPath}）`,
        { details: { appDir, manifestPath } },
      )
    }

    // 2. 解析 manifest
    const yamlText = await fs.promises.readFile(manifestPath, 'utf8')
    const manifest = AppManifest.fromYaml(yamlText)

    // 3. 检查 name 与目录名一致（防 apps/foo/ 放 apps/bar 的 manifest）
    if (manifest.name !== dirName) {
      throw new InvalidAppStateError(
        `App 目录名 "${dirName}" 与 manifest.name "${manifest.name}" 不一致`,
        { details: { dirName, manifestName: manifest.name } },
      )
    }

    // 4. 检查未重复加载
    if (this.apps.has(manifest.name)) {
      throw new AppAlreadyLoadedError(manifest.name)
    }

    // 5. 动态加载 entryPoint（ES module）
    const entryPath = path.resolve(appDir, manifest.entryPoint)
    if (!fs.existsSync(entryPath)) {
      throw new InvalidAppStateError(
        `App "${manifest.name}" 的 entryPoint 不存在: ${manifest.entryPoint}（路径: ${entryPath}）`,
        { details: { entryPoint: manifest.entryPoint, entryPath } },
      )
    }

    let entryModule
    try {
      entryModule = await import(pathToFileURL(entryPath).href)
    } catch (err) {
      throw new InvalidAppStateError(
        `App "${manifest.name}" 入口模块加载失败: ${err.message}`,
        { details: { entryPath, cause: err.message } },
      )
    }

    // 6. 调用 sdk.createApp 装配子模块
    //    entryPoint 模块可导出 start(snode, manifest, sdk) 用于自定义初始化
    //    （如注册 web 路由、cli 命令、credit handler 等）
    const sdk = this.sdk ?? (await import('../../sdk/index.js'))
    const app = await createApp(this.snode, manifest, {
      dataDir: manifest.dataDir,
      // 真实 SNode 集成时启用持久化（懒加载 src/persistence.js）
      persist: undefined,
      log: this.log,
    })

    // 7. 调用 entry 模块的 start() hook（如存在）
    if (typeof entryModule.start === 'function') {
      try {
        await entryModule.start(this.snode, manifest, app, sdk)
      } catch (err) {
        // start hook 失败不阻断 App 加载（视为可选初始化失败）
        this.log('warn', 'app-manager',
          `App "${manifest.name}" start() hook 失败: ${err.message}`)
      }
    }

    // 8. 注册到 Map
    this.apps.set(manifest.name, app)
    this.manifests.set(manifest.name, manifest)
    this.appDirs.set(manifest.name, appDir)

    // 9. 自动注入 Cli 命令到 Cli 实例
    if (this.autoLoadCli && this._cli && app.cli) {
      this._injectCliCommands(manifest.name, app)
    }

    this.log('info', 'app-manager',
      `加载 App: ${manifest.name} v${manifest.version}（capability=${manifest.capability}）`)

    return app
  }

  /**
   * 把 App.cli 注册的命令注入到 Cli 实例。
   * 命令名前缀 `<appName>-` 已在 sdk/cli.js 校验过，这里直接 register。
   * @param {string} appName
   * @param {object} app
   * @private
   */
  _injectCliCommands(appName, app) {
    if (!app.cli || typeof app.cli.listCommands !== 'function') return
    const cmds = app.cli.listCommands()
    for (const cmd of cmds) {
      try {
        // Cli.register 期望 { name, description, category, args, handler } 结构
        // handler 签名：(parsedArgs, ctx) => any
        // parsedArgs = { positional: string[], named: object, flags: Set }
        // App.cli.execute 期望 args 是任意对象（含 positional / named / flags 三个字段）
        this._cli.register({
          name: cmd.name,
          description: cmd.description,
          category: cmd.category ?? `app:${appName}`,
          args: cmd.args,
          handler: async (parsedArgs, ctx) => {
            return await app.cli.execute(cmd.name, parsedArgs)
          },
        })
      } catch (err) {
        // 重复注册等错误不阻断其他命令
        this.log('warn', 'app-manager',
          `App "${appName}" 命令 "${cmd.name}" 注入 Cli 失败: ${err.message}`)
      }
    }
  }

  /**
   * 停止所有 App（按启动反序）。
   * 幂等：多次调用不抛错。
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this._started) return
    this._started = false

    // 启动反序停止
    const apps = [...this.apps.entries()].reverse()
    for (const [name, app] of apps) {
      try {
        await app.stop?.()
      } catch (err) {
        this.log('warn', 'app-manager', `App "${name}" stop 失败: ${err.message}`)
      }
    }

    this.apps.clear()
    this.manifests.clear()
    this.appDirs.clear()
  }

  /**
   * 按 manifestId 取 App 实例。
   * @param {string} name
   * @returns {object|undefined}
   */
  getApp(name) {
    return this.apps.get(name)
  }

  /**
   * 列出所有已加载 App。
   * @returns {object[]}
   */
  listApps() {
    return [...this.apps.values()]
  }

  /**
   * 列出所有已加载 App 名。
   * @returns {string[]}
   */
  listAppNames() {
    return [...this.apps.keys()]
  }

  /**
   * 列出所有 App 的元信息（用于 WebPanel /api/apps 列表）。
   * @returns {Array<{name, version, capability, manifestId, dataDir}>}
   */
  listAppMeta() {
    const result = []
    for (const [name, app] of this.apps) {
      const m = app.manifest
      result.push({
        name,
        manifestId: app.manifestId,
        version: m.version,
        capability: m.capability,
        dataDir: app.dataDir,
        permissions: m.permissions,
        contexts: m.contexts,
        description: m.description,
      })
    }
    return result
  }

  /**
   * 派发 credit 消息到对应 App 的 onReceived handler。
   * 由 SNode._handleCreditMessage 在收到 credit 消息时调用。
   *
   * 消息体应包含 targetApp 字段（M9.3 约定）指定目标 App 名。
   * 缺失 targetApp 或对应 App 未加载时静默跳过（不抛错）。
   *
   * @param {object} creditMsg credit 消息体（含 targetApp / amount / holderDid 等）
   * @returns {Promise<number>} 实际派发的 handler 数量
   */
  async dispatchCreditMessage(creditMsg) {
    const targetApp = creditMsg?.targetApp
    if (!targetApp) return 0
    const app = this.apps.get(targetApp)
    if (!app) return 0
    if (!app.credit || typeof app.credit._onReceived !== 'function') return 0
    try {
      await app.credit._onReceived(creditMsg)
      return 1
    } catch (err) {
      this.log('warn', 'app-manager',
        `App "${targetApp}" credit onReceived 失败: ${err.message}`)
      return 0
    }
  }

  /**
   * 取所有 App 的 web 路由（用于 WebPanel 路由分发）。
   * @returns {Array<{appName, routes}>}
   */
  listWebRoutes() {
    const result = []
    for (const [name, app] of this.apps) {
      if (!app.web) continue
      const routes = app.web.listRoutes?.() ?? []
      result.push({ appName: name, routes })
    }
    return result
  }

  /**
   * 处理 /apps/<appName>/<subPath> 路由请求。
   * 由 WebPanel 在收到 /apps/ 前缀请求时调用。
   *
   * @param {string} appName
   * @param {string} subPath
   * @param {object} [req] HTTP 请求对象（含 method / headers / url）
   * @returns {Promise<{status: number, body: any, headers?: object}>}
   */
  async handleAppWebRequest(appName, subPath, req = {}) {
    const app = this.apps.get(appName)
    if (!app) {
      return { status: 404, body: { error: `App "${appName}" 未加载` } }
    }
    if (!app.web) {
      return { status: 503, body: { error: `App "${appName}" 无 web 子模块` } }
    }
    // 委托给 sdk/web.js 的 handle()（async）
    return await app.web.handle(subPath, req)
  }
}

export default AppManager
