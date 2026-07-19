/**
 * Havix 编辑员资格协议（M3.2 — vouch 累积阈值门控 / M4 — 信誉加权升级）
 * ───────────────────────────────────────────────
 * 设计目标（白皮书 §3.2 context-D + §11.3 M3.2 + §4.1 M4）：
 *   任何人都可以读取维基，但写入需"足够多的高信誉节点背书"。
 *
 * 数据流：
 *   高信誉节点 A → 用 context-A 子身份签名 { endorseDid: D_x, timestamp }
 *              → gossipsub /s-network/reputation 广播 vouch 消息
 *              → 接收方验签通过 → VouchRegistry 索引 (endorseDid, voucherDid)
 *
 *   编辑员 X → 想 publishEntry
 *           → WikiProtocol 先查 VouchRegistry.getQualification(X.context-D-DID)
 *           → qualified=true 才允许发布
 *
 * M3.2 简化版（无 reputationLedger 注入）：
 *   - 用简单 N-vouch 计数（getVouchCount）与 threshold 比较
 *   - 所有 vouch 来源权重相同
 *
 * M4 升级（注入 reputationLedger）：
 *   - getWeightedScore(endorseDid) = Σ(voucherDid 的可用信誉)
 *   - 高信誉节点的 vouch 更有分量（白皮书 §4.1：信誉累积型）
 *   - thresholdScore 默认 = threshold * DEFAULT_INITIAL_REPUTATION
 *     （即所有 vouch 都来自默认信誉 1.0 的节点时，行为与 M3.2 完全一致）
 *   - isQualified 改为比较 weightedScore 与 thresholdScore
 *   - getQualification 统一返回 { score, threshold, qualified }，便于上层错误展示
 *
 * Deferred（未来工作）：
 *   - vouch 自动给 endorseDid 累积 reputation（M5/M6 实现）
 *   - Reputation 时间衰减
 *   - vouch 撤销 / 编辑员吊销（M6 仲裁时实现）
 *
 * 安全性质：
 *   1. 自 vouch 拒绝：voucherDid === endorseDid 视为无效（防自吹自擂）
 *   2. 同一 vouch 幂等：重复 vouch 不累加计数（按 voucherDid 去重）
 *   3. 不可伪造：vouch 用 context-A 子身份签名，接收方零依赖验签
 *   4. 不可关联：context-A 与 context-D 在密码学上独立，外部观察者
 *      无法从 vouch 消息反推到被背书人的维基身份
 */

import { MESSAGE_TYPES, makeMessage, signMessage } from './message-types.js'
import {
  computeWeightedScore,
  DEFAULT_INITIAL_REPUTATION,
} from './credit.js'
import { saveJsonAtomic, mapToArray, arrayToMap, setToArray, arrayToSet } from '../persistence.js'

// vouch 消息走 /s-network/reputation（与心跳/维基 announce 分开）
export const VOUCH_TOPIC = '/s-network/reputation'

// 默认 vouch 阈值（白皮书建议值，可在构造时覆盖）
export const DEFAULT_VOUCH_THRESHOLD = 2

// ──────────────────────────────────────────────
// VouchRegistry 类
// ──────────────────────────────────────────────

/**
 * 编辑员资格注册表。
 *
 * 维护 `endorseDid → Set<voucherDid>` 索引（按 voucherDid 去重）。
 *
 * 对外提供：
 *   - addVouch(endorseDid, voucherDid)    记录一次 vouch
 *   - getVouchCount(endorseDid)          查询 endorseDid 累积的 vouch 数（M3.2）
 *   - getWeightedScore(endorseDid)        按 voucherDid 信誉加权总分（M4）
 *   - getQualification(endorseDid)        统一资格查询 { score, threshold, qualified }（M4）
 *   - isQualified(endorseDid)             是否达到阈值（自动适配 M3.2/M4 模式）
 *   - getVouchers(endorseDid)            列出所有 vouch 来源
 *   - handleVouch(message, ctx)          处理收到的 vouch 消息
 *
 * 模式切换：
 *   - 未注入 reputationLedger → M3.2 兼容模式（简单 N-vouch 计数）
 *   - 注入 reputationLedger    → M4 加权模式（weightedScore vs thresholdScore）
 *
 * M8.1 持久化：构造时传 `persistPath` 即开启落盘（同步原子写）。
 *   - 启动时由 SNode 调用 `loadState(readJson(path))` 注入磁盘状态
 *   - 每次 addVouch 后自动 `_persist()`
 *   - 不传 persistPath 则纯内存模式（单元测试沿用）
 */
export class VouchRegistry {
  /**
   * @param {object} opts
   * @param {number} [opts.threshold]      vouch 阈值（计数模式）/ thresholdScore 基线（加权模式），默认 2
   * @param {number} [opts.thresholdScore]  M4 加权阈值；默认 = threshold * DEFAULT_INITIAL_REPUTATION
   * @param {object} [opts.reputationLedger]  M4 信誉账本（不传则 M3.2 兼容模式）
   * @param {object} [opts.log]              可选日志函数 (level, tag, msg)
   * @param {string} [opts.persistPath]      可选持久化文件路径
   */
  constructor({ threshold, thresholdScore, reputationLedger, log, persistPath } = {}) {
    this.threshold = typeof threshold === 'number' && threshold > 0
      ? threshold
      : DEFAULT_VOUCH_THRESHOLD
    this.reputationLedger = reputationLedger ?? null
    // P1 修复：thresholdScore 应基于注入 ledger 的 initialReputation 推导，
    // 而非硬编码 DEFAULT_INITIAL_REPUTATION。computeWeightedScore 对默认信誉节点
    // 计入的是 ledger.initialReputation（非固定 1.0），故阈值基线必须保持一致：
    // threshold=2 即"需要 2 个默认信誉 vouch"= threshold * ledger.initialReputation。
    // 无 ledger 时（M3.2 兼容模式）退回 DEFAULT_INITIAL_REPUTATION，保留原行为。
    this.thresholdScore = typeof thresholdScore === 'number' && thresholdScore > 0
      ? thresholdScore
      : this.threshold * (this.reputationLedger?.initialReputation ?? DEFAULT_INITIAL_REPUTATION)
    this.log = log ?? (() => {})
    this.persistPath = persistPath ?? null

    /** @type {Map<string, Set<string>>} endorseDid → Set<voucherDid> */
    this.vouches = new Map()
    this._maxVouchesPerDid = 10_000
  }

  /**
   * 序列化为 JSON 可保存的对象。
   * Set<string> 转 string[] 以兼容 JSON。
   * @returns {{ version: string, vouches: [string, string[]][] }}
   */
  toJSON() {
    return {
      version: 'vouch-v1',
      vouches: mapToArray(this.vouches).map(([k, set]) => [k, setToArray(set)]),
    }
  }

  /**
   * 从 loadJson 加载的对象恢复状态（合并到现有 vouches）。
   * @param {object} json
   */
  loadState(json) {
    if (!json || typeof json !== 'object') return
    const arr = Array.isArray(json.vouches) ? json.vouches : []
    for (const [endorseDid, vouchers] of arr) {
      if (typeof endorseDid !== 'string') continue
      const set = arrayToSet(vouchers)
      // 合并到已存在的 set（若有），不覆盖
      const existing = this.vouches.get(endorseDid)
      if (existing) {
        for (const v of set) existing.add(v)
      } else {
        this.vouches.set(endorseDid, set)
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
   * 记录一次 vouch。
   *
   * 校验：
   *   - endorseDid / voucherDid 必须是非空字符串
   *   - 自 vouch（endorseDid === voucherDid）拒绝
   *   - 同一对 (endorseDid, voucherDid) 幂等（不重复计数）
   *
   * M4 注：本方法只维护 vouch 集合，不主动更新 reputationLedger。
   * vouch 自动给 endorseDid 累积 reputation 的策略 deferred 到 M5+。
   *
   * @param {string} endorseDid   被背书人 DID（context-D 子 DID）
   * @param {string} voucherDid   背书人 DID（context-A 子 DID）
   * @returns {{ added: boolean, count: number, reason?: string }}
   */
  addVouch(endorseDid, voucherDid) {
    if (typeof endorseDid !== 'string' || endorseDid.length === 0) {
      return { added: false, count: 0, reason: 'endorseDid 无效' }
    }
    if (typeof voucherDid !== 'string' || voucherDid.length === 0) {
      return { added: false, count: 0, reason: 'voucherDid 无效' }
    }
    if (endorseDid === voucherDid) {
      return { added: false, count: this.getVouchCount(endorseDid), reason: '禁止自 vouch' }
    }

    let set = this.vouches.get(endorseDid)
    if (!set) {
      set = new Set()
      this.vouches.set(endorseDid, set)
    }
    if (set.has(voucherDid)) {
      return { added: false, count: set.size, reason: '已 vouch 过（幂等）' }
    }
    set.add(voucherDid)
    // P1 修复：每个 endorseDid 的 vouch 集合加 LRU 上限
    if (set.size > this._maxVouchesPerDid) {
      const first = set.values().next().value
      set.delete(first)
    }
    this._persist()
    this.log('info', 'vouch',
      `+1 vouch for ${endorseDid.slice(0, 16)}... by ${voucherDid.slice(0, 16)}... (total=${set.size})`)
    return { added: true, count: set.size }
  }

  /**
   * 查询 endorseDid 累积的 vouch 数（M3.2 计数，与 M4 模式无关）。
   * @param {string} endorseDid
   * @returns {number}
   */
  getVouchCount(endorseDid) {
    return this.vouches.get(endorseDid)?.size ?? 0
  }

  /**
   * M4：按 voucherDid 信誉加权计算 endorseDid 的总分。
   *
   * score = Σ(voucherDid 的可用信誉)
   *
   * 无 reputationLedger 时退化为简单计数（M3.2 兼容）。
   *
   * @param {string} endorseDid
   * @returns {number}
   */
  getWeightedScore(endorseDid) {
    const vouchers = this.getVouchers(endorseDid)
    return computeWeightedScore(vouchers, this.reputationLedger)
  }

  /**
   * M4：统一资格查询接口。
   *
   * 返回 { score, threshold, qualified }，便于上层（如 WikiProtocol）构造错误信息。
   *
   * - 无 reputationLedger（M3.2 兼容模式）：
   *     score = vouchCount（整数）
   *     threshold = this.threshold（整数）
   *     qualified = count >= threshold
   * - 有 reputationLedger（M4 加权模式）：
   *     score = weightedScore（浮点）
   *     threshold = this.thresholdScore（浮点）
   *     qualified = score >= thresholdScore
   *
   * @param {string} endorseDid
   * @returns {{ score: number, threshold: number, qualified: boolean }}
   */
  getQualification(endorseDid) {
    if (!this.reputationLedger) {
      const count = this.getVouchCount(endorseDid)
      return { score: count, threshold: this.threshold, qualified: count >= this.threshold }
    }
    const score = this.getWeightedScore(endorseDid)
    return {
      score,
      threshold: this.thresholdScore,
      qualified: score >= this.thresholdScore,
    }
  }

  /**
   * 是否达到 vouch 阈值，具备编辑员资格。
   *
   * 自动适配 M3.2（计数）或 M4（加权）模式。
   *
   * @param {string} endorseDid
   * @returns {boolean}
   */
  isQualified(endorseDid) {
    return this.getQualification(endorseDid).qualified
  }

  /**
   * 列出某 endorseDid 的所有 vouch 来源。
   * @param {string} endorseDid
   * @returns {string[]}
   */
  getVouchers(endorseDid) {
    const set = this.vouches.get(endorseDid)
    return set ? Array.from(set) : []
  }

  /**
   * 处理收到的 vouch 消息。
   *
   * 前置条件：调用方（SNode）已校验消息结构 + Ed25519 验签。
   *
   * payload 期望字段：
   *   - endorseDid: string  被背书人 DID
   *   - timestamp: number   vouch 时间戳
   *   - reason?: string     可选背书理由
   *
   * voucherDid 取自 message.senderId（已验签的 context-A 子 DID）。
   *
   * @param {object} message 已验签的 vouch 消息
   * @returns {{ added: boolean, count: number, reason?: string }}
   */
  handleVouch(message) {
    const { payload, senderId } = message
    if (!payload || typeof payload !== 'object') {
      return { added: false, count: 0, reason: 'payload 缺失' }
    }
    if (typeof payload.endorseDid !== 'string' || payload.endorseDid.length === 0) {
      return { added: false, count: 0, reason: 'payload.endorseDid 无效' }
    }
    if (typeof payload.timestamp !== 'number' || payload.timestamp <= 0) {
      return { added: false, count: 0, reason: 'payload.timestamp 无效' }
    }
    // voucherDid = 消息签名者（context-A 子 DID），不是 payload 里的字段
    // 这样可以防止伪造"我替别人 vouch"
    const voucherDid = senderId
    return this.addVouch(payload.endorseDid, voucherDid)
  }
}

// ──────────────────────────────────────────────
// 工具：构造并发送一条 vouch 消息
// ──────────────────────────────────────────────

/**
 * 让某节点用 context-A 子身份为 endorseDid 发起一次 vouch。
 *
 * 流程：
 *   1. 用 context-A 子身份签名 payload { endorseDid, timestamp, reason? }
 *   2. 组装 vouch 消息（makeMessage）
 *   3. publish 到 /s-network/reputation
 *
 * @param {object} opts
 * @param {object} opts.pubsub           libp2p.services.pubsub
 * @param {import('../identity.js').Identity} opts.voucherIdentity  背书人的 context-A 子身份
 * @param {string} opts.endorseDid       被背书人的 context-D 子 DID
 * @param {string} [opts.reason]         可选背书理由
 * @param {object} [opts.log]            可选日志函数
 * @returns {Promise<{ message: object, recipients: number }>}
 */
export async function publishVouch({ pubsub, voucherIdentity, endorseDid, reason, log }) {
  const logger = log ?? (() => {})
  if (typeof endorseDid !== 'string' || endorseDid.length === 0) {
    throw new Error('endorseDid 必须是非空字符串')
  }

  const payload = {
    endorseDid,
    timestamp: Date.now(),
    reason: reason ?? '',
  }
  // P1 修复：校验 payload.timestamp 为有限正数（防 NaN / Infinity）
  if (!Number.isFinite(payload.timestamp) || payload.timestamp <= 0) {
    throw new Error(`payload.timestamp 必须是有限正数，实际 ${payload.timestamp}`)
  }
  // P0-1 修复：签名覆盖整个 canonical message（含 senderId/type/timestamp/payload）
  const message = await signMessage({
    type: MESSAGE_TYPES.VOUCH,
    senderId: voucherIdentity.did,       // context-A 子 DID
    payload,
    identity: voucherIdentity,
  })

  const bytes = new TextEncoder().encode(JSON.stringify(message))
  const result = await pubsub.publish(VOUCH_TOPIC, bytes)
  const recipients = result.recipients?.length ?? 0
  logger('info', 'vouch',
    `发起 vouch for ${endorseDid.slice(0, 16)}... (recipients=${recipients})`)

  return { message, recipients }
}
