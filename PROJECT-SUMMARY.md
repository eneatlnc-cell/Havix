# Havix 项目摘要

> **当前阶段**：M10 翻译市场端到端跑通 + 全栈安全加固（M9.6 + AUDIT-M10）已完成 ✅
> **测试基线**：MVP 1021/1021 + Embas 213/213 = **1234/1234 全过**
> **仓库**：[eneatlnc-cell/Havix](https://github.com/eneatlnc-cell/Havix) + [eneatlnc-cell/Embas](https://github.com/eneatlnc-cell/Embas)

---

## 1. 项目定位

**Havix —— Haven of Affinity**：去中心化对等网络协议，验证社会学论文《底层高认知者的结构性困境》提出的"分层自组织网络"假设。

- 协议层：身份（DID + 4 context 子身份）/ 信誉账本 / 维基 / 私域市场 / 隧道 / 仲裁 / 持久化
- App 层：基于 Havix SDK 构建的 App，第一个参考 App 是翻译市场 `Embas`
- 经济模型：4 种（公益型 / 消费型 / 签发型 / 转账型），均基于 credit 与 reputation ledger

---

## 2. 仓库结构

### 主仓库 `Havix`

```
/workspace/
├── src/                        # MVP 协议层实现
│   ├── identity.js              # IdentityWallet + 4 context 子身份
│   ├── s-node.js                # SNode 主类（消息 dispatch / start / stop）
│   ├── config.js                # loadConfig + 路径校验（P1-1）
│   ├── persistence.js           # 原子 JSON 持久化工具
│   ├── protocol/
│   │   ├── credit.js            # ReputationLedger + CreditLedger + Faucet
│   │   ├── arbitration.js       # ArbitrationRegistry + TreasuryLedger
│   │   ├── market.js            # MarketRegistry + InviteToken
│   │   ├── vouch.js             # VouchRegistry
│   │   ├── wiki.js              # WikiRegistry
│   │   └── message-types.js     # 消息签名规范
│   ├── network/
│   │   ├── tunnel.js            # TunnelManager + MAX_CHUNK_SIZE（P1-5）
│   │   ├── dht.js / relay.js / rendezvous.js / topology.js
│   └── app/
│       ├── app-manager.js       # AppManager（manifest 扫描 + entryPoint 校验）
│       ├── cli.js / web-panel.js
├── sdk/                         # App SDK（App 开发者使用的 API 层）
│   ├── app.js / context.js / state.js / web.js
│   ├── credit.js / arbitration.js / market.js / tunnel.js / wiki.js
│   ├── manifest.js / permissions.js / errors.js
│   └── ipfs.js / transport.js
├── apps/
│   └── empty-app/               # M9.5 空应用参考模板
├── test/                        # 29 个测试文件，1021 个用例
│   ├── audit-fixes.test.js          # M8 审计 6 P0 + 6 P1 + 3 P2 修复
│   ├── security-m96.test.js         # M9.6 安全加固 6 项立即修复
│   └── audit-m10-p1-mvp.test.js    # AUDIT-M10 MVP P1-1~P1-5 修复（41 用例）
├── Embas/                      # 第一个参考 App（独立 git 仓库）
├── AUDIT-M10.md                # 全栈审计报告（5 P0 + 15 P1 + 32 P2 清单）
├── AUDIT-M9.md / M9-DESIGN.md / DEPLOY.md / ROADMAP.md
├── Havix-Technical-Whitepaper.md / Havix-Vision.html
└── README.md
```

### 子仓库 `Embas`（翻译市场 App）

```
/workspace/Embas/
├── src/
│   ├── orders.js                # 订单生命周期（pending → accepted → delivered → accepted_final）
│   ├── arbitration-adapter.js   # 桥接 SDK arbitration 到 Embas 业务
│   ├── market-adapter.js        # 桥接 SDK market
│   ├── credit-adapter.js        # 桥接 SDK credit（含 escrow mutex P1-7）
│   ├── timeouts.js              # 自动 abstain + 已投票查询（P1-15）
│   ├── cli.js / web.js          # App CLI + Web API（含 DID/CID 脱敏 P1-14）
│   └── state.js / manifest.js
├── test/                        # 213 个用例（含 13 个 P1-14/P1-15 回归测试）
├── manifest.yaml                # capability: market / contexts: [B]
├── M10-DESIGN.md / USAGE.md / README.md
└── index.js                     # App 入口
```

---

## 3. 安全加固进度

### M8 集成前审计（已完成）

6 P0（关键安全）+ 6 P1（健壮性）+ 3 P2（可维护性）= **15 项全部修复**

详见 [README.md](./README.md) "审计修复" 章节。

### M9.6 安全加固第一步（已完成）

6 项立即修复（P0-1 state.js 路径穿越 / P1-1 AppManager entryPoint / P1-5 web.mount opts.dir / P1-7 跨 App 隔离 / P1-8 issueInvite fail-closed / P1-10 仲裁裁决 fail-closed）+ 27 个回归测试。

详见 [test/security-m96.test.js](./test/security-m96.test.js)。

### AUDIT-M10 全栈审计（本次完成）

5 P0 + 15 P1 + 32 P2 清单，详见 [AUDIT-M10.md](./AUDIT-M10.md)。

**P0（5 项）已全部修复**（前次会话完成）。

**P1（15 项）已全部修复**（本次会话按 5 个优先级批次完成）：

| 批次 | 编号 | 文件 | 修复内容 |
|---|---|---|---|
| 优先级 1 | P1-6 | Embas/src/cli.js | translate-accept 强制 translatorDid = 本节点 context-B |
| 优先级 1 | P1-13 | Embas/src/cli.js | dispute-file 强制 respondentDid = order.translatorDid |
| 优先级 2 | P1-7 | Embas/src/credit-adapter.js | freeze/release/transfer 加进程内 mutex |
| 优先级 2 | P1-8 | Embas/src/credit-adapter.js | transfer escrow 不足时抛错（拒绝 fallback） |
| 优先级 2 | P1-9 | Embas/src/credit-adapter.js | release amount > frozen 时抛错（拒绝截断） |
| 优先级 3 | P1-10 | Embas/src/market-adapter.js | payload spread 后预设字段（防覆盖） |
| 优先级 3 | P1-11 | Embas/src/market-adapter.js | callback 必须 try/catch（防冒泡） |
| 优先级 4 | P1-12 | Embas/src/state.js / manifest.js | minReputation 强制校验（fail-closed） |
| 优先级 4 | P1-14 | Embas/src/web.js | JSON API DID/CID 截断脱敏 |
| 优先级 4 | P1-15 | Embas/src/timeouts.js | 自动 abstain 前查询已投票 |
| 优先级 5 | P1-1 | src/config.js | loadConfig 路径穿越校验 |
| 优先级 5 | P1-2 | src/protocol/arbitration.js | castVote 状态校验（PANEL_FORMED/VOTING） |
| 优先级 5 | P1-3 | src/protocol/credit.js + s-node.js | note.signerPublicKey 与 issuerDid 绑定 |
| 优先级 5 | P1-4 | src/protocol/credit.js | ReputationLedger.get 懒创建不写盘 |
| 优先级 5 | P1-5 | src/network/tunnel.js | sendChunk MAX_CHUNK_SIZE 守卫 |

**P2（32 项）**：未修复，待 M11+ 按需处理。

---

## 4. 关键技术决策

### DID/CID 脱敏算法（P1-14）

- **DID 截断**：按 `:` 分割取 subject，subject 长度 > 5 才截断为 `did:havix:B:…6655`（保留前缀完整 + 末尾 4 字符）
- **CID 截断**：HEAD=8 + TAIL=4，长度 > 13 才截断为 `bafybeih…stuv`
- **原则**：截断后字符串必须严格短于原串才截断，否则保留可读性
- **sanitizeOrder 返回新对象**：用 `{ ...order }` 浅拷贝 + 嵌套字段重新展开，保证原对象不被污染

### 仲裁员投票双保险（P1-15）

- 优先调用 `arb.getMyVote?.(disputeId)`（SDK 提供时）
- 本地 `_votedDisputeIds` Set 兜底（SDK 未提供时）
- `getMyVote` 抛错降级为"未投票"处理，最坏情况是重复 abstain（不阻断流程）
- **关键原则**：仲裁员人工投票（guilty/not-guilty）不应被自动 abstain 覆盖

### issuerDid ↔ pubKey 绑定（P1-3）

- **first-seen wins** 策略：首次见到 issuerDid 签的 note 时登记其公钥
- 后续必须用同一公钥签，否则 note 视为伪造
- 防止攻击者获取 issuerDid 后用新 keypair 签 issue note（"旋转 keypair 攻击"）
- 持久化到 `reputation-v1.json` 的 `issuerPubKeys` 字段

### 路径穿越校验复用模式

- `sdk/manifest.js` 导出 `validateDataDir(value, name)` —— 拒绝绝对路径 + `..` + Windows 盘符
- `sdk/state.js` / `sdk/web.js` 已复用
- `src/config.js` 在 MVP 协议层独立实现 `validatePathInput`（不依赖 SDK，分层隔离）

---

## 5. 当前提交状态

### 主仓库 Havix

```
456ea2a AUDIT-M10 P1-1~P1-5 MVP 协议层修复（5 项）+ 41 回归测试
d98917b AUDIT-M10 + P0 修复 + SDK USAGE
346738c Update terminology from '私聊' to '私信'
5394e4e M9.6 security hardening step 1: fix 6 critical issues + 27 P0 tests
20aa9f2 Implement M9.5 empty-app reference template + integration tests
```

### 子仓库 Embas

```
0353920 AUDIT-M10 P1-6~P1-15 修复（10 项）+ 13 回归测试
2f767ac AUDIT-M10 + P0 修复 + Embas USAGE
ffd5b87 M10.6: 集成测试 + M10 完结
```

两个仓库都已 push 到 `main` 分支。

---

## 6. 内测关注点

按用户提到的"三份说明文件"内测：

1. **[README.md](./README.md)** —— 项目概览与已交付能力
2. **[DEPLOY.md](./DEPLOY.md)** —— 部署运行说明
3. **[sdk/USAGE.md](./sdk/USAGE.md) + [Embas/USAGE.md](./Embas/USAGE.md)** —— SDK 与 App 使用说明

可能遇到的问题类型：
- **运行时**：libp2p / Helia / IPFS 节点连接问题 → 检查 bootstrap 配置 + 防火墙
- **业务流程**：Embas 翻译订单 / 仲裁 / 信誉扣款链路 → 检查 [Embas/M10-DESIGN.md](./Embas/M10-DESIGN.md)
- **持久化**：节点重启后状态恢复 → 检查 `.data/` 目录权限
- **App 加载**：manifest.yaml 格式 / entryPoint 路径 → 检查 [sdk/manifest.js](./sdk/manifest.js)

---

## 7. 下一步方向（M11+）

按 [ROADMAP.md](./ROADMAP.md) 规划：

- **M11 多 App 并存 + 加权转换**：教学市场 + 维基 App 上线，FW-01 自然涌现算法 v0
- **M12 网络效应启动**：App 注册中心、Manifest 审核、第三方 App 准入流程
- **M13+ 横向能力扩展**：DID 旋转 / 多跳洋葱 / 跨网络联邦 / Rust 实现

**待处理的 32 项 P2**（可维护性 / 性能 / 文档）可在 M11 阶段按需穿插修复，不阻断主线。

---

*摘要生成时间：2026-07-19 · 测试基线 1234/1234 · 全部 P0 + P1 修复已落地*
