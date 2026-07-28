// SPDX-License-Identifier: Apache-2.0

/**
 * M4 Credit 双轨经济单元测试
 * ───────────────────────────────────────────────
 * 测试范围：
 *   - ReputationLedger：available/frozen/total 三池模型 + credit/freeze/release/slash
 *   - CreditLedger：balance 增减 + transfer
 *   - Faucet：issue（冻结+签发）/ consume（扣减+释放）/ 门槛校验
 *   - computeWeightedScore：纯函数 + 退化模式
 *   - VouchRegistry 加权模式：getWeightedScore / getQualification / isQualified
 *   - publishCreditMessage：构造合法签名消息并广播
 *   - IPFS 助手：putCreditNoteBlock / getCreditNoteBlock 往返
 *   - WikiProtocol + 加权 VouchRegistry 端到端门控
 *   - Faucet issue → publishCreditMessage → _handleCreditMessage 镜像流程
 *
 * 设计要点：
 *   - 纯单元测试（无 helia）覆盖：ReputationLedger / CreditLedger / Faucet /
 *     computeWeightedScore / VouchRegistry 加权模式 / publishCreditMessage
 *   - 端到端测试（需 helia）：IPFS 助手 + WikiProtocol 集成 + credit 消息镜像
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import process from 'node:process'
import { createHeliaLight } from 'helia'

import { IdentityWallet } from '../src/identity.js'
import {
  ReputationLedger,
  CreditLedger,
  Faucet,
  InsufficientReputationError,
  InsufficientFrozenError,
  InsufficientCreditError,
  FaucetNotAuthorizedError,
  computeWeightedScore,
  putCreditNoteBlock,
  getCreditNoteBlock,
  publishCreditMessage,
  CREDIT_TOPIC,
  DEFAULT_INITIAL_REPUTATION,
  DEFAULT_FAUCET_MIN_REPUTATION,
} from '../src/protocol/credit.js'
import { VouchRegistry } from '../src/protocol/vouch.js'
import { WikiProtocol } from '../src/protocol/wiki.js'
import { MESSAGE_TYPES, validateMessageShape } from '../src/protocol/message-types.js'
import { verifyMessageSignature, SNode } from '../src/s-node.js'

const SKIP = process.env.HAVIX_SKIP_E2E === '1'

// ──────────────────────────────────────────────
// 工具
// ──────────────────────────────────────────────

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

async function makeWallet(seedByte) {
  const seed = new Uint8Array(32).fill(seedByte)
  return await IdentityWallet.fromSeed(seed)
}

// ──────────────────────────────────────────────
// ReputationLedger
// ──────────────────────────────────────────────

test('ReputationLedger：新 did 默认信誉 = DEFAULT_INITIAL_REPUTATION', () => {
  const ledger = new ReputationLedger()
  const r = ledger.get('did:havix:A:new')
  assert.equal(r.available, DEFAULT_INITIAL_REPUTATION)
  assert.equal(r.frozen, 0)
  assert.equal(r.total, DEFAULT_INITIAL_REPUTATION)
})

test('ReputationLedger：自定义初始信誉', () => {
  const ledger = new ReputationLedger({ initialReputation: 5.0 })
  const r = ledger.get('did:havix:A:new')
  assert.equal(r.available, 5.0)
  assert.equal(r.total, 5.0)
})

test('ReputationLedger：credit 增加可用信誉，total 跟随', () => {
  const ledger = new ReputationLedger({ initialReputation: 1.0 })
  ledger.credit('did:havix:A:alice', 9.0)
  const r = ledger.get('did:havix:A:alice')
  assert.equal(r.available, 10.0)
  assert.equal(r.frozen, 0)
  assert.equal(r.total, 10.0)
})

test('ReputationLedger：credit 拒绝非负数', () => {
  const ledger = new ReputationLedger()
  assert.throws(() => ledger.credit('d', -1), /非负数/)
  assert.throws(() => ledger.credit('d', NaN), /非负数/)
  assert.throws(() => ledger.credit('d', 'x'), /非负数/)
})

test('ReputationLedger：freeze 把 available 移到 frozen，total 不变', () => {
  const ledger = new ReputationLedger({ initialReputation: 10.0 })
  ledger.freeze('did:havix:A:alice', 3.0)
  const r = ledger.get('did:havix:A:alice')
  assert.equal(r.available, 7.0)
  assert.equal(r.frozen, 3.0)
  assert.equal(r.total, 10.0, 'total 应保持不变')
})

test('ReputationLedger：freeze 可用不足抛 InsufficientReputationError', () => {
  const ledger = new ReputationLedger({ initialReputation: 5.0 })
  assert.throws(
    () => ledger.freeze('did:havix:A:alice', 10.0),
    (err) => {
      assert.equal(err.name, 'InsufficientReputationError')
      assert.equal(err.code, 'INSUFFICIENT_REPUTATION')
      assert.equal(err.needed, 10.0)
      assert.equal(err.available, 5.0)
      return true
    },
  )
})

test('ReputationLedger：freeze 拒绝非正数', () => {
  const ledger = new ReputationLedger({ initialReputation: 100.0 })
  assert.throws(() => ledger.freeze('d', 0), /正数/)
  assert.throws(() => ledger.freeze('d', -1), /正数/)
})

test('ReputationLedger：release 把 frozen 移回 available，total 不变', () => {
  const ledger = new ReputationLedger({ initialReputation: 10.0 })
  ledger.freeze('did:havix:A:alice', 4.0)
  ledger.release('did:havix:A:alice', 4.0)
  const r = ledger.get('did:havix:A:alice')
  assert.equal(r.available, 10.0)
  assert.equal(r.frozen, 0)
  assert.equal(r.total, 10.0)
})

test('ReputationLedger：release 冻结不足抛 InsufficientFrozenError', () => {
  const ledger = new ReputationLedger({ initialReputation: 10.0 })
  ledger.freeze('did:havix:A:alice', 2.0)
  assert.throws(
    () => ledger.release('did:havix:A:alice', 5.0),
    (err) => {
      assert.equal(err.name, 'InsufficientFrozenError')
      assert.equal(err.code, 'INSUFFICIENT_FROZEN')
      assert.equal(err.needed, 5.0)
      assert.equal(err.frozen, 2.0)
      return true
    },
  )
})

test('ReputationLedger：slash 直接从 frozen 扣减，total 减少', () => {
  const ledger = new ReputationLedger({ initialReputation: 10.0 })
  ledger.freeze('did:havix:A:alice', 4.0)
  ledger.slash('did:havix:A:alice', 3.0)
  const r = ledger.get('did:havix:A:alice')
  assert.equal(r.available, 6.0, 'available 不变')
  assert.equal(r.frozen, 1.0, 'frozen 扣减')
  assert.equal(r.total, 7.0, 'total 减少（不同于 release）')
})

test('ReputationLedger：slash 冻结不足抛 InsufficientFrozenError', () => {
  const ledger = new ReputationLedger({ initialReputation: 10.0 })
  ledger.freeze('did:havix:A:alice', 2.0)
  assert.throws(
    () => ledger.slash('did:havix:A:alice', 5.0),
    (err) => {
      assert.equal(err.name, 'InsufficientFrozenError')
      return true
    },
  )
})

test('ReputationLedger：getAvailable/getFrozen/getTotal 便捷方法', () => {
  const ledger = new ReputationLedger({ initialReputation: 10.0 })
  ledger.freeze('d', 3.0)
  assert.equal(ledger.getAvailable('d'), 7.0)
  assert.equal(ledger.getFrozen('d'), 3.0)
  assert.equal(ledger.getTotal('d'), 10.0)
})

// ──────────────────────────────────────────────
// CreditLedger
// ──────────────────────────────────────────────

test('CreditLedger：未知 did 余额 = 0', () => {
  const ledger = new CreditLedger()
  assert.equal(ledger.getBalance('did:havix:A:new'), 0)
})

test('CreditLedger：credit 增加余额', () => {
  const ledger = new CreditLedger()
  assert.equal(ledger.credit('did:havix:B:bob', 5), 5)
  assert.equal(ledger.credit('did:havix:B:bob', 3), 8)
  assert.equal(ledger.getBalance('did:havix:B:bob'), 8)
})

test('CreditLedger：credit 拒绝非正数', () => {
  const ledger = new CreditLedger()
  assert.throws(() => ledger.credit('d', 0), /正数/)
  assert.throws(() => ledger.credit('d', -1), /正数/)
})

test('CreditLedger：debit 扣减余额', () => {
  const ledger = new CreditLedger()
  ledger.credit('did:havix:B:bob', 10)
  assert.equal(ledger.debit('did:havix:B:bob', 3), 7)
  assert.equal(ledger.getBalance('did:havix:B:bob'), 7)
})

test('CreditLedger：debit 余额不足抛 InsufficientCreditError', () => {
  const ledger = new CreditLedger()
  ledger.credit('did:havix:B:bob', 5)
  assert.throws(
    () => ledger.debit('did:havix:B:bob', 10),
    (err) => {
      assert.equal(err.name, 'InsufficientCreditError')
      assert.equal(err.code, 'INSUFFICIENT_CREDIT')
      assert.equal(err.needed, 10)
      assert.equal(err.balance, 5)
      return true
    },
  )
})

test('CreditLedger：transfer 从 fromDid 转到 toDid', () => {
  const ledger = new CreditLedger()
  ledger.credit('did:havix:B:alice', 10)
  const r = ledger.transfer('did:havix:B:alice', 'did:havix:B:bob', 4)
  assert.equal(r.fromBalance, 6)
  assert.equal(r.toBalance, 4)
})

test('CreditLedger：transfer 拒绝 from === to', () => {
  const ledger = new CreditLedger()
  ledger.credit('did:havix:B:bob', 10)
  assert.throws(
    () => ledger.transfer('did:havix:B:bob', 'did:havix:B:bob', 1),
    /相同/,
  )
})

test('CreditLedger：transfer 余额不足抛错', () => {
  const ledger = new CreditLedger()
  ledger.credit('did:havix:B:alice', 3)
  assert.throws(
    () => ledger.transfer('did:havix:B:alice', 'did:havix:B:bob', 10),
    InsufficientCreditError,
  )
})

// ──────────────────────────────────────────────
// Faucet
// ──────────────────────────────────────────────

test('Faucet：issuer 总信誉 < minReputation 抛 FaucetNotAuthorizedError', async () => {
  const repLedger = new ReputationLedger({ initialReputation: 1.0 })
  const creditLedger = new CreditLedger()
  const wallet = await makeWallet(1)
  const faucet = new Faucet({
    reputationLedger: repLedger,
    creditLedger: creditLedger,
    issuerIdentity: wallet.get('A'),
  })
  // 默认 rep = 1.0 < DEFAULT_FAUCET_MIN_REPUTATION (10.0)
  await assert.rejects(
    () => faucet.issue({ holderDid: 'did:havix:B:bob', amount: 1 }),
    (err) => {
      assert.equal(err.name, 'FaucetNotAuthorizedError')
      assert.equal(err.code, 'FAUCET_NOT_AUTHORIZED')
      assert.equal(err.required, DEFAULT_FAUCET_MIN_REPUTATION)
      return true
    },
  )
})

test('Faucet：issue 冻结 issuer 信誉 + credit holder 余额 + 生成签名 note', async () => {
  const repLedger = new ReputationLedger({ initialReputation: 1.0 })
  const creditLedger = new CreditLedger()
  const wallet = await makeWallet(2)
  // 给 issuer 充值到 20.0 信誉（>10 门槛）
  repLedger.credit(wallet.get('A').did, 19.0)
  const faucet = new Faucet({
    reputationLedger: repLedger,
    creditLedger: creditLedger,
    issuerIdentity: wallet.get('A'),
  })

  const holderDid = 'did:havix:B:bob'
  const { note, cid } = await faucet.issue({ holderDid, amount: 5 })

  // note 字段完整
  assert.equal(note.type, 'issue')
  assert.equal(note.issuerDid, wallet.get('A').did)
  assert.equal(note.holderDid, holderDid)
  assert.equal(note.amount, 5)
  assert.ok(typeof note.nonce === 'string' && note.nonce.length > 0, 'nonce 应是非空字符串')
  assert.ok(note.timestamp > 0)
  assert.equal(note.prevNoteCid, null)
  assert.ok(note.signature, '应有 issuer 签名')
  assert.ok(note.signerPublicKey, '应有 issuer 公钥')
  assert.equal(cid, null, 'M4 不写入 IPFS，cid 应为 null')

  // issuer 信誉：1.0 + 19.0 - 5.0(freeze) = 15.0
  const issuerRep = repLedger.get(wallet.get('A').did)
  assert.equal(issuerRep.available, 15.0)
  assert.equal(issuerRep.frozen, 5.0)
  assert.equal(issuerRep.total, 20.0, 'total 应保持不变')

  // holder 余额 = 5
  assert.equal(creditLedger.getBalance(holderDid), 5)

  // note 签名可验签
  const verify = await wallet.get('A').verify(
    new TextEncoder().encode(JSON.stringify({
      type: note.type,
      issuerDid: note.issuerDid,
      holderDid: note.holderDid,
      amount: note.amount,
      nonce: note.nonce,
      timestamp: note.timestamp,
      prevNoteCid: note.prevNoteCid,
    })),
    new Uint8Array(Buffer.from(note.signature, 'base64')),
  )
  assert.equal(verify, true, 'issuer 签名应可验签')
})

test('Faucet：issue 可用信誉不足抛 InsufficientReputationError', async () => {
  const repLedger = new ReputationLedger({ initialReputation: 1.0 })
  const creditLedger = new CreditLedger()
  const wallet = await makeWallet(3)
  repLedger.credit(wallet.get('A').did, 19.0)  // 总信誉 20.0
  const faucet = new Faucet({
    reputationLedger: repLedger,
    creditLedger: creditLedger,
    issuerIdentity: wallet.get('A'),
  })
  // 试图签发 30 credit（>可用 20）
  await assert.rejects(
    () => faucet.issue({ holderDid: 'did:havix:B:bob', amount: 30 }),
    InsufficientReputationError,
  )
  // 状态应未变化
  assert.equal(creditLedger.getBalance('did:havix:B:bob'), 0)
  assert.equal(repLedger.getFrozen(wallet.get('A').did), 0)
})

test('Faucet：issue 参数校验', async () => {
  const repLedger = new ReputationLedger({ initialReputation: 100.0 })
  const creditLedger = new CreditLedger()
  const wallet = await makeWallet(4)
  repLedger.credit(wallet.get('A').did, 100.0)
  const faucet = new Faucet({
    reputationLedger: repLedger,
    creditLedger: creditLedger,
    issuerIdentity: wallet.get('A'),
  })
  await assert.rejects(() => faucet.issue({ holderDid: '', amount: 1 }), /holderDid/)
  await assert.rejects(() => faucet.issue({ holderDid: 'x', amount: 0 }), /正数/)
  await assert.rejects(() => faucet.issue({ holderDid: 'x', amount: -1 }), /正数/)
})

test('Faucet：consume 扣 holder 余额 + 释放 issuer 冻结', async () => {
  const repLedger = new ReputationLedger({ initialReputation: 1.0 })
  const creditLedger = new CreditLedger()
  const wallet = await makeWallet(5)
  repLedger.credit(wallet.get('A').did, 19.0)  // 总信誉 20
  const faucet = new Faucet({
    reputationLedger: repLedger,
    creditLedger: creditLedger,
    issuerIdentity: wallet.get('A'),
  })

  const holderDid = 'did:havix:B:bob'
  await faucet.issue({ holderDid, amount: 5 })
  // issue 后：available=15, frozen=5, total=20

  // 消费 3 credit
  const r = faucet.consume({ holderDid, issuerDid: wallet.get('A').did, amount: 3 })
  assert.equal(r.holderBalance, 2, 'holder 余额 5-3=2')
  assert.equal(r.releasedFrozen, 2, 'issuer 冻结 5-3=2')

  // consume 后：release 把 frozen 移回 available
  //   available = 15 + 3 = 18
  //   frozen = 5 - 3 = 2
  //   total = 18 + 2 = 20（release 不减 total）
  const issuerRep = repLedger.get(wallet.get('A').did)
  assert.equal(issuerRep.available, 18.0, 'release 把 frozen 移回 available')
  assert.equal(issuerRep.frozen, 2.0)
  assert.equal(issuerRep.total, 20.0, 'total 不变（release 不减 total）')
})

test('Faucet：consume 余额不足抛 InsufficientCreditError', async () => {
  const repLedger = new ReputationLedger({ initialReputation: 1.0 })
  const creditLedger = new CreditLedger()
  const wallet = await makeWallet(6)
  repLedger.credit(wallet.get('A').did, 19.0)
  const faucet = new Faucet({
    reputationLedger: repLedger,
    creditLedger: creditLedger,
    issuerIdentity: wallet.get('A'),
  })
  const holderDid = 'did:havix:B:bob'
  await faucet.issue({ holderDid, amount: 5 })
  // 消费 10（余额只有 5）
  assert.throws(
    () => faucet.consume({ holderDid, issuerDid: wallet.get('A').did, amount: 10 }),
    InsufficientCreditError,
  )
})

test('Faucet：consume 冻结不足抛 InsufficientFrozenError', async () => {
  const repLedger = new ReputationLedger({ initialReputation: 1.0 })
  const creditLedger = new CreditLedger()
  const wallet = await makeWallet(7)
  repLedger.credit(wallet.get('A').did, 19.0)
  const faucet = new Faucet({
    reputationLedger: repLedger,
    creditLedger: creditLedger,
    issuerIdentity: wallet.get('A'),
  })
  const holderDid = 'did:havix:B:bob'
  await faucet.issue({ holderDid, amount: 5 })
  // 直接从 creditLedger 扣 4（绕过 faucet.consume），让 holder 余额=1
  creditLedger.debit(holderDid, 4)
  // 现在 holder 余额=1，issuer frozen=5；试图消费 5（余额不足先抛 InsufficientCreditError）
  assert.throws(
    () => faucet.consume({ holderDid, issuerDid: wallet.get('A').did, amount: 5 }),
    InsufficientCreditError,
  )
})

test('Faucet：consume 参数校验', async () => {
  const repLedger = new ReputationLedger({ initialReputation: 1.0 })
  const creditLedger = new CreditLedger()
  const wallet = await makeWallet(8)
  repLedger.credit(wallet.get('A').did, 19.0)
  const faucet = new Faucet({
    reputationLedger: repLedger,
    creditLedger: creditLedger,
    issuerIdentity: wallet.get('A'),
  })
  assert.throws(() => faucet.consume({ holderDid: '', issuerDid: 'x', amount: 1 }), /holderDid/)
  assert.throws(() => faucet.consume({ holderDid: 'x', issuerDid: '', amount: 1 }), /issuerDid/)
  assert.throws(() => faucet.consume({ holderDid: 'x', issuerDid: 'y', amount: 0 }), /正数/)
})

test('Faucet：P1 consume 原子性 - release 失败时回滚 holder 余额', async () => {
  // P1 修复：debit 成功但 release 失败时，必须回滚 holder 余额
  const repLedger = new ReputationLedger({ initialReputation: 1.0 })
  const creditLedger = new CreditLedger()
  const wallet = await makeWallet(10)
  repLedger.credit(wallet.get('A').did, 19.0)
  const faucet = new Faucet({
    reputationLedger: repLedger,
    creditLedger: creditLedger,
    issuerIdentity: wallet.get('A'),
  })
  const holderDid = 'did:havix:B:bob'
  // issue 5 → holder 余额=5，issuer frozen=5
  await faucet.issue({ holderDid, amount: 5 })

  // 模拟 issuer frozen 被外部 slash 减少（如 M6 仲裁）
  // 现在 issuer frozen=5，slash 3 → frozen=2
  repLedger.slash(wallet.get('A').did, 3)

  // 试图消费 5：debit 应成功（holder 余额=5），release 应失败（frozen=2 < 5）
  assert.throws(
    () => faucet.consume({ holderDid, issuerDid: wallet.get('A').did, amount: 5 }),
    InsufficientFrozenError,
  )

  // P1 验证：holder 余额应回滚到 5（未被扣减）
  const holderBalance = creditLedger.getBalance(holderDid)
  assert.equal(holderBalance, 5, 'release 失败时 holder 余额应被回滚')

  // issuer frozen 仍为 2（未被错误释放）
  const issuerRep = repLedger.get(wallet.get('A').did)
  assert.equal(issuerRep.frozen, 2, 'issuer frozen 未被错误释放')
})

test('Faucet：自定义 minReputation 门槛', async () => {
  const repLedger = new ReputationLedger({ initialReputation: 1.0 })
  const creditLedger = new CreditLedger()
  const wallet = await makeWallet(9)
  repLedger.credit(wallet.get('A').did, 4.0)  // 总信誉 5.0
  // 设置门槛 = 3.0（issuer 5.0 >= 3.0）
  const faucet = new Faucet({
    reputationLedger: repLedger,
    creditLedger: creditLedger,
    issuerIdentity: wallet.get('A'),
    minReputation: 3.0,
  })
  const { note } = await faucet.issue({ holderDid: 'did:havix:B:bob', amount: 2 })
  assert.equal(note.amount, 2)
})

// ──────────────────────────────────────────────
// computeWeightedScore：纯函数
// ──────────────────────────────────────────────

test('computeWeightedScore：无 reputationLedger 时退化为简单计数', () => {
  const vouchers = ['v1', 'v2', 'v3']
  assert.equal(computeWeightedScore(vouchers, null), 3)
  assert.equal(computeWeightedScore([], null), 0)
})

test('computeWeightedScore：有 reputationLedger 时按可用信誉求和', () => {
  const ledger = new ReputationLedger({ initialReputation: 1.0 })
  ledger.credit('v1', 9.0)  // v1 rep = 10.0
  // v2, v3 默认 1.0
  const vouchers = ['v1', 'v2', 'v3']
  // 10 + 1 + 1 = 12
  assert.equal(computeWeightedScore(vouchers, ledger), 12)
})

test('computeWeightedScore：voucher 冻结所有信誉后贡献 = 0', () => {
  const ledger = new ReputationLedger({ initialReputation: 10.0 })
  // v1 全部冻结
  ledger.freeze('v1', 10.0)
  // v1 available = 0
  const vouchers = ['v1', 'v2']
  // 0 + 10 = 10
  assert.equal(computeWeightedScore(vouchers, ledger), 10)
})

// ──────────────────────────────────────────────
// VouchRegistry 加权模式（M4 升级）
// ──────────────────────────────────────────────

test('VouchRegistry：默认 thresholdScore = threshold * DEFAULT_INITIAL_REPUTATION', () => {
  const ledger = new ReputationLedger()
  const reg = new VouchRegistry({ threshold: 2, reputationLedger: ledger })
  assert.equal(reg.thresholdScore, 2 * DEFAULT_INITIAL_REPUTATION)
  assert.equal(reg.thresholdScore, 2.0)
})

test('VouchRegistry：自定义 thresholdScore', () => {
  const ledger = new ReputationLedger()
  const reg = new VouchRegistry({
    threshold: 2,
    thresholdScore: 5.0,
    reputationLedger: ledger,
  })
  assert.equal(reg.thresholdScore, 5.0)
})

test('VouchRegistry：无 reputationLedger 时 getQualification 返回整数（M3.2 兼容）', () => {
  const reg = new VouchRegistry({ threshold: 2 })
  reg.addVouch('endorse', 'v1')
  const q = reg.getQualification('endorse')
  assert.equal(q.score, 1)
  assert.equal(q.threshold, 2)
  assert.equal(q.qualified, false)
  reg.addVouch('endorse', 'v2')
  const q2 = reg.getQualification('endorse')
  assert.equal(q2.score, 2)
  assert.equal(q2.qualified, true)
})

test('VouchRegistry：有 reputationLedger 时 getQualification 返回加权 score', () => {
  const ledger = new ReputationLedger({ initialReputation: 1.0 })
  const reg = new VouchRegistry({ threshold: 2, reputationLedger: ledger })
  // 默认 rep 1.0 的 v1 vouch → score = 1.0
  reg.addVouch('endorse', 'v1')
  let q = reg.getQualification('endorse')
  assert.equal(q.score, 1.0)
  assert.equal(q.threshold, 2.0)
  assert.equal(q.qualified, false, '1.0 < 2.0 不达标')

  // 第二个 vouch → score = 2.0 → 刚好达标
  reg.addVouch('endorse', 'v2')
  q = reg.getQualification('endorse')
  assert.equal(q.score, 2.0)
  assert.equal(q.qualified, true, '2.0 >= 2.0 达标')
})

test('VouchRegistry：高信誉 voucher 的 vouch 更有分量', () => {
  const ledger = new ReputationLedger({ initialReputation: 1.0 })
  // v1 是高信誉节点（rep=10）
  ledger.credit('v1', 9.0)
  const reg = new VouchRegistry({ threshold: 2, reputationLedger: ledger })

  // 单个高信誉 vouch → score = 10 >= 2 → 达标
  reg.addVouch('endorse', 'v1')
  const q = reg.getQualification('endorse')
  assert.equal(q.score, 10.0)
  assert.equal(q.qualified, true, '1 个 rep=10 的 voucher 相当于 10 个默认 vouch')
})

test('VouchRegistry：isQualified 在加权模式下正确切换', () => {
  const ledger = new ReputationLedger({ initialReputation: 1.0 })
  const reg = new VouchRegistry({ threshold: 2, reputationLedger: ledger })

  // 0 vouch → 不达标
  assert.equal(reg.isQualified('endorse'), false)

  // 1 默认 vouch → score=1 < 2 → 不达标
  reg.addVouch('endorse', 'v1')
  assert.equal(reg.isQualified('endorse'), false)

  // 2 默认 vouch → score=2 >= 2 → 达标
  reg.addVouch('endorse', 'v2')
  assert.equal(reg.isQualified('endorse'), true)
})

test('VouchRegistry：getWeightedScore 等于 Σ(voucherDid 可用信誉)', () => {
  const ledger = new ReputationLedger({ initialReputation: 1.0 })
  ledger.credit('v1', 4.0)  // v1 = 5
  ledger.credit('v2', 9.0)  // v2 = 10
  // v3 默认 = 1
  const reg = new VouchRegistry({ threshold: 2, reputationLedger: ledger })
  reg.addVouch('endorse', 'v1')
  reg.addVouch('endorse', 'v2')
  reg.addVouch('endorse', 'v3')
  // 5 + 10 + 1 = 16
  assert.equal(reg.getWeightedScore('endorse'), 16)
})

test('VouchRegistry：无 reputationLedger 时 getWeightedScore 退化为计数', () => {
  const reg = new VouchRegistry({ threshold: 2 })
  reg.addVouch('endorse', 'v1')
  reg.addVouch('endorse', 'v2')
  reg.addVouch('endorse', 'v3')
  assert.equal(reg.getWeightedScore('endorse'), 3)
})

// ──────────────────────────────────────────────
// publishCreditMessage：消息构造与广播
// ──────────────────────────────────────────────

test('publishCreditMessage：生成合法签名消息并广播到 /s-network/reputation', async () => {
  const pubsub = makeMockPubsub()
  const wallet = await makeWallet(20)
  // 构造一个已签名的 note（用 Faucet.issue 生成）
  const repLedger = new ReputationLedger({ initialReputation: 1.0 })
  repLedger.credit(wallet.get('A').did, 19.0)
  const creditLedger = new CreditLedger()
  const faucet = new Faucet({
    reputationLedger: repLedger,
    creditLedger: creditLedger,
    issuerIdentity: wallet.get('A'),
  })
  const { note } = await faucet.issue({ holderDid: 'did:havix:B:bob', amount: 3 })

  const { message, recipients } = await publishCreditMessage({
    pubsub,
    note,
    senderIdentity: wallet.get('A'),
  })

  // 消息结构校验
  assert.equal(message.type, MESSAGE_TYPES.CREDIT)
  assert.equal(message.senderId, wallet.get('A').did)
  assert.equal(message.payload.note, note)
  assert.ok(message.timestamp > 0)
  assert.ok(message.signature)
  assert.ok(message.signerPublicKey)

  // validateMessageShape 通过
  const shape = validateMessageShape(message)
  assert.equal(shape.valid, true, `shape 应通过：${shape.error ?? ''}`)

  // verifyMessageSignature 验签通过
  const verify = await verifyMessageSignature(message)
  assert.equal(verify.signed, true)
  assert.equal(verify.valid, true, `签名应验签通过：${verify.error ?? ''}`)

  // pubsub 应被调用一次，topic 是 CREDIT_TOPIC
  assert.equal(pubsub.calls.length, 1)
  assert.equal(pubsub.calls[0].topic, CREDIT_TOPIC)
  assert.equal(pubsub.calls[0].topic, '/s-network/reputation')

  assert.equal(recipients, 0)
})

test('publishCreditMessage：未传 senderIdentity 抛错', async () => {
  const pubsub = makeMockPubsub()
  const note = { type: 'issue', issuerDid: 'x', holderDid: 'y', amount: 1, nonce: 'n', timestamp: 1, prevNoteCid: null }
  await assert.rejects(
    () => publishCreditMessage({ pubsub, note }),
    /senderIdentity/,
  )
})

// ──────────────────────────────────────────────
// IPFS 助手：putCreditNoteBlock / getCreditNoteBlock
// ──────────────────────────────────────────────

test('putCreditNoteBlock + getCreditNoteBlock 往返一致', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const note = {
      type: 'issue',
      issuerDid: 'did:havix:A:issuer',
      holderDid: 'did:havix:B:holder',
      amount: 7,
      nonce: 'test-nonce-123',
      timestamp: Date.now(),
      prevNoteCid: null,
      signature: 'fake-sig',
      signerPublicKey: 'fake-pubkey',
    }
    const cidStr = await putCreditNoteBlock(helia, note)
    assert.match(cidStr, /^bafkrei/, 'raw codec CID 应为 bafkrei 前缀')

    const got = await getCreditNoteBlock(helia, cidStr)
    assert.deepEqual(got, note, '往返内容应一致')
  } finally {
    await helia.stop()
  }
})

// ──────────────────────────────────────────────
// 端到端：WikiProtocol + 加权 VouchRegistry 门控
// ──────────────────────────────────────────────

test('WikiProtocol 门控（加权模式）：1 个高信誉 voucher 即可放行', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const wallet = await makeWallet(30)
    const ledger = new ReputationLedger({ initialReputation: 1.0 })
    // 让 v1 成为高信誉节点（rep = 10）
    ledger.credit('did:havix:A:v1', 9.0)
    const registry = new VouchRegistry({
      threshold: 2,
      reputationLedger: ledger,  // 加权模式
    })
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: wallet.get('D'),
      vouchRegistry: registry,
    })

    // 0 vouch → 拒绝（score=0 < 2.0）
    await assert.rejects(
      () => wiki.publishEntry({ title: 't', content: 'x' }),
      (err) => {
        assert.equal(err.name, 'EditorNotQualifiedError')
        assert.equal(err.current, 0)
        assert.equal(err.threshold, 2.0)
        return true
      },
    )

    // 1 个高信誉 vouch → score=10 >= 2.0 → 放行
    registry.addVouch(wallet.get('D').did, 'did:havix:A:v1')
    const { cid } = await wiki.publishEntry({ title: 't', content: 'x' })
    assert.match(cid, /^bafkrei/)
    assert.equal(wiki.listEntries().length, 1)
  } finally {
    await helia.stop()
  }
})

test('WikiProtocol 门控（加权模式）：默认 rep 节点需 2 个 vouch 才达标', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const wallet = await makeWallet(31)
    const ledger = new ReputationLedger({ initialReputation: 1.0 })
    const registry = new VouchRegistry({
      threshold: 2,
      reputationLedger: ledger,
    })
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: wallet.get('D'),
      vouchRegistry: registry,
    })

    // 1 个默认 vouch → score=1.0 < 2.0 → 拒绝
    registry.addVouch(wallet.get('D').did, 'did:havix:A:v1')
    await assert.rejects(
      () => wiki.publishEntry({ title: 't', content: 'x' }),
      (err) => {
        assert.equal(err.name, 'EditorNotQualifiedError')
        assert.equal(err.current, 1.0)
        assert.equal(err.threshold, 2.0)
        assert.equal(err.need, 1.0)
        return true
      },
    )

    // 第 2 个默认 vouch → score=2.0 >= 2.0 → 放行
    registry.addVouch(wallet.get('D').did, 'did:havix:A:v2')
    const { cid } = await wiki.publishEntry({ title: 't', content: 'x' })
    assert.match(cid, /^bafkrei/)
  } finally {
    await helia.stop()
  }
})

// ──────────────────────────────────────────────
// 端到端：Faucet issue → publishCreditMessage → _handleCreditMessage 镜像
// ──────────────────────────────────────────────

test('端到端：A 签发 credit → B 镜像本地账本', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  // 节点 A：高信誉 issuer
  const walletA = await makeWallet(40)
  const repLedgerA = new ReputationLedger({ initialReputation: 1.0 })
  repLedgerA.credit(walletA.get('A').did, 19.0)  // A 总信誉 20
  const creditLedgerA = new CreditLedger()
  const faucetA = new Faucet({
    reputationLedger: repLedgerA,
    creditLedger: creditLedgerA,
    issuerIdentity: walletA.get('A'),
  })

  // 节点 B：独立账本，初始未与 A 同步
  // M4 不实现跨节点信誉同步——B 需预先充值 issuer 信誉，
  // 模拟"B 已通过其他途径（vouch 累积 / 历史观察）观察到 issuer 的高信誉"
  // 跨节点账本强一致同步 deferred 到 M6 仲裁团（IPFS 流水链最终裁决）
  const walletB = await makeWallet(41)
  const repLedgerB = new ReputationLedger({ initialReputation: 1.0 })
  repLedgerB.credit(walletA.get('A').did, 19.0)  // B 视图：issuer 总信誉 20
  const creditLedgerB = new CreditLedger()
  // 构造一个最小 SNode 实例只为调用 _handleCreditMessage（用 stub 替代 start()）
  const nodeB = new SNode({ logLevel: 'error' })
  nodeB.reputationLedger = repLedgerB
  nodeB.creditLedger = creditLedgerB
  nodeB._processedCreditNonces = new Set()
  nodeB.log = () => {}

  // A 签发 credit 给 holderDid
  const holderDid = 'did:havix:B:bob'
  const { note } = await faucetA.issue({ holderDid, amount: 5 })

  // A 状态：issuer frozen=5, holder balance=5
  assert.equal(repLedgerA.getFrozen(walletA.get('A').did), 5)
  assert.equal(creditLedgerA.getBalance(holderDid), 5)

  // 构造 gossipsub 消息（用 publishCreditMessage 的格式）
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ note, timestamp: Date.now() }))
  const sig = await walletA.get('A').sign(payloadBytes)
  const message = {
    version: 'v1.0',
    type: MESSAGE_TYPES.CREDIT,
    senderId: walletA.get('A').did,
    timestamp: Date.now(),
    payload: { note, timestamp: Date.now() },
    signature: Buffer.from(sig).toString('base64'),
    signerPublicKey: Buffer.from(walletA.get('A').publicKey.raw).toString('base64'),
  }

  // B 处理 credit 消息（应镜像 A 的本地操作）
  const r = await nodeB._handleCreditMessage(message, {})
  assert.equal(r.applied, true)

  // B 状态：issuer frozen=5, holder balance=5
  assert.equal(repLedgerB.getFrozen(walletA.get('A').did), 5, 'B 应镜像冻结 issuer 信誉')
  assert.equal(creditLedgerB.getBalance(holderDid), 5, 'B 应镜像 holder 余额')

  // B 再次处理同一消息 → 幂等
  const r2 = await nodeB._handleCreditMessage(message, {})
  assert.equal(r2.applied, false)
  assert.match(r2.reason, /幂等/)

  // B 状态不变
  assert.equal(repLedgerB.getFrozen(walletA.get('A').did), 5)
  assert.equal(creditLedgerB.getBalance(holderDid), 5)
})

test('端到端：_handleCreditMessage 字段校验', async () => {
  const node = new SNode({ logLevel: 'error' })
  node.reputationLedger = new ReputationLedger()
  node.creditLedger = new CreditLedger()
  node._processedCreditNonces = new Set()
  node.log = () => {}

  // payload 缺失
  assert.equal((await node._handleCreditMessage({ senderId: 'x' })).applied, false)
  // note 缺失
  assert.equal((await node._handleCreditMessage({
    payload: {},
  })).applied, false)
  // note.type 无效
  assert.equal((await node._handleCreditMessage({
    payload: { note: { type: '', issuerDid: 'a', holderDid: 'b', amount: 1, nonce: 'n' } },
  })).applied, false)
  // note.issuerDid 无效
  assert.equal((await node._handleCreditMessage({
    payload: { note: { type: 'issue', issuerDid: '', holderDid: 'b', amount: 1, nonce: 'n' } },
  })).applied, false)
  // note.amount 无效
  assert.equal((await node._handleCreditMessage({
    payload: { note: { type: 'issue', issuerDid: 'a', holderDid: 'b', amount: 0, nonce: 'n' } },
  })).applied, false)
  // note.nonce 无效
  assert.equal((await node._handleCreditMessage({
    payload: { note: { type: 'issue', issuerDid: 'a', holderDid: 'b', amount: 1, nonce: '' } },
  })).applied, false)
})

test('端到端：consume 类型 credit 消息镜像（debit holder + release issuer frozen）', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  // 节点 A：先签发 credit，再消费
  const walletA = await makeWallet(50)
  const repLedgerA = new ReputationLedger({ initialReputation: 1.0 })
  repLedgerA.credit(walletA.get('A').did, 19.0)
  const creditLedgerA = new CreditLedger()
  const faucetA = new Faucet({
    reputationLedger: repLedgerA,
    creditLedger: creditLedgerA,
    issuerIdentity: walletA.get('A'),
  })
  const holderDid = 'did:havix:B:bob'
  const { note: issueNote } = await faucetA.issue({ holderDid, amount: 5 })
  // 消费 3
  faucetA.consume({ holderDid, issuerDid: walletA.get('A').did, amount: 3 })

  // 节点 B：手动模拟 consume 类型消息（M4 consume 不广播，这里手动构造测试镜像逻辑）
  // 同 issue 测试：B 需预先充值 issuer 信誉（M4 不实现跨节点信誉同步，deferred 到 M6）
  const nodeB = new SNode({ logLevel: 'error' })
  nodeB.reputationLedger = new ReputationLedger({ initialReputation: 1.0 })
  nodeB.reputationLedger.credit(walletA.get('A').did, 19.0)  // B 视图：issuer 总信誉 20
  nodeB.creditLedger = new CreditLedger()
  nodeB._processedCreditNonces = new Set()
  nodeB.log = () => {}

  // 先让 B 也镜像 issue（用 faucetA 签发的真实 note，P0-2 验签能通过）
  const issueMessage = {
    version: 'v1.0',
    type: MESSAGE_TYPES.CREDIT,
    senderId: walletA.get('A').did,
    timestamp: Date.now(),
    payload: { note: issueNote, timestamp: Date.now() },
  }
  await nodeB._handleCreditMessage(issueMessage, {})
  assert.equal(nodeB.creditLedger.getBalance(holderDid), 5)
  assert.equal(nodeB.reputationLedger.getFrozen(walletA.get('A').did), 5)

  // 然后镜像 consume —— 手动构造 consume note 并用 issuer context-A 签名
  // （P0-2 修复：consume note 也必须有 issuer 签名，否则验签失败）
  const consumeNote = {
    type: 'consume',
    issuerDid: walletA.get('A').did,
    holderDid,
    amount: 3,
    nonce: 'nonce-consume',
    timestamp: Date.now(),
    prevNoteCid: null,
  }
  const consumeCanonical = (() => {
    const { signature: _s, signerPublicKey: _p, ...rest } = consumeNote
    return rest
  })()
  const consumeSig = await walletA.get('A').sign(
    new TextEncoder().encode(JSON.stringify(consumeCanonical)),
  )
  consumeNote.signature = Buffer.from(consumeSig).toString('base64')
  consumeNote.signerPublicKey = Buffer.from(walletA.get('A').publicKey.raw).toString('base64')

  const consumeMessage = {
    version: 'v1.0',
    type: MESSAGE_TYPES.CREDIT,
    senderId: walletA.get('A').did,
    timestamp: Date.now(),
    payload: { note: consumeNote, timestamp: Date.now() },
  }
  const r = await nodeB._handleCreditMessage(consumeMessage, {})
  assert.equal(r.applied, true)
  // B 状态：holder 余额 5-3=2, issuer frozen 5-3=2
  assert.equal(nodeB.creditLedger.getBalance(holderDid), 2)
  assert.equal(nodeB.reputationLedger.getFrozen(walletA.get('A').did), 2)
})
