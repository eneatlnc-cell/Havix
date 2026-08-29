// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Havix SDK context API（M9.2）
 * ───────────────────────────────────────────────
 * 4-context 子身份访问层。
 *
 * 设计原则（M9 理论修正）：
 *   - getAll() 与 getStatus() 永远返回完整 4-context，让用户感知完整身份模型
 *   - sign() 只允许 Manifest.contexts 列出的 context（防越权）
 *   - verify() 不受限制（任意 context 签的消息都可验签，被动行为）
 *
 * 4 个 context 的语义（与 src/identity.js 一致）：
 *   A = 公开畅游（互联网通行身份，慎用——不与具体业务关联）
 *   B = 市场参与（私域市场内交易）
 *   C = 私聊隧道（点对点加密通信）
 *   D = 维基编辑（写入维基条目，需 vouch 阈值）
 *
 * M9.2 范围：
 *   - 接收 SNode 实例（mock 或真实）
 *   - 通过 snode.wallet 拿到 4 个 Identity
 *   - sign() / verify() 委托 Identity.sign/verify
 *
 * M9.3+ 集成真实 SNode 时无需修改本文件（接口对齐 wallet）。
 */

import { ContextNotEnabledError } from './errors.js'

// context 元信息（与 src/identity.js CONTEXT_META 对齐）
const CONTEXT_META = Object.freeze({
  A: { name: 'public', label: '公开畅游', description: '公共层消息签名、维基读取' },
  B: { name: 'market', label: '市场参与', description: '私域市场内交易、offer 签发' },
  C: { name: 'tunnel',  label: '私聊隧道', description: '点对点加密通信身份' },
  D: { name: 'wiki',    label: '维基编辑', description: '写入维基条目的编辑员身份' },
})

// context → 对应的权限名（identity:context:<X>）
const CONTEXT_PERMISSION = Object.freeze({
  A: 'identity:context:A',
  B: 'identity:context:B',
  C: 'identity:context:C',
  D: 'identity:context:D',
})

/**
 * 创建 context API 实例。
 *
 * @param {object} snode SNode 实例（需有 wallet 字段）
 * @param {import('./manifest.js').AppManifest} manifest App Manifest
 * @returns {object} context API
 */
export function createContextApi(snode, manifest) {
  if (!snode) throw new Error('createContextApi: snode 必填')
  if (!manifest) throw new Error('createContextApi: manifest 必填')
  if (!snode.wallet) throw new Error('createContextApi: snode.wallet 未初始化（节点是否已 start()）')

  const wallet = snode.wallet
  const enabledContexts = Array.isArray(manifest.contexts) ? [...manifest.contexts] : []

  /**
   * 获取本节点的 4-context 子身份（无论 App 是否使用，都全部返回）。
   * 设计原则：让用户感知完整身份模型，即使 App 没用到也"存在"。
   *
   * @returns {{ main: string, A: string, B: string, C: string, D: string }}
   */
  function getAll() {
    return {
      main: wallet.masterPeerId.toString(),
      A: wallet.get('A').did,
      B: wallet.get('B').did,
      C: wallet.get('C').did,
      D: wallet.get('D').did,
    }
  }

  /**
   * 获取本 App 启用的 context 列表（来自 Manifest.contexts）。
   * @returns {string[]} 如 ['B']
   */
  function getEnabled() {
    return [...enabledContexts]
  }

  /**
   * 获取完整状态面板（用于 App 启动时显示）。
   * 每条记录含 did / status / usedByApp / reason。
   *   - status：'active'（App 启用）/ 'loaded'（已派生但未启用）
   *   - usedByApp：true/false
   *   - reason：未启用时的简短说明（来自 CONTEXT_META.description）
   *
   * @returns {Promise<object>} 4-context 完整状态面板
   */
  async function getStatus() {
    const ctxList = ['A', 'B', 'C', 'D']
    const result = {
      main: { did: wallet.masterPeerId.toString(), status: 'active', label: '主身份', description: '节点稳定身份，vouch 锚定对象' },
    }
    for (const ctx of ctxList) {
      const id = wallet.get(ctx)
      const enabled = enabledContexts.includes(ctx)
      result['context' + ctx] = {
        did: id.did,
        status: enabled ? 'active' : 'loaded',
        usedByApp: enabled,
        label: CONTEXT_META[ctx].label,
        description: CONTEXT_META[ctx].description,
      }
    }
    return result
  }

  /**
   * 用指定 context 签名。
   *
   * 校验：
   *   1. context 必须是 'A' / 'B' / 'C' / 'D'
   *   2. context 必须在 Manifest.contexts 中（否则抛 ContextNotEnabledError）
   *
   * 注：M9.2 不强制对应权限（identity:context:X）——
   *   Manifest.contexts 字段本身就是 App 显式声明"我用这个 context"，
   *   与权限是正交的（permissions 用于 SDK 接口门控，contexts 用于 sign 门控）。
   *   这与 M9-DESIGN §5.2 的设计一致。
   *
   * @param {'A'|'B'|'C'|'D'} contextKey
   * @param {Uint8Array} data 待签数据
   * @returns {Promise<{ signature: Uint8Array, signerPublicKey: object }>}
   * @throws {ContextNotEnabledError} 若 context 未在 Manifest.contexts 中
   */
  async function sign(contextKey, data) {
    if (!['A', 'B', 'C', 'D'].includes(contextKey)) {
      throw new Error(`sign: contextKey 必须是 A/B/C/D，实际: ${contextKey}`)
    }
    if (!enabledContexts.includes(contextKey)) {
      throw new ContextNotEnabledError(contextKey, {
        app: manifest.name,
        enabled: enabledContexts,
      })
    }
    if (!(data instanceof Uint8Array)) {
      throw new Error('sign: data 必须是 Uint8Array')
    }
    const id = wallet.get(contextKey)
    const signature = await id.sign(data)
    return { signature, signerPublicKey: id.publicKey }
  }

  /**
   * 验证其他节点签的消息。
   *
   * 注：验签是被动行为——任意 context 签的消息都可验签，不受 App 启用限制。
   *   若 App 只用 context-B，但仍可验签他人用 context-A/D 发的消息。
   *
   * @param {object} publicKey 验签公钥（Ed25519PublicKey 对象，含 .verify(data, sig)）
   * @param {Uint8Array} signature
   * @param {Uint8Array} data
   * @returns {Promise<boolean>}
   */
  async function verify(publicKey, signature, data) {
    if (!publicKey || typeof publicKey.verify !== 'function') {
      throw new Error('verify: publicKey 必须含 verify(data, sig) 方法')
    }
    if (!(signature instanceof Uint8Array)) {
      throw new Error('verify: signature 必须是 Uint8Array')
    }
    if (!(data instanceof Uint8Array)) {
      throw new Error('verify: data 必须是 Uint8Array')
    }
    return publicKey.verify(data, signature)
  }

  return {
    getAll,
    getEnabled,
    getStatus,
    sign,
    verify,
  }
}

export { CONTEXT_META, CONTEXT_PERMISSION }
