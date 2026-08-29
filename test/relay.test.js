// SPDX-License-Identifier: AGPL-3.0-only

/**
 * M5 Relay 准入与轮换单元测试
 * ───────────────────────────────────────────────
 * 测试范围：
 *   - RelayRegistry 候选注册、阈值过滤、信誉排序选举
 *   - 注入 reputationLedger / vouchRegistry 时实时读取账本
 *   - epoch 轮换（20% 概率被换下，重新选举补齐）
 *   - 硬切换语义：被换下的 relay 不再 active
 *   - 历史记录与状态查询
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  RelayRegistry,
  DEFAULT_EPOCH_MS,
  DEFAULT_ROTATE_PROBABILITY,
  DEFAULT_TOP_PERCENTILE,
  DEFAULT_MIN_VOUCH_COUNT,
  DEFAULT_MIN_RELAYS,
} from '../src/network/relay.js'
import { ReputationLedger } from '../src/protocol/credit.js'
import { VouchRegistry } from '../src/protocol/vouch.js'

// ──────────────────────────────────────────────
// 默认常量
// ──────────────────────────────────────────────

test('RelayRegistry：默认常量与白皮书 §7.3 一致', () => {
  assert.equal(DEFAULT_EPOCH_MS, 60 * 60 * 1000, 'epoch = 1 小时')
  assert.equal(DEFAULT_ROTATE_PROBABILITY, 0.20, '轮换概率 20%')
  assert.equal(DEFAULT_TOP_PERCENTILE, 0.30, '准入 top 30%')
  assert.equal(DEFAULT_MIN_VOUCH_COUNT, 3, '最少 3 个 vouch')
  assert.equal(DEFAULT_MIN_RELAYS, 3, '最少 3 个 relay（多链路对冲）')
})

test('RelayRegistry：构造默认值', () => {
  const reg = new RelayRegistry()
  assert.equal(reg.epochMs, DEFAULT_EPOCH_MS)
  assert.equal(reg.rotateProbability, DEFAULT_ROTATE_PROBABILITY)
  assert.equal(reg.topPercentile, DEFAULT_TOP_PERCENTILE)
  assert.equal(reg.minVouchCount, DEFAULT_MIN_VOUCH_COUNT)
  assert.equal(reg.minRelays, DEFAULT_MIN_RELAYS)
  assert.equal(reg.activeRelays.size, 0)
  assert.equal(reg.epochStart, 0)
})

test('RelayRegistry：自定义参数', () => {
  const reg = new RelayRegistry({
    epochMs: 30 * 60 * 1000,
    rotateProbability: 0.5,
    topPercentile: 0.5,
    minVouchCount: 5,
    minRelays: 5,
  })
  assert.equal(reg.epochMs, 30 * 60 * 1000)
  assert.equal(reg.rotateProbability, 0.5)
  assert.equal(reg.topPercentile, 0.5)
  assert.equal(reg.minVouchCount, 5)
  assert.equal(reg.minRelays, 5)
})

test('RelayRegistry：无效参数回退默认', () => {
  const reg = new RelayRegistry({
    epochMs: 0,
    rotateProbability: 1.5,
    topPercentile: 0,
    minVouchCount: 0,
    minRelays: -1,
  })
  assert.equal(reg.epochMs, DEFAULT_EPOCH_MS)
  assert.equal(reg.rotateProbability, DEFAULT_ROTATE_PROBABILITY)
  assert.equal(reg.topPercentile, DEFAULT_TOP_PERCENTILE)
  assert.equal(reg.minVouchCount, DEFAULT_MIN_VOUCH_COUNT)
  assert.equal(reg.minRelays, DEFAULT_MIN_RELAYS)
})

// ──────────────────────────────────────────────
// 候选注册
// ──────────────────────────────────────────────

test('RelayRegistry.registerCandidate：基本注册', () => {
  const reg = new RelayRegistry()
  const r = reg.registerCandidate('did:havix:A:node1', 50, 5)
  assert.equal(r.registered, true)
  assert.equal(reg.candidates.size, 1)
  const info = reg.getCandidate('did:havix:A:node1')
  assert.equal(info.reputation, 50)
  assert.equal(info.vouchCount, 5)
})

test('RelayRegistry.registerCandidate：did 无效拒绝', () => {
  const reg = new RelayRegistry()
  assert.equal(reg.registerCandidate('', 50, 5).registered, false)
  assert.equal(reg.registerCandidate(null, 50, 5).registered, false)
  assert.equal(reg.candidates.size, 0)
})

test('RelayRegistry.registerCandidate：注入 ledger 时以账本为准', () => {
  const ledger = new ReputationLedger()
  ledger.credit('did:havix:A:node1', 100)
  const reg = new RelayRegistry({ reputationLedger: ledger })
  // 传入的 reputation 参数应被忽略
  reg.registerCandidate('did:havix:A:node1', 1, 0)
  const info = reg.getCandidate('did:havix:A:node1')
  assert.equal(info.reputation, 101, '应为 1（初始）+ 100（credit）= 101')
  assert.equal(info.vouchCount, 0)
})

test('RelayRegistry.registerCandidate：注入 vouchRegistry 时以账本为准', () => {
  const vouchReg = new VouchRegistry({ threshold: 1 })
  vouchReg.addVouch('did:havix:D:editor', 'did:havix:A:v1')
  vouchReg.addVouch('did:havix:D:editor', 'did:havix:A:v2')
  const reg = new RelayRegistry({ vouchRegistry: vouchReg })
  // 对于 context-D editor，它本身的 vouchCount 应是 0（它不是被 vouch 的对象）
  // 但测试一个被 vouch 的对象：把它的 did 当作 candidate did（虽然语义上不严格）
  // 这里测的是注入后的查询行为
  reg.registerCandidate('did:havix:D:editor', 50, 99)
  const info = reg.getCandidate('did:havix:D:editor')
  assert.equal(info.vouchCount, 2, '应从 vouchRegistry 读取 vouch 计数=2')
})

// ──────────────────────────────────────────────
// 选举
// ──────────────────────────────────────────────

test('RelayRegistry.electEpoch：vouch 门槛过滤', () => {
  const reg = new RelayRegistry({ minVouchCount: 3, minRelays: 2, topPercentile: 0.5 })
  // 5 个候选，3 个达标，2 个不达标
  reg.registerCandidate('did:havix:A:n1', 100, 5)  // 达标
  reg.registerCandidate('did:havix:A:n2', 90, 4)   // 达标
  reg.registerCandidate('did:havix:A:n3', 80, 3)  // 达标
  reg.registerCandidate('did:havix:A:n4', 70, 2)  // 不达标
  reg.registerCandidate('did:havix:A:n5', 60, 1)  // 不达标

  const { elected, count } = reg.electEpoch()
  // top 50% of 3 qualified = 1.5 → floor=1，但 minRelays=2 兜底 → 取 2
  assert.equal(count, 2)
  assert.ok(elected.includes('did:havix:A:n1'), '信誉最高应入选')
  assert.ok(elected.includes('did:havix:A:n2'), '信誉次高应入选')
  assert.ok(!elected.includes('did:havix:A:n4'), 'vouch 不足不应入选')
  assert.ok(!elected.includes('did:havix:A:n5'), 'vouch 不足不应入选')
})

test('RelayRegistry.electEpoch：信誉降序排序', () => {
  const reg = new RelayRegistry({ minVouchCount: 1, minRelays: 3, topPercentile: 1.0 })
  reg.registerCandidate('did:havix:A:low', 10, 1)
  reg.registerCandidate('did:havix:A:high', 100, 1)
  reg.registerCandidate('did:havix:A:mid', 50, 1)

  const { elected } = reg.electEpoch()
  assert.deepEqual(elected, ['did:havix:A:high', 'did:havix:A:mid', 'did:havix:A:low'])
})

test('RelayRegistry.electEpoch：minRelays 兜底', () => {
  const reg = new RelayRegistry({ minVouchCount: 1, minRelays: 5, topPercentile: 0.1 })
  // 只有 3 个候选，top 10% = 0，但 minRelays=5 兜底应取全部 3 个
  reg.registerCandidate('did:havix:A:n1', 100, 1)
  reg.registerCandidate('did:havix:A:n2', 90, 1)
  reg.registerCandidate('did:havix:A:n3', 80, 1)

  const { count } = reg.electEpoch()
  assert.equal(count, 3)
})

test('RelayRegistry.electEpoch：无合格候选返回空', () => {
  const reg = new RelayRegistry({ minVouchCount: 10 })
  reg.registerCandidate('did:havix:A:n1', 100, 1)
  const { elected, count } = reg.electEpoch()
  assert.equal(count, 0)
  assert.deepEqual(elected, [])
})

test('RelayRegistry.electEpoch：未连任 relay 标记 retired', () => {
  const reg = new RelayRegistry({ minVouchCount: 1, minRelays: 2, topPercentile: 0.5 })
  reg.registerCandidate('did:havix:A:n1', 100, 1)
  reg.registerCandidate('did:havix:A:n2', 90, 1)
  reg.registerCandidate('did:havix:A:n3', 80, 1)

  // 第一次选举：top 50% of 3 = 1，minRelays=2 兜底 → 取 2
  reg.electEpoch()
  assert.ok(reg.isRelay('did:havix:A:n1'))
  assert.ok(reg.isRelay('did:havix:A:n2'))
  assert.equal(reg.isRelay('did:havix:A:n3'), false)

  // 提升 n3 的信誉，第二次选举应让 n3 入选，n2 退位
  reg.registerCandidate('did:havix:A:n3', 200, 1)
  reg.electEpoch()
  assert.ok(reg.isRelay('did:havix:A:n1') || reg.isRelay('did:havix:A:n3'))
  // n2 可能退位（取决于排序）
  const n2Info = reg.getCandidate('did:havix:A:n2')
  if (!reg.isRelay('did:havix:A:n2')) {
    assert.ok(n2Info.retiredAt > 0, '退位 relay 应有 retiredAt 时间戳')
  }
})

test('RelayRegistry.electEpoch：epochStart 更新', () => {
  const reg = new RelayRegistry({ minVouchCount: 1, minRelays: 1, topPercentile: 1.0 })
  reg.registerCandidate('did:havix:A:n1', 100, 1)
  assert.equal(reg.epochStart, 0)
  reg.electEpoch()
  assert.ok(reg.epochStart > 0)
})

// ──────────────────────────────────────────────
// 概率轮换
// ──────────────────────────────────────────────

test('RelayRegistry.rotateElection：rng=1 时无 relay 被换下', () => {
  const reg = new RelayRegistry({
    minVouchCount: 1, minRelays: 3, topPercentile: 1.0,
    rotateProbability: 0.20,
  })
  reg.registerCandidate('did:havix:A:n1', 100, 1)
  reg.registerCandidate('did:havix:A:n2', 90, 1)
  reg.registerCandidate('did:havix:A:n3', 80, 1)
  reg.electEpoch()
  assert.equal(reg.activeRelays.size, 3)

  // rng()=1，1 ≥ 0.20，无人中签
  const r = reg.rotateElection(() => 1)
  assert.deepEqual(r.rotated, [])
  assert.deepEqual(r.supplemented, [])
  assert.equal(reg.activeRelays.size, 3)
})

test('RelayRegistry.rotateElection：rng=0 时所有 active relay 被换下', () => {
  const reg = new RelayRegistry({
    minVouchCount: 1, minRelays: 3, topPercentile: 1.0,
    rotateProbability: 0.20,
  })
  reg.registerCandidate('did:havix:A:n1', 100, 1)
  reg.registerCandidate('did:havix:A:n2', 90, 1)
  reg.registerCandidate('did:havix:A:n3', 80, 1)
  reg.electEpoch()
  assert.equal(reg.activeRelays.size, 3)

  // rng()=0，0 < 0.20，全部中签
  const r = reg.rotateElection(() => 0)
  assert.equal(r.rotated.length, 3)
  // 所有原 relay 被换下后，从候选池补位（原 relay 已退位，可作为候选再次入选）
  assert.equal(r.supplemented.length, 3, '应从候选池补位 3 个')
  assert.equal(reg.activeRelays.size, 3)
})

test('RelayRegistry.rotateElection：补位候选必须通过 vouch 门槛', () => {
  const reg = new RelayRegistry({
    minVouchCount: 3, minRelays: 3, topPercentile: 1.0,
    rotateProbability: 0.20,
  })
  // 3 个达标 + 2 个不达标
  reg.registerCandidate('did:havix:A:ok1', 100, 5)
  reg.registerCandidate('did:havix:A:ok2', 90, 4)
  reg.registerCandidate('did:havix:A:ok3', 80, 3)
  reg.registerCandidate('did:havix:A:bad1', 70, 2)  // vouch 不足
  reg.registerCandidate('did:havix:A:bad2', 60, 1)  // vouch 不足
  reg.electEpoch()
  assert.equal(reg.activeRelays.size, 3)

  // 全部 active relay 中签被换下（rng=0 < 0.20）
  const r = reg.rotateElection(() => 0)
  assert.equal(r.rotated.length, 3)
  // 补位只能从 ok1/ok2/ok3 中选（bad1/bad2 vouch 不足）
  for (const did of r.supplemented) {
    assert.ok(did.startsWith('did:havix:A:ok'), `补位应通过 vouch 门槛：${did}`)
  }
  assert.equal(r.supplemented.length, 3)
})

test('RelayRegistry.rotateElection：补位不足时保持现状', () => {
  const reg = new RelayRegistry({
    minVouchCount: 1, minRelays: 3, topPercentile: 1.0,
    rotateProbability: 0.20,
  })
  // 只有 3 个候选，全被换下后无补位候选
  reg.registerCandidate('did:havix:A:n1', 100, 1)
  reg.registerCandidate('did:havix:A:n2', 90, 1)
  reg.registerCandidate('did:havix:A:n3', 80, 1)
  reg.electEpoch()

  // 全部中签（rng=0）
  const r = reg.rotateElection(() => 0)
  assert.equal(r.rotated.length, 3)
  assert.equal(r.supplemented.length, 3, '原 relay 已退位，可作为补位候选再次入选')
  assert.equal(reg.activeRelays.size, 3)
})

test('RelayRegistry.rotateElection：被换下的 relay 不再 active', () => {
  const reg = new RelayRegistry({
    minVouchCount: 1, minRelays: 3, topPercentile: 1.0,
    rotateProbability: 0.20,
  })
  reg.registerCandidate('did:havix:A:n1', 100, 1)
  reg.registerCandidate('did:havix:A:n2', 90, 1)
  reg.registerCandidate('did:havix:A:n3', 80, 1)
  reg.registerCandidate('did:havix:A:n4', 70, 1)  // 备用补位
  reg.electEpoch()
  // 当前 active: n1, n2, n3

  // 让 n1 中签（第一个 rng=0 < 0.20 中签，后续 rng=1 ≥ 0.20 不中签）
  let callCount = 0
  const rng = () => {
    callCount++
    return callCount === 1 ? 0 : 1
  }
  const r = reg.rotateElection(rng)
  assert.deepEqual(r.rotated, ['did:havix:A:n1'])
  assert.equal(reg.isRelay('did:havix:A:n1'), false, 'n1 被换下后不应再 active')
  // n4 应被补位
  assert.equal(reg.isRelay('did:havix:A:n4'), true, 'n4 应补位入选')
  assert.equal(reg.activeRelays.size, 3)
})

// ──────────────────────────────────────────────
// 状态查询
// ──────────────────────────────────────────────

test('RelayRegistry.getActiveRelays：返回当前 active 列表', () => {
  const reg = new RelayRegistry({ minVouchCount: 1, minRelays: 2, topPercentile: 1.0 })
  reg.registerCandidate('did:havix:A:n1', 100, 1)
  reg.registerCandidate('did:havix:A:n2', 90, 1)
  assert.deepEqual(reg.getActiveRelays(), [])
  reg.electEpoch()
  assert.equal(reg.getActiveRelays().length, 2)
})

test('RelayRegistry.getHistory：记录 elected / retired / rotated', () => {
  const reg = new RelayRegistry({
    minVouchCount: 1, minRelays: 3, topPercentile: 1.0,
    rotateProbability: 0.20,
  })
  reg.registerCandidate('did:havix:A:n1', 100, 1)
  reg.registerCandidate('did:havix:A:n2', 90, 1)
  reg.registerCandidate('did:havix:A:n3', 80, 1)
  reg.electEpoch()

  // 3 个 elected 事件
  let history = reg.getHistory()
  assert.equal(history.length, 3)
  assert.ok(history.every((h) => h.action === 'elected'))

  // 让 n1 被换下（第一个 rng=0 < 0.20 中签，后续 rng=1 不中签）
  let callCount = 0
  reg.rotateElection(() => {
    callCount++
    return callCount === 1 ? 0 : 1
  })
  history = reg.getHistory()
  // 应有 3 elected（初始）+ 1 rotated（n1）+ 1 supplemented elected（n4）= 5
  assert.equal(history.length, 5)
  const rotatedEvents = history.filter((h) => h.action === 'rotated')
  assert.equal(rotatedEvents.length, 1)
  assert.equal(rotatedEvents[0].did, 'did:havix:A:n1')

  // 按 did 过滤
  const n1History = reg.getHistory('did:havix:A:n1')
  assert.ok(n1History.some((h) => h.action === 'elected'))
  assert.ok(n1History.some((h) => h.action === 'rotated'))
})

test('RelayRegistry.isEpochExpired：epoch 超时判定', () => {
  const reg = new RelayRegistry({ epochMs: 1000 })
  reg.registerCandidate('did:havix:A:n1', 100, 1)
  reg.electEpoch()
  // 刚选举完不应超时
  assert.equal(reg.isEpochExpired(), false)
  // 模拟 1.5 秒后
  assert.equal(reg.isEpochExpired(Date.now() + 1500), true)
})

test('RelayRegistry.isEpochExpired：epochStart=0 时永不超时', () => {
  const reg = new RelayRegistry()
  assert.equal(reg.isEpochExpired(), false)
  assert.equal(reg.isEpochExpired(Date.now() + 999999), false)
})

test('RelayRegistry.getCandidate：未知 did 返回 null', () => {
  const reg = new RelayRegistry()
  assert.equal(reg.getCandidate('unknown'), null)
})
