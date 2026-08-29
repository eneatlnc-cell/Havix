// SPDX-License-Identifier: AGPL-3.0-only

/**
 * tunnel API 单元测试（M9.2）
 * 覆盖 3 个权限门控 + open/send/breakLink/close。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSnodeMock } from '../__mocks__/snode-mock.js'
import { createTunnelApi } from '../tunnel.js'
import { AppManifest } from '../manifest.js'
import { PermissionDeniedError } from '../errors.js'

function makeManifest(permissions) {
  return new AppManifest({
    name: 'test-app',
    version: '1.0.0',
    capability: 'tunnel',
    permissions,
    entryPoint: './index.js',
  })
}

test('tunnel.open: 委托 snode.establishTunnel', async () => {
  const snode = createSnodeMock()
  const api = createTunnelApi(snode, makeManifest(['tunnel:open']))
  const r = await api.open('did:target:C')
  assert.ok(r.tunnelId)
  assert.ok(Array.isArray(r.relayDids))
  assert.equal(snode.calls.establishTunnel.length, 1)
})

test('tunnel.open: 缺 tunnel:open 权限抛错', async () => {
  const snode = createSnodeMock()
  const api = createTunnelApi(snode, makeManifest([]))
  await assert.rejects(() => api.open('did:t'), (err) => err instanceof PermissionDeniedError && err.permission === 'tunnel:open')
})

test('tunnel.open: 自定义 relayDids', async () => {
  const snode = createSnodeMock()
  const api = createTunnelApi(snode, makeManifest(['tunnel:open']))
  const r = await api.open('did:t', { relayDids: ['did:r:1', 'did:r:2'] })
  assert.equal(r.relayDids.length, 2)
})

test('tunnel.open: 非法 relayDids 抛错', async () => {
  const snode = createSnodeMock()
  const api = createTunnelApi(snode, makeManifest(['tunnel:open']))
  await assert.rejects(() => api.open('did:t', { relayDids: 'not-array' }), /relayDids 必须是数组或 undefined/)
})

test('tunnel.send: 委托 snode.sendTunnelChunk', async () => {
  const snode = createSnodeMock()
  const api = createTunnelApi(snode, makeManifest(['tunnel:open', 'tunnel:send']))
  const { tunnelId } = await api.open('did:t')
  const r = await api.send(tunnelId, new Uint8Array([1, 2, 3]))
  assert.ok(r.relay)
  assert.equal(r.sequence, 1)
  assert.equal(snode.calls.sendTunnelChunk.length, 1)
})

test('tunnel.send: chunk 非 Uint8Array 抛错', async () => {
  const snode = createSnodeMock()
  const api = createTunnelApi(snode, makeManifest(['tunnel:open', 'tunnel:send']))
  const { tunnelId } = await api.open('did:t')
  await assert.rejects(() => api.send(tunnelId, 'not-bytes'), /chunk 必须是 Uint8Array/)
})

test('tunnel.breakLink: 委托 snode.breakTunnelLink', async () => {
  const snode = createSnodeMock()
  const api = createTunnelApi(snode, makeManifest(['tunnel:open', 'tunnel:close']))
  const { tunnelId, relayDids } = await api.open('did:t', { relayDids: ['did:r:1', 'did:r:2'] })
  const r = await api.breakLink(tunnelId, relayDids[0])
  assert.equal(r.status, 'degraded')
  assert.equal(r.remainingRelays, 1)
})

test('tunnel.close: 委托 snode.closeTunnel', async () => {
  const snode = createSnodeMock()
  const api = createTunnelApi(snode, makeManifest(['tunnel:open', 'tunnel:close']))
  const { tunnelId } = await api.open('did:t')
  await api.close(tunnelId)
  assert.equal(snode._state.tunnels.get(tunnelId).status, 'closed')
})

test('tunnel.send: 缺 tunnel:send 权限抛错', async () => {
  const snode = createSnodeMock()
  const api = createTunnelApi(snode, makeManifest(['tunnel:open']))
  const { tunnelId } = await api.open('did:t')
  await assert.rejects(() => api.send(tunnelId, new Uint8Array([1])), (err) => err instanceof PermissionDeniedError && err.permission === 'tunnel:send')
})
