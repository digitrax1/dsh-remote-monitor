/**
 * Remote probe layer — the fixed POSIX shell script, its output parser, and
 * the derivation that turns two consecutive counter reads into one sample.
 *
 * Pure module: no ssh2, no cordis, no filesystem. Everything here is
 * unit-testable against recorded probe text (see test/probe.test.js).
 *
 * Design notes:
 *  - Exactly ONE round trip per poll. CPU / network / disk-IO percentages are
 *    deltas against the previous poll of the same host, so the numbers describe
 *    the poll interval instead of a synthetic remote `sleep`.
 *  - The script content is a compile-time constant of this module. It never
 *    interpolates caller data, so an alias or a label can never reach the
 *    remote shell. (The one variable is the process-table depth, forced to an
 *    integer.)
 *  - Output is line-oriented with `@@RMON <section>` markers; each section
 *    holds the verbatim content of a kernel file or a standard tool, so a
 *    newer kernel exposing extra fields cannot break a parser that reads only
 *    the leading ones.
 *
 * @module dsh-remote-monitor/probe
 */

/** Line prefix marking one output section. */
export const MARK = '@@RMON'

/** Bytes per 512-byte sector reported by /proc/diskstats. */
const SECTOR_BYTES = 512

/** KiB as reported by /proc/meminfo and `df -k`. */
const KIB = 1024

/**
 * Pseudo filesystems and mount points excluded from the disk-usage table.
 *
 * `overlay` is deliberately NOT here: inside a container the root filesystem
 * usually IS an overlay, and its usage is exactly what the user wants to see.
 * Excluding it would leave a container reporting only its bind mounts.
 */
const PSEUDO_FILESYSTEMS = new Set([
  'tmpfs', 'devtmpfs', 'devfs', 'proc', 'sysfs', 'cgroup', 'cgroup2',
  'squashfs', 'ramfs', 'autofs', 'mqueue', 'debugfs', 'tracefs', 'securityfs',
  'pstore', 'bpf', 'configfs', 'fusectl', 'hugetlbfs', 'binfmt_misc', 'nsfs',
  'rpc_pipefs', 'selinuxfs', 'efivarfs', 'none',
])

/** Mount-point prefixes excluded from the disk-usage table. */
const PSEUDO_MOUNTS = ['/proc', '/sys', '/dev', '/run', '/snap', '/var/lib/docker/overlay2']

/** Block-device names never reported as physical disks. */
const VIRTUAL_DEVICE_RE = /^(loop|ram|fd|sr|zram|md|dm-)/

/**
 * Whether one mount row is worth reporting (a real filesystem on a real
 * device, not a kernel pseudo mount).
 * @param mount - parsed `df` row.
 * @returns true when the row belongs in the sample.
 */
function isReportableMount(mount) {
  if (mount.sizeBytes === null || mount.sizeBytes <= 0) return false
  const fs = (mount.filesystem ?? '').toLowerCase()
  if (PSEUDO_FILESYSTEMS.has(fs)) return false
  if (fs.startsWith('/dev/loop')) return false
  if (PSEUDO_MOUNTS.some(prefix => mount.mount === prefix || mount.mount.startsWith(prefix + '/'))) return false
  return true
}

/**
 * Build the remote probe script.
 * @param {{ topN?: number, light?: boolean }} [options] - `light` drops the
 *   expensive sections (df/ps/nvidia-smi) and keeps only the counters, which is
 *   what a second same-tick read needs.
 * @returns the POSIX shell script text.
 */
export function buildProbeScript(options = {}) {
  const topN = Math.max(1, Math.min(100, Math.trunc(Number(options.topN ?? 8)) || 8))
  const light = options.light === true
  const lines = [
    "RM='" + MARK + "'",
    'echo "$RM probe"',
    'cat /proc/uptime 2>/dev/null',
    'echo "$RM loadavg"',
    'cat /proc/loadavg 2>/dev/null',
    'echo "$RM nproc"',
    "nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null",
    'echo "$RM stat"',
    "grep '^cpu' /proc/stat 2>/dev/null",
    'echo "$RM meminfo"',
    'cat /proc/meminfo 2>/dev/null',
    'echo "$RM netdev"',
    'cat /proc/net/dev 2>/dev/null',
    'echo "$RM diskstats"',
    'cat /proc/diskstats 2>/dev/null',
    'echo "$RM block"',
    'ls /sys/block 2>/dev/null',
    'echo "$RM system"',
    'uname -srm 2>/dev/null',
    'hostname 2>/dev/null',
    "grep -h '^PRETTY_NAME=' /etc/os-release 2>/dev/null | head -n 1 | cut -d= -f2- | tr -d '\"'",
  ]
  if (!light) {
    lines.push(
      'echo "$RM df"',
      'df -P -k 2>/dev/null',
      'echo "$RM ps"',
      'if ps -eo pid= --sort=-pcpu >/dev/null 2>&1; then',
      `  ps -eo pid=,comm=,pcpu=,pmem=,rss=,args= --sort=-pcpu 2>/dev/null | head -n ${topN}`,
      '  echo "$RM psmem"',
      `  ps -eo pid=,comm=,pcpu=,pmem=,rss=,args= --sort=-rss 2>/dev/null | head -n ${topN}`,
      'else',
      `  ps -eo pid=,comm=,pcpu=,pmem=,rss=,args= 2>/dev/null | sort -k3 -nr 2>/dev/null | head -n ${topN}`,
      '  echo "$RM psmem"',
      `  ps -eo pid=,comm=,pcpu=,pmem=,rss=,args= 2>/dev/null | sort -k5 -nr 2>/dev/null | head -n ${topN}`,
      'fi',
      'echo "$RM gpu"',
      'nvidia-smi --query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed,clocks.sm --format=csv,noheader,nounits 2>/dev/null',
      'echo "$RM gpuapps"',
      'nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null',
    )
  }
  lines.push('echo "$RM end"', '')
  return lines.join('\n')
}

/**
 * Wrap a script for one-shot execution over SSH.
 *
 * The script travels base64-encoded so no quote, `$`, backtick or newline in it
 * can be reinterpreted by the remote login shell. `openssl` is preferred
 * because its `-A` flag reads a single unwrapped line on both GNU and BSD
 * userlands; `base64 -d` is the fallback.
 * @param {string} script - the script text.
 * @returns the one-line remote command.
 */
export function encodeProbeCommand(script) {
  const encoded = Buffer.from(script, 'utf8').toString('base64')
  return "if command -v openssl >/dev/null 2>&1; then "
    + `printf '%s' '${encoded}' | openssl base64 -d -A | sh; `
    + `else printf '%s' '${encoded}' | base64 -d | sh; fi`
}

/**
 * Split probe output into its marked sections.
 * @param {string} text - raw stdout of the probe.
 * @returns {Map<string, string[]>} section name to content lines.
 */
export function splitSections(text) {
  const sections = new Map()
  let current = null
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (raw.startsWith(MARK + ' ')) {
      current = raw.slice(MARK.length + 1).trim()
      sections.set(current, [])
      continue
    }
    if (current !== null) sections.get(current).push(raw)
  }
  return sections
}

/** Parse a decimal field, or null when absent/not a number. */
function toNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Whether one mount path contains another (used to collapse bind mounts).
 * @param {string} parent - candidate ancestor.
 * @param {string} child - candidate descendant.
 * @returns {boolean} true when `parent` is `child` or a directory above it.
 */
function isAncestorPath(parent, child) {
  if (parent === child) return true
  if (parent === '/') return child.startsWith('/')
  return child.startsWith(parent.endsWith('/') ? parent : parent + '/')
}

/**
 * Drop redundant rows describing the same filesystem.
 *
 * A container typically reports its root twice — once as `overlay /` and once
 * as the bind-mounted device, e.g. `/dev/vda3 /etc/hosts` — with byte-identical
 * size and usage. Keeping both shows the same disk twice and buries the real
 * `/` row. Rows are collapsed only when the numbers match exactly AND one mount
 * path contains the other, so two genuinely separate identical disks survive.
 *
 * @param {Array<object>} rows - parsed rows.
 * @returns {Array<object>} rows with redundant views removed.
 */
function collapseDuplicateMounts(rows) {
  const kept = []
  for (const row of rows) {
    const duplicate = kept.find(other =>
      other.sizeBytes === row.sizeBytes
      && other.usedBytes === row.usedBytes
      && (isAncestorPath(other.mount, row.mount) || isAncestorPath(row.mount, other.mount)))
    if (duplicate === undefined) {
      kept.push(row)
      continue
    }
    // Keep the row whose mount path is closest to the root.
    if (row.mount !== duplicate.mount && isAncestorPath(row.mount, duplicate.mount)) {
      kept[kept.indexOf(duplicate)] = row
    }
  }
  return kept
}

/**
 * Parse one line of /proc/stat `cpu` or `cpuN`.
 * @param {string} line - the stat line.
 * @returns {{ name: string, user: number, nice: number, system: number, idle: number, iowait: number, irq: number, softirq: number, steal: number, total: number, idleTotal: number } | null}
 */
export function parseCpuLine(line) {
  const match = /^(cpu\d*)\s+(.*)$/.exec(line.trim())
  if (match === null) return null
  const fields = match[2].trim().split(/\s+/).map(value => toNumber(value) ?? 0)
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields
  return {
    name: match[1],
    user, nice, system, idle, iowait, irq, softirq, steal,
    total: user + nice + system + idle + iowait + irq + softirq + steal,
    idleTotal: idle + iowait,
  }
}

/**
 * Parse /proc/meminfo into bytes.
 * @param {string[]} lines - the meminfo section.
 * @returns {{ totalBytes: number|null, freeBytes: number|null, availableBytes: number|null, buffersBytes: number|null, cachedBytes: number|null, swapTotalBytes: number|null, swapFreeBytes: number|null, dirtyBytes: number|null }}
 */
export function parseMeminfo(lines) {
  const values = new Map()
  for (const line of lines) {
    const match = /^([A-Za-z_()0-9]+):\s*(\d+)/.exec(line.trim())
    if (match !== null) values.set(match[1], Number(match[2]) * KIB)
  }
  const cached = (values.get('Cached') ?? 0) + (values.get('SReclaimable') ?? 0)
  return {
    totalBytes: values.get('MemTotal') ?? null,
    freeBytes: values.get('MemFree') ?? null,
    availableBytes: values.get('MemAvailable') ?? null,
    buffersBytes: values.get('Buffers') ?? null,
    cachedBytes: cached > 0 ? cached : null,
    swapTotalBytes: values.get('SwapTotal') ?? null,
    swapFreeBytes: values.get('SwapFree') ?? null,
    dirtyBytes: values.get('Dirty') ?? null,
  }
}

/**
 * Parse `df -P -k` output. GNU df wraps a long device name onto its own line,
 * so a continuation line is re-attached to the row that follows it.
 * @param {string[]} lines - the df section, header included.
 * @returns {Array<{ filesystem: string, mount: string, sizeBytes: number|null, usedBytes: number|null, availBytes: number|null, usePercent: number|null }>}
 */
export function parseDf(lines) {
  const rows = []
  let pendingName = null
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    const fields = line.split(/\s+/)
    if (fields[0] === 'Filesystem') continue
    // POSIX `df -P` emits six columns. Fewer means GNU df wrapped a long device
    // name onto a line of its own, so this line is a name, not a data row.
    if (pendingName === null && fields.length < 6) {
      pendingName = fields.join(' ')
      continue
    }
    const filesystem = pendingName ?? fields[0]
    const rest = pendingName === null ? fields.slice(1) : fields
    pendingName = null
    const size = toNumber(rest[0])
    if (size === null) continue
    rows.push({
      filesystem,
      mount: rest.length >= 5 ? rest.slice(4).join(' ') : '/',
      sizeBytes: size * KIB,
      usedBytes: (toNumber(rest[1]) ?? 0) * KIB,
      availBytes: (toNumber(rest[2]) ?? 0) * KIB,
      usePercent: toNumber(String(rest[3] ?? '').replace('%', '')),
    })
  }
  return collapseDuplicateMounts(rows)
}

/**
 * Parse /proc/diskstats into cumulative counters.
 * @param {string[]} lines - the diskstats section.
 * @returns {Map<string, { readBytes: number, writeBytes: number, reads: number, writes: number, busyMs: number|null }>}
 */
export function parseDiskstats(lines) {
  const devices = new Map()
  for (const raw of lines) {
    const fields = raw.trim().split(/\s+/)
    if (fields.length < 14) continue
    const name = fields[2]
    if (name === undefined || name === '') continue
    devices.set(name, {
      reads: toNumber(fields[3]) ?? 0,
      readBytes: (toNumber(fields[5]) ?? 0) * SECTOR_BYTES,
      writes: toNumber(fields[7]) ?? 0,
      writeBytes: (toNumber(fields[9]) ?? 0) * SECTOR_BYTES,
      busyMs: toNumber(fields[12]),
    })
  }
  return devices
}

/**
 * Parse /proc/net/dev into cumulative byte counters.
 * @param {string[]} lines - the netdev section.
 * @returns {Map<string, { rxBytes: number, txBytes: number }>}
 */
export function parseNetDev(lines) {
  const interfaces = new Map()
  for (const raw of lines) {
    const at = raw.indexOf(':')
    if (at < 0) continue
    const name = raw.slice(0, at).trim()
    if (name === '') continue
    const fields = raw.slice(at + 1).trim().split(/\s+/)
    if (fields.length < 9) continue
    interfaces.set(name, {
      rxBytes: toNumber(fields[0]) ?? 0,
      txBytes: toNumber(fields[8]) ?? 0,
    })
  }
  return interfaces
}

/**
 * Parse a `ps -eo pid=,comm=,pcpu=,pmem=,rss=,args=` table.
 * @param {string[]} lines - the ps section.
 * @returns {Array<{ pid: number, name: string, cpuPercent: number, memPercent: number, rssBytes: number, command: string }>}
 */
export function parsePs(lines) {
  const rows = []
  for (const raw of lines) {
    const match = /^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s*(.*)$/.exec(raw)
    if (match === null) continue
    rows.push({
      pid: Number(match[1]),
      name: match[2],
      cpuPercent: toNumber(match[3]) ?? 0,
      memPercent: toNumber(match[4]) ?? 0,
      rssBytes: (toNumber(match[5]) ?? 0) * KIB,
      command: match[6].trim(),
    })
  }
  return rows
}

/** Parse one nvidia-smi CSV field; `[N/A]`, `N/A` and empty all read as null. */
function smiNumber(value) {
  const text = String(value ?? '').trim()
  if (text === '' || text === '[N/A]' || text === 'N/A' || text === '[Not Supported]' || text === 'Not Supported') return null
  return toNumber(text)
}

/** Split one nvidia-smi CSV row, trimming each field. */
function smiFields(line) {
  return line.split(',').map(field => field.trim())
}

/**
 * Parse the GPU section: per-GPU rows plus the compute-process rows, joined by
 * the GPU UUID nvidia-smi reports on both.
 * @param {string[]} gpuLines - the `gpu` section.
 * @param {string[]} appLines - the `gpuapps` section.
 * @returns {Array<object>} one entry per visible GPU (empty when nvidia-smi is absent).
 */
export function parseGpus(gpuLines, appLines) {
  const byUuid = new Map()
  const gpus = []
  for (const line of gpuLines) {
    if (line.trim() === '') continue
    const f = smiFields(line)
    if (f.length < 6) continue
    const gpu = {
      index: toNumber(f[0]) ?? gpus.length,
      uuid: f[1] ?? '',
      name: f[2] ?? 'GPU',
      utilPercent: smiNumber(f[3]),
      memUsedBytes: (smiNumber(f[4]) ?? 0) * 1024 * 1024,
      memTotalBytes: (smiNumber(f[5]) ?? 0) * 1024 * 1024,
      tempC: smiNumber(f[6]),
      powerW: smiNumber(f[7]),
      powerLimitW: smiNumber(f[8]),
      fanPercent: smiNumber(f[9]),
      clockSmMhz: smiNumber(f[10]),
      processes: [],
    }
    gpus.push(gpu)
    if (gpu.uuid !== '') byUuid.set(gpu.uuid, gpu)
  }
  for (const line of appLines) {
    if (line.trim() === '') continue
    const f = smiFields(line)
    if (f.length < 4) continue
    const gpu = byUuid.get(f[0])
    if (gpu === undefined) continue
    gpu.processes.push({
      pid: toNumber(f[1]),
      name: f[2] ?? '',
      memBytes: (smiNumber(f[3]) ?? 0) * 1024 * 1024,
    })
  }
  return gpus
}

/**
 * Parse the whole probe output.
 * @param {string} text - raw stdout.
 * @returns {object} the raw probe: cumulative counters plus the heavy sections
 *   that only a full probe carries (absent keys when it was a light probe).
 */
export function parseProbe(text) {
  const sections = splitSections(text)
  const get = name => sections.get(name) ?? []

  const uptimeLine = get('probe')[0] ?? ''
  const uptimeSec = toNumber((uptimeLine.trim().split(/\s+/)[0]) ?? null)

  const loadFields = (get('loadavg')[0] ?? '').trim().split(/\s+/)
  const load = [toNumber(loadFields[0]), toNumber(loadFields[1]), toNumber(loadFields[2])]

  const nproc = toNumber((get('nproc')[0] ?? '').trim())

  const cpuLines = get('stat').map(parseCpuLine).filter(Boolean)
  const totalCpu = cpuLines.find(entry => entry.name === 'cpu') ?? null
  const cores = cpuLines.filter(entry => entry.name !== 'cpu')

  const systemLines = get('system')
  const meminfo = get('meminfo')

  const raw = {
    uptimeSec,
    load,
    nproc,
    cpu: totalCpu,
    cores,
    mem: meminfo.length > 0 ? parseMeminfo(meminfo) : null,
    net: parseNetDev(get('netdev')),
    disk: parseDiskstats(get('diskstats')),
    blockDevices: get('block').map(line => line.trim()).filter(line => line !== ''),
    system: {
      uname: (systemLines[0] ?? '').trim() || null,
      hostname: (systemLines[1] ?? '').trim() || null,
      os: (systemLines[2] ?? '').trim() || null,
    },
  }

  if (sections.has('df')) {
    raw.mounts = parseDf(get('df')).filter(isReportableMount)
    raw.psCpu = parsePs(get('ps'))
    raw.psMem = parsePs(get('psmem'))
    raw.gpus = parseGpus(get('gpu'), get('gpuapps'))
  }
  return raw
}

/**
 * Percentage of a counter delta, guarding div-by-zero and counter resets.
 * @param {number} delta - consumed amount over the interval.
 * @param {number} total - total amount over the interval.
 * @returns {number|null} 0..100, or null when the interval carries no data.
 */
function percentOf(delta, total) {
  if (!Number.isFinite(delta) || !Number.isFinite(total) || total <= 0) return null
  if (delta < 0) return null
  return Math.min(100, Math.max(0, (delta / total) * 100))
}

/** Round to one decimal place. */
function round1(value) {
  return value === null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10
}

/**
 * Turn one counter delta into a per-second rate.
 * @param {number|null|undefined} current - counter now.
 * @param {number|null|undefined} previous - counter before.
 * @param {number} seconds - interval length.
 * @returns {number|null} units per second, or null when unavailable/reset.
 */
function rate(current, previous, seconds) {
  if (typeof current !== 'number' || typeof previous !== 'number') return null
  if (!Number.isFinite(current) || !Number.isFinite(previous) || seconds <= 0) return null
  const delta = current - previous
  if (delta < 0) return null
  return delta / seconds
}

/**
 * Derive one wire sample from a counter read and the previous one.
 *
 * `curr` supplies the counters (a light probe is enough); `full` supplies the
 * sections only a full probe carries — mounts, process tables and GPUs. Pass
 * the same object twice for an ordinary full poll.
 *
 * @param {object} input - derivation input.
 * @param {object|null} input.prev - previous raw probe (null on the first read).
 * @param {object} input.curr - the raw probe carrying fresh counters.
 * @param {object} [input.full] - the last full raw probe (defaults to `curr`).
 * @param {number} input.dtMs - milliseconds between `prev` and `curr`.
 * @param {{ includeLoopbackNet?: boolean, netInterfaces?: string[], diskDevices?: string[], topN?: number }} [input.options] - filters.
 * @returns {object} the sample handed to the UI, the agent tools and the alert evaluator.
 */
export function deriveSample({ prev, curr, full, dtMs, options = {} }) {
  const heavy = full ?? curr
  const seconds = dtMs > 0 ? dtMs / 1000 : 0
  const hasDelta = prev !== null && prev !== undefined && seconds > 0

  let cpuPercent = null
  // The breakdown fields are interval percentages too. /proc/stat carries
  // cumulative jiffies, so passing them through raw produced nonsense like
  // "iowait 355544059%" — the counter's absolute value, not a share of time.
  let cpuUserPercent = null
  let cpuSystemPercent = null
  let cpuIowaitPercent = null
  let cpuStealPercent = null
  const cores = []
  if (hasDelta && prev.cpu !== null && curr.cpu !== null) {
    const totalDelta = curr.cpu.total - prev.cpu.total
    const idleDelta = curr.cpu.idleTotal - prev.cpu.idleTotal
    cpuPercent = round1(percentOf(totalDelta - idleDelta, totalDelta))
    cpuUserPercent = round1(percentOf(curr.cpu.user - prev.cpu.user, totalDelta))
    cpuSystemPercent = round1(percentOf(curr.cpu.system - prev.cpu.system, totalDelta))
    cpuIowaitPercent = round1(percentOf(curr.cpu.iowait - prev.cpu.iowait, totalDelta))
    cpuStealPercent = round1(percentOf(curr.cpu.steal - prev.cpu.steal, totalDelta))
    const previousCores = new Map((prev.cores ?? []).map(core => [core.name, core]))
    for (const core of curr.cores ?? []) {
      const before = previousCores.get(core.name)
      if (before === undefined) continue
      const coreTotal = core.total - before.total
      const coreIdle = core.idleTotal - before.idleTotal
      cores.push({ name: core.name, percent: round1(percentOf(coreTotal - coreIdle, coreTotal)) })
    }
  }

  const mem = curr.mem
  let memUsedBytes = null
  let memPercent = null
  if (mem !== null && mem !== undefined && typeof mem.totalBytes === 'number' && mem.totalBytes > 0) {
    memUsedBytes = typeof mem.availableBytes === 'number'
      ? mem.totalBytes - mem.availableBytes
      : mem.totalBytes - (mem.freeBytes ?? 0) - (mem.buffersBytes ?? 0) - (mem.cachedBytes ?? 0)
    memUsedBytes = Math.max(0, memUsedBytes)
    memPercent = round1((memUsedBytes / mem.totalBytes) * 100)
  }
  const swapUsedBytes = mem !== null && mem !== undefined
    && typeof mem.swapTotalBytes === 'number' && typeof mem.swapFreeBytes === 'number'
    ? Math.max(0, mem.swapTotalBytes - mem.swapFreeBytes)
    : null
  const swapPercent = mem !== null && mem !== undefined
    && typeof mem.swapTotalBytes === 'number' && mem.swapTotalBytes > 0 && swapUsedBytes !== null
    ? round1((swapUsedBytes / mem.swapTotalBytes) * 100)
    : null

  const netFilter = new Set(options.netInterfaces ?? [])
  const nets = []
  const netNames = new Set([...(curr.net?.keys() ?? []), ...(hasDelta ? prev.net?.keys() ?? [] : [])])
  for (const name of netNames) {
    if (netFilter.size > 0 && !netFilter.has(name)) continue
    if (netFilter.size === 0 && name === 'lo' && options.includeLoopbackNet !== true) continue
    const now = curr.net?.get(name)
    const before = prev?.net?.get(name)
    nets.push({
      name,
      rxBytes: now?.rxBytes ?? before?.rxBytes ?? 0,
      txBytes: now?.txBytes ?? before?.txBytes ?? 0,
      rxBps: hasDelta ? rate(now?.rxBytes, before?.rxBytes, seconds) : null,
      txBps: hasDelta ? rate(now?.txBytes, before?.txBytes, seconds) : null,
    })
  }
  nets.sort((a, b) => (b.rxBps ?? -1) - (a.rxBps ?? -1))

  const diskFilter = new Set(options.diskDevices ?? [])
  const physical = new Set(heavy.blockDevices ?? [])
  const disks = []
  const diskNames = new Set([...(curr.disk?.keys() ?? []), ...(hasDelta ? prev.disk?.keys() ?? [] : [])])
  for (const name of diskNames) {
    if (VIRTUAL_DEVICE_RE.test(name) && !diskFilter.has(name)) continue
    if (physical.size > 0 && !physical.has(name) && !diskFilter.has(name)) continue
    if (/\d+$/.test(name) && /\D/.test(name) && physical.size > 0 && !physical.has(name)) continue
    if (diskFilter.size > 0 && !diskFilter.has(name)) continue
    const now = curr.disk?.get(name)
    const before = prev?.disk?.get(name)
    const busyNow = now?.busyMs ?? null
    const busyBefore = before?.busyMs ?? null
    disks.push({
      name,
      readBps: hasDelta ? rate(now?.readBytes, before?.readBytes, seconds) : null,
      writeBps: hasDelta ? rate(now?.writeBytes, before?.writeBytes, seconds) : null,
      iops: hasDelta && typeof now?.reads === 'number' && typeof before?.reads === 'number'
        ? (now.reads - before.reads) / seconds + ((now.writes ?? 0) - (before.writes ?? 0)) / seconds
        : null,
      busyPercent: hasDelta && typeof busyNow === 'number' && typeof busyBefore === 'number'
        ? round1(percentOf(busyNow - busyBefore, seconds * 1000))
        : null,
    })
  }
  disks.sort((a, b) => ((b.readBps ?? 0) + (b.writeBps ?? 0)) - ((a.readBps ?? 0) + (a.writeBps ?? 0)))

  const topN = Math.max(1, Math.min(50, Math.trunc(Number(options.topN ?? 8)) || 8))
  const topCpu = (heavy.psCpu ?? []).slice(0, topN)
  const topMem = (heavy.psMem ?? []).slice(0, topN)

  const gpus = (heavy.gpus ?? []).map(gpu => ({
    ...gpu,
    memPercent: gpu.memTotalBytes > 0 ? round1((gpu.memUsedBytes / gpu.memTotalBytes) * 100) : null,
  }))

  const mounts = (heavy.mounts ?? []).map(mount => ({ ...mount, usePercent: round1(mount.usePercent) }))
  mounts.sort((a, b) => (b.usePercent ?? -1) - (a.usePercent ?? -1))

  return {
    sampledAt: Date.now(),
    intervalMs: Math.round(dtMs),
    ratesReady: hasDelta,
    cpu: {
      percent: cpuPercent,
      load: curr.load ?? [null, null, null],
      nproc: curr.nproc ?? null,
      cores,
      user: cpuUserPercent,
      system: cpuSystemPercent,
      iowait: cpuIowaitPercent,
      steal: cpuStealPercent,
    },
    mem: {
      totalBytes: mem?.totalBytes ?? null,
      usedBytes: memUsedBytes,
      availableBytes: mem?.availableBytes ?? null,
      cachedBytes: mem?.cachedBytes ?? null,
      buffersBytes: mem?.buffersBytes ?? null,
      percent: memPercent,
      swapTotalBytes: mem?.swapTotalBytes ?? null,
      swapUsedBytes,
      swapPercent,
    },
    disks: mounts,
    diskIo: disks,
    net: nets,
    gpus,
    topCpu,
    topMem,
    system: {
      ...heavy.system,
      uptimeSec: curr.uptimeSec ?? null,
    },
  }
}

/**
 * Evaluate the configured thresholds against one sample.
 * @param {object} sample - a derived sample.
 * @param {{ cpu?: number, mem?: number, swap?: number, disk?: number, gpu?: number, gpuMem?: number, temp?: number, loadPerCore?: number }} thresholds - thresholds; 0 or undefined disables one.
 * @returns {Array<{ key: string, level: 'warn'|'critical', metric: string, target: string, value: number, threshold: number, message: string }>}
 */
export function evaluateAlerts(sample, thresholds = {}) {
  const alerts = []
  const push = (key, metric, target, value, threshold, unit) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    if (typeof threshold !== 'number' || threshold <= 0) return
    if (value < threshold) return
    const level = value >= Math.min(100, threshold + 5) || threshold >= 95 ? 'critical' : 'warn'
    alerts.push({
      key,
      level,
      metric,
      target,
      value: round1(value),
      threshold,
      message: `${target} ${metric} ${round1(value)}${unit} ≥ ${threshold}${unit}`,
    })
  }

  push('cpu', 'cpu', sample.system?.hostname ?? 'host', sample.cpu?.percent, thresholds.cpu, '%')
  push('mem', 'memory', sample.system?.hostname ?? 'host', sample.mem?.percent, thresholds.mem, '%')
  push('swap', 'swap', sample.system?.hostname ?? 'host', sample.mem?.swapPercent, thresholds.swap, '%')
  for (const mount of sample.disks ?? []) {
    push('disk:' + mount.mount, 'disk', mount.mount, mount.usePercent, thresholds.disk, '%')
  }
  const nproc = sample.cpu?.nproc
  const load1 = sample.cpu?.load?.[0]
  if (typeof nproc === 'number' && nproc > 0) {
    push('load', 'load/core', sample.system?.hostname ?? 'host', load1 / nproc * 100, thresholds.loadPerCore, '%')
  }
  for (const gpu of sample.gpus ?? []) {
    const label = `GPU${gpu.index}`
    push('gpu:' + gpu.index, 'gpu', label, gpu.utilPercent, thresholds.gpu, '%')
    push('gpu-mem:' + gpu.index, 'gpu-mem', label, gpu.memPercent, thresholds.gpuMem, '%')
    push('gpu-temp:' + gpu.index, 'gpu-temp', label, gpu.tempC, thresholds.temp, '°C')
  }
  return alerts
}
