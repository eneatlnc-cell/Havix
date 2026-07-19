/**
 * Havix SDK transport API（M9.2）
 * ───────────────────────────────────────────────
 * gossipsub / IPFS 抽象层（高级用法）。
 *
 * 2 个权限门控：
 *   transport:publish    publish() / subscribe()
 *   transport:subscribe subscribe()
 *
 * 设计原则：
 *   - 自定义 topic 发布/订阅（绕过具体业务协议，App 自己定义消息格式）
 *   - 不经过加密 / 验签 / 路由分流——直接走 libp2p pubsub
 *   - 仅用于 App 内部小众场景（如自定义协议实验）
 *
 * 用法：
 *   await app.transport.publish('/my-app/topic', bytes)
 *   app.transport.subscribe('/my-app/topic', (data, fromPeerId) => {})
 */

import { checkPermission } from './permissions.js'

// topic 命名约定（与白皮书 §6.5 一致）
const TOPIC_PREFIX = '/havix-app/'

/**
 * 创建 transport API 实例。
 *
 * @param {object} snode SNode 实例
 * @param {import('./manifest.js').AppManifest} manifest App Manifest
 * @returns {object} transport API
 */
export function createTransportApi(snode, manifest) {
  if (!snode) throw new Error('createTransportApi: snode 必填')
  if (!manifest) throw new Error('createTransportApi: manifest 必填')

  const perms = manifest.permissions
  const appName = manifest.name

  // 记录订阅便于 unsubscribe
  if (!snode._transportSubscriptions) snode._transportSubscriptions = new Map()
  // P1-7 修复：本 App 自己注册的订阅（topic -> Set<wrapped>）
  //   原实现 app.stop() 直接 snode._transportSubscriptions.clear()，会清掉其他 App 的订阅。
  //   改为只清理 ownSubscriptions 中记录的本 App 注册的项。
  const ownSubscriptions = new Map()

  /**
   * 校验 topic 名：必须是字符串、非空、包含 / 前缀。
   * 不强制必须以 /havix-app/ 开头（允许 App 使用 /s-network/ 等公共层 topic 进行实验），
   * 但禁止使用 market topic 前缀（避免误用）。
   */
  function validateTopic(topic) {
    if (typeof topic !== 'string' || topic.length === 0) {
      throw new Error('transport: topic 必须是非空字符串')
    }
    if (!topic.startsWith('/')) {
      throw new Error(`transport: topic 必须以 / 开头，实际: ${topic}`)
    }
    if (topic.startsWith('/s-network/market/')) {
      throw new Error('transport: 禁止直接使用 market topic 前缀（请用 app.market.publish）')
    }
  }

  /**
   * 发布 gossipsub 消息（自定义 topic）。
   * @param {string} topic
   * @param {Uint8Array} data
   * @returns {Promise<{ recipients: number }>}
   */
  async function publish(topic, data) {
    checkPermission(perms, 'transport:publish', { app: appName })
    validateTopic(topic)
    if (!(data instanceof Uint8Array)) {
      throw new Error('transport.publish: data 必须是 Uint8Array')
    }
    const result = await snode.libp2p.services.pubsub.publish(topic, data)
    return { recipients: result?.recipients ?? 0 }
  }

  /**
   * 订阅 gossipsub 消息。
   * @param {string} topic
   * @param {function(Uint8Array, string)} callback (data, fromPeerId)
   * @returns {Promise<void>}
   */
  async function subscribe(topic, callback) {
    checkPermission(perms, 'transport:subscribe', { app: appName })
    validateTopic(topic)
    if (typeof callback !== 'function') {
      throw new Error('transport.subscribe: callback 必须是函数')
    }
    const wrapped = async (evt) => {
      try {
        await callback(evt?.data ?? evt, evt?.from ?? 'unknown')
      } catch (err) {
        snode.log?.('warn', 'transport', `subscribe callback 异常: ${err.message}`)
      }
    }
    await snode.libp2p.services.pubsub.subscribe(topic, wrapped)
    if (!snode._transportSubscriptions.has(topic)) {
      snode._transportSubscriptions.set(topic, new Set())
    }
    snode._transportSubscriptions.get(topic).add(wrapped)
    // P1-7：同时记录到本 App ownSubscriptions（只跟踪自己注册的）
    if (!ownSubscriptions.has(topic)) {
      ownSubscriptions.set(topic, new Set())
    }
    ownSubscriptions.get(topic).add(wrapped)
  }

  /**
   * 取消订阅。
   * @param {string} topic
   * @returns {Promise<void>}
   */
  async function unsubscribe(topic) {
    validateTopic(topic)
    if (snode.libp2p?.services?.pubsub?.unsubscribe) {
      await snode.libp2p.services.pubsub.unsubscribe(topic)
    }
    snode._transportSubscriptions.delete(topic)
    ownSubscriptions.delete(topic)
  }

  /**
   * 清理本 App 注册的所有订阅（P1-7 修复：只清理自己的，不影响其他 App）。
   * 由 app.stop() 调用。
   * @returns {Promise<void>}
   * @private
   */
  async function _dispose() {
    for (const [topic, handlers] of ownSubscriptions) {
      const snodeSet = snode._transportSubscriptions?.get(topic)
      if (snodeSet) {
        for (const h of handlers) snodeSet.delete(h)
        if (snodeSet.size === 0) snode._transportSubscriptions.delete(topic)
      }
    }
    ownSubscriptions.clear()
  }

  return {
    publish,
    subscribe,
    unsubscribe,
    TOPIC_PREFIX,
    _dispose,
  }
}
