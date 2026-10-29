/**
 * dsh-remote-monitor — host half.
 *
 * Mounts the host book (discovery from `~/.ssh/config` and the dsh-ssh store),
 * the SSH pool, the demand-driven sampler, the `/api/dsh-remote-monitor` route
 * family including its SSE stream, the read-only `rmon_*` agent tools, and an
 * optional system-prompt announcement.
 *
 * Everything rides the official NPM SDK packages: no DSH source change, no
 * patched bundle. The browser half (`./client`) renders the dashboard.
 *
 * @module dsh-remote-monitor
 */

import { readFileSync } from 'node:fs'

import z from '@deepseek-ai/schemastery'
import { Monitor } from './monitor.js'
import { mountOnce } from './mount-once.js'
import { SshPool } from './pool.js'
import { makeRoutes } from './routes.js'
import { HostBook, mtimeMs } from './store.js'
import { makeTools } from './tools.js'

/** Stable cordis plugin name. */
export const name = 'remote-monitor'

/**
 * The package version, surfaced in the panel so a user can tell at a glance
 * whether the running host picked up the code on disk. Cosmetic: a missing or
 * unreadable package.json must never stop the plugin.
 */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? null
  } catch {
    return null
  }
})()

/** Services required before the surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 155

/**
 * Plugin config schema. Under the settings model this schema IS the entry's
 * settings page: the Host derives one form per profile entry from it. Fields
 * marked `volatile()` are committed into a running instance without a remount,
 * which is what lets a new poll interval take effect immediately.
 */
export const Config = z.object({
  /** Master switch for every surface (routes, tools, prompt section). */
  enabled: z.boolean().default(true).volatile(),
  /** Announce the plugin and its tools to every agent. */
  announceToAgent: z.boolean().default(true).volatile(),
  /** Poll interval in milliseconds (clamped to 2000..600000). */
  intervalMs: z.number().default(5000).volatile(),
  /** How many hosts are polled concurrently. */
  concurrency: z.number().default(4).volatile(),
  /** History points kept per host for the charts. */
  historyLimit: z.number().default(240).volatile(),
  /** How many processes the probe reports per sort order. */
  topN: z.number().default(8).volatile(),
  /** Remote command budget in milliseconds. */
  timeoutMs: z.number().default(30000).volatile(),
  /** Budget for establishing one SSH connection, in milliseconds. */
  connectTimeoutMs: z.number().default(15000).volatile(),
  /**
   * Establish connections to hosts behind the same bastion one at a time.
   * Off by default: measured, one `wsCli` gateway handles concurrent links
   * fine, so serializing only made the first refresh three times slower. Turn
   * it on for a gateway that genuinely allows one session at a time.
   */
  serializeBastion: z.boolean().default(false).volatile(),
  /** Keep polling even with no dashboard open (fills history continuously). */
  alwaysOn: z.boolean().default(false).volatile(),
  /** Idle window before polling stops, in milliseconds. */
  idleStopMs: z.number().default(60000).volatile(),
  /** Milliseconds a sample stays fresh enough to reuse for an agent read. */
  cacheTtlMs: z.number().default(2000).volatile(),
  /** Gap between the two probes of a cold start, in milliseconds. */
  rateProbeDelayMs: z.number().default(1000).volatile(),
  /** Include the loopback interface in the network table. */
  includeLoopbackNet: z.boolean().default(false).volatile(),
  /** Comma-separated interface allow-list; empty means every interface. */
  netInterfaces: z.string().default('').volatile(),
  /** Comma-separated block-device allow-list; empty means every physical device. */
  diskDevices: z.string().default('').volatile(),
  /**
   * Alert threshold defaults. A change made in the dashboard is persisted in
   * `$DSH_HOME/dsh-remote-monitor.json` and wins over these; a threshold of 0
   * disables that rule.
   */
  thresholds: z.object({
    cpu: z.number().default(90),
    mem: z.number().default(90),
    swap: z.number().default(50),
    disk: z.number().default(90),
    gpu: z.number().default(95),
    gpuMem: z.number().default(95),
    temp: z.number().default(85),
    loadPerCore: z.number().default(100),
  }).default({}),
  /**
   * Spare-capacity model: what makes a machine "free enough to take a job".
   * Percentages here describe what is still AVAILABLE, not what is used.
   */
  /**
   * Low-utilisation reminder: fire a warning when a machine has been sitting
   * idle long enough that its capacity is being wasted. `enabled: false`
   * switches it off; `forSec` must be at least 60.
   */
  lowUsage: z.object({
    enabled: z.boolean().default(true),
    cpuBelow: z.number().default(15),
    gpuBelow: z.number().default(10),
    forSec: z.number().default(600),
  }).default({}),
  /**
   * Idle index: one 0..100 number blending how long a machine has been idle
   * with how little its GPU is doing. See `capacity.js` for the formula.
   */
  idleIndex: z.object({
    halfLifeSec: z.number().default(1800),
    utilWeight: z.number().default(0.5),
    timeWeight: z.number().default(0.5),
  }).default({}),
  /**
   * Sidebar-footer indicator: a small always-visible line under the sidebar
   * footer showing idle machines / free GPUs, refreshed at `pollSec` while a
   * browser tab is open. `pollSec` below 30 is clamped by the sampler.
   */
  footer: z.object({
    enabled: z.boolean().default(true),
    // Subscribe to the live SSE stream while the tab is visible. On, the list
    // updates with the dashboard's 5 s cadence; off keeps the slow poll only.
    live: z.boolean().default(true),
    pollSec: z.number().default(60),
  }).default({}),
  capacity: z.object({
    cpuFreeMin: z.number().default(60),
    memFreeMin: z.number().default(50),
    gpuUtilMax: z.number().default(10),
    gpuMemMax: z.number().default(10),
    gpuBusyUtil: z.number().default(85),
    gpuBusyMem: z.number().default(80),
    freeScore: z.number().default(60),
    partialScore: z.number().default(30),
    blockDiskPercent: z.number().default(90),
    blockMemPercent: z.number().default(90),
    blockLoadPerCore: z.number().default(8),
  }).default({}),
})

/** The model-facing announcement. */
export const GUIDANCE = '本机已安装 dsh-remote-monitor 插件（DSH 远程资源监控）：侧边栏「监控」入口有实时仪表盘（CPU/内存/Swap/磁盘用量与 IO/网络/GPU 曲线 + 进程表 + 阈值告警）。'
  + '告警除了阈值上限，还有「低使用率提醒」：机器连续空闲（GPU 平均利用率或 CPU 低于阈值）超过设定时长会记一条 warn 告警，可在面板「阈值」里改。'
  + '工具：rmon_list 列出被监控的远程机器；rmon_idle 按空余容量给机器排序（空闲 GPU、空余核数/内存、持续空闲时长、阻塞原因），回答「哪台机器能接新任务」；rmon_status 读取一台或全部机器的实时资源使用；rmon_gpu 读取 NVIDIA 卡（利用率/显存/温度/功耗/占用进程）；rmon_processes 按 CPU 或内存列出最忙的进程；rmon_alerts 查询阈值告警。'
  + '主机列表自动来自 ~/.ssh/config 与 dsh-ssh 插件的 ~/.dsh/dsh-ssh.json，无需重复录入；认证优先使用 ssh-agent 与默认私钥，其次才是已保存的密码。'
  + '限制：这些工具只能读取，不能执行任意命令（需要执行命令请用 ssh_exec）；百分比是两次采样之间的区间值，首次读取只给绝对值；采样由界面或工具调用驱动，无人使用时自动停止轮询。'
  + '空闲指数（0..100）= 空闲时长（半衰期默认 30 分钟）+ 利用率空闲度（GPU 机器看各卡平均，CPU 机器看 CPU）各占一半，用于排序「哪台最闲」；面板默认只列出可连接的机器。'
  + '侧边栏底部有一条「机器空余」小条：显示空闲机器与空闲 GPU，点击展开低使用率机器列表；它会在页面打开时按 pollSec（默认 60 秒）主动采样一次。'
  + '空余度按 GPU/CPU/内存加权计算（有 GPU 的机器 GPU 权重最高），磁盘≥90% 或内存≥90% 会标记为不可调度；「持续空闲」是连续两次以上采样的结果，首次采样不算。'
  + '用户提到「远程机器资源/CPU/内存/磁盘/GPU 使用率/哪台机器忙/哪台机器空着/有空闲的卡吗/显存/进程」时即指本插件。'

/** A config field: a live reference (settings model) or a plain value (tests). */
function resolveField(field, fallback) {
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && typeof field.get === 'function') {
    const value = field.get()
    return value === undefined ? fallback : value
  }
  return field
}

/**
 * Read the resolved config into a plain object, following volatile references.
 * @param {object|undefined} config - the config the Host handed to `apply`.
 * @returns {object} plain values.
 */
function readConfig(config) {
  const raw = config ?? {}
  const out = {}
  for (const key of ['intervalMs', 'concurrency', 'historyLimit', 'topN', 'timeoutMs', 'connectTimeoutMs', 'idleStopMs', 'cacheTtlMs', 'rateProbeDelayMs', 'netInterfaces', 'diskDevices']) {
    out[key] = resolveField(raw[key], undefined)
  }
  for (const key of ['enabled', 'announceToAgent', 'alwaysOn', 'includeLoopbackNet', 'serializeBastion']) {
    out[key] = resolveField(raw[key], undefined)
  }
  const idleIndex = resolveField(raw.idleIndex, undefined)
  if (typeof idleIndex === 'object' && idleIndex !== null) {
    out.idleIndex = {}
    for (const [key, value] of Object.entries(idleIndex)) out.idleIndex[key] = resolveField(value, undefined)
  }
  const footer = resolveField(raw.footer, undefined)
  if (typeof footer === 'object' && footer !== null) {
    out.footer = {}
    for (const [key, value] of Object.entries(footer)) out.footer[key] = resolveField(value, undefined)
  }
  const lowUsage = resolveField(raw.lowUsage, undefined)
  if (typeof lowUsage === 'object' && lowUsage !== null) {
    out.lowUsage = {}
    for (const [key, value] of Object.entries(lowUsage)) out.lowUsage[key] = resolveField(value, undefined)
  }
  const capacity = resolveField(raw.capacity, undefined)
  if (typeof capacity === 'object' && capacity !== null) {
    out.capacity = {}
    for (const [key, value] of Object.entries(capacity)) out.capacity[key] = resolveField(value, undefined)
  }
  const thresholds = resolveField(raw.thresholds, undefined)
  if (typeof thresholds === 'object' && thresholds !== null) {
    out.thresholds = {}
    for (const [key, value] of Object.entries(thresholds)) out.thresholds[key] = resolveField(value, undefined)
  }
  return out
}

/** Mount the monitor. Single-instance guarded: see mount-once.js. */
export const apply = mountOnce('dsh-remote-monitor', applyImpl)

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {object} [config] - resolved plugin config.
 */
function applyImpl(ctx, config) {
  const initial = readConfig(config)

  const book = new HostBook({ thresholds: initial.thresholds, lowUsage: initial.lowUsage })
  const pool = new SshPool({
    resolveAlias: alias => book.find(alias),
    connectTimeoutMs: 15_000,
  })
  const monitor = new Monitor({ book, pool, config: initial })
  monitor.packageVersion = VERSION

  ctx.effect(() => () => { monitor.dispose() }, 'dsh-remote-monitor: engine')

  const { routes, dispose: disposeStreams } = makeRoutes({
    book,
    monitor,
    pool,
    onHostsChanged: () => { monitor.prune() },
  })
  const tools = makeTools(monitor, book)

  let disposeRoutes
  let disposeTools
  let disposeSection

  /**
   * Derive every surface from the current config. Re-registering first tears
   * the previous group down, so a duplicate-name registration can never throw.
   */
  const sync = () => {
    const resolved = readConfig(config)
    if (disposeSection !== undefined) { disposeSection(); disposeSection = undefined }
    if (disposeRoutes !== undefined) { disposeRoutes(); disposeRoutes = undefined }
    if (disposeTools !== undefined) { disposeTools(); disposeTools = undefined }

    if (resolved.enabled === false) {
      monitor.stopTimer()
      return
    }

    if (resolved.announceToAgent !== false) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-remote-monitor',
        order: SECTION_ORDER,
        text: GUIDANCE,
      })
    }

    disposeRoutes = ctx.effect(() => {
      const disposers = routes.map(route => ctx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
        // Closing the routes must also end live SSE streams: a stream that
        // outlives its route would keep the sampler running for nobody.
        disposeStreams()
      }
    }, 'dsh-remote-monitor: routes')

    disposeTools = ctx.effect(() => {
      const disposers = tools.map(tool => ctx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-remote-monitor: tools')

    // Transport tuning lives on the pool, not the sampler.
    if (Number.isFinite(Number(resolved.connectTimeoutMs))) {
      pool.connectTimeoutMs = Math.min(120_000, Math.max(3000, Math.trunc(Number(resolved.connectTimeoutMs))))
    }
    pool.serializeBastion = resolved.serializeBastion === true

    monitor.reconfigure(resolved)
  }

  // A settings edit lands in this instance's volatile references and is
  // announced on the owning fiber (the entry is not remounted).
  ctx.on('loader/volatile-update', () => { sync() })

  // Re-read the discovery sources when one of them changes on disk, so editing
  // ~/.ssh/config shows up without pressing anything.
  monitor.sourceWatch = () => {
    const fingerprint = [mtimeMs(book.sshConfigFile), mtimeMs(book.dshSshFile), mtimeMs(book.settingsFile)].join(':')
    if (monitor.sourceFingerprint === undefined) {
      monitor.sourceFingerprint = fingerprint
      return false
    }
    if (monitor.sourceFingerprint === fingerprint) return false
    monitor.sourceFingerprint = fingerprint
    book.refresh()
    monitor.prune()
    monitor.publish({ type: 'hosts', hosts: monitor.all(), at: Date.now() })
    return true
  }

  sync()
}
