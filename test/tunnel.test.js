// SPDX-License-Identifier: Apache-2.0

/**
 * M5 私聊隧道单元测试
 * ───────────────────────────────────────────────
 * 测试范围：
 *   - Tunnel / TunnelManager 建立与查询
 *   - 多链路对冲：round-robin 分片，3 条 relay 各传 1/3 流量
 *   - 硬切换：relay 下线从 active 移除，剩余继续；全断开抛 TunnelBrokenError
 *   - 链路状态机：active / degraded / broken
 *   - 错误类与参数校验
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  Tunnel,
  TunnelManager,
  LINK_STATUS,
  TunnelBrokenError,
  NoRelayAvailableError,
  DEFAULT_PARALLEL_RELAYS,
} from '../src/network/tunnel.js'

// 工具：构造 3 个 relay did
function makeRelayDids(prefix = 'relay') {
  return [
    `did:havix:A:${prefix}-1`,
    `did:havix:A:${prefix}-2`,
    `did:havix:A:${prefix}-3`,
  ]
}

// ──────────────────────────────────────────────
// 默认常量
// ──────────────────────────────────────────────

test('Tunnel：默认常量与白皮书 §7.2 一致', () => {
  assert.equal(DEFAULT_PARALLEL_RELAYS, 3, '默认 3 条并行 relay')
  assert.equal(LINK_STATUS.ACTIVE, 'active')
  assert.equal(LINK_STATUS.DEGRADED, 'degraded')
  assert.equal(LINK_STATUS.BROKEN, 'broken')
})

// ──────────────────────────────────────────────
// Tunnel 构造
// ──────────────────────────────────────────────

test('Tunnel：构造基本字段', () => {
  const relays = makeRelayDids()
  const t = new Tunnel({
    tunnelId: 'tunnel-1',
    sourceDid: 'did:havix:C:alice',
    targetDid: 'did:havix:C:bob',
    relayDids: relays,
  })
  assert.equal(t.tunnelId, 'tunnel-1')
  assert.equal(t.sourceDid, 'did:havix:C:alice')
  assert.equal(t.targetDid, 'did:havix:C:bob')
  assert.equal(t.activeRelays.length, 3)
  assert.equal(t.rrIndex, 0)
  assert.equal(t.totalChunks, 0)
  assert.ok(t.createdAt > 0)
  assert.equal(t.getStatus(), LINK_STATUS.ACTIVE)
})

test('Tunnel：参数校验', () => {
  const relays = makeRelayDids()
  assert.throws(() => new Tunnel({
    tunnelId: '', sourceDid: 'a', targetDid: 'b', relayDids: relays,
  }), /tunnelId/)
  assert.throws(() => new Tunnel({
    tunnelId: 't', sourceDid: '', targetDid: 'b', relayDids: relays,
  }), /sourceDid/)
  assert.throws(() => new Tunnel({
    tunnelId: 't', sourceDid: 'a', targetDid: '', relayDids: relays,
  }), /targetDid/)
  assert.throws(() => new Tunnel({
    tunnelId: 't', sourceDid: 'a', targetDid: 'b', relayDids: [],
  }), /relayDids/)
  assert.throws(() => new Tunnel({
    tunnelId: 't', sourceDid: 'a', targetDid: 'b',
  }), /relayDids/)
})

// ──────────────────────────────────────────────
// 多链路对冲：round-robin
// ──────────────────────────────────────────────

test('Tunnel.nextRelay：round-robin 分配', () => {
  const relays = makeRelayDids()
  const t = new Tunnel({
    tunnelId: 'tunnel-1',
    sourceDid: 'did:havix:C:alice',
    targetDid: 'did:havix:C:bob',
    relayDids: relays,
  })
  // 第一次应分配 relay[0]，第二次 relay[1]，第三次 relay[2]，第四次回到 relay[0]
  assert.equal(t.nextRelay(), relays[0])
  assert.equal(t.nextRelay(), relays[1])
  assert.equal(t.nextRelay(), relays[2])
  assert.equal(t.nextRelay(), relays[0])
  assert.equal(t.nextRelay(), relays[1])
})

test('Tunnel.sendChunk：3 条 relay 各传 1/3 流量', () => {
  const relays = makeRelayDids()
  const t = new Tunnel({
    tunnelId: 'tunnel-1',
    sourceDid: 'did:havix:C:alice',
    targetDid: 'did:havix:C:bob',
    relayDids: relays,
  })

  // 发 9 个 chunk
  for (let i = 0; i < 9; i++) {
    t.sendChunk(new Uint8Array([i]))
  }
  assert.equal(t.totalChunks, 9)

  // 各 relay 应各传 3 个 chunk
  const stats = t.getStats()
  for (const s of stats) {
    assert.equal(s.sentChunks, 3, `relay ${s.relayDid} 应传 3 个 chunk`)
  }
})

test('Tunnel.sendChunk：sequence 递增', () => {
  const relays = makeRelayDids()
  const t = new Tunnel({
    tunnelId: 'tunnel-1',
    sourceDid: 'a', targetDid: 'b', relayDids: relays,
  })
  const r1 = t.sendChunk(new Uint8Array([1]))
  const r2 = t.sendChunk(new Uint8Array([2]))
  const r3 = t.sendChunk(new Uint8Array([3]))
  assert.equal(r1.sequence, 1)
  assert.equal(r2.sequence, 2)
  assert.equal(r3.sequence, 3)
  assert.equal(r3.total, 3)
})

test('Tunnel.sendChunk：chunk 类型校验', () => {
  const t = new Tunnel({
    tunnelId: 't1', sourceDid: 'a', targetDid: 'b',
    relayDids: makeRelayDids(),
  })
  assert.throws(() => t.sendChunk('not-bytes'), /chunk/)
  assert.throws(() => t.sendChunk(null), /chunk/)
})

// ──────────────────────────────────────────────
// 硬切换
// ──────────────────────────────────────────────

test('Tunnel.breakLink：单 relay 断开后状态 degraded', () => {
  const relays = makeRelayDids()
  const t = new Tunnel({
    tunnelId: 't1', sourceDid: 'a', targetDid: 'b', relayDids: relays,
  })
  assert.equal(t.getStatus(), LINK_STATUS.ACTIVE)
  const r = t.breakLink(relays[0])
  assert.equal(r.status, LINK_STATUS.DEGRADED)
  assert.equal(r.remainingRelays, 2)
  assert.equal(t.getStatus(), LINK_STATUS.DEGRADED)
  assert.equal(t.activeRelays.length, 2)
  assert.ok(!t.activeRelays.includes(relays[0]))
})

test('Tunnel.breakLink：所有 relay 断开后状态 broken', () => {
  const relays = makeRelayDids()
  const t = new Tunnel({
    tunnelId: 't1', sourceDid: 'a', targetDid: 'b', relayDids: relays,
  })
  t.breakLink(relays[0])
  t.breakLink(relays[1])
  t.breakLink(relays[2])
  assert.equal(t.getStatus(), LINK_STATUS.BROKEN)
  assert.equal(t.activeRelays.length, 0)
  assert.ok(t.isBroken())
})

test('Tunnel.sendChunk：broken 时抛 TunnelBrokenError', () => {
  const relays = makeRelayDids()
  const t = new Tunnel({
    tunnelId: 't1', sourceDid: 'a', targetDid: 'b', relayDids: relays,
  })
  t.breakLink(relays[0])
  t.breakLink(relays[1])
  t.breakLink(relays[2])
  assert.throws(
    () => t.sendChunk(new Uint8Array([1])),
    (err) => {
      assert.equal(err.name, 'TunnelBrokenError')
      assert.equal(err.code, 'TUNNEL_BROKEN')
      assert.equal(err.tunnelId, 't1')
      return true
    },
  )
})

test('Tunnel.breakLink：断开未知 relay 不影响状态', () => {
  const t = new Tunnel({
    tunnelId: 't1', sourceDid: 'a', targetDid: 'b', relayDids: makeRelayDids(),
  })
  const r = t.breakLink('did:havix:A:unknown')
  assert.equal(r.status, LINK_STATUS.ACTIVE)
  assert.equal(r.remainingRelays, 3)
})

test('Tunnel.sendChunk：degraded 时剩余 relay 继续服务', () => {
  const relays = makeRelayDids()
  const t = new Tunnel({
    tunnelId: 't1', sourceDid: 'a', targetDid: 'b', relayDids: relays,
  })
  // 断开 relay[0]
  t.breakLink(relays[0])
  // 发 6 个 chunk，应分配到 relay[1] 和 relay[2]
  for (let i = 0; i < 6; i++) {
    t.sendChunk(new Uint8Array([i]))
  }
  const stats = t.getStats()
  const relay1Stats = stats.find((s) => s.relayDid === relays[1])
  const relay2Stats = stats.find((s) => s.relayDid === relays[2])
  assert.equal(relay1Stats.sentChunks, 3)
  assert.equal(relay2Stats.sentChunks, 3)
  // relay[0] 应标记为 broken
  const relay0Stats = stats.find((s) => s.relayDid === relays[0])
  assert.equal(relay0Stats.status, LINK_STATUS.BROKEN)
  assert.ok(relay0Stats.brokenAt > 0)
})

test('Tunnel.nextRelay：无 active relay 时抛 NoRelayAvailableError', () => {
  const relays = makeRelayDids()
  const t = new Tunnel({
    tunnelId: 't1', sourceDid: 'a', targetDid: 'b', relayDids: relays,
  })
  for (const r of relays) t.breakLink(r)
  assert.throws(
    () => t.nextRelay(),
    (err) => {
      assert.equal(err.name, 'NoRelayAvailableError')
      assert.equal(err.code, 'NO_RELAY_AVAILABLE')
      return true
    },
  )
})

// ──────────────────────────────────────────────
// TunnelManager
// ──────────────────────────────────────────────

test('TunnelManager：构造默认值', () => {
  const mgr = new TunnelManager()
  assert.equal(mgr.parallelRelays, DEFAULT_PARALLEL_RELAYS)
  assert.equal(mgr.tunnels.size, 0)
})

test('TunnelManager.establishTunnel：建立隧道', () => {
  const mgr = new TunnelManager()
  const relays = makeRelayDids()
  const t = mgr.establishTunnel({
    sourceDid: 'did:havix:C:alice',
    targetDid: 'did:havix:C:bob',
    relayDids: relays,
  })
  assert.ok(t.tunnelId)
  assert.equal(mgr.tunnels.size, 1)
  assert.equal(mgr.listTunnels().length, 1)
  assert.equal(mgr.getTunnel(t.tunnelId), t)
})

test('TunnelManager.establishTunnel：自定义 tunnelId', () => {
  const mgr = new TunnelManager()
  const t = mgr.establishTunnel({
    tunnelId: 'my-tunnel',
    sourceDid: 'a', targetDid: 'b', relayDids: makeRelayDids(),
  })
  assert.equal(t.tunnelId, 'my-tunnel')
})

test('TunnelManager.establishTunnel：重复 tunnelId 抛错', () => {
  const mgr = new TunnelManager()
  mgr.establishTunnel({
    tunnelId: 'dup', sourceDid: 'a', targetDid: 'b', relayDids: makeRelayDids(),
  })
  assert.throws(() => mgr.establishTunnel({
    tunnelId: 'dup', sourceDid: 'a', targetDid: 'b', relayDids: makeRelayDids(),
  }), /已存在/)
})

test('TunnelManager.establishTunnel：空 relayDids 抛错', () => {
  const mgr = new TunnelManager()
  assert.throws(() => mgr.establishTunnel({
    sourceDid: 'a', targetDid: 'b', relayDids: [],
  }), /relayDids/)
})

test('TunnelManager.sendChunk：通过 ID 发送', () => {
  const mgr = new TunnelManager()
  const t = mgr.establishTunnel({
    sourceDid: 'a', targetDid: 'b', relayDids: makeRelayDids(),
  })
  const r = mgr.sendChunk(t.tunnelId, new Uint8Array([1]))
  assert.equal(r.sequence, 1)
  assert.ok(r.relay)
})

test('TunnelManager.sendChunk：未知 tunnelId 抛错', () => {
  const mgr = new TunnelManager()
  assert.throws(() => mgr.sendChunk('unknown', new Uint8Array([1])), /不存在/)
})

test('TunnelManager.breakLink：通过 ID 断开链路', () => {
  const mgr = new TunnelManager()
  const relays = makeRelayDids()
  const t = mgr.establishTunnel({
    sourceDid: 'a', targetDid: 'b', relayDids: relays,
  })
  const r = mgr.breakLink(t.tunnelId, relays[0])
  assert.equal(r.status, LINK_STATUS.DEGRADED)
  assert.equal(r.remainingRelays, 2)
})

test('TunnelManager.closeTunnel：关闭隧道', () => {
  const mgr = new TunnelManager()
  const t = mgr.establishTunnel({
    sourceDid: 'a', targetDid: 'b', relayDids: makeRelayDids(),
  })
  assert.equal(mgr.tunnels.size, 1)
  mgr.closeTunnel(t.tunnelId)
  assert.equal(mgr.tunnels.size, 0)
  assert.equal(mgr.listTunnels().length, 0)
})

test('TunnelManager.closeTunnel：关闭未知 tunnelId 静默忽略', () => {
  const mgr = new TunnelManager()
  // 不应抛错
  mgr.closeTunnel('unknown')
  assert.equal(mgr.tunnels.size, 0)
})

test('TunnelManager.getStats：返回所有隧道统计', () => {
  const mgr = new TunnelManager()
  mgr.establishTunnel({
    tunnelId: 't1', sourceDid: 'a1', targetDid: 'b1', relayDids: makeRelayDids('r1'),
  })
  mgr.establishTunnel({
    tunnelId: 't2', sourceDid: 'a2', targetDid: 'b2', relayDids: makeRelayDids('r2'),
  })
  const stats = mgr.getStats()
  assert.equal(stats.length, 2)
  assert.equal(stats[0].tunnelId, 't1')
  assert.equal(stats[0].status, LINK_STATUS.ACTIVE)
  assert.equal(stats[0].links.length, 3)
  assert.equal(stats[1].tunnelId, 't2')
})

// ──────────────────────────────────────────────
// 端到端：建立 → 多 chunk 发送 → 部分断开 → 全断开
// ──────────────────────────────────────────────

test('端到端：建立隧道 → 发 9 chunk → 断 1 relay → 继续 → 全断开', () => {
  const mgr = new TunnelManager()
  const relays = makeRelayDids()
  const t = mgr.establishTunnel({
    sourceDid: 'did:havix:C:alice',
    targetDid: 'did:havix:C:bob',
    relayDids: relays,
  })

  // 发 9 个 chunk，每 relay 各 3 个
  for (let i = 0; i < 9; i++) {
    mgr.sendChunk(t.tunnelId, new Uint8Array([i]))
  }
  assert.equal(t.getStatus(), LINK_STATUS.ACTIVE)

  // 断开 relay[0]，状态 degraded
  mgr.breakLink(t.tunnelId, relays[0])
  assert.equal(t.getStatus(), LINK_STATUS.DEGRADED)

  // 继续发 4 个 chunk，应分配到 relay[1] 和 relay[2]
  for (let i = 0; i < 4; i++) {
    mgr.sendChunk(t.tunnelId, new Uint8Array([i + 100]))
  }

  // 断开剩余 relay
  mgr.breakLink(t.tunnelId, relays[1])
  assert.equal(t.getStatus(), LINK_STATUS.DEGRADED)
  mgr.breakLink(t.tunnelId, relays[2])
  assert.equal(t.getStatus(), LINK_STATUS.BROKEN)
  assert.ok(t.isBroken())

  // 再发应抛错
  assert.throws(
    () => mgr.sendChunk(t.tunnelId, new Uint8Array([255])),
    (err) => err.name === 'TunnelBrokenError',
  )
})

test('端到端：relay 断开后 round-robin 游标正确重置', () => {
  const relays = makeRelayDids()
  const t = new Tunnel({
    tunnelId: 't1', sourceDid: 'a', targetDid: 'b', relayDids: relays,
  })
  // 发 2 个 chunk，游标到 2
  t.sendChunk(new Uint8Array([1]))  // relay[0]
  t.sendChunk(new Uint8Array([2]))  // relay[1]
  assert.equal(t.rrIndex, 2)

  // 断开 relay[2]（未发送过的），游标应重置避免越界
  // 但 activeRelays 长度=2，rrIndex=2 应被重置为 0
  t.breakLink(relays[2])
  assert.equal(t.rrIndex, 0, 'rrIndex 越界后应重置')

  // 下一个应发到 relay[0]
  const r = t.sendChunk(new Uint8Array([3]))
  assert.equal(r.relay, relays[0])
})
