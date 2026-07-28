// SPDX-License-Identifier: Apache-2.0

/**
 * M3.1 维基协议单元测试
 * ───────────────────────────────────────────────
 * 测试 WikiProtocol 类的 publishEntry / handleAnnounce / listEntries / getEntry / fetchContent。
 *
 * 测试方案：
 *   - 用 createHeliaLight() 启动最小 helia 实例（不带 libp2p，避免 mDNS/gossipsub 噪音）
 *   - 用 IdentityWallet.fromSeed() 派生 context-D 子身份（不需要 libp2p 实例）
 *   - pubsub 用 mock：只记录 publish 调用，不真实广播
 *   - 用两个不同 wallet 模拟"作者 A"与"接收方 B"，测跨身份验签链路
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import process from 'node:process'
import { createHeliaLight } from 'helia'

import { IdentityWallet } from '../src/identity.js'
import { WikiProtocol, putContentBlock, getContentBlock, WIKI_TOPIC } from '../src/protocol/wiki.js'
import { MESSAGE_TYPES, validateMessageShape } from '../src/protocol/message-types.js'
import { verifyMessageSignature } from '../src/s-node.js'

const SKIP = process.env.HAVIX_SKIP_E2E === '1'

// 工具：创建 mock pubsub，记录所有 publish 调用
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

// 工具：用任意 32 字节种子构造 wallet
async function makeWallet(seedByte) {
  const seed = new Uint8Array(32).fill(seedByte)
  return await IdentityWallet.fromSeed(seed)
}

// ──────────────────────────────────────────────
// 工具函数：putContentBlock / getContentBlock
// ──────────────────────────────────────────────

test('putContentBlock + getContentBlock 往返一致', { skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用' }, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const content = new TextEncoder().encode('hello havix wiki')
    const cidStr = await putContentBlock(helia, content)

    assert.match(cidStr, /^bafkrei/, 'CID 应为 raw codec 的 bafkrei 前缀')

    const got = await getContentBlock(helia, cidStr)
    assert.deepEqual(Array.from(got), Array.from(content), '往返内容应一致')
  } finally {
    await helia.stop()
  }
})

test('getContentBlock：不存在的 CID 抛错', { skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用' }, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    // 构造一个合法但本地未存储的 CID
    // 用一段确定的字节计算 CID，但不调用 put，确保本地没有
    const fakeBytes = new TextEncoder().encode('this-content-does-not-exist-anywhere')
    const { CID } = await import('multiformats/cid')
    const { sha256 } = await import('multiformats/hashes/sha2')
    const hash = await sha256.digest(fakeBytes)
    const fakeCid = CID.createV1(0x55, hash).toString()
    await assert.rejects(() => getContentBlock(helia, fakeCid), /not found|NotFoundError|cannot be fetched/i)
  } finally {
    await helia.stop()
  }
})

// ──────────────────────────────────────────────
// WikiProtocol.publishEntry
// ──────────────────────────────────────────────

test('WikiProtocol.publishEntry：生成合法消息并写入 IPFS', { skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用' }, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const pubsub = makeMockPubsub()
    const wallet = await makeWallet(1)
    const wiki = new WikiProtocol({
      helia,
      pubsub,
      editorIdentity: wallet.get('D'),
    })

    const { cid, message } = await wiki.publishEntry({
      title: 'M3.1 测试条目',
      content: '这是一段测试内容。',
    })

    // 消息结构校验
    assert.equal(message.version, 'v1.0')
    assert.equal(message.type, MESSAGE_TYPES.WIKI_ANNOUNCE)
    assert.equal(message.senderId, wallet.get('D').did, 'senderId 应是 context-D 子 DID')
    assert.ok(message.timestamp > 0)
    assert.equal(message.payload.cid, cid)
    assert.equal(message.payload.title, 'M3.1 测试条目')
    assert.ok(message.signature, '应有 signature')
    assert.ok(message.signerPublicKey, '应有 signerPublicKey')

    // validateMessageShape 应通过
    const shape = validateMessageShape(message)
    assert.equal(shape.valid, true, `shape 应通过：${shape.error ?? ''}`)

    // verifyMessageSignature 应验签通过
    const verify = await verifyMessageSignature(message)
    assert.equal(verify.signed, true)
    assert.equal(verify.valid, true, `签名应验签通过：${verify.error ?? ''}`)

    // pubsub.publish 应被调用一次，topic 是 WIKI_TOPIC
    assert.equal(pubsub.calls.length, 1)
    assert.equal(pubsub.calls[0].topic, WIKI_TOPIC)
    const published = JSON.parse(new TextDecoder().decode(pubsub.calls[0].bytes))
    assert.equal(published.type, MESSAGE_TYPES.WIKI_ANNOUNCE)

    // 本地 entries 应已索引一条
    assert.equal(wiki.listEntries().length, 1)
    const entry = wiki.getEntry(cid)
    assert.ok(entry, '应能查到刚发布的条目')
    assert.equal(entry.title, 'M3.1 测试条目')
    assert.equal(entry.authorDid, wallet.get('D').did)
    assert.equal(entry.cid, cid)
  } finally {
    await helia.stop()
  }
})

test('WikiProtocol.publishEntry：content 接受 string 或 Uint8Array', { skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用' }, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const pubsub = makeMockPubsub()
    const wallet = await makeWallet(2)
    const wiki = new WikiProtocol({ helia, pubsub, editorIdentity: wallet.get('D') })

    // string 形式
    const r1 = await wiki.publishEntry({ title: 't1', content: 'hello' })
    const c1 = await wiki.fetchContent(r1.cid)
    assert.equal(new TextDecoder().decode(c1), 'hello')

    // Uint8Array 形式
    const r2 = await wiki.publishEntry({ title: 't2', content: new TextEncoder().encode('world') })
    const c2 = await wiki.fetchContent(r2.cid)
    assert.equal(new TextDecoder().decode(c2), 'world')

    // 不同内容应得到不同 CID
    assert.notEqual(r1.cid, r2.cid)
  } finally {
    await helia.stop()
  }
})

test('WikiProtocol.publishEntry：title 空字符串抛错', { skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用' }, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const pubsub = makeMockPubsub()
    const wallet = await makeWallet(3)
    const wiki = new WikiProtocol({ helia, pubsub, editorIdentity: wallet.get('D') })

    await assert.rejects(() => wiki.publishEntry({ title: '', content: 'x' }), /title/)
    await assert.rejects(() => wiki.publishEntry({ title: null, content: 'x' }), /title/)
  } finally {
    await helia.stop()
  }
})

// ──────────────────────────────────────────────
// WikiProtocol.handleAnnounce（跨节点场景）
// ──────────────────────────────────────────────

test('WikiProtocol.handleAnnounce：跨身份验签索引', { skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用' }, async () => {
  // 作者 A 用自己的 helia 发布
  // 接收方 B 用自己的 helia 接收（但 helia 只用于 fetchContent，handleAnnounce 只索引元信息）
  const heliaA = await createHeliaLight()
  await heliaA.start()
  const heliaB = await createHeliaLight()
  await heliaB.start()
  try {
    // A 节点：发布条目
    const pubsubA = makeMockPubsub()
    const walletA = await makeWallet(10)
    const wikiA = new WikiProtocol({ helia: heliaA, pubsub: pubsubA, editorIdentity: walletA.get('D') })

    const { cid, message } = await wikiA.publishEntry({
      title: '跨节点测试',
      content: '跨身份验签内容',
    })

    // B 节点：把 A 的内容也写入自己的 helia（模拟 IPFS 网络共享）
    // 真实场景下 B 会通过 bitswap 拉取，这里测试不带 bitswap，手动复制
    const content = await getContentBlock(heliaA, cid)
    await putContentBlock(heliaB, content)

    // B 节点：接收方处理 A 的消息（先验签）
    const verify = await verifyMessageSignature(message)
    assert.equal(verify.valid, true, 'B 应能验签 A 的消息')

    // B 节点：handleAnnounce 索引
    const pubsubB = makeMockPubsub()
    const walletB = await makeWallet(11)
    const wikiB = new WikiProtocol({ helia: heliaB, pubsub: pubsubB, editorIdentity: walletB.get('D') })

    const r = wikiB.handleAnnounce(message, { fromPeerId: 'peer-A' })
    assert.equal(r.indexed, true, '应索引成功')
    assert.equal(r.cid, cid)

    // B 本地 entries 应有 1 条
    assert.equal(wikiB.listEntries().length, 1)
    const entry = wikiB.getEntry(cid)
    assert.ok(entry)
    assert.equal(entry.title, '跨节点测试')
    assert.equal(entry.authorDid, walletA.get('D').did, '作者应是 A 的 context-D 子 DID')
    assert.equal(entry.fromPeerId, 'peer-A')

    // B 应能 fetchContent（已手动写入）
    const got = await wikiB.fetchContent(cid)
    assert.equal(new TextDecoder().decode(got), '跨身份验签内容')
  } finally {
    await heliaA.stop()
    await heliaB.stop()
  }
})

test('WikiProtocol.handleAnnounce：重复 CID 幂等', { skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用' }, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const wallet = await makeWallet(20)
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: wallet.get('D'),
    })

    const { message } = await wiki.publishEntry({ title: '幂等测试', content: 'x' })

    // 第二次处理同消息应返回 indexed=false（重复）
    const r = wiki.handleAnnounce(message)
    assert.equal(r.indexed, false)
    assert.match(r.error, /重复/)

    // entries 仍只有一条
    assert.equal(wiki.listEntries().length, 1)
  } finally {
    await helia.stop()
  }
})

test('WikiProtocol.handleAnnounce：payload 缺字段拒绝', { skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用' }, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const wallet = await makeWallet(21)
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: wallet.get('D'),
    })

    // 缺 cid
    assert.equal(wiki.handleAnnounce({
      version: 'v1.0',
      type: MESSAGE_TYPES.WIKI_ANNOUNCE,
      senderId: 'x',
      timestamp: Date.now(),
      payload: { title: 'x', timestamp: Date.now() },
    }).indexed, false)

    // 缺 title
    assert.equal(wiki.handleAnnounce({
      version: 'v1.0',
      type: MESSAGE_TYPES.WIKI_ANNOUNCE,
      senderId: 'x',
      timestamp: Date.now(),
      payload: { cid: 'bafk...', timestamp: Date.now() },
    }).indexed, false)

    // payload 完全缺失
    assert.equal(wiki.handleAnnounce({
      version: 'v1.0',
      type: MESSAGE_TYPES.WIKI_ANNOUNCE,
      senderId: 'x',
      timestamp: Date.now(),
    }).indexed, false)

    // entries 应保持空
    assert.equal(wiki.listEntries().length, 0)
  } finally {
    await helia.stop()
  }
})

// ──────────────────────────────────────────────
// 端到端：A 签的消息用 B 的公钥验签应失败（不可关联）
// ──────────────────────────────────────────────

test('WikiProtocol：跨 context 不可验签（context-D 签的，用 context-A 公钥验失败）', { skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用' }, async () => {
  const helia = await createHeliaLight()
  await helia.start()
  try {
    const wallet = await makeWallet(30)
    const wiki = new WikiProtocol({
      helia,
      pubsub: makeMockPubsub(),
      editorIdentity: wallet.get('D'),
    })

    const { message } = await wiki.publishEntry({ title: 't', content: 'x' })

    // P0-1 修复：签名现在覆盖 canonical message（移除 signature/signerPublicKey 后的字段）
    const { signature: _s, signerPublicKey: _p, ...canonical } = message
    const canonicalBytes = new TextEncoder().encode(JSON.stringify(canonical))

    // 用 context-D 公钥验 → 应通过
    const verifyD = await wallet.get('D').verify(
      canonicalBytes,
      new Uint8Array(Buffer.from(message.signature, 'base64')),
    )
    assert.equal(verifyD, true, 'context-D 公钥应能验签')

    // 用 context-A 公钥验 → 应失败（不可关联性）
    const verifyA = await wallet.get('A').verify(
      canonicalBytes,
      new Uint8Array(Buffer.from(message.signature, 'base64')),
    )
    assert.equal(verifyA, false, 'context-A 公钥不应能验 context-D 签名')
  } finally {
    await helia.stop()
  }
})
