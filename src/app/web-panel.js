// SPDX-License-Identifier: Apache-2.0

/**
 * Havix 本地 Web 面板（M8.2-4）
 * ───────────────────────────────────────────────
 * 设计目标（白皮书 M8："本地 Web 面板 · 拓扑可视化"）：
 *   节点启动后开一个仅绑定 127.0.0.1 的本地 HTTP server，
 *   提供 JSON API + 一个内嵌 vis-network 的拓扑可视化页面，
 *   让运维人员在浏览器里直接观察节点状态与网络拓扑。
 *
 * 模块边界：
 *   - 本模块只做"读视图"——所有 mutation 走 CLI（M8.2-3）
 *   - 与 CLI 互补：CLI 提供交互操作，Web 提供只读可视化
 *   - 不直接访问 libp2p 内部细节，通过 SNode 公开接口 + 各 registry 字段
 *   - 诊断视图模式：与 cli.js 的 _cmdStatus 一致，允许直接读 registry 内部 Map
 *
 * 安全约束（重要）：
 *   1. 仅绑定 127.0.0.1——不暴露公网（避免被远程探测 / 攻击）
 *   2. GET-only——不提供任何 mutation 接口（所有写操作走 CLI）
 *   3. 不显示私钥——只显示 DID（与 CLI 脱敏原则一致）
 *   4. 无认证——MVP 阶段依赖"仅本地访问"，未来扩展可加 token
 *
 * 路由表：
 *   GET /                          HTML 页面（内嵌 vis-network CDN + 拓扑图 JS）
 *   GET /api/status                节点概览（peerId / 多地址 / 邻居数 / topic / registry 计数）
 *   GET /api/identity              4-context DID 列表
 *   GET /api/neighbors             已连接 peer 列表
 *   GET /api/topics                订阅 topic 列表
 *   GET /api/topology              vis-network 节点+边数据（聚合 view）
 *   GET /api/registry/vouch        vouch 详情
 *   GET /api/registry/wiki         维基条目列表
 *   GET /api/registry/credit       credit / reputation 三元组
 *   GET /api/registry/dispute      dispute 列表 + 投票统计
 *   GET /api/registry/market       市场列表 + manifest
 *   GET /api/registry/treasury     金库余额 + 历史
 *   GET /api/registry/tunnel       隧道列表 + 状态
 *   GET /api/registry/relay        relay 状态 + 候选
 *   GET /api/apps                  已加载 App 列表（M9.4 新增）
 *   GET /apps/<appName>/...        App 路由分发到 AppManager（M9.4 新增）
 *   GET /api/apps/<appName>/...    App API 路由分发到 AppManager（M9.4 新增）
 *   GET /healthz                   健康检查（200 OK）
 *
 * vis-network 数据模型：
 *   nodes: [{ id, label, group, title }]
 *     - self:        本节点 peerId（中心节点）
 *     - did-{A|B|C|D}: 本节点 4-context DID
 *     - peer:        邻居 peer
 *     - relay-active / relay-candidate: relay 节点
 *     - market:      市场节点
 *   edges: [{ from, to, label, dashes }]
 *     - context: peerId → 4-context DID（实线）
 *     - p2p:    peerId ↔ peer（实线）
 *     - vouch:  voucher → endorseDid（虚线）
 *     - tunnel: sourceDid → targetDid（粗实线）
 *     - market: 创建者 → 市场（点线）
 *
 * 测试策略：
 *   - 单元测试通过 mock SNode + http.createServer 绑到 port=0
 *   - 用 fetch 验证各端点 JSON 结构与 HTML 内容
 *   - 验证只接受 GET、未路由路径返回 404
 */

import http from 'node:http'

// ──────────────────────────────────────────────
// 默认配置
// ──────────────────────────────────────────────

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 7331

// ──────────────────────────────────────────────
// WebPanel 主类
// ──────────────────────────────────────────────

export class WebPanel {
  /**
   * @param {object} node SNode 实例
   * @param {object} [opts]
   * @param {string} [opts.host] 监听地址，默认 127.0.0.1
   * @param {number} [opts.port] 监听端口，默认 7331；测试时可传 0 由系统分配
   */
  constructor(node, opts = {}) {
    this.node = node
    this.log = node?.log ?? (() => {})
    this.host = opts.host ?? DEFAULT_HOST
    this.port = opts.port ?? DEFAULT_PORT
    this.server = null
    this._actualPort = null
  }

  /**
   * 启动 HTTP server。
   * @returns {Promise<{host: string, port: number}>}
   */
  async start() {
    if (this.server) {
      throw new Error('WebPanel 已启动')
    }
    this.server = http.createServer((req, res) => {
      this._handle(req, res)
    })
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err)
      this.server.once('error', onError)
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address()
        this._actualPort = typeof addr === 'object' && addr ? addr.port : this.port
        this.server.removeListener('error', onError)
        this.log('info', 'web-panel',
          `Web 面板监听 http://${this.host}:${this._actualPort}`)
        resolve({ host: this.host, port: this._actualPort })
      })
    })
  }

  /**
   * 停止 HTTP server（幂等）。
   */
  async stop() {
    if (!this.server) return
    const srv = this.server
    this.server = null
    return new Promise((resolve) => {
      srv.close(() => resolve())
    })
  }

  /**
   * 取实际监听端口（启动后有效；测试用 port=0 时由系统分配）。
   */
  getActualPort() {
    return this._actualPort
  }

  /**
   * 取访问 URL（启动后有效）。
   */
  getUrl() {
    const port = this._actualPort ?? this.port
    return `http://${this.host}:${port}/`
  }

  // ──────────────────────────────────────────
  // HTTP 路由分发
  // ──────────────────────────────────────────

  _handle(req, res) {
    const url = new URL(req.url, `http://${this.host}`)
    const path = url.pathname

    try {
      // 安全（M8 审计修复 P1-F）：Host 头校验防 DNS rebinding 攻击。
      // 浏览器可携带恶意 Host 头访问 127.0.0.1，绕过同源策略。
      // 仅允许本机回环地址 / 空 Host（HTTP/1.0 客户端）。
      const port = this._actualPort ?? this.port
      const host = req.headers?.host ?? ''
      const allowedHosts = new Set([
        `${this.host}:${port}`,
        `localhost:${port}`,
        `127.0.0.1:${port}`,
        this.host,         // HTTP/1.0 无端口
        'localhost',
        '127.0.0.1',
        '',                // HTTP/1.0 无 Host 头
      ])
      if (!allowedHosts.has(host.toLowerCase())) {
        this._sendJson(res, 403, { error: 'Host 头不被信任（防 DNS rebinding）' })
        return
      }

      if (req.method !== 'GET') {
        this._sendJson(res, 405, {
          error: '仅支持 GET 方法',
          hint: 'App Web API 严格 GET-only（M9 理论修正：协议即法律，mutation 走 CLI）',
        })
        return
      }

      // App 路由分发（M9.4 新增）：/apps/<appName>/... 与 /api/apps/<appName>/...
      // 委托给 node.appManager.handleAppWebRequest（async）
      if (path === '/apps' || path.startsWith('/apps/')) {
        this._handleAppRoute(req, res, path, false)
        return
      }
      if (path === '/api/apps' || path.startsWith('/api/apps/')) {
        this._handleAppRoute(req, res, path, true)
        return
      }

      // 页面路由
      if (path === '/' || path === '/index.html') {
        this._sendHtml(res, 200, this._renderIndex())
        return
      }

      // 健康检查
      if (path === '/healthz') {
        this._sendJson(res, 200, { ok: true })
        return
      }

      // JSON API 路由
      const apiResult = this._routeApi(path)
      if (apiResult.found) {
        this._sendJson(res, 200, apiResult.data)
        return
      }

      this._sendJson(res, 404, { error: `未找到路由: ${path}` })
    } catch (err) {
      this._sendJson(res, 500, { error: err?.message ?? String(err) })
    }
  }

  /**
   * 路由 JSON API。
   * @param {string} path
   * @returns {{found: boolean, data?: any}}
   */
  _routeApi(path) {
    switch (path) {
      case '/api/status':
        return { found: true, data: this._apiStatus() }
      case '/api/identity':
        return { found: true, data: this._apiIdentity() }
      case '/api/neighbors':
        return { found: true, data: this._apiNeighbors() }
      case '/api/topics':
        return { found: true, data: this._apiTopics() }
      case '/api/topology':
        return { found: true, data: this._apiTopology() }
      case '/api/registry/vouch':
        return { found: true, data: this._apiVouch() }
      case '/api/registry/wiki':
        return { found: true, data: this._apiWiki() }
      case '/api/registry/credit':
        return { found: true, data: this._apiCredit() }
      case '/api/registry/dispute':
        return { found: true, data: this._apiDispute() }
      case '/api/registry/market':
        return { found: true, data: this._apiMarket() }
      case '/api/registry/treasury':
        return { found: true, data: this._apiTreasury() }
      case '/api/registry/tunnel':
        return { found: true, data: this._apiTunnel() }
      case '/api/registry/relay':
        return { found: true, data: this._apiRelay() }
      // /api/apps 路由分发到 AppManager（不在此处理，由 _handle 早期分流）
      // /api/apps/<appName>/... 同样在 _handle 早期分流到 _handleAppRoute
      default:
        return { found: false }
    }
  }

  /**
   * 处理 /apps/ 与 /api/apps/ 路由（M9.4 新增）。
   *
   * 路径模式：
   *   /apps                  → 列出已加载 App（HTML 索引）
   *   /apps/<appName>/...    → 委托给 AppManager.handleAppWebRequest(appName, subPath, req)
   *   /api/apps              → 列出已加载 App 元信息（JSON）
   *   /api/apps/<appName>/... → 委托给 AppManager.handleAppWebRequest（同上）
   *
   * AppManager 未启用时：
   *   /apps                  → 503 错误页
   *   /apps/<appName>/...    → 503 JSON
   *   /api/apps              → { ok: false, error: 'AppManager 未启用' }
   *   /api/apps/<appName>/... → 503 JSON
   *
   * @param {object} req HTTP 请求对象
   * @param {object} res HTTP 响应对象
   * @param {string} path 完整路径（如 /apps/foo/bar 或 /api/apps/foo/bar）
   * @param {boolean} isApi 是否为 /api/apps/ 前缀（JSON 响应）
   * @returns {Promise<void>}
   */
  async _handleAppRoute(req, res, path, isApi) {
    const am = this.node?.appManager

    // ── 1. /apps 或 /api/apps（无 appName）：返回 App 列表 ──
    if (path === '/apps' || path === '/api/apps') {
      if (!am) {
        return this._sendJson(res, 503, {
          ok: false,
          error: 'AppManager 未启用（使用 --apps 开启）',
        })
      }
      const apps = am.listAppMeta()
      if (isApi) {
        return this._sendJson(res, 200, { ok: true, count: apps.length, apps })
      }
      // /apps 列表 HTML
      const html = this._renderAppsIndex(apps)
      return this._sendHtml(res, 200, html)
    }

    // ── 2. /apps/<appName>/... 与 /api/apps/<appName>/...：分发到 AppManager ──
    // 路径解析：取第 2 段为 appName，剩余为 subPath
    const segments = path.split('/').filter(Boolean)  // ['apps', 'foo', 'bar'] 或 ['api', 'apps', 'foo', 'bar']
    const appName = isApi ? segments[2] : segments[1]
    if (!appName) {
      return this._sendJson(res, 404, { error: `路径格式错误：${path}` })
    }

    if (!am) {
      return this._sendJson(res, 503, {
        ok: false,
        error: `AppManager 未启用，无法处理 /apps/${appName}/（使用 --apps 开启）`,
      })
    }

    // 子路径（去掉前缀，保留 / 分隔）
    //   /apps/foo/bar/baz → subPath = "bar/baz"
    //   /api/apps/foo/bar → subPath = "bar/baz"
    const prefixSegments = isApi ? 3 : 2
    const restSegs = segments.slice(prefixSegments)
    const subPath = restSegs.join('/')

    try {
      const result = await am.handleAppWebRequest(appName, subPath, {
        method: req.method,
        headers: req.headers,
        url: req.url,
      })
      if (!result || typeof result !== 'object') {
        return this._sendJson(res, 500, { error: `App ${appName} 返回非对象` })
      }
      const status = result.status ?? 200
      const body = result.body ?? null
      const headers = result.headers ?? { 'Content-Type': 'application/json; charset=utf-8' }

      // 智能响应：根据 Content-Type 判断用 _sendHtml 还是 _sendJson
      const ct = headers['Content-Type'] || headers['content-type'] || ''
      if (typeof ct === 'string' && ct.includes('text/html')) {
        const html = typeof body === 'string' ? body : JSON.stringify(body)
        res.writeHead(status, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
          'Cache-Control': 'no-store',
        })
        return res.end(html)
      }
      // JSON 默认响应
      const json = typeof body === 'string' ? body : JSON.stringify(body)
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(json),
        'Cache-Control': 'no-store',
      })
      return res.end(json)
    } catch (err) {
      return this._sendJson(res, 500, {
        error: `App ${appName} 处理失败: ${err?.message ?? String(err)}`,
      })
    }
  }

  /**
   * 渲染 /apps 索引页（HTML）。
   * @param {Array<object>} apps listAppMeta() 返回值
   * @returns {string} HTML
   */
  _renderAppsIndex(apps) {
    const rows = (apps || []).map(a => `
      <tr>
        <td><a href="/apps/${a.name}/">${a.name}</a></td>
        <td>${a.version}</td>
        <td>${a.capability}</td>
        <td>${a.manifestId}</td>
        <td>${a.dataDir}</td>
        <td>${(a.permissions || []).join(', ') || '(空)'}</td>
        <td>${(a.contexts || []).join(', ') || '(无)'}</td>
        <td>${a.description || ''}</td>
      </tr>`).join('')

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Havix Apps · M9.4</title>
  <style>
    body { margin: 0; padding: 20px; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #0d1117; color: #c9d1d9; }
    h1 { color: #58a6ff; font-size: 20px; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; font-family: "SF Mono", "Consolas", monospace; }
    th { color: #f778ba; text-align: left; padding: 8px 12px; border-bottom: 1px solid #30363d; }
    td { padding: 8px 12px; border-bottom: 1px dashed #21262d; color: #79c0ff; }
    tr:hover td { background: #161b22; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .meta { color: #8b949e; font-size: 12px; margin-bottom: 16px; }
    .empty { color: #8b949e; padding: 32px 12px; text-align: center; }
  </style>
</head>
<body>
  <h1>Havix Apps · 已加载 ${apps?.length ?? 0} 个 App</h1>
  <div class="meta">
    <a href="/">← 返回拓扑首页</a> ·
    <a href="/api/apps">JSON API</a> ·
    仅 GET，mutation 走 CLI
  </div>
  ${apps && apps.length > 0 ? `
  <table>
    <thead>
      <tr>
        <th>name</th><th>version</th><th>capability</th><th>manifestId</th>
        <th>dataDir</th><th>permissions</th><th>contexts</th><th>description</th>
      </tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>` : `<div class="empty">暂无已加载的 App（apps 目录为空或不存）</div>`}
</body>
</html>`
  }

  // ──────────────────────────────────────────
  // JSON API 实现
  // ──────────────────────────────────────────

  _apiStatus() {
    const n = this.node
    if (!n) return { ok: false, error: '节点未初始化' }

    return {
      ok: true,
      peerId: n.libp2p?.peerId?.toString?.() ?? null,
      multiaddrs: n.libp2p?.getMultiaddrs?.().map(String) ?? [],
      connectedPeers: (n.libp2p?.getPeers?.() ?? []).map((p) => p.toString()),
      topicCount: n.libp2p?.services?.pubsub?.getTopics?.().length ?? 0,
      registry: {
        vouch: n.vouchRegistry?.vouches?.size ?? 0,
        wiki: n.wiki?.entries?.size ?? 0,
        reputation: n.reputationLedger?.balances?.size ?? 0,
        creditHolders: n.creditLedger?.balances?.size ?? 0,
        disputes: n.arbitrationRegistry?.disputes?.size ?? 0,
        jurorCandidates: n.arbitrationRegistry?.jurorPool?.size ?? 0,
        markets: n.marketRegistry?.listMarkets?.().length ?? 0,
        tunnels: n.tunnelManager?.listTunnels?.().length ?? 0,
        treasuryBalance: n.treasury?.getBalance?.() ?? 0,
        processedCreditNonces: n._processedCreditNonces?.size ?? 0,
      },
      // M9.4：AppManager 状态
      apps: {
        enabled: !!n.appManager,
        count: n.appManager?.listAppNames?.().length ?? 0,
        names: n.appManager?.listAppNames?.() ?? [],
      },
    }
  }

  _apiIdentity() {
    const n = this.node
    if (!n?.wallet) return { ok: false, error: '钱包未初始化' }

    const contexts = ['A', 'B', 'C', 'D']
    const labels = {
      A: '公开层活跃身份',
      B: '市场身份',
      C: '隧道身份',
      D: '维基编辑员',
    }
    const identities = {}
    for (const ctx of contexts) {
      const id = n.wallet.get(ctx)
      identities[ctx] = {
        did: id?.did ?? null,
        label: labels[ctx],
      }
    }
    return { ok: true, identities }
  }

  _apiNeighbors() {
    const n = this.node
    const peers = n?.libp2p?.getPeers?.() ?? []
    return {
      ok: true,
      count: peers.length,
      peers: peers.map((p) => {
        const id = p.toString()
        const conns = n.libp2p?.getConnections?.(p) ?? []
        const addrs = conns.map((c) => c.remoteAddr?.toString?.()).filter(Boolean)
        return { peerId: id, remoteAddrs: addrs }
      }),
    }
  }

  _apiTopics() {
    const n = this.node
    const topics = n?.libp2p?.services?.pubsub?.getTopics?.() ?? []
    return { ok: true, count: topics.length, topics }
  }

  /**
   * 拓扑视图：聚合 nodes + edges，供 vis-network 直接渲染。
   */
  _apiTopology() {
    const n = this.node
    if (!n) return { ok: false, error: '节点未初始化' }

    const nodes = []
    const edges = []
    const selfId = n.libp2p?.peerId?.toString?.() ?? 'self'

    // ── 中心节点 self（peerId） ──
    nodes.push({
      id: selfId,
      label: `self\n${selfId.slice(0, 12)}...`,
      group: 'self',
      title: `本节点\npeerId: ${selfId}`,
    })

    // ── 4-context DID 节点 ──
    if (n.wallet) {
      const ctxLabels = { A: '公开层', B: '市场', C: '隧道', D: '维基' }
      for (const ctx of ['A', 'B', 'C', 'D']) {
        const id = n.wallet.get(ctx)
        if (!id?.did) continue
        const nodeId = `did-${ctx}`
        nodes.push({
          id: nodeId,
          label: `context-${ctx}\n${id.did.slice(0, 16)}...`,
          group: 'did',
          title: `context-${ctx}（${ctxLabels[ctx]}）\nDID: ${id.did}`,
        })
        // self → context-DID 边
        edges.push({
          from: selfId, to: nodeId, label: 'context', dashes: false,
        })
      }
    }

    // ── 邻居 peer ──
    const peers = n.libp2p?.getPeers?.() ?? []
    for (const p of peers) {
      const pid = p.toString()
      nodes.push({
        id: pid,
        label: `peer\n${pid.slice(0, 12)}...`,
        group: 'peer',
        title: `邻居 peer\npeerId: ${pid}`,
      })
      edges.push({
        from: selfId, to: pid, label: 'p2p', dashes: false,
      })
    }

    // ── relay active + candidates ──
    const rr = n.relayRegistry
    if (rr) {
      const active = rr.getActiveRelays?.() ?? []
      for (const did of active) {
        const nodeId = `relay-active:${did}`
        // 避免重复（同一 did 可能既是 peer 又是 relay）
        if (!nodes.find((x) => x.id === nodeId)) {
          nodes.push({
            id: nodeId,
            label: `relay-active\n${did.slice(0, 16)}...`,
            group: 'relay-active',
            title: `active relay\nDID: ${did}`,
          })
          edges.push({
            from: selfId, to: nodeId, label: 'relay', dashes: false,
          })
        }
      }
      const candidates = rr.candidates ?? new Map()
      for (const [did] of candidates) {
        const nodeId = `relay-active:${did}`
        if (nodes.find((x) => x.id === nodeId)) continue
        const candId = `relay-cand:${did}`
        if (nodes.find((x) => x.id === candId)) continue
        nodes.push({
          id: candId,
          label: `relay-cand\n${did.slice(0, 16)}...`,
          group: 'relay-candidate',
          title: `候选 relay\nDID: ${did}`,
        })
        edges.push({
          from: selfId, to: candId, label: 'candidate', dashes: [5, 5],
        })
      }
    }

    // ── vouch 关系 ──
    const vr = n.vouchRegistry
    if (vr?.vouches instanceof Map) {
      for (const [endorseDid, vouchers] of vr.vouches.entries()) {
        // endorseDid 作为节点（若不存在）
        const endId = `vouched:${endorseDid}`
        if (!nodes.find((x) => x.id === endId)) {
          nodes.push({
            id: endId,
            label: `endorsed\n${endorseDid.slice(0, 16)}...`,
            group: 'vouched',
            title: `被背书方\nDID: ${endorseDid}`,
          })
        }
        // 每个 voucher 作为边
        const vSet = vouchers instanceof Set ? vouchers : new Set()
        for (const v of vSet) {
          const vId = `voucher:${v}`
          if (!nodes.find((x) => x.id === vId)) {
            nodes.push({
              id: vId,
              label: `voucher\n${v.slice(0, 16)}...`,
              group: 'voucher',
              title: `背书方\nDID: ${v}`,
            })
          }
          edges.push({
            from: vId, to: endId, label: 'vouch', dashes: [2, 4],
          })
        }
      }
    }

    // ── 隧道 source → target ──
    const tm = n.tunnelManager
    if (tm?.getStats) {
      const stats = tm.getStats()
      for (const t of stats) {
        const srcId = `tunnel-src:${t.sourceDid}`
        const dstId = `tunnel-dst:${t.targetDid}`
        if (!nodes.find((x) => x.id === srcId)) {
          nodes.push({
            id: srcId,
            label: `tunnel-src\n${t.sourceDid.slice(0, 16)}...`,
            group: 'tunnel-src',
            title: `隧道发起方\nDID: ${t.sourceDid}`,
          })
        }
        if (!nodes.find((x) => x.id === dstId)) {
          nodes.push({
            id: dstId,
            label: `tunnel-dst\n${t.targetDid.slice(0, 16)}...`,
            group: 'tunnel-dst',
            title: `隧道目标方\nDID: ${t.targetDid}`,
          })
        }
        edges.push({
          from: srcId, to: dstId,
          label: `tunnel (${t.status})`, dashes: false, width: 3,
        })
      }
    }

    // ── 市场（创建者 → 市场） ──
    const mr = n.marketRegistry
    if (mr?.markets instanceof Map) {
      for (const [marketId, m] of mr.markets.entries()) {
        const mktId = `market:${marketId}`
        const manifest = m?.manifest
        nodes.push({
          id: mktId,
          label: `market\n${manifest?.name ?? marketId}`,
          group: 'market',
          title: `市场 ${marketId}\nname: ${manifest?.name ?? '?'}\nversion: ${manifest?.version ?? '?'}\ncapability: ${manifest?.capability ?? '?'}`,
        })
        // 若是创建者，连 self；否则连 context-B
        if (m?.isCreator) {
          edges.push({
            from: selfId, to: mktId, label: 'creator', dashes: [1, 3],
          })
        } else if (n.wallet?.get) {
          const b = n.wallet.get('B')
          if (b?.did) {
            edges.push({
              from: 'did-B', to: mktId, label: 'member', dashes: [1, 3],
            })
          }
        }
      }
    }

    return { ok: true, nodes, edges }
  }

  _apiVouch() {
    const vr = this.node?.vouchRegistry
    if (!vr) return { ok: false, error: 'vouchRegistry 未初始化' }
    const entries = []
    if (vr.vouches instanceof Map) {
      for (const [endorseDid, vouchers] of vr.vouches.entries()) {
        const vSet = vouchers instanceof Set ? vouchers : new Set()
        entries.push({
          endorseDid,
          vouchers: Array.from(vSet),
          count: vSet.size,
        })
      }
    }
    return { ok: true, count: entries.length, entries }
  }

  _apiWiki() {
    const wiki = this.node?.wiki
    if (!wiki) return { ok: false, error: 'wiki 未初始化' }
    const list = wiki.listEntries?.() ?? []
    return { ok: true, count: list.length, entries: list }
  }

  _apiCredit() {
    const n = this.node
    const rep = n?.reputationLedger
    const credit = n?.creditLedger
    const reputations = []
    if (rep?.balances instanceof Map) {
      for (const [did, r] of rep.balances.entries()) {
        reputations.push({ did, ...r })
      }
    }
    const credits = []
    if (credit?.balances instanceof Map) {
      for (const [did, balance] of credit.balances.entries()) {
        credits.push({ did, balance })
      }
    }
    return { ok: true, reputations, credits }
  }

  _apiDispute() {
    const arb = this.node?.arbitrationRegistry
    if (!arb) return { ok: false, error: 'arbitrationRegistry 未初始化' }
    const disputes = []
    const ids = arb.listDisputes?.() ?? []
    for (const id of ids) {
      const d = arb.getDispute(id)
      if (!d) continue
      let stats = null
      try {
        stats = arb.getVoteStats?.(id) ?? null
      } catch {
        stats = null
      }
      disputes.push({
        disputeId: id,
        claimant: d.claimant,
        respondent: d.respondent,
        type: d.type,
        amount: d.amount,
        status: d.status,
        evidence: d.evidence ?? null,
        panelSize: d.panel?.length ?? 0,
        voteStats: stats,
      })
    }
    const jurorCount = arb.jurorPool?.size ?? 0
    return { ok: true, count: disputes.length, jurorCandidates: jurorCount, disputes }
  }

  _apiMarket() {
    const mr = this.node?.marketRegistry
    if (!mr) return { ok: false, error: 'marketRegistry 未初始化' }
    const markets = []
    if (mr.markets instanceof Map) {
      for (const [marketId, m] of mr.markets.entries()) {
        const manifest = m?.manifest
        markets.push({
          marketId,
          name: manifest?.name ?? null,
          version: manifest?.version ?? null,
          capability: manifest?.capability ?? null,
          permissions: manifest?.permissions ?? [],
          minReputation: manifest?.minReputation ?? null,
          trustWeight: manifest?.trustWeight ?? null,
          spaCid: manifest?.spaCid ?? null,
          topic: m?.topic ?? null,
          isCreator: !!m?.isCreator,
          memberCount: m?.members?.size ?? 0,
        })
      }
    }
    return { ok: true, count: markets.length, markets }
  }

  _apiTreasury() {
    const tr = this.node?.treasury
    if (!tr) return { ok: false, error: 'treasury 未初始化' }
    return {
      ok: true,
      balance: tr.getBalance?.() ?? 0,
      history: tr.getHistory?.() ?? [],
    }
  }

  _apiTunnel() {
    const tm = this.node?.tunnelManager
    if (!tm) return { ok: false, error: 'tunnelManager 未初始化' }
    const stats = tm.getStats?.() ?? []
    return { ok: true, count: stats.length, tunnels: stats }
  }

  _apiRelay() {
    const rr = this.node?.relayRegistry
    if (!rr) return { ok: false, error: 'relayRegistry 未初始化' }
    const active = rr.getActiveRelays?.() ?? []
    const candidates = []
    const candMap = rr.candidates ?? new Map()
    for (const [did, info] of candMap) {
      candidates.push({
        did,
        reputation: info?.reputation ?? null,
        vouchCount: info?.vouchCount ?? null,
      })
    }
    return { ok: true, activeCount: active.length, active, candidates }
  }

  // ──────────────────────────────────────────
  // HTML 页面
  // ──────────────────────────────────────────

  _renderIndex() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Havix 节点拓扑 · M8.2-4</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 0;
      font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: #0d1117; color: #c9d1d9;
      display: flex; flex-direction: column; height: 100vh;
    }
    header {
      background: #161b22; padding: 12px 20px;
      border-bottom: 1px solid #30363d;
      display: flex; align-items: center; justify-content: space-between;
    }
    header h1 { margin: 0; font-size: 18px; color: #58a6ff; }
    header .meta { font-size: 12px; color: #8b949e; }
    main { flex: 1; display: flex; overflow: hidden; }
    #topo {
      flex: 2; border-right: 1px solid #30363d;
      background: #0d1117;
    }
    #side {
      flex: 1; overflow-y: auto; padding: 12px;
      font-family: "SF Mono", "Consolas", "Monaco", monospace;
      font-size: 12px;
    }
    #side h2 {
      color: #58a6ff; font-size: 13px;
      border-bottom: 1px solid #30363d; padding-bottom: 6px; margin-top: 16px;
    }
    #side h2:first-child { margin-top: 0; }
    #side .row { padding: 4px 0; border-bottom: 1px dashed #21262d; }
    #side .key { color: #f778ba; }
    #side .val { color: #79c0ff; }
    #side .ok { color: #56d364; }
    #side .warn { color: #e3b341; }
    #side .err { color: #f85149; }
    #loading {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      color: #8b949e; font-size: 14px;
    }
    .legend {
      position: absolute; bottom: 12px; left: 12px;
      background: rgba(22, 27, 34, 0.9); border: 1px solid #30363d;
      padding: 8px 12px; border-radius: 4px; font-size: 11px;
    }
    .legend .item { margin: 2px 0; }
    .legend .dot {
      display: inline-block; width: 10px; height: 10px; border-radius: 50%;
      margin-right: 6px; vertical-align: middle;
    }
  </style>
</head>
<body>
  <header>
    <h1>Havix 节点拓扑</h1>
    <div class="meta">
      <span id="peerId">加载中...</span> ·
      <a href="/api/status" target="_blank">/api/status</a> ·
      <a href="/api/topology" target="_blank">/api/topology</a> ·
      <a href="/apps">Apps</a> ·
      <a href="/api/apps" target="_blank">/api/apps</a> ·
      <span id="refresh">自动刷新 5s</span>
    </div>
  </header>
  <main>
    <div id="topo">
      <div id="loading">加载拓扑中...</div>
      <div class="legend">
        <div class="item"><span class="dot" style="background:#f85149"></span> self（本节点）</div>
        <div class="item"><span class="dot" style="background:#58a6ff"></span> context-DID</div>
        <div class="item"><span class="dot" style="background:#56d364"></span> peer</div>
        <div class="item"><span class="dot" style="background:#e3b341"></span> relay-active</div>
        <div class="item"><span class="dot" style="background:#a371f7"></span> relay-candidate</div>
        <div class="item"><span class="dot" style="background:#f778ba"></span> market</div>
        <div class="item"><span class="dot" style="background:#8b949e"></span> vouch / tunnel</div>
      </div>
    </div>
    <div id="side">
      <div>正在加载...</div>
    </div>
  </main>

  <script src="https://cdn.jsdelivr.net/npm/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
  <script>
    // 节点颜色映射
    const GROUP_COLORS = {
      'self':             { bg: '#f85149', border: '#da3633' },
      'did':              { bg: '#58a6ff', border: '#1f6feb' },
      'peer':             { bg: '#56d364', border: '#2ea043' },
      'relay-active':     { bg: '#e3b341', border: '#bb8009' },
      'relay-candidate':  { bg: '#a371f7', border: '#8957e5' },
      'market':           { bg: '#f778ba', border: '#bc8cff' },
      'vouched':          { bg: '#8b949e', border: '#6e7681' },
      'voucher':          { bg: '#8b949e', border: '#6e7681' },
      'tunnel-src':       { bg: '#79c0ff', border: '#1f6feb' },
      'tunnel-dst':       { bg: '#79c0ff', border: '#1f6feb' },
    };

    let network = null;

    function buildNodes(rawNodes) {
      const items = (rawNodes || []).map((n) => {
        const colors = GROUP_COLORS[n.group] || { bg: '#8b949e', border: '#6e7681' };
        return {
          id: n.id,
          label: n.label,
          title: n.title,
          group: n.group,
          shape: n.group === 'self' ? 'star' : (n.group === 'market' ? 'box' : 'dot'),
          size: n.group === 'self' ? 30 : (n.group === 'did' ? 18 : 14),
          color: {
            background: colors.bg,
            border: colors.border,
            highlight: { background: colors.bg, border: colors.border },
          },
          font: { color: '#c9d1d9', size: 11, face: 'monospace' },
        };
      });
      return new vis.DataSet(items);
    }

    function buildEdges(rawEdges) {
      const items = (rawEdges || []).map((e, i) => ({
        id: 'e' + i,
        from: e.from,
        to: e.to,
        label: e.label,
        dashes: e.dashes === true ? true : (Array.isArray(e.dashes) ? e.dashes : false),
        width: e.width || 1,
        color: { color: '#30363d', highlight: '#58a6ff', hover: '#8b949e' },
        font: { color: '#8b949e', size: 10, strokeWidth: 0, face: 'monospace' },
      }));
      return new vis.DataSet(items);
    }

    function renderTopology(data) {
      const container = document.getElementById('topo');
      if (!data.ok) {
        document.getElementById('loading').textContent = '错误：' + (data.error || '未知');
        return;
      }
      document.getElementById('loading').style.display = 'none';

      const nodesDs = buildNodes(data.nodes);
      const edgesDs = buildEdges(data.edges);

      if (network) {
        network.setData({ nodes: nodesDs, edges: edgesDs });
        return;
      }
      network = new vis.Network(container, { nodes: nodesDs, edges: edgesDs }, {
        layout: { improvedLayout: true },
        physics: {
          stabilization: { iterations: 200 },
          barnesHut: { gravitationalConstant: -3000, springLength: 120 },
        },
        interaction: { hover: true, tooltipDelay: 100 },
      });
    }

    function renderStatus(s) {
      const side = document.getElementById('side');
      if (!s.ok) {
        side.innerHTML = '<div class="err">错误：' + (s.error || '未知') + '</div>';
        return;
      }
      document.getElementById('peerId').textContent = 'peerId: ' + (s.peerId || '?');
      const r = s.registry || {};
      side.innerHTML = ''
        + '<h2>节点</h2>'
        + row('peerId', s.peerId)
        + row('监听地址', (s.multiaddrs || []).join(', ') || '(无)')
        + row('已连接 peer', (s.connectedPeers || []).length)
        + row('订阅 topic', s.topicCount)
        + '<h2>Registry 计数</h2>'
        + row('vouch 索引', r.vouch)
        + row('wiki 条目', r.wiki)
        + row('reputation 节点', r.reputation)
        + row('credit 持有人', r.creditHolders)
        + row('dispute 数', r.disputes)
        + row('juror 候选', r.jurorCandidates)
        + row('markets', r.markets)
        + row('tunnels', r.tunnels)
        + row('treasury 余额', r.treasuryBalance)
        + row('credit nonce', r.processedCreditNonces)
        + '<h2>Apps（M9.4）</h2>'
        + row('AppManager 启用', s.apps ? (s.apps.enabled ? '是' : '否') : '?')
        + row('已加载 App 数', s.apps ? s.apps.count : 0)
        + (s.apps && s.apps.names && s.apps.names.length > 0
          ? s.apps.names.map((n) => linkRow('/apps/' + n + '/')).join('')
          : row('App', '(无)'))
        + '<h2>API 链接</h2>'
        + linkRow('/api/apps')
        + linkRow('/api/identity')
        + linkRow('/api/neighbors')
        + linkRow('/api/topics')
        + linkRow('/api/topology')
        + linkRow('/api/registry/vouch')
        + linkRow('/api/registry/wiki')
        + linkRow('/api/registry/credit')
        + linkRow('/api/registry/dispute')
        + linkRow('/api/registry/market')
        + linkRow('/api/registry/treasury')
        + linkRow('/api/registry/tunnel')
        + linkRow('/api/registry/relay');
    }

    function row(k, v) {
      return '<div class="row"><span class="key">' + k + '</span> = <span class="val">' + (v === undefined ? '?' : v) + '</span></div>';
    }
    function linkRow(path) {
      return '<div class="row"><a href="' + path + '" target="_blank" style="color:#79c0ff">' + path + '</a></div>';
    }

    async function fetchAll() {
      try {
        const [topoRes, statRes] = await Promise.all([
          fetch('/api/topology'),
          fetch('/api/status'),
        ]);
        const topo = await topoRes.json();
        const stat = await statRes.json();
        renderTopology(topo);
        renderStatus(stat);
      } catch (err) {
        document.getElementById('loading').textContent = '加载失败：' + err.message;
      }
    }

    fetchAll();
    setInterval(fetchAll, 5000);
  </script>
</body>
</html>`
  }

  // ──────────────────────────────────────────
  // 响应辅助
  // ──────────────────────────────────────────

  _sendJson(res, status, body) {
    const json = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
      'Cache-Control': 'no-store',
    })
    res.end(json)
  }

  _sendHtml(res, status, html) {
    const buf = Buffer.from(html, 'utf-8')
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    })
    res.end(buf)
  }
}
