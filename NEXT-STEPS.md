# Havix L0 网络本体开发规划

> 本文档定义 Havix L0 网络本体的开发路径。
> 采用递归结构组织：从三层 ASI 基础设施整体定位出发，逐层展开到 L0 协议形态、阶段、工作项、横切关注点、当前可操作项。
> 任何位置都能定位"当前在哪、下一步往哪去、要做什么"。
>
> 最近更新：2026-08-03

---

## 0. 文档定位

本文档是 Havix L0 网络本体的工程参考，作为 M11 起所有后续工作的锚点。当前代码库即 Havix L0 网络本体本身，M1–M10 已交付 L0 验证形态，本文档只作阶段定位引用，不重复展开 M1–M10 细节。

文档结构（递归展开）：

- **Layer 0**：三层 ASI 基础设施定位（第 1 章）
- **Layer 1**：L0 协议形态与阶段划分（第 2 章）
- **Layer 2**：每阶段的工作项（第 3–6 章）
- **Layer 3**：横切关注点（第 7–11 章：阶段演进 / 安全模型 / 接口契约 / 工程约束 / 假设验证矩阵）
- **Layer 4**：当前形态特性登记（第 12 章）
- **Layer 5**：当前可操作项（第 13–14 章：内测反馈 / 启动检查清单）

---

## 1. Havix L0 网络本体

### 1.1 三层 ASI 基础设施

Havix 是三层 ASI（Artificial Sovereign Intelligence）基础设施的 L0 网络本体。三层各自承担一类主权边界，通过 4-context DID 在协议层硬性切分：

```
┌─────────────────────────────────────────────────────────────┐
│  L2  Aether    │  链上治理层                                  │
│                │  治理参与主权（context-D）                    │
│                │  共识 / 链上账本 / 投票协议 / 宪章演化决策      │
├────────────────┼─────────────────────────────────────────────┤
│  L1  Germ      │  认知执行层                                  │
│                │  认知执行主权（context-B 左脑 / context-C 右脑）│
│                │  认知算法 / 推理 / 左右脑协作                  │
├────────────────┼─────────────────────────────────────────────┤
│  L0  Havix     │  网络本体层（本文档对象）                    │
│                │  物理锚定主权（context-A）                    │
│                │  传输 / 身份派生 / 信用账本基底 / 红线拦截 /    │
│                │  活宪章存储                                   │
└─────────────────────────────────────────────────────────────┘
```

| 层 | 主权类型 | 4-context DID | 协议层职责 | 实现仓库 |
|---|---|---|---|---|
| L0 Havix | 物理锚定主权 | A | 网络基底、传输、身份派生、信用账本基底、红线拦截、活宪章存储 | Havix（本仓库） |
| L1 Germ | 认知执行主权 | B（左脑）/ C（右脑） | 认知算法、推理执行、左右脑协作 | Germ |
| L2 Aether | 治理参与主权 | D | 共识、链上账本、投票协议、宪章演化决策 | Aether |

### 1.2 L0 协议定位

Havix L0 是三层架构的网络基底。L0 不实现认知算法（属 L1）、不实现共识与链上账本（属 L2），但 L0 提供让 L1 认知执行与 L2 链上治理得以锚定、传输、结算、约束的全部协议层能力。

L0 协议主张：高认知个体的认知产出（L1）与治理参与（L2）能否长期稳定存在，取决于网络基底是否提供物理锚定、行为掩护、价值结算与红线保护。L0 的工程目标是构建并验证这个基底。

### 1.3 主权边界

三层各自对应一类主权边界，主权边界是协议设计起点：

| 主权类型 | 所属层 | 内涵 | L0 提供的支持 |
|---|---|---|---|
| 物理锚定主权 | L0 | 个体在网络中的物理存在不可被替代或降级 | 4-context DID 主私钥 + Ed25519 签名 + libp2p peerId 绑定 |
| 认知执行主权 | L1 | 个体对自身认知产出的执行不可被劫持 | context-B/C 子身份派生 + 传输层掩护 + 信用结算基底 |
| 治理参与主权 | L2 | 个体对治理提案的参与不可被绕过 | context-D 子身份 + 红线拦截器 + 活宪章存储 |

### 1.4 4-context DID 与三层映射

4-context DID 是 L0 的原生身份结构，密码学上即三层架构的硬性切分。主 DID 派生 4 个子身份，每个子身份锚定到对应层：

```
主 DID (mainKey, Ed25519)
    │
    ├── HKDF(mainKey, "context-A")  →  L0 物理锚定身份（公开层消息签名、网络参与）
    ├── HKDF(mainKey, "context-B")  →  L1 左脑认知执行身份（分析型认知产出）
    ├── HKDF(mainKey, "context-C")  →  L1 右脑认知执行身份（协作型认知产出）
    └── HKDF(mainKey, "context-D")  →  L2 治理参与身份（投票、宪章演化）
```

| Context | 所属层 | 验证形态实现 | 形态本质 |
|---|---|---|---|
| A | L0 | 公开畅游 / 心跳 / 邻居发现 | L0 网络参与的物理锚定 |
| B | L1 左脑 | 市场参与（Embas 翻译市场） | L1 分析型认知执行（市场交易是左脑分析型认知的验证形态） |
| C | L1 右脑 | 私聊隧道 / 私域协调 | L1 协作型认知执行（私域协调是右脑协作型认知的验证形态） |
| D | L2 | 维基编辑（vouch 准入 + 版本链） | L2 治理参与的种子形态（协作记录编辑是治理参与的验证形态） |

4 个子身份在密码学上不可关联，是三层架构在身份层的原生切分。M11 不新增三层身份支持，而是将这一原生切分形式化为 L1/L2 接入契约（详见第 9 章）。

### 1.5 推理即身份

L1 的认知产出（推理）是个体物理身份的可验证投影。L0 通过物理锚定主权为推理即身份提供基础：

- L0 主 DID 是个体在网络中的物理身份（Ed25519 主私钥 + libp2p peerId）
- L1 context-B/C 子身份由主 DID 经 HKDF 单向派生，认知产出的签名可验证地锚定到 L0 物理身份
- L0 的传输层掩护让认知产出的行为模式不被观察者分辨，但身份锚定关系在协议层始终成立
- L1 认知产出通过 L0 信用账本基底结算，结算凭据即认知产出的身份锚定证明

约束：L1 任何认知产出都必须通过 context-B/C 子身份签名，签名验证通过即证明该产出锚定到对应 L0 物理身份。L0 不验证认知内容，只验证身份锚定。

### 1.6 红线拦截器

红线拦截器是 L0 传输层的原生能力，保护 L2 治理参与主权不被绕过。任何威胁 L2 治理的提案在 L0 传输层被强制拦截，转交 L2 链上投票，不进入自动执行路径。

```
提案提交
   │
   ▼
L0 红线拦截器评估
   │
   ├── 未触及红线 ──► 自动执行路径（99.9%）
   │
   └── 触及红线 ──► 强制转交 L2 链上投票路径（0.1%）
                        │
                        ▼
                   L2 Aether 投票
                        │
                        ▼
                   投票结果回写 L0
```

红线判定规则存于活宪章与 business_rules.json，L0 传输层强制执行。红线拦截器是 L0 → L2 的保护机制，确保治理参与主权在协议层不被绕过。

### 1.7 活宪章与自动执行

活宪章定义治理原则，是 L2 治理的协议层锚点。活宪章通过演化机制持续生长，业务规则与宪章原则分离：

| 组件 | 内容 | 存储位置 | 演化机制 |
|---|---|---|---|
| 活宪章 | 治理原则（不可降级 / 治理可问责 / 边界可维护等） | L0 CharterStore | 经 L2 链上投票演化 |
| 业务规则 | 可变业务参数（红线阈值 / 信誉门槛 / 仲裁规模等） | business_rules.json | 多数自动调整 / 关键项走 L2 |

自动执行与链上投票的切分：

- **99.9% 普通变更**：自动执行，不触发 L2 链上投票（业务规则调整、信誉参数微调、App 准入常规审核等）
- **0.1% 关键变更**：红线拦截器判定触及红线，强制转交 L2 链上投票（宪章演化、红线规则修改、仲裁规则根本变更等）

L0 提供活宪章与业务规则的存储与查询能力，演化决策由 L2 做出。L0 是活宪章的载体与执行者，不是决策者。

### 1.8 协议要回答的问题

L0 协议要回答的问题在三层架构下重新表述：

| 编号 | 假设 | L0 视角表述 |
|---|---|---|
| H1 | 身份不可降级 | L0 物理锚定主权下，4-context 子身份能否在多方协作中保持独立性且行为不被观察者关联 |
| H2 | 价值可闭环 | L0 信用账本基底能否让 L1 认知产出与 L2 治理参与通过协议内信用完成价值闭环 |
| H3 | 治理可问责 | L0 红线拦截器与活宪章能否让违约行为被临时仲裁团处理并自执行，关键变更不被绕过 |
| H4 | 边界可维护 | L0 传输层掩护能否在观察者存在前提下维持 L1 认知协作与 L2 治理参与的可见性边界 |
| H5 | 角色可涌现 | L0 信用加权能否让节点角色在长跑稳定状态下通过加权转换自然分化 |

### 1.9 协议性质

Havix L0 是**主权边界协议**，不是匿名协议。

| 维度 | 匿名协议 | Havix L0 |
|---|---|---|
| 要解决的问题 | 谁和谁通信不可追踪 | 边界内的 L1 认知协作与 L2 治理参与不被外部识别 |
| DID 角色 | 隐藏 | 主权身份，可见但不可降级 |
| 解法 | 重写传输层 | 协议层掩护流量 + 红线拦截 + 活宪章存储 |

4-context DID 分层、双平面隔离、四层协议栈是**主权结构**：DID 可见、身份可识别、协作可建立，但主权边界内的行为不被观察者分辨。

### 1.10 不在 L0 协议范围

- L1 认知算法本身（Germ 拥有，L0 只提供身份锚定与传输基底）
- L2 共识协议与链上账本本身（Aether 拥有，L0 只提供红线拦截与宪章存储）
- 链上治理代币与交易所经济（L0 信用不可跨协议流通）
- 替代任何现实法律或主权治理
- 任何特定政治诉求的表达
- 主权身份的完全隐藏（L0 主张主权可见，行为不可观察）

### 1.11 协议形态

L0 网络本体通过迭代开发逐层展开。每个阶段对应一个协议形态，是该阶段 L0 的真实形态：

| 阶段 | 形态 | L0 在该形态的本质 |
|---|---|---|
| M1–M10 | 验证形态 | L0 网络本体在验证形态：4-context DID 已原生切分三层，单 App（Embas）作为 L1 左脑认知执行的验证形态种子 |
| M11–M12 | 完整化形态 | L0 网络本体在完整化形态：原生暴露 L1/L2 接入契约，多 App 共存验证 L1 多 context 共存 |
| M13–M14 | 网络化形态 | L0 网络本体在网络化形态：Rust 实现 + Cover Traffic 协议提供主权边界掩护 |
| M15+ | 生态形态 | L0 网络本体在生态形态：多语言 SDK + 跨网络联邦 |

每个形态是 L0 网络本体在该阶段的真实形态，不是"未达成的残缺形态"。形态之间存在演进关系，前一形态是后一形态的基础，不是被否定的过渡。

---

## 2. 阶段划分

### 2.1 总览

```
阶段一（验证形态）        阶段二（完整化形态）        阶段三（网络化形态）      阶段四（生态形态）
M1 ─── M10 ──────────►  M11 ─── M12 ────────►  M13 ─── M14 ────────►  M15+ ───►
                            │                      │                      │
                            ▼                      ▼                      ▼
                    L1/L2 接口原生暴露         Rust 实现               多语言 SDK
                    多 App 共存                Cover Traffic           跨网络联邦
                    加权转换                   主权边界掩护             移动端
                    红线拦截器实现             观察者攻击防御
                    活宪章 + business_rules
```

### 2.2 当前位置

**当前处于 L0 验证形态完结点，进入内测阶段。**

- 验证形态（M1–M10）已交付
- 测试基线：MVP 1021/1021 + Embas 213/213 = 1234/1234
- Git 状态：主仓库 `d9a6190` / Embas `0353920`
- 安全加固：M8 审计 + M9.6 + AUDIT-M10 全部 P0 + P1 已完成
- 4-context DID 已原生切分三层（context-A/B/C/D 已对应 L0/L1 左脑/L1 右脑/L2）
- 进入内测，等待内测反馈后启动 M11

---

## 3. 阶段一：验证形态（M1–M10，已完成）

### 3.1 阶段目标

验证 L0 网络本体业务逻辑可走通。让 L0 所有核心模块（identity / credit / vouch / wiki / market / tunnel / arbitration）以最小可运行形态存在，并通过 Embas 翻译市场跑通 L1 左脑认知执行的端到端流程。

### 3.2 工作项

| 阶段 | 主题 | 产出 |
|---|---|---|
| M1–M7 | L0 协议层 MVP | identity / credit / vouch / wiki / market / tunnel / arbitration 协议能力 |
| M8 | 持久化 + CLI + 4 节点集成 | 6 registry 持久化 + 原子写 + start/stop 顺序 |
| M8 审计 | 安全回归 | 6 P0 + 6 P1 + 3 P2 修复（签名覆盖 / note 内层验签 / topic 分流 / InviteToken / gossipsub try-catch / slash 守卫等） |
| M9 | App SDK | Havix SDK 11 模块 + AppManifest 规范 |
| M9.5 | App 参考模板 | apps/empty-app 最小骨架 |
| M9.6 | App 加载层加固 | 路径穿越防护 / 跨 App 隔离 / 准入校验 fail-closed |
| M10 | 第一个 App（L1 左脑验证形态种子） | Embas 翻译市场（订单生命周期 + 仲裁 + escrow） |
| AUDIT-M10 | 全栈安全审计 | 5 P0 + 15 P1 修复（全部完成）+ 32 P2 登记 |

### 3.3 已交付的 L0 协议能力

| L0 模块 | 能力 | 三层架构对应 |
|---|---|---|
| 身份层 | 4-context DID 派生 + Ed25519 签名 | L0 物理锚定（A）+ L1 左脑（B）+ L1 右脑（C）+ L2（D）原生切分 |
| 经济层 | Reputation / Credit 双账本 + Faucet 签发 + Slash 惩罚 | L0 信用账本基底，服务 L1 认知结算与 L2 治理惩罚 |
| 协议层 | Vouch / Wiki / Market / Arbitration / Tunnel | L0 传输承载 L1/L2 业务 |
| 传输层 | libp2p + gossipsub + 单跳 relay + IPFS | L0 网络基底 |
| 持久化 | 6 registry + nonce 集合，原子 JSON 落盘 | L0 状态基底 |
| 治理种子 | 临时仲裁团 + 信誉 slash + Treasury 分账 | L2 治理参与的种子形态 |
| App SDK | 11 模块 API + Manifest 校验 + 权限白名单 | L1 接入的种子形态（App 是 L1 认知执行的载体） |
| App 加载 | AppManager + entryPoint 校验 + 路径穿越防护 | L1 沙箱基底 |
| 验证 App | Embas 翻译市场（订单 / 仲裁 / escrow / DID 脱敏） | L1 左脑认知执行的验证形态种子 |

### 3.4 验证形态的固有特性

验证形态下，以下特性是 L0 在该形态固有的，属于该形态的生态位：

- 传输层使用 libp2p relay，主权身份与行为模式的关联在网络层可观察
- 运行时为 Node.js，GC 抖动影响仲裁时效
- 持久化使用 fs + JSON，写入时阻塞事件循环
- 加密使用 `@noble/curves`，性能受 JS 运行时约束
- 主权边界掩护未实现，观察者攻击下假设无法验证
- L1/L2 接入契约未形式化（4-context DID 已原生支持，但契约未在代码层暴露）

这些特性在后续形态升级时自然转化，详见第 12 章。

### 3.5 假设验证覆盖度（验证形态）

| 假设 | 验证形态验证状态 | 完整验证条件 |
|---|---|---|
| H1 身份不可降级 | 部分验证（4-context 派生可工作，行为关联未掩护） | 网络化形态 Cover Traffic + 双平面强化后 |
| H2 价值可闭环 | 已验证（Embas 翻译市场端到端跑通，L1 左脑认知结算闭环） | - |
| H3 治理可问责 | 部分验证（防直接串谋，红线拦截器未实现） | 完整化形态红线拦截器 + 串谋检测后 |
| H4 边界可维护 | 部分验证（应用层签名 + 双平面隔离有效，主权边界掩护缺失） | 网络化形态 Cover Traffic 协议后 |
| H5 角色可涌现 | 待验证 | 完整化形态 FW-01 算法后 |

---

## 4. 阶段二：完整化形态（M11–M12）

### 4.1 阶段目标

让 L0 网络本体从"4-context 已原生切分三层但契约未暴露"演进到"L1/L2 接入契约原生暴露 + 多 App 共存 + 加权转换 + 开放准入"。验证 H5（角色可涌现）与 H3 完整形态（红线拦截 + 防间接串谋）。

M11 的核心是**原生暴露** 4-context DID 已支持的 L1/L2 接入契约，不是"为未来集成打补丁"。4-context DID 在 M2 即已原生切分三层，M11 将这一原生切分在代码层形式化为接口契约，供 Germ（L1）与 Aether（L2）作为独立层接入。

### 4.2 M11：L1/L2 接口原生暴露 + 多 App 共存

#### 4.2.1 工作项

| 编号 | 工作项 | 类别 | 产出 |
|---|---|---|---|
| M11-1 | L1 CognitiveExecution 接口契约暴露（详见 4.2.2） | L1 接入 | context-B/C 子身份的 L1 认知执行接入契约 |
| M11-2 | L2 GovernanceAnchor 接口契约暴露（详见 4.2.3） | L2 接入 | context-D 子身份的 L2 治理参与接入契约 |
| M11-3 | RedLineInterceptor 实现（详见 4.2.4） | L0 治理能力 | L0 传输层红线拦截 + 自动/链上切分 |
| M11-4 | CharterStore + business_rules.json 实现（详见 4.2.5） | L0 治理能力 | 活宪章存储 + 业务规则 + 演化提议通道 |
| M11-5 | 第二个 App：教学市场（context-B 消费型 + 转账型） | 多 App | 验证 L1 左脑多 App 共存 |
| M11-6 | 第三个 App：维基编辑（context-D 签发型） | 多 App | 验证 L2 治理参与种子的多 context 共存 |
| M11-7 | 加权转换协议 | 经济层 | 跨 App credit 流转 + trustWeight 加权记账 |
| M11-8 | FW-01 自然涌现算法 v0 | 涌现 | 节点角色涌现的算法实现与仿真 |
| M11-9 | 节点间攻击防护（详见 4.2.7） | 安全 | 6 项防护补齐 |
| M11-10 | L0 内部接口契约定义（详见第 9.1 节） | 内部接口 | TransportAdapter / LedgerStorage / CryptoProvider / PubSubProvider 语言无关定义 |

#### 4.2.2 L1 CognitiveExecution 接口暴露

4-context DID 的 context-B（左脑）/ context-C（右脑）已原生派生，M11 形式化为 L1 接入契约。Germ（L1）通过此契约接入 L0：

- **身份锚定**：L1 认知执行单元使用 context-B/C 子身份签名，签名验证即证明认知产出锚定到 L0 物理身份（推理即身份）
- **认知传输**：L1 认知数据通过 L0 传输层（TransportAdapter）传输，使用 context-B/C 子身份签名
- **认知结算**：L1 认知工作产出通过 L0 信用账本基底结算，结算凭据即认知产出的身份锚定证明
- **左右脑隔离**：context-B（左脑）与 context-C（右脑）在密码学上不可关联，L0 传输层保持这一隔离

契约定义详见 9.2 节。L0 不验证认知内容，只验证身份锚定与传输合规。

#### 4.2.3 L2 GovernanceAnchor 接口暴露

4-context DID 的 context-D 已原生派生，M11 形式化为 L2 接入契约。Aether（L2）通过此契约接入 L0：

- **治理身份**：L2 治理参与使用 context-D 子身份，与 L1 认知执行身份（B/C）密码学隔离
- **红线转交接收**：L0 红线拦截器将触及红线的提案转交 L2，L2 通过此契约接收
- **投票结果回写**：L2 链上投票结果通过此契约回写 L0，L0 执行
- **活宪章读取与演化提议**：L2 通过此契约读取活宪章、提交宪章演化提议（演化决策由 L2 共识完成）

契约定义详见 9.3 节。L0 不做治理决策，只做治理身份锚定、红线转交、宪章存储与执行。

#### 4.2.4 RedLineInterceptor 实现

L0 传输层的原生红线拦截能力在 M11 实现：

- **红线评估**：传输层对每条提案评估是否触及红线（规则来自活宪章与 business_rules.json）
- **路径切分**：未触及红线 → 自动执行路径（99.9%）；触及红线 → 强制转交 L2 链上投票（0.1%）
- **强制转交**：触及红线的提案在 L0 层不可被绕过，必须经 L2 链上投票
- **结果执行**：L2 投票结果回写后，L0 执行（通过 / 拒绝 / 修改）

红线拦截器是 L0 → L2 的单向保护机制，确保治理参与主权在协议层不被绕过。契约定义详见 9.4.1 节。

#### 4.2.5 CharterStore + business_rules.json 实现

活宪章与业务规则的 L0 存储在 M11 实现：

- **活宪章存储**：治理原则存于 L0 CharterStore，可通过 L2 链上投票演化
- **业务规则存储**：可变业务参数存于 business_rules.json，多数自动调整 / 关键项走 L2
- **演化提议通道**：L2 通过 GovernanceAnchor 契约提交宪章演化提议，L2 共识通过后由 L0 落盘
- **查询接口**：L1/L2 可查询活宪章与业务规则

契约定义详见 9.4.2 节。L0 是活宪章的载体与执行者，演化决策由 L2 做出。

#### 4.2.6 加权转换与多 App 共存

| 工作项 | L0 视角 |
|---|---|
| 第二个 App：教学市场 | L1 左脑（context-B）第二类认知执行形态 |
| 第三个 App：维基编辑 | L2 治理参与（context-D）的扩展形态 |
| 加权转换协议 | L0 信用账本基底支持跨 App credit 流转，主 DID 信誉 = Σ(context_i.reputation × app_i.trustWeight) |
| FW-01 自然涌现算法 v0 | L0 信用加权驱动节点角色涌现 |

#### 4.2.7 节点间攻击防护

| 防护 | 位置 | 防御对象 |
|---|---|---|
| Rate limiting | `s-node.js` `_pubsubHandler` | 高频消息 CPU 耗尽 |
| Eclipse 攻击检测 | `network/dht.js` | DHT 邻居被控制 |
| 仲裁员串谋统计检测 | `arbitration.js` | 间接串谋（无 vouch 关联但合谋） |
| 仲裁员中途退出惩罚 | `arbitration.js` + `timeouts.js` | 恶意 abstain 拖垮裁决 |
| Front-running commit-reveal | `market.js` | 抢订单时序攻击 |
| issue credit 反向审计 | `credit.js` | issuer 主动作恶 |

Sybil 攻击已通过 vouch 机制 + 信誉门槛 + first-seen wins 公钥绑定 + App 准入审核 + 仲裁 panel 关联节点排除的组合防御被消灭，不在 M11 防护项内。

#### 4.2.8 假设验证目标

| 假设 | M11 验证 | 备注 |
|---|---|---|
| H5 角色可涌现 | ✅ | FW-01 算法 + 加权转换协议 |
| H3 治理可问责（完整） | ✅ | 红线拦截器 + 节点间攻击防护 |
| L1 接入契约原生暴露 | ✅ | CognitiveExecution 契约 + 第二/三个 App 验证 |
| L2 接入契约原生暴露 | ✅ | GovernanceAnchor 契约 + 维基编辑 App 验证 |
| 多 App 隔离 | ✅ | AppManager + App 沙箱 |

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
| App 准入审核强化 | 第三方 App 注入恶意 Manifest |
| vouch 质量加权 | 低质量 vouch 灌水 |

---

## 5. 阶段三：网络化形态（M13–M14）

### 5.1 阶段目标

让 L0 网络本体具备长跑稳定性与观察者攻击防御能力。Rust 实现提供运行时材料升级，Slot-Based Saturated Cover Traffic 协议提供主权边界掩护，让观察者无法分辨边界内 L1 认知协作与 L2 治理参与的真实行为。

### 5.2 M13：Rust 协议层实现

#### 5.2.1 工作项

| 编号 | 工作项 | 优先级 | 说明 |
|---|---|---|---|
| M13-1 | credit / reputation ledger Rust 实现 | P0 | 加权转换核心 |
| M13-2 | arbitration Rust 实现 | P0 | 长跑稳定性要求最高 |
| M13-3 | identity / 签名 Rust 实现 | P0 | `ed25519-dalek` 实现 4-context DID 派生 |
| M13-4 | market Rust 实现 | P1 | 业务复杂 |
| M13-5 | wiki Rust 实现 | P2 | 业务简单 |
| M13-6 | 存储后端 | P0 | lmdb / sled 实现 LedgerStorage 契约 |
| M13-7 | rust-libp2p 集成 | P0 | 实现 PubSubProvider 与 TransportAdapter 契约 |
| M13-8 | RedLineInterceptor / CharterStore Rust 实现 | P1 | L0 治理能力 Rust 化 |

#### 5.2.2 实现原则

1. **协议规范冻结**：M13 期间协议规范不变，只新增实现语言
2. **契约兑现**：每个 Rust 模块兑现第 9 章定义的接口契约（含 L1/L2 接入契约）
3. **等价测试**：JS 实现通过的测试，Rust 实现等价通过
4. **跨实现互操作**：JS 节点与 Rust 节点互通，验证协议规范的语言无关性

### 5.3 M14：主权边界掩护协议

#### 5.3.1 工作项

| 编号 | 工作项 | 优先级 | 说明 |
|---|---|---|---|
| M14-1 | Slot-Based Saturated Cover Traffic 协议 | P0 | 时间切片饱和掩护流量，L1/L2 真实消息嵌入掩护中 |
| M14-2 | 观察者攻击防御 | P0 | 流量模式不可分辨，节点行为不可关联 |
| M14-3 | Eclipse 攻击防御 Rust 强化 | P0 | DHT 邻居多样性硬约束 |
| M14-4 | 双平面隔离强化 | P1 | 控制平面掩护流量与数据平面真实流量分层 |
| M14-5 | 跨网络联邦协议 | P2 | 多个 Havix L0 网络互联（FW-04） |

#### 5.3.2 主权边界掩护设计原则

1. **主权身份可见**：DID 仍是协议层主权身份，不追求隐藏身份存在
2. **行为不可观察**：观察者无法分辨节点在 slot 内是否产生 L1 认知协作或 L2 治理参与
3. **协议层实现**：Cover Traffic 是 L0 协议自身能力，不依赖外部 mixnet
4. **与双平面隔离契合**：掩护流量在控制平面，L1/L2 真实流量在数据平面，二者不可分辨
5. **延迟可控**：相比多跳 mixnet，slot-based 方案延迟更可控，仲裁时效不受影响
6. **主权边界掩护是 H4 验证的前提**：Cover Traffic 协议是 H4（边界可维护）在观察者攻击下被验证的必要条件

---

## 6. 阶段四：生态形态（M15+）

### 6.1 阶段目标

在 L0 协议稳定后扩展生态能力，进入横向扩展阶段。

### 6.2 候选工作项

| 编号 | 工作项 | 说明 |
|---|---|---|
| M15-1 | 多语言 SDK | Python / Go SDK，对应 FW-04 跨网络联邦 |
| M15-2 | 移动端节点 | 资源受限场景的 L0 协议适配 |
| M15-3 | DID 旋转协议 | 主身份密钥泄露后的恢复路径 |
| M15-4 | Cover Traffic 协议增强 | 资源受限场景下的掩护流量优化 |
| M15-5 | L1 Germ 完整集成 | Germ 作为独立层完整接入 L0（基于 M11 暴露的 CognitiveExecution 契约） |
| M15-6 | L2 Aether 完整集成 | Aether 作为独立层完整接入 L0（基于 M11 暴露的 GovernanceAnchor 契约） |

---

## 7. 阶段演进关系

### 7.1 演进原则

- **前一形态是后一形态的基础**：验证形态证明 L0 业务逻辑可走通，完整化形态在此基础上原生暴露 L1/L2 契约，网络化形态在此基础上验证观察者攻击防御
- **前一形态不被否定**：每个形态的 L0 协议能力是真实的，后续形态是能力扩展，不是对前形态的修正
- **形态特性自然转化**：前形态的固有特性（如流量可观察）在后形态中自然转化（如 Cover Traffic 协议），不是"补丁"或"清偿"
- **L1/L2 接入是原生暴露而非补丁**：4-context DID 在 M2 即原生切分三层，M11 形式化契约是原生升级，不是为集成打补丁

### 7.2 各形态验证的假设

| 假设 | 验证形态 | 完整化形态 | 网络化形态 | 生态形态 |
|---|---|---|---|---|
| H1 身份不可降级 | 部分（context 派生） | - | 完整（Cover Traffic + 双平面强化） | - |
| H2 价值可闭环 | 完整（L1 左脑认知结算） | - | - | - |
| H3 治理可问责 | 部分（防直接串谋） | 完整（红线拦截 + 防间接串谋） | - | - |
| H4 边界可维护 | 部分（应用层签名） | - | 完整（Cover Traffic 协议） | - |
| H5 角色可涌现 | - | 完整（FW-01） | - | - |
| L1/L2 接入契约 | 种子（4-context 已切分） | 原生暴露（契约形式化） | Rust 兑现 | 完整集成 |
| 长跑稳定性 | - | - | 完整（Rust） | - |

---

## 8. 协议安全模型

### 8.1 威胁谱系

L0 协议面对的威胁谱系：

```
被动观察 → 流量分析 → 行为关联 → Eclipse 攻击 → 节点劫持 → 物理层攻击 → 治理绕过
   ↑           ↑           ↑           ↑            ↑           ↑           ↑
  弱          中          中           强           极强        极强        极强
```

Sybil 注入已通过 vouch 机制 + 信誉门槛 + first-seen wins 公钥绑定 + App 准入审核 + 仲裁 panel 关联节点排除的组合防御被消灭，不构成协议威胁。

治理绕过（绕过 L2 链上投票直接执行关键变更）由 L0 红线拦截器在传输层强制拦截，是 L0 → L2 的保护机制。

设计原则：威胁谱系上的每一级都必须有对应的协议层防御。某级防御缺失时，对应的协议假设在该强度下无法验证。

### 8.2 防御分层

| 防御层 | 防御对象 | 当前状态 | 完成形态 |
|---|---|---|---|
| 密码学层 | 消息篡改 / 伪造 / 重放 | 完成 | 验证形态 |
| 行为过滤层 | DoS / 内存膨胀 / 路径穿越 | 完成 | 验证形态 |
| 节点间攻击层 | Eclipse / 串谋 / Front-running | 部分完成 | 验证形态 + 完整化形态 |
| 红线拦截层 | 治理绕过 / 关键变更自动执行 | 未开始 | 完整化形态 |
| 主权边界掩护层 | 观察者攻击 / 流量模式分析 / 行为关联 | 未开始 | 网络化形态 |

L0 协议通过 vouch 机制、信誉门槛、first-seen wins 公钥绑定、App 准入审核、仲裁 panel 关联节点排除等组合，已在协议内部消灭 Sybil 攻击的可行性。剩余威胁集中在观察者攻击与治理绕过——分别由 M14 主权边界掩护协议与 M11 红线拦截器防御。

### 8.3 红线拦截器在威胁谱系中的位置

红线拦截器是 L0 对"治理绕过"威胁的协议层防御：

- **威胁**：关键变更（宪章演化 / 红线规则修改 / 仲裁规则根本变更）被绕过 L2 链上投票直接自动执行
- **防御**：L0 传输层强制评估每条提案，触及红线者强制转交 L2 链上投票
- **性质**：L0 → L2 的单向保护，不可在 L0 层被绕过
- **依赖**：红线规则存于活宪章与 business_rules.json，规则修改本身走 L2 链上投票（防自洽绕过）

### 8.4 已完成的节点间攻击防护（验证形态）

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

L0 协议规范包含三类语言无关的接口契约：

- **9.1 L0 内部接口**：L0 自身的传输、存储、加密、发布订阅抽象（TransportAdapter / LedgerStorage / CryptoProvider / PubSubProvider）
- **9.2 L1 接入接口**：L1（Germ）接入 L0 的契约（CognitiveExecution）
- **9.3 L2 接入接口**：L2（Aether）接入 L0 的契约（GovernanceAnchor）
- **9.4 L0 治理能力接口**：L0 自身的治理能力契约（RedLineInterceptor / CharterStore）

L0 内部接口契约定义在 M11 完成，Rust 实现在 M13 兑现。L1/L2 接入契约与 L0 治理能力契约在 M11 完成并暴露，供 Germ 与 Aether 在 M15+ 完整集成。

### 9.1 L0 内部接口

#### 9.1.1 TransportAdapter

```typescript
interface TransportAdapter {
  // 发送 chunk 到目标 DID（主权身份可见，行为由 Cover Traffic 掩护）
  sendChunk(targetDid: Did, chunk: Uint8Array): Promise<{ relay: Did, sequence: number }>

  // 订阅 topic 消息
  subscribe(topic: Topic, handler: (msg: Message) => void): Subscription

  // 发布 topic 消息（真实消息嵌入 Cover Traffic slot）
  publish(topic: Topic, msg: Message): Promise<void>

  // DHT 查询（仅公共 CID）
  dhtFind(cid: Cid): Promise<Peer[]>

  // 节点发现
  discover(filter?: DiscoveryFilter): AsyncIterable<Peer>
}
```

- 验证形态实现：libp2p relay
- 网络化形态实现：libp2p + Cover Traffic 协议层

#### 9.1.2 LedgerStorage

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

#### 9.1.3 CryptoProvider

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

#### 9.1.4 PubSubProvider

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

### 9.2 L1 接入接口：CognitiveExecution

L1（Germ）通过 CognitiveExecution 契约接入 L0。4-context DID 的 context-B（左脑）/ context-C（右脑）已原生支持此契约，M11 形式化暴露：

```typescript
interface CognitiveExecution {
  // 注册认知执行单元（左脑 B / 右脑 C）
  // 使用 context-B/C 子身份，签名验证即证明认知产出锚定到 L0 物理身份（推理即身份）
  registerHemisphere(hemisphere: 'left' | 'right', contextDid: Did): Promise<CognitiveSession>

  // 认知数据传输（走 L0 TransportAdapter，用 context-B/C 子身份签名）
  sendCognitiveChunk(targetDid: Did, chunk: Uint8Array, hemisphere: 'left' | 'right'): Promise<{ relay: Did, sequence: number }>

  // 认知产出锚定（推理即身份：认知产出锚定到 L0 物理身份）
  anchorInference(output: CognitiveOutput, contextDid: Did): Promise<{ anchorProof: AnchorProof }>

  // 认知工作结算（走 L0 信用账本基底）
  settleCognitiveWork(workProof: WorkProof, amount: CreditAmount): Promise<SettlementReceipt>

  // 订阅认知事件
  onCognitiveEvent(handler: (event: CognitiveEvent) => void): Subscription
}
```

- L0 职责：身份锚定验证、传输承载、信用结算
- L1 职责：认知算法、推理执行、左右脑协作逻辑
- L0 不验证认知内容，只验证身份锚定与传输合规

### 9.3 L2 接入接口：GovernanceAnchor

L2（Aether）通过 GovernanceAnchor 契约接入 L0。4-context DID 的 context-D 已原生支持此契约，M11 形式化暴露：

```typescript
interface GovernanceAnchor {
  // 接收红线拦截器转交的提案（L0 → L2）
  receiveInterceptedProposal(proposal: GovernanceProposal): Promise<ProposalReceipt>

  // 提交链上投票结果（L2 → L0）
  submitVoteResult(proposalId: ProposalId, result: VoteResult): Promise<void>

  // 注册治理参与身份（context-D 子身份）
  registerGovernanceIdentity(contextDid: Did): Promise<GovernanceSession>

  // 读取活宪章
  readCharter(): Promise<Charter>

  // 提议宪章演化（活宪章的生长机制，演化决策由 L2 共识完成）
  proposeCharterEvolution(amendment: CharterAmendment): Promise<EvolutionProposal>

  // 业务规则查询
  queryBusinessRule(ruleKey: string): Promise<BusinessRule>
}
```

- L0 职责：治理身份锚定、红线转交、宪章存储与执行
- L2 职责：共识、链上账本、投票协议、宪章演化决策
- L0 不做治理决策，只做治理身份锚定、红线转交、宪章存储与执行

### 9.4 L0 治理能力接口

#### 9.4.1 RedLineInterceptor

L0 传输层的原生红线拦截能力，M11 实现：

```typescript
interface RedLineInterceptor {
  // 传输层强制拦截：判定提案是否触及红线
  evaluate(proposal: Proposal): Promise<{ intercepted: boolean, reason?: string }>

  // 触及红线的提案强制转交 L2 链上投票
  forwardToGovernance(proposal: Proposal): Promise<{ governanceId: ProposalId }>

  // 自动执行判定（99.9% auto / 0.1% on-chain）
  classify(proposal: Proposal): Promise<{ path: 'auto-execute' | 'on-chain-vote', threshold: number }>
}
```

- 红线规则来自活宪章与 business_rules.json
- 红线规则修改本身走 L2 链上投票（防自洽绕过）
- L0 传输层强制执行，不可在 L0 层被绕过

#### 9.4.2 CharterStore

L0 活宪章与业务规则的存储，M11 实现：

```typescript
interface CharterStore {
  // 读取活宪章
  getCharter(): Promise<Charter>

  // 读取业务规则
  getBusinessRules(): Promise<BusinessRules>

  // 读取 business_rules.json 单条规则
  getBusinessRule(ruleKey: string): Promise<BusinessRule>

  // 提交宪章演化提议（走 L2 链上投票，L0 不做决策）
  proposeEvolution(amendment: CharterAmendment): Promise<EvolutionProposal>

  // 落盘 L2 共识通过的宪章演化（L2 → L0 回写）
  applyEvolution(evolutionProposal: EvolutionProposal, voteResult: VoteResult): Promise<void>
}
```

- L0 是活宪章的载体与执行者，不是决策者
- 演化决策由 L2 共识完成，L0 落盘执行

---

## 10. 工程约束

### 10.1 测试基线

每阶段的工作必须保持测试基线全过：

| 仓库 | 当前基线 |
|---|---|
| Havix 主仓库（L0 网络本体） | 1021/1021 |
| Embas（L1 左脑验证形态种子） | 213/213 |
| 合计 | 1234/1234 |

新增工作项必须配套回归测试。M11 起新增工作项的测试纳入对应仓库的基线。L1/L2 接入契约的契约测试纳入 Havix 主仓库基线。

### 10.2 关键决策

#### 决策 1：完整化形态不启动 Rust 化

依据：完整化形态验证的是 L0 协议设计假设（L1/L2 契约原生暴露 + 加权转换 + 自然涌现），不是运行时性能。设计假设未被业务证伪前更换实现语言，会让设计验证与材料升级耦合，难以归因。

约束：M11 新增协议代码必须通过第 9 章定义的接口契约组织，不直接依赖 Node.js fs / `@noble/curves` / libp2p 私有 API。

#### 决策 2：主权边界用 Cover Traffic 实现

依据：Havix L0 是主权边界协议，不是匿名协议。观察者攻击的防御通过协议自身的 Slot-Based Saturated Cover Traffic 实现，不依赖外部 mixnet。主权身份保持可见，行为不可观察。

约束：M14 必须实现 Cover Traffic 协议；协议层不引入对 Nym / Katzenpost / Loopix 等外部 mixnet 的依赖。

#### 决策 3：协议规范与实现语言解耦

依据：Havix L0 协议规范定义语言无关的接口契约。JS 实现是协议在 Node.js 运行时的原生实现，Rust 实现是协议在系统级运行时的原生实现。两者通过协议规范契约保持一致，通过等价测试与跨实现互操作验证。

约束：所有协议层代码必须通过接口契约组织，不直接绑定单一语言的运行时特性。

#### 决策 4：节点间攻击防护是完整化形态必修项

依据：完整化形态验证多 App 共存假设。节点间攻击防护中不依赖 Rust 的部分（Rate limiting / Eclipse 检测 / 串谋统计检测 / 退出惩罚 / Front-running / issue credit 审计）必须在 M11 完成，否则多 App 共存假设的验证不可信。Sybil 攻击已在验证形态通过组合防御消灭，不列入 M11 防护项。

约束：M11 工作计划必须包含第 4.2.7 节定义的防护项。

#### 决策 5：主权边界掩护是 H4 验证的前提

依据：H4（边界可维护）在观察者攻击下的验证要求主权边界内行为不可观察。Cover Traffic 协议是 H4 验证的必要条件，不是工程优化。

约束：M14 必须完成 Slot-Based Saturated Cover Traffic 协议与双平面隔离强化。

#### 决策 6：L1/L2 接入是原生暴露而非补丁

依据：4-context DID 在 M2 即已通过 HKDF 派生原生切分三层（A→L0 / B→L1 左脑 / C→L1 右脑 / D→L2）。M11 形式化暴露 L1/L2 接入契约是对已有原生切分的工程形式化，不是为未来集成打补丁。Germ 与 Aether 在 M15+ 完整集成时消费 M11 暴露的契约，不需 L0 改造。

约束：M11 的 L1/L2 接口契约必须基于 4-context DID 已有的 context-B/C/D 派生实现，不新增身份层结构；契约形式化通过抽象接口组织，不修改 identity.js 的派生逻辑。

#### 决策 7：红线拦截器是 L0 传输层原生能力

依据：治理绕过威胁要求 L0 在传输层强制拦截触及红线的提案。红线拦截器是 L0 → L2 的单向保护，不可在 L0 层被绕过。红线规则修改本身走 L2 链上投票，防自洽绕过。

约束：M11 必须实现 RedLineInterceptor 契约；红线规则存于活宪章与 business_rules.json，规则修改必须经 L2 链上投票。

#### 决策 8：活宪章存储与演化决策分离

依据：活宪章的演化是 L2 治理决策，不是 L0 工程决策。L0 是活宪章的载体与执行者，不是决策者。演化决策由 L2 共识完成，L0 落盘执行。

约束：M11 必须实现 CharterStore 契约；宪章演化必须经 L2 链上投票，L0 不自动演化宪章原则；业务规则（business_rules.json）的多数项可自动调整，关键项走 L2。

#### 决策 9：P2 修复不阻断主线

依据：AUDIT-M10 的 32 项 P2 是可维护性 / 性能 / 文档类，不影响协议设计验证。

约束：P2 在完整化形态与网络化形态按需穿插处理，不安排专门冲刺。例外：与多 App 隔离、审核机制、L1/L2 契约相关的 P2 必须在对应阶段修复。

---

## 11. 假设验证矩阵

### 11.1 当前矩阵

| 假设 | 验证形态 | 完整化形态 | 网络化形态 | 生态形态 |
|---|---|---|---|---|
| H1 身份不可降级 | 部分（context 派生） | - | 完整（Cover Traffic + 双平面强化） | - |
| H2 价值可闭环 | 完整（L1 左脑认知结算） | - | - | - |
| H3 治理可问责 | 部分（防直接串谋） | 完整（红线拦截 + 防间接串谋） | - | - |
| H4 边界可维护 | 部分（应用层签名） | - | 完整（Cover Traffic 协议） | - |
| H5 角色可涌现 | - | 完整（FW-01） | - | - |
| L1/L2 接入契约 | 种子（4-context 已切分） | 原生暴露（契约形式化） | Rust 兑现 | 完整集成 |
| 红线拦截 | - | 完整（RedLineInterceptor） | Rust 兑现 | - |
| 活宪章存储 | - | 完整（CharterStore） | Rust 兑现 | - |
| 长跑稳定性 | - | - | 完整（Rust） | - |

### 11.2 验证解读约束

1. **形态内的验证是有效的**：每个形态在自身生态位内的协议假设验证是有效证据，不因后续形态未完成而失效
2. **形态间的验证是递进的**：完整化形态的验证建立在验证形态之上，网络化形态的验证建立在完整化形态之上
3. **跨形态边界需谨慎归因**：如某形态内出现"假设不成立"的结论，需先确认是否因该形态的固有特性导致，而非协议设计本身缺陷
4. **L1/L2 集成验证分两步**：M11 验证契约原生暴露（L0 单侧），M15+ 验证完整集成（L0 + L1/L2 双侧）

---

## 12. 当前形态特性登记

验证形态下的固有特性登记。这些特性属于该形态的生态位，在后续形态升级时自然转化。

### 12.1 传输层特性

| 特性 | 当前形态 | 后续形态转化 |
|---|---|---|
| 主权身份可关联到行为模式 | libp2p 原生传输 | 网络化形态 Cover Traffic 协议引入后，行为不可分辨 |
| relay 节点可观察两端通信时序 | 单跳 relay | 网络化形态 Cover Traffic 饱和流量后，时序不可分辨 |
| 无流量模式掩护 | 无 | 网络化形态 slot-based 饱和掩护后转化 |

注：peerId 与 DID 的关联在 Havix L0 主权边界协议中是设计要求——主权身份可见。Cover Traffic 不隐藏身份，只掩护行为。

### 12.2 运行时特性

| 特性 | 当前形态 | 后续形态转化 |
|---|---|---|
| GC 抖动影响仲裁时效 | Node.js 运行时 | 网络化形态 Rust 实现后转化 |
| fs IO 阻塞事件循环 | Node.js fs + JSON | 网络化形态 lmdb / sled 后转化 |
| `@noble/curves` 性能受 JS 约束 | JS 加密库 | 网络化形态 `ed25519-dalek` 后转化 |
| Set/Map LRU 是软限 | JS 数据结构 | 网络化形态 Rust 硬限后转化 |
| libp2p gossipsub 内存特性 | 第三方依赖 | 网络化形态 rust-libp2p 后转化 |

### 12.3 L1/L2 接入特性

| 特性 | 当前形态 | 后续形态转化 |
|---|---|---|
| 4-context DID 已原生切分三层 | M2 已实现 | M11 形式化契约暴露后供 L1/L2 接入 |
| L1 接入契约未形式化 | 验证形态未暴露 | 完整化形态 M11 暴露 CognitiveExecution 契约 |
| L2 接入契约未形式化 | 验证形态未暴露 | 完整化形态 M11 暴露 GovernanceAnchor 契约 |
| 红线拦截器未实现 | 验证形态未实现 | 完整化形态 M11 实现 RedLineInterceptor |
| 活宪章存储未实现 | 验证形态未实现 | 完整化形态 M11 实现 CharterStore |

### 12.4 AUDIT-M10 P2 登记

32 项 P2 是可维护性 / 性能 / 文档类。处理策略：

- 完整化形态按需穿插处理与多 App、L1/L2 契约相关的 P2
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

1. 不能因验证形态的固有特性判定协议假设被证伪：如反馈涉及敌对环境、长跑稳定性、网络层观察、L1/L2 集成，需先确认是否因形态固有特性导致
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
- [ ] 第 9.1 节定义的 4 个 L0 内部接口契约已在代码中实现接口定义
- [ ] 第 9.2 节 CognitiveExecution（L1 接入）契约已在代码中实现接口定义
- [ ] 第 9.3 节 GovernanceAnchor（L2 接入）契约已在代码中实现接口定义
- [ ] 第 9.4.1 节 RedLineInterceptor 契约已在代码中实现接口定义
- [ ] 第 9.4.2 节 CharterStore 契约已在代码中实现接口定义
- [ ] business_rules.json 初始结构已定义
- [ ] 节点间攻击防护 6 项 M11 必修已排入 M11 工作计划
- [ ] Slot-Based Saturated Cover Traffic 协议 v0 设计文档已起草
- [ ] 假设验证矩阵已更新

---

## 15. 参考文档

### 15.1 Havix L0 项目内

- [技术白皮书](./Havix-Technical-Whitepaper.md) —— L0 协议规范
- [AUDIT-M10.md](./AUDIT-M10.md) —— 全栈审计报告
- [README.md](./README.md) —— 项目概览
- [DEPLOY.md](./DEPLOY.md) —— 部署运行
- [ROADMAP.md](./ROADMAP.md) —— M9–M12 阶段路线
- [PROJECT-SUMMARY.md](./PROJECT-SUMMARY.md) —— M10 完结快照

### 15.2 三层架构关联仓库

- Germ（L1 认知执行层）：https://github.com/eneatlnc-cell/Germ
- Aether（L2 链上治理层）：待建（M11 暴露 GovernanceAnchor 契约后启动）

### 15.3 外部参考

- Slot-Based Saturated Cover Traffic: L0 主权边界掩护流量协议设计参考
- Loopix: https://arxiv.org/abs/1703.00536 （Cover Traffic 设计参考）
- Dovetail / PBACN: 分层覆盖匿名通信网络相关论文（主权边界设计参考）

---

*本文档定义 Havix L0 网络本体的迭代开发路径。L0 是三层 ASI 基础设施的网络基底，4-context DID 原生切分 L0/L1/L2。每个阶段对应 L0 的一个协议形态，是该阶段的生态位。形态之间存在演进关系，前一形态是后一形态的基础。M11 原生暴露 L1/L2 接入契约，为 Germ 与 Aether 在 M15+ 完整集成提供协议层基础。*
