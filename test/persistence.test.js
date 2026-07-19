/**
 * M8.1 持久化工具单元测试
 * ───────────────────────────────────────────────
 * 测试范围：
 *   - src/persistence.js 的所有导出函数
 *   - ensureDir / loadJson / saveJsonAtomic
 *   - mapToArray / arrayToMap / setToArray / arrayToSet
 *   - bytesToBase64 / base64ToBytes
 *   - 原子写：.tmp 文件写完后被清理
 *   - loadJson 文件不存在 / 损坏时返回默认值（不抛错）
 *
 * 全部纯单元测试，不依赖 helia / libp2p。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import {
  ensureDir,
  loadJson,
  saveJsonAtomic,
  mapToArray,
  arrayToMap,
  setToArray,
  arrayToSet,
  bytesToBase64,
  base64ToBytes,
} from '../src/persistence.js'

// ──────────────────────────────────────────────
// 临时目录辅助
// ──────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'havix-m81-test-'))
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* 忽略 */ }
}

// ──────────────────────────────────────────────
// ensureDir
// ──────────────────────────────────────────────

test('ensureDir：递归创建嵌套目录', () => {
  const base = makeTmpDir()
  try {
    const target = path.join(base, 'a', 'b', 'c')
    assert.equal(fs.existsSync(target), false)
    ensureDir(target)
    assert.equal(fs.existsSync(target), true, '应递归创建目录')
  } finally {
    rmrf(base)
  }
})

test('ensureDir：已存在目录不抛错', () => {
  const base = makeTmpDir()
  try {
    assert.doesNotThrow(() => ensureDir(base))
    assert.doesNotThrow(() => ensureDir(base))
  } finally {
    rmrf(base)
  }
})

// ──────────────────────────────────────────────
// loadJson
// ──────────────────────────────────────────────

test('loadJson：文件不存在时返回 defaultValue', () => {
  const dir = makeTmpDir()
  try {
    const file = path.join(dir, 'no-such.json')
    assert.equal(loadJson(file, 'def'), 'def')
    assert.equal(loadJson(file, null), null)
    assert.equal(loadJson(file, undefined), undefined)
    assert.deepEqual(loadJson(file, { a: 1 }), { a: 1 })
  } finally {
    rmrf(dir)
  }
})

test('loadJson：合法 JSON 文件正确解析', () => {
  const dir = makeTmpDir()
  try {
    const file = path.join(dir, 'data.json')
    fs.writeFileSync(file, JSON.stringify({ foo: 'bar', n: 42, arr: [1, 2, 3] }))
    const result = loadJson(file, null)
    assert.deepEqual(result, { foo: 'bar', n: 42, arr: [1, 2, 3] })
  } finally {
    rmrf(dir)
  }
})

test('loadJson：损坏 JSON 返回 defaultValue，不抛错', () => {
  const dir = makeTmpDir()
  try {
    const file = path.join(dir, 'bad.json')
    fs.writeFileSync(file, '{ this is not valid json ]')
    const logs = []
    const log = (lvl, tag, msg) => logs.push({ lvl, tag, msg })
    assert.equal(loadJson(file, 'fallback', { log }), 'fallback')
    assert.ok(logs.length > 0, '应通过 log 报告失败')
    assert.equal(logs[0].lvl, 'warn')
    assert.match(logs[0].msg, /加载.*失败/)
  } finally {
    rmrf(dir)
  }
})

test('loadJson：未传 log 时不抛错（默认 no-op logger）', () => {
  const dir = makeTmpDir()
  try {
    const file = path.join(dir, 'bad.json')
    fs.writeFileSync(file, '<<<broken>>>')
    assert.doesNotThrow(() => loadJson(file, 'def'))
  } finally {
    rmrf(dir)
  }
})

// ──────────────────────────────────────────────
// saveJsonAtomic
// ──────────────────────────────────────────────

test('saveJsonAtomic：写入后文件存在且内容正确', () => {
  const dir = makeTmpDir()
  try {
    const file = path.join(dir, 'out.json')
    saveJsonAtomic(file, { hello: 'world', n: 7 })
    assert.equal(fs.existsSync(file), true)
    const text = fs.readFileSync(file, 'utf8')
    assert.deepEqual(JSON.parse(text), { hello: 'world', n: 7 })
  } finally {
    rmrf(dir)
  }
})

test('saveJsonAtomic：原子写不留 .tmp 残留', () => {
  const dir = makeTmpDir()
  try {
    const file = path.join(dir, 'atomic.json')
    saveJsonAtomic(file, { a: 1 })
    assert.equal(fs.existsSync(file), true)
    assert.equal(fs.existsSync(`${file}.tmp`), false, 'rename 后 .tmp 应被清理')
  } finally {
    rmrf(dir)
  }
})

test('saveJsonAtomic：覆盖旧文件时保持原子性', () => {
  const dir = makeTmpDir()
  try {
    const file = path.join(dir, 'overwrite.json')
    saveJsonAtomic(file, { version: 1 })
    saveJsonAtomic(file, { version: 2 })
    const text = fs.readFileSync(file, 'utf8')
    assert.deepEqual(JSON.parse(text), { version: 2 })
    assert.equal(fs.existsSync(`${file}.tmp`), false)
  } finally {
    rmrf(dir)
  }
})

test('saveJsonAtomic：自动创建父目录', () => {
  const dir = makeTmpDir()
  try {
    const file = path.join(dir, 'sub', 'deep', 'file.json')
    saveJsonAtomic(file, { ok: true })
    assert.equal(fs.existsSync(file), true)
    const text = fs.readFileSync(file, 'utf8')
    assert.deepEqual(JSON.parse(text), { ok: true })
  } finally {
    rmrf(dir)
  }
})

test('saveJsonAtomic：失败时不抛错（只 log warn）', () => {
  const dir = makeTmpDir()
  try {
    // 不可写路径（root 下）—— 非特权用户写会失败
    const file = '/proc/cannot-write-here.json'
    const logs = []
    const log = (lvl, tag, msg) => logs.push({ lvl, tag, msg })
    assert.doesNotThrow(() => saveJsonAtomic(file, { x: 1 }, { log }))
    assert.ok(logs.some(l => l.lvl === 'warn' && /写盘.*失败/.test(l.msg)),
      '应通过 log warn 报告失败')
  } finally {
    rmrf(dir)
  }
})

// ──────────────────────────────────────────────
// M8 审计修复 P0-A：文件权限 0o600 + 目录权限 0o700
// ──────────────────────────────────────────────

test('saveJsonAtomic：文件权限为 0o600（仅所有者可读写）', () => {
  const dir = makeTmpDir()
  try {
    const file = path.join(dir, 'secret.json')
    saveJsonAtomic(file, { encryptionKey: 'sensitive-data' })
    const stat = fs.statSync(file)
    // 取文件 mode 后 12 位（前 4 位是文件类型）
    const mode = stat.mode & 0o777
    // Windows 无 POSIX 权限，跳过断言
    if (process.platform === 'win32') return
    assert.equal(mode, 0o600,
      `文件权限应为 0o600（仅所有者可读写），实际：0o${mode.toString(8)}`)
  } finally {
    rmrf(dir)
  }
})

test('ensureDir：目录权限为 0o700（仅所有者可访问）', () => {
  const dir = makeTmpDir() + '/subdir'
  try {
    ensureDir(dir)
    const stat = fs.statSync(dir)
    const mode = stat.mode & 0o777
    if (process.platform === 'win32') return
    // mkdirSync 的 mode 在某些系统上会被 umask 修改，
    // 但我们显式传 mode: 0o700，应该生效（或被 umask 减弱）
    // 这里只断言"其他用户无权限"（最后 3 位为 0）
    assert.equal(mode & 0o007, 0,
      `目录"其他用户"权限位应为 0（防本机其他用户读取），实际：0o${mode.toString(8)}`)
  } finally {
    rmrf(dir)
  }
})

// ──────────────────────────────────────────────
// mapToArray / arrayToMap
// ──────────────────────────────────────────────

test('mapToArray：Map → [k, v][]', () => {
  const m = new Map([['a', 1], ['b', 2]])
  assert.deepEqual(mapToArray(m), [['a', 1], ['b', 2]])
})

test('mapToArray：空 Map → 空数组', () => {
  assert.deepEqual(mapToArray(new Map()), [])
})

test('arrayToMap：[k, v][] → Map', () => {
  const m = arrayToMap([['a', 1], ['b', 2]])
  assert.equal(m.get('a'), 1)
  assert.equal(m.get('b'), 2)
  assert.equal(m.size, 2)
})

test('arrayToMap：null / undefined → 空 Map', () => {
  assert.equal(arrayToMap(null).size, 0)
  assert.equal(arrayToMap(undefined).size, 0)
})

test('arrayToMap：valueDecoder 可转换值', () => {
  // 模拟 Set → Array 序列化后恢复 Set
  const m = arrayToMap(
    [['k1', ['a', 'b']], ['k2', ['c']]],
    (v) => new Set(v),
  )
  assert.ok(m.get('k1') instanceof Set)
  assert.deepEqual(Array.from(m.get('k1')), ['a', 'b'])
})

test('mapToArray → arrayToMap 往返一致', () => {
  const orig = new Map([['x', 10], ['y', 20], ['z', 30]])
  const restored = arrayToMap(mapToArray(orig))
  assert.deepEqual(Array.from(restored.entries()), Array.from(orig.entries()))
})

// ──────────────────────────────────────────────
// setToArray / arrayToSet
// ──────────────────────────────────────────────

test('setToArray：Set → Array', () => {
  assert.deepEqual(setToArray(new Set([1, 2, 3])), [1, 2, 3])
})

test('setToArray：空 Set → 空数组', () => {
  assert.deepEqual(setToArray(new Set()), [])
})

test('arrayToSet：Array → Set', () => {
  const s = arrayToSet(['a', 'b', 'c'])
  assert.ok(s instanceof Set)
  assert.equal(s.size, 3)
  assert.equal(s.has('a'), true)
})

test('arrayToSet：null / undefined → 空 Set', () => {
  assert.equal(arrayToSet(null).size, 0)
  assert.equal(arrayToSet(undefined).size, 0)
})

test('setToArray → arrayToSet 往返一致', () => {
  const orig = new Set(['alice', 'bob', 'carol'])
  const restored = arrayToSet(setToArray(orig))
  assert.deepEqual(Array.from(restored).sort(), Array.from(orig).sort())
})

// ──────────────────────────────────────────────
// bytesToBase64 / base64ToBytes
// ──────────────────────────────────────────────

test('bytesToBase64：Uint8Array → base64 字符串', () => {
  const bytes = new Uint8Array([72, 101, 108, 108, 111])  // "Hello"
  assert.equal(bytesToBase64(bytes), 'SGVsbG8=')
})

test('base64ToBytes：base64 字符串 → Uint8Array', () => {
  const bytes = base64ToBytes('SGVsbG8=')
  assert.ok(bytes instanceof Uint8Array)
  assert.deepEqual(Array.from(bytes), [72, 101, 108, 108, 111])
})

test('bytesToBase64 → base64ToBytes 往返一致（含 32 字节 Ed25519 公钥模拟）', () => {
  const orig = new Uint8Array(32)
  for (let i = 0; i < 32; i++) orig[i] = (i * 7 + 13) & 0xff
  const restored = base64ToBytes(bytesToBase64(orig))
  assert.deepEqual(Array.from(restored), Array.from(orig))
})

test('bytesToBase64 → base64ToBytes 往返一致（空数组）', () => {
  const orig = new Uint8Array(0)
  const restored = base64ToBytes(bytesToBase64(orig))
  assert.equal(restored.length, 0)
})

// ──────────────────────────────────────────────
// 端到端：saveJsonAtomic + loadJson 配合
// ──────────────────────────────────────────────

test('端到端：saveJsonAtomic → loadJson 往返一致', () => {
  const dir = makeTmpDir()
  try {
    const file = path.join(dir, 'round-trip.json')
    const data = {
      str: 'hello',
      num: 3.14,
      bool: true,
      null: null,
      arr: [1, 'two', { three: 3 }],
      nested: { a: { b: { c: 'deep' } } },
    }
    saveJsonAtomic(file, data)
    const loaded = loadJson(file, null)
    assert.deepEqual(loaded, data)
  } finally {
    rmrf(dir)
  }
})

test('端到端：Map/Set 借助工具函数可序列化往返一致', () => {
  const dir = makeTmpDir()
  try {
    const file = path.join(dir, 'complex.json')
    const orig = {
      reputations: mapToArray(new Map([['alice', 100], ['bob', 50]])),
      members: setToArray(new Set(['m1', 'm2', 'm3'])),
      key: bytesToBase64(new Uint8Array([1, 2, 3, 4, 5])),
    }
    saveJsonAtomic(file, orig)

    const loaded = loadJson(file, null)
    const restoredMap = arrayToMap(loaded.reputations)
    const restoredSet = arrayToSet(loaded.members)
    const restoredKey = base64ToBytes(loaded.key)

    assert.equal(restoredMap.get('alice'), 100)
    assert.equal(restoredMap.get('bob'), 50)
    assert.equal(restoredSet.size, 3)
    assert.ok(restoredSet.has('m2'))
    assert.deepEqual(Array.from(restoredKey), [1, 2, 3, 4, 5])
  } finally {
    rmrf(dir)
  }
})
