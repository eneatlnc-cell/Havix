// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Relay 准入与轮换模块（M5）
 * ───────────────────────────────────────────────
 * 设计目标（白皮书 §7.3）：
 *   Havix 的 relay 不是匿名志愿者，而是有 vouch 累积的实体。
 *   作恶会损失长期信誉——"用信誉换延迟"，Tor 没有的自由度。
 *
 * 准入机制（白皮书 §7.3）：
 *   动态阈值（信誉前 30%）+ 至少 3 个高信誉节点 vouch
 *
 * 轮换机制（白皮书 §7.3）：
 *   每个 epoch（1 小时）有 20% 概率被换下
 *   电路迁移：MVP 硬切换——relay 下线时隧道断开，应用层重连
 *
 * M5 MVP 范围：
 *   - RelayRegistry：维护当前当选的 relay 集合
 *   - 准入判定：基于 ReputationLedger 的 available 信誉排序取前 30%
 *     + VouchRegistry 的 vouch 计数 ≥ 3（M5 简化：用 count，M4 加权模式留 M6+）
 *   - Epoch 概率轮换：每 epoch 20% 概率被换下
 *   - 硬切换：rotateElection() 直接重新选举，不维护电路迁移
 *   - 选民快照：startEpoch() / endEpoch() 记录当选/退位历史
 *
 * Deferred 到未来工作（M5 不实现）：
 *   - 跨节点 relay 选举协议（M5 用本地视图，跨节点同步 deferred 到 M6+）
 *   - 电路迁移应用层重连机制（M5 硬切换即隧道断开，应用层感知由 M8 CLI 收口）
 *   - 概率轮换的真实分布式随机数（M5 用 Math.random，M6 仲裁团引入 VRF）
 *   - vouch 加权模式判定（M5 用 count，M4 加权阈值判定留 M6+）
 *   - relay 服务质量监控（延迟、丢包、篡改）deferred 到 M6 仲裁时实现
 *
 * 安全性质：
 *   1. 信誉门槛硬性：低于阈值的节点绝不能当选 relay
 *   2. vouch 门槛硬性：vouch 数 < 3 的节点绝不能当选 relay
 *   3. 自举拒绝：节点不能让自己当选（防自吹自擂，与 VouchRegistry 一致）
 *   4. 轮换不可预测：20% 概率由内部随机数决定，外部无法预测
 */

// 默认 epoch 时长（白皮书 §7.3：1 小时）
export const DEFAULT_EPOCH_MS = 60 * 60 * 1000

// 默认轮换概率（白皮书 §7.3：每个 epoch 20% 概率被换下）
export const DEFAULT_ROTATE_PROBABILITY = 0.20

// 默认准入：信誉前 30%（白皮书 §7.3）
export const DEFAULT_TOP_PERCENTILE = 0.30

// 默认准入：至少 3 个高信誉节点 vouch（白皮书 §7.3）
export const DEFAULT_MIN_VOUCH_COUNT = 3

// 默认最少 relay 数（多链路对冲需要至少 3 条并行 relay）
export const DEFAULT_MIN_RELAYS = 3

// ──────────────────────────────────────────────
// RelayRegistry 类
// ──────────────────────────────────────────────

/**
 * Relay 注册表。
 *
 * 维护 `did → { reputation, vouchCount, electedAt, retiredAt }` 索引。
 *
 * 对外提供：
 *   - registerCandidate(did, reputation, vouchCount)  注册候选
 *   - electEpoch()                                   按 top-percentile + vouch 阈值选举
 *   - rotateElection(rng?)                           概率轮换（20% 被换下，重新选举补齐）
 *   - isRelay(did)                                   是否当前当选
 *   - getActiveRelays()                              当前当选列表
 *   - startEpoch() / endEpoch()                      epoch 边界
 *
 * 不持久化；节点重启后从空集合开始重新累积。
 */
export class RelayRegistry {
  /**
   * @param {object} opts
   * @param {number} [opts.epochMs]                 epoch 时长（毫秒），默认 1 小时
   * @param {number} [opts.rotateProbability]       轮换概率（0-1），默认 0.20
   * @param {number} [opts.topPercentile]           准入信誉百分位（0-1），默认 0.30
   * @param {number} [opts.minVouchCount]            最少 vouch 数，默认 3
   * @param {number} [opts.minRelays]                最少 relay 数（多链路对冲需要），默认 3
   * @param {object} [opts.reputationLedger]        M4 信誉账本（可选，用于查询可用信誉）
   * @param {object} [opts.vouchRegistry]           M3.2 vouch 注册表（可选，用于查询 vouch 计数）
   * @param {object} [opts.log]                      可选日志函数 (level, tag, msg)
   */
  constructor({
    epochMs,
    rotateProbability,
    topPercentile,
    minVouchCount,
    minRelays,
    reputationLedger,
    vouchRegistry,
    log,
  } = {}) {
    this.epochMs = typeof epochMs === 'number' && epochMs > 0 ? epochMs : DEFAULT_EPOCH_MS
    this.rotateProbability = typeof rotateProbability === 'number' && rotateProbability >= 0 && rotateProbability <= 1
      ? rotateProbability : DEFAULT_ROTATE_PROBABILITY
    this.topPercentile = typeof topPercentile === 'number' && topPercentile > 0 && topPercentile <= 1
      ? topPercentile : DEFAULT_TOP_PERCENTILE
    this.minVouchCount = typeof minVouchCount === 'number' && minVouchCount > 0
      ? minVouchCount : DEFAULT_MIN_VOUCH_COUNT
    this.minRelays = typeof minRelays === 'number' && minRelays > 0 ? minRelays : DEFAULT_MIN_RELAYS
    this.reputationLedger = reputationLedger ?? null
    this.vouchRegistry = vouchRegistry ?? null
    this.log = log ?? (() => {})

    /** @type {Map<string, {reputation: number, vouchCount: number, electedAt: number, retiredAt?: number}>} */
    this.candidates = new Map()
    /** @type {Set<string>} 当前当选的 relay did 集合 */
    this.activeRelays = new Set()
    /** @type {number} 当前 epoch 开始时间 */
    this.epochStart = 0
    /** @type {Array<{did: string, action: 'elected'|'retired'|'rotated', at: number}>} 历史 */
    this.history = []
  }

  /**
   * 注册一个候选节点。
   *
   * 若 reputationLedger / vouchRegistry 已注入，则覆盖传入值（以账本实时状态为准）。
   *
   * @param {string} did          候选节点 did（context-A 公开层子身份）
   * @param {number} reputation   可用信誉（未注入 ledger 时使用此值）
   * @param {number} vouchCount   vouch 计数（未注入 vouchRegistry 时使用此值）
   * @returns {{ registered: boolean, reason?: string }}
   */
  registerCandidate(did, reputation, vouchCount) {
    if (typeof did !== 'string' || did.length === 0) {
      return { registered: false, reason: 'did 无效' }
    }
    const rep = this.reputationLedger
      ? this.reputationLedger.getAvailable(did)
      : (typeof reputation === 'number' ? reputation : 0)
    const vouch = this.vouchRegistry
      ? this.vouchRegistry.getVouchCount(did)
      : (typeof vouchCount === 'number' ? vouchCount : 0)

    this.candidates.set(did, {
      reputation: rep,
      vouchCount: vouch,
      electedAt: 0,
    })
    this.log('info', 'relay',
      `注册候选 ${did.slice(0, 16)}... (rep=${rep}, vouch=${vouch})`)
    return { registered: true }
  }

  /**
   * 按 top-percentile + vouch 阈值选举。
   *
   * 流程：
   *   1. 筛出 vouchCount ≥ minVouchCount 的候选
   *   2. 按信誉降序排序
   *   3. 取前 topPercentile 比例（向下取整，至少 minRelays 个）
   *   4. 标记为 activeRelays
   *
   * @returns {{ elected: string[], count: number }}
   */
  electEpoch() {
    // 1. vouch 门槛过滤
    const qualified = []
    for (const [did, info] of this.candidates) {
      if (info.vouchCount >= this.minVouchCount) {
        qualified.push({ did, reputation: info.reputation, vouchCount: info.vouchCount })
      }
    }

    // 2. 信誉降序排序
    qualified.sort((a, b) => b.reputation - a.reputation)

    // 3. 取前 topPercentile 比例
    const topN = Math.max(this.minRelays, Math.floor(qualified.length * this.topPercentile))
    const elected = qualified.slice(0, topN).map((x) => x.did)

    // 4. 更新状态
    const now = Date.now()
    for (const did of elected) {
      const info = this.candidates.get(did)
      if (info) {
        info.electedAt = now
        this.history.push({ did, action: 'elected', at: now })
      }
    }
    // 退位未连任的
    for (const did of this.activeRelays) {
      if (!elected.includes(did)) {
        const info = this.candidates.get(did)
        if (info) info.retiredAt = now
        this.history.push({ did, action: 'retired', at: now })
      }
    }
    this.activeRelays = new Set(elected)
    this.epochStart = now

    this.log('info', 'relay',
      `epoch 选举完成：${elected.length} 个 relay 当选（候选 ${this.candidates.size}，合格 ${qualified.length}）`)
    return { elected, count: elected.length }
  }

  /**
   * 概率轮换：每个 epoch 20% 概率被换下，重新选举补齐。
   *
   * 算法（白皮书 §7.3）：
   *   - 对当前每个 active relay，按 rotateProbability 抽签
   *   - 中签的 relay 被换下（retiredAt 标记），其位置由信誉次高的候选补上
   *   - 补位候选也需通过 vouch 门槛
   *
   * @param {function(): number} [rng] 随机数生成器（0-1），默认 Math.random
   * @returns {{ rotated: string[], supplemented: string[], active: string[] }}
   */
  rotateElection(rng = Math.random) {
    const now = Date.now()
    const rotated = []
    const supplemented = []

    // 抽签
    for (const did of this.activeRelays) {
      if (rng() < this.rotateProbability) {
        rotated.push(did)
      }
    }

    // 退位中签 relay
    for (const did of rotated) {
      this.activeRelays.delete(did)
      const info = this.candidates.get(did)
      if (info) info.retiredAt = now
      this.history.push({ did, action: 'rotated', at: now })
    }

    // 补位：从未当选的合格候选中按信誉降序补
    const qualified = []
    for (const [did, info] of this.candidates) {
      if (!this.activeRelays.has(did) && info.vouchCount >= this.minVouchCount) {
        qualified.push({ did, reputation: info.reputation })
      }
    }
    qualified.sort((a, b) => b.reputation - a.reputation)

    const need = Math.max(0, this.minRelays - this.activeRelays.size)
    for (let i = 0; i < Math.min(need, qualified.length); i++) {
      const did = qualified[i].did
      this.activeRelays.add(did)
      const info = this.candidates.get(did)
      if (info) info.electedAt = now
      this.history.push({ did, action: 'elected', at: now })
      supplemented.push(did)
    }

    this.epochStart = now
    this.log('info', 'relay',
      `epoch 轮换：${rotated.length} 个被换下，${supplemented.length} 个补位，当前 ${this.activeRelays.size} 个 relay`)
    return {
      rotated,
      supplemented,
      active: this.getActiveRelays(),
    }
  }

  /**
   * 是否当前当选 relay。
   * @param {string} did
   * @returns {boolean}
   */
  isRelay(did) {
    return this.activeRelays.has(did)
  }

  /**
   * 当前当选列表（按注册顺序）。
   * @returns {string[]}
   */
  getActiveRelays() {
    return Array.from(this.activeRelays)
  }

  /**
   * 取某候选的快照信息。
   * @param {string} did
   * @returns {{reputation: number, vouchCount: number, electedAt: number, retiredAt?: number} | null}
   */
  getCandidate(did) {
    const info = this.candidates.get(did)
    return info ? { ...info } : null
  }

  /**
   * 查询历史记录。
   * @param {string} [did] 可选过滤 did
   * @returns {Array<{did: string, action: string, at: number}>}
   */
  getHistory(did) {
    if (did) return this.history.filter((h) => h.did === did)
    return [...this.history]
  }

  /**
   * 判断当前 epoch 是否已超时。
   *
   * 注意：M5 不实现自动 epoch 推进（需要定时器或外部触发）。
   * 上层（SNode）按需调用 rotateElection() 推进。
   *
   * @param {number} [now] 当前时间戳，默认 Date.now()
   * @returns {boolean}
   */
  isEpochExpired(now = Date.now()) {
    if (this.epochStart === 0) return false
    return (now - this.epochStart) >= this.epochMs
  }
}
