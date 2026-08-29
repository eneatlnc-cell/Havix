// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Havix SDK tunnel API（M9.2）
 * ───────────────────────────────────────────────
 * 私聊隧道访问层，包装 SNode 的 M5 单跳 relay 隧道协议。
 *
 * 3 个权限门控：
 *   tunnel:open   open()
 *   tunnel:send   send()
 *   tunnel:close  close() / breakLink()
 *
 * relay 注册 / 选举是节点级管理操作，M9.2 SDK 不直接暴露（M9.3 AppManager CLI 可加）
 *
 * 设计原则：
 *   - open 返回 tunnel 句柄对象，封装 send / breakLink / close
 *   - send 自动 round-robin 分配到各 relay
 *   - breakLink 触发硬切换语义
 */

import { checkPermission } from './permissions.js'

/**
 * 创建 tunnel API 实例。
 *
 * @param {object} snode SNode 实例
 * @param {import('./manifest.js').AppManifest} manifest App Manifest
 * @returns {object} tunnel API
 */
export function createTunnelApi(snode, manifest) {
  if (!snode) throw new Error('createTunnelApi: snode 必填')
  if (!manifest) throw new Error('createTunnelApi: manifest 必填')

  const perms = manifest.permissions
  const appName = manifest.name

  /**
   * 打开一条到 targetDid 的隧道。
   * @param {string} targetDid 接收方 did（context-C 子身份）
   * @param {object} [opts]
   * @param {string[]} [opts.relayDids] 可选手动指定 relay 列表
   * @returns {Promise<{ tunnelId: string, relayDids: string[] }>}
   */
  async function open(targetDid, opts = {}) {
    checkPermission(perms, 'tunnel:open', { app: appName })
    if (typeof targetDid !== 'string' || targetDid.length === 0) {
      throw new Error('tunnel.open: targetDid 必须是非空字符串')
    }
    if (opts.relayDids !== undefined && !Array.isArray(opts.relayDids)) {
      throw new Error('tunnel.open: relayDids 必须是数组或 undefined')
    }
    return snode.establishTunnel({ targetDid, relayDids: opts.relayDids })
  }

  /**
   * 通过隧道发送一个 chunk。
   * @param {string} tunnelId
   * @param {Uint8Array} chunk
   * @returns {Promise<{ relay: string, sequence: number, total: number }>}
   */
  async function send(tunnelId, chunk) {
    checkPermission(perms, 'tunnel:send', { app: appName })
    if (typeof tunnelId !== 'string' || tunnelId.length === 0) {
      throw new Error('tunnel.send: tunnelId 必须是非空字符串')
    }
    if (!(chunk instanceof Uint8Array)) {
      throw new Error('tunnel.send: chunk 必须是 Uint8Array')
    }
    return snode.sendTunnelChunk({ tunnelId, chunk })
  }

  /**
   * 标记某隧道的某 relay 链路断开（硬切换）。
   * @param {string} tunnelId
   * @param {string} relayDid
   * @returns {Promise<{ status: string, remainingRelays: number }>}
   */
  async function breakLink(tunnelId, relayDid) {
    checkPermission(perms, 'tunnel:close', { app: appName })
    if (typeof tunnelId !== 'string' || tunnelId.length === 0) {
      throw new Error('tunnel.breakLink: tunnelId 必须是非空字符串')
    }
    if (typeof relayDid !== 'string' || relayDid.length === 0) {
      throw new Error('tunnel.breakLink: relayDid 必须是非空字符串')
    }
    return snode.breakTunnelLink({ tunnelId, relayDid })
  }

  /**
   * 关闭隧道。
   * @param {string} tunnelId
   * @returns {Promise<void>}
   */
  async function close(tunnelId) {
    checkPermission(perms, 'tunnel:close', { app: appName })
    if (typeof tunnelId !== 'string' || tunnelId.length === 0) {
      throw new Error('tunnel.close: tunnelId 必须是非空字符串')
    }
    return snode.closeTunnel(tunnelId)
  }

  return {
    open,
    send,
    breakLink,
    close,
  }
}
