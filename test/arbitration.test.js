// SPDX-License-Identifier: Apache-2.0

/**
 * M6 临时仲裁团 + Slash 单元测试
 * ───────────────────────────────────────────────
 * 测试范围：
 *   - TreasuryLedger 存入与查询
 *   - ArbitrationRegistry 候选注册与资格检查
 *   - fileDispute 发起 dispute
 *   - summonPanel 召集仲裁团（信誉阈值 + vouch 阈值 + 排除关联 + 自举拒绝）
 *   - castVote 仲裁员投票（幂等 + 非仲裁员拒绝 + 已裁决拒绝）
 *   - resolveVerdict 多数裁决（≥3 票一致）+ slash 执行
 *   - Slash 只动 frozen 池不动 available（白皮书 §5.3）
 *   - 50% 赔受害者 + 50% 进金库
 *   - publishArbitration 广播到 /s-network/alert
 *   - SNode M6 集成（registerJurorCandidate / fileDispute / castArbitrationVote / resolveVerdict / treasury）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ArbitrationRegistry,
  TreasuryLedger,
  Dispute,
  DISPUTE_STATUS,
  VERDICT_VOTE,
  publishArbitration,
  ARBITRATION_TOPIC,
  DEFAULT_PANEL_SIZE,
  DEFAULT_VERDICT_MAJORITY,
  DEFAULT_REPUTATION_MULTIPLIER,
  DEFAULT_MIN_VOUCH_FOR_JUROR,
  DEFAULT_SLASH_RATIO,
  DisputeNotFoundError,
  JurorNotAuthorizedError,
  DisputeAlreadyResolvedError,
} from '../src/protocol/arbitration.js'
import { ReputationLedger, DEFAULT_INITIAL_REPUTATION } from '../src/protocol/credit.js'
import { VouchRegistry } from '../src/protocol/vouch.js'
import { IdentityWallet } from '../src/identity.js'
import { SNode } from '../src/s-node.js'

// 工具：构造 mock pubsub
function makeMockPubsub() {
  const calls = []
  return {
    calls,
    publish: async (topic, bytes) => {
      calls.push({ topic, bytes })
      return { recipients: [] }
    },
  }
}

// 工具：构造 wallet
async function makeWallet(seedByte) {
  const seed = new Uint8Array(32).fill(seedByte)
  return await IdentityWallet.fromSeed(seed)
}

// 工具：构造一个 ArbitrationRegistry，注入预设 ledger 与 vouchRegistry
// 测试用 reputationMultiplier=0，避开"3 个同质候选导致 median×1.5 > rep"的中位数严格性问题
// （isJurorEligible 门槛测试单独构造 reg 用默认 multiplier=1.5）
function makeRegistry({ ledger, vouchRegistry, panelSize = 5, verdictMajority = 3 }) {
  return new ArbitrationRegistry({
    reputationLedger: ledger,
    vouchRegistry,
    panelSize,
    verdictMajority,
    reputationMultiplier: 0,  // 测试用：门槛=0，任何正信誉都合格
    log: () => {},
  })
}

// ──────────────────────────────────────────────
// 默认常量
// ──────────────────────────────────────────────

test('Arbitration：默认常量与白皮书 §5 一致', () => {
  assert.equal(DEFAULT_PANEL_SIZE, 5, '仲裁团 5 节点')
  assert.equal(DEFAULT_VERDICT_MAJORITY, 3, '多数阈值 ≥3 票')
  assert.equal(DEFAULT_REPUTATION_MULTIPLIER, 1.5, '信誉门槛 中位数 × 1.5')
  assert.equal(DEFAULT_MIN_VOUCH_FOR_JUROR, 10, 'vouch ≥ 10')
  assert.equal(DEFAULT_SLASH_RATIO, 0.5, '50% 赔受害者 + 50% 进金库')
  assert.equal(ARBITRATION_TOPIC, '/s-network/alert')
})

test('DISPUTE_STATUS / VERDICT_VOTE：frozen 常量', () => {
  assert.equal(DISPUTE_STATUS.PENDING, 'pending')
  assert.equal(DISPUTE_STATUS.PANEL_FORMED, 'panel-formed')
  assert.equal(DISPUTE_STATUS.VOTING, 'voting')
  assert.equal(DISPUTE_STATUS.RESOLVED, 'resolved')
  assert.equal(VERDICT_VOTE.GUILTY, 'guilty')
  assert.equal(VERDICT_VOTE.NOT_GUILTY, 'not-guilty')
  assert.equal(VERDICT_VOTE.ABSTAIN, 'abstain')
})

// ──────────────────────────────────────────────
// TreasuryLedger
// ──────────────────────────────────────────────

test('TreasuryLedger：初始余额 0', () => {
  const t = new TreasuryLedger()
  assert.equal(t.getBalance(), 0)
  assert.deepEqual(t.getHistory(), [])
})

test('TreasuryLedger.deposit：存入累加', () => {
  const t = new TreasuryLedger()
  t.deposit({ from: 'did:havix:A:bad', amount: 5, reason: 'test1', disputeId: 'd1' })
  assert.equal(t.getBalance(), 5)
  t.deposit({ from: 'did:havix:A:bad', amount: 3, reason: 'test2', disputeId: 'd2' })
  assert.equal(t.getBalance(), 8)
  assert.equal(t.getHistory().length, 2)
})

test('TreasuryLedger.deposit：金额必须正数', () => {
  const t = new TreasuryLedger()
  assert.throws(() => t.deposit({ from: 'a', amount: 0 }), /正数/)
  assert.throws(() => t.deposit({ from: 'a', amount: -1 }), /正数/)
})

test('TreasuryLedger.getHistory：按 disputeId 过滤', () => {
  const t = new TreasuryLedger()
  t.deposit({ from: 'a', amount: 5, reason: 'r1', disputeId: 'd1' })
  t.deposit({ from: 'b', amount: 3, reason: 'r2', disputeId: 'd2' })
  t.deposit({ from: 'c', amount: 2, reason: 'r3', disputeId: 'd1' })
  const d1 = t.getHistory('d1')
  assert.equal(d1.length, 2)
  assert.equal(d1[0].disputeId, 'd1')
})

// ──────────────────────────────────────────────
// ArbitrationRegistry 构造
// ──────────────────────────────────────────────

test('ArbitrationRegistry：必需参数校验', () => {
  assert.throws(() => new ArbitrationRegistry({}), /reputationLedger 必需/)
  const ledger = new ReputationLedger()
  assert.throws(() => new ArbitrationRegistry({ reputationLedger: ledger }), /vouchRegistry 必需/)
})

test('ArbitrationRegistry：默认参数', () => {
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry()
  const reg = new ArbitrationRegistry({ reputationLedger: ledger, vouchRegistry: vouch })
  assert.equal(reg.panelSize, DEFAULT_PANEL_SIZE)
  assert.equal(reg.verdictMajority, DEFAULT_VERDICT_MAJORITY)
  assert.equal(reg.reputationMultiplier, DEFAULT_REPUTATION_MULTIPLIER)
  assert.equal(reg.minVouchForJuror, DEFAULT_MIN_VOUCH_FOR_JUROR)
  assert.equal(reg.slashRatio, DEFAULT_SLASH_RATIO)
  assert.ok(reg.treasury instanceof TreasuryLedger)
})

test('ArbitrationRegistry：自定义参数', () => {
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry()
  const reg = new ArbitrationRegistry({
    reputationLedger: ledger, vouchRegistry: vouch,
    panelSize: 7, verdictMajority: 4, slashRatio: 0.3,
  })
  assert.equal(reg.panelSize, 7)
  assert.equal(reg.verdictMajority, 4)
  assert.equal(reg.slashRatio, 0.3)
})

// ──────────────────────────────────────────────
// 候选注册与资格检查
// ──────────────────────────────────────────────

test('ArbitrationRegistry.registerJurorCandidate：从 ledger 与 vouchRegistry 读取', () => {
  // initialReputation=0 让 credit 数值可预期（默认 1.0 会让 credit(50) → available=51）
  const ledger = new ReputationLedger({ initialReputation: 0 })
  ledger.credit('did:havix:A:alice', 50)
  const vouch = new VouchRegistry({ threshold: 1 })
  // 给 alice 累积 12 个 vouch（高于阈值 10）
  for (let i = 0; i < 12; i++) {
    vouch.addVouch('did:havix:A:alice', `did:havix:A:v${i}`)
  }
  const reg = makeRegistry({ ledger, vouchRegistry: vouch })

  const r = reg.registerJurorCandidate('did:havix:A:alice')
  assert.equal(r.registered, true)
  assert.equal(r.eligible, true, '信誉 50 > 中位数 50×1.5=75？不对——需用 median×1.5')

  // isJurorEligible 应返回详细信息
  const info = reg.isJurorEligible('did:havix:A:alice')
  assert.equal(info.eligible, r.eligible)
  assert.equal(info.reputation, 50)
  assert.equal(info.vouchCount, 12)
})

test('ArbitrationRegistry.registerJurorCandidate：did 无效拒绝', () => {
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry()
  const reg = makeRegistry({ ledger, vouchRegistry: vouch })
  assert.equal(reg.registerJurorCandidate('').registered, false)
  assert.equal(reg.registerJurorCandidate(null).registered, false)
})

test('ArbitrationRegistry.isJurorEligible：未注册返回 false', () => {
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry()
  const reg = makeRegistry({ ledger, vouchRegistry: vouch })
  const info = reg.isJurorEligible('did:havix:A:unknown')
  assert.equal(info.eligible, false)
  assert.match(info.reason, /未注册/)
})

test('ArbitrationRegistry.isJurorEligible：vouch 不足时拒绝', () => {
  const ledger = new ReputationLedger()
  ledger.credit('did:havix:A:alice', 1000)
  const vouch = new VouchRegistry({ threshold: 1 })
  // alice 只有 5 个 vouch（< 10）
  for (let i = 0; i < 5; i++) {
    vouch.addVouch('did:havix:A:alice', `did:havix:A:v${i}`)
  }
  const reg = makeRegistry({ ledger, vouchRegistry: vouch })
  reg.registerJurorCandidate('did:havix:A:alice')
  const info = reg.isJurorEligible('did:havix:A:alice')
  assert.equal(info.eligible, false)
  assert.match(info.reason, /vouch/)
})

test('ArbitrationRegistry.isJurorEligible：信誉不足时拒绝', () => {
  // 此测试专门验证"信誉 > 中位数 × 1.5"门槛，故直接构造 reg 用默认 multiplier=1.5
  // （makeRegistry 用 multiplier=0 会绕过门槛，不适合本测试）
  const ledger = new ReputationLedger({ initialReputation: 0 })
  // 5 个高信誉候选（rep=100）
  for (let i = 0; i < 5; i++) {
    ledger.credit(`did:havix:A:high${i}`, 100)
  }
  ledger.credit('did:havix:A:alice', 10)  // 信誉很低
  const vouch = new VouchRegistry({ threshold: 1 })
  for (let i = 0; i < 12; i++) {
    vouch.addVouch('did:havix:A:alice', `did:havix:A:v${i}`)
  }
  const reg = new ArbitrationRegistry({
    reputationLedger: ledger, vouchRegistry: vouch,
    // 用默认 multiplier=1.5（不传则用 DEFAULT_REPUTATION_MULTIPLIER）
    log: () => {},
  })
  // 注册全部
  for (let i = 0; i < 5; i++) reg.registerJurorCandidate(`did:havix:A:high${i}`)
  reg.registerJurorCandidate('did:havix:A:alice')
  const info = reg.isJurorEligible('did:havix:A:alice')
  // 中位数 = 100，门槛 = 150，alice 10 < 150
  assert.equal(info.eligible, false)
  assert.match(info.reason, /信誉/)
})

// ──────────────────────────────────────────────
// fileDispute
// ──────────────────────────────────────────────

test('ArbitrationRegistry.fileDispute：基本参数', () => {
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry()
  const reg = makeRegistry({ ledger, vouchRegistry: vouch })
  const { dispute } = reg.fileDispute({
    claimant: 'did:havix:A:alice',
    respondent: 'did:havix:A:bob',
    type: 'offer-breach',
    amount: 10,
  })
  assert.ok(dispute.disputeId)
  assert.equal(dispute.claimant, 'did:havix:A:alice')
  assert.equal(dispute.respondent, 'did:havix:A:bob')
  assert.equal(dispute.type, 'offer-breach')
  assert.equal(dispute.amount, 10)
  assert.equal(dispute.status, DISPUTE_STATUS.PENDING)
  assert.equal(reg.listDisputes().length, 1)
})

test('ArbitrationRegistry.fileDispute：三种 type 合法', () => {
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry()
  const reg = makeRegistry({ ledger, vouchRegistry: vouch })
  for (const type of ['offer-breach', 'relay-malice', 'vouch-collusion']) {
    reg.fileDispute({
      claimant: 'did:havix:A:a', respondent: `did:havix:A:b-${type}`,
      type, amount: 1,
    })
  }
  assert.equal(reg.listDisputes().length, 3)
})

test('ArbitrationRegistry.fileDispute：参数校验', () => {
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry()
  const reg = makeRegistry({ ledger, vouchRegistry: vouch })
  assert.throws(() => reg.fileDispute({ respondent: 'b', type: 'offer-breach', amount: 1 }), /claimant/)
  assert.throws(() => reg.fileDispute({ claimant: 'a', type: 'offer-breach', amount: 1 }), /respondent/)
  assert.throws(() => reg.fileDispute({ claimant: 'a', respondent: 'a', type: 'offer-breach', amount: 1 }), /不能相同/)
  assert.throws(() => reg.fileDispute({ claimant: 'a', respondent: 'b', amount: 1 }), /type/)
  assert.throws(() => reg.fileDispute({ claimant: 'a', respondent: 'b', type: 'invalid' }), /type/)
  assert.throws(() => reg.fileDispute({ claimant: 'a', respondent: 'b', type: 'offer-breach' }), /amount/)
  assert.throws(() => reg.fileDispute({ claimant: 'a', respondent: 'b', type: 'offer-breach', amount: 0 }), /amount/)
})

test('ArbitrationRegistry.fileDispute：重复 disputeId 拒绝', () => {
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry()
  const reg = makeRegistry({ ledger, vouchRegistry: vouch })
  reg.fileDispute({
    disputeId: 'd1', claimant: 'a', respondent: 'b',
    type: 'offer-breach', amount: 1,
  })
  assert.throws(() => reg.fileDispute({
    disputeId: 'd1', claimant: 'a', respondent: 'b',
    type: 'offer-breach', amount: 1,
  }), /已存在/)
})

// ──────────────────────────────────────────────
// summonPanel
// ──────────────────────────────────────────────

test('ArbitrationRegistry.summonPanel：召集合格候选', () => {
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry({ threshold: 1 })
  // 构造 7 个候选：5 个高信誉高 vouch，2 个低信誉
  for (let i = 0; i < 5; i++) {
    ledger.credit(`did:havix:A:h${i}`, 100)
    for (let j = 0; j < 12; j++) {
      vouch.addVouch(`did:havix:A:h${i}`, `did:havix:A:v${i}-${j}`)
    }
  }
  ledger.credit('did:havix:A:low1', 1)
  ledger.credit('did:havix:A:low2', 1)

  const reg = makeRegistry({ ledger, vouchRegistry: vouch, panelSize: 3 })
  for (let i = 0; i < 5; i++) reg.registerJurorCandidate(`did:havix:A:h${i}`)
  reg.registerJurorCandidate('did:havix:A:low1')
  reg.registerJurorCandidate('did:havix:A:low2')

  // 发起 dispute
  const { dispute } = reg.fileDispute({
    claimant: 'did:havix:A:claimant', respondent: 'did:havix:A:respondent',
    type: 'offer-breach', amount: 5,
  })

  const r = reg.summonPanel(dispute.disputeId, () => 0.5)  // 固定 rng，便于复现
  assert.ok(r.panel.length <= 3, `panel 应 ≤ panelSize=3，实际 ${r.panel.length}`)
  // 全部 panel 成员都应是高信誉
  for (const did of r.panel) {
    assert.match(did, /did:havix:A:h\d/, `panel 成员 ${did} 应是高信誉候选`)
  }
  // dispute 状态应更新
  assert.equal(dispute.status, DISPUTE_STATUS.PANEL_FORMED)
  assert.ok(dispute.panelFormedAt > 0)
})

test('ArbitrationRegistry.summonPanel：自举拒绝（claimant/respondent 不能入团）', () => {
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry({ threshold: 1 })
  // claimant 是高信誉
  ledger.credit('did:havix:A:claimant', 100)
  for (let i = 0; i < 12; i++) {
    vouch.addVouch('did:havix:A:claimant', `did:havix:A:v${i}`)
  }
  const reg = makeRegistry({ ledger, vouchRegistry: vouch, panelSize: 3 })
  reg.registerJurorCandidate('did:havix:A:claimant')

  const { dispute } = reg.fileDispute({
    claimant: 'did:havix:A:claimant', respondent: 'did:havix:A:respondent',
    type: 'offer-breach', amount: 5,
  })
  const r = reg.summonPanel(dispute.disputeId, () => 0.5)
  assert.ok(!r.panel.includes('did:havix:A:claimant'), 'claimant 不能进自己的仲裁团')
  assert.ok(r.excluded.includes('did:havix:A:claimant'), 'claimant 应在 excluded 列表')
})

test('ArbitrationRegistry.summonPanel：vouch 关联排除（防串谋）', () => {
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry({ threshold: 1 })
  // 构造一个与 claimant 有 vouch 关联的候选（曾 vouch 过 claimant）
  ledger.credit('did:havix:A:friend', 100)
  for (let i = 0; i < 12; i++) {
    vouch.addVouch('did:havix:A:friend', `did:havix:A:v${i}`)
  }
  // friend 曾 vouch 过 claimant
  vouch.addVouch('did:havix:A:claimant', 'did:havix:A:friend')

  // 另一个无关联的高信誉候选
  ledger.credit('did:havix:A:independent', 100)
  for (let i = 0; i < 12; i++) {
    vouch.addVouch('did:havix:A:independent', `did:havix:A:w${i}`)
  }

  const reg = makeRegistry({ ledger, vouchRegistry: vouch, panelSize: 3 })
  reg.registerJurorCandidate('did:havix:A:friend')
  reg.registerJurorCandidate('did:havix:A:independent')

  const { dispute } = reg.fileDispute({
    claimant: 'did:havix:A:claimant', respondent: 'did:havix:A:respondent',
    type: 'offer-breach', amount: 5,
  })
  const r = reg.summonPanel(dispute.disputeId, () => 0.5)
  // friend 因 vouch 关联应被排除
  assert.ok(r.excluded.includes('did:havix:A:friend'), 'friend 与 claimant 有 vouch 关联应被排除')
  assert.ok(!r.panel.includes('did:havix:A:friend'), 'friend 不应入团')
  // independent 应可以入团
  assert.ok(r.panel.includes('did:havix:A:independent'), 'independent 无关联应入团')
})

test('ArbitrationRegistry.summonPanel：respondent 的 vouch 关联也排除', () => {
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry({ threshold: 1 })
  // 候选 buddy 曾 vouch 过 respondent
  ledger.credit('did:havix:A:buddy', 100)
  for (let i = 0; i < 12; i++) {
    vouch.addVouch('did:havix:A:buddy', `did:havix:A:v${i}`)
  }
  vouch.addVouch('did:havix:A:respondent', 'did:havix:A:buddy')

  // 无关联候选
  ledger.credit('did:havix:A:independent', 100)
  for (let i = 0; i < 12; i++) {
    vouch.addVouch('did:havix:A:independent', `did:havix:A:w${i}`)
  }

  const reg = makeRegistry({ ledger, vouchRegistry: vouch, panelSize: 3 })
  reg.registerJurorCandidate('did:havix:A:buddy')
  reg.registerJurorCandidate('did:havix:A:independent')

  const { dispute } = reg.fileDispute({
    claimant: 'did:havix:A:claimant', respondent: 'did:havix:A:respondent',
    type: 'offer-breach', amount: 5,
  })
  const r = reg.summonPanel(dispute.disputeId, () => 0.5)
  assert.ok(r.excluded.includes('did:havix:A:buddy'), 'buddy 与 respondent 有 vouch 关联应被排除')
})

test('ArbitrationRegistry.summonPanel：未知 dispute 抛错', () => {
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry()
  const reg = makeRegistry({ ledger, vouchRegistry: vouch })
  assert.throws(() => reg.summonPanel('unknown'), (err) => {
    assert.equal(err.name, 'DisputeNotFoundError')
    return true
  })
})

test('ArbitrationRegistry.summonPanel：状态非 PENDING 拒绝', () => {
  const ledger = new ReputationLedger()
  ledger.credit('did:havix:A:j1', 100)
  const vouch = new VouchRegistry({ threshold: 1 })
  for (let i = 0; i < 12; i++) vouch.addVouch('did:havix:A:j1', `did:havix:A:v${i}`)
  const reg = makeRegistry({ ledger, vouchRegistry: vouch, panelSize: 3 })
  reg.registerJurorCandidate('did:havix:A:j1')
  const { dispute } = reg.fileDispute({
    claimant: 'a', respondent: 'b', type: 'offer-breach', amount: 1,
  })
  reg.summonPanel(dispute.disputeId)
  // 再次召集应抛错
  assert.throws(() => reg.summonPanel(dispute.disputeId), /状态/)
})

test('ArbitrationRegistry.summonPanel：无合格候选返回空 panel', () => {
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry()
  const reg = makeRegistry({ ledger, vouchRegistry: vouch })
  // 不注册任何候选
  const { dispute } = reg.fileDispute({
    claimant: 'a', respondent: 'b', type: 'offer-breach', amount: 1,
  })
  const r = reg.summonPanel(dispute.disputeId)
  assert.equal(r.panel.length, 0)
  assert.equal(r.count, 0)
})

// ──────────────────────────────────────────────
// castVote
// ──────────────────────────────────────────────

test('ArbitrationRegistry.castVote：基本投票', () => {
  const ledger = new ReputationLedger()
  ledger.credit('did:havix:A:j1', 100)
  const vouch = new VouchRegistry({ threshold: 1 })
  for (let i = 0; i < 12; i++) vouch.addVouch('did:havix:A:j1', `did:havix:A:v${i}`)
  const reg = makeRegistry({ ledger, vouchRegistry: vouch, panelSize: 3 })
  reg.registerJurorCandidate('did:havix:A:j1')
  const { dispute } = reg.fileDispute({
    claimant: 'a', respondent: 'b', type: 'offer-breach', amount: 1,
  })
  reg.summonPanel(dispute.disputeId)
  // j1 在 panel 中
  if (dispute.panel.includes('did:havix:A:j1')) {
    const r = reg.castVote({ disputeId: dispute.disputeId, jurorDid: 'did:havix:A:j1', vote: VERDICT_VOTE.GUILTY })
    assert.equal(r.recorded, true)
    assert.equal(r.vote, 'guilty')
    assert.equal(dispute.votes.size, 1)
    assert.equal(dispute.status, DISPUTE_STATUS.VOTING)
  }
})

test('ArbitrationRegistry.castVote：非 panel 成员拒绝', () => {
  const ledger = new ReputationLedger()
  ledger.credit('did:havix:A:j1', 100)
  const vouch = new VouchRegistry({ threshold: 1 })
  for (let i = 0; i < 12; i++) vouch.addVouch('did:havix:A:j1', `did:havix:A:v${i}`)
  const reg = makeRegistry({ ledger, vouchRegistry: vouch, panelSize: 3 })
  reg.registerJurorCandidate('did:havix:A:j1')
  const { dispute } = reg.fileDispute({
    claimant: 'a', respondent: 'b', type: 'offer-breach', amount: 1,
  })
  reg.summonPanel(dispute.disputeId)
  // 不在 panel 中的人投票应抛错
  assert.throws(() => reg.castVote({
    disputeId: dispute.disputeId,
    jurorDid: 'did:havix:A:intruder',
    vote: 'guilty',
  }), (err) => {
    assert.equal(err.name, 'JurorNotAuthorizedError')
    return true
  })
})

test('ArbitrationRegistry.castVote：重复投票幂等（覆盖最新）', () => {
  const ledger = new ReputationLedger()
  ledger.credit('did:havix:A:j1', 100)
  const vouch = new VouchRegistry({ threshold: 1 })
  for (let i = 0; i < 12; i++) vouch.addVouch('did:havix:A:j1', `did:havix:A:v${i}`)
  const reg = makeRegistry({ ledger, vouchRegistry: vouch, panelSize: 3 })
  reg.registerJurorCandidate('did:havix:A:j1')
  const { dispute } = reg.fileDispute({
    claimant: 'a', respondent: 'b', type: 'offer-breach', amount: 1,
  })
  reg.summonPanel(dispute.disputeId)
  if (dispute.panel.includes('did:havix:A:j1')) {
    reg.castVote({ disputeId: dispute.disputeId, jurorDid: 'did:havix:A:j1', vote: 'guilty' })
    // 改投 not-guilty（覆盖）
    reg.castVote({ disputeId: dispute.disputeId, jurorDid: 'did:havix:A:j1', vote: 'not-guilty' })
    assert.equal(dispute.votes.size, 1, '重复投票只记一次')
    assert.equal(dispute.votes.get('did:havix:A:j1'), 'not-guilty', '应覆盖为最新')
  }
})

test('ArbitrationRegistry.castVote：无效 vote 拒绝', () => {
  const ledger = new ReputationLedger()
  ledger.credit('did:havix:A:j1', 100)
  const vouch = new VouchRegistry({ threshold: 1 })
  for (let i = 0; i < 12; i++) vouch.addVouch('did:havix:A:j1', `did:havix:A:v${i}`)
  const reg = makeRegistry({ ledger, vouchRegistry: vouch, panelSize: 3 })
  reg.registerJurorCandidate('did:havix:A:j1')
  const { dispute } = reg.fileDispute({
    claimant: 'a', respondent: 'b', type: 'offer-breach', amount: 1,
  })
  reg.summonPanel(dispute.disputeId)
  if (dispute.panel.includes('did:havix:A:j1')) {
    const r = reg.castVote({
      disputeId: dispute.disputeId,
      jurorDid: 'did:havix:A:j1',
      vote: 'invalid-vote',
    })
    assert.equal(r.recorded, false)
    assert.match(r.reason, /vote 必须是/)
  }
})

test('ArbitrationRegistry.castVote：未知 dispute 抛错', () => {
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry()
  const reg = makeRegistry({ ledger, vouchRegistry: vouch })
  assert.throws(() => reg.castVote({
    disputeId: 'unknown', jurorDid: 'a', vote: 'guilty',
  }), (err) => {
    assert.equal(err.name, 'DisputeNotFoundError')
    return true
  })
})

// ──────────────────────────────────────────────
// resolveVerdict
// ──────────────────────────────────────────────

test('ArbitrationRegistry.resolveVerdict：未达多数不裁决', () => {
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry({ threshold: 1 })
  // 构造 3 个合格候选
  for (let i = 0; i < 3; i++) {
    ledger.credit(`did:havix:A:j${i}`, 100)
    for (let k = 0; k < 12; k++) vouch.addVouch(`did:havix:A:j${i}`, `did:havix:A:v${i}-${k}`)
  }
  const reg = makeRegistry({ ledger, vouchRegistry: vouch, panelSize: 3, verdictMajority: 3 })
  for (let i = 0; i < 3; i++) reg.registerJurorCandidate(`did:havix:A:j${i}`)
  const { dispute } = reg.fileDispute({
    claimant: 'a', respondent: 'b', type: 'offer-breach', amount: 1,
  })
  reg.summonPanel(dispute.disputeId, () => 0.5)

  // 只投 2 票（< 3）
  let voted = 0
  for (const juror of dispute.panel) {
    if (voted >= 2) break
    reg.castVote({ disputeId: dispute.disputeId, jurorDid: juror, vote: 'guilty' })
    voted++
  }
  const r = reg.resolveVerdict(dispute.disputeId)
  assert.equal(r.resolved, false)
  assert.match(r.reason, /票数不足/)
  assert.equal(dispute.status, DISPUTE_STATUS.VOTING)
})

test('ArbitrationRegistry.resolveVerdict：guilty 多数裁决 + slash 执行', () => {
  // initialReputation=0 让 available/total 数值可预期
  const ledger = new ReputationLedger({ initialReputation: 0 })
  // respondent 先 credit 一笔信誉，然后 freeze 一部分（用于 slash）
  ledger.credit('did:havix:A:respondent', 100)
  ledger.freeze('did:havix:A:respondent', 20)  // 冻结 20
  // claimant 也有信誉
  ledger.credit('did:havix:A:claimant', 50)
  const vouch = new VouchRegistry({ threshold: 1 })
  for (let i = 0; i < 3; i++) {
    ledger.credit(`did:havix:A:j${i}`, 100)
    for (let k = 0; k < 12; k++) vouch.addVouch(`did:havix:A:j${i}`, `did:havix:A:v${i}-${k}`)
  }
  const reg = makeRegistry({ ledger, vouchRegistry: vouch, panelSize: 3, verdictMajority: 3 })
  for (let i = 0; i < 3; i++) reg.registerJurorCandidate(`did:havix:A:j${i}`)

  const { dispute } = reg.fileDispute({
    claimant: 'did:havix:A:claimant',
    respondent: 'did:havix:A:respondent',
    type: 'offer-breach',
    amount: 10,
  })
  reg.summonPanel(dispute.disputeId, () => 0.5)

  // 3 票 guilty
  for (const juror of dispute.panel) {
    reg.castVote({ disputeId: dispute.disputeId, jurorDid: juror, vote: 'guilty' })
  }
  const r = reg.resolveVerdict(dispute.disputeId)
  assert.equal(r.resolved, true)
  assert.equal(r.verdict, 'guilty')
  assert.equal(r.slashExecuted, true)
  assert.equal(r.slashDetail.slashAmount, 10)
  assert.equal(r.slashDetail.victimCompensation, 5)  // 50% 赔受害者
  assert.equal(r.slashDetail.treasuryDeposit, 5)    // 50% 进金库
  assert.equal(r.slashDetail.frozenBefore, 20)
  assert.equal(r.slashDetail.frozenAfter, 10)

  // respondent frozen 减少 10
  const rep = ledger.get('did:havix:A:respondent')
  assert.equal(rep.frozen, 10, 'slash 只动 frozen，扣 10')
  assert.equal(rep.available, 80, 'available 不变')

  // claimant available 增加 5
  const claimantRep = ledger.get('did:havix:A:claimant')
  assert.equal(claimantRep.available, 55, 'claimant 获赔 5')

  // 金库余额 5
  assert.equal(reg.treasury.getBalance(), 5)
  assert.equal(reg.treasury.getHistory().length, 1)
})

test('ArbitrationRegistry.resolveVerdict：not-guilty 多数裁决不执行 slash', () => {
  const ledger = new ReputationLedger()
  ledger.credit('did:havix:A:respondent', 100)
  ledger.freeze('did:havix:A:respondent', 20)
  const vouch = new VouchRegistry({ threshold: 1 })
  for (let i = 0; i < 3; i++) {
    ledger.credit(`did:havix:A:j${i}`, 100)
    for (let k = 0; k < 12; k++) vouch.addVouch(`did:havix:A:j${i}`, `did:havix:A:v${i}-${k}`)
  }
  const reg = makeRegistry({ ledger, vouchRegistry: vouch, panelSize: 3, verdictMajority: 3 })
  for (let i = 0; i < 3; i++) reg.registerJurorCandidate(`did:havix:A:j${i}`)

  const { dispute } = reg.fileDispute({
    claimant: 'did:havix:A:claimant',
    respondent: 'did:havix:A:respondent',
    type: 'offer-breach',
    amount: 10,
  })
  reg.summonPanel(dispute.disputeId, () => 0.5)

  // 3 票 not-guilty
  for (const juror of dispute.panel) {
    reg.castVote({ disputeId: dispute.disputeId, jurorDid: juror, vote: 'not-guilty' })
  }
  const r = reg.resolveVerdict(dispute.disputeId)
  assert.equal(r.resolved, true)
  assert.equal(r.verdict, 'not-guilty')
  assert.equal(r.slashExecuted, false)
  assert.equal(r.slashDetail, null)

  // respondent frozen 不变
  const rep = ledger.get('did:havix:A:respondent')
  assert.equal(rep.frozen, 20, 'not-guilty 不执行 slash')
  // 金库余额 0
  assert.equal(reg.treasury.getBalance(), 0)
})

test('ArbitrationRegistry.resolveVerdict：abstain 不计入多数', () => {
  const ledger = new ReputationLedger()
  ledger.credit('did:havix:A:respondent', 100)
  ledger.freeze('did:havix:A:respondent', 20)
  const vouch = new VouchRegistry({ threshold: 1 })
  for (let i = 0; i < 3; i++) {
    ledger.credit(`did:havix:A:j${i}`, 100)
    for (let k = 0; k < 12; k++) vouch.addVouch(`did:havix:A:j${i}`, `did:havix:A:v${i}-${k}`)
  }
  const reg = makeRegistry({ ledger, vouchRegistry: vouch, panelSize: 3, verdictMajority: 3 })
  for (let i = 0; i < 3; i++) reg.registerJurorCandidate(`did:havix:A:j${i}`)

  const { dispute } = reg.fileDispute({
    claimant: 'a', respondent: 'did:havix:A:respondent',
    type: 'offer-breach', amount: 10,
  })
  reg.summonPanel(dispute.disputeId, () => 0.5)

  // 2 票 guilty + 1 票 abstain（不足 3 票一致）
  const panel = dispute.panel
  reg.castVote({ disputeId: dispute.disputeId, jurorDid: panel[0], vote: 'guilty' })
  reg.castVote({ disputeId: dispute.disputeId, jurorDid: panel[1], vote: 'guilty' })
  reg.castVote({ disputeId: dispute.disputeId, jurorDid: panel[2], vote: 'abstain' })
  const r = reg.resolveVerdict(dispute.disputeId)
  assert.equal(r.resolved, false, 'abstain 不计入多数，2 票 guilty 不足')
})

test('ArbitrationRegistry.resolveVerdict：frozen 不足时只扣到 0', () => {
  const ledger = new ReputationLedger()
  ledger.credit('did:havix:A:respondent', 100)
  ledger.freeze('did:havix:A:respondent', 3)  // 只冻结 3，但 dispute 索赔 10
  const vouch = new VouchRegistry({ threshold: 1 })
  for (let i = 0; i < 3; i++) {
    ledger.credit(`did:havix:A:j${i}`, 100)
    for (let k = 0; k < 12; k++) vouch.addVouch(`did:havix:A:j${i}`, `did:havix:A:v${i}-${k}`)
  }
  const reg = makeRegistry({ ledger, vouchRegistry: vouch, panelSize: 3, verdictMajority: 3 })
  for (let i = 0; i < 3; i++) reg.registerJurorCandidate(`did:havix:A:j${i}`)

  const { dispute } = reg.fileDispute({
    claimant: 'did:havix:A:claimant',
    respondent: 'did:havix:A:respondent',
    type: 'offer-breach',
    amount: 10,
  })
  reg.summonPanel(dispute.disputeId, () => 0.5)
  for (const juror of dispute.panel) {
    reg.castVote({ disputeId: dispute.disputeId, jurorDid: juror, vote: 'guilty' })
  }
  const r = reg.resolveVerdict(dispute.disputeId)
  assert.equal(r.slashDetail.slashAmount, 3, 'frozen 不足时只扣到实际 frozen=3')
  assert.equal(r.slashDetail.victimCompensation, 1.5)
  assert.equal(r.slashDetail.treasuryDeposit, 1.5)
  assert.equal(r.slashDetail.frozenBefore, 3)
  assert.equal(r.slashDetail.frozenAfter, 0)

  // respondent frozen 归 0
  const rep = ledger.get('did:havix:A:respondent')
  assert.equal(rep.frozen, 0)
  assert.equal(reg.treasury.getBalance(), 1.5)
})

test('ArbitrationRegistry.resolveVerdict：P0-6 frozen=0 时不崩溃', () => {
  // P0-6 修复：respondent frozen=0 时 slash 不应崩溃，仅记录裁决
  const ledger = new ReputationLedger()
  ledger.credit('did:havix:A:respondent', 100)
  // 不 freeze 任何信誉 → frozen=0
  const vouch = new VouchRegistry({ threshold: 1 })
  for (let i = 0; i < 3; i++) {
    ledger.credit(`did:havix:A:j${i}`, 100)
    for (let k = 0; k < 12; k++) vouch.addVouch(`did:havix:A:j${i}`, `did:havix:A:v${i}-${k}`)
  }
  const reg = makeRegistry({ ledger, vouchRegistry: vouch, panelSize: 3, verdictMajority: 3 })
  for (let i = 0; i < 3; i++) reg.registerJurorCandidate(`did:havix:A:j${i}`)

  const { dispute } = reg.fileDispute({
    claimant: 'did:havix:A:claimant',
    respondent: 'did:havix:A:respondent',
    type: 'offer-breach',
    amount: 10,
  })
  reg.summonPanel(dispute.disputeId, () => 0.5)
  for (const juror of dispute.panel) {
    reg.castVote({ disputeId: dispute.disputeId, jurorDid: juror, vote: 'guilty' })
  }
  // 不应抛错
  const r = reg.resolveVerdict(dispute.disputeId)
  assert.equal(r.resolved, true)
  assert.equal(r.slashExecuted, true)
  assert.equal(r.slashDetail.slashAmount, 0, 'frozen=0 → actualSlash=0')
  assert.equal(r.slashDetail.victimCompensation, 0)
  assert.equal(r.slashDetail.treasuryDeposit, 0)
  assert.equal(r.slashDetail.frozenBefore, 0)
  assert.equal(r.slashDetail.frozenAfter, 0)
  // 金库余额未变
  assert.equal(reg.treasury.getBalance(), 0)
  // claimant 信誉未增加（仅有默认 initialReputation=1，无额外赔偿）
  const claimant = ledger.get('did:havix:A:claimant')
  assert.equal(claimant.available, DEFAULT_INITIAL_REPUTATION, 'frozen=0 时 claimant 不获得额外赔偿')
})

test('ArbitrationRegistry.resolveVerdict：已裁决 dispute 拒绝再次裁决', () => {
  const ledger = new ReputationLedger()
  ledger.credit('did:havix:A:respondent', 100)
  ledger.freeze('did:havix:A:respondent', 20)
  const vouch = new VouchRegistry({ threshold: 1 })
  for (let i = 0; i < 3; i++) {
    ledger.credit(`did:havix:A:j${i}`, 100)
    for (let k = 0; k < 12; k++) vouch.addVouch(`did:havix:A:j${i}`, `did:havix:A:v${i}-${k}`)
  }
  const reg = makeRegistry({ ledger, vouchRegistry: vouch, panelSize: 3, verdictMajority: 3 })
  for (let i = 0; i < 3; i++) reg.registerJurorCandidate(`did:havix:A:j${i}`)

  const { dispute } = reg.fileDispute({
    claimant: 'a', respondent: 'did:havix:A:respondent',
    type: 'offer-breach', amount: 10,
  })
  reg.summonPanel(dispute.disputeId, () => 0.5)
  for (const juror of dispute.panel) {
    reg.castVote({ disputeId: dispute.disputeId, jurorDid: juror, vote: 'not-guilty' })
  }
  reg.resolveVerdict(dispute.disputeId)

  // 再次裁决应抛错
  assert.throws(() => reg.resolveVerdict(dispute.disputeId), (err) => {
    assert.equal(err.name, 'DisputeAlreadyResolvedError')
    return true
  })
  // 已裁决后投票也应抛错
  assert.throws(() => reg.castVote({
    disputeId: dispute.disputeId,
    jurorDid: dispute.panel[0],
    vote: 'guilty',
  }), (err) => {
    assert.equal(err.name, 'DisputeAlreadyResolvedError')
    return true
  })
})

test('ArbitrationRegistry.resolveVerdict：未知 dispute 抛错', () => {
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry()
  const reg = makeRegistry({ ledger, vouchRegistry: vouch })
  assert.throws(() => reg.resolveVerdict('unknown'), (err) => {
    assert.equal(err.name, 'DisputeNotFoundError')
    return true
  })
})

test('ArbitrationRegistry.getVoteStats：投票统计', () => {
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry({ threshold: 1 })
  for (let i = 0; i < 3; i++) {
    ledger.credit(`did:havix:A:j${i}`, 100)
    for (let k = 0; k < 12; k++) vouch.addVouch(`did:havix:A:j${i}`, `did:havix:A:v${i}-${k}`)
  }
  const reg = makeRegistry({ ledger, vouchRegistry: vouch, panelSize: 3, verdictMajority: 3 })
  for (let i = 0; i < 3; i++) reg.registerJurorCandidate(`did:havix:A:j${i}`)
  const { dispute } = reg.fileDispute({
    claimant: 'a', respondent: 'b', type: 'offer-breach', amount: 1,
  })
  reg.summonPanel(dispute.disputeId, () => 0.5)
  reg.castVote({ disputeId: dispute.disputeId, jurorDid: dispute.panel[0], vote: 'guilty' })
  reg.castVote({ disputeId: dispute.disputeId, jurorDid: dispute.panel[1], vote: 'not-guilty' })
  reg.castVote({ disputeId: dispute.disputeId, jurorDid: dispute.panel[2], vote: 'abstain' })

  const stats = reg.getVoteStats(dispute.disputeId)
  assert.equal(stats.guilty, 1)
  assert.equal(stats['not-guilty'], 1)
  assert.equal(stats.abstain, 1)
  assert.equal(stats.total, 3)
  assert.equal(stats.status, DISPUTE_STATUS.VOTING)
})

// ──────────────────────────────────────────────
// publishArbitration
// ──────────────────────────────────────────────

test('publishArbitration：生成合法签名消息广播到 /s-network/alert', async () => {
  const pubsub = makeMockPubsub()
  const wallet = await makeWallet(1)
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry()
  const reg = makeRegistry({ ledger, vouchRegistry: vouch })
  const { dispute } = reg.fileDispute({
    claimant: 'did:havix:A:alice',
    respondent: 'did:havix:A:bob',
    type: 'offer-breach',
    amount: 10,
  })
  const { message, recipients } = await publishArbitration({
    pubsub,
    senderIdentity: wallet.get('A'),
    dispute,
    action: 'filed',
  })
  assert.equal(message.type, 'arbitration')
  assert.equal(message.senderId, wallet.get('A').did)
  assert.equal(message.payload.disputeId, dispute.disputeId)
  assert.equal(message.payload.action, 'filed')
  assert.ok(message.signature)
  assert.ok(message.signerPublicKey)
  assert.equal(pubsub.calls.length, 1)
  assert.equal(pubsub.calls[0].topic, ARBITRATION_TOPIC)
  assert.equal(pubsub.calls[0].topic, '/s-network/alert')
  assert.equal(recipients, 0)
})

test('publishArbitration：缺参数抛错', async () => {
  const wallet = await makeWallet(2)
  await assert.rejects(() => publishArbitration({
    senderIdentity: wallet.get('A'),
    dispute: {},
  }), /pubsub/)
})

// ──────────────────────────────────────────────
// Dispute 类
// ──────────────────────────────────────────────

test('Dispute：getVotes 返回数组快照', () => {
  const d = new Dispute({
    disputeId: 'd1', claimant: 'a', respondent: 'b',
    type: 'offer-breach', amount: 1, slashRatio: 0.5,
  })
  d.votes.set('j1', 'guilty')
  d.votes.set('j2', 'not-guilty')
  const votes = d.getVotes()
  assert.equal(votes.length, 2)
  assert.deepEqual(votes[0], { jurorDid: 'j1', vote: 'guilty' })
})

// ──────────────────────────────────────────────
// SNode M6 集成
// ──────────────────────────────────────────────

test('SNode M6 API：未启动时调用抛错', () => {
  const node = new SNode({ logLevel: 'error' })
  assert.throws(() => node.registerJurorCandidate({ did: 'x' }), /未启动/)
  assert.throws(() => node.checkJurorEligibility('x'), /未启动/)
  assert.throws(() => node.resolveVerdict('x'), /未启动/)
  assert.throws(() => node.getTreasuryBalance(), /未启动/)
  assert.throws(() => node.getTreasuryHistory(), /未启动/)
})

test('SNode M6 API：treasury 初始余额 0', () => {
  const node = new SNode({ logLevel: 'error' })
  // 手动注入 treasury（避免完整 start()）
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry()
  const treasury = new TreasuryLedger()
  node.treasury = treasury
  node.arbitrationRegistry = new ArbitrationRegistry({
    reputationLedger: ledger, vouchRegistry: vouch, treasury,
  })
  assert.equal(node.getTreasuryBalance(), 0)
  assert.deepEqual(node.getTreasuryHistory(), [])
})

test('SNode M6 API：registerJurorCandidate 转发', () => {
  const node = new SNode({ logLevel: 'error' })
  // initialReputation=0 让 credit(100) → available=100（默认 1.0 会让其变 101）
  const ledger = new ReputationLedger({ initialReputation: 0 })
  ledger.credit('did:havix:A:j1', 100)
  const vouch = new VouchRegistry()
  const treasury = new TreasuryLedger()
  node.treasury = treasury
  node.arbitrationRegistry = new ArbitrationRegistry({
    reputationLedger: ledger, vouchRegistry: vouch, treasury,
  })
  const r = node.registerJurorCandidate({ did: 'did:havix:A:j1' })
  assert.equal(r.registered, true)
  const info = node.checkJurorEligibility('did:havix:A:j1')
  assert.equal(info.reputation, 100)
})

test('SNode M6 API：完整仲裁流程', async () => {
  const node = new SNode({ logLevel: 'error' })
  const ledger = new ReputationLedger()
  // respondent 有冻结信誉可供 slash
  ledger.credit('did:havix:A:respondent', 100)
  ledger.freeze('did:havix:A:respondent', 20)
  // 3 个合格仲裁员
  const vouch = new VouchRegistry({ threshold: 1 })
  for (let i = 0; i < 3; i++) {
    ledger.credit(`did:havix:A:j${i}`, 100)
    for (let k = 0; k < 12; k++) vouch.addVouch(`did:havix:A:j${i}`, `did:havix:A:v${i}-${k}`)
  }
  const treasury = new TreasuryLedger()
  node.treasury = treasury
  node.arbitrationRegistry = new ArbitrationRegistry({
    reputationLedger: ledger, vouchRegistry: vouch, treasury,
    panelSize: 3, verdictMajority: 3,
    reputationMultiplier: 0,  // 测试用：门槛=0
  })
  // stub wallet：返回 context-A
  node.wallet = {
    get: (ctx) => ({ did: `did:havix:${ctx}:self` }),
  }
  node.log = () => {}

  // 1. 注册候选仲裁员
  for (let i = 0; i < 3; i++) {
    node.registerJurorCandidate({ did: `did:havix:A:j${i}` })
  }

  // 2. 发起 dispute（不广播，直接调 registry）
  const { dispute } = node.arbitrationRegistry.fileDispute({
    claimant: 'did:havix:A:self',
    respondent: 'did:havix:A:respondent',
    type: 'offer-breach',
    amount: 10,
  })

  // 3. 召集仲裁团
  node.summonArbitrationPanel(dispute.disputeId, () => 0.5)

  // 4. 投票（3 票 guilty）——直接调 registry.castVote，用 panel 成员的 did
  // （castArbitrationVote 用本地 wallet.did，本测试 stub wallet 与 panel 成员不一致）
  for (const juror of dispute.panel) {
    node.arbitrationRegistry.castVote({
      disputeId: dispute.disputeId,
      jurorDid: juror,
      vote: 'guilty',
    })
  }

  // 5. 裁决
  const r = node.resolveVerdict(dispute.disputeId)
  assert.equal(r.resolved, true)
  assert.equal(r.verdict, 'guilty')
  assert.equal(r.slashExecuted, true)
  assert.equal(node.getTreasuryBalance(), 5)
  assert.equal(node.getTreasuryHistory().length, 1)
  assert.equal(node.getTreasuryHistory(dispute.disputeId).length, 1)
})

// ──────────────────────────────────────────────
// 端到端：filed → panel-summoned → vote → verdict + slash
// ──────────────────────────────────────────────

test('端到端：完整仲裁 + slash + 金库审计', () => {
  // initialReputation=0 让 available/total 数值可预期（默认 1.0 会让 available/total 各 +1）
  const ledger = new ReputationLedger({ initialReputation: 0 })
  ledger.credit('did:havix:A:respondent', 200)
  ledger.freeze('did:havix:A:respondent', 50)  // 冻结 50，索赔 30
  ledger.credit('did:havix:A:claimant', 10)
  const vouch = new VouchRegistry({ threshold: 1 })
  // 5 个合格仲裁员（panelSize=5）
  for (let i = 0; i < 5; i++) {
    ledger.credit(`did:havix:A:j${i}`, 100)
    for (let k = 0; k < 12; k++) vouch.addVouch(`did:havix:A:j${i}`, `did:havix:A:v${i}-${k}`)
  }
  const reg = makeRegistry({ ledger, vouchRegistry: vouch, panelSize: 5, verdictMajority: 3 })
  for (let i = 0; i < 5; i++) reg.registerJurorCandidate(`did:havix:A:j${i}`)

  // 1. 发起 dispute
  const { dispute } = reg.fileDispute({
    claimant: 'did:havix:A:claimant',
    respondent: 'did:havix:A:respondent',
    type: 'offer-breach',
    evidence: 'bafkrei...',
    amount: 30,
  })
  assert.equal(dispute.status, DISPUTE_STATUS.PENDING)

  // 2. 召集仲裁团
  const panelResult = reg.summonPanel(dispute.disputeId, () => 0.5)
  assert.ok(panelResult.panel.length <= 5)
  assert.equal(dispute.status, DISPUTE_STATUS.PANEL_FORMED)

  // 3. 投票（3 票 guilty + 1 票 not-guilty + 1 票 abstain）
  reg.castVote({ disputeId: dispute.disputeId, jurorDid: dispute.panel[0], vote: 'guilty' })
  reg.castVote({ disputeId: dispute.disputeId, jurorDid: dispute.panel[1], vote: 'guilty' })
  reg.castVote({ disputeId: dispute.disputeId, jurorDid: dispute.panel[2], vote: 'guilty' })
  reg.castVote({ disputeId: dispute.disputeId, jurorDid: dispute.panel[3], vote: 'not-guilty' })
  reg.castVote({ disputeId: dispute.disputeId, jurorDid: dispute.panel[4], vote: 'abstain' })

  // 4. 裁决
  const r = reg.resolveVerdict(dispute.disputeId)
  assert.equal(r.resolved, true)
  assert.equal(r.verdict, 'guilty')
  assert.equal(r.slashExecuted, true)
  assert.equal(r.slashDetail.slashAmount, 30)
  assert.equal(r.slashDetail.victimCompensation, 15)
  assert.equal(r.slashDetail.treasuryDeposit, 15)
  assert.equal(r.slashDetail.frozenBefore, 50)
  assert.equal(r.slashDetail.frozenAfter, 20)

  // 5. 验证账本状态
  const rep = ledger.get('did:havix:A:respondent')
  assert.equal(rep.frozen, 20, 'slash 30 后 frozen=20')
  assert.equal(rep.available, 150, 'available 不变')
  assert.equal(rep.total, 170, 'total 减少 30（slash 是减 total，不是 pool 转移）')

  const claimantRep = ledger.get('did:havix:A:claimant')
  assert.equal(claimantRep.available, 25, 'claimant 获赔 15')

  // 6. 金库审计
  assert.equal(reg.treasury.getBalance(), 15)
  const history = reg.treasury.getHistory(dispute.disputeId)
  assert.equal(history.length, 1)
  assert.equal(history[0].amount, 15)
  assert.equal(history[0].from, 'did:havix:A:respondent')
})

// ──────────────────────────────────────────────
// P1 修复：_handleArbitrationMessage senderId 镜像校验
// ──────────────────────────────────────────────

test('P1: _handleArbitrationMessage filed action senderId ≠ claimant 拒绝', async () => {
  const node = new SNode({ logLevel: 'error' })
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry({ threshold: 1 })
  node.arbitrationRegistry = new ArbitrationRegistry({
    reputationLedger: ledger, vouchRegistry: vouch,
    panelSize: 3, verdictMajority: 3, reputationMultiplier: 0,
  })
  node.log = () => {}

  // 构造 filed 消息：senderId 是攻击者，但 claimant 是受害者
  const r = await node._handleArbitrationMessage({
    senderId: 'did:havix:A:attacker',
    payload: {
      disputeId: 'd1',
      action: 'filed',
      claimant: 'did:havix:A:victim',
      respondent: 'did:havix:A:respondent',
      type: 'offer-breach',
      amount: 10,
    },
  }, {})
  assert.equal(r.applied, false)
  assert.match(r.reason, /filed senderId 与 claimant 不匹配/)
  // dispute 不应被创建
  assert.equal(node.arbitrationRegistry.getDispute('d1'), undefined)
})

test('P1: _handleArbitrationMessage filed action senderId === claimant 通过', async () => {
  const node = new SNode({ logLevel: 'error' })
  const ledger = new ReputationLedger()
  const vouch = new VouchRegistry({ threshold: 1 })
  node.arbitrationRegistry = new ArbitrationRegistry({
    reputationLedger: ledger, vouchRegistry: vouch,
    panelSize: 3, verdictMajority: 3, reputationMultiplier: 0,
  })
  node.log = () => {}

  // senderId === claimant：合法
  const r = await node._handleArbitrationMessage({
    senderId: 'did:havix:A:claimant',
    payload: {
      disputeId: 'd1',
      action: 'filed',
      claimant: 'did:havix:A:claimant',
      respondent: 'did:havix:A:respondent',
      type: 'offer-breach',
      amount: 10,
    },
  }, {})
  assert.equal(r.applied, true)
  assert.ok(node.arbitrationRegistry.getDispute('d1'))
})

test('P1: _handleArbitrationMessage verdict action 非 panel 成员拒绝', async () => {
  const node = new SNode({ logLevel: 'error' })
  const ledger = new ReputationLedger({ initialReputation: 0 })
  // respondent 冻结信誉供 slash（虽然本测试不触发 slash）
  ledger.credit('did:havix:A:respondent', 100)
  ledger.freeze('did:havix:A:respondent', 20)
  const vouch = new VouchRegistry({ threshold: 1 })
  for (let i = 0; i < 3; i++) {
    ledger.credit(`did:havix:A:j${i}`, 100)
    for (let k = 0; k < 12; k++) vouch.addVouch(`did:havix:A:j${i}`, `did:havix:A:v${i}-${k}`)
  }
  node.arbitrationRegistry = new ArbitrationRegistry({
    reputationLedger: ledger, vouchRegistry: vouch,
    panelSize: 3, verdictMajority: 3, reputationMultiplier: 0,
  })
  for (let i = 0; i < 3; i++) node.arbitrationRegistry.registerJurorCandidate(`did:havix:A:j${i}`)
  node.log = () => {}

  // 先 fileDispute + summonPanel 让 dispute.panel 不为空
  const { dispute } = node.arbitrationRegistry.fileDispute({
    claimant: 'did:havix:A:claimant',
    respondent: 'did:havix:A:respondent',
    type: 'offer-breach', amount: 10,
  })
  node.arbitrationRegistry.summonPanel(dispute.disputeId, () => 0.5)
  assert.ok(dispute.panel.length > 0, 'panel 已召集')

  // 非法 senderId（非 panel 成员）发送 verdict → 应拒绝
  const r = await node._handleArbitrationMessage({
    senderId: 'did:havix:A:attacker',
    payload: {
      disputeId: dispute.disputeId,
      action: 'verdict',
      verdict: 'guilty',
      claimant: 'did:havix:A:claimant',
      respondent: 'did:havix:A:respondent',
      type: 'offer-breach', amount: 10,
    },
  }, {})
  assert.equal(r.applied, false)
  assert.match(r.reason, /verdict senderId 不在仲裁团 panel 中/)
  // dispute 状态不应被改成 RESOLVED
  assert.notEqual(dispute.status, DISPUTE_STATUS.RESOLVED)
})

test('P1: _handleArbitrationMessage verdict action panel 成员通过', async () => {
  const node = new SNode({ logLevel: 'error' })
  const ledger = new ReputationLedger({ initialReputation: 0 })
  ledger.credit('did:havix:A:respondent', 100)
  ledger.freeze('did:havix:A:respondent', 20)
  const vouch = new VouchRegistry({ threshold: 1 })
  for (let i = 0; i < 3; i++) {
    ledger.credit(`did:havix:A:j${i}`, 100)
    for (let k = 0; k < 12; k++) vouch.addVouch(`did:havix:A:j${i}`, `did:havix:A:v${i}-${k}`)
  }
  node.arbitrationRegistry = new ArbitrationRegistry({
    reputationLedger: ledger, vouchRegistry: vouch,
    panelSize: 3, verdictMajority: 3, reputationMultiplier: 0,
  })
  for (let i = 0; i < 3; i++) node.arbitrationRegistry.registerJurorCandidate(`did:havix:A:j${i}`)
  node.log = () => {}

  const { dispute } = node.arbitrationRegistry.fileDispute({
    claimant: 'did:havix:A:claimant',
    respondent: 'did:havix:A:respondent',
    type: 'offer-breach', amount: 10,
  })
  node.arbitrationRegistry.summonPanel(dispute.disputeId, () => 0.5)

  // panel 成员发送 verdict → 应通过
  const juror = dispute.panel[0]
  const r = await node._handleArbitrationMessage({
    senderId: juror,
    payload: {
      disputeId: dispute.disputeId,
      action: 'verdict',
      verdict: 'guilty',
      claimant: 'did:havix:A:claimant',
      respondent: 'did:havix:A:respondent',
      type: 'offer-breach', amount: 10,
    },
  }, {})
  assert.equal(r.applied, true)
  assert.equal(dispute.status, DISPUTE_STATUS.RESOLVED)
})
