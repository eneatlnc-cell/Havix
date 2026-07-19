/**
 * Havix SDK 入口（M9.1）
 * ───────────────────────────────────────────────
 * 当前阶段：M9.1 完成
 *   ✅ errors.js         SDK 错误类型
 *   ✅ permissions.js    权限白名单 + 校验
 *   ✅ manifest.js       AppManifest + 解析 + 校验
 *
 * M9.2+ 将逐步加入：
 *   ⏳ context.js         4-context 子身份 API
 *   ⏳ market.js          私域市场 API
 *   ⏳ credit.js          Credit 流水 API
 *   ⏳ wiki.js            维基 API
 *   ⏳ tunnel.js          隧道 API
 *   ⏳ arbitration.js     仲裁 API
 *   ⏳ transport.js       gossipsub / IPFS 抽象
 *   ⏳ web.js             Web 路由注册
 *   ⏳ cli.js             CLI 命令注册
 *   ⏳ state.js           App 状态持久化
 *   ⏳ createApp()        App 入口（M9.2 实现）
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

// createApp 函数将在 M9.2 实现
// export { createApp } from './app.js'
