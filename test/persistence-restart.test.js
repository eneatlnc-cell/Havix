/**
 * M8.1 持久化重启恢复测试
 * ───────────────────────────────────────────────
 * 测试目标：验证各 registry 的 toJSON/loadState/flush 接口能正确往返：
 *   1. 实例化 registry（带 persistPath）
 *   2. 执行 mutation（credit/vouch/dispute/market 等）
 *   3. flush() 写盘
 *   4. 用同一 persistPath 实例化新 registry
 *   5. loadState(loadJson(path))
 *   6. 断言所有状态被恢复
 *
 * 验证 SNode.start() → stop() → start() 的状态恢复契约（M8.1 设计目标）。
 *
 * 全部纯单元测试（不启动 helia / libp2p）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { loadJson } from '../src/persistence.js'
import { ReputationLedger, CreditLedger } from '../src/protocol/credit.js'
import { VouchRegistry } from '../src/protocol/vouch.js'
import { ArbitrationRegistry, TreasuryLedger, DISPUTE_STATUS, VERDICT_VOTE }
  from '../src/protocol/arbitration.js'
import {
  AppManifest,
  InviteToken,
  MarketRegistry,
  issueInviteToken,
} from '../src/protocol/market.js'
import { IdentityWallet } from '../src/identity.js'

// ──────────────────────────────────────────────
// 临时目录辅助
// ──────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'havix-m81-restart-'))
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

const noopLog = () => {}

async function makeWallet(seedByte) {
  const seed = new Uint8Array(32).fill(seedByte)
  return await IdentityWallet.fromSeed(seed)
}

// ──────────────────────────────────────────────
// ReputationLedger：credit/freeze/release 重启恢复
// ──────────────────────────────────────────────

test('M8.1 ReputationLedger：credit/freeze/release 后重启状态恢复', () => {
  const dir = makeTmpDir()
  try {
    const file = path.join(dir, 'reputation.json')

    // ── 节点 1：写入状态 ──
    const ledger1 = new ReputationLedger({
      initialReputation: 10,
      log: noopLog,
      persistPath: file,
    })
    ledger1.credit('did:havix:A:alice', 90)  // total=100, available=100
    ledger1.credit('did:havix:A:bob', 40)   // total=50
    ledger1.freeze('did:havix:A:alice', 30) // frozen=30, available=70
    ledger1.release('did:havix:A:alice', 10) // frozen=20, available=80
    ledger1.flush()

    // 文件已落盘
    assert.equal(fs.existsSync(file), true)

    // ── 节点 2：从磁盘加载 ──
    const ledger2 = new ReputationLedger({
      initialReputation: 10,
      log: noopLog,
      persistPath: file,
    })
    ledger2.loadState(loadJson(file, null, { log: noopLog }))

    const alice = ledger2.get('did:havix:A:alice')
    assert.equal(alice.total, 100, 'alice total 应恢复 100')
    assert.equal(alice.frozen, 20, 'alice frozen 应恢复 20')
    assert.equal(alice.available, 80, 'alice available 应恢复 80')

    const bob = ledger2.get('did:havix:A:bob')
    assert.equal(bob.total, 50, 'bob total 应恢复 50')
    assert.equal(bob.frozen, 0, 'bob frozen 应恢复 0')
    assert.equal(bob.available, 50, 'bob available 应恢复 50')
  } finally {
    rmrf(dir)
  }
})

test('M8.1 ReputationLedger：slash 后 frozen 减少且 total 跟随', () => {
  const dir = makeTmpDir()
  try {
    const file = path.join(dir, 'reputation.json')

    const ledger1 = new ReputationLedger({
      initialReputation: 0,
      log: noopLog,
      persistPath: file,
    })
    ledger1.credit('did:havix:A:carol', 100)
    ledger1.freeze('did:havix:A:carol', 60)  // frozen=60, available=40
    ledger1.slash('did:havix:A:carol', 20)    // frozen=40, total=80
    ledger1.flush()

    const ledger2 = new ReputationLedger({
      initialReputation: 0,
      log: noopLog,
      persistPath: file,
    })
    ledger2.loadState(loadJson(file, null, { log: noopLog }))
    const carol = ledger2.get('did:havix:A:carol')
    assert.equal(carol.frozen, 40, 'carol frozen 应恢复 40（slash 后）')
    assert.equal(carol.available, 40, 'carol available 不受 slash 影响')
    assert.equal(carol.total, 80, 'carol total 应恢复 80（slash 减 20）')
  } finally {
    rmrf(dir)
  }
})

// ──────────────────────────────────────────────
// CreditLedger：credit/debit/transfer 重启恢复
// ──────────────────────────────────────────────

test('M8.1 CreditLedger：credit/debit/transfer 后重启状态恢复', () => {
  const dir = makeTmpDir()
  try {
    const file = path.join(dir, 'credit.json')

    const ledger1 = new CreditLedger({ log: noopLog, persistPath: file })
    ledger1.credit('did:havix:A:alice', 100)
    ledger1.credit('did:havix:A:bob', 50)
    ledger1.debit('did:havix:A:alice', 30)
    ledger1.transfer('did:havix:A:bob', 'did:havix:A:alice', 20)  // bob=30, alice=90
    ledger1.flush()

    const ledger2 = new CreditLedger({ log: noopLog, persistPath: file })
    ledger2.loadState(loadJson(file, null, { log: noopLog }))

    assert.equal(ledger2.getBalance('did:havix:A:alice'), 90, 'alice balance 应恢复 90')
    assert.equal(ledger2.getBalance('did:havix:A:bob'), 30, 'bob balance 应恢复 30')
    assert.equal(ledger2.getBalance('did:havix:A:unknown'), 0, '未知 did 默认 0')
  } finally {
    rmrf(dir)
  }
})

// ──────────────────────────────────────────────
// VouchRegistry：addVouch 重启恢复
// ──────────────────────────────────────────────

test('M8.1 VouchRegistry：addVouch 后重启 voucher 集合恢复', () => {
  const dir = makeTmpDir()
  try {
    const file = path.join(dir, 'vouches.json')

    const ledger1 = new ReputationLedger({ initialReputation: 1.0, log: noopLog })
    const v1 = new VouchRegistry({
      threshold: 2,
      reputationLedger: ledger1,
      log: noopLog,
      persistPath: file,
    })
    v1.addVouch('did:havix:A:endorsee', 'did:havix:A:voucher1')
    v1.addVouch('did:havix:A:endorsee', 'did:havix:A:voucher2')
    v1.addVouch('did:havix:A:endorsee', 'did:havix:A:voucher3')
    v1.addVouch('did:havix:A:other', 'did:havix:A:voucher1')
    v1.flush()

    const ledger2 = new ReputationLedger({ initialReputation: 1.0, log: noopLog })
    const v2 = new VouchRegistry({
      threshold: 2,
      reputationLedger: ledger2,
      log: noopLog,
      persistPath: file,
    })
    v2.loadState(loadJson(file, null, { log: noopLog }))

    assert.equal(v2.getVouchCount('did:havix:A:endorsee'), 3, 'endorsee 应恢复 3 个 vouch')
    assert.equal(v2.getVouchCount('did:havix:A:other'), 1, 'other 应恢复 1 个 vouch')
    const vouchers = v2.getVouchers('did:havix:A:endorsee')
    assert.ok(Array.isArray(vouchers), 'getVouchers 返回数组')
    assert.ok(vouchers.includes('did:havix:A:voucher2'))
    assert.ok(vouchers.includes('did:havix:A:voucher3'))
  } finally {
    rmrf(dir)
  }
})

// ──────────────────────────────────────────────
// TreasuryLedger：deposit 重启恢复
// ──────────────────────────────────────────────

test('M8.1 TreasuryLedger：deposit 后重启余额与历史恢复', () => {
  const dir = makeTmpDir()
  try {
    const file = path.join(dir, 'treasury.json')

    const t1 = new TreasuryLedger({ log: noopLog, persistPath: file })
    t1.deposit({ from: 'did:havix:A:slashed1', amount: 100, reason: 'slash from dispute d1', disputeId: 'd1' })
    t1.deposit({ from: 'did:havix:A:slashed2', amount: 50, reason: 'slash from dispute d2', disputeId: 'd2' })
    t1.flush()

    const t2 = new TreasuryLedger({ log: noopLog, persistPath: file })
    t2.loadState(loadJson(file, null, { log: noopLog }))

    assert.equal(t2.getBalance(), 150, '金库余额应恢复 150')
    assert.equal(t2.getHistory().length, 2, '历史记录应恢复 2 条')
    const d1History = t2.getHistory('d1')
    assert.equal(d1History.length, 1)
    assert.equal(d1History[0].amount, 100)
    assert.equal(d1History[0].from, 'did:havix:A:slashed1')
  } finally {
    rmrf(dir)
  }
})

// ──────────────────────────────────────────────
// ArbitrationRegistry：fileDispute + summonPanel + castVote 重启恢复
// ──────────────────────────────────────────────

test('M8.1 ArbitrationRegistry：dispute 全生命周期重启恢复', async () => {
  const dir = makeTmpDir()
  try {
    const file = path.join(dir, 'arbitration.json')

    const wallet = await makeWallet(7)
    const alice = wallet.get('A').did
    const bob = wallet.get('B').did

    const repLedger1 = new ReputationLedger({ initialReputation: 0, log: noopLog })
    const vouch1 = new VouchRegistry({ threshold: 1, reputationLedger: repLedger1, log: noopLog })
    const treasury1 = new TreasuryLedger({ log: noopLog })

    const arb1 = new ArbitrationRegistry({
      reputationLedger: repLedger1,
      vouchRegistry: vouch1,
      treasury: treasury1,
      log: noopLog,
      persistPath: file,
      panelSize: 3,
      verdictMajority: 2,
      minVouchForJuror: 5,  // 降低门槛便于测试
    })

    // 注册若干仲裁员候选——需在 repLedger / vouchRegistry 中先写入对应数据
    // 5 个候选：3 个低信誉（拉低中位数）+ 2 个高信誉（高于中位数×1.5）
    // 这样高信誉的 2 个候选可被抽中
    for (let i = 0; i < 3; i++) {
      repLedger1.credit(`did:havix:A:jurorLow${i}`, 1)
      for (let j = 0; j < 6; j++) {
        vouch1.addVouch(`did:havix:A:jurorLow${i}`, `did:havix:A:sponsor${i}-${j}`)
      }
      arb1.registerJurorCandidate(`did:havix:A:jurorLow${i}`)
    }
    for (let i = 0; i < 2; i++) {
      repLedger1.credit(`did:havix:A:jurorHigh${i}`, 1000)
      for (let j = 0; j < 6; j++) {
        vouch1.addVouch(`did:havix:A:jurorHigh${i}`, `did:havix:A:sponsorH${i}-${j}`)
      }
      arb1.registerJurorCandidate(`did:havix:A:jurorHigh${i}`)
    }

    const { dispute } = arb1.fileDispute({
      claimant: alice,
      respondent: bob,
      type: 'offer-breach',
      evidence: 'ipfs://evidence1',
      amount: 50,
      disputeId: 'd-test',
    })

    // 召集仲裁团（用确定性 RNG 保证测试可复现）
    const { panel } = arb1.summonPanel('d-test', () => 0.5)
    assert.ok(panel.length > 0, '应抽到至少 1 个仲裁员')

    // 第一个仲裁员投 guilty
    if (panel.length > 0) {
      arb1.castVote({ disputeId: 'd-test', jurorDid: panel[0], vote: VERDICT_VOTE.GUILTY })
    }

    arb1.flush()

    // ── 重启：用同样的 persistPath + loadState ──
    const repLedger2 = new ReputationLedger({ initialReputation: 100, log: noopLog })
    const vouch2 = new VouchRegistry({ threshold: 1, reputationLedger: repLedger2, log: noopLog })
    const treasury2 = new TreasuryLedger({ log: noopLog })

    const arb2 = new ArbitrationRegistry({
      reputationLedger: repLedger2,
      vouchRegistry: vouch2,
      treasury: treasury2,
      log: noopLog,
      persistPath: file,
      panelSize: 3,
      verdictMajority: 2,
      minVouchForJuror: 5,
    })
    arb2.loadState(loadJson(file, null, { log: noopLog }))

    // dispute 应被恢复
    const restored = arb2.getDispute('d-test')
    assert.ok(restored, 'dispute 应被恢复')
    assert.equal(restored.claimant, alice)
    assert.equal(restored.respondent, bob)
    assert.equal(restored.type, 'offer-breach')
    assert.equal(restored.amount, 50)
    assert.equal(restored.status, DISPUTE_STATUS.VOTING,
      '状态应恢复为 VOTING（castVote 后 transition）')

    // panel 应恢复
    assert.deepEqual(restored.panel, panel, 'panel 成员应恢复')

    // 投票应恢复
    assert.equal(restored.votes.get(panel[0]), VERDICT_VOTE.GUILTY,
      'juror 投票应恢复')

    // 仲裁员候选池应恢复
    assert.equal(arb2.jurorPool.size, 5, 'jurorPool 应恢复 5 个候选')

    // 重启后可继续投票（验证恢复后行为正确）
    if (panel.length > 1) {
      arb2.castVote({ disputeId: 'd-test', jurorDid: panel[1], vote: VERDICT_VOTE.GUILTY })
      const d = arb2.getDispute('d-test')
      assert.equal(d.votes.get(panel[1]), VERDICT_VOTE.GUILTY, '重启后可继续投票')
    }
  } finally {
    rmrf(dir)
  }
})

// ──────────────────────────────────────────────
// MarketRegistry：createMarket + joinMarket 重启恢复
// ──────────────────────────────────────────────

test('M8.1 MarketRegistry：创建市场 + 加入市场重启恢复', async () => {
  const dir = makeTmpDir()
  try {
    const file = path.join(dir, 'markets.json')

    const wallet = await makeWallet(9)
    const issuer = wallet.get('A')
    const invitee = wallet.get('B')

    const manifest = new AppManifest({
      name: 'translation-market',
      version: '1.0.0',
      capability: 'market',
      permissions: ['gossipsub:publish'],
      min_reputation: 30,
      trust_weight: 0.8,
    })
    const marketId = manifest.marketId

    // 创建者自邀请令牌
    const creatorToken = await issueInviteToken({
      marketId,
      inviteeDid: issuer.did,
      issuerIdentity: issuer,
      ttlMs: 1000,
      now: 1000,
    })

    // ── 节点 1：创建市场 ──
    const m1 = new MarketRegistry({ log: noopLog, persistPath: file })
    m1.createMarket({ manifest, creatorToken })
    m1.flush()

    // ── 节点 2：从磁盘加载 ──
    const m2 = new MarketRegistry({ log: noopLog, persistPath: file })
    m2.loadState(loadJson(file, null, { log: noopLog }))

    const marketIds = m2.listMarkets()
    assert.equal(marketIds.length, 1, '应恢复 1 个市场')
    assert.equal(marketIds[0], marketId, 'marketId 应恢复')

    const restored = m2.getMarket(marketId)
    assert.ok(restored, 'getMarket 应返回恢复的市场对象')
    assert.equal(restored.manifest.name, 'translation-market')
    assert.equal(restored.isCreator, true, '创建者标志应恢复')
    assert.equal(restored.topic, m2.getTopic(marketId))
  } finally {
    rmrf(dir)
  }
})

test('M8.1 MarketRegistry：加密密钥与 topic 重启后一致（AES 解密可用）', async () => {
  const dir = makeTmpDir()
  try {
    const file = path.join(dir, 'markets.json')

    const wallet = await makeWallet(11)
    const issuer = wallet.get('A')
    const manifest = new AppManifest({
      name: 'secret-market',
      version: '2.0.0',
      capability: 'market',
    })
    const marketId = manifest.marketId

    const creatorToken = await issueInviteToken({
      marketId,
      inviteeDid: issuer.did,
      issuerIdentity: issuer,
      ttlMs: 1000,
      now: 1000,
    })

    const m1 = new MarketRegistry({ log: noopLog, persistPath: file })
    m1.createMarket({ manifest, creatorToken })
    const topicBefore = m1.getTopic(marketId)
    const keyBefore = m1.getEncryptionKey(marketId)
    m1.flush()

    const m2 = new MarketRegistry({ log: noopLog, persistPath: file })
    m2.loadState(loadJson(file, null, { log: noopLog }))

    // 关键：密钥从 base64 恢复为 Uint8Array 后字节完全一致
    const topicAfter = m2.getTopic(marketId)
    const keyAfter = m2.getEncryptionKey(marketId)

    assert.equal(topicAfter, topicBefore, 'topic 应与重启前一致')
    assert.deepEqual(Array.from(keyAfter), Array.from(keyBefore),
      '加密密钥字节应与重启前一致（AES-GCM 解密可用）')
    assert.ok(keyAfter instanceof Uint8Array, '恢复后应为 Uint8Array')
    assert.equal(keyAfter.length, 32, '密钥长度 32 字节（AES-256）')
  } finally {
    rmrf(dir)
  }
})

// ──────────────────────────────────────────────
// 多 registry 混合：模拟 SNode 重启场景
// ──────────────────────────────────────────────

test('M8.1 端到端：多 registry 混合 mutation 后整体重启恢复', async () => {
  const dir = makeTmpDir()
  try {
    const paths = {
      reputation: path.join(dir, 'reputation.json'),
      credit: path.join(dir, 'credit.json'),
      vouch: path.join(dir, 'vouches.json'),
      treasury: path.join(dir, 'treasury.json'),
      arbitration: path.join(dir, 'arbitration.json'),
      market: path.join(dir, 'markets.json'),
    }

    // ── 第一次启动：所有 registry 同时 mutation ──
    const rep1 = new ReputationLedger({ initialReputation: 10, log: noopLog, persistPath: paths.reputation })
    const credit1 = new CreditLedger({ log: noopLog, persistPath: paths.credit })
    const vouch1 = new VouchRegistry({ threshold: 2, reputationLedger: rep1, log: noopLog, persistPath: paths.vouch })
    const treasury1 = new TreasuryLedger({ log: noopLog, persistPath: paths.treasury })
    const arb1 = new ArbitrationRegistry({
      reputationLedger: rep1, vouchRegistry: vouch1, treasury: treasury1,
      log: noopLog, persistPath: paths.arbitration,
    })
    const market1 = new MarketRegistry({ log: noopLog, persistPath: paths.market })

    rep1.credit('did:havix:A:alice', 90)
    credit1.credit('did:havix:A:alice', 100)
    vouch1.addVouch('did:havix:A:bob', 'did:havix:A:alice')
    treasury1.deposit({ from: 'did:havix:A:bad', amount: 25, reason: 'slash' })

    const wallet = await makeWallet(13)
    const issuer = wallet.get('A')
    const manifest = new AppManifest({
      name: 'multi-test', version: '1.0.0', capability: 'market',
    })
    const token = await issueInviteToken({
      marketId: manifest.marketId,
      inviteeDid: issuer.did,
      issuerIdentity: issuer,
      ttlMs: 1000, now: 1000,
    })
    market1.createMarket({ manifest, creatorToken: token })

    // flush 所有
    rep1.flush()
    credit1.flush()
    vouch1.flush()
    treasury1.flush()
    arb1.flush()
    market1.flush()

    // ── 第二次启动：用同样的 persistPath 重新实例化 ──
    const rep2 = new ReputationLedger({ initialReputation: 10, log: noopLog, persistPath: paths.reputation })
    const credit2 = new CreditLedger({ log: noopLog, persistPath: paths.credit })
    const vouch2 = new VouchRegistry({ threshold: 2, reputationLedger: rep2, log: noopLog, persistPath: paths.vouch })
    const treasury2 = new TreasuryLedger({ log: noopLog, persistPath: paths.treasury })
    const arb2 = new ArbitrationRegistry({
      reputationLedger: rep2, vouchRegistry: vouch2, treasury: treasury2,
      log: noopLog, persistPath: paths.arbitration,
    })
    const market2 = new MarketRegistry({ log: noopLog, persistPath: paths.market })

    rep2.loadState(loadJson(paths.reputation, null, { log: noopLog }))
    credit2.loadState(loadJson(paths.credit, null, { log: noopLog }))
    vouch2.loadState(loadJson(paths.vouch, null, { log: noopLog }))
    treasury2.loadState(loadJson(paths.treasury, null, { log: noopLog }))
    arb2.loadState(loadJson(paths.arbitration, null, { log: noopLog }))
    market2.loadState(loadJson(paths.market, null, { log: noopLog }))

    // ── 验证每个 registry 状态正确恢复 ──
    assert.equal(rep2.get('did:havix:A:alice').total, 100, 'reputation total 应恢复 100')
    assert.equal(credit2.getBalance('did:havix:A:alice'), 100, 'credit balance 应恢复 100')
    assert.equal(vouch2.getVouchCount('did:havix:A:bob'), 1, 'vouch 数应恢复 1')
    assert.equal(treasury2.getBalance(), 25, 'treasury 余额应恢复 25')
    assert.equal(market2.listMarkets().length, 1, '市场数应恢复 1')
  } finally {
    rmrf(dir)
  }
})

// ──────────────────────────────────────────────
// 首次启动：persistPath 文件不存在时 loadState 空等价
// ──────────────────────────────────────────────

test('M8.1 首次启动：persistPath 文件不存在时 loadState 不抛错', () => {
  const dir = makeTmpDir()
  try {
    const file = path.join(dir, 'never-existed.json')

    // loadJson 文件不存在返回 null
    const json = loadJson(file, null, { log: noopLog })
    assert.equal(json, null)

    // loadState(null) 应静默无操作
    const ledger = new ReputationLedger({ log: noopLog, persistPath: file })
    assert.doesNotThrow(() => ledger.loadState(null))
    assert.doesNotThrow(() => ledger.loadState(undefined))

    // 状态保持默认值
    const r = ledger.get('did:havix:A:anyone')
    assert.equal(r.available, 1.0)  // DEFAULT_INITIAL_REPUTATION = 1.0
  } finally {
    rmrf(dir)
  }
})

// ──────────────────────────────────────────────
// 不传 persistPath：纯内存模式，flush 为 no-op
// ──────────────────────────────────────────────

test('M8.1 纯内存模式：不传 persistPath 时 flush 为 no-op', () => {
  const ledger = new ReputationLedger({ log: noopLog })  // 无 persistPath
  ledger.credit('did:havix:A:x', 10)
  assert.doesNotThrow(() => ledger.flush())  // 不抛错，不写盘

  const creditLedger = new CreditLedger({ log: noopLog })
  creditLedger.credit('did:havix:A:y', 20)
  assert.doesNotThrow(() => creditLedger.flush())
})
