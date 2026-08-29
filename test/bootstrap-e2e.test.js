// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bootstrap 跨网段引导端到端测试
 * ───────────────────────────────────────────────
 * 验证场景：
 *   - 节点 A 启动（禁用 mdns，监听固定端口）
 *   - 节点 B 启动（禁用 mdns，通过 --bootstrap 指定 A 的 multiaddr）
 *   - 验证 B 通过手动引导连接到 A（不靠 mDNS）
 *
 * 这个测试模拟跨网段场景：两个节点无法通过 mDNS 互发现，
 * 只能通过显式的 multiaddr 引导连接。
 *
 * 跳过条件：HAVIX_SKIP_E2E=1 时跳过
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import process from 'node:process'

import { SNode } from '../src/s-node.js'
import { loadConfig } from '../src/config.js'

const SKIP = process.env.HAVIX_SKIP_E2E === '1'

function makeConfig(name, port, extra = {}) {
  const c = loadConfig()
  c.name = name
  c.port = port
  c.logLevel = 'error'  // 静默大部分日志
  c.dataDir = `.data-test-${name}-${port}`
  c.mdns = false        // 关键：禁用 mDNS，强制走 bootstrap
  Object.assign(c, extra)
  return c
}

test('Bootstrap 跨网段引导', { skip: SKIP && '设置 HAVIX_SKIP_E2E=0 启用' }, async (t) => {
  let nodeA, nodeB

  await t.test('setup: 节点 A 启动（无引导、无 mdns）', async () => {
    nodeA = new SNode(makeConfig('alpha', 9701))
    await nodeA.start()
    assert.ok(nodeA.peerId, 'A 应有 peerId')
    assert.equal(nodeA.neighbors.size, 0, 'A 初始无邻居')
  })

  await t.test('setup: 节点 B 通过 bootstrap 连接到 A', async () => {
    // 构造 A 的 multiaddr
    const aMultiaddr = `/ip4/127.0.0.1/tcp/9701/p2p/${nodeA.peerId.toString()}`

    nodeB = new SNode(makeConfig('beta', 9702, {
      bootstrap: [aMultiaddr],
    }))
    await nodeB.start()

    // B 应该在几秒内通过 bootstrap 连上 A
    for (let i = 0; i < 20; i++) {
      if (nodeB.neighbors.size > 0) break
      await new Promise(r => setTimeout(r, 500))
    }
    assert.equal(nodeB.neighbors.size, 1, 'B 应通过 bootstrap 连接到 1 个邻居')

    // A 端也应感知到 B 的连接（反向连接）
    for (let i = 0; i < 10; i++) {
      if (nodeA.neighbors.size > 0) break
      await new Promise(r => setTimeout(r, 500))
    }
    assert.equal(nodeA.neighbors.size, 1, 'A 应感知到 B 的连接')
  })

  await t.test('bootstrap 配置无效 multiaddr 时打印警告但不崩溃', async () => {
    // 构造一个无效的 multiaddr 引导（端口不存在）
    const badMultiaddr = `/ip4/127.0.0.1/tcp/9999/p2p/${nodeA.peerId.toString()}`

    const nodeC = new SNode(makeConfig('gamma', 9703, {
      bootstrap: [badMultiaddr],
    }))
    // 启动不应抛错
    await nodeC.start()

    // 给 dial 超时一点时间（5 秒超时）
    await new Promise(r => setTimeout(r, 6_000))

    // C 应当没成功连接（因为端口 9999 没人监听）
    assert.equal(nodeC.neighbors.size, 0, 'C 不应连接到无效引导节点')

    await nodeC.stop()
  })

  await t.test('teardown: 关闭节点', async () => {
    if (nodeA) await nodeA.stop()
    if (nodeB) await nodeB.stop()
  })
})
