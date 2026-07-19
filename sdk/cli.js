/**
 * Havix SDK cli API（M9.2）
 * ───────────────────────────────────────────────
 * CLI 命令注册层。
 *
 * M9.2 范围：
 *   - 在 App 实例内部维护命令注册表
 *   - M9.3 AppManager 启动时把这些命令 register 到真实 Cli
 *
 * 设计原则：
 *   - App 不直接接触真实 Cli（避免启动顺序依赖）
 *   - 命令格式与 src/app/cli.js 的 Command 类型对齐：
 *     { name, description?, category?, args?, handler: async (args) => result }
 *   - 命令名命名约定：'<app-name>-<action>'（如 'translate-publish'）
 *     强制前缀防止命名冲突
 *
 * 用法：
 *   app.cli.register('translate-publish', {
 *     description: '发布翻译需求',
 *     args: ['--from', '--to', '--content', '--reward'],
 *     handler: async (args) => {
 *       await publishOffer(args.from, args.to, args.content, args.reward)
 *       return '已发布'
 *     },
 *   })
 *
 *   app.cli.unregister('translate-publish')
 *   app.cli.listCommands()
 */

/**
 * 创建 cli API 实例。
 *
 * @param {object} snode SNode 实例
 * @param {import('./manifest.js').AppManifest} manifest App Manifest
 * @returns {object} cli API
 */
export function createCliApi(snode, manifest) {
  if (!snode) throw new Error('createCliApi: snode 必填')
  if (!manifest) throw new Error('createCliApi: manifest 必填')

  const appName = manifest.name
  const commands = new Map()

  /**
   * 校验命令名格式：必须以 '<appName>-' 开头（防命名冲突）。
   * 允许特例：appName === 'empty-app' 时可注册不带前缀的 'hello'（empty-app 模板简化）
   *   —— 实际仍要求前缀 'empty-app-hello'，模板示例可改成带前缀的写法。
   *
   * @param {string} name
   */
  function validateCommandName(name) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('cli: 命令名必须是非空字符串')
    }
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
      throw new Error(`cli: 命令名必须是 kebab-case（小写字母+数字+短横线），实际: ${name}`)
    }
    const expectedPrefix = `${appName}-`
    if (!name.startsWith(expectedPrefix)) {
      throw new Error(
        `cli: 命令名必须以 "${expectedPrefix}" 开头（防命名冲突），实际: ${name}`,
      )
    }
  }

  /**
   * 注册一个 CLI 命令。
   * @param {string} name 命令名（必须以 '<appName>-' 开头）
   * @param {object} opts
   * @param {string} [opts.description] 描述
   * @param {string} [opts.category] 分类（用于 help 分组）
   * @param {string[]} [opts.args] 参数名列表（仅用于文档）
   * @param {function} opts.handler async (args) => result
   * @returns {void}
   */
  function register(name, opts = {}) {
    validateCommandName(name)
    if (typeof opts.handler !== 'function') {
      throw new Error(`cli.register: ${name} 的 opts.handler 必须是函数`)
    }
    if (commands.has(name)) {
      throw new Error(`cli.register: 命令 ${name} 已注册`)
    }
    commands.set(name, {
      name,
      description: opts.description ?? '',
      category: opts.category ?? `app:${appName}`,
      args: Array.isArray(opts.args) ? opts.args : [],
      handler: opts.handler,
    })
  }

  /**
   * 取消注册。
   * @param {string} name
   * @returns {boolean}
   */
  function unregister(name) {
    return commands.delete(name)
  }

  /**
   * 列出已注册命令（M9.3 AppManager 用于 register 到真实 Cli）。
   * @returns {Array<object>}
   */
  function listCommands() {
    return Array.from(commands.values())
  }

  /**
   * 查询是否注册了某命令。
   * @param {string} name
   * @returns {boolean}
   */
  function hasCommand(name) {
    return commands.has(name)
  }

  /**
   * 执行命令（M9.2 直接执行用于测试）。
   * @param {string} name
   * @param {object} args 参数对象 { positional: [], options: {} }
   * @returns {Promise<any>}
   */
  async function execute(name, args = {}) {
    const cmd = commands.get(name)
    if (!cmd) {
      throw new Error(`cli.execute: 命令 ${name} 未注册`)
    }
    return cmd.handler(args)
  }

  return {
    register,
    unregister,
    listCommands,
    hasCommand,
    execute,
    appName,
  }
}
