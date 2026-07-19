/**
 * AUDIT-M10 MVP 协议层 P1-1 ~ P1-5 回归测试（5 项）
 * ───────────────────────────────────────────────
 * 覆盖 5 项 MVP 协议层修复：
 *   - P1-1: config.js --data-dir / --apps-dir 路径穿越校验
 *   - P1-2: arbitration.js castVote 状态校验
 *   - P1-3: credit.js + s-node.js note.signerPublicKey 与 issuerDid 绑定
 *   - P1-4: credit.js ReputationLedger.get 懒创建不写盘
 *   - P1-5: tunnel.js sendChunk MAX_CHUNK_SIZE 守卫
 *
 * 测试原则：每个修复点都要有"被拒绝路径"+"合法路径"对照，
 * 确保不是误拒合法输入。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

import { loadConfig } from '../src/config.js'
import {
  ArbitrationRegistry,
  TreasuryLedger,
  Dispute,
  DISPUTE_STATUS,
  VERDICT_VOTE,
  DisputeNotFoundError,
  DisputeAlreadyResolvedError,
  DisputeNotInVotingStateError,
  JurorNotAuthorizedError,
} from '../src/protocol/arbitration.js'
import {
  ReputationLedger,
  CreditLedger,
  Faucet,
  InsufficientReputationError,
} from '../src/protocol/credit.js'
import { VouchRegistry } from '../src/protocol/vouch.js'
import {
  Tunnel,
  TunnelManager,
  TunnelBrokenError,
  NoRelayAvailableError,
  ChunkTooLargeError,
  MAX_CHUNK_SIZE,
} from '../src/network/tunnel.js'
import { IdentityWallet } from '../src/identity.js'

// ──────────────────────────────────────────────
// 辅助
// ──────────────────────────────────────────────

function withArgv(argv, fn) {
  const saved = process.argv
  process.argv = ['node', 's-node.js', ...argv]
  try {
    return fn()
  } finally {
    process.argv = saved
  }
}

function withEnv(env, fn) {
  const saved = {}
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k]
    if (env[k] === undefined) delete process.env[k]
    else process.env[k] = env[k]
  }
  try {
    return fn()
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

function makeRegistry({
  ledger,
  vouchRegistry,
  panelSize = 3,
  verdictMajority = 2,
  reputationMultiplier = 0,  // 关闭中位数门槛，便于测试快速构造合格 juror
  minVouchForJuror = 1,     // 降低 vouch 门槛，便于测试
  log = () => {},
} = {}) {
  const rep = ledger ?? new ReputationLedger()
  const vouch = vouchRegistry ?? new VouchRegistry({ threshold: 1 })
  return new ArbitrationRegistry({
    reputationLedger: rep,
    vouchRegistry: vouch,
    treasury: new TreasuryLedger(),
    panelSize,
    verdictMajority,
    reputationMultiplier,
    minVouchForJuror,
    log,
  })
}

function setupFiledDispute(reg, opts = {}) {
  const { claimant = 'did:havix:A:claimant', respondent = 'did:havix:A:respondent' } = opts
  // 给每个 juror 充信誉 + vouch（默认门槛已被 makeRegistry 调低）
  for (let i = 0; i < 5; i++) {
    reg.reputationLedger.credit(`did:havix:A:juror-${i}`, 100)
    reg.vouchRegistry.addVouch(`did:havix:A:juror-${i}`, `did:havix:A:voucher-${i}`)
    // 关键：必须注册到 jurorPool 才能被 summonPanel 选中
    reg.registerJurorCandidate(`did:havix:A:juror-${i}`)
  }
  const { dispute } = reg.fileDispute({
    claimant, respondent, type: 'offer-breach', amount: 5,
  })
  reg.summonPanel(dispute.disputeId, () => 0.5)
  return dispute
}

// ──────────────────────────────────────────────
// P1-1: config.js --data-dir / --apps-dir 路径穿越校验
// ──────────────────────────────────────────────

describe('P1-1: config.js --data-dir / --apps-dir 路径穿越校验', () => {
  test('拒绝 --data-dir /etc/passwd（Linux 绝对路径）', () => {
    assert.throws(
      () => withArgv(['--data-dir', '/etc/passwd'], () => loadConfig()),
      /--data-dir.*必须是相对路径/,
    )
  })

  test('拒绝 --data-dir ../../etc（路径穿越）', () => {
    assert.throws(
      () => withArgv(['--data-dir', '../../etc'], () => loadConfig()),
      /--data-dir.*不允许包含 "\.\." 路径穿越/,
    )
  })

  test('拒绝 --data-dir a/../../b（嵌套路径穿越）', () => {
    assert.throws(
      () => withArgv(['--data-dir', 'a/../../b'], () => loadConfig()),
      /--data-dir.*不允许包含 "\.\." 路径穿越/,
    )
  })

  test('拒绝 --apps-dir /opt/evil（绝对路径）', () => {
    assert.throws(
      () => withArgv(['--apps-dir', '/opt/evil'], () => loadConfig()),
      /--apps-dir.*必须是相对路径/,
    )
  })

  test('拒绝 --apps-dir ../sibling（路径穿越）', () => {
    assert.throws(
      () => withArgv(['--apps-dir', '../sibling'], () => loadConfig()),
      /--apps-dir.*不允许包含 "\.\." 路径穿越/,
    )
  })

  test('拒绝 HAVIX_DATA_DIR=../../etc（环境变量路径穿越）', () => {
    withEnv({ HAVIX_DATA_DIR: '../../etc' }, () => {
      assert.throws(
        () => loadConfig(),
        /--data-dir.*不允许包含 "\.\." 路径穿越/,
      )
    })
  })

  test('拒绝 HAVIX_APPS_DIR=/opt/evil（环境变量绝对路径）', () => {
    withEnv({ HAVIX_APPS_DIR: '/opt/evil' }, () => {
      assert.throws(
        () => loadConfig(),
        /--apps-dir.*必须是相对路径/,
      )
    })
  })

  test('接受合法相对路径 --data-dir my-data --apps-dir my-apps', () => {
    const cfg = withArgv(
      ['--data-dir', 'my-data', '--apps-dir', 'my-apps'],
      () => loadConfig(),
    )
    assert.equal(cfg.dataDir, 'my-data')
    assert.equal(cfg.appsDir, 'my-apps')
  })

  test('接受默认值 .data / apps（无显式指定）', () => {
    const cfg = withArgv([], () => loadConfig())
    assert.equal(cfg.dataDir, '.data')
    assert.equal(cfg.appsDir, 'apps')
  })

  test('接受嵌套相对路径 ./foo/bar（无 ..）', () => {
    const cfg = withArgv(
      ['--data-dir', './foo/bar', '--apps-dir', './apps/sub'],
      () => loadConfig(),
    )
    assert.equal(cfg.dataDir, './foo/bar')
    assert.equal(cfg.appsDir, './apps/sub')
  })

  test('拒绝 Windows 盘符 --data-dir C:\\foo', () => {
    assert.throws(
      () => withArgv(['--data-dir', 'C:\\foo'], () => loadConfig()),
      /--data-dir.*必须是相对路径/,
    )
  })

  test('拒绝 Windows 盘符 --apps-dir D:/evil', () => {
    assert.throws(
      () => withArgv(['--apps-dir', 'D:/evil'], () => loadConfig()),
      /--apps-dir.*必须是相对路径/,
    )
  })
})

// ──────────────────────────────────────────────
// P1-2: arbitration.js castVote 状态校验
// ──────────────────────────────────────────────

describe('P1-2: castVote 状态校验', () => {
  test('PENDING 状态投票抛 DisputeNotInVotingStateError', () => {
    const reg = makeRegistry()
    const { dispute } = reg.fileDispute({
      claimant: 'did:havix:A:c', respondent: 'did:havix:A:r',
      type: 'offer-breach', amount: 5,
    })
    assert.equal(dispute.status, DISPUTE_STATUS.PENDING)
    assert.throws(
      () => reg.castVote({
        disputeId: dispute.disputeId,
        jurorDid: 'did:havix:A:fake-juror',
        vote: VERDICT_VOTE.GUILTY,
      }),
      (err) => err instanceof DisputeNotInVotingStateError
        && err.code === 'DISPUTE_NOT_IN_VOTING_STATE'
        && err.status === DISPUTE_STATUS.PENDING
        && /不允许投票/.test(err.message),
    )
  })

  test('EXPIRED 状态投票抛 DisputeNotInVotingStateError', () => {
    const reg = makeRegistry()
    const { dispute } = reg.fileDispute({
      claimant: 'did:havix:A:c', respondent: 'did:havix:A:r',
      type: 'offer-breach', amount: 5,
    })
    // 直接修改 dispute.status 模拟 EXPIRED（M6 由外部触发）
    dispute.status = DISPUTE_STATUS.EXPIRED
    assert.throws(
      () => reg.castVote({
        disputeId: dispute.disputeId,
        jurorDid: 'did:havix:A:fake-juror',
        vote: VERDICT_VOTE.GUILTY,
      }),
      (err) => err instanceof DisputeNotInVotingStateError
        && err.status === DISPUTE_STATUS.EXPIRED,
    )
  })

  test('PANEL_FORMED 状态正常投票', () => {
    const reg = makeRegistry()
    const dispute = setupFiledDispute(reg)
    assert.equal(dispute.status, DISPUTE_STATUS.PANEL_FORMED)
    const juror = dispute.panel[0]
    const r = reg.castVote({
      disputeId: dispute.disputeId,
      jurorDid: juror,
      vote: VERDICT_VOTE.GUILTY,
    })
    assert.equal(r.recorded, true)
    assert.equal(r.vote, VERDICT_VOTE.GUILTY)
  })

  test('VOTING 状态正常投票（首个 vote 后状态变为 VOTING）', () => {
    const reg = makeRegistry()
    const dispute = setupFiledDispute(reg)
    const [j1, j2] = dispute.panel
    // 第一票后 dispute.status = VOTING
    reg.castVote({
      disputeId: dispute.disputeId,
      jurorDid: j1,
      vote: VERDICT_VOTE.GUILTY,
    })
    assert.equal(dispute.status, DISPUTE_STATUS.VOTING)
    // 第二票在 VOTING 状态下也允许
    const r = reg.castVote({
      disputeId: dispute.disputeId,
      jurorDid: j2,
      vote: VERDICT_VOTE.GUILTY,
    })
    assert.equal(r.recorded, true)
  })

  test('RESOLVED 状态仍抛 DisputeAlreadyResolvedError（向后兼容）', () => {
    const reg = makeRegistry()
    const { dispute } = reg.fileDispute({
      claimant: 'did:havix:A:c', respondent: 'did:havix:A:r',
      type: 'offer-breach', amount: 5,
    })
    dispute.status = DISPUTE_STATUS.RESOLVED
    assert.throws(
      () => reg.castVote({
        disputeId: dispute.disputeId,
        jurorDid: 'did:havix:A:fake-juror',
        vote: VERDICT_VOTE.GUILTY,
      }),
      (err) => err instanceof DisputeAlreadyResolvedError,
    )
  })

  test('错误类 DisputeNotInVotingStateError 字段完整', () => {
    const err = new DisputeNotInVotingStateError({
      disputeId: 'd-1',
      status: 'pending',
      expected: ['panel-formed', 'voting'],
    })
    assert.equal(err.name, 'DisputeNotInVotingStateError')
    assert.equal(err.code, 'DISPUTE_NOT_IN_VOTING_STATE')
    assert.equal(err.disputeId, 'd-1')
    assert.equal(err.status, 'pending')
    assert.deepEqual(err.expected, ['panel-formed', 'voting'])
  })
})

// ──────────────────────────────────────────────
// P1-3: note.signerPublicKey 与 issuerDid 绑定
// ──────────────────────────────────────────────

describe('P1-3: ReputationLedger issuerDid ↔ pubKey 绑定', () => {
  test('registerIssuerPubKey 首次调用登记公钥', () => {
    const ledger = new ReputationLedger()
    const r = ledger.registerIssuerPubKey('did:havix:A:issuer1', 'pubkey-aaa')
    assert.equal(r.registered, true)
    assert.equal(r.pubKey, 'pubkey-aaa')
    assert.equal(ledger.getIssuerPubKey('did:havix:A:issuer1'), 'pubkey-aaa')
  })

  test('registerIssuerPubKey 第二次同公钥 → registered=true（幂等）', () => {
    const ledger = new ReputationLedger()
    ledger.registerIssuerPubKey('did:havix:A:issuer1', 'pubkey-aaa')
    const r = ledger.registerIssuerPubKey('did:havix:A:issuer1', 'pubkey-aaa')
    assert.equal(r.registered, true)
    assert.equal(r.pubKey, 'pubkey-aaa')
  })

  test('registerIssuerPubKey 不同公钥 → registered=false（冲突）', () => {
    const ledger = new ReputationLedger()
    ledger.registerIssuerPubKey('did:havix:A:issuer1', 'pubkey-aaa')
    const r = ledger.registerIssuerPubKey('did:havix:A:issuer1', 'pubkey-bbb')
    assert.equal(r.registered, false)
    assert.equal(r.pubKey, 'pubkey-aaa')  // 已登记的
    assert.equal(r.conflict, 'pubkey-bbb') // 试图覆盖的
  })

  test('getIssuerPubKey 未登记返回 undefined', () => {
    const ledger = new ReputationLedger()
    assert.equal(ledger.getIssuerPubKey('did:havix:A:unknown'), undefined)
  })

  test('toJSON / loadState 持久化 issuerPubKeys', () => {
    const ledger = new ReputationLedger()
    ledger.registerIssuerPubKey('did:havix:A:issuer1', 'pubkey-aaa')
    ledger.registerIssuerPubKey('did:havix:A:issuer2', 'pubkey-bbb')
    const json = ledger.toJSON()
    assert.ok(Array.isArray(json.issuerPubKeys))
    assert.equal(json.issuerPubKeys.length, 2)

    // 加载到新 ledger
    const restored = new ReputationLedger()
    restored.loadState(json)
    assert.equal(restored.getIssuerPubKey('did:havix:A:issuer1'), 'pubkey-aaa')
    assert.equal(restored.getIssuerPubKey('did:havix:A:issuer2'), 'pubkey-bbb')
  })

  test('registerIssuerPubKey 持久化路径被调用 _persist', () => {
    // 用 spy 计数 _persist
    const ledger = new ReputationLedger()
    let persistCalls = 0
    ledger._persist = () => { persistCalls++ }
    ledger.registerIssuerPubKey('did:havix:A:issuer1', 'pubkey-aaa')
    assert.ok(persistCalls >= 1, '首次登记应触发 _persist')
    // 第二次同公钥不应再 _persist
    persistCalls = 0
    ledger.registerIssuerPubKey('did:havix:A:issuer1', 'pubkey-aaa')
    assert.equal(persistCalls, 0, '幂等登记不应 _persist')
  })

  test('registerIssuerPubKey 拒绝空 did / 空 pubKey', () => {
    const ledger = new ReputationLedger()
    assert.throws(
      () => ledger.registerIssuerPubKey('', 'pubkey'),
      /did 必须是非空字符串/,
    )
    assert.throws(
      () => ledger.registerIssuerPubKey('did:havix:A:x', ''),
      /pubKey 必须是非空字符串/,
    )
  })
})

describe('P1-3: SNode._handleCreditMessage 校验 note.signerPublicKey 绑定', () => {
  function randomSeed() {
    const seed = new Uint8Array(32)
    crypto.getRandomValues(seed)
    return seed
  }

  test('收到 issue note 后首次登记 issuerDid → pubKey', async () => {
    // 通过 SNode 集成测试路径验证（不启动真实 libp2p）
    const { SNode } = await import('../src/s-node.js')
    const node = new SNode({ logLevel: 'error', port: 0 })
    // 用 in-memory ledger
    node.reputationLedger = new ReputationLedger()
    node._processedCreditNonces = new Set()

    // 构造合法 issue note：用 context-A 子身份签
    const issuer = await IdentityWallet.fromSeed(randomSeed())
    const issuerA = issuer.get('A')
    const note = {
      type: 'issue',
      issuerDid: issuerA.did,
      holderDid: 'did:havix:A:holder1',
      amount: 5,
      nonce: 'nonce-' + Date.now() + '-' + Math.random(),
      timestamp: Date.now(),
      prevNoteCid: null,
    }
    const sigBytes = await issuerA.sign(new TextEncoder().encode(JSON.stringify(note)))
    const signedNote = {
      ...note,
      signature: Buffer.from(sigBytes).toString('base64'),
      signerPublicKey: Buffer.from(issuerA.publicKey.raw).toString('base64'),
    }

    // 调用 _handleCreditMessage
    const r = await node._handleCreditMessage({
      senderId: issuerA.did,
      payload: { note: signedNote },
      timestamp: Date.now(),
    }, {})
    // 由于 reputationLedger 没有 issuerA 的初始余额，issue 时会 freeze 抛"信誉不足"
    // 但 P1-3 校验应在 freeze 之前通过
    assert.equal(r.applied, false)
    assert.match(r.reason, /信誉不足|InsufficientReputation|amount/)

    // 关键：pubKey 已被登记
    const reg = node.reputationLedger.getIssuerPubKey(issuerA.did)
    assert.equal(reg, signedNote.signerPublicKey)
  })

  test('同一 issuerDid 用不同 pubKey 签的 note 被拒绝', async () => {
    const { SNode } = await import('../src/s-node.js')
    const node = new SNode({ logLevel: 'error', port: 0 })
    node.reputationLedger = new ReputationLedger()
    // 预登记 issuer1 → pubkey-aaa
    node.reputationLedger.registerIssuerPubKey('did:havix:A:issuer1', 'pubkey-aaa')
    node._processedCreditNonces = new Set()

    // 用 issuer2 签的 note（signerPublicKey 是 issuer2 的，但 issuerDid 声明为 issuer1）
    const issuer2 = await IdentityWallet.fromSeed(randomSeed())
    const issuerA2 = issuer2.get('A')
    const note = {
      type: 'issue',
      issuerDid: 'did:havix:A:issuer1',  // 故意声明为 issuer1
      holderDid: 'did:havix:A:holder1',
      amount: 5,
      nonce: 'nonce-evil-' + Date.now() + '-' + Math.random(),
      timestamp: Date.now(),
      prevNoteCid: null,
    }
    const sigBytes = await issuerA2.sign(new TextEncoder().encode(JSON.stringify(note)))
    const signedNote = {
      ...note,
      signature: Buffer.from(sigBytes).toString('base64'),
      signerPublicKey: Buffer.from(issuerA2.publicKey.raw).toString('base64'),  // issuer2 的公钥
    }

    const r = await node._handleCreditMessage({
      senderId: 'did:havix:A:issuer1',  // 与 issuerDid 一致，绕过 P0-2 检查
      payload: { note: signedNote },
      timestamp: Date.now(),
    }, {})

    assert.equal(r.applied, false)
    assert.match(r.reason, /P1-3 修复/)
  })
})

// ──────────────────────────────────────────────
// P1-4: ReputationLedger.get 懒创建不写盘
// ──────────────────────────────────────────────

describe('P1-4: ReputationLedger.get 懒创建不触发 _persist', () => {
  test('get(unknownDid) 不调用 _persist', () => {
    const ledger = new ReputationLedger()
    let persistCalls = 0
    ledger._persist = () => { persistCalls++ }

    const r = ledger.get('did:havix:A:new-did')
    assert.equal(r.available, 1.0)  // DEFAULT_INITIAL_REPUTATION
    assert.equal(r.frozen, 0)
    assert.equal(r.total, 1.0)
    assert.equal(persistCalls, 0, '懒创建不应触发 _persist（P1-4 修复）')
  })

  test('多次 get 同一 unknownDid 只触发一次懒创建（且都不 _persist）', () => {
    const ledger = new ReputationLedger()
    let persistCalls = 0
    ledger._persist = () => { persistCalls++ }

    ledger.get('did:havix:A:x')
    ledger.get('did:havix:A:x')
    ledger.get('did:havix:A:x')
    assert.equal(persistCalls, 0)
    // balances 已被懒创建（但内存中）
    assert.ok(ledger.balances.has('did:havix:A:x'))
  })

  test('mutation（freeze/release/credit）后 _persist 仍触发（验证未破坏）', () => {
    const ledger = new ReputationLedger()
    let persistCalls = 0
    ledger._persist = () => { persistCalls++ }

    ledger.credit('did:havix:A:x', 5)  // credit 会懒创建 + persist
    assert.ok(persistCalls >= 1, 'mutation 仍应触发 _persist')

    persistCalls = 0
    ledger.get('did:havix:A:x')  // 已存在
    assert.equal(persistCalls, 0, '已存在 did 的 get 不应 _persist')

    persistCalls = 0
    ledger.get('did:havix:A:new')  // 不存在
    assert.equal(persistCalls, 0, '懒创建不应 _persist')
  })

  test('懒创建后 toJSON 仍包含该 did（确保调用方 flush 时落盘）', () => {
    const ledger = new ReputationLedger()
    ledger.get('did:havix:A:lazy')
    const json = ledger.toJSON()
    const hasLazy = json.balances.some(([did]) => did === 'did:havix:A:lazy')
    assert.ok(hasLazy, '懒创建的 did 应在 toJSON 中')
  })

  test('高频 get 不触发磁盘 IO（性能特性验证）', () => {
    const ledger = new ReputationLedger()
    let persistCalls = 0
    ledger._persist = () => { persistCalls++ }

    // 模拟高频读：100 个新 did 各读 10 次
    for (let i = 0; i < 100; i++) {
      const did = `did:havix:A:user-${i}`
      for (let j = 0; j < 10; j++) {
        ledger.get(did)
      }
    }
    assert.equal(persistCalls, 0, '1000 次只读访问应零 _persist')
  })
})

// ──────────────────────────────────────────────
// P1-5: tunnel.js sendChunk MAX_CHUNK_SIZE 守卫
// ──────────────────────────────────────────────

describe('P1-5: Tunnel.sendChunk MAX_CHUNK_SIZE 守卫', () => {
  function makeTunnel() {
    const tunnelId = 'test-tunnel-' + Math.random().toString(36).slice(2)
    const relays = ['did:havix:A:relay1', 'did:havix:A:relay2', 'did:havix:A:relay3']
    const t = new Tunnel({
      tunnelId,
      sourceDid: 'did:havix:A:src',
      targetDid: 'did:havix:A:dst',
      relayDids: relays,
      log: () => {},
    })
    // 标记所有 link 为 active
    for (const r of relays) {
      const link = t.links.get(r)
      if (link) link.status = 'active'
    }
    return t
  }

  test('MAX_CHUNK_SIZE 常量 = 64 * 1024', () => {
    assert.equal(MAX_CHUNK_SIZE, 64 * 1024)
    assert.equal(MAX_CHUNK_SIZE, 65536)
  })

  test('sendChunk 拒绝超过 MAX_CHUNK_SIZE 的 chunk', () => {
    const t = makeTunnel()
    const oversized = new Uint8Array(MAX_CHUNK_SIZE + 1)
    assert.throws(
      () => t.sendChunk(oversized),
      (err) => err instanceof ChunkTooLargeError
        && err.code === 'CHUNK_TOO_LARGE'
        && err.size === MAX_CHUNK_SIZE + 1
        && err.max === MAX_CHUNK_SIZE
        && /P1-5/.test(err.message),
    )
  })

  test('sendChunk 拒绝 1GB chunk（极端情况）', () => {
    const t = makeTunnel()
    // 不真分配 1GB（浪费内存），构造一个 byteLength 假值
    const fakeHuge = { byteLength: 1024 * 1024 * 1024 }
    // 直接 stub：把 fakeHuge 当 chunk 传
    // 注意 sendChunk 先校验 instanceof Uint8Array，所以用 Proxy 模拟
    const fakeChunk = new Proxy(new Uint8Array(1), {
      get(target, prop) {
        if (prop === 'byteLength') return 1024 * 1024 * 1024
        return Reflect.get(target, prop)
      },
    })
    assert.throws(
      () => t.sendChunk(fakeChunk),
      (err) => err instanceof ChunkTooLargeError,
    )
  })

  test('sendChunk 接受等于 MAX_CHUNK_SIZE 的 chunk（边界值）', () => {
    const t = makeTunnel()
    const exact = new Uint8Array(MAX_CHUNK_SIZE)
    const r = t.sendChunk(exact)
    assert.equal(r.sequence, 1)
    assert.equal(r.total, 1)
  })

  test('sendChunk 接受小于 MAX_CHUNK_SIZE 的 chunk', () => {
    const t = makeTunnel()
    const small = new Uint8Array(1024)  // 1KB
    const r = t.sendChunk(small)
    assert.equal(r.sequence, 1)
  })

  test('sendChunk 接受空 chunk（0 字节）', () => {
    const t = makeTunnel()
    const empty = new Uint8Array(0)
    const r = t.sendChunk(empty)
    assert.equal(r.sequence, 1)
  })

  test('ChunkTooLargeError 不影响后续合法 chunk（隧道未损毁）', () => {
    const t = makeTunnel()
    const oversized = new Uint8Array(MAX_CHUNK_SIZE + 1)
    assert.throws(() => t.sendChunk(oversized), ChunkTooLargeError)
    // 隧道仍可用
    const ok = new Uint8Array(100)
    const r = t.sendChunk(ok)
    assert.equal(r.sequence, 1)
  })

  test('非 Uint8Array 输入仍抛通用错误（向后兼容）', () => {
    const t = makeTunnel()
    assert.throws(
      () => t.sendChunk('not-a-uint8array'),
      /chunk 必须是 Uint8Array/,
    )
    assert.throws(
      () => t.sendChunk([1, 2, 3]),
      /chunk 必须是 Uint8Array/,
    )
  })

  test('ChunkTooLargeError 错误类字段完整', () => {
    const err = new ChunkTooLargeError({
      tunnelId: 't-1',
      size: 999999,
      max: 65536,
    })
    assert.equal(err.name, 'ChunkTooLargeError')
    assert.equal(err.code, 'CHUNK_TOO_LARGE')
    assert.equal(err.tunnelId, 't-1')
    assert.equal(err.size, 999999)
    assert.equal(err.max, 65536)
  })
})
