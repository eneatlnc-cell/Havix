# Havix 开发路线图

> **当前阶段**：验证形态（M1–M10）已全部交付 ✅ · AUDIT-M10 全部 P0+P1 修复闭环（5 P0 + 15 P1）· 测试基线 1234/1234 · **内测进行中**，M11 启动等内测反馈
> 协议设计见 [技术白皮书](./Havix-Technical-Whitepaper.md)，部署运行见 [DEPLOY.md](./DEPLOY.md)，项目概览见 [README](./README.md)，M11 起的权威规划锚点见 [NEXT-STEPS.md](./NEXT-STEPS.md)。

本文件规划 MVP 之后的开发路线，对齐白皮书 §8.5「阶段二：多 App + 加权转换」与 §12「未来工作」FW-01 ~ FW-06。

> **文档状态说明**：本文件定稿于 MVP 完成时点，M9/M10 段落已按实际交付情况标注"已完成"。M11 起的后续规划已按 L0 视角在 [NEXT-STEPS.md](./NEXT-STEPS.md) 重写（含 L1/L2 接入契约、红线拦截器、活宪章、Rust 化与 Cover Traffic），两文档冲突时以 NEXT-STEPS.md 为准。

---

## 0. 路线目标

**进度现状（2026-08）**：MVP（M1–M8.3）+ M9（App SDK）+ M9.5/M9.6（参考模板 + App 加载层加固）+ M10（第一个 App）已全部交付。第一个真实 App 已跑在协议上——**Embas 翻译市场**（订单生命周期 + 仲裁 + escrow）。测试基线 1234/1234（MVP 1021 + Embas 213），AUDIT-M10 全栈审计 5 P0 + 15 P1 全部修复闭环，32 项 P2 登记待后续形态穿插处理。

**阶段二（M11–M12+）目标**：让 L0 从"4-context 已原生切分三层但契约未暴露"演进到"L1/L2 接入契约原生暴露 + 多 App 共存 + 加权转换"，并为阶段三（Rust 实现 + Cover Traffic 主权边界掩护）打好基础。

| 阶段 | 主题 | 关键产出 | 与白皮书对齐 |
| --- | --- | --- | --- |
| **M9** ✅ | App SDK 与框架 | Havix SDK + App Manifest 规范定稿 + 参考模板 | §8.2 App Manifest、§8.5 阶段二 |
| **M10** ✅ | 第一个参考 App | 翻译市场（context-B + credit 消费）端到端跑通（Embas，AUDIT-M10 闭环） | §11.3 集成场景 1 |
| **M11** | 完整化形态 | L1/L2 接入契约原生暴露 + 红线拦截器 + 活宪章 + 多 App 共存 + 加权转换；FW-01 自然涌现算法 v0 | §8.3 加权转换、FW-01 |
| **M12** | 网络效应启动 | App 注册中心、Manifest 审核、第三方 App 准入流程 | §8.4 App 信任权重审核 |
| **M13+** | 网络化形态 | Rust 实现 + Cover Traffic 主权边界掩护 / DID 旋转 / 跨网络联邦 | §12 FW-02 ~ FW-06 |

---

## 1. App 变体矩阵

App = `context 使用` × `经济模型` × `准入策略` 三维组合。任何 App 都可由这三个维度的取值唯一刻画。

### 1.1 维度一：context 使用

每个 App 声明它使用哪些 context 子身份（白皮书 §3）：

| context | 用途 | 现有协议能力 | 适合的 App |
| --- | --- | --- | --- |
| **A · public** | 公共层消息（心跳 / vouch / credit / announce） | M2 + M4 + M3 已实现 | 公告板、投票、信誉展示 |
| **B · market** | 私域邀请市场，双重加密 | M7 已实现 | 翻译市场、教学市场、招聘、拍卖、托管 |
| **C · tunnel** | 私聊隧道 sourceDid | M5 已实现 | 1v1 加密通讯、群聊、文件传输 |
| **D · wiki** | 维基条目作者签名 | M3 已实现 | 协作文档、知识库、教程、代码仓库镜像 |

**约束**：M3-M7 已经实现 4 个 context 的协议能力，App 只是在协议层之上做业务编排，**不需要新协议层**。

### 1.2 维度二：经济模型

| 模型 | 谁付 credit | 谁收 credit | 复用协议 | 例子 |
| --- | --- | --- | --- | --- |
| **公益型** | 无 | 无 | 不用 M4 | 公共维基、公共论坛 |
| **消费型** | 用户 | 服务方 | `consumeCredit` | API 网关、AI 推理、存储、翻译 |
| **签发型** | 高信誉节点签发 | 用户持有 | `issueCredit` | 内容创作者激励、推荐奖励 |
| **转账型** | 节点 A → 节点 B | 对方 | `transferCredit` | P2P 支付、悬赏、托管 |
| **仲裁依赖型** | 输家被 slash | 受害者获 50% | M6 完整链路 | 高价值交易、合约执行 |

### 1.3 维度三：准入策略

| 策略 | 机制 | 复用协议 |
| --- | --- | --- |
| **完全开放** | 任何 peerId 可加入 | M1 libp2p 连接 |
| **vouch 门控** | 需 N 个高信誉节点 vouch | M3 VouchRegistry + 阈值 N |
| **邀请制** | M7 InviteToken 验签 + 过期 | M7 完整 |
| **混合** | 不同操作不同门槛 | 上述组合 |

### 1.4 内置 App 候选（白皮书 §8.5）

白皮书阶段二规划 3 个内置 App：

| App | context | 经济模型 | 准入 | trustWeight |
| --- | --- | --- | --- | --- |
| **翻译市场** | B (market) | 消费型 | 邀请制 | 0.8 |
| **教学市场** | B (market) | 消费型 + 转账型 | 邀请制 | 0.5 |
| **维基编辑** | D (wiki) | 签发型（创作者激励） | vouch 门控 N=2 | 1.0 |

加上**私聊**（context-C）和**公告板**（context-A）作为可选第 4-5 个 App 候选。

---

## 2. 第一个 App 候选对比

M10 选一个 App 端到端跑通。候选评估：

| 候选 | 协议复用度 | 业务复杂度 | 价值验证 | 风险 | 推荐 |
| --- | --- | --- | --- | --- | --- |
| **A. 翻译市场** | 极高（M7 完整 + M4 credit + M6 仲裁） | 中（offer / consume / 仲裁完整链） | 极高（白皮书 §11.3 默认场景） | 中（业务流程多） | ⭐⭐⭐⭐⭐ |
| **B. 公共维基 App** | 极高（M3 完整） | 低（已实现，仅做 Web UI） | 高（验证 context-D 流通） | 低 | ⭐⭐⭐⭐ |
| **C. 私聊 App** | 中（M5 隧道 + 隧道管理器） | 中（消息分片、断线重连） | 中（context-C 验证） | 中（M5 单跳 relay 局限） | ⭐⭐⭐ |
| **D. 教学市场** | 高（同翻译市场） | 高（多对多 + 评级） | 高 | 高（业务复杂） | ⭐⭐⭐ |
| **E. 公告板 App** | 低（仅 context-A） | 极低 | 低 | 低 | ⭐⭐ |

**推荐 M10 选 A（翻译市场）**：
- 协议复用度最高，能验证 M4 credit 消费 + M7 私域市场 + M6 仲裁的端到端集成
- 白皮书 §11.3 集成场景默认就是翻译市场，社区预期一致
- 业务流程清晰可测：发布 offer → 消费 credit → 不交付 → 仲裁 → slash

**M11 跟进 B（公共维基 App）**：M3 已实现协议层，M10 后补一个 Web UI 即可上线，验证 context-D 通路。

---

## 3. M9 — App SDK 与框架（已完成 ✅）

### 3.1 目标

把 Havix 节点的协议能力封装为 App 可调用的 SDK，让 App 开发者**不需要直接 import 协议层模块**，只通过 SDK 高层 API 操作。

### 3.2 SDK 设计原则

1. **声明优先**：App 用 Manifest 声明需求，SDK 校验权限，不允许越权
2. **隔离性**：每个 App 有独立的 manifestId / 加密密钥 / 信誉记账单元，App 间不互相污染
3. **能力受限**：SDK 不暴露 libp2p / helia 私有 API，只暴露业务语义
4. **可测试**：SDK 提供 mock 实现，App 单元测试不依赖真实节点
5. **向前后兼容**：Manifest 用 semver，SDK 用 v1/v2 共存

### 3.3 SDK 接口草案

```
havix-sdk/
├── index.js                  # 入口：createApp(manifest, options)
├── manifest.js               # AppManifest 类（解析 + 校验）
├── context.js                # 4-context 子身份获取（A/B/C/D）
├── market.js                 # 私域市场 API（基于 M7）
├── credit.js                 # credit API（基于 M4）
├── wiki.js                   # 维基 API（基于 M3）
├── tunnel.js                 # 隧道 API（基于 M5）
├── arbitration.js            # 仲裁 API（基于 M6，被动响应）
└── transport.js              # gossipsub / IPFS 抽象（高级用法）
```

App 入口示例（伪代码）：

```javascript
import { createApp } from 'havix-sdk'

const app = await createApp({
  name: 'translation-market',
  version: '1.0.0',
  capability: 'market',
  permissions: ['market:publish', 'market:subscribe', 'credit:consume'],
  minReputation: 30,
  trustWeight: 0.8,
}, {
  dataDir: '.data/translation-market',  // 独立数据目录
})

// 发布 offer
await app.market.publish({
  sourceLang: 'zh',
  targetLang: 'en',
  contentCid: 'bafy...',
  reward: { amount: 10, unit: 'credit' },
})

// 订阅 offer
app.market.subscribe((offer) => {
  console.log('new offer:', offer)
})

// 消费 credit 给服务方
await app.credit.consume(providerDid, 10, { note: 'translation task #42' })

// 收到 credit 后释放结果（业务侧自实现）
app.credit.onReceived((note) => {
  deliverTranslationResult(note.from, note.payload)
})
```

### 3.4 App Manifest 规范定稿

基于白皮书 §8.2 草案，M9 补充以下字段：

```yaml
name: "translation-market"           # 必需，全局唯一
version: "1.0.0"                      # 必需，semver
capability: "market"                  # 必需，enum: market|wiki|tunnel|public|custom
permissions:                          # 必需，权限声明
  - "market:publish"
  - "market:subscribe"
  - "credit:consume"
  - "credit:issue"                   # 高信誉节点才能用
  - "arbitration:file"
invite_token_format: "ed25519-signature"   # 可选，邀请令牌格式
spa_cid: "bafy..."                    # 可选，前端 SPA 的 IPFS CID
min_reputation: 30                    # 可选，参与门槛
trust_weight: 0.8                     # 可选，0.0-1.0
entry_point: "./index.js"             # 必需，App 入口模块
data_dir: "translation-market"        # 可选，独立数据目录名
```

**M9 产出**：
- ✅ SDK 包（独立 npm 包，可被 App 引用）
- ✅ AppManifest 规范 v1.0（基于白皮书 §8.2 + 上述补充）
- ✅ 参考模板：`apps/empty-app/`（最小骨架，复用 SDK）
- ✅ SDK 单元测试（mock SNode，无 libp2p/helia 依赖）
- ✅ SDK 集成测试（接 SNode 真实实例，2 节点往返）

### 3.5 M9 Deferred

- 第三方 App 加载器（沙箱执行，防恶意 App 影响节点进程）→ M12
- App 之间事件总线（App 互相发现）→ M12
- App 动态安装 / 卸载 → M12

---

## 4. M10 — 第一个参考 App：翻译市场（已完成 ✅，交付为 Embas）

### 4.1 业务流程

基于白皮书 §11.3 集成场景 1：

```
[alice] 创建翻译市场 + 邀请 [bob, carol, dave]
  ↓
[bob] 发布 offer: zh → en, contentCid=bafyX, reward=10 credit
  ↓
[carol] 看到 offer, 调用 credit.consume(bob, 10)
  ↓
[carol] 翻译内容 → 写到 IPFS → 通过私域 market 发结果 cid 给 bob
  ↓
[bob] 验收:
  - 满意 → ack, 交易完成
  - 不满意 → fileDispute(type='offer-breach', against=carol)
  ↓
[仲裁团] 召集 → 投票 → 裁决:
  - guilty → slash carol 信誉 50%, 50% 赔 bob
  - not-guilty → bob 损失 credit（无退款）
```

### 4.2 实现范围

```
apps/translation-market/
├── manifest.yaml             # App Manifest
├── index.js                  # 入口：用 SDK 创建 app
├── api/
│   ├── offer.js              # publishOffer / listOffers
│   ├── consume.js            # consumeCredit + 仲裁预留
│   ├── deliver.js            # deliverResult + ack
│   └── dispute.js            # fileDispute 封装
├── webui/                    # 简单 Web 前端（vanilla JS）
│   ├── index.html
│   └── app.js
└── README.md
```

### 4.3 M10 验收测试

端到端测试覆盖白皮书 §11.3 场景 1：
1. alice 创建翻译市场，邀请 bob/carol/dave
2. bob 发布 offer
3. carol 消费 credit
4. carol 交付翻译结果
5. bob 验收 ack
6. （异常分支）dave 不交付 → bob 发起仲裁 → 仲裁团裁决 → slash

**M10 Deferred**：
- 翻译质量评估（M10 用 bob 人工验收，自动评估 deferred）
- 多语种路由（M10 单语种对，多语种匹配 deferred）
- 退款机制（M10 走仲裁，自动退款 deferred）

---

## 5. M11 — 多 App 并存 + 加权转换

### 5.1 第二、第三个 App

**M11-1 公共维基 App**（context-D）：
- M3 协议层已完整，M11 只补 Web UI（编辑器 + 历史版本浏览）
- 复用 `wiki-publish` / `wiki-list` / `wiki-get` / `wiki-history` CLI 命令
- trustWeight = 1.0（最高，因为是公共物品）

**M11-2 教学市场 App**（context-B）：
- 类似翻译市场，但多对多 + 评级
- 引入"教师评级"（基于历史交付质量），M11 实现简单加权
- trustWeight = 0.5

### 5.2 FW-01 自然涌现算法 v0

白皮书 §8.4：权重不由谁指定，而通过"被多少高信誉节点使用"动态计算。

**M11 v0 算法草案**：

```
App.trustWeight(t) = baseWeight × usageFactor(t)

其中：
  baseWeight = Manifest 声明的初始权重（0.5-1.0）
  usageFactor = min(1.0, activeUsers(t) / threshold)
    activeUsers(t) = 过去 30 天用 credit 消费过该 App 的独立节点数
    threshold = 10（M11 阈值，可调）

防刷分：
  - 只统计 activeUsers，不统计被动订阅
  - 只统计有 credit 流水的用户（防自刷）
  - activeUsers 取 30 天滚动窗口（防老数据永久加权）
```

**M11 Deferred**：
- App 滥用检测（自动降权）→ M12
- 跨 App 信誉流动（FW-04）→ M12+
- 用户主动评分机制 → M12

---

## 6. M12 — 网络效应启动

### 6.1 App 注册中心

节点订阅新 topic `/s-network/apps`，App Manifest 通过 gossipsub 广播，节点本地索引：

```
AppRegistry:
  manifestId → { manifest, deployer, firstSeenAt, activeUsers }
```

节点可查询：`listApps` / `getApp(manifestId)` / `verifyManifestSignature`

### 6.2 第三方 App 准入流程

```
1. 开发者用 context-A 子身份签名 App Manifest
2. 通过 gossipsub 广播到 /s-network/apps
3. 节点收到后:
   - 校验签名
   - 校验 Manifest 字段
   - 校验 deployer 信誉 >= 阈值
   - 加入本地索引（不自动加载）
4. 用户 CLI: app install <manifestId>
5. 节点下载 SPA bundle（spa_cid）+ 启动 App
```

### 6.3 App 沙箱（防恶意 App）

第三方 App 在**子进程**或 **Worker Thread** 中执行：
- 不共享主节点内存
- 通过 IPC 与主节点通信
- 资源配额（CPU / 内存 / 调用频率）
- 异常隔离（App 崩溃不影响节点）

### 6.4 M12 Deferred

- 跨 App 信誉流动（FW-04）
- App 自动升级
- App 卸载后数据清理
- Manifest 审核委员会（人工审核高 trustWeight App）

---

## 7. M13+ — 横向能力扩展

对齐白皮书 §12 未来工作：

| ID | 问题 | M13+ 选择 | 何时启动 |
| --- | --- | --- | --- |
| **FW-02** | 金库释放机制 | 7 节点联签 + 30 天公示 | 网络有真实公共物品资助需求时 |
| **FW-03** | DID 旋转 | 子身份被关联后换发 | 出现真实身份关联攻击时 |
| **FW-04** | 跨 context 信誉流动 | 按 App trustWeight 转换 | 加权转换算法稳定后 |
| **FW-05** | 多跳洋葱升级 | 单跳不够安全时扩展 | 性能瓶颈出现后 |
| **FW-06** | 网络分片联邦 | 多个 Havix 网络联邦 | 单网络稳定后 |

**跨语言实现**（白皮书 §8.5 阶段三）：
- Rust 实现（libp2p Rust 生态成熟）
- JS 节点 ↔ Rust 节点互通验证
- 协议规范 RFC 化

---

## 8. 关键决策点（已随 M9/M10 实施落定）

> 以下决策点起草于 M9 启动前，实际实施中已全部落定：Q4 选 C（SDK 置于主仓库 `sdk/` 子目录）、Q1 选 B（IPFS CID + AES-GCM 加密）、Q2 选 A（客户人工验收）、Q3 选 A（Vanilla JS Web UI）、Q5 选 A（节点本地计算）、Q6 按"M9 稳定后启动 M10"节奏执行。保留原文备查。

下面是路线展开前需要确认的关键决策（历史记录）：

### Q1：M10 翻译市场的"内容"如何表示？

- **A. 纯文本直接放消息体**（小内容，简单）
- **B. IPFS CID + 加密**（大内容，复用 M7 AES-GCM）
- **C. 两者都支持**（按内容大小自动选）

推荐 **B**（与白皮书 §6.5 一致，复用 M7 已有能力）。

### Q2：M10 翻译质量如何评估？

- **A. 客户人工验收**（M10 简单可靠）
- **B. 第三方节点抽检**（增加协议复杂度）
- **C. AI 自动评估**（引入外部依赖）

推荐 **A**（M10 不引入额外依赖，B/C deferred）。

### Q3：App Web UI 用什么技术栈？

- **A. Vanilla JS + vis-network 风格**（与 Web 面板一致，无构建链）
- **B. React / Vue SPA + IPFS 托管**（白皮书 spa_cid 设计，需构建链）
- **C. 两者都支持**（SDK 提供容器，App 自选）

推荐 **A**（M10 MVP 阶段简单优先，B 留给 M12 第三方 App）。

### Q4：M9 SDK 是独立 npm 包还是 monorepo 子目录？

- **A. 独立 npm 包** `havix-sdk`（清晰边界，App 可独立安装）
- **B. Monorepo 子目录** `packages/sdk/`（与协议代码一起开发）
- **C. 主仓库子目录** `sdk/`（最简单，无 monorepo 工具）

推荐 **C**（M9 不引入 monorepo 工具复杂度，等 M12 第三方 App 多了再考虑拆分）。

### Q5：M11 加权转换的 trustWeight 谁来算？

- **A. 每个节点本地算**（去中心化，但可能不一致）
- **B. 高信誉节点广播**（中心化风险，但一致）
- **C. 链上共识**（最严格，但引入共识协议复杂度）

推荐 **A**（与 Havix "本地账本视图 + gossipsub 收敛" 一致，B/C deferred）。

### Q6：M10 何时启动？

- **A. 立即（M9 SDK 起草时同步规划 M10）**
- **B. M9 SDK 稳定后启动 M10**
- **C. 等社区反馈 MVP 后再启动**

推荐 **B**（M9 SDK 稳定 1-2 周后启动 M10，避免 SDK 频繁变动让 App 重写）。

---

## 9. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| SDK 设计不当导致 M10 App 反复重写 | 中 | 高 | M9 用参考模板验证 SDK 接口稳定性，先实现 SDK 集成测试再写 App |
| App 复杂度膨胀，M10 无法完成 | 中 | 高 | M10 严格限定范围（白皮书 §11.3 场景 1），多语种 / 自动评估等 deferred |
| 加权转换算法被刷分攻破 | 中 | 高 | M11 v0 严格限制（只算 credit 流水用户、30 天窗口），M12 上线沙箱后才有真正第三方 App |
| 协议层发现新安全漏洞阻断 M10 | 低 | 高 | M8 审计已修 6 P0 + 6 P1 + 3 P2，剩余 26 项 Deferred 风险可控 |
| App 与协议层版本耦合（升级破坏 App） | 中 | 中 | SDK 用 semver，协议层用 deprecation 期，App 声明兼容协议版本范围 |
| 跨语言实现（M13+）超期 | 中 | 中 | Rust 实现可推迟，JS 单实现够支撑阶段二生态 |

---

## 10. 里程碑估算

| 里程碑 | 估算工作量 | 何时启动 |
| --- | --- | --- |
| M9 App SDK + Manifest 定稿 | 中（SDK 接口 + 模板 + 测试） | MVP 交付后立即 |
| M10 翻译市场 App | 中高（业务流程端到端 + Web UI + 测试） | M9 SDK 稳定后 |
| M11 多 App + 加权转换 v0 | 中（多 App + 算法实现） | M10 上线后 |
| M12 App 注册中心 + 沙箱 | 高（沙箱执行 + 注册中心 + 准入流程） | M11 验证后 |
| M13+ 横向能力 | 视社区反馈 | 视需求 |

> 估算是相对量级，不是绝对时间。具体节奏取决于你投入的精力与社区参与度。

---

## 11. 总结

**路线核心思想**：
1. **协议层 MVP + 第一个 App 已就绪**（M1–M10 交付，Embas 端到端跑通），M11-M12 重点是**契约原生暴露 + 生态**
2. **第一个 App 已选翻译市场**（白皮书默认场景，协议复用度最高，已交付）
3. **加权转换用本地涌现**（与 Havix "本地账本视图 + gossipsub 收敛" 一致）
4. **第三方 App 准入走沙箱**（M12 才开放，防恶意 App 影响节点）
5. **Rust 实现与 Cover Traffic 在网络化形态推进**（M13–M14，验证形态下的 JS 单实现够用）

**当前状态与下一步**：
1. M9 SDK（M9-DESIGN.md）与 M10 翻译市场（Embas）均已交付，§8 决策点已随实施落定
2. 当前处于**内测阶段**，反馈按 [NEXT-STEPS.md](./NEXT-STEPS.md) §13 分级处理（P0 立即修 / P1 登记到 AUDIT-M11 / P2 穿插处理）
3. 内测结束按 [NEXT-STEPS.md](./NEXT-STEPS.md) §14 启动检查清单逐项确认后，启动 M11（完整化形态：L1/L2 接入契约原生暴露 + 红线拦截器 + 活宪章 + 加权转换）

---

**Last Updated**: 验证形态（M1–M10）完结 · 内测进行中 · M11 待内测反馈后启动
