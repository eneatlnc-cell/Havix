// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Identity 派生单元测试（M2 步骤 2.1）
 * ───────────────────────────────────────────────
 * 验证四个关键安全性质：
 *   1. 派生可重现：同一种子派生出相同的 4 个子身份
 *   2. 子身份互异：4 个子身份的 PeerId / 公钥 / 私钥各不相同
 *   3. 不可关联：A 签的消息用 B 的公钥验签应失败
 *   4. 不可逆推：子种子 ≠ 主种子
 *
 * 额外验证：
 *   5. 签名/验签工作正常
 *   6. 不同主种子派生出不同的子身份
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { IdentityWallet, CONTEXTS, CONTEXT_META } from '../src/identity.js'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromString } from '@libp2p/peer-id'

// ──────────────────────────────────────────────
// 测试辅助
// ──────────────────────────────────────────────

/** 生成随机 32 字节种子（每次都不同） */
function randomSeed() {
  const seed = new Uint8Array(32)
  crypto.getRandomValues(seed)
  return seed
}

/** 转 hex 字符串 */
function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ──────────────────────────────────────────────
// 测试用例
// ──────────────────────────────────────────────

test('派生可重现：同一种子派生出相同的 4 个子身份', async () => {
  const seed = randomSeed()

  const w1 = await IdentityWallet.fromSeed(seed)
  const w2 = await IdentityWallet.fromSeed(seed)

  // 主身份相同
  assert.equal(w1.masterPeerId.toString(), w2.masterPeerId.toString())

  // 4 个子身份相同
  for (const ctx of ['A', 'B', 'C', 'D']) {
    const id1 = w1.get(ctx)
    const id2 = w2.get(ctx)
    assert.equal(id1.did, id2.did, `context ${ctx} 的 PeerId 应相同`)
    assert.deepEqual(id1.publicKey.raw, id2.publicKey.raw, `context ${ctx} 的公钥应相同`)
  }
})

test('子身份互异：4 个子身份的 PeerId 各不相同', async () => {
  const wallet = await IdentityWallet.fromSeed(randomSeed())

  const dids = wallet.identities.map(i => i.did)
  const uniqueDids = new Set(dids)
  assert.equal(uniqueDids.size, 4, '4 个子身份 PeerId 应互不相同')

  // 公钥也各不相同
  const pubkeys = wallet.identities.map(i => toHex(i.publicKey.raw))
  const uniquePubs = new Set(pubkeys)
  assert.equal(uniquePubs.size, 4, '4 个子身份公钥应互不相同')
})

test('不可关联：A 签的消息用 B 的公钥验签应失败', async () => {
  const wallet = await IdentityWallet.fromSeed(randomSeed())

  const idA = wallet.get('A')
  const idB = wallet.get('B')

  const msg = new TextEncoder().encode('cross-context message')
  const sigA = await idA.sign(msg)

  // A 签 + A 验 → 通过
  const okA = await idA.verify(msg, sigA)
  assert.equal(okA, true, 'A 签 A 验应通过')

  // A 签 + B 验 → 失败
  const okCross = await idB.verify(msg, sigA)
  assert.equal(okCross, false, 'A 签 B 验应失败')
})

test('不可逆推：子种子 ≠ 主种子', async () => {
  const masterSeed = randomSeed()
  const wallet = await IdentityWallet.fromSeed(masterSeed)

  // 主私钥的种子（前 32 字节）应与所有子身份的种子不同
  const masterSeedHex = toHex(masterSeed)

  for (const ctx of ['A', 'B', 'C', 'D']) {
    const id = wallet.get(ctx)
    const subSeedHex = toHex(id.privateKey.raw.subarray(0, 32))
    assert.notEqual(subSeedHex, masterSeedHex,
      `context ${ctx} 的子种子不应等于主种子`)
  }
})

test('子身份子种子互不相同', async () => {
  const wallet = await IdentityWallet.fromSeed(randomSeed())

  const seeds = wallet.identities.map(i => toHex(i.privateKey.raw.subarray(0, 32)))
  const unique = new Set(seeds)
  assert.equal(unique.size, 4, '4 个子种子应互不相同')
})

test('签名/验签：各 context 独立签验', async () => {
  const wallet = await IdentityWallet.fromSeed(randomSeed())

  for (const ctx of ['A', 'B', 'C', 'D']) {
    const id = wallet.get(ctx)
    const msg = new TextEncoder().encode(`test message for ${ctx}`)
    const sig = await id.sign(msg)

    assert.equal(sig.length, 64, `context ${ctx} 签名长度应为 64`)

    const ok = await id.verify(msg, sig)
    assert.equal(ok, true, `context ${ctx} 验签应通过`)
  }
})

test('篡改消息后验签失败', async () => {
  const wallet = await IdentityWallet.fromSeed(randomSeed())
  const id = wallet.get('A')

  const msg = new TextEncoder().encode('original message')
  const sig = await id.sign(msg)

  // 篡改一字节
  const tampered = new Uint8Array(msg)
  tampered[0] = tampered[0] ^ 0xff

  const ok = await id.verify(tampered, sig)
  assert.equal(ok, false, '篡改消息后验签应失败')
})

test('篡改签名后验签失败', async () => {
  const wallet = await IdentityWallet.fromSeed(randomSeed())
  const id = wallet.get('B')

  const msg = new TextEncoder().encode('original message')
  const sig = await id.sign(msg)

  // 篡改签名一字节
  const tamperedSig = new Uint8Array(sig)
  tamperedSig[0] = tamperedSig[0] ^ 0xff

  const ok = await id.verify(msg, tamperedSig)
  assert.equal(ok, false, '篡改签名后验签应失败')
})

test('不同主种子派生出不同的子身份', async () => {
  const w1 = await IdentityWallet.fromSeed(randomSeed())
  const w2 = await IdentityWallet.fromSeed(randomSeed())

  // 主 PeerId 不同
  assert.notEqual(w1.masterPeerId.toString(), w2.masterPeerId.toString())

  // 各 context 子身份也不同
  for (const ctx of ['A', 'B', 'C', 'D']) {
    assert.notEqual(w1.get(ctx).did, w2.get(ctx).did,
      `不同主种子派生的 context ${ctx} 子身份应不同`)
  }
})

test('CONTEXTS 与 CONTEXT_META 完整性', () => {
  // 4 个 context 都有定义
  for (const ctx of ['A', 'B', 'C', 'D']) {
    assert.ok(CONTEXTS[ctx], `CONTEXTS.${ctx} 应定义`)
    assert.ok(CONTEXT_META[ctx], `CONTEXT_META.${ctx} 应定义`)
    assert.ok(typeof CONTEXTS[ctx] === 'string')
    assert.ok(CONTEXT_META[ctx].name)
    assert.ok(CONTEXT_META[ctx].label)
    assert.ok(CONTEXT_META[ctx].description)
  }

  // 4 个 label 互不相同（确保 HKDF 派生结果独立）
  const labels = ['A', 'B', 'C', 'D'].map(k => CONTEXTS[k])
  assert.equal(new Set(labels).size, 4, '4 个 context label 应互不相同')
})

test('CONTEXTS 不可修改（frozen）', () => {
  assert.ok(Object.isFrozen(CONTEXTS), 'CONTEXTS 应 frozen')
  assert.ok(Object.isFrozen(CONTEXT_META), 'CONTEXT_META 应 frozen')
})

test('get 不存在的 context 抛错', async () => {
  const wallet = await IdentityWallet.fromSeed(randomSeed())

  assert.throws(() => wallet.get('E'), /未找到 context E/)
  assert.throws(() => wallet.get('X'), /未找到 context X/)
})

test('list 返回所有子身份元信息', async () => {
  const wallet = await IdentityWallet.fromSeed(randomSeed())
  const list = wallet.list()

  assert.equal(list.length, 4)
  for (const item of list) {
    assert.ok(['A', 'B', 'C', 'D'].includes(item.context))
    assert.ok(item.did.startsWith('12D3KooW'))
    assert.ok(item.label)
    assert.ok(item.name)
    assert.ok(item.description)
  }
})

test('主身份与子身份 PeerId 不同', async () => {
  const wallet = await IdentityWallet.fromSeed(randomSeed())

  for (const ctx of ['A', 'B', 'C', 'D']) {
    assert.notEqual(wallet.masterPeerId.toString(), wallet.get(ctx).did,
      `主 PeerId 不应等于 context ${ctx} 的子 PeerId`)
  }
})
