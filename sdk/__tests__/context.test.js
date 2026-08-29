// SPDX-License-Identifier: AGPL-3.0-only

/**
 * context API 单元测试（M9.2）
 * 覆盖：
 *   - getAll / getEnabled / getStatus / sign / verify 基础功能
 *   - Manifest.contexts 与 sign() 的门控关系
 *   - 错误处理（context 未启用 / 参数非法）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSnodeMock } from '../__mocks__/snode-mock.js'
import { createContextApi } from '../context.js'
import { AppManifest } from '../manifest.js'
import { ContextNotEnabledError } from '../errors.js'

function makeManifest(overrides = {}) {
  return new AppManifest({
    name: 'test-app',
    version: '1.0.0',
    capability: 'market',
    permissions: ['identity:context', 'identity:context:B'],
    entryPoint: './index.js',
    contexts: ['B'],
    ...overrides,
  })
}

test('context.getAll: 返回完整 4-context + main', () => {
  const snode = createSnodeMock()
  const api = createContextApi(snode, makeManifest())
  const all = api.getAll()
  assert.ok(all.main)
  assert.ok(all.A)
  assert.ok(all.B)
  assert.ok(all.C)
  assert.ok(all.D)
  assert.equal(typeof all.main, 'string')
})

test('context.getEnabled: 返回 Manifest.contexts 副本', () => {
  const snode = createSnodeMock()
  const api = createContextApi(snode, makeManifest({ contexts: ['B', 'C'] }))
  const enabled = api.getEnabled()
  assert.deepEqual(enabled, ['B', 'C'])
  // 修改返回值不影响内部
  enabled.push('A')
  assert.deepEqual(api.getEnabled(), ['B', 'C'])
})

test('context.getStatus: 返回完整 4-context 状态面板（含未启用的）', async () => {
  const snode = createSnodeMock()
  const api = createContextApi(snode, makeManifest({ contexts: ['B'] }))
  const status = await api.getStatus()
  assert.ok(status.main)
  assert.ok(status.contextA)
  assert.ok(status.contextB)
  assert.ok(status.contextC)
  assert.ok(status.contextD)
  // 主身份永远 active
  assert.equal(status.main.status, 'active')
  // context-B 启用 → active / usedByApp=true
  assert.equal(status.contextB.status, 'active')
  assert.equal(status.contextB.usedByApp, true)
  // A/C/D 未启用 → loaded / usedByApp=false
  assert.equal(status.contextA.status, 'loaded')
  assert.equal(status.contextA.usedByApp, false)
  assert.equal(status.contextC.status, 'loaded')
  assert.equal(status.contextC.usedByApp, false)
  assert.equal(status.contextD.status, 'loaded')
  assert.equal(status.contextD.usedByApp, false)
})

test('context.getStatus: 空数组 contexts 时所有 context 都是 loaded', async () => {
  const snode = createSnodeMock()
  const api = createContextApi(snode, makeManifest({ contexts: [] }))
  const status = await api.getStatus()
  for (const ctx of ['contextA', 'contextB', 'contextC', 'contextD']) {
    assert.equal(status[ctx].status, 'loaded')
    assert.equal(status[ctx].usedByApp, false)
  }
})

test('context.sign: 启用的 context 可签名 + 返回 signature + publicKey', async () => {
  const snode = createSnodeMock()
  const api = createContextApi(snode, makeManifest({ contexts: ['B'] }))
  const data = new Uint8Array([1, 2, 3])
  const result = await api.sign('B', data)
  assert.ok(result.signature instanceof Uint8Array)
  assert.equal(result.signature.length, 64)
  assert.ok(result.signerPublicKey)
})

test('context.sign: 未启用的 context 抛 ContextNotEnabledError', async () => {
  const snode = createSnodeMock()
  const api = createContextApi(snode, makeManifest({ contexts: ['B'] }))
  await assert.rejects(
    () => api.sign('A', new Uint8Array([1])),
    (err) => err instanceof ContextNotEnabledError && err.context === 'A' && err.code === 'CONTEXT_NOT_ENABLED',
  )
})

test('context.sign: 非法 contextKey 抛错', async () => {
  const snode = createSnodeMock()
  const api = createContextApi(snode, makeManifest({ contexts: ['A', 'B', 'C', 'D'] }))
  await assert.rejects(
    () => api.sign('X', new Uint8Array([1])),
    /contextKey 必须是 A\/B\/C\/D/,
  )
})

test('context.sign: data 非 Uint8Array 抛错', async () => {
  const snode = createSnodeMock()
  const api = createContextApi(snode, makeManifest({ contexts: ['B'] }))
  await assert.rejects(
    () => api.sign('B', 'not-bytes'),
    /data 必须是 Uint8Array/,
  )
})

test('context.verify: 验签成功（被动行为，不受 App 启用限制）', async () => {
  const snode = createSnodeMock()
  const api = createContextApi(snode, makeManifest({ contexts: [] }))  // 空数组：没启用任何 context
  const id = snode.wallet.get('A')
  const data = new Uint8Array([1, 2, 3])
  const sig = await id.sign(data)
  const ok = await api.verify(id.publicKey, sig, data)
  assert.equal(ok, true)
})

test('context.verify: publicKey 非法抛错', async () => {
  const snode = createSnodeMock()
  const api = createContextApi(snode, makeManifest())
  await assert.rejects(
    () => api.verify(null, new Uint8Array(64), new Uint8Array(1)),
    /publicKey 必须含 verify/,
  )
})

test('createContextApi: snode.wallet 未初始化抛错', () => {
  const snode = createSnodeMock()
  delete snode.wallet
  assert.throws(
    () => createContextApi(snode, makeManifest()),
    /snode\.wallet 未初始化/,
  )
})
