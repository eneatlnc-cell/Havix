// SPDX-License-Identifier: Apache-2.0

/**
 * market API 单元测试（M9.2）
 * 覆盖：
 *   - 6 个权限门控（market:create/invite/join/publish/subscribe/leave）
 *   - 参数校验
 *   - 委托 snode 调用 + 调用记录
 *   - list/isMember/getManifest 只读无权限门控
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSnodeMock } from '../__mocks__/snode-mock.js'
import { createMarketApi } from '../market.js'
import { AppManifest } from '../manifest.js'
import { PermissionDeniedError } from '../errors.js'

function makeManifest(permissions) {
  return new AppManifest({
    name: 'test-app',
    version: '1.0.0',
    capability: 'market',
    permissions,
    entryPoint: './index.js',
  })
}

const innerManifest = { name: 'inner', version: '1.0.0', capability: 'market', permissions: [], entryPoint: './index.js' }

test('market.create: 委托 snode.createMarket + 返回 marketId', async () => {
  const snode = createSnodeMock()
  const api = createMarketApi(snode, makeManifest(['market:create']))
  const result = await api.create({ manifest: innerManifest })
  assert.ok(result.marketId)
  assert.equal(snode.calls.createMarket.length, 1)
})

test('market.create: 缺 market:create 权限抛 PermissionDeniedError', async () => {
  const snode = createSnodeMock()
  const api = createMarketApi(snode, makeManifest([]))
  await assert.rejects(
    () => api.create({ manifest: innerManifest }),
    (err) => err instanceof PermissionDeniedError && err.permission === 'market:create' && err.code === 'PERMISSION_DENIED',
  )
})

test('market.create: 缺 manifest 参数抛错', async () => {
  const snode = createSnodeMock()
  const api = createMarketApi(snode, makeManifest(['market:create']))
  await assert.rejects(() => api.create({}), /manifest 参数必填/)
})

test('market.invite: 委托 snode.issueInvite', async () => {
  const snode = createSnodeMock()
  const api = createMarketApi(snode, makeManifest(['market:invite']))
  const created = await snode.createMarket({ manifest: innerManifest })
  const token = await api.invite(created.marketId, 'did:h:invitee', { ttlMs: 1000 })
  assert.equal(token.inviteeDid, 'did:h:invitee')
  assert.equal(snode.calls.issueInvite.length, 1)
})

test('market.invite: marketId 非法抛错', async () => {
  const snode = createSnodeMock()
  const api = createMarketApi(snode, makeManifest(['market:invite']))
  await assert.rejects(() => api.invite('', 'did:h:1'), /marketId 必须是非空字符串/)
})

test('market.join: 委托 snode.joinMarket', async () => {
  const snode = createSnodeMock()
  const api = createMarketApi(snode, makeManifest(['market:join']))
  const created = await snode.createMarket({ manifest: innerManifest })
  const result = await api.join(created.marketId, created.token)
  assert.ok(result.topic)
  assert.equal(snode.calls.joinMarket.length, 1)
})

test('market.join: token 非对象抛错', async () => {
  const snode = createSnodeMock()
  const api = createMarketApi(snode, makeManifest(['market:join']))
  await assert.rejects(() => api.join('m1', 'not-object'), /token 必须是对象/)
})

test('market.publish: 委托 snode.publishToMarket', async () => {
  const snode = createSnodeMock()
  const api = createMarketApi(snode, makeManifest(['market:publish']))
  const created = await snode.createMarket({ manifest: innerManifest })
  const result = await api.publish(created.marketId, { type: 'offer', payload: 'hello' })
  assert.ok(result.recipients >= 1)
  assert.equal(snode.calls.publishToMarket.length, 1)
})

test('market.publish: payload 非对象抛错', async () => {
  const snode = createSnodeMock()
  const api = createMarketApi(snode, makeManifest(['market:publish']))
  await assert.rejects(() => api.publish('m1', 'not-obj'), /payload 必须是对象/)
})

test('market.subscribe + unsubscribe: 委托 pubsub', async () => {
  const snode = createSnodeMock()
  const api = createMarketApi(snode, makeManifest(['market:subscribe']))
  const created = await snode.createMarket({ manifest: innerManifest })
  await api.subscribe(created.marketId, () => {})
  assert.ok(snode._marketSubscriptions.get(created.marketId).size > 0)
  await api.unsubscribe(created.marketId)
  assert.ok(!snode._marketSubscriptions.has(created.marketId))
})

test('market.subscribe: callback 非函数抛错', async () => {
  const snode = createSnodeMock()
  const api = createMarketApi(snode, makeManifest(['market:subscribe']))
  await assert.rejects(() => api.subscribe('m1', 'not-fn'), /callback 必须是函数/)
})

test('market.leave: 委托 snode.leaveMarket', async () => {
  const snode = createSnodeMock()
  const api = createMarketApi(snode, makeManifest(['market:leave']))
  const created = await snode.createMarket({ manifest: innerManifest })
  await api.leave(created.marketId)
  assert.equal(snode.calls.leaveMarket.length, 1)
})

test('market.list / isMember / getManifest: 只读无权限门控', async () => {
  const snode = createSnodeMock()
  const api = createMarketApi(snode, makeManifest([]))  // 空权限
  const created = await snode.createMarket({ manifest: innerManifest })
  assert.deepEqual(api.list(), [created.marketId])
  assert.equal(api.isMember(created.marketId), true)
  assert.equal(api.getManifest(created.marketId), innerManifest)
})

test('market.leave: 缺 market:leave 权限抛错', async () => {
  const snode = createSnodeMock()
  const api = createMarketApi(snode, makeManifest(['market:create']))
  await assert.rejects(() => api.leave('m1'), (err) => err instanceof PermissionDeniedError && err.permission === 'market:leave')
})
