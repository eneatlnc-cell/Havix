// SPDX-License-Identifier: AGPL-3.0-only

/**
 * M2.2 身份签名端到端测试
 * ───────────────────────────────────────────────
 * 验证两个真实节点的心跳消息能互相验签。
 *
 * 场景：
 *   - 节点 A、B 通过 mDNS 自动发现并连接
 *   - 等待 30 秒触发心跳广播
 *   - 双方应收到对方的心跳消息，且验签通过
 *
 * 缩短心跳间隔：通过 SNode._timers[0] 替换为 3 秒间隔，避免测试等 30 秒。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import process from 'node:process'

import { SNode } from '../src/s-node.js'
import { loadConfig } from '../src/config.js'
import { verifyMessageSignature } from '../src/s-node.js'

const SKIP = process.env.HAVIX_SKIP_E2E === '1'

function makeConfig(name, port) {
  const c = loadConfig()
  c.name = name
  c.port = port
  c.logLevel = 'error'  // 静默，避免污染测试输出
  c.dataDir = `.data-test-${name}-${port}`
  return c
}

test('M2.2 身份签名端到端', { skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用' }, async (t) => {
  let nodeA, nodeB
  let originalInterval

  await t.test('setup: 节点 A、B 启动并派生子身份', async () => {
    nodeA = new SNode(makeConfig('alpha', 10001))
    nodeB = new SNode(makeConfig('beta', 10002))

    await nodeA.start()
    await nodeB.start()

    // 验证两个节点都派生了 4 个子身份
    assert.ok(nodeA.wallet, 'A 应有 wallet')
    assert.ok(nodeB.wallet, 'B 应有 wallet')
    assert.equal(nodeA.wallet.identities.length, 4, 'A 应有 4 个子身份')
    assert.equal(nodeB.wallet.identities.length, 4, 'B 应有 4 个子身份')

    // 主 DID 互不相同
    assert.notEqual(
      nodeA.wallet.masterPeerId.toString(),
      nodeB.wallet.masterPeerId.toString(),
      'A、B 主 DID 应不同',
    )

    // A 的 context-A 子 DID 与 B 的 context-A 子 DID 不同
    assert.notEqual(
      nodeA.wallet.get('A').did,
      nodeB.wallet.get('A').did,
      'A、B 的 context-A 子 DID 应不同',
    )
  })

  await t.test('心跳消息互相验签通过', async () => {
    // 等待 mDNS 互发现
    for (let i = 0; i < 30; i++) {
      if (nodeA.neighbors.size > 0 && nodeB.neighbors.size > 0) break
      await new Promise(r => setTimeout(r, 500))
    }
    assert.equal(nodeA.neighbors.size, 1, 'A 应发现 1 个邻居')
    assert.equal(nodeB.neighbors.size, 1, 'B 应发现 1 个邻居')

    // gossipsub mesh 需要一点时间稳定
    await new Promise(r => setTimeout(r, 2_000))

    const messagesA = []
    const messagesB = []

    const handlerA = (evt) => {
      const text = new TextDecoder().decode(evt.detail.data)
      try {
        const msg = JSON.parse(text)
        if (msg.type === 'heartbeat') messagesA.push(msg)
      } catch {}
    }
    const handlerB = (evt) => {
      const text = new TextDecoder().decode(evt.detail.data)
      try {
        const msg = JSON.parse(text)
        if (msg.type === 'heartbeat') messagesB.push(msg)
      } catch {}
    }
    nodeA.libp2p.services.pubsub.addEventListener('message', handlerA)
    nodeB.libp2p.services.pubsub.addEventListener('message', handlerB)

    // 手动触发心跳，多试几次以应对 gossipsub mesh 未稳定的早期 publish
    for (let i = 0; i < 3; i++) {
      await nodeA._broadcastHeartbeat()
      await nodeB._broadcastHeartbeat()
      await new Promise(r => setTimeout(r, 1_500))
      if (messagesA.length > 0 && messagesB.length > 0) break
    }

    nodeA.libp2p.services.pubsub.removeEventListener('message', handlerA)
    nodeB.libp2p.services.pubsub.removeEventListener('message', handlerB)

    // A 应收到 B 的心跳（B 广播、A 接收）
    assert.ok(messagesA.length > 0, 'A 应收到至少一条心跳消息')
    // B 应收到 A 的心跳
    assert.ok(messagesB.length > 0, 'B 应收到至少一条心跳消息')

    // 验证消息格式：包含 senderId（子 DID，非主 PeerId）、signature、signerPublicKey
    for (const msg of messagesA) {
      assert.equal(msg.version, 'v1.0')
      assert.equal(msg.type, 'heartbeat')
      assert.ok(msg.senderId, '应有 senderId')
      assert.ok(msg.signature, '应有 signature')
      assert.ok(msg.signerPublicKey, '应有 signerPublicKey')

      // senderId 应是 B 的 context-A 子 DID，不是 B 的主 PeerId
      const bSubA = nodeB.wallet.get('A').did
      const hasBSubA = messagesA.some(m => m.senderId === bSubA)
      assert.ok(hasBSubA, `A 收到的心跳应来自 B 的 context-A 子 DID ${bSubA.slice(0, 16)}...`)

      // senderId 不应是 B 的主 PeerId
      assert.notEqual(msg.senderId, nodeB.peerId.toString(),
        '心跳 senderId 不应是 B 的主 PeerId（应是 context-A 子 DID）')
    }

    // 验证签名
    for (const msg of messagesA) {
      const result = await verifyMessageSignature(msg)
      assert.equal(result.signed, true, '消息应已签名')
      assert.equal(result.valid, true, `签名应验签通过：${result.error ?? ''}`)
    }
    for (const msg of messagesB) {
      const result = await verifyMessageSignature(msg)
      assert.equal(result.signed, true, '消息应已签名')
      assert.equal(result.valid, true, `签名应验签通过：${result.error ?? ''}`)
    }
  })

  await t.test('篡改消息后验签失败', async () => {
    // 用 A 的子身份签一条消息，然后篡改 payload，验签应失败
    // P0-1 修复：签名现在覆盖 canonical message（含 version/type/senderId/timestamp/payload）
    const subA = nodeA.wallet.get('A')
    const payload = { test: 'original' }
    const canonical = {
      version: 'v1.0',
      type: 'test',
      senderId: subA.did,
      timestamp: Date.now(),
      payload,
    }
    const canonicalBytes = new TextEncoder().encode(JSON.stringify(canonical))
    const sig = await subA.sign(canonicalBytes)

    const msg = {
      ...canonical,
      signature: Buffer.from(sig).toString('base64'),
      signerPublicKey: Buffer.from(subA.publicKey.raw).toString('base64'),
    }

    // 原始消息验签通过
    const okOriginal = await verifyMessageSignature(msg)
    assert.equal(okOriginal.valid, true, '原始消息应验签通过')

    // 篡改 payload
    const tampered = { ...msg, payload: { test: 'tampered' } }
    const okTampered = await verifyMessageSignature(tampered)
    assert.equal(okTampered.valid, false, '篡改 payload 后验签应失败')
  })

  await t.test('teardown: 关闭节点', async () => {
    if (nodeA) await nodeA.stop()
    if (nodeB) await nodeB.stop()
  })
})
