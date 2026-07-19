# Havix SDK 使用说明（M9 + M10）

> **面向读者**：第 1 章运维管理员（怎么装/管 App）+ 第 2 章开发者（如何用 SDK 写 App）
> **关联文档**：[AUDIT-M9.md](../AUDIT-M9.md) · [AUDIT-M10.md](../AUDIT-M10.md) · [DEPLOY.md](../DEPLOY.md) · [Embas/M10-DESIGN.md](../Embas/M10-DESIGN.md)

Havix SDK 是 App 与协议层之间的契约层。App 通过 SDK 暴露的 7 大子模块（context / credit / market / ipfs / arbitration / wiki / tunnel）+ 3 个注册器（cli / web / state）消费协议能力，不能直接修改协议账本。

## 目录

- [第 1 章 · 运维管理员](#第-1-章--运维管理员)
  - [1.1 AppManager 工作原理](#11-appmanager-工作原理)
  - [1.2 apps/ 目录结构](#12-apps-目录结构)
  - [1.3 manifest.yaml 字段速查](#13-manifestyaml-字段速查)
  - [1.4 启用 / 禁用 App](#14-启用--禁用-app)
  - [1.5 App 持久化目录](#15-app-持久化目录)
  - [1.6 App 失败排查](#16-app-失败排查)
- [第 2 章 · App 开发者](#第-2-章--app-开发者)
  - [2.1 最小 App 范例](#21-最小-app-范例)
  - [2.2 start(snode, manifest, app, sdk) hook](#22-startsnodemanifestappsdk-hook)
  - [2.3 7 大子模块 API 速查](#23-7-大子模块-api-速查)
  - [2.4 cli 命令注册](#24-cli-命令注册)
  - [2.5 web 路由注册](#25-web-路由注册)
  - [2.6 state 持久化](#26-state-持久化)
  - [2.7 测试 mock 模式](#27-测试-mock-模式)
  - [2.8 credit escrow 模式](#28-credit-escrow-模式)
  - [2.9 market 广播模式](#29-market-广播模式)
- [第 3 章 · 已知问题](#第-3-章--已知问题)

---

# 第 1 章 · 运维管理员

## 1.1 AppManager 工作原理

AppManager 是 SNode 启动时扫描 `apps/` 目录加载所有 App 的容器管理器：

```
SNode 启动
  └─ AppManager.start()
       ├─ 扫描 apps/ 下每个子目录
       ├─ 读 manifest.yaml → AppManifest.fromYaml()
       ├─ 校验目录名 === manifest.name（防 apps/foo 放 apps/bar 的 manifest）
       ├─ 校验 entryPoint 路径不穿越 appDir
       ├─ import(entryPoint) 加载 ES module
       ├─ sdk.createApp(snode, manifest) 装配 7 大子模块
       ├─ 调 entry.start(snode, manifest, app, sdk) hook
       └─ 注入 App.cli 命令到 Cli 实例（前缀 `<appName>-<cmd>`）
```

**关键约束**：
- 单 App 加载失败不阻断其他 App（log warn 跳过）
- `manifest.name` 必须等于目录名
- `entryPoint` 不能含 `..` 路径穿越
- AppManager 持有 app 实例 Map，stop() 时按启动反序停止所有 App

## 1.2 apps/ 目录结构

```
havix-node/
├── apps/
│   ├── translation-market/      # Embas 翻译市场
│   │   ├── manifest.yaml        # 必需
│   │   ├── index.js             # 必需（entryPoint）
│   │   ├── src/
│   │   └── package.json         # 可选（仅依赖 Havix SDK，不依赖协议层）
│   └── wiki-app/                # 假设的第二个 App
│       ├── manifest.yaml
│       └── index.js
├── src/                         # Havix 协议层
├── sdk/                         # Havix SDK
└── node_modules/
```

**软链方式部署**（推荐）：
```bash
cd /path/to/havix
ln -s /path/to/Embas apps/translation-market
node src/s-node.js --apps
```

## 1.3 manifest.yaml 字段速查

| 字段 | 必需 | 类型 | 说明 |
| --- | --- | --- | --- |
| `name` | ✓ | string | App 全局唯一标识（kebab-case，1-64 字符） |
| `version` | ✓ | semver | 版本号（MAJOR.MINOR.PATCH） |
| `capability` | ✓ | enum | `market` / `wiki` / `tunnel` / `public` / `custom` |
| `permissions` | ✓ | string[] | 权限白名单（见下方权限表） |
| `entryPoint` | ✓ | path | 入口 ES module 相对路径（如 `./index.js`） |
| `inviteTokenFormat` | | enum | `ed25519-signature`（默认）/ `none` |
| `spaCid` | | cid | 前端 SPA 的 IPFS CID（M9 占位） |
| `minReputation` | | number | 参与门槛（默认 0） |
| `trustWeight` | | float | 加权转换权重 0.0-1.0（默认 0.5） |
| `dataDir` | | string | 独立数据目录名（默认等于 name） |
| `contexts` | | string[] | 使用的 context 子身份（`['A','B','C','D']` 子集，默认 `[]`） |
| `description` | | string | 人类可读描述 |

### 权限白名单（按类别）

| 类别 | 权限 |
| --- | --- |
| **market** | `market:create` / `market:invite` / `market:join` / `market:publish` / `market:subscribe` |
| **credit** | `credit:issue` / `credit:consume` / `credit:balance` / `credit:transfer` |
| **arbitration** | `arbitration:file` / `arbitration:vote` / `arbitration:resolve` |
| **identity** | `identity:context:A` / `identity:context:B` / `identity:context:C` / `identity:context:D` |
| **ipfs** | `ipfs:read` / `ipfs:write` |
| **wiki** | `wiki:read` / `wiki:write` |
| **transport** | `transport:subscribe` / `transport:broadcast` |
| **tunnel** | `tunnel:create` / `tunnel:join` |

## 1.4 启用 / 禁用 App

**启用**：把 App 目录（或软链）放到 `apps/`，重启节点即可。

**禁用**（两种方式）：

1. **临时禁用**：把目录改名加下划线前缀（`apps/_translation-market/`），AppManager 跳过 `_` / `.` 开头的目录
2. **永久禁用**：从 `apps/` 删除目录或软链

```bash
# 临时禁用
mv apps/translation-market apps/_translation-market
# 重启节点

# 恢复
mv apps/_translation-market apps/translation-market
```

> **注意**：禁用后 App 的 dataDir 状态保留，重新启用可恢复订单/案件等数据。

## 1.5 App 持久化目录

每个 App 的持久化数据写入 `<data-dir>/<manifest.dataDir>/`：

```
<data-dir>/
└── translation-market/
    ├── state.json          # app.state 的 key-value 持久化
    ├── orders.json         # Embas 自定义的订单 store
    └── arbitrationCases.json  # 案件索引
```

**注意**：
- `dataDir` 默认等于 `manifest.name`
- 节点重启时，AppManager.start() → app.start() hook 自动调 `state.load()` 恢复
- App 内自定义的持久化文件（如 `orders.json`）由 App 自己读写，AppManager 不托管

## 1.6 App 失败排查

### App 加载失败

日志形如：`加载 App "foo" 失败: <原因>`

| 原因 | 排查 |
| --- | --- |
| 缺 manifest.yaml | 检查 `apps/foo/manifest.yaml` 是否存在 |
| 目录名与 manifest.name 不一致 | 检查 `name` 字段是否等于目录名 |
| entryPoint 路径穿越 | `entryPoint` 不能含 `..`，必须相对 `apps/foo/` |
| entryPoint 不存在 | 检查 `entryPoint: ./index.js` 对应文件 |
| 入口模块加载失败 | 看 cause（通常是语法错误或 import 失败） |
| start() hook 失败 | 不阻断 App 加载，但功能受限——看日志的 cause |

### App 运行时失败

| 症状 | 排查 |
| --- | --- |
| CLI 命令找不到 | 确认命令名前缀 `<appName>-`，如 `translation-market-publish` 而非 `publish` |
| Web 路由 404 | 访问 `/apps/<appName>/...`，前缀必须含 App 名 |
| 状态没持久化 | 检查 `dataDir/<appName>/state.json` 是否写入；权限是否够 |
| credit 转账失败 | 余额不足 / did 错误 / 网络分区，看 snode 日志 |

### 跨节点消息丢失

App 通过 market.publish 广播的消息其他节点没收到：

1. 检查 marketId 是否一致（订阅时和发布时要匹配）
2. 检查 libp2p pubsub 是否连通（`havix-peer-info` 命令）
3. 检查 message.app 标签是否过滤了你的消息（onMessage 只接受 `app === <appName>` 的消息）

---

# 第 2 章 · App 开发者

## 2.1 最小 App 范例

**apps/hello-world/manifest.yaml**：

```yaml
name: hello-world
version: 1.0.0
capability: market
permissions:
  - market:publish
  - market:subscribe
  - identity:context:B
entryPoint: ./index.js
contexts: [B]
description: 最小范例 App
```

**apps/hello-world/index.js**：

```js
/**
 * 最小 Havix App 范例
 * 注册一个 CLI 命令和一个 Web 路由
 */

export async function start(snode, manifest, app, sdk) {
  // 1. 注册 CLI 命令（前缀 hello-world- 会自动加）
  app.cli.register('greet', {
    description: '打招呼',
    args: [{ name: 'name', type: 'string', required: false }],
    handler: async ({ named }) => {
      const name = named?.name ?? 'World'
      const myDid = app.context.get('B').did
      return { ok: true, message: `Hello ${name} from ${myDid}` }
    },
  })

  // 2. 注册 Web 路由（GET-only）
  app.web.get('/apps/hello-world/', async (req) => {
    return {
      status: 200,
      body: `<html><body><h1>Hello World</h1><p>my DID: ${app.context.get('B').did}</p></body></html>`,
      headers: { 'Content-Type': 'text/html' },
    }
  })

  // 3. 订阅 market 消息
  await app.market.subscribe('default', (msg, fromPeerId) => {
    app.log('info', 'hello-world', `收到 market 消息 type=${msg.type} from ${fromPeerId}`)
  })

  app.log('info', 'hello-world', `App 启动完成 v${manifest.version}`)
}

export async function stop(app) {
  app.log('info', 'hello-world', 'App 停止')
}
```

## 2.2 start(snode, manifest, app, sdk) hook

App 入口模块可导出 `start` 和 `stop` 两个异步函数：

```js
export async function start(snode, manifest, app, sdk) {
  // snode: Havix SNode 实例（只读访问，不要修改）
  // manifest: 本 App 的 AppManifest 实例
  // app: SDK createApp 返回的 app 实例（含 7 大子模块 + cli/web/state）
  // sdk: SDK 模块（含 createApp / AppManifest / errors 等导出，用于错误处理）
}

export async function stop(app) {
  // 清理 setInterval / 订阅 / 文件句柄
  // 幂等：多次调用不抛错
}
```

**关键约束**：
- `start` 失败**不阻断** App 加载，但功能受限（log warn）
- `stop` 失败不阻断其他 App 停止
- `stop` 必须幂等（多次调用不抛错）

## 2.3 7 大子模块 API 速查

| 子模块 | 访问方式 | 主要方法 | 对应权限 |
| --- | --- | --- | --- |
| **context** | `app.context` | `get(ctx)` / `getAll()` | `identity:context:<X>` |
| **credit** | `app.credit` | `balance(did)` / `transfer(from,to,amt)` / `issue(did,amt)` / `consume(did,amt)` / `onReceived(handler)` | `credit:balance` / `credit:transfer` / `credit:issue` / `credit:consume` |
| **market** | `app.market` | `create(id,opts)` / `invite(id,did)` / `join(id,token)` / `publish(id,payload)` / `subscribe(id,cb)` / `list()` / `isMember(id)` | `market:create` / `market:invite` / `market:join` / `market:publish` / `market:subscribe` |
| **ipfs** | `app.ipfs` | `add(bytes)` / `get(cid)` / `computeCid(bytes)` | `ipfs:read` / `ipfs:write` |
| **arbitration** | `app.arbitration` | `file(opts)` / `summonPanel(id)` / `vote(id,vote)` / `resolve(id)` / `checkJurorEligibility(did)` | `arbitration:file` / `arbitration:vote` / `arbitration:resolve` |
| **wiki** | `app.wiki` | `getPage(title)` / `putPage(title,content)` / `getLineage(title)` | `wiki:read` / `wiki:write` |
| **tunnel** | `app.tunnel` | `create(opts)` / `join(id)` / `sendChunk(id,data)` | `tunnel:create` / `tunnel:join` |

**调用限制**：每个方法都会先 `checkPermission(perms, '<perm>')`，权限不在 manifest 声明 → 抛 `PermissionDeniedError`。

## 2.4 cli 命令注册

```js
app.cli.register('publish', {
  description: '发布翻译需求',
  category: 'translate',  // 可选，默认 app:<appName>
  args: [
    { name: 'from', type: 'string', required: true },
    { name: 'to', type: 'string', required: true },
    { name: 'reward', type: 'number', required: true },
    { name: 'content-file', type: 'string', required: true },
    { name: 'deadline', type: 'number', required: false, default: 24 },
  ],
  handler: async ({ named, positional, flags }) => {
    // named: { from: 'en', to: 'es', reward: 10, ... }
    // positional: ['arg1', 'arg2']
    // flags: Set of --flag names
    
    const from = named.from
    const reward = Number(named.reward)
    if (!Number.isFinite(reward) || reward <= 0) {
      return { ok: false, error: 'reward 必须 > 0' }
    }
    
    // 业务逻辑
    try {
      // ...
      return { ok: true, orderId: '...' }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  },
})
```

**约束**：
- 命令名注册时无需加前缀（AppManager 注入到 Cli 时自动加 `<appName>-`）
- 同名命令重复注册抛错
- `handler` 必须是 async 函数
- 返回值是任意对象（建议 `{ ok, ... }` 或 `{ ok: false, error }`）

## 2.5 web 路由注册

```js
// 严格 GET-only（SDK 不暴露 post/put/delete 方法）
app.web.get('/apps/<appName>/', async (req) => {
  // req.query: URL 查询参数对象
  // req.params: 路径参数（如 :id，需 SDK 升级支持，见已知问题）
  
  // HTML 路由返回 { status, body, headers }
  return {
    status: 200,
    body: '<html>...',
    headers: { 'Content-Type': 'text/html' },
  }
})

// JSON API 路由直接返回数据对象（不要包装 status/body/headers）
app.web.get('/api/apps/<appName>/orders', async (req) => {
  return {
    ok: true,
    orders: [...],
  }
})
```

**路径约定**：
- HTML 路由：`/apps/<appName>/<path>`
- JSON API 路由：`/api/apps/<appName>/<path>`

**双轨路由**（推荐）：每条资源同时提供 HTML 和 JSON API（参考 Embas/src/web.js）。

## 2.6 state 持久化

```js
// 读
const frozen = await app.state.get('frozen:did:havix:B:alice', 0)

// 写
await app.state.set('frozen:did:havix:B:alice', 100)

// 删
await app.state.delete('frozen:did:havix:B:alice')

// 列出所有 key
const keys = app.state.keys()

// 列出所有 entries
const entries = app.state.entries()
```

**约束**：
- key 必须是非空字符串
- value 会被 JSON.stringify，所以必须是可序列化的（不含 Function / Symbol / 循环引用）
- state.json 自动持久化到 `<data-dir>/<manifest.dataDir>/state.json`
- 重启时 SDK 自动调 `state.load()` 恢复

**namespace 建议**：为避免与其他 App 冲突（虽然 SDK 已按 App 隔离 state），建议 key 加 App 名前缀（如 `translation-market:frozen:<did>`）。

## 2.7 测试 mock 模式

SDK 提供 `createSnodeMock` 用于 App 单元测试：

```js
import { createSnodeMock } from 'havix-sdk/__mocks__/snode-mock.js'
import { createApp } from 'havix-sdk'

const snode = createSnodeMock({
  balances: { 'did:havix:B:me': 100 },
  reputation: { 'did:havix:B:me': 50 },
})

const manifest = {
  name: 'my-app',
  version: '1.0.0',
  capability: 'market',
  permissions: ['market:publish', 'credit:balance'],
  entryPoint: './index.js',
  contexts: ['B'],
}

const app = await createApp(snode, manifest, { dataDir: './test-data' })

// 装载自定义适配器
app._myAdapter = createMyAdapter(app, manifest)

// 调用 App 的 CLI
const result = await app.cli.execute('publish', { named: { ... } })
```

**已知的 mock 失真问题**（详见 [AUDIT-M10.md P2-17](../AUDIT-M10.md)）：

mock 中以下 7 个方法缺真实校验，可能导致测试"假过"：
- `vouch()` / `registerRelayCandidate()` / `registerJurorCandidate()`
- `fileDispute()` / `summonArbitrationPanel()` / `castArbitrationVote()` / `resolveVerdict()`

**建议**：涉及仲裁 / vouch / relay 的核心安全路径，必须走集成测试（如 Embas/test/integration.test.js 的 MockNetwork 模式）。

## 2.8 credit escrow 模式

Havix SDK credit API 只有 `issue` / `consume` / `transfer` / `balance`，没有 `freeze` / `release`。如果 App 需要 escrow 语义（如发布需求时冻结 credit，验收时转账），用 state 模型实现：

```js
// freeze(holderDid, amount)
async function freeze(holderDid, amount) {
  const bal = app.credit.balance(holderDid)
  const frozen = await app.state.get(`frozen:${holderDid}`, 0)
  if (bal - frozen < amount) {
    throw new Error(`余额不足：可用 ${bal - frozen} < 欲冻结 ${amount}`)
  }
  await app.state.set(`frozen:${holderDid}`, frozen + amount)
}

// release(holderDid, amount)
async function release(holderDid, amount) {
  const frozen = await app.state.get(`frozen:${holderDid}`, 0)
  await app.state.set(`frozen:${holderDid}`, Math.max(0, frozen - amount))
}

// transfer(fromDid, toDid, amount) —— 真扣 credit + 清 escrow
async function transfer(fromDid, toDid, amount) {
  const result = await app.credit.transfer(fromDid, toDid, amount)
  await release(fromDid, amount)
  return result
}
```

参考实现：[Embas/src/credit-adapter.js](../Embas/src/credit-adapter.js)。

> **已知问题**（[AUDIT-M10 P1-7/P1-8](../AUDIT-M10.md)）：当前 escrow 模型有 race condition（read-then-write）和 transfer 双重扣款风险，建议内测前修复或加进程内 mutex。

## 2.9 market 广播模式

```js
// 订阅市场消息
await app.market.subscribe(marketId, (msg, fromPeerId) => {
  // 过滤本 App 的消息（按 app 标签）
  if (msg.app !== 'my-app') return
  
  // 按 type 分发
  switch (msg.type) {
    case 'offer':
      handleOffer(msg)
      break
    case 'accept':
      handleAccept(msg)
      break
    // ...
  }
})

// 广播消息
await app.market.publish(marketId, {
  app: 'my-app',  // 必须加 app 标签！
  type: 'offer',
  orderId: '...',
  // ...业务字段
  timestamp: Date.now(),
})
```

**关键约束**：
- 消息必须含 `app` 字段（值为本 App 名），其他 App 才能过滤
- onMessage callback 应在 try/catch 中（防一个 handler 抛错影响其他订阅者）
- payload 不要覆盖 `app` / `type` 字段（详见 [AUDIT-M10 P1-10](../AUDIT-M10.md)）

---

# 第 3 章 · 已知问题

本节列出 SDK 当前版本的已知问题，详见 [AUDIT-M10.md](../AUDIT-M10.md)。

## P0 级（已修复）

| 编号 | 问题 | 状态 |
| --- | --- | --- |
| - | state.js dataDir 路径穿越（M9 P0-1） | ✅ 已修复 |
| - | credit note 签名校验（M9 P1-10） | ✅ 已修复 |

## P1 级（建议内测前修复）

详见 [AUDIT-M10.md P1 清单](../AUDIT-M10.md#p1--高危15-项建议内测前修复)。SDK 层相关项：

- **P1-1** `--data-dir` / `--apps-dir` 无路径穿越校验（src/config.js）
- **P1-3** note.signerPublicKey 与 issuerDid 无密码学绑定（src/s-node.js）
- **P1-4** ReputationLedger.get 同步写盘阻塞事件循环（src/protocol/credit.js）

## P2 级（可纳入 M11）

详见 [AUDIT-M10.md P2 清单](../AUDIT-M10.md#p2--中低危32-项可纳入-m11)。SDK 层相关项：

| 编号 | 文件 | 问题 |
| --- | --- | --- |
| P2-14 | sdk/credit.js | `_onReceived` 注释与代码矛盾（throw 中断循环） |
| P2-15 | sdk/market.js | `list()` / `isMember()` / `getManifest()` 无权限门控 |
| P2-16 | sdk/transport.js + sdk/market.js | `_dispose()` 未解绑 libp2p 订阅（资源泄漏 + 回调残留） |
| P2-17 | sdk/__mocks__/snode-mock.js | 7 个方法缺失真实校验（测试"假过"） |
| P2-18 | sdk/state.js | `load()` 不校验 key 合法性 |
| P2-19 | sdk/ipfs.js | `add()` 无 bytes 大小上限 |
| P2-20 | sdk/cli.js + sdk/manifest.js | 无保留字列表（App 名可为 `help` / `quit` 等） |

## 限制

### 路径参数 `:id` 通配

SDK `web.js` 的 `handle()` 当前为**精确匹配**，不支持 `:id` 通配符。

```js
// 注册
app.web.get('/apps/foo/orders/:id', handler)

// 访问 /apps/foo/orders/42 → 当前返回 404（SDK 不解析 :id）
```

Embas 在测试 mock 中实现了 `:id` 正则解析（见 [Embas/test/arbitration-flow.test.js](../Embas/test/arbitration-flow.test.js) 的 `callRoute`），生产环境需 SDK 升级（记入 M11+ deferred）。

### App 之间隔离

SDK 已按 App 隔离 state / cli / web 路由，但**未隔离 credit / market / arbitration**——所有 App 共享同一 snode 的协议层账本。这是设计决策（账本是共识层），但 App 不能直接调用 `snode.creditLedger` 等协议层 API，必须通过 `app.credit` 包装。

---

**Last Updated**：2026-07-19 · SDK USAGE.md 完成 · 覆盖运维 + 开发者 + 已知问题 · 等待内测反馈
