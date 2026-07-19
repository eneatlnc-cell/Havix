# Havix 下一步开发规划日志

> 记录时间：2026-07-19
> 触发点：M10 翻译市场端到端跑通 + AUDIT-M10 全栈安全加固完成，进入内测阶段
> 用途：内测结束后启动 M11 的参考依据
> 测试基线：MVP 1021/1021 + Embas 213/213 = 1234/1234
> Git 状态：主仓库 `456ea2a` / Embas `0353920`（都已 push 到 main）

---

## 0. 当前里程碑快照

### 已完成

| 阶段 | 主题 | 关键产出 | 测试 |
|---|---|---|---|
| M1-M7 | MVP 协议层 | identity / credit / vouch / wiki / market / tunnel / arbitration / 持久化 | 集成基线 |
| M8.x | 信誉账本持久化 + CLI 收口 + 4 节点集成 | 6 registry 持久化 + 原子 saveJson + start() 失败回滚 | - |
| M8 审计 | 6 P0 + 6 P1 + 3 P2 | 签名覆盖 canonical message / note 内层验签 / topic 分流 / InviteToken.verifySelf / gossipsub try-catch / slash 0 守卫 | 15 项 |
| M9 | App SDK + Manifest 规范 | Havix SDK（11 模块）+ AppManifest 校验 + 参考模板 | - |
| M9.5 | 空应用参考模板 | apps/empty-app（最小可运行 App） | 集成测试 |
| M9.6 | 安全加固第一步 | 6 项立即修复（state/AppManager/web.mount/跨 App/issueInvite/仲裁） | 27 项 |
| M10 | 第一个参考 App：翻译市场 Embas | 订单生命周期 + 仲裁适配器 + escrow + DID 脱敏 | Embas 213 |
| AUDIT-M10 | 全栈审计 | 5 P0 + 15 P1（全部修复）+ 32 P2（未修复） | 41 项新增 |

### 未完成（明确债务）

- **AUDIT-M10 P2 共 32 项**：可维护性 / 性能 / 文档类，未修复。建议在 M11 阶段按需穿插处理，不阻断主线。
- **JS 实现层脆弱性**：libp2p peerId↔DID 绑定暴露、无 mixnet 防流量分析、单线程 GC 抖动、Node.js fs IO 阻塞事件循环——这些是**材料问题，不是补 P2 修复能解决**的，必须 M13+ Rust 化。
- **网络层隐私缺失**：当前 transport 走 libp2p relay，抗 ISP 级观察但抗不了全球流量分析。需要 Nym/Katzenpost 作为可插拔底层。

---

## 1. 内测阶段（当前 → M11 启动前）

### 1.1 内测关注点

按三份说明文件验证：

1. [README.md](./README.md) —— 项目概览与已交付能力
2. [DEPLOY.md](./DEPLOY.md) —— 部署运行说明
3. [sdk/USAGE.md](./sdk/USAGE.md) + [Embas/USAGE.md](./Embas/USAGE.md) —— SDK 与 App 使用说明

### 1.2 可能暴露的问题类型

- **运行时**：libp2p / Helia / IPFS 节点连接问题 → 检查 bootstrap + 防火墙
- **业务流程**：Embas 翻译订单 / 仲裁 / 信誉扣款链路 → 检查 [Embas/M10-DESIGN.md](./Embas/M10-DESIGN.md)
- **持久化**：节点重启后状态恢复 → 检查 `.data/` 目录权限与原子写
- **App 加载**：manifest.yaml 格式 / entryPoint 路径 → 检查 [sdk/manifest.js](./sdk/manifest.js)
- **长跑稳定性**：内存膨胀（Set/Map LRU 上限已做，但需要 24h+ 真实跑测验证）
- **多节点共识**：4 节点拓扑下的消息顺序与最终一致性

### 1.3 内测反馈的处理原则

- **P0 级（阻断内测）**：立即修，按 AUDIT-M10 P0 修复模式（修复 + 回归测试 + 当天 commit）
- **P1 级（影响功能但不阻断）**：登记到 AUDIT-M11，M11 启动时优先处理
- **P2 级（体验/文档）**：登记到 AUDIT-M11，按需穿插
- **设计层质疑**：单独开 issue，需要协议设计讨论，不在内测期决定

---

## 2. M11：多 App 并存 + 加权转换

### 2.1 主线目标

对齐 [ROADMAP.md](./ROADMAP.md) §M11 与白皮书 §8.3「加权转换」、FW-01「自然涌现算法 v0」。

| 工作项 | 描述 | 依赖 |
|---|---|---|
| 教学市场 App（context-B 消费型） | 第二个参考 App，验证 SDK 通用性 | Embas 经验 |
| 维基 App（context-D 签发型） | 第三个参考 App，验证多 context 共存 | - |
| 加权转换协议 | 跨 App credit 流转 + trustWeight 加权 | 3 个 App 跑通 |
| FW-01 自然涌现算法 v0 | 节点角色自然涌现（观察者/参与者/中继） | 加权转换协议 |

### 2.2 M11 的"防脆弱"准备（不做 Rust，但要留接口）

M11 不启动 Rust 重写，但**所有新增协议代码必须为 M13+ Rust 化留接口**。原则：业务层不直接依赖 Node.js fs / `@noble/curves` / libp2p，而是通过抽象层。

| 抽象层 | 位置 | 现状 | M11 动作 |
|---|---|---|---|
| `TransportAdapter` | `network/tunnel.js` | 直接耦合 libp2p relay | 留接口，默认实现保持现状 |
| `LedgerStorage` | `protocol/credit.js` / `arbitration.js` | 直接耦合 fs + JSON | 留接口，默认实现保持现状 |
| `CryptoProvider` | `identity.js` | 直接耦合 `@noble/curves` | 留接口，默认实现保持现状 |
| `PubSubProvider` | `s-node.js` | 直接耦合 libp2p gossipsub | 留接口，默认实现保持现状 |

**判断标准**：M11 写的任何新代码，问自己一句"这段代码在 Rust 实现里是否需要重写业务逻辑？"——如果答"是"，说明抽象不到位；如果答"否，只需换适配器实现"，说明抽象正确。

### 2.3 M11 必须避免的陷阱

- **过早优化**：不在 JS 里做深度性能优化，扛不住的标记为 M13+ Rust 必修项
- **过早 Rust 化**：M11 的核心是验证设计假设（加权转换 + 自然涌现），不是性能优化
- **误判算法可行性**：如果 FW-01 在 JS 里测不出预期吞吐，先排除 GC / IO 抖动干扰，再下结论
- **多 App 隔离不严**：M11 多 App 共存时，权限/资源/命名空间必须严格隔离（参考 AUDIT-M10 P1-7 跨 App 隔离）

---

## 3. M12：网络效应启动

### 3.1 主线目标

| 工作项 | 描述 |
|---|---|
| App 注册中心 | 全局 App 目录 + 版本管理 |
| Manifest 审核 | 第三方 App 准入流程（白皮书 §8.4） |
| App 信任权重审核 | trustWeight 动态调整 |
| 跨节点 App 同步 | App 列表 gossip 协议 |

### 3.2 M12 的关注点

- **审核机制防滥用**：不能让恶意 App 通过审核后劫持节点资源
- **信任权重反操纵**：防 Sybil 攻击抬高权重
- **App 生命周期**：安装 / 升级 / 卸载 / 数据迁移

---

## 4. M13+：Rust 实现 + 底层升级

### 4.1 核心方向

**这是直面"底层过于脆弱"的关键阶段**。

| 方向 | 描述 | 优先级 |
|---|---|---|
| Rust 协议层移植 | identity / credit / vouch / market / arbitration 核心 | P0 |
| 存储后端替换 | JSON → lmdb / sled（通过 LedgerStorage 抽象） | P0 |
| 加密库替换 | `@noble/curves` → `ed25519-dalek`（通过 CryptoProvider 抽象） | P0 |
| Nym mixnet 适配器 | 第一个非 libp2p transport（通过 TransportAdapter 抽象） | P1 |
| Katzenpost 适配器 | 备选 mixnet（如 Nym 延迟不可接受） | P2 |
| DID↔peerId 解耦 | 让一个 DID 可在不暴露 peerId 的前提下通信 | P1 |

### 4.2 Rust 移植优先级排序原则

按"对设计假设验证的贡献度"排序，不按"代码量"或"难度"排序：

1. **credit / reputation ledger**——加权转换的核心，必须先 Rust 化
2. **arbitration**——长跑稳定性要求最高（裁决不可回滚）
3. **identity / 签名**——安全敏感，且 `ed25519-dalek` 比 `@noble/curves` 快 3-5 倍
4. **market**——业务复杂但性能要求中等
5. **tunnel**——必须等 Nym 适配器就绪后再移植
6. **wiki**——可最后移植，业务简单

### 4.3 不做的事

- **不自建 mixnet**：Nym / Katzenpost 已经做了，Havix 集成而非重写
- **不重写 gossipsub**：libp2p 已有，Rust 侧直接用 `rust-libp2p`
- **不在 M13 做多语言联邦**：跨网络联邦（FW-04）留到 M14+
- **不在 Rust 化期间改协议设计**：协议设计冻结，只做材料替换

### 4.4 判断标准

M13+ 完成的标志：
- 所有 M11-M12 在 JS 里跑通的业务流程，在 Rust 实现里等价跑通
- Nym mixnet 适配器作为可选 transport，默认关闭，可配置开启
- 长跑节点（24h+）内存稳定，无 GC 抖动导致的吞吐毛刺
- 4 节点集成测试在 Rust 实现下通过

---

## 5. 待处理债务清单

### 5.1 AUDIT-M10 P2（32 项，未修复）

详见 [AUDIT-M10.md](./AUDIT-M10.md)。处理策略：
- M11 阶段按需穿插修复与多 App 相关的 P2
- M12 阶段处理与审核机制相关的 P2
- M13 Rust 化时大部分 P2 自然消失（如 JS 特有的类型检查、fs IO 阻塞等）

### 5.2 JS 实现层债务（M13+ Rust 必修项清单）

需要在 M11-M12 期间持续登记，到 M13 启动时作为移植参考。当前已知的：

| 债务 | 位置 | 影响 | Rust 化方案 |
|---|---|---|---|
| peerId↔DID 绑定暴露 | `s-node.js` start() | 网络层观察者可画图谱 | TransportAdapter + mixnet |
| GC 抖动影响仲裁时效 | `arbitration.js` | 投票窗口误判超时 | Rust 原生线程 |
| fs IO 阻塞事件循环 | `persistence.js` saveJsonAtomic | 长跑节点写入时卡顿 | lmdb / sled |
| Set/Map LRU 上限是软限 | 多处 | 极端情况可能瞬时超限 | Rust 硬限 + 编译期检查 |
| `@noble/curves` 性能 | `identity.js` | 高频签名场景吞吐瓶颈 | `ed25519-dalek` |
| libp2p gossipsub 内存泄漏 | 第三方依赖 | 长跑节点内存膨胀 | `rust-libp2p` 或自维护 fork |

### 5.3 设计层待验证假设

这些不是债务，是 M11-M12 必须验证的核心假设：

- **加权转换是否真能涌现角色分工**（FW-01）
- **多 App 共存时信誉不可降级是否成立**
- **仲裁 slash 机制在多 App 间是否被滥用**
- **私域市场双重加密在多 App 场景下的性能可接受性**

---

## 6. 内测结束后的启动检查清单

内测结束、准备启动 M11 时，确认以下事项：

- [ ] 内测中发现的所有 P0 已修复
- [ ] P1 已登记到 AUDIT-M11
- [ ] P2 已分类（M11 穿插处理 / M12 处理 / M13 自然消失）
- [ ] `TransportAdapter` / `LedgerStorage` / `CryptoProvider` / `PubSubProvider` 四个抽象接口已在文档中定义（不需要实现，只需要定义）
- [ ] M11 的三个 App（Embas 翻译市场 + 教学市场 + 维基 App）的设计文档已起草
- [ ] FW-01 自然涌现算法的 v0 设计文档已起草
- [ ] Rust 移植优先级清单已更新（基于 M11 实际跑测发现的问题）

---

## 7. 关键决策记录

### 决策 1：M11-M12 不启动 Rust 化
- **理由**：M11 的核心是验证设计假设（加权转换 + 自然涌现），不是性能优化。在假设未被业务证伪前换语言，等于在没验证地基的房子上换屋顶。
- **替代方案**：所有新代码通过抽象层为 Rust 化留接口。

### 决策 2：不自建 mixnet
- **理由**：Nym / Katzenpost / Loopix 已解决网络层隐私，Havix 集成而非重写。Havix 团队规模与 Nym 不在一个量级，自建会拖垮协议层进度。
- **替代方案**：通过 `TransportAdapter` 让 mixnet 可插拔，M13+ 实现 Nym 适配器作为第一个非 libp2p transport。

### 决策 3：Havix 定位为"应用层协议"，不是"网络层协议"
- **理由**：Nym 解决"通信不可追踪"但缺应用；Havix 解决"在追踪存在的前提下如何组织社会结构"。两者互补。
- **含义**：Havix 的核心价值在 DID 分层 + credit + market + arbitration 这套社会学协议，不在网络层。Rust 化时网络层可外包，协议层必须自主可控。

### 决策 4：P2 修复不阻断主线
- **理由**：P2 是可维护性 / 性能 / 文档类，不影响协议设计验证。在 M11-M12 按需穿插，不安排专门冲刺。
- **例外**：与多 App 隔离、审核机制相关的 P2 必须在对应阶段修复。

---

## 8. 联系与参考

- 协议设计：[Havix-Technical-Whitepaper.md](./Havix-Technical-Whitepaper.md)
- 当前审计：[AUDIT-M10.md](./AUDIT-M10.md)
- 项目概览：[README.md](./README.md)
- 部署运行：[DEPLOY.md](./DEPLOY.md)
- 开发路线：[ROADMAP.md](./ROADMAP.md)
- 项目摘要：[PROJECT-SUMMARY.md](./PROJECT-SUMMARY.md)

### 外部参考（M13+ 底层升级方向）

- Nym mixnet: https://nymtech.net/
- Katzenpost: https://katzenpost.mixnetworks.org/
- Loopix: https://arxiv.org/abs/1703.00536
- Dovetail / PBACN: 分层覆盖匿名通信网络相关论文

---

*本日志为内测结束后的 M11 启动参考。内测期间发现的问题将登记到 AUDIT-M11.md，不修改本文件。*
