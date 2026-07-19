# Havix 部署说明

> **当前阶段**：MVP（M1–M8.3 已交付，596/596 测试通过）
> 协议设计见 [技术白皮书](./Havix-Technical-Whitepaper.md)，项目概览见 [README](./README.md)。

本文件覆盖：单节点 / 多节点 / 服务化部署 / Web 面板 / 持久化 / 安全约束 / 故障排查 / 已知限制。

---

## 1. 系统要求

| 项目 | 要求 | 备注 |
| --- | --- | --- |
| Node.js | **>= 18.0.0**（推荐 20.12+，CLI 彩色输出在 20.12+ 用 `util.styleText`，旧版本自动降级为纯文本） | `package.json` 的 `engines` 字段强制约束 |
| 操作系统 | Linux / macOS / Windows | 生产部署建议 Linux（systemd / Docker 友好）；文件权限 0o600/0o700 在 Windows 上不生效但不报错 |
| 网络 | 节点间 TCP 可达 | 默认监听 `0.0.0.0:<port>`；多节点测试时各节点端口必须互不冲突 |
| 磁盘 | ~50 MB（依赖） + 数据目录 | 数据目录默认 `.data/`，含 8 个 ledger JSON 文件 + IPFS blockstore |
| 内存 | ~150 MB（单节点稳态） | libp2p + helia + gossipsub，无重型计算 |

**依赖版本**（关键项，详见 [package.json](./package.json)）：
- `libp2p@^3.3.5` / `@libp2p/gossipsub@^16.0.4` / `@libp2p/tcp@^11.0.23`
- `helia@^7.1.0` / `@helia/libp2p@^1.0.6` / `@helia/bitswap@^4.0.6`
- `@noble/curves@^2.2.0`（Ed25519 签名验证）/ `@libp2p/crypto@^5.1.21`
- `multiformats@^14.0.4` / `@multiformats/multiaddr@^13.0.3`

> 这两个包原本作为传递依赖被引入，M8 审计修复后提升为直接依赖（防止版本漂移）。

---

## 2. 安装

```bash
# 1. 克隆仓库
git clone <repo-url> havix
cd havix

# 2. 安装依赖（约 692 个包，首次 ~60s）
npm install

# 3.（可选）复制环境变量模板
cp .env.example .env
# 按需编辑 .env，所有变量可省略，节点用默认值启动

# 4.（可选）验证安装：跑全量测试
npm test
# 预期：596/596 通过，约 50s
```

**测试套件分布**（M8.3 收尾后）：
- 单元测试（identity / credit / arbitration / market / wiki / vouch / persistence / cli / web-panel / s-node）
- 集成测试（bootstrap-e2e / dht-gate-e2e / restart-recovery / four-nodes-e2e）
- 用例数：596；含 M8.3 17 个 4 节点集成测试 + M8 审计修复 4 个安全测试

环境变量 `HAVIX_SKIP_E2E=1` 可跳过慢速的 e2e 测试（CI 慢机友好）。

---

## 3. 快速开始：单节点

```bash
# 最简启动：随机端口 + mDNS 自动发现 + REPL + Web 面板
npm start

# 或带参数
node src/s-node.js --port 9001 --name alpha
```

启动后控制台输出：

```
  ╔════════════════════════════════════════╗
  ║  Havix — Haven of Affinity              ║
  ║  ...
  ╚════════════════════════════════════════╝

  [config] name      = alpha
  [config] port      = 9001
  [config] dataDir   = .data
  [config] mdns      = true
  [config] bootstrap = []
  [config] dht       = true (lan)
  [config] logLevel  = info
  [config] repl      = true
  [config] web       = true (127.0.0.1:7331)

  [ipfs] 初始化 IPFS (helia) + libp2p...
  [identity] 4-context DID 已派生...
  [pubsub] 已订阅 3 个公共层 topic
  [web-panel] 监听 http://127.0.0.1:7331/  (拓扑可视化 + 状态 API)
  [cli] REPL 已启动，输入 help 查看命令（Ctrl+D 退出）
```

**典型交互**（REPL 提示符 `havix> `）：

```
havix> help               # 列出所有 43 个命令
havix> status             # 节点概览（peerId / 邻居 / registry 计数）
havix> identity           # 4-context DID（A=public/B=market/C=tunnel/D=wiki）
havix> vouch <did-D>      # 给维基编辑员背书
havix> credit-issue <holderDid> 10   # 签发 10 credit（冻结等额信誉）
havix> wiki-publish --title="Hello" --content="# Hello Havix"
havix> exit               # 优雅退出（等同 Ctrl+D）
```

**Web 面板**：浏览器打开 `http://127.0.0.1:7331/` 即可看到拓扑可视化（vis-network，5 秒自动刷新），13 个 JSON API 端点见 §6。

---

## 4. 配置参考

配置优先级（高 → 低）：**命令行参数 > 环境变量 > 默认值**。完整选项见 [src/config.js](./src/config.js) 的 `printHelp()`。

### 4.1 命令行参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--port <number>` | int | `0`（随机） | libp2p TCP 监听端口；0=系统分配 |
| `--name <string>` | string | `havix-node` | 节点显示名（仅日志） |
| `--data-dir <path>` | path | `.data` | 数据目录（IPFS blockstore + ledger JSON） |
| `--bootstrap <multiaddr>...` | multiaddr[] | `[]` | 跨网段引导节点，支持空格分隔多个或逗号分隔 |
| `--mdns <true\|false>` | bool | `true` | 启用局域网 mDNS 自动发现 |
| `--dht <true\|false>` | bool | `true` | 启用 KadDHT |
| `--dht-mode <lan\|wan>` | enum | `lan` | DHT 模式：`lan`=私有局域网 DHT，`wan`=接入公网 IPFS DHT |
| `--log <level>` | enum | `info` | `debug`/`info`/`warn`/`error` |
| `--repl` / `--no-repl` | bool | `true` | 启动后进入交互式 REPL |
| `--web` / `--no-web` | bool | `true` | 启动本地 Web 面板 |
| `--web-port <number>` | int | `7331` | Web 面板端口（0=随机） |
| `--web-host <host>` | host | `127.0.0.1` | Web 面板监听地址（**改非回环地址会触发安全警告**，见 §8） |
| `-h, --help` | flag | — | 打印帮助并退出 |

### 4.2 环境变量

完整列表（命令行同名 `HAVIX_*` 前缀；命令行覆盖环境变量）：

```bash
HAVIX_PORT=0
HAVIX_NAME=havix-node
HAVIX_DATA_DIR=.data
HAVIX_BOOTSTRAP=                          # 逗号分隔的 multiaddr
HAVIX_MDNS=true
HAVIX_DHT=true
HAVIX_DHT_MODE=lan                        # lan | wan
HAVIX_LOG=info

# M8.2 应用层
HAVIX_REPL=true                           # true | false
HAVIX_WEB=true
HAVIX_WEB_PORT=7331
HAVIX_WEB_HOST=127.0.0.1                  # 不要改为 0.0.0.0（见 §8）
```

完整模板见 [.env.example](./.env.example)。

### 4.3 启动顺序（内部）

启动：`SNode.start()` → `WebPanel.start()` → `Cli.start()`（REPL 最后，readline 保持 event loop）。

退出：`Cli.stop()` → `WebPanel.stop()` → `SNode.stop()`（与启动相反，先关 readline 否则 stdin 卡住 `node.stop()`）。

**失败隔离**：
- `WebPanel.start()` 失败不阻断节点（`webPanel = null`，仅日志 warn）
- `Cli.start()` 失败同理
- `SNode.start()` 失败**致命**：运行模式 `exit(1)`，测试模式抛错让测试断言（P2-1 修复：先 `stop()` 清理半启动资源再抛）

**信号处理**：注册 `SIGINT` / `SIGTERM` 触发优雅退出（按上述顺序）。

---

## 5. 多节点部署

### 5.1 局域网（mDNS 自动发现）

同一局域网内多节点启动，无需配置 bootstrap：

```bash
# 节点 A
node src/s-node.js --port 9001 --name alpha

# 节点 B（另一台机器或另一终端）
node src/s-node.js --port 9002 --name beta

# mDNS 自动发现，几秒内自动连接
```

**适用场景**：办公室 / 家庭局域网测试，无需知道对方 IP。

**禁用 mDNS**：`--mdns false`（强制走 bootstrap，常用于确定性测试）。

### 5.2 跨网段（bootstrap 引导）

跨网段或 NAT 后的节点必须用 `--bootstrap` 显式引导：

```bash
# 1. 启动种子节点 A，记下其 multiaddr（含 peerId）
node src/s-node.js --port 9001 --name alpha
# 日志会打印：
#   [libp2p] 监听 /ip4/0.0.0.0/tcp/9001/p2p/12D3Koo...
#   [identity] PeerId = 12D3Koo...
# 取本机可达地址（假设 192.168.1.10）：
#   /ip4/192.168.1.10/tcp/9001/p2p/12D3Koo...

# 2. 启动节点 B，bootstrap 到 A
node src/s-node.js --port 9002 --name beta \
  --bootstrap /ip4/192.168.1.10/tcp/9001/p2p/12D3Koo... \
  --mdns false

# 3. 节点 C 同样引导到 A（star 拓扑）
node src/s-node.js --port 9003 --name gamma \
  --bootstrap /ip4/192.168.1.10/tcp/9001/p2p/12D3Koo... \
  --mdns false
```

**HAZARD**：bootstrap 失败不会让节点崩溃（仅日志 warn），需通过 `status` / `neighbors` 命令验证连接成功。

### 5.3 多个 bootstrap

```bash
# 用空格分隔多个，遇到下一个 -- 开头的参数停止
node src/s-node.js --bootstrap \
  /ip4/10.0.0.1/tcp/9001/p2p/12D3KooAAA \
  /ip4/10.0.0.2/tcp/9001/p2p/12D3KooBBB \
  /ip4/10.0.0.3/tcp/9001/p2p/12D3KooCCC

# 或用逗号
node src/s-node.js --bootstrap=/ip4/10.0.0.1/tcp/9001/p2p/AAA,/ip4/10.0.0.2/tcp/9001/p2p/BBB
```

### 5.4 star 拓扑 4 节点测试拓扑

M8.3 用的测试拓扑（[test/four-nodes-e2e.test.js](./test/four-nodes-e2e.test.js)）：

```
        ┌─────────┐
        │  A:9801 │  中心节点
        └────┬────┘
       ┌─────┼─────┐
       │     │     │
   ┌───▼──┐ ┌▼───┐ ┌▼───┐
   │B:9802│ │C:9803│ │D:9804│  叶子节点
   └──────┘ └────┘ └────┘
```

端口段 9801-9804（避开 bootstrap-e2e 9701-9703 与 dht-gate-e2e 9401-9402）。所有叶子通过 bootstrap 连 A，禁用 mDNS 保证确定性。

---

## 6. Web 面板

启动后浏览器打开 `http://127.0.0.1:7331/`。

### 6.1 拓扑可视化

- 基于 [vis-network 9.1.9](https://github.com/visjs/vis-network) CDN（jsdelivr），暗色 GitHub 主题
- 8 种节点分组：`self` / `context-DID` / `peer` / `relay-active` / `relay-candidate` / `market` / `vouched` / `tunnel-src-dst`
- 5 类边：`context`（主身份→子身份）/ `p2p`（peer 连接）/ `vouch` / `tunnel` / `market creator`
- 5 秒自动刷新（轮询，无 WebSocket；实时推送 deferred 到未来工作）
- 右侧实时状态面板（peerId / 邻居数 / 各 registry 计数）
- 左下角图例

### 6.2 JSON API 端点（13 个）

```
GET /healthz                       # 健康检查（200 OK）
GET /api/status                    # 节点概览
GET /api/identity                  # 4-context DID
GET /api/neighbors                 # 已连接 peer
GET /api/topics                    # 订阅的 gossipsub topic
GET /api/topology                  # 拓扑数据（节点 + 边）
GET /api/registry/vouch            # vouch 关系图
GET /api/registry/wiki             # wiki 条目索引
GET /api/registry/credit           # credit 余额 + 信誉
GET /api/registry/dispute          # 仲裁案件
GET /api/registry/market           # 市场列表
GET /api/registry/treasury         # 金库余额与历史
GET /api/registry/tunnel           # 隧道状态
GET /api/registry/relay            # relay 当选集
```

**约束**：
- **仅 GET**：POST/PUT/DELETE 返回 405，无任何 mutation 接口（写操作走 CLI）
- **`Cache-Control: no-store`**：防缓存
- **不显示私钥**：JSON 与 HTML 都验证 `privateKey` / `secret` 字段不出现
- **Host 头校验**：M8 审计修复 P1-F，防 DNS rebinding 攻击（见 §8.3）

### 6.3 健康检查（探活）

```bash
curl http://127.0.0.1:7331/healthz
# {"ok":true,"ts":"2026-..."}
```

---

## 7. 持久化与重启恢复

### 7.1 持久化范围（M8.1）

数据目录 `<dataDir>/ledgers/` 下 8 个 JSON 文件：

| 文件 | 内容 |
| --- | --- |
| `reputation.json` | ReputationLedger（available/frozen/total 三池信誉） |
| `credit.json` | CreditLedger（holderDid → balance） |
| `vouches.json` | VouchRegistry（endorseDid → Set<voucherDid>） |
| `wiki-index.json` | WikiProtocol 索引（cid → manifest） |
| `arbitration.json` | ArbitrationRegistry（disputes + panel + votes + jurorPool） |
| `treasury.json` | TreasuryLedger（金库余额 + 历史） |
| `markets.json` | MarketRegistry（markets + AES 密钥 base64 + seenNonces） |
| `credit-nonces.json` | credit 消息幂等去重集合（防双花） |

### 7.2 文件安全

- 文件权限 **0o600**（仅所有者可读写）
- 目录权限 **0o700**（仅所有者可访问）
- 原子写：`.tmp` 临时文件 + `renameSync`（崩溃前最后一次 mutation 可能丢失，但不会损坏文件）
- 写盘失败只 log warn，不让磁盘问题导致业务状态回滚

### 7.3 重启行为

```
节点 stop() → 8 个 ledger 文件 flush 到磁盘
节点 start() → loadState(loadJson(path)) 从磁盘恢复
```

**关键发现**（M8.3-3 验证）：
- libp2p 重启生成**新随机密钥对** → peerId + 4-context DID 全部变化
- 持久化的 DID-keyed 状态变成 "orphan" 数据，但旧 DID 的 ledger 数据仍可被查询（`getBalance(anyDid)` 取到余额）
- **真正可重启恢复的场景**：持久化的"外部 DID"数据（如 external-holder credit）跨重启保持
- **nonce 重放保护是跨重启的核心安全性质**：重启后 nonce 集合从磁盘恢复，重放同 nonce 消息被拒绝（防双花）

### 7.4 备份与迁移

```bash
# 备份
cp -r .data/ /backup/havix-$(date +%Y%m%d)/

# 迁移到新机器
rsync -av .data/ user@new-host:/path/to/havix/.data/
```

> **未来工作**：M8.1 明文 JSON，未来 M9+ 加 AES-GCM 加密保护本地账本隐私。多版本快照 / WAL deferred。

---

## 8. 安全注意事项

### 8.1 Web 面板绑定地址（P0-D 修复）

**默认**：`--web-host 127.0.0.1`（仅本地访问）

**不要改为 `0.0.0.0` 或公网 IP**：M8.2 Web 面板**无认证机制**，远程访问会泄露所有 registry 数据，包括：
- 信誉余额
- 市场 AES 密钥
- vouch 关系图谱
- credit 余额
- 仲裁案件详情

如需远程访问，建议通过：
1. **SSH 隧道**：`ssh -L 7331:127.0.0.1:7331 user@havix-host`，本地访问 `http://127.0.0.1:7331/`
2. **反向代理 + 认证**：Nginx/Caddy 加 Basic Auth 或 OAuth，转发到 `127.0.0.1:7331`

强行 `--web-host 0.0.0.0` 会触发控制台显眼警告（不阻断，保持灵活性，未来加 token 认证后可公网）。

### 8.2 Host 头校验（P1-F 修复，防 DNS rebinding）

Web 面板 `_handle()` 开头校验 HTTP `Host` 头是否在白名单内：

```
允许的 Host（不区分大小写）：
  <host>:<port>           # 如 127.0.0.1:7331
  localhost:<port>
  127.0.0.1:<port>
  <host>                  # HTTP/1.0 无端口
  localhost
  127.0.0.1
  ''                      # HTTP/1.0 无 Host 头
```

其他 Host 头返回 `403 {"error":"Host 头不被信任（防 DNS rebinding）"}`。

### 8.3 文件权限（P0-A 修复）

- ledger 文件权限 0o600（仅所有者可读写）
- ledger 目录权限 0o700（仅所有者可访问）
- 防本机其他用户读取敏感数据
- Windows 无 POSIX 权限，自动降级（不报错但不生效）

**生产建议**：用专用用户跑 havix 进程（如 `havix`），数据目录属主设为该用户，`chmod 700 .data`。

### 8.4 协议层安全（M8 审计修复摘要）

完整审计见 README "审计修复" 章节。摘要：

- **P0-1** 签名覆盖整个 canonical message（防 senderId/type 篡改）
- **P0-2** credit note 内层签名验证 + senderId === issuerDid 绑定（防伪造 issuer）
- **P0-3** topic 前缀分流（市场消息走私域路径，公共层签名校验不误拒）
- **P0-4** InviteToken.verifySelf() 零依赖自验签（防伪造 issuer 签发令牌）
- **P0-5** gossipsub handler 顶层 try/catch（防 handler 异常导致节点崩溃 DoS）
- **P0-6** slash 0 守卫（frozen=0 跳过，防 zero-amount 路径崩溃）

### 8.5 网络层

- **TCP + noise E2E 加密**：所有 libp2p 连接强制 noise 加密（替代原规格的 plaintext）
- **DHT 默认 lan 模式**：不接入公网 IPFS Amino DHT，使用私有协议 `/ipfs/lan/kad/1.0.0`
- **DHT 门控**：私域 CID 硬拦截公网 DHT 路由（[src/network/dht.js](./src/network/dht.js)）
- **gossipsub strictSigning**：强制消息签名
- **市场消息双重加密**：私域 topic（SHA-256(令牌)） + AES-256-GCM（HKDF 派生密钥）

---

## 9. 服务化部署

### 9.1 systemd

`/etc/systemd/system/havix.service`：

```ini
[Unit]
Description=Havix Node
After=network.target

[Service]
Type=simple
User=havix
Group=havix
WorkingDirectory=/opt/havix
Environment=NODE_ENV=production
Environment=HAVIX_NAME=prod-node-1
Environment=HAVIX_PORT=9001
Environment=HAVIX_DATA_DIR=/var/lib/havix
Environment=HAVIX_REPL=false
Environment=HAVIX_WEB=true
Environment=HAVIX_WEB_HOST=127.0.0.1
Environment=HAVIX_WEB_PORT=7331
Environment=HAVIX_LOG=info
# bootstrap 节点（按需）
# Environment=HAVIX_BOOTSTRAP=/ip4/10.0.0.1/tcp/9001/p2p/12D3Koo...

ExecStart=/usr/bin/node /opt/havix/src/s-node.js
Restart=on-failure
RestartSec=5s

# 安全
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/havix
# 文件权限
UMask=0077

[Install]
WantedBy=multi-user.target
```

**关键点**：
- `HAVIX_REPL=false`：服务模式不开 REPL（无 stdin）
- `UMask=0077`：与文件权限 0o600/0o700 一致（双重保险）
- `User=havix`：专用用户，数据目录属主隔离

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now havix
sudo systemctl status havix
sudo journalctl -u havix -f    # 实时日志
```

### 9.2 Docker

`Dockerfile`：

```dockerfile
FROM node:20-slim

WORKDIR /app

# 复制 package.json 并安装依赖（利用 layer cache）
COPY package.json ./
RUN npm install --omit=dev

# 复制源码
COPY src/ ./src/
COPY .env.example ./

# 数据目录（运行时挂载 volume）
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

# 切换非 root 用户
USER node

# 默认配置（可被 docker run -e 覆盖）
ENV HAVIX_DATA_DIR=/data
ENV HAVIX_REPL=false
ENV HAVIX_WEB_HOST=127.0.0.1
ENV HAVIX_WEB_PORT=7331

EXPOSE 9001 7331

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7331/healthz').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "src/s-node.js", "--port", "9001"]
```

构建与运行：

```bash
docker build -t havix:latest .

# 单节点
docker run -d \
  --name havix-1 \
  -p 9001:9001 \
  -p 127.0.0.1:7331:7331 \
  -v havix-data-1:/data \
  -e HAVIX_NAME=node-1 \
  havix:latest

# 多节点（用 docker network）
docker network create havix-net
docker run -d --name havix-1 --network havix-net \
  -p 127.0.0.1:7331:7331 -v havix-data-1:/data \
  -e HAVIX_NAME=node-1 havix:latest

# 节点 2 bootstrap 到节点 1（用容器名解析）
docker run -d --name havix-2 --network havix-net \
  -p 127.0.0.1:7332:7331 -v havix-data-2:/data \
  -e HAVIX_NAME=node-2 \
  -e HAVIX_PORT=9001 \
  -e HAVIX_MDNS=false \
  -e HAVIX_BOOTSTRAP=/ip4/havix-1/tcp/9001/p2p/12D3Koo... \
  havix:latest
```

**关键点**：
- `-p 127.0.0.1:7331:7331`：Web 面板**只绑回环**到 host，不暴露公网
- `-v havix-data-1:/data`：数据卷持久化
- `USER node`：非 root 运行
- `HEALTHCHECK`：用 `/healthz` 探活

### 9.3 反向代理 + 认证（远程 Web 访问）

如需远程访问 Web 面板，**必须**加认证层。Caddy 示例：

```caddyfile
havix.example.com {
    basicauth {
        admin $2a$14$...bcrypt-hash...
    }
    reverse_proxy 127.0.0.1:7331
}
```

Nginx 示例：

```nginx
server {
    listen 443 ssl http2;
    server_name havix.example.com;

    ssl_certificate     /etc/letsencrypt/.../fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/.../privkey.pem;

    auth_basic           "Havix";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:7331;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

> 注意：反向代理必须正确转发 `Host` 头（与 §8.2 白名单匹配，或保持 127.0.0.1）。如要允许外部域名 Host，需要修改 [src/app/web-panel.js](./src/app/web-panel.js) 的 `allowedHosts`。

---

## 10. 故障排查

### 10.1 启动失败

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `Error: --port 必须是 0-65535 之间的整数` | 端口参数格式错误 | 检查 `--port` 值 |
| `Error: listen EADDRINUSE` | 端口已被占用 | 换端口或 `lsof -i :9001` 找占用进程 |
| `ERR_MODULE_NOT_FOUND @libp2p/tcp` | 依赖未安装 | `npm install` |
| `SNode 启动失败` 后退出 | libp2p / helia 初始化失败 | 看 `[error]` 日志，常见为端口冲突 / 权限不足 |
| Web 面板 `EACCES` | 端口权限（<1024 需 root） | 用 >1024 端口 |

### 10.2 bootstrap 连不上

```
[bootstrap] 警告：无法连接 /ip4/.../tcp/9001/p2p/...
```

**检查清单**：
1. 种子节点是否已启动？`status` 看 peerId
2. multiaddr 的 IP / 端口 / peerId 是否正确？
3. 防火墙是否放行 TCP 端口？（云服务商安全组）
4. NAT 后的节点需用公网 IP + 端口转发
5. mDNS 是否误启用导致干扰？跨网段建议 `--mdns false`

### 10.3 gossipsub 消息不传播

```
[pubsub] 已发布到 /s-network/reputation，recipients=0
```

**原因**：没有 peer 订阅同 topic。

**解决**：
1. `neighbors` 确认已连接 peer
2. `topics` 确认双方都订阅了 3 个公共层 topic
3. 用 `--log debug` 看消息收发详情

### 10.4 持久化数据丢失

**检查**：
1. `--data-dir` 路径是否正确？
2. `.data/ledgers/` 下是否有 8 个 JSON 文件？
3. 文件权限是否 `0o600`？（`ls -la .data/ledgers/`）
4. 节点 `stop()` 是否正常完成？（异常退出可能未 flush）

**注意**：libp2p 重启会生成新 peerId / DID，旧 DID-keyed 状态变 orphan 但仍可查询。这是设计取舍（M8.3 验证）。

### 10.5 内存持续增长

**原因**：长跑节点的 Set / Map 累积。

**已缓解**（M8 审计修复 P1-lru）：所有 Set/Map 加 100,000 上限，超限时 FIFO 退化 LRU 移除最早项。

**监控**：通过 Web 面板 `/api/status` 看 registry 计数，超过 80,000 时关注。

### 10.6 测试失败

```bash
# 完整运行
npm test

# 跳过慢速 e2e
HAVIX_SKIP_E2E=1 npm test

# 单独运行某个测试文件
node --test test/four-nodes-e2e.test.js

# 详细输出
node --test --test-reporter=spec test/**/*.test.js
```

**常见测试失败**：
- `port already in use`：其他 havix 实例未退出；`lsof -i :9801`
- `timeout`：慢机CI，可设 `NODE_OPTIONS=--max-old-space-size=4096`
- `ECONNREFUSED`：检查测试用的 bootstrap 节点是否启动

---

## 11. 已知限制（MVP 范围外）

### 11.1 安全相关 Deferred（26 项）

完整清单见 README 与白皮书。摘要：

- 跨节点信誉同步协议（M4 用本地账本视图，靠 gossipsub 消息收敛）
- 节点身份持久化（重启 DID 变化导致 orphan 数据）
- 24h 超时重抽（M6 由外部触发，定时器未实现）
- 真实分布式随机数 VRF（M6 用 Math.random）
- 令牌吊销列表 CRL（M7 用 expiresAt 过期）
- 跨节点市场成员同步（M7 本地视图）
- 跨节点 tunnel relay 选举（M5 本地视图）
- ledger 加密存储（M8.1 明文 JSON）
- Web 面板认证（M8.2 仅本地访问）
- SRI 子资源完整性（vis-network CDN 加载未做 SRI 校验）

### 11.2 功能性 Deferred

- vouch 自动给 endorseDid 累积 reputation
- Reputation 时间衰减
- 信用汇率（高信誉节点 credit 更值钱）
- 真实 libp2p stream 跨进程传输（M5 用字节级接口）
- 电路迁移应用层重连（M5 硬切换）
- relay 服务质量监控
- 候补仲裁员自动补位（M6 用固定 5 节点）
- 金库支出用途治理（M6 只进不出）
- 金库 ledger 写入 IPFS 公开审计
- market 内 offer/credit 完整流转（M7 只提供加密通道）
- SPA bundle 拉取与缓存（M7 用 IPFS CID 占位）
- App Manifest 动态权重审核
- 第三方 App 加载
- Web 面板 WebSocket 实时推送
- CLI 命令历史持久化 / 命令补全
- 拓扑图节点拖拽持久化

### 11.3 测试规模

- M8.3 用 4 节点 star 拓扑够覆盖 M3-M7 跨节点场景
- 更大规模 mesh / 全连接拓扑 deferred 到未来性能测试阶段

---

## 12. 升级与卸载

### 12.1 升级

```bash
# 备份数据
cp -r .data/ .data.backup-$(date +%Y%m%d)/

# 拉取新代码
git pull origin main

# 升级依赖
npm install

# 重启节点
sudo systemctl restart havix
# 或 docker: docker restart havix-1
```

**向后兼容性**：M8.1 持久化用 `loadState` 合并式恢复，不覆盖现有数据。各 registry 的 `loadState` 对未知字段宽容（忽略），向后兼容旧版本数据。

### 12.2 卸载

```bash
# 停止节点
sudo systemctl stop havix && sudo systemctl disable havix
# 或 docker: docker stop havix-1 && docker rm havix-1

# 清理代码
rm -rf /opt/havix

# 清理数据（谨慎！不可恢复）
rm -rf /var/lib/havix
# 或 docker: docker volume rm havix-data-1
```

---

## 13. 求助与反馈

- 协议设计问题：[技术白皮书](./Havix-Technical-Whitepaper.md)
- 项目概览：[README](./README.md)
- 测试说明：README "测试" 章节
- 审计修复详情：README "审计修复" 章节
- 安全漏洞：私有披露，勿开 public issue

---

**Last Updated**: M8.3 完成 · MVP 全量审计通过 · 596/596 测试用例 ✅
