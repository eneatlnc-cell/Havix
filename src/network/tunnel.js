/**
 * 私聊隧道模块（M5）
 * ───────────────────────────────────────────────
 * 设计目标（白皮书 §7）：
 *   不追求绝对匿名（那需要真洋葱路由），用单跳 relay + 信誉问责替代。
 *   Tor 没有的自由度——"用信誉换延迟"。
 *
 * 数据流（白皮书 §7.2）：
 *   A → R1 → B   (1/3 流量)
 *   A → R2 → B   (1/3 流量)
 *   A → R3 → B   (1/3 流量)
 *
 *   - A、B 互相不知道对方真实 IP
 *   - 单个 R 被攻破只能看到 1/3 流量片段
 *   - 即使一个 R 是恶意的，也无法重组完整会话
 *
 * M5 MVP 范围：
 *   - TunnelManager：管理 A 与 B 之间的多链路隧道
 *   - 多链路对冲：3 条并行 relay，流量按 round-robin 分片
 *   - 硬切换：relay 下线时该链路断开，分片迁移到剩余 relay
 *   - 流量分片：按 chunk 分配到各 relay（避免单 relay 重组）
 *   - 链路状态机：active / degraded / broken
 *     - active：3 条链路全在线
 *     - degraded：1-2 条链路断开，剩余继续服务
 *     - broken：所有链路断开，应用层需重连
 *
 * Deferred 到未来工作（M5 不实现）：
 *   - 真实 libp2p stream 跨进程传输（M5 用字节级接口，跨进程集成留 M8）
 *   - noise 握手细节（M5 复用 libp2p 已有 noise 加密层，不单独实现）
 *   - relay 协商协议（A 如何发现哪些 relay 愿意服务 B？M5 用 RelayRegistry 视图，跨节点协商留 M6+）
 *   - 电路迁移应用层重连（M5 硬切换即隧道断开，应用层感知由 M8 CLI 收口）
 *   - 流量混淆 / padding（M5 不加，可能被流量分析；deferred 到 M6+）
 *   - relay 服务质量监控（延迟、丢包、篡改；deferred 到 M6 仲裁时实现）
 *
 * 安全性质：
 *   1. 多链路对冲：单 relay 被攻破只能看到 1/N 流量片段
 *   2. 分片不可重组：每个 chunk 独立路由，单 relay 视角是无序片段
 *   3. 硬切换语义：relay 下线立即从 active 集合移除，不试图重连该 relay
 *   4. broken 时拒绝写入：所有链路断开后 sendChunk 抛错，应用层感知
 */

// 默认并行 relay 数（白皮书 §7.2：3 条）
export const DEFAULT_PARALLEL_RELAYS = 3

// 链路状态
export const LINK_STATUS = Object.freeze({
  ACTIVE: 'active',       // 链路在线
  DEGRADED: 'degraded',   // 部分链路断开，剩余继续服务
  BROKEN: 'broken',       // 所有链路断开
})

// 错误类
export class TunnelBrokenError extends Error {
  constructor({ tunnelId, reason }) {
    super(`隧道 ${tunnelId} 已断开：${reason}`)
    this.name = 'TunnelBrokenError'
    this.code = 'TUNNEL_BROKEN'
    this.tunnelId = tunnelId
    this.reason = reason
  }
}

export class NoRelayAvailableError extends Error {
  constructor({ tunnelId }) {
    super(`隧道 ${tunnelId} 无可用 relay`)
    this.name = 'NoRelayAvailableError'
    this.code = 'NO_RELAY_AVAILABLE'
    this.tunnelId = tunnelId
  }
}

// ──────────────────────────────────────────────
// Tunnel 类：单条 A↔B 隧道（含多链路对冲）
// ──────────────────────────────────────────────

/**
 * 一条 A→B 隧道，内部维护 N 条并行 relay 链路。
 *
 * 不持久化；节点重启后隧道丢失，应用层重连。
 */
export class Tunnel {
  /**
   * @param {object} opts
   * @param {string} opts.tunnelId        隧道 ID（UUID 或随机串）
   * @param {string} opts.sourceDid       发起方 A 的 did（context-C 私聊身份）
   * @param {string} opts.targetDid       接收方 B 的 did（context-C 私聊身份）
   * @param {string[]} opts.relayDids      relay did 列表（3 个）
   * @param {object} [opts.log]            可选日志函数
   */
  constructor({ tunnelId, sourceDid, targetDid, relayDids, log }) {
    if (typeof tunnelId !== 'string' || tunnelId.length === 0) {
      throw new Error('tunnelId 必须是非空字符串')
    }
    if (typeof sourceDid !== 'string' || sourceDid.length === 0) {
      throw new Error('sourceDid 必须是非空字符串')
    }
    if (typeof targetDid !== 'string' || targetDid.length === 0) {
      throw new Error('targetDid 必须是非空字符串')
    }
    if (!Array.isArray(relayDids) || relayDids.length === 0) {
      throw new Error('relayDids 必须是非空数组')
    }

    this.tunnelId = tunnelId
    this.sourceDid = sourceDid
    this.targetDid = targetDid
    this.log = log ?? (() => {})

    /** @type {Map<string, {status: string, sentChunks: number, brokenAt?: number}>} */
    this.links = new Map()
    for (const did of relayDids) {
      this.links.set(did, { status: LINK_STATUS.ACTIVE, sentChunks: 0 })
    }

    /** @type {string[]} active relay did 列表（按注册顺序，用于 round-robin） */
    this.activeRelays = [...relayDids]
    /** @type {number} round-robin 游标 */
    this.rrIndex = 0
    /** @type {number} 总发送 chunk 数 */
    this.totalChunks = 0
    /** @type {number} 建立时间 */
    this.createdAt = Date.now()
  }

  /**
   * 取下一条 active relay（round-robin）。
   *
   * 多链路对冲的核心：流量按 chunk 分配到各 relay，
   * 3 条 relay 各传 1/3 流量，单 relay 被攻破只能看到 1/3 片段。
   *
   * @returns {string} relay did
   * @throws {NoRelayAvailableError} 无可用 relay
   */
  nextRelay() {
    if (this.activeRelays.length === 0) {
      throw new NoRelayAvailableError({ tunnelId: this.tunnelId })
    }
    const relay = this.activeRelays[this.rrIndex % this.activeRelays.length]
    this.rrIndex = (this.rrIndex + 1) % this.activeRelays.length
    return relay
  }

  /**
   * 发送一个 chunk：分配到下一条 relay。
   *
   * @param {Uint8Array} chunk
   * @returns {{ relay: string, sequence: number, total: number }}
   * @throws {TunnelBrokenError} 隧道已断开
   * @throws {NoRelayAvailableError} 无可用 relay
   */
  sendChunk(chunk) {
    if (!(chunk instanceof Uint8Array)) {
      throw new Error('chunk 必须是 Uint8Array')
    }
    if (this.activeRelays.length === 0) {
      throw new TunnelBrokenError({
        tunnelId: this.tunnelId,
        reason: '所有 relay 链路均已断开',
      })
    }

    const relay = this.nextRelay()
    const link = this.links.get(relay)
    if (link) {
      link.sentChunks += 1
    }
    this.totalChunks += 1
    this.log('debug', 'tunnel',
      `隧道 ${this.tunnelId.slice(0, 8)} chunk #${this.totalChunks} → relay ${relay.slice(0, 16)}...`)
    return { relay, sequence: this.totalChunks, total: this.totalChunks }
  }

  /**
   * 标记某 relay 链路断开（硬切换）。
   *
   * 白皮书 §7.3：MVP 采用硬切换——relay 下线时隧道断开，应用层重连。
   * M5 语义：单条 relay 断开后从 active 集合移除，剩余 relay 继续服务；
   *         所有 relay 断开后隧道整体 broken。
   *
   * @param {string} relayDid
   * @returns {{ status: string, remainingRelays: number }}
   */
  breakLink(relayDid) {
    const link = this.links.get(relayDid)
    if (!link) {
      return { status: this.getStatus(), remainingRelays: this.activeRelays.length }
    }
    link.status = LINK_STATUS.BROKEN
    link.brokenAt = Date.now()
    this.activeRelays = this.activeRelays.filter((d) => d !== relayDid)
    // 重置 round-robin 游标，避免越界
    if (this.rrIndex >= this.activeRelays.length) {
      this.rrIndex = 0
    }
    this.log('warn', 'tunnel',
      `隧道 ${this.tunnelId.slice(0, 8)} relay ${relayDid.slice(0, 16)}... 断开（剩余 ${this.activeRelays.length}）`)
    return { status: this.getStatus(), remainingRelays: this.activeRelays.length }
  }

  /**
   * 取隧道整体状态。
   * @returns {string} LINK_STATUS 之一
   */
  getStatus() {
    if (this.activeRelays.length === 0) return LINK_STATUS.BROKEN
    if (this.activeRelays.length < this.links.size) return LINK_STATUS.DEGRADED
    return LINK_STATUS.ACTIVE
  }

  /**
   * 取各链路发送统计。
   * @returns {Array<{relayDid: string, status: string, sentChunks: number, brokenAt?: number}>}
   */
  getStats() {
    const stats = []
    for (const [did, link] of this.links) {
      stats.push({ relayDid: did, ...link })
    }
    return stats
  }

  /**
   * 隧道是否已断开（所有 relay 链路均 broken）。
   * @returns {boolean}
   */
  isBroken() {
    return this.activeRelays.length === 0
  }
}

// ──────────────────────────────────────────────
// TunnelManager 类：管理多条隧道
// ──────────────────────────────────────────────

/**
 * 隧道管理器。
 *
 * 维护 `tunnelId → Tunnel` 索引。
 *
 * 对外提供：
 *   - establishTunnel({sourceDid, targetDid, relayDids})   建立隧道
 *   - sendChunk(tunnelId, chunk)                          通过隧道发送 chunk
 *   - breakLink(tunnelId, relayDid)                       标记 relay 断开（硬切换）
 *   - closeTunnel(tunnelId)                               关闭隧道
 *   - getTunnel(tunnelId) / listTunnels()                 查询
 *
 * 不持久化；节点重启后所有隧道丢失，应用层重连。
 */
export class TunnelManager {
  /**
   * @param {object} [opts]
   * @param {number} [opts.parallelRelays]  默认并行 relay 数，默认 3
   * @param {object} [opts.log]              可选日志函数
   */
  constructor({ parallelRelays, log } = {}) {
    this.parallelRelays = typeof parallelRelays === 'number' && parallelRelays > 0
      ? parallelRelays : DEFAULT_PARALLEL_RELAYS
    this.log = log ?? (() => {})

    /** @type {Map<string, Tunnel>} */
    this.tunnels = new Map()
  }

  /**
   * 建立一条隧道。
   *
   * @param {object} opts
   * @param {string} opts.sourceDid     发起方 did
   * @param {string} opts.targetDid     接收方 did
   * @param {string[]} [opts.relayDids] relay did 列表；若不足 parallelRelays 则取传入的全部
   * @param {string} [opts.tunnelId]    可选隧道 ID，默认随机 UUID
   * @returns {Tunnel}
   */
  establishTunnel({ sourceDid, targetDid, relayDids, tunnelId }) {
    if (!Array.isArray(relayDids) || relayDids.length === 0) {
      throw new Error('relayDids 必须是非空数组')
    }
    const id = tunnelId ?? crypto.randomUUID()
    if (this.tunnels.has(id)) {
      throw new Error(`隧道 ${id} 已存在`)
    }
    const tunnel = new Tunnel({
      tunnelId: id,
      sourceDid,
      targetDid,
      relayDids,
      log: this.log,
    })
    this.tunnels.set(id, tunnel)
    this.log('info', 'tunnel',
      `建立隧道 ${id.slice(0, 8)}（${sourceDid.slice(0, 12)}... → ${targetDid.slice(0, 12)}...，${relayDids.length} 条 relay）`)
    return tunnel
  }

  /**
   * 通过隧道发送一个 chunk。
   *
   * @param {string} tunnelId
   * @param {Uint8Array} chunk
   * @returns {{ relay: string, sequence: number, total: number }}
   */
  sendChunk(tunnelId, chunk) {
    const tunnel = this.tunnels.get(tunnelId)
    if (!tunnel) {
      throw new Error(`隧道 ${tunnelId} 不存在`)
    }
    return tunnel.sendChunk(chunk)
  }

  /**
   * 标记某隧道的某 relay 链路断开（硬切换）。
   *
   * @param {string} tunnelId
   * @param {string} relayDid
   * @returns {{ status: string, remainingRelays: number }}
   */
  breakLink(tunnelId, relayDid) {
    const tunnel = this.tunnels.get(tunnelId)
    if (!tunnel) {
      throw new Error(`隧道 ${tunnelId} 不存在`)
    }
    return tunnel.breakLink(relayDid)
  }

  /**
   * 关闭隧道。
   * @param {string} tunnelId
   */
  closeTunnel(tunnelId) {
    const tunnel = this.tunnels.get(tunnelId)
    if (!tunnel) return
    // 标记所有链路为 broken
    for (const did of tunnel.activeRelays) {
      tunnel.breakLink(did)
    }
    this.tunnels.delete(tunnelId)
    this.log('info', 'tunnel', `关闭隧道 ${tunnelId.slice(0, 8)}`)
  }

  /**
   * 取隧道。
   * @param {string} tunnelId
   * @returns {Tunnel | undefined}
   */
  getTunnel(tunnelId) {
    return this.tunnels.get(tunnelId)
  }

  /**
   * 列出所有隧道 ID。
   * @returns {string[]}
   */
  listTunnels() {
    return Array.from(this.tunnels.keys())
  }

  /**
   * 取所有隧道的统计快照。
   * @returns {Array<{tunnelId: string, sourceDid: string, targetDid: string, status: string, totalChunks: number, links: object[]}>}
   */
  getStats() {
    const stats = []
    for (const [id, tunnel] of this.tunnels) {
      stats.push({
        tunnelId: id,
        sourceDid: tunnel.sourceDid,
        targetDid: tunnel.targetDid,
        status: tunnel.getStatus(),
        totalChunks: tunnel.totalChunks,
        links: tunnel.getStats(),
      })
    }
    return stats
  }
}
