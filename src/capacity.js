/**
 * Idle-capacity model — "which machine can take the next job?".
 *
 * Thresholds answer "is something wrong"; they do not answer "where is there
 * room". This module turns one sample into a scheduling-oriented view of a
 * host: a 0..100 headroom score, the number of entirely idle GPUs, the CPU
 * cores and memory bytes still free, and the concrete blockers (a full disk, a
 * saturated GPU, exhausted memory) that make a host unusable no matter how
 * idle its CPU looks.
 *
 * Pure functions only: the sampler attaches the result to every sample and the
 * UI, the tools and the tests all read the same numbers.
 *
 * @module dsh-remote-monitor/capacity
 */

/** Defaults for the headroom model. All percentages are "still free". */
export const DEFAULT_CAPACITY = Object.freeze({
  /** CPU utilisation at or below `100 - cpuFreeMin` counts as headroom. */
  cpuFreeMin: 60,
  /** Memory at or below `100 - memFreeMin` counts as headroom. */
  memFreeMin: 50,
  /** A GPU with utilisation at or below this is a candidate for `idle`. */
  gpuUtilMax: 10,
  /** A GPU with VRAM usage at or below this is a candidate for `idle`. */
  gpuMemMax: 10,
  /** A GPU at or above this utilisation is `busy`. */
  gpuBusyUtil: 85,
  /** VRAM at or above this percentage is `busy`. */
  gpuBusyMem: 80,
  /** Score at or above which a host counts as `free`. */
  freeScore: 60,
  /** Score at or above which a host counts as `partial`. */
  partialScore: 30,
  /** A mount at or above this usage blocks scheduling. */
  blockDiskPercent: 90,
  /** Memory at or above this usage blocks scheduling. */
  blockMemPercent: 90,
  /** Load per core at or above this blocks scheduling (a queue, not headroom). */
  blockLoadPerCore: 8,
})

/**
 * Defaults for the low-utilisation warning: "this machine has been sitting
 * idle long enough to be worth noticing". A card that holds VRAM is NOT idle —
 * an inference server at 0 % utilisation is doing its job.
 */
export const DEFAULT_LOW_USAGE = Object.freeze({
  /** Master switch for the low-utilisation alert. */
  enabled: true,
  /** CPU utilisation at or below this counts as unused (CPU-only hosts). */
  cpuBelow: 15,
  /** Mean GPU utilisation at or below this counts as unused (GPU hosts). */
  gpuBelow: 10,
  /** How long the host must stay under-used before the alert fires. */
  forSec: 600,
})

/**
 * Clamp a config number into a range.
 * @param {unknown} value - the raw value.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @param {number} fallback - used when the value is not a finite number.
 * @returns {number} the clamped number.
 */
function clampNumber(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/**
 * Normalize the capacity config (plugin settings or tool options).
 * @param {object} [config] - raw capacity options.
 * @returns {object} resolved options.
 */
export function normalizeCapacity(config = {}) {
  const raw = config ?? {}
  const gpuUtilMax = clampNumber(raw.gpuUtilMax, 0, 100, DEFAULT_CAPACITY.gpuUtilMax)
  const gpuMemMax = clampNumber(raw.gpuMemMax, 0, 100, DEFAULT_CAPACITY.gpuMemMax)
  return {
    cpuFreeMin: clampNumber(raw.cpuFreeMin, 0, 100, DEFAULT_CAPACITY.cpuFreeMin),
    memFreeMin: clampNumber(raw.memFreeMin, 0, 100, DEFAULT_CAPACITY.memFreeMin),
    gpuUtilMax,
    gpuMemMax,
    gpuBusyUtil: clampNumber(raw.gpuBusyUtil, 0, 100, DEFAULT_CAPACITY.gpuBusyUtil),
    gpuBusyMem: clampNumber(raw.gpuBusyMem, 0, 100, DEFAULT_CAPACITY.gpuBusyMem),
    freeScore: clampNumber(raw.freeScore, 0, 100, DEFAULT_CAPACITY.freeScore),
    partialScore: clampNumber(raw.partialScore, 0, 100, DEFAULT_CAPACITY.partialScore),
    blockDiskPercent: clampNumber(raw.blockDiskPercent, 1, 100, DEFAULT_CAPACITY.blockDiskPercent),
    blockMemPercent: clampNumber(raw.blockMemPercent, 1, 100, DEFAULT_CAPACITY.blockMemPercent),
    blockLoadPerCore: clampNumber(raw.blockLoadPerCore, 1, 1000, DEFAULT_CAPACITY.blockLoadPerCore),
  }
}

/** Coerce to a finite number or null. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Round to one decimal place. */
function round1(value) {
  return Math.round(value * 10) / 10
}

/** Clamp to 0..100. */
function clampPercent(value) {
  return Math.max(0, Math.min(100, value))
}

/** Whether a GPU row is entirely idle. */
function gpuIdle(gpu, options) {
  const util = num(gpu.utilPercent)
  const mem = num(gpu.memPercent)
  const processes = Array.isArray(gpu.processes) ? gpu.processes.length : 0
  return util !== null && util <= options.gpuUtilMax
    && mem !== null && mem <= options.gpuMemMax
    && processes === 0
}

/** Whether a GPU row is saturated. */
function gpuBusy(gpu, options) {
  const util = num(gpu.utilPercent)
  const mem = num(gpu.memPercent)
  return (util !== null && util >= options.gpuBusyUtil) || (mem !== null && mem >= options.gpuBusyMem)
}

/**
 * How much of one GPU is still available, 0..100.
 *
 * The smaller of utilisation headroom and VRAM headroom, capped hard when a
 * process holds the device: a job that allocates VRAM and then idles at 0 %
 * utilisation is not a free GPU, it is a GPU that is about to come back.
 */
function gpuHeadroom(gpu) {
  const util = num(gpu.utilPercent)
  const mem = num(gpu.memPercent)
  const processes = Array.isArray(gpu.processes) ? gpu.processes.length : 0
  if (util === null && mem === null) return null
  const utilFree = util === null ? 100 : 100 - util
  const memFree = mem === null ? 100 : 100 - mem
  let head = Math.max(0, Math.min(utilFree, memFree))
  if (processes > 0 && head > 20) head = 20
  return head
}

/**
 * Defaults for the idle index: one number that answers "how idle is this
 * machine right now", blending HOW LONG it has been idle with HOW LITTLE the
 * GPU is doing. Fifty/fifty by default; a machine that just went idle at 0 %
 * utilisation scores 50, the same machine after one idle half-life scores 75,
 * and a heavily loaded one stays low no matter how long it has been up.
 */
export const DEFAULT_IDLE_INDEX = Object.freeze({
  /** Idle seconds at which the time component reaches 50 (then 75, 87.5…). */
  halfLifeSec: 1800,
  /** Weight of the utilisation component. */
  utilWeight: 0.5,
  /** Weight of the elapsed-idle-time component. */
  timeWeight: 0.5,
})

/**
 * Normalize the idle-index config.
 * @param {object} [config] - raw options.
 * @returns {object} resolved options.
 */
export function normalizeIdleIndex(config = {}) {
  const raw = config ?? {}
  const utilWeight = clampNumber(raw.utilWeight, 0, 1, DEFAULT_IDLE_INDEX.utilWeight)
  const timeWeight = clampNumber(raw.timeWeight, 0, 1, DEFAULT_IDLE_INDEX.timeWeight)
  return {
    halfLifeSec: Math.round(clampNumber(raw.halfLifeSec, 60, 86_400, DEFAULT_IDLE_INDEX.halfLifeSec)),
    utilWeight,
    timeWeight,
  }
}

/**
 * The idle index for one host.
 *
 * `index = w_u * (100 - utilisation) + w_t * timeScore`, where the time score
 * saturates: 1 - 2^(-idle / halfLife). On a GPU host utilisation is the mean
 * across the cards; on a CPU-only host it is the CPU percentage. Time comes
 * from the sampler's sustained-idle clock (`idleForSec`), so a machine that
 * just finished a job does not immediately look like a spare one.
 *
 * @param {object|null} sample - a derived sample.
 * @param {number} idleForSec - how long the host has been continuously idle.
 * @param {object} [options] - idle-index options (see `DEFAULT_IDLE_INDEX`).
 * @returns {{ index: number|null, utilIdle: number|null, timeScore: number|null, utilPercent: number|null, basis: string|null, idleForSec: number }}
 */
export function evaluateIdleIndex(sample, idleForSec, options = {}) {
  const config = normalizeIdleIndex(options)
  const empty = {
    index: null,
    utilIdle: null,
    timeScore: null,
    utilPercent: null,
    basis: null,
    idleForSec: 0,
  }
  if (sample === null || sample === undefined) return empty

  const gpus = Array.isArray(sample.gpus) ? sample.gpus : []
  const utils = gpus.map(gpu => num(gpu.utilPercent)).filter(value => value !== null)
  const gpuAvg = utils.length === 0 ? null : utils.reduce((sum, value) => sum + value, 0) / utils.length
  const cpuPercent = num(sample.cpu?.percent)
  const utilPercent = gpus.length > 0 ? gpuAvg : cpuPercent
  if (utilPercent === null) return empty

  const utilIdle = clampPercent(100 - utilPercent)
  const seconds = Math.max(0, Number(idleForSec) || 0)
  const timeScore = clampPercent(100 * (1 - 2 ** (-seconds / config.halfLifeSec)))
  const weight = config.utilWeight + config.timeWeight
  if (weight <= 0) return { ...empty, utilIdle: round1(utilIdle), timeScore: round1(timeScore), utilPercent: round1(utilPercent), basis: gpus.length > 0 ? 'gpu' : 'cpu', idleForSec: seconds }

  const index = Math.round((config.utilWeight * utilIdle + config.timeWeight * timeScore) / weight)
  return {
    index: Math.max(0, Math.min(100, index)),
    utilIdle: round1(utilIdle),
    timeScore: round1(timeScore),
    utilPercent: round1(utilPercent),
    basis: gpus.length > 0 ? 'gpu' : 'cpu',
    idleForSec: seconds,
  }
}

/**
 * Normalize the low-utilisation config.
 * @param {object} [config] - raw options.
 * @returns {object} resolved options.
 */
export function normalizeLowUsage(config = {}) {
  const raw = config ?? {}
  return {
    enabled: raw.enabled !== false,
    cpuBelow: clampNumber(raw.cpuBelow, 0, 100, DEFAULT_LOW_USAGE.cpuBelow),
    gpuBelow: clampNumber(raw.gpuBelow, 0, 100, DEFAULT_LOW_USAGE.gpuBelow),
    // A minute is the floor: a shorter window would fire on the normal gap
    // between two training jobs and turn into noise.
    forSec: Math.round(clampNumber(raw.forSec, 60, 86_400, DEFAULT_LOW_USAGE.forSec)),
  }
}

/**
 * Is this host under-used right now?
 *
 * "Under-used" is deliberately narrower than "has spare capacity":
 *   - a GPU host is under-used only when its cards are genuinely idle — low
 *     mean utilisation AND no card holding VRAM or a compute process;
 *   - a CPU-only host is under-used when CPU utilisation is low and there is no
 *     queue (`load/core < 1.5`), so a 10 %-CPU host stuck in D-state IO wait is
 *     not reported as wasted capacity.
 *
 * Duration is not handled here: the sampler owns the clock (see `lowSince`).
 *
 * @param {object|null} sample - a derived sample.
 * @param {object} [options] - low-usage options (see `DEFAULT_LOW_USAGE`).
 * @returns {{ enabled: boolean, low: boolean, reason: string|null, cpuPercent: number|null, loadPerCore: number|null, gpuTotal: number, gpuAvgUtil: number|null, pinned: boolean }}
 */
export function evaluateLowUsage(sample, options = {}) {
  const config = normalizeLowUsage(options)
  const result = {
    enabled: config.enabled,
    low: false,
    reason: null,
    cpuPercent: null,
    loadPerCore: null,
    gpuTotal: 0,
    gpuAvgUtil: null,
    pinned: false,
    below: null,
  }
  if (!config.enabled || sample === null || sample === undefined) return result

  const cpu = sample.cpu ?? {}
  const gpus = Array.isArray(sample.gpus) ? sample.gpus : []
  const cpuPercent = num(cpu.percent)
  const nproc = num(cpu.nproc)
  const load1 = Array.isArray(cpu.load) ? num(cpu.load[0]) : null
  const loadPerCore = load1 !== null && nproc !== null && nproc > 0 ? load1 / nproc : null
  const utils = gpus.map(gpu => num(gpu.utilPercent)).filter(value => value !== null)
  const gpuAvgUtil = utils.length === 0 ? null : round1(utils.reduce((sum, value) => sum + value, 0) / utils.length)

  // A device holding memory or running a process is in use even at 0 % util.
  const pinned = gpus.some(gpu => {
    const mem = num(gpu.memPercent)
    const processes = Array.isArray(gpu.processes) ? gpu.processes.length : 0
    return (mem !== null && mem >= 20) || processes > 0
  })

  result.cpuPercent = cpuPercent
  result.loadPerCore = loadPerCore === null ? null : Math.round(loadPerCore * 100) / 100
  result.gpuTotal = gpus.length
  result.gpuAvgUtil = gpuAvgUtil
  result.pinned = pinned

  if (gpus.length > 0) {
    result.below = config.gpuBelow
    if (gpuAvgUtil !== null && gpuAvgUtil <= config.gpuBelow && !pinned) {
      result.low = true
      result.reason = `GPU avg ${gpuAvgUtil}% ≤ ${config.gpuBelow}%`
    }
    return result
  }

  result.below = config.cpuBelow
  const queued = loadPerCore !== null && loadPerCore >= 1.5
  if (cpuPercent !== null && cpuPercent <= config.cpuBelow && !queued) {
    result.low = true
    result.reason = `CPU ${cpuPercent}% ≤ ${config.cpuBelow}%`
  }
  return result
}

/**
 * The alert object for a sustained low-utilisation period.
 * @param {object} usage - an `evaluateLowUsage` result.
 * @param {number} forSec - how long the condition has held.
 * @returns {object} an alert in the same shape as `evaluateAlerts`.
 */
export function lowUsageAlert(usage, forSec) {
  const minutes = Math.max(1, Math.round(forSec / 60))
  const detail = usage.gpuTotal > 0
    ? `GPU avg ${usage.gpuAvgUtil ?? 'n/a'}% · ${usage.gpuTotal} card${usage.gpuTotal === 1 ? '' : 's'}`
    : `CPU ${usage.cpuPercent ?? 'n/a'}%`
  return {
    key: 'low-usage',
    level: 'warn',
    metric: 'usage',
    target: 'host',
    kind: usage.gpuTotal > 0 ? 'gpu' : 'cpu',
    value: usage.gpuTotal > 0 ? usage.gpuAvgUtil : usage.cpuPercent,
    threshold: usage.below,
    message: `low usage: ${detail} · idle for ${minutes}m`,
    forSec,
  }
}

/**
 * Evaluate one sample's spare capacity.
 *
 * @param {object|null} sample - a derived sample from probe.js (cpu/mem/disks/gpus).
 * @param {object} [options] - capacity options (see `DEFAULT_CAPACITY`).
 * @returns {object} the capacity view; callers treat it as read-only.
 */
export function evaluateCapacity(sample, options = {}) {
  const config = normalizeCapacity(options)
  const empty = {
    state: 'unknown',
    score: null,
    cpuFreePercent: null,
    memFreePercent: null,
    loadPerCore: null,
    freeCpuCores: null,
    freeMemBytes: null,
    gpuTotal: 0,
    gpuFree: 0,
    gpuBusy: 0,
    gpuFreePercent: null,
    freeGpuIndexes: [],
    blockers: [],
    schedulable: false,
    diskFreePercent: null,
  }
  if (sample === null || sample === undefined) return empty

  const cpu = sample.cpu ?? {}
  const mem = sample.mem ?? {}
  const gpus = Array.isArray(sample.gpus) ? sample.gpus : []
  const disks = Array.isArray(sample.disks) ? sample.disks : []

  const cpuPercent = num(cpu.percent)
  const nproc = num(cpu.nproc)
  const load1 = Array.isArray(cpu.load) ? num(cpu.load[0]) : null
  const loadPerCore = load1 !== null && nproc !== null && nproc > 0 ? load1 / nproc : null
  const memPercent = num(mem.percent)

  // CPU headroom: the remaining percentage, reduced by queue pressure. A host
  // that reports 30 % CPU but a load of 15 per core is not "70 % free".
  const cpuFreePercent = cpuPercent !== null
    ? round1(clampPercent(100 - cpuPercent))
    : loadPerCore !== null ? round1(clampPercent(100 - loadPerCore * 100)) : null
  const loadPenalty = loadPerCore !== null && loadPerCore > 1
    ? Math.min(90, 20 * (loadPerCore - 1))
    : 0
  const cpuScore = cpuFreePercent === null ? null : clampPercent(cpuFreePercent - loadPenalty)

  const memFreePercent = memPercent === null ? null : round1(clampPercent(100 - memPercent))
  const memScore = memFreePercent

  let gpuTotal = 0
  let gpuFree = 0
  let gpuBusyCount = 0
  const freeGpuIndexes = []
  const headrooms = []
  for (const gpu of gpus) {
    gpuTotal += 1
    const headroom = gpuHeadroom(gpu)
    if (headroom !== null) headrooms.push(headroom)
    if (gpuIdle(gpu, config)) {
      gpuFree += 1
      if (typeof gpu.index === 'number') freeGpuIndexes.push(gpu.index)
      else freeGpuIndexes.push(gpuTotal - 1)
    }
    if (gpuBusy(gpu, config)) gpuBusyCount += 1
  }
  const gpuScore = headrooms.length === 0 ? null : headrooms.reduce((sum, value) => sum + value, 0) / headrooms.length

  // Weight the scarce resource: on a GPU host the card decides placement, on a
  // CPU-only host cores and memory do.
  const weights = gpuTotal > 0
    ? { cpu: 0.32, mem: 0.18, gpu: 0.5 }
    : { cpu: 0.62, mem: 0.38 }
  const parts = [
    { score: cpuScore, weight: weights.cpu },
    { score: memScore, weight: weights.mem },
    { score: gpuScore, weight: weights.gpu },
  ].filter(part => part.score !== null)
  const weightSum = parts.reduce((sum, part) => sum + part.weight, 0)
  const score = parts.length === 0 || weightSum === 0
    ? null
    : Math.round(parts.reduce((sum, part) => sum + part.score * part.weight, 0) / weightSum)

  const blockers = []
  for (const mount of disks) {
    const usePercent = num(mount.usePercent)
    if (usePercent !== null && usePercent >= config.blockDiskPercent) {
      blockers.push({ code: 'disk', value: round1(usePercent), target: mount.mount ?? null })
    }
  }
  if (memPercent !== null && memPercent >= config.blockMemPercent) {
    blockers.push({ code: 'mem', value: round1(memPercent), target: null })
  }
  if (loadPerCore !== null && loadPerCore >= config.blockLoadPerCore) {
    blockers.push({ code: 'load', value: Math.round(loadPerCore * 100) / 100, target: null })
  }
  if (gpuTotal > 0 && gpuFree === 0 && gpuBusyCount >= gpuTotal) {
    blockers.push({ code: 'gpu', value: gpuTotal, target: null })
  }

  let finalScore = score
  if (finalScore !== null && gpuTotal > 0 && gpuFree === 0) {
    // All cards are held: the host cannot take a GPU job whatever its CPU says.
    finalScore = Math.min(finalScore, 25)
  }
  if (finalScore !== null && blockers.some(blocker => blocker.code === 'load')) {
    finalScore = Math.min(finalScore, 15)
  }

  const state = finalScore === null
    ? 'unknown'
    : finalScore >= config.freeScore ? 'free' : finalScore >= config.partialScore ? 'partial' : 'busy'

  const diskFreePercent = disks.length === 0
    ? null
    : round1(clampPercent(100 - disks.reduce((max, mount) => Math.max(max, num(mount.usePercent) ?? 0), 0)))

  return {
    state,
    score: finalScore,
    cpuFreePercent,
    memFreePercent,
    loadPerCore: loadPerCore === null ? null : round1(loadPerCore * 100) / 100,
    freeCpuCores: cpuFreePercent === null || nproc === null ? null : round1((cpuFreePercent / 100) * nproc),
    freeMemBytes: memFreePercent === null
      ? null
      : num(mem.availableBytes)
        ?? (num(mem.totalBytes) === null ? null : Math.round((memFreePercent / 100) * num(mem.totalBytes))),
    gpuTotal,
    gpuFree,
    gpuBusy: gpuBusyCount,
    gpuFreePercent: gpuTotal === 0 ? null : round1((gpuFree / gpuTotal) * 100),
    freeGpuIndexes,
    blockers,
    schedulable: state === 'free' && blockers.length === 0,
    diskFreePercent,
  }
}

/**
 * Fleet-level totals across host payloads (the same objects the routes send).
 * @param {Array<object>} hosts - host payloads.
 * @returns {object} totals for the dashboard header and `rmon_idle`.
 */
export function summarizeFleet(hosts = []) {
  const summary = {
    total: 0,
    online: 0,
    offline: 0,
    idle: 0,
    partial: 0,
    busy: 0,
    unknown: 0,
    schedulable: 0,
    freeGpus: 0,
    totalGpus: 0,
    freeCores: 0,
    freeMemBytes: 0,
  }
  for (const host of hosts) {
    summary.total += 1
    if (host.status !== 'ok') {
      summary.offline += 1
      continue
    }
    summary.online += 1
    const capacity = host.capacity
    if (capacity === undefined || capacity === null) {
      summary.unknown += 1
      continue
    }
    if (capacity.state === 'free') summary.idle += 1
    else if (capacity.state === 'partial') summary.partial += 1
    else if (capacity.state === 'busy') summary.busy += 1
    else summary.unknown += 1
    if (capacity.schedulable) summary.schedulable += 1
    summary.freeGpus += capacity.gpuFree ?? 0
    summary.totalGpus += capacity.gpuTotal ?? 0
    summary.freeCores += capacity.freeCpuCores ?? 0
    summary.freeMemBytes += capacity.freeMemBytes ?? 0
  }
  summary.freeCores = Math.round(summary.freeCores)
  return summary
}

/**
 * One-line English rendering of a capacity view, for the agent tools.
 * @param {object} capacity - an `evaluateCapacity` result.
 * @param {number} [idleForSec] - how long the host has been free.
 * @returns {string} the summary line.
 */
export function describeCapacity(capacity, idleForSec = 0) {
  if (capacity === undefined || capacity === null) return 'capacity unknown'
  if (capacity.state === 'unknown') return 'capacity unknown'
  const bits = [`${capacity.state} · score ${capacity.score}`]
  if (capacity.gpuTotal > 0) {
    const free = capacity.freeGpuIndexes.length > 0 ? ` (GPU${capacity.freeGpuIndexes.join(',')})` : ''
    bits.push(`free GPU ${capacity.gpuFree}/${capacity.gpuTotal}${free}`)
  }
  if (capacity.cpuFreePercent !== null) bits.push(`CPU free ${capacity.cpuFreePercent}%`)
  if (capacity.memFreePercent !== null) bits.push(`mem free ${capacity.memFreePercent}%`)
  if (idleForSec >= 60) bits.push(`free for ${Math.floor(idleForSec / 60)}m`)
  if (capacity.blockers.length > 0) {
    bits.push('blocked by ' + capacity.blockers.map(blocker => blocker.code === 'disk'
      ? `disk ${blocker.target ?? ''} ${blocker.value}%`.replace('  ', ' ')
      : `${blocker.code} ${blocker.value}`).join(', '))
  }
  return bits.join(' · ')
}

/**
 * Rank host payloads by spare capacity: schedulable first, then score.
 * @param {Array<object>} hosts - host payloads.
 * @returns {Array<object>} a new sorted array.
 */
export function rankByCapacity(hosts = []) {
  const rank = host => {
    if (host.status !== 'ok') return -1000
    if (host.capacity === undefined || host.capacity === null) return -500
    return (host.capacity.schedulable ? 1000 : 0) + (host.capacity.score ?? 0)
  }
  return [...hosts].sort((a, b) => rank(b) - rank(a) || String(a.alias).localeCompare(String(b.alias)))
}
