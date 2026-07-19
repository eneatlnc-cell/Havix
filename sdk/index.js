/**
 * Havix SDK 入口（M9.2）
 * ───────────────────────────────────────────────
 * 当前阶段：M9.2 完成
 *   ✅ errors.js         SDK 错误类型
 *   ✅ permissions.js    权限白名单 + 校验
 *   ✅ manifest.js       AppManifest + 解析 + 校验
 *   ✅ context.js        4-context 子身份 API
 *   ✅ market.js         私域市场 API
 *   ✅ credit.js         Credit 流水 API
 *   ✅ wiki.js           维基 API
 *   ✅ tunnel.js         隧道 API
 *   ✅ arbitration.js    仲裁 API
 *   ✅ transport.js      gossipsub / IPFS 抽象
 *   ✅ ipfs.js           IPFS 操作
 *   ✅ web.js            Web 路由注册（GET-only）
 *   ✅ cli.js            CLI 命令注册
 *   ✅ state.js          App 状态持久化（M9.2 内存版，M9.3 接持久化）
 *   ✅ app.js            createApp 入口
 *   ✅ __mocks__/snode-mock.js  mock SNode（用于单元测试）
 *
 * M9.3+ 将加入：
 *   ⏳ AppManager（src/app/app-manager.js，扫描 apps/ 加载）
 *   ⏳ SNode 集成（s-node.js 接 AppManager）
 *   ⏳ WebPanel /apps/<name>/ 路由分发
 *   ⏳ state.js 真实持久化（写盘）
 */

// 错误类型
export {
  HavixSdkError,
  ManifestError,
  PermissionDeniedError,
  ContextNotEnabledError,
  AppNotFoundError,
  AppAlreadyLoadedError,
  InvalidAppStateError,
} from './errors.js'

// 权限
export {
  PERMISSIONS,
  PERMISSION_MAP,
  PERMISSION_NAMES,
  PERMISSION_CATEGORIES,
  isValidPermission,
  validatePermissions,
  checkPermission,
  hasPermission,
  getPermissionsByCategory,
} from './permissions.js'

// Manifest
export {
  AppManifest,
  CAPABILITIES,
  INVITE_TOKEN_FORMATS,
  VALID_CONTEXTS,
  DEFAULTS as MANIFEST_DEFAULTS,
  validateManifest,
} from './manifest.js'

// 各子模块工厂（高级用法：App 可单独 import 工厂函数扩展自定义 SDK）
export { createContextApi, CONTEXT_META } from './context.js'
export { createMarketApi } from './market.js'
export { createCreditApi } from './credit.js'
export { createWikiApi } from './wiki.js'
export { createTunnelApi } from './tunnel.js'
export { createArbitrationApi } from './arbitration.js'
export { createTransportApi } from './transport.js'
export { createIpfsApi } from './ipfs.js'
export { createWebApi } from './web.js'
export { createCliApi } from './cli.js'
export { createStateApi } from './state.js'

// createApp 入口（最常用）
export { createApp } from './app.js'

// mock SNode（用于 App 的单元测试）
export { createSnodeMock, DEFAULT_DIDS } from './__mocks__/snode-mock.js'
