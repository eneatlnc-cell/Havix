// SPDX-License-Identifier: AGPL-3.0-only

/**
 * M8.2 CLI 框架单元测试
 * ───────────────────────────────────────────────
 * 测试范围：
 *   - tokenize：命令行字符串拆 token（含引号、转义、空格）
 *   - parseArgs：positional / named / flags 分类
 *   - Cli 类：命令注册 / 路由 / help / unknown / 异常隔离
 *   - 诊断命令（status / identity / neighbors / topics）通过 mock SNode 验证
 *
 * 不依赖 libp2p / helia：所有测试通过 mock SNode 注入。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'

import { tokenize, parseArgs, Cli } from '../src/app/cli.js'

// ──────────────────────────────────────────────
// 内存输出流辅助
// ──────────────────────────────────────────────

function makeOutput() {
  const chunks = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString())
      cb()
    },
  })
  stream.isTTY = false
  stream._captured = () => chunks.join('')
  return stream
}

function makeMockNode(overrides = {}) {
  return {
    log: () => {},
    libp2p: {
      peerId: { toString: () => '12D3KooWmockpeer' },
      getMultiaddrs: () => ['/ip4/127.0.0.1/tcp/9001/p2p/12D3KooWmockpeer'],
      getPeers: () => [{ toString: () => '12D3KooWpeer2' }],
      getConnections: () => [{ remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/9002/p2p/12D3KooWpeer2' } }],
      services: {
        pubsub: { getTopics: () => ['/s-network/announce', '/s-network/reputation'] },
      },
    },
    wallet: {
      get: (k) => {
        const ids = {
          A: { did: 'did:havix:A:mock', contextKey: 'A' },
          B: { did: 'did:havix:B:mock', contextKey: 'B' },
          C: { did: 'did:havix:C:mock', contextKey: 'C' },
          D: { did: 'did:havix:D:mock', contextKey: 'D' },
        }
        return ids[k]
      },
    },
    vouchRegistry: { vouches: new Map([['e1', new Set(['v1', 'v2'])]]) },
    wiki: { entries: new Map([['cid1', {}], ['cid2', {}]]) },
    reputationLedger: { balances: new Map([['d1', { total: 100 }]]) },
    creditLedger: { balances: new Map([['d1', 50]]) },
    arbitrationRegistry: {
      disputes: new Map([['d1', {}]]),
      jurorPool: new Map([['j1', {}], ['j2', {}]]),
    },
    marketRegistry: { listMarkets: () => ['m1'] },
    treasury: { getBalance: () => 25 },
    _processedCreditNonces: new Set(['n1', 'n2', 'n3']),
    ...overrides,
  }
}

// ──────────────────────────────────────────────
// tokenize
// ──────────────────────────────────────────────

test('tokenize：空行返回空数组', () => {
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize('   '), [])
  assert.deepEqual(tokenize('\t\t'), [])
})

test('tokenize：单命令无参数', () => {
  assert.deepEqual(tokenize('status'), ['status'])
  assert.deepEqual(tokenize('help'), ['help'])
})

test('tokenize：多参数空格分隔', () => {
  assert.deepEqual(tokenize('vouch did:havix:A:alice'), ['vouch', 'did:havix:A:alice'])
  assert.deepEqual(tokenize('credit-issue did:holder 100'),
    ['credit-issue', 'did:holder', '100'])
})

test('tokenize：双引号包裹保持原样', () => {
  assert.deepEqual(tokenize('wiki-publish "hello world"'), ['wiki-publish', 'hello world'])
  assert.deepEqual(tokenize('send "multi word content"'), ['send', 'multi word content'])
})

test('tokenize：双引号内支持反斜杠转义', () => {
  assert.deepEqual(tokenize('echo "say \\"hi\\""'), ['echo', 'say "hi"'])
})

test('tokenize：连续空格视为单个分隔符', () => {
  assert.deepEqual(tokenize('a   b   c'), ['a', 'b', 'c'])
  assert.deepEqual(tokenize('  a  b  '), ['a', 'b'])
})

test('tokenize：未闭合引号到行尾', () => {
  assert.deepEqual(tokenize('echo "unclosed'), ['echo', 'unclosed'])
})

// ──────────────────────────────────────────────
// parseArgs
// ──────────────────────────────────────────────

test('parseArgs：纯 positional', () => {
  const r = parseArgs(['did:xxx', '100'])
  assert.deepEqual(r.positional, ['did:xxx', '100'])
  assert.equal(r.named.amount, undefined)
  assert.equal(r.flags.size, 0)
})

test('parseArgs：named 参数 --key=value', () => {
  const r = parseArgs(['--amount=100', '--ttl=3600'])
  assert.equal(r.named.amount, '100')
  assert.equal(r.named.ttl, '3600')
  assert.equal(r.positional.length, 0)
})

test('parseArgs：flag 参数 --verbose', () => {
  const r = parseArgs(['--force', '--verbose'])
  assert.ok(r.flags.has('force'))
  assert.ok(r.flags.has('verbose'))
  assert.equal(r.positional.length, 0)
})

test('parseArgs：混合 positional + named + flag', () => {
  const r = parseArgs(['did:alice', '100', '--reason=test vouch', '--force'])
  assert.deepEqual(r.positional, ['did:alice', '100'])
  assert.equal(r.named.reason, 'test vouch')
  assert.ok(r.flags.has('force'))
})

test('parseArgs：空数组', () => {
  const r = parseArgs([])
  assert.deepEqual(r.positional, [])
  assert.deepEqual(r.named, {})
  assert.equal(r.flags.size, 0)
})

// ──────────────────────────────────────────────
// Cli 类：命令注册
// ──────────────────────────────────────────────

test('Cli.register：注册单命令', () => {
  const cli = new Cli(makeMockNode(), { silent: true })
  const cmd = {
    name: 'test-cmd',
    category: 'misc',
    shortHelp: 'test',
    handler: () => {},
  }
  cli.register(cmd)
  assert.ok(cli._commands.has('test-cmd'))
})

test('Cli.register：重复注册抛错', () => {
  const cli = new Cli(makeMockNode(), { silent: true })
  cli.register({ name: 'dup', category: 'x', shortHelp: '1', handler: () => {} })
  assert.throws(
    () => cli.register({ name: 'dup', category: 'x', shortHelp: '2', handler: () => {} }),
    /已注册/,
  )
})

test('Cli.register：name 缺失抛错', () => {
  const cli = new Cli(makeMockNode(), { silent: true })
  assert.throws(() => cli.register({ category: 'x', shortHelp: 'no name', handler: () => {} }), /name/)
  assert.throws(() => cli.register({ name: 123, handler: () => {} }), /name/)
})

test('Cli.registerAll：批量注册', () => {
  const cli = new Cli(makeMockNode(), { silent: true })
  cli.registerAll([
    { name: 'a', category: 'x', shortHelp: 'a', handler: () => {} },
    { name: 'b', category: 'x', shortHelp: 'b', handler: () => {} },
    { name: 'c', category: 'x', shortHelp: 'c', handler: () => {} },
  ])
  assert.ok(cli._commands.has('a'))
  assert.ok(cli._commands.has('b'))
  assert.ok(cli._commands.has('c'))
})

test('Cli.getCommandsByCategory：按分类分组', () => {
  const cli = new Cli(makeMockNode(), { silent: true })
  // 已注册 7 个内置（help/exit/quit/status/identity/neighbors/topics）
  const grouped = cli.getCommandsByCategory()
  assert.ok(grouped.has('builtin'))
  assert.ok(grouped.has('diagnostic'))
  assert.equal(grouped.get('builtin').length, 3)  // help/exit/quit
  assert.equal(grouped.get('diagnostic').length, 4)  // status/identity/neighbors/topics
})

// ──────────────────────────────────────────────
// Cli 类：命令分发
// ──────────────────────────────────────────────

test('Cli.execute：空行不触发任何 handler', async () => {
  const cli = new Cli(makeMockNode(), { silent: true })
  await cli.execute('')
  await cli.execute('   ')
  // 不抛错即通过
})

test('Cli.execute：未知命令打印错误但不抛错', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('nonexistent-command')
  const text = output._captured()
  assert.match(text, /未知命令/)
  assert.match(text, /help/)
})

test('Cli.execute：handler 被调用', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  let calledWith = null
  cli.register({
    name: 'echo',
    category: 'misc',
    shortHelp: 'echo args',
    handler: (args) => { calledWith = args; return args.positional[0] },
  })
  await cli.execute('echo hello')
  assert.deepEqual(calledWith.positional, ['hello'])
})

test('Cli.execute：handler 抛错被捕获并打印', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  cli.register({
    name: 'fail',
    category: 'misc',
    shortHelp: 'always fails',
    handler: () => { throw new Error('boom') },
  })
  await cli.execute('fail')
  const text = output._captured()
  assert.match(text, /\[fail\] 失败/)
  assert.match(text, /boom/)
})

test('Cli.execute：handler 异步错误也被捕获', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  cli.register({
    name: 'async-fail',
    category: 'misc',
    shortHelp: 'fails async',
    handler: async () => { throw new Error('async boom') },
  })
  await cli.execute('async-fail')
  const text = output._captured()
  assert.match(text, /async boom/)
})

// ──────────────────────────────────────────────
// 内置命令：help
// ──────────────────────────────────────────────

test('help：无参数列出所有命令（按分类）', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('help')
  const text = output._captured()
  assert.match(text, /可用命令/)
  assert.match(text, /\[内置\]/)
  assert.match(text, /\[诊断\]/)
  assert.match(text, /help/)
  assert.match(text, /status/)
})

test('help <cmd>：显示单命令详情', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('help status')
  const text = output._captured()
  assert.match(text, /命令: status/)
  assert.match(text, /分类: diagnostic/)
  assert.match(text, /用法: status/)
})

test('help <unknown>：打印未知命令错误', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('help nonexistent')
  const text = output._captured()
  assert.match(text, /未知命令: nonexistent/)
})

// ──────────────────────────────────────────────
// 内置命令：status
// ──────────────────────────────────────────────

test('status：显示 peerId / 监听地址 / 邻居数 / registry 计数', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('status')
  const text = output._captured()
  assert.match(text, /12D3KooWmockpeer/)
  assert.match(text, /\/ip4\/127\.0\.0\.1\/tcp\/9001/)
  assert.match(text, /已连接 peer/)
  assert.match(text, /订阅 topic/)
  assert.match(text, /vouch 索引/)
  assert.match(text, /wiki 条目/)
  assert.match(text, /reputation 节点/)
  assert.match(text, /credit 持有人/)
  assert.match(text, /dispute 数/)
  assert.match(text, /juror 候选/)
  assert.match(text, /market 参与数/)
  assert.match(text, /treasury 余额/)
  assert.match(text, /credit nonce/)
})

test('status：节点未初始化时打印错误', async () => {
  const output = makeOutput()
  const cli = new Cli(null, { silent: true, output })
  await cli.execute('status')
  assert.match(output._captured(), /节点未初始化/)
})

// ──────────────────────────────────────────────
// 内置命令：identity
// ──────────────────────────────────────────────

test('identity：显示 4-context DID', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('identity')
  const text = output._captured()
  assert.match(text, /context-A/)
  assert.match(text, /did:havix:A:mock/)
  assert.match(text, /context-B/)
  assert.match(text, /did:havix:B:mock/)
  assert.match(text, /context-C/)
  assert.match(text, /did:havix:C:mock/)
  assert.match(text, /context-D/)
  assert.match(text, /did:havix:D:mock/)
})

test('identity：钱包未初始化时打印错误', async () => {
  const output = makeOutput()
  const cli = new Cli({}, { silent: true, output })
  await cli.execute('identity')
  assert.match(output._captured(), /钱包未初始化/)
})

// ──────────────────────────────────────────────
// 内置命令：neighbors / topics
// ──────────────────────────────────────────────

test('neighbors：列出已连接 peer', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('neighbors')
  const text = output._captured()
  assert.match(text, /已连接 peer \(1\)/)
  assert.match(text, /12D3KooWpeer2/)
})

test('neighbors：无 peer 时打印提示', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.libp2p.getPeers = () => []
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('neighbors')
  assert.match(output._captured(), /当前无已连接 peer/)
})

test('topics：列出订阅 topic', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('topics')
  const text = output._captured()
  assert.match(text, /订阅 topic \(2\)/)
  assert.match(text, /\/s-network\/announce/)
  assert.match(text, /\/s-network\/reputation/)
})

test('topics：无 topic 时打印提示', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.libp2p.services.pubsub.getTopics = () => []
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('topics')
  assert.match(output._captured(), /当前无订阅 topic/)
})

// ──────────────────────────────────────────────
// REPL 启停：不真实启动 readline，仅验证 stop 幂等
// ──────────────────────────────────────────────

test('Cli.stop：未启动时调用不抛错', async () => {
  const cli = new Cli(makeMockNode(), { silent: true })
  await cli.stop()
  assert.equal(cli._rl, null)
})

// ──────────────────────────────────────────────
// 端到端：完整命令执行流
// ──────────────────────────────────────────────

test('端到端：注册新命令 → execute → 验证调用', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })

  let callCount = 0
  cli.register({
    name: 'greet',
    category: 'misc',
    shortHelp: 'say hello',
    handler: (args) => {
      callCount++
      return `hello ${args.positional[0] ?? 'world'}`
    },
  })

  await cli.execute('greet alice')
  await cli.execute('greet bob')
  await cli.execute('greet')

  assert.equal(callCount, 3)
})

test('端到端：复杂命令（含 named + flag + 引号）', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })

  let captured = null
  cli.register({
    name: 'complex',
    category: 'misc',
    shortHelp: 'complex args test',
    handler: (args) => { captured = args },
  })

  await cli.execute('complex did:holder 100 --reason="long reason here" --force')

  assert.deepEqual(captured.positional, ['did:holder', '100'])
  assert.equal(captured.named.reason, 'long reason here')
  assert.ok(captured.flags.has('force'))
})

// ──────────────────────────────────────────────
// M3-M4 命令：vouch
// ──────────────────────────────────────────────

test('vouch：缺 endorseDid 打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('vouch')
  assert.match(output._captured(), /用法: vouch <endorseDid>/)
})

test('vouch：调用 SNode.vouch 并打印成功', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let vouchCalled = null
  node.vouch = async (endorseDid, reason) => {
    vouchCalled = { endorseDid, reason }
    return { recipients: 3 }
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('vouch did:havix:A:alice reason text')
  assert.equal(vouchCalled.endorseDid, 'did:havix:A:alice')
  assert.equal(vouchCalled.reason, 'reason text')
  assert.match(output._captured(), /已投 vouch/)
  assert.match(output._captured(), /3 个 peer/)
})

test('vouch：handler 抛错被捕获（如 SNode 未启动）', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.vouch = async () => { throw new Error('节点未启动') }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('vouch did:alice')
  assert.match(output._captured(), /\[vouch\] 失败/)
  assert.match(output._captured(), /节点未启动/)
})

test('vouch-list：显示 score / threshold / vouch 来源', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.vouchRegistry = {
    getVouchers: (did) => ['did:v1', 'did:v2'],
    getVouchCount: () => 2,
    getQualification: () => ({ score: 2, threshold: 2, qualified: true }),
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('vouch-list did:havix:A:alice')
  const text = output._captured()
  assert.match(text, /vouch 数/)
  assert.match(text, /score/)
  assert.match(text, /threshold/)
  assert.match(text, /是否合格/)
  assert.match(text, /did:v1/)
  assert.match(text, /did:v2/)
})

test('vouch-list：缺 endorseDid 打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('vouch-list')
  assert.match(output._captured(), /用法: vouch-list/)
})

// ──────────────────────────────────────────────
// M3-M4 命令：wiki
// ──────────────────────────────────────────────

test('wiki-publish：缺参数打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('wiki-publish only-title')
  assert.match(output._captured(), /用法: wiki-publish/)
})

test('wiki-publish：调用 wiki.publishEntry 并打印 CID', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let publishCalled = null
  node.wiki = {
    publishEntry: async (opts) => {
      publishCalled = opts
      return { cid: 'bafyfakecid123', message: {} }
    },
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('wiki-publish "hello world" content-body --parent=bafyparent1')
  assert.equal(publishCalled.title, 'hello world')
  assert.equal(publishCalled.content, 'content-body')
  assert.equal(publishCalled.parentCid, 'bafyparent1')
  assert.match(output._captured(), /bafyfakecid123/)
})

test('wiki-list：列出本地索引的条目', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.wiki = {
    listEntries: () => [
      { cid: 'bafy1', title: 'title-1', authorDid: 'did:havix:D:author1', timestamp: 1700000000000, parentCid: null },
      { cid: 'bafy2', title: 'title-2', authorDid: 'did:havix:D:author2', timestamp: 1700000001000, parentCid: 'bafy1' },
    ],
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('wiki-list')
  const text = output._captured()
  assert.match(text, /维基条目 \(2\)/)
  assert.match(text, /bafy1/)
  assert.match(text, /title-1/)
  assert.match(text, /bafy2/)
  assert.match(text, /title-2/)
})

test('wiki-list：按 --title 过滤', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.wiki = {
    listEntries: () => [
      { cid: 'bafy1', title: 'wanted', authorDid: 'd', timestamp: 1, parentCid: null },
      { cid: 'bafy2', title: 'other', authorDid: 'd', timestamp: 2, parentCid: null },
    ],
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('wiki-list --title=wanted')
  const text = output._captured()
  assert.match(text, /bafy1/)
  assert.doesNotMatch(text, /bafy2/)
})

test('wiki-list：空索引打印提示', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.wiki = { listEntries: () => [] }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('wiki-list')
  assert.match(output._captured(), /当前无维基条目/)
})

test('wiki-get：缺 cid 打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('wiki-get')
  assert.match(output._captured(), /用法: wiki-get/)
})

test('wiki-get：未找到 CID 打印错误', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.wiki = { getEntry: () => undefined }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('wiki-get bafynotfound')
  assert.match(output._captured(), /未找到 CID: bafynotfound/)
})

test('wiki-get：显示 manifest（无 --fetch）', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.wiki = {
    getEntry: () => ({
      cid: 'bafy1', title: 'my-title', authorDid: 'did:havix:D:author',
      timestamp: 1700000000000, parentCid: 'bafy0',
    }),
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('wiki-get bafy1')
  const text = output._captured()
  assert.match(text, /my-title/)
  assert.match(text, /did:havix:D:author/)
  assert.match(text, /bafy0/)
})

test('wiki-get --fetch：从 IPFS 拉取并打印内容', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.wiki = {
    getEntry: () => ({
      cid: 'bafy1', title: 't', authorDid: 'd',
      timestamp: 1, parentCid: null,
    }),
    fetchContent: async () => new TextEncoder().encode('hello\nworld'),
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('wiki-get bafy1 --fetch')
  const text = output._captured()
  assert.match(text, /hello/)
  assert.match(text, /world/)
})

test('wiki-get --fetch：拉取失败打印错误', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.wiki = {
    getEntry: () => ({ cid: 'bafy1', title: 't', authorDid: 'd', timestamp: 1, parentCid: null }),
    fetchContent: async () => { throw new Error('IPFS not found') },
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('wiki-get bafy1 --fetch')
  assert.match(output._captured(), /拉取失败: IPFS not found/)
})

test('wiki-history：缺 title 打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('wiki-history')
  assert.match(output._captured(), /用法: wiki-history/)
})

test('wiki-history：列出指定标题的所有版本', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.wiki = {
    listHistory: (title) => [
      { cid: 'bafy1', title, authorDid: 'd', timestamp: 1000, parentCid: null },
      { cid: 'bafy2', title, authorDid: 'd', timestamp: 2000, parentCid: 'bafy1' },
    ],
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('wiki-history my-title')
  const text = output._captured()
  assert.match(text, /版本链 \(2\)/)
  assert.match(text, /bafy1/)
  assert.match(text, /bafy2/)
  assert.match(text, /parent: bafy1/)
})

test('wiki-history：无版本打印提示', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.wiki = { listHistory: () => [] }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('wiki-history no-such-title')
  assert.match(output._captured(), /无已知版本/)
})

// ──────────────────────────────────────────────
// M3-M4 命令：credit
// ──────────────────────────────────────────────

test('credit-issue：缺参数打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('credit-issue did:holder')
  assert.match(output._captured(), /用法: credit-issue/)
})

test('credit-issue：amount 非正数打印错误', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('credit-issue did:holder -5')
  assert.match(output._captured(), /amount 必须是正整数/)
  await cli.execute('credit-issue did:holder abc')
  assert.match(output._captured(), /amount 必须是正整数/)
})

test('credit-issue：调用 SNode.issueCredit 并打印结果', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let issueCalled = null
  node.issueCredit = async (opts) => {
    issueCalled = opts
    return { note: { cid: 'note-cid-1', nonce: 'n-123' }, recipients: 2 }
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('credit-issue did:holder 100 --prev=prev-cid')
  assert.equal(issueCalled.holderDid, 'did:holder')
  assert.equal(issueCalled.amount, 100)
  assert.equal(issueCalled.prevNoteCid, 'prev-cid')
  const text = output._captured()
  assert.match(text, /已签发/)
  assert.match(text, /n-123/)
  assert.match(text, /100/)
  assert.match(text, /2 peer/)
})

test('credit-consume：缺参数打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('credit-consume did:holder')
  assert.match(output._captured(), /用法: credit-consume/)
})

test('credit-consume：调用 SNode.consumeCredit 并打印结果', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let consumeCalled = null
  node.consumeCredit = (opts) => {
    consumeCalled = opts
    return { holderBalance: 50, releasedFrozen: 30 }
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('credit-consume did:holder did:issuer 50')
  assert.deepEqual(consumeCalled, { holderDid: 'did:holder', issuerDid: 'did:issuer', amount: 50 })
  const text = output._captured()
  assert.match(text, /已消费 50 credit/)
  assert.match(text, /holder 余额/)
  assert.match(text, /50/)
  assert.match(text, /释放冻结/)
  assert.match(text, /30/)
})

test('credit-transfer：调用 SNode.transferCredit 并打印结果', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let transferCalled = null
  node.transferCredit = (opts) => {
    transferCalled = opts
    return { fromBalance: 50, toBalance: 150 }
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('credit-transfer did:from did:to 50')
  assert.deepEqual(transferCalled, { fromDid: 'did:from', toDid: 'did:to', amount: 50 })
  const text = output._captured()
  assert.match(text, /已转账 50 credit/)
  assert.match(text, /from 余额/)
  assert.match(text, /to 余额/)
})

test('credit-balance：查询余额', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.creditLedger = { getBalance: (did) => did === 'did:alice' ? 100 : 0 }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('credit-balance did:alice')
  assert.match(output._captured(), /100/)
})

test('credit-balance：缺 did 打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('credit-balance')
  assert.match(output._captured(), /用法: credit-balance/)
})

test('reputation：查询三元组', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.reputationLedger = {
    get: (did) => ({ available: 70, frozen: 30, total: 100 }),
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('reputation did:alice')
  const text = output._captured()
  assert.match(text, /available/)
  assert.match(text, /70/)
  assert.match(text, /frozen/)
  assert.match(text, /30/)
  assert.match(text, /total/)
  assert.match(text, /100/)
})

test('reputation：缺 did 打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('reputation')
  assert.match(output._captured(), /用法: reputation/)
})

// ──────────────────────────────────────────────
// help 系统覆盖新命令
// ──────────────────────────────────────────────

test('help：列出所有 M3-M4 命令分类', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('help')
  const text = output._captured()
  assert.match(text, /\[维基协议 \(M3\)\]/)
  assert.match(text, /\[信誉背书 \(M3\)\]/)
  assert.match(text, /\[双轨经济 \(M4\)\]/)
  assert.match(text, /wiki-publish/)
  assert.match(text, /vouch/)
  assert.match(text, /credit-issue/)
})

test('help <cmd>：显示 wiki-publish 详情', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('help wiki-publish')
  const text = output._captured()
  assert.match(text, /命令: wiki-publish/)
  assert.match(text, /分类: wiki/)
  assert.match(text, /context-D/)
  assert.match(text, /--parent/)
  assert.match(text, /版本链/)
})

// ──────────────────────────────────────────────
// M5-M7 命令：relay
// ──────────────────────────────────────────────

test('relay-register：缺 did 打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('relay-register')
  assert.match(output._captured(), /用法: relay-register/)
})

test('relay-register：成功注册', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.registerRelayCandidate = (opts) => {
    called = opts
    return { registered: true, eligible: true }
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('relay-register did:relay1 80 15')
  assert.deepEqual(called, { did: 'did:relay1', reputation: 80, vouchCount: 15 })
  const text = output._captured()
  assert.match(text, /已注册 relay 候选/)
  assert.match(text, /did:relay1/)
})

test('relay-register：注册失败打印原因', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.registerRelayCandidate = () => ({ registered: false, reason: 'vouch 数不足' })
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('relay-register did:relay1')
  const text = output._captured()
  assert.match(text, /注册失败/)
  assert.match(text, /vouch 数不足/)
})

test('relay-register：未传 reputation/vouchCount 时为 undefined', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.registerRelayCandidate = (opts) => { called = opts; return { registered: true } }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('relay-register did:relay1')
  assert.deepEqual(called, { did: 'did:relay1', reputation: undefined, vouchCount: undefined })
})

test('relay-elect：调用 SNode.electRelayEpoch 并打印结果', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = false
  node.electRelayEpoch = () => {
    called = true
    return { elected: ['did:r1', 'did:r2'], count: 2 }
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('relay-elect')
  assert.equal(called, true)
  const text = output._captured()
  assert.match(text, /epoch 选举完成/)
  assert.match(text, /当选数/)
  assert.match(text, /2/)
  assert.match(text, /did:r1/)
  assert.match(text, /did:r2/)
})

test('relay-rotate：调用 SNode.rotateRelayEpoch 并打印结果', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.rotateRelayEpoch = () => ({
    rotated: ['did:old1'],
    supplemented: ['did:new1'],
    active: ['did:new1', 'did:r2', 'did:r3'],
  })
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('relay-rotate')
  const text = output._captured()
  assert.match(text, /epoch 轮换完成/)
  assert.match(text, /换下/)
  assert.match(text, /补齐/)
  assert.match(text, /当前 active/)
})

test('relay-list：缺 relayRegistry 打印错误', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  delete node.relayRegistry
  // 注：SNode 中 relayRegistry 字段不预定义，mock 默认也不带；但 makeMockNode 没设置 relayRegistry
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('relay-list')
  assert.match(output._captured(), /relayRegistry 未初始化/)
})

test('relay-list：显示候选数 + active 列表', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.relayRegistry = {
    getActiveRelays: () => ['did:r1', 'did:r2'],
    candidates: new Map([['did:r1', {}], ['did:r2', {}], ['did:r3', {}]]),
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('relay-list')
  const text = output._captured()
  assert.match(text, /Relay 状态/)
  assert.match(text, /候选总数/)
  assert.match(text, /3/)
  assert.match(text, /active relay/)
  assert.match(text, /did:r1/)
  assert.match(text, /did:r2/)
})

test('relay-list：active 为空时只打印计数', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.relayRegistry = {
    getActiveRelays: () => [],
    candidates: new Map(),
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('relay-list')
  const text = output._captured()
  assert.match(text, /候选总数:\s+0/)
  assert.match(text, /active relay:\s+0/)
})

// ──────────────────────────────────────────────
// M5-M7 命令：tunnel
// ──────────────────────────────────────────────

test('tunnel-open：缺 targetDid 打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('tunnel-open')
  assert.match(output._captured(), /用法: tunnel-open/)
})

test('tunnel-open：用默认 active relay 建立隧道', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.establishTunnel = (opts) => {
    called = opts
    return { tunnelId: 'tun-1', relayDids: ['did:r1', 'did:r2', 'did:r3'] }
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('tunnel-open did:target')
  assert.deepEqual(called, { targetDid: 'did:target' })
  const text = output._captured()
  assert.match(text, /隧道已建立/)
  assert.match(text, /tun-1/)
  assert.match(text, /relay 数/)
  assert.match(text, /3/)
})

test('tunnel-open：手动指定 relay 列表', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.establishTunnel = (opts) => {
    called = opts
    return { tunnelId: 'tun-2', relayDids: opts.relayDids }
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('tunnel-open did:target did:r1 did:r2')
  assert.deepEqual(called, { targetDid: 'did:target', relayDids: ['did:r1', 'did:r2'] })
  assert.match(output._captured(), /tun-2/)
})

test('tunnel-send：缺参数打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('tunnel-send tun-1')
  assert.match(output._captured(), /用法: tunnel-send/)
})

test('tunnel-send：调用 sendTunnelChunk 并打印 relay/sequence', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.sendTunnelChunk = (opts) => {
    called = opts
    return { relay: 'did:r2', sequence: 1, total: 1 }
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('tunnel-send tun-1 hello world')
  assert.equal(called.tunnelId, 'tun-1')
  assert.deepEqual(Array.from(called.chunk), Array.from(new TextEncoder().encode('hello world')))
  const text = output._captured()
  assert.match(text, /chunk 已发送/)
  assert.match(text, /did:r2/)
  assert.match(text, /1\/1/)
})

test('tunnel-break：缺参数打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('tunnel-break tun-1')
  assert.match(output._captured(), /用法: tunnel-break/)
})

test('tunnel-break：调用 breakTunnelLink 并打印状态', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.breakTunnelLink = (opts) => {
    called = opts
    return { status: 'degraded', remainingRelays: 2 }
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('tunnel-break tun-1 did:r1')
  assert.deepEqual(called, { tunnelId: 'tun-1', relayDid: 'did:r1' })
  const text = output._captured()
  assert.match(text, /链路断开/)
  assert.match(text, /degraded/)
  assert.match(text, /剩余 relay/)
  assert.match(text, /2/)
})

test('tunnel-close：缺 tunnelId 打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('tunnel-close')
  assert.match(output._captured(), /用法: tunnel-close/)
})

test('tunnel-close：调用 closeTunnel 并打印成功', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.closeTunnel = (id) => { called = id }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('tunnel-close tun-1')
  assert.equal(called, 'tun-1')
  assert.match(output._captured(), /tun-1 已关闭/)
})

test('tunnel-list：缺 tunnelManager 打印错误', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  delete node.tunnelManager
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('tunnel-list')
  assert.match(output._captured(), /tunnelManager 未初始化/)
})

test('tunnel-list：无隧道打印提示', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.tunnelManager = { listTunnels: () => [], getStats: () => [] }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('tunnel-list')
  assert.match(output._captured(), /无活动隧道/)
})

test('tunnel-list：列出隧道 + 状态', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.tunnelManager = {
    listTunnels: () => ['tun-1', 'tun-2'],
    getStats: () => [
      {
        tunnelId: 'tun-1', sourceDid: 'did:havix:C:src-aaaaaaaaaa',
        targetDid: 'did:havix:C:dst-bbbbbbbbbb', status: 'active', totalChunks: 5, links: [{}, {}, {}],
      },
      {
        tunnelId: 'tun-2', sourceDid: 'did:havix:C:src-cccccccccc',
        targetDid: 'did:havix:C:dst-dddddddddd', status: 'degraded', totalChunks: 2, links: [{}, {}],
      },
    ],
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('tunnel-list')
  const text = output._captured()
  assert.match(text, /隧道列表 \(2\)/)
  assert.match(text, /tun-1/)
  assert.match(text, /tun-2/)
  assert.match(text, /active/)
  assert.match(text, /degraded/)
})

// ──────────────────────────────────────────────
// M5-M7 命令：arbitration
// ──────────────────────────────────────────────

test('dispute-file：缺参数打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('dispute-file did:resp offer-breach')
  assert.match(output._captured(), /用法: dispute-file/)
})

test('dispute-file：非法 type 打印错误', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('dispute-file did:resp bad-type 100')
  const text = output._captured()
  assert.match(text, /type 必须是/)
  assert.match(text, /offer-breach/)
  assert.match(text, /relay-malice/)
  assert.match(text, /vouch-collusion/)
})

test('dispute-file：amount 非正数打印错误', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('dispute-file did:resp offer-breach 0')
  assert.match(output._captured(), /amount 必须是正整数/)
  await cli.execute('dispute-file did:resp offer-breach -5')
  assert.match(output._captured(), /amount 必须是正整数/)
  await cli.execute('dispute-file did:resp offer-breach abc')
  assert.match(output._captured(), /amount 必须是正整数/)
})

test('dispute-file：调用 fileDispute 并打印 disputeId', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.fileDispute = async (opts) => {
    called = opts
    return {
      dispute: {
        disputeId: 'disp-1', claimant: 'did:havix:A:me',
        respondent: opts.respondent, type: opts.type, amount: opts.amount,
      },
      message: {},
    }
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('dispute-file did:resp offer-breach 100 bafyevidence')
  assert.deepEqual(called, {
    respondent: 'did:resp',
    type: 'offer-breach',
    evidence: 'bafyevidence',
    amount: 100,
  })
  const text = output._captured()
  assert.match(text, /dispute 已发起/)
  assert.match(text, /disp-1/)
  assert.match(text, /did:havix:A:me/)
  assert.match(text, /did:resp/)
  assert.match(text, /offer-breach/)
  assert.match(text, /100/)
})

test('dispute-file：无 evidence 时 evidence 为 undefined', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.fileDispute = async (opts) => {
    called = opts
    return { dispute: { disputeId: 'd1', claimant: 'c', respondent: 'r', type: 'relay-malice', amount: 50 } }
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('dispute-file did:resp relay-malice 50')
  assert.equal(called.evidence, undefined)
})

test('dispute-panel：缺 disputeId 打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('dispute-panel')
  assert.match(output._captured(), /用法: dispute-panel/)
})

test('dispute-panel：召集仲裁团 + 打印 panel 列表 + 排除数', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.summonArbitrationPanel = (id) => {
    called = id
    return {
      panel: ['did:j1', 'did:j2', 'did:j3', 'did:j4', 'did:j5'],
      count: 5,
      excluded: ['did:excl1', 'did:excl2'],
    }
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('dispute-panel disp-1')
  assert.equal(called, 'disp-1')
  const text = output._captured()
  assert.match(text, /仲裁团已召集/)
  assert.match(text, /panel 数/)
  assert.match(text, /排除数/)
  assert.match(text, /2/)
  assert.match(text, /did:j1/)
  assert.match(text, /did:j5/)
})

test('dispute-panel：无排除节点时不打印排除行', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.summonArbitrationPanel = () => ({ panel: ['did:j1'], count: 1, excluded: [] })
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('dispute-panel disp-1')
  assert.doesNotMatch(output._captured(), /排除数/)
})

test('dispute-vote：缺参数打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('dispute-vote disp-1')
  assert.match(output._captured(), /用法: dispute-vote/)
})

test('dispute-vote：非法 vote 打印错误', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('dispute-vote disp-1 invalid')
  const text = output._captured()
  assert.match(text, /vote 必须是/)
  assert.match(text, /guilty/)
  assert.match(text, /not-guilty/)
  assert.match(text, /abstain/)
})

test('dispute-vote：投票成功', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.castArbitrationVote = (opts) => {
    called = opts
    return { recorded: true, vote: opts.vote }
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('dispute-vote disp-1 guilty')
  assert.deepEqual(called, { disputeId: 'disp-1', vote: 'guilty' })
  const text = output._captured()
  assert.match(text, /投票已记录/)
  assert.match(text, /disp-1/)
  assert.match(text, /guilty/)
})

test('dispute-vote：投票失败打印原因', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.castArbitrationVote = () => ({ recorded: false, reason: '本节点不在 panel 中' })
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('dispute-vote disp-1 not-guilty')
  const text = output._captured()
  assert.match(text, /投票失败/)
  assert.match(text, /本节点不在 panel 中/)
})

test('dispute-resolve：缺 disputeId 打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('dispute-resolve')
  assert.match(output._captured(), /用法: dispute-resolve/)
})

test('dispute-resolve：达成裁决 + slash 执行 + 详情', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.resolveVerdict = (id) => {
    called = id
    return {
      resolved: true,
      verdict: 'guilty',
      slashExecuted: true,
      slashDetail: {
        slashAmount: 100,
        victimCompensation: 50,
        treasuryDeposit: 50,
      },
    }
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('dispute-resolve disp-1')
  assert.equal(called, 'disp-1')
  const text = output._captured()
  assert.match(text, /裁决已达成/)
  assert.match(text, /verdict/)
  assert.match(text, /guilty/)
  assert.match(text, /slash.*已执行/)
  assert.match(text, /slash 金额/)
  assert.match(text, /100/)
  assert.match(text, /赔受害者/)
  assert.match(text, /50/)
  assert.match(text, /进金库/)
})

test('dispute-resolve：达成裁决但无 slash', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.resolveVerdict = () => ({
    resolved: true, verdict: 'not-guilty', slashExecuted: false,
  })
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('dispute-resolve disp-1')
  const text = output._captured()
  assert.match(text, /裁决已达成/)
  assert.match(text, /not-guilty/)
  assert.doesNotMatch(text, /slash.*已执行/)
})

test('dispute-resolve：未达成裁决打印原因', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.resolveVerdict = () => ({
    resolved: false, reason: '当前票数 2/3，未达多数',
  })
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('dispute-resolve disp-1')
  const text = output._captured()
  assert.match(text, /暂未达成裁决/)
  assert.match(text, /2\/3/)
})

test('dispute-list：缺 arbitrationRegistry 打印错误', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  delete node.arbitrationRegistry
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('dispute-list')
  assert.match(output._captured(), /arbitrationRegistry 未初始化/)
})

test('dispute-list：无参数列出所有 dispute', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.arbitrationRegistry = {
    listDisputes: () => ['disp-1', 'disp-2'],
    getDispute: (id) => ({
      claimant: 'c', respondent: 'r', type: 'offer-breach',
      amount: 100, status: id === 'disp-1' ? 'voting' : 'resolved',
    }),
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('dispute-list')
  const text = output._captured()
  assert.match(text, /Dispute 列表 \(2\)/)
  assert.match(text, /disp-1/)
  assert.match(text, /disp-2/)
  assert.match(text, /voting/)
  assert.match(text, /resolved/)
})

test('dispute-list：无 dispute 打印提示', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.arbitrationRegistry = { listDisputes: () => [], getDispute: () => null }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('dispute-list')
  assert.match(output._captured(), /当前无 dispute/)
})

test('dispute-list <id>：未找到打印错误', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.arbitrationRegistry = { listDisputes: () => [], getDispute: () => undefined }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('dispute-list disp-x')
  assert.match(output._captured(), /未找到 dispute: disp-x/)
})

test('dispute-list <id>：显示详情 + 投票统计', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.arbitrationRegistry = {
    listDisputes: () => [],
    getDispute: () => ({
      claimant: 'did:c', respondent: 'did:r', type: 'offer-breach',
      amount: 100, status: 'voting', evidence: 'bafyev1',
      panel: ['j1', 'j2', 'j3'],
    }),
    getVoteStats: () => ({
      guilty: 2, 'not-guilty': 1, abstain: 0, total: 3,
      status: 'voting', verdict: null,
    }),
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('dispute-list disp-1')
  const text = output._captured()
  assert.match(text, /Dispute disp-1/)
  assert.match(text, /did:c/)
  assert.match(text, /did:r/)
  assert.match(text, /offer-breach/)
  assert.match(text, /100/)
  assert.match(text, /voting/)
  assert.match(text, /bafyev1/)
  assert.match(text, /投票统计/)
  assert.match(text, /guilty: 2/)
  assert.match(text, /not-guilty: 1/)
  assert.match(text, /abstain: 0/)
  assert.match(text, /total: 3/)
  assert.match(text, /3 个仲裁员/)
})

test('juror-register：默认用 context-A', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.registerJurorCandidate = (opts) => {
    called = opts
    return { registered: true, eligible: true }
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('juror-register')
  assert.deepEqual(called, { did: 'did:havix:A:mock' })
  const text = output._captured()
  assert.match(text, /已注册仲裁员候选/)
  assert.match(text, /当前资格/)
  assert.match(text, /合格/)
})

test('juror-register：手动指定 did', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.registerJurorCandidate = (opts) => { called = opts; return { registered: true, eligible: false } }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('juror-register did:custom-juror')
  assert.equal(called.did, 'did:custom-juror')
  assert.match(output._captured(), /不合格/)
})

test('juror-register：注册失败打印原因', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.registerJurorCandidate = () => ({ registered: false, reason: 'did 无效' })
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('juror-register did:x')
  assert.match(output._captured(), /注册失败/)
  assert.match(output._captured(), /did 无效/)
})

test('juror-register：钱包未初始化打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli({}, { silent: true, output })
  await cli.execute('juror-register')
  assert.match(output._captured(), /用法: juror-register/)
})

test('juror-eligibility：缺 did 打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('juror-eligibility')
  assert.match(output._captured(), /用法: juror-eligibility/)
})

test('juror-eligibility：合格场景打印全部字段', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.checkJurorEligibility = (did) => {
    called = did
    return {
      eligible: true,
      reputation: 120,
      vouchCount: 15,
      threshold: 75,
      reason: null,
    }
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('juror-eligibility did:juror1')
  assert.equal(called, 'did:juror1')
  const text = output._captured()
  assert.match(text, /仲裁员资格检查/)
  assert.match(text, /did:juror1/)
  assert.match(text, /是否合格/)
  assert.match(text, /reputation/)
  assert.match(text, /120/)
  assert.match(text, /vouchCount/)
  assert.match(text, /15/)
  assert.match(text, /threshold/)
  assert.match(text, /75/)
})

test('juror-eligibility：不合格场景打印原因', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.checkJurorEligibility = () => ({
    eligible: false,
    reputation: 50,
    vouchCount: 5,
    threshold: 75,
    reason: '信誉 < 中位数×1.5',
  })
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('juror-eligibility did:juror1')
  const text = output._captured()
  assert.match(text, /否/)
  assert.match(text, /信誉 < 中位数×1.5/)
})

// ──────────────────────────────────────────────
// M5-M7 命令：treasury
// ──────────────────────────────────────────────

test('treasury-balance：查询金库余额', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = false
  node.getTreasuryBalance = () => { called = true; return 250 }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('treasury-balance')
  assert.equal(called, true)
  const text = output._captured()
  assert.match(text, /金库余额/)
  assert.match(text, /250/)
})

test('treasury-history：无参数查全部历史', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.getTreasuryHistory = (id) => { called = id; return [] }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('treasury-history')
  assert.equal(called, undefined)
  assert.match(output._captured(), /当前无金库存入记录/)
})

test('treasury-history：按 disputeId 过滤', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.getTreasuryHistory = (id) => {
    called = id
    return [
      {
        at: 1700000000000,
        from: 'did:havix:A:respondent-xxxxxxxxxxxx',
        amount: 50,
        reason: 'slash from dispute disp-1',
        disputeId: 'disp-1',
      },
    ]
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('treasury-history disp-1')
  assert.equal(called, 'disp-1')
  const text = output._captured()
  assert.match(text, /金库存入历史 \(1\)/)
  assert.match(text, /\+50/)
  assert.match(text, /slash from dispute disp-1/)
  assert.match(text, /disp-1/)
})

test('treasury-history：disputeId 过滤但无记录', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.getTreasuryHistory = () => []
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('treasury-history disp-no-slash')
  assert.match(output._captured(), /disputeId=disp-no-slash/)
})

// ──────────────────────────────────────────────
// M5-M7 命令：market
// ──────────────────────────────────────────────

test('market-create：缺参数打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('market-create myapp')
  assert.match(output._captured(), /用法: market-create/)
})

test('market-create：最小参数 + 默认 options', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.createMarket = async (opts) => {
    called = opts
    return { marketId: 'mkt-1', topic: '/s-network/market/abc' }
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('market-create myapp 1.0.0 market')
  assert.deepEqual(called, {
    manifest: { name: 'myapp', version: '1.0.0', capability: 'market' },
  })
  const text = output._captured()
  assert.match(text, /市场已创建/)
  assert.match(text, /mkt-1/)
  assert.match(text, /\/s-network\/market\/abc/)
})

test('market-create：带 options 参数解析', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.createMarket = async (opts) => { called = opts; return { marketId: 'm1', topic: 't1' } }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute(
    'market-create myapp 1.0.0 wiki --permissions=read,write --min-reputation=50 --trust-weight=0.8 --spa-cid=bafyspa1',
  )
  assert.deepEqual(called, {
    manifest: {
      name: 'myapp', version: '1.0.0', capability: 'wiki',
      permissions: ['read', 'write'],
      min_reputation: 50,
      trust_weight: 0.8,
      spa_cid: 'bafyspa1',
    },
  })
})

test('market-create：permissions 含空格被 trim', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.createMarket = async (opts) => { called = opts; return { marketId: 'm1', topic: 't1' } }
  const cli = new Cli(node, { silent: true, output })
  // 含空格的 named 参数需引号包裹，否则 tokenize 会按空格拆开
  await cli.execute('market-create myapp 1.0.0 market --permissions=" a , b ,c,,"')
  assert.deepEqual(called.manifest.permissions, ['a', 'b', 'c'])
})

test('market-invite：缺参数打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('market-invite mkt-1')
  assert.match(output._captured(), /用法: market-invite/)
})

test('market-invite：调用 issueInvite 并打印令牌 JSON', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  const token = {
    toJSON: () => ({
      marketId: 'mkt-1', issuerDid: 'did:havix:A:me',
      inviteeDid: 'did:havix:B:bob', issuedAt: 1000, expiresAt: 2000, nonce: 'n1',
      signature: 'sig', signerPublicKey: 'pk',
    }),
  }
  node.issueInvite = async (opts) => { called = opts; return token }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('market-invite mkt-1 did:havix:B:bob --ttl=3600000')
  assert.deepEqual(called, { marketId: 'mkt-1', inviteeDid: 'did:havix:B:bob', ttlMs: 3600000 })
  const text = output._captured()
  assert.match(text, /邀请令牌已签发/)
  assert.match(text, /did:havix:B:bob/)
  assert.match(text, /"marketId":"mkt-1"/)
  assert.match(text, /"signature":"sig"/)
})

test('market-invite：未指定 ttl 时 ttlMs 为 undefined', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.issueInvite = async (opts) => { called = opts; return { toJSON: () => ({}) } }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('market-invite mkt-1 did:b')
  assert.equal(called.ttlMs, undefined)
})

test('market-join：缺参数打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('market-join')
  assert.match(output._captured(), /用法: market-join/)
})

test('market-join：JSON 解析失败打印错误', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('market-join not-valid-json')
  assert.match(output._captured(), /令牌 JSON 解析失败/)
})

test('market-join：成功加入', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.joinMarket = async (opts) => {
    called = opts
    return { marketId: 'mkt-1', topic: '/s-network/market/x' }
  }
  const cli = new Cli(node, { silent: true, output })
  // JSON 含 " 必须转义并整体引号包裹，否则 tokenize 会按 " 切分
  const tokenJson = JSON.stringify({ marketId: 'mkt-1', nonce: 'n1' })
  const escaped = tokenJson.replace(/"/g, '\\"')
  await cli.execute(`market-join "${escaped}"`)
  assert.deepEqual(called, { token: { marketId: 'mkt-1', nonce: 'n1' } })
  const text = output._captured()
  assert.match(text, /已加入市场/)
  assert.match(text, /mkt-1/)
  assert.match(text, /\/s-network\/market\/x/)
})

test('market-publish：缺参数打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('market-publish mkt-1')
  assert.match(output._captured(), /用法: market-publish/)
})

test('market-publish：payload JSON 解析失败打印错误', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('market-publish mkt-1 invalid-json')
  assert.match(output._captured(), /payload JSON 解析失败/)
})

test('market-publish：成功发布', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.publishToMarket = async (opts) => {
    called = opts
    return { topic: '/s-network/market/x', recipients: 3 }
  }
  const cli = new Cli(node, { silent: true, output })
  // JSON 含 " 必须转义并整体引号包裹
  const payloadJson = JSON.stringify({ type: 'offer', amount: 100 })
  const escaped = payloadJson.replace(/"/g, '\\"')
  await cli.execute(`market-publish mkt-1 "${escaped}"`)
  assert.deepEqual(called, { marketId: 'mkt-1', payload: { type: 'offer', amount: 100 } })
  const text = output._captured()
  assert.match(text, /消息已发布/)
  assert.match(text, /mkt-1/)
  assert.match(text, /3 peer/)
})

test('market-leave：缺 marketId 打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('market-leave')
  assert.match(output._captured(), /用法: market-leave/)
})

test('market-leave：调用 leaveMarket 并打印成功', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let called = null
  node.leaveMarket = async (id) => { called = id }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('market-leave mkt-1')
  assert.equal(called, 'mkt-1')
  assert.match(output._captured(), /已离开市场 mkt-1/)
})

test('market-list：列出本节点参与的市场', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.listMarkets = () => ['mkt-1', 'mkt-2']
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('market-list')
  const text = output._captured()
  assert.match(text, /市场列表 \(2\)/)
  assert.match(text, /mkt-1/)
  assert.match(text, /mkt-2/)
})

test('market-list：无市场打印提示', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.listMarkets = () => []
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('market-list')
  assert.match(output._captured(), /当前无参与的市场/)
})

test('market-info：缺 marketId 打印用法', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('market-info')
  assert.match(output._captured(), /用法: market-info/)
})

test('market-info：未找到打印错误', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.marketRegistry = { getMarket: () => undefined, isMember: () => false }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('market-info mkt-x')
  assert.match(output._captured(), /mkt-x 不存在或未加入/)
})

test('market-info：显示 manifest + topic + 创建者身份', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  let memberCalled = null
  node.marketRegistry = {
    getMarket: () => ({
      manifest: {
        name: 'translation-market', version: '1.0.0', capability: 'market',
        permissions: ['read', 'write'],
        minReputation: 50, trustWeight: 0.8, spaCid: 'bafyspa1',
      },
      topic: '/s-network/market/abcd',
      isCreator: true,
    }),
    isMember: (id) => { memberCalled = id; return true },
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('market-info mkt-1')
  assert.equal(memberCalled, 'mkt-1')
  const text = output._captured()
  assert.match(text, /市场 mkt-1/)
  assert.match(text, /translation-market/)
  assert.match(text, /1\.0\.0/)
  assert.match(text, /market/)
  assert.match(text, /read, write/)
  assert.match(text, /50/)
  assert.match(text, /0\.8/)
  assert.match(text, /bafyspa1/)
  assert.match(text, /\/s-network\/market\/abcd/)
  assert.match(text, /是否创建者/)
  assert.match(text, /是否成员/)
})

test('market-info：非创建者 + 无 permissions/spa-cid', async () => {
  const output = makeOutput()
  const node = makeMockNode()
  node.marketRegistry = {
    getMarket: () => ({
      manifest: {
        name: 'minimal', version: '0.1.0', capability: 'wiki',
        permissions: [],
        minReputation: 30, trustWeight: 0.5, spaCid: null,
      },
      topic: '/s-network/market/x',
      isCreator: false,
    }),
    isMember: () => true,
  }
  const cli = new Cli(node, { silent: true, output })
  await cli.execute('market-info mkt-1')
  const text = output._captured()
  assert.doesNotMatch(text, /permissions/)
  assert.doesNotMatch(text, /spa_cid/)
})

// ──────────────────────────────────────────────
// help 系统覆盖 M5-M7 新命令分类
// ──────────────────────────────────────────────

test('help：列出所有 M5-M7 命令分类', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('help')
  const text = output._captured()
  assert.match(text, /\[Relay 选举 \(M5\)\]/)
  assert.match(text, /\[私聊隧道 \(M5\)\]/)
  assert.match(text, /\[仲裁 \+ Slash \(M6\)\]/)
  assert.match(text, /\[金库审计 \(M6\)\]/)
  assert.match(text, /\[邀请市场 \(M7\)\]/)
  assert.match(text, /relay-register/)
  assert.match(text, /tunnel-open/)
  assert.match(text, /dispute-file/)
  assert.match(text, /treasury-balance/)
  assert.match(text, /market-create/)
})

test('help <cmd>：显示 dispute-file 详情', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('help dispute-file')
  const text = output._captured()
  assert.match(text, /命令: dispute-file/)
  assert.match(text, /分类: arbitration/)
  assert.match(text, /offer-breach/)
  assert.match(text, /relay-malice/)
  assert.match(text, /vouch-collusion/)
  assert.match(text, /\/s-network\/alert/)
})

test('help <cmd>：显示 market-create 详情', async () => {
  const output = makeOutput()
  const cli = new Cli(makeMockNode(), { silent: true, output })
  await cli.execute('help market-create')
  const text = output._captured()
  assert.match(text, /命令: market-create/)
  assert.match(text, /分类: market/)
  assert.match(text, /--permissions/)
  assert.match(text, /--min-reputation/)
  assert.match(text, /--trust-weight/)
  assert.match(text, /--spa-cid/)
})
