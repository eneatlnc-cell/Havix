// SPDX-License-Identifier: AGPL-3.0-only

/**
 * KadDHT 门控模块（M1 步骤 1.3）
 * ───────────────────────────────────────────────
 * Havix 的核心架构决策之一是"双平面隔离"：
 *   - 公共平面：维基 CID 进 KadDHT，全网可查
 *   - 私域平面：市场 SPA / 私聊内容 / Credit 流水 CID 绝对不进 DHT
 *
 * CID 本身是哈希，无法从字节序列区分公私。因此门控分两层：
 *
 *   1. 应用层自律：market.js / tunnel.js / credit.js 永远不调用 DHT API
 *      私域 CID 只在私有 gossipsub topic 内分发
 *
 *   2. 协议层硬门控（本模块）：包装 libp2p 的 contentRouting
 *      所有 provide / findProviders 调用先查本地 deny list，命中则 throw
 *      应用层（M7）写入私域 CID 时必须调用 registerPrivateCid() 注册
 *
 * 这两层加起来保证：即使有第三方误用 DHT API 写私域 CID，也会被硬门控拦截。
 *
 * 关键设计：可见性在协议层硬性切分，不靠加密兜底。
 */

/**
 * DHT 门控类。
 * 包装 libp2p 的 contentRouting 接口，强制执行公私 CID 分离。
 */
export class DhtGate {
  /**
   * @param {object} libp2p 已启动的 libp2p 实例
   */
  constructor(libp2p) {
    this.libp2p = libp2p

    // 私域 CID deny list（字符串形式，便于比较）
    // key = cid.toString(), value = true
    this._privateCids = new Set()

    // 已注册过的应用层标识，便于审计
    // key = cid.toString(), value = 注册来源（'market' | 'tunnel' | 'credit' | 'unknown'）
    this._privateSources = new Map()
  }

  // ──────────────────────────────────────────
  // 注册 / 查询 deny list
  // ──────────────────────────────────────────

  /**
   * 注册一个私域 CID。注册后该 CID 不可走 DHT API。
   *
   * @param {import('multiformats').CID} cid 私域内容 CID
   * @param {string} source 注册来源（'market' | 'tunnel' | 'credit' | 'unknown'）
   */
  registerPrivateCid(cid, source = 'unknown') {
    const key = cid.toString()
    this._privateCids.add(key)
    this._privateSources.set(key, source)
  }

  /**
   * 检查一个 CID 是否为私域（已在 deny list 中）。
   *
   * @param {import('multiformats').CID} cid
   * @returns {boolean}
   */
  isPrivate(cid) {
    return this._privateCids.has(cid.toString())
  }

  /**
   * 返回当前注册的私域 CID 列表（用于审计/调试）。
   */
  listPrivateCids() {
    return Array.from(this._privateCids).map(key => ({
      cid: key,
      source: this._privateSources.get(key) ?? 'unknown',
    }))
  }

  // ──────────────────────────────────────────
  // 门控的 DHT API
  // ──────────────────────────────────────────

  /**
   * 向 DHT 公告：本节点提供某 CID 的内容。
   *
   * 门控行为：
   *   - 公共 CID → 委托 libp2p.contentRouting.provide
   *   - 私域 CID → 抛出 PrivateCidRejectedError
   *
   * @param {import('multiformats').CID} cid
   * @throws {PrivateCidRejectedError}
   */
  async provide(cid) {
    this._assertPublic(cid, 'provide')
    // libp2p 3.x 通过 node.contentRouting 暴露 DHT 接口
    return this.libp2p.contentRouting.provide(cid)
  }

  /**
   * 查询 DHT：谁提供了某 CID？
   *
   * 门控行为：
   *   - 公共 CID → 委托 libp2p.contentRouting.findProviders
   *   - 私域 CID → 抛出 PrivateCidRejectedError
   *
   * @param {import('multiformats').CID} cid
   * @returns {AsyncIterable<{ id: PeerId, multiaddrs: Multiaddr[] }>}
   * @throws {PrivateCidRejectedError}
   */
  async *findProviders(cid) {
    this._assertPublic(cid, 'findProviders')
    yield * this.libp2p.contentRouting.findProviders(cid)
  }

  // ──────────────────────────────────────────
  // 内部：断言 CID 是公共的
  // ──────────────────────────────────────────

  _assertPublic(cid, operation) {
    if (this.isPrivate(cid)) {
      const source = this._privateSources.get(cid.toString()) ?? 'unknown'
      throw new PrivateCidRejectedError(
        `拒绝 ${operation} 操作：CID ${cid.toString()} 已注册为私域（来源: ${source}）`,
        cid,
        operation,
      )
    }
  }
}

/**
 * 私域 CID 被拒绝通过 DHT 操作时抛出。
 */
export class PrivateCidRejectedError extends Error {
  /**
   * @param {string} message
   * @param {import('multiformats').CID} cid
   * @param {string} operation 被拒绝的操作（'provide' | 'findProviders'）
   */
  constructor(message, cid, operation) {
    super(message)
    this.name = 'PrivateCidRejectedError'
    this.cid = cid
    this.operation = operation
  }
}
