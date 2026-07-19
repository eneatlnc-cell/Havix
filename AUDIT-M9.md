# Havix 深度审计报告（M9 完成后）

**审计时间**：2026-07-19 · **审计范围**：`/workspace/src/` + `/workspace/sdk/` + `/workspace/test/` + `/workspace/apps/` · **基线**：M9.5 完成（commit `20aa9f2`），全量回归 953/953 通过

---

## 审计方法

并行 3 个 subagent 分别审计 SDK 层 / 协议层 / 测试覆盖，逐行核对源码与测试文件。本报告汇总三方发现，按 P0（致命）/ P1（高危）/ P2（中低危）分级。

**审计覆盖**：
- SDK 层 16 个文件：errors / permissions / manifest / app / context / credit / state / cli / web / market / wiki / tunnel / arbitration / transport / ipfs / snode-mock
- 协议层 16 个核心文件：message-types / s-node / persistence / config / app/cli / app/web-panel / app/app-manager + identity / credit / vouch / wiki / market / arbitration / tunnel / relay / dht 协议模块
- 测试层 27 个 test 文件 + 15 个 sdk/__tests__ 文件，共 953 测试

**已确认历史修复**：M8 阶段标注的 P0-1 至 P0-6、P1-arb-mirror / P1-market-gate / P1-bounds / P1-lru / P1-threshold / P2-1/2/3 均已正确落地。本报告只列**新发现**。

---

## P0 — 致命（可直接利用 / 危及主机或同节点其他 App）

### [P0-1] state.js 的 opts.dataDir 路径穿越未校验

**文件**：[`sdk/state.js`](file:///workspace/sdk/state.js) L54-62, L174-179

```js
const dataDirName = opts.dataDir ?? manifest.dataDir ?? manifest.name
const persistDir = path.join(snode?.config?.dataDir ?? '.data', 'ledgers', 'apps', dataDirName)
const persistPath = path.join(persistDir, 'state.json')
// ...
async function flush() { persist.saveJsonAtomic(persistPath, data, { log }) }
```

`opts.dataDir` 由 `createApp(snode, manifest, options)` 透传（`sdk/app.js:60-61, 125-128`），**完全没有路径校验**。`manifest.dataDir` 自身在 `manifest.js:353-381` 已校验 `..` 与绝对路径，但 `options.dataDir` 覆盖值**绕过该检查**。

`path.join` 会规整 `..`，传入 `options.dataDir = '../../../etc/cron.d'` 即可让 `flush()` 写入 `/etc/cron.d/state.json` 之类位置。考虑到 `set()` 每次都触发 `flush()`，写入是高频可控的——等于**任意文件写入**。

**修复**：在 `createStateApi` 入口对 `opts.dataDir` 调用与 `validateDataDir` 等价的校验（拒绝绝对路径、`..`、`\\`、空字节），复用 manifest 校验函数避免逻辑漂移。

---

## P1 — 高危（可绕过权限 / 跨 App 影响 / mock 与真实行为严重不一致）

### [P1-1] AppManager entryPoint 路径穿越

**文件**：[`src/app/app-manager.js`](file:///workspace/src/app/app-manager.js) L156

```js
const entryPath = path.resolve(appDir, manifest.entryPoint)
```

`manifest.entryPoint` 直接由 `manifest.yaml` 提供，仅 `fs.existsSync` 检查，未校验 `entryPath` 是否仍位于 `appDir` 之内。恶意 manifest 可写 `entryPoint: "../../../etc/passwd"` 或绝对路径。由于 `await import(entryPath)` 会执行模块顶层代码，等价于**任意代码执行**。

> 注：`sdk/manifest.js:192-232` 的 `validateEntryPoint` 已拒绝 `..` 与绝对路径。本条仅当 AppManager 调用方绕过 `AppManifest.fromYaml` 直接传入未校验 manifest 时触发。建议在 AppManager 二次防御。

**修复**：

```js
const entryPath = path.resolve(appDir, manifest.entryPoint)
const rel = path.relative(appDir, entryPath)
if (rel.startsWith('..') || path.isAbsolute(rel)) {
  throw new InvalidAppStateError(
    `entryPoint 越界：${manifest.entryPoint} 不在 app 目录内`)
}
```

### [P1-2] context.sign 不校验 identity:context:<X> 权限

**文件**：[`sdk/context.js`](file:///workspace/sdk/context.js) L117-143；[`sdk/permissions.js`](file:///workspace/sdk/permissions.js) L60-63

`permissions.js` 显式声明 4 个 `identity:context:A/B/C/D` 权限（注释为"用 context-X 签名"），但 `context.sign()` 仅检查 `enabledContexts.includes(contextKey)`（即 `manifest.contexts` 数组），**从未调用 `checkPermission`**。

后果：App 在 manifest 中声明 `contexts: ['A']` 但 permissions 数组里**不包含** `identity:context:A`，仍然可以正常签名。这 5 项权限（`identity:context` + 4 个子项）事实上是死代码，权限白名单的"完整性保证"被架空。

**修复**：在 `sign()` 中追加 `checkPermission(perms, CONTEXT_PERMISSION[contextKey], {app: appName})`；或在 `permissions.js` 中删除这 5 项误导性权限并明确文档说明"context 使用由 manifest.contexts 单独门控"。

### [P1-3] context.getAll / getEnabled / getStatus 不校验 identity:context 权限

**文件**：[`sdk/context.js`](file:///workspace/sdk/context.js) L64-108

`getAll()` / `getEnabled()` / `getStatus()` 三个方法**全部没有 checkPermission 调用**。空权限的 App 即可读取本节点完整 4-context DID 集合（包括 context-C 私聊身份、context-D 维基编辑身份），违反最小权限原则。这些 DID 是后续发起社会工程或定向攻击的关键信息。

**修复**：在三个方法入口添加 `checkPermission(perms, 'identity:context', {app: appName})`。

### [P1-4] transport.validateTopic 黑名单仅拦一个前缀

**文件**：[`sdk/transport.js`](file:///workspace/sdk/transport.js) L47-57

```js
if (topic.startsWith('/s-network/market/')) {
  throw new Error('transport: 禁止直接使用 market topic 前缀')
}
```

仅挡 `/s-network/market/`，但 `src/s-node.js:79-93` 列出的敏感系统 topic 还包括：
- `/s-network/reputation/`（credit 消息，可触发镜像账本更新）
- `/s-network/alert/`（arbitration 消息，可触发 filed/verdict 镜像）
- `/s-network/announce/` 等公共频道

App 拥有 `transport:publish` 权限即可直接往这些 topic 注入伪造消息（虽然真实 SNode 有外层签名验证 P0-1，但 SDK 层应主动避免误用）。

**修复**：黑名单改为完整系统前缀列表，或采用白名单（强制 `/havix-app/` 前缀，与 `TOPIC_PREFIX` 常量一致）。

### [P1-5] web.mount 的 opts.dir 无路径校验

**文件**：[`sdk/web.js`](file:///workspace/sdk/web.js) L71-95

`mount()` 仅校验 `opts.dir` 是非空字符串，**没有任何路径穿越检查**。M9.4 已接入 WebPanel 读取 `mounts[].dir` 下的静态文件返回。一旦 App 注册 `web.mount('/apps/x/', {type:'static', dir:'../../../../etc'})` 即可让其他用户通过 HTTP 拉取任意文件。

**修复**：在 `mount()` 中复用 manifest 的 `validateDataDir` 逻辑（拒绝绝对路径、`..`、`\\`），并强制 dir 必须是相对 App 自己目录的子路径。

### [P1-6] credit._onReceived 内部 API 泄露给 App

**文件**：[`sdk/credit.js`](file:///workspace/sdk/credit.js) L145-166

```js
return {
  issue, consume, transfer, balance, onReceived,
  _onReceived,   // ← 注释说"不直接暴露给 App"，但实际在 return 对象里
}
```

App 可直接 `app.credit._onReceived(fakeMsg)` 触发所有 onReceived handler 执行，传入完全伪造的 `creditMsg`（含任意 `senderId`、`amount`、`note`）。empty-app 等示例 App 的 handler 会把伪造数据写入 `app.state.set('lastCreditReceived', ...)`，后续业务可能基于该状态做错误决策。

**修复**：用 Symbol 或 WeakMap 把内部 handler 列表私有化；或返回对象时不暴露 `_onReceived`，改为通过单独的 `attachInternalDispatcher` 函数由 AppManager 持有引用。

### [P1-7] app.stop() 清理影响其他 App 的订阅与 handler

**文件**：[`sdk/app.js`](file:///workspace/sdk/app.js) L144-151

```js
app.stop = async function () {
  if (snode._transportSubscriptions) snode._transportSubscriptions.clear()  // ← 全局清空
  if (snode._marketSubscriptions) snode._marketSubscriptions.clear()
  if (snode._creditHandlers) snode._creditHandlers.length = 0
  await app.state.flush?.()
}
```

`snode._transportSubscriptions` 等是挂在 snode 上的**共享 Map/Set/Array**，被所有 App 共用。停止 App A 会清空 App B、C 的订阅，导致 App B 静默失联。也是一种 DoS 向量：恶意 App 反复 start/stop 可让其他 App 持续掉线。

**修复**：每个 App 在 `createXxxApi` 时维护**自己的** subscription 集合（`credit.js` 已经维护了 `appHandlers`，但 transport/market 没有），`app.stop()` 只清理自己注册的部分。

### [P1-8] issueInvite 静默跳过 min_reputation 校验

**文件**：[`src/s-node.js`](file:///workspace/src/s-node.js) L1146

```js
if (manifest && this.reputationLedger) {
  const inviteeRep = this.reputationLedger.getAvailable(inviteeDid)
  if (inviteeRep < manifest.minReputation) throw new InsufficientReputationError(...)
}
```

当 `this.reputationLedger` 为 `null`（注入失败、测试桩缺失、构造异常等场景）时，**整个 min_reputation 守卫被静默跳过**，没有任何日志或抛错。攻击者只要触发 reputationLedger 注入失败即可绕过白皮书 §8.2 的硬性准入门槛。

**修复**：将"未注入 ledger"视为致命错误而非静默跳过：

```js
if (!manifest) throw new Error('manifest 缺失')
if (!this.reputationLedger) {
  throw new Error('reputationLedger 未初始化，拒绝签发邀请（安全默认）')
}
```

### [P1-9] 市场消息 senderId 未与成员身份绑定（伪造发言）

**文件**：[`src/s-node.js`](file:///workspace/src/s-node.js) L1520-1553

`_handleMarketTopicMessage` 只校验 `envelope.senderId` 是非空字符串，**不校验 senderId 是否对应实际市场成员**。M7 设计中邀请令牌可转发，任何持有令牌者均可派生 AES 密钥并解密；但同密钥也允许加密。后果：
- 市场内任何成员可冒名其他成员发言（如高信誉卖家发布欺诈 offer）
- 受害成员无法自证清白（AES-GCM 仅认证密文完整性，**不绑定发送方身份**）

**修复**：在 AES-GCM 加密的 payload 内部追加一层 Ed25519 签名——"外层 AES-GCM 防外人，内层 Ed25519 防熟人"。

### [P1-10] 仲裁裁决 panel 校验可被消息时序绕过

**文件**：[`src/s-node.js`](file:///workspace/src/s-node.js) L1656

```js
if (dispute.panel && dispute.panel.length > 0 && !dispute.panel.includes(senderId)) {
  return { applied: false, reason: 'verdict senderId 不在 panel 中' }
}
```

校验**仅在本地已镜像 panel 时**生效。若攻击者抢在 `panel-summoned` 消息到达前发送 `verdict` 消息（或故意先广播 verdict 阻断 panel 镜像），则本地 `dispute.panel` 仍为空数组 → 校验被跳过 → 任意节点可伪造裁决触发 slash。

**修复**：改为 fail-closed：

```js
if (!dispute.panel || dispute.panel.length === 0) {
  return { applied: false, reason: '本地未镜像 panel，拒绝裁决（fail-closed）' }
}
if (!dispute.panel.includes(senderId)) {
  return { applied: false, reason: 'verdict senderId 不在 panel 中' }
}
```

### [P1-11] ReputationLedger / CreditLedger 主账本 Map 无 LRU 上限

**文件**：[`src/protocol/credit.js`](file:///workspace/src/protocol/credit.js)

`ReputationLedger.balances` 与 `CreditLedger.balances` 是普通 `Map<string, {...}>`，无任何容量上限。攻击者通过持续广播不同 DID 的 credit/vouch 消息（DID 生成成本极低），可让 Map 无限增长，最终耗尽内存导致 OOM。

对比：`_processedCreditNonces` 已加 100k FIFO LRU（P1-lru 修复），但**主账本 Map 漏修**。

**修复**：为 balances Map 加 100k FIFO 上限，或要求 DID 必须先经 vouch 门槛方可入账（reputation-only-for-vouched 模式）。

### [P1-12] VouchRegistry 顶层 vouches Map 无 LRU

**文件**：[`src/protocol/vouch.js`](file:///workspace/src/protocol/vouch.js)

仅 `endorseDid → Set<voucherDid>` 中**每个 Set** 有 10k 上限，但**顶层 `vouches` Map 本身无上限**。攻击者可创建海量 endorseDid（每个对应一个 10k Set），总体内存仍无限增长。

**修复**：为 `vouches` Map 本身加 100k 上限，且超限时优先驱逐"无 vouch 或 vouch 最少"的 endorseDid。

### [P1-13] ArbitrationRegistry.jurorPool 与 TreasuryLedger.history 无 LRU

**文件**：[`src/protocol/arbitration.js`](file:///workspace/src/protocol/arbitration.js) L315, L152

- `jurorPool` Map 无容量限制。任何 `registerJurorCandidate` 调用都会塞入，攻击者可灌入海量伪 DID。
- `TreasuryLedger.history` Array 永久追加，无截断。长期运行节点积累大量 slash 记录会拖慢 `getHistory()` 和持久化序列化。

对比：`disputes` Map 已加 `_maxDisputes = 100_000`，但 jurorPool 与 history 漏修。

**修复**：jurorPool 加 100k 上限；TreasuryLedger.history 限制最近 100k 条，旧记录归档到 IPFS。

### [P1-14] RelayRegistry 多个集合无 LRU

**文件**：[`src/network/relay.js`](file:///workspace/src/network/relay.js) L106-112

- `candidates` Map 无上限
- `activeRelays` Set 无上限
- `history` Array 无上限（永久追加 elected/retired/rotated 事件）

`registerCandidate` 接受任意 did 字符串入库，不强制先经 vouch 验证。

**修复**：candidates 限制为已 vouch 的节点子集；history 限制最近 10k 条。

### [P1-15] DhtGate._privateCids 与 _privateSources 无 LRU

**文件**：[`src/network/dht.js`](file:///workspace/src/network/dht.js) L35-39

`registerPrivateCid` 接受任意 CID 入 deny list，无上限。

**修复**：加 100k LRU；超限时按注册时间淘汰最旧 CID（需配合 CID TTL 机制防被淘汰的 CID 重新 provide 绕过门控）。

### [P1-16] App 与 SNode 同进程运行，无沙箱

**文件**：[`src/app/app-manager.js`](file:///workspace/src/app/app-manager.js) L178

App 通过 `sdk.createApp(this.snode, ...)` 装配，**直接拿到 snode 引用**，可访问 libp2p/helia/钱包/账本等所有敏感对象。任意 App 代码（包括第三方 manifest）可：
- 读取钱包私钥（context-A/B/C/D 全部）
- 修改 credit/reputation 账本
- 调用 `snode.libp2p.services.pubsub.publish` 向任意 topic 广播
- 调用 `process.exit()` 杀掉整个节点

代码注释虽承认"App 加载失败不阻断其他 App"，但**未提及 App 间的安全隔离**。

**修复**：
- 短期：通过 SDK 显式收敛 App 可调用 API（白名单），剥离 snode 直接引用。
- 长期：使用 worker_thread 或子进程隔离 App，通过 IPC 暴露受限 API。

### [P1-17] manifest.dataDir / entryPoint 路径校验不防 Windows 反斜杠 / 空字节

**文件**：[`sdk/manifest.js`](file:///workspace/sdk/manifest.js) L362-380, L212-230

```js
if (value.startsWith('/') || value.match(/^[a-zA-Z]:/)) { throw ... }
if (value.includes('..')) { throw ... }
```

仅挡 POSIX 绝对路径与 `C:` 形式 Windows 路径。以下未拦截：
- `\\server\share` UNC 路径（Windows）
- `\Windows\System32` 不带 `..` 的反斜杠绝对路径
- `foo\0bar` 空字节（部分 fs API 会截断）
- `~/` tilde 展开（shell 上下文）

**修复**：用 `path.posix.normalize` + 比对结果是否仍以 `..` 起始或为绝对路径；同时拒绝 `\\`、`\0`、`~`。

### [P1-18] mock issueCredit 完全跳过信誉门槛

**文件**：[`sdk/__mocks__/snode-mock.js`](file:///workspace/sdk/__mocks__/snode-mock.js) L307-325

真实 SNode → `faucet.issue()` 会做 `issuerRep >= minReputation` 检查并 `repLedger.freeze(issuerDid, amount)`。Mock 直接 `creditBalances.set(holderDid, ..., +amount)`，**没有任何信誉校验、没有冻结操作**。所有依赖 mock 的单元测试都无法验证"低信誉节点签发 credit 被拒"这条核心安全路径；mock 返回的 `note.signature = new Uint8Array(64)`（全 0）也无法被真实 `verifyCreditNoteSignature` 验证通过。

**修复**：mock 中提供 `minReputation` 配置项并实际拒绝低信誉 issuer；返回的 `note.signature` 至少用 `wallet.get('A').sign(canonicalNote)` 真签一次。

### [P1-19] mock joinMarket 不调用 InviteToken.verifySelf

**文件**：[`sdk/__mocks__/snode-mock.js`](file:///workspace/sdk/__mocks__/snode-mock.js) L491-497

真实 SNode 的 P0-4 修复要求 `joinMarket` 强制 `InviteToken.verifySelf()` 防伪造 issuer 签发令牌。Mock 只 `markets.get(token.marketId).members.add(token.inviteeDid)`，**不验签、不验过期、不验 issuerDid 与本地 wallet 关系**。一个伪造的 token `{marketId, inviteeDid: 'anyone'}` 即可加入任意市场。

**修复**：mock 中至少校验 `token.expiresAt > Date.now()` 与 `token.signature` 字段存在；提供开关让测试主动 opt-in 严格校验。

---

## P2 — 中低危（资源耗尽 / 健壮性 / mock 小差异 / 设计不一致）

### [P2-1] state store 无 key 数量上限 + 无 value 大小上限

**文件**：[`sdk/state.js`](file:///workspace/sdk/state.js) L86-110, L156-166

`store = new Map()` 没有上限。`set()` 每次都 `JSON.stringify(value)` + `flush()`。恶意 App 写入 10^7 个 key 即可耗尽内存；写入 1GB 字符串会一次性占用 1GB 内存 + 写入 1GB JSON 文件。

**修复**：加 `MAX_STATE_KEYS = 10000` + `MAX_VALUE_SIZE = 1MB`，超限抛 QuotaExceededError。

### [P2-2] credit.onReceived handler 列表无上限

**文件**：[`sdk/credit.js`](file:///workspace/sdk/credit.js) L125-135

`appHandlers.push(callback)` 无数量上限。恶意 App 可注册百万级空 handler 占用内存；每次 `_onReceived` 都会 await 串行执行所有 handler（`for...of` + `await`），可能造成 CPU DoS。

**修复**：`MAX_CREDIT_HANDLERS = 64`，超限抛错；考虑并行执行或加超时。

### [P2-3] cli.execute 不捕获 handler 异常

**文件**：[`sdk/cli.js`](file:///workspace/sdk/cli.js) L126-132

`cmd.handler(args)` 抛错直接传播到调用方。对照 `web.js:158-178` web handler 有 try/catch 返回 500，CLI 没有同等保护。如果 AppManager 在 REPL 上下文执行命令且未捕获，单个 App 的命令异常会终止整个 REPL。

**修复**：包装 try/catch，统一返回 `{ok:false, error: err.message}` 或重新抛出但带上命令名上下文。

### [P2-4] web 路由 / mount 注册无上限 + 线性扫描

**文件**：[`sdk/web.js`](file:///workspace/sdk/web.js) L40-42, L103-112, L71-95

`routes = []`、`mounts = []` 无上限。重复检测是 O(n) 线性扫描，恶意 App 注册 10^6 路由会让 `get()`/`hasRoute()` 慢到不可用。

**修复**：用 Map 加速路径查找，并加 `MAX_ROUTES = 1024` 上限。

### [P2-5] manifest 字段长度无上限（除 name/version 外）

**文件**：[`sdk/manifest.js`](file:///workspace/sdk/manifest.js) L269-286, L442-451

`spaCid` 仅校验非空，`description` 无长度限制，`entryPoint` 仅校验非空 + 不含 `..`。一个 1MB 的 description 字符串会直接进入内存并参与 `toJSON()`。

**修复**：每个字段加合理上限（如 description ≤ 4KB，entryPoint ≤ 256）。

### [P2-6] arbitration 只读方法无任何权限门控

**文件**：[`sdk/arbitration.js`](file:///workspace/sdk/arbitration.js) L115-147

`treasuryBalance()` / `treasuryHistory(disputeId)` / `checkJurorEligibility(did)` 都没有 checkPermission。`checkJurorEligibility(did)` 可被任意 App 用于枚举全网仲裁员资格，是典型的信息泄露向量。

**修复**：至少 `checkJurorEligibility` 应要求 `arbitration:vote` 或新增 `arbitration:query` 权限。

### [P2-7] manifest 不校验 capability 与 permissions 的一致性

**文件**：[`sdk/manifest.js`](file:///workspace/sdk/manifest.js) L475-503

`capability: 'wiki'` 的 App 仍可在 permissions 中声明 `market:publish`、`tunnel:open` 等无关权限并实际调用。manifest 校验只验证字段格式，不验证语义一致性。削弱了 capability 字段作为"App 类型声明"的作用。

**修复**：可选地在 `validatePermissionsField` 中按 capability 给出 warning（不强制 error，保持灵活）。

### [P2-8] mock consumeCredit 不释放冻结信誉；mock transferCredit 允许负余额

**文件**：[`sdk/__mocks__/snode-mock.js`](file:///workspace/sdk/__mocks__/snode-mock.js) L326-338

真实 `Faucet.consume` 会 `repLedger.release(issuerDid, amount)`；mock 只 `creditBalances.set(holderDid, ..., -amount)` 返回 `releasedFrozen: amount`，但实际未操作 reputation ledger。`transferCredit` 不做 `< amount` 检查，fromDid 可变负数。测试无法发现"释放失败"或"余额不足"路径。

**修复**：mock 中维护 `frozenReputation` Map，`consume` 实际扣减；`transfer` 加余额检查。

### [P2-9] mock publishToMarket 不做加密、不验证成员

**文件**：[`sdk/__mocks__/snode-mock.js`](file:///workspace/sdk/__mocks__/snode-mock.js) L513-517

真实 `publishMarketMessage` 做 AES-256-GCM 加密（白皮书 §6.5 第二层），mock 直接记录 payload。依赖 mock 的测试无法验证"消息内容是否被正确加密"。

**修复**：mock 中至少做 HKDF 派生 + AES-GCM 加密 stub（或文档说明此限制并要求加密测试走集成测试）。

### [P2-10] mock Identity.verify 简化为首字节匹配

**文件**：[`sdk/__mocks__/snode-mock.js`](file:///workspace/sdk/__mocks__/snode-mock.js) L64-69

```js
async verify(data, signature) {
  return signature instanceof Uint8Array
    && signature.length === 64
    && signature[0] === this.contextKey.charCodeAt(0)
}
```

任何 64 字节、首字节匹配 contextKey ASCII 码的 signature 都会通过。SDK `context.verify()` 的所有测试都无法发现真实签名实现缺陷。

**修复**：mock 用 `@noble/curves/ed25519` 真实实现 sign/verify（mock 文件不强求零依赖）。

### [P2-11] WebPanel 允许空 Host 头 + 向 App 透传完整 req.headers

**文件**：[`src/app/web-panel.js`](file:///workspace/src/app/web-panel.js) L163；[`src/app/app-manager.js`](file:///workspace/src/app/app-manager.js) L365

```js
const allowedHosts = new Set([ ..., '', ])  // 空字符串被允许
```

注释称"HTTP/1.0 无 Host 头"作为允许理由，但现代浏览器均发送 Host。允许空 Host 意味着任何能构造 HTTP/1.0 请求的客户端（如 curl `-H "Host:"`）可绕过 DNS rebinding 防护。

`handleAppWebRequest` 直接接收 `req` 对象，包括 `Cookie`、`Authorization`、`X-Api-Key` 等敏感头。App 代码若日志记录 `req.headers` 或转发给第三方，将泄露用户凭据。

**修复**：删除空字符串条目；在 WebPanel → AppManager 边界显式白名单透传头（如 `Content-Type`、`Accept`），剥离认证类头。

### [P2-12] saveJsonAtomic 使用同步 fs API，阻塞事件循环

**文件**：[`src/persistence.js`](file:///workspace/src/persistence.js)

`fs.writeFileSync` + `fs.renameSync` 在每次账本变更时同步落盘。对于高频路径（如 credit 消息镜像、vouch 累积），同步 IO 会阻塞 libp2p 网络回调，导致消息延迟、心跳超时。

**修复**：高频路径改为异步 `fs.promises.writeFile` + `rename`；或采用写合并 + 防抖（如 100ms 内多次 mutation 合并为一次落盘）。

### [P2-13] startApp 信号处理在 stop 失败时强退 0

**文件**：[`src/s-node.js`](file:///workspace/src/s-node.js) L2019-2020

```js
proc.on('SIGINT', () => { stop('SIGINT').catch(() => proc.exit(0)) })
```

若 `stop()` 抛错（如 libp2p 关闭异常），直接 `proc.exit(0)` 退出码 0，**掩盖错误**且跳过未 flush 的持久化数据。

**修复**：catch 中至少 log 错误并退出码 1。

### [P2-14] loadJson 仅校验 JSON.parse 成功，不校验 schema

**文件**：[`src/persistence.js`](file:///workspace/src/persistence.js)

`loadJson` 对损坏文件返回 defaultValue（safe degradation），但对**结构错误但语法合法**的 JSON（如 `{"balance": "abc"}`）仅返回 parsed 对象，依赖调用方 `loadState` 自行校验。若某模块 `loadState` 校验不严，将引入脏数据。

**修复**：`loadJson` 增加可选 schema 参数，调用方可声明期望结构。

### [P2-15] ensureDir mode 0o700 仅在新建时生效

**文件**：[`src/persistence.js`](file:///workspace/src/persistence.js)

`fs.mkdirSync(dir, { recursive: true, mode: 0o700 })` 的 mode 仅在目录**首次创建**时应用。若目录已存在（如之前以 0o755 创建、或 umask 不同），mode 不会被纠正。

**修复**：创建后显式 `fs.chmodSync(dir, 0o700)` 兜底。

### [P2-16] _handleCreditMessage 将原始 note 派发给 App handler

**文件**：[`src/s-node.js`](file:///workspace/src/s-node.js)

credit 消息经 `_handleCreditMessage` 处理后，按 appName 派发到 App 的 `credit.onReceived`。若 App 拿到完整 note（含 issuerDid、amount、签名等），可能比业务所需信息更多。配合 P1-16 沙箱问题，App 可基于 credit 流水构建用户行为画像。

**修复**：派发前对 note 做最小化裁剪，仅传 App 业务所需字段（如 `{ marketId, amount, type }`）。

### [P2-17] config.js 对 webHost 非 127.0.0.1 仅 warn 不阻断

**文件**：[`src/config.js`](file:///workspace/src/config.js)

`webHost !== '127.0.0.1' && webHost !== 'localhost'` 时仅 `console.warn`，仍允许启动监听 0.0.0.0。生产环境若误配，WebPanel 暴露公网，配合 P2-11 空 Host 漏洞可被远程 DNS rebinding 攻击。

**修复**：默认拒绝非回环地址启动，需显式 `--allow-remote-web` 标志才放行。

### [P2-18] parseSimpleYaml 不防 `__proto__` / `constructor` 键

**文件**：[`sdk/manifest.js`](file:///workspace/sdk/manifest.js) L679-690, L747-801

```js
const key = trimmed.slice(0, colonIdx).trim()
result[key] = parseYamlScalar(valuePart)
```

若 YAML 中出现 `__proto__: {name: evil}`，`result.__proto__ = ...` 会改 `result` 的原型链，使后续 `raw.name` 等访问落到被污染的原型上。SDK 作为库仍应防御。

**修复**：`parseSimpleYaml` 中拒绝 `key === '__proto__' || key === 'constructor' || key === 'prototype'`，或用 `Object.create(null)` 创建 result。

### [P2-19] web.handle() 的 subPath 拼接不校验 `..`

**文件**：[`sdk/web.js`](file:///workspace/sdk/web.js) L138-196

```js
const fullApiPath = `/api/apps/${appName}/${subPath.replace(/^\//, '')}`
```

`subPath` 由 AppManager 传入，若 AppManager 不慎传入 `subPath = '../other-app/api/secret'`，则 `fullApiPath = '/api/apps/my-app/../other-app/api/secret'`。SDK 层应主动拒绝含 `..` 的 subPath。

**修复**：`handle()` 入口对 subPath 做 `..` / `//` 检查。

### [P2-20] cli validateCommandName 注释与代码不符

**文件**：[`sdk/cli.js`](file:///workspace/sdk/cli.js) L46-65

注释说"允许特例: appName === 'empty-app' 时可注册不带前缀的 'hello'... 实际仍要求前缀 'empty-app-hello'"，但代码里没有特例分支。注释是历史残留，会误导读者。

**修复**：删除注释里的"特例"段落。

### [P2-21] AppManifest freeze 不深，但当前 schema 下足够

**文件**：[`sdk/manifest.js`](file:///workspace/sdk/manifest.js) L499-503

冻结了顶层与两个数组。但若未来 manifest 增加嵌套对象字段（如 `metadata: {…}`），浅 freeze 会失效。

**修复**：改 `Object.freeze(this)` + 深递归 freeze 辅助函数。

---

## 测试覆盖缺口（按优先级）

### P0 关键安全用例缺失（27 项）

**签名覆盖完整性**（3）：
- `identity-signing-e2e` 单独覆盖篡改 timestamp / senderId / version 后验签失败
- `vouch.test.js` publishVouch 篡改 senderId 后跨节点接收方验签失败

**路径穿越全覆盖**（4）：
- Web mountPath 含 `../` 应拒绝
- Web `opts.dir` 含 `../` 应拒绝
- `--apps-dir` 含 `../` 应拒绝或警告
- `--dataDir` 含 `../` 应拒绝

**私钥泄露全链路**（4）：
- CLI 命令输出不含 privateKey（identity / vouch / wiki / credit-issue）
- state.json 持久化内容不含 privateKey / seed
- s-node log 输出不含 privateKey
- arbitration evidence cid 解析后不含 privateKey

**资源耗尽压力测试**（5）：
- VouchRegistry 单 endorseDid 累积 10^6 vouch 性能
- AppManager 加载 1000 个 App 后 listApps 性能
- _processedCreditNonces 集合无限增长
- App CLI register 无上限
- WebPanel 路由表无限增长

**WebPanel 安全**（3）：
- HTTP 响应头缺失安全头（X-Frame-Options / CSP / X-Content-Type-Options）
- 跨域请求 Origin 头未校验
- HTTP Method 大小写一致性

**e2e 跨节点**（3）：
- 4 节点 mesh 拓扑（A-B-C-D 全互连）
- tunnel 跨节点（A 通过 B/C/D relay 投递到 E）
- arbitration 跨节点（A fileDispute → B/C/D juror vote → resolve）

**App 隔离**（3）：
- 两 App 同名 CLI 命令互不干扰
- 两 App state 隔离
- 两 App credit ledger 隔离

**持久化跨重启**（3）：
- wiki-index / credit-nonces / treasury history 跨重启恢复（persistence-restart.test.js 漏测）

### P1 重要错误路径缺失（23 项，略）

详见原始子审计报告。主要分布在 AppManager 加载失败 / WebPanel 错误响应 / CreditLedger frozen 边界 / ArbitrationRegistry 重复 vote 与 quorum 不足 / VouchRegistry 跨 context / Tunnel MTU / RelayRegistry 重复 did 等。

### P2 边界用例缺失（38 项，略）

超长字符串 / Unicode / Emoji / 控制字符 / 数字边界（MAX_SAFE_INTEGER / 小数 / 超大）/ 0 字节 / 嵌套深度 / URL 编码穿越 / seed 边界 / version 极端 pre-release 等。

---

## 优先修复建议

### 立即修复（M9.6 第一步）

1. **P0-1** state.js `opts.dataDir` 路径穿越（任意文件写入）
2. **P1-1** AppManager entryPoint 路径穿越（任意代码执行）
3. **P1-5** web.mount `opts.dir` 路径穿越（任意文件读）
4. **P1-7** app.stop() 跨 App 影响订阅与 handler（DoS）
5. **P1-8** issueInvite 静默跳过 min_reputation（安全门槛失效）
6. **P1-10** 仲裁裁决 fail-closed 改造（防伪造裁决）

### 近期修复（M9.6 第二步）

7. **P1-2/3** context 权限空转（5 项权限为死代码）
8. **P1-6** credit `_onReceived` 泄露给 App
9. **P1-9** market senderId 内层签名
10. **P1-11/12/13/14/15** 主账本 Map LRU 兜底（5 处无限增长点）
11. **P1-16** App 沙箱收敛（剥离 snode 直接引用）
12. **P1-17** manifest 路径校验跨平台加固

### 逐步优化（M9.7 或 M10 前）

13. **P1-18/19** mock 与真实行为对齐（issueCredit / joinMarket / consumeCredit / Identity.verify）
14. **P2-1/2/4** SDK 资源上限（state / handler / route）
15. **P2-3** cli.execute 异常隔离
16. **P2-11** WebPanel 安全头 + 头部白名单
17. **P2-12/13/14/15** 持久化健壮性
18. **P2-18** parseSimpleYaml 原型键防御
19. 补充 27 个 P0 安全测试用例

---

## 审计总结

| 级别 | 数量 | 分布 |
|------|------|------|
| **P0** | **1** | state.js opts.dataDir 路径穿越 |
| **P1** | **19** | 路径穿越 / 权限空转 / 资源无限增长 / mock 失真 / 跨 App 影响 / 仲裁 fail-closed |
| **P2** | **21** | SDK 资源上限 / 异常隔离 / mock 简化 / WebPanel 安全头 / 持久化健壮性 |
| **测试缺口** | **88** | P0: 27 / P1: 23 / P2: 38 |

**关键观察**：

1. **M8 审计已修复的 6 个 P0 + 6 个 P1 + 3 个 P2 全部有效落地**——本次未发现回归。
2. **最大风险点是 P0-1**：SDK 层 state.js 接入持久化时引入的路径穿越漏洞，可被任意 App 利用做任意文件写入。这是 M9.3 引入的回归。
3. **SDK 层的权限模型设计合理但实施不完整**：`identity:context` 系列权限完全空转（P1-2/3），导致权限白名单承诺与实际行为脱节。
4. **协议层的资源回收 P1-lru 修复不彻底**：nonce 集合已修，但主账本 balances / jurorPool / treasury history / relay candidates 仍无上限（P1-11 至 P1-15）。
5. **App 沙箱是 M9 的设计取舍**（M12 改 worker_thread），但 SDK 应至少通过 API 收敛剥离 snode 直接引用（P1-16），避免恶意 App 直接读钱包私钥。
6. **mock 与真实 SNode 的 5 处行为差异**（P1-18/19, P2-8/9/10）让依赖 mock 的单测无法捕获真实环境的安全回归——这是 TDD 流程的盲点，建议核心安全路径必须有等价的集成测试覆盖（`test/four-nodes-e2e.test.js` 已部分覆盖）。

**建议下一步**：实施 **M9.6 安全加固**（按"立即修复"6 项 + 补 27 个 P0 安全测试），完成后再决定是否进入 M10。

---

**审计人**：3 个并行 subagent + 主代理汇总 · **审计基线**：M9.5 commit `20aa9f2` · **报告生成**：2026-07-19
