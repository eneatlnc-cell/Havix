# Havix 全栈深度审计报告（M10 完成后·内测前）

**审计时间**：2026-07-19
**审计范围**：MVP 协议层 + SDK 层 + Embas 翻译市场 App（全栈一次过）
**基线**：
- MVP 协议层：commit `main` HEAD（`src/` 18 文件 10530 行）
- SDK 层：commit `main` HEAD（`sdk/` 16 文件 3276 行）
- Embas：commit `ffd5b87` M10.6 完结（`Embas/` 11 文件 3523 行）
- 测试基线：MVP 980/980 + Embas 194/194 = **1174/1174 全过**

**关联审计**：M9 审计见 [AUDIT-M9.md](./AUDIT-M9.md)（6 P0 + 6 P1 + 3 P2 已修复）。本报告只列**新发现**，不重复已审计项。

---

## 审计方法

并行 3 个 subagent 分别审计协议层 / SDK 层 / Embas，逐文件静态分析。本报告汇总三方发现，按 P0（致命·blocker）/ P1（高危·建议内测前修复）/ P2（中低危·可纳入 M11）分级。

**审计维度**：输入校验 / 权限边界 / 资源管理 / 错误处理 / 并发原子性 / 持久化 / 加密签名 / 拒绝服务 / 业务状态机 / 适配器隔离 / Web UI XSS / CLI 命令注入。

---

## P0 — 致命（5 项·阻断内测）

### [P0-1] vote-cast 不校验 senderId 是否在 panel 中
- **文件**：[`src/s-node.js`](file:///workspace/src/s-node.js) L1582-1698
- **问题**：vote-cast action 不校验 senderId 是否在 panel 成员中，与 P1-10 verdict 校验不对称。任意节点可伪造投票污染本地仲裁视图，导致裁决被恶意倾斜
- **修复**：在 vote-cast 分支前置 `if (!dispute.panel.includes(senderId)) return`，与 verdict 路径对称
- **影响内测**：blocker

### [P0-2] CreditLedger.transfer 非原子
- **文件**：[`src/protocol/credit.js`](file:///workspace/src/protocol/credit.js) L494-505
- **问题**：`transfer` debit 后 credit 前 crash 会导致金额凭空消失（非原子）。白皮书双重支付防护依赖本地账本一致性，单节点崩溃即可破坏
- **修复**：用 try/finally 包裹，debit 失败回滚 credit；或在 transfer 内部先校验后双写
- **影响内测**：blocker

### [P0-3] translate-publish 任意文件读取 → IPFS 公开泄露
- **文件**：[`Embas/src/cli.js`](file:///workspace/Embas/src/cli.js) L113-117（translate-publish）、L280-284（translate-deliver）
- **问题**：`fs.readFile(contentFile, 'utf8')` 后立即 `app._ipfs.addText(content)`，无路径白名单/沙箱校验。攻击者执行 `translate-publish --content-file /etc/passwd` 即可把宿主机敏感文件写入 IPFS 并通过 market 广播 contentCid 公开
- **修复**：限制 contentFile 在 `app.dataDir` 子目录内（`path.resolve` + `startsWith` 校验），拒绝绝对路径与 `..` 路径
- **影响内测**：blocker

### [P0-4] publisherDid 身份伪造 → credit 盗窃
- **文件**：[`Embas/src/cli.js`](file:///workspace/Embas/src/cli.js) L109、[`Embas/src/timeouts.js`](file:///workspace/Embas/src/timeouts.js) L226-243
- **问题**：translate-publish 接受外部 `--publisher-did`，无签名校验确认本节点持有该 DID。攻击者执行 `translate-publish --publisher-did <victimDid> --reward 1000`，freeze 在 victimDid 名下记账（escrow 仅本节点 state，victim 不可见）。攻击者用自己 DID 接单 + 交付垃圾译文，48h 后 `handlePublisherTimeout` 自动 `credit.transfer(victimDid, attackerDid, 1000)`，victim 真实 credit 被扣
- **修复**：移除 `--publisher-did` 参数，强制 `publisherDid = getLocalBDid()`；或在 freeze 前要求 publisherDid 的签名证明
- **影响内测**：blocker

### [P0-5] 仲裁列表 HTML 注入（存储型 XSS）
- **文件**：[`Embas/src/web.js`](file:///workspace/Embas/src/web.js) L130-134、[`Embas/src/arbitration-adapter.js`](file:///workspace/Embas/src/arbitration-adapter.js) L91-100
- **问题**：仲裁列表 HTML 路由中 `c.disputeId` / `c.type` / `c.status` 直接插入 HTML，**未调 esc()**。`c.type` 来自 `dispute-file --type <用户输入>`，`arbitration-adapter.fileCase` 只校验 respondentDid/stake，**未校验 type 在 VALID_TYPES 内**。攻击者执行 `dispute-file --id 1 --type '<img src=x onerror=alert(1)>'`，操作者访问 `/apps/translation-market/arbitrations` 即触发 XSS
- **修复**：web.js L130-134 全部字段加 `esc()`；arbitration-adapter.fileCase 增加 `if (!Object.values(DisputeType).includes(type)) throw`
- **影响内测**：blocker

---

## P1 — 高危（15 项·建议内测前修复）

### MVP 协议层（5 项）

| 编号 | 文件:行 | 问题 | 修复建议 |
|---|---|---|---|
| P1-1 | `src/config.js` L70, L122 | `--data-dir` / `--apps-dir` 无路径穿越校验，`--data-dir ../../etc` 可让 ledger 写到任意目录；`--apps-dir` 配合 `await import()` 可加载任意路径 JS | loadConfig 末尾对 dataDir/appsDir 做 `path.resolve` + 拒绝含 `..` 的相对路径 |
| P1-2 | `src/protocol/arbitration.js` L631-662 | `castVote` 不校验 dispute.status，PENDING 状态也可投票，破坏状态机 | castVote 入口校验 `dispute.status === PANEL_FORMED \|\| VOTING` |
| P1-3 | `src/s-node.js` L1416-1512 | note.signerPublicKey 与 issuerDid 无密码学绑定，攻击者可生成新 keypair 签 issue note | 在 verifyCreditNoteSignature 后额外校验 `note.signerPublicKey === ledger.knownIssuerPubKey(issuerDid)` |
| P1-4 | `src/protocol/credit.js` L145-154 | `ReputationLedger.get` 懒创建 did 时调用 `_persist()` 同步写盘，高频读路径触发磁盘 IO 阻塞事件循环 | 懒创建只更新内存，persist 由调用方显式触发或 debounce |
| P1-5 | `src/network/tunnel.js` L151-171 | `sendChunk` 不校验 chunk 大小上限，恶意对端可塞 1GB chunk 触发 OOM | 加 `MAX_CHUNK_SIZE = 64 * 1024` 守卫 |

### Embas 翻译市场（10 项）

| 编号 | 文件:行 | 问题 | 修复建议 |
|---|---|---|---|
| P1-6 | `Embas/src/cli.js` L189 | translate-accept 接受外部 `--translator-did`，攻击者可冒充任意 DID 接单（griefing） | 强制 `translatorDid = getLocalBDid()`，移除 `--translator-did` 参数 |
| P1-7 | `Embas/src/credit-adapter.js` L62-71, L89-93 | credit freeze/release race condition（read-then-write），并发 freeze 都读到 frozen=0 通过校验 | state 层提供 atomic add/getAndAdd，或适配器层加进程内 mutex（按 holderDid 串行） |
| P1-8 | `Embas/src/credit-adapter.js` L109-127 | credit.transfer 双重扣款：escrow 不足时 fallback 从 fromDid 真实余额再扣一次（freeze 预扣 + transfer 真扣） | transfer 内先读 frozen，若 `frozen < amount` 抛错而非 fallback；或先 release 再 transfer 并校验 released == amount |
| P1-9 | `Embas/src/credit-adapter.js` L91 | credit.release 在 `amount > frozen` 时静默返回 `released=0` 但不抛错，timeouts/cli 推进状态后 escrow 凭空消失 | release 在 `amount > frozen` 时抛错或返回 `ok:false`；调用方校验 `released === amount` 才推进状态 |
| P1-10 | `Embas/src/market-adapter.js` L71-76 | market.broadcast 的 `{ app, type, ...payload, timestamp }` 中 payload 可覆盖 app/type 预设值，伪造其他 App 消息 | 改为 `{ ...payload, app: APP_TAG, type, timestamp: Date.now() }`（预设值在后） |
| P1-11 | `Embas/src/market-adapter.js` L155-161 | market.onMessage callback 无 try/catch，一个订阅者抛错会冒泡影响其他订阅者 | `try { callback(msg, fromPeerId) } catch (e) { log('warn', ...) }` |
| P1-12 | `Embas/src/cli.js` L201-210 | minReputation 校验 conditional：若 snode 未装配 reputationLedger，整个信誉校验被跳过，manifest.minReputation=30 形同虚设 | manifest.minReputation>0 时强制要求 reputationLedger 可用，否则拒绝接单 |
| P1-13 | `Embas/src/cli.js` L633 | dispute-file 接受外部 `--respondent-did`，可对未参与交易的节点发起仲裁 | 强制 `respondentDid = order.translatorDid`，移除 `--respondent-did` 参数 |
| P1-14 | `Embas/src/web.js` L174-222 | JSON API 直接返回完整 `order` 对象，含 `publisherDid`/`translatorDid` 完整 DID、`contentCid`/`translationCid`，未脱敏 | JSON API 对 DID 做 shortDid 截断，CID 仅返回前缀；或对 /api/* 加 snode 鉴权 |
| P1-15 | `Embas/src/timeouts.js` L106-130 | 仲裁员自动 abstain 不先查询本节点是否已投票，可能覆盖人工 guilty 投票 | 自动 abstain 前先 `arb.getMyVote?.(disputeId)` 校验未投过；或本地 cache 已投 disputeId 集合 |

---

## P2 — 中低危（32 项·可纳入 M11）

### MVP 协议层（13 项·简表）

| 编号 | 文件:行 | 问题简述 |
|---|---|---|
| P2-1 | `src/protocol/message-types.js` L66-86 | validateMessageShape 不校验 payload 大小，可塞 1GB |
| P2-2 | `src/persistence.js` L50-63 | loadJson 不校验文件大小，大文件 OOM |
| P2-3 | `src/app/web-panel.js` L146-354 | URL path 与 appName 无长度上限 |
| P2-4 | `src/app/cli.js` L154-175 | parseArgs 不校验 named value 长度 |
| P2-5 | `src/protocol/market.js` L938-970 | handleMarketMessage 线性 O(N) 扫 markets |
| P2-6 | `src/protocol/wiki.js` L426-443 | getLineage MAX_DEPTH=1000 CPU 占用 |
| P2-7 | `src/protocol/arbitration.js` L354-527 | loadState 不校验 slashRatio/amount 类型；fileDispute disputeId 可由调用方传入 |
| P2-8 | `src/network/relay.js` L125-196 | registerCandidate 不校验有限性；electEpoch O(N log N) sort |
| P2-9 | `src/network/tunnel.js` L90-123 | Tunnel 构造不校验 relayDids 元素非空字符串 |
| P2-10 | `src/s-node.js` L1337-1352 | establishTunnel 不校验 targetDid === sourceDid（自指隧道） |
| P2-11 | `src/protocol/market.js` L475-658 + `src/protocol/message-types.js` L97-134 | deriveTopicFromToken 与 canonicalMessage 依赖 JSON.stringify 顺序；signMessage 不校验 type ∈ VALID_TYPES |
| P2-12 | `src/protocol/vouch.js` L127-141 + `src/protocol/wiki.js` L193-203 + `src/network/dht.js` L52-56 | loadState 不校验元素类型；registerPrivateCid 不校验 cid 类型 |
| P2-13 | `src/persistence.js` L81-97 | saveJsonAtomic JSON.stringify 无大小限制 |

### SDK 层（7 项·简表）

| 编号 | 文件:行 | 问题简述 |
|---|---|---|
| P2-14 | `sdk/credit.js` L145-156 | `_onReceived` 注释说"单 handler 失败不阻断其他 handler"，实际 `throw err` 中断循环（逻辑 Bug） |
| P2-15 | `sdk/market.js` L196-222 | `list()` / `isMember()` / `getManifest()` 只读方法无 `checkPermission`，App 可枚举其他市场 |
| P2-16 | `sdk/transport.js` L130-139 + `sdk/market.js` L230-239 | P1-7 修复引入的 `_dispose()` 未调用 `pubsub.unsubscribe(topic)`，资源泄漏 + 回调残留（stop 后行为不可预测） |
| P2-17 | `sdk/__mocks__/snode-mock.js` L300-446 | vouch / registerRelayCandidate / registerJurorCandidate / fileDispute / summonArbitrationPanel / castArbitrationVote / resolveVerdict 7 个方法缺失真实校验（测试"假过"） |
| P2-18 | `sdk/state.js` L194-204 | `load()` 不校验 key 合法性，与 `set()` 严格校验不一致（空字符串 key / 超长 key 可绕过） |
| P2-19 | `sdk/ipfs.js` L51-61 | `add()` 无 bytes 大小上限，1GB Uint8Array 触发 OOM |
| P2-20 | `sdk/cli.js` L52-65 + `sdk/manifest.js` L62 | 无保留字列表，App 名可为 `help` / `quit` / `version` 等保留字 |

### Embas 翻译市场（12 项·简表）

| 编号 | 文件:行 | 问题简述 |
|---|---|---|
| P2-21 | `Embas/src/orders.js` L104 | `update` patch 无字段白名单，可覆盖 id/publisherDid/reward 等关键字段 |
| P2-22 | `Embas/src/orders.js` L61 | orderId 自增整数可预测，可枚举 /orders/:id 探测他人订单 |
| P2-23 | `Embas/src/orders.js` L157-170 | fromJSON 不校验订单结构（status/offer/publisherDid），可装载任意 id（含 shell 元字符） |
| P2-24 | `Embas/src/views.js` L587-683 | CLI 命令字符串拼接 order.id，esc() 只转义 HTML 不转义 shell，配合 P2-23 即命令注入 |
| P2-25 | `Embas/src/ipfs-adapter.js` L37-43 | addText 无大小限制，超大文本耗尽内存 |
| P2-26 | `Embas/src/ipfs-adapter.js` L50-56 | getText 不校验 CID 格式，可传任意 cid 读取其他 App 数据 |
| P2-27 | `Embas/src/timeouts.js` L65-138 | checkOnce 非完全原子，外部并发触发可能重复处理同一订单（credit.release 被调两次） |
| P2-28 | `Embas/src/timeouts.js` L58 | now 函数注入可被恶意 App 滥用（让所有订单立即超时） |
| P2-29 | `Embas/src/anticheat.js` L127-176 | diagnoseTrustWeight 缺 isFinite 校验 + factors 泄露内部参数让攻击者精确调整刷分策略 |
| P2-30 | `Embas/manifest.yaml` | minReputation/trustWeight/permissions 与代码实际使用存在偏差 |
| P2-31 | `Embas/src/credit-adapter.js` L28 | state key 无 namespace 隔离（`frozen:<did>` 可能与其他 App 冲突） |
| P2-32 | `Embas/src/web.js` | JSON API 对 `:id` 路径参数依赖 SDK 升级（M11 deferred） |

---

## 内测阻断清单

**必须修复才能内测的 5 个 P0**：

1. **[P0-1]** `src/s-node.js` vote-cast 加 senderId ∈ panel 校验
2. **[P0-2]** `src/protocol/credit.js` CreditLedger.transfer 加 try/finally 原子性
3. **[P0-3]** `Embas/src/cli.js` contentFile 路径沙箱化（限定 app.dataDir 子树）
4. **[P0-4]** `Embas/src/cli.js` 移除 `--publisher-did` 参数，强制 `publisherDid = getLocalBDid()`
5. **[P0-5]** `Embas/src/web.js` 仲裁列表补 `esc()` + `arbitration-adapter.fileCase` 校验 type

**建议内测前修复的 15 个 P1**（按优先级）：

- MVP 协议层：P1-1（config 路径穿越）/ P1-2（castVote 状态校验）/ P1-3（note 签名绑定）/ P1-4（懒创建写盘）/ P1-5（chunk 上限）
- Embas：P1-6（移除 `--translator-did`）/ P1-7（race condition）/ P1-8（transfer 双重扣款）/ P1-9（release 静默截断）/ P1-10（payload 覆盖）/ P1-11（callback try/catch）/ P1-12（minReputation 强制）/ P1-13（移除 `--respondent-did`）/ P1-14（JSON API 脱敏）/ P1-15（自动 abstain 覆盖）

**32 个 P2 可纳入 M11 迭代**，其中 SDK P2-16（`_dispose` 资源泄漏）建议优先处理，否则 `app.stop()` 后行为不可预测。

---

## 审计方法学说明

- **静态分析**：逐文件人工审读 + 模式匹配（race / null deref / 无校验 / 注入 / 资源泄漏）
- **基线对照**：与 AUDIT-M9.md（M9 基线）对照，排除已记录项
- **未做动态 fuzz**：本次未做模糊测试 / 负载测试，建议 M11 引入 libfuzzer / chaos engineering
- **测试覆盖审视**：1174/1174 测试通过，但 SDK P2-17 发现 mock 失真 7 处，部分安全路径测试"假过"

---

## 建议下一步

1. **立即修复 5 个 P0**（阻断内测）
2. **修复 15 个 P1**（建议内测前）
3. **编写两份 USAGE.md**（SDK + Embas）时在"安全注意事项"章节引用本审计报告
4. **M11 规划**：纳入 32 个 P2 + mock 失真修复 + 动态 fuzz 测试

---

**Last Updated**：2026-07-19 · 全栈深度审计完成 · 5 P0 + 15 P1 + 32 P2 = 52 项发现 · 基线 1174/1174 测试通过 · 等待 P0 修复后进入内测
