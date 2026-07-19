# empty-app

Havix 最小可运行 App 参考模板（M9.5）。

## 用途

照着这个目录结构改造成自己的 App。它演示了 SDK 4 大接口的最小用法：

1. **CLI 命令**：注册 `empty-app-hello`，可在 Havix REPL 执行
2. **Web 路由**：注册 `GET /api/apps/empty-app/hello`，可在浏览器访问
3. **State 持久化**：写入 `initializedAt` / `lastGreeting`，重启后保持
4. **Credit 消息派发**：注册 `onReceived` handler，演示消息接收

## 文件结构

```
apps/empty-app/
├── manifest.yaml    # App 声明（身份 / 能力 / 权限 / 入口）
├── index.js         # start/stop hook
└── README.md        # 本文件
```

## manifest.yaml 字段

| 字段 | 必需 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| name | ✅ | kebab-case | — | App 全局唯一标识（与目录名一致） |
| version | ✅ | semver | — | 版本号 |
| capability | ✅ | `market`/`wiki`/`tunnel`/`public`/`custom` | — | 能力声明 |
| permissions | ✅ | string[] | — | 权限白名单（见 `sdk/permissions.js`） |
| entryPoint | ✅ | 相对路径 | — | 入口 JS 模块路径 |
| inviteTokenFormat | ❌ | `ed25519-signature`/`none` | `ed25519-signature` | 邀请 token 格式 |
| spaCid | ❌ | string | null | 前端 SPA 的 IPFS CID |
| minReputation | ❌ | number | 0 | 参与门槛 |
| trustWeight | ❌ | 0.0-1.0 | 0.5 | 加权转换权重 |
| dataDir | ❌ | 相对路径 | = name | 独立数据目录名 |
| contexts | ❌ | string[] | [] | 使用的 context 子身份（`A`/`B`/`C`/`D`） |
| description | ❌ | string | '' | 人类可读描述 |

## start(snode, manifest, app, sdk) hook 签名

AppManager 在 `createApp` 装配后调用，4 个参数：

- `snode` — SNode 实例（含 libp2p / IPFS / 各 registry）
- `manifest` — 已校验的 `AppManifest` 对象
- `app` — SDK 装配的 App 实例（含 cli / web / state / credit / ... 7 大接口）
- `sdk` — SDK 模块（含 `createApp` / `AppManifest` / 各 `createXxxApi`）

## 改造成自己的 App

1. 复制 `apps/empty-app/` 到 `apps/<your-app-name>/`
2. 修改 `manifest.yaml`：
   - `name` 改为 `<your-app-name>`（必须与目录名一致）
   - `capability` 改为 `market` / `wiki` / `tunnel` / `public` / `custom` 之一
   - `permissions` 加入 App 需要的权限（如 `market:create` / `credit:issue`）
3. 修改 `index.js`：
   - 命令名前缀改为 `<your-app-name>-`（如 `translate-publish`）
   - web 路由前缀改为 `/api/apps/<your-app-name>/` 或 `/apps/<your-app-name>/`
4. 启动节点时确保 `--apps` 开启（默认开启）

## 验证

启动节点后：

```bash
# CLI（REPL）
havix> empty-app-hello --name Alice
Hello, Alice! (from empty-app)

# Web
curl http://127.0.0.1:7331/api/apps/empty-app/hello
{"ok":true,"app":"empty-app","version":"1.0.0",...}

# App 列表
curl http://127.0.0.1:7331/api/apps
{"ok":true,"count":1,"apps":[...]}
```

## 约束

- **严格 GET-only**：Web API 不允许 POST/PUT/DELETE（M9 理论修正：协议即法律，mutation 走 CLI）
- **命令名前缀**：CLI 命令必须以 `<appName>-` 开头（防命名冲突）
- **路径前缀**：Web 路由必须以 `/apps/<appName>/` 或 `/api/apps/<appName>/` 开头（隔离 App 间路由）
- **App 同进程**：M9 不开放第三方 App，App 与节点同进程运行；M12 改 Worker Thread 隔离
