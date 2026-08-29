// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Havix empty-app 参考模板（M9.5）
 * ───────────────────────────────────────────────
 * 最小可运行 App：演示 SDK 4 大接口用法。
 *
 * AppManager 启动时调用 start(snode, manifest, app, sdk) hook：
 *   1. 注册 `empty-app-hello` CLI 命令（mutation 入口）
 *   2. 注册 `GET /api/apps/empty-app/hello` web 路由（观察入口）
 *   3. 写一个 state 键 `greeting` 并 flush 持久化
 *   4. 注册 credit.onReceived handler 演示消息派发
 *
 * 停止时 stop(app) hook 清理资源。
 *
 * 改造指南：把 `empty-app` 全局替换为新 App 名，按需扩展 capability / permissions。
 */

/**
 * App 启动 hook。AppManager 在 createApp 装配后调用。
 *
 * @param {object} snode SNode 实例（含 libp2p / IPFS / 各 registry）
 * @param {import('../../sdk/manifest.js').AppManifest} manifest 已校验的 AppManifest
 * @param {object} app SDK 装配的 App 实例（含 cli / web / state / credit / ... 7 大接口）
 * @param {object} sdk SDK 模块（含 createApp / AppManifest / 各 createXxxApi）
 * @returns {Promise<void>}
 */
export async function start(snode, manifest, app, sdk) {
  app.log?.('info', 'empty-app', `Hello from ${manifest.name} v${manifest.version}`)

  // ── 1. CLI 命令（mutation 入口）──────────────────────────
  //    命令名必须以 '<appName>-' 开头（sdk/cli.js 强制校验防命名冲突）
  app.cli.register('empty-app-hello', {
    description: '打个招呼（empty-app 演示）',
    args: ['--name'],
    handler: async (args) => {
      const name = args?.named?.name || args?.options?.name || 'world'
      const greeting = `Hello, ${name}! (from empty-app)`
      // 写入 state（演示持久化）
      await app.state.set('lastGreeting', {
        text: greeting,
        at: Date.now(),
      })
      return greeting
    },
  })

  // ── 2. Web 路由（观察入口，严格 GET-only）─────────────────
  //    路径必须以 /api/apps/<appName>/ 或 /apps/<appName>/ 开头（sdk/web.js 强制校验）
  app.web.get('/api/apps/empty-app/hello', async (req) => {
    const lastGreeting = await app.state.get('lastGreeting')
    const initializedAt = await app.state.get('initializedAt')
    return {
      ok: true,
      app: manifest.name,
      version: manifest.version,
      greeting: `Hello from empty-app!`,
      lastGreeting,
      initializedAt,
    }
  })

  // ── 3. State 持久化 ────────────────────────────────────────
  //    createApp 时 persist=undefined 已懒加载 src/persistence.js，
  //    autoFlush=true（默认）让 set/delete/clear 自动写盘。
  //    这里写一个初始键演示持久化往返。
  const existingKeys = app.state.keys()
  if (!existingKeys.includes('initializedAt')) {
    await app.state.set('initializedAt', Date.now())
  }
  await app.state.set('manifestName', manifest.name)

  // ── 4. Credit 消息派发 ─────────────────────────────────────
  //    onReceived 注册 handler，AppManager.dispatchCreditMessage 时调用。
  //    empty-app 不签发 credit（capability=custom），但演示接收侧 handler。
  app.credit.onReceived(async (creditMsg, senderId) => {
    app.log?.('info', 'empty-app',
      `收到 credit 消息 from ${senderId?.slice?.(0, 16) ?? '?'}: ${creditMsg?.amount ?? 0}`)
    await app.state.set('lastCreditReceived', {
      amount: creditMsg?.amount ?? 0,
      senderId,
      at: Date.now(),
    })
  })

  app.log?.('info', 'empty-app', `App 启动完成：1 CLI 命令 + 1 web 路由 + state 已初始化`)
}

/**
 * App 停止 hook。AppManager.stop() 调用 app.stop() 后会触发此函数（如存在）。
 *
 * 注意：SDK 的 app.stop() 已自动清理 transport/market 订阅 + state flush，
 *      此 hook 仅用于 App 自己的额外清理（如关闭文件句柄 / 取消定时器）。
 *
 * @param {object} app App 实例
 * @returns {Promise<void>}
 */
export async function stop(app) {
  app.log?.('info', 'empty-app', 'Goodbye from empty-app')
  // 演示：停止前显式 flush 一次（app.stop 也会做，这里幂等）
  await app.state?.flush?.()
}
