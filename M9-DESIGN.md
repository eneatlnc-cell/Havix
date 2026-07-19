# M9 — App SDK 详细设计

> **当前阶段**：MVP（M1–M8.3）已完成，进入阶段二（M9–M12+）的第一步
> 路线规划见 [ROADMAP.md](./ROADMAP.md)，部署运行见 [DEPLOY.md](./DEPLOY.md)。

本文件是 M9 阶段的详细设计文档。M9 目标：把 Havix 节点的协议能力封装为 App 可调用的 SDK，让 App 开发者**不需要直接 import 协议层模块**，只通过 SDK 高层 API 操作。

---

## 1. 目标与范围

### 1.1 必做（M9 范围内）

- ✅ Havix SDK 包（位置：`sdk/` 子目录）
- ✅ AppManifest 规范 v1.0（基于白皮书 §8.2 草案）
- ✅ App 容器机制（节点启动时挂载 App）
- ✅ SDK 7 大接口（context / market / credit / wiki / tunnel / arbitration / transport）
- ✅ 参考模板 `apps/empty-app/`
- ✅ SDK 单元测试（mock SNode）
- ✅ SDK 集成测试（接真实 SNode）
- ✅ Web 面板扩展：支持 `/apps/<app-name>/` 路由

### 1.2 Deferred（M10+ 处理）

- App 沙箱执行（M9 App 与节点同进程，M12 改 Worker Thread）
- 第三方 App 加载器（M9 只支持内置 App）
- App 动态安装/卸载（M9 App 在节点启动时静态注册）
- App 间事件总线（M9 各 App 独立，互不通信）
- AppManifest 自动审核（M9 人工审核，M12 自动化）

---

## 2. SDK 架构总览

```
┌──────────────────────────────────────────────────────────┐
│                    App（如翻译市场）                       │
│   用 SDK 提供的高层 API 操作业务，不直接接触协议层         │
└────────────────────────┬─────────────────────────────────┘
                         │ import { createApp } from 'havix-sdk'
                         ↓
┌──────────────────────────────────────────────────────────┐
│                    Havix SDK（sdk/）                      │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐    │
│  │ app.market   │ │ app.credit   │ │ app.wiki     │    │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘    │
│         │                │                │             │
│  ┌──────┴───────┐ ┌──────┴───────┐ ┌──────┴───────┐    │
│  │ app.tunnel   │ │ app.arbitration│ │ app.context  │   │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘    │
│         │                │                │             │
│         └────────────────┼────────────────┘             │
│                          │                              │
│                  app.transport                           │
│            （gossipsub + IPFS 抽象）                     │
└──────────────────────────┬─────────────────────────────-─┘
                           │ SDK 通过 deps 注入 SNode 实例
                           ↓
┌──────────────────────────────────────────────────────────┐
│                Havix 节点（src/s-node.js）               │
│   SNode 公开 API（已有，M3-M7 实现）                     │
└──────────────────────────────────────────────────────────┘
```

**核心设计原则**：

1. **依赖注入**：SDK 不直接 `import { SNode }`，而是接收 SNode 实例作为参数。这让 SDK 可被单元测试用 mock SNode 验证。
2. **声明优先**：App 用 Manifest 声明能力，SDK 校验权限，不允许越权。
3. **隔离性**：每个 App 有独立的 `manifestId` / 加密密钥 / 数据目录，App 间不互相污染。
4. **能力受限**：SDK 不暴露 libp2p / helia 私有 API，只暴露业务语义。
5. **可测试**：SDK 提供 mock 实现，App 单元测试不依赖真实节点。

---

## 3. AppManifest 规范 v1.0

### 3.1 字段定义

基于白皮书 §8.2 草案 + M9 补充字段：

| 字段 | 必需 | 类型 | 说明 |
| --- | --- | --- | --- |
| `name` | ✅ | string | App 全局唯一标识（kebab-case，如 `translation-market`） |
| `version` | ✅ | semver | App 版本（如 `1.0.0`） |
| `capability` | ✅ | enum | `market` / `wiki` / `tunnel` / `public` / `custom` |
| `permissions` | ✅ | string[] | 权限声明列表（见 §3.2） |
| `entryPoint` | ✅ | string | App 入口模块相对路径（如 `./index.js`） |
| `inviteTokenFormat` | ❌ | enum | `ed25519-signature`（默认）/ `none` |
| `spaCid` | ❌ | CID | 前端 SPA 的 IPFS CID（M9 占位，不拉取） |
| `minReputation` | ❌ | number | 参与门槛（默认 0） |
| `trustWeight` | ❌ | number | 0.0–1.0，加权转换权重（默认 0.5） |
| `dataDir` | ❌ | string | 独立数据目录名（默认等于 `name`） |
| `contexts` | ❌ | string[] | 使用的 context 子身份，如 `['B', 'D']`（默认 `['A']`） |
| `description` | ❌ | string | App 人类可读描述 |

### 3.2 权限声明（白名单）

共 28 项权限，按 8 大 category 分组（market 6 + credit 4 + wiki 3 + tunnel 3 + arbitration 3 + identity 5 + transport 2 + ipfs 2 = 28）：

```
# 市场权限（6 项）
market:create         创建新市场
market:invite         邀请成员
market:join           加入市场
market:publish        发布私域消息
market:subscribe      订阅私域消息
market:leave          离开市场

# Credit 权限（4 项）
credit:issue          签发 credit（需高信誉）
credit:consume        消费 credit
credit:transfer       转账
credit:balance        查询余额

# 维基权限（3 项）
wiki:publish          发布条目（需 vouch 阈值）
wiki:list             列出条目
wiki:get              获取条目

# 隧道权限（3 项）
tunnel:open           打开隧道
tunnel:send           发送隧道消息
tunnel:close          关闭隧道

# 仲裁权限（3 项）
arbitration:file      发起仲裁
arbitration:vote      投票（需仲裁员资格）
arbitration:resolve   裁决（需仲裁团多数）

# 身份权限（5 项：基础 + 4 context）
identity:context        获取本节点 context 信息（含完整 4-context 状态面板，verify 任意 context 都可）
identity:context:A      用 context-A 签名（A 是互联网通行身份，慎用）
identity:context:B      用 context-B 签名（业务身份）
identity:context:C      用 context-C 签名（私聊身份）
identity:context:D      用 context-D 签名（维基编辑身份，需 vouch 阈值）

# 传输权限（2 项）
transport:publish     直接 gossipsub 发布（自定义 topic）
transport:subscribe   直接 gossipsub 订阅

# IPFS 权限（2 项）
ipfs:read             IPFS 读取
ipfs:write            IPFS 写入
```

**校验规则**：SDK 在 App 调用任何 API 前校验对应权限，缺失抛 `PermissionDeniedError`。

### 3.3 示例 Manifest（翻译市场）

```yaml
# apps/translation-market/manifest.yaml
name: translation-market
version: 1.0.0
capability: market
permissions:
  - market:create
  - market:invite
  - market:join
  - market:publish
  - market:subscribe
  - credit:consume
  - credit:balance
  - arbitration:file
  - identity:context:B
  - ipfs:read
  - ipfs:write
inviteTokenFormat: ed25519-signature
minReputation: 30
trustWeight: 0.8
dataDir: translation-market
contexts: [B]
description: 邀请制翻译服务市场，credit 消费 + 仲裁保障
entryPoint: ./index.js
```

### 3.4 Context 取舍设计哲学（M9 理论修正）

**核心理念**：Havix 的 4-context 隔离（A/B/C/D）不是"每个 App 都该用全部 4 个"，而是**该用哪个就用哪个，不该用的刻意不用，每个选择都有明确理由**。

**翻译市场的取舍（最终方案）**：

| Context | 是否使用 | 设计理由 |
| --- | --- | --- |
| **主 DID** | ✓（身份锚定） | 节点稳定身份，vouch 锚定对象，不直接参与业务 |
| **context-A**（公共） | **✗ 刻意不用** | A 是"畅游互联网"的通用身份，**绝不能与具体业务关联**——若用 A 公告"我开了翻译市场"，A 与 B 立刻被关联，M2.1 的不可关联性保证就破功了。A 保持纯粹。 |
| **context-B**（市场） | ✓（业务身份） | 翻译市场全部业务（offer / 接单 / 交付 / 验收 / 仲裁） |
| **context-C**（隧道） | **✗ M10 暂不用** | 私聊身份暂无应用场景——讨价还价走 context-B 私域消息已加密，无需额外隧道。**但 App UI 必须显示 C 存在（"未启用"状态）让用户感知完整身份模型**。 |
| **context-D**（维基） | **✗ 留给维基 App** | D 需 vouch 阈值（M3.2）才有意义——不是每个翻译市场用户都能编辑维基。D 在翻译市场内无实际用途，应留给专门的"维基 App"（M11-1 计划）。 |

**为什么这是"突出验证理念"**：

- 之前 `contexts: [B]` 是"被动选择"（不知道还有别的可选项）
- 现在 `contexts: [B]` 是"**主动取舍**"——刻意不用 A/C/D，每个选择都有明确理由
- 真正体现 Havix 设计哲学的是**通过不用 A/C/D 来体现隔离**，不是通过用全部 4 个
- App 启动时显示完整 4-context 状态面板（含未使用的 A/C/D 的"未启用"标记），让用户**直观感知完整身份模型**，即使 App 没用到也"存在"

**反例（错误设计）**：

| ❌ 错误做法 | 为什么错 |
| --- | --- |
| 用 context-A 公告"我开了翻译市场" | A 与 B 立刻被关联，破坏 M2.1 不可关联性 |
| 用 context-D 编辑"翻译规范维基" | D 需 vouch 才能编辑，不是所有翻译市场用户都能用——混淆编辑员门槛 |
| 用 context-C 做"客户与译者私聊" | context-B 私域消息已加密，私聊走 C 是过度设计；C 应留给真正的 1v1 匿名通讯 App |
| 用全部 4 个 context | 每个都浅用，等于都没用——4-context 隔离沦为口号 |

**正确的"突出验证理念"做法**：

1. **App 主动声明 contexts 字段**：Manifest 显式列出使用哪些 context
2. **App 启动显示完整身份状态面板**：4-context 全部显示（含未启用的），让用户感知完整模型
3. **每个"不用"的选择都有明确理由**：写进 App README，作为设计决策记录
4. **不同 App 用不同 context 子集**：翻译市场 [B] / 维基 App [D] / 公告板 [A] / 私聊 App [C]——这才是 4-context 设计的真正价值



---

## 4. App 生命周期

### 4.1 节点启动流程（含 App 加载）

```
SNode.start()
  → WebPanel.start()
  → AppManager.start()              [M9 新增]
      → 扫描 apps/ 目录
      → 解析每个 manifest.yaml
      → 校验 Manifest 字段
      → 创建 App 沙箱（manifestId 隔离）
      → 调用 app.start(snode, manifest)
  → Cli.start()
```

### 4.2 App 启动接口

```javascript
// apps/<app-name>/index.js
export async function start(snode, manifest, sdk) {
  const app = await sdk.createApp(snode, manifest)
  
  // 注册 Web 路由
  app.web.mount('/apps/translation-market/', htmlHandler, apiHandler)
  
  // 注册 CLI 命令
  app.cli.register('translate-publish', publishHandler)
  
  // 订阅私域市场消息
  app.market.subscribe(handleMarketMessage)
  
  return app  // 返回 app 实例供 AppManager 管理
}

export async function stop(app) {
  await app.web.unmount()
  await app.market.unsubscribe()
}
```

### 4.3 节点停止流程

```
Cli.stop()
  → AppManager.stop()              [M9 新增]
      → 对每个 App 调用 stop(app)
      → 清理 Web 路由 + CLI 命令
  → WebPanel.stop()
  → SNode.stop()
```

---

## 5. SDK 接口规范

### 5.1 入口：createApp

```javascript
import { createApp } from 'havix-sdk'

const app = await createApp(snode, manifest, {
  // options（可选）
  dataDir: '.data/translation-market',
  log: customLogger,
})
```

**返回对象**：`app` 实例，包含以下子模块：

| 子模块 | 用途 | 见 |
| --- | --- | --- |
| `app.context` | 获取 4-context 子身份 | §5.2 |
| `app.market` | 私域市场 API | §5.3 |
| `app.credit` | Credit 流水 API | §5.4 |
| `app.wiki` | 维基条目 API | §5.5 |
| `app.tunnel` | 隧道 API | §5.6 |
| `app.arbitration` | 仲裁 API | §5.7 |
| `app.transport` | gossipsub / IPFS 抽象 | §5.8 |
| `app.web` | Web 路由注册 | §5.9 |
| `app.cli` | CLI 命令注册 | §5.10 |
| `app.ipfs` | IPFS 操作 | §5.11 |
| `app.state` | 应用状态持久化 | §5.12 |

### 5.2 app.context

获取本节点身份信息。**关键设计**：无论 App 实际使用哪些 context，都显示完整 4-context 状态面板（含未启用的），让用户感知完整身份模型。

```javascript
// 获取本节点的 4-context 子身份（无论 App 是否使用，都全部返回）
const { main, A, B, C, D } = await app.context.getAll()
// → {
//   main: 'did:havix:main:z...',     // 主 DID（身份锚定）
//   A: 'did:havix:A:z...',           // context-A 子 DID
//   B: 'did:havix:B:z...',           // context-B 子 DID
//   C: 'did:havix:C:z...',           // context-C 子 DID
//   D: 'did:havix:D:z...',           // context-D 子 DID
// }

// 获取本 App 启用的 context 列表（来自 Manifest.contexts）
const enabledContexts = app.context.getEnabled()
// → ['B']  （翻译市场只启用 B）

// 获取完整状态面板（用于 App 启动时显示）
const status = await app.context.getStatus()
// → {
//     main:     { did: 'did:havix:main:z...', status: 'active' },
//     contextA: { did: 'did:havix:A:z...',     status: 'loaded',  usedByApp: false, reason: 'A 是互联网通行身份，不与业务关联' },
//     contextB: { did: 'did:havix:B:z...',     status: 'active',  usedByApp: true,  reason: '业务身份' },
//     contextC: { did: 'did:havix:C:z...',     status: 'loaded',  usedByApp: false, reason: '私聊身份，本 App 暂无场景' },
//     contextD: { did: 'did:havix:D:z...',     status: 'loaded',  usedByApp: false, reason: '需 vouch 阈值，留给维基 App' },
//   }

// 用指定 context 签名（必须是 App 启用的 context，否则抛 PermissionDeniedError）
const sig = await app.context.sign('B', messageBytes)
// → { signature, signerPublicKey }

// 验证其他节点签的消息（任意 context 都可验签，不受 App 启用限制）
const valid = await app.context.verify(publicKey, signature, messageBytes)
// → boolean
```

**App 启动时身份状态面板（M9 SDK 标准输出）**：

```
应用：translation-market v1.0.0
身份状态（4-context 完整模型）：
  主 DID:    did:havix:main:z6Mk...    ✓ active  （身份锚定）
  context-A: did:havix:A:z6Mk...      ✓ loaded  （未启用：互联网通行身份不与业务关联）
  context-B: did:havix:B:z6Mk...      ✓ active  （业务身份，已用）
  context-C: did:havix:C:z6Mk...      ✓ loaded  （未启用：私聊身份，本 App 暂无场景）
  context-D: did:havix:D:z6Mk...      ✓ loaded  （未启用：需 vouch 阈值，留给维基 App）
```

**关键约束**：
- `getAll()` 与 `getStatus()` 永远返回完整 4-context（让用户感知完整模型）
- `sign()` 只允许 Manifest.contexts 列出的 context（防越权）
- `verify()` 不受限制（任意 context 签的消息都可验签，因为验签是被动行为）

### 5.3 app.market

复用 M7 邀请市场协议：

```javascript
// 创建新市场
const market = await app.market.create({
  name: 'translation-market',
  manifest: { minReputation: 30 },
})

// 邀请成员（生成 InviteToken）
const token = await app.market.invite(market.id, inviteeDid, {
  expiresAt: Date.now() + 24 * 3600 * 1000,
})

// 加入市场（持邀请令牌）
await app.market.join(market.id, token)

// 发布私域消息（自动 AES-GCM 加密）
await app.market.publish(market.id, {
  type: 'translation-offer',
  payload: { sourceLang: 'zh', targetLang: 'en', contentCid, reward: 10 },
})

// 订阅私域消息（自动解密）
app.market.subscribe(market.id, (message, fromPeerId) => {
  console.log('收到私域消息:', message)
})

// 离开市场
await app.market.leave(market.id)
```

### 5.4 app.credit

复用 M4 Credit 双轨经济：

```javascript
// 查询余额
const balance = await app.credit.balance(holderDid)

// 签发 credit（需 high reputation）
const note = await app.credit.issue(holderDid, 100, {
  note: 'initial grant',
})

// 消费 credit（用户付给服务方）
await app.credit.consume(providerDid, 10, {
  note: 'translation task #42',
})

// 转账
await app.credit.transfer(toDid, 50, {
  note: 'payment',
})

// 监听 credit 流水
app.credit.onReceived((credit, fromDid) => {
  console.log('收到 credit:', credit)
})
```

### 5.5 app.wiki

复用 M3 维基协议：

```javascript
// 发布条目（需 vouch 阈值）
const entry = await app.wiki.publish({
  title: 'Translation Best Practices',
  content: '...',
  parentCid: null,  // null = 根条目
})

// 列出条目
const entries = await app.wiki.list()

// 获取单条
const entry = await app.wiki.get(cid)

// 历史版本
const history = await app.wiki.history(title)
```

### 5.6 app.tunnel

复用 M5 隧道协议：

```javascript
// 打开隧道
const tunnel = await app.tunnel.open(targetDid, {
  parallelRelays: 3,
})

// 发送消息
await tunnel.send(messageBytes)

// 接收消息
tunnel.onMessage((data, fromDid) => {
  console.log('收到隧道消息:', data)
})

// 关闭
await tunnel.close()
```

### 5.7 app.arbitration

复用 M6 仲裁协议：

```javascript
// 发起仲裁
const dispute = await app.arbitration.file({
  type: 'offer-breach',  // offer-breach | relay-malice | vouch-collusion
  respondentDid: daveDid,
  evidence: {
    description: '漏译第 3 章',
    attachments: [{ cid: originalCid }, { cid: translationCid }],
  },
  stake: 10,  // 争议 credit 额
})

// 查询仲裁状态
const status = await app.arbitration.get(dispute.id)
// → { status: 'panel-summoning', panel: [...], votes: [...] }

// 监听裁决
app.arbitration.onVerdict((verdict) => {
  console.log('裁决:', verdict)
  // → { disputeId, decision: 'guilty', slashAmount, compensation }
})
```

### 5.8 app.transport

高级用法：直接操作 gossipsub / IPFS（受 permissions 限制）：

```javascript
// 发布 gossipsub 消息（自定义 topic）
await app.transport.publish('/my-app/custom-topic', messageBytes)

// 订阅
app.transport.subscribe('/my-app/custom-topic', (data, fromPeerId) => {})

// IPFS 操作
const cid = await app.transport.ipfs.add(contentBytes)
const content = await app.transport.ipfs.get(cid)
```

### 5.9 app.web

注册 Web 路由到 Havix Web 面板。**严格遵循 M8.2 GET-only 约束**——不破例，所有 mutation 走 CLI。

**设计原则**（M9 理论修正）：

> "协议即法律"——所有节点互动必须走 Havix 网络协议（gossipsub / 私域 topic / IPFS / 隧道），Web 面板只是观察窗口，不是控制面板。

```javascript
// 静态文件（HTML/JS/CSS）
app.web.mount('/apps/translation-market/', {
  type: 'static',
  dir: './webui/',
})

// GET API 端点（只读查询）
app.web.get('/api/apps/translation-market/offers', async (req) => {
  return { offers: await listOffers() }
})

app.web.get('/api/apps/translation-market/orders/:id', async (req) => {
  return await getOrder(req.params.id)
})

app.web.get('/api/apps/translation-market/identity-status', async (req) => {
  return await app.context.getStatus()  // 4-context 完整状态
})

// ❌ 不提供 POST/PUT/DELETE 接口
// 所有 mutation 操作走 CLI（app.cli.register）
// Web UI 上的 mutation 按钮显示 CLI 命令让用户复制到 REPL 执行
```

**Web UI mutation 按钮交互**：

当用户点击 Web UI 上的"发布需求"按钮时：

```
┌─────────────────────────────────────────────────┐
│  发布翻译需求                                 × │
├─────────────────────────────────────────────────┤
│                                                  │
│  此操作需在 CLI 执行，已为你生成命令：           │
│                                                  │
│  ┌───────────────────────────────────────────┐  │
│  │ translate-publish --from zh --to en \     │  │
│  │   --content "你的内容..." --reward 10     │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│              [📋 复制命令]   [关闭]              │
│                                                  │
│  复制后到 REPL 提示符粘贴执行（havix> _）       │
└─────────────────────────────────────────────────┘
```

**为什么这样设计**：

| 选项 | 优点 | 缺点 | 评价 |
| --- | --- | --- | --- |
| Web API 直接执行 mutation | 体验流畅 | 破坏 GET-only 约束 / 引入 CSRF 风险 / 节点互动绕过协议层 | ❌ 不选 |
| **Web 显示命令让用户复制** | 严格遵循协议 / 用户明确感知操作 / 与 M8.2 一致 | 多一步复制粘贴 | ✓ 选 |
| Web 表单生成命令 + 一键复制 | 介于两者之间 | 仍需用户去 REPL 执行 | 后续 M10 视体验可加 |

**SDK 接口约束**：

- `app.web.mount()` 只允许注册静态文件路由
- `app.web.get()` 只允许注册 GET 路由
- SDK 不提供 `app.web.post()` / `app.web.put()` / `app.web.delete()` 接口
- 强制开发者把 mutation 走 `app.cli.register()`

### 5.10 app.cli

注册 CLI 命令到 Havix REPL：

```javascript
app.cli.register('translate-publish', {
  description: '发布翻译需求',
  args: ['--from', '--to', '--content', '--reward'],
  handler: async (args) => {
    await publishOffer(args.from, args.to, args.content, args.reward)
  },
})
```

### 5.11 app.ipfs

IPFS 操作（受 `ipfs:read` / `ipfs:write` 权限限制）：

```javascript
// 写入
const cid = await app.ipfs.add(contentBytes)

// 读取
const content = await app.ipfs.get(cid)

// 加密写入（AES-GCM，密钥从 manifestId 派生）
const cid = await app.ipfs.addEncrypted(contentBytes, {
  deriveKey: 'manifestId',
})

// 加密读取
const content = await app.ipfs.getEncrypted(cid)
```

### 5.12 app.state

App 私有状态持久化（与节点 ledger 隔离）：

```javascript
// 写入
await app.state.set('orders', orderList)

// 读取
const orders = await app.state.get('orders', [])

// 删除
await app.state.delete('orders')
```

存储位置：`<dataDir>/ledgers/apps/<manifestId>/state.json`，权限 0o600。

---

## 6. App 容器机制

### 6.1 AppManager（M9 新增模块）

位置：`src/app/app-manager.js`

```javascript
export class AppManager {
  constructor(snode, sdk, options = {}) {
    this.snode = snode
    this.sdk = sdk
    this.apps = new Map()  // manifestId → appInstance
    this.appsDir = options.appsDir ?? path.join(process.cwd(), 'apps')
  }
  
  async start() {
    // 扫描 apps/ 目录
    const entries = await fs.readdir(this.appsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const manifestPath = path.join(this.appsDir, entry.name, 'manifest.yaml')
      if (!fs.existsSync(manifestPath)) continue
      
      // 解析 Manifest
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'))
      validateManifest(manifest)
      
      // 加载入口模块
      const entryPath = path.join(this.appsDir, entry.name, manifest.entryPoint)
      const { start } = await import(`file://${entryPath}`)
      
      // 启动 App
      const app = await start(this.snode, manifest, this.sdk)
      this.apps.set(manifest.name, app)
      
      this.snode.log('info', 'app', `加载 App: ${manifest.name} v${manifest.version}`)
    }
  }
  
  async stop() {
    for (const [name, app] of this.apps) {
      try {
        const { stop } = await import(`file://${path.join(this.appsDir, name, 'index.js')}`)
        await stop(app)
      } catch (err) {
        this.snode.log('warn', 'app', `App ${name} stop 失败: ${err.message}`)
      }
    }
    this.apps.clear()
  }
  
  getApp(name) {
    return this.apps.get(name)
  }
  
  listApps() {
    return Array.from(this.apps.values())
  }
}
```

### 6.2 SNode 集成

`src/s-node.js` 修改：

```javascript
// 在 constructor 中
this.appManager = null  // M9 新增

// 在 _startInternal 末尾（WebPanel 启动后，Cli 启动前）
if (this.config.apps !== false) {
  const { AppManager } = await import('./app/app-manager.js')
  const sdk = await import('../sdk/index.js')
  this.appManager = new AppManager(this, sdk)
  await this.appManager.start()
}

// 在 stop() 中（Cli 之后，WebPanel 之前）
if (this.appManager) {
  try { await this.appManager.stop() } catch (err) { /* log warn */ }
}
```

### 6.3 config.js 新增选项

```javascript
apps: true,          // 启动时加载 apps/ 目录
appsDir: 'apps',    // App 目录路径
```

环境变量：`HAVIX_APPS=true/false` / `HAVIX_APPS_DIR=apps`

---

## 7. SDK 包结构

```
sdk/
├── package.json                # 独立 package 描述（但保留在主仓库）
├── index.js                    # 入口：createApp
├── manifest.js                 # AppManifest 类 + 解析 + 校验
├── permissions.js              # 权限白名单 + 校验
├── context.js                  # 4-context 子身份 API
├── market.js                   # 私域市场 API（包装 SNode.createMarket 等）
├── credit.js                   # Credit 流水 API（包装 SNode.issueCredit 等）
├── wiki.js                     # 维基 API（包装 SNode.publishEntry 等）
├── tunnel.js                   # 隧道 API（包装 SNode.establishTunnel 等）
├── arbitration.js              # 仲裁 API（包装 SNode.fileDispute 等）
├── transport.js                # gossipsub / IPFS 抽象
├── web.js                      # Web 路由注册
├── cli.js                      # CLI 命令注册
├── state.js                    # App 私有状态持久化
├── errors.js                   # SDK 错误类型
└── __mocks__/
    └── snode-mock.js           # 单元测试用的 mock SNode
```

### 7.1 入口示例

`sdk/index.js`：

```javascript
import { AppManifest, validateManifest } from './manifest.js'
import { checkPermission } from './permissions.js'
import { createContextApi } from './context.js'
import { createMarketApi } from './market.js'
// ... 其他

export async function createApp(snode, manifest, options = {}) {
  // 1. 校验 Manifest
  validateManifest(manifest)
  
  // 2. 创建 App 实例
  const app = {
    manifest,
    snode,
    options,
  }
  
  // 3. 装配各子模块（受 permissions 限制）
  app.context = createContextApi(snode, manifest)
  app.market = createMarketApi(snode, manifest)
  app.credit = createCreditApi(snode, manifest)
  app.wiki = createWikiApi(snode, manifest)
  app.tunnel = createTunnelApi(snode, manifest)
  app.arbitration = createArbitrationApi(snode, manifest)
  app.transport = createTransportApi(snode, manifest)
  app.web = createWebApi(snode, manifest)
  app.cli = createCliApi(snode, manifest)
  app.ipfs = createIpfsApi(snode, manifest)
  app.state = createStateApi(snode, manifest, options.dataDir)
  
  return app
}

export { AppManifest, validateManifest }
export * from './errors.js'
```

---

## 8. 参考模板：apps/empty-app/

最小可运行 App 模板，让开发者照着改：

```
apps/empty-app/
├── manifest.yaml          # 最小 Manifest
├── index.js               # start/stop 函数
└── README.md              # 怎么改造成自己的 App
```

`apps/empty-app/manifest.yaml`：

```yaml
name: empty-app
version: 1.0.0
capability: custom
permissions:
  - identity:context
  - ipfs:read
minReputation: 0
trustWeight: 0.5
dataDir: empty-app
contexts: []  # 空数组：模板不预设使用哪些 context，由具体 App 自选
description: 最小可运行 App 模板
entryPoint: ./index.js
```

`apps/empty-app/index.js`：

```javascript
export async function start(snode, manifest, sdk) {
  const app = await sdk.createApp(snode, manifest)
  
  snode.log('info', 'empty-app', 'Hello from empty-app')
  
  // 注册一个 hello 命令
  app.cli.register('hello', {
    description: '打个招呼',
    handler: () => 'Hello from empty-app!',
  })
  
  return app
}

export async function stop(app) {
  app.snode.log('info', 'empty-app', 'Goodbye')
}
```

---

## 9. Web 面板扩展

### 9.1 路由设计

Havix Web 面板新增 `/apps/<app-name>/` 路由前缀。**严格遵循 M8.2 GET-only 约束**——所有 App API 都是 GET，无 mutation 接口：

```
GET /apps/translation-market/                    # App 首页（HTML）
GET /apps/translation-market/index.html          # 显式 HTML
GET /apps/translation-market/static/*           # 静态资源（JS/CSS/图片）
GET /api/apps/translation-market/offers         # 查询 offer 列表
GET /api/apps/translation-market/orders/:id     # 查询订单详情
GET /api/apps/translation-market/identity-status # 查询 4-context 身份状态
GET /api/apps/translation-market/arbitrations    # 查询仲裁列表

# ❌ 不允许 POST / PUT / DELETE
# mutation 操作（发布 offer / 接单 / 验收 / 仲裁）走 CLI
```

### 9.2 GET-only 约束（M9 理论修正）

**原 M9 草案提议**：App API 可破例允许 POST/PUT/DELETE，配 CSRF token 防护。

**M9 修正决策**：**不允许破例**。

理由：
1. **协议即法律**——所有节点互动必须走 Havix 网络协议（gossipsub / 私域 topic / IPFS / 隧道）。Web 面板是观察窗口，不是控制面板。
2. **M8.2 GET-only 约束不可破坏**——一旦破例，未来 App 都会跟风加 mutation API，约束沦为口号。
3. **CLI 是唯一 mutation 入口**——M8.2 已建立此约束，M9 延续。
4. **避免 CSRF / DNS rebinding 扩大攻击面**——破例需要额外的 token 机制，复杂度上升。
5. **用户明确感知操作**——复制命令到 REPL 让用户对每笔操作有"我在签名一笔交易"的明确感知，而不是点个按钮就完成。

**App Web UI 的 mutation 交互**：

Web UI 上的所有 mutation 按钮（如"发布需求"、"接单"、"验收"、"发起仲裁"）：
- 点击后弹窗显示对应 CLI 命令
- 提供"复制命令"按钮
- 用户复制到 Havix REPL（`havix> `）粘贴执行
- 命令通过 SDK 调用协议层接口完成节点互动

详见 §5.9 的 Web UI mutation 按钮交互示例。

### 9.3 WebPanel 修改

`src/app/web-panel.js` 新增 App 路由分发：

```javascript
_handle(req, res) {
  // ... 现有 Host 头校验 ...
  
  const path = url.pathname
  
  // App 路由分发（M9 新增）
  if (path.startsWith('/apps/')) {
    return this._handleAppRoute(req, res, path)
  }
  if (path.startsWith('/api/apps/')) {
    return this._handleAppApi(req, res, path)
  }
  
  // ... 现有路由 ...
}

_handleAppRoute(req, res, path) {
  const [, , appName, ...rest] = path.split('/')
  const app = this.node.appManager.getApp(appName)
  if (!app) return this._sendJson(res, 404, { error: `App ${appName} not loaded` })
  
  // M9 理论修正：App 路由严格 GET-only
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return this._sendJson(res, 405, {
      error: `App Web API 仅支持 GET（M9 理论修正：协议即法律，mutation 走 CLI）`,
      hint: 'mutation 操作请到 REPL 执行对应 CLI 命令',
    })
  }
  
  return app.web.handle(req, res, '/' + rest.join('/'))
}
```

---

## 10. 测试策略

### 10.1 SDK 单元测试

位置：`sdk/__tests__/*.test.js`

策略：用 `snode-mock.js` 注入 fake SNode，验证 SDK 接口与权限校验，不依赖真实 libp2p。

```javascript
import { createApp } from '../index.js'
import { createSnodeMock } from '../__mocks__/snode-mock.js'

test('SDK 权限校验：缺 market:publish 权限调用 publish 抛错', async () => {
  const snode = createSnodeMock()
  const manifest = {
    name: 'test',
    permissions: ['market:subscribe'],  // 缺 publish
    // ...
  }
  const app = await createApp(snode, manifest)
  await assert.rejects(
    () => app.market.publish('market-1', { type: 'test' }),
    /PermissionDeniedError.*market:publish/,
  )
})
```

**测试覆盖目标**：
- 7 大接口各 10+ 测试 = 70+ SDK 接口测试
- 权限校验：每个权限 1 个拒绝测试 = 25+ 测试
- Manifest 校验：字段缺失 / 类型错误 / 未知权限 = 15+ 测试

### 10.2 SDK 集成测试

位置：`test/sdk-integration.test.js`

策略：启动真实 SNode（2 节点 star 拓扑），SDK 创建 App，验证端到端：

```javascript
test('SDK 集成：App A 创建市场 → App B 加入 → 双方收到消息', async () => {
  const nodeA = await startSNode({ port: 9901 })
  const nodeB = await startSNode({ port: 9902, bootstrap: [nodeA.multiaddr] })
  
  const sdk = await import('../sdk/index.js')
  const appA = await sdk.createApp(nodeA, manifestA)
  const appB = await sdk.createApp(nodeB, manifestB)
  
  const market = await appA.market.create({ name: 'test-market' })
  const token = await appA.market.invite(market.id, nodeB.context.B)
  await appB.market.join(market.id, token)
  
  const received = new Promise(resolve => {
    appB.market.subscribe(market.id, resolve)
  })
  
  await appA.market.publish(market.id, { type: 'test', payload: 'hello' })
  
  const msg = await received
  assert.equal(msg.payload, 'hello')
})
```

### 10.3 参考模板测试

`test/empty-app.test.js`：启动一个节点加载 empty-app，验证 hello 命令工作。

### 10.4 预期测试用例数

| 类别 | 用例数 |
| --- | --- |
| Manifest 解析 + 校验 | ~15 |
| 权限校验（拒绝路径） | ~25 |
| SDK 接口单元（7 模块） | ~70 |
| SDK 集成（2 节点 e2e） | ~10 |
| empty-app 加载测试 | ~5 |
| Web App 路由分发 | ~10 |
| **合计** | **~135** |

加上现有 596 = **目标 731/731 通过**。

---

## 11. 实施计划

### 11.1 子阶段拆分

| 子阶段 | 内容 | 估时 | 测试增量 | 实际 |
| --- | --- | --- | --- | --- |
| **M9.1** | AppManifest + 解析 + 校验 + 权限白名单 | 中 | ~40 测试 | ✅ 111 测试 |
| **M9.2** | SDK 入口 + 7 大接口骨架 + mock SNode | 中 | ~70 测试 | ✅ 253 测试 |
| **M9.3** | AppManager + SNode 集成 + config 选项 | 中 | ~15 测试 | ✅ 52 测试 |
| **M9.4** | Web 面板路由扩展 + App API | 中 | ~10 测试 | ✅ 24 测试 |
| **M9.5** | empty-app 参考模板 + 集成测试 | 中 | ~15 测试 | ✅ 28 测试 |
| **M9.6** | 安全加固第一步（深度审计后立即修复 6 项 + 27 P0 测试） | 中 | ~25 测试 | ✅ 27 测试 |

每个子阶段完成后跑全量回归，确认无 regression。

### 11.2 顺序依赖

```
M9.1 Manifest（无依赖）
   ↓
M9.2 SDK 接口（依赖 M9.1）
   ↓
M9.3 AppManager（依赖 M9.2）
   ↓
M9.4 Web 路由（依赖 M9.3）
   ↓
M9.5 empty-app（依赖 M9.4）
   ↓
M9 完成 → 进入 M10 翻译市场
```

### 11.3 验收标准

- ✅ `sdk/` 包完整，7 大接口全部实现
- ✅ AppManifest 规范 v1.0 定稿
- ✅ AppManager 能加载 `apps/` 下的所有 App
- ✅ Web 面板支持 `/apps/<name>/` 路由
- ✅ `apps/empty-app/` 可加载并响应 `hello` 命令
- ✅ 测试目标 731/731 通过
- ✅ README 加入 M9 章节
- ✅ 文档完整（M9-DESIGN.md 已实施部分标注 ✅）

---

## 12. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| SDK 接口设计不当导致 M10 翻译市场反复重写 | 中 | 高 | M9.5 用 empty-app 验证接口稳定性，再进 M10 |
| AppManifest 规范过早固化，M10 翻译市场需求字段不够 | 中 | 中 | Manifest 字段尽量可选，缺省值兜底 |
| App API 破坏 Web 面板 GET-only 约束带来安全风险 | 中 | 高 | 强制 127.0.0.1 + Host 头校验 + CSRF token |
| App 与节点同进程，恶意 App 可能崩溃节点 | 低 | 高 | M9 不开放第三方 App，M12 改 Worker Thread |
| SDK mock 与真实 SNode 行为不一致，集成测试才暴露 | 中 | 中 | mock 优先实现，集成测试必须接真实 SNode |

---

## 13. Deferred 项

明确的 M9 范围外项目：

- App 沙箱（Worker Thread）→ M12
- 第三方 App 加载器 + 准入流程 → M12
- AppManifest 自动审核 → M12
- App 间事件总线 → M12
- App 动态安装/卸载 → M12
- trustWeight 自然涌现算法 → M11
- App Web UI 框架抽象（如 vis-network 风格的 SDK UI 组件）→ M10+ 视需求
- App 版本升级与迁移 → M12+
- App 数据导入/导出 → M12+
- App 卸载后数据清理 → M12
- 跨 App 信誉流动（FW-04）→ M12+
- App Manifest 数字签名（防伪造）→ M12（M9 阶段所有 App 都是内置，无伪造风险）

---

## 14. 与白皮书对齐

| 白皮书位置 | M9 实现 |
| --- | --- |
| §8.1 三要素（Havix Protocol Spec / App Manifest / Reputation Portability） | M9 完成第 2 项 App Manifest；第 1 项已完成（M1-M8）；第 3 项 deferred 到 M11 |
| §8.2 App Manifest 规范（草案） | M9 定稿 v1.0，补 7 个新字段 |
| §8.3 加权转换公式 | 算法 v0 在 M11 实现 |
| §8.4 FW-01 App 信任权重审核 | M11 v0 + M12 强化 |
| §8.5 阶段二 3 个内置 App | M10 翻译市场 + M11 维基/教学 |
| §11.3 集成场景 | M10 翻译市场覆盖场景 1 |

---

## 15. App 代码仓库策略

### 15.1 分阶段策略

| 阶段 | App 来源 | 仓库位置 | 理由 |
| --- | --- | --- | --- |
| **M9–M11** | 内置 App（翻译市场 / 教学市场 / 维基 App） | **主仓库 `apps/` 子目录** | 内置 App 与协议层协同开发，绑定版本发布 |
| **M12+** | 第三方 App | **独立仓库** | 第三方独立演进，通过 App Manifest 的 `repository` 字段声明源码位置 |

### 15.2 主仓库 `apps/` 子目录的好处

- **协议层（src/）和应用层（apps/）一起测试**，避免版本漂移
- **SDK（sdk/）和 App 同步迭代**，破坏性变更能立即发现
- **单一 CHANGELOG**，发布节奏一致
- **App 加载器扫 `apps/` 目录即用**，无需下载
- **测试覆盖完整**：协议层测试 + SDK 测试 + App 测试在同一 CI 流水线

### 15.3 M12 第三方 App 独立仓库的必要性

- 第三方独立迭代节奏
- App 数字签名验证（防伪造）
- App 注册中心需 `repository` 字段供审计追溯
- App 作者用 context-A 子身份签名 Manifest，节点验签后才允许加载

### 15.4 仓库目录结构（M9 后）

```
havix/                          # 主仓库
├── src/                        # 协议层（M1-M8 已实现）
├── sdk/                        # Havix SDK（M9 新增）
├── apps/                       # App 代码（M9 新增）
│   ├── empty-app/              # 参考模板（M9.5）
│   └── translation-market/     # 第一个真实 App（M10）
├── test/                       # 测试（含 SDK + App 集成测试）
├── docs/                       # 文档（DEPLOY.md / ROADMAP.md / M9-DESIGN.md / ...）
├── README.md
├── package.json                # 主仓库依赖（含 sdk/ 子目录的本地引用）
└── .gitignore
```

---

## 16. 下一步

1. ✅ **M9.1 AppManifest + 解析 + 校验**已完成（111 测试）
2. ✅ **M9.2 SDK 入口 + 7 大接口骨架 + mock SNode**已完成（253 SDK 测试 / 849 全量回归通过）
3. ✅ **M9.3 AppManager + SNode 集成 + config 选项**已完成（52 集成测试 / 901 全量回归通过）
   - `src/app/app-manager.js`：扫描 `apps/<dir>/manifest.yaml` → `AppManifest.fromYaml` → `await import(entryPoint)` → `createApp` 装配 → 调用 `entryModule.start(snode, manifest, app, sdk)` hook；单 App 加载失败不阻断其他 App（log warn 跳过）；stop() 按启动反序停止所有 App，幂等
   - `sdk/state.js` 接入 `src/persistence.js`：`flush()` 调 `saveJsonAtomic` 原子写，`load()` 调 `loadJson` 读盘，`autoFlush=true`（默认）让 set/delete/clear 自动写盘；`persist=null` 退化为内存版（M9.2 兼容）
   - `sdk/credit.js` 新增 `_onReceived(creditMsg)` 内部派发方法供 AppManager 调用
   - `sdk/app.js` 新增 `options.persist` 透传 + `options.autoLoad` 控制 state.load
   - `sdk/manifest.js` 升级 `parseYamlScalar` 支持内联数组 `[a, b, c]` / `["a", "b"]`
   - `src/config.js` 新增 `--apps` / `--no-apps` / `--apps-dir <path>` + 环境变量 `HAVIX_APPS` / `HAVIX_APPS_DIR`
   - `src/s-node.js` startApp 流程插入 AppManager（在 WebPanel 与 Cli 之间启动），shutdown 顺序变为 `Cli → AppManager → WebPanel → SNode`；`_handleCreditMessage` 在镜像成功后调用 `appManager.dispatchCreditMessage(...)` 按 `targetApp` 派发到对应 App
4. ✅ **M9.4 Web 面板路由扩展 + App API**已完成（24 集成测试 / 925 全量回归通过）
   - `src/app/web-panel.js` `_handle`：早期分流 `/apps/` 与 `/api/apps/` 前缀到 `_handleAppRoute(req, res, path, isApi)`
   - `_handleAppRoute`：`/apps` HTML 索引页 / `/api/apps` JSON 列表 / `/apps/<appName>/...` 与 `/api/apps/<appName>/...` 委托给 `appManager.handleAppWebRequest(appName, subPath, req)`
   - `_renderAppsIndex(apps)`：HTML 索引页（暗色主题 + 8 列表格 + 跳转链接）
   - `_apiStatus` 新增 `apps: { enabled, count, names }` 字段
   - HTML 拓扑首页 header 新增 `Apps` 链接；侧边栏新增 `Apps（M9.4）` 区块
   - 严格 GET-only：POST/PUT/DELETE 返回 405，hint 提示"协议即法律，mutation 走 CLI"
   - AppManager 未启用时 `/apps/` 与 `/api/apps/...` 返回 503 + 提示 `--apps` 开启
5. ✅ **M9.5 empty-app 参考模板 + 集成测试**已完成（28 集成测试 / 953 全量回归通过）
   - `apps/empty-app/manifest.yaml`：最小 Manifest（capability=custom / permissions=[identity:context, ipfs:read, credit:balance]）
   - `apps/empty-app/index.js`：start/stop hook 演示 SDK 4 大接口
     - CLI：注册 `empty-app-hello --name <name>`，返回 `Hello, <name>! (from empty-app)` + 写入 state.lastGreeting
     - Web：注册 `GET /api/apps/empty-app/hello`，返回 ok+app+version+greeting+lastGreeting+initializedAt
     - State：start 时写 initializedAt + manifestName，autoFlush=true 自动写盘
     - Credit：注册 onReceived handler，dispatchCreditMessage 时写 state.lastCreditReceived
     - stop hook：调用 app.state.flush() 显式写盘
   - `apps/empty-app/README.md`：App 开发文档（manifest 字段表 + start hook 签名 + 改造步骤 + 验证命令 + 约束）
   - `test/empty-app.test.js`：28 个测试覆盖 App 加载 / CLI 命令 / Web 路由 / State 持久化往返 / Credit 派发 / stop hook / WebPanel 端到端 / manifest 校验
6. ✅ **M9.6 安全加固第一步**已完成（27 P0 安全测试 / 980 全量回归通过）
   - 深度审计：3 个并行 subagent 审计 SDK 层 16 文件 + 协议层 16 文件 + 测试层 27+15 文件，生成 `AUDIT-M9.md`（1 P0 + 19 P1 + 21 P2 + 88 测试缺口）
   - 立即修复 6 项：
     - **P0-1** `sdk/state.js` `opts.dataDir` 路径穿越 → 复用 `validateDataDir` 校验
     - **P1-1** `src/app/app-manager.js` entryPoint 路径穿越 → `path.relative` + `relEntry.startsWith('..')` 校验
     - **P1-5** `sdk/web.js` `mount()` `opts.dir` 路径穿越 → 复用 `validateDataDir` 校验
     - **P1-7** `sdk/app.js` `app.stop()` 跨 App 影响 → transport / market / credit 三个子模块各自维护 `ownSubscriptions` 闭包 + `_dispose()` 只清理自己注册的项
     - **P1-8** `src/s-node.js` `issueInvite` fail-closed → manifest 缺失或 reputationLedger 未注入时直接抛错
     - **P1-10** `src/s-node.js` `_handleArbitrationMessage` verdict fail-closed → 本地未镜像 panel 时拒绝裁决
   - `sdk/manifest.js` 导出 `validateDataDir` 供 state.js / web.js 复用，避免逻辑漂移
   - `test/security-m96.test.js`：27 个 P0 安全测试覆盖 6 个修复点 + validateDataDir 单元测试
7. **M9 阶段二（App SDK + 安全加固第一步）完成** → 下一步可选：
   - **M9.7** 安全加固第二步（11 项近期修复 + 23 P1 测试补充）：context 权限空转 / `_onReceived` 泄露 / market senderId 内层签名 / 主账本 Map LRU / App 沙箱收敛 / manifest 路径校验跨平台
   - **M10 翻译市场**（用户已暂缓，要在独立库开发做隔离）

---

**Last Updated**: M9.6 安全加固第一步已完成 · 全量回归 980/980 通过 · 深度审计报告已生成（AUDIT-M9.md）· 下一步可选 M9.7 安全加固第二步 / M10 翻译市场（已暂缓，独立库开发）
