/**
 * 临时仲裁团 + Slash 模块（M6）
 * ───────────────────────────────────────────────
 * 设计目标（白皮书 §5）：
 *   Havix 的治理不是"民主投票"（多数暴政），不是"中心执法"（S 国模型），
 *   是"高信誉者的临时召集制"——商会、行会、自治公社的真实治理形态。
 *
 * 触发条件（白皮书 §5.1，三种可发起 arbitration）：
 *   1. Offer 违约：付了 credit 但没拿到服务（offer-breach）
 *   2. Relay 作恶：relay 节点泄露电路或篡改流量（relay-malice）
 *   3. Vouch 舞弊：相互刷 vouch 抬高信誉（vouch-collusion）
 *
 * 仲裁团组成（白皮书 §5.1）：
 *   - 5 个节点，从"信誉 > 网络中位数 ×1.5 且 vouch 数 ≥ 10"的池里随机抽取
 *   - 排除纠纷双方的任何 vouch 关联节点（防串谋）
 *   - 先响应的 5 个正式入团，其余作为候补
 *   - 24 小时未达成裁决则重抽
 *
 * 裁决执行（白皮书 §5.2）：
 *   - 每个仲裁员投 guilty / not-guilty / abstain
 *   - 多数意见（≥3 票一致）为裁决
 *   - 裁决通过 /s-network/alert 公开广播
 *
 * Slash 机制（白皮书 §5.3）：
 *   - 关键设计：只动 frozen 部分，不动 available
 *     如果 slash 能动可用信誉 → 攻击者可以靠仲裁把别人信誉打光 → 治理武器化
 *     只动 frozen → slash 只影响"正在发行的 credit" → 治理成为"经济纠纷解决"而非"政治清洗"
 *   - 50% 赔给受害者
 *   - 50% 进入金库（暂冻结，MVP 阶段只进不出）
 *   - 金库余额在 IPFS 上公开 ledger，所有人可审计
 *
 * M6 MVP 范围：
 *   - ArbitrationRegistry：维护所有 dispute 与仲裁团
 *   - summonPanel：召集仲裁团（信誉阈值 + vouch 阈值 + 排除关联）
 *   - castVote：仲裁员投票（guilty / not-guilty / abstain）
 *   - resolveVerdict：达成多数（≥3 票一致）后执行 slash
 *   - TreasuryLedger：金库账本（M6 暂只进不出）
 *   - ArbitrationMessage：alert topic 广播
 *
 * Deferred 到未来工作（M6 不实现）：
 *   - 24 小时超时重抽（M6 由外部触发，定时器 deferred 到 M8）
 *   - 候补仲裁员自动补位（M6 用固定 5 节点，候补机制 deferred）
 *   - 真实分布式随机数 VRF（M6 用 Math.random，与 M5 epoch 轮换一致）
 *   - 金库支出用途治理（M6 只进不出，未来由社区治理决定）
 *   - IPFS 流水链完整验证（M6 用本地账本视图，跨节点账本一致性靠 gossipsub 消息收敛）
 *   - 跨节点仲裁团选举协议（M6 用本地视图，跨节点同步 deferred 到未来）
 *
 * 安全性质：
 *   1. 关联排除：纠纷双方的 vouch 关联节点不能入团（防串谋）
 *   2. 自举拒绝：发起方与被诉方都不能进入自己的仲裁团
 *   3. 投票幂等：同一仲裁员对同一 dispute 重复投票只记一次
 *   4. Slash 只动 frozen：available 不受影响（防治理武器化）
 *   5. 多数硬性：未达 ≥3 票一致不算裁决（防少数暴政）
 *   6. 双重裁决拒绝：已裁决的 dispute 不能再投票（最终性）
 */

import { MESSAGE_TYPES, makeMessage, signMessage } from './message-types.js'
import { saveJsonAtomic, mapToArray, arrayToMap } from '../persistence.js'

// arbitration 消息走 /s-network/alert（与心跳/维基 announce、vouch/credit reputation 分开）
export const ARBITRATION_TOPIC = '/s-network/alert'

// 仲裁团规模（白皮书 §5.1：5 个节点）
export const DEFAULT_PANEL_SIZE = 5

// 裁决多数阈值（白皮书 §5.2：≥3 票一致）
export const DEFAULT_VERDICT_MAJORITY = 3

// 仲裁员资格：信誉 > 网络中位数 × 1.5（白皮书 §5.1）
export const DEFAULT_REPUTATION_MULTIPLIER = 1.5

// 仲裁员资格：vouch 数 ≥ 10（白皮书 §5.1）
export const DEFAULT_MIN_VOUCH_FOR_JUROR = 10

// Slash 比例：50% 赔受害者 + 50% 进金库（白皮书 §5.3）
export const DEFAULT_SLASH_RATIO = 0.5

// dispute 状态
export const DISPUTE_STATUS = Object.freeze({
  PENDING: 'pending',       // 等待召集仲裁团
  PANEL_FORMED: 'panel-formed', // 仲裁团已召集，等待投票
  VOTING: 'voting',         // 投票中
  RESOLVED: 'resolved',     // 已裁决
  EXPIRED: 'expired',       // 超时未达成裁决（M6 由外部触发）
})

// 投票选项
export const VERDICT_VOTE = Object.freeze({
  GUILTY: 'guilty',
  NOT_GUILTY: 'not-guilty',
  ABSTAIN: 'abstain',
})

// 错误类
export class DisputeNotFoundError extends Error {
  constructor({ disputeId }) {
    super(`dispute ${disputeId} 不存在`)
    this.name = 'DisputeNotFoundError'
    this.code = 'DISPUTE_NOT_FOUND'
    this.disputeId = disputeId
  }
}

export class JurorNotAuthorizedError extends Error {
  constructor({ disputeId, jurorDid, reason }) {
    super(`仲裁员 ${jurorDid} 无权投票 dispute ${disputeId}：${reason}`)
    this.name = 'JurorNotAuthorizedError'
    this.code = 'JUROR_NOT_AUTHORIZED'
    this.disputeId = disputeId
    this.jurorDid = jurorDid
    this.reason = reason
  }
}

export class DisputeAlreadyResolvedError extends Error {
  constructor({ disputeId }) {
    super(`dispute ${disputeId} 已裁决，不能再投票`)
    this.name = 'DisputeAlreadyResolvedError'
    this.code = 'DISPUTE_ALREADY_RESOLVED'
    this.disputeId = disputeId
  }
}

export class DisputeNotInVotingStateError extends Error {
  constructor({ disputeId, status, expected }) {
    super(
      `dispute ${disputeId} 状态 ${status} 不允许投票，预期 ${expected.join(' / ')}（P1-2 修复）`,
    )
    this.name = 'DisputeNotInVotingStateError'
    this.code = 'DISPUTE_NOT_IN_VOTING_STATE'
    this.disputeId = disputeId
    this.status = status
    this.expected = expected
  }
}

// ──────────────────────────────────────────────
// TreasuryLedger：金库账本（M6 暂只进不出）
// ──────────────────────────────────────────────

/**
 * 金库账本。
 *
 * 白皮书 §5.3：金库余额在 IPFS 上公开 ledger，所有人可审计。
 * M6 MVP：内存账本，不写 IPFS（deferred）；只进不出（未来由社区治理决定）。
 * M8.1 持久化：构造时传 `persistPath` 即开启落盘（同步原子写）。
 *
 * 对外提供：
 *   - deposit(did, amount, reason)   存入（slash 的 50%）
 *   - getBalance()                    总余额
 *   - getHistory()                    存入历史（审计用）
 */
export class TreasuryLedger {
  /**
   * @param {object} [opts]
   * @param {object} [opts.log] 可选日志函数
   * @param {string} [opts.persistPath] 可选持久化文件路径（M8.1）
   */
  constructor({ log, persistPath } = {}) {
    this.log = log ?? (() => {})
    this.persistPath = persistPath ?? null
    /** @type {number} 总余额 */
    this.balance = 0
    /** @type {Array<{from: string, amount: number, reason: string, disputeId?: string, at: number}>} */
    this.history = []
  }

  /**
   * 序列化为 JSON 可保存的对象。
   * @returns {{ version: string, balance: number, history: Array<object> }}
   */
  toJSON() {
    return {
      version: 'treasury-v1',
      balance: this.balance,
      history: this.history,
    }
  }

  /**
   * 从 loadJson 加载的对象恢复状态（覆盖式恢复）。
   * @param {object} json
   */
  loadState(json) {
    if (!json || typeof json !== 'object') return
    if (typeof json.balance === 'number' && Number.isFinite(json.balance)) {
      this.balance = json.balance
    }
    if (Array.isArray(json.history)) {
      this.history = json.history.filter((h) => h
        && typeof h.from === 'string'
        && typeof h.amount === 'number'
        && typeof h.reason === 'string'
        && typeof h.at === 'number')
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
   * 存入金库。
   * @param {object} opts
   * @param {string} opts.from       来源 did
   * @param {number} opts.amount     金额
   * @param {string} opts.reason     存入原因（如 "slash from dispute xxx"）
   * @param {string} [opts.disputeId] 关联 dispute
   * @returns {{ balance: number, entry: object }}
   */
  deposit({ from, amount, reason, disputeId }) {
    // P1 修复：增加 Number.isFinite 校验，防 NaN / Infinity
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error('amount 必须是正数')
    }
    const entry = {
      from,
      amount,
      reason,
      disputeId,
      at: Date.now(),
    }
    this.history.push(entry)
    this.balance += amount
    this._persist()
    this.log('info', 'treasury', `金库 +${amount}（来自 ${from.slice(0, 16)}...，余额 ${this.balance}）`)
    return { balance: this.balance, entry }
  }

  /**
   * 取总余额。
   * @returns {number}
   */
  getBalance() {
    return this.balance
  }

  /**
   * 取存入历史。
   * @param {string} [disputeId] 可选过滤
   * @returns {Array<object>}
   */
  getHistory(disputeId) {
    if (disputeId) return this.history.filter((h) => h.disputeId === disputeId)
    return [...this.history]
  }
}

// ──────────────────────────────────────────────
// ArbitrationRegistry：仲裁注册表
// ──────────────────────────────────────────────

/**
 * 临时仲裁团注册表。
 *
 * 维护 `disputeId → Dispute` 索引。
 *
 * 对外提供：
 *   - fileDispute({claimant, respondent, type, evidence, amount})  发起仲裁
 *   - summonPanel(disputeId, rng?)                                  召集仲裁团
 *   - castVote({disputeId, jurorDid, vote})                          仲裁员投票
 *   - resolveVerdict(disputeId)                                     达成多数后执行 slash
 *   - getDispute(disputeId) / listDisputes()                         查询
 *   - isJurorEligible(jurorDid, disputeId)                           仲裁员资格检查
 *
 * M8.1 持久化：构造时传 `persistPath` 即开启落盘（同步原子写）。
 *   - disputes + jurorPool 一并持久化
 *   - Dispute.votes (Map) 序列化为 [jurorDid, vote][]
 *   - 启动时由 SNode 调用 loadState(readJson(path)) 恢复
 */
export class ArbitrationRegistry {
  /**
   * @param {object} opts
   * @param {object} opts.reputationLedger      M4 信誉账本（必需，用于查询信誉与执行 slash）
   * @param {object} opts.vouchRegistry         M3.2 vouch 注册表（必需，用于查询 vouch 与排除关联）
   * @param {object} [opts.treasury]             M6 金库账本（不传则内部创建）
   * @param {number} [opts.panelSize]           仲裁团规模，默认 5
   * @param {number} [opts.verdictMajority]     裁决多数阈值，默认 3
   * @param {number} [opts.reputationMultiplier] 仲裁员信誉门槛倍数，默认 1.5
   * @param {number} [opts.minVouchForJuror]    仲裁员最少 vouch 数，默认 10
   * @param {number} [opts.slashRatio]          Slash 比例，默认 0.5（50% 赔受害者 + 50% 进金库）
   * @param {object} [opts.log]                  可选日志函数
   * @param {string} [opts.persistPath]          可选持久化文件路径（M8.1）
   */
  constructor({
    reputationLedger,
    vouchRegistry,
    treasury,
    panelSize,
    verdictMajority,
    reputationMultiplier,
    minVouchForJuror,
    slashRatio,
    log,
    persistPath,
  }) {
    if (!reputationLedger) throw new Error('reputationLedger 必需')
    if (!vouchRegistry) throw new Error('vouchRegistry 必需')

    this.reputationLedger = reputationLedger
    this.vouchRegistry = vouchRegistry
    this.treasury = treasury ?? new TreasuryLedger({ log })
    this.panelSize = typeof panelSize === 'number' && panelSize > 0 ? panelSize : DEFAULT_PANEL_SIZE
    this.verdictMajority = typeof verdictMajority === 'number' && verdictMajority > 0
      ? verdictMajority : DEFAULT_VERDICT_MAJORITY
    // 允许 reputationMultiplier=0（关闭中位数门槛，仅靠 vouch 阈值过滤）
    this.reputationMultiplier = typeof reputationMultiplier === 'number' && reputationMultiplier >= 0
      ? reputationMultiplier : DEFAULT_REPUTATION_MULTIPLIER
    this.minVouchForJuror = typeof minVouchForJuror === 'number' && minVouchForJuror >= 0
      ? minVouchForJuror : DEFAULT_MIN_VOUCH_FOR_JUROR
    this.slashRatio = typeof slashRatio === 'number' && slashRatio >= 0 && slashRatio <= 1
      ? slashRatio : DEFAULT_SLASH_RATIO
    this.log = log ?? (() => {})
    this.persistPath = persistPath ?? null

    /** @type {Map<string, Dispute>} */
    this.disputes = new Map()
    this._maxDisputes = 100_000
    /** @type {Map<string, {did: string, reputation: number, vouchCount: number}>} 候选仲裁员池 */
    this.jurorPool = new Map()
  }

  /**
   * 序列化为 JSON 可保存的对象。
   * Dispute 内部 votes: Map → [jurorDid, vote][]。
   * @returns {{ version: string, disputes: Array, jurorPool: [string, object][] }}
   */
  toJSON() {
    const disputesArr = Array.from(this.disputes.entries()).map(([id, d]) => [
      id,
      {
        disputeId: d.disputeId,
        claimant: d.claimant,
        respondent: d.respondent,
        type: d.type,
        evidence: d.evidence,
        amount: d.amount,
        slashRatio: d.slashRatio,
        panel: d.panel,
        votes: Array.from(d.votes.entries()),
        verdict: d.verdict,
        status: d.status,
        filedAt: d.filedAt,
        panelFormedAt: d.panelFormedAt,
        verdictAt: d.verdictAt,
      },
    ])
    return {
      version: 'arbitration-v1',
      disputes: disputesArr,
      jurorPool: mapToArray(this.jurorPool),
    }
  }

  /**
   * 从 loadJson 加载的对象恢复状态（合并到现有 disputes / jurorPool）。
   * @param {object} json
   */
  loadState(json) {
    if (!json || typeof json !== 'object') return
    // 恢复 disputes
    const disputesArr = Array.isArray(json.disputes) ? json.disputes : []
    for (const [id, d] of disputesArr) {
      if (typeof id !== 'string' || !d || typeof d.disputeId !== 'string') continue
      const dispute = new Dispute({
        disputeId: d.disputeId,
        claimant: d.claimant,
        respondent: d.respondent,
        type: d.type,
        evidence: d.evidence,
        amount: d.amount,
        slashRatio: d.slashRatio,
      })
      dispute.panel = Array.isArray(d.panel) ? d.panel : []
      dispute.votes = arrayToMap(d.votes)
      dispute.verdict = d.verdict ?? null
      dispute.status = d.status ?? DISPUTE_STATUS.PENDING
      dispute.filedAt = typeof d.filedAt === 'number' ? d.filedAt : Date.now()
      dispute.panelFormedAt = typeof d.panelFormedAt === 'number' ? d.panelFormedAt : 0
      dispute.verdictAt = typeof d.verdictAt === 'number' ? d.verdictAt : 0
      this.disputes.set(id, dispute)
    }
    // 恢复 jurorPool
    const poolArr = Array.isArray(json.jurorPool) ? json.jurorPool : []
    for (const [did, info] of poolArr) {
      if (typeof did === 'string' && info && typeof info.did === 'string') {
        this.jurorPool.set(did, {
          did: info.did,
          reputation: typeof info.reputation === 'number' ? info.reputation : 0,
          vouchCount: typeof info.vouchCount === 'number' ? info.vouchCount : 0,
        })
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
   * 注册一个候选仲裁员。
   * @param {string} did
   * @returns {{ registered: boolean, eligible: boolean, reason?: string }}
   */
  registerJurorCandidate(did) {
    if (typeof did !== 'string' || did.length === 0) {
      return { registered: false, eligible: false, reason: 'did 无效' }
    }
    const reputation = this.reputationLedger.getAvailable(did)
    const vouchCount = this.vouchRegistry.getVouchCount(did)
    this.jurorPool.set(did, { did, reputation, vouchCount })
    this._persist()
    this.log('debug', 'arbitration',
      `注册候选仲裁员 ${did.slice(0, 16)}... (rep=${reputation}, vouch=${vouchCount})`)
    return { registered: true, eligible: this._isJurorEligibleByStats(reputation, vouchCount) }
  }

  /**
   * 按当前池子计算信誉中位数。
   * @returns {number}
   */
  _computeMedianReputation() {
    const reputations = Array.from(this.jurorPool.values())
      .map((j) => j.reputation)
      .filter((r) => r > 0)
      .sort((a, b) => a - b)
    if (reputations.length === 0) return 0
    const mid = Math.floor(reputations.length / 2)
    return reputations.length % 2 === 0
      ? (reputations[mid - 1] + reputations[mid]) / 2
      : reputations[mid]
  }

  /**
   * 判断候选仲裁员是否符合门槛（信誉 > 中位数 × 1.5 且 vouch ≥ 10）。
   * @param {number} reputation
   * @param {number} vouchCount
   * @param {number} [medianRep] 可选手动指定中位数（避免重复计算）
   * @returns {boolean}
   */
  _isJurorEligibleByStats(reputation, vouchCount, medianRep) {
    const median = typeof medianRep === 'number' ? medianRep : this._computeMedianReputation()
    const threshold = median * this.reputationMultiplier
    return reputation > threshold && vouchCount >= this.minVouchForJuror
  }

  /**
   * 判断某 did 是否符合仲裁员资格（公开接口）。
   * @param {string} did
   * @returns {{ eligible: boolean, reputation: number, vouchCount: number, threshold: number, reason?: string }}
   */
  isJurorEligible(did) {
    const candidate = this.jurorPool.get(did)
    if (!candidate) {
      return { eligible: false, reputation: 0, vouchCount: 0, threshold: 0, reason: '未注册为候选' }
    }
    const median = this._computeMedianReputation()
    const threshold = median * this.reputationMultiplier
    const eligible = this._isJurorEligibleByStats(candidate.reputation, candidate.vouchCount, median)
    return {
      eligible,
      reputation: candidate.reputation,
      vouchCount: candidate.vouchCount,
      threshold,
      reason: eligible ? undefined : `信誉 ${candidate.reputation} ≤ 阈值 ${threshold} 或 vouch ${candidate.vouchCount} < ${this.minVouchForJuror}`,
    }
  }

  /**
   * 发起一个 dispute。
   *
   * @param {object} opts
   * @param {string} opts.claimant     发起方 did
   * @param {string} opts.respondent   被诉方 did
   * @param {string} opts.type         'offer-breach' | 'relay-malice' | 'vouch-collusion'
   * @param {string} [opts.evidence]   证据 IPFS CID
   * @param {number} [opts.amount]     索赔金额（slash 多少信誉）
   * @param {string} [opts.disputeId]  可选自定义 disputeId
   * @returns {{ dispute: Dispute }}
   */
  fileDispute({ claimant, respondent, type, evidence, amount, disputeId }) {
    if (typeof claimant !== 'string' || claimant.length === 0) {
      throw new Error('claimant 必须是非空字符串')
    }
    if (typeof respondent !== 'string' || respondent.length === 0) {
      throw new Error('respondent 必须是非空字符串')
    }
    if (claimant === respondent) {
      throw new Error('claimant 与 respondent 不能相同')
    }
    const validTypes = ['offer-breach', 'relay-malice', 'vouch-collusion']
    if (!validTypes.includes(type)) {
      throw new Error(`type 必须是 ${validTypes.join(' / ')} 之一`)
    }
    // P1 修复：增加 Number.isFinite 校验，防 NaN / Infinity
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error('amount 必须是正数')
    }

    const id = disputeId ?? `dispute-${crypto.randomUUID().slice(0, 8)}`
    if (this.disputes.has(id)) {
      throw new Error(`dispute ${id} 已存在`)
    }

    const dispute = new Dispute({
      disputeId: id,
      claimant,
      respondent,
      type,
      evidence,
      amount,
      slashRatio: this.slashRatio,
    })
    this.disputes.set(id, dispute)
    // P1 修复：disputes Map 加 LRU 上限
    if (this.disputes.size > this._maxDisputes) {
      const first = this.disputes.keys().next().value
      this.disputes.delete(first)
    }
    this._persist()
    this.log('info', 'arbitration',
      `发起 dispute ${id}（${claimant.slice(0, 12)}... → ${respondent.slice(0, 12)}...，type=${type}，amount=${amount}）`)
    return { dispute }
  }

  /**
   * 召集仲裁团。
   *
   * 算法（白皮书 §5.1）：
   *   1. 计算候选池的信誉中位数
   *   2. 筛出符合门槛的候选（信誉 > 中位数 × 1.5 且 vouch ≥ 10）
   *   3. 排除纠纷双方的 vouch 关联节点（防串谋）
   *   4. 排除 claimant / respondent 自身（自举拒绝）
   *   5. 随机抽取 panelSize 个
   *
   * @param {string} disputeId
   * @param {function(): number} [rng] 随机数生成器，默认 Math.random
   * @returns {{ panel: string[], count: number, excluded: string[] }}
   */
  summonPanel(disputeId, rng = Math.random) {
    const dispute = this.disputes.get(disputeId)
    if (!dispute) throw new DisputeNotFoundError({ disputeId })
    if (dispute.status !== DISPUTE_STATUS.PENDING) {
      throw new Error(`dispute ${disputeId} 状态 ${dispute.status}，不能召集仲裁团`)
    }

    const median = this._computeMedianReputation()
    const eligible = []
    const excluded = []
    for (const [did, info] of this.jurorPool) {
      // 排除自举
      if (did === dispute.claimant || did === dispute.respondent) {
        excluded.push(did)
        continue
      }
      // 排除 vouch 关联（防串谋：与纠纷双方有 vouch 关系的不能入团）
      if (this._hasVouchConflict(did, dispute)) {
        excluded.push(did)
        continue
      }
      if (this._isJurorEligibleByStats(info.reputation, info.vouchCount, median)) {
        eligible.push(did)
      }
    }

    // 随机抽取 panelSize 个
    const shuffled = this._shuffle(eligible, rng)
    const panel = shuffled.slice(0, this.panelSize)
    dispute.panel = panel
    dispute.status = DISPUTE_STATUS.PANEL_FORMED
    dispute.panelFormedAt = Date.now()
    this._persist()

    this.log('info', 'arbitration',
      `dispute ${disputeId} 召集仲裁团：${panel.length} 个（合格 ${eligible.length}，排除 ${excluded.length}）`)
    return { panel, count: panel.length, excluded }
  }

  /**
   * 检查 did 与纠纷双方是否有 vouch 关联（防串谋）。
   *
   * 防串谋规则：
   *   - 如果 did 曾 vouch 过 claimant 或 respondent → 不能入团
   *   - 如果 claimant 或 respondent 曾 vouch 过 did → 不能入团
   *
   * @param {string} did
   * @param {Dispute} dispute
   * @returns {boolean} true 表示有冲突
   */
  _hasVouchConflict(did, dispute) {
    // did 是否曾 vouch 过纠纷双方
    const didVouchesClaimant = this.vouchRegistry.getVouchers(dispute.claimant).includes(did)
    const didVouchesRespondent = this.vouchRegistry.getVouchers(dispute.respondent).includes(did)
    if (didVouchesClaimant || didVouchesRespondent) return true

    // 纠纷双方是否曾 vouch 过 did
    const didsVouchers = this.vouchRegistry.getVouchers(did)
    if (didsVouchers.includes(dispute.claimant)) return true
    if (didsVouchers.includes(dispute.respondent)) return true

    return false
  }

  /**
   * Fisher-Yates 洗牌。
   * @param {Array} arr
   * @param {function(): number} rng
   * @returns {Array}
   */
  _shuffle(arr, rng) {
    const a = [...arr]
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }

  /**
   * 仲裁员投票。
   *
   * @param {object} opts
   * @param {string} opts.disputeId
   * @param {string} opts.jurorDid
   * @param {string} opts.vote      'guilty' | 'not-guilty' | 'abstain'
   * @returns {{ recorded: boolean, vote: string, reason?: string }}
   */
  castVote({ disputeId, jurorDid, vote }) {
    const dispute = this.disputes.get(disputeId)
    if (!dispute) throw new DisputeNotFoundError({ disputeId })

    if (dispute.status === DISPUTE_STATUS.RESOLVED) {
      throw new DisputeAlreadyResolvedError({ disputeId })
    }

    // P1-2 修复：castVote 入口状态校验
    //   只允许 PANEL_FORMED / VOTING 状态投票；PENDING（仲裁团未召集）与
    //   EXPIRED（超时未达成裁决）状态拒绝投票，保护状态机一致性。
    if (dispute.status !== DISPUTE_STATUS.PANEL_FORMED
        && dispute.status !== DISPUTE_STATUS.VOTING) {
      throw new DisputeNotInVotingStateError({
        disputeId,
        status: dispute.status,
        expected: [DISPUTE_STATUS.PANEL_FORMED, DISPUTE_STATUS.VOTING],
      })
    }

    const validVotes = [VERDICT_VOTE.GUILTY, VERDICT_VOTE.NOT_GUILTY, VERDICT_VOTE.ABSTAIN]
    if (!validVotes.includes(vote)) {
      return { recorded: false, vote, reason: `vote 必须是 ${validVotes.join(' / ')} 之一` }
    }

    if (!dispute.panel.includes(jurorDid)) {
      throw new JurorNotAuthorizedError({
        disputeId, jurorDid, reason: '不在仲裁团中',
      })
    }

    // 幂等：同一仲裁员重复投票只记一次（覆盖最新）
    if (dispute.votes.has(jurorDid)) {
      this.log('warn', 'arbitration',
        `dispute ${disputeId} 仲裁员 ${jurorDid.slice(0, 16)}... 重复投票（覆盖为 ${vote}）`)
    }
    dispute.votes.set(jurorDid, vote)
    dispute.status = DISPUTE_STATUS.VOTING
    this._persist()

    this.log('info', 'arbitration',
      `dispute ${disputeId} 仲裁员 ${jurorDid.slice(0, 16)}... 投票 ${vote}（共 ${dispute.votes.size}/${this.panelSize}）`)
    return { recorded: true, vote }
  }

  /**
   * 尝试达成裁决并执行 slash。
   *
   * 规则（白皮书 §5.2 + §5.3）：
   *   - 统计 guilty / not-guilty / abstain 票数
   *   - 若 guilty 或 not-guilty 票数 ≥ verdictMajority（默认 3）→ 裁决成立
   *   - abstain 不计入多数判定
   *   - guilty → 执行 slash：从 respondent 的 frozen 信誉扣除 amount
   *     - 50% 赔给 claimant（credit 到 claimant 余额）
   *     - 50% 进金库
   *   - not-guilty → 不执行 slash，dispute 标记 RESOLVED
   *   - 未达多数 → 不裁决，等待更多投票
   *
   * @param {string} disputeId
   * @returns {{ resolved: boolean, verdict?: string, slashExecuted?: boolean, slashDetail?: object, reason?: string }}
   */
  resolveVerdict(disputeId) {
    const dispute = this.disputes.get(disputeId)
    if (!dispute) throw new DisputeNotFoundError({ disputeId })
    if (dispute.status === DISPUTE_STATUS.RESOLVED) {
      throw new DisputeAlreadyResolvedError({ disputeId })
    }

    const counts = { guilty: 0, 'not-guilty': 0, abstain: 0 }
    for (const vote of dispute.votes.values()) {
      counts[vote] += 1
    }

    let verdict = null
    if (counts.guilty >= this.verdictMajority) {
      verdict = VERDICT_VOTE.GUILTY
    } else if (counts['not-guilty'] >= this.verdictMajority) {
      verdict = VERDICT_VOTE.NOT_GUILTY
    }

    if (!verdict) {
      return {
        resolved: false,
        reason: `票数不足多数（guilty=${counts.guilty}，not-guilty=${counts['not-guilty']}，abstain=${counts.abstain}，需 ≥${this.verdictMajority}）`,
      }
    }

    // 裁决成立
    dispute.verdict = verdict
    dispute.verdictAt = Date.now()
    dispute.status = DISPUTE_STATUS.RESOLVED

    let slashExecuted = false
    let slashDetail = null
    if (verdict === VERDICT_VOTE.GUILTY) {
      slashDetail = this._executeSlash(dispute)
      slashExecuted = true
    }
    this._persist()

    this.log('info', 'arbitration',
      `dispute ${disputeId} 裁决：${verdict}（guilty=${counts.guilty}，not-guilty=${counts['not-guilty']}，abstain=${counts.abstain}）${slashExecuted ? 'slash 已执行' : ''}`)

    return {
      resolved: true,
      verdict,
      slashExecuted,
      slashDetail,
    }
  }

  /**
   * 执行 slash（白皮书 §5.3）。
   *
   * 关键设计：只动 frozen 部分，不动 available（防治理武器化）。
   *
   * Slash 分配：
   *   - slash 金额 = dispute.amount（从 respondent frozen 扣除）
   *   - 50% 赔给 claimant（credit 到 claimant 的 credit balance）
   *   - 50% 进金库（treasury.deposit）
   *
   * 注：M6 用 ReputationLedger.slash 扣除 frozen；
   *     赔偿部分用 CreditLedger.credit 给 claimant（M4 已有 API）。
   *
   * @param {Dispute} dispute
   * @returns {{ slashAmount: number, victimCompensation: number, treasuryDeposit: number, frozenBefore: number, frozenAfter: number }}
   */
  _executeSlash(dispute) {
    const slashAmount = dispute.amount

    // 查 respondent frozen 状态
    const repInfo = this.reputationLedger.get(dispute.respondent)
    const frozenBefore = repInfo?.frozen ?? 0

    // 如果 frozen 不足，只能扣到 0（不抛错，按实际可扣额）
    const actualSlash = Math.min(slashAmount, frozenBefore)
    if (actualSlash < slashAmount) {
      this.log('warn', 'arbitration',
        `dispute ${dispute.disputeId} respondent frozen 不足（${frozenBefore} < ${slashAmount}），实际 slash ${actualSlash}`)
    }

    // P0-6 修复：actualSlash = 0 时跳过 slash 操作
    // ReputationLedger.slash 在 amount <= 0 时抛错，frozen=0 的 respondent 不需要扣
    if (actualSlash > 0) {
      // 执行 slash（只动 frozen）
      this.reputationLedger.slash(dispute.respondent, actualSlash)

      // 赔偿与金库（按实际 slash 比例分配）
      const actualVictimCompensation = actualSlash * this.slashRatio
      const actualTreasuryDeposit = actualSlash * (1 - this.slashRatio)

      // 赔偿进 claimant 信誉（用 credit 增加可用信誉）
      if (actualVictimCompensation > 0) {
        this.reputationLedger.credit(dispute.claimant, actualVictimCompensation)
      }

      // 金库存款
      if (actualTreasuryDeposit > 0) {
        this.treasury.deposit({
          from: dispute.respondent,
          amount: actualTreasuryDeposit,
          reason: `slash from dispute ${dispute.disputeId}`,
          disputeId: dispute.disputeId,
        })
      }
    } else {
      this.log('warn', 'arbitration',
        `dispute ${dispute.disputeId} respondent frozen=0，跳过 slash 与赔偿（仅记录裁决）`)
    }

    const repInfoAfter = this.reputationLedger.get(dispute.respondent)
    const frozenAfter = repInfoAfter?.frozen ?? 0

    return {
      slashAmount: actualSlash,
      victimCompensation: actualSlash > 0 ? actualSlash * this.slashRatio : 0,
      treasuryDeposit: actualSlash > 0 ? actualSlash * (1 - this.slashRatio) : 0,
      frozenBefore,
      frozenAfter,
    }
  }

  /**
   * 取 dispute。
   * @param {string} disputeId
   * @returns {Dispute | undefined}
   */
  getDispute(disputeId) {
    return this.disputes.get(disputeId)
  }

  /**
   * 列出所有 dispute ID。
   * @returns {string[]}
   */
  listDisputes() {
    return Array.from(this.disputes.keys())
  }

  /**
   * 取 dispute 投票统计。
   * @param {string} disputeId
   * @returns {{ guilty: number, 'not-guilty': number, abstain: number, total: number, status: string, verdict?: string }}
   */
  getVoteStats(disputeId) {
    const dispute = this.disputes.get(disputeId)
    if (!dispute) throw new DisputeNotFoundError({ disputeId })
    const counts = { guilty: 0, 'not-guilty': 0, abstain: 0 }
    for (const vote of dispute.votes.values()) {
      counts[vote] += 1
    }
    return {
      ...counts,
      total: dispute.votes.size,
      status: dispute.status,
      verdict: dispute.verdict,
    }
  }
}

// ──────────────────────────────────────────────
// Dispute 类
// ──────────────────────────────────────────────

/**
 * 单个 dispute。
 *
 * 状态机：PENDING → PANEL_FORMED → VOTING → RESOLVED
 *                            └→ EXPIRED（M6 由外部触发）
 */
export class Dispute {
  /**
   * @param {object} opts
   * @param {string} opts.disputeId
   * @param {string} opts.claimant
   * @param {string} opts.respondent
   * @param {string} opts.type
   * @param {string} [opts.evidence]
   * @param {number} opts.amount
   * @param {number} opts.slashRatio
   */
  constructor({ disputeId, claimant, respondent, type, evidence, amount, slashRatio }) {
    this.disputeId = disputeId
    this.claimant = claimant
    this.respondent = respondent
    this.type = type
    this.evidence = evidence ?? null
    this.amount = amount
    this.slashRatio = slashRatio

    /** @type {string[]} 仲裁团 did 列表 */
    this.panel = []
    /** @type {Map<string, string>} jurorDid → vote */
    this.votes = new Map()
    /** @type {string|null} 裁决结果 */
    this.verdict = null

    this.status = DISPUTE_STATUS.PENDING
    this.filedAt = Date.now()
    this.panelFormedAt = 0
    this.verdictAt = 0
  }

  /**
   * 取投票快照（数组形式，便于序列化）。
   * @returns {Array<{jurorDid: string, vote: string}>}
   */
  getVotes() {
    return Array.from(this.votes.entries()).map(([jurorDid, vote]) => ({ jurorDid, vote }))
  }
}

// ──────────────────────────────────────────────
// publishArbitration：广播 arbitration 消息
// ──────────────────────────────────────────────

/**
 * 构造并广播 arbitration 消息到 /s-network/alert。
 *
 * 发起方用 context-A 子身份签名（与 vouch/credit 同 context，便于聚合信誉事件）。
 *
 * @param {object} opts
 * @param {object} opts.pubsub             libp2p gossipsub
 * @param {object} opts.senderIdentity      发起方 IdentityWallet 的 context-A 子身份
 * @param {object} opts.dispute            Dispute 对象
 * @param {string} [opts.action]           'filed' | 'panel-summoned' | 'vote-cast' | 'verdict'
 * @returns {Promise<{ message: object, recipients: number }>}
 */
export async function publishArbitration({ pubsub, senderIdentity, dispute, action }) {
  if (!pubsub) throw new Error('pubsub 必需')
  if (!senderIdentity) throw new Error('senderIdentity 必需')
  if (!dispute) throw new Error('dispute 必需')

  const payload = {
    disputeId: dispute.disputeId,
    claimant: dispute.claimant,
    respondent: dispute.respondent,
    type: dispute.type,
    evidence: dispute.evidence,
    amount: dispute.amount,
    action: action ?? 'filed',
    status: dispute.status,
    verdict: dispute.verdict,
    timestamp: Date.now(),
  }

  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload))
  // P0-1 修复：签名覆盖整个 canonical message（含 senderId/type/timestamp/payload）
  // 注：原 payloadBytes 仅用于审计对照，实际签名在 signMessage 内部对 canonical 做
  void payloadBytes
  const message = await signMessage({
    type: MESSAGE_TYPES.ARBITRATION,
    senderId: senderIdentity.did,
    payload,
    identity: senderIdentity,
  })

  const bytes = new TextEncoder().encode(JSON.stringify(message))
  const result = await pubsub.publish(ARBITRATION_TOPIC, bytes)
  return { message, recipients: result?.recipients?.length ?? 0 }
}
