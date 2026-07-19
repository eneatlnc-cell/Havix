# Havix 协议开发规划

> 本文档定义 Havix 协议从当前阶段到完整形态的开发路径。
> M1–M10 已完成的部分是协议的参考实现与验证工具，不是协议本身。
> 从 M11 开始，Havix 协议进入实质构建阶段。
>
> 最近更新：2026-07-19

---

## 一、Havix 协议定位

Havix 是一个去中心化对等网络协议，目标是验证社会学论文《底层高认知者的结构性困境》提出的分层自组织网络假设。

### 协议要回答的问题

1. **身份不可降级**：在多方协作中，个体能否保持多 context 子身份的独立性，不被强迫合并为单一身份
2. **价值可闭环**：高认知个体的认知产出能否通过协议内信用体系完成价值闭环，不依赖外部法币通道
3. **治理可问责**：在无中心仲裁者的情况下，违约行为能否被临时仲裁团处理，且裁决能自执行
4. **边界可维护**：在观察者存在的前提下，私域协作空间能否维持可见性边界，不被强行穿透
5. **角色可涌现**：在长跑稳定状态下，节点角色能否通过加权转换自然分化，而非外部指定

### 协议不回答的问题

- 网络层的绝对匿名（这是 mixnet 的领域，Havix 集成而非重写）
- 链上治理代币与交易所经济（Havix 信用不可跨协议流通）
- 替代任何现实法律或主权治理
- 任何特定政治诉求的表达

### 协议与参考实现的关系

```
┌──────────────────────────────────────────────┐
│           Havix 协议规范（语言无关）           │
│  身份派生规则 / 信用账本不变量 / 仲裁状态机 / │
│  双平面隔离原则 / 加权转换算法                │
└──────────────────┬───────────────────────────┘
                   │ 参考实现
┌──────────────────┴───────────────────────────┐
│  JS 实现（M1–M10，当前）                       │
│  Node.js + libp2p + @noble/curves + fs       │
│  用途：验证协议业务逻辑、跑通端到端流程         │
└──────────────────┬───────────────────────────┘
                   │ 材料升级
┌──────────────────┴───────────────────────────┐
│  Rust 实现（M13+）                             │
│  rust-libp2p + ed25519-dalek + lmdb          │
│  + Nym mixnet transport 适配器                │
│  用途：长跑稳定、敌对环境验证、生产部署        │
└──────────────────────────────────────────────┘
```

**关键原则**：协议规范在参考实现之上，参考实现的局限不等于协议的局限。当 JS 实现无法验证某项协议假设时，应明确登记"该假设待 Rust 实现验证"，而非判定协议假设被证伪。

---

## 二、阶段划分

### M1–M10：参考实现与验证（已完成）

| 阶段 | 主题 | 性质 |
|---|---|---|
| M1–M7 | 协议层 MVP：identity / credit / vouch / wiki / market / tunnel / arbitration | 协议能力的最小可运行实现 |
| M8 | 持久化 + CLI 收口 + 4 节点集成测试 | 让参考实现能长跑 |
| M8 审计 | 6 P0 + 6 P1 + 3 P2 修复 | 参考实现的密码学与健壮性回归 |
| M9 | App SDK + Manifest 规范 | 把协议能力封装为 App 可调用接口 |
| M9.5 | 空应用参考模板 | 最小 App 骨架 |
| M9.6 | 安全加固第一步 | App 加载层路径穿越 / 跨 App 隔离 / 准入校验 |
| M10 | 翻译市场 App Embas | 第一个端到端参考 App |
| AUDIT-M10 | 5 P0 + 15 P1 修复（已完成）+ 32 P2（待处理） | 全栈安全加固 |

**M1–M10 的产出本质**：一套协议参考实现，验证了协议的业务逻辑可走通。**这不是 Havix 协议本身**，是验证工具。

### M11：多 App 共存与加权转换

**目标**：在协议层验证加权转换假设（FW-01），让多个 App 共存于同一节点，节点角色通过 trustWeight 加权自然涌现。

#### 工作项

| 编号 | 工作项 | 产出 |
|---|---|---|
| M11-1 | 第二个参考 App：教学市场（context-B 消费型 + 转账型） | 验证 SDK 在第二个 App 上的通用性 |
| M11-2 | 第三个参考 App：维基编辑（context-D 签发型） | 验证多 context 共存 |
| M11-3 | 加权转换协议 | 跨 App credit 流转 + trustWeight 加权记账 |
| M11-4 | FW-01 自然涌现算法 v0 | 节点角色涌现的算法实现与仿真 |
| M11-5 | 抽象接口预留（为 M13 Rust 化） | TransportAdapter / LedgerStorage / CryptoProvider / PubSubProvider 接口定义 |

#### 协议假设验证目标

| 假设 | M11 是否验证 | 备注 |
|---|---|---|
| 加权转换能涌现角色分工（FW-01） | ✅ | 业务逻辑层验证 |
| 多 App 共存时 App 间隔离不破 | ✅ | 需 M11-1 / M11-2 / M11-3 共同验证 |
| 仲裁 slash 在多 App 间不被滥用 | ✅ | 需配套 M11 节点间攻击防护 |

### M12：网络效应与 App 准入

**目标**：建立 App 注册中心与第三方 App 准入流程，让 Havix 从"内置 App 协议"过渡到"开放生态协议"。

#### 工作项

| 编号 | 工作项 | 产出 |
|---|---|---|
| M12-1 | App 注册中心 | 全局 App 目录 + 版本管理 + 跨节点同步 |
| M12-2 | Manifest 审核流程 | 第三方 App 准入机制（白皮书 §8.4） |
| M12-3 | App 信任权重动态调整 | trustWeight 根据历史表现调整 |
| M12-4 | App 生命周期管理 | 安装 / 升级 / 卸载 / 数据迁移 |
| M12-5 | 第三方 App 沙箱执行 | 隔离第三方 App 对节点进程的影响 |

#### 协议假设验证目标

| 假设 | M12 是否验证 | 备注 |
|---|---|---|
| 开放准入下协议假设不崩 | ✅ | 需配套 M12 Sybil 防御强化 |
| App 信任权重抗操纵 | ✅ | 需 M12-3 |

### M13：Rust 协议层实现

**目标**：将 Havix 协议核心用 Rust 重新实现，作为长跑稳定与敌对环境验证的基础。

#### 工作项

| 编号 | 工作项 | 优先级 | 说明 |
|---|---|---|---|
| M13-1 | credit / reputation ledger Rust 移植 | P0 | 加权转换核心，最先移植 |
| M13-2 | arbitration Rust 移植 | P0 | 长跑稳定性要求最高 |
| M13-3 | identity / 签名 Rust 移植 | P0 | `ed25519-dalek` 替换 `@noble/curves` |
| M13-4 | market Rust 移植 | P1 | 业务复杂但性能要求中等 |
| M13-5 | wiki Rust 移植 | P2 | 业务简单，最后移植 |
| M13-6 | 存储后端替换 | P0 | JSON → lmdb / sled，通过 LedgerStorage 抽象 |
| M13-7 | rust-libp2p 集成 | P0 | 替换 Node.js libp2p |

#### 移植原则

1. **协议规范冻结**：M13 期间不改协议设计，只做材料替换
2. **抽象接口兑现**：M11 定义的四个抽象接口在 M13 各自得到 Rust 实现
3. **等价测试**：所有 JS 实现通过的测试，在 Rust 实现下等价通过
4. **跨实现互操作**：JS 节点与 Rust 节点能互通（验证协议规范的语言无关性）

### M14：网络层强化

**目标**：让 Havix 协议的边界维护能力从"应用层签名"升级到"网络层不可观察"，使协议假设能在敌对环境下被验证。

#### 工作项

| 编号 | 工作项 | 优先级 | 说明 |
|---|---|---|---|
| M14-1 | Nym mixnet transport 适配器 | P0 | 第一个非 libp2p transport |
| M14-2 | DID ↔ peerId 解耦 | P0 | 让 DID 在不暴露 peerId 的前提下通信 |
| M14-3 | Eclipse 攻击防御 Rust 强化 | P0 | DHT 邻居多样性约束 |
| M14-4 | Katzenpost 适配器 | P1 | Nym 延迟不可接受时的备选 |
| M14-5 | 跨网络联邦协议 | P2 | 多个 Havix 网络互联（FW-04） |

#### 网络层设计原则

1. **不自建 mixnet**：Nym / Katzenpost / Loopix 已解决网络层匿名性，Havix 集成而非重写
2. **transport 可插拔**：通过 TransportAdapter 抽象，让 libp2p / Nym / Katzenpost 作为可选 transport
3. **DID 与传输解耦**：DID 是协议层身份，peerId 是传输层标识，两者不可强绑定
4. **网络层是协议假设验证的地基**：mixnet 不是工程优化，是让"边界维护"假设能被验证的前提

### M15+：生态扩展

**目标**：在协议稳定后扩展生态能力，进入横向扩展阶段。

#### 候选工作项

| 编号 | 工作项 | 说明 |
|---|---|---|
| M15-1 | 多语言 SDK | Rust / Python / Go SDK，对应 FW-04 跨网络联邦 |
| M15-2 | 移动端节点 | 资源受限场景的协议适配 |
| M15-3 | DID 旋转协议 | 主身份密钥泄露后的恢复路径 |
| M15-4 | 多跳 onion transport | 在 Nym 之外的备选深度匿名方案 |

---

## 三、协议安全模型

### 威胁谱系

Havix 协议面对的威胁是连续的谱系，不是离散的两类：

```
被动观察 → 流量分析 → 节点劫持 → Sybil 注入 → Eclipse 攻击 → BGP 劫持
   ↑              ↑           ↑           ↑            ↑
  弱            中           强           强            极强
```

**设计原则**：威胁谱系上的每一级都必须有对应的协议层防御。当某一级防御缺失时，对应的协议假设无法被验证。

### 防御分层

| 防御层 | 防御对象 | 当前状态 | 完成阶段 |
|---|---|---|---|
| 密码学层 | 消息篡改 / 伪造 / 重放 | ✅ 完成（M8 审计 + AUDIT-M10） | M1–M10 |
| 行为过滤层 | DoS / 内存膨胀 / 路径穿越 | ✅ 完成（M9.6 + AUDIT-M10） | M9.6 + AUDIT-M10 |
| 节点间攻击层 | Sybil / Eclipse / 串谋 / Front-running | ⏳ 部分缺失 | M11 / M12 |
| 网络层匿名 | 流量分析 / 元数据泄露 | ❌ 缺失 | M14 |
| 物理层防御 | BGP 劫持 / ISP 级观察 | ❌ 不在 Havix 范围 | 协议外 |

### 节点间攻击防护清单

#### 已完成（M1–M10）

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

#### M11 必修

| 防护 | 位置 | 防御对象 |
|---|---|---|
| Rate limiting | `s-node.js` `_pubsubHandler` | 高频消息 CPU 耗尽 |
| Sybil 防御加强 | `vouch.js` + `arbitration.js` | 慢速累积 vouch 入 panel |
| Eclipse 攻击检测 | `network/dht.js` | DHT 邻居被控制 |
| 仲裁员串谋统计检测 | `arbitration.js` | 间接串谋（无 vouch 关联但合谋） |
| 仲裁员中途退出惩罚 | `arbitration.js` + `timeouts.js` | 恶意 abstain 拖垮裁决 |
| Front-running commit-reveal | `market.js` | 抢订单时序攻击 |
| issue credit 反向审计 | `credit.js` | issuer 主动作恶 |

#### M12 必修

| 防护 | 位置 | 防御对象 |
|---|---|---|
| App 准入场景 Sybil 强化 | App 注册中心 | 第三方 App 注入恶意节点 |
| vouch 质量加权 | `vouch.js` | 低质量 vouch 灌水 |

#### M13 Rust 化必修

| 防护 | 位置 | 防御对象 |
|---|---|---|
| Nym mixnet transport | `network/tunnel.js` 适配器 | 流量分析 |
| DID ↔ peerId 解耦 | `s-node.js` + transport 层 | peerId 可观察建立 DID 映射 |
| Eclipse 攻击 Rust 强化 | `network/dht.js` Rust 版 | DHT 邻居多样性硬约束 |

#### M14+ 暂不处理

| 防护 | 说明 |
|---|---|
| Katzenpost 适配器 | Nym 备选方案，延迟不可接受时启用 |
| 多跳 onion transport | 协议假设验证不依赖此项 |

---

## 四、假设验证覆盖度

### 当前覆盖度（M1–M10 完成后）

| 协议假设 | JS 实现验证状态 | 完整验证条件 |
|---|---|---|
| 加权转换涌现角色分工（FW-01） | ⏳ 待 M11 | 不依赖网络层，M11 可完整验证 |
| 多 App 共存时 App 间隔离 | ⏳ 待 M11 | 不依赖网络层，M11 可完整验证 |
| 仲裁 slash 防滥用 | ⚠️ 部分验证 | M11 加串谋统计检测后完整 |
| 私域市场双重加密防冒充 | ✅ 已验证 | 不依赖网络层 |
| 身份不可降级（context 独立性） | ⚠️ 部分验证 | M14 DID↔peerId 解耦后完整 |
| 信誉不可降级 | ⚠️ 部分验证 | M11 Sybil 防御 + M14 mixnet 后完整 |
| 边界可维护（敌对环境下） | ❌ 无法验证 | M14 mixnet + DID 解耦后 |
| 长跑稳定性 | ❌ 无法验证 | M13 Rust 实现后 |

### 验证原则

1. **JS 实现的局限不等于协议假设的局限**：当 JS 实现无法验证某项假设时，登记为"待 M13/M14 验证"，不判定协议假设被证伪
2. **协议假设验证需要完整的威胁谱系防御**：敌对环境验证必须在 M11 节点间攻击防护 + M14 网络层匿名都完成后才能进行
3. **内测反馈的解读**：如内测中出现"假设不成立"的结论，需先确认是否因防御缺失导致，而非协议假设本身缺陷

---

## 五、抽象接口设计（M11 预留，M13 兑现）

为让 M13 Rust 实现能无痛接管 JS 实现的业务逻辑，M11 期间定义以下四个抽象接口。**M11 只定义接口，不实现 Rust 版本**。

### TransportAdapter

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

**默认实现**：libp2p relay（M1–M10 现状）
**M14 实现**：Nym mixnet 适配器
**M14+ 实现**：Katzenpost 适配器

### LedgerStorage

```typescript
interface LedgerStorage {
  // 原子读
  get<T>(key: string): Promise<T | null>

  // 原子写
  put<T>(key: string, value: T): Promise<void>

  // 批量原子写
  batch<T>(ops: Array<{ type: 'put', key: string, value: T }>): Promise<void>

  // 范围查询
  range(start: string, end: string): AsyncIterable<{ key: string, value: any }>
}
```

**默认实现**：Node.js fs + JSON（M1–M10 现状）
**M13 实现**：lmdb / sled

### CryptoProvider

```typescript
interface CryptoProvider {
  // Ed25519 签名
  sign(privateKey: PrivateKey, message: Uint8Array): Promise<Signature>

  // Ed25519 验签
  verify(publicKey: PublicKey, message: Uint8Array, signature: Signature): Promise<boolean>

  // AES-GCM 加密
  encrypt(key: SymmetricKey, plaintext: Uint8Array): Promise<Ciphertext>

  // AES-GCM 解密
  decrypt(key: SymmetricKey, ciphertext: Ciphertext): Promise<Uint8Array>

  // SHA-256 哈希
  hash(data: Uint8Array): Hash

  // 随机数生成
  randomBytes(length: number): Uint8Array
}
```

**默认实现**：`@noble/curves` + `@noble/hashes` + node:crypto（M1–M10 现状）
**M13 实现**：`ed25519-dalek` + `aes-gcm` + `sha2` + `rand_core`

### PubSubProvider

```typescript
interface PubSubProvider {
  // 订阅 topic
  subscribe(topic: Topic): Promise<void>

  // 取消订阅
  unsubscribe(topic: Topic): Promise<void>

  // 发布消息
  publish(topic: Topic, message: Uint8Array): Promise<void>

  // 注册消息处理器
  onMessage(handler: (event: PubSubEvent) => void): void

  // 获取 mesh 对等节点
  getMeshPeers(topic: Topic): Promise<Peer[]>
}
```

**默认实现**：libp2p gossipsub（M1–M10 现状）
**M13 实现**：rust-libp2p gossipsub

---

## 六、待处理债务

### AUDIT-M10 P2（32 项）

可维护性 / 性能 / 文档类。处理策略：

- **M11 阶段**：按需穿插处理与多 App 相关的 P2
- **M12 阶段**：处理与审核机制相关的 P2
- **M13 Rust 化**：大部分 P2 自然消失（如 JS 特有的类型检查、fs IO 阻塞等）

### JS 实现层债务（M13 Rust 化时清偿）

| 债务 | 位置 | Rust 化方案 |
|---|---|---|
| peerId↔DID 绑定可观察 | `s-node.js` start() | TransportAdapter + M14 Nym |
| GC 抖动影响仲裁时效 | `arbitration.js` | Rust 原生线程 |
| fs IO 阻塞事件循环 | `persistence.js` | lmdb / sled |
| Set/Map LRU 是软限 | 多处 | Rust 硬限 + 编译期检查 |
| `@noble/curves` 性能 | `identity.js` | `ed25519-dalek` |
| libp2p gossipsub 内存泄漏 | 第三方依赖 | rust-libp2p |

---

## 七、内测反馈处理规则

内测期间发现的问题按以下规则分类处理：

| 级别 | 处理时机 | 处理方式 |
|---|---|---|
| P0（阻断内测） | 立即 | 修复 + 回归测试 + 当天 commit |
| P1（影响功能） | M11 启动时 | 登记到 AUDIT-M11，优先处理 |
| P2（体验/文档） | 按需 | 登记到 AUDIT-M11，穿插处理 |
| 设计层质疑 | M11 设计阶段 | 单独开 issue，协议设计讨论 |

### 内测反馈的解读约束

1. **不能因 JS 实现的局限判定协议假设被证伪**：如反馈涉及敌对环境、长跑稳定性、网络层观察，需先确认是否因防御缺失导致
2. **不能因单次跑测失败判定协议设计错误**：需区分"协议设计问题"与"参考实现 bug"
3. **设计层质疑需进入协议规范讨论**：不在内测期做决定，登记后等 M11 设计阶段处理

---

## 八、关键决策

### 决策 1：M11 不启动 Rust 化

M11 的核心是验证协议设计假设（加权转换 + 自然涌现），不是性能优化。在假设未被业务证伪前换语言，等于在未验证地基的房子上换屋顶。

替代方案：所有新增协议代码通过抽象层为 M13 Rust 化留接口。

### 决策 2：不自建 mixnet

Nym / Katzenpost / Loopix 已解决网络层匿名性。Havix 集成而非重写。Havix 团队规模与 mixnet 项目不在同一量级，自建会拖垮协议层进度。

替代方案：通过 TransportAdapter 抽象让 mixnet 可插拔，M14 实现 Nym 适配器作为第一个非 libp2p transport。

### 决策 3：协议规范与参考实现分离

协议规范是语言无关的，参考实现的局限不等于协议的局限。JS 实现无法验证的协议假设，登记为"待 Rust 实现验证"，不判定协议假设被证伪。

### 决策 4：节点间攻击防护是 M11 必修项

节点间攻击防护中不依赖 Rust 的部分（Rate limiting / Sybil 防御 / Eclipse 检测 / 串谋统计检测 / 退出惩罚 / Front-running / issue credit 审计），M11 必须完成。否则 M11 多 App 共存假设的验证本身不可信。

### 决策 5：网络层防御是协议假设验证的地基

mixnet 不是工程优化，是让"边界维护"假设能被验证的前提条件。M14 Nym 适配器与 DID↔peerId 解耦是协议假设完整验证的必要条件，不是可选项。

### 决策 6：P2 修复不阻断主线

P2 是可维护性 / 性能 / 文档类，不影响协议设计验证。在 M11–M12 按需穿插，不安排专门冲刺。例外：与多 App 隔离、审核机制相关的 P2 必须在对应阶段修复。

---

## 九、内测结束后的启动检查清单

内测结束、启动 M11 前确认：

- [ ] 内测发现的所有 P0 已修复
- [ ] P1 已登记到 AUDIT-M11
- [ ] P2 已分类（M11 穿插 / M12 处理 / M13 自然消失）
- [ ] M11 三个 App 设计文档已起草（教学市场 / 维基 App / 加权转换协议）
- [ ] FW-01 自然涌现算法 v0 设计文档已起草
- [ ] 四个抽象接口（TransportAdapter / LedgerStorage / CryptoProvider / PubSubProvider）已在文档中定义
- [ ] 节点间攻击防护 7 项 M11 必修已排入 M11 工作计划
- [ ] 假设验证覆盖度表已更新

---

## 十、参考文档

### Havix 项目内

- [技术白皮书](./Havix-Technical-Whitepaper.md) —— 协议规范
- [AUDIT-M10.md](./AUDIT-M10.md) —— 全栈审计报告
- [README.md](./README.md) —— 项目概览
- [DEPLOY.md](./DEPLOY.md) —— 部署运行
- [ROADMAP.md](./ROADMAP.md) —— M9–M12 阶段路线
- [PROJECT-SUMMARY.md](./PROJECT-SUMMARY.md) —— M10 完结快照

### 外部参考

- Nym mixnet: https://nymtech.net/
- Katzenpost: https://katzenpost.mixnetworks.org/
- Loopix: https://arxiv.org/abs/1703.00536
- Dovetail / PBACN: 分层覆盖匿名通信网络相关论文

---

*本文档定义 Havix 协议从参考实现到完整形态的工程路径。各阶段工作项的具体设计文档在各阶段启动时单独起草。*
