// SPDX-License-Identifier: Apache-2.0

/**
 * Havix SDK wiki API（M9.2）
 * ───────────────────────────────────────────────
 * 维基条目访问层，包装 SNode.wiki（M3 协议）。
 *
 * 3 个权限门控：
 *   wiki:publish  publish()
 *   wiki:list     list() / history() / lineage() / latest()
 *   wiki:get      get() / isRoot()
 *
 * 设计原则：
 *   - publishEntry 需 vouch 阈值（实际由 SNode.wiki.vouchRegistry 在 publishEntry 内部校验）
 *   - content 类型可以是 string 或 Uint8Array（与 src/protocol/wiki.js 一致）
 *   - parentCid null/空字符串视为根条目
 */

import { checkPermission } from './permissions.js'

/**
 * 创建 wiki API 实例。
 *
 * @param {object} snode SNode 实例
 * @param {import('./manifest.js').AppManifest} manifest App Manifest
 * @returns {object} wiki API
 */
export function createWikiApi(snode, manifest) {
  if (!snode) throw new Error('createWikiApi: snode 必填')
  if (!manifest) throw new Error('createWikiApi: manifest 必填')
  if (!snode.wiki) throw new Error('createWikiApi: snode.wiki 未初始化')

  const perms = manifest.permissions
  const appName = manifest.name

  /**
   * 发布条目（需 vouch 阈值）。
   * @param {object} opts
   * @param {string} opts.title 条目标题（非空字符串）
   * @param {string|Uint8Array} opts.content 条目内容
   * @param {string} [opts.parentCid] 父版本 CID，未传视为根条目
   * @returns {Promise<{ cid: string, message: object }>}
   */
  async function publish({ title, content, parentCid = null } = {}) {
    checkPermission(perms, 'wiki:publish', { app: appName })
    if (typeof title !== 'string' || title.length === 0) {
      throw new Error('wiki.publish: title 必须是非空字符串')
    }
    if (typeof content !== 'string' && !(content instanceof Uint8Array)) {
      throw new Error('wiki.publish: content 必须是 string 或 Uint8Array')
    }
    return snode.wiki.publishEntry({ title, content, parentCid })
  }

  /**
   * 列出条目。
   * @returns {Array<object>}
   */
  function list() {
    checkPermission(perms, 'wiki:list', { app: appName })
    return snode.wiki.listEntries()
  }

  /**
   * 获取单条。
   * @param {string} cid
   * @returns {object|null}
   */
  function get(cid) {
    checkPermission(perms, 'wiki:get', { app: appName })
    if (typeof cid !== 'string' || cid.length === 0) {
      throw new Error('wiki.get: cid 必须是非空字符串')
    }
    return snode.wiki.getEntry(cid)
  }

  /**
   * 列出某标题的版本历史。
   * @param {string} title
   * @returns {Array<object>}
   */
  function history(title) {
    checkPermission(perms, 'wiki:list', { app: appName })
    if (typeof title !== 'string' || title.length === 0) {
      throw new Error('wiki.history: title 必须是非空字符串')
    }
    return snode.wiki.listHistory(title)
  }

  /**
   * 获取版本链（从根到指定 cid 的所有版本）。
   * @param {string} cid
   * @returns {Array<object>}
   */
  function lineage(cid) {
    checkPermission(perms, 'wiki:list', { app: appName })
    if (typeof cid !== 'string' || cid.length === 0) {
      throw new Error('wiki.lineage: cid 必须是非空字符串')
    }
    return snode.wiki.getLineage(cid)
  }

  /**
   * 获取某标题的最新版本。
   * @param {string} title
   * @param {string} [authorDid] 可选过滤
   * @returns {object|null}
   */
  function latest(title, authorDid) {
    checkPermission(perms, 'wiki:list', { app: appName })
    if (typeof title !== 'string' || title.length === 0) {
      throw new Error('wiki.latest: title 必须是非空字符串')
    }
    if (authorDid !== undefined && (typeof authorDid !== 'string' || authorDid.length === 0)) {
      throw new Error('wiki.latest: authorDid 必须是非空字符串或 undefined')
    }
    return snode.wiki.getLatestVersion(title, authorDid)
  }

  /**
   * 检查 cid 是否是根条目。
   * @param {string} cid
   * @returns {boolean}
   */
  function isRoot(cid) {
    checkPermission(perms, 'wiki:get', { app: appName })
    if (typeof cid !== 'string' || cid.length === 0) {
      throw new Error('wiki.isRoot: cid 必须是非空字符串')
    }
    return snode.wiki.isRootEntry(cid)
  }

  return {
    publish,
    list,
    get,
    history,
    lineage,
    latest,
    isRoot,
  }
}
