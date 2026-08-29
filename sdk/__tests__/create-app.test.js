// SPDX-License-Identifier: AGPL-3.0-only

/**
 * createApp 入口单元测试（M9.2）
 * 覆盖装配 + 子模块缺依赖处理 + manifest 归一化 + _ensureModule + stop。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSnodeMock } from '../__mocks__/snode-mock.js'
import { createApp } from '../app.js'
import { AppManifest } from '../manifest.js'
import { InvalidAppStateError } from '../errors.js'

function makeManifest(overrides = {}) {
  return new AppManifest({
    name: 'test-app',
    version: '1.0.0',
    capability: 'market',
    permissions: [
      'market:create', 'market:invite', 'market:join', 'market:publish', 'market:subscribe', 'market:leave',
      'credit:issue', 'credit:consume', 'credit:transfer', 'credit:balance',
      'wiki:publish', 'wiki:list', 'wiki:get',
      'tunnel:open', 'tunnel:send', 'tunnel:close',
      'arbitration:file', 'arbitration:vote', 'arbitration:resolve',
      'transport:publish', 'transport:subscribe',
      'ipfs:read', 'ipfs:write',
      'identity:context', 'identity:context:B',
    ],
    entryPoint: './index.js',
    contexts: ['B'],
    ...overrides,
  })
}

test('createApp: 装配 7 大子模块 + web/cli/state', async () => {
  const snode = createSnodeMock()
  const app = await createApp(snode, makeManifest())
  assert.ok(app.context)
  assert.ok(app.market)
  assert.ok(app.credit)
  assert.ok(app.wiki)
  assert.ok(app.tunnel)
  assert.ok(app.arbitration)
  assert.ok(app.transport)
  assert.ok(app.ipfs)
  assert.ok(app.web)
  assert.ok(app.cli)
  assert.ok(app.state)
})

test('createApp: manifestId 等于 manifest.name（M9.2）', async () => {
  const snode = createSnodeMock()
  const app = await createApp(snode, makeManifest({ name: 'my-app' }))
  assert.equal(app.manifestId, 'my-app')
})

test('createApp: dataDir 默认等于 manifest.name', async () => {
  const snode = createSnodeMock()
  const app = await createApp(snode, makeManifest({ name: 'my-app' }))
  assert.equal(app.dataDir, 'my-app')
})

test('createApp: options.dataDir 覆盖 manifest.dataDir', async () => {
  const snode = createSnodeMock()
  const app = await createApp(snode, makeManifest({ dataDir: 'manifest-dir' }), { dataDir: 'options-dir' })
  assert.equal(app.dataDir, 'options-dir')
})

test('createApp: manifest 可以是普通对象（内部转换 AppManifest）', async () => {
  const snode = createSnodeMock()
  const app = await createApp(snode, {
    name: 'obj-app',
    version: '1.0.0',
    capability: 'market',
    permissions: [],
    entryPoint: './index.js',
  })
  assert.ok(app.manifest instanceof AppManifest)
  assert.equal(app.manifest.name, 'obj-app')
})

test('createApp: 缺 wallet 时 context 子模块为 null + _ensureModule 抛错', async () => {
  const snode = createSnodeMock()
  delete snode.wallet
  const app = await createApp(snode, makeManifest())
  assert.equal(app.context, null)
  assert.throws(
    () => app._ensureModule('context'),
    (err) => err instanceof InvalidAppStateError && err.code === 'INVALID_APP_STATE',
  )
})

test('createApp: 缺 wiki 时 wiki 子模块为 null', async () => {
  const snode = createSnodeMock()
  delete snode.wiki
  const app = await createApp(snode, makeManifest())
  assert.equal(app.wiki, null)
})

test('createApp: 缺 libp2p.services.pubsub 时 transport 为 null', async () => {
  const snode = createSnodeMock()
  delete snode.libp2p.services.pubsub
  const app = await createApp(snode, makeManifest())
  assert.equal(app.transport, null)
})

test('createApp.stop: 清理订阅 + state.flush（P1-7 修复：只清理自己注册的）', async () => {
  const snode = createSnodeMock()
  const app = await createApp(snode, makeManifest())

  // 模拟"其他 App"在 snode 共享状态中注册的订阅——本 App.stop() 不应清理它们
  const otherHandler = () => {}
  snode._transportSubscriptions = new Map([['/other-app-topic', new Set([otherHandler])]])
  snode._marketSubscriptions = new Map([['other-market', new Set([otherHandler])]])
  snode._creditHandlers = [otherHandler]
  await app.stop()
  // P1-7：本 App 没注册任何订阅，stop 后其他 App 的注册应保持
  assert.equal(snode._transportSubscriptions.size, 1)
  assert.equal(snode._marketSubscriptions.size, 1)
  assert.equal(snode._creditHandlers.length, 1)
})

test('createApp: log 优先 options.log > snode.log', async () => {
  const snode = createSnodeMock()
  const customLog = () => {}
  const app = await createApp(snode, makeManifest(), { log: customLog })
  assert.equal(app.log, customLog)
})

test('createApp: snode 必填', async () => {
  await assert.rejects(() => createApp(null, makeManifest()), /snode 必填/)
})

test('createApp: manifest 必填', async () => {
  const snode = createSnodeMock()
  await assert.rejects(() => createApp(snode, null), /manifest 必填/)
})

test('createApp: 端到端——market.create + context.sign + credit.issue 全部可调用', async () => {
  const snode = createSnodeMock()
  const app = await createApp(snode, makeManifest())
  const m = await app.market.create({ manifest: { name: 'inner', version: '1.0.0', capability: 'market', permissions: [], entryPoint: './index.js' } })
  assert.ok(m.marketId)
  const sig = await app.context.sign('B', new Uint8Array([1]))
  assert.equal(sig.signature.length, 64)
  const { note } = await app.credit.issue('did:h:1', 50)
  assert.equal(note.amount, 50)
})
