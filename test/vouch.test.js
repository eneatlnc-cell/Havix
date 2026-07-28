// SPDX-License-Identifier: Apache-2.0

/**
 * M3.2 vouch 协议单元测试
 * ───────────────────────────────────────────────
 * 测试范围：
 *   - VouchRegistry 计数、阈值、自 vouch 拒绝、幂等
 *   - VouchRegistry.handleVouch 处理消息
 *   - publishVouch 跨节点验签链路
 *   - WikiProtocol 门控：未达阈值抛 EditorNotQualifiedError，达阈值放行
 *   - 不可关联性：context-A 签的 vouch 不能用 context-D 验
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import process from 'node:process'
import { createHeliaLight } from 'helia'

import { IdentityWallet } from '../src/identity.js'
import {
  VouchRegistry,
  publishVouch,
  VOUCH_TOPIC,
  DEFAULT_VOUCH_THRESHOLD,
} from '../src/protocol/vouch.js'
import { WikiProtocol, EditorNotQualifiedError } from '../src/protocol/wiki.js'
import { MESSAGE_TYPES, validateMessageShape } from '../src/protocol/message-types.js'
import { verifyMessageSignature } from '../src/s-node.js'

const SKIP = process.env.HAVIX_SKIP_E2E === '1'

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
// VouchRegistry 基础计数
// ──────────────────────────────────────────────

test('VouchRegistry：默认阈值 = 2', () => {
  const reg = new VouchRegistry()
  assert.equal(reg.threshold, DEFAULT_VOUCH_THRESHOLD)
  assert.equal(reg.threshold, 2)
})

test('VouchRegistry：自定义阈值', () => {
  const reg = new VouchRegistry({ threshold: 5 })
  assert.equal(reg.threshold, 5)
})

test('VouchRegistry：阈值无效时回退默认', () => {
  for (const t of [0, -1, NaN, '2', null, undefined]) {
    const reg = new VouchRegistry({ threshold: t })
    assert.equal(reg.threshold, DEFAULT_VOUCH_THRESHOLD, `threshold=${t} 应回退默认`)
  }
})

test('VouchRegistry.addVouch：基本计数递增', () => {
  const reg = new VouchRegistry({ threshold: 3 })
  const endorse = 'did:havix:D:editor'

  assert.equal(reg.getVouchCount(endorse), 0)
  assert.equal(reg.isQualified(endorse), false)

  let r = reg.addVouch(endorse, 'voucher-1')
  assert.equal(r.added, true)
  assert.equal(r.count, 1)
  assert.equal(reg.isQualified(endorse), false)

  r = reg.addVouch(endorse, 'voucher-2')
  assert.equal(r.added, true)
  assert.equal(r.count, 2)
  assert.equal(reg.isQualified(endorse), false)

  r = reg.addVouch(endorse, 'voucher-3')
  assert.equal(r.added, true)
  assert.equal(r.count, 3)
  assert.equal(reg.isQualified(endorse), true)
})

test('VouchRegistry.getVouchers：列出所有来源', () => {
  const reg = new VouchRegistry({ threshold: 2 })
  const endorse = 'did:havix:D:editor'
  reg.addVouch(endorse, 'v1')
  reg.addVouch(endorse, 'v2')
  reg.addVouch(endorse, 'v3')
  const vouchers = reg.getVouchers(endorse)
  assert.equal(vouchers.length, 3)
  assert.ok(vouchers.includes('v1'))
  assert.ok(vouchers.includes('v2'))
  assert.ok(vouchers.includes('v3'))
})

// ──────────────────────────────────────────────
// 自 vouch 与幂等
// ──────────────────────────────────────────────

test('VouchRegistry.addVouch：自 vouch 拒绝', () => {
  const reg = new VouchRegistry({ threshold: 1 })
  const did = 'did:havix:A:same'
  const r = reg.addVouch(did, did)
  assert.equal(r.added, false)
  assert.match(r.reason, /自 vouch/)
  assert.equal(reg.getVouchCount(did), 0, '自 vouch 不应计数')
})

test('VouchRegistry.addVouch：同一 vouch 幂等', () => {
  const reg = new VouchRegistry({ threshold: 3 })
  const endorse = 'did:havix:D:editor'
  const voucher = 'did:havix:A:v1'

  const r1 = reg.addVouch(endorse, voucher)
  assert.equal(r1.added, true)
  assert.equal(r1.count, 1)

  // 重复 vouch 不应累加
  const r2 = reg.addVouch(endorse, voucher)
  assert.equal(r2.added, false)
  assert.match(r2.reason, /幂等/)
  assert.equal(r2.count, 1)
  assert.equal(reg.getVouchCount(endorse), 1)
})

test('VouchRegistry.addVouch：不同 endorseDid 互不影响', () => {
  const reg = new VouchRegistry({ threshold: 2 })
  reg.addVouch('editor-1', 'voucher-X')
  reg.addVouch('editor-2', 'voucher-X')
  assert.equal(reg.getVouchCount('editor-1'), 1)
  assert.equal(reg.getVouchCount('editor-2'), 1)
  // 同一 voucher 可以为不同 endorse vouch
})

test('VouchRegistry.addVouch：参数校验', () => {
  const reg = new VouchRegistry()
  assert.equal(reg.addVouch('', 'v').added, false)
  assert.equal(reg.addVouch(null, 'v').added, false)
  assert.equal(reg.addVouch('e', '').added, false)
  assert.equal(reg.addVouch('e', null).added, false)
})

// ──────────────────────────────────────────────
// VouchRegistry.handleVouch
// ──────────────────────────────────────────────

test('VouchRegistry.handleVouch：合法消息索引', () => {
  const reg = new VouchRegistry({ threshold: 1 })
  const message = {
    version: 'v1.0',
    type: MESSAGE_TYPES.VOUCH,
    senderId: 'did:havix:A:voucher',
    timestamp: Date.now(),
    payload: { endorseDid: 'did:havix:D:editor', timestamp: Date.now() },
  }
  const r = reg.handleVouch(message)
  assert.equal(r.added, true)
  assert.equal(r.count, 1)
  assert.equal(reg.getVouchCount('did:havix:D:editor'), 1)
  assert.equal(reg.isQualified('did:havix:D:editor'), true)
})

test('VouchRegistry.handleVouch：voucherDid 取自 senderId 而非 payload', () => {
  // 防止伪造"我替别人 vouch"：voucherDid 必须是签名者
  const reg = new VouchRegistry({ threshold: 1 })
  const message = {
    version: 'v1.0',
    type: MESSAGE_TYPES.VOUCH,
    senderId: 'did:havix:A:actual-signer',
    timestamp: Date.now(),
    payload: {
      endorseDid: 'did:havix:D:editor',
      timestamp: Date.now(),
    },
  }
  reg.handleVouch(message)
  const vouchers = reg.getVouchers('did:havix:D:editor')
  assert.deepEqual(vouchers, ['did:havix:A:actual-signer'])
})

test('VouchRegistry.handleVouch：payload 缺字段拒绝', () => {
  const reg = new VouchRegistry()
  // 缺 endorseDid
  assert.equal(reg.handleVouch({
    version: 'v1.0',
    type: MESSAGE_TYPES.VOUCH,
    senderId: 'x',
    timestamp: Date.now(),
    payload: { timestamp: Date.now() },
  }).added, false)

  // 缺 timestamp
  assert.equal(reg.handleVouch({
    version: 'v1.0',
    type: MESSAGE_TYPES.VOUCH,
    senderId: 'x',
    timestamp: Date.now(),
    payload: { endorseDid: 'y' },
  }).added, false)

  // payload 完全缺失
  assert.equal(reg.handleVouch({
    version: 'v1.0',
    type: MESSAGE_TYPES.VOUCH,
    senderId: 'x',
    timestamp: Date.now(),
  }).added, false)
})

// ──────────────────────────────────────────────
// publishVouch：消息构造与签名
// ──────────────────────────────────────────────

test('publishVouch：生成合法签名消息并广播到 /s-network/reputation', async () => {
  const pubsub = makeMockPubsub()
  const wallet = await makeWallet(1)
  const endorseDid = 'did:havix:D:editor-xyz'

  const { message, recipients } = await publishVouch({
    pubsub,
    voucherIdentity: wallet.get('A'),
    endorseDid,
    reason: '测试背书',
  })

  // 结构校验
  assert.equal(message.type, MESSAGE_TYPES.VOUCH)
  assert.equal(message.senderId, wallet.get('A').did)
  assert.equal(message.payload.endorseDid, endorseDid)
  assert.equal(message.payload.reason, '测试背书')
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

  // pubsub 应被调用一次，topic 是 VOUCH_TOPIC
  assert.equal(pubsub.calls.length, 1)
  assert.equal(pubsub.calls[0].topic, VOUCH_TOPIC)
  assert.equal(pubsub.calls[0].topic, '/s-network/reputation')

  // recipients 来自 mock 的空数组
  assert.equal(recipients, 0)
})

test('publishVouch：endorseDid 空字符串抛错', async () => {
  const pubsub = makeMockPubsub()
  const wallet = await makeWallet(2)
  await assert.rejects(() => publishVouch({
    pubsub,
    voucherIdentity: wallet.get('A'),
    endorseDid: '',
  }), /endorseDid/)
})

// ──────────────────────────────────────────────
// WikiProtocol 门控
// ──────────────────────────────────────────────

test('WikiProtocol 门控：未配置 vouchRegistry 时不门控（M3.1 兼容）', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const wallet = await makeWallet(10)
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: wallet.get('D'),
      // 不传 vouchRegistry
    })
    // 应能直接发布（无门控）
    const { cid } = await wiki.publishEntry({ title: 't', content: 'x' })
    assert.match(cid, /^bafkrei/)
  } finally {
    await helia.stop()
  }
})

test('WikiProtocol 门控：未达阈值抛 EditorNotQualifiedError', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const wallet = await makeWallet(11)
    const registry = new VouchRegistry({ threshold: 2 })
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: wallet.get('D'),
      vouchRegistry: registry,
    })

    // 0 vouch → 拒绝
    await assert.rejects(
      () => wiki.publishEntry({ title: 't', content: 'x' }),
      (err) => {
        assert.equal(err.name, 'EditorNotQualifiedError')
        assert.equal(err.code, 'EDITOR_NOT_QUALIFIED')
        assert.equal(err.current, 0)
        assert.equal(err.threshold, 2)
        assert.equal(err.need, 2)
        return true
      },
    )

    // 1 vouch → 仍拒绝
    registry.addVouch(wallet.get('D').did, 'did:havix:A:voucher-1')
    await assert.rejects(
      () => wiki.publishEntry({ title: 't', content: 'x' }),
      (err) => {
        assert.equal(err.name, 'EditorNotQualifiedError')
        assert.equal(err.current, 1)
        assert.equal(err.need, 1)
        return true
      },
    )

    // entries 应仍为空
    assert.equal(wiki.listEntries().length, 0)
  } finally {
    await helia.stop()
  }
})

test('WikiProtocol 门控：达阈值放行发布', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const wallet = await makeWallet(12)
    const registry = new VouchRegistry({ threshold: 2 })
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: wallet.get('D'),
      vouchRegistry: registry,
    })

    // 给 2 个 vouch
    registry.addVouch(wallet.get('D').did, 'did:havix:A:v1')
    registry.addVouch(wallet.get('D').did, 'did:havix:A:v2')

    // 现在应能发布
    const { cid, message } = await wiki.publishEntry({ title: 't', content: 'x' })
    assert.match(cid, /^bafkrei/)
    assert.equal(message.type, MESSAGE_TYPES.WIKI_ANNOUNCE)
    assert.equal(wiki.listEntries().length, 1)
  } finally {
    await helia.stop()
  }
})

test('WikiProtocol 门控：超过阈值也能放行', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const wallet = await makeWallet(13)
    const registry = new VouchRegistry({ threshold: 2 })
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: wallet.get('D'),
      vouchRegistry: registry,
    })

    // 给 5 个 vouch（远超阈值 2）
    for (let i = 0; i < 5; i++) {
      registry.addVouch(wallet.get('D').did, `did:havix:A:v${i}`)
    }
    const { cid } = await wiki.publishEntry({ title: 't', content: 'x' })
    assert.match(cid, /^bafkrei/)
  } finally {
    await helia.stop()
  }
})

// ──────────────────────────────────────────────
// 端到端：A vouch X → B 收到消息 → B 索引 → B 可发布维基
// ──────────────────────────────────────────────

test('端到端：vouch 跨节点验签与门控', {
  skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用',
}, async () => {
  // 编辑员 X：context-D 子身份
  const walletX = await makeWallet(50)
  const editorX = walletX.get('D')

  // 背书人 A 和 B：context-A 子身份
  const walletA = await makeWallet(51)
  const walletB = await makeWallet(52)
  const voucherA = walletA.get('A')
  const voucherB = walletB.get('A')

  // 接收方 R 的 VouchRegistry（模拟 R 收到 A、B 的 vouch 消息）
  const registry = new VouchRegistry({ threshold: 2 })

  // A 发起 vouch for X
  const pubsubA = makeMockPubsub()
  const { message: msgA } = await publishVouch({
    pubsub: pubsubA,
    voucherIdentity: voucherA,
    endorseDid: editorX.did,
  })

  // B 发起 vouch for X
  const pubsubB = makeMockPubsub()
  const { message: msgB } = await publishVouch({
    pubsub: pubsubB,
    voucherIdentity: voucherB,
    endorseDid: editorX.did,
  })

  // R 收到 A 的消息：先验签，再 handleVouch
  let verify = await verifyMessageSignature(msgA)
  assert.equal(verify.valid, true, 'A 的 vouch 应验签通过')
  let r = registry.handleVouch(msgA)
  assert.equal(r.added, true)
  assert.equal(r.count, 1)
  assert.equal(registry.isQualified(editorX.did), false, '1 vouch 仍不达标')

  // R 收到 B 的消息
  verify = await verifyMessageSignature(msgB)
  assert.equal(verify.valid, true, 'B 的 vouch 应验签通过')
  r = registry.handleVouch(msgB)
  assert.equal(r.added, true)
  assert.equal(r.count, 2)
  assert.equal(registry.isQualified(editorX.did), true, '2 vouch 应达标')

  // 现在 X 可以发布维基了
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: editorX,
      vouchRegistry: registry,
    })
    const { cid } = await wiki.publishEntry({ title: '通过 vouch 门控', content: '内容' })
    assert.match(cid, /^bafkrei/)
  } finally {
    await helia.stop()
  }
})

// ──────────────────────────────────────────────
// 不可关联性：context-A 签的 vouch 不能用 context-D 验
// ──────────────────────────────────────────────

test('不可关联性：context-A 签的 vouch 不能用 context-D 验签', async () => {
  const wallet = await makeWallet(60)
  const pubsub = makeMockPubsub()
  const { message } = await publishVouch({
    pubsub,
    voucherIdentity: wallet.get('A'),
    endorseDid: 'did:havix:D:someone',
  })

  // P0-1 修复：签名现在覆盖 canonical message（移除 signature/signerPublicKey 后的字段）
  const { signature: _s, signerPublicKey: _p, ...canonical } = message
  const canonicalBytes = new TextEncoder().encode(JSON.stringify(canonical))

  // 用 context-A 公钥验 → 通过
  const verifyA = await wallet.get('A').verify(
    canonicalBytes,
    new Uint8Array(Buffer.from(message.signature, 'base64')),
  )
  assert.equal(verifyA, true)

  // 用 context-D 公钥验 → 失败
  const verifyD = await wallet.get('D').verify(
    canonicalBytes,
    new Uint8Array(Buffer.from(message.signature, 'base64')),
  )
  assert.equal(verifyD, false, 'context-D 公钥不应能验 context-A 签名')
})
