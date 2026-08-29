// SPDX-License-Identifier: AGPL-3.0-only

/**
 * M3.1 message-types 单元测试
 * ───────────────────────────────────────────────
 * 测试公共层消息类型常量、结构校验、构造器。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MESSAGE_VERSION,
  MESSAGE_TYPES,
  VALID_TYPES,
  validateMessageShape,
  makeMessage,
} from '../src/protocol/message-types.js'

// ──────────────────────────────────────────────
// 常量完整性
// ──────────────────────────────────────────────

test('MESSAGE_VERSION = "v1.0"', () => {
  assert.equal(MESSAGE_VERSION, 'v1.0')
})

test('MESSAGE_TYPES 包含 M3.1 实现的两种 type', () => {
  assert.equal(MESSAGE_TYPES.HEARTBEAT, 'heartbeat')
  assert.equal(MESSAGE_TYPES.WIKI_ANNOUNCE, 'wiki-announce')
})

test('MESSAGE_TYPES 是 frozen 对象', () => {
  assert.ok(Object.isFrozen(MESSAGE_TYPES))
  assert.throws(() => { MESSAGE_TYPES.HEARTBEAT = 'x' })
})

test('VALID_TYPES 是所有 type 的集合', () => {
  assert.ok(VALID_TYPES.has('heartbeat'))
  assert.ok(VALID_TYPES.has('wiki-announce'))
  assert.ok(VALID_TYPES.has('offer'))
  assert.ok(VALID_TYPES.has('vouch'))
  assert.ok(VALID_TYPES.has('arbitration'))
  assert.ok(VALID_TYPES.has('credit'))
  assert.ok(VALID_TYPES.has('acknowledge'))
  assert.equal(VALID_TYPES.has('nonexistent'), false)
})

// ──────────────────────────────────────────────
// validateMessageShape
// ──────────────────────────────────────────────

test('validateMessageShape：合法消息通过', () => {
  const r = validateMessageShape({
    version: 'v1.0',
    type: 'heartbeat',
    senderId: '12D3KooWabc',
    timestamp: Date.now(),
    payload: { knownPeers: [] },
  })
  assert.equal(r.valid, true)
})

test('validateMessageShape：version 不匹配拒绝', () => {
  const r = validateMessageShape({
    version: 'v2.0',
    type: 'heartbeat',
    senderId: 'x',
    timestamp: Date.now(),
    payload: {},
  })
  assert.equal(r.valid, false)
  assert.match(r.error, /version/)
})

test('validateMessageShape：未知 type 拒绝', () => {
  const r = validateMessageShape({
    version: 'v1.0',
    type: 'bogus',
    senderId: 'x',
    timestamp: Date.now(),
    payload: {},
  })
  assert.equal(r.valid, false)
  assert.match(r.error, /type/)
})

test('validateMessageShape：senderId 非空校验', () => {
  const r = validateMessageShape({
    version: 'v1.0',
    type: 'heartbeat',
    senderId: '',
    timestamp: Date.now(),
    payload: {},
  })
  assert.equal(r.valid, false)
  assert.match(r.error, /senderId/)
})

test('validateMessageShape：timestamp 必须是正数', () => {
  for (const ts of [0, -1, NaN, Infinity, 'now']) {
    const r = validateMessageShape({
      version: 'v1.0',
      type: 'heartbeat',
      senderId: 'x',
      timestamp: ts,
      payload: {},
    })
    assert.equal(r.valid, false, `timestamp=${ts} 应拒绝`)
    assert.match(r.error, /timestamp/)
  }
})

test('validateMessageShape：payload 必须是对象', () => {
  for (const payload of [null, 'string', 42, []]) {
    const r = validateMessageShape({
      version: 'v1.0',
      type: 'heartbeat',
      senderId: 'x',
      timestamp: Date.now(),
      payload,
    })
    assert.equal(r.valid, false)
    assert.match(r.error, /payload/)
  }
})

test('validateMessageShape：message 非对象拒绝', () => {
  for (const m of [null, undefined, 'str', 42]) {
    const r = validateMessageShape(m)
    assert.equal(r.valid, false)
  }
})

// ──────────────────────────────────────────────
// makeMessage
// ──────────────────────────────────────────────

test('makeMessage：组装合法消息', () => {
  const sig = new Uint8Array([1, 2, 3, 4])
  const pub = new Uint8Array([5, 6, 7, 8])
  const msg = makeMessage({
    type: MESSAGE_TYPES.WIKI_ANNOUNCE,
    senderId: 'did:havix:D:abc',
    payload: { cid: 'bafy...', title: 'hello' },
    signature: sig,
    signerPublicKey: pub,
  })

  assert.equal(msg.version, 'v1.0')
  assert.equal(msg.type, 'wiki-announce')
  assert.equal(msg.senderId, 'did:havix:D:abc')
  assert.equal(typeof msg.timestamp, 'number')
  assert.ok(msg.timestamp > 0)
  assert.deepEqual(msg.payload, { cid: 'bafy...', title: 'hello' })

  // signature / signerPublicKey 应为 base64
  assert.equal(msg.signature, Buffer.from(sig).toString('base64'))
  assert.equal(msg.signerPublicKey, Buffer.from(pub).toString('base64'))
})

test('makeMessage：每次调用 timestamp 不同（按时间递增）', async () => {
  const opts = {
    type: MESSAGE_TYPES.HEARTBEAT,
    senderId: 'x',
    payload: {},
    signature: new Uint8Array(),
    signerPublicKey: new Uint8Array(),
  }
  const m1 = makeMessage(opts)
  await new Promise(r => setTimeout(r, 5))
  const m2 = makeMessage(opts)
  assert.ok(m2.timestamp >= m1.timestamp, '后调用的 timestamp 应更大或相等')
})
