/**
 * 跨网段发现模块（M1 步骤 1.4）
 * ───────────────────────────────────────────────
 * Havix 白皮书原计划使用 @libp2p/rendezvous 协议做跨网段发现，但研究阶段确认：
 *   - npm 上 `@libp2p/rendezvous` 包不存在
 *   - 官方仓库 libp2p/js-libp2p-rendezvous 停滞于 2018 年 WIP 状态
 *   - 社区替代 @canvas-js/libp2p-rendezvous 存在但引入额外依赖
 *
 * MVP 修正方案：手动多地址引导（bootstrap）
 *   - 节点启动时通过 `--bootstrap <multiaddr>` 或 `HAVIX_BOOTSTRAP` 指定引导节点
 *   - 直接通过 libp2p.dial() 连接（不依赖 rendezvous 协议）
 *   - 连接成功后通过 gossipsub mesh 自然扩散邻居
 *
 * 这个方案的限制：
 *   - 引导节点必须是公开可访问的（multiaddr 中含 IP + 端口 + PeerId）
 *   - 不支持"按 namespace 查询节点"（rendezvous 的核心能力）
 *   - 跨网段发现只能靠"已知引导节点"链式扩散
 *
 * 升级路径（白皮书 Future Work）：
 *   - 阶段二可接入 @canvas-js/libp2p-rendezvous 提供 namespace 查询能力
 *   - 或用 KadDHT 的 peerRouting.findPeer 替代（但需要 PeerId 已知）
 *   - 或自实现一个轻量的 rendezvous 协议（基于 libp2p stream）
 *
 * 工作流程：
 *   1. 用户配置 bootstrap 列表（命令行 / 环境变量）
 *   2. 节点启动后异步 dial 每个引导节点
 *   3. dial 成功 → 加入邻居列表（与 mdns 发现的节点同等对待）
 *   4. dial 失败 → 打印警告，节点继续启动（不阻塞）
 */

import { multiaddr } from '@multiformats/multiaddr'

/**
 * Bootstrap 模块：管理跨网段引导节点的连接。
 */
export class Bootstrap {
  /**
   * @param {object} libp2p 已启动的 libp2p 实例
   * @param {string[]} bootstrapList multiaddr 字符串数组
   * @param {object} [logger] 简易日志函数 { info, warn, debug }
   */
  constructor(libp2p, bootstrapList, logger = console) {
    this.libp2p = libp2p
    this.bootstrapList = bootstrapList
    this.log = logger
  }

  /**
   * 异步连接所有引导节点。
   * 不阻塞主流程——单个引导节点失败不影响其他节点。
   *
   * @returns {Promise<{success: string[], failed: {addr: string, error: string}[]}>}
   */
  async connect() {
    const success = []
    const failed = []

    for (const addrStr of this.bootstrapList) {
      try {
        const result = await this._dialOne(addrStr)
        success.push(result)
        this.log.info('bootstrap', `连接引导节点成功：${result.peerId} (${addrStr})`)
      } catch (err) {
        failed.push({ addr: addrStr, error: err.message })
        this.log.warn('bootstrap', `连接引导节点失败：${addrStr} — ${err.message}`)
      }
    }

    if (success.length === 0 && this.bootstrapList.length > 0) {
      this.log.warn('bootstrap', `所有 ${this.bootstrapList.length} 个引导节点都连接失败`)
    } else if (success.length > 0) {
      this.log.info('bootstrap', `引导完成：${success.length}/${this.bootstrapList.length} 成功`)
    }

    return { success, failed }
  }

  /**
   * 拨号单个引导节点。
   *
   * @param {string} addrStr multiaddr 字符串，例如：
   *   '/ip4/192.168.1.10/tcp/9001/p2p/12D3KooW...'
   * @returns {Promise<{addr: string, peerId: string}>}
   * @private
   */
  async _dialOne(addrStr) {
    let ma
    try {
      ma = multiaddr(addrStr)
    } catch (err) {
      throw new Error(`无效的 multiaddr：${err.message}`)
    }

    // multiaddr 必须含 p2p 部分（PeerId）
    // 直接检查字符串形式是否含 /p2p/ 段（multiformats 14.x 的 stringTuples API 已变更）
    if (!addrStr.includes('/p2p/')) {
      throw new Error('multiaddr 缺少 p2p/PeerId 部分')
    }

    // dial 时带 5 秒超时，避免跨网段防火墙黑洞卡住
    const conn = await this.libp2p.dial(ma, {
      signal: AbortSignal.timeout(5_000),
    })

    return {
      addr: addrStr,
      peerId: conn.remotePeer.toString(),
    }
  }

  /**
   * 返回当前引导列表（用于调试/CLI 显示）。
   */
  list() {
    return [...this.bootstrapList]
  }
}
