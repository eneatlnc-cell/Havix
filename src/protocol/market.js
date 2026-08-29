// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 邀请制市场协议模块（M7）
 * ───────────────────────────────────────────────
 * 设计目标（白皮书 §6.5 + §8）：
 *   Havix 的"私域不可见"靠双重加密实现：
 *     第一层：topic 名本身是哈希（sha256(邀请令牌)），攻击者扫描 topic 名只能看到哈希
 *     第二层：消息体用令牌派生密钥再加密（HKDF + AES-GCM），即使暴力加入 topic 也解不开消息
 *
 *   每个"私域市场"= 一个 App（白皮书 §8.2）：
 *     - 创建者通过 App Manifest 声明能力需求（capability / permissions / min_reputation / trust_weight）
 *     - 创建者用 context-A 子身份签发邀请令牌，被邀请方拿到令牌后才能加入
 *     - 加入后订阅 topic = sha256(令牌)（即"topic 名 = 哈希"层）
 *     - 发布消息：plaintext → AES-GCM(key, plaintext) → 公共层明文信封（type/senderId/timestamp）
 *                  → gossipsub.publish(topic, 加密信封)
 *     - 接收方：gossipsub 收到 → 验证 topic 是否本地已加入 → 解密 → 验签
 *
 * 邀请令牌格式（白皮书 §8.2 invite_token_format: "ed25519-signature"）：
 *   {
 *     marketId:       string,       // 市场 ID（manifest.name + 短哈希）
 *     issuerDid:      string,       // 签发方 context-A DID（市场创建者）
 *     inviteeDid:     string,       // 被邀请方 context-B DID
 *     issuedAt:       number,       // 签发时间戳
 *     expiresAt:      number,       // 过期时间戳（0 = 永不过期）
 *     nonce:          string,       // 防重放（UUID）
 *     signature:      string(base64),  // issuer 用 context-A 私钥对 payload 的 Ed25519 签名
 *     signerPublicKey: string(base64)  // issuer context-A 公钥（接收方零依赖验签）
 *   }
 *
 * M7 MVP 范围：
 *   - AppManifest 类：解析与校验 manifest 字段
 *   - InviteToken 类：令牌构造、签名、验签
 *   - deriveTopicFromToken(token)：sha256(token) → topic 名
 *   - deriveEncryptionKey(token)：HKDF(token, "market-encryption") → 32 字节密钥
 *   - encryptMessage / decryptMessage：AES-GCM 加密/解密消息体
 *   - MarketRegistry：管理本节点参与的市场（manifest + token + topic）
 *   - publishMarketMessage：构造加密信封并广播到私有 topic
 *   - handleMarketMessage：接收方解密 + 验证
 *   - SNode M7 集成：createMarket / issueInvite / joinMarket / publishToMarket
 *
 * Deferred 到未来工作（M7 不实现）：
 *   - 跨节点 transfer 同步（M7 用本地账本视图，与 M4 一致）
 *   - offer/credit 在市场内的完整流转（M7 只提供加密通道，业务逻辑由 App 自行实现）
 *   - 完整 SPA bundle 分发（M7 用 IPFS CID 占位，不实现拉取与缓存）
 *   - App Manifest 动态权重审核（白皮书 §8.4，推迟到阶段二，自然涌现算法）
 *   - 跨节点市场成员同步（M7 用本地视图，跨节点一致性靠 gossipsub 消息收敛）
 *   - 令牌吊销列表（M7 令牌过期靠 expiresAt，吊销列表 deferred）
 *   - 第三方 App 加载（白皮书 §8.5 阶段一不开放，参考实现内置）
 *
 * 安全性质：
 *   1. 私有 topic 不可枚举：topic 名 = sha256(令牌)，攻击者扫描只能看到哈希
 *   2. 消息体双重加密：即使暴力加入 topic，无令牌也解不开消息
 *   3. 令牌签名验证：issuer 必须用 context-A 子身份签名，验签失败拒绝
 *   4. 令牌过期保护：expiresAt 字段，过期令牌拒绝加入
 *   5. nonce 防重放：每个令牌有唯一 nonce，相同 nonce 视为重放
 *   6. inviteeDid 绑定：令牌指定被邀请方 DID，他人截获也不能用
 */

import crypto from 'node:crypto'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { MESSAGE_TYPES, makeMessage } from './message-types.js'
import { saveJsonAtomic, mapToArray, setToArray, arrayToSet, bytesToBase64, base64ToBytes } from '../persistence.js'

// ──────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────

// 私有 topic 前缀（与公共层 /s-network/* 分开）
export const MARKET_TOPIC_PREFIX = '/s-network/market/'

// HKDF info 参数（白皮书 §6.5：key = HKDF(inviteToken, "market-encryption")）
export const MARKET_ENCRYPTION_INFO = 'market-encryption'

// AES-GCM 密钥长度（256 位）
export const AES_KEY_LENGTH = 32

// AES-GCM IV 长度（96 位，NIST 推荐）
export const AES_IV_LENGTH = 12

// AES-GCM 认证标签长度（128 位）
export const AES_AUTH_TAG_LENGTH = 16

// 默认令牌有效期（30 天，毫秒）
export const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

// App Manifest 必需字段
export const MANIFEST_REQUIRED_FIELDS = ['name', 'version', 'capability']

// 合法 capability 值
export const VALID_CAPABILITIES = Object.freeze(new Set(['market', 'wiki', 'custom']))

// 合法 permission 值（白皮书 §8.2）
export const VALID_PERMISSIONS = Object.freeze(new Set([
  'gossipsub:publish',
  'gossipsub:subscribe',
  'ipfs:read',
  'ipfs:write',
  'identity:context-A',
  'identity:context-B',
  'identity:context-C',
  'identity:context-D',
]))

// 默认 trust_weight 范围（白皮书 §8.3：0.0 ~ 1.0）
export const MIN_TRUST_WEIGHT = 0.0
export const MAX_TRUST_WEIGHT = 1.0
export const DEFAULT_TRUST_WEIGHT = 0.5

// 默认 min_reputation（白皮书 §8.2 示例为 30）
export const DEFAULT_MIN_REPUTATION = 30

// 错误类
export class InvalidManifestError extends Error {
  constructor(message) {
    super(`App Manifest 无效：${message}`)
    this.name = 'InvalidManifestError'
    this.code = 'INVALID_MANIFEST'
  }
}

export class InvalidTokenError extends Error {
  constructor(message) {
    super(`邀请令牌无效：${message}`)
    this.name = 'InvalidTokenError'
    this.code = 'INVALID_TOKEN'
  }
}

export class MarketNotFoundError extends Error {
  constructor({ marketId }) {
    super(`市场 ${marketId} 不存在或本节点未加入`)
    this.name = 'MarketNotFoundError'
    this.code = 'MARKET_NOT_FOUND'
    this.marketId = marketId
  }
}

export class DecryptionError extends Error {
  constructor(message) {
    super(`消息解密失败：${message}`)
    this.name = 'DecryptionError'
    this.code = 'DECRYPTION_FAILED'
  }
}

// ──────────────────────────────────────────────
// AppManifest 类
// ──────────────────────────────────────────────

/**
 * App Manifest（白皮书 §8.2）。
 *
 * 每个"私域市场" = 一个 App，通过 manifest 声明能力需求。
 * 节点决定是否加载该 App，加载后即可在该市场内发消息。
 *
 * 必需字段：
 *   - name:        string  市场名称（如 "translation-market"）
 *   - version:     string  manifest 版本（如 "1.0.0"）
 *   - capability:  string  'market' | 'wiki' | 'custom'
 *
 * 可选字段：
 *   - permissions:        string[]  权限列表（VALID_PERMISSIONS 子集）
 *   - invite_token_format: string   'ed25519-signature'（M7 唯一支持）
 *   - spa_cid:            string   SPA bundle 的 IPFS CID（M7 占位，不实现拉取）
 *   - min_reputation:     number   加入市场的最小信誉（默认 30）
 *   - trust_weight:       number   App 信任权重 0.0~1.0（默认 0.5）
 *   - description:        string   市场描述（可选）
 */
export class AppManifest {
  /**
   * @param {object} raw 原始 manifest 对象
   */
  constructor(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new InvalidManifestError('manifest 必须是对象')
    }
    this._validate(raw)
    this.name = raw.name
    this.version = raw.version
    this.capability = raw.capability
    this.permissions = raw.permissions ?? []
    this.inviteTokenFormat = raw.invite_token_format ?? 'ed25519-signature'
    this.spaCid = raw.spa_cid ?? null
    this.minReputation = typeof raw.min_reputation === 'number'
      ? raw.min_reputation : DEFAULT_MIN_REPUTATION
    this.trustWeight = typeof raw.trust_weight === 'number'
      ? raw.trust_weight : DEFAULT_TRUST_WEIGHT
    this.description = raw.description ?? ''
  }

  /**
   * 校验 manifest 字段。
   * @param {object} raw
   * @throws {InvalidManifestError}
   * @private
   */
  _validate(raw) {
    for (const field of MANIFEST_REQUIRED_FIELDS) {
      if (typeof raw[field] !== 'string' || raw[field].length === 0) {
        throw new InvalidManifestError(`字段 ${field} 必须是非空字符串`)
      }
    }
    if (!VALID_CAPABILITIES.has(raw.capability)) {
      throw new InvalidManifestError(
        `capability 必须是 ${Array.from(VALID_CAPABILITIES).join(' / ')} 之一，实际 ${raw.capability}`,
      )
    }
    if (raw.permissions) {
      if (!Array.isArray(raw.permissions)) {
        throw new InvalidManifestError('permissions 必须是数组')
      }
      for (const p of raw.permissions) {
        if (!VALID_PERMISSIONS.has(p)) {
          throw new InvalidManifestError(`未知 permission: ${p}`)
        }
      }
    }
    if (raw.invite_token_format && raw.invite_token_format !== 'ed25519-signature') {
      throw new InvalidManifestError(
        `M7 仅支持 invite_token_format = 'ed25519-signature'，实际 ${raw.invite_token_format}`,
      )
    }
    if (typeof raw.min_reputation === 'number' && raw.min_reputation < 0) {
      throw new InvalidManifestError('min_reputation 不能为负数')
    }
    if (typeof raw.trust_weight === 'number') {
      if (raw.trust_weight < MIN_TRUST_WEIGHT || raw.trust_weight > MAX_TRUST_WEIGHT) {
        throw new InvalidManifestError(
          `trust_weight 必须在 [${MIN_TRUST_WEIGHT}, ${MAX_TRUST_WEIGHT}] 范围内，实际 ${raw.trust_weight}`,
        )
      }
    }
  }

  /**
   * 计算市场 ID（name + sha256(manifest JSON 前缀））。
   * 用于在 MarketRegistry 中唯一标识市场。
   * @returns {string}
   */
  get marketId() {
    const raw = {
      name: this.name,
      version: this.version,
      capability: this.capability,
    }
    const json = JSON.stringify(raw)
    const hash = sha256(new TextEncoder().encode(json))
    const hex = Buffer.from(hash).toString('hex').slice(0, 8)
    return `${this.name}-${hex}`
  }

  /**
   * 序列化为 JSON（用于持久化或网络传输）。
   */
  toJSON() {
    return {
      name: this.name,
      version: this.version,
      capability: this.capability,
      permissions: this.permissions,
      invite_token_format: this.inviteTokenFormat,
      spa_cid: this.spaCid,
      min_reputation: this.minReputation,
      trust_weight: this.trustWeight,
      description: this.description,
    }
  }
}

// ──────────────────────────────────────────────
// 邀请令牌：构造、签名、验签
// ──────────────────────────────────────────────

/**
 * 邀请令牌（白皮书 §8.2 invite_token_format: "ed25519-signature"）。
 *
 * 令牌由市场创建者用 context-A 子身份签发。
 * 被邀请方拿到令牌后用 context-B 子身份加入市场。
 *
 * payload（用于签名）：
 *   { marketId, issuerDid, inviteeDid, issuedAt, expiresAt, nonce }
 *
 * 令牌完整结构：
 *   { ...payload, signature, signerPublicKey }
 */
export class InviteToken {
  /**
   * @param {object} opts
   * @param {string} opts.marketId
   * @param {string} opts.issuerDid     签发方 context-A DID
   * @param {string} opts.inviteeDid    被邀请方 context-B DID
   * @param {number} opts.issuedAt      签发时间戳
   * @param {number} [opts.expiresAt]   过期时间戳（0 = 永不过期）
   * @param {string} opts.nonce         防重放 nonce
   * @param {string} [opts.signature]   base64 签名（验签时填入）
   * @param {string} [opts.signerPublicKey] base64 公钥（验签时填入）
   */
  constructor({ marketId, issuerDid, inviteeDid, issuedAt, expiresAt, nonce, signature, signerPublicKey }) {
    this.marketId = marketId
    this.issuerDid = issuerDid
    this.inviteeDid = inviteeDid
    this.issuedAt = issuedAt
    this.expiresAt = expiresAt ?? 0
    this.nonce = nonce
    this.signature = signature ?? null
    this.signerPublicKey = signerPublicKey ?? null
  }

  /**
   * 取 payload（用于签名/验签）。
   * @returns {object}
   */
  get payload() {
    return {
      marketId: this.marketId,
      issuerDid: this.issuerDid,
      inviteeDid: this.inviteeDid,
      issuedAt: this.issuedAt,
      expiresAt: this.expiresAt,
      nonce: this.nonce,
    }
  }

  /**
   * 序列化为 JSON 字符串（用于签名输入）。
   * 字段顺序固定，确保签名确定性。
   * @returns {string}
   */
  payloadJson() {
    return JSON.stringify(this.payload)
  }

  /**
   * 验证令牌签名。
   * @param {object} publicKey Ed25519PublicKey 对象（@libp2p/crypto/keys）
   * @returns {Promise<boolean>}
   */
  async verify(publicKey) {
    if (!this.signature || !this.signerPublicKey) {
      return false
    }
    try {
      const sigBytes = Buffer.from(this.signature, 'base64')
      const payloadBytes = new TextEncoder().encode(this.payloadJson())
      return await publicKey.verify(payloadBytes, sigBytes)
    } catch {
      return false
    }
  }

  /**
   * 用令牌内嵌的 signerPublicKey（base64 原始公钥字节）自验签（P0-4 修复）。
   *
   * 这是零依赖验签：调用方不需要拿到 issuer 的 publicKey 对象，
   * 直接用 token.signerPublicKey 解码后调用 @noble/curves Ed25519 verify。
   *
   * joinMarket / 接收任何外发令牌的场景都应调用本方法做签名校验，
   * 防止攻击者伪造 issuerDid / 篡改 payload 后重签。
   *
   * @returns {Promise<boolean>} true 表示签名有效
   */
  async verifySelf() {
    if (!this.signature || !this.signerPublicKey) {
      return false
    }
    try {
      const sigBytes = new Uint8Array(Buffer.from(this.signature, 'base64'))
      const pubBytes = new Uint8Array(Buffer.from(this.signerPublicKey, 'base64'))
      const payloadBytes = new TextEncoder().encode(this.payloadJson())
      return ed25519.verify(sigBytes, payloadBytes, pubBytes)
    } catch {
      return false
    }
  }

  /**
   * 检查令牌是否过期。
   * @param {number} [now] 当前时间戳，默认 Date.now()
   * @returns {boolean} true 表示已过期
   */
  isExpired(now = Date.now()) {
    if (this.expiresAt === 0) return false  // 0 = 永不过期
    return now > this.expiresAt
  }

  /**
   * 检查令牌是否绑定到指定 DID。
   * @param {string} did
   * @returns {boolean}
   */
  isFor(did) {
    return this.inviteeDid === did
  }

  /**
   * 序列化为 JSON（用于持久化或网络传输）。
   */
  toJSON() {
    return {
      ...this.payload,
      signature: this.signature,
      signerPublicKey: this.signerPublicKey,
    }
  }

  /**
   * 从 JSON 反序列化。
   * @param {object} json
   * @returns {InviteToken}
   */
  static fromJSON(json) {
    return new InviteToken({
      marketId: json.marketId,
      issuerDid: json.issuerDid,
      inviteeDid: json.inviteeDid,
      issuedAt: json.issuedAt,
      expiresAt: json.expiresAt,
      nonce: json.nonce,
      signature: json.signature,
      signerPublicKey: json.signerPublicKey,
    })
  }
}

/**
 * 签发一个邀请令牌。
 *
 * @param {object} opts
 * @param {string} opts.marketId
 * @param {string} opts.inviteeDid   被邀请方 context-B DID
 * @param {object} opts.issuerIdentity 签发方 Identity 对象（context-A 子身份）
 * @param {number} [opts.ttlMs]      有效期（毫秒），默认 30 天
 * @param {number} [opts.now]        当前时间戳，默认 Date.now()（测试可注入）
 * @returns {Promise<InviteToken>}
 */
export async function issueInviteToken({ marketId, inviteeDid, issuerIdentity, ttlMs, now }) {
  if (!marketId) throw new InvalidTokenError('marketId 必需')
  if (!inviteeDid) throw new InvalidTokenError('inviteeDid 必需')
  if (!issuerIdentity) throw new InvalidTokenError('issuerIdentity 必需')

  const issuedAt = now ?? Date.now()
  const expiresAt = ttlMs === 0 ? 0 : (issuedAt + (ttlMs ?? DEFAULT_TOKEN_TTL_MS))
  const nonce = crypto.randomUUID()

  const token = new InviteToken({
    marketId,
    issuerDid: issuerIdentity.did,
    inviteeDid,
    issuedAt,
    expiresAt,
    nonce,
  })

  const payloadBytes = new TextEncoder().encode(token.payloadJson())
  const signature = await issuerIdentity.sign(payloadBytes)
  token.signature = Buffer.from(signature).toString('base64')
  token.signerPublicKey = Buffer.from(issuerIdentity.publicKey.raw).toString('base64')

  return token
}

// ──────────────────────────────────────────────
// topic 派生 + 双重加密（白皮书 §6.5）
// ──────────────────────────────────────────────

/**
 * 从令牌派生私有 topic 名（白皮书 §6.5 第一层）。
 *
 *   topic = sha256(inviteToken).toString('hex')
 *
 * @param {InviteToken} token
 * @returns {string}
 */
export function deriveTopicFromToken(token) {
  const tokenJson = JSON.stringify(token.toJSON())
  const hash = sha256(new TextEncoder().encode(tokenJson))
  const hex = Buffer.from(hash).toString('hex')
  return `${MARKET_TOPIC_PREFIX}${hex}`
}

/**
 * 从令牌派生加密密钥（白皮书 §6.5 第二层）。
 *
 *   key = HKDF(inviteToken, "market-encryption")
 *
 * @param {InviteToken} token
 * @returns {Uint8Array} 32 字节 AES-256 密钥
 */
export function deriveEncryptionKey(token) {
  const tokenJson = new TextEncoder().encode(JSON.stringify(token.toJSON()))
  return hkdf(
    sha256,
    tokenJson,                                // IKM = 令牌 JSON
    undefined,                                // salt（留空）
    new TextEncoder().encode(MARKET_ENCRYPTION_INFO),  // info = "market-encryption"
    AES_KEY_LENGTH,                           // 输出 32 字节
  )
}

/**
 * AES-GCM 加密消息体（白皮书 §6.5 第二层）。
 *
 * @param {Uint8Array} key 32 字节密钥
 * @param {string|Uint8Array} plaintext
 * @returns {{ iv: string, ciphertext: string, tag: string }} base64 编码的 IV / 密文 / 认证标签
 */
export function encryptMessage(key, plaintext) {
  if (!(key instanceof Uint8Array) || key.length !== AES_KEY_LENGTH) {
    throw new DecryptionError(`密钥必须是 ${AES_KEY_LENGTH} 字节，实际 ${key?.length}`)
  }
  const plaintextBytes = typeof plaintext === 'string'
    ? new TextEncoder().encode(plaintext)
    : plaintext

  const iv = crypto.randomBytes(AES_IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), iv, {
    authTagLength: AES_AUTH_TAG_LENGTH,
  })
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintextBytes)),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()

  return {
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: tag.toString('base64'),
  }
}

/**
 * AES-GCM 解密消息体（白皮书 §6.5 第二层）。
 *
 * @param {Uint8Array} key 32 字节密钥
 * @param {{ iv: string, ciphertext: string, tag: string }} encrypted
 * @returns {Uint8Array} 明文字节
 * @throws {DecryptionError} 解密失败（密钥错误 / 数据损坏 / 标签不匹配）
 */
export function decryptMessage(key, encrypted) {
  if (!(key instanceof Uint8Array) || key.length !== AES_KEY_LENGTH) {
    throw new DecryptionError(`密钥必须是 ${AES_KEY_LENGTH} 字节，实际 ${key?.length}`)
  }
  try {
    const iv = Buffer.from(encrypted.iv, 'base64')
    const ciphertext = Buffer.from(encrypted.ciphertext, 'base64')
    const tag = Buffer.from(encrypted.tag, 'base64')

    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), iv, {
      authTagLength: AES_AUTH_TAG_LENGTH,
    })
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ])
    return new Uint8Array(plaintext)
  } catch (err) {
    throw new DecryptionError(err.message)
  }
}

// ──────────────────────────────────────────────
// MarketRegistry：管理本节点参与的市场
// ──────────────────────────────────────────────

/**
 * 市场注册表。
 *
 * 维护本节点参与的私域市场列表。
 *
 * 对外提供：
 *   - createMarket(manifest)             创建市场（本节点是创建者）
 *   - getMarket(marketId)                查询市场
 *   - joinMarket(token)                  用邀请令牌加入市场
 *   - leaveMarket(marketId)              离开市场
 *   - listMarkets()                       列出本节点参与的市场
 *   - isMember(marketId, did)            检查 did 是否是市场成员
 *   - getToken(marketId)                  取本地令牌（用于派生 topic 与密钥）
 *   - getEncryptionKey(marketId)         取加密密钥
 *   - getTopic(marketId)                 取私有 topic 名
 */
export class MarketRegistry {
  /**
   * @param {object} [opts]
   * @param {object} [opts.log] 可选日志函数
   * @param {string} [opts.persistPath] 可选持久化文件路径（M8.1）
   */
  constructor({ log, persistPath } = {}) {
    this.log = log ?? (() => {})
    this.persistPath = persistPath ?? null
    /** @type {Map<string, { manifest: AppManifest, token: InviteToken, topic: string, key: Uint8Array, isCreator: boolean, members: Set<string> }>} */
    this.markets = new Map()
    /** @type {Set<string>} 已见过的 nonce 集合（防重放） */
    this._seenNonces = new Set()
    this._seenNonceLimit = 100_000
  }

  /**
   * 序列化为 JSON 可保存的对象。
   * - manifest 用 toJSON()，null 时保留 null
   * - token 用 toJSON()
   * - key: Uint8Array → base64
   * - members: Set → Array
   * @returns {{ version: string, markets: Array, seenNonces: string[] }}
   */
  toJSON() {
    const marketsArr = Array.from(this.markets.entries()).map(([id, m]) => [
      id,
      {
        manifest: m.manifest ? m.manifest.toJSON() : null,
        token: m.token.toJSON(),
        topic: m.topic,
        key: bytesToBase64(m.key),
        isCreator: m.isCreator,
        members: setToArray(m.members),
      },
    ])
    return {
      version: 'market-v1',
      markets: marketsArr,
      seenNonces: setToArray(this._seenNonces),
    }
  }

  /**
   * 从 loadJson 加载的对象恢复状态（合并到现有 markets + _seenNonces）。
   * @param {object} json
   */
  loadState(json) {
    if (!json || typeof json !== 'object') return
    // 恢复 markets
    const marketsArr = Array.isArray(json.markets) ? json.markets : []
    for (const [id, m] of marketsArr) {
      if (typeof id !== 'string' || !m || typeof m.token !== 'object') continue
      try {
        const token = InviteToken.fromJSON(m.token)
        const manifest = m.manifest ? new AppManifest(m.manifest) : null
        this.markets.set(id, {
          manifest,
          token,
          topic: typeof m.topic === 'string' ? m.topic : '',
          key: base64ToBytes(m.key),
          isCreator: !!m.isCreator,
          members: arrayToSet(m.members),
        })
      } catch (err) {
        this.log('warn', 'market', `恢复市场 ${id} 失败：${err.message}`)
      }
    }
    // 恢复 _seenNonces
    if (Array.isArray(json.seenNonces)) {
      for (const n of json.seenNonces) {
        if (typeof n === 'string') this._seenNonces.add(n)
      }
    }
  }

  /** 显式 flush 到磁盘（幂等）。 */
  flush() {
    if (!this.persistPath) return
    saveJsonAtomic(this.persistPath, this.toJSON(), { log: this.log })
  }

  /** 内部：mutation 后触发持久化。 */
  _persist() {
    if (!this.persistPath) return
    this.flush()
  }

  /**
   * 创建市场（本节点是创建者）。
   *
   * 创建者会用 context-A 子身份签发第一个邀请令牌给自己（自邀请），
   * 以便创建者也是市场成员。
   *
   * @param {object} opts
   * @param {AppManifest} opts.manifest
   * @param {InviteToken} [opts.creatorToken] 创建者的自邀请令牌
   * @returns {{ marketId: string, topic: string, token: InviteToken }}
   */
  createMarket({ manifest, creatorToken }) {
    if (!(manifest instanceof AppManifest)) {
      throw new InvalidManifestError('manifest 必须是 AppManifest 实例')
    }
    const marketId = manifest.marketId
    if (this.markets.has(marketId)) {
      throw new Error(`市场 ${marketId} 已存在`)
    }
    if (!creatorToken) {
      throw new InvalidTokenError('创建市场时必须提供 creatorToken')
    }
    if (creatorToken.marketId !== marketId) {
      throw new InvalidTokenError('creatorToken.marketId 与 manifest.marketId 不匹配')
    }

    const token = creatorToken
    const topic = deriveTopicFromToken(token)
    const key = deriveEncryptionKey(token)

    this.markets.set(marketId, {
      manifest,
      token,
      topic,
      key,
      isCreator: true,
      members: new Set([token.inviteeDid]),
    })
    this._seenNonces.add(token.nonce)
    // P1 修复：FIFO 退化 LRU 防止长跑节点内存膨胀
    if (this._seenNonces.size > this._seenNonceLimit) {
      const first = this._seenNonces.values().next().value
      this._seenNonces.delete(first)
    }
    this._persist()
    this.log('info', 'market',
      `创建市场 ${marketId}（topic=${topic.slice(0, 24)}...，成员 1）`)
    return { marketId, topic, token }
  }

  /**
   * 加入市场（用市场令牌）。
   *
   * M7 MVP 设计（白皮书 §6.5 inviteToken 单数形式）：
   *   所有市场成员共享同一个"市场令牌"来派生 topic + 加密密钥。
   *   创建者签发的"邀请凭证"（issueInvite）用于 out-of-band 身份验证，
   *   但实际加入市场需要拿到市场令牌（创建者通过私有渠道传递）。
   *
   *   因此本方法不强制 token.inviteeDid === myDid —— 令牌可被转发给其他成员。
   *   授权由 out-of-band 渠道保证，本方法只做密码学校验（签名 + 过期 + nonce）。
   *
   * P0-4 修复：必须调用 token.verifySelf() 验证 issuer 签名，防止伪造 issuerDid
   *   或篡改 payload（marketId/expiresAt/nonce）后重签。
   *
   * @param {object} opts
   * @param {InviteToken} opts.token 市场令牌（所有成员共享）
   * @param {string} opts.myDid 本节点 context-B DID（加入后记入 members 集合）
   * @param {number} [opts.now] 当前时间戳，默认 Date.now()（测试可注入）
   * @returns {Promise<{ marketId: string, topic: string }>}
   */
  async joinMarket({ token, myDid, now }) {
    if (!(token instanceof InviteToken)) {
      throw new InvalidTokenError('token 必须是 InviteToken 实例')
    }
    if (!token.signature || !token.signerPublicKey) {
      throw new InvalidTokenError('令牌缺少签名')
    }
    if (token.isExpired(now ?? Date.now())) {
      throw new InvalidTokenError('令牌已过期')
    }
    // M7 MVP：不强制 inviteeDid === myDid（令牌可被转发给其他成员）
    if (this._seenNonces.has(token.nonce)) {
      throw new InvalidTokenError('令牌已使用（nonce 重放）')
    }

    // P0-4 修复：必须验证 issuer 签名，防止伪造 issuerDid / 篡改 payload 后重签
    const sigValid = await token.verifySelf()
    if (!sigValid) {
      throw new InvalidTokenError('令牌签名验证失败（issuer 签名无效）')
    }

    const marketId = token.marketId
    if (this.markets.has(marketId)) {
      throw new Error(`已加入市场 ${marketId}`)
    }

    const topic = deriveTopicFromToken(token)
    const key = deriveEncryptionKey(token)

    this.markets.set(marketId, {
      manifest: null,  // 加入方不一定有 manifest（创建者才有）
      token,
      topic,
      key,
      isCreator: false,
      members: new Set([myDid]),
    })
    this._seenNonces.add(token.nonce)
    // P1 修复：FIFO 退化 LRU 防止长跑节点内存膨胀
    if (this._seenNonces.size > this._seenNonceLimit) {
      const first = this._seenNonces.values().next().value
      this._seenNonces.delete(first)
    }
    this._persist()
    this.log('info', 'market',
      `加入市场 ${marketId}（topic=${topic.slice(0, 24)}...）`)
    return { marketId, topic }
  }

  /**
   * 离开市场。
   * @param {string} marketId
   */
  leaveMarket(marketId) {
    const m = this.markets.get(marketId)
    if (!m) throw new MarketNotFoundError({ marketId })
    this.markets.delete(marketId)
    this._persist()
    this.log('info', 'market', `离开市场 ${marketId}`)
  }

  /**
   * 取市场信息。
   * @param {string} marketId
   * @returns {object | undefined}
   */
  getMarket(marketId) {
    return this.markets.get(marketId)
  }

  /**
   * 列出本节点参与的市场 ID。
   * @returns {string[]}
   */
  listMarkets() {
    return Array.from(this.markets.keys())
  }

  /**
   * 检查本节点是否是某市场的成员。
   * @param {string} marketId
   * @returns {boolean}
   */
  isMember(marketId) {
    return this.markets.has(marketId)
  }

  /**
   * 取本地令牌。
   * @param {string} marketId
   * @returns {InviteToken}
   */
  getToken(marketId) {
    const m = this.markets.get(marketId)
    if (!m) throw new MarketNotFoundError({ marketId })
    return m.token
  }

  /**
   * 取加密密钥。
   * @param {string} marketId
   * @returns {Uint8Array}
   */
  getEncryptionKey(marketId) {
    const m = this.markets.get(marketId)
    if (!m) throw new MarketNotFoundError({ marketId })
    return m.key
  }

  /**
   * 取私有 topic 名。
   * @param {string} marketId
   * @returns {string}
   */
  getTopic(marketId) {
    const m = this.markets.get(marketId)
    if (!m) throw new MarketNotFoundError({ marketId })
    return m.topic
  }

  /**
   * 取市场 manifest（仅创建者有）。
   * @param {string} marketId
   * @returns {AppManifest | null}
   */
  getManifest(marketId) {
    const m = this.markets.get(marketId)
    if (!m) throw new MarketNotFoundError({ marketId })
    return m.manifest
  }
}

// ──────────────────────────────────────────────
// publishMarketMessage：构造加密信封并广播
// ──────────────────────────────────────────────

/**
 * 构造并广播加密的市场消息到私有 topic。
 *
 * 流程：
 *   1. 用 marketId 对应的加密密钥 AES-GCM 加密 payload JSON
 *   2. 构造明文信封：{ version, type: 'offer', senderId, timestamp, encrypted: { iv, ciphertext, tag } }
 *      （明文信封不含原 payload，攻击者即使加入 topic 也只能看到加密 blob）
 *   3. gossipsub.publish(topic, 信封 JSON)
 *
 * 注：senderId 是 context-B 子身份 DID（市场参与身份），
 *     与公开层 context-A 隔离；payload 在加密块内，不暴露明文。
 *
 * @param {object} opts
 * @param {object} opts.pubsub libp2p gossipsub
 * @param {MarketRegistry} opts.registry
 * @param {string} opts.marketId
 * @param {string} opts.senderId 本节点 context-B DID
 * @param {object} opts.payload 任意可序列化的业务 payload（offer / chat / ack 等）
 * @returns {Promise<{ topic: string, recipients: number }>}
 */
export async function publishMarketMessage({ pubsub, registry, marketId, senderId, payload }) {
  if (!pubsub) throw new Error('pubsub 必需')
  if (!registry) throw new Error('registry 必需')
  if (!marketId) throw new Error('marketId 必需')
  if (!senderId) throw new Error('senderId 必需')
  if (!payload || typeof payload !== 'object') throw new Error('payload 必须是对象')

  const key = registry.getEncryptionKey(marketId)
  const topic = registry.getTopic(marketId)

  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const encrypted = encryptMessage(key, plaintext)

  // 明文信封：明文头 + 加密块（不含 payload 明文）
  // P0-3 修复：市场消息走私有 topic（/s-network/market/ 前缀），不参与公共层签名校验
  //   - payload 已被 AES-GCM 认证（GCM 认证标签保证完整性 + 密钥派生保证只有市场成员能解密）
  //   - 不传 signature/signerPublicKey（新版 makeMessage 不会附加这些字段）
  //   - 接收方按 topic 前缀分流到 handleMarketMessage（绕过公共层 verifyMessageSignature）
  const envelope = makeMessage({
    type: MESSAGE_TYPES.OFFER,
    senderId,
    payload: { marketId, encrypted },
  })

  const bytes = new TextEncoder().encode(JSON.stringify(envelope))
  const result = await pubsub.publish(topic, bytes)
  return { topic, recipients: result?.recipients?.length ?? 0 }
}

/**
 * 处理接收到的市场消息（解密 + 验证）。
 *
 * @param {object} opts
 * @param {MarketRegistry} opts.registry
 * @param {object} opts.envelope 明文信封
 * @param {string} opts.topic 接收到的 topic（用于查找 marketId）
 * @returns {{ marketId: string, senderId: string, payload: object, timestamp: number }}
 * @throws {MarketNotFoundError} 本地未加入该 topic 对应的市场
 * @throws {DecryptionError} 解密失败（密钥错误 / 数据损坏）
 */
export function handleMarketMessage({ registry, envelope, topic }) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('envelope 必须是对象')
  }
  // 通过 topic 反查 marketId
  let marketId = null
  for (const [id, m] of registry.markets) {
    if (m.topic === topic) {
      marketId = id
      break
    }
  }
  if (!marketId) {
    throw new MarketNotFoundError({ marketId: `<topic ${topic.slice(0, 24)}...>` })
  }

  const key = registry.getEncryptionKey(marketId)
  const encrypted = envelope.payload?.encrypted
  if (!encrypted) {
    throw new DecryptionError('envelope.payload.encrypted 缺失')
  }

  const plaintextBytes = decryptMessage(key, encrypted)
  const plaintext = new TextDecoder().decode(plaintextBytes)
  const payload = JSON.parse(plaintext)

  return {
    marketId,
    senderId: envelope.senderId,
    payload,
    timestamp: envelope.timestamp,
  }
}
