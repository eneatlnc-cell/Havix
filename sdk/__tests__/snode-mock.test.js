/**
 * mock SNode 单元测试（M9.2）
 * 验证 mock SNode 提供的方法可工作 + 调用记录正确。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSnodeMock, DEFAULT_DIDS } from '../__mocks__/snode-mock.js'

test('mock SNode: 提供 4-context DID 与 wallet', () => {
  const snode = createSnodeMock()
  assert.equal(snode.wallet.masterPeerId.toString(), DEFAULT_DIDS.main)
  assert.equal(snode.wallet.get('A').did, DEFAULT_DIDS.A)
  assert.equal(snode.wallet.get('B').did, DEFAULT_DIDS.B)
  assert.equal(snode.wallet.get('C').did, DEFAULT_DIDS.C)
  assert.equal(snode.wallet.get('D').did, DEFAULT_DIDS.D)
})

test('mock SNode: wallet.get 不存在的 context 抛错', () => {
  const snode = createSnodeMock()
  assert.throws(() => snode.wallet.get('X'), /未找到 context X/)
})

test('mock SNode: wallet.sign + verify 端到端', async () => {
  const snode = createSnodeMock()
  const id = snode.wallet.get('B')
  const data = new Uint8Array([1, 2, 3])
  const sig = await id.sign(data)
  assert.equal(sig.length, 64)
  const ok = await id.verify(data, sig)
  assert.equal(ok, true)
})

test('mock SNode: createMarket 返回合法结构 + 调用记录', async () => {
  const snode = createSnodeMock()
  const manifest = { name: 'inner', version: '1.0.0', capability: 'market', permissions: [], entryPoint: './index.js' }
  const result = await snode.createMarket({ manifest, ttlMs: 1000 })
  assert.ok(result.marketId)
  assert.ok(result.topic.startsWith('/s-network/market/'))
  assert.ok(result.token)
  assert.equal(snode.calls.createMarket.length, 1)
  assert.equal(snode.calls.createMarket[0][0].manifest, manifest)
})

test('mock SNode: issueCredit 更新 creditLedger 余额', async () => {
  const snode = createSnodeMock()
  await snode.issueCredit({ holderDid: 'did:h:1', amount: 100 })
  assert.equal(snode.creditLedger.getBalance('did:h:1'), 100)
  await snode.consumeCredit({ holderDid: 'did:h:1', issuerDid: 'did:i:1', amount: 30 })
  assert.equal(snode.creditLedger.getBalance('did:h:1'), 70)
})

test('mock SNode: transferCredit 在两个 holder 间转账', async () => {
  const snode = createSnodeMock()
  await snode.issueCredit({ holderDid: 'did:a', amount: 100 })
  snode.transferCredit({ fromDid: 'did:a', toDid: 'did:b', amount: 40 })
  assert.equal(snode.creditLedger.getBalance('did:a'), 60)
  assert.equal(snode.creditLedger.getBalance('did:b'), 40)
})

test('mock SNode: establishTunnel + sendTunnelChunk + closeTunnel', async () => {
  const snode = createSnodeMock()
  const { tunnelId } = await snode.establishTunnel({ targetDid: 'did:target' })
  const r = await snode.sendTunnelChunk({ tunnelId, chunk: new Uint8Array([1]) })
  assert.ok(r.relay)
  assert.equal(r.sequence, 1)
  snode.closeTunnel(tunnelId)
  assert.equal(snode._state.tunnels.get(tunnelId).status, 'closed')
})

test('mock SNode: wiki.publishEntry + listEntries + getEntry', async () => {
  const snode = createSnodeMock()
  const { cid } = await snode.wiki.publishEntry({ title: 't1', content: 'hello' })
  assert.ok(cid.startsWith('bafy'))
  const list = snode.wiki.listEntries()
  assert.equal(list.length, 1)
  const entry = snode.wiki.getEntry(cid)
  assert.equal(entry.title, 't1')
})

test('mock SNode: fileDispute + summonArbitrationPanel + castArbitrationVote + resolveVerdict', async () => {
  const snode = createSnodeMock()
  const { dispute } = await snode.fileDispute({ respondent: 'did:r', type: 'offer-breach', amount: 5 })
  assert.equal(dispute.status, 'panel-summoning')
  const panel = snode.summonArbitrationPanel(dispute.disputeId)
  assert.equal(panel.count, 3)
  const vote = snode.castArbitrationVote({ disputeId: dispute.disputeId, vote: 'guilty' })
  assert.equal(vote.recorded, true)
  const verdict = snode.resolveVerdict(dispute.disputeId)
  assert.equal(verdict.verdict, 'guilty')
})

test('mock SNode: ipfs.blockstore.put + get 端到端', async () => {
  const snode = createSnodeMock()
  // blockstore.put 需要 CID 对象，用 multiformats 构造
  const { CID } = await import('multiformats/cid')
  const { sha256 } = await import('multiformats/hashes/sha2')
  const bytes = new Uint8Array([1, 2, 3, 4])
  const hash = await sha256.digest(bytes)
  const cid = CID.createV1(0x55, hash)
  await snode.ipfs.blockstore.put(cid, bytes)
  let got
  for await (const chunk of snode.ipfs.blockstore.get(cid)) {
    got = chunk
  }
  assert.deepEqual(got, bytes)
})

test('mock SNode: 自定义 dids 选项可覆盖默认 DID', () => {
  const snode = createSnodeMock({ dids: { main: 'did:custom:main', A: 'did:custom:A', B: 'did:custom:B', C: 'did:custom:C', D: 'did:custom:D' } })
  assert.equal(snode.wallet.masterPeerId.toString(), 'did:custom:main')
  assert.equal(snode.wallet.get('A').did, 'did:custom:A')
})

test('mock SNode: 自定义 ledgers 选项可初始化余额', () => {
  const snode = createSnodeMock({ ledgers: { credit: [['did:h:1', 1000]] } })
  assert.equal(snode.creditLedger.getBalance('did:h:1'), 1000)
})
