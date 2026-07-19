/**
 * DHT 门控端到端集成测试
 * ───────────────────────────────────────────────
 * 验证真实双节点场景：
 *   1. 节点 A put 内容到 IPFS，调用 gate.provide(公共CID) → 公告到 DHT
 *   2. 节点 B 通过 gate.findProviders(公共CID) → 找到 A
 *   3. 节点 A 调用 gate.registerPrivateCid(私域CID)
 *   4. 节点 A 调用 gate.provide(私域CID) → 抛 PrivateCidRejectedError
 *   5. 节点 B 调用 gate.findProviders(私域CID) → 抛 PrivateCidRejectedError
 *
 * 此测试需要真实启动两个 helia+libp2p 节点，运行时间约 30-60 秒。
 * 跳过条件：HAVIX_SKIP_E2E=1 时跳过（CI 中可选）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import process from 'node:process'

import { SNode } from '../src/s-node.js'
import { loadConfig } from '../src/config.js'
import { PrivateCidRejectedError } from '../src/network/dht.js'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import * as raw from 'multiformats/codecs/raw'

const SKIP = process.env.HAVIX_SKIP_E2E === '1'

async function makeCid(content = 'hello world') {
  const bytes = new TextEncoder().encode(content)
  const hash = await sha256.digest(bytes)
  return CID.create(1, raw.code, hash)
}

function makeConfig(name, port) {
  const c = loadConfig()
  c.name = name
  c.port = port
  c.logLevel = 'error'  // 静默大部分日志
  c.dataDir = `.data-test-${name}`
  return c
}

test('DHT 门控端到端', { skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用' }, async (t) => {
  const nodeA = new SNode(makeConfig('alpha', 9401))
  const nodeB = new SNode(makeConfig('beta', 9402))

  await t.test('setup: 两个节点启动并互相发现', async () => {
    await nodeA.start()
    await nodeB.start()

    // 等待 mdns 互发现（最多 15 秒）
    for (let i = 0; i < 30; i++) {
      if (nodeA.neighbors.size > 0 && nodeB.neighbors.size > 0) break
      await new Promise(r => setTimeout(r, 500))
    }
    assert.equal(nodeA.neighbors.size, 1, 'alpha 应发现 1 个邻居')
    assert.equal(nodeB.neighbors.size, 1, 'beta 应发现 1 个邻居')
  })

  await t.test('公共 CID 可走 DHT（A.provide → B.findProviders）', async () => {
    const publicCid = await makeCid('public wiki content from alpha')
    // A 公告
    await nodeA.dhtGate.provide(publicCid)
    // B 查询（需要 DHT 路由稳定，最多重试 3 次）
    let found = false
    for (let attempt = 0; attempt < 3 && !found; attempt++) {
      try {
        for await (const _ of nodeB.dhtGate.findProviders(publicCid)) {
          found = true
          break
        }
      } catch {
        await new Promise(r => setTimeout(r, 2000))
      }
    }
    assert.ok(found, 'B 应通过 DHT 找到 A 公告的公共 CID')
  })

  await t.test('私域 CID 在 A 端被门控拦截 provide', async () => {
    const privateCid = await makeCid('private market content')
    nodeA.dhtGate.registerPrivateCid(privateCid, 'market')

    await assert.rejects(
      () => nodeA.dhtGate.provide(privateCid),
      (err) => {
        assert.ok(err instanceof PrivateCidRejectedError)
        assert.equal(err.operation, 'provide')
        return true
      },
    )
  })

  await t.test('私域 CID 在 B 端被门控拦截 findProviders', async () => {
    const privateCid = await makeCid('private tunnel content')
    nodeB.dhtGate.registerPrivateCid(privateCid, 'tunnel')

    await assert.rejects(
      async () => {
        for await (const _ of nodeB.dhtGate.findProviders(privateCid)) {
          // 不应进入
        }
      },
      (err) => {
        assert.ok(err instanceof PrivateCidRejectedError)
        assert.equal(err.operation, 'findProviders')
        return true
      },
    )
  })

  await t.test('teardown: 关闭节点', async () => {
    await nodeA.stop()
    await nodeB.stop()
  })
})
