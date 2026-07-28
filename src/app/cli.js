// SPDX-License-Identifier: Apache-2.0

/**
 * Havix 命令行交互层（M8.2）
 * ───────────────────────────────────────────────
 * 设计目标（白皮书 M8："app/cli.js：命令补全"）：
 *   节点启动后进入交互式 REPL，把所有 SNode 公开 API 命令化。
 *   类似 redis-cli / psql 的交互体验，运维人员可在本地直接操作节点。
 *
 * 模块边界：
 *   - 本模块只做命令解析与路由（"动词"层）
 *   - 业务逻辑全部委托给 SNode 方法（"动作"层在 s-node.js）
 *   - 不直接访问各 registry 私有字段，所有操作走 SNode 公开 API
 *   - 错误处理：未知命令 / 参数不足 / 执行异常都打印友好提示，不让 REPL 退出
 *
 * 命令格式：
 *   <command> [arg1] [arg2] ...     空格分隔
 *   <command> --flag                布尔标志
 *   <command> --key=value           命名参数（少量复杂命令用）
 *   "string with spaces"            双引号包裹的参数保持原样
 *
 * REPL 命令（M8.2-1 实现）：
 *   help [cmd]     列出所有命令 / 显示单命令详情
 *   status         节点概览（peerId / 多地址 / 已连接 peer / 各 registry 计数）
 *   identity       4-context DID 列表（A/B/C/D）
 *   neighbors      已连接 peer 列表
 *   topics         当前订阅的 gossipsub topic
 *   exit / quit    退出节点（等同于 Ctrl+C）
 *
 * 业务命令（M8.2-2 / M8.2-3 后续追加）：
 *   vouch / wiki-publish / credit-issue / credit-consume / credit-transfer
 *   relay-register / relay-elect / relay-rotate
 *   tunnel-open / tunnel-send / tunnel-break / tunnel-close / tunnel-list
 *   dispute-file / dispute-panel / dispute-vote / dispute-resolve / dispute-list
 *   treasury-balance / treasury-history
 *   market-create / market-invite / market-join / market-leave / market-list
 *   market-publish / market-info
 *
 * 安全说明：
 *   - REPL 只在本地 stdin 操作，不接受远程命令（不通过 gossipsub / 网络暴露）
 *   - 所有命令执行受 SNode 内部权限模型约束（如 issueCredit 受 faucet 信誉门槛）
 *   - 错误信息只打印到本地 stdout，不泄露敏感字段（如私钥永远不打印）
 *
 * 测试策略：
 *   - 单元测试通过 `new Cli(nodeMock)` 注入 mock SNode，验证命令解析与路由
 *   - REPL readline 接口可被替换为内存流（用于自动化测试）
 */

import readline from 'node:readline'
import { styleText } from 'node:util'

// ──────────────────────────────────────────────
// 工具：彩色输出（CI 环境自动降级）
// ──────────────────────────────────────────────

/**
 * 用 ANSI 颜色打印文本。
 * Node 20.12+ 提供 util.styleText；旧版本降级为纯文本。
 */
function colorize(code, text) {
  try {
    return styleText(code, text)
  } catch {
    return text
  }
}

const c = {
  header: (s) => colorize(['bold', 'cyan'], s),
  ok: (s) => colorize('green', s),
  warn: (s) => colorize('yellow', s),
  err: (s) => colorize('red', s),
  dim: (s) => colorize('dim', s),
  key: (s) => colorize('magenta', s),
  val: (s) => colorize('blue', s),
}

// ──────────────────────────────────────────────
// 命令解析：把单行字符串拆为 [command, ...args]
// ──────────────────────────────────────────────

/**
 * 解析命令行字符串为 token 数组。
 *
 * 规则：
 *   - 双引号包裹的部分保持原样（可含空格）
 *   - 反斜杠转义：\" → "，\\ → \
 *   - 连续空格视为单个分隔符
 *
 * @param {string} line
 * @returns {string[]} tokens，第一个是命令名
 */
export function tokenize(line) {
  const tokens = []
  let cur = ''
  let inQuote = false
  let i = 0

  while (i < line.length) {
    const ch = line[i]

    if (inQuote) {
      if (ch === '\\') {
        // 转义：下一个字符直接入 cur
        const next = line[i + 1]
        if (next !== undefined) {
          cur += next
          i += 2
          continue
        }
        i += 1
        continue
      }
      if (ch === '"') {
        inQuote = false
        i += 1
        continue
      }
      cur += ch
      i += 1
      continue
    }

    if (ch === '"') {
      inQuote = true
      i += 1
      continue
    }

    if (ch === ' ' || ch === '\t') {
      if (cur.length > 0) {
        tokens.push(cur)
        cur = ''
      }
      i += 1
      continue
    }

    cur += ch
    i += 1
  }

  if (cur.length > 0) tokens.push(cur)
  return tokens
}

/**
 * 把命名参数 args 数组拆为 { positional, named, flags }。
 *
 *   ["did:xxx", "--amount=100", "--force"]
 *     → { positional: ["did:xxx"], named: { amount: "100" }, flags: Set(["force"]) }
 *
 * @param {string[]} args
 * @returns {{positional: string[], named: object, flags: Set<string>}}
 */
export function parseArgs(args) {
  const positional = []
  const named = {}
  const flags = new Set()

  for (const a of args) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) {
        const k = a.slice(2, eq)
        const v = a.slice(eq + 1)
        named[k] = v
      } else {
        flags.add(a.slice(2))
      }
    } else {
      positional.push(a)
    }
  }

  return { positional, named, flags }
}

// ──────────────────────────────────────────────
// 命令定义结构
// ──────────────────────────────────────────────

/**
 * @typedef {Object} Command
 * @property {string} name         命令名（不含参数）
 * @property {string} category     分类（diagnostic / wiki / credit / ...）
 * @property {string} shortHelp     一句话描述
 * @property {string} [usage]       用法示例（不含 prompt 前缀）
 * @property {string} [longHelp]    详细说明（help <cmd> 显示）
 * @property {(args, ctx) => Promise<any>|any} handler  执行函数；args=parseArgs 结果，ctx={node, log}
 */

// ──────────────────────────────────────────────
// Cli 主类
// ──────────────────────────────────────────────

export class Cli {
  /**
   * @param {object} node SNode 实例
   * @param {object} [opts]
   * @param {NodeJS.ReadStream|{on: function, write: function, close: function}} [opts.input]  可注入输入流（测试用）
   * @param {NodeJS.WriteStream|{write: function}} [opts.output]  可注入输出流（测试用）
   * @param {boolean} [opts.silent]  静默模式（不打印欢迎语，测试用）
   */
  constructor(node, opts = {}) {
    this.node = node
    this.log = node?.log ?? (() => {})
    this.input = opts.input ?? process.stdin
    this.output = opts.output ?? process.stdout
    this.silent = opts.silent ?? false
    this._commands = new Map()
    this._rl = null
    this._exiting = false

    this._registerBuiltins()
  }

  // ──────────────────────────────────────────
  // 命令注册
  // ──────────────────────────────────────────

  /**
   * 注册一个命令。
   * @param {Command} cmd
   */
  register(cmd) {
    if (!cmd?.name || typeof cmd.name !== 'string') {
      throw new Error('命令必须有 name 字段')
    }
    if (this._commands.has(cmd.name)) {
      throw new Error(`命令 ${cmd.name} 已注册`)
    }
    this._commands.set(cmd.name, cmd)
  }

  /**
   * 批量注册命令。
   * @param {Command[]} cmds
   */
  registerAll(cmds) {
    for (const c of cmds) this.register(c)
  }

  /**
   * 获取所有已注册命令（按 category 分组）。
   * @returns {Map<string, Command[]>}
   */
  getCommandsByCategory() {
    const grouped = new Map()
    for (const cmd of this._commands.values()) {
      const cat = cmd.category ?? 'misc'
      if (!grouped.has(cat)) grouped.set(cat, [])
      grouped.get(cat).push(cmd)
    }
    return grouped
  }

  // ──────────────────────────────────────────
  // REPL 启停
  // ──────────────────────────────────────────

  /**
   * 启动 REPL，阻塞直到用户输入 exit / Ctrl+D。
   */
  start() {
    if (this._rl) {
      throw new Error('REPL 已启动')
    }

    if (!this.silent) {
      this._printBanner()
    }

    this._rl = readline.createInterface({
      input: this.input,
      output: this.output,
      prompt: c.header('havix') + ' ' + c.dim('>') + ' ',
      terminal: this.output.isTTY === true,
    })

    this._rl.prompt()

    this._rl.on('line', (line) => {
      this._dispatch(line)
        .catch((err) => {
          this._println(c.err(`[内部错误] ${err?.message ?? err}`))
        })
        .finally(() => {
          if (!this._exiting) this._rl?.prompt()
        })
    })

    this._rl.on('close', () => {
      this._println(c.dim('\n[REPL 关闭]'))
    })
  }

  /**
   * 退出 REPL（不停止节点；节点停止由调用方负责）。
   */
  async stop() {
    this._exiting = true
    if (this._rl) {
      this._rl.close()
      this._rl = null
    }
  }

  // ──────────────────────────────────────────
  // 命令分发
  // ──────────────────────────────────────────

  /**
   * 分发一行命令。
   * @param {string} line
   * @returns {Promise<any>}
   */
  async _dispatch(line) {
    const tokens = tokenize(line.trim())
    if (tokens.length === 0) return  // 空行

    const [name, ...rest] = tokens
    const cmd = this._commands.get(name)
    if (!cmd) {
      this._println(c.err(`未知命令: ${name}`))
      this._println(c.dim(`输入 ${c.val('help')} 查看可用命令`))
      return
    }

    const args = parseArgs(rest)
    try {
      await cmd.handler(args, { node: this.node, cli: this, log: this.log })
    } catch (err) {
      this._println(c.err(`[${cmd.name}] 失败: ${err?.message ?? err}`))
    }
  }

  /**
   * 直接执行一行命令（不通过 readline，便于测试 / 脚本调用）。
   * @param {string} line
   * @returns {Promise<any>}
   */
  async execute(line) {
    return this._dispatch(line)
  }

  // ──────────────────────────────────────────
  // 内置命令注册
  // ──────────────────────────────────────────

  _registerBuiltins() {
    this.registerAll([
      {
        name: 'help',
        category: 'builtin',
        shortHelp: '列出所有命令 / 显示单命令详情',
        usage: 'help [command]',
        longHelp: '无参数列出所有命令（按分类分组）；\n带参数显示指定命令的用法与说明。',
        handler: (args) => this._cmdHelp(args),
      },
      {
        name: 'exit',
        category: 'builtin',
        shortHelp: '退出节点（等同于 Ctrl+C）',
        usage: 'exit',
        longHelp: '退出 REPL 并触发节点优雅停止（SIGINT 流程，flush 持久化）。',
        handler: () => this._cmdExit(),
      },
      {
        name: 'quit',
        category: 'builtin',
        shortHelp: 'exit 的别名',
        usage: 'quit',
        handler: () => this._cmdExit(),
      },
      {
        name: 'status',
        category: 'diagnostic',
        shortHelp: '节点概览（peerId / 多地址 / 邻居 / registry 计数）',
        usage: 'status',
        longHelp: '展示节点当前运行状态：\n  - libp2p peerId 与监听多地址\n  - 4-context DID 列表\n  - 已连接 peer 数量\n  - 当前订阅的 gossipsub topic\n  - 各 registry 计数（vouch / wiki / credit / dispute / market / treasury）',
        handler: () => this._cmdStatus(),
      },
      {
        name: 'identity',
        category: 'diagnostic',
        shortHelp: '4-context DID 列表（A=公开 / B=市场 / C=隧道 / D=维基）',
        usage: 'identity',
        longHelp: '展示本节点的 4 个子身份：\n  context-A: 公开层活跃身份（心跳 / credit issuer / dispute claimant）\n  context-B: 市场身份（被邀请方加入市场）\n  context-C: 隧道身份（私聊 sourceDid）\n  context-D: 维基编辑员身份（条目作者签名）',
        handler: () => this._cmdIdentity(),
      },
      {
        name: 'neighbors',
        category: 'diagnostic',
        shortHelp: '已连接 peer 列表',
        usage: 'neighbors',
        longHelp: '列出 libp2p 当前已建立的 peer 连接（peerId + multiaddr + 方向）。',
        handler: () => this._cmdNeighbors(),
      },
      {
        name: 'topics',
        category: 'diagnostic',
        shortHelp: '当前订阅的 gossipsub topic 列表',
        usage: 'topics',
        longHelp: '列出 gossipsub 当前订阅的所有 topic（公共层 + 私有 market topic）。',
        handler: () => this._cmdTopics(),
      },
    ])

    // M8.2-2：M3-M4 业务命令（vouch / wiki / credit）
    this.registerAll(this._m3m4Commands())

    // M8.2-3：M5-M7 业务命令（relay / tunnel / dispute / treasury / market）
    this.registerAll(this._m5m6m7Commands())
  }

  // ──────────────────────────────────────────
  // M5-M7 命令定义
  // ──────────────────────────────────────────

  _m5m6m7Commands() {
    return [
      // ── M5 relay 选举 ──
      {
        name: 'relay-register',
        category: 'relay',
        shortHelp: '注册 relay 候选（需满足信誉前 30% + vouch≥3）',
        usage: 'relay-register <did> [reputation] [vouchCount]',
        longHelp: '把 did 注册为 relay 候选节点。\n  若注入 reputationLedger / vouchRegistry，reputation/vouchCount 参数被忽略（以账本为准）。\n  未注入时使用传入参数。',
        handler: (args) => this._cmdRelayRegister(args),
      },
      {
        name: 'relay-elect',
        category: 'relay',
        shortHelp: '执行一次 relay 选举（按 top-percentile + vouch 阈值）',
        usage: 'relay-elect',
        longHelp: '从候选中选出合格 relay 作为本 epoch active 集合。\n白皮书 §7.3：信誉前 30% + vouch≥3。',
        handler: () => this._cmdRelayElect(),
      },
      {
        name: 'relay-rotate',
        category: 'relay',
        shortHelp: '执行 epoch 轮换（20% 概率换下，重新选举补齐）',
        usage: 'relay-rotate',
        longHelp: '当前 active relay 集合中 20% 概率被换下，从剩余合格候选中补齐。',
        handler: () => this._cmdRelayRotate(),
      },
      {
        name: 'relay-list',
        category: 'relay',
        shortHelp: '查看当前 active relay + 候选数',
        usage: 'relay-list',
        longHelp: '列出 active relay 集合 + 候选总数 + 单个候选详情。',
        handler: () => this._cmdRelayList(),
      },

      // ── M5 tunnel ──
      {
        name: 'tunnel-open',
        category: 'tunnel',
        shortHelp: '建立到 targetDid 的私聊隧道（context-C 子身份）',
        usage: 'tunnel-open <targetDid> [relayDid1 relayDid2 ...]',
        longHelp: '建立隧道：\n  targetDid: 接收方 context-C DID\n  可选手动指定 relay 列表，默认用 activeRelays（3 条并行）\n\n失败场景：activeRelays 为空时抛 NoRelayAvailableError。',
        handler: (args) => this._cmdTunnelOpen(args),
      },
      {
        name: 'tunnel-send',
        category: 'tunnel',
        shortHelp: '通过隧道发送一个 chunk（自动 round-robin 分片）',
        usage: 'tunnel-send <tunnelId> <text>',
        longHelp: '通过隧道发送一个 chunk：\n  tunnelId: 隧道 ID\n  text: 文本内容（自动 UTF-8 编码为 Uint8Array）\n\n返回分配到的 relay + 序号。',
        handler: (args) => this._cmdTunnelSend(args),
      },
      {
        name: 'tunnel-break',
        category: 'tunnel',
        shortHelp: '标记某 relay 链路断开（硬切换）',
        usage: 'tunnel-break <tunnelId> <relayDid>',
        longHelp: '把某隧道的某 relay 标记为 broken。\n单条断开后剩余 relay 继续；全断开后隧道整体 broken。',
        handler: (args) => this._cmdTunnelBreak(args),
      },
      {
        name: 'tunnel-close',
        category: 'tunnel',
        shortHelp: '关闭隧道',
        usage: 'tunnel-close <tunnelId>',
        longHelp: '主动关闭隧道（释放资源）。',
        handler: (args) => this._cmdTunnelClose(args),
      },
      {
        name: 'tunnel-list',
        category: 'tunnel',
        shortHelp: '列出所有隧道 + 状态',
        usage: 'tunnel-list',
        longHelp: '列出所有活动隧道的 ID / source / target / status / 总 chunk 数。',
        handler: () => this._cmdTunnelList(),
      },

      // ── M6 arbitration ──
      {
        name: 'dispute-file',
        category: 'arbitration',
        shortHelp: '发起仲裁（context-A 作为 claimant）',
        usage: 'dispute-file <respondent> <type> <amount> [evidence]',
        longHelp: '发起 dispute：\n  respondent: 被诉方 context-A DID\n  type: "offer-breach" | "relay-malice" | "vouch-collusion"\n  amount: 索赔金额（slash 多少 frozen 信誉）\n  evidence: 可选，证据 IPFS CID\n\n本节点用 context-A 作为 claimant，广播到 /s-network/alert。',
        handler: (args) => this._cmdDisputeFile(args),
      },
      {
        name: 'dispute-panel',
        category: 'arbitration',
        shortHelp: '召集仲裁团（5 节点，排除关联）',
        usage: 'dispute-panel <disputeId>',
        longHelp: '为 disputeId 召集仲裁团。\n白皮书 §5.1：5 节点，从信誉 > 中位数×1.5 且 vouch≥10 的池随机抽取，排除纠纷双方的 vouch 关联节点。',
        handler: (args) => this._cmdDisputePanel(args),
      },
      {
        name: 'dispute-vote',
        category: 'arbitration',
        shortHelp: '仲裁员投票（本节点作为 juror）',
        usage: 'dispute-vote <disputeId> <guilty|not-guilty|abstain>',
        longHelp: '本节点用 context-A 作为 juror 投票。\n  guilty: 有罪\n  not-guilty: 无罪\n  abstain: 弃权\n\n达到 ≥3 票一致后才能 resolveVerdict。',
        handler: (args) => this._cmdDisputeVote(args),
      },
      {
        name: 'dispute-resolve',
        category: 'arbitration',
        shortHelp: '尝试达成裁决 + 执行 slash',
        usage: 'dispute-resolve <disputeId>',
        longHelp: '检查是否达到多数（≥3 票一致），若达成则执行 slash：\n  - 50% 赔受害者\n  - 50% 进金库\n  - 只动 frozen 不动 available（防治理武器化）',
        handler: (args) => this._cmdDisputeResolve(args),
      },
      {
        name: 'dispute-list',
        category: 'arbitration',
        shortHelp: '列出所有 dispute ID / 查看单条详情',
        usage: 'dispute-list [disputeId]',
        longHelp: '无参数：列出所有 dispute ID。\n带参数：显示单条 dispute 详情（claimant / respondent / type / status / 投票统计）。',
        handler: (args) => this._cmdDisputeList(args),
      },
      {
        name: 'juror-register',
        category: 'arbitration',
        shortHelp: '注册仲裁员候选',
        usage: 'juror-register [did]',
        longHelp: '注册本节点（或指定 did）为仲裁员候选。\n默认用 context-A 子身份。',
        handler: (args) => this._cmdJurorRegister(args),
      },
      {
        name: 'juror-eligibility',
        category: 'arbitration',
        shortHelp: '检查仲裁员资格',
        usage: 'juror-eligibility <did>',
        longHelp: '检查 did 是否满足仲裁员资格：信誉 > 中位数×1.5 + vouch≥10。',
        handler: (args) => this._cmdJurorEligibility(args),
      },

      // ── M6 treasury ──
      {
        name: 'treasury-balance',
        category: 'treasury',
        shortHelp: '查询金库总余额',
        usage: 'treasury-balance',
        longHelp: '查询金库账本总余额（slash 的 50% 累积，M6 只进不出）。',
        handler: () => this._cmdTreasuryBalance(),
      },
      {
        name: 'treasury-history',
        category: 'treasury',
        shortHelp: '查询金库存入历史（审计用）',
        usage: 'treasury-history [disputeId]',
        longHelp: '列出金库存入历史：\n  无参数：全部历史\n  带参数：过滤指定 disputeId 的存入记录',
        handler: (args) => this._cmdTreasuryHistory(args),
      },

      // ── M7 market ──
      {
        name: 'market-create',
        category: 'market',
        shortHelp: '创建私域市场（本节点是创建者）',
        usage: 'market-create <name> <version> <capability> [--permissions=p1,p2] [--min-reputation=N] [--trust-weight=N] [--spa-cid=<cid>]',
        longHelp: '创建一个私域市场：\n  name: 市场名（如 "translation-market"）\n  version: manifest 版本（如 "1.0.0"）\n  capability: "market" | "wiki" | "custom"\n  --permissions: 逗号分隔权限列表\n  --min-reputation: 加入市场最小信誉（默认 30）\n  --trust-weight: 0.0~1.0（默认 0.5）\n  --spa-cid: SPA bundle IPFS CID（占位）\n\n创建者用 context-A 签发自邀请令牌，自动订阅私有 topic。',
        handler: (args) => this._cmdMarketCreate(args),
      },
      {
        name: 'market-invite',
        category: 'market',
        shortHelp: '签发邀请令牌给被邀请方',
        usage: 'market-invite <marketId> <inviteeDid> [--ttl=<ms>]',
        longHelp: '本节点（创建者）签发邀请令牌：\n  marketId: 市场 ID\n  inviteeDid: 被邀请方 context-B DID\n  --ttl: 令牌有效期（毫秒），默认 30 天\n\n前置门控：inviteeDid 的可用信誉须 ≥ manifest.minReputation。',
        handler: (args) => this._cmdMarketInvite(args),
      },
      {
        name: 'market-join',
        category: 'market',
        shortHelp: '用邀请令牌加入市场',
        usage: 'market-join <tokenJson>',
        longHelp: '用令牌加入市场：\n  tokenJson: 邀请令牌 JSON（字符串）\n\n本节点用 context-B 子身份加入，订阅私有 topic。\n内部会校验令牌签名（verifySelf）+ 过期 + inviteeDid 绑定。',
        handler: (args) => this._cmdMarketJoin(args),
      },
      {
        name: 'market-publish',
        category: 'market',
        shortHelp: '在市场内发布加密消息（AES-GCM 双重加密）',
        usage: 'market-publish <marketId> <payloadJson>',
        longHelp: '在市场内发布消息：\n  marketId: 市场 ID\n  payloadJson: 业务 payload 的 JSON 字符串\n\n流程：明文 → AES-GCM(key, plaintext) → 明文信封 → 广播到私有 topic。',
        handler: (args) => this._cmdMarketPublish(args),
      },
      {
        name: 'market-leave',
        category: 'market',
        shortHelp: '离开市场',
        usage: 'market-leave <marketId>',
        longHelp: '取消订阅 + 删除本地条目。',
        handler: (args) => this._cmdMarketLeave(args),
      },
      {
        name: 'market-list',
        category: 'market',
        shortHelp: '列出本节点参与的市场',
        usage: 'market-list',
        longHelp: '列出本节点已加入的所有市场 ID。',
        handler: () => this._cmdMarketList(),
      },
      {
        name: 'market-info',
        category: 'market',
        shortHelp: '查看市场详情（manifest / topic / 是否创建者）',
        usage: 'market-info <marketId>',
        longHelp: '显示市场详情：\n  - manifest（name/version/capability/permissions/min_reputation/trust_weight/spa_cid）\n  - topic（sha256(令牌)）\n  - 是否创建者\n  - 是否成员',
        handler: (args) => this._cmdMarketInfo(args),
      },
    ]
  }

  // ──────────────────────────────────────────
  // M5-M7 命令实现
  // ──────────────────────────────────────────

  _cmdRelayRegister(args) {
    const [did, repStr, vouchStr] = args.positional
    if (!did) {
      this._println(c.err('用法: relay-register <did> [reputation] [vouchCount]'))
      return
    }
    const reputation = repStr ? Number.parseInt(repStr, 10) : undefined
    const vouchCount = vouchStr ? Number.parseInt(vouchStr, 10) : undefined
    const r = this.node.registerRelayCandidate({ did, reputation, vouchCount })
    if (r.registered) {
      this._println(c.ok(`✓ 已注册 relay 候选 ${did.slice(0, 20)}...`))
    } else {
      this._println(c.warn(`✗ 注册失败：${r.reason ?? '未知原因'}`))
    }
  }

  _cmdRelayElect() {
    const r = this.node.electRelayEpoch()
    this._println(c.ok(`✓ epoch 选举完成`))
    this._println(`  ${c.key('当选数')}: ${c.val(String(r.count))}`)
    if (r.elected.length > 0) {
      this._println(`  ${c.key('active relay')}:`)
      for (const did of r.elected) {
        this._println(`    ${c.val(did)}`)
      }
    }
  }

  _cmdRelayRotate() {
    const r = this.node.rotateRelayEpoch()
    this._println(c.ok(`✓ epoch 轮换完成`))
    this._println(`  ${c.key('换下')}: ${c.val(String(r.rotated.length))} 个`)
    this._println(`  ${c.key('补齐')}: ${c.val(String(r.supplemented.length))} 个`)
    this._println(`  ${c.key('当前 active')}: ${c.val(String(r.active.length))} 个`)
  }

  _cmdRelayList() {
    const rr = this.node.relayRegistry
    if (!rr) {
      this._println(c.err('relayRegistry 未初始化'))
      return
    }
    const active = rr.getActiveRelays()
    const candidateCount = rr.candidates?.size ?? 0
    this._println(c.header(`═══ Relay 状态 ═══`))
    this._println(`  ${c.key('候选总数')}:     ${c.val(String(candidateCount))}`)
    this._println(`  ${c.key('active relay')}: ${c.val(String(active.length))}`)
    if (active.length > 0) {
      this._println(`  ${c.key('active 列表')}:`)
      for (const did of active) {
        this._println(`    ${c.val(did)}`)
      }
    }
  }

  _cmdTunnelOpen(args) {
    const [targetDid, ...relayDids] = args.positional
    if (!targetDid) {
      this._println(c.err('用法: tunnel-open <targetDid> [relayDid1 relayDid2 ...]'))
      return
    }
    const opts = { targetDid }
    if (relayDids.length > 0) opts.relayDids = relayDids
    const r = this.node.establishTunnel(opts)
    this._println(c.ok(`✓ 隧道已建立`))
    this._println(`  ${c.key('tunnelId')}:  ${c.val(r.tunnelId)}`)
    this._println(`  ${c.key('relay 数')}: ${c.val(String(r.relayDids.length))}`)
  }

  _cmdTunnelSend(args) {
    const [tunnelId, ...textParts] = args.positional
    if (!tunnelId || textParts.length === 0) {
      this._println(c.err('用法: tunnel-send <tunnelId> <text>'))
      return
    }
    const text = textParts.join(' ')
    const chunk = new TextEncoder().encode(text)
    const r = this.node.sendTunnelChunk({ tunnelId, chunk })
    this._println(c.ok(`✓ chunk 已发送`))
    this._println(`  ${c.key('relay')}:     ${c.val(r.relay)}`)
    this._println(`  ${c.key('sequence')}: ${c.val(String(r.sequence))}/${c.val(String(r.total))}`)
  }

  _cmdTunnelBreak(args) {
    const [tunnelId, relayDid] = args.positional
    if (!tunnelId || !relayDid) {
      this._println(c.err('用法: tunnel-break <tunnelId> <relayDid>'))
      return
    }
    const r = this.node.breakTunnelLink({ tunnelId, relayDid })
    this._println(c.warn(`⚠ 链路断开`))
    this._println(`  ${c.key('状态')}:       ${c.val(r.status)}`)
    this._println(`  ${c.key('剩余 relay')}: ${c.val(String(r.remainingRelays))}`)
  }

  _cmdTunnelClose(args) {
    const [tunnelId] = args.positional
    if (!tunnelId) {
      this._println(c.err('用法: tunnel-close <tunnelId>'))
      return
    }
    this.node.closeTunnel(tunnelId)
    this._println(c.ok(`✓ 隧道 ${tunnelId} 已关闭`))
  }

  _cmdTunnelList() {
    const tm = this.node.tunnelManager
    if (!tm) {
      this._println(c.err('tunnelManager 未初始化'))
      return
    }
    const ids = tm.listTunnels()
    if (ids.length === 0) {
      this._println(c.warn('当前无活动隧道'))
      return
    }
    this._println(c.header(`═══ 隧道列表 (${ids.length}) ═══`))
    const stats = tm.getStats()
    for (const s of stats) {
      this._println(`  ${c.val(s.tunnelId)}  ${c.dim(s.status)}`)
      this._println(`    ${c.dim(`${s.sourceDid.slice(0, 20)}... → ${s.targetDid.slice(0, 20)}... · ${s.totalChunks} chunks · ${s.links?.length ?? 0} links`)}`)
    }
  }

  async _cmdDisputeFile(args) {
    const [respondent, type, amountStr, evidence] = args.positional
    if (!respondent || !type || !amountStr) {
      this._println(c.err('用法: dispute-file <respondent> <type> <amount> [evidence]'))
      return
    }
    const validTypes = ['offer-breach', 'relay-malice', 'vouch-collusion']
    if (!validTypes.includes(type)) {
      this._println(c.err(`type 必须是 ${validTypes.join(' / ')}，实际 ${type}`))
      return
    }
    const amount = Number.parseInt(amountStr, 10)
    if (!Number.isFinite(amount) || amount <= 0) {
      this._println(c.err(`amount 必须是正整数，实际 ${amountStr}`))
      return
    }
    this._println(c.dim(`→ 发起 dispute ${type} 索赔 ${amount}...`))
    const r = await this.node.fileDispute({ respondent, type, evidence, amount })
    this._println(c.ok(`✓ dispute 已发起`))
    this._println(`  ${c.key('disputeId')}:  ${c.val(r.dispute.disputeId)}`)
    this._println(`  ${c.key('claimant')}:   ${c.val(r.dispute.claimant)}`)
    this._println(`  ${c.key('respondent')}: ${c.val(r.dispute.respondent)}`)
    this._println(`  ${c.key('type')}:       ${c.val(r.dispute.type)}`)
    this._println(`  ${c.key('amount')}:     ${c.val(String(r.dispute.amount))}`)
  }

  _cmdDisputePanel(args) {
    const [disputeId] = args.positional
    if (!disputeId) {
      this._println(c.err('用法: dispute-panel <disputeId>'))
      return
    }
    const r = this.node.summonArbitrationPanel(disputeId)
    this._println(c.ok(`✓ 仲裁团已召集`))
    this._println(`  ${c.key('panel 数')}:   ${c.val(String(r.count))}`)
    if (r.excluded && r.excluded.length > 0) {
      this._println(`  ${c.key('排除数')}:    ${c.val(String(r.excluded.length))}（关联节点）`)
    }
    if (r.panel.length > 0) {
      this._println(`  ${c.key('panel 列表')}:`)
      for (const did of r.panel) {
        this._println(`    ${c.val(did)}`)
      }
    }
  }

  _cmdDisputeVote(args) {
    const [disputeId, vote] = args.positional
    if (!disputeId || !vote) {
      this._println(c.err('用法: dispute-vote <disputeId> <guilty|not-guilty|abstain>'))
      return
    }
    const validVotes = ['guilty', 'not-guilty', 'abstain']
    if (!validVotes.includes(vote)) {
      this._println(c.err(`vote 必须是 ${validVotes.join(' / ')}，实际 ${vote}`))
      return
    }
    const r = this.node.castArbitrationVote({ disputeId, vote })
    if (r.recorded) {
      this._println(c.ok(`✓ 投票已记录`))
      this._println(`  ${c.key('disputeId')}: ${c.val(disputeId)}`)
      this._println(`  ${c.key('vote')}:      ${c.val(vote)}`)
    } else {
      this._println(c.warn(`✗ 投票失败：${r.reason ?? '未知原因'}`))
    }
  }

  _cmdDisputeResolve(args) {
    const [disputeId] = args.positional
    if (!disputeId) {
      this._println(c.err('用法: dispute-resolve <disputeId>'))
      return
    }
    const r = this.node.resolveVerdict(disputeId)
    if (r.resolved) {
      this._println(c.ok(`✓ 裁决已达成`))
      this._println(`  ${c.key('verdict')}:    ${c.val(r.verdict)}`)
      if (r.slashExecuted) {
        this._println(`  ${c.key('slash')}:     ${c.warn('已执行')}`)
        if (r.slashDetail) {
          this._println(`    ${c.dim(`slash 金额: ${r.slashDetail.slashAmount ?? '?'}`)}`)
          this._println(`    ${c.dim(`赔受害者: ${r.slashDetail.victimCompensation ?? '?'}`)}`)
          this._println(`    ${c.dim(`进金库:   ${r.slashDetail.treasuryDeposit ?? '?'}`)}`)
        }
      }
    } else {
      this._println(c.warn(`✗ 暂未达成裁决：${r.reason ?? '未知原因'}`))
    }
  }

  _cmdDisputeList(args) {
    const arb = this.node.arbitrationRegistry
    if (!arb) {
      this._println(c.err('arbitrationRegistry 未初始化'))
      return
    }
    if (args.positional.length > 0) {
      const disputeId = args.positional[0]
      const d = arb.getDispute(disputeId)
      if (!d) {
        this._println(c.err(`未找到 dispute: ${disputeId}`))
        return
      }
      this._println(c.header(`═══ Dispute ${disputeId} ═══`))
      this._println(`  ${c.key('claimant')}:   ${c.val(d.claimant)}`)
      this._println(`  ${c.key('respondent')}: ${c.val(d.respondent)}`)
      this._println(`  ${c.key('type')}:       ${c.val(d.type)}`)
      this._println(`  ${c.key('amount')}:     ${c.val(String(d.amount))}`)
      this._println(`  ${c.key('status')}:     ${c.val(d.status)}`)
      if (d.evidence) {
        this._println(`  ${c.key('evidence')}:   ${c.val(d.evidence)}`)
      }
      const stats = arb.getVoteStats(disputeId)
      this._println(`  ${c.key('投票统计')}:`)
      this._println(`    ${c.dim(`guilty: ${stats.guilty} · not-guilty: ${stats['not-guilty']} · abstain: ${stats.abstain} · total: ${stats.total}`)}`)
      if (d.panel && d.panel.length > 0) {
        this._println(`  ${c.key('panel')}:       ${c.val(String(d.panel.length))} 个仲裁员`)
      }
      if (stats.verdict) {
        this._println(`  ${c.key('verdict')}:    ${c.val(stats.verdict)}`)
      }
      return
    }
    const ids = arb.listDisputes()
    if (ids.length === 0) {
      this._println(c.warn('当前无 dispute'))
      return
    }
    this._println(c.header(`═══ Dispute 列表 (${ids.length}) ═══`))
    for (const id of ids) {
      const d = arb.getDispute(id)
      this._println(`  ${c.val(id)}  ${c.dim(d?.status ?? '?')}`)
    }
  }

  _cmdJurorRegister(args) {
    const did = args.positional[0] ?? this.node.wallet?.get('A')?.did
    if (!did) {
      this._println(c.err('用法: juror-register [did]（默认用 context-A，但钱包未初始化）'))
      return
    }
    const r = this.node.registerJurorCandidate({ did })
    if (r.registered) {
      this._println(c.ok(`✓ 已注册仲裁员候选 ${did.slice(0, 20)}...`))
      if (r.eligible !== undefined) {
        this._println(`  ${c.key('当前资格')}: ${r.eligible ? c.ok('合格') : c.warn('不合格')}`)
      }
    } else {
      this._println(c.warn(`✗ 注册失败：${r.reason ?? '未知原因'}`))
    }
  }

  _cmdJurorEligibility(args) {
    const [did] = args.positional
    if (!did) {
      this._println(c.err('用法: juror-eligibility <did>'))
      return
    }
    const r = this.node.checkJurorEligibility(did)
    this._println(c.header(`═══ 仲裁员资格检查 ═══`))
    this._println(`  ${c.key('did')}:           ${c.val(did)}`)
    this._println(`  ${c.key('是否合格')}:     ${r.eligible ? c.ok('是') : c.warn('否')}`)
    if (r.reputation !== undefined) {
      this._println(`  ${c.key('reputation')}:  ${c.val(String(r.reputation))}`)
    }
    if (r.vouchCount !== undefined) {
      this._println(`  ${c.key('vouchCount')}: ${c.val(String(r.vouchCount))}`)
    }
    if (r.threshold !== undefined) {
      this._println(`  ${c.key('threshold')}:   ${c.val(String(r.threshold))}`)
    }
    if (r.reason) {
      this._println(`  ${c.key('原因')}:        ${c.dim(r.reason)}`)
    }
  }

  _cmdTreasuryBalance() {
    const balance = this.node.getTreasuryBalance()
    this._println(c.header(`═══ 金库余额 ═══`))
    this._println(`  ${c.key('总额')}: ${c.val(String(balance))}`)
  }

  _cmdTreasuryHistory(args) {
    const [disputeId] = args.positional
    const history = this.node.getTreasuryHistory(disputeId)
    if (history.length === 0) {
      this._println(c.warn(`当前无金库存入记录${disputeId ? `（disputeId=${disputeId}）` : ''}`))
      return
    }
    this._println(c.header(`═══ 金库存入历史 (${history.length}) ═══`))
    for (const h of history) {
      this._println(`  ${c.val(new Date(h.at).toISOString())}  ${c.key(`+${h.amount}`)}`)
      this._println(`    ${c.dim(`from: ${h.from.slice(0, 24)}... · reason: ${h.reason}${h.disputeId ? ` · dispute: ${h.disputeId}` : ''}`)}`)
    }
  }

  async _cmdMarketCreate(args) {
    const [name, version, capability] = args.positional
    if (!name || !version || !capability) {
      this._println(c.err('用法: market-create <name> <version> <capability> [options]'))
      return
    }
    const manifest = { name, version, capability }
    if (args.named.permissions) {
      manifest.permissions = args.named.permissions.split(',').map((s) => s.trim()).filter(Boolean)
    }
    if (args.named['min-reputation']) {
      manifest.min_reputation = Number.parseInt(args.named['min-reputation'], 10)
    }
    if (args.named['trust-weight']) {
      manifest.trust_weight = Number.parseFloat(args.named['trust-weight'])
    }
    if (args.named['spa-cid']) {
      manifest.spa_cid = args.named['spa-cid']
    }
    this._println(c.dim(`→ 创建市场 "${name}" v${version} (${capability})...`))
    const r = await this.node.createMarket({ manifest })
    this._println(c.ok(`✓ 市场已创建`))
    this._println(`  ${c.key('marketId')}:  ${c.val(r.marketId)}`)
    this._println(`  ${c.key('topic')}:     ${c.val(r.topic)}`)
  }

  async _cmdMarketInvite(args) {
    const [marketId, inviteeDid] = args.positional
    if (!marketId || !inviteeDid) {
      this._println(c.err('用法: market-invite <marketId> <inviteeDid> [--ttl=<ms>]'))
      return
    }
    const ttlMs = args.named.ttl ? Number.parseInt(args.named.ttl, 10) : undefined
    this._println(c.dim(`→ 签发邀请令牌给 ${inviteeDid.slice(0, 20)}...`))
    const token = await this.node.issueInvite({ marketId, inviteeDid, ttlMs })
    this._println(c.ok(`✓ 邀请令牌已签发`))
    this._println(`  ${c.key('token JSON')}:`)
    this._println(`    ${c.val(JSON.stringify(token.toJSON()))}`)
  }

  async _cmdMarketJoin(args) {
    const [tokenJson] = args.positional
    if (!tokenJson) {
      this._println(c.err('用法: market-join <tokenJson>'))
      return
    }
    let token
    try {
      token = JSON.parse(tokenJson)
    } catch (err) {
      this._println(c.err(`令牌 JSON 解析失败：${err.message}`))
      return
    }
    this._println(c.dim(`→ 加入市场 ${token.marketId ?? '?'}...`))
    const r = await this.node.joinMarket({ token })
    this._println(c.ok(`✓ 已加入市场`))
    this._println(`  ${c.key('marketId')}:  ${c.val(r.marketId)}`)
    this._println(`  ${c.key('topic')}:     ${c.val(r.topic)}`)
  }

  async _cmdMarketPublish(args) {
    const [marketId, payloadJson] = args.positional
    if (!marketId || !payloadJson) {
      this._println(c.err('用法: market-publish <marketId> <payloadJson>'))
      return
    }
    let payload
    try {
      payload = JSON.parse(payloadJson)
    } catch (err) {
      this._println(c.err(`payload JSON 解析失败：${err.message}`))
      return
    }
    const r = await this.node.publishToMarket({ marketId, payload })
    this._println(c.ok(`✓ 消息已发布`))
    this._println(`  ${c.key('marketId')}:  ${c.val(marketId)}`)
    this._println(`  ${c.key('广播给')}:    ${c.val(String(r.recipients))} peer`)
  }

  async _cmdMarketLeave(args) {
    const [marketId] = args.positional
    if (!marketId) {
      this._println(c.err('用法: market-leave <marketId>'))
      return
    }
    await this.node.leaveMarket(marketId)
    this._println(c.ok(`✓ 已离开市场 ${marketId}`))
  }

  _cmdMarketList() {
    const ids = this.node.listMarkets()
    if (ids.length === 0) {
      this._println(c.warn('当前无参与的市场'))
      return
    }
    this._println(c.header(`═══ 市场列表 (${ids.length}) ═══`))
    for (const id of ids) {
      this._println(`  ${c.val(id)}`)
    }
  }

  _cmdMarketInfo(args) {
    const [marketId] = args.positional
    if (!marketId) {
      this._println(c.err('用法: market-info <marketId>'))
      return
    }
    const mr = this.node.marketRegistry
    const m = mr?.getMarket?.(marketId)
    if (!m) {
      this._println(c.err(`市场 ${marketId} 不存在或未加入`))
      return
    }
    const manifest = m.manifest
    this._println(c.header(`═══ 市场 ${marketId} ═══`))
    this._println(`  ${c.key('name')}:           ${c.val(manifest.name)}`)
    this._println(`  ${c.key('version')}:        ${c.val(manifest.version)}`)
    this._println(`  ${c.key('capability')}:     ${c.val(manifest.capability)}`)
    if (manifest.permissions && manifest.permissions.length > 0) {
      this._println(`  ${c.key('permissions')}:     ${c.val(manifest.permissions.join(', '))}`)
    }
    this._println(`  ${c.key('min_reputation')}: ${c.val(String(manifest.minReputation))}`)
    this._println(`  ${c.key('trust_weight')}:   ${c.val(String(manifest.trustWeight))}`)
    if (manifest.spaCid) {
      this._println(`  ${c.key('spa_cid')}:        ${c.val(manifest.spaCid)}`)
    }
    this._println(`  ${c.key('topic')}:          ${c.val(m.topic)}`)
    this._println(`  ${c.key('是否创建者')}:     ${m.isCreator ? c.ok('是') : c.warn('否')}`)
    this._println(`  ${c.key('是否成员')}:       ${mr.isMember(marketId) ? c.ok('是') : c.warn('否')}`)
  }

  // ──────────────────────────────────────────
  // M3-M4 命令定义
  // ──────────────────────────────────────────

  _m3m4Commands() {
    return [
      // ── M3.2 vouch ──
      {
        name: 'vouch',
        category: 'vouch',
        shortHelp: '为 endorseDid 投信誉背书（context-A 子身份）',
        usage: 'vouch <endorseDid> [reason]',
        longHelp: '为 endorseDid 投一次信誉背书。\n  endorseDid: 被背书方 context-A DID\n  reason: 可选背书原因（引号包裹可含空格）\n\n本节点用 context-A 子身份签名 vouch 消息并广播到 /s-network/reputation。\n接收方节点会镜像 vouch 到本地注册表。',
        handler: (args) => this._cmdVouch(args),
      },
      {
        name: 'vouch-list',
        category: 'vouch',
        shortHelp: '查询某 did 收到的 vouch 列表 / 资格状态',
        usage: 'vouch-list <endorseDid>',
        longHelp: '查询 endorseDid 收到的所有 vouch 来源 + 当前资格状态：\n  - vouch 来源列表\n  - 当前 score / threshold\n  - 是否达到编辑员资格',
        handler: (args) => this._cmdVouchList(args),
      },

      // ── M3.1/M3.3 wiki ──
      {
        name: 'wiki-publish',
        category: 'wiki',
        shortHelp: '发布维基条目（context-D 子身份 + IPFS + gossipsub 广播）',
        usage: 'wiki-publish <title> <content> [--parent=<cid>]',
        longHelp: '发布一条维基条目：\n  title: 条目标题（引号包裹可含空格）\n  content: 正文（引号包裹可含空格 / 换行用 \\n）\n  --parent=<cid>: 可选，父版本 CID（构造版本链）\n\n前置门控：编辑员 context-D DID 的 vouch 累积须达阈值，否则抛 EditorNotQualifiedError。\n发布后写入 IPFS + 广播 announce + 本地索引。',
        handler: (args) => this._cmdWikiPublish(args),
      },
      {
        name: 'wiki-list',
        category: 'wiki',
        shortHelp: '列出本地索引的所有维基条目（cid + title + author）',
        usage: 'wiki-list [--title=<title>]',
        longHelp: '列出本地 wiki.entries 索引：\n  无参数：全部条目\n  --title=<title>: 过滤指定标题',
        handler: (args) => this._cmdWikiList(args),
      },
      {
        name: 'wiki-get',
        category: 'wiki',
        shortHelp: '查询条目 manifest / 拉取 IPFS 内容',
        usage: 'wiki-get <cid> [--fetch]',
        longHelp: '查询 CID 对应的维基条目：\n  无 --fetch：只显示 manifest（title / authorDid / parentCid / timestamp）\n  --fetch：从 IPFS 拉取正文内容并打印',
        handler: (args) => this._cmdWikiGet(args),
      },
      {
        name: 'wiki-history',
        category: 'wiki',
        shortHelp: '列出某标题的所有版本（按 timestamp 升序）',
        usage: 'wiki-history <title>',
        longHelp: '列出本地索引中指定标题的所有版本，按 timestamp 升序排列。\n用于追溯版本链。',
        handler: (args) => this._cmdWikiHistory(args),
      },

      // ── M4 credit / reputation ──
      {
        name: 'credit-issue',
        category: 'credit',
        shortHelp: '签发 Credit 给 holderDid（Faucet + 广播 /s-network/reputation）',
        usage: 'credit-issue <holderDid> <amount> [--prev=<cid>]',
        longHelp: '本节点（context-A）作为 Faucet issuer 签发 Credit：\n  holderDid: 收款方 context-A DID\n  amount: 金额（正整数）\n  --prev=<cid>: 可选，前一笔流水 CID（流水链）\n\n前置门控：本节点总信誉须 ≥ faucet 门槛（DEFAULT_FAUCET_MIN_REPUTATION）。\n          可用信誉须 ≥ amount（会冻结等额信誉）。',
        handler: (args) => this._cmdCreditIssue(args),
      },
      {
        name: 'credit-consume',
        category: 'credit',
        shortHelp: '消费 Credit（holderDid 余额扣减 + 释放 issuerDid 冻结）',
        usage: 'credit-consume <holderDid> <issuerDid> <amount>',
        longHelp: '消费 Credit（本地账本操作，不广播）：\n  holderDid: 消费者\n  issuerDid: 签发方（用于释放冻结）\n  amount: 消费金额\n\nM4 MVP：跨节点同步 deferred 到 M7。',
        handler: (args) => this._cmdCreditConsume(args),
      },
      {
        name: 'credit-transfer',
        category: 'credit',
        shortHelp: '本地转账（fromDid → toDid）',
        usage: 'credit-transfer <fromDid> <toDid> <amount>',
        longHelp: '本地账本转账（不广播）：\n  fromDid: 转出方\n  toDid: 转入方\n  amount: 转账金额\n\nM4 MVP：跨节点 transfer 同步 deferred。',
        handler: (args) => this._cmdCreditTransfer(args),
      },
      {
        name: 'credit-balance',
        category: 'credit',
        shortHelp: '查询某 did 的 credit 余额',
        usage: 'credit-balance <did>',
        longHelp: '查询 did 在 CreditLedger 中的当前余额。',
        handler: (args) => this._cmdCreditBalance(args),
      },
      {
        name: 'reputation',
        category: 'credit',
        shortHelp: '查询某 did 的信誉三元组（available / frozen / total）',
        usage: 'reputation <did>',
        longHelp: '查询 did 在 ReputationLedger 中的信誉：\n  available: 可用信誉\n  frozen: 冻结信誉（签发 credit / 仲裁担保）\n  total: 总信誉 = available + frozen',
        handler: (args) => this._cmdReputation(args),
      },
    ]
  }

  // ──────────────────────────────────────────
  // M3-M4 命令实现
  // ──────────────────────────────────────────

  async _cmdVouch(args) {
    const [endorseDid, ...rest] = args.positional
    if (!endorseDid) {
      this._println(c.err('用法: vouch <endorseDid> [reason]'))
      return
    }
    const reason = rest.join(' ') || null
    this._println(c.dim(`→ vouch ${endorseDid}${reason ? ` (${reason})` : ''}...`))
    const r = await this.node.vouch(endorseDid, reason)
    this._println(c.ok(`✓ 已投 vouch（广播给 ${r.recipients} 个 peer）`))
  }

  _cmdVouchList(args) {
    const [endorseDid] = args.positional
    if (!endorseDid) {
      this._println(c.err('用法: vouch-list <endorseDid>'))
      return
    }
    const vr = this.node.vouchRegistry
    if (!vr) {
      this._println(c.err('vouchRegistry 未初始化'))
      return
    }
    const vouchers = vr.getVouchers(endorseDid)
    const count = vr.getVouchCount(endorseDid)
    const q = vr.getQualification(endorseDid)
    this._println(c.header(`═══ ${endorseDid} 的 vouch 状态 ═══`))
    this._println(`  ${c.key('vouch 数')}:     ${c.val(String(count))}`)
    this._println(`  ${c.key('score')}:        ${c.val(String(q.score))}`)
    this._println(`  ${c.key('threshold')}:   ${c.val(String(q.threshold))}`)
    this._println(`  ${c.key('是否合格')}:     ${q.qualified ? c.ok('是') : c.warn('否')}`)
    if (vouchers.length === 0) {
      this._println(`  ${c.dim('(无 vouch 来源)')}`)
    } else {
      this._println(`  ${c.key('vouch 来源')}:`)
      for (const v of vouchers) {
        this._println(`    ${c.val(v)}`)
      }
    }
  }

  async _cmdWikiPublish(args) {
    const [title, content] = args.positional
    if (!title || !content) {
      this._println(c.err('用法: wiki-publish <title> <content> [--parent=<cid>]'))
      return
    }
    const parentCid = args.named.parent ?? null
    this._println(c.dim(`→ 发布维基 "${title}"（${content.length} 字符）${parentCid ? ` parent=${parentCid.slice(0, 12)}...` : ''}...`))
    const r = await this.node.wiki.publishEntry({
      title,
      content,  // publishEntry 内部接受 string 或 Uint8Array
      parentCid,
    })
    this._println(c.ok(`✓ 已发布`))
    this._println(`  ${c.key('CID')}:    ${c.val(r.cid)}`)
    this._println(`  ${c.key('标题')}:   ${c.val(title)}`)
  }

  _cmdWikiList(args) {
    const wiki = this.node.wiki
    if (!wiki) {
      this._println(c.err('wiki 未初始化'))
      return
    }
    let entries = wiki.listEntries()
    if (args.named.title) {
      entries = entries.filter((e) => e.title === args.named.title)
    }
    if (entries.length === 0) {
      this._println(c.warn('当前无维基条目'))
      return
    }
    this._println(c.header(`═══ 维基条目 (${entries.length}) ═══`))
    for (const e of entries) {
      this._println(`  ${c.val(e.cid)}  ${c.key(e.title)}`)
      this._println(`    ${c.dim(`作者: ${e.authorDid.slice(0, 20)}... · ${new Date(e.timestamp).toISOString()}${e.parentCid ? ` · parent: ${e.parentCid.slice(0, 12)}...` : ''}`)}`)
    }
  }

  async _cmdWikiGet(args) {
    const [cid] = args.positional
    if (!cid) {
      this._println(c.err('用法: wiki-get <cid> [--fetch]'))
      return
    }
    const wiki = this.node.wiki
    const entry = wiki.getEntry(cid)
    if (!entry) {
      this._println(c.err(`未找到 CID: ${cid}`))
      return
    }
    this._println(c.header(`═══ 维基条目 ${cid} ═══`))
    this._println(`  ${c.key('标题')}:     ${c.val(entry.title)}`)
    this._println(`  ${c.key('作者')}:     ${c.val(entry.authorDid)}`)
    this._println(`  ${c.key('时间')}:     ${c.dim(new Date(entry.timestamp).toISOString())}`)
    if (entry.parentCid) {
      this._println(`  ${c.key('父版本')}:   ${c.val(entry.parentCid)}`)
    }
    if (args.flags.has('fetch')) {
      this._println(c.dim(`→ 从 IPFS 拉取内容...`))
      try {
        const bytes = await wiki.fetchContent(cid)
        const text = new TextDecoder().decode(bytes)
        this._println(`  ${c.key('内容')}:`)
        for (const line of text.split('\n')) {
          this._println(`    ${line}`)
        }
      } catch (err) {
        this._println(c.err(`拉取失败: ${err.message}`))
      }
    }
  }

  _cmdWikiHistory(args) {
    const [title] = args.positional
    if (!title) {
      this._println(c.err('用法: wiki-history <title>'))
      return
    }
    const wiki = this.node.wiki
    const history = wiki.listHistory(title)
    if (history.length === 0) {
      this._println(c.warn(`标题 "${title}" 无已知版本`))
      return
    }
    this._println(c.header(`═══ "${title}" 版本链 (${history.length}) ═══`))
    for (const e of history) {
      this._println(`  ${c.val(e.cid)}  ${c.dim(new Date(e.timestamp).toISOString())}`)
      if (e.parentCid) {
        this._println(`    ${c.dim(`↑ parent: ${e.parentCid}`)}`)
      }
    }
  }

  async _cmdCreditIssue(args) {
    const [holderDid, amountStr] = args.positional
    if (!holderDid || !amountStr) {
      this._println(c.err('用法: credit-issue <holderDid> <amount> [--prev=<cid>]'))
      return
    }
    const amount = Number.parseInt(amountStr, 10)
    if (!Number.isFinite(amount) || amount <= 0) {
      this._println(c.err(`amount 必须是正整数，实际 ${amountStr}`))
      return
    }
    const prevNoteCid = args.named.prev ?? null
    this._println(c.dim(`→ 签发 ${amount} credit 给 ${holderDid.slice(0, 20)}...`))
    const r = await this.node.issueCredit({ holderDid, amount, prevNoteCid })
    this._println(c.ok(`✓ 已签发`))
    this._println(`  ${c.key('note CID')}:  ${c.val(r.note.cid ?? '<inline>')}`)
    this._println(`  ${c.key('nonce')}:     ${c.val(r.note.nonce)}`)
    this._println(`  ${c.key('金额')}:      ${c.val(String(amount))}`)
    this._println(`  ${c.key('广播给')}:    ${c.val(String(r.recipients))} peer`)
  }

  _cmdCreditConsume(args) {
    const [holderDid, issuerDid, amountStr] = args.positional
    if (!holderDid || !issuerDid || !amountStr) {
      this._println(c.err('用法: credit-consume <holderDid> <issuerDid> <amount>'))
      return
    }
    const amount = Number.parseInt(amountStr, 10)
    if (!Number.isFinite(amount) || amount <= 0) {
      this._println(c.err(`amount 必须是正整数，实际 ${amountStr}`))
      return
    }
    const r = this.node.consumeCredit({ holderDid, issuerDid, amount })
    this._println(c.ok(`✓ 已消费 ${amount} credit`))
    this._println(`  ${c.key('holder 余额')}:    ${c.val(String(r.holderBalance))}`)
    this._println(`  ${c.key('释放冻结')}:       ${c.val(String(r.releasedFrozen))}`)
  }

  _cmdCreditTransfer(args) {
    const [fromDid, toDid, amountStr] = args.positional
    if (!fromDid || !toDid || !amountStr) {
      this._println(c.err('用法: credit-transfer <fromDid> <toDid> <amount>'))
      return
    }
    const amount = Number.parseInt(amountStr, 10)
    if (!Number.isFinite(amount) || amount <= 0) {
      this._println(c.err(`amount 必须是正整数，实际 ${amountStr}`))
      return
    }
    const r = this.node.transferCredit({ fromDid, toDid, amount })
    this._println(c.ok(`✓ 已转账 ${amount} credit`))
    this._println(`  ${c.key('from 余额')}:  ${c.val(String(r.fromBalance))}`)
    this._println(`  ${c.key('to 余额')}:    ${c.val(String(r.toBalance))}`)
  }

  _cmdCreditBalance(args) {
    const [did] = args.positional
    if (!did) {
      this._println(c.err('用法: credit-balance <did>'))
      return
    }
    const balance = this.node.creditLedger.getBalance(did)
    this._println(`  ${c.key(did.slice(0, 24))}... ${c.dim('=')}`)
    this._println(`    ${c.key('credit 余额')}: ${c.val(String(balance))}`)
  }

  _cmdReputation(args) {
    const [did] = args.positional
    if (!did) {
      this._println(c.err('用法: reputation <did>'))
      return
    }
    const rep = this.node.reputationLedger.get(did)
    this._println(`  ${c.key(did.slice(0, 24))}... ${c.dim('=')}`)
    this._println(`    ${c.key('available')}: ${c.val(String(rep.available))}`)
    this._println(`    ${c.key('frozen')}:    ${c.val(String(rep.frozen))}`)
    this._println(`    ${c.key('total')}:     ${c.val(String(rep.total))}`)
  }

  // ──────────────────────────────────────────
  // 内置命令实现
  // ──────────────────────────────────────────

  _cmdHelp(args) {
    if (args.positional.length > 0) {
      const name = args.positional[0]
      const cmd = this._commands.get(name)
      if (!cmd) {
        this._println(c.err(`未知命令: ${name}`))
        return
      }
      this._println(c.header(`命令: ${cmd.name}`))
      this._println(`  ${c.key('分类')}: ${cmd.category ?? 'misc'}`)
      this._println(`  ${c.key('说明')}: ${cmd.shortHelp}`)
      if (cmd.usage) {
        this._println(`  ${c.key('用法')}: ${cmd.usage}`)
      }
      if (cmd.longHelp) {
        this._println(`  ${c.key('详情')}:`)
        for (const line of cmd.longHelp.split('\n')) {
          this._println(`    ${c.dim(line)}`)
        }
      }
      return
    }

    // 列出所有命令（按分类分组）
    const grouped = this.getCommandsByCategory()
    const categoryNames = {
      builtin: '内置',
      diagnostic: '诊断',
      wiki: '维基协议 (M3)',
      vouch: '信誉背书 (M3)',
      credit: '双轨经济 (M4)',
      relay: 'Relay 选举 (M5)',
      tunnel: '私聊隧道 (M5)',
      arbitration: '仲裁 + Slash (M6)',
      treasury: '金库审计 (M6)',
      market: '邀请市场 (M7)',
      misc: '其他',
    }

    this._println(c.header('可用命令：'))
    for (const [cat, cmds] of grouped) {
      const label = categoryNames[cat] ?? cat
      this._println(c.dim(`\n  [${label}]`))
      cmds.sort((a, b) => a.name.localeCompare(b.name))
      for (const cmd of cmds) {
        const pad = ' '.repeat(Math.max(0, 22 - cmd.name.length))
        this._println(`    ${c.val(cmd.name.padEnd(22))} ${pad}${cmd.shortHelp}`)
      }
    }
    this._println(c.dim(`\n  输入 ${c.val('help <command>')} 查看单命令详情`))
  }

  async _cmdExit() {
    this._println(c.warn('正在退出...'))
    await this.stop()
    // 触发 SIGINT 流程，让 s-node.js main() 走优雅退出（flush 持久化）
    process.kill(process.pid, 'SIGINT')
  }

  _cmdStatus() {
    const n = this.node
    if (!n) {
      this._println(c.err('节点未初始化'))
      return
    }

    this._println(c.header('═══ Havix 节点状态 ═══'))

    // libp2p peerId
    const peerId = n.libp2p?.peerId?.toString() ?? '<未启动>'
    this._println(`  ${c.key('peerId')}:        ${c.val(peerId)}`)

    // 多地址
    const multiaddrs = n.libp2p?.getMultiaddrs?.().map(String) ?? []
    this._println(`  ${c.key('监听地址')}:`)
    if (multiaddrs.length === 0) {
      this._println(`    ${c.dim('(无)')}`)
    } else {
      for (const ma of multiaddrs) {
        this._println(`    ${c.val(ma)}`)
      }
    }

    // 邻居
    const peers = n.libp2p?.getPeers?.() ?? []
    this._println(`  ${c.key('已连接 peer')}:  ${c.val(peers.length.toString())}`)

    // topic
    const topics = n.libp2p?.services?.pubsub?.getTopics?.() ?? []
    this._println(`  ${c.key('订阅 topic')}:  ${c.val(topics.length.toString())}`)

    // registry 计数（诊断视图：直接读各 registry 内部字段是可接受的）
    this._println(c.header('═══ Registry 计数 ═══'))
    const counts = [
      ['vouch 索引', n.vouchRegistry?.vouches?.size ?? 0],
      ['wiki 条目', n.wiki?.entries?.size ?? 0],
      ['reputation 节点', n.reputationLedger?.balances?.size ?? 0],
      ['credit 持有人', n.creditLedger?.balances?.size ?? 0],
      ['dispute 数', n.arbitrationRegistry?.disputes?.size ?? 0],
      ['juror 候选', n.arbitrationRegistry?.jurorPool?.size ?? 0],
      ['market 参与数', n.marketRegistry?.listMarkets?.().length ?? 0],
      ['treasury 余额', n.treasury?.getBalance?.() ?? 0],
      ['credit nonce', n._processedCreditNonces?.size ?? 0],
    ]
    for (const [label, val] of counts) {
      this._println(`  ${c.key(label.padEnd(20))} ${c.val(String(val))}`)
    }
  }

  _cmdIdentity() {
    const n = this.node
    if (!n?.wallet) {
      this._println(c.err('钱包未初始化（节点未 start）'))
      return
    }

    this._println(c.header('═══ 4-context DID ═══'))
    const ctxMeta = [
      { key: 'A', label: 'context-A · 公开层活跃身份', desc: '心跳 / credit issuer / dispute claimant' },
      { key: 'B', label: 'context-B · 市场身份', desc: '被邀请方加入市场' },
      { key: 'C', label: 'context-C · 隧道身份', desc: '私聊 sourceDid' },
      { key: 'D', label: 'context-D · 维基编辑员', desc: '条目作者签名' },
    ]

    for (const ctx of ctxMeta) {
      const id = n.wallet.get(ctx.key)
      if (!id) {
        this._println(`  ${c.warn(ctx.label)}: <未初始化>`)
        continue
      }
      this._println(`  ${c.key(ctx.label)}`)
      this._println(`    DID:    ${c.val(id.did)}`)
      this._println(`    ${c.dim(ctx.desc)}`)
    }
  }

  _cmdNeighbors() {
    const n = this.node
    const peers = n?.libp2p?.getPeers?.() ?? []
    if (peers.length === 0) {
      this._println(c.warn('当前无已连接 peer'))
      return
    }

    this._println(c.header(`═══ 已连接 peer (${peers.length}) ═══`))
    for (const p of peers) {
      const id = p.toString()
      const addrs = n.libp2p?.getConnections?.(p)?.map((c2) => c2.remoteAddr.toString()) ?? []
      this._println(`  ${c.val(id)}`)
      if (addrs.length > 0) {
        for (const a of addrs) {
          this._println(`    ${c.dim(a)}`)
        }
      } else {
        this._println(`    ${c.dim('(无地址)')}`)
      }
    }
  }

  _cmdTopics() {
    const n = this.node
    const topics = n?.libp2p?.services?.pubsub?.getTopics?.() ?? []
    if (topics.length === 0) {
      this._println(c.warn('当前无订阅 topic'))
      return
    }

    this._println(c.header(`═══ 订阅 topic (${topics.length}) ═══`))
    for (const t of topics) {
      this._println(`  ${c.val(t)}`)
    }
  }

  // ──────────────────────────────────────────
  // 输出辅助
  // ──────────────────────────────────────────

  _printBanner() {
    this._println()
    this._println(c.header('  ╔════════════════════════════════════════════╗'))
    this._println(c.header('  ║  Havix CLI · M8.2 命令交互层                  ║'))
    this._println(c.header('  ║  输入 help 查看命令 · Ctrl+D 退出            ║'))
    this._println(c.header('  ╚════════════════════════════════════════════╝'))
    this._println()
  }

  _println(text = '') {
    this.output.write(text + '\n')
  }
}
