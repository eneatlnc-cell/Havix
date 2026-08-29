// SPDX-License-Identifier: AGPL-3.0-only

/**
 * wiki API 单元测试（M9.2）
 * 覆盖 3 个权限门控 + publish/list/get/history/lineage/latest/isRoot。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSnodeMock } from '../__mocks__/snode-mock.js'
import { createWikiApi } from '../wiki.js'
import { AppManifest } from '../manifest.js'
import { PermissionDeniedError } from '../errors.js'

function makeManifest(permissions) {
  return new AppManifest({
    name: 'test-app',
    version: '1.0.0',
    capability: 'wiki',
    permissions,
    entryPoint: './index.js',
  })
}

test('wiki.publish: 委托 snode.wiki.publishEntry', async () => {
  const snode = createSnodeMock()
  const api = createWikiApi(snode, makeManifest(['wiki:publish']))
  const { cid, message } = await api.publish({ title: 't1', content: 'hello' })
  assert.ok(cid.startsWith('bafy'))
  assert.equal(message.type, 'wiki-announce')
  assert.equal(snode.calls.wikiPublishEntry.length, 1)
})

test('wiki.publish: content 可以是 Uint8Array', async () => {
  const snode = createSnodeMock()
  const api = createWikiApi(snode, makeManifest(['wiki:publish']))
  const { cid } = await api.publish({ title: 't1', content: new Uint8Array([1, 2, 3]) })
  assert.ok(cid.startsWith('bafy'))
})

test('wiki.publish: 缺 wiki:publish 权限抛错', async () => {
  const snode = createSnodeMock()
  const api = createWikiApi(snode, makeManifest([]))
  await assert.rejects(() => api.publish({ title: 't1', content: 'c' }), (err) => err instanceof PermissionDeniedError && err.permission === 'wiki:publish')
})

test('wiki.publish: 空标题抛错', async () => {
  const snode = createSnodeMock()
  const api = createWikiApi(snode, makeManifest(['wiki:publish']))
  await assert.rejects(() => api.publish({ title: '', content: 'c' }), /title 必须是非空字符串/)
})

test('wiki.list: 委托 listEntries', async () => {
  const snode = createSnodeMock()
  const api = createWikiApi(snode, makeManifest(['wiki:publish', 'wiki:list']))
  await api.publish({ title: 't1', content: 'a' })
  await api.publish({ title: 't2', content: 'b' })
  assert.equal(api.list().length, 2)
})

test('wiki.get: 委托 getEntry + 不存在返回 null', async () => {
  const snode = createSnodeMock()
  const api = createWikiApi(snode, makeManifest(['wiki:publish', 'wiki:get']))
  const { cid } = await api.publish({ title: 't1', content: 'a' })
  assert.equal(api.get(cid).title, 't1')
  assert.equal(api.get('nonexistent'), null)
})

test('wiki.history: 返回某标题的所有版本', async () => {
  const snode = createSnodeMock()
  const api = createWikiApi(snode, makeManifest(['wiki:publish', 'wiki:list']))
  await api.publish({ title: 't1', content: 'v1' })
  await api.publish({ title: 't1', content: 'v2' })
  const hist = api.history('t1')
  assert.equal(hist.length, 2)
})

test('wiki.lineage + isRoot: 版本链 + 根条目判定', async () => {
  const snode = createSnodeMock()
  const api = createWikiApi(snode, makeManifest(['wiki:publish', 'wiki:list', 'wiki:get']))
  const r1 = await api.publish({ title: 't1', content: 'root' })
  const r2 = await api.publish({ title: 't1', content: 'v2', parentCid: r1.cid })
  assert.equal(api.isRoot(r1.cid), true)
  assert.equal(api.isRoot(r2.cid), false)
  const lineage = api.lineage(r2.cid)
  assert.equal(lineage.length, 2)
  assert.equal(lineage[0].cid, r1.cid)
  assert.equal(lineage[1].cid, r2.cid)
})

test('wiki.latest: 返回某标题最新版本', async () => {
  const snode = createSnodeMock()
  const api = createWikiApi(snode, makeManifest(['wiki:publish', 'wiki:list']))
  await api.publish({ title: 't1', content: 'v1' })
  const last = await api.publish({ title: 't1', content: 'v2' })
  const latest = api.latest('t1')
  assert.equal(latest.cid, last.cid)
})

test('createWikiApi: snode.wiki 未初始化抛错', () => {
  const snode = createSnodeMock()
  delete snode.wiki
  assert.throws(() => createWikiApi(snode, makeManifest([])), /snode\.wiki 未初始化/)
})
