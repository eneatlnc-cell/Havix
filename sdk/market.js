/**
 * Havix SDK market API（M9.2）
 * ───────────────────────────────────────────────
 * 私域市场访问层，包装 SNode 的 M7 邀请市场协议。
 *
 * 6 个权限门控（permissions.js 白名单）：
 *   market:create     create()
 *   market:invite     invite()
 *   market:join       join()
 *   market:publish     publish()
 *   market:subscribe  subscribe()
 *   market:leave       leave()
 *
 * 设计原则：
 *   - 每个方法在调用 snode 前先 checkPermission
 *   - 缺权限抛 PermissionDeniedError（带 app 名 + 权限名）
 *   - 参数校验失败抛普通 Error（带清晰 message）
 *   - 不缓存 snode 返回值——每次调用都委托 snode（保证一致性）
 *
 * 用法：
 *   const app = await createApp(snode, manifest)
 *   const m = await app.market.create({ name: 'translation-market', manifest: {...} })
 *   const token = await app.market.invite(m.marketId, inviteeDid, { ttlMs })
 *   await app.market.join(m.marketId, token)
 *   await app.market.publish(m.marketId, { type: 'offer', payload: {...} })
 *   app.market.subscribe(m.marketId, (msg, fromPeerId) => { ... })
 *   await app.market.leave(m.marketId)
 */

import { checkPermission } from './permissions.js'

/**
 * 创建 market API 实例。
 *
 * @param {object} snode SNode 实例
 * @param {import('./manifest.js').AppManifest} manifest App Manifest
 * @returns {object} market API
 */
export function createMarketApi(snode, manifest) {
  if (!snode) throw new Error('createMarketApi: snode 必填')
  if (!manifest) throw new Error('createMarketApi: manifest 必填')

  const perms = manifest.permissions
  const appName = manifest.name

  // P1-7 修复：本 App 自己注册的市场订阅（marketId -> Set<wrapped>）
  //   原实现 app.stop() 直接 snode._marketSubscriptions.clear()，会清掉其他 App 的订阅。
  const ownSubscriptions = new Map()

  /**
   * 创建新市场。
   * @param {object} opts
   * @param {string} [opts.name] 市场名（mock 用，真实 SNode 从 manifest 派生 marketId）
   * @param {object} opts.manifest 市场 manifest（AppManifest 实例或原始字段）
   * @param {number} [opts.ttlMs] 自邀请令牌有效期，默认 30 天
   * @returns {Promise<{ marketId: string, topic: string, token: object }>}
   */
  async function create({ name, manifest: marketManifest, ttlMs } = {}) {
    checkPermission(perms, 'market:create', { app: appName })
    if (!marketManifest) {
      throw new Error('market.create: manifest 参数必填')
    }
    return snode.createMarket({ manifest: marketManifest, ttlMs })
  }

  /**
   * 邀请成员（生成 InviteToken）。
   * @param {string} marketId
   * @param {string} inviteeDid 被邀请方 context-B DID
   * @param {object} [opts]
   * @param {number} [opts.ttlMs] 有效期，默认 30 天
   * @returns {Promise<object>} InviteToken
   */
  async function invite(marketId, inviteeDid, opts = {}) {
    checkPermission(perms, 'market:invite', { app: appName })
    if (typeof marketId !== 'string' || marketId.length === 0) {
      throw new Error('market.invite: marketId 必须是非空字符串')
    }
    if (typeof inviteeDid !== 'string' || inviteeDid.length === 0) {
      throw new Error('market.invite: inviteeDid 必须是非空字符串')
    }
    return snode.issueInvite({ marketId, inviteeDid, ttlMs: opts.ttlMs })
  }

  /**
   * 加入市场（持邀请令牌）。
   * @param {string} marketId（仅用于校验，真实 token 内含 marketId）
   * @param {object} token InviteToken
   * @returns {Promise<{ marketId: string, topic: string }>}
   */
  async function join(marketId, token) {
    checkPermission(perms, 'market:join', { app: appName })
    if (typeof marketId !== 'string' || marketId.length === 0) {
      throw new Error('market.join: marketId 必须是非空字符串')
    }
    if (!token || typeof token !== 'object') {
      throw new Error('market.join: token 必须是对象')
    }
    return snode.joinMarket({ token })
  }

  /**
   * 发布私域消息（自动 AES-GCM 加密）。
   * @param {string} marketId
   * @param {object} payload 消息体
   * @returns {Promise<{ recipients: number }>}
   */
  async function publish(marketId, payload) {
    checkPermission(perms, 'market:publish', { app: appName })
    if (typeof marketId !== 'string' || marketId.length === 0) {
      throw new Error('market.publish: marketId 必须是非空字符串')
    }
    if (!payload || typeof payload !== 'object') {
      throw new Error('market.publish: payload 必须是对象')
    }
    return snode.publishToMarket({ marketId, payload })
  }

  /**
   * 订阅私域消息（自动解密）。
   *
   * 实现细节：
   *   - 通过 snode.libp2p.services.pubsub.subscribe 注册 handler
   *   - handler 收到消息后调用 callback(message, fromPeerId)
   *   - 订阅记录到 this._subscriptions 供 unsubscribe 使用
   *
   * @param {string} marketId
   * @param {function(object, string)} callback 消息回调
   * @returns {Promise<void>}
   */
  async function subscribe(marketId, callback) {
    checkPermission(perms, 'market:subscribe', { app: appName })
    if (typeof marketId !== 'string' || marketId.length === 0) {
      throw new Error('market.subscribe: marketId 必须是非空字符串')
    }
    if (typeof callback !== 'function') {
      throw new Error('market.subscribe: callback 必须是函数')
    }
    const topic = snode.getMarketTopic(marketId)
    if (!topic) {
      throw new Error(`market.subscribe: 市场 ${marketId} 未找到 topic（是否已 join？）`)
    }
    const wrapped = async (evt) => {
      try {
        await callback(evt?.data ?? evt, evt?.from ?? 'unknown')
      } catch (err) {
        snode.log?.('warn', 'market', `subscribe callback 异常: ${err.message}`)
      }
    }
    await snode.libp2p.services.pubsub.subscribe(topic, wrapped)
    // 记录便于 unsubscribe
    if (!snode._marketSubscriptions) snode._marketSubscriptions = new Map()
    if (!snode._marketSubscriptions.has(marketId)) snode._marketSubscriptions.set(marketId, new Set())
    snode._marketSubscriptions.get(marketId).add(wrapped)
    // P1-7：同时记录到本 App ownSubscriptions
    if (!ownSubscriptions.has(marketId)) ownSubscriptions.set(marketId, new Set())
    ownSubscriptions.get(marketId).add(wrapped)
  }

  /**
   * 取消订阅（可选）。
   * @param {string} marketId
   * @returns {Promise<void>}
   */
  async function unsubscribe(marketId) {
    if (typeof marketId !== 'string' || marketId.length === 0) {
      throw new Error('market.unsubscribe: marketId 必须是非空字符串')
    }
    const topic = snode.getMarketTopic(marketId)
    if (topic && snode.libp2p?.services?.pubsub?.unsubscribe) {
      await snode.libp2p.services.pubsub.unsubscribe(topic)
    }
    if (snode._marketSubscriptions?.has(marketId)) {
      snode._marketSubscriptions.delete(marketId)
    }
    ownSubscriptions.delete(marketId)
  }

  /**
   * 离开市场（取消订阅 + 删除本地条目）。
   * @param {string} marketId
   * @returns {Promise<void>}
   */
  async function leave(marketId) {
    checkPermission(perms, 'market:leave', { app: appName })
    if (typeof marketId !== 'string' || marketId.length === 0) {
      throw new Error('market.leave: marketId 必须是非空字符串')
    }
    return snode.leaveMarket(marketId)
  }

  /**
   * 列出本节点参与的市场（只读，无权限门控）。
   * @returns {string[]}
   */
  function list() {
    return snode.listMarkets()
  }

  /**
   * 检查是否是某市场的成员（只读，无权限门控）。
   * @param {string} marketId
   * @returns {boolean}
   */
  function isMember(marketId) {
    if (typeof marketId !== 'string' || marketId.length === 0) {
      throw new Error('market.isMember: marketId 必须是非空字符串')
    }
    return snode.isMarketMember(marketId)
  }

  /**
   * 获取市场 manifest（只读，无权限门控）。
   * @param {string} marketId
   * @returns {object|null}
   */
  function getManifest(marketId) {
    if (typeof marketId !== 'string' || marketId.length === 0) {
      throw new Error('market.getManifest: marketId 必须是非空字符串')
    }
    return snode.getMarketManifest(marketId)
  }

  /**
   * 清理本 App 注册的市场订阅（P1-7 修复：只清理自己的）。
   * 由 app.stop() 调用。
   * @returns {Promise<void>}
   * @private
   */
  async function _dispose() {
    for (const [marketId, handlers] of ownSubscriptions) {
      const snodeSet = snode._marketSubscriptions?.get(marketId)
      if (snodeSet) {
        for (const h of handlers) snodeSet.delete(h)
        if (snodeSet.size === 0) snode._marketSubscriptions.delete(marketId)
      }
    }
    ownSubscriptions.clear()
  }

  return {
    create,
    invite,
    join,
    publish,
    subscribe,
    unsubscribe,
    leave,
    list,
    isMember,
    getManifest,
    _dispose,
  }
}
