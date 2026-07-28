// SPDX-License-Identifier: Apache-2.0

/**
 * Havix SDK 权限白名单 + 校验（M9.1）
 * ───────────────────────────────────────────────
 * 权限是 App Manifest 的核心字段——声明 App 能调用哪些 SDK 接口。
 *
 * 设计原则：
 *   1. 白名单制——所有可用权限都在 PERMISSIONS 中列出
 *   2. 按协议层分组——market / credit / wiki / tunnel / arbitration / identity / transport / ipfs
 *   3. SDK 在 App 调用任何 API 前校验对应权限，缺失抛 PermissionDeniedError
 *   4. 权限名格式：<category>:<action>（如 market:publish）或 <category>:<action>:<scope>
 *      （如 identity:context:B，表示仅可访问 context-B）
 *
 * 共 28 项权限：
 *   market(6) + credit(4) + wiki(3) + tunnel(3) + arbitration(3)
 *   + identity(5: 基础 + 4 context) + transport(2) + ipfs(2) = 28
 *
 * 权限与 SDK 接口的映射见 sdk/index.js 中各子模块的 createXxxApi。
 */

import { PermissionDeniedError } from './errors.js'

/**
 * 权限白名单。
 * 每项权限包含 name（机器可读）+ description（人类可读）+ category（分组）。
 */
export const PERMISSIONS = Object.freeze([
  // ─── 市场权限（market） ───
  { name: 'market:create',    description: '创建新市场',                category: 'market' },
  { name: 'market:invite',     description: '邀请成员（签发 InviteToken）', category: 'market' },
  { name: 'market:join',       description: '加入市场（持邀请令牌）',     category: 'market' },
  { name: 'market:publish',    description: '发布私域消息（AES-GCM 加密）', category: 'market' },
  { name: 'market:subscribe', description: '订阅私域消息（自动解密）',   category: 'market' },
  { name: 'market:leave',      description: '离开市场',                   category: 'market' },

  // ─── Credit 权限（credit） ───
  { name: 'credit:issue',     description: '签发 credit（需高信誉）',     category: 'credit' },
  { name: 'credit:consume',   description: '消费 credit（付给服务方）',   category: 'credit' },
  { name: 'credit:transfer',  description: '转账',                        category: 'credit' },
  { name: 'credit:balance',   description: '查询余额',                    category: 'credit' },

  // ─── 维基权限（wiki） ───
  { name: 'wiki:publish',     description: '发布条目（需 vouch 阈值）',   category: 'wiki' },
  { name: 'wiki:list',        description: '列出条目',                    category: 'wiki' },
  { name: 'wiki:get',         description: '获取条目',                    category: 'wiki' },

  // ─── 隧道权限（tunnel） ───
  { name: 'tunnel:open',      description: '打开隧道',                    category: 'tunnel' },
  { name: 'tunnel:send',      description: '发送隧道消息',                category: 'tunnel' },
  { name: 'tunnel:close',     description: '关闭隧道',                    category: 'tunnel' },

  // ─── 仲裁权限（arbitration） ───
  { name: 'arbitration:file',     description: '发起仲裁',               category: 'arbitration' },
  { name: 'arbitration:vote',     description: '投票（需仲裁员资格）',   category: 'arbitration' },
  { name: 'arbitration:resolve',  description: '裁决（需仲裁团多数）',   category: 'arbitration' },

  // ─── 身份权限（identity） ───
  // identity:context 是基础权限（getAll / getStatus / verify 任意 context 都可）
  // identity:context:<X> 是受限权限（sign 只能用指定 context X）
  { name: 'identity:context',  description: '获取本节点 context 信息（含完整 4-context 状态面板）', category: 'identity' },
  { name: 'identity:context:A', description: '用 context-A 签名（A 是互联网通行身份，慎用）',     category: 'identity' },
  { name: 'identity:context:B', description: '用 context-B 签名（业务身份）',                     category: 'identity' },
  { name: 'identity:context:C', description: '用 context-C 签名（私聊身份）',                     category: 'identity' },
  { name: 'identity:context:D', description: '用 context-D 签名（维基编辑身份，需 vouch 阈值）',  category: 'identity' },

  // ─── 传输权限（transport） ───
  { name: 'transport:publish',   description: '直接 gossipsub 发布（自定义 topic）', category: 'transport' },
  { name: 'transport:subscribe', description: '直接 gossipsub 订阅',                category: 'transport' },

  // ─── IPFS 权限（ipfs） ───
  { name: 'ipfs:read',  description: 'IPFS 读取', category: 'ipfs' },
  { name: 'ipfs:write', description: 'IPFS 写入', category: 'ipfs' },
])

/**
 * 权限名 → 权限对象 的查找表（O(1) 查找）。
 */
export const PERMISSION_MAP = Object.freeze(
  Object.fromEntries(PERMISSIONS.map(p => [p.name, p])),
)

/**
 * 所有合法权限名集合（用于校验）。
 */
export const PERMISSION_NAMES = Object.freeze(
  new Set(PERMISSIONS.map(p => p.name)),
)

/**
 * 所有合法 category 集合（用于 Manifest.contexts 校验等）。
 */
export const PERMISSION_CATEGORIES = Object.freeze(
  new Set(PERMISSIONS.map(p => p.category)),
)

// ──────────────────────────────────────────────
// 校验函数
// ──────────────────────────────────────────────

/**
 * 校验权限名是否在白名单中。
 * @param {string} permission
 * @returns {boolean}
 */
export function isValidPermission(permission) {
  return PERMISSION_NAMES.has(permission)
}

/**
 * 校验 App 声明的权限列表：
 *   1. 必须是数组
 *   2. 每项必须是字符串
 *   3. 每项必须在白名单中
 *   4. 不允许重复
 *
 * @param {string[]} permissions App 声明的权限列表
 * @returns {{ valid: boolean, errors: string[] }} 校验结果
 */
export function validatePermissions(permissions) {
  const errors = []

  if (!Array.isArray(permissions)) {
    return { valid: false, errors: ['permissions 字段必须是数组'] }
  }

  if (permissions.length === 0) {
    // 空权限合法（empty-app 模板就是空权限）
    return { valid: true, errors: [] }
  }

  const seen = new Set()
  for (const p of permissions) {
    if (typeof p !== 'string') {
      errors.push(`权限项必须是字符串，实际类型: ${typeof p}`)
      continue
    }
    if (!isValidPermission(p)) {
      errors.push(`未知权限: "${p}"（不在白名单中）`)
      continue
    }
    if (seen.has(p)) {
      errors.push(`重复权限: "${p}"`)
      continue
    }
    seen.add(p)
  }

  return { valid: errors.length === 0, errors }
}

/**
 * 校验 App 是否拥有指定权限。
 * 用于 SDK 接口在调用前检查——若缺失抛 PermissionDeniedError。
 *
 * @param {string[]} appPermissions App 已声明的权限列表
 * @param {string} requiredPermission 调用接口所需的权限
 * @param {object} [opts]
 * @param {string} [opts.app] App 名（用于错误信息）
 * @throws {PermissionDeniedError} 若 App 未声明该权限
 */
export function checkPermission(appPermissions, requiredPermission, opts = {}) {
  if (!Array.isArray(appPermissions) || !appPermissions.includes(requiredPermission)) {
    throw new PermissionDeniedError(requiredPermission, { app: opts.app })
  }
}

/**
 * 校验 App 是否拥有指定权限（不抛错，返回布尔）。
 * 用于条件性逻辑（如 UI 显示按钮前检查）。
 *
 * @param {string[]} appPermissions
 * @param {string} requiredPermission
 * @returns {boolean}
 */
export function hasPermission(appPermissions, requiredPermission) {
  return Array.isArray(appPermissions) && appPermissions.includes(requiredPermission)
}

/**
 * 列出某 category 下的所有权限。
 * 用于 Manifest 校验时按分组检查权限完整性。
 *
 * @param {string} category
 * @returns {string[]}
 */
export function getPermissionsByCategory(category) {
  return PERMISSIONS.filter(p => p.category === category).map(p => p.name)
}
