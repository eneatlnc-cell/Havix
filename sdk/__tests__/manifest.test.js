// SPDX-License-Identifier: AGPL-3.0-only

/**
 * M9.1 AppManifest + 解析 + 校验单元测试
 * ───────────────────────────────────────────────
 * 测试范围：
 *   - AppManifest 构造（必需字段 + 可选字段 + 默认值）
 *   - fromObject / fromJson / fromYaml 静态工厂方法
 *   - 极简 YAML 解析器（扁平 key: value + 数组）
 *   - 校验失败场景（必需字段缺失 / 类型错误 / 非法值 / 路径穿越）
 *   - 不可变性（Object.freeze）
 *   - 实例方法（hasPermission / hasContext / toJSON / toString）
 *
 * 全部纯单元测试，不依赖 snode / libp2p / helia / 文件系统。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AppManifest,
  CAPABILITIES,
  INVITE_TOKEN_FORMATS,
  VALID_CONTEXTS,
  validateManifest,
} from '../manifest.js'
import { ManifestError } from '../errors.js'

// ──────────────────────────────────────────────
// 测试用 Manifest 模板
// ──────────────────────────────────────────────

const VALID_MANIFEST = {
  name: 'translation-market',
  version: '1.0.0',
  capability: 'market',
  permissions: ['market:publish', 'market:subscribe', 'credit:balance'],
  entryPoint: './index.js',
  contexts: ['B'],
  minReputation: 30,
  trustWeight: 0.8,
  description: '邀请制翻译服务市场',
}

// ──────────────────────────────────────────────
// AppManifest 构造 - 合法路径
// ──────────────────────────────────────────────

test('AppManifest：合法 manifest 构造成功', () => {
  const m = new AppManifest(VALID_MANIFEST)
  assert.equal(m.name, 'translation-market')
  assert.equal(m.version, '1.0.0')
  assert.equal(m.capability, 'market')
  assert.deepEqual(m.permissions, ['market:publish', 'market:subscribe', 'credit:balance'])
  assert.equal(m.entryPoint, './index.js')
  assert.deepEqual(m.contexts, ['B'])
  assert.equal(m.minReputation, 30)
  assert.equal(m.trustWeight, 0.8)
})

test('AppManifest：可选字段缺失时使用默认值', () => {
  const m = new AppManifest({
    name: 'minimal-app',
    version: '0.1.0',
    capability: 'custom',
    permissions: [],
    entryPoint: './index.js',
  })
  assert.equal(m.inviteTokenFormat, 'ed25519-signature')
  assert.equal(m.spaCid, null)
  assert.equal(m.minReputation, 0)
  assert.equal(m.trustWeight, 0.5)
  assert.equal(m.dataDir, 'minimal-app')  // 默认等于 name
  assert.deepEqual(m.contexts, [])
  assert.equal(m.description, '')
})

test('AppManifest：dataDir 默认等于 name', () => {
  const m = new AppManifest({
    name: 'empty-app',
    version: '1.0.0',
    capability: 'custom',
    permissions: [],
    entryPoint: './index.js',
  })
  assert.equal(m.dataDir, 'empty-app')
})

test('AppManifest：dataDir 显式指定时使用指定值', () => {
  const m = new AppManifest({
    ...VALID_MANIFEST,
    dataDir: 'custom-dir',
  })
  assert.equal(m.dataDir, 'custom-dir')
})

test('AppManifest：empty-app 模板 contexts: [] 合法', () => {
  const m = new AppManifest({
    name: 'empty-app',
    version: '1.0.0',
    capability: 'custom',
    permissions: [],
    entryPoint: './index.js',
    contexts: [],
  })
  assert.deepEqual(m.contexts, [])
})

// ──────────────────────────────────────────────
// AppManifest 构造 - 必需字段缺失
// ──────────────────────────────────────────────

test('AppManifest：name 缺失抛 ManifestError', () => {
  const { name, ...rest } = VALID_MANIFEST
  assert.throws(
    () => new AppManifest(rest),
    (err) => {
      assert.ok(err instanceof ManifestError)
      assert.match(err.message, /name 字段缺失/)
      assert.equal(err.code, 'MANIFEST_MISSING_FIELD')
      return true
    },
  )
})

test('AppManifest：version 缺失抛 ManifestError', () => {
  const { version, ...rest } = VALID_MANIFEST
  assert.throws(
    () => new AppManifest(rest),
    (err) => {
      assert.ok(err instanceof ManifestError)
      assert.match(err.message, /version 字段缺失/)
      return true
    },
  )
})

test('AppManifest：capability 缺失抛 ManifestError', () => {
  const { capability, ...rest } = VALID_MANIFEST
  assert.throws(
    () => new AppManifest(rest),
    /capability 字段缺失/,
  )
})

test('AppManifest：permissions 缺失抛 ManifestError', () => {
  const { permissions, ...rest } = VALID_MANIFEST
  assert.throws(
    () => new AppManifest(rest),
    /permissions 字段缺失/,
  )
})

test('AppManifest：entryPoint 缺失抛 ManifestError', () => {
  const { entryPoint, ...rest } = VALID_MANIFEST
  assert.throws(
    () => new AppManifest(rest),
    /entryPoint 字段缺失/,
  )
})

// ──────────────────────────────────────────────
// AppManifest 构造 - name 字段校验
// ──────────────────────────────────────────────

test('AppManifest：name 非 kebab-case 抛错', () => {
  const cases = [
    'TranslationMarket',  // 大写
    'translation_market',  // 下划线
    'translation market',  // 空格
    '1translation',        // 数字开头
    '-translation',        // 短横线开头
    '',                    // 空
    'a'.repeat(65),       // 太长（>64）
  ]
  for (const name of cases) {
    assert.throws(
      () => new AppManifest({ ...VALID_MANIFEST, name }),
      ManifestError,
      `应拒绝 name: "${name}"`,
    )
  }
})

test('AppManifest：name kebab-case 合法值通过', () => {
  const cases = ['a', 'abc', 'translation-market', 'app-1', 'a-b-c-1-2-3']
  for (const name of cases) {
    assert.doesNotThrow(
      () => new AppManifest({ ...VALID_MANIFEST, name }),
      `应接受 name: "${name}"`,
    )
  }
})

test('AppManifest：name 类型错误抛错', () => {
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, name: 123 }),
    /name 字段必须是字符串/,
  )
})

// ──────────────────────────────────────────────
// AppManifest 构造 - version 字段校验
// ──────────────────────────────────────────────

test('AppManifest：version 非 semver 抛错', () => {
  const cases = ['1', '1.0', 'v1.0.0', 'version-1', '1.0.0.0', 'abc']
  for (const version of cases) {
    assert.throws(
      () => new AppManifest({ ...VALID_MANIFEST, version }),
      ManifestError,
      `应拒绝 version: "${version}"`,
    )
  }
})

test('AppManifest：version semver 合法值通过', () => {
  const cases = ['1.0.0', '0.1.0', '2.5.3', '1.0.0-alpha', '1.0.0-beta.1', '1.0.0+build.1', '0.0.1-rc.1+build.2']
  for (const version of cases) {
    assert.doesNotThrow(
      () => new AppManifest({ ...VALID_MANIFEST, version }),
      `应接受 version: "${version}"`,
    )
  }
})

// ──────────────────────────────────────────────
// AppManifest 构造 - capability 字段校验
// ──────────────────────────────────────────────

test('AppManifest：capability 非法值抛错', () => {
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, capability: 'social' }),
    /capability 字段必须是 \[.*\] 之一/,
  )
})

test('AppManifest：所有合法 capability 通过', () => {
  for (const cap of CAPABILITIES) {
    assert.doesNotThrow(
      () => new AppManifest({ ...VALID_MANIFEST, capability: cap }),
      `应接受 capability: "${cap}"`,
    )
  }
})

test('CAPABILITIES：包含 5 个值', () => {
  assert.equal(CAPABILITIES.length, 5)
  assert.ok(CAPABILITIES.includes('market'))
  assert.ok(CAPABILITIES.includes('wiki'))
  assert.ok(CAPABILITIES.includes('tunnel'))
  assert.ok(CAPABILITIES.includes('public'))
  assert.ok(CAPABILITIES.includes('custom'))
})

// ──────────────────────────────────────────────
// AppManifest 构造 - permissions 字段校验
// ──────────────────────────────────────────────

test('AppManifest：permissions 含未知权限抛错', () => {
  assert.throws(
    () => new AppManifest({
      ...VALID_MANIFEST,
      permissions: ['market:publish', 'admin:delete'],
    }),
    /未知权限.*admin:delete/,
  )
})

test('AppManifest：permissions 含重复权限抛错', () => {
  assert.throws(
    () => new AppManifest({
      ...VALID_MANIFEST,
      permissions: ['market:publish', 'market:publish'],
    }),
    /重复权限.*market:publish/,
  )
})

test('AppManifest：permissions 含非字符串项抛错', () => {
  assert.throws(
    () => new AppManifest({
      ...VALID_MANIFEST,
      permissions: ['market:publish', 123],
    }),
    /权限项必须是字符串/,
  )
})

test('AppManifest：permissions 非数组抛错', () => {
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, permissions: 'market:publish' }),
    /permissions 字段必须是数组/,
  )
})

// ──────────────────────────────────────────────
// AppManifest 构造 - entryPoint 字段校验
// ──────────────────────────────────────────────

test('AppManifest：entryPoint 绝对路径抛错（防加载文件系统任意位置）', () => {
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, entryPoint: '/etc/passwd' }),
    /相对路径/,
  )
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, entryPoint: 'C:\\Windows\\system32' }),
    /相对路径/,
  )
})

test('AppManifest：entryPoint 含 ".." 路径穿越抛错', () => {
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, entryPoint: '../../../etc/passwd' }),
    /路径穿越/,
  )
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, entryPoint: './sub/../../etc/passwd' }),
    /路径穿越/,
  )
})

test('AppManifest：entryPoint 空字符串抛错', () => {
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, entryPoint: '' }),
    /entryPoint 字段不能为空/,
  )
})

// ──────────────────────────────────────────────
// AppManifest 构造 - trustWeight / minReputation 数值校验
// ──────────────────────────────────────────────

test('AppManifest：trustWeight < 0 抛错', () => {
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, trustWeight: -0.1 }),
    /trustWeight 字段必须在 0.0-1.0/,
  )
})

test('AppManifest：trustWeight > 1 抛错', () => {
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, trustWeight: 1.1 }),
    /trustWeight 字段必须在 0.0-1.0/,
  )
})

test('AppManifest：trustWeight = 0 / 1 边界值合法', () => {
  assert.doesNotThrow(() => new AppManifest({ ...VALID_MANIFEST, trustWeight: 0 }))
  assert.doesNotThrow(() => new AppManifest({ ...VALID_MANIFEST, trustWeight: 1 }))
})

test('AppManifest：trustWeight NaN / Infinity 抛错', () => {
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, trustWeight: NaN }),
    /有限数字/,
  )
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, trustWeight: Infinity }),
    /有限数字/,
  )
})

test('AppManifest：minReputation < 0 抛错', () => {
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, minReputation: -1 }),
    /minReputation 字段必须 >= 0/,
  )
})

test('AppManifest：minReputation = 0 边界值合法', () => {
  assert.doesNotThrow(() => new AppManifest({ ...VALID_MANIFEST, minReputation: 0 }))
})

// ──────────────────────────────────────────────
// AppManifest 构造 - contexts 字段校验
// ──────────────────────────────────────────────

test('AppManifest：contexts 含非法值抛错', () => {
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, contexts: ['E'] }),
    /contexts 数组项必须是 \[.*\] 之一/,
  )
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, contexts: ['X'] }),
    /contexts 数组项必须是/,
  )
})

test('AppManifest：contexts 含重复值抛错', () => {
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, contexts: ['B', 'B'] }),
    /contexts 数组不允许重复/,
  )
})

test('AppManifest：contexts 含非字符串项抛错', () => {
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, contexts: ['B', 123] }),
    /contexts 数组项必须是字符串/,
  )
})

test('AppManifest：contexts 非数组抛错', () => {
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, contexts: 'B' }),
    /contexts 字段必须是数组/,
  )
})

test('AppManifest：contexts 全部 4 个合法值通过', () => {
  const m = new AppManifest({ ...VALID_MANIFEST, contexts: ['A', 'B', 'C', 'D'] })
  assert.deepEqual(m.contexts, ['A', 'B', 'C', 'D'])
})

test('VALID_CONTEXTS：包含 A/B/C/D', () => {
  assert.deepEqual([...VALID_CONTEXTS], ['A', 'B', 'C', 'D'])
})

// ──────────────────────────────────────────────
// AppManifest 构造 - inviteTokenFormat / spaCid / dataDir 校验
// ──────────────────────────────────────────────

test('AppManifest：inviteTokenFormat 非法值抛错', () => {
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, inviteTokenFormat: 'invalid' }),
    /inviteTokenFormat 字段必须是/,
  )
})

test('AppManifest：所有合法 inviteTokenFormat 通过', () => {
  for (const fmt of INVITE_TOKEN_FORMATS) {
    assert.doesNotThrow(
      () => new AppManifest({ ...VALID_MANIFEST, inviteTokenFormat: fmt }),
      `应接受 inviteTokenFormat: "${fmt}"`,
    )
  }
})

test('AppManifest：spaCid 非字符串抛错', () => {
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, spaCid: 123 }),
    /spaCid 字段必须是字符串/,
  )
})

test('AppManifest：dataDir 绝对路径抛错', () => {
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, dataDir: '/etc/havix' }),
    /相对路径/,
  )
})

test('AppManifest：dataDir 含 ".." 抛错', () => {
  assert.throws(
    () => new AppManifest({ ...VALID_MANIFEST, dataDir: '../etc' }),
    /路径穿越/,
  )
})

// ──────────────────────────────────────────────
// AppManifest 构造 - raw 入参类型校验
// ──────────────────────────────────────────────

test('AppManifest：raw 是 null 抛错', () => {
  assert.throws(
    () => new AppManifest(null),
    /Manifest 必须是对象.*null/,
  )
})

test('AppManifest：raw 是数组抛错', () => {
  assert.throws(
    () => new AppManifest([1, 2, 3]),
    /Manifest 必须是对象/,
  )
})

test('AppManifest：raw 是字符串抛错', () => {
  assert.throws(
    () => new AppManifest('string'),
    /Manifest 必须是对象/,
  )
})

// ──────────────────────────────────────────────
// 静态工厂方法 - fromObject
// ──────────────────────────────────────────────

test('AppManifest.fromObject：合法对象构造成功', () => {
  const m = AppManifest.fromObject(VALID_MANIFEST)
  assert.equal(m.name, 'translation-market')
  assert.ok(m instanceof AppManifest)
})

test('AppManifest.fromObject：非法对象抛 ManifestError', () => {
  assert.throws(
    () => AppManifest.fromObject({ name: 'invalid' }),
    ManifestError,
  )
})

// ──────────────────────────────────────────────
// 静态工厂方法 - fromJson
// ──────────────────────────────────────────────

test('AppManifest.fromJson：合法 JSON 字符串构造成功', () => {
  const json = JSON.stringify(VALID_MANIFEST)
  const m = AppManifest.fromJson(json)
  assert.equal(m.name, 'translation-market')
})

test('AppManifest.fromJson：非法 JSON 抛 ManifestError', () => {
  assert.throws(
    () => AppManifest.fromJson('{invalid json}'),
    /JSON 解析失败/,
  )
})

test('AppManifest.fromJson：非字符串入参抛错', () => {
  assert.throws(
    () => AppManifest.fromJson({}),
    /fromJson 入参必须是字符串/,
  )
})

test('AppManifest.fromJson：合法 JSON 但字段缺失抛 ManifestError', () => {
  assert.throws(
    () => AppManifest.fromJson(JSON.stringify({ name: 'incomplete' })),
    ManifestError,
  )
})

// ──────────────────────────────────────────────
// 静态工厂方法 - fromYaml
// ──────────────────────────────────────────────

test('AppManifest.fromYaml：扁平 key: value 解析成功', () => {
  const yaml = `
name: translation-market
version: 1.0.0
capability: market
permissions: []
entryPoint: ./index.js
description: 邀请制翻译市场
`
  const m = AppManifest.fromYaml(yaml)
  assert.equal(m.name, 'translation-market')
  assert.equal(m.version, '1.0.0')
  assert.equal(m.capability, 'market')
  assert.equal(m.entryPoint, './index.js')
  assert.equal(m.description, '邀请制翻译市场')
})

test('AppManifest.fromYaml：permissions 数组解析成功', () => {
  const yaml = `
name: test-app
version: 1.0.0
capability: market
entryPoint: ./index.js
permissions:
  - market:publish
  - market:subscribe
  - credit:balance
`
  const m = AppManifest.fromYaml(yaml)
  assert.deepEqual(m.permissions, ['market:publish', 'market:subscribe', 'credit:balance'])
})

test('AppManifest.fromYaml：contexts 数组解析成功', () => {
  const yaml = `
name: test-app
version: 1.0.0
capability: market
permissions: []
entryPoint: ./index.js
contexts:
  - B
`
  const m = AppManifest.fromYaml(yaml)
  assert.deepEqual(m.contexts, ['B'])
})

test('AppManifest.fromYaml：minReputation 数字解析成功', () => {
  const yaml = `
name: test-app
version: 1.0.0
capability: market
permissions: []
entryPoint: ./index.js
minReputation: 30
trustWeight: 0.8
`
  const m = AppManifest.fromYaml(yaml)
  assert.equal(m.minReputation, 30)
  assert.equal(m.trustWeight, 0.8)
})

test('AppManifest.fromYaml：注释 + 空行被忽略', () => {
  const yaml = `# 这是一个注释
name: test-app

# 中间空行
version: 1.0.0
# 末尾注释
capability: custom
permissions: []
entryPoint: ./index.js
`
  const m = AppManifest.fromYaml(yaml)
  assert.equal(m.name, 'test-app')
  assert.equal(m.version, '1.0.0')
})

test('AppManifest.fromYaml：带引号的字符串值被去掉引号', () => {
  const yaml = `
name: "test-app"
version: '1.0.0'
capability: "custom"
permissions: []
entryPoint: "./index.js"
description: "带引号的描述"
`
  const m = AppManifest.fromYaml(yaml)
  assert.equal(m.name, 'test-app')
  assert.equal(m.version, '1.0.0')
  assert.equal(m.description, '带引号的描述')
})

test('AppManifest.fromYaml：非字符串入参抛错', () => {
  assert.throws(
    () => AppManifest.fromYaml({}),
    /fromYaml 入参必须是字符串/,
  )
})

test('AppManifest.fromYaml：YAML 顶层不允许数组项抛错', () => {
  const yaml = `- item1
- item2`
  assert.throws(
    () => AppManifest.fromYaml(yaml),
    /YAML 顶层不允许数组项/,
  )
})

test('AppManifest.fromYaml：缺少冒号抛错', () => {
  const yaml = `name test-app`
  assert.throws(
    () => AppManifest.fromYaml(yaml),
    /YAML 行无法解析/,
  )
})

test('AppManifest.fromYaml：翻译市场完整 manifest 解析', () => {
  const yaml = `
# apps/translation-market/manifest.yaml
name: translation-market
version: 1.0.0
capability: market
permissions:
  - market:create
  - market:invite
  - market:join
  - market:publish
  - market:subscribe
  - market:leave
  - credit:consume
  - credit:balance
  - arbitration:file
  - identity:context:B
  - ipfs:read
  - ipfs:write
inviteTokenFormat: ed25519-signature
minReputation: 30
trustWeight: 0.8
dataDir: translation-market
contexts:
  - B
description: 邀请制翻译服务市场，credit 消费 + 仲裁保障
entryPoint: ./index.js
`
  const m = AppManifest.fromYaml(yaml)
  assert.equal(m.name, 'translation-market')
  assert.equal(m.version, '1.0.0')
  assert.equal(m.capability, 'market')
  assert.equal(m.permissions.length, 12)
  assert.equal(m.inviteTokenFormat, 'ed25519-signature')
  assert.equal(m.minReputation, 30)
  assert.equal(m.trustWeight, 0.8)
  assert.equal(m.dataDir, 'translation-market')
  assert.deepEqual(m.contexts, ['B'])
})

// ──────────────────────────────────────────────
// 实例方法 - hasPermission / hasContext
// ──────────────────────────────────────────────

test('AppManifest.hasPermission：拥有权限返回 true', () => {
  const m = new AppManifest(VALID_MANIFEST)
  assert.equal(m.hasPermission('market:publish'), true)
  assert.equal(m.hasPermission('market:subscribe'), true)
  assert.equal(m.hasPermission('credit:balance'), true)
})

test('AppManifest.hasPermission：缺权限返回 false', () => {
  const m = new AppManifest(VALID_MANIFEST)
  assert.equal(m.hasPermission('market:invite'), false)
  assert.equal(m.hasPermission('credit:issue'), false)
  assert.equal(m.hasPermission('admin:delete'), false)
})

test('AppManifest.hasContext：拥有 context 返回 true', () => {
  const m = new AppManifest({ ...VALID_MANIFEST, contexts: ['B'] })
  assert.equal(m.hasContext('B'), true)
  assert.equal(m.hasContext('A'), false)
  assert.equal(m.hasContext('C'), false)
  assert.equal(m.hasContext('D'), false)
})

test('AppManifest.hasContext：contexts 空时全部返回 false', () => {
  const m = new AppManifest({ ...VALID_MANIFEST, contexts: [] })
  assert.equal(m.hasContext('A'), false)
  assert.equal(m.hasContext('B'), false)
})

// ──────────────────────────────────────────────
// 实例方法 - toJSON / toString
// ──────────────────────────────────────────────

test('AppManifest.toJSON：序列化回对象（含全部字段）', () => {
  const m = new AppManifest(VALID_MANIFEST)
  const obj = m.toJSON()
  assert.equal(obj.name, 'translation-market')
  assert.equal(obj.version, '1.0.0')
  assert.equal(obj.capability, 'market')
  assert.deepEqual(obj.permissions, VALID_MANIFEST.permissions)
  assert.equal(obj.entryPoint, './index.js')
  assert.deepEqual(obj.contexts, ['B'])
  assert.equal(obj.minReputation, 30)
  assert.equal(obj.trustWeight, 0.8)
})

test('AppManifest.toJSON：可被 JSON.stringify 序列化', () => {
  const m = new AppManifest(VALID_MANIFEST)
  const json = JSON.stringify(m.toJSON())
  const parsed = JSON.parse(json)
  assert.equal(parsed.name, 'translation-market')
})

test('AppManifest.toJSON：可往返重建 AppManifest', () => {
  const m1 = new AppManifest(VALID_MANIFEST)
  const obj = m1.toJSON()
  const m2 = new AppManifest(obj)
  assert.equal(m1.name, m2.name)
  assert.equal(m1.version, m2.version)
  assert.deepEqual(m1.permissions, m2.permissions)
  assert.deepEqual(m1.contexts, m2.contexts)
})

test('AppManifest.toString：返回简短摘要', () => {
  const m = new AppManifest(VALID_MANIFEST)
  const str = m.toString()
  assert.match(str, /AppManifest/)
  assert.match(str, /name=translation-market/)
  assert.match(str, /version=1.0.0/)
  assert.match(str, /capability=market/)
})

// ──────────────────────────────────────────────
// 不可变性（Object.freeze）
// ──────────────────────────────────────────────

test('AppManifest：实例冻结（不可变）', () => {
  const m = new AppManifest(VALID_MANIFEST)
  assert.ok(Object.isFrozen(m))
  assert.throws(() => {
    m.name = 'changed'
  }, TypeError)
})

test('AppManifest：permissions 数组冻结（不可变）', () => {
  const m = new AppManifest(VALID_MANIFEST)
  assert.ok(Object.isFrozen(m.permissions))
  assert.throws(() => {
    m.permissions.push('admin:delete')
  }, TypeError)
})

test('AppManifest：contexts 数组冻结（不可变）', () => {
  const m = new AppManifest(VALID_MANIFEST)
  assert.ok(Object.isFrozen(m.contexts))
  assert.throws(() => {
    m.contexts.push('A')
  }, TypeError)
})

// ──────────────────────────────────────────────
// validateManifest 函数（不抛错，返回校验结果）
// ──────────────────────────────────────────────

test('validateManifest：合法 manifest 返回 valid=true', () => {
  const result = validateManifest(VALID_MANIFEST)
  assert.equal(result.valid, true)
  assert.equal(result.errors.length, 0)
})

test('validateManifest：非法 manifest 返回 valid=false 含错误信息', () => {
  const result = validateManifest({ name: 'invalid name with space' })
  assert.equal(result.valid, false)
  assert.ok(result.errors.length > 0)
  assert.ok(result.errors.some(e => e.includes('kebab-case')))
})

test('validateManifest：null 入参返回 invalid', () => {
  const result = validateManifest(null)
  assert.equal(result.valid, false)
  assert.ok(result.errors.length > 0)
})
