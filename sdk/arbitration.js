// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Havix SDK arbitration API（M9.2）
 * ───────────────────────────────────────────────
 * 临时仲裁团访问层，包装 SNode 的 M6 仲裁协议。
 *
 * 3 个权限门控：
 *   arbitration:file    file()
 *   arbitration:vote    vote()
 *   arbitration:resolve resolve()
 *
 * 只读查询（getPanel / getStatus / treasuryBalance / treasuryHistory）无权限门控，
 * 但需要在 App manifest 中包含对应权限 category（arbitration）才能用整套。
 * M9.2 简化：只把 mutation 操作做权限门控，查询操作直接放行（与 M8.2 GET-only 一致）。
 *
 * 设计原则：
 *   - file 用本节点 context-A 子身份作为 claimant（实际由 SNode 内部完成）
 *   - vote 用本节点 context-A 子身份作为 jurorDid
 *   - resolve 多数裁决（≥3/5）
 */

import { checkPermission } from './permissions.js'

/**
 * 创建 arbitration API 实例。
 *
 * @param {object} snode SNode 实例
 * @param {import('./manifest.js').AppManifest} manifest App Manifest
 * @returns {object} arbitration API
 */
export function createArbitrationApi(snode, manifest) {
  if (!snode) throw new Error('createArbitrationApi: snode 必填')
  if (!manifest) throw new Error('createArbitrationApi: manifest 必填')

  const perms = manifest.permissions
  const appName = manifest.name

  // 白皮书 §5.2 允许的 dispute 类型
  const VALID_TYPES = Object.freeze(['offer-breach', 'relay-malice', 'vouch-collusion'])
  // 允许的投票选项
  const VALID_VOTES = Object.freeze(['guilty', 'not-guilty', 'abstain'])

  /**
   * 发起仲裁。
   * @param {object} opts
   * @param {string} opts.respondentDid 被诉方 did
   * @param {string} opts.type 'offer-breach' | 'relay-malice' | 'vouch-collusion'
   * @param {string|object} [opts.evidence] 证据（CID 字符串或对象）
   * @param {number} opts.stake 争议 credit 额（必须 > 0，有限数）
   * @returns {Promise<{ dispute: object, message: object }>}
   */
  async function file({ respondentDid, type, evidence, stake } = {}) {
    checkPermission(perms, 'arbitration:file', { app: appName })
    if (typeof respondentDid !== 'string' || respondentDid.length === 0) {
      throw new Error('arbitration.file: respondentDid 必须是非空字符串')
    }
    if (!VALID_TYPES.includes(type)) {
      throw new Error(`arbitration.file: type 必须是 ${VALID_TYPES.join(' / ')}，实际: ${type}`)
    }
    if (!Number.isFinite(stake) || stake <= 0) {
      throw new Error(`arbitration.file: stake 必须是 > 0 的有限数，实际: ${stake}`)
    }
    // evidence 可以是 CID 字符串或对象（含 attachments 等结构）
    const evidenceArg = typeof evidence === 'string' ? evidence : (evidence ?? null)
    return snode.fileDispute({
      respondent: respondentDid,
      type,
      evidence: evidenceArg,
      amount: stake,
    })
  }

  /**
   * 召集仲裁团。
   * @param {string} disputeId
   * @returns {Promise<{ panel: string[], count: number, excluded: string[] }>}
   */
  async function summonPanel(disputeId) {
    checkPermission(perms, 'arbitration:file', { app: appName })
    if (typeof disputeId !== 'string' || disputeId.length === 0) {
      throw new Error('arbitration.summonPanel: disputeId 必须是非空字符串')
    }
    return snode.summonArbitrationPanel(disputeId)
  }

  /**
   * 仲裁员投票（本节点作为仲裁员）。
   * @param {string} disputeId
   * @param {string} vote 'guilty' | 'not-guilty' | 'abstain'
   * @returns {Promise<{ recorded: boolean, vote: string }>}
   */
  async function vote(disputeId, voteChoice) {
    checkPermission(perms, 'arbitration:vote', { app: appName })
    if (typeof disputeId !== 'string' || disputeId.length === 0) {
      throw new Error('arbitration.vote: disputeId 必须是非空字符串')
    }
    if (!VALID_VOTES.includes(voteChoice)) {
      throw new Error(`arbitration.vote: vote 必须是 ${VALID_VOTES.join(' / ')}，实际: ${voteChoice}`)
    }
    return snode.castArbitrationVote({ disputeId, vote: voteChoice })
  }

  /**
   * 尝试达成裁决并执行 slash。
   * @param {string} disputeId
   * @returns {Promise<object>} { resolved, verdict?, slashExecuted?, slashDetail? }
   */
  async function resolve(disputeId) {
    checkPermission(perms, 'arbitration:resolve', { app: appName })
    if (typeof disputeId !== 'string' || disputeId.length === 0) {
      throw new Error('arbitration.resolve: disputeId 必须是非空字符串')
    }
    return snode.resolveVerdict(disputeId)
  }

  // ── 只读查询（无权限门控，遵循 M8.2 GET-only 精神） ──

  /**
   * 查询金库余额。
   * @returns {number}
   */
  function treasuryBalance() {
    return snode.getTreasuryBalance()
  }

  /**
   * 查询金库存入历史。
   * @param {string} [disputeId] 可选过滤
   * @returns {Array<object>}
   */
  function treasuryHistory(disputeId) {
    if (disputeId !== undefined && (typeof disputeId !== 'string' || disputeId.length === 0)) {
      throw new Error('arbitration.treasuryHistory: disputeId 必须是非空字符串或 undefined')
    }
    return snode.getTreasuryHistory(disputeId)
  }

  /**
   * 检查某 did 是否符合仲裁员资格（只读）。
   * @param {string} did
   * @returns {object}
   */
  function checkJurorEligibility(did) {
    if (typeof did !== 'string' || did.length === 0) {
      throw new Error('arbitration.checkJurorEligibility: did 必须是非空字符串')
    }
    return snode.checkJurorEligibility(did)
  }

  return {
    file,
    summonPanel,
    vote,
    resolve,
    treasuryBalance,
    treasuryHistory,
    checkJurorEligibility,
    // 暴露常量供 App 校验
    VALID_TYPES,
    VALID_VOTES,
  }
}
