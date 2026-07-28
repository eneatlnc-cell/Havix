// SPDX-License-Identifier: Apache-2.0

/**
 * arbitration API 单元测试（M9.2）
 * 覆盖 3 个权限门控 + file/summonPanel/vote/resolve + 只读查询。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSnodeMock } from '../__mocks__/snode-mock.js'
import { createArbitrationApi } from '../arbitration.js'
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

test('arbitration.file: 委托 snode.fileDispute + 返回 dispute', async () => {
  const snode = createSnodeMock()
  const api = createArbitrationApi(snode, makeManifest(['arbitration:file']))
  const { dispute } = await api.file({
    respondentDid: 'did:r',
    type: 'offer-breach',
    evidence: 'cid:evidence',
    stake: 10,
  })
  assert.equal(dispute.status, 'panel-summoning')
  assert.equal(dispute.respondent, 'did:r')
  assert.equal(snode.calls.fileDispute.length, 1)
})

test('arbitration.file: 缺 arbitration:file 权限抛错', async () => {
  const snode = createSnodeMock()
  const api = createArbitrationApi(snode, makeManifest([]))
  await assert.rejects(
    () => api.file({ respondentDid: 'did:r', type: 'offer-breach', stake: 10 }),
    (err) => err instanceof PermissionDeniedError && err.permission === 'arbitration:file',
  )
})

test('arbitration.file: 非法 type 抛错', async () => {
  const snode = createSnodeMock()
  const api = createArbitrationApi(snode, makeManifest(['arbitration:file']))
  await assert.rejects(
    () => api.file({ respondentDid: 'did:r', type: 'unknown', stake: 10 }),
    /type 必须是 offer-breach \/ relay-malice \/ vouch-collusion/,
  )
})

test('arbitration.file: stake <= 0 / NaN 抛错', async () => {
  const snode = createSnodeMock()
  const api = createArbitrationApi(snode, makeManifest(['arbitration:file']))
  await assert.rejects(() => api.file({ respondentDid: 'did:r', type: 'offer-breach', stake: 0 }), /stake 必须是 > 0 的有限数/)
  await assert.rejects(() => api.file({ respondentDid: 'did:r', type: 'offer-breach', stake: NaN }), /stake 必须是 > 0 的有限数/)
})

test('arbitration.summonPanel: 委托 snode.summonArbitrationPanel', async () => {
  const snode = createSnodeMock()
  const api = createArbitrationApi(snode, makeManifest(['arbitration:file']))
  const { dispute } = await api.file({ respondentDid: 'did:r', type: 'offer-breach', stake: 10 })
  const r = await api.summonPanel(dispute.disputeId)
  assert.equal(r.count, 3)
})

test('arbitration.vote: 委托 snode.castArbitrationVote', async () => {
  const snode = createSnodeMock()
  const api = createArbitrationApi(snode, makeManifest(['arbitration:file', 'arbitration:vote']))
  const { dispute } = await api.file({ respondentDid: 'did:r', type: 'offer-breach', stake: 10 })
  const r = await api.vote(dispute.disputeId, 'guilty')
  assert.equal(r.recorded, true)
})

test('arbitration.vote: 非法 vote 选项抛错', async () => {
  const snode = createSnodeMock()
  const api = createArbitrationApi(snode, makeManifest(['arbitration:vote']))
  await assert.rejects(
    () => api.vote('d1', 'invalid'),
    /vote 必须是 guilty \/ not-guilty \/ abstain/,
  )
})

test('arbitration.resolve: 委托 snode.resolveVerdict', async () => {
  const snode = createSnodeMock()
  const api = createArbitrationApi(snode, makeManifest(['arbitration:file', 'arbitration:resolve']))
  const { dispute } = await api.file({ respondentDid: 'did:r', type: 'offer-breach', stake: 10 })
  const verdict = await api.resolve(dispute.disputeId)
  assert.equal(verdict.verdict, 'guilty')
})

test('arbitration.resolve: 缺权限抛错', async () => {
  const snode = createSnodeMock()
  const api = createArbitrationApi(snode, makeManifest(['arbitration:file']))
  await assert.rejects(() => api.resolve('d1'), (err) => err instanceof PermissionDeniedError && err.permission === 'arbitration:resolve')
})

test('arbitration.treasuryBalance / treasuryHistory: 只读无门控', () => {
  const snode = createSnodeMock({ ledgers: { treasuryBalance: 100, treasuryHistory: [{ d: 'd1' }] } })
  const api = createArbitrationApi(snode, makeManifest([]))
  assert.equal(api.treasuryBalance(), 100)
  assert.equal(api.treasuryHistory().length, 1)
})

test('arbitration.checkJurorEligibility: 只读无门控', () => {
  const snode = createSnodeMock()
  const api = createArbitrationApi(snode, makeManifest([]))
  const r = api.checkJurorEligibility('did:juror')
  assert.equal(r.eligible, true)
})

test('arbitration.VALID_TYPES / VALID_VOTES 常量暴露', () => {
  const snode = createSnodeMock()
  const api = createArbitrationApi(snode, makeManifest([]))
  assert.deepEqual([...api.VALID_TYPES], ['offer-breach', 'relay-malice', 'vouch-collusion'])
  assert.deepEqual([...api.VALID_VOTES], ['guilty', 'not-guilty', 'abstain'])
})
