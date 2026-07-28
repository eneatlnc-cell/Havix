// SPDX-License-Identifier: Apache-2.0

/**
 * state.js 持久化集成测试（M9.3）
 * ───────────────────────────────────────────────
 * 覆盖：
 *   - flush() 写盘到 persistPath（saveJsonAtomic 原子写）
 *   - load() 从 persistPath 读入内存（loadJson）
 *   - persist=null 退化为内存版（M9.2 兼容）
 *   - 注入 fake persist 模块（测试用）
 *   - 真实 src/persistence.js 集成：写盘 → 重启 → load 恢复
 *   - set/delete/clear 自动 flush（autoFlush=true 默认）
 *   - autoFlush=false：手动 flush
 *   - 不可序列化 value 拒绝
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { createStateApi } from '../sdk/state.js'
import { AppManifest } from '../sdk/manifest.js'
import { createSnodeMock } from '../sdk/__mocks__/snode-mock.js'

// ──────────────────────────────────────────────
// 辅助
// ──────────────────────────────────────────────

function makeManifest(overrides = {}) {
  return new AppManifest({
    name: 'test-app',
    version: '1.0.0',
    capability: 'custom',
    permissions: [],
    entryPoint: 'index.js',
    ...overrides,
  })
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'havix-state-'))
}

// ──────────────────────────────────────────────
// 内存版（persist=null）
// ──────────────────────────────────────────────

describe('state: persist=null 内存版（M9.2 兼容）', () => {
  test('flush/load 是 no-op', async () => {
    const snode = createSnodeMock()
    const manifest = makeManifest()
    const state = createStateApi(snode, manifest, { persist: null })

    await state.set('key1', 'value1')
    await state.flush()  // 不应抛错
    await state.load()   // 不应抛错
    assert.equal(await state.get('key1'), 'value1')
  })

  test('set 后立即读', async () => {
    const snode = createSnodeMock()
    const state = createStateApi(snode, makeManifest(), { persist: null })
    await state.set('a', 1)
    await state.set('b', { x: 2 })
    await state.set('c', [1, 2, 3])
    assert.equal(await state.get('a'), 1)
    assert.deepEqual(await state.get('b'), { x: 2 })
    assert.deepEqual(await state.get('c'), [1, 2, 3])
  })
})

// ──────────────────────────────────────────────
// 注入 fake persist 模块
// ──────────────────────────────────────────────

describe('state: 注入 fake persist 模块', () => {
  test('flush 调用 saveJsonAtomic', async () => {
    const savedCalls = []
    const fakePersist = {
      saveJsonAtomic(filePath, data, opts) {
        savedCalls.push({ filePath, data })
      },
      loadJson(filePath, defaultValue) {
        return savedCalls[0]?.data ?? defaultValue
      },
    }
    const snode = createSnodeMock()
    const state = createStateApi(snode, makeManifest(), {
      persist: fakePersist,
      autoFlush: false,
    })

    await state.set('key1', 'value1')
    await state.flush()

    assert.equal(savedCalls.length, 1)
    assert.equal(savedCalls[0].data.key1, 'value1')
  })

  test('load 调用 loadJson', async () => {
    const fakePersist = {
      saveJsonAtomic() {},
      loadJson() {
        return { key1: 'loaded-value', key2: 42 }
      },
    }
    const snode = createSnodeMock()
    const state = createStateApi(snode, makeManifest(), { persist: fakePersist })

    await state.load()
    assert.equal(await state.get('key1'), 'loaded-value')
    assert.equal(await state.get('key2'), 42)
  })

  test('autoFlush=true（默认）：set 后自动 flush', async () => {
    const savedCalls = []
    const fakePersist = {
      saveJsonAtomic(filePath, data) { savedCalls.push(data) },
      loadJson() { return {} },
    }
    const snode = createSnodeMock()
    const state = createStateApi(snode, makeManifest(), { persist: fakePersist })

    await state.set('a', 1)
    await state.set('b', 2)
    // 每次 set 都触发一次 flush
    assert.equal(savedCalls.length, 2)
  })

  test('autoFlush=false：手动 flush', async () => {
    const savedCalls = []
    const fakePersist = {
      saveJsonAtomic(filePath, data) { savedCalls.push(data) },
      loadJson() { return {} },
    }
    const snode = createSnodeMock()
    const state = createStateApi(snode, makeManifest(), {
      persist: fakePersist,
      autoFlush: false,
    })

    await state.set('a', 1)
    await state.set('b', 2)
    assert.equal(savedCalls.length, 0)

    await state.flush()
    assert.equal(savedCalls.length, 1)
  })
})

// ──────────────────────────────────────────────
// 真实 src/persistence.js 集成
// ──────────────────────────────────────────────

describe('state: 真实 src/persistence.js 集成', () => {
  test('写盘 → 重启 → load 恢复', async () => {
    const tmpDir = makeTempDir()
    const snode = createSnodeMock({ config: { dataDir: tmpDir } })
    const manifest = makeManifest({ name: 'persist-app' })

    // 第一次启动：set + 自动 flush
    const state1 = createStateApi(snode, manifest, { autoFlush: false })
    await state1.set('counter', 42)
    await state1.set('user', { name: 'alice', age: 30 })
    await state1.flush()

    // 验证文件确实写到了磁盘
    assert.ok(fs.existsSync(state1.persistPath))
    const rawText = fs.readFileSync(state1.persistPath, 'utf8')
    const rawData = JSON.parse(rawText)
    assert.equal(rawData.counter, 42)
    assert.equal(rawData.user.name, 'alice')

    // 第二次启动：load 应该恢复数据
    const state2 = createStateApi(snode, manifest, { autoFlush: false })
    await state2.load()
    assert.equal(await state2.get('counter'), 42)
    assert.equal((await state2.get('user')).name, 'alice')

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('文件不存在时 load 返回空状态', async () => {
    const tmpDir = makeTempDir()
    const snode = createSnodeMock({ config: { dataDir: tmpDir } })
    const state = createStateApi(snode, makeManifest())
    // 不调 set 直接 load
    await state.load()
    assert.equal(state.keys().length, 0)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('delete 自动 flush 到磁盘', async () => {
    const tmpDir = makeTempDir()
    const snode = createSnodeMock({ config: { dataDir: tmpDir } })
    const state = createStateApi(snode, makeManifest({ name: 'del-app' }))

    await state.set('keep', 1)
    await state.set('remove', 2)
    await state.delete('remove')

    // 验证文件中只有 keep
    const rawText = fs.readFileSync(state.persistPath, 'utf8')
    const rawData = JSON.parse(rawText)
    assert.equal(rawData.keep, 1)
    assert.equal(rawData.remove, undefined)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('clear 自动 flush 空对象到磁盘', async () => {
    const tmpDir = makeTempDir()
    const snode = createSnodeMock({ config: { dataDir: tmpDir } })
    const state = createStateApi(snode, makeManifest({ name: 'clear-app' }))

    await state.set('a', 1)
    await state.set('b', 2)
    await state.clear()

    const rawText = fs.readFileSync(state.persistPath, 'utf8')
    const rawData = JSON.parse(rawText)
    assert.deepEqual(rawData, {})

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('persistPath 路径正确', async () => {
    const tmpDir = makeTempDir()
    const snode = createSnodeMock({ config: { dataDir: tmpDir } })
    const state = createStateApi(snode, makeManifest({ name: 'path-app' }))

    // 应该是 <dataDir>/ledgers/apps/<appName>/state.json
    const expected = path.join(tmpDir, 'ledgers', 'apps', 'path-app', 'state.json')
    assert.equal(state.persistPath, expected)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('dataDir 覆盖 manifest.name', async () => {
    const tmpDir = makeTempDir()
    const snode = createSnodeMock({ config: { dataDir: tmpDir } })
    const state = createStateApi(snode, makeManifest({ name: 'app-x' }), {
      dataDir: 'custom-dir',
    })

    const expected = path.join(tmpDir, 'ledgers', 'apps', 'custom-dir', 'state.json')
    assert.equal(state.persistPath, expected)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ──────────────────────────────────────────────
// 错误处理
// ──────────────────────────────────────────────

describe('state: 错误处理', () => {
  test('set 不可序列化 value 拒绝', async () => {
    const snode = createSnodeMock()
    const state = createStateApi(snode, makeManifest(), { persist: null })

    const circular = { a: 1 }
    circular.self = circular
    await assert.rejects(() => state.set('bad', circular), /不可 JSON 序列化/)
  })

  test('set 空 key 拒绝', async () => {
    const snode = createSnodeMock()
    const state = createStateApi(snode, makeManifest(), { persist: null })
    await assert.rejects(() => state.set('', 'val'), /非空字符串/)
  })

  test('get 不存在 key 返回 defaultValue', async () => {
    const snode = createSnodeMock()
    const state = createStateApi(snode, makeManifest(), { persist: null })
    assert.equal(await state.get('missing', 'fallback'), 'fallback')
    assert.equal(await state.get('missing'), undefined)
  })

  test('load 失败时抛错（由 AppManager 上层 catch）', async () => {
    const fakePersist = {
      saveJsonAtomic() {},
      loadJson() { throw new Error('disk corrupted') },
    }
    const snode = createSnodeMock()
    const state = createStateApi(snode, makeManifest(), { persist: fakePersist })
    // load 失败应该抛错（由 AppManager 上层 catch）
    await assert.rejects(() => state.load())
  })
})
