/**
 * Havix SDK createApp 入口（M9.2）
 * ───────────────────────────────────────────────
 * 装配 7 大子模块 + web/cli/state，返回完整 app 实例。
 *
 * 设计原则：
 *   - manifest 既可以是 AppManifest 实例，也可以是普通对象（内部转换）
 *   - 装配每个子模块时检查 snode 是否满足该模块的最小要求
 *   - 子模块装配失败不致命——缺哪个就置为 null，App 仍可启动
 *     但调用缺的子模块会抛 InvalidAppStateError
 *   - app.manifestId / app.dataDir 暴露给 App 用于业务逻辑
 *
 * M9.2 范围：
 *   - 不接真实 SNode（mock 优先）
 *   - 集成测试 deferred 到 M9.3
 *
 * 用法：
 *   import { createApp } from 'havix-sdk'
 *   const app = await createApp(snode, manifest, { dataDir })
 *
 *   // 调用各子模块
 *   await app.market.create({...})
 *   await app.context.sign('B', bytes)
 *   await app.state.set('orders', [])
 */

import { AppManifest, DEFAULTS as MANIFEST_DEFAULTS } from './manifest.js'
import { createContextApi } from './context.js'
import { createMarketApi } from './market.js'
import { createCreditApi } from './credit.js'
import { createWikiApi } from './wiki.js'
import { createTunnelApi } from './tunnel.js'
import { createArbitrationApi } from './arbitration.js'
import { createTransportApi } from './transport.js'
import { createIpfsApi } from './ipfs.js'
import { createWebApi } from './web.js'
import { createCliApi } from './cli.js'
import { createStateApi } from './state.js'
import { InvalidAppStateError } from './errors.js'

/**
 * 创建 app 实例。
 *
 * @param {object} snode SNode 实例（mock 或真实）
 * @param {AppManifest|object} manifest App Manifest（实例或原始字段）
 * @param {object} [options]
 * @param {string} [options.dataDir] 覆盖 manifest.dataDir（用于 App 自定义数据目录）
 * @param {function} [options.log] 自定义 logger
 * @returns {Promise<object>} app 实例（含 manifest/snode/options + 7 大子模块 + web/cli/state）
 */
export async function createApp(snode, manifest, options = {}) {
  if (!snode) throw new Error('createApp: snode 必填')
  if (!manifest) throw new Error('createApp: manifest 必填')

  // 1. 归一化 manifest 为 AppManifest 实例
  const manifestObj = manifest instanceof AppManifest
    ? manifest
    : new AppManifest(manifest)

  // 2. 计算最终 dataDir（options > manifest > 默认 name）
  const dataDir = options.dataDir ?? manifestObj.dataDir ?? manifestObj.name

  // 3. 创建 app 容器
  const app = {
    manifest: manifestObj,
    manifestId: manifestObj.name,  // M9.2 用 name 作为 manifestId（M9.3 可改为 hash）
    snode,
    options,
    dataDir,
    // log：优先用 options 自定义，其次用 snode.log，最后 noop
    log: options.log ?? snode.log ?? ((lvl, tag, msg) => { /* noop */ }),
  }

  // 4. 装配各子模块（缺依赖时置为 null + 调用抛 InvalidAppStateError）

  // 4.1 context（依赖 snode.wallet）
  app.context = snode.wallet
    ? createContextApi(snode, manifestObj)
    : null

  // 4.2 market（无外部依赖，全部委托 snode）
  app.market = createMarketApi(snode, manifestObj)

  // 4.3 credit（依赖 snode.creditLedger，实际由各方法在调用时校验）
  app.credit = snode.creditLedger || snode.issueCredit || snode.consumeCredit
    ? createCreditApi(snode, manifestObj)
    : null

  // 4.4 wiki（依赖 snode.wiki）
  app.wiki = snode.wiki
    ? createWikiApi(snode, manifestObj)
    : null

  // 4.5 tunnel（依赖 snode.establishTunnel）
  app.tunnel = snode.establishTunnel
    ? createTunnelApi(snode, manifestObj)
    : null

  // 4.6 arbitration（依赖 snode.arbitrationRegistry 或 snode.fileDispute）
  app.arbitration = (snode.fileDispute || snode.arbitrationRegistry)
    ? createArbitrationApi(snode, manifestObj)
    : null

  // 4.7 transport（依赖 snode.libp2p.services.pubsub）
  app.transport = snode.libp2p?.services?.pubsub
    ? createTransportApi(snode, manifestObj)
    : null

  // 4.8 ipfs（依赖 snode.ipfs.blockstore）
  app.ipfs = snode.ipfs?.blockstore
    ? createIpfsApi(snode, manifestObj)
    : null

  // 4.9 web（无外部依赖，纯注册表）
  app.web = createWebApi(snode, manifestObj)

  // 4.10 cli（无外部依赖，纯注册表）
  app.cli = createCliApi(snode, manifestObj)

  // 4.11 state（无外部依赖，M9.2 mock 内存版）
  app.state = createStateApi(snode, manifestObj, options.dataDir)

  // 5. 装配 lazy getter：访问 null 子模块时抛清晰错误
  //    避免每次调用都先 if (app.xxx === null) throw
  //    用 Proxy 拦截 null 子模块的属性访问
  //    —— M9.2 不用 Proxy（保留简单对象语义便于测试），改为提供 helper：
  app._ensureModule = function (name) {
    if (app[name] === null || app[name] === undefined) {
      throw new InvalidAppStateError(
        `App "${manifestObj.name}" 的 ${name} 子模块未初始化（SNode 未提供对应能力）`,
        { details: { module: name, appName: manifestObj.name } },
      )
    }
  }

  // 6. 装配 stop() 辅助（清空内部状态，M9.3 AppManager 调用）
  app.stop = async function () {
    // 清理 transport / market 订阅
    if (snode._transportSubscriptions) snode._transportSubscriptions.clear()
    if (snode._marketSubscriptions) snode._marketSubscriptions.clear()
    if (snode._creditHandlers) snode._creditHandlers.length = 0
    // state flush（M9.3 真实 SNode 才有持久化效果）
    await app.state.flush?.()
  }

  return app
}

export { AppManifest, MANIFEST_DEFAULTS }
