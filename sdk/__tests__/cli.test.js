// SPDX-License-Identifier: Apache-2.0

/**
 * cli API 单元测试（M9.2）
 * 覆盖 register/unregister/listCommands/hasCommand/execute + 命令名前缀校验。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSnodeMock } from '../__mocks__/snode-mock.js'
import { createCliApi } from '../cli.js'
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

test('cli.register: 注册命令 + listCommands 返回', () => {
  const snode = createSnodeMock()
  const api = createCliApi(snode, makeManifest())
  api.register('test-app-hello', {
    description: '打招呼',
    args: ['--name'],
    handler: async () => 'hello',
  })
  assert.equal(api.listCommands().length, 1)
  assert.equal(api.hasCommand('test-app-hello'), true)
})

test('cli.register: 命令名必须以 <appName>- 开头（防命名冲突）', () => {
  const snode = createSnodeMock()
  const api = createCliApi(snode, makeManifest('my-app'))
  assert.throws(() => api.register('other-app-cmd', { handler: () => 1 }), /必须以 "my-app-"/)
  assert.throws(() => api.register('myapp-cmd', { handler: () => 1 }), /必须以 "my-app-"/)
})

test('cli.register: 命令名必须是 kebab-case', () => {
  const snode = createSnodeMock()
  const api = createCliApi(snode, makeManifest())
  assert.throws(() => api.register('test-app-Camel', { handler: () => 1 }), /kebab-case/)
  assert.throws(() => api.register('test-app_under', { handler: () => 1 }), /kebab-case/)
})

test('cli.register: handler 非函数抛错', () => {
  const snode = createSnodeMock()
  const api = createCliApi(snode, makeManifest())
  assert.throws(() => api.register('test-app-x', { handler: 'not-fn' }), /opts.handler 必须是函数/)
})

test('cli.register: 重复注册同名命令抛错', () => {
  const snode = createSnodeMock()
  const api = createCliApi(snode, makeManifest())
  api.register('test-app-cmd', { handler: () => 1 })
  assert.throws(() => api.register('test-app-cmd', { handler: () => 2 }), /已注册/)
})

test('cli.unregister: 取消注册', () => {
  const snode = createSnodeMock()
  const api = createCliApi(snode, makeManifest())
  api.register('test-app-x', { handler: () => 1 })
  assert.equal(api.unregister('test-app-x'), true)
  assert.equal(api.hasCommand('test-app-x'), false)
  assert.equal(api.unregister('test-app-x'), false)  // 不存在返回 false
})

test('cli.execute: 调用 handler + 返回结果', async () => {
  const snode = createSnodeMock()
  const api = createCliApi(snode, makeManifest())
  api.register('test-app-hello', {
    handler: async (args) => `hello ${args.name}`,
  })
  const r = await api.execute('test-app-hello', { name: 'world' })
  assert.equal(r, 'hello world')
})

test('cli.execute: 未注册命令抛错', async () => {
  const snode = createSnodeMock()
  const api = createCliApi(snode, makeManifest())
  await assert.rejects(() => api.execute('test-app-unknown'), /未注册/)
})

test('cli.appName 暴露给 App', () => {
  const snode = createSnodeMock()
  const api = createCliApi(snode, makeManifest('foo-app'))
  assert.equal(api.appName, 'foo-app')
})
