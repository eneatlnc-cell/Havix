// SPDX-License-Identifier: Apache-2.0

/**
 * M8.2-4 Web 面板单元测试
 * ───────────────────────────────────────────────
 * 测试范围：
 *   - 启停 server（port=0 由系统分配随机端口）
 *   - GET-only（POST/PUT/DELETE 返回 405）
 *   - 路由 404
 *   - /healthz 健康检查
 *   - / 页面包含 vis-network CDN 引用与必要 DOM
 *   - /api/status 返回节点概览
 *   - /api/identity 返回 4-context DID
 *   - /api/neighbors 返回 peer 列表
 *   - /api/topics 返回 topic 列表
 *   - /api/topology 返回 nodes+edges（含 self/peer/did/vouch/tunnel/market）
 *   - /api/registry/{vouch,wiki,credit,dispute,market,treasury,tunnel,relay}
 *
 * 不依赖 libp2p / helia：所有测试通过 mock SNode 注入。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WebPanel, DEFAULT_HOST, DEFAULT_PORT } from '../src/app/web-panel.js'

// ──────────────────────────────────────────────
// mock SNode 辅助
// ──────────────────────────────────────────────

function makeMockNode(overrides = {}) {
  return {
    log: () => {},
    libp2p: {
      peerId: { toString: () => '12D3KooWmockpeer' },
      getMultiaddrs: () => ['/ip4/127.0.0.1/tcp/9001/p2p/12D3KooWmockpeer'],
      getPeers: () => [{ toString: () => '12D3KooWpeer2' }, { toString: () => '12D3KooWpeer3' }],
      getConnections: (p) => [
        { remoteAddr: { toString: () => `/ip4/127.0.0.1/tcp/9002/p2p/${p.toString()}` } },
      ],
      services: {
        pubsub: { getTopics: () => ['/s-network/announce', '/s-network/reputation'] },
      },
    },
    wallet: {
      get: (k) => {
        const ids = {
          A: { did: 'did:havix:A:mock', contextKey: 'A' },
          B: { did: 'did:havix:B:mock', contextKey: 'B' },
          C: { did: 'did:havix:C:mock', contextKey: 'C' },
          D: { did: 'did:havix:D:mock', contextKey: 'D' },
        }
        return ids[k]
      },
    },
    vouchRegistry: {
      vouches: new Map([
        ['did:havix:A:endorsee1', new Set(['did:havix:A:voucher1', 'did:havix:A:voucher2'])],
      ]),
    },
    wiki: {
      entries: new Map([['cid1', { title: 't1' }], ['cid2', { title: 't2' }]]),
      listEntries: () => [
        { cid: 'cid1', title: 't1', authorDid: 'did:havix:D:author1', timestamp: 1, parentCid: null },
        { cid: 'cid2', title: 't2', authorDid: 'did:havix:D:author2', timestamp: 2, parentCid: 'cid1' },
      ],
    },
    reputationLedger: {
      balances: new Map([['did:havix:A:user1', { available: 70, frozen: 30, total: 100 }]]),
    },
    creditLedger: {
      balances: new Map([['did:havix:A:user1', 50]]),
    },
    arbitrationRegistry: {
      disputes: new Map([['disp-1', {
        disputeId: 'disp-1', claimant: 'did:c', respondent: 'did:r',
        type: 'offer-breach', amount: 100, status: 'voting',
        evidence: 'bafy1', panel: ['j1', 'j2', 'j3'], votes: new Map([['j1', 'guilty']]),
      }]]),
      jurorPool: new Map([['j1', { did: 'j1', reputation: 100, vouchCount: 15 }]]),
      listDisputes: () => ['disp-1'],
      getDispute: (id) => id === 'disp-1' ? {
        disputeId: 'disp-1', claimant: 'did:c', respondent: 'did:r',
        type: 'offer-breach', amount: 100, status: 'voting',
        evidence: 'bafy1', panel: ['j1', 'j2', 'j3'], votes: new Map([['j1', 'guilty']]),
      } : undefined,
      getVoteStats: (id) => ({
        guilty: 1, 'not-guilty': 0, abstain: 0, total: 1, status: 'voting', verdict: null,
      }),
    },
    marketRegistry: {
      markets: new Map([
        ['mkt-1', {
          manifest: {
            name: 'translation-market', version: '1.0.0', capability: 'market',
            permissions: ['read', 'write'],
            minReputation: 50, trustWeight: 0.8, spaCid: 'bafyspa1',
          },
          topic: '/s-network/market/abc',
          isCreator: true,
          members: new Set(['did:havix:A:me', 'did:havix:B:bob']),
        }],
      ]),
      listMarkets: () => ['mkt-1'],
    },
    treasury: {
      getBalance: () => 250,
      getHistory: () => [
        {
          at: 1700000000000,
          from: 'did:havix:A:respondent-aaaaaaaaaaaa',
          amount: 50,
          reason: 'slash from dispute disp-1',
          disputeId: 'disp-1',
        },
      ],
    },
    tunnelManager: {
      listTunnels: () => ['tun-1'],
      getStats: () => [
        {
          tunnelId: 'tun-1', sourceDid: 'did:havix:C:src-aaaaaaaaaa',
          targetDid: 'did:havix:C:dst-bbbbbbbbbb', status: 'active',
          totalChunks: 5, links: [{}, {}, {}],
        },
      ],
    },
    relayRegistry: {
      getActiveRelays: () => ['did:havix:A:relay1'],
      candidates: new Map([
        ['did:havix:A:relay1', { did: 'did:havix:A:relay1', reputation: 90, vouchCount: 12 }],
        ['did:havix:A:relay2', { did: 'did:havix:A:relay2', reputation: 60, vouchCount: 8 }],
      ]),
    },
    _processedCreditNonces: new Set(['n1', 'n2', 'n3']),
    ...overrides,
  }
}

// ──────────────────────────────────────────────
// 测试工具：起一个绑随机端口的 WebPanel
// ──────────────────────────────────────────────

async function startPanel(node, opts = {}) {
  const panel = new WebPanel(node, { port: 0, host: '127.0.0.1', ...opts })
  await panel.start()
  return panel
}

async function fetchJson(panel, path, init) {
  const res = await fetch(`http://127.0.0.1:${panel.getActualPort()}${path}`, init)
  const body = await res.json()
  return { status: res.status, headers: res.headers, body }
}

async function fetchText(panel, path, init) {
  const res = await fetch(`http://127.0.0.1:${panel.getActualPort()}${path}`, init)
  const body = await res.text()
  return { status: res.status, headers: res.headers, body }
}

// ──────────────────────────────────────────────
// 启停 / 配置
// ──────────────────────────────────────────────

test('默认配置：host=127.0.0.1 port=7331', () => {
  const panel = new WebPanel(makeMockNode())
  assert.equal(panel.host, '127.0.0.1')
  assert.equal(panel.port, 7331)
  assert.equal(panel.getActualPort(), null)  // 启动前为 null
})

test('导出常量 DEFAULT_HOST / DEFAULT_PORT', () => {
  assert.equal(DEFAULT_HOST, '127.0.0.1')
  assert.equal(DEFAULT_PORT, 7331)
})

test('start() 后 getActualPort() 返回实际端口（port=0 时由系统分配）', async () => {
  const panel = await startPanel(makeMockNode())
  assert.ok(panel.getActualPort() > 0)
  assert.match(panel.getUrl(), /^http:\/\/127\.0\.0\.1:\d+\/$/)
  await panel.stop()
})

test('start() 重复调用抛错', async () => {
  const panel = await startPanel(makeMockNode())
  await assert.rejects(() => panel.start(), /已启动/)
  await panel.stop()
})

test('stop() 未启动时调用幂等', async () => {
  const panel = new WebPanel(makeMockNode(), { port: 0 })
  await panel.stop()  // 不抛错
})

test('stop() 已启动后可再次 start()', async () => {
  const panel = await startPanel(makeMockNode())
  await panel.stop()
  // 重新启动不应抛错
  await panel.start()
  await panel.stop()
})

// ──────────────────────────────────────────────
// 基本路由：404 / 405 / healthz
// ──────────────────────────────────────────────

test('未路由路径返回 404', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/no-such-path')
  assert.equal(r.status, 404)
  assert.match(r.body.error, /未找到路由/)
  await panel.stop()
})

test('POST 请求返回 405', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/api/status', { method: 'POST' })
  assert.equal(r.status, 405)
  assert.match(r.body.error, /仅支持 GET/)
  await panel.stop()
})

test('PUT 请求返回 405', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/api/status', { method: 'PUT', body: '{}' })
  assert.equal(r.status, 405)
  await panel.stop()
})

test('DELETE 请求返回 405', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/api/status', { method: 'DELETE' })
  assert.equal(r.status, 405)
  await panel.stop()
})

test('GET /healthz 返回 200 + { ok: true }', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/healthz')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  await panel.stop()
})

// ──────────────────────────────────────────────
// HTML 页面
// ──────────────────────────────────────────────

test('GET / 返回 HTML + vis-network CDN 引用', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchText(panel, '/')
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /text\/html/)
  assert.match(r.body, /<!DOCTYPE html>/)
  assert.match(r.body, /vis-network/)
  assert.match(r.body, /cdn\.jsdelivr\.net/)
  assert.match(r.body, /Havix 节点拓扑/)
  await panel.stop()
})

test('GET / 包含 vis.Network + DataSet 调用', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchText(panel, '/')
  assert.match(r.body, /new vis\.Network/)
  assert.match(r.body, /new vis\.DataSet/)
  await panel.stop()
})

test('GET / 包含自动刷新逻辑', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchText(panel, '/')
  assert.match(r.body, /setInterval/)
  assert.match(r.body, /\/api\/topology/)
  assert.match(r.body, /\/api\/status/)
  await panel.stop()
})

test('GET /index.html 与 / 等价', async () => {
  const panel = await startPanel(makeMockNode())
  const r1 = await fetchText(panel, '/')
  const r2 = await fetchText(panel, '/index.html')
  assert.equal(r1.body, r2.body)
  await panel.stop()
})

// ──────────────────────────────────────────────
// /api/status
// ──────────────────────────────────────────────

test('GET /api/status 返回节点概览', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/api/status')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.peerId, '12D3KooWmockpeer')
  assert.deepEqual(r.body.multiaddrs, ['/ip4/127.0.0.1/tcp/9001/p2p/12D3KooWmockpeer'])
  assert.deepEqual(r.body.connectedPeers, ['12D3KooWpeer2', '12D3KooWpeer3'])
  assert.equal(r.body.topicCount, 2)
  // registry 计数
  assert.equal(r.body.registry.vouch, 1)
  assert.equal(r.body.registry.wiki, 2)
  assert.equal(r.body.registry.reputation, 1)
  assert.equal(r.body.registry.creditHolders, 1)
  assert.equal(r.body.registry.disputes, 1)
  assert.equal(r.body.registry.jurorCandidates, 1)
  assert.equal(r.body.registry.markets, 1)
  assert.equal(r.body.registry.tunnels, 1)
  assert.equal(r.body.registry.treasuryBalance, 250)
  assert.equal(r.body.registry.processedCreditNonces, 3)
  await panel.stop()
})

test('GET /api/status 节点未初始化时返回 ok:false', async () => {
  const panel = await startPanel(null)
  const r = await fetchJson(panel, '/api/status')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, false)
  assert.match(r.body.error, /节点未初始化/)
  await panel.stop()
})

test('GET /api/status 缺失字段时降级为 0 / 空数组', async () => {
  const node = makeMockNode()
  delete node.vouchRegistry
  delete node.wiki
  const panel = await startPanel(node)
  const r = await fetchJson(panel, '/api/status')
  assert.equal(r.body.registry.vouch, 0)
  assert.equal(r.body.registry.wiki, 0)
  await panel.stop()
})

// ──────────────────────────────────────────────
// /api/identity
// ──────────────────────────────────────────────

test('GET /api/identity 返回 4-context DID', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/api/identity')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.identities.A.did, 'did:havix:A:mock')
  assert.equal(r.body.identities.A.label, '公开层活跃身份')
  assert.equal(r.body.identities.B.did, 'did:havix:B:mock')
  assert.equal(r.body.identities.C.did, 'did:havix:C:mock')
  assert.equal(r.body.identities.D.did, 'did:havix:D:mock')
  await panel.stop()
})

test('GET /api/identity 钱包未初始化时返回错误', async () => {
  const panel = await startPanel({})
  const r = await fetchJson(panel, '/api/identity')
  assert.equal(r.body.ok, false)
  assert.match(r.body.error, /钱包未初始化/)
  await panel.stop()
})

// ──────────────────────────────────────────────
// /api/neighbors
// ──────────────────────────────────────────────

test('GET /api/neighbors 返回 peer 列表 + 远端地址', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/api/neighbors')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.count, 2)
  assert.deepEqual(r.body.peers[0].peerId, '12D3KooWpeer2')
  assert.ok(r.body.peers[0].remoteAddrs.length > 0)
  await panel.stop()
})

test('GET /api/neighbors 无 peer 时返回空数组', async () => {
  const node = makeMockNode()
  node.libp2p.getPeers = () => []
  const panel = await startPanel(node)
  const r = await fetchJson(panel, '/api/neighbors')
  assert.equal(r.body.count, 0)
  assert.deepEqual(r.body.peers, [])
  await panel.stop()
})

// ──────────────────────────────────────────────
// /api/topics
// ──────────────────────────────────────────────

test('GET /api/topics 返回订阅 topic 列表', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/api/topics')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.count, 2)
  assert.deepEqual(r.body.topics, ['/s-network/announce', '/s-network/reputation'])
  await panel.stop()
})

// ──────────────────────────────────────────────
// /api/topology
// ──────────────────────────────────────────────

test('GET /api/topology 返回 nodes + edges（self/peer/did/relay/vouch/tunnel/market）', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/api/topology')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.ok(Array.isArray(r.body.nodes))
  assert.ok(Array.isArray(r.body.edges))
  assert.ok(r.body.nodes.length > 0)
  assert.ok(r.body.edges.length > 0)

  // self 节点
  const self = r.body.nodes.find((n) => n.group === 'self')
  assert.ok(self, '应包含 self 节点')
  assert.equal(self.id, '12D3KooWmockpeer')

  // 4-context DID 节点
  const didA = r.body.nodes.find((n) => n.id === 'did-A')
  const didB = r.body.nodes.find((n) => n.id === 'did-B')
  const didC = r.body.nodes.find((n) => n.id === 'did-C')
  const didD = r.body.nodes.find((n) => n.id === 'did-D')
  assert.ok(didA && didB && didC && didD, '应包含 4 个 context-DID 节点')
  assert.equal(didA.title, 'context-A（公开层）\nDID: did:havix:A:mock')

  // peer 节点
  const peers = r.body.nodes.filter((n) => n.group === 'peer')
  assert.equal(peers.length, 2)
  assert.ok(peers.find((p) => p.id === '12D3KooWpeer2'))

  // relay-active + relay-candidate
  const activeRelay = r.body.nodes.find((n) => n.group === 'relay-active')
  assert.ok(activeRelay, '应包含 active relay 节点')
  const candRelay = r.body.nodes.find((n) => n.group === 'relay-candidate')
  assert.ok(candRelay, '应包含候选 relay 节点')

  // vouch 关系
  const vouched = r.body.nodes.find((n) => n.group === 'vouched')
  assert.ok(vouched, '应包含被背书节点')
  const vouchEdge = r.body.edges.find((e) => e.label === 'vouch')
  assert.ok(vouchEdge, '应包含 vouch 边')

  // tunnel
  const tunnelEdge = r.body.edges.find((e) => e.label.startsWith('tunnel'))
  assert.ok(tunnelEdge, '应包含 tunnel 边')

  // market
  const market = r.body.nodes.find((n) => n.group === 'market')
  assert.ok(market, '应包含 market 节点')
  const marketEdge = r.body.edges.find((e) => e.label === 'creator')
  assert.ok(marketEdge, '应包含 creator 边')

  await panel.stop()
})

test('GET /api/topology 节点未初始化时返回 ok:false', async () => {
  const panel = await startPanel(null)
  const r = await fetchJson(panel, '/api/topology')
  assert.equal(r.body.ok, false)
  await panel.stop()
})

test('GET /api/topology 自我 → 4-context DID 边', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/api/topology')
  const ctxEdges = r.body.edges.filter((e) => e.label === 'context')
  assert.equal(ctxEdges.length, 4)
  for (const e of ctxEdges) {
    assert.equal(e.from, '12D3KooWmockpeer')
    assert.match(e.to, /^did-[A-D]$/)
  }
  await panel.stop()
})

test('GET /api/topology self → peer 边', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/api/topology')
  const p2pEdges = r.body.edges.filter((e) => e.label === 'p2p')
  assert.equal(p2pEdges.length, 2)
  await panel.stop()
})

// ──────────────────────────────────────────────
// /api/registry/vouch
// ──────────────────────────────────────────────

test('GET /api/registry/vouch 返回 vouch 详情', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/api/registry/vouch')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.count, 1)
  assert.equal(r.body.entries[0].endorseDid, 'did:havix:A:endorsee1')
  assert.deepEqual(r.body.entries[0].vouchers, ['did:havix:A:voucher1', 'did:havix:A:voucher2'])
  assert.equal(r.body.entries[0].count, 2)
  await panel.stop()
})

test('GET /api/registry/vouch 未初始化时返回错误', async () => {
  const node = makeMockNode()
  delete node.vouchRegistry
  const panel = await startPanel(node)
  const r = await fetchJson(panel, '/api/registry/vouch')
  assert.equal(r.body.ok, false)
  assert.match(r.body.error, /vouchRegistry 未初始化/)
  await panel.stop()
})

// ──────────────────────────────────────────────
// /api/registry/wiki
// ──────────────────────────────────────────────

test('GET /api/registry/wiki 返回条目列表', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/api/registry/wiki')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.count, 2)
  assert.equal(r.body.entries[0].cid, 'cid1')
  assert.equal(r.body.entries[0].title, 't1')
  await panel.stop()
})

// ──────────────────────────────────────────────
// /api/registry/credit
// ──────────────────────────────────────────────

test('GET /api/registry/credit 返回 reputation + credit', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/api/registry/credit')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.reputations.length, 1)
  assert.equal(r.body.reputations[0].did, 'did:havix:A:user1')
  assert.equal(r.body.reputations[0].available, 70)
  assert.equal(r.body.reputations[0].frozen, 30)
  assert.equal(r.body.reputations[0].total, 100)
  assert.equal(r.body.credits.length, 1)
  assert.equal(r.body.credits[0].did, 'did:havix:A:user1')
  assert.equal(r.body.credits[0].balance, 50)
  await panel.stop()
})

// ──────────────────────────────────────────────
// /api/registry/dispute
// ──────────────────────────────────────────────

test('GET /api/registry/dispute 返回 dispute 列表 + 投票统计', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/api/registry/dispute')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.count, 1)
  assert.equal(r.body.jurorCandidates, 1)
  const d = r.body.disputes[0]
  assert.equal(d.disputeId, 'disp-1')
  assert.equal(d.claimant, 'did:c')
  assert.equal(d.respondent, 'did:r')
  assert.equal(d.type, 'offer-breach')
  assert.equal(d.amount, 100)
  assert.equal(d.status, 'voting')
  assert.equal(d.panelSize, 3)
  assert.equal(d.voteStats.guilty, 1)
  assert.equal(d.voteStats.total, 1)
  await panel.stop()
})

test('GET /api/registry/dispute getVoteStats 抛错时降级为 null', async () => {
  const node = makeMockNode()
  node.arbitrationRegistry.getVoteStats = () => { throw new Error('boom') }
  const panel = await startPanel(node)
  const r = await fetchJson(panel, '/api/registry/dispute')
  assert.equal(r.body.disputes[0].voteStats, null)
  await panel.stop()
})

// ──────────────────────────────────────────────
// /api/registry/market
// ──────────────────────────────────────────────

test('GET /api/registry/market 返回市场详情', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/api/registry/market')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.count, 1)
  const m = r.body.markets[0]
  assert.equal(m.marketId, 'mkt-1')
  assert.equal(m.name, 'translation-market')
  assert.equal(m.version, '1.0.0')
  assert.equal(m.capability, 'market')
  assert.deepEqual(m.permissions, ['read', 'write'])
  assert.equal(m.minReputation, 50)
  assert.equal(m.trustWeight, 0.8)
  assert.equal(m.spaCid, 'bafyspa1')
  assert.equal(m.topic, '/s-network/market/abc')
  assert.equal(m.isCreator, true)
  assert.equal(m.memberCount, 2)
  await panel.stop()
})

// ──────────────────────────────────────────────
// /api/registry/treasury
// ──────────────────────────────────────────────

test('GET /api/registry/treasury 返回余额 + 历史', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/api/registry/treasury')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.balance, 250)
  assert.equal(r.body.history.length, 1)
  assert.equal(r.body.history[0].amount, 50)
  assert.equal(r.body.history[0].disputeId, 'disp-1')
  await panel.stop()
})

// ──────────────────────────────────────────────
// /api/registry/tunnel
// ──────────────────────────────────────────────

test('GET /api/registry/tunnel 返回隧道统计', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/api/registry/tunnel')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.count, 1)
  assert.equal(r.body.tunnels[0].tunnelId, 'tun-1')
  assert.equal(r.body.tunnels[0].status, 'active')
  assert.equal(r.body.tunnels[0].totalChunks, 5)
  await panel.stop()
})

// ──────────────────────────────────────────────
// /api/registry/relay
// ──────────────────────────────────────────────

test('GET /api/registry/relay 返回 active + 候选', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/api/registry/relay')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.activeCount, 1)
  assert.deepEqual(r.body.active, ['did:havix:A:relay1'])
  assert.equal(r.body.candidates.length, 2)
  const cand1 = r.body.candidates.find((c) => c.did === 'did:havix:A:relay1')
  assert.equal(cand1.reputation, 90)
  assert.equal(cand1.vouchCount, 12)
  await panel.stop()
})

// ──────────────────────────────────────────────
// 并发请求 / 性能
// ──────────────────────────────────────────────

test('并发 100 个请求都成功响应', async () => {
  const panel = await startPanel(makeMockNode())
  const paths = ['/api/status', '/api/topology', '/healthz', '/api/registry/credit', '/']
  const requests = []
  for (let i = 0; i < 100; i++) {
    const path = paths[i % paths.length]
    requests.push(fetch(`http://127.0.0.1:${panel.getActualPort()}${path}`))
  }
  const responses = await Promise.all(requests)
  for (const r of responses) {
    assert.equal(r.status, 200)
    await r.text()  // 排空响应体
  }
  await panel.stop()
})

// ──────────────────────────────────────────────
// 安全性
// ──────────────────────────────────────────────

test('HTML 不包含任何敏感字段（无 private/privateKey/secret）', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchText(panel, '/')
  assert.doesNotMatch(r.body, /privateKey/i)
  assert.doesNotMatch(r.body, /secret/i)
  await panel.stop()
})

test('JSON API 不泄露私钥字段', async () => {
  const panel = await startPanel(makeMockNode())
  for (const path of ['/api/status', '/api/identity', '/api/topology']) {
    const r = await fetchJson(panel, path)
    const text = JSON.stringify(r.body)
    assert.doesNotMatch(text, /privateKey/i)
    assert.doesNotMatch(text, /secret/i)
  }
  await panel.stop()
})

test('响应头包含 Cache-Control: no-store', async () => {
  const panel = await startPanel(makeMockNode())
  const r = await fetchJson(panel, '/api/status')
  assert.equal(r.headers.get('cache-control'), 'no-store')
  const r2 = await fetchText(panel, '/')
  assert.equal(r2.headers.get('cache-control'), 'no-store')
  await panel.stop()
})

test('响应 Content-Type 正确（JSON / HTML）', async () => {
  const panel = await startPanel(makeMockNode())
  const rJson = await fetchJson(panel, '/api/status')
  assert.match(rJson.headers.get('content-type'), /application\/json/)
  const rHtml = await fetchText(panel, '/')
  assert.match(rHtml.headers.get('content-type'), /text\/html/)
  await panel.stop()
})

// ──────────────────────────────────────────────
// M8 审计修复 P1-F：Host 头校验防 DNS rebinding
// ──────────────────────────────────────────────

test('Host 头校验：恶意 Host 头被 403 拒绝（防 DNS rebinding）', async () => {
  const panel = await startPanel(makeMockNode())
  const port = panel.getActualPort()

  // 正常 Host（127.0.0.1:port）应通过
  const r1 = await fetchJson(panel, '/healthz')
  assert.equal(r1.status, 200)

  // 恶意 Host 头应被拒绝
  // 注意：fetch 会用 URL 自动覆盖 Host 头，必须用 http.request 才能注入自定义 Host
  const http = await import('node:http')
  await new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/healthz', method: 'GET', headers: { Host: 'evil.example.com' } },
      (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          assert.equal(res.statusCode, 403, `恶意 Host 应返回 403，实际 ${res.statusCode}`)
          assert.match(JSON.parse(body).error, /Host 头不被信任/)
          resolve()
        })
      },
    )
    req.on('error', (err) => { throw err })
    req.end()
  })

  await panel.stop()
})

test('Host 头校验：localhost 与 127.0.0.1 都允许', async () => {
  const panel = await startPanel(makeMockNode())
  const port = panel.getActualPort()

  // localhost:port 应通过
  const r1 = await fetch(`http://localhost:${port}/healthz`)
  // 注意：fetch 会自动设 Host 头为 localhost:port
  assert.equal(r1.status, 200)

  await panel.stop()
})
