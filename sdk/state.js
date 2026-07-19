/**
 * Havix SDK state API（M9.2）
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
 * 用法：
 *   await app.state.set('orders', orderList)
 *   const orders = await app.state.get('orders', [])
 *   await app.state.delete('orders')
 *   await app.state.clear()
 */

import path from 'node:path'

/**
 * 创建 state API 实例。
 *
 * @param {object} snode SNode 实例（M9.2 不使用 snode，M9.3 用）
 * @param {import('./manifest.js').AppManifest} manifest App Manifest
 * @param {string} [dataDirOverride] 可选，覆盖默认 dataDir
 * @returns {object} state API
 */
export function createStateApi(snode, manifest, dataDirOverride = null) {
  if (!manifest) throw new Error('createStateApi: manifest 必填')

  const dataDirName = dataDirOverride ?? manifest.dataDir ?? manifest.name
  // 持久化路径（M9.3 接入真实 SNode 时用）
  const persistDir = path.join(
    snode?.config?.dataDir ?? '.data',
    'ledgers',
    'apps',
    dataDirName,
  )
  const persistPath = path.join(persistDir, 'state.json')

  // 内存状态（M9.2 mock 实现）
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
    // M9.2 mock 不写盘；M9.3 真实 SNode 集成时调 _persist()
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
    return store.delete(key)
  }

  /**
   * 清空所有状态。
   * @returns {Promise<void>}
   */
  async function clear() {
    store.clear()
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
   * 持久化到磁盘（M9.3+ 实现，M9.2 mock 是 no-op）。
   * @returns {Promise<void>}
   */
  async function flush() {
    // M9.3 实现：用 src/persistence.js saveJsonAtomic 写到 persistPath
    // M9.2 mock 不实现，仅占位
    return
  }

  /**
   * 从磁盘加载（M9.3+ 实现，M9.2 mock 是 no-op）。
   * @returns {Promise<void>}
   */
  async function load() {
    // M9.3 实现：用 src/persistence.js loadJson 从 persistPath 读
    // M9.2 mock 不实现
    return
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
