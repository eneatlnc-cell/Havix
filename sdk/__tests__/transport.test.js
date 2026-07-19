/**
 * transport API 单元测试（M9.2）
 * 覆盖 2 个权限门控 + topic 校验 + publish/subscribe/unsubscribe。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSnodeMock } from '../__mocks__/snode-mock.js'
import { createTransportApi } from '../transport.js'
import { AppManifest } from '../manifest.js'
import { PermissionDeniedError } from '../errors.js'

function makeManifest(permissions) {
  return new AppManifest({
    name: 'test-app',
    version: '1.0.0',
    capability: 'custom',
    permissions,
    entryPoint: './index.js',
  })
}

test('transport.publish: 委托 snode.libp2p.services.pubsub.publish', async () => {
  const snode = createSnodeMock()
  const api = createTransportApi(snode, makeManifest(['transport:publish']))
  const r = await api.publish('/havix-app/test', new Uint8Array([1, 2, 3]))
  assert.ok('recipients' in r)
  assert.equal(snode.calls.pubsubPublish.length, 1)
})

test('transport.publish: 缺 transport:publish 权限抛错', async () => {
  const snode = createSnodeMock()
  const api = createTransportApi(snode, makeManifest([]))
  await assert.rejects(() => api.publish('/t', new Uint8Array([1])), (err) => err instanceof PermissionDeniedError && err.permission === 'transport:publish')
})

test('transport.publish: data 非 Uint8Array 抛错', async () => {
  const snode = createSnodeMock()
  const api = createTransportApi(snode, makeManifest(['transport:publish']))
  await assert.rejects(() => api.publish('/t', 'not-bytes'), /data 必须是 Uint8Array/)
})

test('transport.publish: topic 不以 / 开头抛错', async () => {
  const snode = createSnodeMock()
  const api = createTransportApi(snode, makeManifest(['transport:publish']))
  await assert.rejects(() => api.publish('bad-topic', new Uint8Array([1])), /topic 必须以 \/ 开头/)
})

test('transport.publish: 禁止使用 market topic 前缀', async () => {
  const snode = createSnodeMock()
  const api = createTransportApi(snode, makeManifest(['transport:publish']))
  await assert.rejects(
    () => api.publish('/s-network/market/abc', new Uint8Array([1])),
    /禁止直接使用 market topic 前缀/,
  )
})

test('transport.subscribe: 委托 pubsub.subscribe + 记录到 _transportSubscriptions', async () => {
  const snode = createSnodeMock()
  const api = createTransportApi(snode, makeManifest(['transport:subscribe']))
  await api.subscribe('/havix-app/test', () => {})
  assert.ok(snode._transportSubscriptions.get('/havix-app/test').size > 0)
  assert.equal(snode.calls.pubsubSubscribe.length, 1)
})

test('transport.subscribe: callback 非函数抛错', async () => {
  const snode = createSnodeMock()
  const api = createTransportApi(snode, makeManifest(['transport:subscribe']))
  await assert.rejects(() => api.subscribe('/t', 'not-fn'), /callback 必须是函数/)
})

test('transport.unsubscribe: 清理 _transportSubscriptions', async () => {
  const snode = createSnodeMock()
  const api = createTransportApi(snode, makeManifest(['transport:subscribe']))
  await api.subscribe('/havix-app/test', () => {})
  await api.unsubscribe('/havix-app/test')
  assert.ok(!snode._transportSubscriptions.has('/havix-app/test'))
})

test('transport.TOPIC_PREFIX 常量暴露', () => {
  const snode = createSnodeMock()
  const api = createTransportApi(snode, makeManifest([]))
  assert.equal(api.TOPIC_PREFIX, '/havix-app/')
})
