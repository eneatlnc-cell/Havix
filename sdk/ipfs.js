/**
 * Havix SDK ipfs API（M9.2）
 * ───────────────────────────────────────────────
 * IPFS 操作访问层。
 *
 * 2 个权限门控：
 *   ipfs:read  get()
 *   ipfs:write add()
 *
 * 设计原则：
 *   - 复用 SNode.ipfs.blockstore.put/get
 *   - CID 计算遵循 raw codec + sha256（与 src/protocol/wiki.js 一致）
 *   - add 返回 CID 字符串，get 返回 Uint8Array
 *
 * 注：M9.2 不实现 addEncrypted/getEncrypted（M9.3+ 加 AES-GCM 派生密钥）
 *   —— manifestId 派生密钥在 M9.3 AppManager 接入后才可用（需 manifest 实例已加载）。
 */

import { checkPermission } from './permissions.js'

// raw codec + sha256 hash，与 src/protocol/wiki.js 一致
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import * as rawCodec from 'multiformats/codecs/raw'

const RAW_CODEC = rawCodec.code  // 0x55, raw codec

/**
 * 创建 ipfs API 实例。
 *
 * @param {object} snode SNode 实例（需有 ipfs.blockstore）
 * @param {import('./manifest.js').AppManifest} manifest App Manifest
 * @returns {object} ipfs API
 */
export function createIpfsApi(snode, manifest) {
  if (!snode) throw new Error('createIpfsApi: snode 必填')
  if (!manifest) throw new Error('createIpfsApi: manifest 必填')
  if (!snode.ipfs?.blockstore) {
    throw new Error('createIpfsApi: snode.ipfs.blockstore 未初始化')
  }

  const perms = manifest.permissions
  const appName = manifest.name
  const blockstore = snode.ipfs.blockstore

  /**
   * 写入内容到 IPFS。
   * @param {Uint8Array} bytes
   * @returns {Promise<string>} CID 字符串
   */
  async function add(bytes) {
    checkPermission(perms, 'ipfs:write', { app: appName })
    if (!(bytes instanceof Uint8Array)) {
      throw new Error('ipfs.add: bytes 必须是 Uint8Array')
    }
    // 计算 CID（与 src/protocol/wiki.js putContentBlock 一致）
    const hash = await sha256.digest(bytes)
    const cid = CID.createV1(RAW_CODEC, hash)
    await blockstore.put(cid, bytes)
    return cid.toString()
  }

  /**
   * 按 CID 读取内容。
   * @param {string} cidStr CID 字符串
   * @returns {Promise<Uint8Array>}
   */
  async function get(cidStr) {
    checkPermission(perms, 'ipfs:read', { app: appName })
    if (typeof cidStr !== 'string' || cidStr.length === 0) {
      throw new Error('ipfs.get: cidStr 必须是非空字符串')
    }
    const cid = CID.parse(cidStr)
    let chunks = []
    for await (const chunk of blockstore.get(cid)) {
      chunks.push(chunk)
    }
    if (chunks.length === 0) return new Uint8Array(0)
    if (chunks.length === 1) return chunks[0]
    // 拼接多个 chunk
    const total = chunks.reduce((s, c) => s + c.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      out.set(c, offset)
      offset += c.length
    }
    return out
  }

  /**
   * 计算 CID（不写入 blockstore，仅算 hash）。
   * @param {Uint8Array} bytes
   * @returns {Promise<string>} CID 字符串
   */
  async function computeCid(bytes) {
    if (!(bytes instanceof Uint8Array)) {
      throw new Error('ipfs.computeCid: bytes 必须是 Uint8Array')
    }
    const hash = await sha256.digest(bytes)
    return CID.createV1(RAW_CODEC, hash).toString()
  }

  return {
    add,
    get,
    computeCid,
    // 占位：M9.3+ 实现（依赖 manifestId 派生密钥）
    // addEncrypted / getEncrypted deferred
  }
}
