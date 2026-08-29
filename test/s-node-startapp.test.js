// SPDX-License-Identifier: AGPL-3.0-only

/**
 * M8.2-5 集成测试：startApp() 启停顺序 + 配置开关
 * ───────────────────────────────────────────────
 * 测试策略：
 *   - 通过 deps 注入 fake SNode/Cli/WebPanel/process
 *   - 不依赖真实 libp2p / helia
 *   - 验证启动顺序、退出顺序、配置开关、错误处理
 *
 * 测试覆盖：
 *   - 默认配置（repl=true + web=true）：3 个组件都启动，退出顺序正确
 *   - --no-repl：Cli 不启动
 *   - --no-web：WebPanel 不启动
 *   - --no-repl --no-web：仅 SNode 启动
 *   - SNode.start() 失败：抛错（测试模式）+ 不启动 Cli/WebPanel
 *   - WebPanel.start() 失败：不阻断，Cli 仍启动
 *   - Cli.start() 失败：不阻断 stop() 流程
 *   - stop() 幂等
 *   - SIGINT/SIGTERM 触发 stop
 *   - stdout 输出包含 banner + config 信息
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { startApp } from '../src/s-node.js'
import { loadConfig, DEFAULT_CONFIG } from '../src/config.js'

// ──────────────────────────────────────────────
// fake SNode / Cli / WebPanel
// ──────────────────────────────────────────────

class FakeSNode {
  constructor(config) {
    this.config = config
    this.startCalls = 0
    this.stopCalls = 0
    this.log = () => {}
    // 暴露给 WebPanel / Cli 的字段（防止 _apiStatus 等访问崩溃）
    this.libp2p = null
    this.wallet = null
    this.vouchRegistry = null
    this.wiki = null
    this.reputationLedger = null
    this.creditLedger = null
    this.arbitrationRegistry = null
    this.marketRegistry = null
    this.treasury = null
    this.tunnelManager = null
    this.relayRegistry = null
    this._processedCreditNonces = null
  }
  async start() {
    this.startCalls++
    if (FakeSNode.nextStartThrows) {
      throw new Error(FakeSNode.nextStartThrows)
    }
  }
  async stop() {
    this.stopCalls++
  }
}
FakeSNode.nextStartThrows = null

class FakeCli {
  constructor(node, opts) {
    this.node = node
    this.opts = opts
    this.startCalls = 0
    this.stopCalls = 0
  }
  start() {
    this.startCalls++
    if (FakeCli.nextStartThrows) {
      throw new Error(FakeCli.nextStartThrows)
    }
  }
  async stop() {
    this.stopCalls++
  }
}
FakeCli.nextStartThrows = null

class FakeWebPanel {
  constructor(node, opts) {
    this.node = node
    this.opts = opts
    this.startCalls = 0
    this.stopCalls = 0
    this.actualPort = opts?.port ?? 7331
  }
  async start() {
    this.startCalls++
    if (FakeWebPanel.nextStartThrows) {
      throw new Error(FakeWebPanel.nextStartThrows)
    }
    return { host: this.opts.host, port: this.actualPort }
  }
  async stop() {
    this.stopCalls++
  }
  getActualPort() {
    return this.actualPort
  }
  getUrl() {
    return `http://${this.opts.host}:${this.actualPort}/`
  }
}
FakeWebPanel.nextStartThrows = null

// fake process：EventEmitter + exit 标记
function makeFakeProcess() {
  const emitter = new EventEmitter()
  emitter.exit = (code) => { emitter.exitCode = code }
  emitter.exitCode = null
  return emitter
}

// 内存 stdout：收集所有写入
function makeMemoryStdout() {
  const chunks = []
  return {
    write: (s) => { chunks.push(s); return true },
    isTTY: false,
    _captured: () => chunks.join(''),
    _chunks: chunks,
  }
}

// ──────────────────────────────────────────────
// 默认配置
// ──────────────────────────────────────────────

function makeTestConfig(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    name: 'test-node',
    port: 0,
    dataDir: '.test-data',
    bootstrap: [],
    repl: true,
    web: true,
    webPort: 0,  // 0 = 系统分配（但 fake 不实际绑定）
    webHost: '127.0.0.1',
    ...overrides,
  }
}

// 每个测试前重置 fake 的 throw 标记
function resetFakes() {
  FakeSNode.nextStartThrows = null
  FakeCli.nextStartThrows = null
  FakeWebPanel.nextStartThrows = null
}

// ──────────────────────────────────────────────
// 启动顺序
// ──────────────────────────────────────────────

test('默认配置：SNode / WebPanel / Cli 都启动', async () => {
  resetFakes()
  const proc = makeFakeProcess()
  const stdout = makeMemoryStdout()
  const { node, cli, webPanel } = await startApp(makeTestConfig(), {
    SNode: FakeSNode,
    Cli: FakeCli,
    WebPanel: FakeWebPanel,
    process: proc,
    stdout,
  })

  assert.ok(node instanceof FakeSNode)
  assert.ok(cli instanceof FakeCli)
  assert.ok(webPanel instanceof FakeWebPanel)
  assert.equal(node.startCalls, 1)
  assert.equal(webPanel.startCalls, 1)
  assert.equal(cli.startCalls, 1)
})

test('启动顺序：SNode → WebPanel → Cli', async () => {
  resetFakes()
  const proc = makeFakeProcess()
  const stdout = makeMemoryStdout()
  const order = []

  class TrackedSNode extends FakeSNode {
    async start() { order.push('SNode.start'); await super.start() }
    async stop() { order.push('SNode.stop'); await super.stop() }
  }
  class TrackedCli extends FakeCli {
    start() { order.push('Cli.start'); super.start() }
    async stop() { order.push('Cli.stop'); await super.stop() }
  }
  class TrackedWebPanel extends FakeWebPanel {
    async start() { order.push('WebPanel.start'); return await super.start() }
    async stop() { order.push('WebPanel.stop'); await super.stop() }
  }

  const { stop } = await startApp(makeTestConfig(), {
    SNode: TrackedSNode,
    Cli: TrackedCli,
    WebPanel: TrackedWebPanel,
    process: proc,
    stdout,
  })

  await stop()

  assert.deepEqual(order, [
    'SNode.start', 'WebPanel.start', 'Cli.start',
    'Cli.stop', 'WebPanel.stop', 'SNode.stop',
  ])
})

test('stdout 输出包含 banner + config 字段', async () => {
  resetFakes()
  const proc = makeFakeProcess()
  const stdout = makeMemoryStdout()
  await startApp(makeTestConfig({ name: 'my-node', port: 12345 }), {
    SNode: FakeSNode,
    Cli: FakeCli,
    WebPanel: FakeWebPanel,
    process: proc,
    stdout,
  })

  const text = stdout._captured()
  assert.match(text, /Havix — Haven of Affinity/)
  assert.match(text, /M8 · CLI \+ Web 面板/)
  assert.match(text, /\[config\] name\s+= my-node/)
  assert.match(text, /\[config\] port\s+= 12345/)
  assert.match(text, /\[config\] repl\s+= true/)
  assert.match(text, /\[config\] web\s+= true/)
  assert.match(text, /\[web-panel\] 监听 http:\/\/127\.0\.0\.1:\d+/)
  assert.match(text, /\[cli\] REPL 已启动/)
})

// ──────────────────────────────────────────────
// 配置开关
// ──────────────────────────────────────────────

test('--no-repl：Cli 不启动，WebPanel 仍启动', async () => {
  resetFakes()
  const proc = makeFakeProcess()
  const stdout = makeMemoryStdout()
  const { cli, webPanel } = await startApp(makeTestConfig({ repl: false }), {
    SNode: FakeSNode,
    Cli: FakeCli,
    WebPanel: FakeWebPanel,
    process: proc,
    stdout,
  })

  assert.equal(cli, null)
  assert.ok(webPanel instanceof FakeWebPanel)
  assert.equal(webPanel.startCalls, 1)
  assert.match(stdout._captured(), /REPL 已禁用/)
})

test('--no-web：WebPanel 不启动，Cli 仍启动', async () => {
  resetFakes()
  const proc = makeFakeProcess()
  const stdout = makeMemoryStdout()
  const { cli, webPanel } = await startApp(makeTestConfig({ web: false }), {
    SNode: FakeSNode,
    Cli: FakeCli,
    WebPanel: FakeWebPanel,
    process: proc,
    stdout,
  })

  assert.equal(webPanel, null)
  assert.ok(cli instanceof FakeCli)
  assert.equal(cli.startCalls, 1)
  assert.match(stdout._captured(), /已禁用（--no-web）/)
})

test('--no-repl --no-web：仅 SNode 启动', async () => {
  resetFakes()
  const proc = makeFakeProcess()
  const stdout = makeMemoryStdout()
  const { node, cli, webPanel } = await startApp(
    makeTestConfig({ repl: false, web: false }),
    {
      SNode: FakeSNode,
      Cli: FakeCli,
      WebPanel: FakeWebPanel,
      process: proc,
      stdout,
    },
  )

  assert.ok(node instanceof FakeSNode)
  assert.equal(node.startCalls, 1)
  assert.equal(cli, null)
  assert.equal(webPanel, null)
})

test('--web-host / --web-port 传给 WebPanel', async () => {
  resetFakes()
  const proc = makeFakeProcess()
  const stdout = makeMemoryStdout()
  const { webPanel } = await startApp(
    makeTestConfig({ webHost: '127.0.0.1', webPort: 9999 }),
    {
      SNode: FakeSNode,
      Cli: FakeCli,
      WebPanel: FakeWebPanel,
      process: proc,
      stdout,
    },
  )

  assert.equal(webPanel.opts.host, '127.0.0.1')
  assert.equal(webPanel.opts.port, 9999)
})

// ──────────────────────────────────────────────
// 退出顺序
// ──────────────────────────────────────────────

test('stop() 顺序：Cli → WebPanel → SNode', async () => {
  resetFakes()
  const proc = makeFakeProcess()
  const stdout = makeMemoryStdout()
  const { node, cli, webPanel, stop } = await startApp(makeTestConfig(), {
    SNode: FakeSNode,
    Cli: FakeCli,
    WebPanel: FakeWebPanel,
    process: proc,
    stdout,
  })

  await stop()

  assert.equal(cli.stopCalls, 1)
  assert.equal(webPanel.stopCalls, 1)
  assert.equal(node.stopCalls, 1)
})

test('stop() 幂等：第二次调用不重复执行', async () => {
  resetFakes()
  const proc = makeFakeProcess()
  const stdout = makeMemoryStdout()
  const { node, cli, webPanel, stop } = await startApp(makeTestConfig(), {
    SNode: FakeSNode,
    Cli: FakeCli,
    WebPanel: FakeWebPanel,
    process: proc,
    stdout,
  })

  await stop()
  await stop()

  assert.equal(cli.stopCalls, 1)
  assert.equal(webPanel.stopCalls, 1)
  assert.equal(node.stopCalls, 1)
})

test('stop() 各组件抛错也走完所有组件', async () => {
  resetFakes()
  const proc = makeFakeProcess()
  const stdout = makeMemoryStdout()

  class ErrCli extends FakeCli {
    async stop() { throw new Error('cli stop boom') }
  }
  class ErrWebPanel extends FakeWebPanel {
    async stop() { throw new Error('web stop boom') }
  }
  class ErrSNode extends FakeSNode {
    async stop() { throw new Error('node stop boom') }
  }

  const { stop } = await startApp(makeTestConfig(), {
    SNode: ErrSNode,
    Cli: ErrCli,
    WebPanel: ErrWebPanel,
    process: proc,
    stdout,
  })

  // 不抛错，错误被捕获打印
  await stop()
  const text = stdout._captured()
  assert.match(text, /cli\.stop 异常: cli stop boom/)
  assert.match(text, /webPanel\.stop 异常: web stop boom/)
  assert.match(text, /node\.stop 异常: node stop boom/)
})

test('--no-repl 模式 stop() 跳过 Cli', async () => {
  resetFakes()
  const proc = makeFakeProcess()
  const stdout = makeMemoryStdout()
  const { node, webPanel, stop } = await startApp(makeTestConfig({ repl: false }), {
    SNode: FakeSNode,
    Cli: FakeCli,
    WebPanel: FakeWebPanel,
    process: proc,
    stdout,
  })

  await stop()
  assert.equal(webPanel.stopCalls, 1)
  assert.equal(node.stopCalls, 1)
})

// ──────────────────────────────────────────────
// 错误处理
// ──────────────────────────────────────────────

test('SNode.start() 失败：抛错（测试模式）', async () => {
  resetFakes()
  FakeSNode.nextStartThrows = 'libp2p dial failed'
  const proc = makeFakeProcess()
  const stdout = makeMemoryStdout()

  await assert.rejects(
    () => startApp(makeTestConfig(), {
      SNode: FakeSNode,
      Cli: FakeCli,
      WebPanel: FakeWebPanel,
      process: proc,
      stdout,
    }),
    /libp2p dial failed/,
  )
  // 不应该启动 Cli / WebPanel
  assert.match(stdout._captured(), /SNode 启动失败/)
})

test('WebPanel.start() 失败：不阻断，Cli 仍启动', async () => {
  resetFakes()
  FakeWebPanel.nextStartThrows = 'EADDRINUSE'
  const proc = makeFakeProcess()
  const stdout = makeMemoryStdout()

  const { cli, webPanel } = await startApp(makeTestConfig(), {
    SNode: FakeSNode,
    Cli: FakeCli,
    WebPanel: FakeWebPanel,
    process: proc,
    stdout,
  })

  // webPanel 引用被清空（标记为启动失败）
  assert.equal(webPanel, null)
  // 但 Cli 仍然启动
  assert.ok(cli instanceof FakeCli)
  assert.equal(cli.startCalls, 1)
  assert.match(stdout._captured(), /web-panel.*启动失败/)
})

test('Cli.start() 失败：不阻断，stop() 仍能正常执行', async () => {
  resetFakes()
  FakeCli.nextStartThrows = 'readline init failed'
  const proc = makeFakeProcess()
  const stdout = makeMemoryStdout()

  const { node, webPanel, stop } = await startApp(makeTestConfig(), {
    SNode: FakeSNode,
    Cli: FakeCli,
    WebPanel: FakeWebPanel,
    process: proc,
    stdout,
  })

  assert.match(stdout._captured(), /REPL 启动失败/)

  // stop() 仍能正常退出
  await stop()
  assert.equal(webPanel.stopCalls, 1)
  assert.equal(node.stopCalls, 1)
})

// ──────────────────────────────────────────────
// 信号处理
// ──────────────────────────────────────────────

test('SIGINT 触发 stop()', async () => {
  resetFakes()
  const proc = makeFakeProcess()
  const stdout = makeMemoryStdout()
  const { node, stop } = await startApp(makeTestConfig(), {
    SNode: FakeSNode,
    Cli: FakeCli,
    WebPanel: FakeWebPanel,
    process: proc,
    stdout,
  })

  // 直接调用 stop 等价于 SIGINT 触发
  await stop('SIGINT')

  assert.equal(node.stopCalls, 1)
  assert.match(stdout._captured(), /received SIGINT/)
})

test('SIGTERM 触发 stop()', async () => {
  resetFakes()
  const proc = makeFakeProcess()
  const stdout = makeMemoryStdout()
  const { node, stop } = await startApp(makeTestConfig(), {
    SNode: FakeSNode,
    Cli: FakeCli,
    WebPanel: FakeWebPanel,
    process: proc,
    stdout,
  })

  await stop('SIGTERM')

  assert.equal(node.stopCalls, 1)
  assert.match(stdout._captured(), /received SIGTERM/)
})

test('process.on 注册了 SIGINT / SIGTERM', async () => {
  resetFakes()
  const proc = makeFakeProcess()
  const stdout = makeMemoryStdout()
  await startApp(makeTestConfig(), {
    SNode: FakeSNode,
    Cli: FakeCli,
    WebPanel: FakeWebPanel,
    process: proc,
    stdout,
  })

  // EventEmitter 的 listenerCount 可查
  assert.ok(proc.listenerCount('SIGINT') >= 1)
  assert.ok(proc.listenerCount('SIGTERM') >= 1)
})

test('通过 EventEmitter.emit 触发 SIGINT 等价于直接调用 stop', async () => {
  resetFakes()
  const proc = makeFakeProcess()
  const stdout = makeMemoryStdout()
  const { node } = await startApp(makeTestConfig(), {
    SNode: FakeSNode,
    Cli: FakeCli,
    WebPanel: FakeWebPanel,
    process: proc,
    stdout,
  })

  // 模拟 OS 发信号
  proc.emit('SIGINT')
  // 等 stop() 异步完成
  await new Promise((r) => setImmediate(r))
  // 给 stop 内部 await 一点时间
  await new Promise((r) => setTimeout(r, 10))

  assert.equal(node.stopCalls, 1)
  assert.match(stdout._captured(), /received SIGINT/)
})

// ──────────────────────────────────────────────
// config.js 集成
// ──────────────────────────────────────────────

test('DEFAULT_CONFIG 包含 M8.2 应用层字段', () => {
  assert.equal(DEFAULT_CONFIG.repl, true)
  assert.equal(DEFAULT_CONFIG.web, true)
  assert.equal(DEFAULT_CONFIG.webPort, 7331)
  assert.equal(DEFAULT_CONFIG.webHost, '127.0.0.1')
})

test('loadConfig 默认开启 repl + web', () => {
  // 清掉可能影响测试的环境变量
  const oldEnv = { ...process.env }
  delete process.env.HAVIX_REPL
  delete process.env.HAVIX_WEB
  delete process.env.HAVIX_WEB_PORT
  delete process.env.HAVIX_WEB_HOST
  // 用空 argv 避免 main 流程参数干扰
  const origArgv = process.argv
  process.argv = ['node', 's-node.js']

  try {
    const c = loadConfig()
    assert.equal(c.repl, true)
    assert.equal(c.web, true)
    assert.equal(c.webPort, 7331)
    assert.equal(c.webHost, '127.0.0.1')
  } finally {
    process.argv = origArgv
    // 恢复环境变量
    for (const k of Object.keys(oldEnv)) process.env[k] = oldEnv[k]
  }
})

test('parseArgv：--no-repl 关闭 REPL', () => {
  const origArgv = process.argv
  process.argv = ['node', 's-node.js', '--no-repl']
  try {
    const c = loadConfig()
    assert.equal(c.repl, false)
    assert.equal(c.web, true)  // 默认值
  } finally {
    process.argv = origArgv
  }
})

test('parseArgv：--no-web 关闭 Web', () => {
  const origArgv = process.argv
  process.argv = ['node', 's-node.js', '--no-web']
  try {
    const c = loadConfig()
    assert.equal(c.web, false)
    assert.equal(c.repl, true)
  } finally {
    process.argv = origArgv
  }
})

test('parseArgv：--repl=false 等价于 --no-repl', () => {
  const origArgv = process.argv
  process.argv = ['node', 's-node.js', '--repl=false']
  try {
    const c = loadConfig()
    assert.equal(c.repl, false)
  } finally {
    process.argv = origArgv
  }
})

test('parseArgv：--web-port 自定义端口', () => {
  const origArgv = process.argv
  process.argv = ['node', 's-node.js', '--web-port', '8000']
  try {
    const c = loadConfig()
    assert.equal(c.webPort, 8000)
  } finally {
    process.argv = origArgv
  }
})

test('parseArgv：--web-port=8000 等价形式', () => {
  const origArgv = process.argv
  process.argv = ['node', 's-node.js', '--web-port=8000']
  try {
    const c = loadConfig()
    assert.equal(c.webPort, 8000)
  } finally {
    process.argv = origArgv
  }
})

test('parseArgv：--web-port 非法值抛错', () => {
  const origArgv = process.argv
  process.argv = ['node', 's-node.js', '--web-port', 'abc']
  try {
    assert.throws(() => loadConfig(), /--web-port 必须是 0-65535/)
  } finally {
    process.argv = origArgv
  }
})

test('parseArgv：--web-port 超范围抛错', () => {
  const origArgv = process.argv
  process.argv = ['node', 's-node.js', '--web-port', '70000']
  try {
    assert.throws(() => loadConfig(), /--web-port 必须是 0-65535/)
  } finally {
    process.argv = origArgv
  }
})

test('parseArgv：--web-host 自定义地址', () => {
  const origArgv = process.argv
  process.argv = ['node', 's-node.js', '--web-host', '0.0.0.0']
  try {
    const c = loadConfig()
    assert.equal(c.webHost, '0.0.0.0')
  } finally {
    process.argv = origArgv
  }
})

test('parseArgv：组合 --no-repl --web-port 8000', () => {
  const origArgv = process.argv
  process.argv = ['node', 's-node.js', '--no-repl', '--web-port', '8000']
  try {
    const c = loadConfig()
    assert.equal(c.repl, false)
    assert.equal(c.webPort, 8000)
  } finally {
    process.argv = origArgv
  }
})

test('环境变量 HAVIX_REPL=false 关闭 REPL', () => {
  const origArgv = process.argv
  process.argv = ['node', 's-node.js']
  const oldVal = process.env.HAVIX_REPL
  process.env.HAVIX_REPL = 'false'
  try {
    const c = loadConfig()
    assert.equal(c.repl, false)
  } finally {
    process.argv = origArgv
    if (oldVal === undefined) delete process.env.HAVIX_REPL
    else process.env.HAVIX_REPL = oldVal
  }
})

test('环境变量 HAVIX_WEB_PORT 覆盖默认', () => {
  const origArgv = process.argv
  process.argv = ['node', 's-node.js']
  const oldVal = process.env.HAVIX_WEB_PORT
  process.env.HAVIX_WEB_PORT = '9000'
  try {
    const c = loadConfig()
    assert.equal(c.webPort, 9000)
  } finally {
    process.argv = origArgv
    if (oldVal === undefined) delete process.env.HAVIX_WEB_PORT
    else process.env.HAVIX_WEB_PORT = oldVal
  }
})

test('命令行参数覆盖环境变量', () => {
  const origArgv = process.argv
  process.argv = ['node', 's-node.js', '--web-port', '7000']
  const oldVal = process.env.HAVIX_WEB_PORT
  process.env.HAVIX_WEB_PORT = '9000'
  try {
    const c = loadConfig()
    assert.equal(c.webPort, 7000)  // 命令行优先
  } finally {
    process.argv = origArgv
    if (oldVal === undefined) delete process.env.HAVIX_WEB_PORT
    else process.env.HAVIX_WEB_PORT = oldVal
  }
})

test('--help 包含 M8.2 应用层选项', () => {
  // 不能直接调用 loadConfig（会 exit），直接测试 printHelp 输出
  // 通过临时替换 process.exit 捕获
  const origArgv = process.argv
  const origExit = process.exit
  const origStdout = process.stdout.write
  let captured = ''
  process.argv = ['node', 's-node.js', '--help']
  process.exit = (code) => { throw { code, _helpExit: true } }
  process.stdout.write = (s) => { captured += s; return true }

  try {
    loadConfig()
  } catch (e) {
    assert.ok(e._helpExit, '应该 exit(0)')
    assert.equal(e.code, 0)
  } finally {
    process.argv = origArgv
    process.exit = origExit
    process.stdout.write = origStdout
  }

  assert.match(captured, /--\[no-\]repl/)
  assert.match(captured, /--\[no-\]web/)
  assert.match(captured, /--web-port/)
  assert.match(captured, /--web-host/)
  assert.match(captured, /HAVIX_REPL/)
})
