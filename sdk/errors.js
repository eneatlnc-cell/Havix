// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Havix SDK 错误类型（M9.1）
 * ───────────────────────────────────────────────
 * 所有 SDK 抛出的错误都继承自 HavixSdkError，便于上层 try/catch 统一处理。
 *
 * 错误分类：
 *   - ManifestError              Manifest 解析 / 校验失败
 *   - PermissionDeniedError      权限不足（App 未声明对应权限）
 *   - ContextNotEnabledError     App 未启用对应 context（sign 时）
 *   - AppNotFoundError           App 未加载（Web 路由找不到 App）
 *   - AppAlreadyLoadedError      App 已加载（重复加载）
 *   - InvalidAppStateError       App 状态非法（如调用顺序错误）
 */

/**
 * SDK 错误基类。
 * 所有 SDK 抛出的错误都继承自此类，便于上层 try/catch 统一处理。
 */
export class HavixSdkError extends Error {
  /**
   * @param {string} message 错误信息
   * @param {object} [opts]
   * @param {string} [opts.code] 错误码（机器可读，如 'MANIFEST_INVALID_FIELD'）
   * @param {object} [opts.details] 额外上下文（如 Manifest 字段名、权限名）
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = new.target.name
    this.code = opts.code ?? 'HAVIX_SDK_ERROR'
    this.details = opts.details
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target)
    }
  }
}

/**
 * Manifest 解析 / 校验失败。
 * 用法：throw new ManifestError('name 字段缺失', { code: 'MANIFEST_MISSING_FIELD', details: { field: 'name' } })
 */
export class ManifestError extends HavixSdkError {
  constructor(message, opts = {}) {
    super(message, { code: opts.code ?? 'MANIFEST_ERROR', ...opts })
  }
}

/**
 * 权限不足——App 未声明对应权限。
 * 用法：throw new PermissionDeniedError('market:publish', { app: 'translation-market' })
 */
export class PermissionDeniedError extends HavixSdkError {
  /**
   * @param {string} permission 被拒绝的权限名（如 'market:publish'）
   * @param {object} [opts]
   * @param {string} [opts.app] App 名
   */
  constructor(permission, opts = {}) {
    const app = opts.app ?? '(unknown app)'
    super(
      `权限不足：App "${app}" 未声明权限 "${permission}"。请在 manifest.yaml 的 permissions 列表中添加该权限。`,
      {
        code: 'PERMISSION_DENIED',
        details: { permission, app, ...opts.details },
      },
    )
    this.permission = permission
  }
}

/**
 * App 未启用对应 context（调用 context.sign 时）。
 * 用法：throw new ContextNotEnabledError('A', { app: 'translation-market', enabled: ['B'] })
 */
export class ContextNotEnabledError extends HavixSdkError {
  /**
   * @param {string} context 被拒绝的 context（如 'A'）
   * @param {object} [opts]
   * @param {string} [opts.app] App 名
   * @param {string[]} [opts.enabled] App 已启用的 context 列表
   */
  constructor(context, opts = {}) {
    const enabled = opts.enabled ?? []
    const app = opts.app ?? '(unknown app)'
    super(
      `Context "${context}" 未被 App "${app}" 启用。已启用的 context: [${enabled.join(', ')}]。` +
        `Manifest.contexts 字段需包含该 context 才能调用 sign()。`,
      {
        code: 'CONTEXT_NOT_ENABLED',
        details: { context, app, enabled, ...opts.details },
      },
    )
    this.context = context
  }
}

/**
 * App 未加载——Web 路由找不到 App。
 * 用法：throw new AppNotFoundError('translation-market')
 */
export class AppNotFoundError extends HavixSdkError {
  constructor(appName, opts = {}) {
    super(`App "${appName}" 未加载。请检查 apps/ 目录是否包含该 App 的 manifest.yaml。`, {
      code: 'APP_NOT_FOUND',
      details: { appName, ...opts.details },
    })
    this.appName = appName
  }
}

/**
 * App 已加载——重复加载。
 * 用法：throw new AppAlreadyLoadedError('translation-market')
 */
export class AppAlreadyLoadedError extends HavixSdkError {
  constructor(appName, opts = {}) {
    super(`App "${appName}" 已加载。重复加载 AppManager.start() 或同目录存在重复 manifest。`, {
      code: 'APP_ALREADY_LOADED',
      details: { appName, ...opts.details },
    })
    this.appName = appName
  }
}

/**
 * App 状态非法——调用顺序错误。
 * 用法：throw new InvalidAppStateError('App 未 start 就调用 stop')
 */
export class InvalidAppStateError extends HavixSdkError {
  constructor(message, opts = {}) {
    super(message, {
      code: 'INVALID_APP_STATE',
      details: opts.details,
    })
  }
}
