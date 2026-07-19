# Havix 技术白皮书

**Haven of Affinity —— 高认知个体自组织生境协议**

> 版本：v0.1.0-draft
> 状态：设计阶段，MVP 实现前
> 定位：协议规范草案 + 参考实现设计说明

---

## 摘要

Havix 是一个去中心化对等网络协议，用于验证社会学论文《底层高认知者的结构性困境》中提出的"分层自组织网络"假设。其核心主张是：**当主流集权系统的资源抽水比例过高、内卷失控时，高认知个体可以通过构建平行网络实现生存与意义的自我维系**。

Havix 不是暗网，不是 DAO，不是去中心化的 Discord。它的精确形态是：**去中心化传输 + 准入制空间 + 信誉锚定经济的 P2P overlay**。

- **不是暗网**：砍掉真正的洋葱路由，用单跳 relay + 信誉问责替代。匿名性比 Tor 弱，但延迟低一倍以上，且 relay 作恶有长期成本。
- **不是 DAO**：不做链上投票、不做 token 经济、不做治理代币。治理由临时仲裁团按需召集，裁决通过信誉 slash 自执行。
- **不是 Discord**：传输层完全去中心化，但每个"市场"是创建者主权空间——这恰好对应"高认知个体小生境"的边界属性。

本白皮书定义 Havix 协议的完整设计，包含架构、身份、经济、治理、部署、生态六个层面共 18 个核心决策。参考实现采用 Node.js 18 + libp2p 生态，但协议规范本身不绑死任何语言。

---

## 1. 项目背景

### 1.1 论文主张

社会学论文假设：在 S 国这样的高抽水比例集权系统中，高认知个体面临结构性困境——其产出的认知价值被系统以"税收""内卷""资源再分配"等形式抽走，个体无法通过法定渠道实现价值闭环。

论文提出破局路径：**高认知个体主动构建平行网络，在 P2P 协议层实现认知价值的去中心化交换**。Havix 是这一主张的技术验证载体。

### 1.2 设计哲学

Havix 的每一处设计都对应论文的一个核心命题：

| 论文主张 | Havix 实现 |
|---|---|
| 高认知个体自我维系 | 高信誉节点 Faucet 签发 Credit |
| 平行网络 | P2P overlay 完全脱离中心服务器 |
| 无中心治理 | 临时仲裁团 + 信誉 slash 自执行 |
| 不推翻但绕开 | 传输层不可见性 + 准入制空间 |
| 结构性困境 | Slash 只动冻结部分，治理不武器化 |
| 高认知者自治 | Relay/Rendezvous 准入门槛 + 编辑员资格 |

### 1.3 非目标（明确不做的事）

- 不追求绝对匿名（那需要真洋葱路由）
- 不做治理代币（避免交易所中心化漏洞）
- 不做"完全去中心化一切"（市场是创建者主权，这是设计而非缺陷）
- 不涉及任何现实政治或商业用途
- 不替代任何现实法律或治理系统

---

## 2. 核心架构

### 2.1 四层协议栈

```
┌─────────────────────────────────────────────────────────┐
│                    应用层（寄生）                         │
│  维基 SPA │ 市场 SPA(任意) │ 私信隧道 │ CLI 可视化        │
├─────────────────────────────────────────────────────────┤
│                    身份层                                 │
│  主DID → context 派生                                    │
│  A=公开畅游  B=市场  C=私信  D=维基编辑                  │
├─────────────────────────────────────────────────────────┤
│                协议层（公共/私域）                         │
│  维基协议  │ 市场协议  │ Offer/Credit  │ Vouch/Slash    │
├─────────────────────────────────────────────────────────┤
│                  经济层                                   │
│  Reputation(累积)  ⇄  Credit(可消耗)                    │
│  Faucet: 高信誉签发 credit 时冻结等额信誉                 │
│  仲裁: 5人临时团 → slash 50赔+50金库                      │
├─────────────────────────────────────────────────────────┤
│                  传输层                                   │
│  libp2p  │  gossipsub  │  单跳relay(概率轮换20%/epoch)   │
│  IPFS    │  noise E2E  │  电路硬切换                     │
└─────────────────────────────────────────────────────────┘
```

### 2.2 双平面隔离

Havix 的核心架构决策是**双平面隔离**——可见性在协议层硬性切分，不靠加密兜底。

```
┌─────────────────────────────────────────────────┐
│            私域平面（强加密、不可见）              │
│                                                 │
│  私有 gossipsub topic                           │
│  topic名 = sha256(邀请令牌)                      │
│  消息体 = 令牌派生的对称密钥再加密                │
│                                                 │
│  内含：市场SPA分发、私信电路协商、Credit流水      │
├─────────────────────────────────────────────────┤
│             ↕ 同一组节点，两个平面               │
├─────────────────────────────────────────────────┤
│            公共平面（可见、可审计）                │
│                                                 │
│  gossipsub mesh  ← 邻居发现、心跳、广播          │
│  KadDHT          ← 仅维基CID寻址                │
│  Rendezvous      ← 跨网段发现                    │
│  mdns            ← 局域网自动发现                │
└─────────────────────────────────────────────────┘
```

**为什么是双平面而非纯加密**：

- 纯加密方案：所有 CID 进 DHT，私域靠加密保护 → 攻击者可枚举网络成员、可观察谁在请求什么 CID
- 双平面方案：私域 CID **绝对不进 DHT**，只在私有 topic 内分发 → 攻击者连"有什么内容存在"都不知道

这对应论文主张"**集权系统的反面不是无政府，是分层可见性 + 准入自治**"。

---

## 3. 身份层

### 3.1 4-Context DID 派生

主 DID = ed25519 私钥。子身份通过 HKDF 派生，密码学上不可关联。

```
主 DID (mainKey)
    │
    ├── HKDF(mainKey, "context-A")  → 公开层畅游身份
    ├── HKDF(mainKey, "context-B")  → 市场参与身份
    ├── HKDF(mainKey, "context-C")  → 私信隧道身份
    └── HKDF(mainKey, "context-D")  → 维基编辑员身份
```

**不可关联性**：即使一个节点同时在维基写文章（DID-D）、在市场交易（DID-B）、在私信交流（DID-C），外部观察者无法把三个子 DID 关联到同一人。

**信誉独立累积**：每个 context 的信誉分独立累积，不互通。维基信誉和市场信誉是两套独立账本。

### 3.2 子身份的语义边界

| Context | 用途 | 信誉来源 | 准入凭证 |
|---|---|---|---|
| A | 公开层消息签名、维基读取 | 心跳/邻居贡献 | 无（默认开放） |
| B | 市场内交易、Credit 消费 | 市场 vouch 累积 | 邀请令牌 |
| C | 私信隧道握手 | 双向 vouch | 对端主动发起 |
| D | 维基条目写入 | 高质量内容获得 vouch | N 个高信誉节点背书 |

### 3.3 主 DID 信誉汇总（加权转换）

主 DID 信誉 = Σ(context_i.reputation × app_i.trustWeight)

其中 app_i.trustWeight 由 App Manifest 声明（0.0 ~ 1.0）。详见 §7 生态设计。

---

## 4. 经济模型

### 4.1 Reputation-Credit 双轨制

Havix 不能用真钱（合规风险 + 交易所中心化漏洞），但纯信誉分不可消耗，无法表达"我花掉了一次翻译服务"。因此采用双轨：

**Track 1: Reputation（不可消耗，累积型）**
- 来源：vouch 消息累积
- 用途：准入凭证（relay 资格、维基编辑员资格、市场创建权）
- 性质：长期信用，类似"信用评分"
- 范围：per-context 独立

**Track 2: Credit（可消耗，凭证型）**
- 来源：高信誉节点签发的"服务凭证"
- 用途：消费 offer
- 性质：可消耗 token，类似"代金券"
- 实现：IPFS 上的签名 JSON `{issuer, holder, amount, nonce, sig}`

### 4.2 Faucet 机制（Reputation → Credit 单向转换）

高信誉节点可以凭信誉签发 Credit，但签发会**冻结等额自身信誉**：

```
高信誉节点 Alice (rep=80)
  ↓ 签发 10 credit 给 Bob
Alice 信誉冻结 10 → 可用信誉 70，冻结 10
Bob 获得 10 credit（可消费任何 offer）
Bob 消费 credit → Alice 冻结的 10 信誉释放，Alice reputation 不变
```

**四个关键性质**：

1. **反通胀**：每张 credit 都有对应冻结的信誉背书，不能凭空印
2. **作恶成本**：Alice 签发的 credit 如果被用于恶意 offer，Alice 的冻结信誉会被 slash
3. **自然流通**：Bob 拿到 credit 可以再转给 Carol
4. **价值锚定**：credit 价值 = 签发节点信誉的"投影"，高信誉节点的 credit 更值钱

### 4.3 Credit 流转

```
正常路径：
  Alice (高信誉) → 签发 credit → Bob 持有 → 消费 Carol 的 offer
  → Carol 拿到 credit → Carol 向 Alice 兑换（或转手给他人）

纠纷路径：
  Bob 付了 credit 但 Carol 没交付 → Bob 发起 arbitration
  → 仲裁团调查 IPFS 上的 credit 流水
  → 裁决 Carol guilty → Carol 冻结的信誉部分释放给 Bob
```

Credit 流水完全在 IPFS 上可追溯，这是仲裁可执行性的基础。

---

## 5. 治理模型

### 5.1 临时仲裁团机制

**触发条件**（三种可发起 arbitration）：
1. **Offer 违约**：付了 credit 但没拿到服务
2. **Relay 作恶**：relay 节点泄露电路或篡改流量
3. **Vouch 舞弊**：相互刷 vouch 抬高信誉

**仲裁团组成**：
- 5 个节点，从"信誉 > 网络中位数 ×1.5 且 vouch 数 ≥ 10"的池子里随机抽取
- 排除纠纷双方的任何 vouch 关联节点（防串谋）
- 先响应的 5 个正式入团，其余作为候补
- 24 小时未达成裁决则重抽

### 5.2 裁决执行

- 每个仲裁员投 `guilty` / `not-guilty` / `abstain`
- 多数意见（≥3 票一致）为裁决
- 裁决通过 arbitration gossipsub topic 公开广播

### 5.3 Slash 机制（治理与经济的咬合点）

**关键设计：Slash 只动冻结部分，不动可用信誉**

- 如果 slash 能动可用信誉 → 攻击者可以靠仲裁把别人信誉打光 → 治理武器化
- 只动冻结部分 → slash 只影响"正在发行的 credit" → 治理成为"经济纠纷解决"而非"政治清洗"

**Slash 分配规则**：

- 50% 赔给受害者
- 50% 进入金库（暂冻结，MVP 阶段只进不出）
- 金库余额在 IPFS 上公开 ledger，所有人可审计

### 5.4 治理的论文对应

Havix 的治理不是"民主投票"（多数暴政），不是"中心执法"（S 国模型），是**"高信誉者的临时召集制"**——这恰好是历史上商会、行会、自治公社的真实治理形态。

---

## 6. 部署拓扑

### 6.1 混合拓扑选型

Havix 采用 **Gossip Mesh + Rendezvous + 门控 KadDHT** 的混合拓扑。

**为什么不用纯 DHT**：

- Kademlia DHT 查询可枚举 → 违背"私域不可见"
- DHT 内容全局可取 → 私域 CID 暴露
- 纯 DHT 是 Havix 的反模式，只用于公共维基 CID 索引

### 6.2 三层发现机制

| 发现场景 | 机制 | 范围 |
|---|---|---|
| 局域网 | mdns | 同子网 |
| 跨网段 | Rendezvous point | 全网 |
| 公共内容 | KadDHT | 全网 |

### 6.3 Rendezvous Point 准入

- Rendezvous point 由高信誉节点自愿承担
- 准入机制与 relay 准入完全复用：动态阈值（前 30%）+ 3 vouch
- 冷启动问题：第一个节点没有 rendezvous，靠 mdns + 手动 multiaddr 引导

### 6.4 KadDHT 门控规则

```javascript
// network/dht.js 伪代码
async findContent(cid) {
  if (cid.belongsToPrivateMarket) {
    throw new Error('Private CID cannot be resolved via DHT')
  }
  return kadDHT.findContent(cid)
}
```

- 维基 CID：进 KadDHT，公开可读
- 市场 CID：**绝对不进 DHT**，只在私有 gossipsub topic 内分发
- 私信 relay 电路：不进 DHT，relay 选择通过 context-B/C 私有 topic 协商

### 6.5 私域 Topic 双重加密

```
第一层：topic 名本身是哈希
  topic = sha256(inviteToken).toString('hex')
  → 攻击者扫描 topic 名，只能看到哈希

第二层：消息体用令牌派生密钥再加密
  key = HKDF(inviteToken, "market-encryption")
  ciphertext = AES-GCM(key, plaintext)
  → 即使有人暴力加入 topic，也解不开消息
```

---

## 7. 简化洋葱（单跳 Relay）

### 7.1 设计思路

Tor 的三跳洋葱是为了对抗"单点同时知道两端"的威胁。Havix 砍掉真洋葱后，用 **信誉问责** 替代：

- Tor 的 relay 是匿名志愿者、不可信任也不可问责
- Havix 的 relay 是有 vouch 分数累积的实体，作恶会损失长期信誉
- **用信誉换延迟**——Tor 没有的自由度

### 7.2 单跳 Relay + 多链路对冲

```
A → R1 → B   (1/3 流量)
A → R2 → B   (1/3 流量)
A → R3 → B   (1/3 流量)
```

- A、B 互相不知道对方真实 IP
- 单个 R 被攻破只能看到 1/3 流量片段
- 即使一个 R 是恶意的，也无法重组完整会话

### 7.3 Relay 准入与轮换

**准入**：动态阈值（前 30%）+ 至少 3 个高信誉节点 vouch

**轮换**：每个 epoch（1 小时）有 20% 概率被换下

**电路迁移**：MVP 采用硬切换——relay 下线时隧道断开，应用层重连。市场 SPA 是无状态请求/响应模型，断一下重连几乎无感。

---

## 8. 生态设计

### 8.1 三要素

Havix 的生态化依托三个开放规范：

1. **Havix Protocol Spec**：协议规范，语言无关
2. **Havix App Manifest**：应用宿主规范
3. **Reputation Portability**：信誉加权转换

### 8.2 App Manifest 规范（草案）

```yaml
name: "translation-market"
version: "1.0.0"
capability: "market"
permissions:
  - "gossipsub:publish"
  - "ipfs:read"
  - "identity:context-B"
invite_token_format: "ed25519-signature"
spa_cid: "bafy..."
min_reputation: 30
trust_weight: 0.8
```

每个私域市场 = 一个 App。App 通过 manifest 声明能力需求，节点决定是否加载。多个 App 可并存。

### 8.3 加权转换公式

```
主DID信誉 = Σ ( context_i.reputation × app_i.trustWeight )

其中：
  context_i = 该节点参与的某个 App
  app_i.trustWeight = App manifest 里声明的权重（0.0 ~ 1.0）
```

**四个深层性质**：

1. App 是自声明的信任域
2. 生态竞争自然涌现（高权重 App 受欢迎）
3. 攻击成本分层
4. 冷启动问题优雅解决

### 8.4 待解决问题：App 信任权重审核（FW-01）

**问题**：如果 App 自己声明权重，攻击者可建一个"权重 1.0 的刷分 App"自刷信誉，瞬间攻破加权转换。

**MVP 选择方案 C：自然涌现**（推迟到阶段二）

- 权重不由谁指定，而是通过"被多少高信誉节点使用"动态计算
- 阶段一无第三方 App，不存在刷分问题
- 阶段二有真实数据后再实现动态权重算法

### 8.5 生态化路线图

**阶段一：单实现 + 协议稳定（MVP）**
- Havix 参考实现跑通
- 协议规范定稿
- 不开放第三方实现

**阶段二：多 App + 加权转换（生态种子）**
- 3 个内置 App：翻译市场(0.8)、教学市场(0.5)、维基编辑(1.0)
- App Manifest 规范定稿
- FW-01 自然涌现算法实现

**阶段三：多实现 + 跨语言（真生态）**
- Rust 或 Go 实现（建议 Rust，libp2p Rust 生态成熟）
- JS 节点和 Rust 节点互通
- 协议规范从 RFC 草案变为正式版

---

## 9. 公共层消息协议

### 9.1 消息通用结构

所有公共层消息必须符合以下 JSON 结构，额外字段将被节点忽略：

```json
{
  "version": "v1.0",
  "type": "offer" | "vouch" | "arbitration" | "heartbeat" | "credit" | "acknowledge",
  "senderId": "节点PeerId的字符串形式",
  "timestamp": 1234567890,
  "payload": { }
}
```

### 9.2 各类型 Payload

**offer** —— 翻译服务通告
```json
{
  "sourceLang": "源语言代码",
  "targetLang": "目标语言代码",
  "contentCid": "IPFS内容标识符",
  "rewardToken": "自定义积分描述"
}
```

**vouch** —— 信誉背书（扩展为双重用途）
```json
{
  "targetId": "被背书节点的PeerId",
  "delta": -10到10的整数,
  "reason": "简短理由描述",
  "endorsementType": "reputation" | "relay" | "wiki-editor"
}
```

**arbitration** —— 仲裁请求（扩展为完整裁决流）
```json
{
  "disputeId": "冲突唯一标识",
  "claimant": "发起方PeerId",
  "respondent": "被诉方PeerId",
  "evidence": "证据的IPFS哈希",
  "type": "offer-breach" | "relay-malice" | "vouch-collusion",
  "verdict": "guilty" | "not-guilty" | null,
  "jurors": ["仲裁员PeerId"],
  "slashRatio": 0.5
}
```

**heartbeat** —— 心跳
```json
{
  "knownPeers": ["邻居节点PeerId数组"]
}
```

**credit** —— Credit 凭证（新增）
```json
{
  "issuer": "签发节点DID",
  "holder": "持有节点DID",
  "amount": 10,
  "nonce": "唯一nonce",
  "signature": "签发者签名",
  "consumedBy": "offer-id" | null
}
```

### 9.3 默认订阅频道

每个节点启动时必须订阅三个默认频道：

- `/s-network/announce` —— 通用通告
- `/s-network/reputation` —— vouch 与 credit 流水
- `/s-network/alert` —— arbitration 与裁决

---

## 10. 节点核心接口

### 10.1 SNode 类

```javascript
class SNode {
  constructor(options) {
    this.peerId        // libp2p 自动生成的 Ed25519 公钥哈希
    this.libp2p        // libp2p 实例
    this.ipfs          // IPFS 实例
    this.reputation    // Map<peerIdString, number>
    this.neighbors     // Set<peerIdString> 当前活跃邻居
    this.topics        // Set<string> 订阅的公共层频道
    this.identity      // Identity 派生器（4 context）
    this.credit        // Credit 账本
    this.relayState    // Relay 状态（是否当选、当前 epoch）
  }
}
```

### 10.2 启动流程

1. 初始化 IPFS，等待就绪
2. 初始化 libp2p（TCP + noise + mplex + gossipsub + KadDHT + rendezvous + mdns）
3. 派生 4 个 context 子身份
4. 公共平面初始化（订阅 3 个默认频道、启动 mdns、向 rendezvous 注册）
5. 启动定时器（心跳 30s / 拓扑维护 60s / Relay epoch 1h）
6. CLI 就绪

### 10.3 内部处理方法

- `handleOffer(message)` —— 打印翻译服务详情，回复 acknowledge
- `handleVouch(message)` —— 更新 reputation Map，双重用途（信誉背书 + relay 资格）
- `handleArbitration(message)` —— 高信誉节点自愿加入仲裁团，多数裁决
- `handleHeartbeat(message)` —— 更新邻居列表，发现新节点主动连接
- `handleCredit(message)` —— 验证签名，更新账本

---

## 11. MVP 路线图

### 11.1 八个里程碑

| 里程碑 | 关键产出 | 可演示能力 |
|---|---|---|
| M1 | 双平面传输基线 | 节点发现 |
| M2 | DID 派生 | 身份隔离 |
| M3 | 维基协议 | 公共内容协作 |
| M4 | Credit 双轨 | 经济流通 |
| M5 | 单跳 Relay | 匿名通信 |
| M6 | 仲裁团 | 去中心治理 |
| M7 | 邀请市场 | 私域不可见 |
| M8 | 集成收口 | 完整场景 |

### 11.2 各里程碑详细范围

**M1: 双平面传输基线**
- 改造 s-node.js：plaintext→noise，初始化双平面
- network/dht.js：KadDHT 仅索引公共 CID
- network/rendezvous.js：rendezvous client
- 验证：双节点 mdns 自动发现 + 跨网段 rendezvous 连接

**M2: 身份层（4-context DID 派生）**
- src/identity.js：HKDF 派生
- 主 DID = ed25519 私钥哈希
- 验证：4 个子 DID 不可关联

**M3: 维基协议**
- protocol/wiki.js：CID 广播 + 编辑员签名校验
- 编辑员资格 = N 个高信誉节点 vouch 累积
- 验证：维基条目发布、签名校验、无资格写入被拒

**M4: 经济层（Credit 双轨）**
- protocol/credit.js：Faucet + 冻结账本
- Credit 凭证 = IPFS 上的签名 JSON
- 验证：Credit 流水可追溯

**M5: 私信隧道（单跳 Relay）**
- network/tunnel.js：libp2p stream + noise + 单跳 relay
- network/relay.js：准入 + 概率轮换
- 验证：3 条并行 relay 各传 1/3 流量

**M6: 治理层（临时仲裁团）**
- protocol/arbitration.js：召集 + 投票 + slash 执行
- 5 个高信誉节点随机抽取
- 验证：完整仲裁流程 + slash 自执行

**M7: 邀请制市场（私域层骨架）**
- protocol/market.js：令牌签发 + 私有 topic + SPA 拉取
- App Manifest 基础版
- 验证：私域不可见性通过 traffic analysis 验证

**M8: CLI 收口 + 集成测试**
- app/cli.js：命令补全
- 信誉持久化
- 4 节点集成测试

### 11.3 集成测试场景

启动 4 个节点（alpha/beta/gamma/delta），验证完整场景：

- 4 节点自动组网
- alpha 发布维基条目，beta/gamma/delta 都能读到
- alpha 在翻译市场发布 offer，beta 用 credit 消费
- gamma 不交付 → alpha 发起仲裁 → 仲裁团裁决 + slash
- alpha 与 delta 建立私信隧道
- alpha 创建私域市场，邀请 delta 加入
- 强制关掉 alpha → 其他节点 90 秒内检测到并自愈拓扑

---

## 12. 未来工作

| ID | 问题 | MVP 选择 | 推迟原因 |
|---|---|---|---|
| FW-01 | App 信任权重审核 | 自然涌现（方案 C） | 阶段二才需要，需要真实使用数据 |
| FW-02 | 金库释放机制 | 7 节点联签 + 30 天公示 | 阶段一无公共物品资助需求 |
| FW-03 | DID 旋转 | 子身份被关联后换发 | 阶段一威胁模型未到这一级 |
| FW-04 | 跨 context 信誉流动 | 当前不可，未来按 App 权重转换 | 阶段二实现 |
| FW-05 | 多跳洋葱升级 | 单跳不够安全时扩展 | 性能瓶颈出现后再考虑 |
| FW-06 | 网络分片联邦 | 多个 Havix 网络联邦 | 单网络稳定后再考虑 |

---

## 13. 设计决策清单（共 18 项）

| # | 层 | 决策点 | 选择 |
|---|---|---|---|
| 1 | 架构 | 整体形态 | CLI 节点 + 本地面板 |
| 2 | 架构 | 匿名性 | vouch-anchored overlay |
| 3 | 架构 | 简化洋葱 | 单跳 relay + 多链路对冲 |
| 4 | 身份 | DID 策略 | 4 context 派生（A/B/C/D） |
| 5 | 协议 | 私域不可见语义 | 内容加密 + 邀请令牌 |
| 6 | 协议 | Relay 准入 | 动态阈值（前 30%）+ 3 vouch |
| 7 | 协议 | 市场令牌 | 创建者签发 |
| 8 | 协议 | Relay 轮换 | 概率 20%/epoch |
| 9 | 协议 | 电路迁移 | 硬切换 + 应用层重连 |
| 10 | 经济 | 经济模型 | Reputation + Credit 双轨 |
| 11 | 经济 | Faucet 机制 | 签发 credit 时冻结等额信誉 |
| 12 | 治理 | Slash 分配 | 50 赔 + 50 金库（暂冻结） |
| 13 | 部署 | 拓扑语义 | 双平面隔离 |
| 14 | 部署 | 跨网段发现 | Rendezvous（非固定 bootstrap） |
| 15 | 部署 | KadDHT 用途 | 仅公共维基 CID |
| 16 | 生态 | 信誉汇总 | 加权转换（context × App 权重） |
| 17 | 生态 | App 权重审核 | 自然涌现（FW-01 推迟） |
| 18 | 命名 | 官方释义 | Haven of Affinity（不用"庇护"） |

---

## 14. 命名说明

**协议名**：Havix

**官方释义**：Haven of Affinity（亲和之港）

**禁止释义**：庇护网络

**理由**：
- "庇护"暗含被动，是弱势语境
- 论文主张是"高认知个体主动构建平行网络"——主动叙事
- 把"主动构建"翻译成"庇护"，叙事重心从"自治"滑向"流亡"
- Havix 保留音感（haven + helix 合成），但释义改为主动叙事

**论文用词**：Havix Protocol / 高认知个体自组织生境协议

---

## 15. 免责声明

Havix 仅用于学术验证目的，不涉及任何现实政治或商业用途。

- 所有消息内容和测试数据均使用虚构示例（如翻译"hello world"或"这是一段测试文本"）
- 不涉及任何敏感或真实人类信息
- 公共层协议仅用于演示认知价值的去中心化交换
- 不替代任何现实法律或治理系统
- 不追求绝对匿名性，不构成对任何现实司法管辖的规避
- 所有经济机制（Reputation/Credit）仅作为协议内部记账，不构成任何金融工具

---

## 附录 A：参考实现技术选型

| 类别 | 选择 |
|---|---|
| 运行环境 | Node.js 18+，ES Module |
| P2P 传输 | @libp2p/tcp |
| 加密 | @chainsafe/libp2p-noise |
| 多路复用 | @libp2p/mplex |
| PubSub | @chainsafe/libp2p-gossipsub |
| DHT | @libp2p/kad-dht |
| Rendezvous | @libp2p/rendezvous |
| 内容寻址 | helia 或 ipfs-core |
| 消息编码 | JSON（初期，后续可换 Protobuf） |

## 附录 B：目录结构

```
src/
  s-node.js          主入口
  config.js          配置
  identity.js        DID 派生
protocol/
  message-types.js   消息定义
  wiki.js            维基协议
  market.js          市场协议
  credit.js          Faucet + 账本
  arbitration.js     临时仲裁团 + slash
network/
  topology.js        双平面邻居管理
  tunnel.js          noise + relay
  rendezvous.js      rendezvous 注册/查询
  dht.js             公共 CID 门控
  relay.js           relay 准入 + 轮换
app/
  cli.js             命令行 + 本地面板
```

---

**文档结束**

本白皮书是设计阶段草案，将随 MVP 实现迭代更新。所有 18 个核心决策已锁定，未来工作项已归档。
