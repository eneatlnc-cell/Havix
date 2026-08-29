// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Havix 节点主入口
 * ───────────────────────────────────────────────
 * 当前阶段：M7 — 邀请市场（私域不可见 + 双重加密）
 *
 * 已实现：
 *   1. libp2p 节点初始化（M1.2）
 *      - TCP 传输
 *      - noise 加密（替代原规格的 plaintext，私域必须 E2E）
 *      - yamux + mplex 多路复用（yamux 优先，mplex 向后兼容）
 *      - identify 服务（必需，让对端发现自己的 multiaddrs 和协议）
 *      - gossipsub 发布订阅（注意：必须用 @libp2p/gossipsub@16.x 而非
 *        @chainsafe/libp2p-gossipsub@14.x —— 后者依赖 @libp2p/interface@2.x，
 *        与 libp2p 3.x 不兼容，会导致流无法建立）
 *      - mdns 局域网自动发现
 *      - ping 调试服务
 *   2. IPFS (helia) 初始化（独立实例，供维基 CID 使用）
 *   3. KadDHT 门控（M1.3）：私域 CID 硬拦截
 *   4. 跨网段引导（M1.4）：手动 multiaddr
 *   5. 4-context DID 派生（M2.1）：HKDF-SHA256 + Ed25519
 *   6. 公共层消息 context-A 签名（M2.2）：心跳带 signature + signerPublicKey
 *   7. gossipsub 消息验签（M2.2）：每条公共层消息做 Ed25519 验签
 *   8. 维基协议骨架（M3.1）：
 *      - WikiProtocol.publishEntry：写 IPFS + context-D 签名 + gossipsub 广播
 *      - WikiProtocol.handleAnnounce：接收方验签后索引到本地 manifest
 *      - 消息分发：gossipsub message 按 type 路由到对应 handler
 *   9. 编辑员资格门控（M3.2）：
 *      - VouchRegistry 维护 endorseDid → Set<voucherDid>，阈值 N=2
 *      - vouch 消息走 /s-network/reputation，context-A 签名
 *      - WikiProtocol.publishEntry 前置门控，未达阈值抛 EditorNotQualifiedError
 *      - SNode.vouch(endorseDid) 公开 API
 *  10. 维基版本控制链（M3.3）：
 *      - publishEntry 接受 parentCid 参数，构造版本链
 *      - 作者一致性校验：续写时父版本作者必须与当前编辑员一致
 *        （防止劫持他人条目；不一致抛 ParentCidMismatchError）
 *      - lazy 验证：父 CID 不在本地索引时不阻塞发布（仅记录）
 *      - 查询接口：listHistory(title) / getLineage(cid) / isRootEntry(cid)
 *                  / getLatestVersion(title, authorDid)
 *      - 防环保护：getLineage 上限 1000 深度 + CID 去重
 *      - 兼容旧消息：无 parentCid 字段的 announce 视为根条目
 *  11. Credit 双轨经济（M4）：
 *      - ReputationLedger：available/frozen/total 三池模型（白皮书 §4.1）
 *      - CreditLedger：holderDid → balance 余额表
 *      - Faucet：高信誉节点签发 Credit 时冻结等额自身信誉（白皮书 §4.2）
 *      - VouchRegistry 注入 reputationLedger 后自动升级为信誉加权模式
 *        （高信誉节点的 vouch 比默认 1.0 信誉节点更有分量）
 *      - credit 消息走 /s-network/reputation topic（与 vouch 同 topic）
 *      - 接收方镜像签发/消费操作到本地账本（按 nonce 幂等）
 *      - SNode.issueCredit/consumeCredit/transferCredit 公开 API
 *  12. 私聊隧道（M5）：
 *      - RelayRegistry：准入（信誉前 30% + vouch≥3）+ epoch 轮换（20% 概率被换下）
 *      - TunnelManager：3 条并行 relay 多链路对冲（round-robin 分片）
 *      - 硬切换：relay 下线从 active 集合移除，剩余继续服务；全断开抛 TunnelBrokenError
 *      - context-C 子身份作为私聊 sourceDid（与维基 D / 公开 A / 市场 B 隔离）
 *      - SNode.registerRelayCandidate/electRelayEpoch/rotateRelayEpoch 公开 API
 *      - SNode.establishTunnel/sendTunnelChunk/breakTunnelLink/closeTunnel 公开 API
 *  13. 临时仲裁团（M6）：
 *      - ArbitrationRegistry：fileDispute / summonPanel / castVote / resolveVerdict
 *      - TreasuryLedger：金库账本（slash 的 50% 进金库，M6 只进不出）
 *      - Slash 只动 frozen 池不动 available（白皮书 §5.3：防治理武器化）
 *      - 50% 赔受害者 + 50% 进金库（slashRatio 默认 0.5）
 *      - 仲裁消息走 /s-network/alert topic（与 announce/reputation 分开）
 *      - SNode.registerJurorCandidate/checkJurorEligibility 公开 API
 *      - SNode.fileDispute/summonArbitrationPanel/castArbitrationVote/resolveVerdict 公开 API
 *      - SNode.getTreasuryBalance/getTreasuryHistory 公开 API（金库审计）
 *  14. 邀请市场（M7）：
 *      - AppManifest：name/version/capability 必需 + permissions/spa_cid/min_reputation/trust_weight 可选
 *      - InviteToken：issuer context-A 签名 + inviteeDid 绑定 + expiresAt 过期 + nonce 防重放
 *      - 私有 topic = sha256(令牌) → /s-network/market/<hex64>（白皮书 §6.5 第一层）
 *      - 消息体 AES-256-GCM 加密（HKDF(令牌, "market-encryption") 派生密钥，白皮书 §6.5 第二层）
 *      - MarketRegistry：管理本节点参与的市场（createMarket / joinMarket / leaveMarket / listMarkets）
 *      - publishMarketMessage：构造明文信封 + 加密块 → 广播到私有 topic
 *      - handleMarketMessage：接收方按 topic 反查 marketId → AES-GCM 解密 → 返回 payload
 *      - SNode.createMarket/issueInvite/joinMarket/publishToMarket/leaveMarket 公开 API
 *      - SNode.listMarkets/isMarketMember/getMarketManifest/getMarketTopic 公开 API
 *
 * 审计修复（M8 集成前深度审计）：
 *   P0（关键安全）：
 *     P0-1  签名覆盖整个 canonical message（version/type/senderId/timestamp/payload）
 *           而非仅 payload——防 senderId / type 篡改（message-types.js canonicalMessage）
 *     P0-2  credit note 内层签名验证 + senderId === note.issuerDid 绑定（防伪造 issuer）
 *           verifyCreditNoteSignature() + _handleCreditMessage 双层校验
 *     P0-3  topic 前缀分流：/s-network/market/ 走私域消息路径（AES-GCM 已认证，无需公共层签名）
 *     P0-4  InviteToken.verifySelf() 零依赖自验签；joinMarket 强制调用（防伪造 issuer 签发令牌）
 *     P0-5  gossipsub handler 顶层 try/catch：任何 handler 异常都不让节点崩溃（DoS 防护）
 *     P0-6  slash 0 守卫：frozenBefore=0 时跳过 slash 与赔偿（防 zero-amount 路径崩溃）
 *   P1（健壮性 / 一致性）：
 *     P1-faucet     Faucet.consume 原子性：release 失败时回滚 holder 余额（credit.js）
 *     P1-arb-mirror arbitration filed/verdict senderId 镜像校验
 *                   filed: senderId === claimant；verdict: senderId ∈ panel
 *     P1-market-gate issueInvite 强制 min_reputation 检查（白皮书 §8.2，抛 InsufficientReputationError）
 *     P1-bounds     vouch/wiki/credit/arbitration: timestamp/amount 加 Number.isFinite 检查
 *     P1-lru        market/vouch/wiki/arbitration/credit-nonces 的 Set/Map 加 100,000 上限（FIFO 退化 LRU）
 *     P1-threshold  VouchRegistry.thresholdScore 用 ledger.initialReputation 推导（向后兼容）
 *   P2（可维护性 / 启动正确性）：
 *     P2-1  start() 失败回滚：拆分为 start() + _startInternal()，
 *           ipfs.start() 成功后任何步骤抛错都调用 stop() 清理半启动资源
 *     P2-2  监听器注册顺序：先 addEventListener 再 subscribe（避免消息丢失窗口）
 *     P2-3  JSDoc/注释修正：本头注释新增"审计修复"小节；各 P0/P1/P2 修复点处加内联注释
 *
 * 暂未实现 / Deferred（后续里程碑或未来工作）：
 *   - M8: CLI 收口 + 4 节点集成测试
 *   - 未来工作：vouch 自动给 endorseDid 累积 reputation、Reputation 时间衰减、
 *              完整双重支付防护（M6 已用本地账本视图，跨节点账本一致性靠 gossipsub 消息收敛）、
 *              信用汇率（高信誉节点 credit 更值钱）、
 *              真实 libp2p stream 跨进程传输（M5 用字节级接口，跨进程集成留 M8）、
 *              跨节点 relay 选举协议（M5 用本地视图，跨节点同步 deferred 到未来）、
 *              电路迁移应用层重连（M5 硬切换即隧道断开，应用层感知由 M8 CLI 收口）、
 *              relay 服务质量监控（M6 仲裁已支持 relay-malice 类型，监控细节 deferred）、
 *              24 小时超时重抽（M6 由外部触发，定时器 deferred 到 M8）、
 *              候补仲裁员自动补位（M6 用固定 5 节点，候补机制 deferred）、
 *              真实分布式随机数 VRF（M6 用 Math.random，与 M5 epoch 轮换一致）、
 *              金库支出用途治理（M6 只进不出，未来由社区治理决定）、
 *              金库 ledger 写入 IPFS 公开审计（M6 用内存账本，IPFS ledger deferred）、
 *              跨节点仲裁团选举协议（M6 用本地视图，跨节点同步 deferred 到未来）、
 *              跨节点 transfer 同步（M7 用本地账本视图，跨节点同步靠 gossipsub 消息收敛）、
 *              market 内 offer/credit 完整流转（M7 只提供加密通道，业务逻辑由 App 自行实现）、
 *              SPA bundle 拉取与缓存（M7 用 IPFS CID 占位 spa_cid，不实现拉取）、
 *              App Manifest 动态权重审核（白皮书 §8.4，自然涌现算法推迟到阶段二）、
 *              令牌吊销列表（M7 用 expiresAt 过期，吊销列表 deferred）、
 *              跨节点市场成员同步（M7 用本地视图，跨节点一致性靠 gossipsub 收敛）、
 *              第三方 App 加载（白皮书 §8.5 阶段一不开放，参考实现内置）
 */

import process from 'node:process'
import path from 'node:path'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { mplex } from '@libp2p/mplex'
import { identify, identifyPush } from '@libp2p/identify'
import { gossipsub } from '@libp2p/gossipsub'
import { mdns } from '@libp2p/mdns'
import { ping } from '@libp2p/ping'
import { createHeliaLight } from 'helia'
import { withLibp2p } from '@helia/libp2p'
import { withBitswap } from '@helia/bitswap'
import { kadDHT, removePublicAddressesMapper } from '@libp2p/kad-dht'

import { loadConfig } from './config.js'
import { DhtGate } from './network/dht.js'
import { Bootstrap } from './network/rendezvous.js'
import { IdentityWallet, CONTEXT_META } from './identity.js'
import { MESSAGE_TYPES, validateMessageShape, canonicalMessage, signMessage } from './protocol/message-types.js'
import { WikiProtocol, EditorNotQualifiedError } from './protocol/wiki.js'
import { VouchRegistry, publishVouch, VOUCH_TOPIC } from './protocol/vouch.js'
import {
  ensureDir,
  loadJson,
  saveJsonAtomic,
  setToArray,
  arrayToSet,
} from './persistence.js'
import {
  ReputationLedger,
  CreditLedger,
  Faucet,
  publishCreditMessage,
  DEFAULT_INITIAL_REPUTATION,
  DEFAULT_FAUCET_MIN_REPUTATION,
  CREDIT_TOPIC,
  InsufficientReputationError,
} from './protocol/credit.js'
import {
  ArbitrationRegistry,
  TreasuryLedger,
  DISPUTE_STATUS,
  publishArbitration,
  ARBITRATION_TOPIC,
  DEFAULT_PANEL_SIZE,
  DEFAULT_VERDICT_MAJORITY,
  DEFAULT_SLASH_RATIO,
} from './protocol/arbitration.js'
import {
  RelayRegistry,
  DEFAULT_EPOCH_MS,
  DEFAULT_ROTATE_PROBABILITY,
  DEFAULT_TOP_PERCENTILE,
  DEFAULT_MIN_VOUCH_COUNT,
  DEFAULT_MIN_RELAYS,
} from './network/relay.js'
import {
  TunnelManager,
  NoRelayAvailableError,
  DEFAULT_PARALLEL_RELAYS,
} from './network/tunnel.js'
import {
  AppManifest,
  InviteToken,
  MarketRegistry,
  issueInviteToken,
  publishMarketMessage,
  handleMarketMessage,
  DEFAULT_TOKEN_TTL_MS,
  MARKET_TOPIC_PREFIX,
  InvalidManifestError,
  InvalidTokenError,
  MarketNotFoundError,
  DecryptionError,
} from './protocol/market.js'
import { Cli } from './app/cli.js'
import { WebPanel } from './app/web-panel.js'

// ──────────────────────────────────────────────
// 默认订阅的公共层频道
// ──────────────────────────────────────────────

export const DEFAULT_TOPICS = [
  '/s-network/announce',     // 通用通告
  '/s-network/reputation',   // vouch 与 credit 流水
  '/s-network/alert',        // arbitration 与裁决
]

// ──────────────────────────────────────────────
// 简易日志（按级别过滤）
// ──────────────────────────────────────────────

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

// ──────────────────────────────────────────────
// 消息签名/验签辅助
// ──────────────────────────────────────────────

/** base64 字符串 → Uint8Array（验签时解析签名/公钥用） */
function fromBase64(str) {
  return new Uint8Array(Buffer.from(str, 'base64'))
}

/**
 * 验证公共层消息的签名（M2.2 引入；P0-1 修复于审计阶段）。
 *
 * 消息格式约定：
 *   { version, type, senderId, timestamp, payload, signature?, signerPublicKey? }
 *
 * 验签规则（P0-1 修复后）：
 *   - 若消息无 signature / signerPublicKey 字段 → 视为未签名消息，返回 { signed: false }
 *   - 否则用 signerPublicKey 验证 signature 是否对应 canonical message 的 JSON 序列化字节
 *     （canonical = 移除 signature / signerPublicKey 字段后的 message，即覆盖整个明文头）
 *   - 这保证 senderId / type / timestamp 不能被第三方篡改（防伪造身份、防 type 篡改）
 *   - 验签不依赖外部库：直接调用 @noble/curves 的 Ed25519 verify
 *
 * @param {object} message 已解析的消息对象
 * @returns {Promise<{signed: boolean, valid?: boolean, error?: string}>}
 */
export async function verifyMessageSignature(message) {
  if (!message.signature || !message.signerPublicKey) {
    return { signed: false }
  }

  try {
    // 延迟导入，避免未使用签名消息时也加载该模块
    // 动态 import 不支持 `as` 别名，改用字段访问
    const edModule = await import('@noble/curves/ed25519.js')
    const ed = edModule.ed25519

    const signature = fromBase64(message.signature)
    const publicKey = fromBase64(message.signerPublicKey)
    // P0-1 修复：签名覆盖整个 canonical message（含 version/type/senderId/timestamp/payload）
    const canonical = canonicalMessage(message)
    const signBytes = new TextEncoder().encode(JSON.stringify(canonical))

    const valid = ed.verify(signature, signBytes, publicKey)
    return { signed: true, valid }
  } catch (err) {
    return { signed: true, valid: false, error: err.message }
  }
}

/**
 * 验证 CreditNote 内层签名（P0-2 修复）。
 *
 * CreditNote 内层结构 = { type, issuerDid, holderDid, amount, nonce, timestamp,
 *                          prevNoteCid, signature, signerPublicKey }
 *
 * 签名覆盖 canonical（移除 signature / signerPublicKey 后的字段）的 JSON 字节。
 * 该签名由 issuer 用 context-A 子身份在 Faucet.issue 时生成。
 *
 * @param {object} note 已签名的 CreditNote
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
export async function verifyCreditNoteSignature(note) {
  if (!note || !note.signature || !note.signerPublicKey) {
    return { valid: false, error: 'note 缺少 signature / signerPublicKey' }
  }
  try {
    const edModule = await import('@noble/curves/ed25519.js')
    const ed = edModule.ed25519
    const signature = fromBase64(note.signature)
    const publicKey = fromBase64(note.signerPublicKey)
    const { signature: _s, signerPublicKey: _p, ...canonical } = note
    const signBytes = new TextEncoder().encode(JSON.stringify(canonical))
    const valid = ed.verify(signature, signBytes, publicKey)
    return { valid, error: valid ? undefined : '签名不匹配' }
  } catch (err) {
    return { valid: false, error: err.message }
  }
}

function makeLogger(level) {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.info
  return (lvl, tag, msg, ...args) => {
    if (LOG_LEVELS[lvl] < threshold) return
    const ts = new Date().toISOString().slice(11, 23)
    const color = {
      debug: '\x1b[90m', info: '\x1b[36m',
      warn: '\x1b[33m', error: '\x1b[31m',
    }[lvl] ?? ''
    const reset = '\x1b[0m'
    console.log(`${color}[${ts}] [${lvl}]${reset} [${tag}] ${msg}`, ...args)
  }
}

// ──────────────────────────────────────────────
// SNode 节点主类
// ──────────────────────────────────────────────

export class SNode {
  /**
   * @param {object} config 由 loadConfig() 返回的配置对象
   */
  constructor(config) {
    this.config = config
    this.log = makeLogger(config.logLevel)

    // M9.3 AppManager 句柄（在 startApp() 中由外部注入；SNode 用它派发 credit 消息）
    this.appManager = null

    // M8.1 持久化目录：dataDir/ledgers/
    // 复用 config.dataDir（默认 '.data'，可由 --data-dir 或 HAVIX_DATA_DIR 覆盖）
    // 不存在则 start() 时 ensureDir 创建
    this.persistDir = path.join(config.dataDir ?? '.data', 'ledgers')
    // 各 ledger 文件路径（start() 内部 ensureDir 后使用）
    this._persistPaths = {
      reputation: path.join(this.persistDir, 'reputation.json'),
      credit: path.join(this.persistDir, 'credit.json'),
      vouch: path.join(this.persistDir, 'vouches.json'),
      wiki: path.join(this.persistDir, 'wiki-index.json'),
      arbitration: path.join(this.persistDir, 'arbitration.json'),
      treasury: path.join(this.persistDir, 'treasury.json'),
      market: path.join(this.persistDir, 'markets.json'),
      creditNonces: path.join(this.persistDir, 'credit-nonces.json'),
    }

    // libp2p / IPFS 实例（start() 后填充）
    this.peerId = null
    this.libp2p = null
    this.ipfs = null

    // DHT 门控（start() 后填充）
    // 包装 libp2p.contentRouting，强制执行公私 CID 分离
    this.dhtGate = null

    // 跨网段引导模块（start() 后填充）
    // @libp2p/rendezvous 不存在，MVP 用手动 multiaddr 引导替代
    this.bootstrap = null

    // 身份钱包（start() 后填充）
    // 从主 PeerId 派生 4 个 context 子身份（A/B/C/D）
    // 公共层消息用 context-A 子身份签名，使接收方可验签且不可关联到主身份
    this.wallet = null

    // 维基协议（start() 后填充）
    // M3.1：编辑员用 context-D 子身份发布条目，CID 广播走 /s-network/announce
    // M3.2：publishEntry 前置 vouch 阈值门控（由 vouchRegistry 提供计数）
    this.wiki = null

    // 编辑员资格注册表（start() 后填充）
    // M3.2：维护 endorseDid → Set<voucherDid>，阈值 N=2
    // M4：注入 reputationLedger 后自动切换为信誉加权模式
    this.vouchRegistry = null

    // M4 经济层（start() 后填充）
    //   - reputationLedger：available/frozen/total 三池信誉账本
    //   - creditLedger：holderDid → balance 余额表
    //   - faucet：高信誉节点签发 Credit 的入口（context-A 子身份作为 issuer）
    this.reputationLedger = null
    this.creditLedger = null
    this.faucet = null

    // M4：credit 消息幂等去重（按 note.nonce）
    // P1-A5-13 修复：加 LRU 上限，防止长跑节点内存膨胀
    this._processedCreditNonces = new Set()
    this._creditNonceLimit = 100_000  // 上限 10 万条 nonce，超限移除最早

    // P1-A5-10 修复：保存监听器引用，stop() 时移除（防重启重复注册）
    this._pubsubHandler = null
    this._peerDiscoveryHandler = null
    this._connectionOpenHandler = null
    this._connectionCloseHandler = null

    // M5 私聊隧道（start() 后填充）
    //   - relayRegistry：维护当前当选 relay 集合（准入阈值 + epoch 轮换）
    //   - tunnelManager：管理 A↔B 多链路隧道（单跳 relay + round-robin 对冲 + 硬切换）
    this.relayRegistry = null
    this.tunnelManager = null

    // M6 仲裁团（start() 后填充）
    //   - arbitrationRegistry：维护 dispute + 仲裁团召集 + 投票 + 裁决 + slash 执行
    //   - treasury：金库账本（slash 的 50% 进金库，M6 只进不出）
    this.arbitrationRegistry = null
    this.treasury = null

    // M7 邀请市场（start() 后填充）
    //   - marketRegistry：管理本节点参与的私域市场（manifest + token + topic）
    //   - 私有 topic = sha256(邀请令牌)（白皮书 §6.5 第一层）
    //   - 消息体 AES-GCM 加密（白皮书 §6.5 第二层）
    this.marketRegistry = null

    // 邻居与信誉状态
    this.reputation = new Map()       // peerIdString -> number
    this.neighbors = new Set()        // 活跃邻居 peerIdString
    this.topics = new Set(DEFAULT_TOPICS)

    // 定时器引用（start() 后填充，stop() 时清理）
    this._timers = []
  }

  // ──────────────────────────────────────────
  // 启动
  // ──────────────────────────────────────────

  async start() {
    const log = this.log

    // P2-1 修复：start() 失败回滚
    // ipfs.start() 成功后，后续任何步骤（DHT 门控、身份派生、协议初始化、
    // 订阅 topic、注册监听器）抛错都必须回滚已启动的资源，避免半启动节点残留。
    // 回滚策略：调用 this.stop() 清理已注册的监听器 + 停止 ipfs。
    const startedIpfs = { value: false }
    try {
      await this._startInternal(log, startedIpfs)
    } catch (err) {
      log('error', 'node', `start() 失败，开始回滚：${err.message}`)
      try {
        await this.stop()
      } catch (stopErr) {
        log('error', 'node', `回滚 stop() 也异常：${stopErr.message}`)
      }
      throw err
    }
  }

  /**
   * start() 内部实现（P2-1 修复后拆分）。
   *
   * @param {function} log logger
   * @param {{ value: boolean }} startedIpfs 标记 ipfs 是否已启动（用于回滚判断）
   */
  async _startInternal(log, startedIpfs) {
    // ── 1. 初始化 IPFS (helia) + Havix 协议层 libp2p ──
    // helia 7.x 的 createHelia() 会自动调用 withLibp2p 装载默认 libp2p mixin，
    // 二次调用 withLibp2p 会报 "already present"。
    // 正确做法：用 createHeliaLight() 创建裸 helia，再手动组合 mixin：
    //   createHeliaLight → withLibp2p（自定义配置）→ withBitswap（IPFS 块交换）
    log('info', 'ipfs', '初始化 IPFS (helia) + libp2p...')

    // DHT 配置根据 dhtMode 选择：
    //   lan = 仅局域网 DHT，不接入公网 IPFS Amino DHT（Havix 默认）
    //   wan = 接入公网 IPFS DHT
    // 白皮书设计：Havix 默认 lan 模式，避免公网暴露
    const dhtConfig = this.config.dht
      ? {
          dht: kadDHT({
            protocol: this.config.dhtMode === 'lan'
              ? '/ipfs/lan/kad/1.0.0'    // LAN 私有协议，与公网 DHT 隔离
              : '/ipfs/kad/1.0.0',       // 标准 IPFS 公网 DHT 协议
            peerInfoMapper: this.config.dhtMode === 'lan'
              ? removePublicAddressesMapper  // LAN 模式不公告公网地址
              : undefined,
            clientMode: false,           // 服务器模式，可路由其他节点
          }),
        }
      : {}  // 用户禁用 DHT 时不注册

    this.ipfs = withBitswap(
      withLibp2p(
        createHeliaLight(),
        {
          addresses: {
            // 监听所有网卡的指定端口（0 = 随机）
            listen: [`/ip4/0.0.0.0/tcp/${this.config.port}`],
          },
          transports: [tcp()],
          connectionEncrypters: [noise()],
          // yamux 优先，mplex 向后兼容
          streamMuxers: [yamux(), mplex()],
          peerDiscovery: this.config.mdns ? [mdns()] : [],
          services: {
            // identify 必需：让对端发现自己的 multiaddrs 和协议
            identify: identify(),
            identifyPush: identifyPush(),
            // ping 调试用
            ping: ping(),
            // gossipsub：公共层广播频道
            pubsub: gossipsub({
              emitSelf: false,                    // 不接收自己发的消息
              allowPublishToZeroTopicPeers: true,  // 即使无订阅者也允许 publish
              strictSigning: true,                 // 强制签名
              fallbackToFloodsub: true,            // 允许 fallback 到 floodsub（兼容性）
              floodPublish: true,                  // 自发布消息发到所有 peers
            }),
            // DHT（仅当 config.dht=true）
            ...dhtConfig,
          },
        }
      )
    )

    // 启动 helia（同时启动 libp2p mixin）
    await this.ipfs.start()
    startedIpfs.value = true   // P2-1 修复：标记 ipfs 已启动，回滚时需 stop()
    this.libp2p = this.ipfs.libp2p
    this.peerId = this.libp2p.peerId
    log('info', 'ipfs', `IPFS + libp2p 就绪。peerId = ${this.peerId.toString()}`)

    const multiaddrs = this.libp2p.getMultiaddrs().map(String)
    log('info', 'libp2p', `Havix 节点就绪`)
    log('info', 'libp2p', `监听地址：`)
    for (const ma of multiaddrs) {
      console.log(`           - ${ma}`)
    }

    // ── 1b. 初始化 DHT 门控 ──
    // DhtGate 包装 libp2p.contentRouting，强制公私 CID 分离：
    //   - 公共 CID（维基条目）可走 provide/findProviders
    //   - 私域 CID（市场/私聊/Credit）调用 DHT API 时抛 PrivateCidRejectedError
    if (this.config.dht) {
      this.dhtGate = new DhtGate(this.libp2p)
      log('info', 'dht', `KadDHT 就绪（mode=${this.config.dhtMode}, protocol=${this.config.dhtMode === 'lan' ? '/ipfs/lan/kad/1.0.0' : '/ipfs/kad/1.0.0'}）`)
      log('info', 'dht', `DHT 门控已激活：私域 CID 调用 provide/findProviders 将抛 PrivateCidRejectedError`)
    } else {
      log('warn', 'dht', `DHT 已禁用（HAVIX_DHT=false）`)
    }

    // ── 1c. 派生 4-context 子身份（M2）──
    // 主 PeerId 用于 P2P 传输（libp2p 通道），但公共层消息签名用 context-A 子身份。
    // 这样：
    //   - 网络层只能看到主 PeerId（不能从传输层关联到消息签名者）
    //   - 公共层消息接收方只能看到 context-A 子 DID（不能关联到市场/私聊/维基身份）
    // 4 个 context 在密码学上互不可关联（HKDF 单向 + Ed25519 独立 keypair）
    log('info', 'identity', '派生 4-context 子身份...')
    this.wallet = await IdentityWallet.fromLibp2p(this.libp2p)
    log('info', 'identity', `主 DID = ${this.wallet.masterPeerId.toString()}`)
    for (const id of this.wallet.identities) {
      const meta = CONTEXT_META[id.contextKey]
      log('info', 'identity',
        `  [${id.contextKey}] ${meta.label.padEnd(4)} → ${id.did}  (${meta.description})`)
    }

    // ── 1c-bis. 初始化维基协议 + 编辑员资格注册表 + M4 经济层 ──
    // M3.1：编辑员用 context-D 子身份发布条目（写 IPFS + gossipsub 广播）
    // M3.2：publishEntry 前置门控——vouch 累积 < 阈值时拒绝发布
    //       VouchRegistry 维护 endorseDid → Set<voucherDid>，阈值 N=2
    // M4：注入 reputationLedger → VouchRegistry 自动切换为信誉加权模式
    //     （高信誉节点的 vouch 比默认 1.0 信誉节点更有分量）
    //     Faucet 用 context-A 子身份作为 issuer（公开层活跃性身份）
    //
    // M8.1 持久化：每个 registry 构造时传 persistPath（不传则纯内存模式），
    //   构造后立即调用 loadState(loadJson(path, null)) 从磁盘恢复状态。
    //   loadJson 文件不存在/解析失败时返回 null（不抛错），保证首次启动正常。
    ensureDir(this.persistDir)
    this.reputationLedger = new ReputationLedger({ log, persistPath: this._persistPaths.reputation })
    this.creditLedger = new CreditLedger({ log, persistPath: this._persistPaths.credit })
    this.vouchRegistry = new VouchRegistry({
      threshold: 2,
      reputationLedger: this.reputationLedger,  // M4 升级为信誉加权
      log,
      persistPath: this._persistPaths.vouch,
    })
    this.wiki = new WikiProtocol({
      helia: this.ipfs,
      pubsub: this.libp2p.services.pubsub,
      editorIdentity: this.wallet.get('D'),
      vouchRegistry: this.vouchRegistry,
      log,
      persistPath: this._persistPaths.wiki,
    })
    this.faucet = new Faucet({
      reputationLedger: this.reputationLedger,
      creditLedger: this.creditLedger,
      issuerIdentity: this.wallet.get('A'),   // context-A：公开层活跃身份
      log,
    })

    // M8.1：从磁盘加载已持久化的状态（合并式恢复，不覆盖现有数据）
    this.reputationLedger.loadState(loadJson(this._persistPaths.reputation, null, { log }))
    this.creditLedger.loadState(loadJson(this._persistPaths.credit, null, { log }))
    this.vouchRegistry.loadState(loadJson(this._persistPaths.vouch, null, { log }))
    this.wiki.loadState(loadJson(this._persistPaths.wiki, null, { log }))

    // M8.1：加载 credit 消息幂等去重 nonce 集合
    {
      const json = loadJson(this._persistPaths.creditNonces, null, { log })
      if (json && Array.isArray(json.nonces)) {
        this._processedCreditNonces = arrayToSet(json.nonces)
        log('info', 'credit', `恢复 ${this._processedCreditNonces.size} 个 credit nonce`)
      }
    }
    log('info', 'wiki',
      `维基协议就绪（editor DID = ${this.wallet.get('D').did.slice(0, 16)}...，vouch 阈值 = ${this.vouchRegistry.threshold}（加权 ${this.vouchRegistry.thresholdScore}））`)
    log('info', 'credit',
      `M4 经济层就绪（reputation 默认 ${DEFAULT_INITIAL_REPUTATION}，faucet 门槛 ${DEFAULT_FAUCET_MIN_REPUTATION}，issuer = context-A）`)

    // ── 1c. M5 私聊隧道 ──
    // 白皮书 §7：单跳 relay + 多链路对冲 + 信誉问责。
    // RelayRegistry 注入 reputationLedger + vouchRegistry，准入时实时读取账本状态。
    // TunnelManager 默认 3 条并行 relay（白皮书 §7.2）。
    this.relayRegistry = new RelayRegistry({
      reputationLedger: this.reputationLedger,
      vouchRegistry: this.vouchRegistry,
      log,
    })
    this.tunnelManager = new TunnelManager({ log })
    log('info', 'tunnel',
      `M5 隧道层就绪（epoch=${DEFAULT_EPOCH_MS}ms，轮换概率=${DEFAULT_ROTATE_PROBABILITY}，准入 top=${DEFAULT_TOP_PERCENTILE} + vouch≥${DEFAULT_MIN_VOUCH_COUNT}，并行 relay=${DEFAULT_PARALLEL_RELAYS}）`)

    // ── 1d. M6 仲裁团 ──
    // 白皮书 §5：临时仲裁团 + slash 只动 frozen + 金库审计。
    // 注入 M4 reputationLedger（用于查信誉 + 执行 slash）与 M3.2 vouchRegistry（用于查 vouch + 排除关联）。
    // 金库 treasury 作为 ArbitrationRegistry 内部组件，同时暴露到 SNode 供审计。
    // M8.1：treasury + arbitrationRegistry 持久化到独立 JSON 文件。
    this.treasury = new TreasuryLedger({ log, persistPath: this._persistPaths.treasury })
    this.arbitrationRegistry = new ArbitrationRegistry({
      reputationLedger: this.reputationLedger,
      vouchRegistry: this.vouchRegistry,
      treasury: this.treasury,
      log,
      persistPath: this._persistPaths.arbitration,
    })
    // M8.1：从磁盘加载已持久化的状态
    this.treasury.loadState(loadJson(this._persistPaths.treasury, null, { log }))
    this.arbitrationRegistry.loadState(loadJson(this._persistPaths.arbitration, null, { log }))
    log('info', 'arbitration',
      `M6 治理层就绪（panelSize=${DEFAULT_PANEL_SIZE}，多数阈值=${DEFAULT_VERDICT_MAJORITY}，slashRatio=${DEFAULT_SLASH_RATIO}）`)

    // ── 1d. M7 邀请市场 ──
    // 白皮书 §6.5 + §8：私有 topic = sha256(令牌) + 消息体 AES-GCM 加密（双重加密）
    // MarketRegistry 维护本节点参与的市场（创建或加入）
    // 公开 API：createMarket / issueInvite / joinMarket / publishToMarket / leaveMarket / listMarkets
    // M8.1：marketRegistry 持久化（markets + seenNonces 一并落盘）
    this.marketRegistry = new MarketRegistry({ log, persistPath: this._persistPaths.market })
    this.marketRegistry.loadState(loadJson(this._persistPaths.market, null, { log }))
    log('info', 'market',
      `M7 市场层就绪（topic 前缀 /s-network/market/，AES-256-GCM，token TTL=${DEFAULT_TOKEN_TTL_MS}ms）`)

    // ── 1d. 跨网段引导（手动 multiaddr 引导）──
    // 白皮书原计划用 @libp2p/rendezvous，但该包不存在（详见 rendezvous.js 注释）。
    // MVP 用手动 multiaddr 引导：用户通过 --bootstrap 或 HAVIX_BOOTSTRAP 指定跨网段节点。
    // dial 成功后这些节点会被 connection:open 事件加入 neighbors Set，与 mdns 发现同等对待。
    if (this.config.bootstrap.length > 0) {
      // 适配日志：Bootstrap 期望 { info, warn, debug } 方法风格，
      // s-node.js 的 logger 是函数风格 log(level, tag, msg, ...args)
      const bootstrapLogger = {
        info: (tag, msg, ...args) => log('info', tag, msg, ...args),
        warn: (tag, msg, ...args) => log('warn', tag, msg, ...args),
        debug: (tag, msg, ...args) => log('debug', tag, msg, ...args),
        error: (tag, msg, ...args) => log('error', tag, msg, ...args),
      }
      this.bootstrap = new Bootstrap(this.libp2p, this.config.bootstrap, bootstrapLogger)
      log('info', 'bootstrap', `配置了 ${this.config.bootstrap.length} 个引导节点，开始连接...`)
      // 异步连接，不阻塞 start() —— 引导节点连接失败不致命
      this.bootstrap.connect().catch(err => {
        log('error', 'bootstrap', `引导过程异常：${err.message}`)
      })
    }

    // ── 3. 注册事件监听器（P2-2 修复：必须在订阅 topic 之前完成）──
    // P2-2 修复：原顺序是先 subscribe(topic) 再 addEventListener('message', handler)，
    // 这会造成消息丢失窗口——订阅后到 handler 注册前到达的消息会被丢弃。
    // 正确顺序：先注册所有监听器（peer:discovery / connection / pubsub message），
    //           再 subscribe(topic)，确保第一条消息就能被 handler 接收。
    //
    // 3a. 监听 peer:discovery（自动 dial 邻居）
    // P1-A5-10 修复：保存监听器引用，stop() 时移除（防重启重复注册）
    this._peerDiscoveryHandler = (evt) => {
      const peerInfo = evt.detail
      const peerIdStr = peerInfo.id.toString()
      log('debug', 'discovery', `发现节点 ${peerIdStr}`)

      // 异步 dial，不阻塞事件循环
      this._dialPeer(peerInfo).catch(err => {
        log('debug', 'discovery', `dial ${peerIdStr} 失败: ${err.message}`)
      })
    }
    this.libp2p.addEventListener('peer:discovery', this._peerDiscoveryHandler)

    // 3b. 监听 connection 建立 / 断开
    this._connectionOpenHandler = (evt) => {
      const conn = evt.detail
      const remotePeer = conn.remotePeer.toString()
      this.neighbors.add(remotePeer)
      log('info', 'neighbor', `已连接 → ${remotePeer} (共 ${this.neighbors.size} 个邻居)`)
    }
    this.libp2p.addEventListener('connection:open', this._connectionOpenHandler)

    this._connectionCloseHandler = (evt) => {
      const conn = evt.detail
      const remotePeer = conn.remotePeer.toString()
      this.neighbors.delete(remotePeer)
      log('info', 'neighbor', `断开连接 ✕ ${remotePeer} (剩 ${this.neighbors.size} 个邻居)`)
    }
    this.libp2p.addEventListener('connection:close', this._connectionCloseHandler)

    // 3c. 监听 gossipsub 消息（M3.1 起按 type 分发到具体 handler）
    // 通用流程：
    //   0. P0-5 修复：顶层 try/catch 防止 handler 异常导致节点崩溃（DoS 防护）
    //   0b. P0-3 修复：按 topic 前缀分流——/s-network/market/ 走私域消息处理（不验签，AES-GCM 已认证）
    //                  公共层 topic 走标准验签流程
    //   1. JSON 解析
    //   2. validateMessageShape 校验 version/type/senderId/timestamp/payload
    //   3. verifyMessageSignature Ed25519 验签（M2.2；P0-1 修复后覆盖 canonical message）
    //   4. 按 type 分发到 handler：
    //        heartbeat     → M3.1 暂仅日志（M4 加 vouch 累积）
    //        wiki-announce → WikiProtocol.handleAnnounce
    //        vouch/credit/arbitration → 各自 handler
    this._pubsubHandler = async (evt) => {
      const { topic, data, from } = evt.detail
      // P0-5 修复：顶层 try/catch，任何 handler 异常都不能让节点崩溃
      try {
        const text = new TextDecoder().decode(data)

        // P0-3 修复：市场 topic 分流——私域消息已 AES-GCM 加密，无需公共层签名校验
        if (topic.startsWith(MARKET_TOPIC_PREFIX)) {
          await this._handleMarketTopicMessage(topic, text, from)
          return
        }

        // 1. JSON 解析
        let message
        try {
          message = JSON.parse(text)
        } catch {
          log('debug', 'pubsub', `<${topic}> from ${from?.toString() ?? 'unknown'}: ${text.slice(0, 60)}（非 JSON，忽略）`)
          return
        }

        // 2. 结构校验（M3.1 引入，统一在 message-types.js 里实现）
        const shape = validateMessageShape(message)
        if (!shape.valid) {
          log('warn', 'pubsub', `<${topic}> 结构校验失败：${shape.error}`)
          return
        }

        // 3. 签名校验（M2.2 引入；P0-1 修复后覆盖 canonical message）
        const verifyResult = await verifyMessageSignature(message)
        if (!verifyResult.signed) {
          log('warn', 'pubsub',
            `<${topic}> 收到 ${message.type} from ${message.senderId.slice(0, 12)}...（未签名，忽略）`)
          return
        }
        if (!verifyResult.valid) {
          log('warn', 'pubsub',
            `<${topic}> 收到 ${message.type} from ${message.senderId.slice(0, 12)}...（验签失败：${verifyResult.error ?? '签名不匹配'}）`)
          return
        }

        // 4. 按 type 分发
        const fromPeerId = from?.toString() ?? null
        switch (message.type) {
          case MESSAGE_TYPES.HEARTBEAT:
            // M3.1 仅日志；M4 起用 vouch 累积更新邻居信誉
            log('debug', 'heartbeat',
              `<${topic}> ✓ from ${message.senderId.slice(0, 16)}...（knownPeersCount=${message.payload.knownPeersCount ?? 0}）`)
            break

          case MESSAGE_TYPES.WIKI_ANNOUNCE: {
            // 维基 CID 广播：交给 WikiProtocol 索引
            const r = this.wiki.handleAnnounce(message, { fromPeerId })
            if (r.indexed) {
              log('info', 'pubsub',
                `<${topic}> ✓ wiki-announce by ${message.senderId.slice(0, 16)}... → indexed ${r.cid.slice(0, 16)}...`)
            } else if (r.error?.includes('重复')) {
              // 重复广播不算异常，静默
              log('debug', 'wiki', `重复广播 cid=${r.cid?.slice(0, 16)}...，忽略`)
            } else {
              log('warn', 'wiki', `wiki-announce 处理失败：${r.error}`)
            }
            break
          }

          case MESSAGE_TYPES.VOUCH: {
            // vouch 消息：交给 VouchRegistry 索引
            // message.senderId = 背书人的 context-A 子 DID（已验签）
            // payload.endorseDid = 被背书人的 context-D 子 DID
            const r = this.vouchRegistry.handleVouch(message)
            if (r.added) {
              log('info', 'pubsub',
                `<${topic}> ✓ vouch by ${message.senderId.slice(0, 16)}... for ${message.payload.endorseDid.slice(0, 16)}... (total=${r.count})`)
            } else if (r.reason?.includes('幂等')) {
              // 重复 vouch 不算异常，静默
              log('debug', 'vouch', `重复 vouch，忽略（total=${r.count}）`)
            } else if (r.reason?.includes('自 vouch')) {
              log('warn', 'vouch', `拒绝自 vouch from ${message.senderId.slice(0, 16)}...`)
            } else {
              log('warn', 'vouch', `vouch 处理失败：${r.reason}`)
            }
            break
          }

          case MESSAGE_TYPES.CREDIT: {
            // M4 credit 消息：交给 _handleCreditMessage 镜像本地账本
            // P0-2 修复：handler 内会验证内层 note.signature 与 senderId === issuerDid 绑定
            const r = await this._handleCreditMessage(message, { fromPeerId })
            if (r.applied) {
              log('info', 'pubsub',
                `<${topic}> ✓ credit ${message.payload?.note?.type ?? '?'} by ${message.senderId.slice(0, 16)}... (amount=${message.payload?.note?.amount ?? '?'})`)
            } else if (r.reason?.includes('幂等')) {
              log('debug', 'credit', `重复 credit 消息，忽略（nonce=${message.payload?.note?.nonce?.slice(0, 8)}...）`)
            } else {
              log('warn', 'credit', `credit 处理失败：${r.reason}`)
            }
            break
          }

          case MESSAGE_TYPES.ARBITRATION: {
            // M6 仲裁消息：走 /s-network/alert topic
            // 接收方按 action 镜像本地状态（filed / panel-summoned / vote-cast / verdict）
            // P1-A5-3/4 修复：filed 校验 senderId === claimant；verdict 校验 senderId 是已知仲裁员
            const r = this._handleArbitrationMessage(message, { fromPeerId })
            if (r.applied) {
              log('info', 'pubsub',
                `<${topic}> ✓ arbitration ${message.payload?.action ?? '?'} on ${message.payload?.disputeId?.slice(0, 16)}...`)
            } else {
              log('debug', 'arbitration', `arbitration 处理：${r.reason}`)
            }
            break
          }

          default:
            // 其他 type（acknowledge 等）暂未接入 handler
            log('debug', 'pubsub',
              `<${topic}> ✓ ${message.type} from ${message.senderId.slice(0, 16)}...（暂未接入 handler）`)
        }
      } catch (err) {
        // P0-5 修复：任何 handler 异常都只记录，不让节点崩溃
        log('error', 'pubsub', `handler 异常 on <${topic}>: ${err.message}`)
      }
    }
    this.libp2p.services.pubsub.addEventListener('message', this._pubsubHandler)

    // ── 4. 订阅默认公共频道（P2-2 修复：在 handler 注册后订阅，避免消息丢失）──
    log('info', 'pubsub', `订阅公共频道：${DEFAULT_TOPICS.join(', ')}`)
    for (const topic of DEFAULT_TOPICS) {
      await this.libp2p.services.pubsub.subscribe(topic)
    }

    // ── 5. 心跳定时器：每 30s 向 announce 频道广播邻居列表 ──
    // M3 会用正式的 heartbeat 消息协议替换这个简化版
    this._timers.push(setInterval(() => {
      this._broadcastHeartbeat().catch(err => {
        log('warn', 'heartbeat', `心跳广播失败: ${err.message}`)
      })
    }, 30_000))

    log('info', 'node', '✓ Havix 节点启动完成。等待发现邻居...')
    log('info', 'node', '  (Ctrl+C 退出)')
  }

  // ──────────────────────────────────────────
  // 公开 API（M3.2 新增）
  // ──────────────────────────────────────────

  /**
   * 用本节点 context-A 子身份为某编辑员（context-D 子 DID）发起 vouch。
   *
   * 用法：
   *   node.vouch('did:havix:D:...')
   *
   * @param {string} endorseDid  被背书人的 context-D 子 DID
   * @param {string} [reason]    可选背书理由
   * @returns {Promise<{ recipients: number }>}
   */
  async vouch(endorseDid, reason) {
    if (!this.libp2p) throw new Error('节点未启动')
    const { recipients } = await publishVouch({
      pubsub: this.libp2p.services.pubsub,
      voucherIdentity: this.wallet.get('A'),
      endorseDid,
      reason,
      log: this.log,
    })
    // 本地也索引一份（自己作为 vouch 来源）
    this.vouchRegistry.addVouch(endorseDid, this.wallet.get('A').did)
    return { recipients }
  }

  // ──────────────────────────────────────────
  // 公开 API（M4 新增）
  // ──────────────────────────────────────────

  /**
   * M4: 用本节点（context-A 子身份）作为 Faucet issuer 签发 Credit 给 holderDid。
   *
   * 流程：
   *   1. Faucet.issue 本地操作：冻结 issuer 等额信誉 + credit holder 余额
   *   2. publishCreditMessage 广播 credit 消息到 /s-network/reputation
   *   3. 接收方节点 _handleCreditMessage 镜像本地操作（freeze+credit）
   *
   * 失败场景：
   *   - issuer 总信誉 < minReputation → 抛 FaucetNotAuthorizedError
   *   - issuer 可用信誉 < amount → 抛 InsufficientReputationError
   *
   * @param {object} opts
   * @param {string} opts.holderDid 收款人 did
   * @param {number} opts.amount 金额
   * @param {string} [opts.prevNoteCid] 前一笔流水 CID（流水链），首笔为 null
   * @returns {Promise<{ note: object, recipients: number }>}
   */
  async issueCredit({ holderDid, amount, prevNoteCid = null }) {
    if (!this.libp2p) throw new Error('节点未启动')
    // 1. 本地操作：冻结 issuer 信誉 + credit holder 余额
    const { note } = await this.faucet.issue({ holderDid, amount, prevNoteCid })
    // 2. 广播 credit 消息（issuer 用 context-A 子身份签外层消息）
    const { recipients } = await publishCreditMessage({
      pubsub: this.libp2p.services.pubsub,
      note,
      senderIdentity: this.wallet.get('A'),
    })
    // 3. 标记 nonce 已处理（防回环；emitSelf=false 不会收到自己的消息，但保险起见）
    this._processedCreditNonces.add(note.nonce)
    this._persistCreditNonces()  // M8.1：落盘 nonce 集合
    this.log('info', 'credit',
      `签发 ${amount} credit 给 ${holderDid.slice(0, 16)}...（recipients=${recipients}）`)
    return { note, recipients }
  }

  /**
   * M4: 消费 Credit（holderDid 余额扣减 + issuerDid 冻结信誉释放）。
   *
   * 注意：M4 简化处理，不广播 consume 消息——
   *   跨节点同步复杂（需要 holderDid 同意扣减的签名证明），deferred 到 M6 仲裁时实现。
   *   本地账本状态变化即可（M4 MVP 场景：单节点视图的经济流通）。
   *
   * @param {object} opts
   * @param {string} opts.holderDid 消费者 did
   * @param {string} opts.issuerDid 签发者 did（用于释放冻结）
   * @param {number} opts.amount 消费金额
   * @returns {{ holderBalance: number, releasedFrozen: number }}
   */
  consumeCredit({ holderDid, issuerDid, amount }) {
    if (!this.libp2p) throw new Error('节点未启动')
    const r = this.faucet.consume({ holderDid, issuerDid, amount })
    this.log('info', 'credit',
      `消费 ${amount} credit（holder=${holderDid.slice(0, 16)}...，释放 ${issuerDid.slice(0, 16)}... 的冻结信誉）`)
    return r
  }

  /**
   * M4: 转账（本地账本操作）。
   *
   * 注意：M4 简化处理，不广播 transfer 消息——
   *   跨节点 transfer 同步涉及多节点账本一致性，deferred 到 M7 邀请市场时实现。
   *
   * @param {object} opts
   * @param {string} opts.fromDid 转出方 did
   * @param {string} opts.toDid 转入方 did
   * @param {number} opts.amount 转账金额
   * @returns {{ fromBalance: number, toBalance: number }}
   */
  transferCredit({ fromDid, toDid, amount }) {
    if (!this.libp2p) throw new Error('节点未启动')
    const r = this.creditLedger.transfer(fromDid, toDid, amount)
    this.log('info', 'credit',
      `转账 ${amount} credit（${fromDid.slice(0, 16)}... → ${toDid.slice(0, 16)}...）`)
    return r
  }

  // ──────────────────────────────────────────
  // 公开 API（M6 新增）
  // ──────────────────────────────────────────

  /**
   * M6: 注册一个候选仲裁员（用本地 did）。
   *
   * @param {object} opts
   * @param {string} opts.did 候选仲裁员 did（context-A 子身份）
   * @returns {{ registered: boolean, eligible: boolean, reason?: string }}
   */
  registerJurorCandidate({ did }) {
    if (!this.arbitrationRegistry) throw new Error('节点未启动')
    return this.arbitrationRegistry.registerJurorCandidate(did)
  }

  /**
   * M6: 检查某 did 是否符合仲裁员资格。
   * @param {string} did
   * @returns {{ eligible: boolean, reputation: number, vouchCount: number, threshold: number, reason?: string }}
   */
  checkJurorEligibility(did) {
    if (!this.arbitrationRegistry) throw new Error('节点未启动')
    return this.arbitrationRegistry.isJurorEligible(did)
  }

  /**
   * M6: 发起一个 dispute（用 context-A 子身份签名）。
   *
   * @param {object} opts
   * @param {string} opts.respondent 被诉方 did
   * @param {string} opts.type       'offer-breach' | 'relay-malice' | 'vouch-collusion'
   * @param {string} [opts.evidence] 证据 IPFS CID
   * @param {number} opts.amount     索赔金额（slash 多少信誉）
   * @returns {Promise<{ dispute: object, message: object }>}
   */
  async fileDispute({ respondent, type, evidence, amount }) {
    if (!this.arbitrationRegistry) throw new Error('节点未启动')
    const claimant = this.wallet.get('A').did
    const { dispute } = this.arbitrationRegistry.fileDispute({
      claimant, respondent, type, evidence, amount,
    })
    // 广播 arbitration 消息（action=filed）
    const { message } = await publishArbitration({
      pubsub: this.libp2p.services.pubsub,
      senderIdentity: this.wallet.get('A'),
      dispute,
      action: 'filed',
    })
    this.log('info', 'arbitration',
      `发起 dispute ${dispute.disputeId}（${claimant.slice(0, 12)}... → ${respondent.slice(0, 12)}...）`)
    return { dispute, message }
  }

  /**
   * M6: 召集仲裁团。
   *
   * @param {string} disputeId
   * @param {function(): number} [rng] 随机数生成器，默认 Math.random
   * @returns {{ panel: string[], count: number, excluded: string[] }}
   */
  summonArbitrationPanel(disputeId, rng) {
    if (!this.arbitrationRegistry) throw new Error('节点未启动')
    return this.arbitrationRegistry.summonPanel(disputeId, rng)
  }

  /**
   * M6: 仲裁员投票（本节点作为仲裁员）。
   *
   * @param {object} opts
   * @param {string} opts.disputeId
   * @param {string} opts.vote 'guilty' | 'not-guilty' | 'abstain'
   * @returns {{ recorded: boolean, vote: string, reason?: string }}
   */
  castArbitrationVote({ disputeId, vote }) {
    if (!this.arbitrationRegistry) throw new Error('节点未启动')
    const jurorDid = this.wallet.get('A').did
    return this.arbitrationRegistry.castVote({ disputeId, jurorDid, vote })
  }

  /**
   * M6: 尝试达成裁决并执行 slash。
   *
   * @param {string} disputeId
   * @returns {{ resolved: boolean, verdict?: string, slashExecuted?: boolean, slashDetail?: object, reason?: string }}
   */
  resolveVerdict(disputeId) {
    if (!this.arbitrationRegistry) throw new Error('节点未启动')
    return this.arbitrationRegistry.resolveVerdict(disputeId)
  }

  /**
   * M6: 取金库余额。
   * @returns {number}
   */
  getTreasuryBalance() {
    if (!this.treasury) throw new Error('节点未启动')
    return this.treasury.getBalance()
  }

  /**
   * M6: 取金库存入历史（审计用）。
   * @param {string} [disputeId] 可选过滤
   * @returns {Array<object>}
   */
  getTreasuryHistory(disputeId) {
    if (!this.treasury) throw new Error('节点未启动')
    return this.treasury.getHistory(disputeId)
  }

  // ──────────────────────────────────────────
  // 公开 API（M7 新增）
  // ──────────────────────────────────────────

  /**
   * M7: 创建一个私域市场（本节点是创建者）。
   *
   * 流程：
   *   1. 校验 manifest
   *   2. 用 context-A 子身份签发"自邀请令牌"（issuerDid = inviteeDid = 本节点 context-A）
   *   3. 创建者也是市场成员
   *   4. 订阅私有 topic（gossipsub）
   *
   * @param {object} opts
   * @param {object} opts.manifest  App Manifest 原始字段（会构造 AppManifest 实例）
   * @param {number} [opts.ttlMs]   自邀请令牌有效期，默认 30 天
   * @returns {Promise<{ marketId: string, topic: string, token: InviteToken }>}
   */
  async createMarket({ manifest, ttlMs }) {
    if (!this.marketRegistry) throw new Error('节点未启动')
    if (!this.wallet) throw new Error('身份钱包未初始化')
    const appManifest = manifest instanceof AppManifest ? manifest : new AppManifest(manifest)
    const issuerIdentity = this.wallet.get('A')
    const marketId = appManifest.marketId

    // 创建者自邀请令牌（issuerDid = inviteeDid = 创建者 context-A DID）
    // 注：M7 MVP 简化处理 —— 创建者用 context-A 作为 issuer 与 invitee，未来可让创建者用 context-B 邀请他人
    const creatorToken = await issueInviteToken({
      marketId,
      inviteeDid: issuerIdentity.did,
      issuerIdentity,
      ttlMs,
    })

    const result = this.marketRegistry.createMarket({ manifest: appManifest, creatorToken })

    // 订阅私有 topic
    await this.libp2p.services.pubsub.subscribe(result.topic)
    this.log('info', 'market',
      `创建市场 ${marketId} 并订阅 topic ${result.topic.slice(0, 32)}...`)
    return result
  }

  /**
   * M7: 签发邀请令牌给被邀请方。
   *
   * 本节点必须是该市场的创建者。
   *
   * P1 修复：min_reputation 强制。
   *   创建者在签发邀请前必须校验 inviteeDid 的可用信誉 ≥ manifest.minReputation
   *   （白皮书 §8.2）。校验失败抛 InsufficientReputationError。
   *   注：joinMarket 侧无法强制（joiner 没有 manifest），靠创建者签发时把关。
   *
   * @param {object} opts
   * @param {string} opts.marketId
   * @param {string} opts.inviteeDid 被邀请方 context-B DID
   * @param {number} [opts.ttlMs] 有效期，默认 30 天
   * @returns {Promise<InviteToken>}
   */
  async issueInvite({ marketId, inviteeDid, ttlMs }) {
    if (!this.marketRegistry) throw new Error('节点未启动')
    const m = this.marketRegistry.getMarket(marketId)
    if (!m) throw new MarketNotFoundError({ marketId })
    if (!m.isCreator) {
      throw new Error(`本节点不是市场 ${marketId} 的创建者，无权签发邀请令牌`)
    }
    // P1-8 修复：min_reputation fail-closed（M9.6）
    //   原实现 `if (manifest && this.reputationLedger)` 在 manifest 或 ledger 缺失时
    //   静默跳过校验——任意节点都能"忘"带 ledger 后绕过信誉门槛。改为：
    //   - manifest 缺失：fail-closed 抛错（市场 manifest 是 issueInvite 的必要前置）
    //   - reputationLedger 缺失：fail-closed 抛错（节点未注入信誉账本，不能放行）
    const manifest = m.manifest
    if (!manifest) {
      throw new Error(`市场 ${marketId} 缺少 manifest，issueInvite fail-closed（P1-8 修复）`)
    }
    if (!this.reputationLedger) {
      throw new Error(
        `节点未注入 reputationLedger，issueInvite fail-closed（P1-8 修复）：` +
        `无法校验 invitee ${inviteeDid} 的可用信誉是否满足 minReputation=${manifest.minReputation}`,
      )
    }
    const inviteeRep = this.reputationLedger.getAvailable(inviteeDid)
    if (inviteeRep < manifest.minReputation) {
      throw new InsufficientReputationError({
        did: inviteeDid,
        needed: manifest.minReputation,
        available: inviteeRep,
      })
    }
    const issuerIdentity = this.wallet.get('A')
    return await issueInviteToken({
      marketId,
      inviteeDid,
      issuerIdentity,
      ttlMs,
    })
  }

  /**
   * M7: 用邀请令牌加入市场。
   *
   * @param {object} opts
   * @param {InviteToken|object} opts.token 邀请令牌（实例或 JSON 对象）
   * @returns {Promise<{ marketId: string, topic: string }>}
   */
  async joinMarket({ token }) {
    if (!this.marketRegistry) throw new Error('节点未启动')
    if (!this.wallet) throw new Error('身份钱包未初始化')
    const t = token instanceof InviteToken ? token : InviteToken.fromJSON(token)
    const myDid = this.wallet.get('B').did  // 被邀请方用 context-B DID
    // P0-4 修复：MarketRegistry.joinMarket 现在是 async（内部调用 token.verifySelf）
    const result = await this.marketRegistry.joinMarket({ token: t, myDid })
    await this.libp2p.services.pubsub.subscribe(result.topic)
    this.log('info', 'market',
      `加入市场 ${result.marketId} 并订阅 topic ${result.topic.slice(0, 32)}...`)
    return result
  }

  /**
   * M7: 离开市场（取消订阅 + 删除本地条目）。
   * @param {string} marketId
   */
  async leaveMarket(marketId) {
    if (!this.marketRegistry) throw new Error('节点未启动')
    const topic = this.marketRegistry.getTopic(marketId)
    await this.libp2p.services.pubsub.unsubscribe(topic)
    this.marketRegistry.leaveMarket(marketId)
  }

  /**
   * M7: 列出本节点参与的市场。
   * @returns {string[]}
   */
  listMarkets() {
    if (!this.marketRegistry) throw new Error('节点未启动')
    return this.marketRegistry.listMarkets()
  }

  /**
   * M7: 检查是否是某市场的成员。
   * @param {string} marketId
   * @returns {boolean}
   */
  isMarketMember(marketId) {
    if (!this.marketRegistry) throw new Error('节点未启动')
    return this.marketRegistry.isMember(marketId)
  }

  /**
   * M7: 在市场内发布加密消息。
   *
   * 流程：
   *   1. 用 marketId 对应密钥 AES-GCM 加密 payload
   *   2. 构造明文信封（type/senderId/timestamp + encrypted 块）
   *   3. gossipsub.publish(私有 topic, 信封)
   *
   * @param {object} opts
   * @param {string} opts.marketId
   * @param {object} opts.payload 业务 payload
   * @returns {Promise<{ topic: string, recipients: number }>}
   */
  async publishToMarket({ marketId, payload }) {
    if (!this.marketRegistry) throw new Error('节点未启动')
    const senderId = this.wallet.get('B').did
    return await publishMarketMessage({
      pubsub: this.libp2p.services.pubsub,
      registry: this.marketRegistry,
      marketId,
      senderId,
      payload,
    })
  }

  /**
   * M7: 取市场 manifest（仅创建者有）。
   * @param {string} marketId
   * @returns {AppManifest | null}
   */
  getMarketManifest(marketId) {
    if (!this.marketRegistry) throw new Error('节点未启动')
    return this.marketRegistry.getManifest(marketId)
  }

  /**
   * M7: 取市场的私有 topic 名（用于调试 / 监控订阅状态）。
   * @param {string} marketId
   * @returns {string}
   */
  getMarketTopic(marketId) {
    if (!this.marketRegistry) throw new Error('节点未启动')
    return this.marketRegistry.getTopic(marketId)
  }

  // ──────────────────────────────────────────
  // 公开 API（M5 新增）
  // ──────────────────────────────────────────

  /**
   * M5: 注册一个 relay 候选节点。
   *
   * 候选准入门槛由 RelayRegistry 控制：
   *   - 信誉前 30%（白皮书 §7.3，可配置 topPercentile）
   *   - vouch 数 ≥ 3（白皮书 §7.3，可配置 minVouchCount）
   *
   * 若 reputationLedger / vouchRegistry 已注入，则传入的 reputation / vouchCount 参数被忽略，
   * 以账本实时状态为准。
   *
   * @param {object} opts
   * @param {string} opts.did        候选节点 did（context-A 子身份）
   * @param {number} [opts.reputation] 可用信誉（未注入 ledger 时使用）
   * @param {number} [opts.vouchCount] vouch 计数（未注入 vouchRegistry 时使用）
   * @returns {{ registered: boolean, reason?: string }}
   */
  registerRelayCandidate({ did, reputation, vouchCount }) {
    if (!this.relayRegistry) throw new Error('节点未启动')
    return this.relayRegistry.registerCandidate(did, reputation, vouchCount)
  }

  /**
   * M5: 执行一次 relay 选举（按 top-percentile + vouch 阈值）。
   *
   * 应在 epoch 开始时调用，或外部触发 epoch 轮换时调用。
   * M5 不实现自动 epoch 推进定时器（deferred 到 M8 CLI 收口）。
   *
   * @returns {{ elected: string[], count: number }}
   */
  electRelayEpoch() {
    if (!this.relayRegistry) throw new Error('节点未启动')
    return this.relayRegistry.electEpoch()
  }

  /**
   * M5: 执行一次 epoch 轮换（20% 概率被换下，重新选举补齐）。
   *
   * @param {function(): number} [rng] 随机数生成器，默认 Math.random
   * @returns {{ rotated: string[], supplemented: string[], active: string[] }}
   */
  rotateRelayEpoch(rng) {
    if (!this.relayRegistry) throw new Error('节点未启动')
    return this.relayRegistry.rotateElection(rng)
  }

  /**
   * M5: 建立一条到 targetDid 的私聊隧道。
   *
   * 流程（白皮书 §7.2）：
   *   1. 从 RelayRegistry 的 activeRelays 中选取 parallelRelays 个 relay
   *   2. 用 context-C 子身份作为 sourceDid（私聊身份）
   *   3. TunnelManager.establishTunnel 建立隧道
   *
   * 失败场景：
   *   - activeRelays 不足 parallelRelays → 仍建立，但 relay 数 < 3（多链路对冲减弱）
   *   - activeRelays 为空 → 抛 NoRelayAvailableError
   *
   * @param {object} opts
   * @param {string} opts.targetDid 接收方 did（context-C 子身份）
   * @param {string[]} [opts.relayDids] 可选手动指定 relay 列表，默认用 activeRelays
   * @returns {{ tunnelId: string, relayDids: string[] }}
   */
  establishTunnel({ targetDid, relayDids }) {
    if (!this.tunnelManager) throw new Error('节点未启动')
    const relays = relayDids ?? this.relayRegistry.getActiveRelays()
    if (relays.length === 0) {
      throw new NoRelayAvailableError({ tunnelId: '(pre-establish)' })
    }
    const sourceDid = this.wallet.get('C').did  // context-C：私聊身份
    const tunnel = this.tunnelManager.establishTunnel({
      sourceDid,
      targetDid,
      relayDids: relays,
    })
    this.log('info', 'tunnel',
      `建立隧道 ${tunnel.tunnelId.slice(0, 8)}（${relays.length} 条 relay，${sourceDid.slice(0, 12)}... → ${targetDid.slice(0, 12)}...）`)
    return { tunnelId: tunnel.tunnelId, relayDids: relays }
  }

  /**
   * M5: 通过隧道发送一个 chunk（自动 round-robin 分配到各 relay）。
   *
   * @param {object} opts
   * @param {string} opts.tunnelId
   * @param {Uint8Array} opts.chunk
   * @returns {{ relay: string, sequence: number, total: number }}
   */
  sendTunnelChunk({ tunnelId, chunk }) {
    if (!this.tunnelManager) throw new Error('节点未启动')
    return this.tunnelManager.sendChunk(tunnelId, chunk)
  }

  /**
   * M5: 标记某隧道的某 relay 链路断开（硬切换）。
   *
   * 白皮书 §7.3：MVP 采用硬切换——relay 下线时隧道断开，应用层重连。
   * M5 语义：单条 relay 断开后从 active 集合移除，剩余 relay 继续服务；
   *         所有 relay 断开后隧道整体 broken。
   *
   * @param {object} opts
   * @param {string} opts.tunnelId
   * @param {string} opts.relayDid
   * @returns {{ status: string, remainingRelays: number }}
   */
  breakTunnelLink({ tunnelId, relayDid }) {
    if (!this.tunnelManager) throw new Error('节点未启动')
    return this.tunnelManager.breakLink(tunnelId, relayDid)
  }

  /**
   * M5: 关闭隧道。
   * @param {string} tunnelId
   */
  closeTunnel(tunnelId) {
    if (!this.tunnelManager) throw new Error('节点未启动')
    this.tunnelManager.closeTunnel(tunnelId)
  }

  // ──────────────────────────────────────────
  // 内部：处理收到的 credit 消息（M4）
  // ──────────────────────────────────────────

  /**
   * 镜像 credit 消息到本地账本。
   *
   * payload.note 是已签名的 CreditNote：
   *   { type, issuerDid, holderDid, amount, nonce, timestamp, prevNoteCid, signature, signerPublicKey }
   *
   * M4 MVP 简化策略：
   *   - 信任外层消息签名（已由主 handler 验签）
   *   - 不二次验证内层 note 签名（完整流水链验证 deferred 到 M6 仲裁）
   *   - 按 note.type 镜像本地操作：
   *       'issue':   repLedger.freeze(issuerDid, amount) + creditLedger.credit(holderDid, amount)
   *       'consume': creditLedger.debit(holderDid, amount) + repLedger.release(issuerDid, amount)
   *       'transfer': 仅本地索引，不镜像（M4 不实现跨节点 transfer 同步）
   *   - 按 note.nonce 幂等去重
   *
   * @param {object} message 已验签的 credit 消息
   * @param {object} [ctx]
   * @returns {Promise<{ applied: boolean, reason?: string }>}
   */
  async _handleCreditMessage(message, ctx = {}) {
    const { payload } = message
    if (!payload || typeof payload !== 'object') {
      return { applied: false, reason: 'payload 缺失' }
    }
    const note = payload.note
    if (!note || typeof note !== 'object') {
      return { applied: false, reason: 'payload.note 缺失' }
    }
    if (typeof note.type !== 'string' || note.type.length === 0) {
      return { applied: false, reason: 'note.type 无效' }
    }
    if (typeof note.issuerDid !== 'string' || note.issuerDid.length === 0) {
      return { applied: false, reason: 'note.issuerDid 无效' }
    }
    if (typeof note.holderDid !== 'string' || note.holderDid.length === 0) {
      return { applied: false, reason: 'note.holderDid 无效' }
    }
    if (typeof note.amount !== 'number' || !Number.isFinite(note.amount) || note.amount <= 0) {
      return { applied: false, reason: 'note.amount 无效' }
    }
    if (typeof note.nonce !== 'string' || note.nonce.length === 0) {
      return { applied: false, reason: 'note.nonce 无效' }
    }

    // P0-2 修复：验证内层 note 签名（防止重放与伪造）
    //   - note.signature 必须用 note.signerPublicKey 验证通过
    //   - message.senderId === note.issuerDid（防 senderId 伪造）
    if (message.senderId !== note.issuerDid) {
      this.log('warn', 'credit',
        `senderId(${message.senderId.slice(0, 12)}...) ≠ note.issuerDid(${note.issuerDid.slice(0, 12)}...)，拒绝`)
      return { applied: false, reason: 'senderId 与 note.issuerDid 不匹配（P0-2 修复）' }
    }
    const sigCheck = await verifyCreditNoteSignature(note)
    if (!sigCheck.valid) {
      this.log('warn', 'credit', `note 签名验证失败：${sigCheck.error ?? '签名不匹配'}，拒绝`)
      return { applied: false, reason: `note 内层签名验证失败：${sigCheck.error ?? '签名不匹配'}` }
    }

    // P1-3 修复：note.signerPublicKey 与 issuerDid 密码学绑定
    //   - verifyCreditNoteSignature 仅校验"签名 vs signerPublicKey 自洽"，
    //     不校验"signerPublicKey 真正属于 issuerDid"
    //   - 攻击者可生成新 keypair 签 issue note，绕过身份验证
    //   - 修复：用 ReputationLedger 维护 issuerDid → pubKey 绑定（first-seen wins）
    if (this.reputationLedger && typeof this.reputationLedger.registerIssuerPubKey === 'function') {
      const result = this.reputationLedger.registerIssuerPubKey(note.issuerDid, note.signerPublicKey)
      if (!result.registered) {
        this.log('warn', 'credit',
          `note.signerPublicKey 与已登记公钥冲突（issuer=${note.issuerDid.slice(0, 12)}...），拒绝（P1-3）`)
        return {
          applied: false,
          reason: 'note.signerPublicKey 与 issuerDid 已绑定公钥冲突（P1-3 修复）',
        }
      }
    }

    // 幂等：按 nonce 去重
    if (this._processedCreditNonces.has(note.nonce)) {
      return { applied: false, reason: 'credit 已处理过（幂等）' }
    }

    // 应用操作
    try {
      if (note.type === 'issue') {
        // 镜像签发：冻结 issuerDid 信誉 + credit holderDid 余额
        this.reputationLedger.freeze(note.issuerDid, note.amount)
        this.creditLedger.credit(note.holderDid, note.amount)
      } else if (note.type === 'consume') {
        // 镜像消费：debit holderDid 余额 + release issuerDid 冻结信誉
        this.creditLedger.debit(note.holderDid, note.amount)
        this.reputationLedger.release(note.issuerDid, note.amount)
      } else {
        // 'transfer' 等类型 M4 不实现跨节点同步
        this.log('debug', 'credit',
          `收到 ${note.type} 类型 credit 消息（M4 未实现跨节点同步，本地账本未更新）`)
        // 仍标记为已处理（避免重复警告刷屏）
        this._processedCreditNonces.add(note.nonce)
        this._persistCreditNonces()  // M8.1：落盘 nonce 集合
        return { applied: false, reason: `${note.type} 类型未在 M4 实现跨节点同步` }
      }
    } catch (err) {
      // 应用失败：不标记 nonce 为已处理，便于重试或后续仲裁
      return { applied: false, reason: err.message }
    }

    // 标记 nonce 已处理（带 LRU 上限，防内存膨胀）
    this._processedCreditNonces.add(note.nonce)
    // P1-A5-13 修复：超过上限时移除最早的 nonce（FIFO 退化 LRU）
    if (this._processedCreditNonces.size > this._creditNonceLimit) {
      const first = this._processedCreditNonces.values().next().value
      this._processedCreditNonces.delete(first)
    }
    this._persistCreditNonces()  // M8.1：落盘 nonce 集合
    this.log('info', 'credit',
      `镜像 ${note.type} credit（issuer=${note.issuerDid.slice(0, 12)}..., holder=${note.holderDid.slice(0, 12)}..., amount=${note.amount}）`)

    // M9.3：派发到 App 的 onReceived handler（如目标 App 已加载且注册了 handler）
    if (this.appManager && typeof this.appManager.dispatchCreditMessage === 'function') {
      try {
        await this.appManager.dispatchCreditMessage({
          ...note,
          senderId: message.senderId,
          timestamp: message.timestamp,
          targetApp: payload.targetApp ?? note.targetApp ?? null,
        })
      } catch (err) {
        // App handler 失败不影响 ledger 镜像结果
        this.log('warn', 'credit',
          `App dispatchCreditMessage 失败: ${err.message}`)
      }
    }

    return { applied: true }
  }

  // ──────────────────────────────────────────
  // 内部：处理收到的市场 topic 消息（P0-3 修复）
  // ──────────────────────────────────────────

  /**
   * 处理 /s-network/market/<hex> topic 上的消息。
   *
   * P0-3 修复：市场 topic 走私域消息路径，不参与公共层签名校验。
   *   - payload 已被 AES-GCM 加密 + 认证（GCM 认证标签保证完整性）
   *   - 只有持有令牌的成员能派生密钥解密（密钥派生即认证）
   *   - 解密失败说明发送方不在市场内或消息被篡改，丢弃即可
   *
   * @param {string} topic 私有市场 topic（/s-network/market/<hex64>）
   * @param {string} text 原始消息文本
   * @param {object} from 发送方 PeerId
   * @returns {Promise<{ applied: boolean, reason?: string, senderId?: string }>}
   */
  async _handleMarketTopicMessage(topic, text, from) {
    let envelope
    try {
      envelope = JSON.parse(text)
    } catch {
      this.log('debug', 'market', `<${topic.slice(0, 24)}...> 非 JSON，忽略`)
      return { applied: false, reason: '非 JSON' }
    }
    // 基本结构校验（市场消息不需要签名，但需要基本字段）
    if (!envelope || typeof envelope !== 'object') {
      return { applied: false, reason: 'envelope 非对象' }
    }
    if (typeof envelope.senderId !== 'string' || envelope.senderId.length === 0) {
      return { applied: false, reason: 'envelope.senderId 无效' }
    }
    if (!envelope.payload || typeof envelope.payload !== 'object') {
      return { applied: false, reason: 'envelope.payload 无效' }
    }

    try {
      const result = handleMarketMessage({
        registry: this.marketRegistry,
        envelope,
        topic,
      })
      this.log('info', 'market',
        `<${topic.slice(0, 24)}...> ✓ from ${result.senderId.slice(0, 12)}... (payload keys=${Object.keys(result.payload || {}).join(',')})`)
      return { applied: true, senderId: result.senderId, payload: result.payload }
    } catch (err) {
      // 解密失败 / 市场未找到 等都视为非致命，仅记录
      this.log('debug', 'market', `<${topic.slice(0, 24)}...> 处理失败：${err.message}`)
      return { applied: false, reason: err.message }
    }
  }

  /**
   * M6: 处理收到的 arbitration 消息（镜像本地 dispute 视图）。
   *
   * M6 MVP 不做严格跨节点账本同步——每个节点维护自己的 dispute 视图。
   * 接收方按 message.payload.action 镜像本地状态：
   *   - filed：本地 fileDispute（如未存在）
   *   - panel-summoned：本地 summonPanel（如未召集）
   *   - vote-cast：本地 castVote（如仲裁员在本地 panel 中）
   *   - verdict：本地 resolveVerdict（如未裁决）
   *
   * 镜像失败（dispute 已存在 / 已裁决 / 仲裁员不在 panel）不算错误，静默忽略。
   *
   * @param {object} message 已验签的 arbitration 消息
   * @param {object} ctx
   * @returns {{ applied: boolean, reason?: string }}
   */
  _handleArbitrationMessage(message, ctx = {}) {
    const payload = message.payload
    if (!payload || !payload.disputeId) {
      return { applied: false, reason: 'payload 缺 disputeId' }
    }
    const disputeId = payload.disputeId
    const action = payload.action ?? 'filed'
    const senderId = message.senderId

    // P1 修复：senderId 镜像校验
    //   - 'filed' action：只有 claimant 自己才能发起 dispute（防伪造他人发起）
    //   - 'verdict' action：senderId 必须是已召集 panel 中的仲裁员（防任意节点裁决）
    if (action === 'filed' && payload.claimant && senderId !== payload.claimant) {
      this.log('warn', 'arbitration',
        `filed action: senderId(${senderId?.slice(0, 12)}...) ≠ claimant(${payload.claimant.slice(0, 12)}...)，拒绝`)
      return { applied: false, reason: 'filed senderId 与 claimant 不匹配（P1 修复）' }
    }

    // 已存在则不重复 fileDispute
    let dispute = this.arbitrationRegistry.getDispute(disputeId)

    // verdict action 的 senderId 校验在 dispute 取出后做（需要 dispute.panel）

    try {
      if (action === 'filed') {
        if (!dispute) {
          // 镜像发起 dispute（claimant / respondent / type / amount 取自 payload）
          this.arbitrationRegistry.fileDispute({
            disputeId,
            claimant: payload.claimant,
            respondent: payload.respondent,
            type: payload.type,
            evidence: payload.evidence,
            amount: payload.amount,
          })
        }
        return { applied: true }
      }

      if (action === 'panel-summoned') {
        // M6 MVP 不镜像 panel 成员（panel 是各节点本地视图，跨节点 panel 一致性靠消息收敛）
        // 仅确保 dispute 存在
        if (!dispute) {
          this.arbitrationRegistry.fileDispute({
            disputeId,
            claimant: payload.claimant,
            respondent: payload.respondent,
            type: payload.type,
            evidence: payload.evidence,
            amount: payload.amount,
          })
        }
        return { applied: true }
      }

      if (action === 'vote-cast') {
        // M6 MVP 不镜像投票（投票是各节点本地行为，跨节点投票汇总靠 verdict 消息收敛）
        if (!dispute) {
          this.arbitrationRegistry.fileDispute({
            disputeId,
            claimant: payload.claimant,
            respondent: payload.respondent,
            type: payload.type,
            evidence: payload.evidence,
            amount: payload.amount,
          })
        }
        // P0-1 修复（AUDIT-M10）：vote-cast 校验 senderId ∈ panel，与 verdict 路径对称
        //   原实现不校验——任意节点可伪造投票污染本地仲裁视图。
        //   fail-closed：panel 未镜像时拒绝投票镜像（强制等待 panel 消息收敛后再处理 vote）
        const disputeForVote = dispute ?? this.arbitrationRegistry.getDispute(disputeId)
        if (!disputeForVote?.panel || disputeForVote.panel.length === 0) {
          this.log('warn', 'arbitration',
            `vote-cast action: dispute ${disputeId} 本地未镜像 panel，拒绝镜像投票（fail-closed, P0-1 修复）`)
          return {
            applied: false,
            reason: '本地未镜像 panel，拒绝镜像投票（fail-closed，P0-1 修复）',
          }
        }
        if (!disputeForVote.panel.includes(senderId)) {
          this.log('warn', 'arbitration',
            `vote-cast action: senderId(${senderId?.slice(0, 12)}...) 不在 panel 中，拒绝镜像投票`)
          return { applied: false, reason: 'vote-cast senderId 不在仲裁团 panel 中（P0-1 修复）' }
        }
        return { applied: true }
      }

      if (action === 'verdict') {
        if (!dispute) {
          this.arbitrationRegistry.fileDispute({
            disputeId,
            claimant: payload.claimant,
            respondent: payload.respondent,
            type: payload.type,
            evidence: payload.evidence,
            amount: payload.amount,
          })
          dispute = this.arbitrationRegistry.getDispute(disputeId)
        }
        // P1-10 修复：verdict senderId 必须是已召集 panel 中的仲裁员（fail-closed）
        //   原实现 panel 为空时宽松接受——攻击者可在 panel 镜像未到达前伪造裁决，
        //   让 dispute.status = RESOLVED 提前固化。改为 fail-closed：
        //   - panel 未镜像（空）→ 拒绝裁决（强制等待 panel 消息收敛后再处理 verdict）
        //   - panel 已知但 senderId 不在 panel 中 → 拒绝裁决
        if (!dispute.panel || dispute.panel.length === 0) {
          this.log('warn', 'arbitration',
            `verdict action: dispute ${disputeId} 本地未镜像 panel，拒绝裁决（fail-closed, P1-10 修复）`)
          return {
            applied: false,
            reason: '本地未镜像 panel，拒绝裁决（fail-closed，P1-10 修复）',
          }
        }
        if (!dispute.panel.includes(senderId)) {
          this.log('warn', 'arbitration',
            `verdict action: senderId(${senderId?.slice(0, 12)}...) 不在 panel 中，拒绝镜像裁决`)
          return { applied: false, reason: 'verdict senderId 不在仲裁团 panel 中（P1-10 修复）' }
        }
        // 如本地未裁决且 payload.verdict 存在，标记本地裁决（但不执行 slash——slash 只由原始仲裁节点执行）
        if (dispute.status !== DISPUTE_STATUS.RESOLVED && payload.verdict) {
          dispute.verdict = payload.verdict
          dispute.verdictAt = Date.now()
          dispute.status = DISPUTE_STATUS.RESOLVED
          this.log('info', 'arbitration',
            `镜像裁决 ${disputeId}：${payload.verdict}（不执行 slash，由原始仲裁节点执行）`)
        }
        return { applied: true }
      }

      return { applied: false, reason: `未知 action: ${action}` }
    } catch (err) {
      // 镜像失败不算错误（如 dispute 已存在、已裁决等）
      return { applied: false, reason: err.message }
    }
  }

  // ──────────────────────────────────────────
  // M8.1：持久化 flush（stop() 前调用，或在崩溃前外部触发）
  // ──────────────────────────────────────────

  /**
   * 把所有持久化 registry 的内存状态同步写盘。
   * - 各 registry 的 flush() 是幂等的（内部判空 persistPath）
   * - 失败不抛错——只 log warn（业务状态已变更，不应因磁盘问题让 stop() 也失败）
   * - 额外持久化 _processedCreditNonces 集合（不归任何 registry 管）
   */
  _flushAllRegistries() {
    const log = this.log
    const flushOne = (name, fn) => {
      try {
        fn()
      } catch (err) {
        log('warn', 'persist', `flush ${name} 失败：${err.message}`)
      }
    }
    flushOne('reputation', () => this.reputationLedger?.flush?.())
    flushOne('credit', () => this.creditLedger?.flush?.())
    flushOne('vouch', () => this.vouchRegistry?.flush?.())
    flushOne('wiki', () => this.wiki?.flush?.())
    flushOne('treasury', () => this.treasury?.flush?.())
    flushOne('arbitration', () => this.arbitrationRegistry?.flush?.())
    flushOne('market', () => this.marketRegistry?.flush?.())
    flushOne('creditNonces', () => {
      saveJsonAtomic(
        this._persistPaths.creditNonces,
        { nonces: setToArray(this._processedCreditNonces) },
        { log },
      )
    })
  }

  /**
   * M8.1：持久化 _processedCreditNonces 到磁盘（同步原子写）。
   * 每次 nonce.add() 后调用——失败不抛错（只 log warn），
   * 因为业务状态（标记 nonce 已处理）已变更，不应因磁盘问题回滚。
   */
  _persistCreditNonces() {
    try {
      saveJsonAtomic(
        this._persistPaths.creditNonces,
        { nonces: setToArray(this._processedCreditNonces) },
        { log: this.log },
      )
    } catch (err) {
      this.log('warn', 'persist', `flush creditNonces 失败：${err.message}`)
    }
  }

  // ──────────────────────────────────────────
  // 停止
  // ──────────────────────────────────────────

  async stop() {
    const log = this.log
    log('info', 'node', '正在停止节点...')

    // M8.1：停止前 flush 所有持久化 registry 到磁盘
    // 顺序无关紧要（各 ledger 独立文件）；失败只 log warn，不影响 stop() 流程
    this._flushAllRegistries()

    // 清理定时器
    for (const t of this._timers) clearInterval(t)
    this._timers = []

    // P1-A5-10 修复：移除事件监听器（防重启重复注册）
    if (this.libp2p) {
      if (this._peerDiscoveryHandler) {
        this.libp2p.removeEventListener('peer:discovery', this._peerDiscoveryHandler)
        this._peerDiscoveryHandler = null
      }
      if (this._connectionOpenHandler) {
        this.libp2p.removeEventListener('connection:open', this._connectionOpenHandler)
        this._connectionOpenHandler = null
      }
      if (this._connectionCloseHandler) {
        this.libp2p.removeEventListener('connection:close', this._connectionCloseHandler)
        this._connectionCloseHandler = null
      }
      if (this._pubsubHandler && this.libp2p.services?.pubsub) {
        this.libp2p.services.pubsub.removeEventListener('message', this._pubsubHandler)
        this._pubsubHandler = null
      }
    }

    // 停止 helia（同时停止其管理的 libp2p mixin）
    if (this.ipfs) {
      await this.ipfs.stop()
    }

    log('info', 'node', '节点已停止。')
  }

  // ──────────────────────────────────────────
  // 内部：dial 发现的 peer
  // ──────────────────────────────────────────

  async _dialPeer(peerInfo) {
    // 跳过自己
    if (peerInfo.id.equals(this.peerId)) return

    // 已连接则跳过
    if (this.libp2p.getConnections(peerInfo.id).length > 0) return

    await this.libp2p.dial(peerInfo.id, {
      signal: AbortSignal.timeout(5_000),
    })
  }

  // ──────────────────────────────────────────
  // 内部：广播心跳（M3.1 用 makeMessage 统一格式）
  // ──────────────────────────────────────────

  async _broadcastHeartbeat() {
    if (!this.libp2p) return

    // M2.2 起心跳改用 context-A 子身份签名（P0-1 修复：签名覆盖整个 canonical message）：
    //   - senderId = context-A 子 DID（非主 PeerId）
    //   - signature = 用 context-A 私钥对 canonical(heartbeat) 的签名
    //   - signerPublicKey = context-A 公钥原始字节（接收方可直接验签，无需 DHT 查询）
    //
    // P2-A5-27 修复：心跳不再泄露完整 knownPeers 列表，只广播数量（防拓扑元数据泄露）
    const subA = this.wallet.get('A')

    const payload = {
      // P2-A5-27 修复：只广播邻居数量，不广播完整 PeerId 列表
      knownPeersCount: this.neighbors.size,
    }

    const heartbeat = await signMessage({
      type: MESSAGE_TYPES.HEARTBEAT,
      senderId: subA.did,             // context-A 子 DID（非主 PeerId）
      payload,
      identity: subA,
    })

    const bytes = new TextEncoder().encode(JSON.stringify(heartbeat))
    await this.libp2p.services.pubsub.publish(
      '/s-network/announce',
      bytes,
    )
    this.log('debug', 'heartbeat',
      `广播心跳（${this.neighbors.size} 邻居，签名 context-A=${subA.did.slice(0, 12)}...）`)
  }
}

// ──────────────────────────────────────────────
// 启动入口（M8.2-5：集成 CLI + WebPanel）
// ──────────────────────────────────────────────
//
// 启动顺序（重要）：
//   1. SNode.start()         → libp2p / helia / 各 registry 加载
//   2. WebPanel.start()      → HTTP server 绑定 127.0.0.1:webPort
//   3. Cli.start()           → REPL 阻塞（同步 readline.createInterface）
//
// 退出顺序（与启动相反）：
//   1. Cli.stop()             → 关 readline，进程不再因 stdin 阻塞
//   2. WebPanel.stop()        → 关 HTTP server
//   3. SNode.stop()           → 关 libp2p / helia，flush 持久化
//
// 可测试性：
//   把启动逻辑提取为 startApp(config, deps)，通过 deps 注入 fake
//   SNode/Cli/WebPanel/process，单元测试无需真实 libp2p / helia。

/**
 * 启动 Havix 应用层（SNode + WebPanel + Cli REPL）。
 *
 * @param {object} config 由 loadConfig() 返回的配置对象
 * @param {object} [deps] 依赖注入（测试用）
 * @param {class} [deps.SNode] SNode 类（默认指向本文件导出的 SNode）
 * @param {class} [deps.Cli] Cli 类（默认指向 ./app/cli.js 的 Cli）
 * @param {class} [deps.WebPanel] WebPanel 类（默认指向 ./app/web-panel.js 的 WebPanel）
 * @param {object} [deps.process] Node.js process 对象（默认指向全局 process）
 * @param {object} [deps.stdout] stdout 流（默认指向 process.stdout）
 * @returns {Promise<{node: object, cli: object|null, webPanel: object|null, stop: () => Promise<void>}>}
 */
export async function startApp(config, deps = {}) {
  const SNodeCtor = deps.SNode ?? SNode
  const CliCtor = deps.Cli ?? Cli
  const WebPanelCtor = deps.WebPanel ?? WebPanel
  const proc = deps.process ?? process
  const stdout = deps.stdout ?? process.stdout

  const println = (s = '') => stdout.write(s + '\n')

  println()
  println('  ╔════════════════════════════════════════╗')
  println('  ║  Havix — Haven of Affinity              ║')
  println('  ║  高认知个体自组织生境协议                ║')
  println('  ║  M4 · Credit 双轨经济                    ║')
  println('  ║  M5 · 单跳 Relay 隧道                     ║')
  println('  ║  M6 · 临时仲裁团 + Slash                  ║')
  println('  ║  M7 · 邀请市场 + 双重加密                 ║')
  println('  ║  M8 · CLI + Web 面板                      ║')
  println('  ╚════════════════════════════════════════╝')
  println()
  println(`  [config] name      = ${config.name}`)
  println(`  [config] port      = ${config.port}`)
  println(`  [config] dataDir   = ${config.dataDir}`)
  println(`  [config] mdns      = ${config.mdns}`)
  println(`  [config] bootstrap = [${config.bootstrap.join(', ')}]`)
  println(`  [config] dht       = ${config.dht} (${config.dhtMode})`)
  println(`  [config] logLevel  = ${config.logLevel}`)
  println(`  [config] repl      = ${config.repl}`)
  println(`  [config] web       = ${config.web} (${config.webHost}:${config.webPort})`)
  println()

  const node = new SNodeCtor(config)
  let cli = null
  let webPanel = null
  let stopped = false

  // ── 1. SNode 启动 ──
  try {
    await node.start()
  } catch (err) {
    println(`  [fatal] SNode 启动失败: ${err.message}`)
    // 测试模式：抛错让测试断言；运行模式：exit(1)
    if (deps.SNode) throw err
    proc.exit(1)
    return { node, cli, webPanel, stop: async () => {} }
  }

  // ── 2. WebPanel 启动（在 REPL 之前，保证 REPL 操作时面板已可用） ──
  if (config.web !== false) {
    webPanel = new WebPanelCtor(node, {
      host: config.webHost,
      port: config.webPort,
    })
    try {
      const { host, port } = await webPanel.start()
      println(`  [web-panel] 监听 http://${host}:${port}/  (拓扑可视化 + 状态 API)`)
    } catch (err) {
      println(`  [web-panel] 启动失败（不阻断节点）: ${err.message}`)
      webPanel = null
    }
  }

  // ── 2.5 AppManager 启动（M9.3 新增；在 Cli 之前，让 App CLI 命令可注入） ──
  let appManager = null
  if (config.apps !== false) {
    try {
      const { AppManager } = await import('./app/app-manager.js')
      const appsDir = path.resolve(process.cwd(), config.appsDir)
      appManager = new AppManager(node, null, { appsDir })
      // 先 Cli 注入（让 App CLI 命令能注入）——Cli 可能未启用，App 仍正常加载
      if (config.repl !== false) {
        // Cli 还没构造，先用临时占位让 AppManager 知道命令注入存在；
        // Cli 构造后再把真实实例塞回去并 register 已收集的命令
        // —— 这里采用：等 Cli 构造后再触发 appManager.setCli + injectCommands
      }
      const loadedApps = await appManager.start()
      // 让 SNode 引用 appManager（用于 _handleCreditMessage 派发到 App handler）
      node.appManager = appManager
      if (loadedApps.length > 0) {
        println(`  [app-manager] 加载 ${loadedApps.length} 个 App: ${loadedApps.map(a => a.manifestId).join(', ')}`)
      } else {
        println(`  [app-manager] apps 目录无 App 或目录不存在: ${appsDir}`)
      }
    } catch (err) {
      println(`  [app-manager] 启动失败（不阻断节点）: ${err.message}`)
      appManager = null
    }
  }

  // ── 3. Cli REPL 启动（最后；同步返回但 readline 会保持 event loop） ──
  if (config.repl !== false) {
    cli = new CliCtor(node, { input: proc.stdin, output: stdout })
    // M9.3：把 App CLI 命令注入到 Cli 实例
    if (appManager) {
      appManager.setCli(cli)
      // 对已加载的 App 重新触发一次命令注入
      for (const appName of appManager.listAppNames()) {
        const app = appManager.getApp(appName)
        appManager._injectCliCommands(appName, app)
      }
    }
    try {
      cli.start()
      println('  [cli] REPL 已启动，输入 help 查看命令（Ctrl+D 退出）')
      println()
    } catch (err) {
      println(`  [cli] REPL 启动失败: ${err.message}`)
      cli = null
    }
  } else {
    println('  [cli] REPL 已禁用（--no-repl）')
  }

  if (!config.web) {
    println('  [web-panel] 已禁用（--no-web）')
  }
  if (config.apps === false) {
    println('  [app-manager] 已禁用（--no-apps）')
  }

  // ── 优雅退出：按 CLI → AppManager → WebPanel → SNode 顺序 ──
  const stop = async (signal) => {
    if (stopped) return
    stopped = true
    if (signal) println(`\n  [shutdown] received ${signal}, stopping node...`)

    // 1. Cli（先关 readline，否则 stdin 会卡住 node.stop）
    try {
      if (cli) await cli.stop()
    } catch (err) {
      println(`  [shutdown] cli.stop 异常: ${err.message}`)
    }

    // 2. AppManager（M9.3 新增；在 WebPanel 之前 stop，让 App state.flush 抢在节点关闭前完成）
    try {
      if (appManager) await appManager.stop()
    } catch (err) {
      println(`  [shutdown] appManager.stop 异常: ${err.message}`)
    }

    // 3. WebPanel
    try {
      if (webPanel) await webPanel.stop()
    } catch (err) {
      println(`  [shutdown] webPanel.stop 异常: ${err.message}`)
    }

    // 4. SNode（最后；flush 持久化、关 libp2p / helia）
    try {
      await node.stop()
    } catch (err) {
      println(`  [shutdown] node.stop 异常: ${err.message}`)
    }
  }

  // 注册信号处理（仅真实 process；测试时注入的 fake 不会被注册）
  if (typeof proc.on === 'function' && proc !== process) {
    // 测试模式：手动注册以便断言
    proc.on('SIGINT', () => { stop('SIGINT').catch(() => {}) })
    proc.on('SIGTERM', () => { stop('SIGTERM').catch(() => {}) })
  } else {
    proc.on('SIGINT', () => { stop('SIGINT').catch(() => proc.exit(0)) })
    proc.on('SIGTERM', () => { stop('SIGTERM').catch(() => proc.exit(0)) })
  }

  return { node, cli, webPanel, appManager, stop }
}

/**
 * main 入口：加载 config + 调用 startApp
 */
async function main() {
  const config = loadConfig()
  await startApp(config)
}

// ──────────────────────────────────────────────
// 入口判断：仅当作为主模块直接运行时启动节点
// import 时不触发 main()，便于测试与库式调用
// ──────────────────────────────────────────────

const isMainModule = import.meta.url === `file://${process.argv[1]}`

if (isMainModule) {
  main().catch(err => {
    console.error('[uncaught]', err)
    process.exit(1)
  })
}
