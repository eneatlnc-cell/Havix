// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Havix 身份层：4-Context DID 派生（M2 步骤 2.1）
 * ───────────────────────────────────────────────
 * 设计目标（白皮书第 4 章）：
 *   主 DID = libp2p 节点的 Ed25519 私钥
 *   4 个 context 子身份 = HKDF 派生 + 独立 Ed25519 keypair
 *
 * 四个 context：
 *   A = 公开畅游（公共层消息签名、维基读取）
 *   B = 市场参与（私域市场内交易、offer 签发）
 *   C = 私聊隧道（点对点加密通信身份）
 *   D = 维基编辑（写入维基条目的编辑员身份）
 *
 * 关键安全性质：
 *   1. 不可关联性：4 个子身份在密码学上相互独立，外部观察者无法把
 *      "维基编辑员 D" 与 "市场参与者 B" 关联到同一自然人
 *   2. 不可逆推：即使某子身份私钥泄露，也无法反推主私钥
 *      （HKDF 单向 + Ed25519 种子独立）
 *   3. 独立签名：每个子身份用各自的 keypair 签名，验签时只能用对应公钥
 *
 * 实现要点：
 *   - 主私钥位于 `libp2p.components.privateKey`（不是 libp2p.peerId.privateKey，
 *     新版 @libp2p/peer-id 的 PeerId 不再持有私钥）
 *   - 主私钥 .raw 是 64 字节 = 32(种子) + 32(公钥)，取前 32 字节作 HKDF 输入
 *   - HKDF 用 @noble/hashes（libp2p 内部也用此库，保持一致）
 *   - 子种子生成 keypair 用 @libp2p/crypto/keys 的 generateKeyPairFromSeed
 *   - 从 keypair 构造 PeerId 用 peerIdFromPrivateKey
 */

import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'

// ──────────────────────────────────────────────
// Context 定义
// ──────────────────────────────────────────────

/**
 * 4 个 context 的标签。
 *
 * 这些字符串作为 HKDF 的 info 参数，确保派生出的子种子在密码学上独立。
 * 修改这些字符串 = 让所有派生身份失效（相当于"换发 DID"）。
 */
export const CONTEXTS = Object.freeze({
  A: 'havix-context-A-public',     // 公开畅游
  B: 'havix-context-B-market',     // 市场参与
  C: 'havix-context-C-tunnel',     // 私聊隧道
  D: 'havix-context-D-wiki',       // 维基编辑
})

/**
 * Context 元信息（用于 UI 显示与文档说明，不参与密码学）。
 */
export const CONTEXT_META = Object.freeze({
  A: { name: 'public',  label: '公开畅游', description: '公共层消息签名、维基读取' },
  B: { name: 'market',  label: '市场参与', description: '私域市场内交易、offer 签发' },
  C: { name: 'tunnel',  label: '私聊隧道', description: '点对点加密通信身份' },
  D: { name: 'wiki',    label: '维基编辑', description: '写入维基条目的编辑员身份' },
})

// ──────────────────────────────────────────────
// Identity 类
// ──────────────────────────────────────────────

/**
 * 单个 context 的子身份。
 *
 * 一个 Identity 实例包含：
 *   - contextKey：'A' | 'B' | 'C' | 'D'
 *   - peerId：子身份的 PeerId（可与主 PeerId 区分）
 *   - privateKey：Ed25519PrivateKey 对象，可调 .sign(data) / .raw / .publicKey
 *   - publicKey：Ed25519PublicKey 对象，可调 .verify(data, sig) / .raw
 */
export class Identity {
  /**
   * @param {object} opts
   * @param {'A'|'B'|'C'|'D'} opts.contextKey
   * @param {import('@libp2p/interface').PeerId} opts.peerId
   * @param {import('@libp2p/crypto/keys').Ed25519PrivateKey} opts.privateKey
   * @param {import('@libp2p/crypto/keys').Ed25519PublicKey} opts.publicKey
   */
  constructor({ contextKey, peerId, privateKey, publicKey }) {
    this.contextKey = contextKey
    this.peerId = peerId
    this.privateKey = privateKey
    this.publicKey = publicKey
  }

  /**
   * 子身份 PeerId 的字符串形式（12D3KooW...）。
   */
  get did() {
    return this.peerId.toString()
  }

  /**
   * 用此子身份签名一段数据。
   * @param {Uint8Array} data
   * @returns {Promise<Uint8Array>} 64 字节 Ed25519 签名
   */
  async sign(data) {
    return this.privateKey.sign(data)
  }

  /**
   * 用此子身份的公钥验签。
   * @param {Uint8Array} data
   * @param {Uint8Array} signature
   * @returns {Promise<boolean>}
   */
  async verify(data, signature) {
    return this.publicKey.verify(data, signature)
  }
}

// ──────────────────────────────────────────────
// IdentityWallet 类：管理主身份 + 4 个子身份
// ──────────────────────────────────────────────

/**
 * 身份钱包：从主 libp2p 节点派生 4 个 context 子身份。
 *
 * 用法：
 *   const wallet = await IdentityWallet.fromLibp2p(libp2p)
 *   const subA = wallet.get('A')          // 公开畅游子身份
 *   const sig = await subA.sign(data)    // 用 A 子身份签名
 *   const ok = await subA.verify(data, sig)  // 验签
 */
export class IdentityWallet {
  /**
   * @param {object} opts
   * @param {import('@libp2p/crypto/keys').Ed25519PrivateKey} opts.masterPrivateKey 主私钥
   * @param {import('@libp2p/interface').PeerId} opts.masterPeerId 主 PeerId
   * @param {Identity[]} opts.identities 4 个子身份
   */
  constructor({ masterPrivateKey, masterPeerId, identities }) {
    this.masterPrivateKey = masterPrivateKey
    this.masterPeerId = masterPeerId
    this.identities = identities
  }

  /**
   * 从 libp2p 实例派生完整身份钱包。
   *
   * @param {object} libp2p 已启动的 libp2p 实例
   * @returns {Promise<IdentityWallet>}
   */
  static async fromLibp2p(libp2p) {
    // 主私钥在 libp2p.components.privateKey
    // （不是 libp2p.peerId.privateKey，新版 @libp2p/peer-id 不持有私钥）
    const masterPriv = libp2p.components.privateKey
    if (!masterPriv) {
      throw new Error('无法从 libp2p.components 获取主私钥（libp2p 是否已启动？）')
    }
    if (masterPriv.type !== 'Ed25519') {
      throw new Error(`仅支持 Ed25519 主密钥，当前为 ${masterPriv.type}`)
    }

    const masterSeed = masterPriv.raw.subarray(0, 32)
    if (masterSeed.length !== 32) {
      throw new Error(`主种子长度异常：${masterSeed.length}（应为 32）`)
    }

    const identities = await deriveIdentitiesFromSeed(masterSeed)

    return new IdentityWallet({
      masterPrivateKey: masterPriv,
      masterPeerId: libp2p.peerId,
      identities,
    })
  }

  /**
   * 从 32 字节种子派生 4 个子身份（用于测试，不依赖 libp2p 实例）。
   *
   * @param {Uint8Array} masterSeed 32 字节主种子
   * @returns {Promise<Identity[]>}
   */
  static async fromSeed(masterSeed) {
    if (masterSeed.length !== 32) {
      throw new Error(`主种子长度异常：${masterSeed.length}（应为 32）`)
    }
    const identities = await deriveIdentitiesFromSeed(masterSeed)

    // 主身份用一个完整 keypair（需要从种子生成，因为 fromSeed 没有 libp2p 实例）
    const masterPriv = await generateKeyPairFromSeed('Ed25519', masterSeed)
    return new IdentityWallet({
      masterPrivateKey: masterPriv,
      masterPeerId: peerIdFromPrivateKey(masterPriv),
      identities,
    })
  }

  /**
   * 获取指定 context 的子身份。
   * @param {'A'|'B'|'C'|'D'} contextKey
   * @returns {Identity}
   */
  get(contextKey) {
    const id = this.identities.find(i => i.contextKey === contextKey)
    if (!id) {
      throw new Error(`未找到 context ${contextKey} 的子身份`)
    }
    return id
  }

  /**
   * 列出所有子身份的元信息（用于 CLI 显示与调试，不暴露私钥）。
   */
  list() {
    return this.identities.map(id => ({
      context: id.contextKey,
      ...CONTEXT_META[id.contextKey],
      did: id.did,
    }))
  }
}

// ──────────────────────────────────────────────
// 核心派生函数
// ──────────────────────────────────────────────

/**
 * 从主种子派生 4 个 context 子身份。
 *
 * 派生流程：
 *   1. 对每个 context label 应用 HKDF-SHA256，输出 32 字节子种子
 *   2. 用子种子生成 Ed25519 keypair（@libp2p/crypto/keys）
 *   3. 从 keypair 构造 PeerId（peerIdFromPrivateKey）
 *
 * @param {Uint8Array} masterSeed 32 字节主种子
 * @returns {Promise<Identity[]>}
 */
async function deriveIdentitiesFromSeed(masterSeed) {
  const encoder = new TextEncoder()
  const identities = []

  for (const contextKey of ['A', 'B', 'C', 'D']) {
    const label = CONTEXTS[contextKey]

    // 1. HKDF 派生 32 字节子种子
    //    IKM = 主种子, salt = 空, info = context label
    const subSeed = hkdf(
      sha256,
      masterSeed,                // IKM
      undefined,                 // salt（留空）
      encoder.encode(label),      // info
      32,                        // 输出长度 = Ed25519 种子长度
    )

    // 2. 从子种子生成 Ed25519 keypair
    const subPriv = await generateKeyPairFromSeed('Ed25519', subSeed)

    // 3. 从 keypair 构造 PeerId
    const subPeerId = peerIdFromPrivateKey(subPriv)

    identities.push(new Identity({
      contextKey,
      peerId: subPeerId,
      privateKey: subPriv,
      publicKey: subPriv.publicKey,
    }))
  }

  return identities
}
