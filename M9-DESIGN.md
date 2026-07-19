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

```
# 市场权限
market:create         创建新市场
market:invite         邀请成员
market:join           加入市场
market:publish        发布私域消息
market:subscribe      订阅私域消息
market:leave          离开市场

# Credit 权限
credit:issue          签发 credit（需高信誉）
credit:consume        消费 credit
credit:transfer       转账
credit:balance        查询余额

# 维基权限
wiki:publish          发布条目（需 vouch 阈值）
wiki:list             列出条目
wiki:get              获取条目

# 隧道权限
tunnel:open           打开隧道
tunnel:send           发送隧道消息
tunnel:close          关闭隧道

# 仲裁权限
arbitration:file      发起仲裁
arbitration:vote      投票（需仲裁员资格）
arbitration:resolve   裁决（需仲裁团多数）

# 高级权限
identity:context      获取 context 子身份
transport:publish     直接 gossipsub 发布
transport:subscribe   直接 gossipsub 订阅
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

```javascript
// 获取本节点的 4-context 子身份
const { A, B, C, D } = await app.context.getAll()

// 获取指定 context 的 DID
const contextB = await app.context.get('B')
// → "did:havix:B:z..."

// 用指定 context 签名
const sig = await app.context.sign('B', messageBytes)
// → { signature, signerPublicKey }

// 验证其他节点签的消息
const valid = await app.context.verify(publicKey, signature, messageBytes)
// → boolean
```

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

注册 Web 路由到 Havix Web 面板：

```javascript
// 静态文件
app.web.mount('/apps/translation-market/', {
  type: 'static',
  dir: './webui/',  // HTML/JS/CSS
})

// API 端点
app.web.api('/api/apps/translation-market/offers', async (req, res) => {
  const offers = await listOffers()
  return { offers }
})

// 动态路由
app.web.api('/api/apps/translation-market/orders/:id', async (req, res) => {
  const order = await getOrder(req.params.id)
  return order
})
```

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
  - identity:context:A
  - ipfs:read
minReputation: 0
trustWeight: 0.5
dataDir: empty-app
contexts: [A]
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

Havix Web 面板新增 `/apps/<app-name>/` 路由前缀：

```
GET /apps/translation-market/                    # App 首页（HTML）
GET /apps/translation-market/index.html          # 显式 HTML
GET /apps/translation-market/static/*           # 静态资源（JS/CSS/图片）
GET /api/apps/translation-market/offers         # App API
POST /api/apps/translation-market/offers         # App API（注意：破坏 GET-only 约束）
```

### 9.2 GET-only 约束的破例

M8.2 Web 面板是 GET-only（无 mutation）。M9 App API 可能需要 POST（如发布 offer）。

**M9 决策**：
- App 的 mutation API（POST/PUT/DELETE）允许，但**必须走本地 127.0.0.1**
- App API 自动继承 Host 头校验（P1-F）
- App API 必须自带 CSRF 防护（要求 `X-App-Token` 头，token 在 App 启动时生成并打印到 stdout）

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

| 子阶段 | 内容 | 估时 | 测试增量 |
| --- | --- | --- | --- |
| **M9.1** | AppManifest + 解析 + 校验 + 权限白名单 | 中 | ~40 测试 |
| **M9.2** | SDK 入口 + 7 大接口骨架 + mock SNode | 中 | ~70 测试 |
| **M9.3** | AppManager + SNode 集成 + config 选项 | 中 | ~15 测试 |
| **M9.4** | Web 面板路由扩展 + App API | 中 | ~10 测试 |
| **M9.5** | empty-app 参考模板 + 集成测试 | 中 | ~15 测试 |

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

## 15. 下一步

1. **你审阅本文档**，确认 SDK 设计、Manifest 字段、Web 路由方案是否合理
2. 确认后开始 **M9.1 AppManifest + 解析 + 校验**实施
3. M9.1 完成后停下来等你确认，再进 M9.2

---

**Last Updated**: M9 详细设计草案 · 等待审阅
