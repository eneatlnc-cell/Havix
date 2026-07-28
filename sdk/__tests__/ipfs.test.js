// SPDX-License-Identifier: Apache-2.0

/**
 * ipfs API 单元测试（M9.2）
 * 覆盖 2 个权限门控 + add/get/computeCid + 数据往返一致。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSnodeMock } from '../__mocks__/snode-mock.js'
import { createIpfsApi } from '../ipfs.js'
import { AppManifest } from '../manifest.js'
import { PermissionDeniedError } from '../errors.js'

function makeManifest(permissions) {
  return new AppManifest({
    name: 'test-app',
    version: '1.0.0',
    capability: 'custom',
    permissions,
    entryPoint: './index.js',
  })
}

test('ipfs.add + get: 数据往返一致', async () => {
  const snode = createSnodeMock()
  const api = createIpfsApi(snode, makeManifest(['ipfs:read', 'ipfs:write']))
  const bytes = new Uint8Array([1, 2, 3, 4, 5])
  const cid = await api.add(bytes)
  assert.ok(cid.startsWith('bafk'))
  const got = await api.get(cid)
  assert.deepEqual(got, bytes)
})

test('ipfs.add: 缺 ipfs:write 权限抛错', async () => {
  const snode = createSnodeMock()
  const api = createIpfsApi(snode, makeManifest(['ipfs:read']))
  await assert.rejects(() => api.add(new Uint8Array([1])), (err) => err instanceof PermissionDeniedError && err.permission === 'ipfs:write')
})

test('ipfs.get: 缺 ipfs:read 权限抛错', async () => {
  const snode = createSnodeMock()
  const api = createIpfsApi(snode, makeManifest(['ipfs:write']))
  await api.add(new Uint8Array([1]))
  await assert.rejects(() => api.get('bafyxxx'), (err) => err instanceof PermissionDeniedError && err.permission === 'ipfs:read')
})

test('ipfs.add: bytes 非 Uint8Array 抛错', async () => {
  const snode = createSnodeMock()
  const api = createIpfsApi(snode, makeManifest(['ipfs:write']))
  await assert.rejects(() => api.add('not-bytes'), /bytes 必须是 Uint8Array/)
})

test('ipfs.get: cidStr 非法抛错', async () => {
  const snode = createSnodeMock()
  const api = createIpfsApi(snode, makeManifest(['ipfs:read']))
  await assert.rejects(() => api.get(''), /cidStr 必须是非空字符串/)
})

test('ipfs.computeCid: 计算与 add 一致', async () => {
  const snode = createSnodeMock()
  const api = createIpfsApi(snode, makeManifest(['ipfs:read', 'ipfs:write']))
  const bytes = new Uint8Array([1, 2, 3])
  const computed = await api.computeCid(bytes)
  const added = await api.add(bytes)
  assert.equal(computed, added)
})

test('ipfs.computeCid: 无需权限（纯计算，不写盘）', async () => {
  const snode = createSnodeMock()
  const api = createIpfsApi(snode, makeManifest([]))
  const cid = await api.computeCid(new Uint8Array([1]))
  assert.ok(cid.startsWith('bafk'))
})

test('ipfs.get: 不存在的 cid 抛错', async () => {
  const snode = createSnodeMock()
  const api = createIpfsApi(snode, makeManifest(['ipfs:read']))
  // 构造一个合法但 blockstore 中不存在的 CID
  const { CID } = await import('multiformats/cid')
  const { sha256 } = await import('multiformats/hashes/sha2')
  const hash = await sha256.digest(new Uint8Array([99, 99, 99]))
  const cid = CID.createV1(0x55, hash).toString()
  await assert.rejects(() => api.get(cid), /blockstore 未找到 cid/)
})

test('createIpfsApi: snode.ipfs.blockstore 未初始化抛错', () => {
  const snode = createSnodeMock()
  delete snode.ipfs.blockstore
  assert.throws(() => createIpfsApi(snode, makeManifest([])), /snode\.ipfs\.blockstore 未初始化/)
})
