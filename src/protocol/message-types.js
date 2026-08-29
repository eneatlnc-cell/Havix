// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Havix 公共层消息类型定义（M3.1）
 * ───────────────────────────────────────────────
 * 白皮书 §2.1 约定，Havix 公共层 gossipsub 频道：
 *   /s-network/announce     通用通告（心跳、维基 CID 广播）
 *   /s-network/reputation   vouch 与 credit 流水
 *   /s-network/alert        仲裁与裁决
 *
 * 每条消息通用结构（白皮书 §6）：
 *   {
 *     version: 'v1.0',
 *     type:    'heartbeat' | 'wiki-announce' | 'offer' | 'vouch' |
 *              'arbitration' | 'credit' | 'acknowledge',
 *     senderId: string,         // 子 DID（依 type 选择 A/B/C/D）
 *     timestamp: number,        // 毫秒时间戳
 *     payload: object,          // type-specific 内容
 *     signature?: string,      // base64 Ed25519 签名（对 canonical message 的 JSON 字节）
 *     signerPublicKey?: string // base64 Ed25519 公钥原始字节
 *   }
 *
 * 签名规则（M2.2 引入；P0-1 修复于审计阶段）：
 *   - 签名覆盖 canonical message 的 JSON 序列化字节
 *     （canonical = 移除 signature / signerPublicKey 字段后的 message）
 *     即 { version, type, senderId, timestamp, payload } 全部参与签名
 *   - 这保证 senderId / type / timestamp 不能被第三方篡改（防伪造身份、防 type 篡改）
 *   - 接收方零依赖验签：消息内嵌 signerPublicKey，无需 DHT 查询
 *   - 不同 type 用不同 context 子身份签名（白皮书 §3.2）：
 *       heartbeat        → context-A（公开层活跃性广播）
 *       wiki-announce    → context-D（维基编辑员身份，证明作者资格）
 *       offer/credit    → context-B（市场参与；M7 私域消息走 topic 前缀分流，不验签）
 *       arbitration/vouch → context-A（信誉/治理）
 *   M3.1 范围：只实现 heartbeat 与 wiki-announce 两种 type 的分发
 */

export const MESSAGE_VERSION = 'v1.0'

/**
 * 消息类型常量。
 *
 * 使用 frozen object 防止误改（与 identity.js 的 CONTEXTS 保持一致风格）。
 */
export const MESSAGE_TYPES = Object.freeze({
  HEARTBEAT: 'heartbeat',
  WIKI_ANNOUNCE: 'wiki-announce',
  OFFER: 'offer',                // M7
  VOUCH: 'vouch',                // M4
  ARBITRATION: 'arbitration',    // M6
  CREDIT: 'credit',              // M4
  ACKNOWLEDGE: 'acknowledge',    // 通用 ACK
})

/**
 * 所有合法 type 字符串集合（用于校验）。
 */
export const VALID_TYPES = Object.freeze(new Set(Object.values(MESSAGE_TYPES)))

/**
 * 校验消息通用结构。
 *
 * 不校验签名（签名校验在 s-node.js 的 verifyMessageSignature 中），
 * 只校验明文头：version / type / senderId / timestamp / payload。
 *
 * @param {object} message 已解析的消息对象
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateMessageShape(message) {
  if (!message || typeof message !== 'object') {
    return { valid: false, error: 'message 必须是对象' }
  }
  if (message.version !== MESSAGE_VERSION) {
    return { valid: false, error: `version 不匹配（期望 ${MESSAGE_VERSION}，实际 ${message.version}）` }
  }
  if (!VALID_TYPES.has(message.type)) {
    return { valid: false, error: `未知 type: ${message.type}` }
  }
  if (typeof message.senderId !== 'string' || message.senderId.length === 0) {
    return { valid: false, error: 'senderId 必须是非空字符串' }
  }
  if (typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp) || message.timestamp <= 0) {
    return { valid: false, error: 'timestamp 必须是正数' }
  }
  if (!message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) {
    return { valid: false, error: 'payload 必须是对象（非数组）' }
  }
  return { valid: true }
}

/**
 * 取用于签名的 canonical 形式（移除 signature / signerPublicKey 字段）。
 *
 * P0-1 修复：签名覆盖整个 canonical message，包括 version/type/senderId/timestamp/payload。
 * 这样 senderId 不能被篡改（防伪造身份），type 不能被篡改（防 vouch 改 credit）。
 *
 * @param {object} message
 * @returns {object} 不含 signature / signerPublicKey 的 message 副本
 */
export function canonicalMessage(message) {
  const { signature, signerPublicKey, ...canonical } = message
  return canonical
}

/**
 * 构造一条已签名的消息（P0-1 修复：推荐入口）。
 *
 * 流程：
 *   1. 组装 message = { version, type, senderId, timestamp: Date.now(), payload }
 *   2. 用 identity 对 canonical(message) 的 JSON 字节签名
 *   3. 把 signature / signerPublicKey（base64）附加到 message
 *
 * @param {object} opts
 * @param {string} opts.type MESSAGE_TYPES 之一
 * @param {string} opts.senderId 子 DID 字符串
 * @param {object} opts.payload
 * @param {object} opts.identity Identity 实例（用于签名）
 * @returns {Promise<object>} 已签名的完整 message
 */
export async function signMessage({ type, senderId, payload, identity }) {
  if (!identity) throw new Error('identity 必需（signMessage）')
  const message = {
    version: MESSAGE_VERSION,
    type,
    senderId,
    timestamp: Date.now(),
    payload,
  }
  const canonical = canonicalMessage(message)
  const signBytes = new TextEncoder().encode(JSON.stringify(canonical))
  const signature = await identity.sign(signBytes)
  return {
    ...message,
    signature: Buffer.from(signature).toString('base64'),
    signerPublicKey: Buffer.from(identity.publicKey.raw).toString('base64'),
  }
}

/**
 * 构造一条消息（旧接口，向后兼容；不推荐新代码使用）。
 *
 * 调用方需自行用对应 context 子身份对 canonical message 签名后传入。
 * 本函数只做组装，不签名（签名是 IdentityWallet 的职责）。
 *
 * 注意：P0-1 修复后，签名应覆盖整个 canonical message 而非 payload。
 * 推荐使用 signMessage 工厂函数替代。
 *
 * @param {object} opts
 * @param {string} opts.type MESSAGE_TYPES 之一
 * @param {string} opts.senderId 子 DID 字符串
 * @param {object} opts.payload
 * @param {Uint8Array} [opts.signature] 签名字节（可选，未传则不附加）
 * @param {Uint8Array} [opts.signerPublicKey] 公钥原始字节（可选）
 * @returns {object}
 */
export function makeMessage({ type, senderId, payload, signature, signerPublicKey }) {
  const message = {
    version: MESSAGE_VERSION,
    type,
    senderId,
    timestamp: Date.now(),
    payload,
  }
  if (signature && signerPublicKey) {
    message.signature = Buffer.from(signature).toString('base64')
    message.signerPublicKey = Buffer.from(signerPublicKey).toString('base64')
  }
  return message
}
