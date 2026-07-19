/**
 * Havix SDK credit API（M9.2）
 * ───────────────────────────────────────────────
 * Credit 流水访问层，包装 SNode 的 M4 双轨经济。
 *
 * 4 个权限门控：
 *   credit:issue    issue()
 *   credit:consume  consume()
 *   credit:transfer transfer()
 *   credit:balance  balance() / onReceived()
 *
 * 设计原则：
 *   - issue 需高信誉（实际由 SNode.reputationLedger 在 issueCredit 内部校验）
 *   - consume 需 issuerDid（用于释放对应 issuer 冻结信誉）
 *   - transfer 仅本地账本操作（M4 MVP 不广播）
 *
 * 用法：
 *   const balance = await app.credit.balance(holderDid)
 *   const { note } = await app.credit.issue(holderDid, 100, { prevNoteCid })
 *   await app.credit.consume(holderDid, issuerDid, 10)
 *   await app.credit.transfer(fromDid, toDid, 50)
 */

import { checkPermission } from './permissions.js'

/**
 * 创建 credit API 实例。
 *
 * @param {object} snode SNode 实例
 * @param {import('./manifest.js').AppManifest} manifest App Manifest
 * @returns {object} credit API
 */
export function createCreditApi(snode, manifest) {
  if (!snode) throw new Error('createCreditApi: snode 必填')
  if (!manifest) throw new Error('createCreditApi: manifest 必填')

  const perms = manifest.permissions
  const appName = manifest.name

  /**
   * 签发 credit（需高信誉）。
   * @param {string} holderDid 收款人 did
   * @param {number} amount 金额（必须 > 0，有限数）
   * @param {object} [opts]
   * @param {string} [opts.prevNoteCid] 前一笔流水 CID（流水链）
   * @returns {Promise<{ note: object, recipients: number }>}
   */
  async function issue(holderDid, amount, opts = {}) {
    checkPermission(perms, 'credit:issue', { app: appName })
    if (typeof holderDid !== 'string' || holderDid.length === 0) {
      throw new Error('credit.issue: holderDid 必须是非空字符串')
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`credit.issue: amount 必须是 > 0 的有限数，实际: ${amount}`)
    }
    return snode.issueCredit({ holderDid, amount, prevNoteCid: opts.prevNoteCid ?? null })
  }

  /**
   * 消费 credit（用户付给服务方）。
   * @param {string} holderDid 消费者 did
   * @param {string} issuerDid 签发者 did（用于释放冻结信誉）
   * @param {number} amount 消费金额（必须 > 0，有限数）
   * @returns {Promise<{ holderBalance: number, releasedFrozen: number }>}
   */
  async function consume(holderDid, issuerDid, amount) {
    checkPermission(perms, 'credit:consume', { app: appName })
    if (typeof holderDid !== 'string' || holderDid.length === 0) {
      throw new Error('credit.consume: holderDid 必须是非空字符串')
    }
    if (typeof issuerDid !== 'string' || issuerDid.length === 0) {
      throw new Error('credit.consume: issuerDid 必须是非空字符串')
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`credit.consume: amount 必须是 > 0 的有限数，实际: ${amount}`)
    }
    return snode.consumeCredit({ holderDid, issuerDid, amount })
  }

  /**
   * 转账。
   * @param {string} fromDid 转出方 did
   * @param {string} toDid 转入方 did
   * @param {number} amount 转账金额（必须 > 0，有限数）
   * @returns {Promise<{ fromBalance: number, toBalance: number }>}
   */
  async function transfer(fromDid, toDid, amount) {
    checkPermission(perms, 'credit:transfer', { app: appName })
    if (typeof fromDid !== 'string' || fromDid.length === 0) {
      throw new Error('credit.transfer: fromDid 必须是非空字符串')
    }
    if (typeof toDid !== 'string' || toDid.length === 0) {
      throw new Error('credit.transfer: toDid 必须是非空字符串')
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`credit.transfer: amount 必须是 > 0 的有限数，实际: ${amount}`)
    }
    return snode.transferCredit({ fromDid, toDid, amount })
  }

  /**
   * 查询余额。
   * @param {string} holderDid
   * @returns {number}
   */
  function balance(holderDid) {
    checkPermission(perms, 'credit:balance', { app: appName })
    if (typeof holderDid !== 'string' || holderDid.length === 0) {
      throw new Error('credit.balance: holderDid 必须是非空字符串')
    }
    return snode.creditLedger.getBalance(holderDid)
  }

  /**
   * 注册 credit 接收回调。
   *
   * M9.2 简化实现：在 snode._creditHandlers 上注册回调。
   * 真实 SNode 集成时（M9.3）由 AppManager 在 _handleCreditMessage 中调用此回调。
   *
   * @param {function(object, string)} callback (creditNote, fromDid)
   * @returns {void}
   */
  function onReceived(callback) {
    checkPermission(perms, 'credit:balance', { app: appName })
    if (typeof callback !== 'function') {
      throw new Error('credit.onReceived: callback 必须是函数')
    }
    if (!snode._creditHandlers) snode._creditHandlers = []
    snode._creditHandlers.push(callback)
  }

  return {
    issue,
    consume,
    transfer,
    balance,
    onReceived,
  }
}
