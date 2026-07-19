/**
 * Havix SDK state API（M9.2 + M9.3）
 * ───────────────────────────────────────────────
 * App 私有状态持久化层（与节点 ledger 隔离）。
 *
 * 设计原则：
 *   - 每个 App 独立 state.json，路径 <dataDir>/ledgers/apps/<manifestId>/state.json
 *   - 数据格式：JSON 对象（顶层 key:value）
 *   - 写入用原子写（.tmp + renameSync，复用 src/persistence.js 模式）
 *   - 不持久化私钥 / 加密密钥（敏感数据 deferred 到 M9.3+）
 *
 * M9.2 范围：
 *   - 提供 set/get/delete/clear 接口
 *   - 用内存 Map 存（M9.2 mock SNode 用）
 *   - 真实 SNode 集成时（M9.3）改用 src/persistence.js 工具写盘
 *   - 接口签名保持不变，App 代码无需修改
 *
 * M9.3 升级：
 *   - flush() 写盘到 persistPath（saveJsonAtomic）
 *   - load() 从 persistPath 读入内存（loadJson）
 *   - 注入 persist 模块（默认懒加载 src/persistence.js；测试可注入 fake）
 *   - 提供 readonly 模式（persist=null 时退化为 M9.2 内存版）
 *
 * 用法：
 *   await app.state.set('orders', orderList)
 *   const orders = await app.state.get('orders', [])
 *   await app.state.delete('orders')
 *   await app.state.clear()
 *   await app.state.flush()  // M9.3 写盘
 *   await app.state.load()   // M9.3 加载
 */

import path from 'node:path'
import { validateDataDir } from './manifest.js'

/**
 * 创建 state API 实例。
 *
 * @param {object} snode SNode 实例（M9.3 用 snode.config.dataDir 计算 persistPath）
 * @param {import('./manifest.js').AppManifest} manifest App Manifest
 * @param {string|object} [dataDirOrOpts] 可选：
 *   - 字符串：覆盖默认 dataDir（M9.2 兼容形式）
 *   - 对象：{ dataDir?, persist?, log? }（M9.3 扩展形式）
 *   - persist 可为 null（强制 readonly 内存版）/ 对象（注入 fake）/ undefined（懒加载真实模块）
 * @returns {object} state API
 */
export function createStateApi(snode, manifest, dataDirOrOpts = null) {
  if (!manifest) throw new Error('createStateApi: manifest 必填')

  // 兼容 M9.2 调用形式：第三参数既可以是字符串（dataDir 覆盖）也可以是 opts 对象
  const opts = typeof dataDirOrOpts === 'string'
    ? { dataDir: dataDirOrOpts }
    : (dataDirOrOpts ?? {})

  // P0-1 修复：opts.dataDir 必须经过与 manifest.dataDir 等价的路径校验
  //   manifest.dataDir 在 AppManifest 构造时已校验；opts.dataDir 来自 createApp 调用方，
  //   未校验可被传入 '../../../etc/cron.d' 等路径穿越字符串，导致 flush() 任意文件写入。
  //   这里复用 validateDataDir（manifest.js 导出），拒绝绝对路径 / .. / 反斜杠等。
  const dataDirName = opts.dataDir !== undefined
    ? validateDataDir(opts.dataDir, manifest.name)
    : (manifest.dataDir ?? manifest.name)
  // 持久化路径（M9.3 接入真实 SNode 时用）
  const persistDir = path.join(
    snode?.config?.dataDir ?? '.data',
    'ledgers',
    'apps',
    dataDirName,
  )
  const persistPath = path.join(persistDir, 'state.json')

  // 持久化模块：
  //   - opts.persist === null  → 内存版（M9.2 mock / 单元测试用）
  //   - opts.persist === object → 注入的 fake（测试用）
  //   - opts.persist === undefined → 懒加载 src/persistence.js（M9.3 真实）
  let _persistMod = opts.persist  // 缓存已加载的模块
  async function getPersist() {
    if (_persistMod === null) return null  // 强制内存版
    if (_persistMod) return _persistMod
    // 懒加载真实模块（动态 import 避免 sdk 在 unit test 环境强依赖 src/）
    try {
      _persistMod = await import('../src/persistence.js')
      return _persistMod
    } catch (err) {
      // sdk 被独立打包或 src/ 不在路径上时降级为内存版
      _persistMod = null
      return null
    }
  }

  const log = opts.log ?? snode?.log ?? (() => {})

  // 内存状态（M9.2 mock 实现 / M9.3 真实模式的缓存层）
  const store = new Map()

  /**
   * 写入一个 key 的值。
   * @param {string} key 顶层 key（非空字符串）
   * @param {any} value 可 JSON 序列化的值
   * @returns {Promise<void>}
   */
  async function set(key, value) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('state.set: key 必须是非空字符串')
    }
    // 预校验可序列化（早失败，避免写到一半发现不可序列化）
    try {
      JSON.stringify(value)
    } catch (err) {
      throw new Error(`state.set: value 不可 JSON 序列化: ${err.message}`)
    }
    store.set(key, value)
    // M9.3：每次 set 自动 flush，保证磁盘与内存一致
    // （App 也可手动调 flush() 批量提交）
    if (opts.autoFlush !== false) {
      await flush()
    }
  }

  /**
   * 读取一个 key 的值。
   * @param {string} key
   * @param {any} [defaultValue] 不存在时返回
   * @returns {Promise<any>}
   */
  async function get(key, defaultValue = undefined) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('state.get: key 必须是非空字符串')
    }
    return store.has(key) ? store.get(key) : defaultValue
  }

  /**
   * 删除一个 key。
   * @param {string} key
   * @returns {Promise<boolean>} 是否删除成功（不存在返回 false）
   */
  async function deleteKey(key) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('state.delete: key 必须是非空字符串')
    }
    const existed = store.delete(key)
    if (existed && opts.autoFlush !== false) {
      await flush()
    }
    return existed
  }

  /**
   * 清空所有状态。
   * @returns {Promise<void>}
   */
  async function clear() {
    store.clear()
    if (opts.autoFlush !== false) {
      await flush()
    }
  }

  /**
   * 列出所有 key（用于调试 / 备份）。
   * @returns {string[]}
   */
  function keys() {
    return Array.from(store.keys())
  }

  /**
   * 列出所有 [key, value] 对。
   * @returns {Array<[string, any]>}
   */
  function entries() {
    return Array.from(store.entries())
  }

  /**
   * 持久化到磁盘（M9.3 实现）。
   * - 内存版（persist=null）是 no-op
   * - 真实模式调 saveJsonAtomic 原子写
   * @returns {Promise<void>}
   */
  async function flush() {
    const persist = await getPersist()
    if (!persist) return  // 内存版 no-op
    const data = Object.fromEntries(store.entries())
    persist.saveJsonAtomic(persistPath, data, { log })
  }

  /**
   * 从磁盘加载（M9.3 实现）。
   * - 内存版（persist=null）是 no-op
   * - 真实模式调 loadJson 读盘
   * @returns {Promise<void>}
   */
  async function load() {
    const persist = await getPersist()
    if (!persist) return  // 内存版 no-op
    const data = persist.loadJson(persistPath, {}, { log })
    store.clear()
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) {
        store.set(k, v)
      }
    }
  }

  return {
    set,
    get,
    delete: deleteKey,
    clear,
    keys,
    entries,
    flush,
    load,
    // 暴露路径供 M9.3 集成测试断言
    persistPath,
    persistDir,
  }
}
