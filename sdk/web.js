// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Havix SDK web API（M9.2）
 * ───────────────────────────────────────────────
 * Web 路由注册层。
 *
 * 严格遵循 M8.2 GET-only 约束（M9 理论修正）：
 *   - 只允许注册 GET 路由
 *   - 不提供 post / put / delete 接口
 *   - mutation 操作必须走 app.cli.register
 *
 * M9.2 范围：
 *   - 提供 mount / get / hasRoute / listRoutes / handle 接口
 *   - 在 App 实例内部维护路由表
 *   - M9.4 AppManager 接入 WebPanel 时调用 handle(req, res, subPath) 派发请求
 *
 * 用法：
 *   app.web.mount('/apps/translation-market/', { type: 'static', dir: './webui/' })
 *   app.web.get('/api/apps/translation-market/offers', async (req) => {
 *     return { offers: await listOffers() }
 *   })
 *   // ❌ app.web.post 不存在
 */

// 路由记录结构：{ method: 'GET', path: string, type: 'static'|'api', handler: function, dir?: string }

import { validateDataDir } from './manifest.js'

/**
 * 创建 web API 实例。
 *
 * @param {object} snode SNode 实例
 * @param {import('./manifest.js').AppManifest} manifest App Manifest
 * @returns {object} web API
 */
export function createWebApi(snode, manifest) {
  if (!snode) throw new Error('createWebApi: snode 必填')
  if (!manifest) throw new Error('createWebApi: manifest 必填')

  const appName = manifest.name

  // 内部路由表
  const routes = []
  // 静态文件挂载点
  const mounts = []

  /**
   * 校验 path：必须以 / 开头，必须以 /apps/<appName>/ 为前缀（隔离 App 间路由）。
   */
  function validatePath(p) {
    if (typeof p !== 'string' || p.length === 0) {
      throw new Error('web: path 必须是非空字符串')
    }
    if (!p.startsWith('/')) {
      throw new Error(`web: path 必须以 / 开头，实际: ${p}`)
    }
    // 强制 App 路由以 /apps/<appName>/ 开头（防越权注册其他 App 的路由）
    const expectedPrefix = `/apps/${appName}/`
    if (!p.startsWith(expectedPrefix) && !p.startsWith(`/api/apps/${appName}/`)) {
      throw new Error(
        `web: path 必须以 ${expectedPrefix} 或 /api/apps/${appName}/ 开头（隔离 App 间路由），实际: ${p}`,
      )
    }
  }

  /**
   * 挂载静态文件目录。
   * @param {string} mountPath 如 '/apps/translation-market/'
   * @param {object} opts
   * @param {string} opts.type 必须 'static'
   * @param {string} opts.dir 静态文件目录相对路径
   * @returns {void}
   */
  function mount(mountPath, opts = {}) {
    if (opts.type !== 'static') {
      throw new Error('web.mount: opts.type 必须是 "static"')
    }
    if (typeof opts.dir !== 'string' || opts.dir.length === 0) {
      throw new Error('web.mount: opts.dir 必须是非空字符串')
    }
    // P1-5 修复：opts.dir 必须经过路径穿越校验
    //   mount() 后续会从 opts.dir 读取静态文件，未校验可让 App 读取任意目录。
    //   复用 manifest.js 的 validateDataDir（语义一致：相对路径 + 无 .. + 无绝对路径）。
    validateDataDir(opts.dir, appName)
    // 先做基本校验（非空 / 以 / 开头 / 以 / 结尾），再 validatePath 检查前缀
    // ——避免 path 无尾 / 时被前缀校验先抛错，掩盖真正的"缺尾 /"问题
    if (typeof mountPath !== 'string' || mountPath.length === 0) {
      throw new Error('web: path 必须是非空字符串')
    }
    if (!mountPath.startsWith('/')) {
      throw new Error(`web: path 必须以 / 开头，实际: ${mountPath}`)
    }
    if (!mountPath.endsWith('/')) {
      throw new Error('web.mount: mountPath 必须以 / 结尾（静态目录）')
    }
    validatePath(mountPath)
    // 不允许重复挂载同一路径
    if (mounts.find(m => m.mountPath === mountPath)) {
      throw new Error(`web.mount: 路径 ${mountPath} 已挂载`)
    }
    mounts.push({ mountPath, type: 'static', dir: opts.dir })
  }

  /**
   * 注册 GET API 端点。
   * @param {string} path 如 '/api/apps/translation-market/offers'
   * @param {function} handler async (req) => response | { status, body, headers }
   * @returns {void}
   */
  function get(path, handler) {
    validatePath(path)
    if (typeof handler !== 'function') {
      throw new Error('web.get: handler 必须是函数')
    }
    if (routes.find(r => r.path === path && r.method === 'GET')) {
      throw new Error(`web.get: 路径 ${path} 已注册`)
    }
    routes.push({ method: 'GET', path, type: 'api', handler })
  }

  /**
   * 列出已注册路由（M9.4 AppManager 用于检查冲突 / 调试）。
   * @returns {Array<object>}
   */
  function listRoutes() {
    return [...routes, ...mounts]
  }

  /**
   * 查询是否注册了某路径。
   * @param {string} path
   * @returns {boolean}
   */
  function hasRoute(path) {
    return routes.some(r => r.path === path) || mounts.some(m => path.startsWith(m.mountPath))
  }

  /**
   * 处理请求（由 AppManager 在 WebPanel._handleAppRoute 调用）。
   *
   * @param {string} subPath 子路径（已剥离 /apps/<appName>/ 前缀）
   * @param {object} req { method, headers, query }
   * @returns {Promise<{ status: number, body: any, headers: object }>}
   */
  async function handle(subPath, req = {}) {
    // 强制 GET-only
    if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
      return {
        status: 405,
        body: {
          error: 'App Web API 仅支持 GET（M9 理论修正：协议即法律，mutation 走 CLI）',
          hint: 'mutation 操作请到 REPL 执行对应 CLI 命令',
        },
        headers: { 'Allow': 'GET, HEAD' },
      }
    }

    // 完整路径重建（用 appName 前缀）
    const fullApiPath = `/api/apps/${appName}/${subPath.replace(/^\//, '')}`
    const fullStaticPath = `/apps/${appName}/${subPath.replace(/^\//, '')}`

    // 先查 API 路由（精确匹配）
    const apiRoute = routes.find(r => r.path === fullApiPath)
    if (apiRoute) {
      try {
        const result = await apiRoute.handler({ ...req, path: fullApiPath, params: {} })
        // handler 返回值兼容：
        //   - { status, body, headers } 完整响应
        //   - 任意其他值视为 body（200 + Content-Type: application/json）
        if (result && typeof result === 'object' && ('status' in result || 'body' in result)) {
          return {
            status: result.status ?? 200,
            body: result.body ?? null,
            headers: result.headers ?? { 'Content-Type': 'application/json' },
          }
        }
        return { status: 200, body: result, headers: { 'Content-Type': 'application/json' } }
      } catch (err) {
        return {
          status: 500,
          body: { error: err.message },
          headers: { 'Content-Type': 'application/json' },
        }
      }
    }

    // 再查静态挂载（前缀匹配）
    const staticMount = mounts.find(m => fullStaticPath.startsWith(m.mountPath))
    if (staticMount) {
      return {
        status: 200,
        body: { _static: true, dir: staticMount.dir, path: fullStaticPath },
        headers: { 'Content-Type': 'text/html' },
      }
      // 实际静态文件由 AppManager 接入 WebPanel 时读取磁盘返回，M9.2 仅返回占位
    }

    return {
      status: 404,
      body: { error: `App ${appName} 未注册路径 ${fullApiPath} / ${fullStaticPath}` },
      headers: { 'Content-Type': 'application/json' },
    }
  }

  // ── 显式提供 GET-only 约束的 API ──
  // 不提供 post/put/delete 方法（访问会得到 undefined）
  // 这里直接返回 web 对象，调用方尝试 .post 会被 JS 视为 undefined 调用抛 TypeError

  return {
    mount,
    get,
    listRoutes,
    hasRoute,
    handle,
    // 显式声明约束（防止 IDE 自动补全 post/put/delete）
    _constraint: 'GET-only (M9 理论修正)',
  }
}
