/**
 * Agent tools — the read-only face of the monitor.
 *
 * These tools expose NO way to run a caller-supplied command on a remote host:
 * the only remote text that ever executes is the fixed probe in probe.js. That
 * is the deliberate difference from `ssh_exec`, and it is what makes it safe
 * to let an agent poll a fleet unattended. Anything genuinely arbitrary belongs
 * in dsh-ssh's `ssh_exec`.
 *
 * Output is a rendered report: the model reads prose tables far more reliably
 * than a deep JSON object, and it keeps the canonical value trivially valid.
 *
 * @module dsh-remote-monitor/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { describeCapacity, rankByCapacity, summarizeFleet } from './capacity.js'

/** One text content block. */
function text(value) {
  return [{ type: 'text', text: value }]
}

/** The one-field canonical output every tool here declares. */
const REPORT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      report: { type: 'string', required: true },
    },
  },
  render: (_args, value) => text(value.report),
}

/** Format a byte count. */
export function formatBytes(bytes, digits = 1) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return 'n/a'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let value = Math.abs(bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const sign = bytes < 0 ? '-' : ''
  return `${sign}${value.toFixed(unit === 0 ? 0 : digits)} ${units[unit]}`
}

/** Format a per-second byte rate. */
export function formatRate(bytesPerSecond) {
  if (typeof bytesPerSecond !== 'number' || !Number.isFinite(bytesPerSecond)) return 'n/a'
  return `${formatBytes(bytesPerSecond, 1)}/s`
}

/** Format a percentage. */
export function formatPercent(value, digits = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a'
  return `${value.toFixed(digits)}%`
}

/** Format an uptime in seconds as `12d 4h 3m`. */
export function formatUptime(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 'n/a'
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const parts = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0 || days > 0) parts.push(`${hours}h`)
  parts.push(`${minutes}m`)
  return parts.join(' ')
}

/** Format an epoch timestamp in local time. */
function formatTime(epochMs) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return 'never'
  const date = new Date(epochMs)
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Right-pad a label column. */
function pad(text, width) {
  const value = String(text)
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

/**
 * Render one host payload as a report block.
 * @param {object} host - a monitor payload.
 * @param {{ gpuOnly?: boolean, includeProcesses?: boolean, processLimit?: number, processSort?: 'cpu'|'mem' }} [options] - section selection.
 * @returns {string} the report text.
 */
export function renderHost(host, options = {}) {
  const lines = []
  const state = host.status === 'unknown'
    ? (host.monitor ? 'NOT READ YET' : 'MONITORING OFF')
    : host.ok
      ? 'OK'
      : `UNREACHABLE${host.error !== undefined && host.error !== null ? ' — ' + host.error : ''}`
  const latency = host.latencyMs === null || host.latencyMs === undefined ? '' : ` · latency ${host.latencyMs} ms`
  lines.push(`${host.alias} (${host.user}@${host.host}:${host.port}, source: ${host.source}) — ${state}${latency} · sampled ${formatTime(host.lastSampleAt)}`)

  const system = host.system ?? {}
  const systemBits = []
  if (system.os !== null && system.os !== undefined && system.os !== '') systemBits.push(system.os)
  if (system.uname !== null && system.uname !== undefined && system.uname !== '') systemBits.push(system.uname)
  if (typeof system.uptimeSec === 'number') systemBits.push(`up ${formatUptime(system.uptimeSec)}`)
  if (system.hostname !== null && system.hostname !== undefined && system.hostname !== '') systemBits.unshift(system.hostname)
  if (systemBits.length > 0) lines.push(`  system: ${systemBits.join(' · ')}`)

  if (!host.ok && host.lastSampleAt === null) {
    lines.push('  no data yet — the host has never answered a probe')
    return lines.join('\n')
  }

  if (options.gpuOnly !== true) {
    const cpu = host.cpu ?? {}
    const load = Array.isArray(cpu.load) ? cpu.load : []
    const loadText = load.map(value => (typeof value === 'number' ? value.toFixed(2) : 'n/a')).join(' / ')
    const perCore = typeof load[0] === 'number' && typeof cpu.nproc === 'number' && cpu.nproc > 0
      ? ` (${(load[0] / cpu.nproc).toFixed(2)}/core)`
      : ''
    lines.push(`  cpu: ${formatPercent(cpu.percent)} of ${cpu.nproc ?? 'n/a'} cores · load ${loadText}${perCore} · iowait ${formatPercent(cpu.iowait)} · steal ${formatPercent(cpu.steal)}`)

    const mem = host.mem ?? {}
    const core = `  mem: ${formatBytes(mem.usedBytes)} / ${formatBytes(mem.totalBytes)} (${formatPercent(mem.percent)})`
    const swap = typeof mem.swapTotalBytes === 'number' && mem.swapTotalBytes > 0
      ? ` · swap ${formatBytes(mem.swapUsedBytes)} / ${formatBytes(mem.swapTotalBytes)} (${formatPercent(mem.swapPercent)})`
      : ' · no swap'
    lines.push(core + swap)
    if (host.capacity !== null && host.capacity !== undefined) {
      lines.push(`  capacity: ${describeCapacity(host.capacity, host.idleForSec ?? 0)}${host.capacity.schedulable ? ' · schedulable' : ''}`)
    }
    if (host.idleIndex !== null && host.idleIndex !== undefined && host.idleIndex.index !== null) {
      const part = host.idleIndex.basis === 'gpu'
        ? `GPU avg ${host.idleIndex.utilPercent}%`
        : `CPU ${host.idleIndex.utilPercent}%`
      lines.push(`  idle index: ${host.idleIndex.index}/100 (${part} · ${Math.round((host.idleIndex.timeScore ?? 0))} time score · idle ${formatUptime(host.idleIndex.idleForSec ?? 0)})`)
    }
    if (host.lowUsage?.low === true) {
      lines.push(`  usage: low · under-used for ${formatUptime(host.lowUsage.forSec ?? 0)} (${host.lowUsage.reason ?? 'below threshold'})`)
    }

    if ((host.disks ?? []).length > 0) {
      lines.push('  disk usage:')
      for (const mount of host.disks) {
        lines.push(`    ${pad(mount.mount, 18)} ${formatBytes(mount.usedBytes)} / ${formatBytes(mount.sizeBytes)} (${formatPercent(mount.usePercent)})`)
      }
    }
    if ((host.diskIo ?? []).length > 0 && host.ratesReady) {
      lines.push('  disk io:')
      for (const device of host.diskIo.slice(0, 6)) {
        lines.push(`    ${pad(device.name, 12)} read ${pad(formatRate(device.readBps), 12)} write ${pad(formatRate(device.writeBps), 12)} busy ${formatPercent(device.busyPercent, 0)}`)
      }
    }
    if ((host.net ?? []).length > 0) {
      lines.push('  network:')
      for (const nic of host.net.slice(0, 6)) {
        lines.push(`    ${pad(nic.name, 12)} rx ${pad(formatRate(nic.rxBps), 12)} tx ${pad(formatRate(nic.txBps), 12)} total ↓${formatBytes(nic.rxBytes)} ↑${formatBytes(nic.txBytes)}`)
      }
    }
  }

  const gpus = host.gpus ?? []
  if (gpus.length > 0) {
    lines.push(`  gpu (${gpus.length}):`)
    for (const gpu of gpus) {
      lines.push(`    GPU${gpu.index} ${pad(gpu.name, 20)} util ${pad(formatPercent(gpu.utilPercent, 0), 5)} mem ${pad(formatBytes(gpu.memUsedBytes), 10)} / ${pad(formatBytes(gpu.memTotalBytes), 10)} (${formatPercent(gpu.memPercent)})  ${gpu.tempC ?? 'n/a'}°C  ${gpu.powerW ?? 'n/a'} W / ${gpu.powerLimitW ?? 'n/a'} W  fan ${gpu.fanPercent ?? 'n/a'}%`)
      for (const process of gpu.processes ?? []) {
        lines.push(`      pid ${process.pid} ${process.name} ${formatBytes(process.memBytes)}`)
      }
    }
  } else if (options.gpuOnly === true) {
    lines.push('  gpu: none detected (nvidia-smi absent, or the host has no NVIDIA device)')
  }

  if (options.includeProcesses === true) {
    const list = options.processSort === 'mem' ? (host.topMem ?? []) : (host.topCpu ?? [])
    const sortLabel = options.processSort === 'mem' ? 'memory' : 'cpu'
    const limit = options.processLimit ?? 8
    if (list.length > 0) {
      lines.push(`  top ${Math.min(limit, list.length)} processes by ${sortLabel}:`)
      for (const process of list.slice(0, limit)) {
        lines.push(`    pid ${pad(process.pid, 7)} ${pad(process.name, 18)} cpu ${pad(formatPercent(process.cpuPercent), 8)} mem ${pad(formatPercent(process.memPercent), 6)} rss ${pad(formatBytes(process.rssBytes), 10)} ${process.command}`)
      }
    } else {
      lines.push('  processes: the probe returned none (this host may restrict `ps`)')
    }
  }

  if (!host.ratesReady) {
    lines.push('  note: rates (cpu% / network / disk io) are unavailable on this first read; call again in a few seconds for a delta.')
  }

  const alerts = host.alerts ?? []
  if (alerts.length > 0) {
    lines.push('  alerts:')
    for (const alert of alerts) lines.push(`    [${alert.level}] ${alert.message}`)
  }
  return lines.join('\n')
}

/** Render the host inventory. */
export function renderInventory(hosts, thresholds) {
  if (hosts.length === 0) {
    return 'No hosts are known. Add one to ~/.ssh/config (or to the dsh-ssh plugin), then call rmon_list again.'
  }
  const rows = ['alias | target | source | monitor | status | cpu | mem | gpu | idle | disk | last sample', '--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---']
  for (const host of hosts) {
    const gpu = (host.gpus ?? []).length > 0
      ? `${Math.max(...host.gpus.map(item => item.utilPercent ?? 0)).toFixed(0)}% x${host.gpus.length}`
      : '-'
    const capacity = host.capacity
    const idle = capacity === null || capacity === undefined || capacity.score === null
      ? '-'
      : `${capacity.schedulable ? 'free' : capacity.state} ${capacity.score}${capacity.gpuTotal > 0 ? ` · ${capacity.gpuFree}/${capacity.gpuTotal}g` : ''}${host.status === 'ok' && capacity.schedulable && host.idleForSec >= 60 ? ` ${Math.floor(host.idleForSec / 60)}m` : ''}`
    const disk = (host.disks ?? []).length > 0
      ? formatPercent(Math.max(...host.disks.map(item => item.usePercent ?? 0)), 0)
      : '-'
    rows.push([
      host.alias,
      `${host.user}@${host.host}:${host.port}`,
      host.source,
      host.monitor ? 'on' : 'off',
      host.status === 'ok' ? 'ok' : host.status === 'unknown' ? 'not read' : 'down',
      formatPercent(host.cpu?.percent, 0),
      formatPercent(host.mem?.percent, 0),
      gpu,
      idle,
      disk,
      formatTime(host.lastSampleAt),
    ].join(' | '))
  }
  rows.push('')
  rows.push('thresholds: ' + Object.entries(thresholds).map(([key, value]) => `${key}≥${value}`).join(' '))
  rows.push('idle = spare capacity (free <score> · <free>/<total> GPUs); use rmon_idle to rank machines by headroom.')
  rows.push('Use rmon_status for a full report, rmon_gpu for GPUs and rmon_processes for the top processes.')
  return rows.join('\n')
}

/** Render the recent-alert log. */
export function renderAlerts(entries, thresholds, lowUsage) {
  const lines = ['thresholds: ' + Object.entries(thresholds).map(([key, value]) => `${key}≥${value}`).join(' ')]
  if (lowUsage !== null && lowUsage !== undefined) {
    lines.push(lowUsage.enabled === false
      ? 'low-usage reminder: off'
      : `low-usage reminder: CPU ≤${lowUsage.cpuBelow}% (CPU-only) or GPU avg ≤${lowUsage.gpuBelow}% for ≥${Math.round(lowUsage.forSec / 60)}m`)
  }
  lines.push('')
  if (entries.length === 0) {
    lines.push('No threshold breaches have been recorded since the plugin started.')
    return lines.join('\n')
  }
  for (const entry of entries) {
    for (const alert of entry.alerts) {
      lines.push(`${formatTime(entry.at)}  ${entry.alias}  [${alert.level}] ${alert.message}`)
    }
  }
  return lines.join('\n')
}

/** Render the spare-capacity ranking. */
export function renderIdle(hosts, thresholds, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(50, Math.trunc(options.limit))) : 12
  let picked = hosts.filter(host => {
    if (options.gpusOnly === true && (host.capacity?.gpuTotal ?? 0) === 0) return false
    if (options.includeBusy === true) return true
    if (host.status !== 'ok') return false
    const state = host.capacity?.state
    return state === 'free' || state === 'partial'
  })
  picked = rankByCapacity(picked).slice(0, limit)

  const summary = summarizeFleet(hosts)
  const lines = [
    `fleet: ${summary.online}/${summary.total} online · ${summary.schedulable} schedulable · ${summary.freeGpus}/${summary.totalGpus} GPUs free · ${summary.freeCores} cores + ${formatBytes(summary.freeMemBytes)} free`,
  ]
  if (picked.length === 0) {
    lines.push('')
    lines.push('No machine currently has spare capacity. Call rmon_idle with includeBusy=true to see the busy ones and what is holding them.')
    return lines.join('\n')
  }

  lines.push('')
  lines.push('alias | idle | idx | score | free cpu | free mem | free gpu | free for | notes')
  lines.push('--- | --- | --- | --- | --- | --- | --- | --- | ---')
  for (const host of picked) {
    const capacity = host.capacity
    if (capacity === null || capacity === undefined) continue
    const freeFor = host.idleForSec >= 60 ? `${Math.floor(host.idleForSec / 60)}m` : host.idleForSec > 0 ? `${host.idleForSec}s` : '-'
    const gpu = capacity.gpuTotal > 0
      ? `${capacity.gpuFree}/${capacity.gpuTotal}${capacity.freeGpuIndexes.length > 0 ? ` (GPU${capacity.freeGpuIndexes.join(',')})` : ''}`
      : '-'
    const notes = capacity.blockers.length > 0
      ? 'blocked: ' + capacity.blockers.map(blocker => blocker.code === 'disk'
        ? `disk ${blocker.target ?? ''} ${blocker.value}%`.replace('  ', ' ')
        : `${blocker.code} ${blocker.value}`).join(', ')
      : capacity.schedulable ? 'schedulable' : ''
    const cores = capacity.freeCpuCores === null ? '-' : `${Math.round(capacity.freeCpuCores)} cores (${formatPercent(capacity.cpuFreePercent, 0)})`
    lines.push([
      host.alias,
      capacity.state,
      host.idleIndex?.index === null || host.idleIndex?.index === undefined ? '-' : String(host.idleIndex.index),
      String(capacity.score),
      cores,
      capacity.memFreePercent === null ? '-' : formatPercent(capacity.memFreePercent, 0),
      gpu,
      freeFor,
      notes,
    ].join(' | '))
  }
  lines.push('')
  lines.push('idle: free = score ≥ ' + (options.freeScore ?? 60) + ' with no blockers; partial = some headroom; "free for" only counts sustained idle (≥ 1 poll).')
  return lines.join('\n')
}

/**
 * Build the agent tool set for one monitor.
 * @param {import('./monitor.js').Monitor} monitor - the sampler.
 * @param {import('./store.js').HostBook} book - the host book.
 * @returns {Array<object>} tool definitions.
 */
export function makeTools(monitor, book) {
  const listTool = defineTool({
    name: 'rmon_list',
    description: 'List the remote machines this DSH installation monitors, with the last known CPU / memory / GPU / disk headline for each and whether it is currently reachable. Hosts are discovered from ~/.ssh/config and the dsh-ssh host store, so an alias shown by ssh_list is usually usable here too. Start here to learn the available aliases. '
      + 'Triggers: 远程机器, 服务器列表, 监控哪些机器, remote hosts, fleet, which machines.',
    parameters: {
      query: { type: 'string', description: 'Optional case-insensitive substring match against alias, host, tag or environment.' },
    },
    output: REPORT_OUTPUT,
    async execute(args) {
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      const hosts = monitor.all().filter(host => {
        if (query === '') return true
        return [host.alias, host.host, host.label, host.environment ?? '', ...(host.tags ?? [])]
          .some(field => String(field).toLowerCase().includes(query))
      })
      return { report: renderInventory(hosts, book.thresholds()) }
    },
  })

  const idleTool = defineTool({
    name: 'rmon_idle',
    description: 'Rank the monitored machines by SPARE capacity: which ones can take the next job, how many GPUs are completely idle, how many CPU cores and how much memory are still free, how long the machine has been idle, and what blocks it when it is otherwise free (a full disk, exhausted memory, all GPUs busy). Reads every monitored host over SSH with the fixed read-only probe; percentages are interval values. Use it instead of guessing from CPU% alone — a GPU host with idle CPUs but no free VRAM is not available. '
      + 'Triggers: 哪台机器空着, 有空闲的机器吗, 空闲 GPU, 哪张卡能用, 机器空余, 能不能跑新任务, 找台空闲机器, idle hosts, free capacity, which machine is free, available GPU, spare capacity, can I schedule here.',
    parameters: {
      includeBusy: { type: 'boolean', description: 'Include busy and unreachable machines instead of only those with spare capacity (default false).' },
      gpusOnly: { type: 'boolean', description: 'Only consider machines that report at least one NVIDIA GPU (default false).' },
      limit: { type: 'integer', description: 'How many machines to list, 1..50 (default 12).' },
      fresh: { type: 'boolean', description: 'Force a brand-new read (default true, since capacity changes quickly).' },
    },
    output: REPORT_OUTPUT,
    async execute(args) {
      const hosts = await monitor.readAllNow({ fresh: args.fresh !== false })
      if (hosts.length === 0) return { report: 'No monitored hosts are configured.' }
      const options = {
        includeBusy: args.includeBusy === true,
        gpusOnly: args.gpusOnly === true,
        limit: Number.isFinite(args.limit) ? args.limit : 12,
        freeScore: monitor.capacity?.freeScore ?? 60,
      }
      return { report: renderIdle(hosts, book.thresholds(), options) }
    },
  })

  const statusTool = defineTool({
    name: 'rmon_status',
    description: 'Read live resource usage of one or all monitored remote machines: CPU (usage, load, iowait), memory and swap, per-mount disk usage, disk IO, network throughput, NVIDIA GPUs (utilisation, VRAM, temperature, power) and threshold alerts. Reads over SSH with a fixed read-only probe — it cannot run arbitrary commands (use ssh_exec for that). Percentages describe the interval between two reads; a host read for the first time reports gauges only and says so. '
      + 'Triggers: 资源使用, CPU 占用, 内存占用, 磁盘满了, 机器负载, 服务器状态, GPU 使用率, 显存, resource usage, memory, disk full, load average, is the machine busy.',
    parameters: {
      alias: { type: 'string', description: 'One host alias from rmon_list. Omit to read every monitored host.' },
      fresh: { type: 'boolean', description: 'Force a brand-new read instead of reusing a sample taken in the last couple of seconds (default false).' },
      includeProcesses: { type: 'boolean', description: 'Also list the busiest processes (default true).' },
      processLimit: { type: 'integer', description: 'How many processes to list, 1..50 (default 8).' },
    },
    output: REPORT_OUTPUT,
    async execute(args) {
      const fresh = args.fresh === true
      const includeProcesses = args.includeProcesses !== false
      const processLimit = Number.isFinite(args.processLimit) ? Math.max(1, Math.min(50, Math.trunc(args.processLimit))) : 8
      if (typeof args.alias === 'string' && args.alias.trim() !== '') {
        const host = await monitor.readNow(args.alias.trim(), { fresh })
        if (host === undefined) {
          const known = book.list().map(entry => entry.alias).join(', ')
          return { report: `Unknown alias '${args.alias}'. Known aliases: ${known === '' ? '(none)' : known}` }
        }
        return { report: renderHost(host, { includeProcesses, processLimit }) }
      }
      const hosts = await monitor.readAllNow({ fresh })
      if (hosts.length === 0) return { report: 'No monitored hosts are configured.' }
      return { report: hosts.map(host => renderHost(host, { includeProcesses, processLimit })).join('\n\n') }
    },
  })

  const gpuTool = defineTool({
    name: 'rmon_gpu',
    description: 'Report NVIDIA GPU state on one or all monitored remote machines: per-GPU utilisation, VRAM used/total, temperature, power draw against the limit, fan and SM clock, plus the compute processes holding VRAM. Runs nvidia-smi over SSH. Reports clearly when a host has no NVIDIA device or no nvidia-smi. '
      + 'Triggers: GPU, 显卡, 显存, nvidia-smi, CUDA 卡, 哪张卡空着, VRAM, GPU 温度, is the GPU free.',
    parameters: {
      alias: { type: 'string', description: 'One host alias from rmon_list. Omit for every monitored host.' },
      fresh: { type: 'boolean', description: 'Force a brand-new read (default true here, since GPU state changes fast).' },
    },
    output: REPORT_OUTPUT,
    async execute(args) {
      const fresh = args.fresh !== false
      const pick = host => ({ ...host, gpus: host.gpus ?? [] })
      if (typeof args.alias === 'string' && args.alias.trim() !== '') {
        const host = await monitor.readNow(args.alias.trim(), { fresh })
        if (host === undefined) {
          const known = book.list().map(entry => entry.alias).join(', ')
          return { report: `Unknown alias '${args.alias}'. Known aliases: ${known === '' ? '(none)' : known}` }
        }
        return { report: renderHost(pick(host), { gpuOnly: true }) }
      }
      const hosts = (await monitor.readAllNow({ fresh })).filter(host => (host.gpus ?? []).length > 0)
      if (hosts.length === 0) return { report: 'No monitored host reported an NVIDIA GPU.' }
      return { report: hosts.map(host => renderHost(pick(host), { gpuOnly: true })).join('\n\n') }
    },
  })

  const processesTool = defineTool({
    name: 'rmon_processes',
    description: 'List the busiest processes on one monitored remote machine, sorted by CPU or by resident memory, with pid, name, cpu%, mem%, RSS and the command line. Use it to find out WHO is consuming a host after rmon_status shows it is loaded. Read-only. '
      + 'Triggers: 哪个进程, 谁占了 CPU, 谁占了内存, 进程列表, top 进程, which process, top, htop, oom, memory hog.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from rmon_list.' },
      sort: { type: 'string', enum: ['cpu', 'mem'], description: 'Sort key: cpu (default) or mem.' },
      limit: { type: 'integer', description: 'How many rows, 1..50 (default 15).' },
      fresh: { type: 'boolean', description: 'Force a brand-new read (default true).' },
    },
    output: REPORT_OUTPUT,
    async execute(args) {
      const alias = args.alias.trim()
      const host = await monitor.readNow(alias, { fresh: args.fresh !== false })
      if (host === undefined) {
        const known = book.list().map(entry => entry.alias).join(', ')
        return { report: `Unknown alias '${alias}'. Known aliases: ${known === '' ? '(none)' : known}` }
      }
      const sort = args.sort === 'mem' ? 'mem' : 'cpu'
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(50, Math.trunc(args.limit))) : 15
      const lines = [`${host.alias} (${host.user}@${host.host}) — top ${limit} processes by ${sort === 'mem' ? 'memory' : 'cpu'} · sampled ${formatTime(host.lastSampleAt)}`]
      const list = sort === 'mem' ? (host.topMem ?? []) : (host.topCpu ?? [])
      if (list.length === 0) {
        lines.push(host.ok
          ? '  the probe returned no process rows (this host may restrict `ps`, or the process table was empty)'
          : `  host is unreachable: ${host.error ?? 'unknown error'}`)
        return { report: lines.join('\n') }
      }
      lines.push('  pid     name                cpu      mem     rss       command')
      for (const process of list.slice(0, limit)) {
        lines.push(`  ${pad(process.pid, 7)} ${pad(process.name, 18)} ${pad(formatPercent(process.cpuPercent), 8)} ${pad(formatPercent(process.memPercent), 7)} ${pad(formatBytes(process.rssBytes), 9)} ${process.command}`)
      }
      return { report: lines.join('\n') }
    },
  })

  const alertsTool = defineTool({
    name: 'rmon_alerts',
    description: 'Show the threshold breaches the monitor has recorded since this DSH process started (CPU, memory, swap, disk usage per mount, GPU utilisation, VRAM, GPU temperature, load per core) together with the thresholds currently in force. Use it to answer "is anything wrong right now" without reading every host. '
      + 'Triggers: 告警, 报警, 有没有异常, 阈值, alerts, alarms, anything wrong, threshold.',
    parameters: {
      limit: { type: 'integer', description: 'How many breach groups to show, 1..100 (default 20).' },
    },
    output: REPORT_OUTPUT,
    async execute(args) {
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(100, Math.trunc(args.limit))) : 20
      return { report: renderAlerts(monitor.alerts(limit), book.thresholds(), typeof book.lowUsage === 'function' ? book.lowUsage() : undefined) }
    },
  })

  return [listTool, idleTool, statusTool, gpuTool, processesTool, alertsTool]
}
