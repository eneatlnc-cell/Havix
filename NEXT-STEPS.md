# Havix 协议开发规划

> 本文档定义 Havix 协议的开发路径。
> 采用递归结构组织：从协议整体定位出发，逐层展开到阶段、工作项、横切关注点、当前可操作项。
> 任何位置都能定位"当前在哪、下一步往哪去、要做什么"。
>
> 最近更新：2026-07-19

---

## 0. 文档定位

本文档是 Havix 协议开发的工程参考，作为 M11 起所有后续工作的锚点。M1–M10 的工作已归档于项目历史，本文档只作阶段定位引用，不重复展开细节。

文档结构：

- **Layer 0**：协议整体定位（第 1 章）
- **Layer 1**：阶段划分（第 2 章）
- **Layer 2**：每阶段的工作项（第 3–7 章）
- **Layer 3**：横切关注点（第 8–11 章：安全模型 / 假设验证 / 接口契约 / 工程约束）
- **Layer 4**：当前形态特性登记（第 12 章）
- **Layer 5**：当前可操作项（第 13–14 章：内测反馈 / 启动检查清单）

---

## 1. Havix 协议

### 1.1 协议定位

Havix 是去中心化对等网络协议，验证社会学论文《底层高认知者的结构性困境》提出的分层自组织网络假设。

协议主张：当主流集权系统的资源抽水比例过高时，高认知个体可以通过构建平行网络实现生存与意义的自我维系。

### 1.2 协议要回答的五个问题

| 编号 | 假设 | 描述 |
|---|---|---|
| H1 | 身份不可降级 | 多方协作中个体能否保持多 context 子身份的独立性 |
| H2 | 价值可闭环 | 高认知个体的认知产出能否通过协议内信用体系完成价值闭环 |
| H3 | 治理可问责 | 在无中心仲裁者的情况下违约行为能否被临时仲裁团处理并自执行 |
| H4 | 边界可维护 | 在观察者存在的前提下私域协作空间能否维持可见性边界 |
| H5 | 角色可涌现 | 在长跑稳定状态下节点角色能否通过加权转换自然分化 |

### 1.3 不在协议范围

- 网络层绝对匿名（mixnet 的领域，Havix 集成而非重写）
- 链上治理代币与交易所经济（Havix 信用不可跨协议流通）
- 替代任何现实法律或主权治理
- 任何特定政治诉求的表达

### 1.4 协议形态

Havix 协议通过迭代开发逐层展开。每个阶段对应一个协议形态，是该阶段的生态位：

| 阶段 | 形态 | 性质 |
|---|---|---|
| M1–M10 | 验证形态 | MVP + SDK + 验证 App，验证协议业务逻辑可走通 |
| M11–M12 | 完整化形态 | 多 App 共存 + 加权转换 + 网络效应 + App 准入 |
| M13–M14 | 网络化形态 | Rust 实现 + mixnet 集成 + DID 传输解耦 |
| M15+ | 生态形态 | 多语言 SDK + 跨网络联邦 + 移动端节点 |

每个形态是协议在该阶段的真实形态，不是"未达成的残缺形态"。形态之间存在演进关系，前一形态是后一形态的基础，不是被否定的过渡。

---

## 2. 阶段划分

### 2.1 总览

```
阶段一（验证形态）        阶段二（完整化形态）      阶段三（网络化形态）      阶段四（生态形态）
M1 ─── M10 ──────────►  M11 ─── M12 ────────►  M13 ─── M14 ────────►  M15+ ───►
                            │                      │                      │
                            ▼                      ▼                      ▼
                       多 App 共存              Rust 实现               多语言 SDK
                       加权转换                 mixnet 集成            跨网络联邦
                       网络效应                 DID 解耦                移动端
                       App 准入                 跨节点攻击防护强化
```

### 2.2 当前位置

**当前处于验证形态完结点，进入内测阶段。**

- 验证形态（M1–M10）已交付
- 测试基线：MVP 1021/1021 + Embas 213/213 = 1234/1234
- Git 状态：主仓库 `d9a6190` / Embas `0353920`
- 安全加固：M8 审计 + M9.6 + AUDIT-M10 全部 P0 + P1 已完成
- 进入内测，等待内测反馈后启动 M11

---

## 3. 阶段一：验证形态（M1–M10，已完成）

### 3.1 阶段目标

验证协议业务逻辑可走通。让协议的所有核心模块（identity / credit / vouch / wiki / market / tunnel / arbitration）以最小可运行形态存在，并跑通端到端的 App 流程。

### 3.2 工作项

| 阶段 | 主题 | 产出 |
|---|---|---|
| M1–M7 | 协议层 MVP | identity / credit / vouch / wiki / market / tunnel / arbitration 协议能力 |
| M8 | 持久化 + CLI + 4 节点集成 | 6 registry 持久化 + 原子写 + start/stop 顺序 |
| M8 审计 | 安全回归 | 6 P0 + 6 P1 + 3 P2 修复（签名覆盖 / note 内层验签 / topic 分流 / InviteToken / gossipsub try-catch / slash 守卫等） |
| M9 | App SDK | Havix SDK 11 模块 + AppManifest 规范 |
| M9.5 | App 参考模板 | apps/empty-app 最小骨架 |
| M9.6 | App 加载层加固 | 路径穿越防护 / 跨 App 隔离 / 准入校验 fail-closed |
| M10 | 第一个 App | Embas 翻译市场（订单生命周期 + 仲裁 + escrow） |
| AUDIT-M10 | 全栈安全审计 | 5 P0 + 15 P1 修复（全部完成）+ 32 P2 登记 |

### 3.3 已交付的协议能力

| 模块 | 能力 |
|---|---|
| 身份层 | 4-context DID 派生 + Ed25519 签名 |
| 经济层 | Reputation / Credit 双账本 + Faucet 签发 + Slash 惩罚 |
| 协议层 | Vouch / Wiki / Market / Arbitration / Tunnel |
| 传输层 | libp2p + gossipsub + 单跳 relay + IPFS |
| 持久化 | 6 registry + nonce 集合，原子 JSON 落盘 |
| 治理 | 临时仲裁团 + 信誉 slash + Treasury 分账 |
| App SDK | 11 模块 API + Manifest 校验 + 权限白名单 |
| App 加载 | AppManager + entryPoint 校验 + 路径穿越防护 |
| 验证 App | Embas 翻译市场（订单 / 仲裁 / escrow / DID 脱敏） |

### 3.4 验证形态的固有特性

验证形态下，以下特性是固有的，属于该形态的生态位：

- 传输层使用 libp2p relay，peerId 与 DID 的映射在网络层可见
- 运行时为 Node.js，GC 抖动影响仲裁时效
- 持久化使用 fs + JSON，写入时阻塞事件循环
- 加密使用 `@noble/curves`，性能受 JS 运行时约束
- 网络层匿名缺失，敌对环境假设无法验证

这些特性在后续形态升级时自然转化，详见第 12 章。

### 3.5 假设验证覆盖度（验证形态）

| 假设 | 验证形态验证状态 | 完整验证条件 |
|---|---|---|
| H1 身份不可降级 | 部分验证（context 派生可工作，peerId 关联未解耦） | 网络化形态 DID↔peerId 解耦后 |
| H2 价值可闭环 | 已验证（Embas 翻译市场端到端跑通） | - |
| H3 治理可问责 | 部分验证（防直接串谋，缺间接串谋检测） | 完整化形态加统计检测后 |
| H4 边界可维护 | 部分验证（应用层签名 + 双平面隔离有效，网络层不可观察缺失） | 网络化形态 mixnet 集成后 |
| H5 角色可涌现 | 待验证 | 完整化形态 FW-01 算法后 |

---

## 4. 阶段二：完整化形态（M11–M12）

### 4.1 阶段目标

让协议从"单 App MVP"演进到"多 App 共存 + 加权转换 + 开放准入"。验证 H5（角色可涌现）与 H3 完整形态（防间接串谋）。

### 4.2 M11：多 App 共存与加权转换

#### 4.2.1 工作项

| 编号 | 工作项 | 产出 |
|---|---|---|
| M11-1 | 第二个 App：教学市场（context-B 消费型 + 转账型） | 验证 SDK 在多 App 上的通用性 |
| M11-2 | 第三个 App：维基编辑（context-D 签发型） | 验证多 context 共存 |
| M11-3 | 加权转换协议 | 跨 App credit 流转 + trustWeight 加权记账 |
| M11-4 | FW-01 自然涌现算法 v0 | 节点角色涌现的算法实现与仿真 |
| M11-5 | 节点间攻击防护（详见 4.2.3） | 7 项防护补齐 |
| M11-6 | 接口契约定义（详见第 9 章） | 4 个抽象接口的语言无关定义 |

#### 4.2.2 假设验证目标

| 假设 | M11 验证 | 备注 |
|---|---|---|
| H5 角色可涌现 | ✅ | FW-01 算法 + 加权转换协议 |
| H3 治理可问责（完整） | ✅ | 配合节点间攻击防护 |
| 多 App 隔离 | ✅ | AppManager + App 沙箱 |

#### 4.2.3 节点间攻击防护

| 防护 | 位置 | 防御对象 |
|---|---|---|
| Rate limiting | `s-node.js` `_pubsubHandler` | 高频消息 CPU 耗尽 |
| Sybil 防御加强 | `vouch.js` + `arbitration.js` | 慢速累积 vouch 入 panel |
| Eclipse 攻击检测 | `network/dht.js` | DHT 邻居被控制 |
| 仲裁员串谋统计检测 | `arbitration.js` | 间接串谋（无 vouch 关联但合谋） |
| 仲裁员中途退出惩罚 | `arbitration.js` + `timeouts.js` | 恶意 abstain 拖垮裁决 |
| Front-running commit-reveal | `market.js` | 抢订单时序攻击 |
| issue credit 反向审计 | `credit.js` | issuer 主动作恶 |

### 4.3 M12：网络效应与 App 准入

#### 4.3.1 工作项

| 编号 | 工作项 | 产出 |
|---|---|---|
| M12-1 | App 注册中心 | 全局 App 目录 + 版本管理 + 跨节点同步 |
| M12-2 | Manifest 审核流程 | 第三方 App 准入机制（白皮书 §8.4） |
| M12-3 | App 信任权重动态调整 | trustWeight 根据历史表现调整 |
| M12-4 | App 生命周期管理 | 安装 / 升级 / 卸载 / 数据迁移 |
| M12-5 | 第三方 App 沙箱执行 | 隔离第三方 App 对节点进程的影响 |

#### 4.3.2 M12 安全项

| 防护 | 防御对象 |
|---|---|
| App 准入场景 Sybil 强化 | 第三方 App 注入恶意节点 |
| vouch 质量加权 | 低质量 vouch 灌水 |

---

## 5. 阶段三：网络化形态（M13–M14）

### 5.1 阶段目标

让协议具备长跑稳定性与敌对环境验证能力。Rust 实现提供运行时材料升级，mixnet 集成提供网络层不可观察性，DID↔peerId 解耦提供身份层网络隔离。

### 5.2 M13：Rust 协议层实现

#### 5.2.1 工作项

| 编号 | 工作项 | 优先级 | 说明 |
|---|---|---|---|
| M13-1 | credit / reputation ledger Rust 实现 | P0 | 加权转换核心 |
| M13-2 | arbitration Rust 实现 | P0 | 长跑稳定性要求最高 |
| M13-3 | identity / 签名 Rust 实现 | P0 | `ed25519-dalek` 实现 |
| M13-4 | market Rust 实现 | P1 | 业务复杂 |
| M13-5 | wiki Rust 实现 | P2 | 业务简单 |
| M13-6 | 存储后端 | P0 | lmdb / sled 实现 LedgerStorage 契约 |
| M13-7 | rust-libp2p 集成 | P0 | 实现 PubSubProvider 与 TransportAdapter 契约 |

#### 5.2.2 实现原则

1. **协议规范冻结**：M13 期间协议规范不变，只新增实现语言
2. **契约兑现**：每个 Rust 模块兑现第 9 章定义的接口契约
3. **等价测试**：JS 实现通过的测试，Rust 实现等价通过
4. **跨实现互操作**：JS 节点与 Rust 节点互通，验证协议规范的语言无关性

### 5.3 M14：网络层强化

#### 5.3.1 工作项

| 编号 | 工作项 | 优先级 | 说明 |
|---|---|---|---|
| M14-1 | Nym mixnet transport 适配器 | P0 | 第一个非 libp2p transport |
| M14-2 | DID ↔ peerId 解耦 | P0 | DID 在不暴露 peerId 的前提下通信 |
| M14-3 | Eclipse 攻击防御 Rust 强化 | P0 | DHT 邻居多样性硬约束 |
| M14-4 | Katzenpost 适配器 | P1 | Nym 延迟不可接受时的备选 |
| M14-5 | 跨网络联邦协议 | P2 | 多个 Havix 网络互联（FW-04） |

#### 5.3.2 网络层设计原则

1. **不自建 mixnet**：Nym / Katzenpost / Loopix 已解决网络层匿名性，Havix 集成而非重写
2. **transport 可插拔**：通过 TransportAdapter 契约，libp2p / Nym / Katzenpost 作为可选 transport
3. **DID 与传输解耦**：DID 是协议层身份，peerId 是传输层标识，两者不可强绑定
4. **网络层是 H4 验证的前提**：mixnet 集成是 H4（边界可维护）在敌对环境下被验证的必要条件

---

## 6. 阶段四：生态形态（M15+）

### 6.1 阶段目标

在协议稳定后扩展生态能力，进入横向扩展阶段。

### 6.2 候选工作项

| 编号 | 工作项 | 说明 |
|---|---|---|
| M15-1 | 多语言 SDK | Python / Go SDK，对应 FW-04 跨网络联邦 |
| M15-2 | 移动端节点 | 资源受限场景的协议适配 |
| M15-3 | DID 旋转协议 | 主身份密钥泄露后的恢复路径 |
| M15-4 | 多跳 onion transport | 在 Nym 之外的备选深度匿名方案 |

---

## 7. 阶段演进关系

### 7.1 演进原则

- **前一形态是后一形态的基础**：验证形态证明协议业务逻辑可走通，完整化形态在此基础上验证多 App 假设，网络化形态在此基础上验证敌对环境假设
- **前一形态不被否定**：每个形态的协议能力是真实的，后续形态是能力扩展，不是对前形态的修正
- **形态特性自然转化**：前形态的固有特性（如 peerId 可观察）在后形态中自然转化（如 DID 解耦），不是"补丁"或"清偿"

### 7.2 各形态验证的假设

| 假设 | 验证形态 | 完整化形态 | 网络化形态 | 生态形态 |
|---|---|---|---|---|
| H1 身份不可降级 | 部分 | - | 完整 | - |
| H2 价值可闭环 | 完整 | - | - | - |
| H3 治理可问责 | 部分 | 完整 | - | - |
| H4 边界可维护 | 部分 | - | 完整 | - |
| H5 角色可涌现 | - | 完整 | - | - |

---

## 8. 协议安全模型

### 8.1 威胁谱系

Havix 协议面对的威胁是连续谱系：

```
被动观察 → 流量分析 → 节点劫持 → Sybil 注入 → Eclipse 攻击 → BGP 劫持
   ↑              ↑           ↑           ↑            ↑
  弱            中           强           强            极强
```

设计原则：威胁谱系上的每一级都必须有对应的协议层防御。某级防御缺失时，对应的协议假设在该强度下无法验证。

### 8.2 防御分层

| 防御层 | 防御对象 | 当前状态 | 完成形态 |
|---|---|---|---|
| 密码学层 | 消息篡改 / 伪造 / 重放 | 完成 | 验证形态 |
| 行为过滤层 | DoS / 内存膨胀 / 路径穿越 | 完成 | 验证形态 |
| 节点间攻击层 | Sybil / Eclipse / 串谋 / Front-running | 部分完成 | 验证形态 + 完整化形态 |
| 网络层匿名 | 流量分析 / 元数据泄露 | 未开始 | 网络化形态 |
| 物理层防御 | BGP 劫持 / ISP 级观察 | 不在协议范围 | - |

### 8.3 已完成的节点间攻击防护（验证形态）

| 防护 | 位置 | 防御对象 |
|---|---|---|
| canonical message 签名 | `message-types.js` | senderId / type 篡改 |
| credit note 内层签名 + senderId === issuerDid | `s-node.js` | 伪造 issuer |
| InviteToken.verifySelf() | `market.js` | 伪造 invite |
| issuerDid ↔ pubKey 绑定（first-seen wins） | `credit.js` | keypair 旋转攻击 |
| 仲裁 panel 排除 vouch 关联节点 | `arbitration.js` | 直接串谋 |
| gossipsub handler 顶层 try/catch | `s-node.js` | handler 抛错 DoS |
| Set/Map LRU 100K 上限 | 多处 | 内存膨胀 |
| 路径穿越校验 | `config.js` / `state.js` / `web.js` / `app-manager.js` | 任意文件读写 |
| DID / CID JSON API 脱敏 | `Embas/src/web.js` | 身份画像泄露 |
| 自动 abstain 查询已投票 | `Embas/src/timeouts.js` | 覆盖人工投票 |
| escrow mutex + 截断守卫 | `Embas/src/credit-adapter.js` | 双重扣款 / race / 截断 |

---

## 9. 接口契约

Havix 协议规范包含语言无关的接口契约。每个实现语言各自兑现这些契约。契约定义在 M11 完成，Rust 实现在 M13 兑现。

### 9.1 TransportAdapter

```typescript
interface TransportAdapter {
  // 发送 chunk 到目标 DID（不暴露 peerId）
  sendChunk(targetDid: Did, chunk: Uint8Array): Promise<{ relay: Did, sequence: number }>

  // 订阅 topic 消息
  subscribe(topic: Topic, handler: (msg: Message) => void): Subscription

  // 发布 topic 消息
  publish(topic: Topic, msg: Message): Promise<void>

  // DHT 查询（仅公共 CID）
  dhtFind(cid: Cid): Promise<Peer[]>

  // 节点发现
  discover(filter?: DiscoveryFilter): AsyncIterable<Peer>
}
```

- 验证形态实现：libp2p relay
- 网络化形态实现：Nym mixnet 适配器
- 后续实现：Katzenpost 适配器

### 9.2 LedgerStorage

```typescript
interface LedgerStorage {
  get<T>(key: string): Promise<T | null>
  put<T>(key: string, value: T): Promise<void>
  batch<T>(ops: Array<{ type: 'put', key: string, value: T }>): Promise<void>
  range(start: string, end: string): AsyncIterable<{ key: string, value: any }>
}
```

- 验证形态实现：Node.js fs + JSON
- 网络化形态实现：lmdb / sled

### 9.3 CryptoProvider

```typescript
interface CryptoProvider {
  sign(privateKey: PrivateKey, message: Uint8Array): Promise<Signature>
  verify(publicKey: PublicKey, message: Uint8Array, signature: Signature): Promise<boolean>
  encrypt(key: SymmetricKey, plaintext: Uint8Array): Promise<Ciphertext>
  decrypt(key: SymmetricKey, ciphertext: Ciphertext): Promise<Uint8Array>
  hash(data: Uint8Array): Hash
  randomBytes(length: number): Uint8Array
}
```

- 验证形态实现：`@noble/curves` + `@noble/hashes` + node:crypto
- 网络化形态实现：`ed25519-dalek` + `aes-gcm` + `sha2` + `rand_core`

### 9.4 PubSubProvider

```typescript
interface PubSubProvider {
  subscribe(topic: Topic): Promise<void>
  unsubscribe(topic: Topic): Promise<void>
  publish(topic: Topic, message: Uint8Array): Promise<void>
  onMessage(handler: (event: PubSubEvent) => void): void
  getMeshPeers(topic: Topic): Promise<Peer[]>
}
```

- 验证形态实现：libp2p gossipsub
- 网络化形态实现：rust-libp2p gossipsub

---

## 10. 工程约束

### 10.1 测试基线

每阶段的工作必须保持测试基线全过：

| 仓库 | 当前基线 |
|---|---|
| Havix 主仓库 | 1021/1021 |
| Embas | 213/213 |
| 合计 | 1234/1234 |

新增工作项必须配套回归测试。M11 起新增工作项的测试纳入对应仓库的基线。

### 10.2 关键决策

#### 决策 1：完整化形态不启动 Rust 化

依据：完整化形态验证的是协议设计假设（加权转换 + 自然涌现），不是运行时性能。设计假设未被业务证伪前更换实现语言，会让设计验证与材料升级耦合，难以归因。

约束：M11 新增协议代码必须通过第 9 章定义的接口契约组织，不直接依赖 Node.js fs / `@noble/curves` / libp2p 私有 API。

#### 决策 2：不自建 mixnet

依据：Nym / Katzenpost / Loopix 已解决网络层匿名性。Havix 集成而非重写。Havix 团队规模与 mixnet 项目不在同一量级，自建会拖垮协议层进度。

约束：网络层匿名性通过 TransportAdapter 契约集成外部 mixnet 实现。

#### 决策 3：协议规范与实现语言解耦

依据：Havix 协议规范定义语言无关的接口契约。JS 实现是协议在 Node.js 运行时的原生实现，Rust 实现是协议在系统级运行时的原生实现。两者通过协议规范契约保持一致，通过等价测试与跨实现互操作验证。

约束：所有协议层代码必须通过接口契约组织，不直接绑定单一语言的运行时特性。

#### 决策 4：节点间攻击防护是完整化形态必修项

依据：完整化形态验证多 App 共存假设。节点间攻击防护中不依赖 Rust 的部分（Rate limiting / Sybil 防御 / Eclipse 检测 / 串谋统计检测 / 退出惩罚 / Front-running / issue credit 审计）必须在 M11 完成，否则多 App 共存假设的验证不可信。

约束：M11 工作计划必须包含第 4.2.3 节定义的 7 项防护。

#### 决策 5：网络层防御是 H4 验证的前提

依据：H4（边界可维护）在敌对环境下的验证要求网络层不可观察。mixnet 集成是 H4 验证的必要条件，不是工程优化。

约束：M14 必须完成 Nym 适配器与 DID↔peerId 解耦。

#### 决策 6：P2 修复不阻断主线

依据：AUDIT-M10 的 32 项 P2 是可维护性 / 性能 / 文档类，不影响协议设计验证。

约束：P2 在完整化形态与网络化形态按需穿插处理，不安排专门冲刺。例外：与多 App 隔离、审核机制相关的 P2 必须在对应阶段修复。

---

## 11. 假设验证矩阵

### 11.1 当前矩阵

| 假设 | 验证形态 | 完整化形态 | 网络化形态 | 生态形态 |
|---|---|---|---|---|
| H1 身份不可降级 | 部分（context 派生） | - | 完整（DID 解耦） | - |
| H2 价值可闭环 | 完整 | - | - | - |
| H3 治理可问责 | 部分（防直接串谋） | 完整（防间接串谋） | - | - |
| H4 边界可维护 | 部分（应用层签名） | - | 完整（mixnet） | - |
| H5 角色可涌现 | - | 完整（FW-01） | - | - |
| 长跑稳定性 | - | - | 完整（Rust） | - |

### 11.2 验证解读约束

1. **形态内的验证是有效的**：每个形态在自身生态位内的协议假设验证是有效证据，不因后续形态未完成而失效
2. **形态间的验证是递进的**：完整化形态的验证建立在验证形态之上，网络化形态的验证建立在完整化形态之上
3. **跨形态边界需谨慎归因**：如某形态内出现"假设不成立"的结论，需先确认是否因该形态的固有特性导致，而非协议设计本身缺陷

---

## 12. 当前形态特性登记

验证形态下的固有特性登记。这些特性属于该形态的生态位，在后续形态升级时自然转化。

### 12.1 传输层特性

| 特性 | 当前形态 | 后续形态转化 |
|---|---|---|
| peerId ↔ DID 映射在网络层可见 | libp2p relay | 网络化形态引入 mixnet transport + DID 解耦后转化 |
| relay 节点可见两端 peerId | 单跳 relay | 网络化形态 Nym mixnet 替代后转化 |
| 无流量分析防御 | libp2p 原生传输 | 网络化形态 mixnet 集成后转化 |

### 12.2 运行时特性

| 特性 | 当前形态 | 后续形态转化 |
|---|---|---|
| GC 抖动影响仲裁时效 | Node.js 运行时 | 网络化形态 Rust 实现后转化 |
| fs IO 阻塞事件循环 | Node.js fs + JSON | 网络化形态 lmdb / sled 后转化 |
| `@noble/curves` 性能受 JS 约束 | JS 加密库 | 网络化形态 `ed25519-dalek` 后转化 |
| Set/Map LRU 是软限 | JS 数据结构 | 网络化形态 Rust 硬限后转化 |
| libp2p gossipsub 内存特性 | 第三方依赖 | 网络化形态 rust-libp2p 后转化 |

### 12.3 AUDIT-M10 P2 登记

32 项 P2 是可维护性 / 性能 / 文档类。处理策略：

- 完整化形态按需穿插处理与多 App 相关的 P2
- 网络化形态处理与审核机制相关的 P2
- 网络化形态 Rust 化时部分 P2 自然转化（如 JS 特有的类型检查、fs IO 阻塞等）

---

## 13. 内测反馈处理规则

### 13.1 分级处理

| 级别 | 处理时机 | 处理方式 |
|---|---|---|
| P0（阻断内测） | 立即 | 修复 + 回归测试 + 当天 commit |
| P1（影响功能） | M11 启动时 | 登记到 AUDIT-M11，优先处理 |
| P2（体验/文档） | 按需 | 登记到 AUDIT-M11，穿插处理 |
| 设计层质疑 | M11 设计阶段 | 单独开 issue，协议设计讨论 |

### 13.2 解读约束

1. 不能因验证形态的固有特性判定协议假设被证伪：如反馈涉及敌对环境、长跑稳定性、网络层观察，需先确认是否因形态固有特性导致
2. 不能因单次跑测失败判定协议设计错误：需区分"协议设计问题"与"实现 bug"
3. 设计层质疑需进入协议规范讨论：不在内测期做决定，登记后等 M11 设计阶段处理

---

## 14. 内测结束后的启动检查清单

内测结束、启动 M11 前确认：

- [ ] 内测发现的所有 P0 已修复
- [ ] P1 已登记到 AUDIT-M11
- [ ] P2 已分类（完整化形态穿插 / 网络化形态处理 / 自然转化）
- [ ] M11 三个 App 设计文档已起草（教学市场 / 维基 App / 加权转换协议）
- [ ] FW-01 自然涌现算法 v0 设计文档已起草
- [ ] 第 9 章定义的 4 个接口契约已在代码中实现接口定义
- [ ] 节点间攻击防护 7 项 M11 必修已排入 M11 工作计划
- [ ] 假设验证矩阵已更新

---

## 15. 参考文档

### 15.1 Havix 项目内

- [技术白皮书](./Havix-Technical-Whitepaper.md) —— 协议规范
- [AUDIT-M10.md](./AUDIT-M10.md) —— 全栈审计报告
- [README.md](./README.md) —— 项目概览
- [DEPLOY.md](./DEPLOY.md) —— 部署运行
- [ROADMAP.md](./ROADMAP.md) —— M9–M12 阶段路线
- [PROJECT-SUMMARY.md](./PROJECT-SUMMARY.md) —— M10 完结快照

### 15.2 外部参考

- Nym mixnet: https://nymtech.net/
- Katzenpost: https://katzenpost.mixnetworks.org/
- Loopix: https://arxiv.org/abs/1703.00536
- Dovetail / PBACN: 分层覆盖匿名通信网络相关论文

---

*本文档定义 Havix 协议的迭代开发路径。每个阶段对应一个协议形态，是该阶段的生态位。形态之间存在演进关系，前一形态是后一形态的基础。*
