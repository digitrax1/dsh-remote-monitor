/**
 * Sampler — the single place that decides when a remote machine is read.
 *
 * Polling is demand-driven. A timer runs while something is watching: an open
 * dashboard (an SSE subscriber) or a recent agent tool call. Once nothing has
 * asked for data for `idleStopMs`, the timer stops, so a plugin that is merely
 * installed does not keep ten SSH sessions and ten `ps` invocations running
 * forever. `alwaysOn` overrides that for users who want continuous history.
 *
 * Every host keeps its last counter read, so CPU / network / disk-IO figures
 * are deltas across the poll interval rather than a synthetic remote `sleep`.
 * The first read of a host is therefore a pair: a full probe for the heavy
 * sections, then one cheap counter-only probe ~1 s later, so even the first
 * sample the user or the agent sees carries real percentages.
 *
 * @module dsh-remote-monitor/monitor
 */

import { evaluateCapacity, evaluateIdleIndex, evaluateLowUsage, lowUsageAlert, normalizeCapacity, normalizeIdleIndex, normalizeLowUsage } from './capacity.js'
import { buildProbeScript, deriveSample, encodeProbeCommand, evaluateAlerts, parseProbe } from './probe.js'

/** Default poll interval. */
const DEFAULT_INTERVAL_MS = 5000

/** Default concurrent host polls. */
const DEFAULT_CONCURRENCY = 4

/** Default number of history points kept per host (5 s apart => 20 minutes). */
const DEFAULT_HISTORY_LIMIT = 240

/** Default freshness window for an on-demand read. */
const DEFAULT_CACHE_TTL_MS = 2000

/** Default gap between the two probes of a cold start. */
const DEFAULT_RATE_PROBE_DELAY_MS = 1000

/** Default idle window before the timer stops. */
const DEFAULT_IDLE_STOP_MS = 60_000

/** Recent alerts retained per host. */
const RECENT_ALERT_LIMIT = 20

/** Consecutive-failure backoff: first delay, then doubling, capped. */
const FAILURE_BACKOFF_BASE_MS = 15_000
const FAILURE_BACKOFF_MAX_MS = 120_000

/**
 * How long to wait before the next automatic attempt at a host that has failed
 * this many times in a row.
 *
 * Unreachable machines are common in a discovered host list (a stale entry in
 * `~/.ssh/config`), and one of them must not decide the polling cadence of the
 * whole fleet: behind a single bastion lane, a host that takes 30 s to fail
 * delays every other host on that bastion. A human asking (a refresh click, an
 * agent tool call) bypasses the delay.
 *
 * @param {number} failures - consecutive failures.
 * @returns {number} milliseconds to wait.
 */
function failureBackoffMs(failures) {
  if (failures <= 0) return 0
  return Math.min(FAILURE_BACKOFF_MAX_MS, FAILURE_BACKOFF_BASE_MS * 2 ** Math.min(3, failures - 1))
}

/** Sleep helper. */
function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms).unref?.() })
}

/**
 * Map over items with a concurrency cap, preserving input order.
 * @param {Array<*>} items - the work items.
 * @param {number} limit - maximum in flight.
 * @param {(item: *) => Promise<*>} worker - the async body.
 * @returns {Promise<Array<*>>} results in input order.
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = new Array(Math.max(1, Math.min(limit, items.length))).fill(null).map(async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * The compact per-tick series a chart needs. Keeping only these numbers (rather
 * than every sample) bounds the memory a long-running dashboard occupies.
 * @param {object} sample - a derived sample.
 * @returns {object} one history point.
 */
export function historyPoint(sample) {
  const gpus = sample.gpus ?? []
  return {
    t: sample.sampledAt,
    cpu: sample.cpu?.percent ?? null,
    mem: sample.mem?.percent ?? null,
    swap: sample.mem?.swapPercent ?? null,
    netRx: sample.net?.reduce((sum, nic) => sum + (nic.rxBps ?? 0), 0) ?? 0,
    netTx: sample.net?.reduce((sum, nic) => sum + (nic.txBps ?? 0), 0) ?? 0,
    disk: sample.disks?.reduce((max, mount) => Math.max(max, mount.usePercent ?? 0), 0) ?? null,
    gpu: gpus.length > 0 ? Math.max(...gpus.map(gpu => gpu.utilPercent ?? 0)) : null,
    gpuMem: gpus.length > 0 ? Math.max(...gpus.map(gpu => gpu.memPercent ?? 0)) : null,
    temp: gpus.length > 0 ? Math.max(...gpus.map(gpu => gpu.tempC ?? 0)) : null,
    freeGpu: sample.capacity?.gpuFree ?? null,
    score: sample.capacity?.score ?? null,
    index: sample.idleIndex?.index ?? null,
    alerts: (sample.alerts ?? []).length,
  }
}

/**
 * Normalize the sampler tuning out of a plugin config.
 * @param {object} config - resolved plugin config.
 * @returns {object} clamped tuning values.
 */
export function tuningFrom(config = {}) {
  return {
    intervalMs: clampInt(config.intervalMs, 2000, 600_000, DEFAULT_INTERVAL_MS),
    concurrency: clampInt(config.concurrency, 1, 32, DEFAULT_CONCURRENCY),
    historyLimit: clampInt(config.historyLimit, 20, 5000, DEFAULT_HISTORY_LIMIT),
    cacheTtlMs: clampInt(config.cacheTtlMs, 0, 300_000, DEFAULT_CACHE_TTL_MS),
    rateProbeDelayMs: clampInt(config.rateProbeDelayMs, 200, 10_000, DEFAULT_RATE_PROBE_DELAY_MS),
    idleStopMs: clampInt(config.idleStopMs, 5000, 3_600_000, DEFAULT_IDLE_STOP_MS),
    alwaysOn: config.alwaysOn === true,
    topN: clampInt(config.topN, 1, 50, 8),
    execTimeoutMs: clampInt(config.timeoutMs, 2000, 300_000, 30_000),
    includeLoopbackNet: config.includeLoopbackNet === true,
    netInterfaces: toStringArray(config.netInterfaces),
    diskDevices: toStringArray(config.diskDevices),
    capacity: normalizeCapacity(config.capacity),
    idleIndex: normalizeIdleIndex(config.idleIndex),
    lowUsage: normalizeLowUsage(config.lowUsage),
    footer: normalizeFooterConfig(config.footer),
  }
}

/**
 * The sampler.
 */
export class Monitor {
  /**
   * @param {object} options - wiring.
   * @param {import('./store.js').HostBook} options.book - the host book.
   * @param {import('./pool.js').SshPool} options.pool - the SSH pool.
   * @param {object} [options.config] - resolved plugin config.
   */
  constructor({ book, pool, config = {} }) {
    this.book = book
    this.pool = pool
    this.applyTuning(config)

    /** @type {Map<string, object>} alias -> per-host state */
    this.states = new Map()
    /** @type {Set<(event: object) => void>} */
    this.listeners = new Set()
    /** @type {Array<{ alias: string, at: number, alerts: Array<object> }>} */
    this.recentAlerts = []
    this.timer = undefined
    this.watchTimer = setInterval(() => {
      if (this.disposed) return
      if (this.sourceWatch?.() === true && (this.listeners.size > 0 || this.alwaysOn)) this.ensureTimer()
    }, 15_000)
    // A stat check every 15 s must not keep the host process alive on its own.
    this.watchTimer.unref?.()
    this.ticking = false
    this.lastDemandAt = Date.now()
    this.lastTickAt = null
    this.tickCount = 0
    this.disposed = false
  }

  /**
   * Install (or reinstall) the tuning fields and rebuild the probe commands.
   * @param {object} config - resolved plugin config.
   */
  applyTuning(config) {
    Object.assign(this, tuningFrom(config))
    this.capacityOptions = normalizeCapacity(this.capacity)
    this.idleIndexOptions = normalizeIdleIndex(this.idleIndex)
    this.lowUsageOptions = normalizeLowUsage(this.lowUsage)
    this.footer = normalizeFooterConfig(this.footer)
    this.fullCommand = encodeProbeCommand(buildProbeScript({ topN: this.topN }))
    this.lightCommand = encodeProbeCommand(buildProbeScript({ topN: this.topN, light: true }))
  }

  /**
   * Apply a settings change without losing the collected history.
   * @param {object} config - resolved plugin config.
   */
  reconfigure(config) {
    const wasRunning = this.running
    this.stopTimer()
    this.applyTuning(config)
    this.lastDemandAt = Date.now()
    if (wasRunning || this.listeners.size > 0) this.ensureTimer()
  }

  /** Read the tuned options back out, as the plugin Config shape. */
  get options() {
    return {
      intervalMs: this.intervalMs,
      concurrency: this.concurrency,
      historyLimit: this.historyLimit,
      cacheTtlMs: this.cacheTtlMs,
      rateProbeDelayMs: this.rateProbeDelayMs,
      idleStopMs: this.idleStopMs,
      alwaysOn: this.alwaysOn,
      topN: this.topN,
      timeoutMs: this.execTimeoutMs,
      includeLoopbackNet: this.includeLoopbackNet,
      netInterfaces: [...this.netInterfaces],
      diskDevices: [...this.diskDevices],
      capacity: { ...this.capacity },
    }
  }

  /**
   * Per-host state, created on first use.
   * @param {object} entry - a host-book entry.
   * @returns {object} the mutable state.
   */
  stateFor(entry) {
    let state = this.states.get(entry.alias)
    if (state === undefined) {
      state = {
        alias: entry.alias,
        entry,
        lastFull: null,
        lastFullAt: null,
        lastCounters: null,
        lastCountersAt: null,
        lastSample: null,
        error: null,
        failures: 0,
        samples: 0,
        idleSince: null,
        lowSince: null,
        lowUsage: null,
        latencyMs: null,
        inFlight: undefined,
        nextAttemptAt: 0,
        history: [],
        alerts: [],
        recentAlerts: [],
      }
      this.states.set(entry.alias, state)
    }
    state.entry = entry
    return state
  }

  /** Add a subscriber; while one exists the poll timer runs. */
  subscribe(listener) {
    this.listeners.add(listener)
    this.demand()
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Record demand for data and make sure the timer is running. */
  demand() {
    this.lastDemandAt = Date.now()
    this.ensureTimer()
  }

  /** Start the poll timer when there is something to poll for. */
  ensureTimer() {
    if (this.disposed) return
    if (this.timer !== undefined) return
    if (this.book.monitored().length === 0) return
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    this.timer.unref?.()
    // Sample immediately so the first paint is not one interval late.
    void this.tick()
  }

  /** Stop the poll timer. */
  stopTimer() {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** Whether the sampler is currently polling. */
  get running() {
    return this.timer !== undefined
  }

  /** Stop the timer once nothing has wanted data for the idle window. */
  maybeIdleStop() {
    if (this.alwaysOn || this.listeners.size > 0) return
    if (Date.now() - this.lastDemandAt < this.idleStopMs) return
    this.stopTimer()
  }

  /** Drop state for hosts that no longer exist. */
  prune() {
    const alive = new Set(this.book.list().map(host => host.alias))
    for (const alias of [...this.states.keys()]) {
      if (!alive.has(alias)) this.states.delete(alias)
    }
  }

  /** Poll every monitored host once, with bounded concurrency. */
  async tick() {
    if (this.disposed || this.ticking) return
    this.ticking = true
    try {
      const hosts = this.book.monitored()
      this.prune()
      if (hosts.length === 0) {
        this.maybeIdleStop()
        return
      }
      const samples = await mapLimit(hosts, this.concurrency, host => this.sampleHost(host, { force: true, respectBackoff: true }))
      this.tickCount += 1
      this.lastTickAt = Date.now()
      this.publish({ type: 'samples', samples, at: this.lastTickAt })
    } finally {
      this.ticking = false
      this.maybeIdleStop()
    }
  }

  /**
   * Read one host and fold the result into its state.
   * @param {object} entry - a host-book entry.
   * @param {{ force?: boolean, respectBackoff?: boolean }} [options] - `force`
   *   skips the cache window; `respectBackoff` honours a failing host's delay.
   * @returns {Promise<object>} the host payload sent to the UI.
   */
  async sampleHost(entry, options = {}) {
    const state = this.stateFor(entry)
    if (state.inFlight !== undefined) return state.inFlight
    if (options.respectBackoff === true && state.nextAttemptAt > Date.now()) {
      return this.payload(entry, state)
    }
    if (options.force !== true && state.lastSample !== null && Date.now() - state.lastSample.sampledAt < this.cacheTtlMs) {
      return this.payload(entry, state)
    }
    const promise = this.read(entry, state).finally(() => { state.inFlight = undefined })
    state.inFlight = promise
    return promise
  }

  /**
   * The actual two-step read of one host.
   * @param {object} entry - a host-book entry.
   * @param {object} state - its state.
   * @returns {Promise<object>} the host payload.
   */
  async read(entry, state) {
    const started = Date.now()
    const full = await this.pool.exec(entry, this.fullCommand, { timeoutMs: this.execTimeoutMs })
    if (!full.ok) {
      state.failures += 1
      state.error = full.error ?? (full.timedOut ? 'probe timed out' : 'probe failed')
      state.latencyMs = null
      state.idleSince = null
      state.lowSince = null
      state.lowUsage = null
      state.nextAttemptAt = Date.now() + failureBackoffMs(state.failures)
      const payload = this.payload(entry, state, { ok: false, error: state.error })
      this.publish({ type: 'sample', sample: payload })
      return payload
    }

    const fullAt = Date.now()
    const rawFull = parseProbe(full.stdout)
    let prev = state.lastCounters
    let prevAt = state.lastCountersAt
    let curr = rawFull
    let currAt = fullAt

    if (prev === null) {
      // Cold start: the full probe is only a baseline, so take one cheap
      // counter read a moment later and report real rates straight away.
      await sleep(this.rateProbeDelayMs)
      const light = await this.pool.exec(entry, this.lightCommand, { timeoutMs: this.execTimeoutMs })
      if (light.ok) {
        prev = rawFull
        prevAt = fullAt
        curr = parseProbe(light.stdout)
        currAt = Date.now()
      }
    }

    const dtMs = prev !== null && prevAt !== null ? Math.max(1, currAt - prevAt) : 0
    const sample = deriveSample({
      prev, curr, full: rawFull, dtMs,
      options: {
        includeLoopbackNet: this.includeLoopbackNet,
        netInterfaces: this.netInterfaces,
        diskDevices: this.diskDevices,
        topN: this.topN,
      },
    })

    sample.capacity = evaluateCapacity(sample, this.capacityOptions)
    // A long gap between two samples (dashboard closed, sampler paused) means
    // the last hour was NOT observed. Restart both clocks rather than claim a
    // duration nothing watched.
    const previousSampledAt = state.lastSample?.sampledAt ?? null
    const gapMs = previousSampledAt === null ? 0 : sample.sampledAt - previousSampledAt
    const stale = gapMs > Math.max(30_000, this.intervalMs * 3)

    // Track sustained idleness: a host that was free for less than one poll
    // interval is a snapshot, not spare capacity someone can plan around.
    if (sample.capacity.schedulable) {
      if (state.idleSince === null || stale) state.idleSince = sample.sampledAt
    } else {
      state.idleSince = null
    }

    // Idle index: how idle the host is RIGHT NOW, blending run-length with how
    // little the GPU is doing. Computed after the clock update so a fresh
    // sample from a just-freed host does not jump to a high score.
    const idleSec = state.idleSince === null ? 0 : Math.max(0, Math.round((sample.sampledAt - state.idleSince) / 1000))
    sample.idleIndex = evaluateIdleIndex(sample, idleSec, this.idleIndexOptions)

    state.lastFull = rawFull
    state.lastFullAt = fullAt
    state.lastCounters = curr
    state.lastCountersAt = currAt
    state.lastSample = sample
    state.latencyMs = Date.now() - started
    state.error = null
    state.failures = 0
    state.nextAttemptAt = 0
    state.samples += 1

    const thresholds = this.book.thresholds()
    sample.alerts = evaluateAlerts(sample, thresholds)

    // Low-utilisation warning: a separate clock from the idle-capacity one,
    // because a host can be "low usage" (wasted) without being schedulable
    // (a full disk) and vice versa.
    const lowSettings = typeof this.book.lowUsage === 'function' ? this.book.lowUsage() : this.lowUsageOptions
    const usage = evaluateLowUsage(sample, lowSettings)
    state.lowUsage = usage
    if (usage.low) {
      if (state.lowSince === null || stale) state.lowSince = sample.sampledAt
    } else {
      state.lowSince = null
    }
    const lowForSec = state.lowSince === null ? 0 : Math.max(0, Math.round((sample.sampledAt - state.lowSince) / 1000))
    const lowWindow = Number.isFinite(Number(lowSettings?.forSec)) ? Number(lowSettings.forSec) : this.lowUsageOptions.forSec
    if (usage.enabled && usage.low && lowForSec >= lowWindow) {
      sample.alerts = [...sample.alerts, lowUsageAlert(usage, lowForSec)]
    }

    state.alerts = sample.alerts
    if (sample.alerts.length > 0) {
      const at = Date.now()
      state.recentAlerts = [...state.recentAlerts, { at, alerts: sample.alerts }].slice(-RECENT_ALERT_LIMIT)
      this.recentAlerts = [...this.recentAlerts, { alias: entry.alias, at, alerts: sample.alerts }].slice(-RECENT_ALERT_LIMIT * 2)
    }

    const point = historyPoint(sample)
    state.history = [...state.history, point].slice(-this.historyLimit)

    const payload = this.payload(entry, state, { ok: true })
    this.publish({ type: 'sample', sample: payload })
    return payload
  }

  /**
   * Project one host's state into the wire payload.
   * @param {object} entry - a host-book entry.
   * @param {object} state - its state.
   * @param {{ ok?: boolean, error?: string }} [outcome] - an explicit outcome override.
   * @returns {object} the payload.
   */
  payload(entry, state, outcome) {
    const connection = this.pool.status(entry)
    const sample = state.lastSample
    // Never-sampled and failing are different states: an installed-but-unread
    // host must not be reported as healthy just because nothing has gone wrong
    // yet, which is exactly what a bare `error === null` test would say.
    const sampled = sample !== null
    const status = state.error !== null ? 'down' : sampled ? 'ok' : 'unknown'
    return {
      alias: entry.alias,
      label: entry.displayName ?? entry.alias,
      host: entry.host,
      port: entry.port,
      user: entry.user,
      source: entry.source,
      tags: entry.tags ?? [],
      environment: entry.environment ?? null,
      monitor: entry.monitor !== false,
      status,
      ok: outcome?.ok ?? (status === 'ok'),
      error: outcome?.error ?? state.error,
      latencyMs: state.latencyMs,
      samples: state.samples,
      failures: state.failures,
      nextAttemptAt: state.nextAttemptAt > Date.now() ? state.nextAttemptAt : null,
      connection: { connected: connection.connected, since: connection.since, attempts: connection.attempts },
      lastSampleAt: sample?.sampledAt ?? null,
      system: sample?.system ?? null,
      cpu: sample?.cpu ?? null,
      mem: sample?.mem ?? null,
      disks: sample?.disks ?? [],
      diskIo: sample?.diskIo ?? [],
      net: sample?.net ?? [],
      gpus: sample?.gpus ?? [],
      topCpu: sample?.topCpu ?? [],
      topMem: sample?.topMem ?? [],
      capacity: sample?.capacity ?? null,
      idleIndex: sample?.idleIndex ?? null,
      lowUsage: sample === null
        ? null
        : {
            low: state.lowUsage?.low === true,
            enabled: state.lowUsage?.enabled !== false,
            forSec: state.lowSince === null ? 0 : Math.max(0, Math.round((Date.now() - state.lowSince) / 1000)),
            reason: state.lowUsage?.reason ?? null,
          },
      idleForSec: state.idleSince !== null ? Math.max(0, Math.round((Date.now() - state.idleSince) / 1000)) : 0,
      alerts: state.alerts,
      ratesReady: sample?.ratesReady ?? false,
    }
  }

  /** Send one event to every subscriber, isolating subscriber failures. */
  publish(event) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // A broken SSE writer must not stop the sampler.
        this.listeners.delete(listener)
      }
    }
  }

  /** All monitored hosts, current payloads. */
  all() {
    this.prune()
    return this.book.monitored().map(entry => this.payload(entry, this.stateFor(entry)))
  }

  /** One host's current payload. */
  get(alias) {
    const entry = this.book.find(alias)
    if (entry === undefined) return undefined
    return this.payload(entry, this.stateFor(entry))
  }

  /**
   * Read one host on demand — how an agent tool gets a number it can trust.
   * @param {string} alias - the alias to read.
   * @param {{ fresh?: boolean }} [options] - `fresh` bypasses the cache window.
   * @returns {Promise<object|undefined>} the payload, or undefined for an unknown alias.
   */
  async readNow(alias, options = {}) {
    const entry = this.book.find(alias)
    if (entry === undefined) return undefined
    this.demand()
    return this.sampleHost(entry, { force: options.fresh === true })
  }

  /**
   * Read every monitored host on demand.
   * @param {{ fresh?: boolean, aliases?: string[] }} [options] - an optional alias subset.
   * @returns {Promise<Array<object>>} payloads.
   */
  async readAllNow(options = {}) {
    const entries = options.aliases !== undefined && options.aliases.length > 0
      ? options.aliases.map(alias => this.book.find(alias)).filter(entry => entry !== undefined)
      : this.book.monitored()
    this.demand()
    return mapLimit(entries, this.concurrency, entry => this.sampleHost(entry, { force: options.fresh === true }))
  }

  /**
   * One host's chart history.
   * @param {string} alias - the alias.
   * @param {number} [limit] - how many points back to return.
   * @returns {Array<object>} history points, oldest first.
   */
  history(alias, limit) {
    const state = this.states.get(alias)
    if (state === undefined) return []
    const count = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : state.history.length
    return state.history.slice(-count)
  }

  /** Recent threshold breaches across all hosts, newest first. */
  alerts(limit = 20) {
    return [...this.recentAlerts].reverse().slice(0, Math.max(1, limit))
  }

  /** Runtime facts for the panel footer. */
  info() {
    return {
      running: this.running,
      intervalMs: this.intervalMs,
      subscribers: this.listeners.size,
      lastTickAt: this.lastTickAt,
      tickCount: this.tickCount,
      alwaysOn: this.alwaysOn,
      topN: this.topN,
      footer: { ...this.footer },
      version: this.packageVersion ?? null,
    }
  }

  /** Stop polling and release every connection. */
  dispose() {
    this.disposed = true
    this.stopTimer()
    clearInterval(this.watchTimer)
    this.listeners.clear()
    this.pool.dispose()
  }
}

/** Normalize the sidebar footer indicator settings. */
function normalizeFooterConfig(config = {}) {
  const pollSec = Number(config?.pollSec)
  return {
    enabled: config?.enabled !== false,
    live: config?.live !== false,
    pollSec: Number.isFinite(pollSec) ? Math.min(3600, Math.max(30, Math.round(pollSec))) : 60,
  }
}

/** Clamp a config number into an integer range with a default. */
function clampInt(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/** Normalize a comma-separated string or a string array into a string array. */
export function toStringArray(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(item => item !== '')
  if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(item => item !== '')
  return []
}
