/**
 * web API 单元测试（M9.2）
 * 覆盖 GET-only 约束 + mount/get/listRoutes/hasRoute/handle。
 *
 * 严格遵循 M9 理论修正：不提供 post/put/delete 接口。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSnodeMock } from '../__mocks__/snode-mock.js'
import { createWebApi } from '../web.js'
import { AppManifest } from '../manifest.js'

function makeManifest(name = 'test-app') {
  return new AppManifest({
    name,
    version: '1.0.0',
    capability: 'custom',
    permissions: [],
    entryPoint: './index.js',
  })
}

test('web.get: 注册 GET API 路由', () => {
  const snode = createSnodeMock()
  const api = createWebApi(snode, makeManifest())
  api.get('/api/apps/test-app/foo', () => ({ foo: 'bar' }))
  assert.equal(api.hasRoute('/api/apps/test-app/foo'), true)
  assert.equal(api.listRoutes().length, 1)
})

test('web.mount: 注册静态目录', () => {
  const snode = createSnodeMock()
  const api = createWebApi(snode, makeManifest())
  api.mount('/apps/test-app/', { type: 'static', dir: './webui/' })
  assert.equal(api.hasRoute('/apps/test-app/index.html'), true)
})

test('web.handle: GET API 路由返回 handler 结果', async () => {
  const snode = createSnodeMock()
  const api = createWebApi(snode, makeManifest())
  api.get('/api/apps/test-app/foo', () => ({ foo: 'bar' }))
  const r = await api.handle('foo', { method: 'GET' })
  assert.equal(r.status, 200)
  assert.equal(r.body.foo, 'bar')
})

test('web.handle: handler 抛错返回 500', async () => {
  const snode = createSnodeMock()
  const api = createWebApi(snode, makeManifest())
  api.get('/api/apps/test-app/broken', () => { throw new Error('boom') })
  const r = await api.handle('broken', { method: 'GET' })
  assert.equal(r.status, 500)
  assert.equal(r.body.error, 'boom')
})

test('web.handle: 非 GET 方法返回 405 + hint', async () => {
  const snode = createSnodeMock()
  const api = createWebApi(snode, makeManifest())
  api.get('/api/apps/test-app/foo', () => ({ foo: 'bar' }))
  const r = await api.handle('foo', { method: 'POST' })
  assert.equal(r.status, 405)
  assert.match(r.body.error, /仅支持 GET/)
  assert.match(r.body.hint, /REPL/)
})

test('web.handle: 路径未注册返回 404', async () => {
  const snode = createSnodeMock()
  const api = createWebApi(snode, makeManifest())
  const r = await api.handle('unknown', { method: 'GET' })
  assert.equal(r.status, 404)
})

test('web.handle: 静态目录前缀匹配返回 200', async () => {
  const snode = createSnodeMock()
  const api = createWebApi(snode, makeManifest())
  api.mount('/apps/test-app/', { type: 'static', dir: './webui/' })
  const r = await api.handle('index.html', { method: 'GET' })
  assert.equal(r.status, 200)
  assert.equal(r.body._static, true)
})

test('web: 路径必须以 /apps/<appName>/ 或 /api/apps/<appName>/ 开头（防越权）', () => {
  const snode = createSnodeMock()
  const api = createWebApi(snode, makeManifest())
  assert.throws(() => api.get('/apps/other-app/foo', () => {}), /必须以/)
  assert.throws(() => api.get('/api/apps/other-app/foo', () => {}), /必须以/)
  assert.throws(() => api.get('/random/path', () => {}), /必须以/)
})

test('web: 不允许重复注册同一路径', () => {
  const snode = createSnodeMock()
  const api = createWebApi(snode, makeManifest())
  api.get('/api/apps/test-app/foo', () => 1)
  assert.throws(() => api.get('/api/apps/test-app/foo', () => 2), /已注册/)
})

test('web: 不提供 post/put/delete 方法（GET-only 约束）', () => {
  const snode = createSnodeMock()
  const api = createWebApi(snode, makeManifest())
  assert.equal(typeof api.post, 'undefined')
  assert.equal(typeof api.put, 'undefined')
  assert.equal(typeof api.delete, 'undefined')
  assert.equal(api._constraint, 'GET-only (M9 理论修正)')
})

test('web.mount: mountPath 必须以 / 结尾', () => {
  const snode = createSnodeMock()
  const api = createWebApi(snode, makeManifest())
  assert.throws(() => api.mount('/apps/test-app', { type: 'static', dir: './x' }), /mountPath 必须以 \/ 结尾/)
})

test('web.mount: type 必须是 static', () => {
  const snode = createSnodeMock()
  const api = createWebApi(snode, makeManifest())
  assert.throws(() => api.mount('/apps/test-app/', { type: 'dynamic', dir: './x' }), /opts.type 必须是 "static"/)
})
