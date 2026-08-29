// SPDX-License-Identifier: AGPL-3.0-only

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
  // App 注册的 credit 接收 handler 列表（M9.3 AppManager.dispatchCreditMessage 调用）
  let appHandlers = null

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
    // 同时记录到 App 内部 handlers（M9.3 AppManager.dispatchCreditMessage 用）
    if (!appHandlers) appHandlers = []
    appHandlers.push(callback)
  }

  /**
   * 内部派发：调用所有 onReceived 注册的 handler。
   * 由 AppManager.dispatchCreditMessage 调用，不直接暴露给 App。
   *
   * @param {object} creditMsg
   * @returns {Promise<void>}
   * @private
   */
  async function _onReceived(creditMsg) {
    if (!appHandlers || appHandlers.length === 0) return
    for (const handler of appHandlers) {
      try {
        await handler(creditMsg, creditMsg?.senderId)
      } catch (err) {
        // 单 handler 失败不阻断其他 handler
        // （错误由 AppManager 上层 log）
        throw err
      }
    }
  }

  /**
   * 清理本 App 注册的 credit handler（P1-7 修复：只清理自己的）。
   * 由 app.stop() 调用。
   * 原实现直接 snode._creditHandlers.length = 0，会清掉其他 App 的 handler。
   * @returns {void}
   * @private
   */
  function _dispose() {
    if (appHandlers && snode._creditHandlers) {
      for (const h of appHandlers) {
        const idx = snode._creditHandlers.indexOf(h)
        if (idx >= 0) snode._creditHandlers.splice(idx, 1)
      }
    }
    appHandlers = null
  }

  return {
    issue,
    consume,
    transfer,
    balance,
    onReceived,
    // M9.3 内部 API（不直接暴露给 App，AppManager 用）
    _onReceived,
    _dispose,
  }
}
