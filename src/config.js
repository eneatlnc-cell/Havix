/**
 * Havix 配置加载模块
 * ───────────────────────────────────────────────
 * 把环境变量 + 命令行参数转换为统一的配置对象。
 *
 * 优先级（高 → 低）：
 *   1. 命令行参数（--port, --name, --bootstrap ...）
 *   2. 环境变量（HAVIX_PORT, HAVIX_NAME, HAVIX_BOOTSTRAP ...）
 *   3. DEFAULT_CONFIG 默认值
 *
 * M8 会扩展为支持 config 文件（第四层优先级）。
 */

import process from 'node:process'

/**
 * 校验路径不允许绝对路径 / Windows 盘符 / `..` 路径穿越（P1-1 修复）。
 *
 * 与 sdk/manifest.js 的 validateDataDir 等价，但分层隔离（MVP 协议层不依赖 SDK）。
 * 用于 --data-dir / --apps-dir 输入校验，防止 ledger 写到任意目录
 * 或 AppManager 加载任意路径 JS。
 *
 * @param {string} value 待校验路径
 * @param {string} name 字段名（仅用于错误信息）
 * @returns {string} 校验通过的路径
 * @throws {Error} 路径非法
 */
function validatePathInput(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} 必须是非空字符串`)
  }
  // 拒绝 Linux 绝对路径 / Windows 盘符
  if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) {
    throw new Error(
      `${name} 必须是相对路径（不允许绝对路径），实际: "${value}"`,
    )
  }
  // 拒绝 `..` 路径穿越（含 a/../../b 等嵌套形式）
  if (value.includes('..')) {
    throw new Error(
      `${name} 不允许包含 ".." 路径穿越，实际: "${value}"`,
    )
  }
  return value
}

/**
 * 默认配置。任何未在环境变量/命令行中显式设置的项都会回退到这里。
 */
export const DEFAULT_CONFIG = {
  // 基础
  port: 0,                    // 0 = 随机端口
  name: 'havix-node',         // 仅日志显示用
  dataDir: '.data',           // libp2p/helia 持久化目录

  // 网络发现
  mdns: true,
  bootstrap: [],              // multiaddr 数组
  dht: true,
  dhtMode: 'lan',             // 'lan' | 'wan'

  // 调试
  logLevel: 'info',

  // M8.2 应用层：CLI REPL + 本地 Web 面板
  repl: true,                 // 启动后进入 REPL 交互
  web: true,                  // 启动后开本地 Web 面板
  webPort: 7331,              // Web 面板端口（7331 = HAVIX）
  webHost: '127.0.0.1',      // Web 面板监听地址（仅本地，安全考虑）

  // M9.3 App 容器：扫描 apps/ 目录加载 App
  apps: true,                 // 启动时加载 apps/ 目录
  appsDir: 'apps',            // App 目录路径（相对 cwd 或绝对路径）
}

/**
 * 解析命令行参数。
 * 支持两种形式：
 *   --port 9001        (空格分隔)
 *   --port=9001        (等号分隔)
 *   --bootstrap a b c  (多值，遇到下一个 -- 开头的参数停止)
 *
 * @param {string[]} argv process.argv.slice(2)
 * @returns {object} 命令行配置（仅含显式指定的字段）
 */
function parseArgv(argv) {
  const cli = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '--port' || arg.startsWith('--port=')) {
      const val = arg.includes('=') ? arg.split('=')[1] : argv[++i]
      cli.port = Number.parseInt(val, 10)
      if (Number.isNaN(cli.port) || cli.port < 0 || cli.port > 65535) {
        throw new Error(`--port 必须是 0-65535 之间的整数，当前值：${val}`)
      }
    } else if (arg === '--name' || arg.startsWith('--name=')) {
      cli.name = arg.includes('=') ? arg.split('=')[1] : argv[++i]
    } else if (arg === '--data-dir' || arg.startsWith('--data-dir=')) {
      cli.dataDir = arg.includes('=') ? arg.split('=')[1] : argv[++i]
    } else if (arg === '--bootstrap' || arg.startsWith('--bootstrap=')) {
      // 多值参数：--bootstrap a b c 或 --bootstrap=a,b,c
      let values
      if (arg.includes('=')) {
        values = arg.split('=')[1].split(',')
      } else {
        values = []
        while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          values.push(argv[++i])
        }
      }
      cli.bootstrap = values.map(s => s.trim()).filter(Boolean)
    } else if (arg === '--mdns' || arg.startsWith('--mdns=')) {
      const val = arg.includes('=') ? arg.split('=')[1] : argv[++i]
      cli.mdns = val === 'true' || val === '1'
    } else if (arg === '--dht' || arg.startsWith('--dht=')) {
      const val = arg.includes('=') ? arg.split('=')[1] : argv[++i]
      cli.dht = val === 'true' || val === '1'
    } else if (arg === '--dht-mode' || arg.startsWith('--dht-mode=')) {
      cli.dhtMode = arg.includes('=') ? arg.split('=')[1] : argv[++i]
      if (cli.dhtMode !== 'lan' && cli.dhtMode !== 'wan') {
        throw new Error(`--dht-mode 必须是 'lan' 或 'wan'，当前值：${cli.dhtMode}`)
      }
    } else if (arg === '--log' || arg.startsWith('--log=')) {
      cli.logLevel = arg.includes('=') ? arg.split('=')[1] : argv[++i]
    } else if (arg === '--repl' || arg.startsWith('--repl=')) {
      // --repl / --repl=true / --repl=false / --no-repl
      const val = arg.includes('=') ? arg.split('=')[1] : 'true'
      cli.repl = val === 'true' || val === '1'
    } else if (arg === '--no-repl') {
      cli.repl = false
    } else if (arg === '--web' || arg.startsWith('--web=')) {
      const val = arg.includes('=') ? arg.split('=')[1] : 'true'
      cli.web = val === 'true' || val === '1'
    } else if (arg === '--no-web') {
      cli.web = false
    } else if (arg === '--web-port' || arg.startsWith('--web-port=')) {
      const val = arg.includes('=') ? arg.split('=')[1] : argv[++i]
      cli.webPort = Number.parseInt(val, 10)
      if (Number.isNaN(cli.webPort) || cli.webPort < 0 || cli.webPort > 65535) {
        throw new Error(`--web-port 必须是 0-65535 之间的整数，当前值：${val}`)
      }
    } else if (arg === '--web-host' || arg.startsWith('--web-host=')) {
      cli.webHost = arg.includes('=') ? arg.split('=')[1] : argv[++i]
    } else if (arg === '--apps' || arg.startsWith('--apps=')) {
      // --apps / --apps=true / --apps=false / --no-apps
      const val = arg.includes('=') ? arg.split('=')[1] : 'true'
      cli.apps = val === 'true' || val === '1'
    } else if (arg === '--no-apps') {
      cli.apps = false
    } else if (arg === '--apps-dir' || arg.startsWith('--apps-dir=')) {
      cli.appsDir = arg.includes('=') ? arg.split('=')[1] : argv[++i]
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }

  return cli
}

/**
 * 打印帮助信息。
 */
function printHelp() {
  console.log(`
Havix — Haven of Affinity

用法：
  node src/s-node.js [options]

选项：
  --port <number>          监听端口（0=随机，默认 0）
  --name <string>          节点显示名称（默认 havix-node）
  --data-dir <path>        数据目录（默认 .data）
  --bootstrap <multiaddr>  跨网段引导节点（可多个或逗号分隔）
  --mdns <true|false>      启用 mDNS 局域网发现（默认 true）
  --dht <true|false>       启用 KadDHT（默认 true）
  --dht-mode <lan|wan>     DHT 模式（默认 lan）
  --log <level>            日志级别 debug|info|warn|error（默认 info）
  --[no-]repl              启动后进入 CLI 交互式 REPL（默认 true）
  --[no-]web               启动后开本地 Web 面板（默认 true）
  --web-port <number>      Web 面板端口（默认 7331；0=随机）
  --web-host <host>        Web 面板监听地址（默认 127.0.0.1，仅本地）
  --[no-]apps              启动时扫描 apps/ 加载 App（默认 true）
  --apps-dir <path>        App 目录路径（默认 apps，相对 cwd 或绝对路径）
  -h, --help               显示帮助

环境变量（被命令行参数覆盖）：
  HAVIX_PORT, HAVIX_NAME, HAVIX_DATA_DIR, HAVIX_BOOTSTRAP,
  HAVIX_MDNS, HAVIX_DHT, HAVIX_DHT_MODE, HAVIX_LOG,
  HAVIX_REPL, HAVIX_WEB, HAVIX_WEB_PORT, HAVIX_WEB_HOST,
  HAVIX_APPS, HAVIX_APPS_DIR

示例：
  # 启动第一个节点
  node src/s-node.js --port 9001 --name alpha

  # 启动第二个节点，引导到第一个
  node src/s-node.js --port 9002 --name beta \\
    --bootstrap /ip4/127.0.0.1/tcp/9001/p2p/<alpha-peerid>

  # 仅作为后台服务运行（不开 REPL）
  node src/s-node.js --no-repl --web-port 8000

  # 完全无应用层（纯节点）
  node src/s-node.js --no-repl --no-web

  # 禁用 App 容器（仅协议层）
  node src/s-node.js --no-apps

  # 自定义 App 目录
  node src/s-node.js --apps-dir /opt/havix/apps
`)
}

/**
 * 加载配置。
 * 优先级：命令行 > 环境变量 > 默认值
 *
 * @returns {object} 合并后的配置对象
 */
export function loadConfig() {
  const env = process.env
  const cli = parseArgv(process.argv.slice(2))

  const config = { ...DEFAULT_CONFIG }

  // ── 端口 ──
  if (env.HAVIX_PORT !== undefined) {
    const port = Number.parseInt(env.HAVIX_PORT, 10)
    if (Number.isNaN(port) || port < 0 || port > 65535) {
      throw new Error(`HAVIX_PORT 必须是 0-65535 之间的整数，当前值：${env.HAVIX_PORT}`)
    }
    config.port = port
  }
  if (cli.port !== undefined) {
    config.port = cli.port
  }

  // ── 名称 ──
  if (env.HAVIX_NAME) config.name = env.HAVIX_NAME
  if (cli.name) config.name = cli.name

  // ── 数据目录 ──
  if (env.HAVIX_DATA_DIR) config.dataDir = env.HAVIX_DATA_DIR
  if (cli.dataDir) config.dataDir = cli.dataDir

  // ── mDNS ──
  if (env.HAVIX_MDNS !== undefined) config.mdns = env.HAVIX_MDNS === 'true'
  if (cli.mdns !== undefined) config.mdns = cli.mdns

  // ── 引导节点（命令行覆盖环境变量）──
  if (env.HAVIX_BOOTSTRAP) {
    config.bootstrap = env.HAVIX_BOOTSTRAP
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  }
  if (cli.bootstrap) {
    config.bootstrap = cli.bootstrap
  }

  // ── DHT ──
  if (env.HAVIX_DHT !== undefined) config.dht = env.HAVIX_DHT === 'true'
  if (cli.dht !== undefined) config.dht = cli.dht

  if (env.HAVIX_DHT_MODE) {
    const mode = env.HAVIX_DHT_MODE
    if (mode !== 'lan' && mode !== 'wan') {
      throw new Error(`HAVIX_DHT_MODE 必须是 'lan' 或 'wan'，当前值：${mode}`)
    }
    config.dhtMode = mode
  }
  if (cli.dhtMode) config.dhtMode = cli.dhtMode

  // ── 日志级别 ──
  if (env.HAVIX_LOG) config.logLevel = env.HAVIX_LOG
  if (cli.logLevel) config.logLevel = cli.logLevel

  // ── M8.2 应用层：REPL + Web 面板 ──
  if (env.HAVIX_REPL !== undefined) config.repl = env.HAVIX_REPL === 'true'
  if (cli.repl !== undefined) config.repl = cli.repl

  if (env.HAVIX_WEB !== undefined) config.web = env.HAVIX_WEB === 'true'
  if (cli.web !== undefined) config.web = cli.web

  if (env.HAVIX_WEB_PORT !== undefined) {
    const port = Number.parseInt(env.HAVIX_WEB_PORT, 10)
    if (Number.isNaN(port) || port < 0 || port > 65535) {
      throw new Error(`HAVIX_WEB_PORT 必须是 0-65535 之间的整数，当前值：${env.HAVIX_WEB_PORT}`)
    }
    config.webPort = port
  }
  if (cli.webPort !== undefined) config.webPort = cli.webPort

  if (env.HAVIX_WEB_HOST) config.webHost = env.HAVIX_WEB_HOST
  if (cli.webHost) config.webHost = cli.webHost

  // ── M9.3 App 容器 ──
  if (env.HAVIX_APPS !== undefined) config.apps = env.HAVIX_APPS === 'true'
  if (cli.apps !== undefined) config.apps = cli.apps

  if (env.HAVIX_APPS_DIR) config.appsDir = env.HAVIX_APPS_DIR
  if (cli.appsDir) config.appsDir = cli.appsDir

  // 安全门槛（M8 审计修复 P0-D）：
  // Web 面板无认证机制，绑定非 127.0.0.1 地址会暴露所有 registry 数据。
  // 不阻断（保持灵活性，可能未来加 token 认证后可公网），但打印显眼警告。
  if (config.web !== false && config.webHost !== '127.0.0.1' && config.webHost !== 'localhost') {
    // eslint-disable-next-line no-console
    console.warn(
      `⚠️  安全警告：--web-host=${config.webHost} 将暴露 Web 面板到非本地地址。\n` +
      `   M8.2 Web 面板无认证机制，任何能访问该地址的客户端可读取所有 registry 数据\n` +
      `   （含信誉余额、市场 AES 密钥、vouch 关系图谱等敏感字段）。\n` +
      `   如需远程访问，建议通过 SSH 隧道或反向代理（带认证）转发到 127.0.0.1:${config.webPort}。\n`
    )
  }

  // P1-1 修复：--data-dir / --apps-dir 路径穿越校验
  //   - 拒绝绝对路径（Linux `/` 或 Windows `C:\`）
  //   - 拒绝含 `..` 的路径穿越
  //   - 防止 ledger 写入任意目录 + AppManager 加载任意路径 JS
  validatePathInput(config.dataDir, '--data-dir / HAVIX_DATA_DIR')
  validatePathInput(config.appsDir, '--apps-dir / HAVIX_APPS_DIR')

  return config
}

