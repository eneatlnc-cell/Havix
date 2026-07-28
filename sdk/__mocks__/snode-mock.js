// SPDX-License-Identifier: Apache-2.0

/**
 * Havix SDK mock SNode（M9.2）
 * ───────────────────────────────────────────────
 * 单元测试用的 fake SNode 实例，覆盖 SDK 7 大接口需要的所有方法。
 * 不依赖 libp2p / helia / IPFS——纯内存记录调用与可配置返回值。
 *
 * 设计原则：
 *   1. 方法返回值默认可工作（如 createMarket 返回合法结构）
 *   2. 每个 async 方法记录调用到 this.calls[name]，便于断言
 *   3. 提供方法级 override：mock.createMarket.mockImplementation(fn)
 *   4. 提供 throwOnce / throwAlways 让测试模拟 SNode 抛错
 *
 * 用法：
 *   import { createSnodeMock } from '../__mocks__/snode-mock.js'
 *   const snode = createSnodeMock()
 *   const sdk = createApp(snode, manifest)
 *   await sdk.market.create({...})
 *   assert.equal(snode.calls.createMarket.length, 1)
 */

// ──────────────────────────────────────────────
// 默认 4-context DID（mock 用固定值便于断言）
// ──────────────────────────────────────────────

const DEFAULT_DIDS = Object.freeze({
  main: 'did:havix:main:z6MkmockMain000000000000000000000000000000000000000',
  A: 'did:havix:A:z6MkmockA000000000000000000000000000000000000000000000',
  B: 'did:havix:B:z6MkmockB000000000000000000000000000000000000000000000',
  C: 'did:havix:C:z6MkmockC000000000000000000000000000000000000000000000',
  D: 'did:havix:D:z6MkmockD000000000000000000000000000000000000000000000',
})

/**
 * 单个 context 子身份 mock（模拟 Identity 类）。
 * 提供 sign / verify / did / publicKey 字段。
 */
class MockIdentity {
  constructor(contextKey, did) {
    this.contextKey = contextKey
    this._did = did
    // publicKey 暴露 verify 方法（与 libp2p PublicKey 接口一致，供 api.verify(publicKey, sig, data) 调用）
    const self = this
    this.publicKey = {
      raw: new Uint8Array([contextKey.charCodeAt(0)]),
      verify: (data, signature) => self.verify(data, signature),
    }
  }

  get did() {
    return this._did
  }

  get peerId() {
    return { toString: () => this._did }
  }

  async sign(data) {
    // 返回 64 字节假签名（前 32 字节是 data 哈希的 mock，后 32 字节是 contextKey 重复）
    const sig = new Uint8Array(64)
    sig[0] = this.contextKey.charCodeAt(0)
    return sig
  }

  async verify(data, signature) {
    // 简化验签：签名首字节匹配 contextKey 即视为有效
    return signature instanceof Uint8Array
      && signature.length === 64
      && signature[0] === this.contextKey.charCodeAt(0)
  }
}

/**
 * 身份钱包 mock（模拟 IdentityWallet 类）。
 * 持有 4 个 MockIdentity + 主 DID。
 */
class MockWallet {
  constructor(dids = DEFAULT_DIDS) {
    this.masterPeerId = { toString: () => dids.main }
    this.identities = [
      new MockIdentity('A', dids.A),
      new MockIdentity('B', dids.B),
      new MockIdentity('C', dids.C),
      new MockIdentity('D', dids.D),
    ]
    this._dids = dids
  }

  get(contextKey) {
    const id = this.identities.find(i => i.contextKey === contextKey)
    if (!id) throw new Error(`未找到 context ${contextKey} 的子身份`)
    return id
  }

  list() {
    return this.identities.map(id => ({
      context: id.contextKey,
      did: id.did,
    }))
  }
}

// ──────────────────────────────────────────────
// 可 mock 的方法工厂
// ──────────────────────────────────────────────

/**
 * 包装一个方法使其记录调用 + 支持 override。
 *
 * @param {function} defaultImpl 默认实现
 * @param {Array} calls 记录数组（外部传入引用）
 * @returns {function & { mockImplementation(fn), mockReturnValue(val), mockClear() }}
 */
function mockMethod(defaultImpl, calls) {
  let impl = defaultImpl

  const fn = function (...args) {
    calls.push(args)
    return impl.apply(this, args)
  }

  fn.mockImplementation = function (newImpl) {
    impl = newImpl
    return fn
  }

  fn.mockReturnValue = function (val) {
    impl = () => val
    return fn
  }

  fn.mockClear = function () {
    calls.length = 0
    return fn
  }

  return fn
}

// ──────────────────────────────────────────────
// mock SNode 主体
// ──────────────────────────────────────────────

/**
 * 创建 mock SNode 实例。
 *
 * @param {object} [opts]
 * @param {object} [opts.dids] 自定义 4-context DID（默认用 DEFAULT_DIDS）
 * @param {object} [opts.ledgers] 自定义 ledger 状态（reputation/credit 等）
 * @returns {object} mock SNode（结构同真实 SNode 的公开 API）
 */
export function createSnodeMock(opts = {}) {
  const dids = { ...DEFAULT_DIDS, ...(opts.dids ?? {}) }
  const wallet = new MockWallet(dids)
  // 节点配置（用于 state API 计算 persistPath 等；模拟真实 SNode 的 snode.config.dataDir）
  const config = opts.config ?? { dataDir: '.data' }

  // 调用记录
  const calls = {}

  // ledger 状态（mock 内存版）
  const creditBalances = new Map(opts.ledgers?.credit ?? [])
  const reputation = new Map(opts.ledgers?.reputation ?? [])
  const treasuryBalance = opts.ledgers?.treasuryBalance ?? 0
  const treasuryHistory = opts.ledgers?.treasuryHistory ?? []

  // 已建立隧道记录
  const tunnels = new Map()

  // 已创建市场记录
  const markets = new Map()

  // wiki 条目索引
  const wikiEntries = new Map()
  const wikiHistory = new Map()  // title → [{cid, authorDid, parentCid, timestamp}]

  // pubsub 订阅记录
  const pubsubSubscriptions = new Map()  // topic → Set<handler>

  // IPFS blockstore
  const blockstore = new Map()  // cidString → Uint8Array

  // 单调递增计数器（用于生成唯一 CID/marketId/tunnelId，避免同毫秒调用冲突）
  let seq = 0
  function nextSeq() { return (seq++).toString(36) }

  // ── helper：注册可被 mock 的方法 ──
  function makeMethod(name, defaultImpl) {
    calls[name] = []
    return mockMethod(defaultImpl, calls[name])
  }

  // ── 公开 API（M3-M7） ──

  const snode = {
    // 身份与日志
    wallet,
    config,
    log: makeMethod('log', (lvl, tag, msg) => { /* 静默 */ }),

    // libp2p / IPFS（mock）
    libp2p: {
      services: {
        pubsub: {
          async publish(topic, data) {
            calls.pubsubPublish = calls.pubsubPublish || []
            calls.pubsubPublish.push({ topic, data })
            const handlers = pubsubSubscriptions.get(topic)
            if (handlers) {
              for (const h of handlers) {
                try { await h({ topic, data, from: 'mock-peer' }) } catch { /* 忽略 */ }
              }
            }
            return { recipients: handlers?.size ?? 0 }
          },
          async subscribe(topic, handler) {
            calls.pubsubSubscribe = calls.pubsubSubscribe || []
            calls.pubsubSubscribe.push({ topic })
            if (!pubsubSubscriptions.has(topic)) pubsubSubscriptions.set(topic, new Set())
            if (handler) pubsubSubscriptions.get(topic).add(handler)
          },
          async unsubscribe(topic) {
            calls.pubsubUnsubscribe = calls.pubsubUnsubscribe || []
            calls.pubsubUnsubscribe.push({ topic })
            pubsubSubscriptions.delete(topic)
          },
        },
      },
    },
    ipfs: {
      blockstore: {
        async put(cid, bytes) {
          calls.ipfsPut = calls.ipfsPut || []
          calls.ipfsPut.push({ cid: cid.toString(), bytes })
          blockstore.set(cid.toString(), bytes)
        },
        // IPFS blockstore.get 是 AsyncGenerator——必须用 async function*
        async *get(cid) {
          calls.ipfsGet = calls.ipfsGet || []
          calls.ipfsGet.push({ cid: cid.toString() })
          const bytes = blockstore.get(cid.toString())
          if (!bytes) throw new Error(`blockstore 未找到 cid: ${cid.toString()}`)
          yield bytes
        },
      },
    },

    // M3 维基（snode.wiki 协议对象，与真实 SNode 一致）
    wiki: {
      async publishEntry({ title, content, parentCid = null }) {
        calls.wikiPublishEntry = calls.wikiPublishEntry || []
        calls.wikiPublishEntry.push({ title, content, parentCid })
        const cid = 'bafy' + title.padEnd(8, '0').slice(0, 8) + Date.now().toString(36) + '-' + nextSeq()
        wikiEntries.set(cid, { cid, title, content, authorDid: dids.D, parentCid, timestamp: Date.now() })
        if (!wikiHistory.has(title)) wikiHistory.set(title, [])
        wikiHistory.get(title).push({ cid, authorDid: dids.D, parentCid, timestamp: Date.now() })
        return { cid, message: { type: 'wiki-announce', payload: { cid, title } } }
      },
      listEntries() {
        calls.wikiListEntries = calls.wikiListEntries || []
        calls.wikiListEntries.push({})
        return Array.from(wikiEntries.values())
      },
      getEntry(cidStr) {
        calls.wikiGetEntry = calls.wikiGetEntry || []
        calls.wikiGetEntry.push({ cidStr })
        return wikiEntries.get(cidStr) ?? null
      },
      listHistory(title) {
        calls.wikiListHistory = calls.wikiListHistory || []
        calls.wikiListHistory.push({ title })
        return wikiHistory.get(title) ?? []
      },
      getLineage(cidStr) {
        calls.wikiGetLineage = calls.wikiGetLineage || []
        calls.wikiGetLineage.push({ cidStr })
        const lineage = []
        let cur = wikiEntries.get(cidStr)
        while (cur) {
          lineage.unshift(cur)
          cur = cur.parentCid ? wikiEntries.get(cur.parentCid) : null
        }
        return lineage
      },
      getLatestVersion(title, authorDid) {
        calls.wikiGetLatestVersion = calls.wikiGetLatestVersion || []
        calls.wikiGetLatestVersion.push({ title, authorDid })
        const hist = wikiHistory.get(title) ?? []
        const filtered = authorDid ? hist.filter(h => h.authorDid === authorDid) : hist
        return filtered.length > 0 ? filtered[filtered.length - 1] : null
      },
      isRootEntry(cidStr) {
        calls.wikiIsRootEntry = calls.wikiIsRootEntry || []
        calls.wikiIsRootEntry.push({ cidStr })
        const e = wikiEntries.get(cidStr)
        return e ? (e.parentCid === null || e.parentCid === undefined) : false
      },
    },

    // M3 vouch
    async vouch(endorseDid, reason) {
      calls.vouch = calls.vouch || []
      calls.vouch.push({ endorseDid, reason })
      return { recipients: 1 }
    },

    // M4 Credit
    async issueCredit(opts) {
      const { holderDid, amount, prevNoteCid = null } = opts ?? {}
      calls.issueCredit = calls.issueCredit || []
      // 记录调用参数数组（与 makeMethod 的 args[] 形式一致，便于 calls.X[0][0].field 断言）
      calls.issueCredit.push([opts])
      creditBalances.set(holderDid, (creditBalances.get(holderDid) ?? 0) + amount)
      const note = {
        type: 'issue',
        issuerDid: dids.A,
        holderDid,
        amount,
        nonce: 'nonce-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        timestamp: Date.now(),
        prevNoteCid,
        signature: new Uint8Array(64),
        signerPublicKey: new Uint8Array(32),
      }
      return { note, recipients: 1 }
    },
    consumeCredit({ holderDid, issuerDid, amount }) {
      calls.consumeCredit = calls.consumeCredit || []
      calls.consumeCredit.push({ holderDid, issuerDid, amount })
      creditBalances.set(holderDid, (creditBalances.get(holderDid) ?? 0) - amount)
      return { holderBalance: creditBalances.get(holderDid), releasedFrozen: amount }
    },
    transferCredit({ fromDid, toDid, amount }) {
      calls.transferCredit = calls.transferCredit || []
      calls.transferCredit.push({ fromDid, toDid, amount })
      creditBalances.set(fromDid, (creditBalances.get(fromDid) ?? 0) - amount)
      creditBalances.set(toDid, (creditBalances.get(toDid) ?? 0) + amount)
      return { fromBalance: creditBalances.get(fromDid), toBalance: creditBalances.get(toDid) }
    },
    creditLedger: {
      getBalance(holderDid) {
        calls.creditBalance = calls.creditBalance || []
        calls.creditBalance.push({ holderDid })
        return creditBalances.get(holderDid) ?? 0
      },
    },
    reputationLedger: {
      getAvailable(did) {
        calls.reputationAvailable = calls.reputationAvailable || []
        calls.reputationAvailable.push({ did })
        return reputation.get(did) ?? 0
      },
    },

    // M5 Tunnel + Relay
    registerRelayCandidate({ did, reputation, vouchCount }) {
      calls.registerRelayCandidate = calls.registerRelayCandidate || []
      calls.registerRelayCandidate.push({ did, reputation, vouchCount })
      return { registered: true }
    },
    electRelayEpoch() {
      calls.electRelayEpoch = calls.electRelayEpoch || []
      calls.electRelayEpoch.push({})
      return { elected: [dids.A], count: 1 }
    },
    rotateRelayEpoch(rng) {
      calls.rotateRelayEpoch = calls.rotateRelayEpoch || []
      calls.rotateRelayEpoch.push({ rng: !!rng })
      return { rotated: [], supplemented: [], active: [dids.A] }
    },
    establishTunnel({ targetDid, relayDids }) {
      calls.establishTunnel = calls.establishTunnel || []
      calls.establishTunnel.push({ targetDid, relayDids })
      const tunnelId = 'tunnel-' + Date.now().toString(36)
      const relays = relayDids ?? [dids.A]
      tunnels.set(tunnelId, { tunnelId, sourceDid: dids.C, targetDid, relayDids: relays, status: 'active', sentChunks: 0 })
      return { tunnelId, relayDids: relays }
    },
    sendTunnelChunk({ tunnelId, chunk }) {
      calls.sendTunnelChunk = calls.sendTunnelChunk || []
      calls.sendTunnelChunk.push({ tunnelId, chunk })
      const t = tunnels.get(tunnelId)
      if (!t) throw new Error(`隧道 ${tunnelId} 不存在`)
      if (t.status === 'broken') throw new Error('隧道已断开')
      t.sentChunks++
      return { relay: t.relayDids[t.sentChunks % t.relayDids.length], sequence: t.sentChunks, total: t.relayDids.length }
    },
    breakTunnelLink({ tunnelId, relayDid }) {
      calls.breakTunnelLink = calls.breakTunnelLink || []
      calls.breakTunnelLink.push({ tunnelId, relayDid })
      const t = tunnels.get(tunnelId)
      if (!t) throw new Error(`隧道 ${tunnelId} 不存在`)
      t.relayDids = t.relayDids.filter(r => r !== relayDid)
      t.status = t.relayDids.length === 0 ? 'broken' : 'degraded'
      return { status: t.status, remainingRelays: t.relayDids.length }
    },
    closeTunnel(tunnelId) {
      calls.closeTunnel = calls.closeTunnel || []
      calls.closeTunnel.push({ tunnelId })
      const t = tunnels.get(tunnelId)
      if (t) t.status = 'closed'
    },

    // M6 Arbitration
    registerJurorCandidate({ did }) {
      calls.registerJurorCandidate = calls.registerJurorCandidate || []
      calls.registerJurorCandidate.push({ did })
      return { registered: true, eligible: true }
    },
    checkJurorEligibility(did) {
      calls.checkJurorEligibility = calls.checkJurorEligibility || []
      calls.checkJurorEligibility.push({ did })
      return { eligible: true, reputation: 50, vouchCount: 5, threshold: 3 }
    },
    async fileDispute({ respondent, type, evidence, amount }) {
      calls.fileDispute = calls.fileDispute || []
      calls.fileDispute.push({ respondent, type, evidence, amount })
      const dispute = {
        disputeId: 'dispute-' + Date.now().toString(36),
        claimant: dids.A,
        respondent, type, evidence, amount,
        status: 'panel-summoning',
        panel: [], votes: [],
        createdAt: Date.now(),
      }
      return { dispute, message: { type: 'arbitration', payload: { action: 'filed', dispute } } }
    },
    summonArbitrationPanel(disputeId, rng) {
      calls.summonArbitrationPanel = calls.summonArbitrationPanel || []
      calls.summonArbitrationPanel.push({ disputeId, rng: !!rng })
      return { panel: [dids.A, 'did:havix:A:peer2', 'did:havix:A:peer3'], count: 3, excluded: [] }
    },
    castArbitrationVote({ disputeId, vote }) {
      calls.castArbitrationVote = calls.castArbitrationVote || []
      calls.castArbitrationVote.push({ disputeId, vote })
      return { recorded: true, vote }
    },
    resolveVerdict(disputeId) {
      calls.resolveVerdict = calls.resolveVerdict || []
      calls.resolveVerdict.push({ disputeId })
      return {
        resolved: true,
        verdict: 'guilty',
        slashExecuted: true,
        slashDetail: { slashAmount: 10, compensation: 5, treasuryDeposit: 5 },
      }
    },
    getTreasuryBalance() {
      calls.getTreasuryBalance = calls.getTreasuryBalance || []
      calls.getTreasuryBalance.push({})
      return treasuryBalance
    },
    getTreasuryHistory(disputeId) {
      calls.getTreasuryHistory = calls.getTreasuryHistory || []
      calls.getTreasuryHistory.push({ disputeId })
      return treasuryHistory
    },

    // M7 Market
    async createMarket(opts) {
      const { manifest, ttlMs } = opts ?? {}
      calls.createMarket = calls.createMarket || []
      // 记录调用参数数组（与 makeMethod 的 args[] 形式一致，便于 calls.X[0][0].field 断言）
      calls.createMarket.push([opts])
      const marketId = manifest?.marketId ?? ('market-' + Date.now().toString(36))
      const topic = '/s-network/market/' + marketId
      const token = {
        marketId,
        inviteeDid: dids.A,
        issuerDid: dids.A,
        expiresAt: Date.now() + (ttlMs ?? 30 * 24 * 3600 * 1000),
        signature: new Uint8Array(64),
        signerPublicKey: new Uint8Array(32),
      }
      markets.set(marketId, { marketId, manifest, topic, token, isCreator: true, members: new Set([dids.A]) })
      return { marketId, topic, token }
    },
    async issueInvite({ marketId, inviteeDid, ttlMs }) {
      calls.issueInvite = calls.issueInvite || []
      calls.issueInvite.push({ marketId, inviteeDid, ttlMs })
      const m = markets.get(marketId)
      if (!m) throw new Error(`市场 ${marketId} 不存在`)
      return {
        marketId,
        inviteeDid,
        issuerDid: dids.A,
        expiresAt: Date.now() + (ttlMs ?? 30 * 24 * 3600 * 1000),
        signature: new Uint8Array(64),
        signerPublicKey: new Uint8Array(32),
      }
    },
    async joinMarket({ token }) {
      calls.joinMarket = calls.joinMarket || []
      calls.joinMarket.push({ token })
      const m = markets.get(token.marketId)
      if (m) m.members.add(token.inviteeDid)
      return { marketId: token.marketId, topic: m?.topic ?? '/s-network/market/' + token.marketId }
    },
    async leaveMarket(marketId) {
      calls.leaveMarket = calls.leaveMarket || []
      calls.leaveMarket.push({ marketId })
      markets.delete(marketId)
    },
    listMarkets() {
      calls.listMarkets = calls.listMarkets || []
      calls.listMarkets.push({})
      return Array.from(markets.keys())
    },
    isMarketMember(marketId) {
      calls.isMarketMember = calls.isMarketMember || []
      calls.isMarketMember.push({ marketId })
      return markets.has(marketId)
    },
    async publishToMarket({ marketId, payload }) {
      calls.publishToMarket = calls.publishToMarket || []
      calls.publishToMarket.push({ marketId, payload })
      return { recipients: markets.get(marketId)?.members.size ?? 1 }
    },
    getMarketManifest(marketId) {
      calls.getMarketManifest = calls.getMarketManifest || []
      calls.getMarketManifest.push({ marketId })
      return markets.get(marketId)?.manifest ?? null
    },
    getMarketTopic(marketId) {
      calls.getMarketTopic = calls.getMarketTopic || []
      calls.getMarketTopic.push({ marketId })
      return markets.get(marketId)?.topic ?? null
    },

    // ── 暴露调用记录 + 状态供测试断言 ──
    calls,
    _state: {
      creditBalances,
      reputation,
      treasuryBalance,
      treasuryHistory,
      tunnels,
      markets,
      wikiEntries,
      wikiHistory,
      pubsubSubscriptions,
      blockstore,
      dids,
    },
  }

  return snode
}

export { DEFAULT_DIDS, MockIdentity, MockWallet }
