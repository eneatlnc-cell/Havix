/**
 * Havix 维基协议（M3.1）
 * ───────────────────────────────────────────────
 * 设计目标（白皮书 §3.2 context-D + §11.2 M3）：
 *   维基是 Havix 的"公开智库文档"——任何人都能读取，写入需编辑员身份签名。
 *
 * 数据流：
 *   作者 → 把内容字节写入 IPFS（helia.blockstore）→ 得到 CID（公共 CID）
 *       → 用 context-D 子身份签名 {cid, title, timestamp}
 *       → 通过 gossipsub /s-network/announce 广播 wiki-announce 消息
 *       → 接收方验签通过 → 索引到本地 manifest
 *
 *   读取者 → 从本地 manifest 查到 CID → helia.blockstore.get(cid) 或 ipfs.cat(cid) 取内容
 *
 * 编辑员资格（M3.2 才实现）：
 *   - M3.1 不验资格，只验签名（验签通过就接收，作者自证其私钥持有）
 *   - M3.2 加 vouch 累积阈值门控：N 个高信誉节点 vouch 才能写入
 *
 * 版本控制（M3.3 才实现）：
 *   - M3.1 每个 publishEntry 都是一次独立发布（同 title 可重复发布）
 *   - M3.3 加历史链（每个新版本签名父版本 CID）
 *
 * 关键安全性质：
 *   1. 内容不可篡改：CID 是内容哈希，任何修改都会改变 CID
 *   2. 作者不可伪造：context-D 子身份签名，接收方零依赖验签
 *   3. 不可关联性：context-D 与其他 context 在密码学上独立，外部观察者
 *      无法从维基编辑员身份反推作者的市场/私聊/主 PeerId
 *   4. 公开可读：CID 是公共 CID，任何节点都可拉取内容（M3.1 通过 DHT 门控默认放行）
 */

import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { MESSAGE_TYPES, makeMessage, signMessage } from './message-types.js'
import { saveJsonAtomic, mapToArray } from '../persistence.js'

// 维基 announce 消息走 /s-network/announce（与心跳同 topic）
export const WIKI_TOPIC = '/s-network/announce'

// raw codec code（multiformats 中 0x55 表示 raw 即原始字节）
const RAW_CODEC = 0x55

// ──────────────────────────────────────────────
// 错误类：编辑员未达 vouch 阈值
// ──────────────────────────────────────────────

/**
 * publishEntry 时若编辑员的 vouch 累积未达阈值，抛此错误。
 *
 * 带 `current` / `threshold` / `need` 字段，便于上层提示用户"还需 N 个 vouch"。
 */
export class EditorNotQualifiedError extends Error {
  constructor({ editorDid, current, threshold, need }) {
    super(`编辑员 ${editorDid.slice(0, 16)}... vouch 不足：当前 ${current}/${threshold}，还需 ${need} 个`)
    this.name = 'EditorNotQualifiedError'
    this.code = 'EDITOR_NOT_QUALIFIED'
    this.editorDid = editorDid
    this.current = current
    this.threshold = threshold
    this.need = need
  }
}

/**
 * publishEntry 续写父版本时，若作者与父版本作者不一致，抛此错误。
 *
 * M3.3 MVP 范围：只允许原作者续写自己的条目；
 * 跨作者协作编辑 deferred 到未来版本（白皮书 §3.2 未来工作）。
 */
export class ParentCidMismatchError extends Error {
  constructor({ parentCid, expectedAuthor, actualAuthor }) {
    super(`父版本 ${parentCid.slice(0, 16)}... 作者为 ${expectedAuthor.slice(0, 16)}...，与续写者 ${actualAuthor.slice(0, 16)}... 不一致`)
    this.name = 'ParentCidMismatchError'
    this.code = 'PARENT_CID_AUTHOR_MISMATCH'
    this.parentCid = parentCid
    this.expectedAuthor = expectedAuthor
    this.actualAuthor = actualAuthor
  }
}

// ──────────────────────────────────────────────
// 工具：把内容字节写入 IPFS 并返回 CID
// ──────────────────────────────────────────────

/**
 * 计算内容字节的 CID（raw codec + sha256）并写入 helia blockstore。
 *
 * @param {object} helia 已启动的 helia 实例
 * @param {Uint8Array} bytes 内容字节
 * @returns {Promise<string>} CID 字符串
 */
export async function putContentBlock(helia, bytes) {
  // 1. 计算 sha256 多哈希
  const hash = await sha256.digest(bytes)
  // 2. 构造 CID（raw codec + sha256 hash，版本 v1）
  const cid = CID.createV1(RAW_CODEC, hash)
  // 3. 写入 helia blockstore
  await helia.blockstore.put(cid, bytes)
  return cid.toString()
}

/**
 * 从 helia blockstore 按 CID 取内容字节。
 *
 * helia.blockstore.get(cid) 返回 AsyncGenerator<Uint8Array>，
 * 本函数将所有 chunk 拼成单个 Uint8Array 返回。
 *
 * @param {object} helia
 * @param {string} cidStr CID 字符串
 * @returns {Promise<Uint8Array>}
 */
export async function getContentBlock(helia, cidStr) {
  const cid = CID.parse(cidStr)
  const chunks = []
  let total = 0
  for await (const chunk of helia.blockstore.get(cid)) {
    chunks.push(chunk)
    total += chunk.length
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

// ──────────────────────────────────────────────
// WikiProtocol 类
// ──────────────────────────────────────────────

/**
 * 维基协议模块。
 *
 * 持有 helia 引用、gossipsub 引用、context-D 子身份引用。
 * 对外提供：
 *   - publishEntry({title, content})  发布新条目
 *   - handleAnnounce(message)         处理收到的 wiki-announce 消息
 *   - listEntries()                   列出本地索引的条目
 *   - getEntry(cid)                   查询单条条目
 *   - fetchContent(cid)               从 IPFS 拉取内容
 *
 * 状态：
 *   - entries: Map<cidStr, EntryManifest>  本地索引
 *
 * @typedef {Object} EntryManifest
 * @property {string} cid            IPFS CID
 * @property {string} title         条目标题
 * @property {string} authorDid     作者 context-D 子 DID
 * @property {number} timestamp    消息时间戳
 * @property {string|null} parentCid  M3.3：父版本 CID，根条目为 null
 * @property {string} fromPeerId   转发节点的主 PeerId（可选，调试用）
 */
export class WikiProtocol {
  /**
   * @param {object} opts
   * @param {object} opts.helia       已启动的 helia 实例
   * @param {object} opts.pubsub     libp2p.services.pubsub
   * @param {import('../identity.js').Identity} opts.editorIdentity context-D 子身份
   * @param {object} [opts.vouchRegistry]  可选，M3.2 起的门控：未传入或 null 表示不门控
   * @param {object} [opts.log]      可选日志函数 (level, tag, msg, ...args)
   * @param {string} [opts.persistPath]  可选持久化文件路径（M8.1）
   */
  constructor({ helia, pubsub, editorIdentity, vouchRegistry, log, persistPath }) {
    this.helia = helia
    this.pubsub = pubsub
    this.editor = editorIdentity
    this.vouchRegistry = vouchRegistry ?? null
    this.log = log ?? (() => {})
    this.persistPath = persistPath ?? null

    // 本地索引：cid → manifest
    /** @type {Map<string, EntryManifest>} */
    this.entries = new Map()
    this._maxEntries = 100_000
  }

  /**
   * 序列化为 JSON 可保存的对象（仅索引元信息，CID 内容在 IPFS）。
   * @returns {{ version: string, entries: [string, EntryManifest][] }}
   */
  toJSON() {
    return {
      version: 'wiki-v1',
      entries: mapToArray(this.entries),
    }
  }

  /**
   * 从 loadJson 加载的对象恢复 entries 索引。
   * @param {object} json
   */
  loadState(json) {
    if (!json || typeof json !== 'object') return
    const arr = Array.isArray(json.entries) ? json.entries : []
    for (const [cid, manifest] of arr) {
      if (typeof cid === 'string' && manifest
        && typeof manifest.title === 'string'
        && typeof manifest.authorDid === 'string') {
        this.entries.set(cid, manifest)
      }
    }
  }

  /** 显式 flush 到磁盘（幂等）。 */
  flush() {
    if (!this.persistPath) return
    saveJsonAtomic(this.persistPath, this.toJSON(), { log: this.log })
  }

  /** 内部：mutation 后触发持久化。 */
  _persist() {
    if (!this.persistPath) return
    this.flush()
  }

  /**
   * 发布一条维基条目。
   *
   * 流程：
   *   1. 把 content 写入 IPFS（helia.blockstore.put）→ 得到 CID
   *   2. （M3.3）若指定 parentCid，校验作者与父版本一致
   *   3. 用 context-D 子身份签名 payload {cid, title, timestamp, parentCid}
   *   4. 组装 wiki-announce 消息（makeMessage）
   *   5. publish 到 /s-network/announce
   *   6. 本地也索引（自己作为作者，把自己当已知条目）
   *
   * M3.3 版本链规则：
   *   - parentCid 为 null/undefined → 根条目（v1）
   *   - parentCid 指向已有条目 → 续写版本
   *   - 续写时父版本作者必须与当前编辑员一致（防止劫持他人条目）
   *   - 同一标题可有多条根条目（不同作者各自开头）；版本链仅沿 parentCid 单链回溯
   *   - 分叉/合并 deferred 到未来版本
   *
   * @param {object} opts
   * @param {string} opts.title     条目标题
   * @param {string|Uint8Array} opts.content 条目内容（字符串将按 UTF-8 编码）
   * @param {string} [opts.parentCid] M3.3 父版本 CID，未传视为根条目
   * @returns {Promise<{ cid: string, message: object }>}
   */
  async publishEntry({ title, content, parentCid }) {
    if (typeof title !== 'string' || title.length === 0) {
      throw new Error('title 必须是非空字符串')
    }
    if (typeof content === 'string') {
      content = new TextEncoder().encode(content)
    } else if (!(content instanceof Uint8Array)) {
      throw new Error('content 必须是 string 或 Uint8Array')
    }
    // parentCid 归一化：未传 / 空字符串 / null 都视为根条目
    const parentCidNorm = (typeof parentCid === 'string' && parentCid.length > 0)
      ? parentCid
      : null

    // 0. M3.2 门控：检查编辑员 vouch 累积是否达到阈值
    //    M4 起：vouchRegistry 可能注入了 reputationLedger，会自动用加权 score 比较
    //    getQualification 统一返回 { score, threshold, qualified }，适配两种模式
    //    若 vouchRegistry 未配置（M3.1 兼容模式），跳过门控
    if (this.vouchRegistry) {
      const q = this.vouchRegistry.getQualification(this.editor.did)
      if (!q.qualified) {
        const need = q.threshold - q.score
        throw new EditorNotQualifiedError({
          editorDid: this.editor.did,
          current: q.score,
          threshold: q.threshold,
          need,
        })
      }
    }

    // 0b. M3.3 作者一致性校验：续写时父版本作者必须与当前编辑员一致
    //     防止 A 冒用 B 的条目续写（劫持他人维基条目）
    //     注：若父版本 CID 不在本地索引，跳过校验（lazy 验证：
    //         本节点可能尚未拉到父版本，记录 parentCid 即可，不阻塞发布）
    if (parentCidNorm) {
      const parent = this.entries.get(parentCidNorm)
      if (parent && parent.authorDid !== this.editor.did) {
        throw new ParentCidMismatchError({
          parentCid: parentCidNorm,
          expectedAuthor: parent.authorDid,
          actualAuthor: this.editor.did,
        })
      }
    }

    // 1. 写入 IPFS
    const cidStr = await putContentBlock(this.helia, content)

    // 2. 签名 payload（M3.3 起含 parentCid）
    const payload = {
      cid: cidStr,
      title,
      timestamp: Date.now(),
      parentCid: parentCidNorm,
    }
    // P1 修复：校验 entry.timestamp 为有限正数（防 NaN / Infinity）
    if (!Number.isFinite(payload.timestamp) || payload.timestamp <= 0) {
      throw new Error(`entry.timestamp 必须是有限正数，实际 ${payload.timestamp}`)
    }
    // P0-1 修复：签名覆盖整个 canonical message（含 senderId/type/timestamp/payload）
    const message = await signMessage({
      type: MESSAGE_TYPES.WIKI_ANNOUNCE,
      senderId: this.editor.did,
      payload,
      identity: this.editor,
    })

    // 4. 广播
    const bytes = new TextEncoder().encode(JSON.stringify(message))
    const result = await this.pubsub.publish(WIKI_TOPIC, bytes)
    const parentLabel = parentCidNorm ? ` parent=${parentCidNorm.slice(0, 12)}...` : ' (根)'
    this.log('info', 'wiki',
      `发布条目 "${title}" (cid=${cidStr.slice(0, 12)}...${parentLabel}, recipients=${result.recipients?.length ?? 0})`)

    // 5. 本地索引（作者自己也算已知条目）
    this._indexEntry({
      cid: cidStr,
      title,
      authorDid: this.editor.did,
      timestamp: payload.timestamp,
      parentCid: parentCidNorm,
      fromPeerId: null,
    })

    return { cid: cidStr, message }
  }

  /**
   * 处理收到的 wiki-announce 消息。
   *
   * 前置条件：调用方（SNode）已校验 version/type/senderId/timestamp/payload 结构
   *           并已通过 Ed25519 验签。
   *
   * 本函数只做：
   *   - 校验 payload.cid / payload.title / payload.timestamp 字段
   *   - 索引到本地 manifest
   *
   * @param {object} message 已验签的 wiki-announce 消息
   * @param {object} [ctx] 上下文（含 fromPeerId 等）
   * @returns {{ indexed: boolean, cid?: string, error?: string }}
   */
  handleAnnounce(message, ctx = {}) {
    const { payload } = message
    if (!payload || typeof payload !== 'object') {
      return { indexed: false, error: 'payload 缺失' }
    }
    if (typeof payload.cid !== 'string' || payload.cid.length === 0) {
      return { indexed: false, error: 'payload.cid 无效' }
    }
    if (typeof payload.title !== 'string' || payload.title.length === 0) {
      return { indexed: false, error: 'payload.title 无效' }
    }
    if (typeof payload.timestamp !== 'number' || payload.timestamp <= 0) {
      return { indexed: false, error: 'payload.timestamp 无效' }
    }
    // M3.3：parentCid 字段归一化（旧消息无此字段视为根条目）
    const parentCid = (typeof payload.parentCid === 'string' && payload.parentCid.length > 0)
      ? payload.parentCid
      : null

    // 幂等：已存在则不覆盖（保留首次索引）
    if (this.entries.has(payload.cid)) {
      return { indexed: false, cid: payload.cid, error: 'CID 已索引（重复广播）' }
    }

    this._indexEntry({
      cid: payload.cid,
      title: payload.title,
      authorDid: message.senderId,
      timestamp: payload.timestamp,
      parentCid,
      fromPeerId: ctx.fromPeerId ?? null,
    })

    const parentLabel = parentCid ? ` parent=${parentCid.slice(0, 12)}...` : ' (根)'
    this.log('info', 'wiki',
      `索引条目 "${payload.title}" by ${message.senderId.slice(0, 12)}... (cid=${payload.cid.slice(0, 12)}...${parentLabel})`)

    return { indexed: true, cid: payload.cid }
  }

  /**
   * 列出本地索引的所有条目元信息。
   * @returns {EntryManifest[]}
   */
  listEntries() {
    return Array.from(this.entries.values())
  }

  /**
   * 查询单条条目元信息。
   * @param {string} cidStr
   * @returns {EntryManifest | undefined}
   */
  getEntry(cidStr) {
    return this.entries.get(cidStr)
  }

  /**
   * M3.3：列出某标题的所有已知版本（按 timestamp 升序）。
   *
   * 同标题可能由不同作者各自开根条目，本接口返回所有匹配的版本
   * （不区分作者），由调用方自行过滤。
   *
   * @param {string} title
   * @returns {EntryManifest[]} 按 timestamp 升序
   */
  listHistory(title) {
    return Array.from(this.entries.values())
      .filter(e => e.title === title)
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  /**
   * M3.3：沿 parentCid 回溯版本链，从指定 CID 一直到根条目。
   *
   * 返回数组 [self, parent, grandparent, ..., root]，按时间倒序（最新在前）。
   *
   * 防环保护：若链长超过 1000（疑似环或脏数据），停止回溯并返回已收集部分。
   * 若 parentCid 指向的条目不在本地索引，停止回溯（lazy 验证）。
   *
   * @param {string} cidStr  起始 CID
   * @returns {EntryManifest[]} 从最新版本到根，按时间倒序
   */
  getLineage(cidStr) {
    const lineage = []
    let cur = this.entries.get(cidStr)
    const MAX_DEPTH = 1000  // 防环
    let depth = 0
    const seen = new Set()  // 防环：同一 CID 不重复访问

    while (cur && depth < MAX_DEPTH) {
      if (seen.has(cur.cid)) break  // 检测到环，停止
      seen.add(cur.cid)
      lineage.push(cur)
      if (!cur.parentCid) break  // 根条目，链结束
      cur = this.entries.get(cur.parentCid)
      depth++
    }

    return lineage
  }

  /**
   * M3.3：判断某 CID 是否为根条目（无父版本）。
   * @param {string} cidStr
   * @returns {boolean}
   */
  isRootEntry(cidStr) {
    const e = this.entries.get(cidStr)
    return !!e && !e.parentCid
  }

  /**
   * M3.3：找出当前某作者某标题的最新版本 CID。
   *
   * 在所有同 title 同 author 的条目中，返回 timestamp 最大者。
   * 用于"作者续写时自动找上一版本"的场景。
   *
   * @param {string} title
   * @param {string} authorDid
   * @returns {EntryManifest | undefined}
   */
  getLatestVersion(title, authorDid) {
    const candidates = Array.from(this.entries.values())
      .filter(e => e.title === title && e.authorDid === authorDid)
      .sort((a, b) => b.timestamp - a.timestamp)
    return candidates[0]
  }

  /**
   * 从 IPFS 拉取条目内容字节。
   *
   * 注：仅本地 blockstore 取；若 CID 不在本节点，需要走 bitswap/DHT，
   * 此处不实现网络拉取（M3.x 后续步骤再加）。
   *
   * @param {string} cidStr
   * @returns {Promise<Uint8Array>}
   */
  async fetchContent(cidStr) {
    return await getContentBlock(this.helia, cidStr)
  }

  // ──────────────────────────────────────────
  // 内部：索引条目
  // ──────────────────────────────────────────

  _indexEntry(manifest) {
    this.entries.set(manifest.cid, manifest)
    // P1 修复：维基条目索引加 LRU 上限
    if (this.entries.size > this._maxEntries) {
      const first = this.entries.keys().next().value
      this.entries.delete(first)
    }
    // M8.1：mutation 后持久化
    this._persist()
  }
}
