/**
 * 审计修复测试（M8 集成前深度审计）
 * ───────────────────────────────────────────────
 * 测试范围：
 *   - P2-1: start() 失败时回滚已启动的资源（调用 stop() 清理）
 *
 * 其他 P0/P1 修复的测试已分别落在对应模块的测试文件中：
 *   - P0-1 canonical message 签名 → identity-signing-e2e / vouch / wiki 测试
 *   - P0-2 credit note 内层签名 → credit.test.js
 *   - P0-3 topic 前缀分流 → market.test.js（间接）
 *   - P0-4 InviteToken.verifySelf → market.test.js
 *   - P0-5 handler try/catch → s-node 集成测试
 *   - P0-6 slash 0 守卫 → arbitration.test.js
 *   - P1-arb-mirror senderId 镜像 → arbitration.test.js
 *   - P1-market-gate min_reputation → market.test.js
 *   - P1-faucet 原子性 → credit.test.js
 *   - P1-bounds / P1-lru / P1-threshold → 各模块单元测试
 *
 * 注意：本测试不启动真实 libp2p，只验证 start() 的回滚契约。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SNode } from '../src/s-node.js'

// ──────────────────────────────────────────────
// P2-1: start() 失败回滚
// ──────────────────────────────────────────────

test('P2-1: start() 失败时调用 stop() 回滚已启动资源', async () => {
  const node = new SNode({ logLevel: 'error', port: 0 })

  // 跟踪 stop() 是否被调用
  let stopCalled = false
  node.stop = async () => {
    stopCalled = true
  }

  // stub _startInternal 抛错（模拟 ipfs.start() 之后的步骤失败）
  node._startInternal = async () => {
    throw new Error('mocked _startInternal failure')
  }

  // start() 应当抛出 _startInternal 的错误
  await assert.rejects(
    () => node.start(),
    /mocked _startInternal failure/,
    'start() 应将 _startInternal 的错误重新抛出',
  )

  assert.equal(stopCalled, true, 'start() 失败时应调用 stop() 进行回滚')
})

test('P2-1: stop() 自身异常也不应掩盖原始错误', async () => {
  const node = new SNode({ logLevel: 'error', port: 0 })

  // stop() 也抛错
  node.stop = async () => {
    throw new Error('stop also failed')
  }

  node._startInternal = async () => {
    throw new Error('original failure')
  }

  // 应当抛出原始错误，而不是 stop() 的错误
  await assert.rejects(
    () => node.start(),
    /original failure/,
    'start() 失败时应抛出原始错误，不被 stop() 的异常掩盖',
  )
})

test('P2-1: _startInternal 成功时 start() 不调用 stop()', async () => {
  const node = new SNode({ logLevel: 'error', port: 0 })

  let stopCalled = false
  node.stop = async () => {
    stopCalled = true
  }

  // _startInternal 成功完成（不抛错）
  let internalCalled = false
  node._startInternal = async () => {
    internalCalled = true
  }

  await node.start()

  assert.equal(internalCalled, true, '_startInternal 应被调用')
  assert.equal(stopCalled, false, '_startInternal 成功时不应调用 stop()')
})
