// SPDX-License-Identifier: AGPL-3.0-only

/**
 * M7 邀请市场 + 双重加密 单元测试
 * ───────────────────────────────────────────────
 * 测试范围：
 *   - 默认常量与白皮书 §6.5 + §8 一致
 *   - AppManifest 解析与校验（必需字段、capability、permissions、trust_weight 范围）
 *   - AppManifest.marketId 唯一性与确定性
 *   - InviteToken 构造、payload、isExpired、isFor
 *   - issueInviteToken：issuer 签名 + 验签
 *   - deriveTopicFromToken：topic 名 = sha256(令牌) hex
 *   - deriveEncryptionKey：HKDF 派生 32 字节密钥
 *   - encryptMessage / decryptMessage：AES-256-GCM 加解密一致性
 *   - decryptMessage 错误密钥抛 DecryptionError
 *   - MarketRegistry：createMarket / joinMarket / leaveMarket / listMarkets
 *   - joinMarket 防护：过期令牌、inviteeDid 不匹配、nonce 重放、重复加入
 *   - publishMarketMessage：构造加密信封并广播
 *   - handleMarketMessage：接收方解密 + 验证
 *   - SNode M7 集成：未启动抛错、listMarkets 初始空、API 转发
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import {
  AppManifest,
  InviteToken,
  MarketRegistry,
  issueInviteToken,
  deriveTopicFromToken,
  deriveEncryptionKey,
  encryptMessage,
  decryptMessage,
  publishMarketMessage,
  handleMarketMessage,
  MARKET_TOPIC_PREFIX,
  MARKET_ENCRYPTION_INFO,
  AES_KEY_LENGTH,
  AES_IV_LENGTH,
  AES_AUTH_TAG_LENGTH,
  DEFAULT_TOKEN_TTL_MS,
  DEFAULT_MIN_REPUTATION,
  DEFAULT_TRUST_WEIGHT,
  MIN_TRUST_WEIGHT,
  MAX_TRUST_WEIGHT,
  MANIFEST_REQUIRED_FIELDS,
  VALID_CAPABILITIES,
  VALID_PERMISSIONS,
  InvalidManifestError,
  InvalidTokenError,
  MarketNotFoundError,
  DecryptionError,
} from '../src/protocol/market.js'
import { IdentityWallet } from '../src/identity.js'
import { SNode } from '../src/s-node.js'
import { ReputationLedger, InsufficientReputationError } from '../src/protocol/credit.js'

// ──────────────────────────────────────────────
// 工具
// ──────────────────────────────────────────────

// 构造一个 mock pubsub，记录 publish 调用
function makeMockPubsub() {
  const calls = []
  return {
    calls,
    publish: async (topic, bytes) => {
      calls.push({ topic, bytes })
      return { recipients: [] }
    },
    subscribe: async () => {},
    unsubscribe: async () => {},
  }
}

// 构造 wallet（与 arbitration.test.js 一致）
async function makeWallet(seedByte) {
  const seed = new Uint8Array(32).fill(seedByte)
  return await IdentityWallet.fromSeed(seed)
}

// 构造一个简单的 manifest
function makeManifestRaw(overrides = {}) {
  return {
    name: 'translation-market',
    version: '1.0.0',
    capability: 'market',
    permissions: ['gossipsub:publish', 'ipfs:read', 'identity:context-B'],
    min_reputation: 30,
    trust_weight: 0.8,
    ...overrides,
  }
}

// ──────────────────────────────────────────────
// 默认常量
// ──────────────────────────────────────────────

test('Market：默认常量与白皮书 §6.5 + §8 一致', () => {
  assert.equal(MARKET_TOPIC_PREFIX, '/s-network/market/')
  assert.equal(MARKET_ENCRYPTION_INFO, 'market-encryption')
  assert.equal(AES_KEY_LENGTH, 32, 'AES-256 密钥 32 字节')
  assert.equal(AES_IV_LENGTH, 12, 'GCM IV 12 字节（NIST 推荐）')
  assert.equal(AES_AUTH_TAG_LENGTH, 16, 'GCM 认证标签 16 字节')
  assert.equal(DEFAULT_TOKEN_TTL_MS, 30 * 24 * 60 * 60 * 1000, '默认令牌 TTL 30 天')
  assert.equal(DEFAULT_MIN_REPUTATION, 30, '默认 min_reputation=30')
  assert.equal(DEFAULT_TRUST_WEIGHT, 0.5, '默认 trust_weight=0.5')
  assert.equal(MIN_TRUST_WEIGHT, 0.0)
  assert.equal(MAX_TRUST_WEIGHT, 1.0)
})

test('Market：frozen 常量', () => {
  assert.deepEqual(MANIFEST_REQUIRED_FIELDS, ['name', 'version', 'capability'])
  assert.ok(VALID_CAPABILITIES.has('market'))
  assert.ok(VALID_CAPABILITIES.has('wiki'))
  assert.ok(VALID_CAPABILITIES.has('custom'))
  assert.ok(VALID_PERMISSIONS.has('gossipsub:publish'))
  assert.ok(VALID_PERMISSIONS.has('identity:context-B'))
  assert.ok(!VALID_PERMISSIONS.has('invalid:perm'))
})

// ──────────────────────────────────────────────
// AppManifest
// ──────────────────────────────────────────────

test('AppManifest：完整字段解析', () => {
  const m = new AppManifest(makeManifestRaw())
  assert.equal(m.name, 'translation-market')
  assert.equal(m.version, '1.0.0')
  assert.equal(m.capability, 'market')
  assert.deepEqual(m.permissions, ['gossipsub:publish', 'ipfs:read', 'identity:context-B'])
  assert.equal(m.inviteTokenFormat, 'ed25519-signature')
  assert.equal(m.minReputation, 30)
  assert.equal(m.trustWeight, 0.8)
  assert.equal(m.spaCid, null)
  assert.equal(m.description, '')
})

test('AppManifest：默认值', () => {
  const m = new AppManifest({
    name: 'simple',
    version: '0.1.0',
    capability: 'market',
  })
  assert.deepEqual(m.permissions, [])
  assert.equal(m.inviteTokenFormat, 'ed25519-signature')
  assert.equal(m.minReputation, DEFAULT_MIN_REPUTATION)
  assert.equal(m.trustWeight, DEFAULT_TRUST_WEIGHT)
})

test('AppManifest：必需字段缺失拒绝', () => {
  assert.throws(() => new AppManifest({ version: '1.0', capability: 'market' }),
    /name 必须是非空字符串/)
  assert.throws(() => new AppManifest({ name: '', version: '1.0', capability: 'market' }),
    /name 必须是非空字符串/)
  assert.throws(() => new AppManifest({ name: 'x', capability: 'market' }),
    /version 必须是非空字符串/)
  assert.throws(() => new AppManifest({ name: 'x', version: '1.0' }),
    /capability 必须是非空字符串/)
})

test('AppManifest：非法 capability 拒绝', () => {
  assert.throws(() => new AppManifest({
    name: 'x', version: '1.0', capability: 'invalid',
  }), /capability 必须是/)
})

test('AppManifest：非法 permission 拒绝', () => {
  assert.throws(() => new AppManifest({
    name: 'x', version: '1.0', capability: 'market',
    permissions: ['gossipsub:publish', 'invalid:perm'],
  }), /未知 permission: invalid:perm/)
})

test('AppManifest：trust_weight 范围校验', () => {
  assert.throws(() => new AppManifest({
    name: 'x', version: '1.0', capability: 'market', trust_weight: -0.1,
  }), /trust_weight 必须在/)
  assert.throws(() => new AppManifest({
    name: 'x', version: '1.0', capability: 'market', trust_weight: 1.5,
  }), /trust_weight 必须在/)
  // 边界值合法
  new AppManifest({ name: 'x', version: '1.0', capability: 'market', trust_weight: 0.0 })
  new AppManifest({ name: 'x', version: '1.0', capability: 'market', trust_weight: 1.0 })
})

test('AppManifest：min_reputation 不能为负', () => {
  assert.throws(() => new AppManifest({
    name: 'x', version: '1.0', capability: 'market', min_reputation: -1,
  }), /min_reputation 不能为负数/)
})

test('AppManifest：非法 invite_token_format 拒绝', () => {
  assert.throws(() => new AppManifest({
    name: 'x', version: '1.0', capability: 'market',
    invite_token_format: 'rsa-signature',
  }), /M7 仅支持 invite_token_format = 'ed25519-signature'/)
})

test('AppManifest.marketId：name + 短哈希，确定性', () => {
  const m1 = new AppManifest(makeManifestRaw())
  const m2 = new AppManifest(makeManifestRaw())
  assert.equal(m1.marketId, m2.marketId, '相同 manifest → 相同 marketId')
  assert.match(m1.marketId, /^translation-market-[0-9a-f]{8}$/)

  // 不同 name → 不同 marketId
  const m3 = new AppManifest(makeManifestRaw({ name: 'other-market' }))
  assert.notEqual(m1.marketId, m3.marketId)
})

test('AppManifest.toJSON / 序列化', () => {
  const m = new AppManifest(makeManifestRaw({ spa_cid: 'bafy...' }))
  const json = m.toJSON()
  assert.equal(json.name, 'translation-market')
  assert.equal(json.spa_cid, 'bafy...')
  assert.equal(json.invite_token_format, 'ed25519-signature')
})

// ──────────────────────────────────────────────
// InviteToken
// ──────────────────────────────────────────────

test('InviteToken：构造与 payload', () => {
  const t = new InviteToken({
    marketId: 'm1',
    issuerDid: 'did:havix:A:alice',
    inviteeDid: 'did:havix:B:bob',
    issuedAt: 1000,
    expiresAt: 2000,
    nonce: 'n1',
  })
  assert.deepEqual(t.payload, {
    marketId: 'm1',
    issuerDid: 'did:havix:A:alice',
    inviteeDid: 'did:havix:B:bob',
    issuedAt: 1000,
    expiresAt: 2000,
    nonce: 'n1',
  })
  assert.equal(t.signature, null)
  assert.equal(t.signerPublicKey, null)
})

test('InviteToken.isExpired', () => {
  const t = new InviteToken({
    marketId: 'm', issuerDid: 'a', inviteeDid: 'b',
    issuedAt: 1000, expiresAt: 2000, nonce: 'n',
  })
  assert.equal(t.isExpired(1500), false, '1500 < 2000 未过期')
  assert.equal(t.isExpired(2000), false, '2000 = 2000 未过期（边界）')
  assert.equal(t.isExpired(2001), true, '2001 > 2000 已过期')
})

test('InviteToken.isExpired：0 = 永不过期', () => {
  const t = new InviteToken({
    marketId: 'm', issuerDid: 'a', inviteeDid: 'b',
    issuedAt: 1000, expiresAt: 0, nonce: 'n',
  })
  assert.equal(t.isExpired(Date.now() + 999999999), false, '永不过期')
})

test('InviteToken.isFor', () => {
  const t = new InviteToken({
    marketId: 'm', issuerDid: 'a', inviteeDid: 'did:havix:B:bob',
    issuedAt: 1000, expiresAt: 2000, nonce: 'n',
  })
  assert.equal(t.isFor('did:havix:B:bob'), true)
  assert.equal(t.isFor('did:havix:B:eve'), false)
})

test('InviteToken.toJSON / fromJSON 往返一致', () => {
  const t = new InviteToken({
    marketId: 'm1', issuerDid: 'a', inviteeDid: 'b',
    issuedAt: 1000, expiresAt: 2000, nonce: 'n',
    signature: 'sig-base64', signerPublicKey: 'pk-base64',
  })
  const json = t.toJSON()
  const t2 = InviteToken.fromJSON(json)
  assert.equal(t2.marketId, 'm1')
  assert.equal(t2.signature, 'sig-base64')
  assert.equal(t2.signerPublicKey, 'pk-base64')
  assert.deepEqual(t2.payload, t.payload)
})

// ──────────────────────────────────────────────
// issueInviteToken（签名 + 验签）
// ──────────────────────────────────────────────

test('issueInviteToken：签发并验签成功', async () => {
  const wallet = await makeWallet(1)
  const issuerIdentity = wallet.get('A')

  const token = await issueInviteToken({
    marketId: 'market-abc12345',
    inviteeDid: 'did:havix:B:bob',
    issuerIdentity,
    ttlMs: 1000,
    now: 1000,
  })

  assert.equal(token.marketId, 'market-abc12345')
  assert.equal(token.issuerDid, issuerIdentity.did)
  assert.equal(token.inviteeDid, 'did:havix:B:bob')
  assert.equal(token.issuedAt, 1000)
  assert.equal(token.expiresAt, 2000)
  assert.ok(token.nonce.length > 0, 'nonce 非空')
  assert.ok(token.signature, '签名存在')
  assert.ok(token.signerPublicKey, '公钥存在')

  // 验签
  const valid = await token.verify(issuerIdentity.publicKey)
  assert.equal(valid, true, '签名验证通过')
})

test('issueInviteToken：ttlMs=0 永不过期', async () => {
  const wallet = await makeWallet(1)
  const token = await issueInviteToken({
    marketId: 'm',
    inviteeDid: 'did:havix:B:b',
    issuerIdentity: wallet.get('A'),
    ttlMs: 0,
    now: 1000,
  })
  assert.equal(token.expiresAt, 0, 'ttlMs=0 → expiresAt=0 永不过期')
  assert.equal(token.isExpired(Date.now() + 1e12), false)
})

test('issueInviteToken：参数校验', async () => {
  const wallet = await makeWallet(1)
  await assert.rejects(() => issueInviteToken({
    inviteeDid: 'b', issuerIdentity: wallet.get('A'),
  }), /marketId 必需/)
  await assert.rejects(() => issueInviteToken({
    marketId: 'm', issuerIdentity: wallet.get('A'),
  }), /inviteeDid 必需/)
  await assert.rejects(() => issueInviteToken({
    marketId: 'm', inviteeDid: 'b',
  }), /issuerIdentity 必需/)
})

test('issueInviteToken：篡改 payload 验签失败', async () => {
  const wallet = await makeWallet(1)
  const token = await issueInviteToken({
    marketId: 'm1',
    inviteeDid: 'did:havix:B:bob',
    issuerIdentity: wallet.get('A'),
    ttlMs: 1000,
    now: 1000,
  })
  // 篡改 inviteeDid
  token.inviteeDid = 'did:havix:B:eve'
  const valid = await token.verify(wallet.get('A').publicKey)
  assert.equal(valid, false, '篡改 payload 后验签失败')
})

test('issueInviteToken：用错误公钥验签失败', async () => {
  const wallet1 = await makeWallet(1)
  const wallet2 = await makeWallet(2)
  const token = await issueInviteToken({
    marketId: 'm1', inviteeDid: 'b',
    issuerIdentity: wallet1.get('A'),
    ttlMs: 1000, now: 1000,
  })
  const valid = await token.verify(wallet2.get('A').publicKey)
  assert.equal(valid, false, '错误公钥验签失败')
})

// ──────────────────────────────────────────────
// deriveTopicFromToken
// ──────────────────────────────────────────────

test('deriveTopicFromToken：topic = /s-network/market/<sha256 hex 64>', async () => {
  const wallet = await makeWallet(1)
  const token = await issueInviteToken({
    marketId: 'm1', inviteeDid: 'b',
    issuerIdentity: wallet.get('A'),
    ttlMs: 1000, now: 1000,
  })
  const topic = deriveTopicFromToken(token)
  assert.match(topic, /^\/s-network\/market\/[0-9a-f]{64}$/)
  assert.ok(topic.startsWith(MARKET_TOPIC_PREFIX))
})

test('deriveTopicFromToken：相同令牌 → 相同 topic（确定性）', async () => {
  const wallet = await makeWallet(1)
  const token = await issueInviteToken({
    marketId: 'm1', inviteeDid: 'b',
    issuerIdentity: wallet.get('A'),
    ttlMs: 1000, now: 1000,
  })
  const t1 = deriveTopicFromToken(token)
  const t2 = deriveTopicFromToken(token)
  assert.equal(t1, t2)
})

test('deriveTopicFromToken：不同令牌 → 不同 topic', async () => {
  const wallet = await makeWallet(1)
  const t1 = await issueInviteToken({
    marketId: 'm1', inviteeDid: 'b',
    issuerIdentity: wallet.get('A'), ttlMs: 1000, now: 1000,
  })
  const t2 = await issueInviteToken({
    marketId: 'm2', inviteeDid: 'b',
    issuerIdentity: wallet.get('A'), ttlMs: 1000, now: 1000,
  })
  assert.notEqual(deriveTopicFromToken(t1), deriveTopicFromToken(t2))
})

// ──────────────────────────────────────────────
// deriveEncryptionKey
// ──────────────────────────────────────────────

test('deriveEncryptionKey：输出 32 字节密钥', async () => {
  const wallet = await makeWallet(1)
  const token = await issueInviteToken({
    marketId: 'm1', inviteeDid: 'b',
    issuerIdentity: wallet.get('A'), ttlMs: 1000, now: 1000,
  })
  const key = deriveEncryptionKey(token)
  assert.ok(key instanceof Uint8Array)
  assert.equal(key.length, AES_KEY_LENGTH, '32 字节')
})

test('deriveEncryptionKey：相同令牌 → 相同密钥（确定性）', async () => {
  const wallet = await makeWallet(1)
  const token = await issueInviteToken({
    marketId: 'm1', inviteeDid: 'b',
    issuerIdentity: wallet.get('A'), ttlMs: 1000, now: 1000,
  })
  const k1 = deriveEncryptionKey(token)
  const k2 = deriveEncryptionKey(token)
  assert.deepEqual(Array.from(k1), Array.from(k2))
})

// ──────────────────────────────────────────────
// encryptMessage / decryptMessage
// ──────────────────────────────────────────────

test('encryptMessage / decryptMessage：加解密一致', () => {
  const key = crypto.randomBytes(AES_KEY_LENGTH)
  const plaintext = 'hello, market!'
  const encrypted = encryptMessage(key, plaintext)
  assert.ok(encrypted.iv)
  assert.ok(encrypted.ciphertext)
  assert.ok(encrypted.tag)
  assert.notEqual(encrypted.ciphertext, plaintext)

  const decrypted = decryptMessage(key, encrypted)
  const text = new TextDecoder().decode(decrypted)
  assert.equal(text, plaintext)
})

test('encryptMessage：相同明文不同 IV（随机性）', () => {
  const key = crypto.randomBytes(AES_KEY_LENGTH)
  const plaintext = 'same plaintext'
  const e1 = encryptMessage(key, plaintext)
  const e2 = encryptMessage(key, plaintext)
  assert.notEqual(e1.iv, e2.iv, 'IV 不同')
  assert.notEqual(e1.ciphertext, e2.ciphertext, '密文不同')
  // 但解密后明文一致
  assert.equal(new TextDecoder().decode(decryptMessage(key, e1)), plaintext)
  assert.equal(new TextDecoder().decode(decryptMessage(key, e2)), plaintext)
})

test('decryptMessage：错误密钥抛 DecryptionError', () => {
  const key1 = crypto.randomBytes(AES_KEY_LENGTH)
  const key2 = crypto.randomBytes(AES_KEY_LENGTH)
  const encrypted = encryptMessage(key1, 'secret')
  assert.throws(() => decryptMessage(key2, encrypted), DecryptionError)
})

test('decryptMessage：篡改密文抛 DecryptionError', () => {
  const key = crypto.randomBytes(AES_KEY_LENGTH)
  const encrypted = encryptMessage(key, 'secret')
  const tampered = { ...encrypted, ciphertext: Buffer.from('tampered').toString('base64') }
  assert.throws(() => decryptMessage(key, tampered), DecryptionError)
})

test('decryptMessage：篡改认证标签抛 DecryptionError', () => {
  const key = crypto.randomBytes(AES_KEY_LENGTH)
  const encrypted = encryptMessage(key, 'secret')
  const tampered = { ...encrypted, tag: Buffer.from('bad-tag').toString('base64') }
  assert.throws(() => decryptMessage(key, tampered), DecryptionError)
})

test('encryptMessage：非法密钥长度抛错', () => {
  assert.throws(() => encryptMessage(new Uint8Array(16), 'x'), /密钥必须是 32 字节/)
})

test('encryptMessage：支持 Uint8Array 明文', () => {
  const key = crypto.randomBytes(AES_KEY_LENGTH)
  const plaintext = new Uint8Array([1, 2, 3, 4, 5])
  const encrypted = encryptMessage(key, plaintext)
  const decrypted = decryptMessage(key, encrypted)
  assert.deepEqual(Array.from(decrypted), [1, 2, 3, 4, 5])
})

// ──────────────────────────────────────────────
// MarketRegistry
// ──────────────────────────────────────────────

async function setupMarket({ log } = {}) {
  const wallet = await makeWallet(1)
  const issuer = wallet.get('A')
  const manifest = new AppManifest(makeManifestRaw())
  const marketId = manifest.marketId

  // 创建者自邀请令牌
  const creatorToken = await issueInviteToken({
    marketId,
    inviteeDid: issuer.did,
    issuerIdentity: issuer,
    ttlMs: 1000,
    now: 1000,
  })

  const registry = new MarketRegistry({ log: log ?? (() => {}) })
  const result = registry.createMarket({ manifest, creatorToken })
  return { wallet, issuer, manifest, marketId, creatorToken, registry, ...result }
}

test('MarketRegistry.createMarket：基本流程', async () => {
  const ctx = await setupMarket()
  assert.ok(ctx.marketId)
  assert.ok(ctx.topic.startsWith(MARKET_TOPIC_PREFIX))
  assert.ok(ctx.token instanceof InviteToken)
  assert.equal(ctx.registry.listMarkets().length, 1)
  assert.equal(ctx.registry.isMember(ctx.marketId), true)
  assert.equal(ctx.registry.getManifest(ctx.marketId), ctx.manifest)
})

test('MarketRegistry.createMarket：重复 marketId 拒绝', async () => {
  const ctx = await setupMarket()
  // 用相同 manifest 再创建一次
  assert.throws(() => ctx.registry.createMarket({
    manifest: ctx.manifest,
    creatorToken: ctx.creatorToken,
  }), /已存在/)
})

test('MarketRegistry.createMarket：非 AppManifest 实例拒绝', () => {
  const registry = new MarketRegistry({ log: () => {} })
  assert.throws(() => registry.createMarket({
    manifest: { name: 'x' },
    creatorToken: {},
  }), InvalidManifestError)
})

test('MarketRegistry.createMarket：creatorToken.marketId 不匹配拒绝', async () => {
  const wallet = await makeWallet(1)
  const manifest = new AppManifest(makeManifestRaw())
  const wrongToken = await issueInviteToken({
    marketId: 'wrong-id',
    inviteeDid: wallet.get('A').did,
    issuerIdentity: wallet.get('A'),
    ttlMs: 1000, now: 1000,
  })
  const registry = new MarketRegistry({ log: () => {} })
  assert.throws(() => registry.createMarket({
    manifest, creatorToken: wrongToken,
  }), /marketId 与 manifest.marketId 不匹配/)
})

test('MarketRegistry.joinMarket：基本流程', async () => {
  const ctx = await setupMarket()
  // M7 MVP：所有成员共享同一个市场令牌（即创建者的 creatorToken）
  // 被邀请方通过 out-of-band 渠道拿到令牌，加入时用任意 myDid
  const bobDid = 'did:havix:B:bob'
  const bobReg = new MarketRegistry({ log: () => {} })
  // P0-4 修复：joinMarket 现在 async（内部调用 token.verifySelf）
  const result = await bobReg.joinMarket({
    token: ctx.creatorToken,  // 共享市场令牌
    myDid: bobDid,
    now: 1500,
  })
  assert.equal(result.marketId, ctx.marketId)
  assert.equal(result.topic, ctx.topic, '共享令牌 → 相同 topic')
  assert.equal(bobReg.isMember(ctx.marketId), true)
  assert.equal(bobReg.getManifest(ctx.marketId), null, '加入方无 manifest')
})

test('MarketRegistry.joinMarket：过期令牌拒绝', async () => {
  const ctx = await setupMarket()
  const bobReg = new MarketRegistry({ log: () => {} })
  // creatorToken 的 expiresAt=2000，now=3000 已过期
  await assert.rejects(() => bobReg.joinMarket({
    token: ctx.creatorToken, myDid: 'did:havix:B:bob', now: 3000,
  }), /令牌已过期/)
})

test('MarketRegistry.joinMarket：nonce 重放拒绝', async () => {
  const ctx = await setupMarket()
  const bobReg = new MarketRegistry({ log: () => {} })
  await bobReg.joinMarket({ token: ctx.creatorToken, myDid: 'did:havix:B:bob', now: 1500 })
  // 同一 registry 第二次加入相同 nonce 应拒绝
  await assert.rejects(() => bobReg.joinMarket({
    token: ctx.creatorToken, myDid: 'did:havix:B:eve', now: 1500,
  }), /已加入市场|令牌已使用/)
})

test('MarketRegistry.joinMarket：缺签名拒绝', async () => {
  const bobReg = new MarketRegistry({ log: () => {} })
  const token = new InviteToken({
    marketId: 'm1', issuerDid: 'a', inviteeDid: 'did:havix:B:bob',
    issuedAt: 1000, expiresAt: 2000, nonce: 'n',
  })
  await assert.rejects(() => bobReg.joinMarket({
    token, myDid: 'did:havix:B:bob', now: 1500,
  }), /令牌缺少签名/)
})

test('MarketRegistry.joinMarket：P0-4 篡改 signature 后验签失败', async () => {
  const ctx = await setupMarket()
  const bobReg = new MarketRegistry({ log: () => {} })
  // 篡改 issuerDid 但保留原 signature → verifySelf 应失败
  const tampered = InviteToken.fromJSON(ctx.creatorToken.toJSON())
  tampered.issuerDid = 'did:havix:A:attacker'
  await assert.rejects(() => bobReg.joinMarket({
    token: tampered, myDid: 'did:havix:B:bob', now: 1500,
  }), /令牌签名验证失败/)
})

test('MarketRegistry.leaveMarket：基本流程', async () => {
  const ctx = await setupMarket()
  ctx.registry.leaveMarket(ctx.marketId)
  assert.equal(ctx.registry.isMember(ctx.marketId), false)
  assert.equal(ctx.registry.listMarkets().length, 0)
})

test('MarketRegistry.leaveMarket：未知 marketId 抛错', () => {
  const registry = new MarketRegistry({ log: () => {} })
  assert.throws(() => registry.leaveMarket('unknown'), MarketNotFoundError)
})

test('MarketRegistry.getEncryptionKey / getTopic / getToken', async () => {
  const ctx = await setupMarket()
  const key = ctx.registry.getEncryptionKey(ctx.marketId)
  assert.ok(key instanceof Uint8Array)
  assert.equal(key.length, AES_KEY_LENGTH)
  assert.equal(ctx.registry.getTopic(ctx.marketId), ctx.topic)
  assert.equal(ctx.registry.getToken(ctx.marketId), ctx.creatorToken)
})

test('MarketRegistry.getEncryptionKey：未知 marketId 抛错', () => {
  const registry = new MarketRegistry({ log: () => {} })
  assert.throws(() => registry.getEncryptionKey('unknown'), MarketNotFoundError)
})

// ──────────────────────────────────────────────
// publishMarketMessage + handleMarketMessage 端到端
// ──────────────────────────────────────────────

test('publishMarketMessage：构造加密信封并广播', async () => {
  const ctx = await setupMarket()
  const pubsub = makeMockPubsub()

  const result = await publishMarketMessage({
    pubsub,
    registry: ctx.registry,
    marketId: ctx.marketId,
    senderId: 'did:havix:B:bob',
    payload: { kind: 'offer', item: 'translation', price: 5 },
  })

  assert.equal(result.topic, ctx.topic)
  assert.equal(result.recipients, 0)
  assert.equal(pubsub.calls.length, 1, 'pubsub.publish 调用 1 次')
  assert.equal(pubsub.calls[0].topic, ctx.topic)

  // 解析广播的字节
  const envelope = JSON.parse(new TextDecoder().decode(pubsub.calls[0].bytes))
  assert.equal(envelope.senderId, 'did:havix:B:bob')
  assert.equal(envelope.type, 'offer')
  assert.ok(envelope.payload.encrypted, 'payload.encrypted 存在')
  assert.ok(envelope.payload.encrypted.iv)
  assert.ok(envelope.payload.encrypted.ciphertext)
  assert.ok(envelope.payload.encrypted.tag)
  // 明文信封不应包含原 payload 明文
  assert.equal(envelope.payload.item, undefined, '原 payload 字段不应暴露在信封')
})

test('handleMarketMessage：解密并验证', async () => {
  const ctx = await setupMarket()
  const pubsub = makeMockPubsub()

  await publishMarketMessage({
    pubsub,
    registry: ctx.registry,
    marketId: ctx.marketId,
    senderId: 'did:havix:B:bob',
    payload: { kind: 'offer', item: 'translation', price: 5 },
  })

  const envelope = JSON.parse(new TextDecoder().decode(pubsub.calls[0].bytes))
  const decoded = handleMarketMessage({
    registry: ctx.registry,
    envelope,
    topic: ctx.topic,
  })

  assert.equal(decoded.marketId, ctx.marketId)
  assert.equal(decoded.senderId, 'did:havix:B:bob')
  assert.deepEqual(decoded.payload, { kind: 'offer', item: 'translation', price: 5 })
})

test('handleMarketMessage：未知 topic 抛 MarketNotFoundError', async () => {
  const ctx = await setupMarket()
  const pubsub = makeMockPubsub()
  await publishMarketMessage({
    pubsub,
    registry: ctx.registry,
    marketId: ctx.marketId,
    senderId: 'b',
    payload: { x: 1 },
  })
  const envelope = JSON.parse(new TextDecoder().decode(pubsub.calls[0].bytes))
  assert.throws(() => handleMarketMessage({
    registry: ctx.registry,
    envelope,
    topic: '/s-network/market/unknown',
  }), MarketNotFoundError)
})

test('handleMarketMessage：用错误 registry 解密失败', async () => {
  // ctx1 创建市场，ctx2 是不同节点的 registry（也加入相同市场但用不同 token → 不同密钥）
  const ctx1 = await setupMarket()
  const ctx2 = await setupMarket()  // 新 wallet → 不同 issuer → 不同密钥

  // 把 ctx1 发出的消息用 ctx2 解密
  const pubsub = makeMockPubsub()
  await publishMarketMessage({
    pubsub,
    registry: ctx1.registry,
    marketId: ctx1.marketId,
    senderId: 'b',
    payload: { x: 1 },
  })

  // 把 ctx1 的 topic 注入 ctx2（让 ctx2 知道这个 topic 对应 ctx1 的 marketId）
  // 但 ctx2 没加入 ctx1 的市场，所以会 MarketNotFoundError
  const envelope = JSON.parse(new TextDecoder().decode(pubsub.calls[0].bytes))
  assert.throws(() => handleMarketMessage({
    registry: ctx2.registry,
    envelope,
    topic: ctx1.topic,
  }), MarketNotFoundError)
})

test('publishMarketMessage：参数校验', async () => {
  const ctx = await setupMarket()
  await assert.rejects(() => publishMarketMessage({
    pubsub: null, registry: ctx.registry, marketId: ctx.marketId, senderId: 'b', payload: {},
  }), /pubsub 必需/)
  await assert.rejects(() => publishMarketMessage({
    pubsub: makeMockPubsub(), registry: null, marketId: ctx.marketId, senderId: 'b', payload: {},
  }), /registry 必需/)
  await assert.rejects(() => publishMarketMessage({
    pubsub: makeMockPubsub(), registry: ctx.registry, marketId: '', senderId: 'b', payload: {},
  }), /marketId 必需/)
  await assert.rejects(() => publishMarketMessage({
    pubsub: makeMockPubsub(), registry: ctx.registry, marketId: ctx.marketId, senderId: '', payload: {},
  }), /senderId 必需/)
  await assert.rejects(() => publishMarketMessage({
    pubsub: makeMockPubsub(), registry: ctx.registry, marketId: ctx.marketId, senderId: 'b', payload: null,
  }), /payload 必须是对象/)
})

test('publishMarketMessage：未知 marketId 抛 MarketNotFoundError', async () => {
  const pubsub = makeMockPubsub()
  const registry = new MarketRegistry({ log: () => {} })
  await assert.rejects(() => publishMarketMessage({
    pubsub, registry, marketId: 'unknown', senderId: 'b', payload: {},
  }), MarketNotFoundError)
})

test('端到端：创建者发消息 → 加入方收消息', async () => {
  // 两个 wallet：alice（创建者）和 bob（被邀请方）
  const aliceWallet = await makeWallet(1)
  const bobWallet = await makeWallet(2)

  // alice 创建市场
  const manifest = new AppManifest(makeManifestRaw())
  const marketId = manifest.marketId
  const aliceIssuer = aliceWallet.get('A')

  const aliceCreatorToken = await issueInviteToken({
    marketId,
    inviteeDid: aliceIssuer.did,
    issuerIdentity: aliceIssuer,
    ttlMs: 1000, now: 1000,
  })

  const aliceReg = new MarketRegistry({ log: () => {} })
  aliceReg.createMarket({ manifest, creatorToken: aliceCreatorToken })

  // M7 MVP：bob 通过 out-of-band 渠道拿到市场令牌（即 alice 的 creatorToken）
  // bob 用自己的 context-B DID 加入，与 alice 共享相同的 topic + 密钥
  const bobDid = bobWallet.get('B').did
  const bobReg = new MarketRegistry({ log: () => {} })
  await bobReg.joinMarket({ token: aliceCreatorToken, myDid: bobDid, now: 1500 })

  // alice 和 bob 的 topic 应一致（共享同一个市场令牌 → 相同 sha256）
  assert.equal(aliceReg.getTopic(marketId), bobReg.getTopic(marketId),
    '创建者与加入方共享相同 topic')

  // alice 发布消息
  const alicePubsub = makeMockPubsub()
  await publishMarketMessage({
    pubsub: alicePubsub,
    registry: aliceReg,
    marketId,
    senderId: aliceIssuer.did,
    payload: { msg: 'hello from alice' },
  })

  // bob 通过 gossipsub 收到字节，调用 handleMarketMessage 解密
  const envelope = JSON.parse(new TextDecoder().decode(alicePubsub.calls[0].bytes))
  const decoded = handleMarketMessage({
    registry: bobReg,
    envelope,
    topic: bobReg.getTopic(marketId),
  })
  assert.equal(decoded.payload.msg, 'hello from alice')
})

// ──────────────────────────────────────────────
// SNode M7 集成
// ──────────────────────────────────────────────

test('SNode M7 API：未启动抛错', () => {
  const node = new SNode({ logLevel: 'error' })
  assert.throws(() => node.listMarkets(), /节点未启动/)
  assert.throws(() => node.isMarketMember('m'), /节点未启动/)
  assert.throws(() => node.getMarketManifest('m'), /节点未启动/)
  assert.throws(() => node.getMarketTopic('m'), /节点未启动/)
})

test('SNode M7 API：listMarkets 初始空（构造后但未 start）', () => {
  // 直接检查 SNode 构造时 marketRegistry = null
  const node = new SNode({ logLevel: 'error' })
  assert.equal(node.marketRegistry, null)
})

// ──────────────────────────────────────────────
// P1 修复：SNode.issueInvite 强制 manifest.min_reputation
// ──────────────────────────────────────────────

test('P1: SNode.issueInvite 强制 min_reputation 检查', async () => {
  const wallet = await makeWallet(20)
  const node = new SNode({ logLevel: 'error' })
  // stub wallet：直接返回真实 context-A 身份（含 sign/publicKey）
  const issuerA = wallet.get('A')
  node.wallet = { get: (ctx) => ctx === 'A' ? issuerA : { did: `did:havix:${ctx}:self` } }
  node.log = () => {}
  // stub libp2p（不实际订阅）
  node.libp2p = { services: { pubsub: { subscribe: async () => {} } } }

  // 创建 manifest 声明 min_reputation=30
  const manifest = new AppManifest({
    name: 'high-rep-market',
    version: '1.0.0',
    capability: 'market',
    min_reputation: 30,
  })

  // 模拟 reputationLedger：invitee 信誉只有 10 < 30
  node.reputationLedger = new ReputationLedger({ initialReputation: 0 })
  node.reputationLedger.credit('did:havix:B:invitee', 10)

  // 创建市场（创建者信誉 0 + initialReputation=0，但 createMarket 不校验创建者信誉）
  const marketRegistry = new MarketRegistry({ log: () => {} })
  node.marketRegistry = marketRegistry

  // 手动 createMarket（不走 SNode.createMarket，因为它需要 libp2p）
  const creatorToken = await issueInviteToken({
    marketId: manifest.marketId,
    inviteeDid: issuerA.did,
    issuerIdentity: issuerA,
  })
  marketRegistry.createMarket({ manifest, creatorToken })

  // P1 验证：invitee 信誉不足时应拒绝
  await assert.rejects(
    () => node.issueInvite({
      marketId: manifest.marketId,
      inviteeDid: 'did:havix:B:invitee',
    }),
    InsufficientReputationError,
  )
})

test('P1: SNode.issueInvite 信誉达标时放行', async () => {
  const wallet = await makeWallet(21)
  const node = new SNode({ logLevel: 'error' })
  const issuerA = wallet.get('A')
  node.wallet = { get: (ctx) => ctx === 'A' ? issuerA : { did: `did:havix:${ctx}:self` } }
  node.log = () => {}
  node.libp2p = { services: { pubsub: { subscribe: async () => {} } } }

  const manifest = new AppManifest({
    name: 'high-rep-market',
    version: '1.0.0',
    capability: 'market',
    min_reputation: 30,
  })

  // invitee 信誉 50 >= 30
  node.reputationLedger = new ReputationLedger({ initialReputation: 0 })
  node.reputationLedger.credit('did:havix:B:invitee', 50)

  const marketRegistry = new MarketRegistry({ log: () => {} })
  node.marketRegistry = marketRegistry
  const creatorToken = await issueInviteToken({
    marketId: manifest.marketId,
    inviteeDid: issuerA.did,
    issuerIdentity: issuerA,
  })
  marketRegistry.createMarket({ manifest, creatorToken })

  // 信誉达标 → 应放行
  const token = await node.issueInvite({
    marketId: manifest.marketId,
    inviteeDid: 'did:havix:B:invitee',
  })
  assert.ok(token instanceof InviteToken)
  assert.equal(token.inviteeDid, 'did:havix:B:invitee')
})
