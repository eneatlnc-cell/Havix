/**
 * DhtGate 单元测试
 * ───────────────────────────────────────────────
 * 验证门控逻辑：
 *   1. 注册私域 CID 后，isPrivate 返回 true
 *   2. 公共 CID 的 provide/findProviders 委托给 libp2p
 *   3. 私域 CID 的 provide 抛 PrivateCidRejectedError
 *   4. 私域 CID 的 findProviders 抛 PrivateCidRejectedError
 *   5. listPrivateCids 返回正确的审计信息
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import * as raw from 'multiformats/codecs/raw'

import { DhtGate, PrivateCidRejectedError } from '../src/network/dht.js'

// ──────────────────────────────────────────────
// 测试辅助：构造一个 CID
// ──────────────────────────────────────────────

async function makeCid(content = 'hello world') {
  const bytes = new TextEncoder().encode(content)
  const hash = await sha256.digest(bytes)
  return CID.create(1, raw.code, hash)
}

// ──────────────────────────────────────────────
// 测试辅助：构造一个 stub libp2p（只模拟 contentRouting 接口）
// ──────────────────────────────────────────────

function makeStubLibp2p() {
  const provideCalls = []
  const findProvidersCalls = []

  return {
    provideCalls,
    findProvidersCalls,

    contentRouting: {
      async provide(cid) {
        provideCalls.push(cid.toString())
      },
      async *findProviders(cid) {
        findProvidersCalls.push(cid.toString())
        yield {
          id: { toString: () => '12D3KooWStubPeer' },
          multiaddrs: [],
        }
      },
    },
  }
}

// ──────────────────────────────────────────────
// 测试用例
// ──────────────────────────────────────────────

test('注册私域 CID 后 isPrivate 返回 true', async () => {
  const stub = makeStubLibp2p()
  const gate = new DhtGate(stub)

  const cid = await makeCid('private market content')
  assert.equal(gate.isPrivate(cid), false)

  gate.registerPrivateCid(cid, 'market')
  assert.equal(gate.isPrivate(cid), true)
})

test('公共 CID 的 provide 委托给 libp2p', async () => {
  const stub = makeStubLibp2p()
  const gate = new DhtGate(stub)

  const cid = await makeCid('public wiki content')
  await gate.provide(cid)

  assert.equal(stub.provideCalls.length, 1)
  assert.equal(stub.provideCalls[0], cid.toString())
})

test('公共 CID 的 findProviders 委托给 libp2p', async () => {
  const stub = makeStubLibp2p()
  const gate = new DhtGate(stub)

  const cid = await makeCid('public wiki content')
  const providers = []
  for await (const p of gate.findProviders(cid)) {
    providers.push(p)
  }

  assert.equal(providers.length, 1)
  assert.equal(providers[0].id.toString(), '12D3KooWStubPeer')
  assert.equal(stub.findProvidersCalls.length, 1)
})

test('私域 CID 的 provide 抛 PrivateCidRejectedError', async () => {
  const stub = makeStubLibp2p()
  const gate = new DhtGate(stub)

  const cid = await makeCid('private market content')
  gate.registerPrivateCid(cid, 'market')

  await assert.rejects(
    () => gate.provide(cid),
    (err) => {
      assert.ok(err instanceof PrivateCidRejectedError)
      assert.equal(err.operation, 'provide')
      assert.equal(err.cid.toString(), cid.toString())
      assert.match(err.message, /拒绝 provide 操作/)
      assert.match(err.message, /来源: market/)
      return true
    },
  )

  // 确保底层 libp2p 没被调用
  assert.equal(stub.provideCalls.length, 0)
})

test('私域 CID 的 findProviders 抛 PrivateCidRejectedError', async () => {
  const stub = makeStubLibp2p()
  const gate = new DhtGate(stub)

  const cid = await makeCid('private tunnel content')
  gate.registerPrivateCid(cid, 'tunnel')

  await assert.rejects(
    async () => {
      for await (const _ of gate.findProviders(cid)) {
        // 不应进入此循环
      }
    },
    (err) => {
      assert.ok(err instanceof PrivateCidRejectedError)
      assert.equal(err.operation, 'findProviders')
      assert.match(err.message, /来源: tunnel/)
      return true
    },
  )

  assert.equal(stub.findProvidersCalls.length, 0)
})

test('listPrivateCids 返回审计信息', async () => {
  const stub = makeStubLibp2p()
  const gate = new DhtGate(stub)

  const cid1 = await makeCid('market content')
  const cid2 = await makeCid('tunnel content')
  const cid3 = await makeCid('credit content')

  gate.registerPrivateCid(cid1, 'market')
  gate.registerPrivateCid(cid2, 'tunnel')
  gate.registerPrivateCid(cid3, 'credit')

  const list = gate.listPrivateCids()
  assert.equal(list.length, 3)

  const sources = list.map(item => item.source).sort()
  assert.deepEqual(sources, ['credit', 'market', 'tunnel'])

  // 每个 item 应包含 cid 字符串和 source
  for (const item of list) {
    assert.ok(typeof item.cid === 'string')
    assert.ok(typeof item.source === 'string')
  }
})

test('未注册的 CID 视为公共', async () => {
  const stub = makeStubLibp2p()
  const gate = new DhtGate(stub)

  const cid = await makeCid('never registered')
  assert.equal(gate.isPrivate(cid), false)

  // 应该正常委托给 libp2p
  await gate.provide(cid)
  assert.equal(stub.provideCalls.length, 1)
})

test('同一 CID 重复注册不会出错', async () => {
  const stub = makeStubLibp2p()
  const gate = new DhtGate(stub)

  const cid = await makeCid('duplicate')
  gate.registerPrivateCid(cid, 'market')
  gate.registerPrivateCid(cid, 'tunnel')  // 第二次注册覆盖来源

  assert.equal(gate.isPrivate(cid), true)
  const list = gate.listPrivateCids()
  assert.equal(list.length, 1)
  // 第二次注册的 source 覆盖第一次
  assert.equal(list[0].source, 'tunnel')
})
