// SPDX-License-Identifier: AGPL-3.0-only

/**
 * M5 SNode 隧道集成测试
 * ───────────────────────────────────────────────
 * 测试范围：
 *   - SNode.relayRegistry / tunnelManager 初始化（start() 后非 null）
 *   - SNode.registerRelayCandidate / electRelayEpoch / rotateRelayEpoch 公开 API
 *   - SNode.establishTunnel / sendTunnelChunk / breakTunnelLink / closeTunnel 公开 API
 *   - SNode.establishTunnel 在无 activeRelays 时抛 NoRelayAvailableError
 *
 * 注意：本测试不启动真实 libp2p，使用 stub 替代 start()，
 *      只验证 SNode 上的 M5 API 转发逻辑（与 credit.test.js 同风格）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SNode } from '../src/s-node.js'
import { RelayRegistry } from '../src/network/relay.js'
import { TunnelManager, LINK_STATUS, NoRelayAvailableError } from '../src/network/tunnel.js'

// 工具：构造一个未启动的 SNode，手动注入 M5 组件
function makeStubNode() {
  const node = new SNode({ logLevel: 'error' })
  node.relayRegistry = new RelayRegistry({
    minVouchCount: 1, minRelays: 3, topPercentile: 1.0,
    log: () => {},
  })
  node.tunnelManager = new TunnelManager({ log: () => {} })
  // wallet stub：context-C 子身份
  node.wallet = {
    get: (ctx) => ({ did: `did:havix:${ctx}:self` }),
  }
  node.log = () => {}
  return node
}

// ──────────────────────────────────────────────
// SNode M5 API 转发逻辑
// ──────────────────────────────────────────────

test('SNode M5 API：registerRelayCandidate 转发', () => {
  const node = makeStubNode()
  const r = node.registerRelayCandidate({
    did: 'did:havix:A:r1', reputation: 100, vouchCount: 5,
  })
  assert.equal(r.registered, true)
  assert.equal(node.relayRegistry.candidates.size, 1)
})

test('SNode M5 API：electRelayEpoch 转发', () => {
  const node = makeStubNode()
  node.registerRelayCandidate({ did: 'did:havix:A:r1', reputation: 100, vouchCount: 5 })
  node.registerRelayCandidate({ did: 'did:havix:A:r2', reputation: 90, vouchCount: 4 })
  node.registerRelayCandidate({ did: 'did:havix:A:r3', reputation: 80, vouchCount: 3 })
  const { elected, count } = node.electRelayEpoch()
  assert.equal(count, 3)
  assert.ok(elected.includes('did:havix:A:r1'))
})

test('SNode M5 API：rotateRelayEpoch 转发', () => {
  const node = makeStubNode()
  node.registerRelayCandidate({ did: 'did:havix:A:r1', reputation: 100, vouchCount: 1 })
  node.registerRelayCandidate({ did: 'did:havix:A:r2', reputation: 90, vouchCount: 1 })
  node.registerRelayCandidate({ did: 'did:havix:A:r3', reputation: 80, vouchCount: 1 })
  node.registerRelayCandidate({ did: 'did:havix:A:r4', reputation: 70, vouchCount: 1 })
  node.electRelayEpoch()
  // rng=1，无人中签
  const r = node.rotateRelayEpoch(() => 1)
  assert.deepEqual(r.rotated, [])
})

test('SNode M5 API：establishTunnel 用 activeRelays 建立', () => {
  const node = makeStubNode()
  node.registerRelayCandidate({ did: 'did:havix:A:r1', reputation: 100, vouchCount: 1 })
  node.registerRelayCandidate({ did: 'did:havix:A:r2', reputation: 90, vouchCount: 1 })
  node.registerRelayCandidate({ did: 'did:havix:A:r3', reputation: 80, vouchCount: 1 })
  node.electRelayEpoch()

  const { tunnelId, relayDids } = node.establishTunnel({
    targetDid: 'did:havix:C:bob',
  })
  assert.ok(tunnelId)
  assert.equal(relayDids.length, 3)
  // sourceDid 应是 context-C
  const tunnel = node.tunnelManager.getTunnel(tunnelId)
  assert.equal(tunnel.sourceDid, 'did:havix:C:self')
})

test('SNode M5 API：establishTunnel 无 activeRelays 时抛 NoRelayAvailableError', () => {
  const node = makeStubNode()
  // 不选举，activeRelays 为空
  assert.throws(
    () => node.establishTunnel({ targetDid: 'did:havix:C:bob' }),
    (err) => {
      assert.equal(err.name, 'NoRelayAvailableError')
      return true
    },
  )
})

test('SNode M5 API：establishTunnel 手动指定 relayDids', () => {
  const node = makeStubNode()
  const { tunnelId, relayDids } = node.establishTunnel({
    targetDid: 'did:havix:C:bob',
    relayDids: ['did:havix:A:r1', 'did:havix:A:r2', 'did:havix:A:r3'],
  })
  assert.equal(relayDids.length, 3)
  assert.ok(tunnelId)
})

test('SNode M5 API：sendTunnelChunk 转发', () => {
  const node = makeStubNode()
  const { tunnelId } = node.establishTunnel({
    targetDid: 'did:havix:C:bob',
    relayDids: ['did:havix:A:r1', 'did:havix:A:r2', 'did:havix:A:r3'],
  })
  const r = node.sendTunnelChunk({ tunnelId, chunk: new Uint8Array([1]) })
  assert.equal(r.sequence, 1)
  assert.ok(r.relay)
})

test('SNode M5 API：breakTunnelLink 转发', () => {
  const node = makeStubNode()
  const { tunnelId } = node.establishTunnel({
    targetDid: 'did:havix:C:bob',
    relayDids: ['did:havix:A:r1', 'did:havix:A:r2', 'did:havix:A:r3'],
  })
  const r = node.breakTunnelLink({ tunnelId, relayDid: 'did:havix:A:r1' })
  assert.equal(r.status, LINK_STATUS.DEGRADED)
  assert.equal(r.remainingRelays, 2)
})

test('SNode M5 API：closeTunnel 转发', () => {
  const node = makeStubNode()
  const { tunnelId } = node.establishTunnel({
    targetDid: 'did:havix:C:bob',
    relayDids: ['did:havix:A:r1', 'did:havix:A:r2', 'did:havix:A:r3'],
  })
  assert.equal(node.tunnelManager.tunnels.size, 1)
  node.closeTunnel(tunnelId)
  assert.equal(node.tunnelManager.tunnels.size, 0)
})

test('SNode M5 API：未启动时调用抛错', () => {
  const node = new SNode({ logLevel: 'error' })
  // relayRegistry / tunnelManager 都是 null
  assert.throws(() => node.registerRelayCandidate({ did: 'x' }), /未启动/)
  assert.throws(() => node.electRelayEpoch(), /未启动/)
  assert.throws(() => node.rotateRelayEpoch(), /未启动/)
  assert.throws(() => node.establishTunnel({ targetDid: 'x' }), /未启动/)
  assert.throws(() => node.sendTunnelChunk({ tunnelId: 'x', chunk: new Uint8Array() }), /未启动/)
  assert.throws(() => node.breakTunnelLink({ tunnelId: 'x', relayDid: 'y' }), /未启动/)
  assert.throws(() => node.closeTunnel('x'), /未启动/)
})

// ──────────────────────────────────────────────
// 端到端：注册 → 选举 → 建立隧道 → 发 chunk → 硬切换
// ──────────────────────────────────────────────

test('端到端：M5 完整流程', () => {
  const node = makeStubNode()

  // 1. 注册 4 个候选
  node.registerRelayCandidate({ did: 'did:havix:A:r1', reputation: 100, vouchCount: 5 })
  node.registerRelayCandidate({ did: 'did:havix:A:r2', reputation: 90, vouchCount: 4 })
  node.registerRelayCandidate({ did: 'did:havix:A:r3', reputation: 80, vouchCount: 3 })
  node.registerRelayCandidate({ did: 'did:havix:A:r4', reputation: 70, vouchCount: 2 })

  // 2. 选举：top 100% of 4 = 4，minRelays=3 兜底 → 取全部 4 个
  const { count } = node.electRelayEpoch()
  assert.equal(count, 4)

  // 3. 建立隧道（用前 3 个 active relay）
  const { tunnelId } = node.establishTunnel({ targetDid: 'did:havix:C:bob' })
  const tunnel = node.tunnelManager.getTunnel(tunnelId)
  assert.equal(tunnel.activeRelays.length, 4, 'activeRelays 全部入选')
  assert.equal(tunnel.getStatus(), LINK_STATUS.ACTIVE)

  // 4. 发 9 个 chunk（4 条 relay，round-robin 分配：2,2,2,3）
  for (let i = 0; i < 9; i++) {
    node.sendTunnelChunk({ tunnelId, chunk: new Uint8Array([i]) })
  }
  assert.equal(tunnel.totalChunks, 9)

  // 5. 断开一条 relay，状态 degraded
  node.breakTunnelLink({ tunnelId, relayDid: 'did:havix:A:r1' })
  assert.equal(tunnel.getStatus(), LINK_STATUS.DEGRADED)

  // 6. 继续发，剩余 relay 继续服务
  node.sendTunnelChunk({ tunnelId, chunk: new Uint8Array([100]) })
  assert.equal(tunnel.totalChunks, 10)

  // 7. 关闭隧道
  node.closeTunnel(tunnelId)
  assert.equal(node.tunnelManager.tunnels.size, 0)
})
