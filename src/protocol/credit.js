/**
 * Havix Credit 双轨经济（M4）
 * ───────────────────────────────────────────────
 * 设计目标（白皮书 §4）：
 *   Track 1 Reputation（不可消耗，累积型）
 *     - 来源：vouch 消息累积
 *     - 用途：准入凭证（维基编辑员、relay 资格、市场创建权）
 *     - 性质：长期信用
 *     - 范围：per-context 独立
 *
 *   Track 2 Credit（可消耗，凭证型）
 *     - 来源：高信誉节点签发的"服务凭证"
 *     - 用途：消费 offer
 *     - 实现：签名 JSON {issuer, holder, amount, nonce, sig}
 *
 *   Faucet 机制（Reputation → Credit 单向转换）：
 *     高信誉节点签发 Credit 时，等额自身 Reputation 被"冻结"，
 *     Credit 被消费后冻结部分释放（信誉不变）。
 *     反通胀 + 作恶成本 + 自然流通 + 价值锚定。
 *
 * M4 MVP 范围：
 *   - ReputationLedger：voucherDid → reputation 数值（默认 1.0）
 *   - VouchRegistry 升级：从简单 N-vouch 计数 → 按 voucherReputation 加权
 *   - CreditLedger：holderDid → balance
 *   - Faucet：signIssue（冻结 issuer 信誉）/ consume（释放冻结）
 *   - CreditNote：签名 JSON 结构（写入 IPFS）
 *   - 转账流水走 gossipsub /s-network/reputation topic
 *
 * Deferred 到未来工作（M4 不实现）：
 *   - Reputation 时间衰减（白皮书未明确，未来工作）
 *   - 完整双重支付防护（需要全节点共识，M6 仲裁时实现）
 *   - 信用汇率（高信誉节点的 credit 更值钱 — 仅设计说明）
 *   - App Manifest 加权（白皮书 §3.3，未来工作）
 *   - Credit 跨市场流通（M7 邀请市场时实现）
 */

import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { MESSAGE_TYPES, makeMessage, signMessage } from './message-types.js'
import { saveJsonAtomic, mapToArray, arrayToMap } from '../persistence.js'

// Credit 流水消息走 /s-network/reputation（与 vouch 同 topic，便于聚合信誉事件）
export const CREDIT_TOPIC = '/s-network/reputation'

// raw codec code（与 wiki.js 一致，0x55 表示 raw 即原始字节）
const RAW_CODEC = 0x55

// 默认起始 reputation（每个新 voucherDid 的初始信誉分）
export const DEFAULT_INITIAL_REPUTATION = 1.0

// 高信誉节点签发 Credit 的最小 reputation 阈值（白皮书 §4.2，"高信誉节点"门槛）
export const DEFAULT_FAUCET_MIN_REPUTATION = 10.0

// ──────────────────────────────────────────────
// ReputationLedger
// ──────────────────────────────────────────────

/**
 * 信誉账本。
 *
 * 维护 `did → { available, frozen }` 三元组：
 *   - available：可用信誉（用于 vouch 加权、签发 Credit 资格判断）
 *   - frozen：冻结信誉（签发 Credit 时冻结，Credit 被消费后释放）
 *   - 总信誉 total = available + frozen（不变，仅在两池间转移）
 *
 * 与白皮书 §4.2 关键性质 4 一致："credit 价值 = 签发节点信誉的投影"——
 * total 不变意味着签发 Credit 不影响 issuer 的总信誉排名，
 * 只影响其"还能再签发多少 Credit"。
 *
 * M8.1 持久化：构造时传 `persistPath` 即开启落盘（同步原子写）。
 *   - 启动时由 SNode 调用 `loadState(readJson(path))` 注入磁盘状态
 *   - 每次 mutation 后自动 `_persist()`（写入 persistPath）
 *   - 不传 persistPath 则纯内存模式（单元测试沿用）
 */
export class ReputationLedger {
  /**
   * @param {object} opts
   * @param {number} [opts.initialReputation] 新 did 的初始信誉分，默认 1.0
   * @param {object} [opts.log] 可选日志函数 (level, tag, msg)
   * @param {string} [opts.persistPath] 可选持久化文件路径；不传则纯内存模式
   */
  constructor({ initialReputation, log, persistPath } = {}) {
    this.initialReputation = typeof initialReputation === 'number' && initialReputation >= 0
      ? initialReputation
      : DEFAULT_INITIAL_REPUTATION
    this.log = log ?? (() => {})
    this.persistPath = persistPath ?? null

    /** @type {Map<string, {available: number, frozen: number}>} */
    this.balances = new Map()

    // P1-3 修复：issuerDid → 公钥绑定 Map（防伪造 note 时旋转 keypair）
    //   - first-seen wins：首次见到 issuerDid 签的 note 时登记其公钥
    //   - 后续必须用同一公钥签，否则拒绝
    /** @type {Map<string, string>} did → base64 publicKey */
    this._issuerPubKeys = new Map()
  }

  /**
   * 序列化为 JSON 可保存的对象。
   * @returns {{ version: string, balances: [string, {available: number, frozen: number}][] }}
   */
  toJSON() {
    return {
      version: 'reputation-v1',
      initialReputation: this.initialReputation,
      balances: mapToArray(this.balances),
      // P1-3 修复：持久化 issuerDid → pubKey 绑定
      issuerPubKeys: mapToArray(this._issuerPubKeys),
    }
  }

  /**
   * 从 loadJson 加载的对象恢复状态（合并到现有 balances）。
   * M8.1：SNode.start() 时调用。
   * @param {object} json
   */
  loadState(json) {
    if (!json || typeof json !== 'object') return
    const arr = Array.isArray(json.balances) ? json.balances : []
    for (const [did, info] of arr) {
      if (typeof did === 'string' && info
        && typeof info.available === 'number'
        && typeof info.frozen === 'number') {
        this.balances.set(did, { available: info.available, frozen: info.frozen })
      }
    }
    // P1-3 修复：恢复 issuerPubKeys 绑定
    const pubArr = Array.isArray(json.issuerPubKeys) ? json.issuerPubKeys : []
    for (const [did, pubKey] of pubArr) {
      if (typeof did === 'string' && typeof pubKey === 'string') {
        this._issuerPubKeys.set(did, pubKey)
      }
    }
  }

  /**
   * P1-3 修复：登记某 issuerDid 的公钥（first-seen wins）。
   *
   * 策略：
   *   - 首次见到 issuerDid 时登记其公钥
   *   - 后续必须用同一公钥签 note，否则 note 视为伪造
   *   - 防止攻击者获取 issuerDid 后用新 keypair 签 issue note
   *     （即"旋转 keypair 攻击"）
   *
   * @param {string} did issuerDid
   * @param {string} pubKey base64 编码的公钥
   * @returns {{ registered: boolean, pubKey: string, conflict?: string }}
   *   registered=true 表示新登记或匹配已有
   *   registered=false 表示与已登记公钥冲突（调用方应拒绝该 note）
   */
  registerIssuerPubKey(did, pubKey) {
    if (typeof did !== 'string' || did.length === 0) {
      throw new Error('did 必须是非空字符串')
    }
    if (typeof pubKey !== 'string' || pubKey.length === 0) {
      throw new Error('pubKey 必须是非空字符串')
    }
    const existing = this._issuerPubKeys.get(did)
    if (existing === undefined) {
      this._issuerPubKeys.set(did, pubKey)
      this._persist()
      this.log('info', 'rep',
        `登记 issuer ${did.slice(0, 16)}... 公钥（首次绑定，P1-3）`)
      return { registered: true, pubKey }
    }
    if (existing !== pubKey) {
      // 冲突：issuerDid 已绑定到不同公钥
      this.log('warn', 'rep',
        `issuer ${did.slice(0, 16)}... 公钥冲突：已登记 ${existing.slice(0, 16)}... 但新 note 用 ${pubKey.slice(0, 16)}...，拒绝（P1-3）`)
      return { registered: false, pubKey: existing, conflict: pubKey }
    }
    return { registered: true, pubKey }
  }

  /**
   * P1-3 修复：取某 issuerDid 已登记的公钥。
   * @param {string} did
   * @returns {string | undefined} 已登记的 base64 公钥，未登记时 undefined
   */
  getIssuerPubKey(did) {
    return this._issuerPubKeys.get(did)
  }

  /**
   * 显式 flush 到磁盘（幂等）。
   * SNode.stop() 时调用；mutation 后内部已自动 _persist。
   */
  flush() {
    if (!this.persistPath) return
    saveJsonAtomic(this.persistPath, this.toJSON(), { log: this.log })
  }

  /**
   * 内部：mutation 后触发持久化。
   * 失败由 saveJsonAtomic 内部 log warn，不抛错。
   */
  _persist() {
    if (!this.persistPath) return
    this.flush()
  }

  /**
   * 取某 did 的信誉三元组（不存在则按初始值创建）。
   *
   * P1-4 修复：懒创建只更新内存，不触发 _persist()。
   *   - 高频读路径不应触发磁盘 IO 阻塞事件循环
   *   - 调用方在 mutation（freeze/release/slash/credit）时会持久化，
   *     届时该 did 的初始化记录会一并落盘
   *   - 纯只读的 did（get 后无 mutation）丢失不损失任何业务数据：
   *     初始值每次启动都能用 initialReputation 重算出来
   *
   * @param {string} did
   * @returns {{available: number, frozen: number, total: number}}
   */
  get(did) {
    let b = this.balances.get(did)
    if (!b) {
      b = { available: this.initialReputation, frozen: 0 }
      this.balances.set(did, b)
      // P1-4 修复：不调用 _persist()——懒创建只更新内存
    }
    return { ...b, total: b.available + b.frozen }
  }

  /**
   * 取可用信誉。
   * @param {string} did
   * @returns {number}
   */
  getAvailable(did) {
    return this.get(did).available
  }

  /**
   * 取冻结信誉。
   * @param {string} did
   * @returns {number}
   */
  getFrozen(did) {
    return this.get(did).frozen
  }

  /**
   * 取总信誉（available + frozen）。
   * @param {string} did
   * @returns {number}
   */
  getTotal(did) {
    const b = this.get(did)
    return b.total
  }

  /**
   * 增加可用信誉（用于外部事件触发，比如优质内容获 vouch）。
   * @param {string} did
   * @param {number} amount 非负数
   * @returns {{available: number, frozen: number, total: number}}
   */
  credit(did, amount) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new Error(`amount 必须是非负数，实际 ${amount}`)
    }
    const b = this.balances.get(did) ?? { available: this.initialReputation, frozen: 0 }
    b.available += amount
    this.balances.set(did, b)
    this._persist()
    return { ...b, total: b.available + b.frozen }
  }

  /**
   * 冻结等额可用信誉（签发 Credit 时调用）。
   *
   * 校验：可用信誉必须 ≥ amount，否则抛错。
   *
   * @param {string} did 签发者 did
   * @param {number} amount 冻结量
   * @returns {{available: number, frozen: number, total: number}}
   */
  freeze(did, amount) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error(`amount 必须是正数，实际 ${amount}`)
    }
    const b = this.balances.get(did) ?? { available: this.initialReputation, frozen: 0 }
    if (b.available < amount) {
      throw new InsufficientReputationError({
        did, needed: amount, available: b.available,
      })
    }
    b.available -= amount
    b.frozen += amount
    this.balances.set(did, b)
    this._persist()
    this.log('info', 'rep',
      `冻结 ${amount} 信誉（did=${did.slice(0, 16)}...，available=${b.available}, frozen=${b.frozen}）`)
    return { ...b, total: b.available + b.frozen }
  }

  /**
   * 释放冻结信誉（Credit 被消费后调用）。
   *
   * 校验：冻结信誉必须 ≥ amount。
   * 释放后回到 available 池；total 不变。
   *
   * @param {string} did
   * @param {number} amount
   * @returns {{available: number, frozen: number, total: number}}
   */
  release(did, amount) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error(`amount 必须是正数，实际 ${amount}`)
    }
    const b = this.balances.get(did) ?? { available: this.initialReputation, frozen: 0 }
    if (b.frozen < amount) {
      throw new InsufficientFrozenError({
        did, needed: amount, frozen: b.frozen,
      })
    }
    b.frozen -= amount
    b.available += amount
    this.balances.set(did, b)
    this._persist()
    this.log('info', 'rep',
      `释放 ${amount} 冻结信誉（did=${did.slice(0, 16)}...，available=${b.available}, frozen=${b.frozen}）`)
    return { ...b, total: b.available + b.frozen }
  }

  /**
   * Slash：直接从冻结池中扣除（M6 仲裁调用，M4 暴露接口但不触发）。
   *
   * 与白皮书 §5.3 一致："Slash 只动冻结部分，不动可用信誉"。
   * total 会减少（不同于 release）。
   *
   * @param {string} did
   * @param {number} amount
   * @returns {{available: number, frozen: number, total: number}}
   */
  slash(did, amount) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error(`amount 必须是正数，实际 ${amount}`)
    }
    const b = this.balances.get(did) ?? { available: this.initialReputation, frozen: 0 }
    if (b.frozen < amount) {
      throw new InsufficientFrozenError({
        did, needed: amount, frozen: b.frozen,
      })
    }
    b.frozen -= amount
    this.balances.set(did, b)
    this._persist()
    this.log('warn', 'rep',
      `Slash ${amount} 冻结信誉（did=${did.slice(0, 16)}...，frozen=${b.frozen}，total=${b.available + b.frozen}）`)
    return { ...b, total: b.available + b.frozen }
  }
}

// ──────────────────────────────────────────────
// 错误类
// ──────────────────────────────────────────────

/**
 * 可用信誉不足（签发 Credit 时无法冻结所需量）。
 */
export class InsufficientReputationError extends Error {
  constructor({ did, needed, available }) {
    super(`信誉不足：did=${did.slice(0, 16)}... 需要 ${needed}，可用 ${available}`)
    this.name = 'InsufficientReputationError'
    this.code = 'INSUFFICIENT_REPUTATION'
    this.did = did
    this.needed = needed
    this.available = available
  }
}

/**
 * 冻结信誉不足（释放或 slash 时冻结池不够）。
 */
export class InsufficientFrozenError extends Error {
  constructor({ did, needed, frozen }) {
    super(`冻结信誉不足：did=${did.slice(0, 16)}... 需要 ${needed}，冻结 ${frozen}`)
    this.name = 'InsufficientFrozenError'
    this.code = 'INSUFFICIENT_FROZEN'
    this.did = did
    this.needed = needed
    this.frozen = frozen
  }
}

// ──────────────────────────────────────────────
// VouchRegistry 升级：信誉加权
// ──────────────────────────────────────────────

/**
 * 把 VouchRegistry 从简单 N-vouch 计数升级为按 voucherReputation 加权。
 *
 * 改动：
 *   - 新增 `reputationLedger` 依赖（构造时注入）
 *   - 新增 `getWeightedScore(endorseDid)`：Σ(voucherReputation for v in vouchers)
 *   - 新增 `thresholdScore`：默认等于原 threshold * initialReputation
 *     （即所有 vouch 都来自默认信誉 1.0 的节点时，行为与原 N-vouch 一致）
 *   - `isQualified` 改为比较 weightedScore 与 thresholdScore
 *   - 旧的 `getVouchCount` 与 `threshold` 字段保留，向后兼容
 *
 * 这样：
 *   - 1 个 rep=10 的节点 vouch = 10 个 rep=1 的节点 vouch（高信誉背书更有分量）
 *   - 默认配置下（所有节点 rep=1.0），行为与 M3.2 完全一致
 */
export function computeWeightedScore(vouchers, reputationLedger) {
  if (!reputationLedger) {
    // 没注入 ledger 时退化为简单计数（M3.2 兼容）
    return vouchers.length
  }
  let sum = 0
  for (const v of vouchers) {
    sum += reputationLedger.getAvailable(v)
  }
  return sum
}

// ──────────────────────────────────────────────
// CreditNote：签名 JSON 结构（写入 IPFS）
// ──────────────────────────────────────────────

/**
 * 一张 Credit 凭证（白皮书 §4.1：IPFS 上的签名 JSON）。
 *
 * @typedef {Object} CreditNote
 * @property {string} type 'issue' | 'transfer' | 'consume'
 * @property {string} issuerDid 签发者 did（context-A 子身份）
 * @property {string} holderDid 持有者 did
 * @property {number} amount 金额（正数）
 * @property {number} nonce 防重放随机数
 * @property {number} timestamp
 * @property {string} prevNoteCid 前一笔流水的 CID（流水链）；首笔为 null
 * @property {string} signature issuer 对本结构（除 signature 外）的签名
 * @property {string} signerPublicKey issuer 的公钥原始字节
 */

// ──────────────────────────────────────────────
// CreditLedger
// ──────────────────────────────────────────────

/**
 * Credit 账本。
 *
 * 维护 `holderDid → balance` 余额表。
 *
 * 对外提供：
 *   - credit(holderDid, amount)         增加余额（Faucet 签发时调用）
 *   - debit(holderDid, amount)          扣减余额（消费时调用，不足抛错）
 *   - transfer(fromDid, toDid, amount)  转账
 *   - getBalance(holderDid)             查询余额
 *
 * M8.1 持久化：构造时传 `persistPath` 即开启落盘（同步原子写）。
 *   - 启动时由 SNode 调用 `loadState(readJson(path))` 注入磁盘状态
 *   - 每次 mutation 后自动 `_persist()`
 *   - 不传 persistPath 则纯内存模式（单元测试沿用）
 *
 * 完整双重支付防护仍 deferred（M6 仲裁时通过流水链验证）。
 */
export class CreditLedger {
  /**
   * @param {object} [opts]
   * @param {object} [opts.log] 可选日志函数
   * @param {string} [opts.persistPath] 可选持久化文件路径
   */
  constructor({ log, persistPath } = {}) {
    this.log = log ?? (() => {})
    this.persistPath = persistPath ?? null
    /** @type {Map<string, number>} */
    this.balances = new Map()
  }

  /**
   * 序列化为 JSON 可保存的对象。
   * @returns {{ version: string, balances: [string, number][] }}
   */
  toJSON() {
    return {
      version: 'credit-v1',
      balances: mapToArray(this.balances),
    }
  }

  /**
   * 从 loadJson 加载的对象恢复状态（合并到现有 balances）。
   * @param {object} json
   */
  loadState(json) {
    if (!json || typeof json !== 'object') return
    const arr = Array.isArray(json.balances) ? json.balances : []
    for (const [did, bal] of arr) {
      if (typeof did === 'string' && typeof bal === 'number' && Number.isFinite(bal)) {
        this.balances.set(did, bal)
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
   * 查询余额。
   * @param {string} did
   * @returns {number}
   */
  getBalance(did) {
    return this.balances.get(did) ?? 0
  }

  /**
   * 增加余额（Faucet 签发 / 收款）。
   * @param {string} did
   * @param {number} amount
   * @returns {number} 新余额
   */
  credit(did, amount) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error(`amount 必须是正数，实际 ${amount}`)
    }
    const cur = this.balances.get(did) ?? 0
    const next = cur + amount
    this.balances.set(did, next)
    this._persist()
    return next
  }

  /**
   * 扣减余额（消费 / 转出）。
   * @param {string} did
   * @param {number} amount
   * @returns {number} 新余额
   */
  debit(did, amount) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error(`amount 必须是正数，实际 ${amount}`)
    }
    const cur = this.balances.get(did) ?? 0
    if (cur < amount) {
      throw new InsufficientCreditError({ did, needed: amount, balance: cur })
    }
    const next = cur - amount
    this.balances.set(did, next)
    this._persist()
    return next
  }

  /**
   * 转账。
   * @param {string} fromDid
   * @param {string} toDid
   * @param {number} amount
   * @returns {{fromBalance: number, toBalance: number}}
   */
  transfer(fromDid, toDid, amount) {
    if (fromDid === toDid) {
      throw new Error('fromDid 与 toDid 不能相同')
    }
    // P1 修复：增加 Number.isFinite 校验，防 NaN / Infinity（与 debit/credit 一致）
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error(`amount 必须是正数，实际 ${amount}`)
    }
    // P0-2 修复（AUDIT-M10）：transfer 原子性 —— debit 成功后若 credit 抛错，
    // 必须回滚 debit，否则金额凭空消失。先用 debit 校验余额并扣款，credit 失败时 refund。
    let newFrom
    try {
      newFrom = this.debit(fromDid, amount)
    } catch (err) {
      throw err  // debit 失败（余额不足等）直接抛出，状态未变
    }
    try {
      const newTo = this.credit(toDid, amount)
      return { fromBalance: newFrom, toBalance: newTo }
    } catch (err) {
      // credit 失败 → 回滚 debit
      try {
        this.credit(fromDid, amount)  // 退还 fromDid
      } catch (refundErr) {
        // 退款也失败（极端情况），抛出原始错误 + 退款失败信息
        throw new Error(
          `transfer 回滚失败：debit 已扣 ${amount} 但 credit 与 refund 均失败。` +
          `原始错误: ${err.message}; 退款错误: ${refundErr.message}`,
        )
      }
      throw err
    }
  }
}

/**
 * Credit 余额不足。
 */
export class InsufficientCreditError extends Error {
  constructor({ did, needed, balance }) {
    super(`Credit 不足：did=${did.slice(0, 16)}... 需要 ${needed}，余额 ${balance}`)
    this.name = 'InsufficientCreditError'
    this.code = 'INSUFFICIENT_CREDIT'
    this.did = did
    this.needed = needed
    this.balance = balance
  }
}

// ──────────────────────────────────────────────
// Faucet：签发 Credit 时冻结等额信誉
// ──────────────────────────────────────────────

/**
 * Faucet 服务：高信誉节点签发 Credit 的入口。
 *
 * 流程（白皮书 §4.2）：
 *   1. 校验 issuer 的可用信誉 ≥ amount + minReputation（保留最低门槛）
 *   2. ReputationLedger.freeze(issuerDid, amount)  冻结等额信誉
 *   3. CreditLedger.credit(holderDid, amount)     增加 holder 余额
 *   4. 生成 CreditNote（含 issuer 签名）
 *   5. （可选）写入 IPFS 形成流水链
 *   6. 广播 credit 消息到 /s-network/reputation
 *
 * 消费流程：
 *   1. CreditLedger.debit(holderDid, amount)
 *   2. ReputationLedger.release(issuerDid, amount)  释放冻结
 *
 * Slash 流程（M6 调用，M4 暴露接口）：
 *   1. ReputationLedger.slash(issuerDid, amount)  从冻结池直接扣除
 *
 * 注意：M4 不实现完整双重支付防护——
 *   - 签发与消费都信任本地账本状态
 *   - 跨节点的账本同步靠 gossipsub credit 消息
 *   - 真正的双支付防护需要 M6 仲裁团对 IPFS 流水链做最终裁决
 */
export class Faucet {
  /**
   * @param {object} opts
   * @param {ReputationLedger} opts.reputationLedger
   * @param {CreditLedger} opts.creditLedger
   * @param {import('../identity.js').Identity} opts.issuerIdentity 签发者的 context-A 子身份
   * @param {number} [opts.minReputation] 签发 Credit 的最低信誉门槛，默认 10
   * @param {object} [opts.log]
   */
  constructor({ reputationLedger, creditLedger, issuerIdentity, minReputation, log }) {
    this.repLedger = reputationLedger
    this.creditLedger = creditLedger
    this.issuer = issuerIdentity
    this.minReputation = typeof minReputation === 'number' && minReputation >= 0
      ? minReputation
      : DEFAULT_FAUCET_MIN_REPUTATION
    this.log = log ?? (() => {})
  }

  /**
   * 签发 Credit：冻结 issuer 等额信誉 + 增加 holder 余额。
   *
   * @param {object} opts
   * @param {string} opts.holderDid 收款人 did
   * @param {number} opts.amount 金额
   * @param {string} [opts.prevNoteCid] 前一笔流水 CID（流水链），首笔为 null
   * @returns {Promise<{ note: CreditNote, cid: string | null }>}
   *          cid 为写入 IPFS 后的 CID（若 helia 未注入则 null）
   */
  async issue({ holderDid, amount, prevNoteCid = null }) {
    if (typeof holderDid !== 'string' || holderDid.length === 0) {
      throw new Error('holderDid 必须是非空字符串')
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error(`amount 必须是正数，实际 ${amount}`)
    }

    const issuerDid = this.issuer.did
    const issuerRep = this.repLedger.getTotal(issuerDid)

    // 1. 门槛校验：issuer 必须是"高信誉节点"
    if (issuerRep < this.minReputation) {
      throw new FaucetNotAuthorizedError({
        issuerDid, total: issuerRep, required: this.minReputation,
      })
    }

    // 2. 冻结等额信誉（available 不足时抛 InsufficientReputationError）
    this.repLedger.freeze(issuerDid, amount)

    // 3. 增加 holder 余额
    this.creditLedger.credit(holderDid, amount)

    // 4. 生成 CreditNote
    const note = {
      type: 'issue',
      issuerDid,
      holderDid,
      amount,
      nonce: crypto.randomUUID(),
      timestamp: Date.now(),
      prevNoteCid,
    }
    const sigBytes = await this.issuer.sign(new TextEncoder().encode(JSON.stringify(note)))
    const signedNote = {
      ...note,
      signature: Buffer.from(sigBytes).toString('base64'),
      signerPublicKey: Buffer.from(this.issuer.publicKey.raw).toString('base64'),
    }

    this.log('info', 'faucet',
      `签发 ${amount} credit 给 ${holderDid.slice(0, 16)}...（issuer=${issuerDid.slice(0, 16)}...，冻结 ${amount} 信誉）`)

    return { note: signedNote, cid: null }
  }

  /**
   * 消费 Credit：扣减 holder 余额 + 释放 issuer 等额冻结信誉。
   *
   * P1 修复：原子性保证。如果第 1 步 debit 成功但第 2 步 release 失败
   * （例如 issuer 的 frozen 不足），必须回滚第 1 步，避免 holder 余额被扣
   * 但 issuer 冻结信誉未释放的账本不一致。
   *
   * @param {object} opts
   * @param {string} opts.holderDid 消费者 did
   * @param {string} opts.issuerDid 签发者 did（用于释放冻结）
   * @param {number} opts.amount 消费金额
   * @returns {{ holderBalance: number, releasedFrozen: number }}
   */
  consume({ holderDid, issuerDid, amount }) {
    if (typeof holderDid !== 'string' || holderDid.length === 0) {
      throw new Error('holderDid 必须是非空字符串')
    }
    if (typeof issuerDid !== 'string' || issuerDid.length === 0) {
      throw new Error('issuerDid 必须是非空字符串')
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error(`amount 必须是正数，实际 ${amount}`)
    }

    // 1. 扣减 holder 余额（不足抛 InsufficientCreditError）
    const holderBalance = this.creditLedger.debit(holderDid, amount)

    // 2. 释放 issuer 等额冻结信誉（不足抛 InsufficientFrozenError）
    //    注：M4 不验证 holderDid 持有的 credit 确实由 issuerDid 签发
    //    （那需要查 IPFS 流水链，deferred 到 M6 仲裁时验证）
    let released
    try {
      released = this.repLedger.release(issuerDid, amount)
    } catch (err) {
      // P1 原子性修复：release 失败 → 回滚 holder 余额
      this.creditLedger.credit(holderDid, amount)
      this.log('error', 'faucet',
        `consume 回滚：释放 issuer 冻结信誉失败（${err.message}），已退还 holder 余额 ${amount}`)
      throw err
    }

    this.log('info', 'faucet',
      `消费 ${amount} credit（holder=${holderDid.slice(0, 16)}...，释放 ${issuerDid.slice(0, 16)}... 的冻结信誉）`)

    return { holderBalance, releasedFrozen: released.frozen }
  }
}

/**
 * Faucet 签发资格不足（issuer 总信誉未达门槛）。
 */
export class FaucetNotAuthorizedError extends Error {
  constructor({ issuerDid, total, required }) {
    super(`Faucet 资格不足：issuer=${issuerDid.slice(0, 16)}... 总信誉 ${total} < 门槛 ${required}`)
    this.name = 'FaucetNotAuthorizedError'
    this.code = 'FAUCET_NOT_AUTHORIZED'
    this.issuerDid = issuerDid
    this.total = total
    this.required = required
  }
}

// ──────────────────────────────────────────────
// 工具：把 CreditNote 写入 IPFS
// ──────────────────────────────────────────────

/**
 * 把 CreditNote 的 JSON 字节写入 IPFS，返回 CID。
 *
 * 与 wiki.js 的 putContentBlock 一致：raw codec + sha256。
 *
 * @param {object} helia
 * @param {CreditNote} note
 * @returns {Promise<string>} CID 字符串
 */
export async function putCreditNoteBlock(helia, note) {
  const bytes = new TextEncoder().encode(JSON.stringify(note))
  const hash = await sha256.digest(bytes)
  const cid = CID.createV1(RAW_CODEC, hash)
  await helia.blockstore.put(cid, bytes)
  return cid.toString()
}

/**
 * 从 IPFS 读取 CreditNote。
 * @param {object} helia
 * @param {string} cidStr
 * @returns {Promise<CreditNote>}
 */
export async function getCreditNoteBlock(helia, cidStr) {
  const cid = CID.parse(cidStr)
  const chunks = []
  for await (const chunk of helia.blockstore.get(cid)) {
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.length
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

// ──────────────────────────────────────────────
// 工具：广播 credit 消息（gossipsub）
// ──────────────────────────────────────────────

/**
 * 把一笔 CreditNote 包装成 credit 消息广播到 /s-network/reputation。
 *
 * @param {object} opts
 * @param {object} opts.pubsub libp2p.services.pubsub
 * @param {CreditNote} opts.note 已签名的 CreditNote
 * @param {import('../identity.js').Identity} [opts.senderIdentity] 可选发送者身份（用于二次签名）
 *        注：M4 简化处理，CreditNote 本身已有 issuer 签名，外层消息用 issuer 同身份签即可
 * @returns {Promise<{ message: object, recipients: number }>}
 */
export async function publishCreditMessage({ pubsub, note, senderIdentity }) {
  if (!senderIdentity) {
    throw new Error('senderIdentity 必填（M4：用 issuer 身份签外层消息）')
  }

  const payload = {
    note,
    timestamp: Date.now(),
  }
  // P0-1 修复：签名覆盖整个 canonical message（含 senderId/type/timestamp/payload）
  const message = await signMessage({
    type: MESSAGE_TYPES.CREDIT,
    senderId: senderIdentity.did,
    payload,
    identity: senderIdentity,
  })

  const bytes = new TextEncoder().encode(JSON.stringify(message))
  const result = await pubsub.publish(CREDIT_TOPIC, bytes)
  return { message, recipients: result.recipients?.length ?? 0 }
}
