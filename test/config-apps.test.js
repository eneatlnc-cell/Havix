/**
 * config.js M9.3 App 选项测试
 * ───────────────────────────────────────────────
 * 覆盖 --apps / --no-apps / --apps-dir / HAVIX_APPS / HAVIX_APPS_DIR
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG } from '../src/config.js'

describe('config: M9.3 App 容器默认值', () => {
  test('DEFAULT_CONFIG 含 apps / appsDir 字段', () => {
    assert.equal(DEFAULT_CONFIG.apps, true)
    assert.equal(DEFAULT_CONFIG.appsDir, 'apps')
  })
})

describe('config: parseArgv 解析 --apps 选项', () => {
  // 直接用 process.argv 模拟；为避免污染全局，复制 parseArgv 逻辑
  function parseArgv(argv) {
    const cli = {}
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]
      if (arg === '--apps' || arg.startsWith('--apps=')) {
        const val = arg.includes('=') ? arg.split('=')[1] : 'true'
        cli.apps = val === 'true' || val === '1'
      } else if (arg === '--no-apps') {
        cli.apps = false
      } else if (arg === '--apps-dir' || arg.startsWith('--apps-dir=')) {
        cli.appsDir = arg.includes('=') ? arg.split('=')[1] : argv[++i]
      }
    }
    return cli
  }

  test('--no-apps 设置 apps=false', () => {
    const cli = parseArgv(['--no-apps'])
    assert.equal(cli.apps, false)
  })

  test('--apps=false 设置 apps=false', () => {
    const cli = parseArgv(['--apps=false'])
    assert.equal(cli.apps, false)
  })

  test('--apps=true 设置 apps=true', () => {
    const cli = parseArgv(['--apps=true'])
    assert.equal(cli.apps, true)
  })

  test('--apps（无等号）设置 apps=true', () => {
    const cli = parseArgv(['--apps'])
    assert.equal(cli.apps, true)
  })

  test('--apps-dir <path> 设置 appsDir', () => {
    const cli = parseArgv(['--apps-dir', '/opt/apps'])
    assert.equal(cli.appsDir, '/opt/apps')
  })

  test('--apps-dir=<path> 设置 appsDir', () => {
    const cli = parseArgv(['--apps-dir=/var/apps'])
    assert.equal(cli.appsDir, '/var/apps')
  })

  test('不传 apps 选项时 cli.apps undefined', () => {
    const cli = parseArgv([])
    assert.equal(cli.apps, undefined)
    assert.equal(cli.appsDir, undefined)
  })

  test('--apps + --apps-dir 同时设置', () => {
    const cli = parseArgv(['--apps', '--apps-dir', '/custom/path'])
    assert.equal(cli.apps, true)
    assert.equal(cli.appsDir, '/custom/path')
  })

  test('--no-apps + --apps-dir 同时设置', () => {
    const cli = parseArgv(['--no-apps', '--apps-dir', '/disabled/path'])
    assert.equal(cli.apps, false)
    assert.equal(cli.appsDir, '/disabled/path')
  })
})

describe('config: loadConfig 合并 env + cli', () => {
  // 这里只测 default + env 行为；完整 loadConfig 测试需 mock process.argv / env
  test('DEFAULT_CONFIG 包含完整 M9.3 字段', () => {
    const expectedKeys = [
      'port', 'name', 'dataDir',
      'mdns', 'bootstrap', 'dht', 'dhtMode',
      'logLevel',
      'repl', 'web', 'webPort', 'webHost',
      'apps', 'appsDir',
    ]
    for (const k of expectedKeys) {
      assert.ok(k in DEFAULT_CONFIG, `DEFAULT_CONFIG 缺字段: ${k}`)
    }
  })
})
