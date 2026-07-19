/**
 * Havix 通用持久化工具（M8.1）
 * ───────────────────────────────────────────────
 * 设计目标：为所有内存型 registry（Reputation/Credit/Vouch/Wiki/Arbitration/Treasury/Market）
 * 提供统一的 JSON 文件持久化：
 *   - 同步原子写（write .tmp + rename）防"写到一半崩溃"
 *   - 加载时缺失文件返回默认值（首次启动等价于空状态）
 *   - 不抛错——持久化失败只 log warn（账本 mutation 已成功，不应因磁盘问题回滚业务状态）
 *
 * 写盘策略：同步 fs 操作（不用 fs.promises）。理由：
 *   1. 账本 mutation 频率低（每次 vouch/credit/dispute 一次），同步写性能足够
 *   2. 同步写更简单——mutation 返回时磁盘已落盘，无需等待 flush
 *   3. 与 P2-1 start() 回滚兼容：start 失败时不会留下半写入状态
 *
 * 不实现：
 *   - 加密（M8.1 MVP 明文，未来 M9+ 加 AES-GCM 加密）
 *   - 压缩（数据量小，不必要）
 *   - 多版本快照（M8.1 只保留最新）
 *   - 跨节点账本同步（靠 gossipsub 消息收敛，M8.1 不变）
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * 递归创建目录（同步，已存在则跳过）。
 *
 * 安全：M8 审计修复加 `mode: 0o700`——仅所有者可读写执行，
 * 防止本机其他用户读取 `.data/ledgers/` 下的明文账本。
 * 注意：mode 在已存在目录上不生效，仅对 mkdirSync 新建的目录生效。
 *
 * @param {string} dir
 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/**
 * 加载 JSON 文件。
 *
 * 文件不存在 / 解析失败时返回 `defaultValue`，不抛错。
 * 这样首次启动等价于空状态，且磁盘损坏不会让节点无法启动。
 *
 * @param {string} filePath
 * @param {*} defaultValue 文件不存在或解析失败时返回的默认值
 * @param {object} [opts]
 * @param {function} [opts.log] 可选日志函数 (level, tag, msg)
 * @returns {*}
 */
export function loadJson(filePath, defaultValue, opts = {}) {
  const log = opts.log ?? (() => {})
  try {
    if (!fs.existsSync(filePath)) {
      return defaultValue
    }
    const text = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(text)
  } catch (err) {
    log('warn', 'persistence',
      `加载 ${filePath} 失败，使用默认值：${err.message}`)
    return defaultValue
  }
}

/**
 * 原子写 JSON 文件。
 *
 * 流程：
 *   1. 写到 `<filePath>.tmp`
 *   2. fs.renameSync(tmp, filePath) 原子替换
 *
 * 这样即使写到一半进程崩溃，原文件仍完整。
 *
 * 失败处理：只 log warn，不抛错——理由见模块头注释。
 *
 * @param {string} filePath
 * @param {*} data 任意可 JSON 序列化的值
 * @param {object} [opts]
 * @param {function} [opts.log] 可选日志函数
 */
export function saveJsonAtomic(filePath, data, opts = {}) {
  const log = opts.log ?? (() => {})
  const tmp = `${filePath}.tmp`
  try {
    ensureDir(path.dirname(filePath))
    const text = JSON.stringify(data, null, 2)
    // 安全：M8 审计修复加 `mode: 0o600`——仅所有者可读写，
    // 防止本机其他用户读取明文账本（含市场 AES 密钥、信誉余额等敏感字段）。
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, filePath)
  } catch (err) {
    log('warn', 'persistence',
      `写盘 ${filePath} 失败（数据仍在内存，下次重启会丢失本次变更）：${err.message}`)
    // 尝试清理 tmp
    try { fs.unlinkSync(tmp) } catch { /* 忽略 */ }
  }
}

// ──────────────────────────────────────────────
// Map / Set 与 JSON 互转的辅助工具
// ──────────────────────────────────────────────

/**
 * Map → JSON 二维数组。
 *
 * 用于序列化 `Map<K, V>` 到 `[[k, v], ...]`（JSON.stringify(Map) 会丢键）。
 * 值的序列化由调用方在传入前完成（如 Set → Array）。
 *
 * @template K, V
 * @param {Map<K, V>} map
 * @returns {[K, V][]}
 */
export function mapToArray(map) {
  return Array.from(map.entries())
}

/**
 * JSON 二维数组 → Map。
 *
 * @template K, V
 * @param {[K, V][]|null|undefined} arr
 * @param {function} [valueDecoder] 可选，对每个值做反序列化（如 Array → Set）
 * @returns {Map<K, V>}
 */
export function arrayToMap(arr, valueDecoder) {
  const m = new Map()
  if (!Array.isArray(arr)) return m
  for (const [k, v] of arr) {
    m.set(k, valueDecoder ? valueDecoder(v) : v)
  }
  return m
}

/**
 * Set → Array。
 * @template T
 * @param {Set<T>} set
 * @returns {T[]}
 */
export function setToArray(set) {
  return Array.from(set)
}

/**
 * Array → Set。
 * @template T
 * @param {T[]|null|undefined} arr
 * @returns {Set<T>}
 */
export function arrayToSet(arr) {
  return new Set(Array.isArray(arr) ? arr : [])
}

/**
 * Uint8Array → base64 字符串（用于序列化密钥等二进制字段）。
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

/**
 * base64 字符串 → Uint8Array。
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function base64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}
