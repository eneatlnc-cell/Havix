# Havix

**Haven of Affinity —— 高认知个体自组织生境协议**

Havix 是一个去中心化对等网络协议，用于验证社会学论文《底层高认知者的结构性困境》中提出的"分层自组织网络"假设。详细设计见 [技术白皮书](./Havix-Technical-Whitepaper.md) 与 [愿景展示](./Havix-Vision.html)。部署运行说明见 [DEPLOY.md](./DEPLOY.md)，MVP 后开发路线见 [ROADMAP.md](./ROADMAP.md)，M9 App SDK 详细设计见 [M9-DESIGN.md](./M9-DESIGN.md)。

> 当前阶段：**M8.3 4 节点集成测试已完成** ✅ · M8 阶段全部完成 · MVP 全量审计通过

---

## 已交付能力

### 审计修复（M8 集成前深度审计）

M7 完成后、M8 集成前对全部协议层（identity / message-types / credit / arbitration / market / vouch / wiki / s-node）做深度安全审计，发现 6 个 P0（关键安全）+ 6 项 P1（健壮性）+ 3 项 P2（可维护性）问题，**全部修复**。基础已为第二阶段（M8+）打好——签名/验签/原子性/资源回收/启动正确性都做到位，不留技术债。

**P0 关键安全修复**：
- **P0-1 签名覆盖整个 canonical message**：原签名只覆盖 `payload` 字段，攻击者可篡改 `senderId` / `type` / `timestamp` 而不破坏签名（vouch 改 credit、伪造身份）。修复：`canonicalMessage()` 移除 `signature / signerPublicKey` 后整体参与签名，`signMessage()` 工厂统一入口，`verifyMessageSignature()` 与所有 3 个跨 context 验签测试同步更新
- **P0-2 credit note 内层签名验证**：原 `_handleCreditMessage` 只信任外层消息签名，不验证内层 note——攻击者可伪造 `note.type` 或 `note.amount`。修复：新增 `verifyCreditNoteSignature()` + 强制 `senderId === note.issuerDid` 绑定，双层校验防伪造 issuer
- **P0-3 topic 前缀分流**：市场消息走 `/s-network/market/<hex64>` 私有 topic，已 AES-GCM 加密认证，无需公共层签名校验。修复：`_pubsubHandler` 按 `topic.startsWith(MARKET_TOPIC_PREFIX)` 分流到 `_handleMarketTopicMessage`，避免误拒加密信封
- **P0-4 InviteToken.verifySelf() 零依赖自验签**：原 `joinMarket` 只校验 token 字段结构，不验证 issuer 签名——任何节点都能伪造 token 加入市场。修复：InviteToken 内嵌 `signerPublicKey`，新增 `verifySelf()` 用 `@noble/curves` Ed25519 自验签；`joinMarket` 改为 async 并强制调用
- **P0-5 gossipsub handler 顶层 try/catch**：handler 异常会让节点进程崩溃（DoS）。修复：整个 message dispatch 包一层 try/catch，任何 handler 异常只记录不抛
- **P0-6 slash 0 守卫**：`_executeSlash` 在 `frozenBefore=0` 时 `actualSlash=0`，但 `reputationLedger.slash(0)` 与 `treasury.deposit(0)` 仍会执行，触发边界异常。修复：`actualSlash > 0` 守卫，frozen=0 时跳过 slash 与赔偿，仅记录 warn

**P1 健壮性 / 一致性修复**：
- **P1-faucet Faucet.consume 原子性**：`debit(holder)` 成功但 `release(issuer)` 失败时，holder 余额已扣但 issuer 冻结未释放，账本不一致。修复：`release` 失败时 `credit(holder, amount)` 回滚 holder 余额
- **P1-arb-mirror arbitration senderId 镜像校验**：跨节点镜像 verdict 时未校验 senderId 是否在 panel 中——任意节点可伪造裁决。修复：`filed` action 强制 `senderId === claimant`，`verdict` action 强制 `senderId ∈ panel`（panel 未知时宽松接受，已知时严格校验）
- **P1-market-gate issueInvite 强制 min_reputation**：白皮书 §8.2 要求邀请前校验 invitee 可用信誉，原代码漏掉。修复：`issueInvite` 调用 `reputationLedger.getAvailable(inviteeDid)` 与 `manifest.minReputation` 比较，不足抛 `InsufficientReputationError`
- **P1-bounds timestamp/amount Number.isFinite 检查**：vouch / wiki / credit / arbitration 的 `payload.timestamp` 与 `amount` 缺 `NaN / Infinity` 守卫，恶意输入会污染账本。修复：全部加 `Number.isFinite` 检查
- **P1-lru Set/Map 加上限**：`market._seenNonces` / `vouch.vouches` / `wiki.entries` / `arbitration.disputes` / `s-node._processedCreditNonces` 长跑节点会无限膨胀。修复：全部加 100,000 上限，超限时 FIFO 退化 LRU 移除最早项
- **P1-threshold VouchRegistry.thresholdScore 推导**：原默认值硬编码 `threshold × 1.0`，与 `ReputationLedger.initialReputation` 解耦后两者不一致会破坏向后兼容。修复：改用 `this.reputationLedger?.initialReputation ?? DEFAULT_INITIAL_REPUTATION` 动态推导

**P2 可维护性 / 启动正确性修复**：
- **P2-1 start() 失败回滚**：原 `start()` 无回滚——`ipfs.start()` 成功后任何步骤抛错会让 libp2p 半启动残留（端口仍占、监听器未注册）。修复：拆分为 `start()` 外壳 + `_startInternal()` 实现，外壳 try/catch 在失败时调用 `stop()` 清理已启动资源
- **P2-2 监听器注册顺序**：原顺序是先 `subscribe(topic)` 再 `addEventListener('message', handler)`，造成消息丢失窗口（订阅后到 handler 注册前到达的消息被丢弃）。修复：先注册所有监听器（peer:discovery / connection / pubsub message），再 `subscribe(topic)`
- **P2-3 JSDoc/注释修正**：`s-node.js` 头注释新增"审计修复"小节；各 P0/P1/P2 修复点处加内联注释；`message-types.js` 头注释更新签名规则说明

✅ P0-1 签名覆盖整个 canonical message（防 senderId/type 篡改）
✅ P0-2 credit note 内层签名验证 + senderId === issuerDid 绑定
✅ P0-3 topic 前缀分流（市场消息走私域路径，公共层签名校验不误拒）
✅ P0-4 InviteToken.verifySelf() 零依赖自验签 + joinMarket 强制调用
✅ P0-5 gossipsub handler 顶层 try/catch（DoS 防护）
✅ P0-6 slash 0 守卫（frozen=0 跳过，防 zero-amount 路径崩溃）
✅ P1 Faucet.consume 原子性（release 失败回滚 holder 余额）
✅ P1 arbitration filed/verdict senderId 镜像校验（防伪造裁决）
✅ P1 issueInvite 强制 min_reputation 检查（白皮书 §8.2）
✅ P1 timestamp/amount Number.isFinite 边界检查（4 个协议模块）
✅ P1 Set/Map 加 100,000 LRU 上限（5 处无限增长点）
✅ P1 VouchRegistry.thresholdScore 用 ledger.initialReputation 动态推导
✅ P2 start() 失败回滚（start → _startInternal 拆分 + stop() 清理）
✅ P2 监听器注册顺序优化（先 addEventListener 再 subscribe）
✅ P2 JSDoc/注释修正（s-node.js / message-types.js 头注释 + 内联注释）

### M8.1 信誉/账本持久化

M8 拆分为 3 子阶段（M8.1 持久化 → M8.2 CLI 收口 → M8.3 4 节点集成测试）。**M8.1** 解决"M4-M7 的内存型账本重启即丢失"问题：所有 6 个 registry（Reputation / Credit / Vouch / Wiki / Arbitration / Treasury / Market）+ 1 个 nonce 集合都加入持久化能力，节点重启后状态完整恢复。

**通用持久化工具 `src/persistence.js`** — 提供 4 类原子操作：
- `ensureDir(dir)` 递归创建目录；`loadJson(path, default, opts)` 文件不存在/损坏返回默认值（不抛错）；`saveJsonAtomic(path, data, opts)` 原子写（`.tmp` + `renameSync`）
- `mapToArray` / `arrayToMap`（带可选 `valueDecoder`）、`setToArray` / `arrayToSet`、`bytesToBase64` / `base64ToBytes` 用于序列化 Map/Set/Uint8Array
- 设计原则：**mutation 已成功的业务状态不可因磁盘问题回滚**——失败只 log warn，不抛错；写盘用同步 fs 操作（账本 mutation 频率低，性能足够，与 P2-1 start 回滚兼容）

**各 registry 持久化接口（统一模式）**：
- 构造时传 `persistPath`（不传则纯内存模式，向后兼容现有单元测试）
- `toJSON()` 序列化 Map → `[[k, v], ...]`、Set → `string[]`、Uint8Array → base64
- `loadState(json)` 合并式恢复（不覆盖现有数据，保证安全重入）
- `flush()` 显式写盘（幂等）；`_persist()` 内部 mutation 后自动调用
- 已在 5+3 处 mutation（credit/vouch/dispute/market/nonce）中加入 `_persist()` 自动落盘

**SNode 集成（M8.1-7）**：
- 构造时初始化 `persistDir = dataDir/ledgers/` + 8 个 ledger 文件路径
- `_startInternal()` 中 `ensureDir(persistDir)` → 构造各 registry 时传 `persistPath` → 立即 `loadState(loadJson(path, null, {log}))` 恢复磁盘状态（首次启动文件不存在时返回 null，loadState 静默无操作）
- `stop()` 中调用 `_flushAllRegistries()`：8 个 ledger（reputation / credit / vouch / wiki / treasury / arbitration / market / creditNonces）的 flush 都包裹 try/catch，失败只 log warn（不让磁盘问题导致 stop 也失败）
- `_processedCreditNonces` 集合独立持久化到 `credit-nonces.json`（3 处 `.add()` 后调用 `_persistCreditNonces()`）

**Deferred 到未来工作（M8.1 范围外）**：
- 加密存储（M8.1 明文 JSON，未来 M9+ 加 AES-GCM 加密保护本地账本隐私）
- 多版本快照 / WAL（M8.1 只保留最新，崩溃前最后一次 mutation 可能丢失但不会损坏文件——原子写保证）
- 跨节点账本一致性（仍靠 gossipsub 消息最终收敛，M8.1 不变；持久化只是单节点重启恢复）

✅ 通用持久化工具 `src/persistence.js`（8 个导出函数 + 同步原子写）
✅ ReputationLedger / CreditLedger 持久化（credit/freeze/release/slash/debit/transfer 全 mutation 落盘）
✅ VouchRegistry 持久化（endorseDid → Set<voucherDid> 集合恢复）
✅ WikiProtocol 索引持久化（cid → EntryManifest，CID 内容仍在 IPFS）
✅ ArbitrationRegistry + TreasuryLedger 持久化（dispute 状态机 + 仲裁团 panel + votes + jurorPool + 金库余额与历史）
✅ MarketRegistry 持久化（markets Map + 加密密钥 Uint8Array → base64 恢复 + seenNonces 集合）
✅ SNode 集成：构造传 persistPath + start() 加载 + stop() flush + credit nonce 集合独立持久化
✅ 持久化工具单元测试（28 个：ensureDir/loadJson/saveJsonAtomic/Map/Set/base64 全覆盖 + 端到端往返）
✅ 重启恢复集成测试（11 个：每个 registry 单独往返 + 多 registry 混合端到端 + 首次启动空等价 + 纯内存模式 no-op）

### M8.2 CLI 收口 + 本地 Web 面板

M8.2 把 M3-M7 的所有公开 API 命令化，节点启动后进入交互式 REPL（类似 redis-cli / psql），并提供一个仅绑定 127.0.0.1 的本地 Web 面板做拓扑可视化。运维人员可在本地直接操作节点（CLI）与观察网络状态（Web），与 M8.1 持久化互补——持久化解决"重启不丢"，CLI/Web 解决"操作可达"。

**M8.2-1 CLI 框架（[src/app/cli.js](src/app/cli.js)）** — REPL 引擎基于 Node.js `readline`：`tokenize()` 命令解析（支持双引号包裹 + 反斜杠转义 + 连续空格）；`parseArgs()` 参数分类（positional / `--key=value` / `--flag`）；`register()` / `registerAll()` 命令注册表；`execute()` 直接执行（测试用，不进 REPL）；`util.styleText` 彩色输出（Node 20.12+，CI 自动降级为纯文本）；错误隔离：handler 抛错被捕获打印，REPL 不退出；7 个内置诊断命令（`help` / `exit` / `quit` / `status` / `identity` / `neighbors` / `topics`）。

**M8.2-2 M3-M4 业务命令（11 个）** — vouch / vouch-list / wiki-publish / wiki-list / wiki-get / wiki-history / credit-issue / credit-consume / credit-transfer / credit-balance / reputation；每命令覆盖成功路径 + 参数校验失败 + 错误打印；命令委托 SNode 公开 API，不直接访问 registry 私有字段。

**M8.2-3 M5-M7 业务命令（25 个）** — `relay-register` / `relay-elect` / `relay-rotate` / `relay-list`（4）；`tunnel-open` / `tunnel-send` / `tunnel-break` / `tunnel-close` / `tunnel-list`（5）；`dispute-file` / `dispute-panel` / `dispute-vote` / `dispute-resolve` / `dispute-list` / `juror-register` / `juror-eligibility`（7）；`treasury-balance` / `treasury-history`（2）；`market-create` / `market-invite` / `market-join` / `market-publish` / `market-leave` / `market-list` / `market-info`（7）。每命令严格校验参数（type ∈ `offer-breach|relay-malice|vouch-collusion`、amount 正整数、vote ∈ `guilty|not-guilty|abstain`、JSON 解析失败打印错误）。

**M8.2-4 本地 Web 面板（[src/app/web-panel.js](src/app/web-panel.js)）** — HTTP server 仅绑定 `127.0.0.1:7331`（默认；可 `--web-port` 覆盖；`--no-web` 关闭）；`GET-only`（POST/PUT/DELETE 返回 405，无任何 mutation 接口）；`Cache-Control: no-store` 防缓存；13 个 JSON API 端点：`/healthz` + `/api/status` + `/api/identity` + `/api/neighbors` + `/api/topics` + `/api/topology` + 8 个 `/api/registry/{vouch,wiki,credit,dispute,market,treasury,tunnel,relay}`；HTML 页面内嵌 vis-network 9.1.9 CDN（jsdelivr），暗色 GitHub 主题，8 种节点分组（self / context-DID / peer / relay-active / relay-candidate / market / vouched / tunnel-src-dst）+ 5 类边（context / p2p / vouch / tunnel / market creator）+ 5 秒自动刷新 + 右侧实时状态面板 + 左下角图例。

**M8.2-5 s-node.js 集成** — `config.js` 新增 4 个选项：`--repl / --no-repl`（默认 true）、`--web / --no-web`（默认 true）、`--web-port <number>`（默认 7331；0=随机）、`--web-host <host>`（默认 127.0.0.1）；支持环境变量 `HAVIX_REPL` / `HAVIX_WEB` / `HAVIX_WEB_PORT` / `HAVIX_WEB_HOST`，命令行覆盖环境变量；`s-node.js` 把原 `main()` 提取为导出函数 `startApp(config, deps)`，通过 `deps={SNode, Cli, WebPanel, process, stdout}` 注入 fake 实现进行单元测试，无需真实 libp2p / helia。

**启动与退出顺序（重要）**：
- 启动：SNode.start() → WebPanel.start() → Cli.start()（REPL 最后；同步返回但 readline 保持 event loop）
- 退出：Cli.stop() → WebPanel.stop() → SNode.stop()（与启动相反；先关 readline 否则 stdin 卡住 node.stop）

**失败隔离**：WebPanel.start() 失败不阻断节点（`webPanel = null`），Cli.start() 失败同理；只有 SNode.start() 失败才致命（运行模式 exit(1)，测试模式抛错让测试断言）。`stop()` 幂等 + 各组件抛错也走完所有组件（错误被捕获打印，不让单个组件失败阻断其他组件清理）。

**安全约束（M8.2 Web 面板）**：
- 仅绑定 127.0.0.1——不暴露公网（避免被远程探测 / 攻击）
- GET-only——不提供任何 mutation 接口（所有写操作走 CLI）
- 不显示私钥——只显示 DID（与 CLI 脱敏原则一致）；HTML 与 JSON 测试都验证 `privateKey` / `secret` 不出现
- 无认证——MVP 阶段依赖"仅本地访问"，未来扩展可加 token

**Deferred 到未来工作（M8.2 范围外）**：
- Web 面板认证（M8.2 仅本地访问，未来 token-based 远程访问 deferred）
- 拓扑图节点拖拽持久化（vis-network 物理布局每节点本地视图，跨节点共享 deferred）
- CLI 命令历史持久化（M8.2 用 readline 默认 in-memory 历史，跨会话持久化 deferred）
- CLI 命令补全（M8.2 用 readline 默认 Tab 补全，按已注册命令名补全 deferred 到 M9+）
- Web 面板 WebSocket 实时推送（M8.2 用 5 秒轮询，实时性要求高的场景 deferred）

✅ CLI 框架（[src/app/cli.js](src/app/cli.js)）：REPL 引擎 + tokenize/parseArgs + 命令注册表 + 彩色输出 + 错误隔离
✅ 7 个内置诊断命令（help / exit / status / identity / neighbors / topics）
✅ 11 个 M3-M4 业务命令（vouch / wiki / credit）
✅ 25 个 M5-M7 业务命令（relay / tunnel / dispute / treasury / market）
✅ 本地 Web 面板（[src/app/web-panel.js](src/app/web-panel.js)）：HTTP server + 13 个 JSON API + vis-network 拓扑可视化
✅ config.js 4 个新选项（--repl / --web / --web-port / --web-host，命令行 + 环境变量）
✅ s-node.js 提取 startApp(config, deps) 可测试函数 + 集成 Cli + WebPanel + 优雅退出
✅ CLI 单元测试（143 个：36 框架 + 30 M3-M4 + 77 M5-M7，含 help 系统覆盖）
✅ Web 面板单元测试（42 个：启停 + 路由 404/405 + HTML/API + 拓扑数据 + 并发 + 安全）
✅ startApp 集成测试（33 个：启动顺序 + 退出顺序 + 配置开关 + 错误处理 + SIGINT/SIGTERM + config.js）

### M8.3 4 节点集成测试

M8.3 在真实 4 节点网络中验证 M1-M8 全部能力端到端可用。这是 M8 阶段的收尾——M8.1 持久化解决"重启不丢"、M8.2 CLI/Web 解决"操作可达"、M8.3 解决"跨节点协同正确"。三阶段合起来构成"可运行的 P2P 网络协议"完整闭环。

**测试拓扑**：star（中心节点 A:9801，叶子节点 B:9802 / C:9803 / D:9804 通过 bootstrap 连 A）。禁用 mDNS（强制走 bootstrap，确定性）、禁用 web/repl（避免端口/readline 冲突）。端口段 9801-9804（避开 bootstrap-e2e 的 9701-9703 与 dht-gate-e2e 的 9401-9402）。`HAVIX_SKIP_E2E=1` 跳过（与既有 e2e 测试一致，CI 慢机可跳过）。

**M8.3-1 star 拓扑连接验证** — 4 个真实 in-process SNode 实例，各自独立端口 + 独立 dataDir。`t.after()` 保证清理（即使中途断言失败也停掉所有节点 + 删 dataDir）。验证：B/C/D 各自 bootstrap 连到 A（neighbors.size === 1）、A 看到 3 个邻居、4 节点都订阅了 3 个公共层 topic（announce / reputation / alert）。

**M8.3-2 gossipsub 公共层消息跨节点传播** — 在 M8.3-1 harness 上扩展，验证 3 类公共层消息的跨节点传播与镜像：
- **vouch 跨节点传播**：A vouch 外部 context-D DID → B/C/D `vouchRegistry.getVouchCount` 同步 +1，且 `voucherDid` 是 A 的 context-A 子 DID
- **wiki-announce 跨节点传播**：B/C 各自 vouch A 的 context-D DID → A 累积 2 vouch 达阈值 N=2 → A `publishEntry` → B/C/D `wiki.entries` 索引到 manifest（验证 cid/title/authorDid 字段一致性）
- **credit 跨节点镜像**：A `issueCredit` → B/C/D 镜像 `creditLedger.credit` + `reputationLedger.freeze`（验证 holder 余额 +amount + issuer available 信誉 -amount）

**M8.3-3 持久化 + 重启恢复端到端** — 验证 M8.1 持久化在真实节点 stop→start 后的状态恢复：
- **round 1**：A 启动 → issueCredit 给 external-holder（本地落盘 + nonce 落盘）
- **round 1 stop**：A.stop() flush 8 个 ledger 文件到磁盘（reputation / credit / vouches / wiki-index / arbitration / treasury / markets / credit-nonces），验证文件存在 + 内容包含 holderDid=10 + nonce 落盘
- **round 2 restart**：A 同 dataDir 重新 start()（libp2p 重新生成随机密钥对 → 新 peerId / 新 4-context DID，但 loadState 从磁盘恢复旧数据）→ external-holder 余额保持 10 + nonce 集合恢复 1 条
- **replay protection**：重放同 nonce note → `_handleCreditMessage` 拒绝（applied=false, reason 含"幂等"），余额未双花
- **fresh issue**：重启后新 context-A DID + 新 nonce → issueCredit 正常应用（新 holder 余额 5，旧 holder 余额仍 10，nonce 集合 2 条）

**关键发现（已写进测试注释）**：
- **M4 信誉无 gossipsub 同步**：`reputationLedger.credit()` 只动本地账本，无跨节点消息。跨节点 `issueCredit` 要让接收方 `freeze(amount)` 不抛 `InsufficientReputationError`，必须每个节点本地都先达到稳态信誉。测试用 `for (const node of nodes) node.reputationLedger.credit(aContextA, 50)` 模拟"A 已通过其他途径积累足够信誉"的稳态场景。
- **libp2p 重启生成新 DID**：每次 start() 生成新随机密钥对 → peerId + 4-context DID 全部变化。持久化的 DID-keyed 状态变成"orphan"（无主）数据，但旧 DID 的 ledger 数据仍可被查询（`getBalance(anyDid)` 仍能取到）。真正可重启恢复的场景是持久化的"外部 DID"数据（如 external-holder credit）跨重启保持。
- **nonce 重放保护是跨重启的核心安全性质**：M8.1 + M8.3 联合验证——重启后 nonce 集合从磁盘恢复，重放同 nonce 消息被拒绝，防双花。

**安全约束（M8.3）**：
- 测试拓扑仅 127.0.0.1（本地回环），不暴露公网
- 每个节点独立 dataDir（`.data-m83-{name}-{port}/`），测试后 `t.after()` 清理
- 端口段 9801-9804 不与既有 e2e 测试冲突
- `HAVIX_SKIP_E2E=1` 跳过（与 bootstrap-e2e / dht-gate-e2e 一致，CI 慢机可跳过）

**Deferred 到未来工作（M8.3 范围外）**：
- 跨节点信誉同步协议（M4 用本地账本视图，跨节点账本一致性靠 gossipsub 消息收敛；M8.3 暴露的"A 涨信誉但 B 不知道"是 M4 设计取舍，未来 M9+ 可加 reputation 消息同步）
- 节点身份持久化（M8.3 验证重启 DID 变化导致 orphan 数据；未来可加 libp2p privateKey 持久化到磁盘，重启恢复同 peerId）
- 4 节点以上更大规模测试（M8.3 用 4 节点 star 拓扑够覆盖 M3-M7 跨节点场景；更大规模 mesh/全连接拓扑 deferred 到未来性能测试阶段）
- 跨节点 market 私域消息传播（M8.3 未覆盖 M7 私有 topic + AES-GCM 加密端到端，deferred 到 M9+）
- 跨节点 tunnel relay 选举（M8.3 未覆盖 M5 relay 跨节点选举协议，deferred 到 M9+）

✅ 4 节点 star 拓扑 harness（[test/four-nodes-e2e.test.js](test/four-nodes-e2e.test.js)）：4 个真实 in-process SNode + bootstrap 引导 + 127.0.0.1 端口段隔离
✅ M8.3-1 拓扑连接验证（6 个子测试：A 启动 + B/C/D bootstrap + B/C/D 各自 1 邻居 + A 看到 3 邻居 + 4 节点订阅 3 topic）
✅ M8.3-2 gossipsub 跨节点传播（5 个子测试：setup + vouch + wiki-announce + credit 镜像，每类验证字段一致性）
✅ M8.3-3 持久化 + 重启恢复（6 个子测试：round1 issue + stop flush + round2 restart loadState + replay protection + fresh issue）

### M1 双平面传输基线

构建 Havix 节点的传输层骨架：libp2p 3.x + helia 7.x，TCP + noise E2E 加密 + yamux/mplex 多路复用。提供局域网 mDNS 自动发现与手动 multiaddr 跨网段引导两种邻居发现方式。KadDHT 默认 LAN 模式（`/ipfs/lan/kad/1.0.0`），与公网 IPFS Amino DHT 隔离；DHT 门控在协议层硬性拦截私域 CID 的 provide/findProviders 调用，抛 `PrivateCidRejectedError`，不依赖加密兜底。公共层订阅三个 gossipsub 频道（`/s-network/announce`、`/reputation`、`/alert`），心跳定时器每 30s 广播邻居列表，SIGINT/SIGTERM 优雅退出。

✅ 节点初始化（IPFS/Helia + libp2p，noise E2E 加密）  
✅ 局域网自动发现（mDNS，1 分钟内双向连接）  
✅ 跨网段引导（手动 multiaddr 引导）  
✅ KadDHT（默认 LAN 模式，与公网 IPFS DHT 隔离）  
✅ DHT 门控（私域 CID 调用 provide/findProviders 抛 `PrivateCidRejectedError`）  
✅ 公共层频道订阅（`/s-network/announce`、`/reputation`、`/alert`）  
✅ 心跳定时器（30s 广播邻居列表）  
✅ 优雅退出（SIGINT/SIGTERM）

### M2 DID 派生与公共层消息签名

在主 PeerId 基础上，用 HKDF-SHA256 从主 Ed25519 种子派生 A/B/C/D 四组密码学独立的子身份（公开层 / 市场 / 私聊隧道 / 维基），子身份间不可关联、不可逆推主身份。公共层消息改用 context-A 子身份签名：心跳带 `signature` + `signerPublicKey` 字段，接收方零依赖验签（无需 DHT 查询），但无法从 context-A 反推主 PeerId。gossipsub 接收方对每条消息做 Ed25519 验签，未签名或验签失败均降级处理；payload 任何修改都会破坏签名（篡改检测）。

✅ 4-context DID 派生（HKDF-SHA256 + Ed25519，4 组独立子身份密码学互不可关联）  
✅ 公共层消息改用 context-A 子身份签名（心跳带 `signature` + `signerPublicKey`）  
✅ gossipsub 消息签名验证（接收方零依赖 Ed25519 验签）  
✅ 篡改检测（payload 任何修改都会导致验签失败）

### M3 维基协议

构建 Havix 的"公开智库文档"：任何人都能读取维基内容，写入需编辑员身份签名。维基协议分三层递进完成：

**M3.1 协议骨架** — 公共层消息类型常量与结构校验（`message-types.js`：`MESSAGE_TYPES`、`validateMessageShape`、`makeMessage`）；`WikiProtocol.publishEntry` 将内容写入 IPFS（raw codec + sha256 CID），用 context-D 子身份签名 `{cid, title, timestamp}` 后通过 gossipsub `/s-network/announce` 广播；接收方验签通过后索引到本地 manifest；gossipsub message 按 `type` 字段路由到对应 handler（heartbeat → 日志、wiki-announce → WikiProtocol、vouch → VouchRegistry）。

**M3.2 编辑员资格门控** — `VouchRegistry` 维护 `endorseDid → Set<voucherDid>`，默认阈值 N=2；vouch 消息走 `/s-network/reputation` topic，用 context-A 子身份签名（背书人用公开层活跃性身份，被背书人才是 context-D 编辑员身份，跨 context 防伪造）；自 vouch 拒绝（防自吹自擂）+ 同 vouch 幂等（按 voucherDid 去重）；`publishEntry` 前置门控，未达阈值抛 `EditorNotQualifiedError`（带 `current/threshold/need` 字段）；`SNode.vouch(endorseDid)` 公开 API。

**M3.3 版本控制链** — `publishEntry` 接受 `parentCid` 参数构造版本链；续写时父版本作者必须与当前编辑员一致（防劫持他人条目，不一致抛 `ParentCidMismatchError`）；lazy 验证策略（父 CID 不在本地索引时不阻塞发布，仅记录）；签名覆盖 `parentCid`，篡改会破坏签名；查询接口 `listHistory(title)` / `getLineage(cid)` / `isRootEntry(cid)` / `getLatestVersion(title, authorDid)`；防环保护（上限 1000 深度 + CID 去重）；向后兼容旧消息（无 parentCid 字段视为根条目）。

**Deferred 到未来工作**：维基分叉/合并（多 parentCid）、跨作者协作编辑、Merkle DAG 完整验证（当前为 lazy 验证）。

✅ 公共层消息类型常量与结构校验
✅ 维基 CID 广播（写 IPFS + context-D 签名 + gossipsub 广播）
✅ 接收方验签后索引本地 manifest + 内容按 CID 读取
✅ gossipsub 消息按 type 分发到对应 handler
✅ vouch 累积阈值门控（N=2，自 vouch 拒绝 + 幂等）
✅ `publishEntry` 前置门控，未达阈值抛 `EditorNotQualifiedError`
✅ `SNode.vouch(endorseDid)` 公开 API
✅ 版本链（`parentCid` 签名 + 作者一致性校验 + lazy 验证）
✅ 版本查询接口（`listHistory` / `getLineage` / `isRootEntry` / `getLatestVersion`）
✅ 防环保护 + 向后兼容旧消息

### M4 Credit 双轨经济

构建 Havix 的"信誉锚定经济"（白皮书 §4）：高信誉节点签发 Credit 时等额冻结自身 Reputation，Credit 被消费后冻结部分释放。Reputation 不可消耗（累积型准入凭证），Credit 可消耗（凭证型流通媒介），Faucet 是两者间的单向转换闸门。这一机制同时实现反通胀、作恶成本、自然流通与价值锚定。

**Track 1 Reputation（不可消耗，累积型）** — `ReputationLedger` 维护 `did → {available, frozen, total}` 三池模型（白皮书 §4.2 关键性质 4：total 不变，签发 Credit 不影响 issuer 总信誉排名，只影响"还能再签发多少"）；`available` 用于 vouch 加权与签发资格判断，`frozen` 是签发 Credit 时的等额冻结；`slash`（M6 调用，M4 暴露接口）只动 frozen 池，不动 available（白皮书 §5.3）；不持久化，节点重启从 0 重新累积。

**Track 2 Credit（可消耗，凭证型）** — `CreditLedger` 维护 `holderDid → balance`；`credit/debit/transfer/getBalance` 四个原语；debit 不足抛 `InsufficientCreditError`；不持久化，跨节点双重支付防护 deferred 到 M6 仲裁。

**Faucet 单向转换** — `Faucet.issue({holderDid, amount, prevNoteCid})` 校验 issuer 总信誉 ≥ `minReputation`（默认 10，"高信誉节点"门槛）后冻结等额可用信誉 + 增加 holder 余额 + 生成 `CreditNote` 签名 JSON（含 nonce 防重放 + prevNoteCid 形成流水链）；`Faucet.consume({holderDid, issuerDid, amount})` debit holder 余额 + release issuer 冻结信誉；issuer 用 context-A 子身份签发（与心跳/vouch 同 context，便于聚合信誉事件）。

**VouchRegistry 加权升级** — `VouchRegistry` 构造时注入 `reputationLedger` 后自动从 M3.2 的简单 N-vouch 计数升级为按 voucher 可用信誉加权（`getWeightedScore = Σ voucherReputation`，1 个 rep=10 的节点 vouch = 10 个 rep=1 的节点 vouch）；`thresholdScore` 默认 = `threshold × DEFAULT_INITIAL_REPUTATION`，确保所有 vouch 来自默认 1.0 信誉节点时与 M3.2 行为完全等价（向后兼容）；新增 `getQualification(endorseDid)` 统一返回 `{score, threshold, qualified}`，WikiProtocol 门控已切换到此接口。

**Credit 流水同步** — credit 消息走 `/s-network/reputation` topic（与 vouch 同 topic，便于聚合信誉事件）；接收方 `_handleCreditMessage` 按 nonce 幂等镜像 issue/consume 到本地账本（防重放）；`SNode.issueCredit/consumeCredit/transferCredit` 公开 API；M4 不实现跨节点账本同步——每个节点维护自己的信誉视图，跨节点账本一致性靠 gossipsub 消息最终收敛，真正双重支付防护 deferred 到 M6 仲裁团对 IPFS 流水链做最终裁决。

**Deferred 到未来工作**：Reputation 时间衰减（白皮书未明确，未来工作）、vouch 自动给 endorseDid 累积 reputation（M5+）、信用汇率（高信誉节点 credit 更值钱，仅设计说明）、App Manifest 加权（白皮书 §3.3）、Credit 跨市场流通（M7 邀请市场）、完整双重支付防护（M6 仲裁时验证 IPFS 流水链）、跨节点账本同步（M6 仲裁时收敛）。

✅ ReputationLedger 三池模型（available/frozen/total，签发 Credit 不影响 issuer 总信誉排名）
✅ CreditLedger 余额表（credit/debit/transfer/getBalance，不足抛 `InsufficientCreditError`）
✅ Faucet 签发与消费（冻结/释放等额信誉，门槛 minReputation=10）
✅ CreditNote 签名 JSON（issuer context-A 签名 + nonce 防重放 + prevNoteCid 流水链）
✅ VouchRegistry 加权升级（注入 reputationLedger 后高信誉背书更有分量，向后兼容 M3.2）
✅ `getQualification` 统一资格查询接口（score/threshold/qualified 三元组）
✅ credit 消息走 `/s-network/reputation` topic（与 vouch 同 topic，聚合信誉事件）
✅ 接收方 `_handleCreditMessage` 按 nonce 幂等镜像 issue/consume
✅ `SNode.issueCredit/consumeCredit/transferCredit` 公开 API
✅ Slash 接口暴露（M6 仲裁时调用，只动 frozen 池不动 available）

### M5 单跳 Relay 隧道

构建 Havix 的"简化洋葱"（白皮书 §7）：不追求绝对匿名（那需要真洋葱路由），用单跳 relay + 信誉问责替代。Tor 的 relay 是匿名志愿者不可问责，Havix 的 relay 是有 vouch 累积的实体，作恶会损失长期信誉——"用信誉换延迟"是 Tor 没有的自由度。

**Relay 准入与轮换（白皮书 §7.3）** — `RelayRegistry` 维护候选 → active 集合的两级索引；准入门槛双重：信誉前 30%（`topPercentile=0.30`，按 available 信誉降序取前 N）+ 至少 3 个高信誉节点 vouch（`minVouchCount=3`，vouch 计数取自注入的 `VouchRegistry`）；epoch 轮换（默认 1 小时）：每个 active relay 有 20% 概率被换下（`rotateProbability=0.20`），中签后从候选池按信誉降序补位，补位候选也必须通过 vouch 门槛；M5 用 `Math.random`，分布式 VRF deferred 到 M6+。

**多链路对冲（白皮书 §7.2）** — `TunnelManager` 管理多条 A↔B 隧道，每条 `Tunnel` 内部维护 N 条并行 relay 链路（默认 3 条）；流量按 round-robin 分片到各 relay，3 条 relay 各传 1/3 流量，单 relay 被攻破只能看到 1/3 流量片段；分片不可重组（每个 chunk 独立路由，单 relay 视角是无序片段）。

**硬切换（白皮书 §7.3）** — MVP 采用硬切换语义：relay 下线立即从 active 集合移除（`breakLink`），不试图重连该 relay；剩余 relay 继续服务（状态 `degraded`）；所有 relay 断开后隧道整体 `broken`，`sendChunk` 抛 `TunnelBrokenError`，应用层感知重连；电路迁移应用层重连机制 deferred 到 M8 CLI 收口。

**链路状态机** — `active`（3 条全在线）/ `degraded`（1-2 条断开，剩余继续）/ `broken`（全断开，拒绝写入）；`getStats()` 返回各链路发送统计（sentChunks / status / brokenAt），便于上层决策。

**context-C 私聊身份** — `SNode.establishTunnel` 用 context-C 子身份作为 sourceDid（私聊身份），与维基 D / 公开 A / 市场 B 隔离；A、B 互相不知道对方真实 IP，relay 只看到 context-C DID。

**Deferred 到未来工作**：真实 libp2p stream 跨进程传输（M5 用字节级接口，跨进程集成留 M8）、跨节点 relay 选举协议（M5 用本地视图，跨节点同步 deferred 到 M6+）、relay 协商协议（A 如何发现哪些 relay 愿意服务 B？M5 用 RelayRegistry 视图）、电路迁移应用层重连（M5 硬切换即隧道断开，应用层感知由 M8 CLI 收口）、流量混淆/padding（M5 不加，可能被流量分析，deferred 到 M6+）、relay 服务质量监控（延迟、丢包、篡改，deferred 到 M6 仲裁时实现）、vouch 加权模式判定（M5 用 count，M4 加权阈值判定留 M6+）、自动 epoch 推进定时器（M5 由外部触发，deferred 到 M8 CLI）。

✅ RelayRegistry 候选注册 + 准入门槛双重（信誉前 30% + vouch≥3）
✅ Epoch 选举（top-percentile + vouch 阈值过滤，信誉降序排序，minRelays 兜底）
✅ 概率轮换（20% 概率被换下，从候选池补位，补位需通过 vouch 门槛）
✅ 历史记录（elected / retired / rotated 三类事件，按 did 过滤查询）
✅ TunnelManager 多隧道管理（establishTunnel / sendChunk / breakLink / closeTunnel）
✅ 多链路对冲（3 条并行 relay round-robin 分片，各传 1/3 流量）
✅ 硬切换（relay 下线从 active 移除，剩余继续；全断开抛 TunnelBrokenError）
✅ 链路状态机（active / degraded / broken）
✅ context-C 私聊身份（sourceDid 与 A/B/D 隔离）
✅ `SNode.registerRelayCandidate/electRelayEpoch/rotateRelayEpoch` 公开 API
✅ `SNode.establishTunnel/sendTunnelChunk/breakTunnelLink/closeTunnel` 公开 API

### M6 临时仲裁团 + Slash

构建 Havix 的"去中心治理"（白皮书 §5）：不搞民主投票（多数暴政），不搞中心执法（S 国模型），而是高信誉者的临时召集制——商会、行会、自治公社的真实治理形态。当 Offer 违约、Relay 作恶或 Vouch 舞弊发生时，临时召集 5 节点仲裁团，多数裁决后对作恶方 slash frozen 信誉，50% 赔受害者、50% 进金库。

**触发条件（白皮书 §5.1，三种 dispute 类型）** — `ArbitrationRegistry.fileDispute` 接受 `type: 'offer-breach' | 'relay-malice' | 'vouch-collusion'`；分别对应"付了 credit 但没拿到服务"、"relay 节点泄露电路或篡改流量"、"相互刷 vouch 抬高信誉"三种治理场景；claimant 与 respondent 不能相同，amount 必须 > 0；生成 `disputeId` 后置为 `pending` 状态。

**仲裁团召集（白皮书 §5.1）** — `summonPanel(disputeId, rng)` 算法：① 计算候选池信誉中位数；② 筛出符合门槛的候选（`reputation > median × multiplier`，默认 `multiplier=1.5`；同时 `vouch ≥ minVouchForJuror`，默认 10）；③ 排除纠纷双方的 vouch 关联节点（防串谋：候选曾 vouch 过 claimant/respondent，或 claimant/respondent 曾 vouch 过候选，都不能入团）；④ 排除 claimant/respondent 自身（自举拒绝）；⑤ Fisher-Yates 洗牌后取 `panelSize` 个（默认 5）。状态机 `pending → panel-formed → voting → resolved`，未达多数前可继续投票。

**投票与裁决（白皮书 §5.2）** — `castVote({disputeId, jurorDid, vote})` 接受 `guilty | not-guilty | abstain`；非 panel 成员抛 `JurorNotAuthorizedError`；同一仲裁员重复投票覆盖最新（幂等）；`resolveVerdict(disputeId)` 统计票数，`guilty` 或 `not-guilty` 票数 ≥ `verdictMajority`（默认 3）即裁决成立；`abstain` 不计入多数判定；未达多数返回 `{resolved: false, reason}` 不抛错；已裁决 dispute 再投票或再裁决抛 `DisputeAlreadyResolvedError`（最终性）。

**Slash 机制（白皮书 §5.3，治理与经济的咬合点）** — 关键设计：**只动 frozen 池，不动 available**。如果 slash 能动可用信誉 → 攻击者可以靠仲裁把别人信誉打光 → 治理武器化；只动 frozen → slash 只影响"正在发行的 credit" → 治理成为"经济纠纷解决"而非"政治清洗"。Slash 分配：`actualSlash = min(dispute.amount, frozenBefore)`（frozen 不足只扣到 0，不抛错）；`victimCompensation = actualSlash × slashRatio`（默认 0.5）→ `reputationLedger.credit(claimant, ...)` 赔给受害者；`treasuryDeposit = actualSlash × (1 - slashRatio)` → `treasury.deposit(...)` 进金库。

**TreasuryLedger 金库账本（白皮书 §5.3，M6 只进不出）** — `deposit({from, amount, reason, disputeId})` 累加余额并记入历史；`getBalance()` 总余额；`getHistory(disputeId?)` 可按 dispute 过滤的审计记录；M6 用内存账本（不写 IPFS，deferred）；金库支出用途治理 deferred 到未来由社区决定。

**仲裁消息广播** — `publishArbitration({pubsub, senderIdentity, dispute, action})` 用 context-A 子身份签名后广播到 `/s-network/alert` topic（与 announce/reputation 分开）；payload 包含 `disputeId/claimant/respondent/type/amount/action/status/verdict`；接收方 `_handleArbitrationMessage` 按 action 镜像本地 dispute 状态（filed/panel-summoned/vote-cast/verdict）；**verdict 镜像不执行 slash**——只有原始发起仲裁的节点执行 slash（避免重复扣账），其他节点仅记录最终性。

**SNode M6 集成** — `start()` 初始化 `TreasuryLedger` + `ArbitrationRegistry`（注入 `reputationLedger` + `vouchRegistry`）；8 个公开 API：`registerJurorCandidate/checkJurorEligibility/fileDispute/summonArbitrationPanel/castArbitrationVote/resolveVerdict/getTreasuryBalance/getTreasuryHistory`；`fileDispute` 用本地 context-A 子身份作为 claimant 并广播；`castArbitrationVote` 用本地 context-A 子身份作为 jurorDid（本节点是仲裁员时调用）。

**Deferred 到未来工作**：24 小时超时重抽（M6 由外部触发，定时器 deferred 到 M8）、候补仲裁员自动补位（M6 用固定 5 节点，候补机制 deferred）、真实分布式随机数 VRF（M6 用 `Math.random`，与 M5 epoch 轮换一致）、金库支出用途治理（M6 只进不出，未来由社区治理决定）、金库 ledger 写入 IPFS 公开审计（M6 用内存账本，IPFS ledger deferred）、IPFS 流水链完整验证（M6 用本地账本视图，跨节点账本一致性靠 gossipsub 消息收敛）、跨节点仲裁团选举协议（M6 用本地视图，跨节点同步 deferred 到未来）。

✅ ArbitrationRegistry 临时仲裁团（fileDispute / summonPanel / castVote / resolveVerdict）
✅ 仲裁团召集门槛（信誉 > 中位数 × 1.5 + vouch ≥ 10）+ 防串谋排除（vouch 关联）+ 自举拒绝
✅ Dispute 状态机（pending → panel-formed → voting → resolved）
✅ 多数裁决（≥3 票一致）+ abstain 不计入多数 + 最终性保护（已裁决拒绝再次投票）
✅ Slash 只动 frozen 池不动 available（白皮书 §5.3：防治理武器化）
✅ Slash 分配 50% 赔受害者 + 50% 进金库（slashRatio 默认 0.5，可配置）
✅ frozen 不足时只扣到 0（不抛错，按实际可扣额）
✅ TreasuryLedger 金库账本（M6 只进不出，按 disputeId 审计过滤）
✅ publishArbitration 广播到 `/s-network/alert` topic（context-A 签名 + 接收方镜像）
✅ `SNode.registerJurorCandidate/checkJurorEligibility/fileDispute/summonArbitrationPanel` 公开 API
✅ `SNode.castArbitrationVote/resolveVerdict` 公开 API
✅ `SNode.getTreasuryBalance/getTreasuryHistory` 公开 API（金库审计）

### M7 邀请市场 + 双重加密

构建 Havix 的"私域不可见"（白皮书 §6.5 + §8）：私域 CID 绝对不进 DHT，只在私有 gossipsub topic 内分发；topic 名本身是 sha256(邀请令牌)，攻击者扫描只能看到哈希；消息体用令牌派生的密钥 AES-GCM 加密，即使暴力加入 topic 也解不开消息。每个私域市场 = 一个 App，通过 App Manifest 声明能力需求，创建者用 context-A 子身份签发市场令牌，被邀请方拿到令牌后才能加入。

**App Manifest（白皮书 §8.2）** — `AppManifest` 类解析 manifest 字段：必需 `name/version/capability`（capability ∈ `market|wiki|custom`）；可选 `permissions`（白名单 VALID_PERMISSIONS 子集）、`invite_token_format`（M7 仅支持 `ed25519-signature`）、`spa_cid`（SPA bundle IPFS CID，M7 占位不拉取）、`min_reputation`（默认 30）、`trust_weight`（0.0~1.0，默认 0.5）；`marketId = name + sha256(manifest)[0:8]` 确定性派生。

**邀请令牌（白皮书 §8.2 invite_token_format: "ed25519-signature"）** — `InviteToken` 类包含 `marketId/issuerDid/inviteeDid/issuedAt/expiresAt/nonce`（payload 用于签名）+ `signature/signerPublicKey`（issuer context-A Ed25519 签名）；`isExpired(now)` 检查过期（`expiresAt=0` 永不过期）；`isFor(did)` 检查绑定；`verify(publicKey)` Ed25519 验签；`issueInviteToken()` 工厂函数用 issuer context-A 子身份签名；nonce 用 `crypto.randomUUID()` 防重放。

**私有 topic 派生（白皮书 §6.5 第一层）** — `deriveTopicFromToken(token)` → `sha256(token.toJSON())` → `/s-network/market/<hex64>`；相同 token → 相同 topic（确定性）；不同 token → 不同 topic（不可枚举）；与公共层 `/s-network/announce|reputation|alert` 完全分开。

**消息体双重加密（白皮书 §6.5 第二层）** — `deriveEncryptionKey(token)` 用 `HKDF-SHA256(令牌 JSON, salt=空, info="market-encryption")` 派生 32 字节 AES-256 密钥；`encryptMessage(key, plaintext)` 用 Node.js `crypto` 的 AES-256-GCM（IV 12 字节随机、认证标签 16 字节）加密，返回 `{iv, ciphertext, tag}` base64；`decryptMessage(key, encrypted)` 解密，密钥错误或数据篡改抛 `DecryptionError`；相同明文每次加密 IV 不同（随机性）。

**MarketRegistry** — `createMarket({manifest, creatorToken})` 创建者用自邀请令牌（issuerDid=inviteeDid=创建者 context-A）创建市场，订阅 topic，记入 members 集合；`joinMarket({token, myDid})` 加入方用市场令牌加入（M7 MVP 所有成员共享同一个市场令牌，授权由 out-of-band 渠道保证，本方法只做密码学校验：签名+过期+nonce）；`leaveMarket/listMarkets/isMember/getToken/getEncryptionKey/getTopic/getManifest` 查询接口。

**M7 共享令牌设计** — 白皮书 §6.5 的 `inviteToken` 是单数形式，意味着所有市场成员共享同一个市场令牌来派生 topic + key。`issueInvite` 签发的是"邀请凭证"（用于 out-of-band 身份验证），但实际加入市场需要拿到市场令牌（创建者通过私有渠道传递）。因此 `joinMarket` 不强制 `inviteeDid === myDid`（令牌可被转发），授权由 out-of-band 渠道保证。

**加密信封广播** — `publishMarketMessage({pubsub, registry, marketId, senderId, payload})` 流程：① AES-GCM 加密 payload JSON；② 构造明文信封 `{version, type:'offer', senderId, timestamp, payload:{marketId, encrypted:{iv,ciphertext,tag}}}`（明文信封不含原 payload，攻击者即使加入 topic 也只能看到加密 blob）；③ `gossipsub.publish(topic, 信封)`。senderId 是 context-B 子身份 DID（市场参与身份，与公开层 context-A 隔离）。

**接收方解密** — `handleMarketMessage({registry, envelope, topic})` 通过 topic 反查 marketId（本地未加入抛 `MarketNotFoundError`），取密钥 AES-GCM 解密，返回 `{marketId, senderId, payload, timestamp}`；密钥错误或数据损坏抛 `DecryptionError`。

**SNode M7 集成** — `start()` 初始化 `MarketRegistry`；10 个公开 API：`createMarket/issueInvite/joinMarket/leaveMarket/listMarkets/isMarketMember/publishToMarket/getMarketManifest/getMarketTopic`；`createMarket` 用 context-A 子身份签发自邀请令牌并订阅私有 topic；`joinMarket` 用 context-B DID 加入；`publishToMarket` 用 context-B DID 作为 senderId 广播加密信封。

**Deferred 到未来工作**：跨节点 transfer 同步（M7 用本地账本视图，跨节点同步靠 gossipsub 消息收敛）、market 内 offer/credit 完整流转（M7 只提供加密通道，业务逻辑由 App 自行实现）、SPA bundle 拉取与缓存（M7 用 IPFS CID 占位 spa_cid，不实现拉取）、App Manifest 动态权重审核（白皮书 §8.4，自然涌现算法推迟到阶段二）、令牌吊销列表（M7 用 expiresAt 过期，吊销列表 deferred）、跨节点市场成员同步（M7 用本地视图，跨节点一致性靠 gossipsub 收敛）、第三方 App 加载（白皮书 §8.5 阶段一不开放，参考实现内置）、独立邀请凭证与市场令牌分离（M7 MVP 简化为共享令牌，未来分离为"邀请凭证 + 市场根令牌"两个概念）。

✅ AppManifest 类（白皮书 §8.2）：字段校验 + marketId 确定性派生 + toJSON 序列化
✅ InviteToken 类：issuer context-A Ed25519 签名 + expiresAt 过期 + nonce 防重放 + isFor 绑定 + verify 验签
✅ issueInviteToken 工厂：用 context-A 子身份签名，ttlMs=0 永不过期
✅ deriveTopicFromToken：sha256(令牌) → `/s-network/market/<hex64>`（白皮书 §6.5 第一层）
✅ deriveEncryptionKey：HKDF-SHA256(令牌, "market-encryption") → 32 字节 AES-256 密钥（白皮书 §6.5 第二层）
✅ encryptMessage/decryptMessage：AES-256-GCM（IV 12 字节随机 + 认证标签 16 字节），密钥错误或篡改抛 DecryptionError
✅ MarketRegistry：createMarket/joinMarket/leaveMarket/listMarkets/isMember/getToken/getEncryptionKey/getTopic/getManifest
✅ 共享令牌设计：所有成员共享同一个市场令牌派生相同 topic + key，joinMarket 不强制 inviteeDid 匹配
✅ publishMarketMessage：构造明文信封 + AES-GCM 加密块 → gossipsub.publish(topic, 信封)
✅ handleMarketMessage：接收方按 topic 反查 marketId → AES-GCM 解密 → 返回 payload
✅ `SNode.createMarket/issueInvite/joinMarket/publishToMarket/leaveMarket` 公开 API
✅ `SNode.listMarkets/isMarketMember/getMarketManifest/getMarketTopic` 公开 API

## 快速开始

### 1. 安装

```bash
# 需要 Node.js 18+（推荐 20 LTS）
node --version
npm install
cp .env.example .env
```

### 2. 单节点启动

```bash
npm start
# 或：node src/s-node.js --port 9001 --name alpha
```

### 3. 双节点局域网测试（mDNS 自动发现）

打开两个终端：

```bash
# 终端 1
node src/s-node.js --port 9001 --name alpha

# 终端 2
node src/s-node.js --port 9002 --name beta
```

预期：1 分钟内两个节点都会打印 `已连接 → <peerId> (共 1 个邻居)`。

### 4. 跨网段引导（手动 multiaddr）

```bash
# 终端 1：启动引导节点
node src/s-node.js --port 9001 --name alpha

# 复制 alpha 的 multiaddr（控制台会打印监听地址）
# 例如：/ip4/127.0.0.1/tcp/9001/p2p/12D3KooW...

# 终端 2：通过 bootstrap 引导
node src/s-node.js --port 9002 --name beta \
  --bootstrap /ip4/127.0.0.1/tcp/9001/p2p/12D3KooW...
```

预期：beta 启动后几秒内打印 `连接引导节点成功：12D3KooW...`。

### 5. 启动后进入 CLI REPL + Web 面板（M8.2）

默认配置下，节点启动后会同时起 REPL 与 Web 面板：

```bash
node src/s-node.js --port 9001 --name alpha
```

启动日志会打印：
```
  [web-panel] 监听 http://127.0.0.1:7331/  (拓扑可视化 + 状态 API)
  [cli] REPL 已启动，输入 help 查看命令（Ctrl+D 退出）
```

浏览器打开 `http://127.0.0.1:7331/` 即可看到 vis-network 拓扑图（self → 4-context DID + 邻居 peer + relay + 市场 + vouch 关系 + 隧道），右侧实时状态面板 5 秒自动刷新。

REPL 支持 43 个命令（7 诊断 + 11 M3-M4 + 25 M5-M7），输入 `help` 查看全部分类，`help <cmd>` 查看单命令详情。例如：

```
havix > help
havix > status
havix > vouch did:havix:A:endorsee1
havix > market-create myapp 1.0.0 market --permissions=read,write --min-reputation=50
havix > dispute-file did:havix:A:respondent1 offer-breach 100 bafyevidence
```

**仅作为后台服务运行（不开 REPL）**：

```bash
node src/s-node.js --no-repl --web-port 8000
```

**完全无应用层（纯节点，不开 REPL 也不开 Web）**：

```bash
node src/s-node.js --no-repl --no-web
```

## 命令行参数

```
选项：
  --port <number>          监听端口（0=随机，默认 0）
  --name <string>          节点显示名称（默认 havix-node）
  --data-dir <path>        数据目录（默认 .data）
  --bootstrap <multiaddr>  跨网段引导节点（可多个或逗号分隔）
  --mdns <true|false>      启用 mDNS 局域网发现（默认 true）
  --dht <true|false>       启用 KadDHT（默认 true）
  --dht-mode <lan|wan>     DHT 模式（默认 lan）
  --log <level>            日志级别 debug|info|warn|error（默认 info）
  --[no-]repl              启动后进入 CLI 交互式 REPL（默认 true）
  --[no-]web               启动后开本地 Web 面板（默认 true）
  --web-port <number>      Web 面板端口（默认 7331；0=随机）
  --web-host <host>        Web 面板监听地址（默认 127.0.0.1，仅本地）
  -h, --help               显示帮助
```

环境变量（被命令行参数覆盖）：`HAVIX_PORT`、`HAVIX_NAME`、`HAVIX_DATA_DIR`、`HAVIX_BOOTSTRAP`、`HAVIX_MDNS`、`HAVIX_DHT`、`HAVIX_DHT_MODE`、`HAVIX_LOG`、`HAVIX_REPL`、`HAVIX_WEB`、`HAVIX_WEB_PORT`、`HAVIX_WEB_HOST`

## 测试

```bash
# 全部测试（单元 + e2e，约 50 秒，共 596 个用例）
npm test

# 跳过 e2e 测试（CI 用）
HAVIX_SKIP_E2E=1 npm test
```

测试覆盖（596 个用例，全部通过）：

**M8.3 4 节点集成测试阶段（17 个，需 HAVIX_SKIP_E2E=0 启用）**
- four-nodes-e2e 集成测试（17 个子测试）：M8.3-1 star 拓扑连接（6 个：A 启动 + B/C/D bootstrap + B/C/D 各自 1 邻居 + A 看到 3 邻居 + 4 节点订阅 3 公共 topic）、M8.3-2 gossipsub 跨节点传播（5 个：setup + vouch 跨节点同步 +1 + wiki-announce 跨节点索引 manifest + credit 跨节点镜像 freeze+credit）、M8.3-3 持久化 + 重启恢复（6 个：round1 issue + stop flush 8 个 ledger 文件 + round2 restart loadState 恢复 + replay protection 拒绝同 nonce + fresh issue 正常应用）

**M8 审计修复阶段（4 个）**
- persistence 文件权限测试（2 个：saveJsonAtomic 0o600 + ensureDir 0o700，M8 审计 P0-A 修复）
- web-panel Host 头校验测试（2 个：恶意 Host 403 拒绝 + localhost/127.0.0.1 允许，M8 审计 P1-F 修复）

**M8.2 CLI 收口 + Web 面板阶段（218 个）**
- cli 单元测试（143 个）：M8.2-1 框架 36 个（tokenize/parseArgs 解析、Cli 类 register/registerAll/execute、REPL 启停、彩色输出、错误隔离、7 个诊断命令）、M8.2-2 M3-M4 命令 30 个（vouch/vouch-list/wiki-publish/wiki-list/wiki-get/wiki-history/credit-issue/credit-consume/credit-transfer/credit-balance/reputation 全覆盖含成功+参数校验+错误）、M8.2-3 M5-M7 命令 77 个（relay×4 + tunnel×5 + dispute×7 + treasury×2 + market×7，每命令成功路径 + 缺参数 + 类型校验 + JSON 解析失败 + help 系统覆盖）
- web-panel 单元测试（44 个）：启停（默认配置 + port=0 + 重复启动抛错 + stop 幂等 + 重新启动）、路由（404 未找到 / 405 POST/PUT/DELETE 仅 GET / healthz）、HTML 页面（DOCTYPE + vis-network CDN + Network/DataSet 调用 + 自动刷新 + /index.html 等价）、API 端点（13 个端点全覆盖 + 缺失字段降级 + 错误返回 ok:false）、拓扑数据完整性（self + 4-context DID + peer + relay active/candidate + vouch + tunnel + market 节点与边）、并发 100 请求不崩、安全性（HTML/JSON 不含 privateKey/secret + Cache-Control + Content-Type + Host 头校验防 DNS rebinding 2 个）
- s-node-startapp 集成测试（33 个）：启动顺序（SNode → WebPanel → Cli 通过 TrackedXxx 类记录调用次序）、退出顺序（Cli → WebPanel → SNode）、配置开关（--no-repl / --no-web / 组合 / --repl=false / --web-port / --web-host）、错误处理（SNode.start 失败抛错、WebPanel.start 失败不阻断、Cli.start 失败不阻断 stop）、stop() 幂等 + 各组件抛错也走完、SIGINT/SIGTERM 信号触发（直接调用 + EventEmitter.emit）、config.js（DEFAULT_CONFIG 字段 + parseArgv 解析 + 环境变量覆盖 + 命令行覆盖环境变量 + --help 包含新选项）

**M8.1 持久化阶段（41 个）**
- persistence 单元测试（30 个）：ensureDir 递归创建、loadJson 文件不存在/损坏返回默认值、saveJsonAtomic 原子写不留 .tmp 残留 + 自动创建父目录 + 失败只 log warn + 文件权限 0o600（M8 审计修复）、ensureDir 目录权限 0o700（M8 审计修复）、mapToArray/arrayToMap 往返、setToArray/arrayToSet 往返、bytesToBase64/base64ToBytes 往返、端到端 save→load 往返一致
- persistence-restart 重启恢复集成测试（11 个）：ReputationLedger credit/freeze/release/slash 重启恢复、CreditLedger credit/debit/transfer 重启恢复、VouchRegistry voucher 集合恢复、TreasuryLedger 余额与历史恢复、ArbitrationRegistry dispute 全生命周期恢复（含 panel/votes/status）、MarketRegistry 市场列表恢复 + 加密密钥字节级一致、多 registry 混合端到端、首次启动空等价、纯内存模式 no-op

**审计修复阶段（3 个）**
- audit-fixes 单元测试（3 个）：P2-1 start() 失败回滚（调用 stop()、stop 异常不掩盖原错误、成功时不调 stop）

**M1 阶段（19 个）**
- DhtGate 单元测试（8 个）：私域 CID 注册/查询、公共 CID 委托、私域 CID 拦截、审计列表
- DHT 门控端到端（6 个）：双节点真实 DHT，A.provide → B.findProviders，私域 CID 两端都被硬拦截
- Bootstrap 跨网段引导端到端（5 个）：B 通过 bootstrap 连到 A，无效 multiaddr 不崩溃

**M2 阶段（19 个）**
- identity 单元测试（14 个）：4-context 派生可重现、互异、不可关联、不可逆推；签名/验签独立；篡改 payload 与 signature 都验签失败
- identity 签名端到端（5 个）：双节点 mDNS 互发现、context-A 子身份签名心跳互相验签、篡改检测

**M3 阶段（58 个）**
- message-types 单元测试（13 个）：消息类型常量、frozen 完整性、validateMessageShape 各字段校验、makeMessage 组装
- wiki 单元测试（9 个）：putContentBlock/getContentBlock 往返一致、publishEntry 生成合法签名消息、handleAnnounce 跨身份验签索引、重复 CID 幂等、payload 缺字段拒绝、context 不可关联性
- vouch 单元测试（20 个）：VouchRegistry 计数/阈值/自 vouch 拒绝/幂等、handleVouch 防伪造来源、publishVouch 跨节点验签、WikiProtocol 门控（未达阈值抛 EditorNotQualifiedError / 达阈值放行）、跨 context 不可关联性
- wiki 版本链单元测试（16 个）：根/子条目、作者一致性校验（抛 ParentCidMismatchError）、lazy 验证、旧消息兼容、listHistory/getLineage 查询、防环保护、签名覆盖 parentCid、跨节点版本链传递、乱序到达

**M4 阶段（48 个）**
- ReputationLedger 单元测试（12 个）：三池模型（available/frozen/total）、credit/freeze/release/slash 原语、初始信誉默认值、total 不变性质、slash 只动 frozen 池
- CreditLedger 单元测试（7 个）：credit/debit/transfer/getBalance、自转账拒绝、debit 不足抛 InsufficientCreditError
- Faucet 单元测试（8 个）：issue 冻结等额信誉 + 生成签名 CreditNote、consume 释放冻结、minReputation 门槛拒绝（抛 FaucetNotAuthorizedError）、可用信誉不足抛 InsufficientReputationError、流水链 prevNoteCid
- computeWeightedScore 单元测试（3 个）：无 ledger 退化为计数（M3.2 兼容）、有 ledger 时 Σ voucher 可用信誉
- VouchRegistry 加权模式单元测试（8 个）：thresholdScore 默认 = threshold × DEFAULT_INITIAL_REPUTATION、自定义 thresholdScore、getQualification 双模式统一接口、高信誉 voucher 更有分量、isQualified 加权切换、向后兼容 M3.2
- publishCreditMessage 单元测试（2 个）：生成合法签名消息广播到 `/s-network/reputation`、未传 senderIdentity 抛错
- IPFS helpers 单元测试（1 个）：putCreditNoteBlock/getCreditNoteBlock 往返一致
- WikiProtocol 加权门控端到端（2 个）：1 个高信誉 voucher 即可放行、默认 rep 节点需 2 个 vouch 才达标
- 端到端 credit 镜像测试（3 个）：_handleCreditMessage 字段校验、A 签发 credit → B 镜像本地账本、consume 类型镜像（debit holder + release issuer frozen）；B 节点需预先充值 issuer 信誉（M4 不实现跨节点信誉同步，deferred 到 M6）

**M5 阶段（61 个）**
- relay 单元测试（24 个）：RelayRegistry 默认常量（与白皮书 §7.3 一致）、候选注册（注入 ledger/vouchRegistry 时以账本为准）、选举（vouch 门槛过滤、信誉降序、minRelays 兜底、未连任标记 retired、epochStart 更新）、概率轮换（rng=1 无中签、rng=0 全中签、补位通过 vouch 门槛、被换下 relay 不再 active）、状态查询（getActiveRelays / getHistory / isEpochExpired / getCandidate）
- tunnel 单元测试（26 个）：Tunnel 构造与参数校验、nextRelay round-robin 分配、sendChunk 3 条 relay 各传 1/3 流量、sequence 递增、chunk 类型校验、breakLink（单 relay 断开 degraded、所有 relay 断开 broken、断开未知 relay 不影响、degraded 时剩余继续）、TunnelBrokenError / NoRelayAvailableError、TunnelManager（establishTunnel / sendChunk / breakLink / closeTunnel / getStats）、端到端（建立 → 发 9 chunk → 断 1 → 继续 → 全断开）、round-robin 游标正确重置
- s-node-tunnel 集成测试（11 个）：SNode M5 API 转发（registerRelayCandidate / electRelayEpoch / rotateRelayEpoch / establishTunnel / sendTunnelChunk / breakTunnelLink / closeTunnel）、无 activeRelays 时抛 NoRelayAvailableError、未启动时调用抛错、端到端完整流程（注册 → 选举 → 建立隧道 → 发 chunk → 硬切换 → 关闭）

**M6 阶段（46 个）**
- arbitration 单元测试（46 个）：默认常量（与白皮书 §5 一致）、DISPUTE_STATUS / VERDICT_VOTE frozen 常量、TreasuryLedger（deposit 累加、金额必须正数、getHistory 按 disputeId 过滤）、ArbitrationRegistry 构造（必需参数校验、默认参数、自定义参数）、候选注册与资格检查（registerJurorCandidate 从 ledger/vouchRegistry 读取、did 无效拒绝、isJurorEligible 未注册/vouch 不足/信誉不足三种拒绝原因）、fileDispute（基本参数、三种 type 合法、参数校验、重复 disputeId 拒绝）、summonPanel（召集合格候选、自举拒绝、vouch 关联排除防串谋、respondent vouch 关联也排除、未知 dispute 抛 DisputeNotFoundError、状态非 PENDING 拒绝、无合格候选返回空 panel）、castVote（基本投票、非 panel 成员抛 JurorNotAuthorizedError、重复投票幂等覆盖、无效 vote 拒绝、未知 dispute 抛 DisputeNotFoundError）、resolveVerdict（未达多数不裁决、guilty 多数裁决 + slash 执行、not-guilty 不执行 slash、abstain 不计入多数、frozen 不足只扣到 0、已裁决 dispute 拒绝再次裁决、未知 dispute 抛错）、getVoteStats 投票统计、publishArbitration（生成合法签名消息广播到 /s-network/alert、缺参数抛错）、Dispute 类 getVotes 数组快照、SNode M6 集成（未启动抛错、treasury 初始余额 0、registerJurorCandidate 转发、完整仲裁流程）、端到端（完整仲裁 + slash + 金库审计）

**M7 阶段（55 个）**
- market 单元测试（55 个）：默认常量（与白皮书 §6.5 + §8 一致）、frozen 常量（MANIFEST_REQUIRED_FIELDS/VALID_CAPABILITIES/VALID_PERMISSIONS）、AppManifest（完整字段解析、默认值、必需字段缺失拒绝、非法 capability 拒绝、非法 permission 拒绝、trust_weight 范围校验、min_reputation 不能为负、非法 invite_token_format 拒绝、marketId 确定性、toJSON 序列化）、InviteToken（构造与 payload、isExpired 边界、expiresAt=0 永不过期、isFor 绑定、toJSON/fromJSON 往返一致）、issueInviteToken（签发并验签成功、ttlMs=0 永不过期、参数校验、篡改 payload 验签失败、错误公钥验签失败）、deriveTopicFromToken（topic 格式 /s-network/market/<hex64>、相同令牌相同 topic、不同令牌不同 topic）、deriveEncryptionKey（32 字节密钥、相同令牌相同密钥）、encryptMessage/decryptMessage（加解密一致、相同明文不同 IV、错误密钥抛 DecryptionError、篡改密文/标签抛 DecryptionError、非法密钥长度抛错、支持 Uint8Array 明文）、MarketRegistry（createMarket 基本流程、重复 marketId 拒绝、非 AppManifest 实例拒绝、creatorToken.marketId 不匹配拒绝、joinMarket 基本流程、过期令牌拒绝、nonce 重放拒绝、缺签名拒绝、leaveMarket 基本流程与未知 marketId 抛错、getEncryptionKey/getTopic/getToken 查询）、publishMarketMessage（构造加密信封并广播、参数校验、未知 marketId 抛 MarketNotFoundError）、handleMarketMessage（解密并验证、未知 topic 抛 MarketNotFoundError、错误 registry 解密失败）、端到端（创建者发消息 → 加入方收消息，共享令牌场景）、SNode M7 集成（未启动抛错、listMarkets 初始空）

## 项目结构

```
havix/
├── package.json                  依赖与脚本
├── .env.example                   环境变量模板
├── Havix-Technical-Whitepaper.md  技术白皮书
├── Havix-Vision.html              愿景展示页
├── src/
│   ├── s-node.js                  主入口（M1+M2+M3+M4+M5+M6+M7+M8.1+M8.2：传输基线 + DID 签名 + 维基协议 + Credit 双轨经济 + 单跳 Relay 隧道 + 临时仲裁团 + 邀请市场双重加密 + 持久化 + startApp 可测试函数 + Cli/WebPanel 集成）
│   ├── config.js                  配置加载（命令行 + 环境变量 + 默认值；M8.2 新增 --repl / --web / --web-port / --web-host 4 个应用层选项）
│   ├── identity.js                4-context DID 派生（HKDF + Ed25519）
│   ├── persistence.js             通用持久化工具（M8.1：ensureDir/loadJson/saveJsonAtomic/Map/Set/base64）
│   ├── protocol/
│   │   ├── message-types.js       公共层消息类型常量与结构校验（M3 已实现）
│   │   ├── wiki.js                维基协议：CID 广播 + 编辑员签名 + vouch 门控 + 版本链（M3 已实现）
│   │   ├── vouch.js               编辑员资格注册表 + publishVouch（M3 已实现，M4 升级为信誉加权双模式）
│   │   ├── market.js              邀请市场协议：AppManifest + InviteToken + 双重加密 + MarketRegistry（M7 已实现）
│   │   ├── credit.js              ReputationLedger + CreditLedger + Faucet + CreditNote（M4 已实现）
│   │   └── arbitration.js         临时仲裁团 + TreasuryLedger + slash（M6 已实现）
│   ├── network/
│   │   ├── topology.js            双平面邻居管理（M1 设计 / M8 审计归档）
│   │   ├── tunnel.js              Tunnel + TunnelManager（单跳 relay + 多链路对冲 + 硬切换，M5 已实现）
│   │   ├── dht.js                 DHT 门控（M1 已实现）
│   │   ├── rendezvous.js          跨网段引导（M1 已实现，手动 multiaddr 方案）
│   │   └── relay.js               RelayRegistry（准入阈值 + epoch 轮换，M5 已实现）
│   └── app/
│       ├── cli.js                 命令行 REPL（M8.2-1/2/3 已实现：tokenize/parseArgs + 43 个命令 = 7 诊断 + 11 M3-M4 + 25 M5-M7）
│       └── web-panel.js           本地 Web 面板（M8.2-4：HTTP server 127.0.0.1 + 13 个 JSON API + vis-network 拓扑可视化）
└── test/
    ├── persistence.test.js            M8.1 持久化工具单元测试（28 个）
    ├── persistence-restart.test.js    M8.1 重启恢复集成测试（11 个）
    ├── audit-fixes.test.js            审计修复单元测试（P2-1 start() 回滚，3 个）
    ├── dht-gate.test.js              DhtGate 单元测试（8 个）
    ├── dht-gate-e2e.test.js           DHT 门控端到端（6 个）
    ├── bootstrap-e2e.test.js          Bootstrap 跨网段引导端到端（5 个）
    ├── identity.test.js               identity 单元测试（14 个）
    ├── identity-signing-e2e.test.js   identity 签名端到端（5 个）
    ├── message-types.test.js          消息类型与结构校验单元测试（13 个）
    ├── wiki.test.js                   维基协议单元测试（9 个）
    ├── vouch.test.js                  vouch 资格门控单元测试（20 个）
    ├── wiki-version-chain.test.js     维基版本链单元测试（16 个）
    ├── credit.test.js                 Credit 双轨经济单元测试（48 个）
    ├── relay.test.js                  Relay 准入与轮换单元测试（24 个）
    ├── tunnel.test.js                 私聊隧道单元测试（26 个）
    ├── s-node-tunnel.test.js          SNode M5 隧道集成测试（11 个）
    ├── arbitration.test.js            临时仲裁团 + Slash 单元测试（46 个）
    ├── market.test.js                 邀请市场 + 双重加密单元测试（55 个）
    ├── cli.test.js                    M8.2 CLI 单元测试（143 个：36 框架 + 30 M3-M4 + 77 M5-M7）
    ├── web-panel.test.js              M8.2 Web 面板单元测试（42 个：启停 + 路由 404/405 + HTML/API + 拓扑 + 并发 + 安全）
    ├── s-node-startapp.test.js        M8.2 startApp 集成测试（33 个：启动顺序 + 退出顺序 + 配置开关 + 错误处理 + SIGINT/SIGTERM + config.js）
    └── four-nodes-e2e.test.js         M8.3 4 节点集成测试（17 个子测试：star 拓扑 + gossipsub 跨节点传播 + 持久化重启恢复）
```

## MVP 里程碑

| 里程碑 | 状态 | 关键能力 |
|---|---|---|
| M1 双平面传输基线 | ✅ 已完成 | 节点发现 + 跨网段引导 + DHT 门控 |
| M2 DID 派生 | ✅ 已完成 | 4-context 子身份（HKDF）+ 公共层消息签名 |
| M3 维基协议 | ✅ 已完成 | CID 广播 + 编辑员 context-D 签名 + vouch 资格门控 + 版本控制链 |
| M4 Credit 双轨 | ✅ 已完成 | Reputation 三池 + Credit 余额 + Faucet 冻结/释放 + VouchRegistry 信誉加权升级 |
| M5 单跳 Relay | ✅ 已完成 | RelayRegistry 准入/轮换 + TunnelManager 多链路对冲 + 硬切换 + context-C 私聊身份 |
| M6 仲裁团 | ✅ 已完成 | 临时仲裁团（5 节点 + 多数裁决 ≥3）+ Slash 只动 frozen（50% 赔受害者 + 50% 进金库）+ TreasuryLedger 金库审计 |
| M7 邀请市场 | ✅ 已完成 | AppManifest + InviteToken（Ed25519 签名）+ 私有 topic（sha256 令牌）+ AES-256-GCM 双重加密 + MarketRegistry |
| 审计修复 | ✅ 已完成 | 6 P0 + 6 P1 + 3 P2 全部修复（canonical 签名 / note 内层验签 / 原子性 / LRU 上限 / start 回滚 / 监听器顺序） |
| M8.1 持久化 | ✅ 已完成 | 6 registry + credit nonce 集合全部持久化（JSON + 同步原子写 + start 加载 / stop flush） |
| M8.2 CLI 收口 | ✅ 已完成 | REPL 引擎 + 43 个命令（7 诊断 + 11 M3-M4 + 25 M5-M7）+ Web 面板（13 个 API + vis-network 拓扑）+ s-node.js 集成（startApp 可测试函数） |
| M8.3 4 节点集成测试 | ✅ 已完成 | 4 节点 star 拓扑 harness + gossipsub 跨节点传播（vouch/wiki/credit 镜像）+ 持久化重启恢复 + nonce 重放保护 |

## 核心设计决策（M1 → M2 → M3 → M4 → M5 → M6 → M7 阶段递进）

### 传输与发现（M1）
- **传输层**：libp2p 3.x + helia 7.x，TCP + noise + yamux/mplex
- **身份与 IPFS 共用 PeerId**：helia mixin 模式，IPFS 与 Havix 协议层共用同一个 PeerId
- **发现**：mDNS 局域网自动发现 + 手动 multiaddr 跨网段引导
- **DHT**：默认 LAN 模式（`/ipfs/lan/kad/1.0.0`），与公网 IPFS Amino DHT 隔离
- **门控**：私域 CID 在协议层硬性拦截，不依赖加密兜底

### 身份与不可关联性（M2）
- **4-context DID 派生**：在主 PeerId 基础上 HKDF-SHA256 派生 A/B/C/D 四组密码学独立的子身份
  - A=公开层活跃性广播、B=市场参与、C=私聊隧道、D=维基编辑员
- **不可关联性**：接收方零依赖验签（消息内嵌公钥），但无法从子 DID 反推主 PeerId，也无法跨 context 关联
- **签名规则（P0-1 修复后）**：签名覆盖整个 canonical message 的 JSON 序列化字节（移除 `signature` / `signerPublicKey` 后的字段，即 `{version, type, senderId, timestamp, payload}`）；推荐使用 `signMessage()` 工厂统一入口。这保证 `senderId` / `type` / `timestamp` 都不能被第三方篡改——原签名只覆盖 `payload` 会被"vouch 改 credit"或"伪造 senderId"绕过

### 维基协议（M3）
- **维基协议数据流**：内容写入 IPFS（raw codec + sha256 CID）→ 编辑员 context-D 签名 payload → gossipsub `/s-network/announce` 广播 → 接收方验签后索引本地 manifest
- **维基 announce 与心跳同 topic**：不新增 topic，复用 `/s-network/announce`，用消息 `type` 字段区分
- **vouch 走独立 topic**：`/s-network/reputation`，与心跳/维基 announce 分开，便于 M4 接入 Credit 流水时复用
- **vouch 用 context-A 签**：背书人用公开层活跃性身份；被背书人才是 context-D 编辑员身份；跨 context 验签链路天然防伪造
- **voucherDid 取自 senderId**：而非 payload 字段，防止"我替别人 vouch"的伪造攻击
- **vouch 阈值默认 N=2**：白皮书建议值，可在 `VouchRegistry` 构造时覆盖；M3 用简单 N-vouch 计数，M4 升级为按 voucherReputation 加权
- **版本链 lazy 验证**：父 CID 不在本地索引时不阻塞发布（仅记录 parentCid），适配网络延迟与乱序到达；完整 Merkle DAG 验证 deferred
- **版本链作者一致性**：续写时父版本作者必须与当前编辑员一致，防止劫持他人条目；跨作者协作编辑 deferred
- **向后兼容**：无 parentCid 字段的旧消息自动视为根条目

### Credit 双轨经济（M4）
- **三池模型（白皮书 §4.2 关键性质 4）**：`ReputationLedger` 维护 `did → {available, frozen, total}`，total = available + frozen，签发 Credit 在两池间转移（freeze available → frozen），消费时反向（release frozen → available），total 始终不变——意味着签发 Credit 不影响 issuer 的总信誉排名，只影响其"还能再签发多少 Credit"
- **Faucet 单向转换**：高信誉节点（总信誉 ≥ minReputation=10）签发 Credit 时等额冻结自身可用信誉，Credit 被消费后冻结部分释放；issuer 总信誉不变（反通胀）+ 签发有成本（作恶成本）+ 信誉锚定 Credit 价值（价值锚定）
- **VouchRegistry 双模式**：构造时不传 `reputationLedger` → M3.2 兼容模式（简单 N-vouch 计数）；传入 → M4 加权模式（`getWeightedScore = Σ voucherReputation`）；`thresholdScore` 默认 = `threshold × DEFAULT_INITIAL_REPUTATION`，确保所有 vouch 来自默认 1.0 信誉节点时两模式行为完全等价（向后兼容）
- **`getQualification` 统一接口**：返回 `{score, threshold, qualified}` 三元组，WikiProtocol 门控已切换到此接口，上层错误信息（`EditorNotQualifiedError` 的 current/threshold/need 字段）自动适配两种模式
- **CreditNote 签名 JSON**：写入 IPFS 的凭证结构 `{type, issuerDid, holderDid, amount, nonce, timestamp, prevNoteCid, signature, signerPublicKey}`；issuer 用 context-A 子身份签名（与心跳/vouch 同 context，便于聚合信誉事件）；nonce 防重放；prevNoteCid 形成流水链
- **credit 消息走 `/s-network/reputation`**：与 vouch 同 topic，便于聚合信誉事件；接收方 `_handleCreditMessage` 按 nonce 幂等镜像 issue/consume 到本地账本
- **Slash 接口暴露（M6 调用）**：`ReputationLedger.slash(did, amount)` 只从 frozen 池扣除（不动 available），与白皮书 §5.3 一致——只惩罚"正在签发 Credit 中的冻结部分"，不影响已建立的信誉基础；total 减少（不同于 release）
- **不持久化**：M4 范围内 ReputationLedger / CreditLedger / VouchRegistry 都不持久化，节点重启从 0 重新累积；持久化、网络重放保护 deferred 到 M5+
- **跨节点账本一致性**：M4 不实现跨节点账本同步——每个节点维护自己的信誉视图，跨节点一致性靠 gossipsub credit 消息最终收敛；真正双重支付防护 deferred 到 M6 仲裁团对 IPFS 流水链做最终裁决

### 单跳 Relay 隧道（M5）
- **简化洋葱（白皮书 §7）**：不追求绝对匿名（那需要真洋葱路由），用单跳 relay + 信誉问责替代；Tor 的 relay 是匿名志愿者不可问责，Havix 的 relay 是有 vouch 累积的实体，作恶会损失长期信誉——"用信誉换延迟"是 Tor 没有的自由度
- **准入双重门槛（白皮书 §7.3）**：信誉前 30%（`topPercentile=0.30`，按 available 信誉降序取前 N）+ 至少 3 个高信誉节点 vouch（`minVouchCount=3`）；`RelayRegistry` 注入 `reputationLedger` + `vouchRegistry`，准入时实时读取账本状态；M5 用 vouch count，M4 加权模式判定留 M6+
- **epoch 轮换（白皮书 §7.3）**：每个 epoch（默认 1 小时）有 20% 概率被换下（`rotateProbability=0.20`），中签后从候选池按信誉降序补位，补位候选也必须通过 vouch 门槛；M5 用 `Math.random`，分布式 VRF deferred 到 M6+；M5 不实现自动 epoch 推进定时器（外部触发，deferred 到 M8 CLI）
- **多链路对冲（白皮书 §7.2）**：A → R1 → B / A → R2 → B / A → R3 → B 三条并行 relay，流量按 round-robin 分片，3 条 relay 各传 1/3 流量；单 relay 被攻破只能看到 1/3 流量片段；分片不可重组（每个 chunk 独立路由，单 relay 视角是无序片段）
- **硬切换（白皮书 §7.3）**：MVP 采用硬切换——relay 下线立即从 active 集合移除（`breakLink`），不试图重连该 relay；剩余 relay 继续服务（状态 `degraded`）；所有 relay 断开后隧道整体 `broken`，`sendChunk` 抛 `TunnelBrokenError`，应用层感知重连；电路迁移应用层重连机制 deferred 到 M8 CLI 收口
- **链路状态机**：`active`（3 条全在线）/ `degraded`（1-2 条断开，剩余继续）/ `broken`（全断开，拒绝写入）；`getStats()` 返回各链路发送统计（sentChunks / status / brokenAt）
- **context-C 私聊身份**：`SNode.establishTunnel` 用 context-C 子身份作为 sourceDid（私聊身份），与维基 D / 公开 A / 市场 B 隔离；A、B 互相不知道对方真实 IP，relay 只看到 context-C DID
- **不持久化**：M5 范围内 RelayRegistry / TunnelManager 都不持久化，节点重启后 relay 候选集与隧道全部丢失；持久化 deferred 到 M8
- **真实 libp2p stream 跨进程传输 deferred**：M5 用字节级接口（`sendChunk(chunk: Uint8Array)`），跨进程 libp2p stream 集成留 M8；noise 握手复用 libp2p 已有加密层，不单独实现；relay 协商协议（A 如何发现哪些 relay 愿意服务 B）用 RelayRegistry 本地视图，跨节点协商 deferred 到 M6+

### 临时仲裁团与 Slash（M6）
- **临时召集制（白皮书 §5.4）**：Havix 的治理不是"民主投票"（多数暴政），不是"中心执法"（S 国模型），是高信誉者的临时召集制——商会、行会、自治公社的真实治理形态；dispute 发生时临时召集 5 节点仲裁团，裁决后解散，无长期治理机构
- **三种 dispute 触发条件（白皮书 §5.1）**：`offer-breach`（付了 credit 但没拿到服务）/ `relay-malice`（relay 节点泄露电路或篡改流量）/ `vouch-collusion`（相互刷 vouch 抬高信誉）；分别对应经济纠纷、传输层作恶、信誉系统舞弊三类治理场景
- **仲裁员门槛双重（白皮书 §5.1）**：信誉 > 网络中位数 × 1.5（`reputationMultiplier` 默认 1.5，可配置为 0 关闭中位数门槛）+ vouch 数 ≥ 10（`minVouchForJuror`）；用信誉与 vouch 双重过滤，确保仲裁员既有钱也有社区信任
- **防串谋（白皮书 §5.1）**：候选曾 vouch 过 claimant/respondent，或 claimant/respondent 曾 vouch 过候选，都不能入团——双向排除避免"朋友判朋友"；同时 claimant/respondent 自身也被排除（自举拒绝）
- **多数裁决（白皮书 §5.2）**：5 节点仲裁团需 ≥3 票一致（`verdictMajority` 默认 3）才能裁决；`abstain` 不计入多数判定（防弃权票稀释裁决）；未达多数返回 `{resolved: false, reason}` 不抛错，等待更多投票
- **最终性保护**：已裁决 dispute 再投票或再裁决都抛 `DisputeAlreadyResolvedError`，防止反复裁决造成信誉系统不稳定
- **Slash 只动 frozen（白皮书 §5.3，治理与经济的咬合点）**：`slash` 只从 `frozen` 池扣除，不动 `available`——如果 slash 能动可用信誉，攻击者可以靠仲裁把别人信誉打光（治理武器化）；只动 frozen 则 slash 只影响"正在发行的 credit"（治理成为"经济纠纷解决"而非"政治清洗"）；这恰好对应论文主张"结构性困境"的"反治理武器化"设计
- **Slash 分配（白皮书 §5.3）**：`actualSlash = min(dispute.amount, frozenBefore)`（frozen 不足只扣到 0，不抛错）；`slashRatio` 默认 0.5 → 50% 赔受害者（`reputationLedger.credit(claimant, ...)`）+ 50% 进金库（`treasury.deposit(...)`）；slashRatio 可配置（如 0.3 赔 30% / 70% 进金库）
- **金库账本（白皮书 §5.3）**：`TreasuryLedger` 只进不出（M6 范围），所有 slash 的金库部分累加；`getHistory(disputeId?)` 支持按 dispute 过滤的审计；M6 用内存账本，IPFS 公开 ledger deferred 到未来；金库支出用途治理（社区决定如何使用）deferred 到未来
- **仲裁消息走独立 topic（白皮书 §2.1）**：`/s-network/alert` 与 `/s-network/announce`（心跳/维基）/ `/s-network/reputation`（vouch/credit）分开；payload 含 `action: filed | panel-summoned | vote-cast | verdict`；接收方按 action 镜像本地 dispute 状态
- **verdict 镜像不执行 slash**：跨节点广播的 verdict 消息，接收方仅更新本地 dispute 状态为 resolved，不执行 slash（避免重复扣账）；只有原始发起仲裁的节点执行 slash（一次性扣账），其他节点仅记录最终性
- **不持久化**：M6 范围内 ArbitrationRegistry / TreasuryLedger 都不持久化，节点重启后 dispute 与金库余额丢失；持久化 deferred 到 M8
- **跨节点仲裁团选举 deferred**：M6 用本地视图召集仲裁团（候选仲裁员池是本节点维护的），跨节点仲裁团选举协议（如何让全网对同一 dispute 召集到同一组仲裁员）deferred 到未来；M6 MVP 假设发起仲裁的节点本机有足够候选仲裁员
- **24 小时超时重抽 deferred**：白皮书 §5.1 提到"24 小时未达成裁决则重抽"，M6 由外部触发（不实现定时器），定时器 deferred 到 M8 CLI 收口
- **候补仲裁员自动补位 deferred**：白皮书 §5.1 提到"先响应的 5 个正式入团，其余作为候补"，M6 用固定 5 节点（panel 召集后不补位），候补机制 deferred
- **分布式 VRF deferred**：M6 用 `Math.random` 抽取仲裁团（与 M5 epoch 轮换一致），真实分布式随机数 VRF deferred 到未来

### 邀请市场与双重加密（M7）
- **私域不可见（白皮书 §6.5）**：私域 CID 绝对不进 DHT，只在私有 gossipsub topic 内分发；纯加密方案下攻击者可枚举网络成员、可观察谁在请求什么 CID；双平面方案让攻击者连"有什么内容存在"都不知道；这对应论文主张"集权系统的反面不是无政府，是分层可见性 + 准入自治"
- **双重加密（白皮书 §6.5）**：第一层 topic 名 = sha256(邀请令牌)，攻击者扫描只能看到哈希；第二层消息体用 HKDF 派生的 AES-256-GCM 密钥加密，即使暴力加入 topic 也解不开消息；两层防护让"私域"真正不可见
- **App Manifest 规范（白皮书 §8.2）**：每个私域市场 = 一个 App，通过 manifest 声明能力需求（name/version/capability 必需，permissions/spa_cid/min_reputation/trust_weight 可选）；M7 仅支持 `invite_token_format = 'ed25519-signature'`（其他格式 deferred）；`marketId = name + sha256(manifest)[0:8]` 确定性派生，相同 manifest → 相同 marketId
- **邀请令牌（白皮书 §8.2）**：令牌由市场创建者用 context-A 子身份签发，包含 `marketId/issuerDid/inviteeDid/issuedAt/expiresAt/nonce`（payload）+ `signature/signerPublicKey`（Ed25519 签名 + 公钥）；`expiresAt=0` 永不过期；nonce 用 `crypto.randomUUID()` 防重放；验签用 `@noble/curves` Ed25519
- **共享市场令牌设计**：白皮书 §6.5 的 `inviteToken` 是单数形式，意味着所有市场成员共享同一个市场令牌来派生 topic + key；`issueInvite` 签发的是"邀请凭证"（用于 out-of-band 身份验证），但实际加入市场需要拿到市场令牌（创建者通过私有渠道传递）；因此 `joinMarket` 不强制 `inviteeDid === myDid`（令牌可被转发给其他成员）；授权由 out-of-band 渠道保证，本方法只做密码学校验（签名 + 过期 + nonce）
- **AES-256-GCM 选择**：用 Node.js 内置 `crypto` 模块（无需第三方依赖）；IV 12 字节随机（NIST SP 800-38D 推荐）；认证标签 16 字节（GCM 默认）；相同明文每次加密 IV 不同（随机性，防模式分析）
- **明文信封设计**：广播的消息结构 `{version, type:'offer', senderId, timestamp, payload:{marketId, encrypted:{iv,ciphertext,tag}}}`；明文信封不含原 payload，攻击者即使加入 topic 也只能看到加密 blob；`senderId` 是 context-B 子身份 DID（市场参与身份，与公开层 context-A 隔离）；加密本身即认证（AES-GCM 认证标签保证完整性），不需要二次签名
- **topic 反查 marketId**：接收方收到 gossipsub 消息时，通过 topic 字符串反查本地 MarketRegistry 找到 marketId（而非消息体里读 marketId）；这避免攻击者伪造 marketId 误导接收方
- **不持久化**：M7 范围内 MarketRegistry 不持久化，节点重启后市场列表丢失；持久化 deferred 到 M8
- **跨节点 transfer 同步 deferred**：M7 用本地账本视图，跨节点同步靠 gossipsub 消息收敛；完整跨节点账本一致性 deferred 到未来
- **market 内 offer/credit 完整流转 deferred**：M7 只提供加密通道（AES-GCM 加密的消息信封），市场内 offer/credit 业务逻辑（如下单、支付、确认）由 App 自行实现；M4 的 CreditLedger 已提供基础设施
- **SPA bundle 拉取 deferred**：M7 用 IPFS CID 占位 `spa_cid` 字段，不实现 SPA bundle 拉取与缓存；未来可由 helia 拉取 CID 后注入 iframe
- **App Manifest 动态权重审核 deferred（白皮书 §8.4）**：FW-01 问题（App 自声明 trust_weight 可被刷分）由"自然涌现算法"解决，推迟到阶段二；阶段一无第三方 App，不存在刷分问题
- **令牌吊销列表 deferred**：M7 用 `expiresAt` 过期机制，吊销列表（CRL）deferred 到未来；当前令牌泄露只能等过期
- **跨节点市场成员同步 deferred**：M7 用本地视图（本节点维护的 members 集合），跨节点一致性靠 gossipsub 消息收敛；完整成员同步协议 deferred
- **第三方 App 加载 deferred（白皮书 §8.5）**：阶段一不开放第三方 App，参考实现内置；阶段二开放 App Manifest 规范定稿
- **独立邀请凭证与市场令牌分离 deferred**：M7 MVP 简化为共享令牌（所有成员用同一个 token），未来分离为"邀请凭证（identity-bound）+ 市场根令牌（topic/key derivation）"两个概念，提升安全性

### 审计修复（M8 集成前）
- **签名覆盖整个 canonical message（P0-1）**：原签名只覆盖 `payload` 字段——攻击者可篡改 `senderId` / `type` / `timestamp` 而不破坏签名（"vouch 改 credit"或"伪造身份"）。修复后 `canonicalMessage()` 移除 `signature / signerPublicKey` 后整体参与签名。这是审计阶段最关键的修复，所有验签测试（identity-signing-e2e / vouch / wiki）都同步更新
- **双层签名校验（P0-2）**：credit note 既有 issuer 用 context-A 子身份签的外层消息签名（防伪造发送方），也有 issuer 用同一 context-A 私钥签的内层 note 签名（防伪造 note 内容）；接收方 `_handleCreditMessage` 双层校验：先验外层消息签名（主 handler 已验），再验内层 note 签名（`verifyCreditNoteSignature`），同时强制 `senderId === note.issuerDid` 绑定（防 senderId 与 issuer 解耦的伪造攻击）
- **topic 前缀分流（P0-3）**：`/s-network/market/<hex64>` 私有 topic 上的消息已 AES-GCM 加密 + 认证（GCM 认证标签保证完整性），不需要再做公共层签名校验。主 `_pubsubHandler` 按 `topic.startsWith(MARKET_TOPIC_PREFIX)` 分流到 `_handleMarketTopicMessage`，避免因缺 signature 字段被误拒。这同时与"密钥派生即认证"原则一致——只有持有令牌的成员能派生密钥解密
- **零依赖自验签（P0-4）**：InviteToken 在 token 内嵌 `signerPublicKey`，新增 `verifySelf()` 方法用 `@noble/curves` Ed25519 直接验签，不需要 DHT 查询 issuer 公钥。`joinMarket` 改为 async 并强制调用 `verifySelf()`，防"任何节点伪造 token 加入市场"攻击
- **DoS 防护（P0-5）**：整个 gossipsub message dispatch 包一层 try/catch——任何 handler 异常（如 `JSON.parse` 失败、字段缺失、网络错误）都只记录，不让节点进程崩溃。这是 P2P 网络的必备 DoS 防护（恶意节点可故意发送畸形消息触发异常）
- **slash 0 守卫（P0-6）**：当 `dispute.respondent` 的 `frozen=0` 时（未签发过 Credit），`actualSlash = Math.min(amount, 0) = 0`，但原代码仍会执行 `slash(0)` / `credit(0)` / `deposit(0)`——触发边界异常。修复后 `actualSlash > 0` 守卫，frozen=0 时跳过整个 slash 与赔偿路径，仅记录 warn。这同时简化了金库审计（不会出现金额为 0 的噪音记录）
- **Faucet.consume 原子性（P1）**：`debit(holder)` 成功但 `release(issuer)` 失败时（如 issuer 冻结不足），原代码会让 holder 余额已扣但 issuer 冻结未释放——账本不一致。修复后 `release` 失败时回滚 `credit(holder, amount)` 退还 holder 余额，再抛错。这是"两阶段提交"模式的最小实现
- **arbitration senderId 镜像校验（P1）**：跨节点镜像 verdict 时未校验 senderId 是否在 panel 中——任意节点可伪造裁决让本地 dispute 标记为 resolved，阻止真实仲裁进行。修复后 `filed` action 强制 `senderId === claimant`（防伪造他人发起），`verdict` action 在本地已有 panel 信息时强制 `senderId ∈ panel`（panel 未知时宽松接受，对应"M6 跨节点 panel 一致性靠消息收敛"的渐进式严格）
- **Set/Map LRU 上限（P1）**：长跑节点的 `market._seenNonces` / `vouch.vouches` / `wiki.entries` / `arbitration.disputes` / `s-node._processedCreditNonces` 都会无限膨胀（每个 nonce/entry/dispute 永久保留）。修复后全部加 100,000 上限，超限时 FIFO 退化 LRU 移除最早项。这是"无 GC 的内存型账本"的必备防护
- **start() 失败回滚（P2-1）**：原 `start()` 无回滚——`ipfs.start()` 成功后任何步骤抛错会让 libp2p 半启动残留（端口仍占、监听器未注册、ipfs 未停）。修复后拆分为 `start()` 外壳 + `_startInternal()` 实现，外壳 try/catch 在失败时调用 `stop()` 清理已启动资源。`stop()` 自身异常也不掩盖原始错误（先记录 stop 错误，再抛原始 start 错误）
- **监听器注册顺序（P2-2）**：原顺序是先 `subscribe(topic)` 再 `addEventListener('message', handler)`——订阅后到 handler 注册前到达的消息会被丢弃（消息丢失窗口）。修复后先注册所有监听器（peer:discovery / connection:open / connection:close / pubsub message），再 `subscribe(topic)`，确保第一条消息就能被 handler 接收。这是事件驱动系统的基本正确性要求

### 持久化（M8.1）
- **存储格式选 JSON 文件而非 LevelDB / SQLite**：MVP 阶段账本 mutation 频率低（每 vouch/credit/dispute 一次），数据量小（每 ledger KB 量级），JSON 文件足够；LevelDB 引入额外依赖且 KV 抽象对"序列化整个 registry 状态"无优势；SQLite 适合查询密集场景但对 Havix 无必要；JSON 文件可读性最佳（崩溃后可直接 `cat` 检查账本）
- **同步原子写而非异步 fs.promises**：① mutation 频率低，同步写性能足够；② 同步写更简单——mutation 返回时磁盘已落盘，无需等待 flush；③ 与 P2-1 start() 回滚兼容——start 失败时不会留下半写入状态。原子写流程：`write tmp` → `renameSync(tmp, target)`——即使写到一半进程崩溃，原文件仍完整
- **加载时机选 start() 时而非构造函数**：构造函数只做内存初始化（避免 fs I/O 影响单元测试），实际加载在 `_startInternal()` 中 `ensureDir(persistDir)` 之后；这样首次启动（文件不存在）等价于空状态（`loadJson` 返回 null，`loadState(null)` 静默无操作）
- **mutation 后自动 _persist() 而非仅 stop() 时 flush**：防"运行中崩溃丢数据"——虽然原子写性能 OK，但若只在 stop() 时 flush，进程被 kill -9 时所有未 flush 的 mutation 全丢；折中方案：每次 mutation 后同步落盘（O(n) fsync，但 mutation 频率低可接受）
- **失败不抛错（只 log warn）**：mutation 已成功的业务状态不可因磁盘问题回滚——若 credit 已扣但落盘失败时回滚 credit，反而会引入"账本视图与磁盘不一致"的更严重问题。正确做法是接受"内存账本与磁盘短暂不一致"，等待下次 mutation 的 _persist() 自然修正
- **纯内存模式向后兼容**：不传 persistPath 时各 registry 退化为内存模式（flush 是 no-op），现有单元测试无需修改即可通过——这是 M8.1 集成 318 测试全过的关键
- **loadState 合并式而非覆盖式**：恢复时不覆盖 registry 已存在的数据，只在空缺处填充——保证 loadState 重入安全（同一份 json 重复调用 loadState 不会丢失内存中已存在的数据）
- **credit nonce 集合独立持久化**：`_processedCreditNonces` 集合不属于任何 registry（SNode 直接管理），单独持久化到 `credit-nonces.json`；3 处 `.add()` 后调用 `_persistCreditNonces()`，stop() 时一并 flush
- **不实现加密存储（M8.1 明文 JSON）**：MVP 阶段假设运行节点可信（账本文件可明文）；未来 M9+ 加 AES-GCM 加密保护本地账本隐私（防止恶意软件偷取 .data/ledgers/* 直接读取用户信誉与余额）
- **不实现多版本快照 / WAL**：M8.1 只保留最新状态——崩溃前最后一次 mutation 可能丢失（_persist 失败时），但不会损坏文件（原子写保证）；WAL 适合高频率写入场景，对 Havix 的低频 mutation 无必要
- **跨节点账本一致性不变**：M8.1 持久化只是单节点重启恢复——节点在线时仍靠 gossipsub 消息收敛账本；持久化不解决"双花"问题（仍 deferred 到 M6 仲裁 + 未来 IPFS 流水链验证）

### 关键依赖版本坑
- **gossipsub**：必须用 `@libp2p/gossipsub@16.x`（依赖 `@libp2p/interface@3.x`），不要用 `@chainsafe/libp2p-gossipsub@14.x`（依赖 `@libp2p/interface@2.x`，与 libp2p 3.x 不兼容，会导致流无法建立）
- **multiformats**：v14.x 起需用 `CID.createV1(codec, hash)` 与 `CID.parse(str)`，旧版的 `create(version, codec, hash)` 与 `multiformats.parse` 已不可用
- **helia blockstore**：`get(cid)` 返回 `AsyncGenerator<Uint8Array>`，需 `for await` 收集 chunks（非单个 Uint8Array）
- **libp2p.peerId.privateKey**：在 `@libp2p/peer-id` 6.x 中不存在，必须用 `libp2p.components.privateKey`
- **主 DID 种子提取**：masterPriv.raw 是 64 字节（32 seed + 32 pubkey），取 `.subarray(0, 32)`

## 免责声明

Havix 仅用于学术验证目的，不涉及任何现实政治或商业用途。详见 [白皮书第 15 章](./Havix-Technical-Whitepaper.md)。
