// SPDX-License-Identifier: AGPL-3.0-only

/**
 * credit API 单元测试（M9.2）
 * 覆盖 4 个权限门控 + 参数校验 + 委托 snode + onReceived 回调。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSnodeMock } from '../__mocks__/snode-mock.js'
import { createCreditApi } from '../credit.js'
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

test('credit.issue: 委托 snode.issueCredit', async () => {
  const snode = createSnodeMock()
  const api = createCreditApi(snode, makeManifest(['credit:issue']))
  const { note, recipients } = await api.issue('did:h:1', 100, { prevNoteCid: 'cid:prev' })
  assert.equal(note.amount, 100)
  assert.equal(note.holderDid, 'did:h:1')
  assert.equal(recipients, 1)
  assert.equal(snode.calls.issueCredit.length, 1)
  assert.equal(snode.calls.issueCredit[0][0].prevNoteCid, 'cid:prev')
})

test('credit.issue: 缺 credit:issue 权限抛错', async () => {
  const snode = createSnodeMock()
  const api = createCreditApi(snode, makeManifest([]))
  await assert.rejects(() => api.issue('did:h:1', 100), (err) => err instanceof PermissionDeniedError && err.permission === 'credit:issue')
})

test('credit.issue: amount <= 0 抛错', async () => {
  const snode = createSnodeMock()
  const api = createCreditApi(snode, makeManifest(['credit:issue']))
  await assert.rejects(() => api.issue('did:h:1', 0), /amount 必须是 > 0 的有限数/)
  await assert.rejects(() => api.issue('did:h:1', -5), /amount 必须是 > 0 的有限数/)
})

test('credit.issue: amount NaN/Infinity 拒绝', async () => {
  const snode = createSnodeMock()
  const api = createCreditApi(snode, makeManifest(['credit:issue']))
  await assert.rejects(() => api.issue('did:h:1', NaN), /amount 必须是 > 0 的有限数/)
  await assert.rejects(() => api.issue('did:h:1', Infinity), /amount 必须是 > 0 的有限数/)
})

test('credit.consume: 委托 snode.consumeCredit', async () => {
  const snode = createSnodeMock()
  const api = createCreditApi(snode, makeManifest(['credit:issue', 'credit:consume']))
  await api.issue('did:h:1', 100)
  const r = await api.consume('did:h:1', 'did:i:1', 30)
  assert.equal(r.holderBalance, 70)
  assert.equal(r.releasedFrozen, 30)
})

test('credit.transfer: 委托 snode.transferCredit', async () => {
  const snode = createSnodeMock()
  const api = createCreditApi(snode, makeManifest(['credit:issue', 'credit:transfer']))
  await api.issue('did:a', 100)
  const r = await api.transfer('did:a', 'did:b', 40)
  assert.equal(r.fromBalance, 60)
  assert.equal(r.toBalance, 40)
})

test('credit.balance: 委托 snode.creditLedger.getBalance', async () => {
  const snode = createSnodeMock()
  const api = createCreditApi(snode, makeManifest(['credit:issue', 'credit:balance']))
  await api.issue('did:h:1', 50)
  assert.equal(api.balance('did:h:1'), 50)
  assert.equal(api.balance('did:nonexistent'), 0)
})

test('credit.onReceived: 注册回调到 snode._creditHandlers', () => {
  const snode = createSnodeMock()
  const api = createCreditApi(snode, makeManifest(['credit:balance']))
  const cb = () => {}
  api.onReceived(cb)
  assert.equal(snode._creditHandlers.length, 1)
  assert.equal(snode._creditHandlers[0], cb)
})

test('credit.onReceived: callback 非函数抛错', () => {
  const snode = createSnodeMock()
  const api = createCreditApi(snode, makeManifest(['credit:balance']))
  assert.throws(() => api.onReceived('not-fn'), /callback 必须是函数/)
})

test('credit.consume: 缺 credit:consume 权限抛错', async () => {
  const snode = createSnodeMock()
  const api = createCreditApi(snode, makeManifest(['credit:issue']))
  await assert.rejects(() => api.consume('did:h:1', 'did:i:1', 30), (err) => err instanceof PermissionDeniedError && err.permission === 'credit:consume')
})
