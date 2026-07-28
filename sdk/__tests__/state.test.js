// SPDX-License-Identifier: Apache-2.0

/**
 * state API 单元测试（M9.2）
 * 覆盖 set/get/delete/clear/keys/entries + 持久化路径计算。
 * 注：M9.2 用内存实现，flush/load 是 no-op。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSnodeMock } from '../__mocks__/snode-mock.js'
import { createStateApi } from '../state.js'
import { AppManifest } from '../manifest.js'

function makeManifest(dataDir = null) {
  return new AppManifest({
    name: 'test-app',
    version: '1.0.0',
    capability: 'custom',
    permissions: [],
    entryPoint: './index.js',
    ...(dataDir ? { dataDir } : {}),
  })
}

test('state.set + get: 简单值往返', async () => {
  const snode = createSnodeMock()
  const api = createStateApi(snode, makeManifest())
  await api.set('key1', 'value1')
  assert.equal(await api.get('key1'), 'value1')
})

test('state.set + get: 对象值往返（深拷贝等价）', async () => {
  const snode = createSnodeMock()
  const api = createStateApi(snode, makeManifest())
  await api.set('orders', [{ id: 1, total: 10 }, { id: 2, total: 20 }])
  const r = await api.get('orders')
  assert.deepEqual(r, [{ id: 1, total: 10 }, { id: 2, total: 20 }])
})

test('state.get: 不存在的 key 返回 defaultValue', async () => {
  const snode = createSnodeMock()
  const api = createStateApi(snode, makeManifest())
  assert.equal(await api.get('nonexistent'), undefined)
  assert.equal(await api.get('nonexistent', 'fallback'), 'fallback')
})

test('state.set: key 空字符串抛错', async () => {
  const snode = createSnodeMock()
  const api = createStateApi(snode, makeManifest())
  await assert.rejects(() => api.set('', 'v'), /key 必须是非空字符串/)
})

test('state.set: value 不可 JSON 序列化抛错', async () => {
  const snode = createSnodeMock()
  const api = createStateApi(snode, makeManifest())
  const circular = {}
  circular.self = circular
  await assert.rejects(() => api.set('circular', circular), /value 不可 JSON 序列化/)
})

test('state.delete: 删除存在的 key 返回 true', async () => {
  const snode = createSnodeMock()
  const api = createStateApi(snode, makeManifest())
  await api.set('k', 'v')
  assert.equal(await api.delete('k'), true)
  assert.equal(await api.get('k'), undefined)
})

test('state.delete: 删除不存在的 key 返回 false', async () => {
  const snode = createSnodeMock()
  const api = createStateApi(snode, makeManifest())
  assert.equal(await api.delete('nonexistent'), false)
})

test('state.clear: 清空所有状态', async () => {
  const snode = createSnodeMock()
  const api = createStateApi(snode, makeManifest())
  await api.set('k1', 'v1')
  await api.set('k2', 'v2')
  await api.clear()
  assert.equal(api.keys().length, 0)
})

test('state.keys + entries: 列出所有 key 与对', async () => {
  const snode = createSnodeMock()
  const api = createStateApi(snode, makeManifest())
  await api.set('k1', 'v1')
  await api.set('k2', 'v2')
  assert.deepEqual(api.keys(), ['k1', 'k2'])
  assert.deepEqual(api.entries(), [['k1', 'v1'], ['k2', 'v2']])
})

test('state.persistPath: 用 manifest.dataDir 计算路径', () => {
  const snode = createSnodeMock({ config: { dataDir: '.data-test' } })
  const api = createStateApi(snode, makeManifest('my-data-dir'))
  assert.match(api.persistPath, /\.data-test[\/\\]ledgers[\/\\]apps[\/\\]my-data-dir[\/\\]state\.json/)
})

test('state.persistPath: options.dataDir 覆盖 manifest.dataDir', () => {
  const snode = createSnodeMock({ config: { dataDir: '.data-test' } })
  const api = createStateApi(snode, makeManifest('manifest-data-dir'), 'override-dir')
  assert.match(api.persistPath, /override-dir[\/\\]state\.json/)
})

test('state.flush + load: M9.2 是 no-op（不抛错即可）', async () => {
  const snode = createSnodeMock()
  const api = createStateApi(snode, makeManifest())
  await api.flush()
  await api.load()
  // 不抛错即可
})
