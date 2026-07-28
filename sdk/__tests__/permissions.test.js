// SPDX-License-Identifier: Apache-2.0

/**
 * M9.1 权限白名单 + 校验单元测试
 * ───────────────────────────────────────────────
 * 测试范围：
 *   - PERMISSIONS 白名单完整性（25 项）
 *   - isValidPermission
 *   - validatePermissions（合法 / 缺失 / 重复 / 非法类型）
 *   - checkPermission（抛 PermissionDeniedError）
 *   - hasPermission（不抛错）
 *   - getPermissionsByCategory
 *
 * 全部纯单元测试，不依赖 snode / libp2p / helia。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PERMISSIONS,
  PERMISSION_MAP,
  PERMISSION_NAMES,
  PERMISSION_CATEGORIES,
  isValidPermission,
  validatePermissions,
  checkPermission,
  hasPermission,
  getPermissionsByCategory,
} from '../permissions.js'
import { PermissionDeniedError } from '../errors.js'

// ──────────────────────────────────────────────
// PERMISSIONS 白名单完整性
// ──────────────────────────────────────────────

test('PERMISSIONS：白名单包含 28 项权限', () => {
  assert.equal(PERMISSIONS.length, 28,
    `应有 28 项权限，实际 ${PERMISSIONS.length}`)
})

test('PERMISSIONS：每项权限有 name / description / category', () => {
  for (const p of PERMISSIONS) {
    assert.equal(typeof p.name, 'string', `权限 name 应是字符串: ${JSON.stringify(p)}`)
    assert.ok(p.name.length > 0, `权限 name 不能为空: ${JSON.stringify(p)}`)
    assert.equal(typeof p.description, 'string', `权限 description 应是字符串: ${JSON.stringify(p)}`)
    assert.equal(typeof p.category, 'string', `权限 category 应是字符串: ${JSON.stringify(p)}`)
  }
})

test('PERMISSIONS：权限名格式 <category>:<action> 或 <category>:<action>:<scope>', () => {
  for (const p of PERMISSIONS) {
    const parts = p.name.split(':')
    assert.ok(parts.length >= 2 && parts.length <= 3,
      `权限名 "${p.name}" 应有 2-3 段冒号分隔`)
    assert.equal(parts[0], p.category,
      `权限名前缀 "${parts[0]}" 应等于 category "${p.category}"`)
  }
})

test('PERMISSIONS：权限名唯一（无重复）', () => {
  const names = PERMISSIONS.map(p => p.name)
  const set = new Set(names)
  assert.equal(set.size, names.length, '权限名不应重复')
})

test('PERMISSIONS：覆盖 8 大 category', () => {
  const expectedCategories = [
    'market', 'credit', 'wiki', 'tunnel',
    'arbitration', 'identity', 'transport', 'ipfs',
  ]
  for (const cat of expectedCategories) {
    assert.ok(PERMISSION_CATEGORIES.has(cat), `应覆盖 category: ${cat}`)
  }
})

test('PERMISSION_MAP：name → 权限对象查找', () => {
  for (const p of PERMISSIONS) {
    assert.equal(PERMISSION_MAP[p.name], p)
  }
})

test('PERMISSION_NAMES：Set 形式', () => {
  assert.ok(PERMISSION_NAMES instanceof Set)
  for (const p of PERMISSIONS) {
    assert.ok(PERMISSION_NAMES.has(p.name))
  }
})

// ──────────────────────────────────────────────
// market 权限分组完整性（6 项）
// ──────────────────────────────────────────────

test('market category：包含 6 项权限', () => {
  const marketPerms = getPermissionsByCategory('market')
  assert.deepEqual(marketPerms.sort(), [
    'market:create',
    'market:invite',
    'market:join',
    'market:leave',
    'market:publish',
    'market:subscribe',
  ])
})

test('credit category：包含 4 项权限', () => {
  const creditPerms = getPermissionsByCategory('credit')
  assert.deepEqual(creditPerms.sort(), [
    'credit:balance',
    'credit:consume',
    'credit:issue',
    'credit:transfer',
  ])
})

test('identity category：包含 5 项权限（基础 + 4 context）', () => {
  const idPerms = getPermissionsByCategory('identity')
  assert.equal(idPerms.length, 5)
  assert.ok(idPerms.includes('identity:context'))
  assert.ok(idPerms.includes('identity:context:A'))
  assert.ok(idPerms.includes('identity:context:B'))
  assert.ok(idPerms.includes('identity:context:C'))
  assert.ok(idPerms.includes('identity:context:D'))
})

// ──────────────────────────────────────────────
// isValidPermission
// ──────────────────────────────────────────────

test('isValidPermission：白名单内的权限返回 true', () => {
  assert.equal(isValidPermission('market:publish'), true)
  assert.equal(isValidPermission('credit:consume'), true)
  assert.equal(isValidPermission('identity:context:B'), true)
  assert.equal(isValidPermission('ipfs:read'), true)
})

test('isValidPermission：白名单外的权限返回 false', () => {
  assert.equal(isValidPermission('market:nonexistent'), false)
  assert.equal(isValidPermission('admin:delete'), false)
  assert.equal(isValidPermission(''), false)
  assert.equal(isValidPermission('not-a-permission'), false)
})

// ──────────────────────────────────────────────
// validatePermissions
// ──────────────────────────────────────────────

test('validatePermissions：合法权限列表通过', () => {
  const result = validatePermissions(['market:publish', 'market:subscribe', 'credit:balance'])
  assert.equal(result.valid, true)
  assert.equal(result.errors.length, 0)
})

test('validatePermissions：空数组合法（empty-app 模板）', () => {
  const result = validatePermissions([])
  assert.equal(result.valid, true)
  assert.equal(result.errors.length, 0)
})

test('validatePermissions：非数组返回 invalid', () => {
  const result = validatePermissions('market:publish')
  assert.equal(result.valid, false)
  assert.match(result.errors[0], /必须是数组/)
})

test('validatePermissions：null 返回 invalid', () => {
  const result = validatePermissions(null)
  assert.equal(result.valid, false)
})

test('validatePermissions：包含未知权限返回 invalid', () => {
  const result = validatePermissions(['market:publish', 'admin:delete'])
  assert.equal(result.valid, false)
  assert.ok(result.errors.some(e => e.includes('admin:delete')))
  assert.ok(result.errors.some(e => e.includes('未知权限')))
})

test('validatePermissions：包含非字符串项返回 invalid', () => {
  const result = validatePermissions(['market:publish', 123, null])
  assert.equal(result.valid, false)
  assert.ok(result.errors.some(e => e.includes('字符串')))
})

test('validatePermissions：重复权限返回 invalid', () => {
  const result = validatePermissions(['market:publish', 'market:publish'])
  assert.equal(result.valid, false)
  assert.ok(result.errors.some(e => e.includes('重复')))
})

test('validatePermissions：所有 28 项白名单权限一次性通过', () => {
  const allNames = Array.from(PERMISSION_NAMES)
  const result = validatePermissions(allNames)
  assert.equal(result.valid, true, `所有白名单权限应一次性通过: ${result.errors.join('; ')}`)
})

// ──────────────────────────────────────────────
// checkPermission（抛错）
// ──────────────────────────────────────────────

test('checkPermission：拥有权限时不抛错', () => {
  assert.doesNotThrow(() => {
    checkPermission(['market:publish'], 'market:publish')
  })
})

test('checkPermission：缺权限时抛 PermissionDeniedError', () => {
  assert.throws(
    () => checkPermission(['market:subscribe'], 'market:publish'),
    (err) => {
      assert.ok(err instanceof PermissionDeniedError)
      assert.equal(err.permission, 'market:publish')
      assert.match(err.message, /market:publish/)
      assert.match(err.message, /权限不足/)
      return true
    },
  )
})

test('checkPermission：空数组时抛 PermissionDeniedError', () => {
  assert.throws(
    () => checkPermission([], 'credit:consume'),
    PermissionDeniedError,
  )
})

test('checkPermission：非数组 permissions 抛错', () => {
  assert.throws(
    () => checkPermission(null, 'market:publish'),
    PermissionDeniedError,
  )
})

test('checkPermission：错误信息含 App 名（opts.app）', () => {
  assert.throws(
    () => checkPermission([], 'market:publish', { app: 'translation-market' }),
    (err) => {
      assert.match(err.message, /translation-market/)
      assert.equal(err.details.app, 'translation-market')
      return true
    },
  )
})

test('checkPermission：错误 code 为 PERMISSION_DENIED', () => {
  try {
    checkPermission([], 'market:publish')
    assert.fail('应抛错')
  } catch (err) {
    assert.equal(err.code, 'PERMISSION_DENIED')
  }
})

// ──────────────────────────────────────────────
// hasPermission（不抛错，返回布尔）
// ──────────────────────────────────────────────

test('hasPermission：拥有权限返回 true', () => {
  assert.equal(hasPermission(['market:publish', 'credit:balance'], 'market:publish'), true)
})

test('hasPermission：缺权限返回 false', () => {
  assert.equal(hasPermission(['market:subscribe'], 'market:publish'), false)
})

test('hasPermission：空数组返回 false', () => {
  assert.equal(hasPermission([], 'market:publish'), false)
})

test('hasPermission：非数组返回 false（不抛错）', () => {
  assert.equal(hasPermission(null, 'market:publish'), false)
  assert.equal(hasPermission(undefined, 'market:publish'), false)
  assert.equal(hasPermission('market:publish', 'market:publish'), false)
})

// ──────────────────────────────────────────────
// getPermissionsByCategory
// ──────────────────────────────────────────────

test('getPermissionsByCategory：返回某 category 下所有权限', () => {
  const tunnelPerms = getPermissionsByCategory('tunnel')
  assert.equal(tunnelPerms.length, 3)
  assert.ok(tunnelPerms.includes('tunnel:open'))
  assert.ok(tunnelPerms.includes('tunnel:send'))
  assert.ok(tunnelPerms.includes('tunnel:close'))
})

test('getPermissionsByCategory：未知 category 返回空数组', () => {
  const result = getPermissionsByCategory('nonexistent')
  assert.deepEqual(result, [])
})

test('getPermissionsByCategory：arbitration 含 3 项', () => {
  const arbPerms = getPermissionsByCategory('arbitration')
  assert.equal(arbPerms.length, 3)
  assert.ok(arbPerms.includes('arbitration:file'))
  assert.ok(arbPerms.includes('arbitration:vote'))
  assert.ok(arbPerms.includes('arbitration:resolve'))
})

// ──────────────────────────────────────────────
// Object.freeze 不可变性验证
// ──────────────────────────────────────────────

test('PERMISSIONS：白名单不可变（frozen）', () => {
  assert.ok(Object.isFrozen(PERMISSIONS))
  assert.throws(() => {
    PERMISSIONS.push({ name: 'admin:delete', description: 'evil', category: 'admin' })
  }, TypeError)
})

test('PERMISSION_NAMES：Set 不可变（frozen）', () => {
  assert.ok(Object.isFrozen(PERMISSION_NAMES))
})

test('PERMISSION_CATEGORIES：Set 不可变（frozen）', () => {
  assert.ok(Object.isFrozen(PERMISSION_CATEGORIES))
})
