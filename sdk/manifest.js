// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Havix SDK AppManifest（M9.1）
 * ───────────────────────────────────────────────
 * AppManifest 是 App 的声明文件，描述 App 的身份、能力、权限、门槛。
 * 节点启动时由 AppManager 扫描 apps/ 目录加载每个 App 的 manifest.yaml。
 *
 * 字段（11 项）：
 *   必需（5）：
 *     name           App 全局唯一标识（kebab-case）
 *     version        semver 版本号
 *     capability     market / wiki / tunnel / public / custom
 *     permissions    权限声明列表（白名单）
 *     entryPoint     App 入口模块相对路径
 *   可选（6）：
 *     inviteTokenFormat  ed25519-signature（默认）/ none
 *     spaCid             前端 SPA 的 IPFS CID（M9 占位）
 *     minReputation      参与门槛（默认 0）
 *     trustWeight        加权转换权重 0.0-1.0（默认 0.5）
 *     dataDir            独立数据目录名（默认等于 name）
 *     contexts           使用的 context 子身份（如 ['B']，默认 []）
 *     description        人类可读描述
 *
 * 校验规则：
 *   - 必需字段缺失抛 ManifestError
 *   - 字段类型错误抛 ManifestError
 *   - name 必须 kebab-case（小写字母+数字+短横线）
 *   - version 必须 semver 格式
 *   - capability 必须在白名单中
 *   - permissions 必须在权限白名单中（见 permissions.js）
 *   - trustWeight 必须 0.0-1.0
 *   - minReputation 必须 >= 0
 *   - contexts 必须是 ['A'/'B'/'C'/'D'] 的子集
 */

import { ManifestError } from './errors.js'
import { validatePermissions, isValidPermission } from './permissions.js'

// ──────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────

export const CAPABILITIES = Object.freeze(['market', 'wiki', 'tunnel', 'public', 'custom'])

export const INVITE_TOKEN_FORMATS = Object.freeze(['ed25519-signature', 'none'])

export const VALID_CONTEXTS = Object.freeze(['A', 'B', 'C', 'D'])

export const DEFAULTS = Object.freeze({
  inviteTokenFormat: 'ed25519-signature',
  minReputation: 0,
  trustWeight: 0.5,
  dataDir: null,  // 默认等于 name（在构造时填充）
  contexts: [],
  description: '',
})

// ──────────────────────────────────────────────
// 校验辅助
// ──────────────────────────────────────────────

// kebab-case：小写字母开头，后接小写字母/数字/短横线，长度 1-64
const NAME_REGEX = /^[a-z][a-z0-9-]{0,63}$/

// semver：MAJOR.MINOR.PATCH（可选 -prerelease + +build）
const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/**
 * 校验 name 字段。
 * @param {any} name
 * @returns {string} 校验通过的 name
 * @throws {ManifestError}
 */
function validateName(name) {
  if (name === undefined || name === null) {
    throw new ManifestError('name 字段缺失（必需）', {
      code: 'MANIFEST_MISSING_FIELD',
      details: { field: 'name' },
    })
  }
  if (typeof name !== 'string') {
    throw new ManifestError(`name 字段必须是字符串，实际类型: ${typeof name}`, {
      code: 'MANIFEST_INVALID_TYPE',
      details: { field: 'name', expected: 'string', actual: typeof name },
    })
  }
  if (!NAME_REGEX.test(name)) {
    throw new ManifestError(
      `name 字段必须是 kebab-case（小写字母开头，仅含小写字母/数字/短横线，长度 1-64），实际: "${name}"`,
      {
        code: 'MANIFEST_INVALID_NAME',
        details: { field: 'name', value: name },
      },
    )
  }
  return name
}

/**
 * 校验 version 字段。
 * @param {any} version
 * @returns {string}
 * @throws {ManifestError}
 */
function validateVersion(version) {
  if (version === undefined || version === null) {
    throw new ManifestError('version 字段缺失（必需）', {
      code: 'MANIFEST_MISSING_FIELD',
      details: { field: 'version' },
    })
  }
  if (typeof version !== 'string') {
    throw new ManifestError(`version 字段必须是字符串，实际类型: ${typeof version}`, {
      code: 'MANIFEST_INVALID_TYPE',
      details: { field: 'version', expected: 'string', actual: typeof version },
    })
  }
  if (!SEMVER_REGEX.test(version)) {
    throw new ManifestError(
      `version 字段必须是 semver 格式（如 "1.0.0"），实际: "${version}"`,
      {
        code: 'MANIFEST_INVALID_VERSION',
        details: { field: 'version', value: version },
      },
    )
  }
  return version
}

/**
 * 校验 capability 字段。
 * @param {any} capability
 * @returns {string}
 * @throws {ManifestError}
 */
function validateCapability(capability) {
  if (capability === undefined || capability === null) {
    throw new ManifestError('capability 字段缺失（必需）', {
      code: 'MANIFEST_MISSING_FIELD',
      details: { field: 'capability' },
    })
  }
  if (typeof capability !== 'string') {
    throw new ManifestError(`capability 字段必须是字符串，实际类型: ${typeof capability}`, {
      code: 'MANIFEST_INVALID_TYPE',
      details: { field: 'capability', expected: 'string', actual: typeof capability },
    })
  }
  if (!CAPABILITIES.includes(capability)) {
    throw new ManifestError(
      `capability 字段必须是 [${CAPABILITIES.join(', ')}] 之一，实际: "${capability}"`,
      {
        code: 'MANIFEST_INVALID_CAPABILITY',
        details: { field: 'capability', value: capability, allowed: CAPABILITIES },
      },
    )
  }
  return capability
}

/**
 * 校验 permissions 字段。
 * @param {any} permissions
 * @returns {string[]}
 * @throws {ManifestError}
 */
function validatePermissionsField(permissions) {
  if (permissions === undefined || permissions === null) {
    throw new ManifestError('permissions 字段缺失（必需，可为空数组）', {
      code: 'MANIFEST_MISSING_FIELD',
      details: { field: 'permissions' },
    })
  }
  const result = validatePermissions(permissions)
  if (!result.valid) {
    throw new ManifestError(
      `permissions 字段校验失败：\n  - ${result.errors.join('\n  - ')}`,
      {
        code: 'MANIFEST_INVALID_PERMISSIONS',
        details: { field: 'permissions', errors: result.errors },
      },
    )
  }
  return [...permissions]  // 返回副本
}

/**
 * 校验 entryPoint 字段。
 * @param {any} entryPoint
 * @returns {string}
 * @throws {ManifestError}
 */
function validateEntryPoint(entryPoint) {
  if (entryPoint === undefined || entryPoint === null) {
    throw new ManifestError('entryPoint 字段缺失（必需）', {
      code: 'MANIFEST_MISSING_FIELD',
      details: { field: 'entryPoint' },
    })
  }
  if (typeof entryPoint !== 'string') {
    throw new ManifestError(`entryPoint 字段必须是字符串，实际类型: ${typeof entryPoint}`, {
      code: 'MANIFEST_INVALID_TYPE',
      details: { field: 'entryPoint', expected: 'string', actual: typeof entryPoint },
    })
  }
  if (entryPoint.length === 0) {
    throw new ManifestError('entryPoint 字段不能为空字符串', {
      code: 'MANIFEST_INVALID_ENTRYPOINT',
      details: { field: 'entryPoint' },
    })
  }
  // 不允许绝对路径（防 App 加载文件系统任意位置的代码）
  if (entryPoint.startsWith('/') || entryPoint.match(/^[a-zA-Z]:/)) {
    throw new ManifestError(
      `entryPoint 字段必须是相对路径（不允许绝对路径），实际: "${entryPoint}"`,
      {
        code: 'MANIFEST_INVALID_ENTRYPOINT',
        details: { field: 'entryPoint', value: entryPoint },
      },
    )
  }
  // 不允许 .. 路径穿越（防逃逸 App 目录）
  if (entryPoint.includes('..')) {
    throw new ManifestError(
      `entryPoint 字段不允许包含 ".." 路径穿越，实际: "${entryPoint}"`,
      {
        code: 'MANIFEST_INVALID_ENTRYPOINT',
        details: { field: 'entryPoint', value: entryPoint },
      },
    )
  }
  return entryPoint
}

/**
 * 校验 inviteTokenFormat 字段（可选）。
 * @param {any} value
 * @returns {string}
 * @throws {ManifestError}
 */
function validateInviteTokenFormat(value) {
  if (value === undefined || value === null) return DEFAULTS.inviteTokenFormat
  if (typeof value !== 'string') {
    throw new ManifestError(
      `inviteTokenFormat 字段必须是字符串，实际类型: ${typeof value}`,
      {
        code: 'MANIFEST_INVALID_TYPE',
        details: { field: 'inviteTokenFormat', expected: 'string', actual: typeof value },
      },
    )
  }
  if (!INVITE_TOKEN_FORMATS.includes(value)) {
    throw new ManifestError(
      `inviteTokenFormat 字段必须是 [${INVITE_TOKEN_FORMATS.join(', ')}] 之一，实际: "${value}"`,
      {
        code: 'MANIFEST_INVALID_INVITE_TOKEN_FORMAT',
        details: { field: 'inviteTokenFormat', value, allowed: INVITE_TOKEN_FORMATS },
      },
    )
  }
  return value
}

/**
 * 校验 spaCid 字段（可选）。
 * @param {any} value
 * @returns {string|null}
 * @throws {ManifestError}
 */
function validateSpaCid(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new ManifestError(`spaCid 字段必须是字符串，实际类型: ${typeof value}`, {
      code: 'MANIFEST_INVALID_TYPE',
      details: { field: 'spaCid', expected: 'string', actual: typeof value },
    })
  }
  // 简单 CID 校验（CIDv0 以 "z" 开头 base58，CIDv1 以 "b" 开头 base32 或 "z" 开头）
  // M9 阶段不严格校验 CID 格式，只校验非空
  if (value.length === 0) {
    throw new ManifestError('spaCid 字段不能为空字符串', {
      code: 'MANIFEST_INVALID_SPACID',
      details: { field: 'spaCid' },
    })
  }
  return value
}

/**
 * 校验 minReputation 字段（可选）。
 * @param {any} value
 * @returns {number}
 * @throws {ManifestError}
 */
function validateMinReputation(value) {
  if (value === undefined || value === null) return DEFAULTS.minReputation
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ManifestError(
      `minReputation 字段必须是有限数字，实际: ${value}`,
      {
        code: 'MANIFEST_INVALID_MIN_REPUTATION',
        details: { field: 'minReputation', value },
      },
    )
  }
  if (value < 0) {
    throw new ManifestError(
      `minReputation 字段必须 >= 0，实际: ${value}`,
      {
        code: 'MANIFEST_INVALID_MIN_REPUTATION',
        details: { field: 'minReputation', value },
      },
    )
  }
  return value
}

/**
 * 校验 trustWeight 字段（可选）。
 * @param {any} value
 * @returns {number}
 * @throws {ManifestError}
 */
function validateTrustWeight(value) {
  if (value === undefined || value === null) return DEFAULTS.trustWeight
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ManifestError(
      `trustWeight 字段必须是有限数字，实际: ${value}`,
      {
        code: 'MANIFEST_INVALID_TRUST_WEIGHT',
        details: { field: 'trustWeight', value },
      },
    )
  }
  if (value < 0 || value > 1) {
    throw new ManifestError(
      `trustWeight 字段必须在 0.0-1.0 之间，实际: ${value}`,
      {
        code: 'MANIFEST_INVALID_TRUST_WEIGHT',
        details: { field: 'trustWeight', value },
      },
    )
  }
  return value
}

/**
 * 校验 dataDir 字段（可选）。
 * @param {any} value
 * @param {string} name App 名（默认值兜底）
 * @returns {string}
 * @throws {ManifestError}
 */
function validateDataDir(value, name) {
  if (value === undefined || value === null || value === '') return name  // 默认等于 name
  if (typeof value !== 'string') {
    throw new ManifestError(`dataDir 字段必须是字符串，实际类型: ${typeof value}`, {
      code: 'MANIFEST_INVALID_TYPE',
      details: { field: 'dataDir', expected: 'string', actual: typeof value },
    })
  }
  // 简单安全检查：不允许绝对路径 / .. 路径穿越
  if (value.startsWith('/') || value.match(/^[a-zA-Z]:/)) {
    throw new ManifestError(
      `dataDir 字段必须是相对路径，实际: "${value}"`,
      {
        code: 'MANIFEST_INVALID_DATADIR',
        details: { field: 'dataDir', value },
      },
    )
  }
  if (value.includes('..')) {
    throw new ManifestError(
      `dataDir 字段不允许包含 ".." 路径穿越，实际: "${value}"`,
      {
        code: 'MANIFEST_INVALID_DATADIR',
        details: { field: 'dataDir', value },
      },
    )
  }
  return value
}

/**
 * 校验 contexts 字段（可选）。
 * @param {any} value
 * @returns {string[]}
 * @throws {ManifestError}
 */
function validateContexts(value) {
  if (value === undefined || value === null) return [...DEFAULTS.contexts]
  if (!Array.isArray(value)) {
    throw new ManifestError(
      `contexts 字段必须是数组，实际类型: ${typeof value}`,
      {
        code: 'MANIFEST_INVALID_CONTEXTS',
        details: { field: 'contexts', actual: typeof value },
      },
    )
  }
  const seen = new Set()
  const result = []
  for (const ctx of value) {
    if (typeof ctx !== 'string') {
      throw new ManifestError(
        `contexts 数组项必须是字符串，实际类型: ${typeof ctx}`,
        {
          code: 'MANIFEST_INVALID_CONTEXTS',
          details: { field: 'contexts', item: ctx },
        },
      )
    }
    if (!VALID_CONTEXTS.includes(ctx)) {
      throw new ManifestError(
        `contexts 数组项必须是 [${VALID_CONTEXTS.join(', ')}] 之一，实际: "${ctx}"`,
        {
          code: 'MANIFEST_INVALID_CONTEXTS',
          details: { field: 'contexts', item: ctx, allowed: VALID_CONTEXTS },
        },
      )
    }
    if (seen.has(ctx)) {
      throw new ManifestError(
        `contexts 数组不允许重复，重复项: "${ctx}"`,
        {
          code: 'MANIFEST_INVALID_CONTEXTS',
          details: { field: 'contexts', duplicate: ctx },
        },
      )
    }
    seen.add(ctx)
    result.push(ctx)
  }
  return result
}

/**
 * 校验 description 字段（可选）。
 * @param {any} value
 * @returns {string}
 * @throws {ManifestError}
 */
function validateDescription(value) {
  if (value === undefined || value === null) return DEFAULTS.description
  if (typeof value !== 'string') {
    throw new ManifestError(`description 字段必须是字符串，实际类型: ${typeof value}`, {
      code: 'MANIFEST_INVALID_TYPE',
      details: { field: 'description', expected: 'string', actual: typeof value },
    })
  }
  return value
}

// ──────────────────────────────────────────────
// AppManifest 类
// ──────────────────────────────────────────────

/**
 * AppManifest 类。所有字段经校验后冻结（不可变）。
 *
 * 用法：
 *   const manifest = AppManifest.fromYaml(yamlString)
 *   const manifest = AppManifest.fromObject({ name: '...', ... })
 *   const manifest = new AppManifest({ name: '...', ... })
 *
 *   manifest.name           // "translation-market"
 *   manifest.permissions    // ['market:publish', ...]
 *   manifest.hasPermission('market:publish')  // true
 *   manifest.toJSON()       // 序列化回对象
 */
export class AppManifest {
  /**
   * @param {object} raw 已解析的 Manifest 对象（来自 YAML / JSON / 代码字面量）
   * @throws {ManifestError} 任一字段校验失败
   */
  constructor(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ManifestError(
        `Manifest 必须是对象，实际类型: ${raw === null ? 'null' : typeof raw}`,
        { code: 'MANIFEST_INVALID_TYPE', details: { actual: typeof raw } },
      )
    }

    // 必需字段先校验（顺序很重要：name 先校验，dataDir 才能用 name 兜底）
    this.name = validateName(raw.name)
    this.version = validateVersion(raw.version)
    this.capability = validateCapability(raw.capability)
    this.permissions = validatePermissionsField(raw.permissions)
    this.entryPoint = validateEntryPoint(raw.entryPoint)

    // 可选字段
    this.inviteTokenFormat = validateInviteTokenFormat(raw.inviteTokenFormat)
    this.spaCid = validateSpaCid(raw.spaCid)
    this.minReputation = validateMinReputation(raw.minReputation)
    this.trustWeight = validateTrustWeight(raw.trustWeight)
    this.dataDir = validateDataDir(raw.dataDir, this.name)
    this.contexts = validateContexts(raw.contexts)
    this.description = validateDescription(raw.description)

    // 冻结——AppManifest 加载后不可变（防运行时篡改）
    Object.freeze(this)
    Object.freeze(this.permissions)
    Object.freeze(this.contexts)
  }

  // ──────────────────────────────────────────────
  // 静态工厂方法
  // ──────────────────────────────────────────────

  /**
   * 从普通对象创建 AppManifest。
   * @param {object} obj
   * @returns {AppManifest}
   * @throws {ManifestError}
   */
  static fromObject(obj) {
    return new AppManifest(obj)
  }

  /**
   * 从 JSON 字符串创建 AppManifest。
   * @param {string} json
   * @returns {AppManifest}
   * @throws {ManifestError} JSON 解析失败或字段校验失败
   */
  static fromJson(json) {
    if (typeof json !== 'string') {
      throw new ManifestError(
        `fromJson 入参必须是字符串，实际类型: ${typeof json}`,
        { code: 'MANIFEST_INVALID_INPUT', details: { method: 'fromJson', actual: typeof json } },
      )
    }
    let obj
    try {
      obj = JSON.parse(json)
    } catch (err) {
      throw new ManifestError(
        `JSON 解析失败: ${err.message}`,
        { code: 'MANIFEST_JSON_PARSE_ERROR', details: { error: err.message } },
      )
    }
    return new AppManifest(obj)
  }

  /**
   * 从 YAML 字符串创建 AppManifest。
   * M9.1 使用极简 YAML 解析器（只支持 manifest.yaml 的扁平 key: value 格式 + 数组），
   * 不引入外部 YAML 库（保持 sdk/ 零依赖）。
   *
   * 支持的 YAML 语法子集：
   *   - key: value（字符串/数字）
   *   - key:\n  - item1\n  - item2（数组）
   *   - # 注释
   *   - 空行
   *
   * 不支持：嵌套对象 / 多行字符串 / 锚点 / 别名
   *
   * @param {string} yaml
   * @returns {AppManifest}
   * @throws {ManifestError} YAML 解析失败或字段校验失败
   */
  static fromYaml(yaml) {
    if (typeof yaml !== 'string') {
      throw new ManifestError(
        `fromYaml 入参必须是字符串，实际类型: ${typeof yaml}`,
        { code: 'MANIFEST_INVALID_INPUT', details: { method: 'fromYaml', actual: typeof yaml } },
      )
    }
    const obj = parseSimpleYaml(yaml)
    return new AppManifest(obj)
  }

  // ──────────────────────────────────────────────
  // 实例方法
  // ──────────────────────────────────────────────

  /**
   * 检查 App 是否拥有指定权限。
   * @param {string} permission
   * @returns {boolean}
   */
  hasPermission(permission) {
    return this.permissions.includes(permission)
  }

  /**
   * 检查 App 是否启用了指定 context。
   * @param {string} context 'A' / 'B' / 'C' / 'D'
   * @returns {boolean}
   */
  hasContext(context) {
    return this.contexts.includes(context)
  }

  /**
   * 序列化为普通对象（与 raw 输入形状一致，便于 JSON.stringify 或回写文件）。
   * @returns {object}
   */
  toJSON() {
    return {
      name: this.name,
      version: this.version,
      capability: this.capability,
      permissions: [...this.permissions],
      entryPoint: this.entryPoint,
      inviteTokenFormat: this.inviteTokenFormat,
      ...(this.spaCid ? { spaCid: this.spaCid } : {}),
      minReputation: this.minReputation,
      trustWeight: this.trustWeight,
      dataDir: this.dataDir,
      contexts: [...this.contexts],
      description: this.description,
    }
  }

  /**
   * 简短摘要（用于日志打印）。
   * @returns {string}
   */
  toString() {
    return `AppManifest(name=${this.name}, version=${this.version}, capability=${this.capability}, permissions=[${this.permissions.join(',')}], contexts=[${this.contexts.join(',')}])`
  }
}

// ──────────────────────────────────────────────
// 极简 YAML 解析器（M9.1 内置，不引入外部依赖）
// ──────────────────────────────────────────────

/**
 * 极简 YAML 解析器——只支持 manifest.yaml 的扁平 key: value 格式 + 数组。
 *
 * 支持的语法：
 *   key: value                # 字符串/数字
 *   key: "quoted value"       # 带引号字符串
 *   key: 123                  # 数字
 *   key:                      # 数组开始
 *     - item1
 *     - item2
 *   # 注释
 *   空行
 *
 * 不支持：嵌套对象 / 多行字符串 / 锚点 / 别名
 *
 * @param {string} yaml
 * @returns {object}
 * @throws {ManifestError}
 */
function parseSimpleYaml(yaml) {
  const result = {}
  const lines = yaml.split('\n')

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // 跳过空行 + 注释行
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++
      continue
    }

    // 数组项（顶层不允许）
    if (trimmed.startsWith('- ')) {
      throw new ManifestError(
        `YAML 顶层不允许数组项，需在 key 下定义: "${line}"`,
        { code: 'MANIFEST_YAML_PARSE_ERROR', details: { line, lineNum: i + 1 } },
      )
    }

    // key: value 格式
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) {
      throw new ManifestError(
        `YAML 行无法解析（缺少冒号分隔符）: "${line}"`,
        { code: 'MANIFEST_YAML_PARSE_ERROR', details: { line, lineNum: i + 1 } },
      )
    }

    const key = trimmed.slice(0, colonIdx).trim()
    let valuePart = trimmed.slice(colonIdx + 1).trim()

    if (!key) {
      throw new ManifestError(
        `YAML 行缺少 key: "${line}"`,
        { code: 'MANIFEST_YAML_PARSE_ERROR', details: { line, lineNum: i + 1 } },
      )
    }

    // 情况 1：key: value（同行）
    if (valuePart !== '') {
      result[key] = parseYamlScalar(valuePart)
      i++
      continue
    }

    // 情况 2：key:（空值，可能是数组开始）
    // 向下扫描缩进的数组项
    const items = []
    let j = i + 1
    while (j < lines.length) {
      const nextLine = lines[j]
      const nextTrimmed = nextLine.trim()

      // 跳过空行 + 注释
      if (nextTrimmed === '' || nextTrimmed.startsWith('#')) {
        j++
        continue
      }

      // 数组项
      if (nextTrimmed.startsWith('- ')) {
        const item = nextTrimmed.slice(2).trim()
        items.push(parseYamlScalar(item))
        j++
        continue
      }

      // 数组项（仅 "-"）
      if (nextTrimmed === '-') {
        items.push('')
        j++
        continue
      }

      // 遇到非数组项 → 数组结束
      break
    }

    if (items.length > 0) {
      result[key] = items
      i = j
    } else {
      // 空值（null）
      result[key] = null
      i++
    }
  }

  return result
}

/**
 * 解析 YAML 标量值（字符串/数字/布尔/null/数组/对象）。
 * @param {string} raw
 * @returns {string|number|boolean|null|Array|object}
 */
function parseYamlScalar(raw) {
  if (raw === '') return ''

  // 内联空数组 / 空对象
  if (raw === '[]') return []
  if (raw === '{}') return {}

  // 内联数组：[a, b, c] 或 ["a", "b"]（M9.3 新增：支持 permissions: ["market:create", "credit:balance"]）
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim()
    if (inner === '') return []
    // 拆分顶层的逗号（不递归处理嵌套数组/对象，M9 单层够用）
    const items = []
    let cur = ''
    let inQuote = null
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]
      if (inQuote) {
        if (ch === inQuote) {
          inQuote = null
        }
        cur += ch
      } else if (ch === '"' || ch === "'") {
        inQuote = ch
        cur += ch
      } else if (ch === ',') {
        items.push(cur.trim())
        cur = ''
      } else {
        cur += ch
      }
    }
    if (cur.trim() !== '') items.push(cur.trim())
    return items.map(parseYamlScalar)
  }

  // 去掉引号
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1)
  }

  // null
  if (raw === 'null' || raw === '~') return null

  // 布尔
  if (raw === 'true') return true
  if (raw === 'false') return false

  // 数字
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10)
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw)

  // 字符串
  return raw
}

// ──────────────────────────────────────────────
// 校验函数（导出，供 AppManager 在加载 App 前调用）
// ──────────────────────────────────────────────

/**
 * 校验 Manifest 对象但不构造 AppManifest 实例。
 * 用于在加载前预先检查。
 * @param {object} raw
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateManifest(raw) {
  try {
    new AppManifest(raw)  // eslint-disable-line no-new
    return { valid: true, errors: [] }
  } catch (err) {
    if (err instanceof ManifestError) {
      return { valid: false, errors: [err.message] }
    }
    return { valid: false, errors: [`未知错误: ${err.message}`] }
  }
}

export { ManifestError, isValidPermission, validateDataDir }
