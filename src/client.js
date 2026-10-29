/**
 * dsh-remote-monitor — browser half.
 *
 * This file is served verbatim to the web GUI and executed through the shell's
 * module loader, so it is a single self-contained bundle rather than an ES
 * module: it wraps itself in `window.__ModuleLoader__.load({ id, factory })`,
 * takes `react` and `react/jsx-runtime` from the loader-provided `require`, and
 * exports only the cordis plugin contract (`apply`, `inject`).
 *
 * It contributes two seats, exactly like the shell's own pages:
 *   - a row in the sidebar's global panel list (`sidebar.panellist`)
 *   - the page occupying the layout's keyed `main` slot (`main`)
 *
 * Both go through `ctx.slots.inject`, which fires only once the owning shell
 * entry has declared the seat, so load order does not matter and a shell that
 * cannot serve the seats simply shows no panel instead of failing the boot.
 *
 * Live data arrives over the host's SSE stream; no polling runs here. Charts
 * are hand-drawn SVG — a charting dependency would be one more thing to keep
 * working across shells.
 */

window.__ModuleLoader__.load({
  id: 'dsh-remote-monitor',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Panel identity shared by the sidebar row and the main-slot page. */
    const PANEL_ID = 'remote-monitor'
    /** Row order among the shell's global panel rows. */
    const PANEL_ORDER = 45

    const API = {
      hosts: '/api/dsh-remote-monitor/hosts',
      thresholds: '/api/dsh-remote-monitor/thresholds',
      reload: '/api/dsh-remote-monitor/reload',
      snapshot: '/api/dsh-remote-monitor/snapshot',
      history: '/api/dsh-remote-monitor/history',
      alerts: '/api/dsh-remote-monitor/alerts',
      stream: '/api/dsh-remote-monitor/stream',
      test: '/api/dsh-remote-monitor/test',
    }

    /** How many history points the charts keep. */
    const HISTORY_LIMIT = 120

    // ---------------------------------------------------------------- i18n

    const zh = {
      'entry.label': '监控',
      'entry.tooltip': '远程机器资源监控',
      'panel.title': '远程资源监控',
      'panel.subtitle': '通过 SSH 读取 CPU / 内存 / 磁盘 / 网络 / GPU',
      'action.pause': '暂停',
      'action.resume': '继续',
      'action.refresh': '立即刷新',
      'action.reload': '重载主机',
      'action.thresholds': '阈值',
      'action.close': '关闭',
      'action.back': '返回概览',
      'action.test': '测试连接',
      'action.enable': '开启监控',
      'action.disable': '暂停监控',
      'action.save': '保存',
      'action.apply': '应用',
      'view.label': '视图',
      'view.all': '总览 · 全部机器',
      'view.idle': '空闲机器（可调度）',
      'view.gpu': 'GPU 资源',
      'view.alerts': '告警中心',
      'view.hosts': '单机详情',
      'cap.free': '空闲',
      'cap.partial': '部分空余',
      'cap.busy': '占用',
      'cap.unknown': '待采样',
      'cap.offline': '离线',
      'cap.score': '空余度',
      'cap.cpuFree': 'CPU 空余',
      'cap.memFree': '内存空余',
      'cap.gpuFree': '空闲 GPU',
      'cap.freeCores': '空闲核数',
      'cap.freeMem': '空闲内存',
      'cap.freeFor': '持续空闲',
      'cap.schedulable': '可调度',
      'cap.blocked': '不可调度',
      'cap.block.disk': '磁盘 {target} 已用 {value}%',
      'cap.block.mem': '内存已用 {value}%',
      'cap.block.gpu': '全部 {value} 张 GPU 忙',
      'cap.block.load': '每核负载 {value}',
      'cap.stat.schedulable': '台可调度',
      'cap.stat.freeGpu': '张空闲 GPU',
      'cap.stat.freeCores': '核空闲',
      'cap.stat.freeMem': '空闲内存',
      'cap.empty': '当前没有空闲机器。勾选「显示全部」可以看到被占用的机器和占用原因。',
      'cap.showAll': '显示全部机器',
      'cap.hint': '空余度 = GPU / 内存 / CPU 加权（有 GPU 的机器以显卡为主）；磁盘 ≥90% 或内存 ≥90% 视为不可调度；「持续空闲」需连续采样。',
      'idle.index': '空闲指数',
      'idle.indexHint': '空闲指数 = 空闲时长（半衰期 30 分钟）+ 利用率空闲度（GPU 机器取各卡平均，CPU 机器取 CPU%），各占一半。',
      'cap.helpTitle': '这些数字是什么',
      'cap.helpScore': '空余度：这台机器能不能接新任务。GPU / CPU / 内存加权；GPU 机器一张空闲卡都没有时封顶 25。',
      'cap.helpIndex': '空闲指数：这台机器有多闲。空闲时长 + 利用率空闲度各占一半，越高越闲。',
      'cap.helpGpu': '空闲 GPU：利用率 ≤10%、显存 ≤10%，且没有进程占用的卡。',
      'cap.helpBlock': '阻塞项：磁盘 ≥90%、内存 ≥90%、全部 GPU 忙或每核负载 ≥8 时，标为不可调度。',
      'cap.tipCpu': '剩余 CPU 百分比，负载过高会扣分',
      'cap.tipCores': '按剩余 CPU 折算的核数',
      'cap.tipMem': '剩余内存百分比',
      'cap.tipGpu': '完全空闲的 GPU 数（利用率≤10%、显存≤10%、无进程）',
      'cap.tipFree': '连续保持可调度的时长',
      'filter.showDown': '显示不可达',
      'empty.allDown': '当前没有可连接的机器。勾选「显示不可达」可以看到离线主机。',
      'gpu.free': '空闲',
      'gpu.busy': '占用',
      'gpu.idleList': '空闲卡',
      'gpu.noneHere': '没有带 GPU 的主机',
      'foot.label': '机器空余',
      'foot.idle': '空闲',
      'foot.gpu': '空闲 GPU',
      'foot.low': '低使用率',
      'foot.none': '暂无机器',
      'foot.refresh': '每 {sec} 秒自动刷新 · 点击收起',
      'foot.polling': '正在采样…',
      'foot.updated': '{s} 秒前更新',
      'foot.off': '提醒已关闭',
      'low.section': '低使用率提醒',
      'low.hint': '机器连续空闲超过设定时长时记一条提醒。分钟数最小 1；用开关关闭。',
      'low.enabled': '启用低使用率提醒',
      'low.cpu': 'CPU 低于 %（无 GPU 机器）',
      'low.gpu': 'GPU 平均低于 %（有 GPU 机器）',
      'low.for': '持续（分钟）',
      'low.alert': '低使用率：已空闲 {min} 分钟（{value}% ≤ {threshold}%）',
      'low.tag': '低使用率',
      'alerts.host': '主机',
      'alerts.noneHere': '当前没有阈值告警。',
      'state.pausedShort': '暂停',
      'state.live': '实时',
      'state.paused': '已暂停',
      'state.idle': '空闲（轮询已停止）',
      'state.connecting': '连接中…',
      'summary.hosts': '台主机',
      'summary.monitored': '台监控中',
      'summary.alerts': '条告警',
      'empty.title': '没有发现任何主机',
      'empty.body': '把机器写进 ~/.ssh/config，或在 dsh-ssh 插件里配置，然后点「重载主机」。',
      'empty.loading': '正在读取主机列表…',
      'host.notRead': '尚未读取',
      'host.ok': '正常',
      'host.down': '不可达',
      'host.off': '已暂停',
      'host.retryIn': '秒后重试',
      'metric.cpu': 'CPU',
      'metric.mem': '内存',
      'metric.swap': 'Swap',
      'metric.load': '负载',
      'metric.disk': '磁盘',
      'metric.net': '网络',
      'metric.gpu': 'GPU',
      'section.disk': '磁盘使用',
      'section.diskIo': '磁盘 IO',
      'section.net': '网络',
      'section.gpu': 'GPU',
      'section.processes': '进程',
      'section.system': '系统',
      'table.mount': '挂载点',
      'table.used': '已用',
      'table.size': '总量',
      'table.use': '占用',
      'table.device': '设备',
      'table.read': '读',
      'table.write': '写',
      'table.busy': '繁忙',
      'table.nic': '网卡',
      'table.rx': '接收',
      'table.tx': '发送',
      'table.total': '累计',
      'table.pid': 'PID',
      'table.name': '名称',
      'table.cpu': 'CPU',
      'table.mem': '内存',
      'table.rss': 'RSS',
      'table.command': '命令',
      'proc.byCpu': '按 CPU',
      'proc.expandHint': '点击展开完整命令',
      'proc.byMem': '按内存',
      'gpu.none': '未检测到 NVIDIA 显卡',
      'gpu.mem': '显存',
      'gpu.temp': '温度',
      'gpu.power': '功耗',
      'gpu.fan': '风扇',
      'gpu.procs': '占用进程',
      'thr.title': '告警阈值',
      'thr.hint': '达到或超过阈值即告警；填 0 关闭该项。',
      'thr.cpu': 'CPU %',
      'thr.mem': '内存 %',
      'thr.swap': 'Swap %',
      'thr.disk': '磁盘 %',
      'thr.gpu': 'GPU 利用率 %',
      'thr.gpuMem': '显存 %',
      'thr.temp': 'GPU 温度 °C',
      'thr.loadPerCore': '每核负载 %',
      'alerts.none': '没有告警',
      'alerts.title': '告警',
      'error.prefix': '出错：',
      'source.title': '主机来源',
      'source.count': '条',
      'rates.note': '百分比为两次采样之间的区间值；首次读取只给绝对值。',
      'noRates': '速率待下一轮采样',
    }

    const en = {
      'entry.label': 'Monitor',
      'entry.tooltip': 'Remote host resource monitor',
      'panel.title': 'Remote resource monitor',
      'panel.subtitle': 'CPU / memory / disk / network / GPU over SSH',
      'action.pause': 'Pause',
      'action.resume': 'Resume',
      'action.refresh': 'Refresh now',
      'action.reload': 'Reload hosts',
      'action.thresholds': 'Thresholds',
      'action.close': 'Close',
      'action.back': 'Back to overview',
      'action.test': 'Test connection',
      'action.enable': 'Monitor',
      'action.disable': 'Pause',
      'action.save': 'Save',
      'action.apply': 'Apply',
      'view.label': 'View',
      'view.all': 'Overview · all hosts',
      'view.idle': 'Idle machines (schedulable)',
      'view.gpu': 'GPU resources',
      'view.alerts': 'Alert center',
      'view.hosts': 'Host detail',
      'cap.free': 'idle',
      'cap.partial': 'partial',
      'cap.busy': 'busy',
      'cap.unknown': 'no sample',
      'cap.offline': 'offline',
      'cap.score': 'Free capacity',
      'cap.cpuFree': 'CPU free',
      'cap.memFree': 'Memory free',
      'cap.gpuFree': 'Free GPU',
      'cap.freeCores': 'Free cores',
      'cap.freeMem': 'Free memory',
      'cap.freeFor': 'Idle for',
      'cap.schedulable': 'schedulable',
      'cap.blocked': 'blocked',
      'cap.block.disk': 'disk {target} at {value}%',
      'cap.block.mem': 'memory at {value}%',
      'cap.block.gpu': 'all {value} GPUs busy',
      'cap.block.load': 'load {value}/core',
      'cap.stat.schedulable': 'schedulable',
      'cap.stat.freeGpu': 'GPUs free',
      'cap.stat.freeCores': 'cores free',
      'cap.stat.freeMem': 'memory free',
      'cap.empty': 'No machine has spare capacity right now. Tick "all hosts" to see what is holding them.',
      'cap.showAll': 'Show all hosts',
      'cap.hint': 'Headroom = GPU / memory / CPU weighted (the GPU dominates on a GPU host); a disk ≥90% or memory ≥90% is not schedulable; "idle for" needs consecutive samples.',
      'idle.index': 'Idle index',
      'idle.indexHint': 'Idle index = idle time (30 min half-life) + utilisation headroom (mean GPU, or CPU% on a CPU host), 50/50.',
      'cap.helpTitle': 'What do these numbers mean',
      'cap.helpScore': 'Free capacity: can this host take a new job? GPU / CPU / memory weighted; capped at 25 when a GPU host has no free card.',
      'cap.helpIndex': 'Idle index: how idle the host is. Idle time and utilisation headroom, 50/50; higher means idler.',
      'cap.helpGpu': 'Free GPUs: utilisation ≤10%, VRAM ≤10%, and no process holding the card.',
      'cap.helpBlock': 'Blocked when a disk is ≥90%, memory ≥90%, every GPU is busy, or load is ≥8/core.',
      'cap.tipCpu': 'CPU headroom; a queue on the host lowers it',
      'cap.tipCores': 'Cores free, derived from the CPU headroom',
      'cap.tipMem': 'Memory headroom',
      'cap.tipGpu': 'Cards that are completely free (≤10% util, ≤10% VRAM, no processes)',
      'cap.tipFree': 'How long it has stayed schedulable',
      'filter.showDown': 'Show unreachable',
      'empty.allDown': 'No reachable machine right now. Tick "Show unreachable" to see the offline hosts.',
      'gpu.free': 'free',
      'gpu.busy': 'busy',
      'gpu.idleList': 'idle cards',
      'gpu.noneHere': 'No host reports a GPU',
      'foot.label': 'Idle',
      'foot.idle': 'idle',
      'foot.gpu': 'free GPU',
      'foot.low': 'low usage',
      'foot.none': 'No host',
      'foot.refresh': 'refreshes every {sec}s · click to collapse',
      'foot.polling': 'sampling…',
      'foot.updated': 'updated {s}s ago',
      'foot.off': 'reminder off',
      'low.section': 'Low-utilisation reminder',
      'low.hint': 'Warn when a machine has been idle for longer than this. Minimum 1 minute; switch it off with the toggle.',
      'low.enabled': 'Enable low-utilisation reminder',
      'low.cpu': 'CPU below % (CPU-only hosts)',
      'low.gpu': 'GPU average below % (GPU hosts)',
      'low.for': 'For (minutes)',
      'low.alert': 'Low usage: idle for {min}m ({value}% ≤ {threshold}%)',
      'low.tag': 'low usage',
      'alerts.host': 'Host',
      'alerts.noneHere': 'No threshold alerts right now.',
      'state.pausedShort': 'paused',
      'state.live': 'live',
      'state.paused': 'paused',
      'state.idle': 'idle (polling stopped)',
      'state.connecting': 'connecting…',
      'summary.hosts': 'hosts',
      'summary.monitored': 'monitored',
      'summary.alerts': 'alerts',
      'empty.title': 'No hosts found',
      'empty.body': 'Add a machine to ~/.ssh/config, or configure it in the dsh-ssh plugin, then press "Reload hosts".',
      'empty.loading': 'Loading host list…',
      'host.notRead': 'not read yet',
      'host.ok': 'ok',
      'host.down': 'unreachable',
      'host.off': 'paused',
      'host.retryIn': 's until retry',
      'metric.cpu': 'CPU',
      'metric.mem': 'Memory',
      'metric.swap': 'Swap',
      'metric.load': 'Load',
      'metric.disk': 'Disk',
      'metric.net': 'Network',
      'metric.gpu': 'GPU',
      'section.disk': 'Disk usage',
      'section.diskIo': 'Disk IO',
      'section.net': 'Network',
      'section.gpu': 'GPU',
      'section.processes': 'Processes',
      'section.system': 'System',
      'table.mount': 'Mount',
      'table.used': 'Used',
      'table.size': 'Size',
      'table.use': 'Use',
      'table.device': 'Device',
      'table.read': 'Read',
      'table.write': 'Write',
      'table.busy': 'Busy',
      'table.nic': 'Interface',
      'table.rx': 'RX',
      'table.tx': 'TX',
      'table.total': 'Total',
      'table.pid': 'PID',
      'table.name': 'Name',
      'table.cpu': 'CPU',
      'table.mem': 'Mem',
      'table.rss': 'RSS',
      'table.command': 'Command',
      'proc.byCpu': 'by CPU',
      'proc.expandHint': 'Click to show the full command',
      'proc.byMem': 'by memory',
      'gpu.none': 'No NVIDIA GPU detected',
      'gpu.mem': 'VRAM',
      'gpu.temp': 'Temp',
      'gpu.power': 'Power',
      'gpu.fan': 'Fan',
      'gpu.procs': 'Processes',
      'thr.title': 'Alert thresholds',
      'thr.hint': 'An alert fires at or above the threshold; 0 disables the rule.',
      'thr.cpu': 'CPU %',
      'thr.mem': 'Memory %',
      'thr.swap': 'Swap %',
      'thr.disk': 'Disk %',
      'thr.gpu': 'GPU util %',
      'thr.gpuMem': 'VRAM %',
      'thr.temp': 'GPU temp °C',
      'thr.loadPerCore': 'Load per core %',
      'alerts.none': 'No alerts',
      'alerts.title': 'Alerts',
      'error.prefix': 'Error: ',
      'source.title': 'Host sources',
      'source.count': ' rows',
      'rates.note': 'Percentages describe the interval between two reads; the first read reports gauges only.',
      'noRates': 'rates on next read',
    }

    /** Language chosen once from the document, with a Chinese-script fallback. */
    const LANGUAGE = (() => {
      try {
        const lang = String(navigator.language || document.documentElement.lang || 'en').toLowerCase()
        return lang.startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'en'
      }
    })()

    /** Translate a key. */
    function tt(key) {
      const table = LANGUAGE === 'zh' ? zh : en
      return table[key] ?? en[key] ?? key
    }

    // ------------------------------------------------------------ formatting

    /** Format a byte count. */
    function bytes(value, digits = 1) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
      let size = Math.abs(value)
      let unit = 0
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024
        unit += 1
      }
      return `${value < 0 ? '-' : ''}${size.toFixed(unit === 0 ? 0 : digits)} ${units[unit]}`
    }

    /** Format a per-second byte rate. */
    function rate(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return bytes(value, 1) + '/s'
    }

    /** Format a percentage. */
    function percent(value, digits = 1) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return value.toFixed(digits) + '%'
    }

    /** Format an uptime in seconds. */
    function uptime(seconds) {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '—'
      const total = Math.max(0, Math.floor(seconds))
      const days = Math.floor(total / 86400)
      const hours = Math.floor((total % 86400) / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      return (days > 0 ? days + 'd ' : '') + (days > 0 || hours > 0 ? hours + 'h ' : '') + minutes + 'm'
    }

    /** Format a clock time. */
    function clock(epochMs) {
      if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return '—'
      const date = new Date(epochMs)
      const pad = value => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** Traffic colours: readable on a light and a dark surface. */
    const TONE = {
      ok: '#22a06b',
      warn: '#d98324',
      bad: '#d64545',
      info: '#3b7dd8',
      violet: '#8b5cf6',
      neutral: 'currentColor',
    }

    /** Pick a status tone for a percentage. */
    function toneFor(value, threshold) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return TONE.neutral
      if (typeof threshold === 'number' && threshold > 0 && value >= threshold) return TONE.bad
      if (typeof threshold === 'number' && threshold > 0 && value >= threshold * 0.85) return TONE.warn
      return TONE.ok
    }

    // ------------------------------------------------------------------ CSS

    const STYLE_ID = 'dsh-remote-monitor-style'

    const CSS = `
.drm-root{display:flex;flex-direction:column;gap:14px;padding:18px 20px 40px;min-height:100%;max-height:100%;height:100%;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,currentColor 25%,transparent) transparent;box-sizing:border-box;color:var(--drm-fg,inherit);font-size:13px}
.drm-root::-webkit-scrollbar{width:10px}
.drm-root::-webkit-scrollbar-thumb{background:color-mix(in srgb,currentColor 24%,transparent);border-radius:6px;border:2px solid transparent;background-clip:content-box}
.drm-root::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,currentColor 40%,transparent);background-clip:content-box}
.drm-root::-webkit-scrollbar-track{background:transparent}
.drm-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;position:sticky;top:-18px;z-index:6;padding:18px 0 10px;margin-top:-18px;background:color-mix(in srgb,Canvas 90%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid color-mix(in srgb,currentColor 8%,transparent)}
.drm-title{font-size:17px;font-weight:650;margin:0}
.drm-sub{font-size:12px;opacity:.6;margin:2px 0 0}
.drm-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.drm-btn{appearance:none;border:1px solid color-mix(in srgb,currentColor 20%,transparent);background:color-mix(in srgb,currentColor 5%,transparent);color:inherit;border-radius:7px;padding:5px 11px;font-size:12px;cursor:pointer;line-height:1.6}
.drm-btn:hover{background:color-mix(in srgb,currentColor 11%,transparent)}
.drm-btn:disabled{opacity:.45;cursor:not-allowed}
.drm-btn[data-primary="1"]{background:color-mix(in srgb,${TONE.info} 18%,transparent);border-color:color-mix(in srgb,${TONE.info} 45%,transparent)}
.drm-pill{display:inline-flex;align-items:center;gap:5px;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:999px;padding:3px 10px;font-size:11.5px;opacity:.9}
.drm-dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.drm-stats{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;opacity:.75}
.drm-banner{border:1px solid color-mix(in srgb,${TONE.warn} 45%,transparent);background:color-mix(in srgb,${TONE.warn} 12%,transparent);border-radius:9px;padding:9px 13px;font-size:12px;display:flex;flex-direction:column;gap:3px}
.drm-banner[data-level="critical"]{border-color:color-mix(in srgb,${TONE.bad} 50%,transparent);background:color-mix(in srgb,${TONE.bad} 12%,transparent)}
.drm-grid{display:grid;gap:13px;grid-template-columns:repeat(auto-fill,minmax(310px,1fr))}
.drm-card{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:11px;padding:13px 14px;background:color-mix(in srgb,currentColor 3%,transparent);display:flex;flex-direction:column;gap:10px;cursor:pointer;transition:border-color .12s,transform .12s}
.drm-card:hover{border-color:color-mix(in srgb,currentColor 30%,transparent);transform:translateY(-1px)}
.drm-card[data-down="1"]{border-color:color-mix(in srgb,${TONE.bad} 45%,transparent)}
.drm-card[data-off="1"]{opacity:.55}
.drm-cardhead{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.drm-hostname{font-weight:620;font-size:13.5px;display:flex;align-items:center;gap:7px;word-break:break-all}
.drm-target{font-size:11.5px;opacity:.6;margin-top:2px;word-break:break-all}
.drm-metrics{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.drm-metric{display:flex;flex-direction:column;gap:4px;min-width:0}
.drm-metriclabel{font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;opacity:.55;display:flex;justify-content:space-between;gap:6px}
.drm-metricvalue{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
.drm-metricsub{font-size:11px;opacity:.6}
.drm-bar{height:5px;border-radius:3px;background:color-mix(in srgb,currentColor 13%,transparent);overflow:hidden}
.drm-barfill{height:100%;border-radius:3px;transition:width .3s}
.drm-gpuchips{display:flex;gap:6px;flex-wrap:wrap}
.drm-chip{border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:6px;padding:3px 7px;font-size:11px;display:flex;gap:5px;align-items:center;font-variant-numeric:tabular-nums}
.drm-chip b{font-weight:620}
.drm-empty{text-align:center;padding:56px 20px;opacity:.7}
.drm-panel{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:11px;padding:13px 15px;display:flex;flex-direction:column;gap:11px}
.drm-paneltitle{font-size:12px;font-weight:620;letter-spacing:.03em;text-transform:uppercase;opacity:.6}
.drm-table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
.drm-table th{text-align:left;font-weight:560;opacity:.55;padding:3px 10px 5px 0;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
.drm-table td{padding:3px 10px 3px 0;border-top:1px solid color-mix(in srgb,currentColor 9%,transparent);vertical-align:top}
.drm-table td.drm-num{text-align:right}
.drm-cmd{opacity:.62;display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
.drm-proctable{table-layout:fixed;width:100%}
.drm-proctable th,.drm-proctable td{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:6px}
.drm-proctable td.drm-cmdcell{opacity:.7}
.drm-procrow{cursor:pointer}
.drm-procrow:hover td{background:color-mix(in srgb,currentColor 5%,transparent)}
.drm-procrow[data-open="1"] td{background:color-mix(in srgb,currentColor 6%,transparent)}
.drm-cmdfull{padding:0!important;border-top:none!important}
.drm-cmdfull pre{margin:0 0 4px;padding:7px 9px;border-radius:7px;background:color-mix(in srgb,currentColor 5%,transparent);font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.85;max-height:180px;overflow:auto}
.drm-detailgrid > *{min-width:0}
.drm-detail{display:flex;flex-direction:column;gap:13px}
.drm-detailgrid{display:grid;gap:13px;grid-template-columns:repeat(auto-fit,minmax(330px,1fr))}
.drm-chartrow{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:13px}
.drm-chart{border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:9px;padding:9px 11px;display:flex;flex-direction:column;gap:6px}
.drm-chartlabel{font-size:11px;opacity:.6;display:flex;justify-content:space-between;gap:8px}
.drm-chartvalue{font-size:16px;font-weight:620;font-variant-numeric:tabular-nums}
.drm-dialog{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:60;padding:20px}
.drm-dialogbox{background:var(--drm-dialog-bg,#fff);color:var(--drm-dialog-fg,#111);border-radius:12px;padding:18px 20px;min-width:320px;max-width:460px;max-height:calc(100vh - 40px);overflow-y:auto;display:flex;flex-direction:column;gap:12px;box-shadow:0 18px 50px rgba(0,0,0,.35)}
@media (prefers-color-scheme:dark){.drm-dialogbox{background:#1d1f24;color:#eee}}
.drm-field{display:flex;justify-content:space-between;align-items:center;gap:12px}
.drm-field input{width:96px;padding:4px 7px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 24%,transparent);background:transparent;color:inherit;font:inherit;font-variant-numeric:tabular-nums}
.drm-alertlist{display:flex;flex-direction:column;gap:3px;font-size:12px}
.drm-alertrow{display:flex;gap:8px;align-items:baseline}
.drm-tag{font-size:10.5px;padding:1px 6px;border-radius:5px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);opacity:.75}
.drm-sources{font-size:11px;opacity:.55;display:flex;gap:14px;flex-wrap:wrap}
.drm-note{font-size:11px;opacity:.5}
.drm-svg{display:block;width:100%;height:auto;overflow:visible}
.drm-select{appearance:none;border:1px solid color-mix(in srgb,currentColor 20%,transparent);background-color:color-mix(in srgb,currentColor 5%,transparent);color:inherit;border-radius:7px;padding:5px 26px 5px 10px;font:inherit;font-size:12px;cursor:pointer;max-width:280px;line-height:1.6;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 14px) 52%,calc(100% - 9px) 52%;background-size:5px 5px,5px 5px;background-repeat:no-repeat}
.drm-select:hover{background-color:color-mix(in srgb,currentColor 10%,transparent)}
.drm-select option,.drm-select optgroup{background:Canvas;color:CanvasText}
.drm-badge{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:2px 9px;font-size:10.5px;font-weight:620;letter-spacing:.02em;border:1px solid color-mix(in srgb,var(--tone) 52%,transparent);background:color-mix(in srgb,var(--tone) 13%,transparent);color:var(--tone);white-space:nowrap}
.drm-badge .drm-dot{background:var(--tone)}
.drm-statgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(126px,1fr));gap:10px}
.drm-stat{border:1px solid color-mix(in srgb,currentColor 13%,transparent);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:2px;background:color-mix(in srgb,currentColor 3%,transparent)}
.drm-stat b{font-size:20px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.15}
.drm-stat span{font-size:11px;opacity:.6}
.drm-capbar{height:7px;border-radius:4px;background:color-mix(in srgb,currentColor 13%,transparent);overflow:hidden}
.drm-capbar > i{display:block;height:100%;border-radius:4px;transition:width .3s}
.drm-capblock{display:flex;flex-direction:column;gap:6px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:10px;padding:10px 12px;background:color-mix(in srgb,currentColor 2.5%,transparent)}
.drm-caphead{display:flex;justify-content:space-between;align-items:baseline;gap:10px;font-size:11.5px;position:relative}
.drm-helpwrap{position:relative;display:inline-flex}
.drm-helpbtn{width:15px;height:15px;padding:0;border-radius:50%;border:1px solid color-mix(in srgb,currentColor 25%,transparent);background:none;color:inherit;font-size:10px;line-height:13px;cursor:pointer;opacity:.55;font-family:inherit}
.drm-helpbtn:hover{opacity:1;background:color-mix(in srgb,currentColor 8%,transparent)}
.drm-helppop{position:absolute;left:0;top:20px;z-index:40;width:264px;display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:10px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:Canvas;color:CanvasText;box-shadow:0 12px 32px rgba(0,0,0,.22);font-size:11px;line-height:1.55;font-weight:400}
.drm-helphead{font-weight:620;font-size:11.5px}
.drm-helprow{opacity:.8}
.drm-caphead b{font-size:17px;font-variant-numeric:tabular-nums}
.drm-idlewrap{display:flex;flex-direction:column;gap:9px}
.drm-idlerow{display:grid;grid-template-columns:minmax(190px,1.3fr) minmax(140px,1.1fr) minmax(110px,.8fr) minmax(120px,.9fr) minmax(96px,.6fr) auto;gap:12px;align-items:center;border:1px solid color-mix(in srgb,currentColor 13%,transparent);border-radius:10px;padding:9px 12px;background:color-mix(in srgb,currentColor 2.5%,transparent);cursor:pointer;transition:border-color .12s,background .12s}
.drm-idlerow:hover{border-color:color-mix(in srgb,currentColor 30%,transparent);background:color-mix(in srgb,currentColor 5%,transparent)}
.drm-idlerow[data-state="free"]{border-color:color-mix(in srgb,${TONE.ok} 38%,transparent)}
.drm-idlerow[data-state="busy"]{opacity:.72}
.drm-idlerow[data-state="offline"]{opacity:.5}
.drm-idlerow[data-state="partial"]{border-color:color-mix(in srgb,${TONE.warn} 32%,transparent)}
.drm-mini{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;opacity:.65}
.drm-mini b{font-weight:620;opacity:.95}
.drm-blockerline{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.drm-gpucell{display:flex;flex-direction:column;gap:4px;min-width:0}
.drm-gpucellhead{display:flex;justify-content:space-between;gap:8px;font-size:11px;opacity:.65}
.drm-gpucards{display:grid;grid-template-columns:repeat(auto-fill,minmax(228px,1fr));gap:11px}
.drm-panelhead{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}
.drm-gpulist{display:flex;flex-direction:column;gap:1px;max-height:300px;overflow-y:auto;scrollbar-width:thin}
.drm-gpurow{display:grid;grid-template-columns:58px minmax(0,1fr) minmax(56px,110px) 44px 148px 42px 50px 30px;gap:8px;align-items:center;font-size:11.5px;padding:3px 4px;border-radius:6px;font-variant-numeric:tabular-nums}
.drm-gpurow:hover{background:color-mix(in srgb,currentColor 5%,transparent)}
.drm-gpurow[data-free="1"]{background:color-mix(in srgb,${TONE.ok} 8%,transparent)}
.drm-gpuidx{font-weight:620}
.drm-gpuname{opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.drm-gpupbar{height:5px;border-radius:3px;background:color-mix(in srgb,currentColor 12%,transparent);overflow:hidden}
.drm-gpupbar > i{display:block;height:100%;border-radius:3px}
.drm-gpuutil{font-weight:620;text-align:right}
.drm-gpuvram,.drm-gputemp,.drm-gpupower{opacity:.65;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.drm-gpuprocs{opacity:.55;text-align:right}
.drm-collapsehead{display:flex;align-items:center;gap:8px;width:100%;padding:0;border:none;background:none;color:inherit;font:inherit;cursor:pointer;text-align:left}
.drm-collapsearrow{width:12px;font-size:10px;opacity:.6;flex:none}
.drm-collapsemeta{margin-left:auto;font-size:11px;opacity:.5;flex:none}
.drm-collapsebody{display:flex;flex-direction:column;gap:10px;margin-top:10px}
.drm-collapsible{padding:11px 13px;gap:0}
@media (max-width:1200px){.drm-gpurow{grid-template-columns:54px minmax(0,1fr) 60px 42px 110px 40px 46px 26px}}
.drm-gpucard{border:1px solid color-mix(in srgb,currentColor 13%,transparent);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:7px;background:color-mix(in srgb,currentColor 2.5%,transparent);cursor:pointer}
.drm-gpucard:hover{border-color:color-mix(in srgb,currentColor 30%,transparent)}
.drm-gpucard[data-free="1"]{border-color:color-mix(in srgb,${TONE.ok} 40%,transparent)}
.drm-chipfree{border-color:color-mix(in srgb,${TONE.ok} 55%,transparent);background:color-mix(in srgb,${TONE.ok} 10%,transparent)}
.drm-sectiontitle{font-size:12px;font-weight:620;letter-spacing:.03em;text-transform:uppercase;opacity:.6;display:flex;justify-content:space-between;align-items:center;gap:10px}
.drm-check{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;opacity:.8;cursor:pointer;user-select:none}
.drm-check input{accent-color:currentColor}
@media (max-width:900px){.drm-idlerow{grid-template-columns:1fr 1fr}.drm-idlerow > div:first-child{grid-column:1 / -1}}
.drm-foot{display:flex;flex-direction:column;gap:6px;width:100%;min-width:0;font-size:11.5px;color:inherit}
.drm-footrow{display:flex;align-items:center;gap:7px;padding:5px 8px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:8px;background:color-mix(in srgb,currentColor 3.5%,transparent);white-space:nowrap;overflow:hidden;min-width:0}
.drm-footrow .drm-dot{width:6px;height:6px}
.drm-footcount{font-weight:620;font-variant-numeric:tabular-nums;flex:none}
.drm-foothead{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;row-gap:1px;padding:0 2px;font-size:10.5px}
.drm-footlabel{font-weight:620;flex:none}
.drm-footwarn{color:${TONE.warn};font-weight:620;flex:none}
.drm-footsummary{margin-left:auto;opacity:.6;white-space:nowrap;font-variant-numeric:tabular-nums}
.drm-footage{opacity:.4;font-size:10px;white-space:nowrap;font-variant-numeric:tabular-nums}
.drm-footscroll{display:flex;flex-direction:column;gap:1px;max-height:212px;overflow-y:auto;scrollbar-width:thin;border-top:1px solid color-mix(in srgb,currentColor 10%,transparent);padding-top:3px}
.drm-footscroll::-webkit-scrollbar{width:7px}
.drm-footscroll::-webkit-scrollbar-thumb{background:color-mix(in srgb,currentColor 22%,transparent);border-radius:4px}
.drm-footitem{display:grid;grid-template-columns:7px minmax(0,1fr) auto;column-gap:6px;align-items:center;padding:3px 5px;border-radius:6px;min-width:0}
.drm-footitem:hover{background:color-mix(in srgb,currentColor 6%,transparent)}
.drm-footitem[data-low="1"]{background:color-mix(in srgb,${TONE.warn} 8%,transparent)}
.drm-footdot{width:6px;height:6px;border-radius:50%;flex:none}
.drm-footalias{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px}
.drm-footidx{font-variant-numeric:tabular-nums;font-weight:620;font-size:11.5px}
.drm-footmeta{grid-column:2 / 4;font-size:10px;opacity:.55;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums;margin-top:-1px}
.drm-footempty{opacity:.5;font-size:10.5px;padding:4px 2px}
`

    /** Inject the stylesheet once. */
    function ensureStyle() {
      try {
        if (document.getElementById(STYLE_ID) !== null) return
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
      } catch {
        // A missing stylesheet degrades looks, never function.
      }
    }

    // -------------------------------------------------------------- api client

    /** Read a JSON response, surfacing the route's error message. */
    async function requestJson(url, init) {
      const response = await fetch(url, { credentials: 'same-origin', ...init })
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok) {
        const message = body !== null && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`
        throw new Error(message)
      }
      return body
    }

    // ------------------------------------------------------------- components

    /**
     * A sparkline with a filled area. Values are plain numbers; nulls create a
     * gap so a period without a reading is visible rather than drawn as zero.
     * @param {object} props - values, colour and geometry.
     * @returns {React.ReactElement} the chart.
     */
    function Sparkline({ values, max, color, height = 34 }) {
      const width = 200
      const points = Array.isArray(values) ? values : []
      const known = points.filter(value => typeof value === 'number' && Number.isFinite(value))
      const ceiling = max !== undefined && max > 0
        ? max
        : Math.max(1, known.length > 0 ? Math.max(...known) : 1) * 1.15
      const step = points.length > 1 ? width / (points.length - 1) : width
      const y = value => height - Math.max(0, Math.min(1, value / ceiling)) * (height - 2) - 1

      let path = ''
      let open = false
      let firstX = null
      let lastX = null
      points.forEach((value, index) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          open = false
          return
        }
        const x = index * step
        if (!open) {
          path += `${path === '' ? '' : ' '}M${x.toFixed(1)},${y(value).toFixed(1)}`
          open = true
          if (firstX === null) firstX = x
        } else {
          path += ` L${x.toFixed(1)},${y(value).toFixed(1)}`
        }
        lastX = x
      })
      const area = firstX !== null && lastX !== null && lastX > firstX
        ? `${path} L${lastX.toFixed(1)},${height} L${firstX.toFixed(1)},${height} Z`
        : null

      return h('svg', { className: 'drm-svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', style: { height: `${height}px` } },
        area !== null ? h('path', { d: area, fill: color, opacity: 0.13, stroke: 'none' }) : null,
        path === '' ? null : h('path', { d: path, fill: 'none', stroke: color, strokeWidth: 1.6, strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke' }),
        h('line', { x1: 0, y1: height - 0.5, x2: width, y2: height - 0.5, stroke: 'currentColor', opacity: 0.14, strokeWidth: 1, vectorEffect: 'non-scaling-stroke' }))
    }

    /** A labelled percentage bar. */
    function MetricBar({ label, value, threshold, detail }) {
      const tone = toneFor(value, threshold)
      return h('div', { className: 'drm-metric' },
        h('div', { className: 'drm-metriclabel' }, h('span', null, label), detail !== undefined ? h('span', null, detail) : null),
        h('div', { className: 'drm-metricvalue' }, percent(value)),
        h('div', { className: 'drm-bar' }, h('div', { className: 'drm-barfill', style: { width: `${Math.max(0, Math.min(100, value ?? 0))}%`, background: tone } })))
    }

    /** One chart tile in the detail view. */
    function ChartTile({ label, value, series, color, max }) {
      return h('div', { className: 'drm-chart' },
        h('div', { className: 'drm-chartlabel' }, h('span', null, label), h('span', null, value)),
        h(Sparkline, { values: series, color, max }))
    }

    /** Status tone for a host payload. */
    function hostTone(host) {
      if (host.monitor === false) return TONE.neutral
      if (host.status === 'ok') return TONE.ok
      if (host.status === 'down') return TONE.bad
      return TONE.warn
    }

    /** Status text for a host payload. */
    function hostStateText(host) {
      if (host.monitor === false) return tt('host.off')
      if (host.status === 'ok') return tt('host.ok')
      if (host.status === 'down') return tt('host.down')
      return tt('host.notRead')
    }

    /** Highest disk usage across mounts. */
    function maxDisk(host) {
      const mounts = Array.isArray(host.disks) ? host.disks : []
      if (mounts.length === 0) return null
      return mounts.reduce((max, mount) => (typeof mount.usePercent === 'number' && mount.usePercent > (max ?? -1) ? mount.usePercent : max), null)
    }

    /** Combined network rate. */
    function netRate(host, key) {
      const nics = Array.isArray(host.net) ? host.net : []
      const values = nics.map(nic => nic[key]).filter(value => typeof value === 'number' && Number.isFinite(value))
      return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0)
    }

    /** Compact duration, e.g. `42s`, `3m`, `2h 10m`. */
    function duration(seconds) {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '—'
      if (seconds < 90) return `${Math.round(seconds)}s`
      const minutes = Math.round(seconds / 60)
      if (minutes < 90) return `${minutes}m`
      const hours = Math.floor(minutes / 60)
      return `${hours}h${minutes % 60 > 0 ? ` ${minutes % 60}m` : ''}`
    }

    /** Colour for a host's spare-capacity view. */
    function capacityTone(host) {
      const capacity = host.capacity
      if (host.status !== 'ok' || capacity === null || capacity === undefined || capacity.state === 'unknown') return TONE.neutral
      if (capacity.state === 'free') return capacity.blockers.length === 0 ? TONE.ok : TONE.warn
      if (capacity.state === 'partial') return TONE.warn
      return TONE.bad
    }

    /** Colour for the idle index: greener = the machine is sitting idle. */
    function idleIndexTone(index) {
      if (typeof index !== 'number' || !Number.isFinite(index)) return TONE.neutral
      if (index >= 70) return TONE.ok
      if (index >= 40) return TONE.warn
      return TONE.neutral
    }

    /** Localized label for a host's spare-capacity view. */
    function capacityLabel(host) {
      const capacity = host.capacity
      if (host.monitor === false) return tt('host.off')
      if (host.status !== 'ok') return tt('cap.offline')
      if (capacity === null || capacity === undefined || capacity.state === 'unknown') return tt('cap.unknown')
      if (capacity.state === 'busy') return tt('cap.busy')
      if (Array.isArray(capacity.blockers) && capacity.blockers.length > 0) return tt('cap.blocked')
      return tt('cap.' + capacity.state)
    }

    /** Localized blocker text. */
    function blockerText(blocker) {
      if (blocker.code === 'disk') return tt('cap.block.disk').replace('{target}', blocker.target ?? '').replace('{value}', blocker.value)
      if (blocker.code === 'mem') return tt('cap.block.mem').replace('{value}', blocker.value)
      if (blocker.code === 'gpu') return tt('cap.block.gpu').replace('{value}', blocker.value)
      if (blocker.code === 'load') return tt('cap.block.load').replace('{value}', blocker.value)
      return `${blocker.code} ${blocker.value}`
    }

    /** Human text for one alert (the low-usage alert is localized here). */
    function alertText(alert) {
      if (alert.key === 'low-usage' && typeof alert.forSec === 'number') {
        return tt('low.alert')
          .replace('{min}', String(Math.max(1, Math.round(alert.forSec / 60))))
          .replace('{value}', alert.value ?? '—')
          .replace('{threshold}', alert.threshold ?? '—')
      }
      return alert.message
    }

    /** Free GPUs as `2/4 (GPU0,GPU1)`. */
    function freeGpuText(capacity) {
      if (capacity === null || capacity === undefined || (capacity.gpuTotal ?? 0) === 0) return '—'
      const indexes = Array.isArray(capacity.freeGpuIndexes) && capacity.freeGpuIndexes.length > 0
        ? ` (GPU${capacity.freeGpuIndexes.join(',')})`
        : ''
      return `${capacity.gpuFree}/${capacity.gpuTotal}${indexes}`
    }

    /** The idle/partial/busy badge. */
    function CapacityBadge({ host, showIdle }) {
      const tone = capacityTone(host)
      const capacity = host.capacity
      return h('span', { className: 'drm-badge', style: { '--tone': tone }, title: capacity?.blockers?.map(blockerText).join(' · ') ?? undefined },
        h('span', { className: 'drm-dot' }),
        capacityLabel(host),
        showIdle === true && host.status === 'ok' && (host.idleForSec ?? 0) >= 60 ? h('span', { style: { opacity: .7, fontWeight: 500 } }, ` · ${duration(host.idleForSec)}`) : null)
    }

    /**
     * The "?" next to the capacity numbers: a small popover that explains what
     * free capacity, idle index and the rest actually mean. Native tooltips
     * were too easy to miss and could not hold the whole explanation.
     */
    function CapacityHelp() {
      const [open, setOpen] = React.useState(false)
      const rows = [
        ['cap.helpScore', tt('cap.helpScore')],
        ['cap.helpIndex', tt('cap.helpIndex')],
        ['cap.helpGpu', tt('cap.helpGpu')],
        ['cap.helpBlock', tt('cap.helpBlock')],
      ]
      return h('span', { className: 'drm-helpwrap' },
        h('button', {
          type: 'button',
          className: 'drm-helpbtn',
          'aria-expanded': open ? 'true' : 'false',
          title: tt('cap.helpTitle'),
          onClick: event => { event.stopPropagation(); setOpen(value => !value) },
        }, '?'),
        open
          ? h('div', { className: 'drm-helppop', onClick: event => event.stopPropagation() },
            h('div', { className: 'drm-helphead' }, tt('cap.helpTitle')),
            rows.map(([key, text]) => h('div', { key, className: 'drm-helprow' }, text)))
          : null)
    }

    /**
     * Score bar plus the free CPU / memory / GPU numbers. This is the piece the
     * overview card and the host detail share.
     */
    function CapacityStrip({ host, bare, badge }) {
      const capacity = host.capacity
      if (host.status !== 'ok' || capacity === null || capacity === undefined) return null
      const score = capacity.score ?? 0
      const tone = capacityTone(host)
      return h('div', { className: 'drm-capblock', style: bare === true ? { border: 'none', background: 'transparent', padding: 0 } : undefined },
        h('div', { className: 'drm-caphead' },
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
            h('span', null, tt('cap.score')),
            h(CapacityHelp)),
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
            badge === true ? h(CapacityBadge, { host, showIdle: true }) : null,
            h('b', { style: { color: tone } }, capacity.score === null ? '—' : capacity.score))),
        h('div', { className: 'drm-capbar' }, h('i', { style: { width: `${Math.max(0, Math.min(100, score))}%`, background: tone } })),
        h('div', { className: 'drm-mini' },
          h('span', { title: tt('idle.indexHint') }, `${tt('idle.index')} `,
            h('b', { style: { color: idleIndexTone(host.idleIndex?.index) } }, host.idleIndex?.index === null || host.idleIndex?.index === undefined ? '—' : host.idleIndex.index)),
          h('span', { title: tt('cap.tipCpu') }, `${tt('cap.cpuFree')} `, h('b', null, percent(capacity.cpuFreePercent, 0))),
          h('span', { title: tt('cap.tipCores') }, `${tt('cap.freeCores')} `, h('b', null, capacity.freeCpuCores === null ? '—' : Math.round(capacity.freeCpuCores))),
          h('span', { title: tt('cap.tipMem') }, `${tt('cap.memFree')} `, h('b', null, percent(capacity.memFreePercent, 0))),
          h('span', { title: tt('cap.tipGpu') }, `${tt('cap.gpuFree')} `, h('b', null, capacity.gpuTotal > 0 ? `${capacity.gpuFree}/${capacity.gpuTotal}` : '—')),
          (host.idleForSec ?? 0) > 0 ? h('span', { title: tt('cap.tipFree') }, `${tt('cap.freeFor')} `, h('b', null, duration(host.idleForSec))) : null),
        capacity.blockers.length > 0
          ? h('div', { className: 'drm-mini', style: { color: TONE.warn } }, `${tt('cap.blocked')}：` + capacity.blockers.map(blockerText).join(' · '))
          : null)
    }

    /** Rank hosts for the idle view: schedulable first, then by score. */
    function rankIdle(hosts) {
      const rank = host => {
        if (host.status !== 'ok') return -1000
        if (host.capacity === null || host.capacity === undefined) return -500
        const index = host.idleIndex?.index
        return (host.capacity.schedulable ? 1000 : 0) * 100 + (index ?? host.capacity.score ?? 0)
      }
      return [...hosts].sort((a, b) => rank(b) - rank(a) || String(a.alias).localeCompare(String(b.alias)))
    }

    /** Fleet totals as shown in the idle header. */
    function fleetTotals(hosts) {
      const totals = { schedulable: 0, freeGpus: 0, totalGpus: 0, freeCores: 0, freeMemBytes: 0, idle: 0, partial: 0, busy: 0, offline: 0 }
      for (const host of hosts) {
        if (host.status !== 'ok') {
          totals.offline += 1
          continue
        }
        const capacity = host.capacity
        if (capacity === null || capacity === undefined) continue
        if (capacity.schedulable) totals.schedulable += 1
        if (capacity.state === 'free') totals.idle += 1
        else if (capacity.state === 'partial') totals.partial += 1
        else if (capacity.state === 'busy') totals.busy += 1
        totals.freeGpus += capacity.gpuFree ?? 0
        totals.totalGpus += capacity.gpuTotal ?? 0
        totals.freeCores += capacity.freeCpuCores ?? 0
        totals.freeMemBytes += capacity.freeMemBytes ?? 0
      }
      totals.freeCores = Math.round(totals.freeCores)
      return totals
    }

    /** The idle / schedulable view. */
    function IdleView({ hosts, onSelect }) {
      const [showAll, setShowAll] = React.useState(false)
      const totals = fleetTotals(hosts)
      const online = hosts.filter(host => host.status === 'ok' && host.capacity !== null && host.capacity !== undefined)
      const visible = rankIdle(showAll
        ? hosts
        : online.filter(host => host.capacity.schedulable || host.capacity.state === 'partial'))

      return h('div', { className: 'drm-idlewrap' },
        h('div', { className: 'drm-statgrid' },
          h('div', { className: 'drm-stat' }, h('b', { style: { color: TONE.ok } }, String(totals.schedulable)), h('span', null, tt('cap.stat.schedulable'))),
          h('div', { className: 'drm-stat' }, h('b', null, `${totals.freeGpus}/${totals.totalGpus}`), h('span', null, tt('cap.stat.freeGpu'))),
          h('div', { className: 'drm-stat' }, h('b', null, String(totals.freeCores)), h('span', null, tt('cap.stat.freeCores'))),
          h('div', { className: 'drm-stat' }, h('b', null, bytes(totals.freeMemBytes)), h('span', null, tt('cap.stat.freeMem'))),
          h('div', { className: 'drm-stat' }, h('b', null, String(totals.partial)), h('span', null, tt('cap.partial'))),
          h('div', { className: 'drm-stat' }, h('b', null, String(totals.busy)), h('span', null, tt('cap.busy')))),

        h('div', { className: 'drm-sectiontitle' },
          h('span', null, tt('view.idle')),
          h('label', { className: 'drm-check' },
            h('input', { type: 'checkbox', checked: showAll, onChange: event => setShowAll(event.target.checked) }),
            tt('cap.showAll'))),

        visible.length === 0
          ? h('div', { className: 'drm-empty' }, tt('cap.empty'))
          : visible.map(host => {
            const capacity = host.capacity
            const idle = host.idleIndex
            const index = typeof idle?.index === 'number' ? idle.index : null
            const indexTone = idleIndexTone(index)
            return h('div', {
              key: host.alias,
              className: 'drm-idlerow',
              'data-state': host.status !== 'ok' ? 'offline' : capacity?.state ?? 'unknown',
              onClick: () => onSelect(host.alias),
            },
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'drm-hostname' },
                h('span', { className: 'drm-dot', style: { background: hostTone(host) } }),
                host.label ?? host.alias),
              h('div', { className: 'drm-sub2' }, `${host.user}@${host.host}:${host.port}`),
              capacity !== null && capacity !== undefined && capacity.blockers.length > 0
                ? h('div', { className: 'drm-mini drm-blockerline', style: { color: TONE.warn }, title: capacity.blockers.map(blockerText).join(' · ') }, '⚠ ' + capacity.blockers.map(blockerText).join(' · '))
                : null),

            h('div', { className: 'drm-gpucell' },
              h('div', { className: 'drm-gpucellhead' }, h('span', { title: tt('idle.indexHint') }, tt('idle.index')), h('b', { style: { color: indexTone } }, index === null ? '—' : index)),
              h('div', { className: 'drm-capbar' }, h('i', { style: { width: `${Math.max(0, Math.min(100, index ?? 0))}%`, background: indexTone } })),
              h('div', { className: 'drm-mini' }, `${tt('cap.score')} ${capacity?.score ?? '—'}`)),

            h('div', { className: 'drm-gpucell' },
              h('div', { className: 'drm-gpucellhead' }, h('span', null, tt('cap.cpuFree')), h('b', null, percent(capacity?.cpuFreePercent, 0))),
              h('div', { className: 'drm-mini' }, `${tt('cap.freeCores')} ${capacity?.freeCpuCores === null || capacity?.freeCpuCores === undefined ? '—' : Math.round(capacity.freeCpuCores)} · ${tt('cap.memFree')} ${percent(capacity?.memFreePercent, 0)}`)),

            h('div', { className: 'drm-gpucell' },
              h('div', { className: 'drm-gpucellhead' }, h('span', null, tt('cap.gpuFree')), h('b', null, freeGpuText(capacity))),
              capacity !== null && capacity !== undefined && capacity.gpuTotal > 0
                ? h('div', { className: 'drm-mini' }, `${tt('gpu.idleList')} ${capacity.freeGpuIndexes.length > 0 ? capacity.freeGpuIndexes.map(index => `GPU${index}`).join(' ') : '—'}`)
                : null),

            h('div', { className: 'drm-gpucell' },
              h('div', { className: 'drm-gpucellhead' }, h('span', null, tt('cap.freeFor')), h('b', null, duration(host.idleForSec))),
              h('div', { className: 'drm-mini' }, host.status === 'ok' ? tt('host.ok') : hostStateText(host))),

            h('div', { style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 } },
              h(CapacityBadge, { host, showIdle: false })))
          }),

        h('div', { className: 'drm-note' }, tt('cap.hint')))
    }

    /** GPU resources across the fleet. */
    function GpuView({ hosts, thresholds, onSelect }) {
      const withGpu = rankIdle(hosts.filter(host => (host.gpus ?? []).length > 0))
      if (withGpu.length === 0) return h('div', { className: 'drm-empty' }, tt('gpu.noneHere'))
      const totals = fleetTotals(hosts)
      const card = host => {
        const chips = (host.gpus ?? []).map(gpu => h('span', {
          key: gpu.index,
          className: 'drm-chip' + (host.capacity?.freeGpuIndexes?.includes(gpu.index) ? ' drm-chipfree' : ''),
        },
        h('b', null, `GPU${gpu.index}`),
        h('span', { style: { color: toneFor(gpu.utilPercent, thresholds.gpu) } }, percent(gpu.utilPercent, 0)),
        h('span', { style: { opacity: .65 } }, `${bytes(gpu.memUsedBytes)}/${bytes(gpu.memTotalBytes)}`)))
        return h('div', {
          key: host.alias,
          className: 'drm-gpucard',
          'data-free': host.capacity?.gpuFree > 0 ? '1' : '0',
          onClick: () => onSelect(host.alias),
        },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' } },
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'drm-hostname' },
              h('span', { className: 'drm-dot', style: { background: hostTone(host) } }),
              host.label ?? host.alias),
            h('div', { className: 'drm-sub2' }, `${host.user}@${host.host}`)),
          h(CapacityBadge, { host })),
        h('div', { className: 'drm-mini' }, `${tt('cap.gpuFree')} ${freeGpuText(host.capacity)}`),
        h('div', { className: 'drm-gpuchips' }, chips))
      }
      return h('div', { className: 'drm-idlewrap' },
        h('div', { className: 'drm-statgrid' },
          h('div', { className: 'drm-stat' }, h('b', { style: { color: TONE.ok } }, `${totals.freeGpus}/${totals.totalGpus}`), h('span', null, tt('cap.stat.freeGpu'))),
          h('div', { className: 'drm-stat' }, h('b', null, String(withGpu.length)), h('span', null, tt('summary.hosts')))),
        h('div', { className: 'drm-gpucards' }, withGpu.map(card)))
    }

    /** Every active alert, grouped by host. */
    function AlertsView({ hosts }) {
      const rows = hosts.flatMap(host => (host.alerts ?? []).map(alert => ({ ...alert, alias: host.alias })))
      if (rows.length === 0) return h('div', { className: 'drm-empty' }, tt('alerts.noneHere'))
      const byHost = new Map()
      for (const alert of rows) {
        if (!byHost.has(alert.alias)) byHost.set(alert.alias, [])
        byHost.get(alert.alias).push(alert)
      }
      return h('div', { className: 'drm-idlewrap' }, [...byHost.entries()].map(([alias, alerts]) => h('div', { key: alias, className: 'drm-panel' },
        h('div', { className: 'drm-paneltitle' }, `${tt('alerts.host')} · ${alias} (${alerts.length})`),
        h('div', { className: 'drm-alertlist' }, alerts.map(alert => h('div', { key: alert.key, className: 'drm-alertrow' },
          h('span', { className: 'drm-tag', style: { borderColor: alert.level === 'critical' ? TONE.bad : TONE.warn, color: alert.level === 'critical' ? TONE.bad : TONE.warn } }, alert.level),
          h('span', null, alertText(alert))))))))
    }

    /**
     * The view switcher: every screen of the panel plus every host detail.
     * @param {object} props - current value, hosts and the change handler.
     * @returns {React.ReactElement} the select.
     */
    function ViewSelect({ value, hosts, onChange }) {
      return h('select', { className: 'drm-select', value, onChange: event => onChange(event.target.value), title: tt('view.label') },
        h('optgroup', { label: tt('view.label') },
          h('option', { value: 'all' }, tt('view.all')),
          h('option', { value: 'idle' }, tt('view.idle')),
          h('option', { value: 'gpu' }, tt('view.gpu')),
          h('option', { value: 'alerts' }, tt('view.alerts'))),
        h('optgroup', { label: tt('view.hosts') },
          hosts.map(host => h('option', { key: host.alias, value: 'host:' + host.alias },
            `${host.label ?? host.alias} · ${host.status === 'ok' ? tt('cap.' + (host.capacity?.state ?? 'unknown')) : hostStateText(host)}`))))
    }

    /** One host card in the overview grid. */
    function HostCard({ host, history, thresholds, onSelect }) {
      const diskMax = maxDisk(host)
      const gpus = Array.isArray(host.gpus) ? host.gpus : []
      const cpuSeries = history.map(point => point.cpu)
      const memSeries = history.map(point => point.mem)
      const retryIn = typeof host.nextAttemptAt === 'number' ? Math.max(0, Math.round((host.nextAttemptAt - Date.now()) / 1000)) : null

      return h('div', {
        className: 'drm-card',
        'data-down': host.status === 'down' ? '1' : '0',
        'data-off': host.monitor === false ? '1' : '0',
        onClick: () => onSelect(host.alias),
      },
      h('div', { className: 'drm-cardhead' },
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'drm-hostname' },
            h('span', { className: 'drm-dot', style: { background: hostTone(host) } }),
            host.label ?? host.alias),
          h('div', { className: 'drm-target' }, `${host.user}@${host.host}:${host.port}`)),
        h('div', { style: { textAlign: 'right', flex: 'none', display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-end' } },
          h(CapacityBadge, { host, showIdle: true }),
          h('div', { className: 'drm-pill' }, hostStateText(host)),
          retryIn !== null && retryIn > 0 ? h('div', { className: 'drm-note', style: { marginTop: 4 } }, `${retryIn}${tt('host.retryIn')}`) : null)),

      host.status === 'down'
        ? h('div', { className: 'drm-note' }, host.error ?? '')
        : h('div', { className: 'drm-metrics' },
          h('div', { className: 'drm-metric' },
            h('div', { className: 'drm-metriclabel' }, h('span', null, tt('metric.cpu')), h('span', null, Array.isArray(host.cpu?.load) && typeof host.cpu.load[0] === 'number' ? `load ${host.cpu.load[0].toFixed(2)}` : '')),
            h('div', { className: 'drm-metricvalue' }, percent(host.cpu?.percent, 1)),
            h(Sparkline, { values: cpuSeries, max: 100, color: toneFor(host.cpu?.percent, thresholds.cpu), height: 26 })),
          h('div', { className: 'drm-metric' },
            h('div', { className: 'drm-metriclabel' }, h('span', null, tt('metric.mem')), h('span', null, `${bytes(host.mem?.usedBytes)} / ${bytes(host.mem?.totalBytes)}`)),
            h('div', { className: 'drm-metricvalue' }, percent(host.mem?.percent, 1)),
            h(Sparkline, { values: memSeries, max: 100, color: toneFor(host.mem?.percent, thresholds.mem), height: 26 })),
          h('div', { style: { gridColumn: '1 / -1' } }, h(CapacityStrip, { host }))),

      h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11.5, opacity: .8 } },
        h('span', null, `${tt('metric.disk')} ${diskMax === null ? '—' : percent(diskMax, 0)}`),
        h('span', null, `${tt('metric.net')} ↓${rate(netRate(host, 'rxBps'))} ↑${rate(netRate(host, 'txBps'))}`),
        h('span', null, Array.isArray(host.cpu?.load) && typeof host.cpu.load[0] === 'number' ? `${tt('metric.load')} ${host.cpu.load.map(value => typeof value === 'number' ? value.toFixed(2) : '—').join(' ')}` : '')),

      gpus.length > 0
        ? h('div', { className: 'drm-gpuchips' }, gpus.map(gpu => h('span', { key: gpu.index, className: 'drm-chip' },
          h('b', null, `GPU${gpu.index}`),
          h('span', { style: { color: toneFor(gpu.utilPercent, thresholds.gpu) } }, percent(gpu.utilPercent, 0)),
          h('span', { style: { opacity: .65 } }, `${bytes(gpu.memUsedBytes)}/${bytes(gpu.memTotalBytes)}`),
          typeof gpu.tempC === 'number' ? h('span', { style: { opacity: .65, color: toneFor(gpu.tempC, thresholds.temp) } }, `${gpu.tempC}°C`) : null)))
        : null,

      Array.isArray(host.alerts) && host.alerts.length > 0
        ? h('div', { className: 'drm-alertlist' }, host.alerts.slice(0, 3).map(alert => h('div', { key: alert.key, className: 'drm-alertrow' },
          h('span', { className: 'drm-tag', style: { borderColor: alert.level === 'critical' ? TONE.bad : TONE.warn, color: alert.level === 'critical' ? TONE.bad : TONE.warn } }, alert.level),
          h('span', null, alertText(alert)))))
        : null)
    }

    /** A small table built from a header list and row arrays. */
    function Table({ headers, rows, numericFrom = 1 }) {
      if (rows.length === 0) return h('div', { className: 'drm-note' }, '—')
      return h('table', { className: 'drm-table' },
        h('thead', null, h('tr', null, headers.map((header, index) => h('th', { key: index, className: index >= numericFrom ? 'drm-num' : undefined }, header)))),
        h('tbody', null, rows.map((row, index) => h('tr', { key: index }, row.map((cell, cellIndex) => h('td', {
          key: cellIndex,
          className: cellIndex >= numericFrom ? 'drm-num' : undefined,
        }, cell))))))
    }

    /**
     * One process table. The command column is the only flexible one: numeric
     * columns are fixed, the command is clipped with an ellipsis, and clicking
     * a row expands the full command inline — a native `title` tooltip would
     * dump the whole command line on top of the page.
     */
    function ProcessTable({ processes }) {
      const [openPid, setOpenPid] = React.useState(null)
      const rows = Array.isArray(processes) ? processes : []
      return h('table', { className: 'drm-table drm-proctable' },
        h('colgroup', null,
          h('col', { style: { width: '8%' } }),
          h('col', { style: { width: '15%' } }),
          h('col', { style: { width: '10%' } }),
          h('col', { style: { width: '9%' } }),
          h('col', { style: { width: '12%' } }),
          h('col', { style: { width: '46%' } })),
        h('thead', null, h('tr', null,
          h('th', null, tt('table.pid')),
          h('th', null, tt('table.name')),
          h('th', { className: 'drm-num' }, tt('table.cpu')),
          h('th', { className: 'drm-num' }, tt('table.mem')),
          h('th', { className: 'drm-num' }, tt('table.rss')),
          h('th', null, tt('table.command')))),
        h('tbody', null, rows.map(process => {
          const open = openPid === process.pid
          return h(React.Fragment, { key: process.pid },
            h('tr', {
              className: 'drm-procrow',
              'data-open': open ? '1' : '0',
              title: open ? undefined : tt('proc.expandHint'),
              onClick: () => setOpenPid(current => current === process.pid ? null : process.pid),
            },
            h('td', null, String(process.pid)),
            h('td', null, process.name),
            h('td', { className: 'drm-num' }, percent(process.cpuPercent)),
            h('td', { className: 'drm-num' }, percent(process.memPercent)),
            h('td', { className: 'drm-num' }, bytes(process.rssBytes)),
            h('td', { className: 'drm-cmdcell' }, h('span', { className: 'drm-cmd' }, process.command))),
            open
              ? h('tr', { className: 'drm-cmdfull' }, h('td', { colSpan: 6 }, h('pre', null, process.command)))
              : null)
        })))
    }

    /** A collapsible detail panel: title row, optional meta, body only when open. */
    function Section({ title, meta, children, open: initialOpen }) {
      const [open, setOpen] = React.useState(initialOpen === true)
      return h('div', { className: 'drm-panel drm-collapsible' },
        h('button', {
          className: 'drm-collapsehead',
          type: 'button',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen(value => !value),
        },
        h('span', { className: 'drm-collapsearrow' }, open ? '▾' : '▸'),
        h('span', { className: 'drm-paneltitle' }, title),
        meta !== undefined ? h('span', { className: 'drm-collapsemeta' }, meta) : null),
        open ? h('div', { className: 'drm-collapsebody' }, children) : null)
    }

    /**
     * Compact GPU table: one row per card instead of a large card each. An
     * eight-card host used to take hundreds of pixels of cards plus a process
     * paragraph per card; this keeps the whole inventory scannable and leaves
     * the long process lists behind a tooltip / the process section.
     */
    function GpuSummary({ gpus, capacity, thresholds }) {
      const free = Array.isArray(capacity?.freeGpuIndexes) ? capacity.freeGpuIndexes : []
      const avg = gpus.length === 0
        ? null
        : Math.round(gpus.reduce((sum, gpu) => sum + (gpu.utilPercent ?? 0), 0) / gpus.length)
      return h('div', { className: 'drm-panel' },
        h('div', { className: 'drm-panelhead' },
          h('div', { className: 'drm-paneltitle' }, tt('section.gpu')),
          h('div', { className: 'drm-mini' },
            `${gpus.length} × ${gpus[0]?.name ?? 'GPU'}`,
            ' · ',
            `${tt('cap.gpuFree')} ${capacity?.gpuFree ?? 0}/${gpus.length}`,
            ' · ',
            `${tt('metric.gpu')} avg ${avg === null ? '—' : avg}%`)),
        h('div', { className: 'drm-gpulist' }, gpus.map(gpu => {
          const tone = toneFor(gpu.utilPercent, thresholds.gpu)
          const procs = Array.isArray(gpu.processes) ? gpu.processes : []
          const processTitle = procs.length === 0
            ? '—'
            : procs.map(process => `${process.pid} ${process.name} ${bytes(process.memBytes)}`).join('\n')
          return h('div', {
            key: gpu.index,
            className: 'drm-gpurow',
            'data-free': free.includes(gpu.index) ? '1' : '0',
            title: `GPU${gpu.index} · ${gpu.name} · ${tt('gpu.procs')} ${procs.length}`,
          },
          h('b', { className: 'drm-gpuidx' }, `GPU${gpu.index}`),
          h('span', { className: 'drm-gpuname' }, gpu.name),
          h('div', { className: 'drm-gpupbar' }, h('i', { style: { width: `${Math.max(0, Math.min(100, gpu.utilPercent ?? 0))}%`, background: tone } })),
          h('span', { className: 'drm-gpuutil', style: { color: tone } }, percent(gpu.utilPercent, 0)),
          h('span', { className: 'drm-gpuvram' }, `${bytes(gpu.memUsedBytes)} / ${bytes(gpu.memTotalBytes)}`),
          h('span', { className: 'drm-gputemp' }, typeof gpu.tempC === 'number' ? `${gpu.tempC}°C` : '—'),
          h('span', { className: 'drm-gpupower' }, typeof gpu.powerW === 'number' ? `${gpu.powerW}W` : '—'),
          h('span', { className: 'drm-gpuprocs', title: processTitle }, procs.length === 0 ? '—' : String(procs.length)))
        })))
    }

    /** The single-host detail view. */
    function HostDetail({ host, history, thresholds, onBack, onToggleMonitor, onTest, testState, viewSwitch }) {
      const cpuSeries = history.map(point => point.cpu)
      const memSeries = history.map(point => point.mem)
      const netRxSeries = history.map(point => point.netRx)
      const netTxSeries = history.map(point => point.netTx)
      const gpuSeries = history.map(point => point.gpu)
      const gpus = Array.isArray(host.gpus) ? host.gpus : []
      const diskMax = maxDisk(host)
      const system = host.system ?? {}

      return h('div', { className: 'drm-detail' },
        h('div', { className: 'drm-head' },
          h('div', null,
            h('h2', { className: 'drm-title' }, h('span', { className: 'drm-dot', style: { background: hostTone(host), display: 'inline-block', marginRight: 8 } }), host.label ?? host.alias),
            h('div', { className: 'drm-sub' }, `${host.user}@${host.host}:${host.port} · ${host.source} · ${hostStateText(host)}${host.latencyMs !== null && host.latencyMs !== undefined ? ` · ${host.latencyMs} ms` : ''}`)),
          h('div', { className: 'drm-toolbar' },
            viewSwitch,
            h('button', { className: 'drm-btn', onClick: onBack }, tt('action.back')),
            h('button', { className: 'drm-btn', onClick: () => onTest(host.alias), disabled: testState?.alias === host.alias && testState?.busy === true },
              testState?.alias === host.alias && testState?.busy === true ? '…' : tt('action.test')),
            h('button', { className: 'drm-btn', onClick: () => onToggleMonitor(host.alias, host.monitor === false) },
              host.monitor === false ? tt('action.enable') : tt('action.disable')))),

        testState?.alias === host.alias && testState?.message !== undefined
          ? h('div', { className: 'drm-banner', 'data-level': testState.ok === true ? 'ok' : 'critical' }, testState.message)
          : null,

        host.status === 'down'
          ? h('div', { className: 'drm-banner', 'data-level': 'critical' }, host.error ?? '')
          : null,

        host.status === 'ok' && host.capacity !== null && host.capacity !== undefined
          ? h('div', { className: 'drm-panel' }, h(CapacityStrip, { host, bare: true, badge: true }))
          : null,

        h('div', { className: 'drm-chartrow' },
          h(ChartTile, { label: tt('metric.cpu'), value: percent(host.cpu?.percent), series: cpuSeries, color: TONE.info, max: 100 }),
          h(ChartTile, { label: tt('metric.mem'), value: percent(host.mem?.percent), series: memSeries, color: TONE.violet, max: 100 }),
          h(ChartTile, { label: `${tt('metric.net')} ↓`, value: rate(netRate(host, 'rxBps')), series: netRxSeries, color: TONE.ok }),
          h(ChartTile, { label: `${tt('metric.net')} ↑`, value: rate(netRate(host, 'txBps')), series: netTxSeries, color: TONE.warn }),
          gpus.length > 0 ? h(ChartTile, { label: `${tt('metric.gpu')} max`, value: percent(gpuSeries.length > 0 ? gpuSeries[gpuSeries.length - 1] : null, 0), series: gpuSeries, color: TONE.bad, max: 100 }) : null),

        h('div', { className: 'drm-detailgrid' },
          h('div', { className: 'drm-panel' },
            h('div', { className: 'drm-paneltitle' }, tt('section.system')),
            h('table', { className: 'drm-table' }, h('tbody', null,
              row(tt('table.name'), system.hostname ?? '—'),
              row('OS', system.os ?? '—'),
              row('Kernel', system.uname ?? '—'),
              row('Uptime', uptime(system.uptimeSec)),
              row(tt('metric.load'), Array.isArray(host.cpu?.load) ? host.cpu.load.map(value => typeof value === 'number' ? value.toFixed(2) : '—').join(' / ') : '—'),
              row(tt('metric.cpu'), `${percent(host.cpu?.percent)} · ${host.cpu?.nproc ?? '—'} cores · iowait ${percent(host.cpu?.iowait)}`),
              row(tt('metric.mem'), `${bytes(host.mem?.usedBytes)} / ${bytes(host.mem?.totalBytes)}`),
              row(tt('metric.swap'), host.mem?.swapTotalBytes ? `${bytes(host.mem?.swapUsedBytes)} / ${bytes(host.mem?.swapTotalBytes)}` : '—'),
              row('Sampled', clock(host.lastSampleAt))))),

          h('div', { className: 'drm-panel' },
            h('div', { className: 'drm-paneltitle' }, tt('section.disk')),
            h(Table, {
              headers: [tt('table.mount'), tt('table.used'), tt('table.size'), tt('table.use')],
              numericFrom: 1,
              rows: (host.disks ?? []).map(mount => [
                h('span', { key: 'm' }, mount.mount),
                bytes(mount.usedBytes),
                bytes(mount.sizeBytes),
                h('span', { key: 'p', style: { color: toneFor(mount.usePercent, thresholds.disk) } }, percent(mount.usePercent)),
              ]),
            }))),

        gpus.length > 0
          ? h(GpuSummary, { gpus, capacity: host.capacity, thresholds })
          : null,

        (host.topCpu ?? []).length > 0 || (host.topMem ?? []).length > 0
          ? h('div', { className: 'drm-detailgrid' },
            h(Section, { title: `${tt('section.processes')} · ${tt('proc.byCpu')}`, meta: `${(host.topCpu ?? []).length}`, open: false },
              h(ProcessTable, { key: 'cpu-' + host.alias, processes: host.topCpu ?? [] })),
            h(Section, { title: `${tt('section.processes')} · ${tt('proc.byMem')}`, meta: `${(host.topMem ?? []).length}`, open: false },
              h(ProcessTable, { key: 'mem-' + host.alias, processes: host.topMem ?? [] })))
          : null,

        (host.diskIo ?? []).length > 0 || (host.net ?? []).length > 0
          ? h('div', { className: 'drm-detailgrid' },
            (host.diskIo ?? []).length > 0
              ? h(Section, { title: tt('section.diskIo'), meta: `${(host.diskIo ?? []).length}`, open: false },
                h(Table, {
                  headers: [tt('table.device'), tt('table.read'), tt('table.write'), tt('table.busy')],
                  numericFrom: 1,
                  rows: host.diskIo.slice(0, 8).map(device => [device.name, rate(device.readBps), rate(device.writeBps), percent(device.busyPercent, 0)]),
                }))
              : null,
            (host.net ?? []).length > 0
              ? h(Section, { title: tt('section.net'), meta: `${(host.net ?? []).length}`, open: false },
                h(Table, {
                  headers: [tt('table.nic'), tt('table.rx'), tt('table.tx'), tt('table.total')],
                  numericFrom: 1,
                  rows: host.net.slice(0, 8).map(nic => [nic.name, rate(nic.rxBps), rate(nic.txBps), `↓${bytes(nic.rxBytes)} ↑${bytes(nic.txBytes)}`]),
                }))
              : null)
          : null,

        h('div', { className: 'drm-note' }, tt('rates.note')))

      /** One definition row. */
      function row(label, value) {
        return h('tr', { key: label }, h('td', null, label), h('td', { className: 'drm-num' }, value))
      }
    }

    /** The thresholds dialog. */
    function ThresholdDialog({ thresholds, lowUsage, onClose, onSave, busy }) {
      const [draft, setDraft] = React.useState(() => ({ ...thresholds }))
      const [lowDraft, setLowDraft] = React.useState(() => ({
        enabled: lowUsage?.enabled !== false,
        cpuBelow: lowUsage?.cpuBelow ?? 15,
        gpuBelow: lowUsage?.gpuBelow ?? 10,
        forMin: Math.max(1, Math.round((lowUsage?.forSec ?? 600) / 60)),
      }))
      const fields = [
        ['cpu', tt('thr.cpu')], ['mem', tt('thr.mem')], ['swap', tt('thr.swap')], ['disk', tt('thr.disk')],
        ['gpu', tt('thr.gpu')], ['gpuMem', tt('thr.gpuMem')], ['temp', tt('thr.temp')], ['loadPerCore', tt('thr.loadPerCore')],
      ]
      return h('div', { className: 'drm-dialog', onClick: event => { if (event.target === event.currentTarget) onClose() } },
        h('div', { className: 'drm-dialogbox' },
          h('div', { className: 'drm-title' }, tt('thr.title')),
          h('div', { className: 'drm-note' }, tt('thr.hint')),
          fields.map(([key, label]) => h('div', { key, className: 'drm-field' },
            h('span', null, label),
            h('input', {
              type: 'number',
              min: 0,
              value: draft[key] ?? 0,
              onChange: event => setDraft({ ...draft, [key]: Number(event.target.value) }),
            }))),
          h('div', { className: 'drm-paneltitle', style: { marginTop: 6 } }, tt('low.section')),
          h('div', { className: 'drm-note' }, tt('low.hint')),
          h('label', { className: 'drm-check' },
            h('input', {
              type: 'checkbox',
              checked: lowDraft.enabled,
              onChange: event => setLowDraft({ ...lowDraft, enabled: event.target.checked }),
            }),
            tt('low.enabled')),
          [['cpuBelow', tt('low.cpu')], ['gpuBelow', tt('low.gpu')], ['forMin', tt('low.for')]].map(([key, label]) => h('div', { key, className: 'drm-field' },
            h('span', null, label),
            h('input', {
              type: 'number',
              min: key === 'forMin' ? 1 : 0,
              value: lowDraft[key] ?? 0,
              onChange: event => setLowDraft({ ...lowDraft, [key]: Number(event.target.value) }),
            }))),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
            h('button', { className: 'drm-btn', onClick: onClose }, tt('action.close')),
            h('button', { className: 'drm-btn', 'data-primary': '1', disabled: busy === true, onClick: () => onSave(draft, {
              enabled: lowDraft.enabled,
              cpuBelow: lowDraft.cpuBelow,
              gpuBelow: lowDraft.gpuBelow,
              forSec: Math.max(1, lowDraft.forMin) * 60,
            }) }, tt('action.save')))))
    }

    // ----------------------------------------------------------------- panel

    /**
     * The monitor page. Owns the SSE subscription, the client-side history and
     * the selected host.
     * @returns {React.ReactElement} the page.
     */
    function MonitorPage() {
      const [hosts, setHosts] = React.useState([])
      const [sources, setSources] = React.useState([])
      const [thresholds, setThresholds] = React.useState({})
      const [lowUsage, setLowUsage] = React.useState({})
      const [info, setInfo] = React.useState(null)
      const [history, setHistory] = React.useState({})
      const [alerts, setAlerts] = React.useState([])
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [paused, setPaused] = React.useState(false)
      const [selected, setSelected] = React.useState(null)
      const [view, setView] = React.useState('all')
      const [showDown, setShowDown] = React.useState(false)
      const [showThresholds, setShowThresholds] = React.useState(false)
      const [savingThresholds, setSavingThresholds] = React.useState(false)
      const [testState, setTestState] = React.useState(null)
      const historyRef = React.useRef({})
      const streamRef = React.useRef(null)

      /** Merge one host payload into the list. */
      const upsert = React.useCallback(sample => {
        setHosts(current => {
          const index = current.findIndex(host => host.alias === sample.alias)
          if (index < 0) return [...current, sample].sort((a, b) => a.alias.localeCompare(b.alias))
          const next = [...current]
          next[index] = { ...current[index], ...sample }
          return next
        })
      }, [])

      /** Append one sample to the client-side chart history. */
      const pushHistory = React.useCallback(sample => {
        const store = historyRef.current
        const point = {
          t: sample.lastSampleAt ?? Date.now(),
          cpu: sample.cpu?.percent ?? null,
          mem: sample.mem?.percent ?? null,
          swap: sample.mem?.swapPercent ?? null,
          netRx: netRate(sample, 'rxBps') ?? 0,
          netTx: netRate(sample, 'txBps') ?? 0,
          disk: maxDisk(sample),
          gpu: Array.isArray(sample.gpus) && sample.gpus.length > 0 ? Math.max(...sample.gpus.map(gpu => gpu.utilPercent ?? 0)) : null,
          gpuMem: Array.isArray(sample.gpus) && sample.gpus.length > 0 ? Math.max(...sample.gpus.map(gpu => gpu.memPercent ?? 0)) : null,
          temp: Array.isArray(sample.gpus) && sample.gpus.length > 0 ? Math.max(...sample.gpus.map(gpu => gpu.tempC ?? 0)) : null,
        }
        const series = [...(store[sample.alias] ?? []), point]
        store[sample.alias] = series.slice(-HISTORY_LIMIT)
        setHistory({ ...store })
      }, [])

      /** Read the host list plus any history the host already collected. */
      const loadHosts = React.useCallback(async () => {
        try {
          const body = await requestJson(API.hosts)
          setHosts(body.hosts ?? [])
          setSources(body.sources ?? [])
          setThresholds(body.thresholds ?? {})
          setLowUsage(body.lowUsage ?? {})
          setInfo(body.info ?? null)
          setError(null)
        } catch (loadError) {
          setError(loadError instanceof Error ? loadError.message : String(loadError))
        } finally {
          setLoading(false)
        }
      }, [])

      /** Seed chart history from the host's ring buffer. */
      const loadHistory = React.useCallback(async () => {
        try {
          const body = await requestJson(API.history)
          const seed = {}
          for (const [alias, points] of Object.entries(body.series ?? {})) {
            if (Array.isArray(points) && points.length > 0) seed[alias] = points.slice(-HISTORY_LIMIT)
          }
          const merged = { ...seed, ...historyRef.current }
          historyRef.current = merged
          setHistory(merged)
        } catch {
          // History is a nicety; the charts fill from the live stream anyway.
        }
      }, [])

      /** Refresh the alert log. */
      const loadAlerts = React.useCallback(async () => {
        try {
          const body = await requestJson(API.alerts + '?limit=25')
          setAlerts(body.alerts ?? [])
        } catch {
          // Non-fatal.
        }
      }, [])

      React.useEffect(() => {
        ensureStyle()
        void loadHosts()
        void loadHistory()
        void loadAlerts()
      }, [loadHosts, loadHistory, loadAlerts])

      // The SSE subscription is also what keeps the host sampler running.
      React.useEffect(() => {
        if (paused) {
          streamRef.current?.close()
          streamRef.current = null
          return undefined
        }
        let stream
        try {
          stream = new EventSource(API.stream)
        } catch {
          return undefined
        }
        streamRef.current = stream
        stream.addEventListener('hosts', event => {
          try {
            const body = JSON.parse(event.data)
            setHosts(body.hosts ?? [])
            setSources(body.sources ?? [])
            setThresholds(body.thresholds ?? {})
            setLowUsage(body.lowUsage ?? {})
            setInfo(body.info ?? null)
          } catch { /* ignore malformed frame */ }
        })
        stream.addEventListener('samples', event => {
          try {
            const body = JSON.parse(event.data)
            for (const sample of body.samples ?? []) {
              upsert(sample)
              pushHistory(sample)
            }
            if (body.info !== undefined) setInfo(body.info)
          } catch { /* ignore malformed frame */ }
        })
        stream.addEventListener('sample', event => {
          try {
            const body = JSON.parse(event.data)
            if (body.sample !== undefined) {
              upsert(body.sample)
              pushHistory(body.sample)
            }
            void loadAlerts()
          } catch { /* ignore malformed frame */ }
        })
        return () => {
          stream.close()
          streamRef.current = null
        }
      }, [paused, upsert, pushHistory, loadAlerts])

      /** Toggle one host's monitoring switch. */
      const toggleMonitor = React.useCallback(async (alias, monitor) => {
        try {
          const body = await requestJson(API.hosts, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias, monitor }),
          })
          setHosts(body.hosts ?? [])
          setSources(body.sources ?? [])
        } catch (toggleError) {
          setError(toggleError instanceof Error ? toggleError.message : String(toggleError))
        }
      }, [])

      /** Test one host's connection. */
      const testHost = React.useCallback(async alias => {
        setTestState({ alias, busy: true })
        try {
          const body = await requestJson(API.test, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias }),
          })
          setTestState({
            alias,
            busy: false,
            ok: body.ok,
            message: body.ok
              ? `${tt('host.ok')} · ${body.latencyMs} ms · ${body.system?.hostname ?? ''} ${body.system?.os ?? ''}`.trim()
              : `${tt('host.down')} · ${body.error ?? ''}`,
          })
        } catch (testError) {
          setTestState({ alias, busy: false, ok: false, message: testError instanceof Error ? testError.message : String(testError) })
        }
      }, [])

      /** Force a fresh read of every monitored host. */
      const refreshNow = React.useCallback(async () => {
        try {
          await requestJson(API.snapshot + '?fresh=1')
        } catch {
          // The stream will deliver results anyway.
        }
      }, [])

      /** Re-read ~/.ssh/config and the dsh-ssh store. */
      const reloadHosts = React.useCallback(async () => {
        try {
          const body = await requestJson(API.reload, { method: 'POST' })
          setHosts(body.hosts ?? [])
          setSources(body.sources ?? [])
          setError(null)
        } catch (reloadError) {
          setError(reloadError instanceof Error ? reloadError.message : String(reloadError))
        }
      }, [])

      /** Persist the thresholds. */
      const saveThresholds = React.useCallback(async (draft, lowDraft) => {
        setSavingThresholds(true)
        try {
          const body = await requestJson(API.thresholds, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...draft, lowUsage: lowDraft }),
          })
          setThresholds(body.thresholds ?? draft)
          if (body.lowUsage !== undefined) setLowUsage(body.lowUsage)
          setShowThresholds(false)
        } catch (saveError) {
          setError(saveError instanceof Error ? saveError.message : String(saveError))
        } finally {
          setSavingThresholds(false)
        }
      }, [])

      /** One dropdown drives every screen: the four views plus each host. */
      const changeView = React.useCallback(value => {
        if (typeof value === 'string' && value.startsWith('host:')) {
          setSelected(value.slice(5))
          return
        }
        setSelected(null)
        setView(typeof value === 'string' && value !== '' ? value : 'all')
      }, [])

      const monitored = hosts.filter(host => host.monitor !== false)
      const activeAlerts = hosts.flatMap(host => (host.alerts ?? []).map(alert => ({ ...alert, alias: host.alias })))
      const selectedHost = selected === null ? null : hosts.find(host => host.alias === selected) ?? null
      const running = info?.running === true
      // "Only connectable machines": unreachable hosts are hidden by default so
      // the dashboard is about capacity that actually exists. The toggle brings
      // them back for troubleshooting.
      const downCount = hosts.filter(host => host.status === 'down').length
      const visibleHosts = showDown || downCount === 0 ? hosts : hosts.filter(host => host.status !== 'down')
      const totals = fleetTotals(visibleHosts)

      if (selectedHost !== null) {
        return h('div', { className: 'drm-root' },
          h(HostDetail, {
            host: selectedHost,
            history: history[selectedHost.alias] ?? [],
            thresholds,
            onBack: () => setSelected(null),
            onToggleMonitor: toggleMonitor,
            onTest: testHost,
            testState,
            viewSwitch: visibleHosts.length + 1 > 0
              ? h(ViewSelect, {
                value: 'host:' + selectedHost.alias,
                hosts: visibleHosts.some(host => host.alias === selectedHost.alias) ? visibleHosts : [...visibleHosts, selectedHost],
                onChange: changeView,
              })
              : null,
          }))
      }

      return h('div', { className: 'drm-root' },
        h('div', { className: 'drm-head' },
          h('div', null,
            h('h2', { className: 'drm-title' }, tt('panel.title')),
            h('div', { className: 'drm-sub' }, tt('panel.subtitle'))),
          h('div', { className: 'drm-toolbar' },
            visibleHosts.length > 0 ? h(ViewSelect, { value: view, hosts: visibleHosts, onChange: changeView }) : null,
            h('span', { className: 'drm-pill' },
              h('span', { className: 'drm-dot', style: { background: paused ? TONE.warn : running ? TONE.ok : TONE.neutral } }),
              paused ? tt('state.paused') : running ? tt('state.live') : tt('state.idle')),
            h('button', { className: 'drm-btn', onClick: () => setPaused(value => !value) }, paused ? tt('action.resume') : tt('action.pause')),
            h('button', { className: 'drm-btn', onClick: refreshNow, disabled: paused }, tt('action.refresh')),
            h('button', { className: 'drm-btn', onClick: reloadHosts }, tt('action.reload')),
            h('button', { className: 'drm-btn', onClick: () => setShowThresholds(true) }, tt('action.thresholds')))),

        h('div', { className: 'drm-stats' },
          h('span', null, `${hosts.length} ${tt('summary.hosts')}`),
          h('span', null, `${monitored.length} ${tt('summary.monitored')}`),
          h('span', null, `${activeAlerts.length} ${tt('summary.alerts')}`),
          h('span', { style: { color: totals.schedulable > 0 ? TONE.ok : undefined } }, `${totals.schedulable} ${tt('cap.stat.schedulable')} · ${totals.freeGpus}/${totals.totalGpus} ${tt('cap.stat.freeGpu')}`),
          downCount > 0
            ? h('label', { className: 'drm-check' },
              h('input', { type: 'checkbox', checked: showDown, onChange: event => setShowDown(event.target.checked) }),
              `${tt('filter.showDown')} (${downCount})`)
            : null,
          info?.intervalMs !== undefined ? h('span', null, `interval ${Math.round(info.intervalMs / 1000)}s`) : null,
          info?.subscribers !== undefined ? h('span', null, `subscribers ${info.subscribers}`) : null,
          info?.version ? h('span', { className: 'drm-note' }, `v${info.version}`) : null),

        error !== null ? h('div', { className: 'drm-banner', 'data-level': 'critical' }, tt('error.prefix') + error) : null,

        activeAlerts.length > 0 && view !== 'alerts'
          ? h('div', { className: 'drm-banner', 'data-level': activeAlerts.some(alert => alert.level === 'critical') ? 'critical' : 'warn' },
            h('div', { style: { fontWeight: 600 } }, `${tt('alerts.title')} · ${activeAlerts.length}`),
            h('div', { className: 'drm-alertlist' }, activeAlerts.slice(0, 6).map((alert, index) => h('div', { key: index, className: 'drm-alertrow' },
              h('span', { className: 'drm-tag' }, alert.alias),
              h('span', null, alertText(alert))))))
          : null,

        loading
          ? h('div', { className: 'drm-empty' }, tt('empty.loading'))
          : hosts.length === 0
            ? h('div', { className: 'drm-empty' }, h('div', { className: 'drm-title' }, tt('empty.title')), h('p', null, tt('empty.body')))
            : visibleHosts.length === 0
              ? h('div', { className: 'drm-empty' }, tt('empty.allDown'))
              : view === 'idle'
              ? h(IdleView, { hosts: visibleHosts, onSelect: setSelected })
              : view === 'gpu'
                ? h(GpuView, { hosts: visibleHosts, thresholds, onSelect: setSelected })
                : view === 'alerts'
                  ? h(AlertsView, { hosts: visibleHosts })
                  : h('div', { className: 'drm-grid' }, visibleHosts.map(host => h(HostCard, {
                    key: host.alias,
                    host,
                    history: history[host.alias] ?? [],
                    thresholds,
                    onSelect: setSelected,
                  }))),

        sources.length > 0
          ? h('div', { className: 'drm-sources' },
            h('span', null, tt('source.title') + ':'),
            sources.map(source => h('span', { key: source.source }, `${source.path} (${source.count}${tt('source.count')}${source.ok ? '' : ' · ' + (source.error ?? 'error')})`)))
          : null,

        h('div', { className: 'drm-note' }, tt('rates.note')),

        showThresholds
          ? h(ThresholdDialog, { thresholds, lowUsage, busy: savingThresholds, onClose: () => setShowThresholds(false), onSave: saveThresholds })
          : null)
    }

    // ------------------------------------------------------------ registration

    /** The sidebar glyph. */
    function MonitorIcon({ size }) {
      return h('svg', {
        'data-dsh-panel-entry': PANEL_ID,
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('rect', { x: 1.75, y: 2.25, width: 12.5, height: 11.5, rx: 1.75 }),
      h('path', { d: 'M4 11.25l1.9-3.1 1.7 2.1 1.5-3.6 1.4 2.6H13' }))
    }

    // --------------------------------------------------------- footer chip

    /**
     * The always-visible sidebar-footer line: how many machines are idle, how
     * many GPUs are free, and how many are flagged as low-utilisation.
     *
     * It polls slowly (default 60 s) and only forces a fresh sample when the
     * last one is older than the poll window, so a dashboard that is already
     * streaming at 5 s does not get read twice. Nothing runs while the tab is
     * hidden, and the chip is purely informational: clicking expands the list.
     *
     * @returns {React.ReactElement} the footer chip.
     */
    function FooterIndicator() {
      const [hosts, setHosts] = React.useState([])
      const [compact, setCompact] = React.useState(false)
      const [loaded, setLoaded] = React.useState(false)
      const [enabled, setEnabled] = React.useState(true)
      const [failed, setFailed] = React.useState(false)
      const [pollSec, setPollSec] = React.useState(60)
      const [live, setLive] = React.useState(true)
      const [nowTick, setNowTick] = React.useState(() => Date.now())
      const rootRef = React.useRef(null)
      const pollMsRef = React.useRef(60000)

      // A one-second clock only drives the "updated Ns ago" label; it keeps the
      // list honest when values barely move (a busy GPU host holds ~the same
      // number for minutes even though it is refreshed every 5 s).
      React.useEffect(() => {
        const timer = setInterval(() => setNowTick(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [])

      /** Merge one pushed sample into the footer list. */
      const mergeSample = React.useCallback(sample => {
        setHosts(current => {
          const index = current.findIndex(host => host.alias === sample.alias)
          if (index < 0) return [...current, sample]
          const next = current.slice()
          next[index] = { ...current[index], ...sample }
          return next
        })
      }, [])

      // The shell lays footer actions out as full-width rows in the wide
      // sidebar and as icons when collapsed; switch on the measured width
      // instead of guessing from a class name we do not own.
      React.useEffect(() => {
        // The panel injects the stylesheet on mount, but the footer can be the
        // only surface a user ever sees: inject it here too.
        ensureStyle()
        const node = rootRef.current
        // Two signals for "the sidebar is collapsed": the shell's frame
        // attribute (authoritative, but not observable in every shell build)
        // and the measured width (works wherever the attribute is absent).
        const frame = typeof document !== 'undefined' ? document.querySelector('[data-dsh-frame]') : null
        const update = () => {
          const collapsed = frame !== null && frame.hasAttribute('data-sidebar-collapsed')
          const width = node !== null && typeof node.getBoundingClientRect === 'function'
            ? node.getBoundingClientRect().width
            : 0
          setCompact(collapsed || (width > 0 && width < 104))
        }
        update()
        const observer = typeof ResizeObserver === 'function' && node !== null ? new ResizeObserver(update) : null
        observer?.observe(node)
        const mutation = frame !== null && typeof MutationObserver === 'function'
          ? new MutationObserver(update)
          : null
        mutation?.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] })
        window.addEventListener('resize', update)
        return () => {
          observer?.disconnect()
          mutation?.disconnect()
          window.removeEventListener('resize', update)
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        let timer = null
        const schedule = ms => { if (alive) timer = setTimeout(load, ms) }
        const load = async () => {
          timer = null
          if (typeof document !== 'undefined' && document.hidden) { schedule(15000); return }
          try {
            let body = await requestJson(API.hosts)
            const footer = body.info?.footer
            if (footer !== undefined && footer.enabled === false) {
              if (alive) setEnabled(false)
              schedule(60000)
              return
            }
            if (footer !== undefined && Number.isFinite(footer.pollSec)) {
              pollMsRef.current = Math.max(30, footer.pollSec) * 1000
              if (alive) setPollSec(Math.round(pollMsRef.current / 1000))
            }
            if (footer !== undefined && alive) setLive(footer.live !== false)
            const stamps = (body.hosts ?? []).map(host => host.lastSampleAt).filter(value => typeof value === 'number')
            const newest = stamps.length > 0 ? Math.max(...stamps) : null
            const stale = newest === null || Date.now() - newest > pollMsRef.current - 5000
            if (stale) {
              // Force one read pass; individual hosts may still fail and that is fine.
              try { await requestJson(API.snapshot + '?fresh=1') } catch { /* per-host errors stay per host */ }
              body = await requestJson(API.hosts)
            }
            if (alive) {
              setEnabled(true)
              setFailed(false)
              setHosts(body.hosts ?? [])
              setLoaded(true)
            }
          } catch { if (alive) setFailed(true) }
          schedule(pollMsRef.current)
        }
        load()
        return () => { alive = false; if (timer !== null) clearTimeout(timer) }
      }, [])

      // Live updates: the footer shares the dashboard's SSE stream while the
      // tab is visible, so the list moves with the 5 s sampling cadence instead
      // of waiting for the 60 s fallback poll. The poll stays as metadata
      // refresh and as the only path when `footer.live` is off.
      React.useEffect(() => {
        if (!live || typeof EventSource !== 'function') return undefined
        let stream = null
        const open = () => {
          if (stream !== null || document.hidden) return
          try {
            stream = new EventSource(API.stream)
          } catch {
            return
          }
          stream.addEventListener('hosts', event => {
            try {
              const body = JSON.parse(event.data)
              setHosts(body.hosts ?? [])
              setLoaded(true)
            } catch { /* ignore malformed frame */ }
          })
          const onSample = event => {
            try {
              const body = JSON.parse(event.data)
              const samples = body.samples ?? (body.sample === undefined ? [] : [body.sample])
              for (const sample of samples) mergeSample(sample)
              if (samples.length > 0) {
                setLoaded(true)
                setFailed(false)
              }
            } catch { /* ignore malformed frame */ }
          }
          stream.addEventListener('samples', onSample)
          stream.addEventListener('sample', onSample)
        }
        const close = () => {
          if (stream !== null) {
            stream.close()
            stream = null
          }
        }
        const onVisibility = () => {
          if (document.hidden) close()
          else open()
        }
        open()
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          close()
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [live, mergeSample])

      // Disabled in settings, or the host half is still the old build: show
      // nothing rather than a chip that can never load.
      if (!enabled) return null
      if (failed && hosts.length === 0) return null

      const monitored = hosts.filter(host => host.monitor !== false)
      const online = monitored.filter(host => host.status === 'ok')
      const idle = online.filter(host => host.capacity?.schedulable === true)
      const low = online.filter(host => host.lowUsage?.low === true)
      const freeGpus = idle.reduce((sum, host) => sum + (host.capacity?.gpuFree ?? 0), 0)
      const tone = low.length > 0 ? TONE.warn : idle.length > 0 ? TONE.ok : TONE.neutral
      const polling = !loaded
      const count = low.length > 0 ? low.length : idle.length
      const stampValues = online.map(host => host.lastSampleAt).filter(value => typeof value === 'number')
      const sampleAgeSec = stampValues.length === 0
        ? null
        : Math.max(0, Math.round((nowTick - Math.max(...stampValues)) / 1000))
      const ageText = sampleAgeSec === null ? null : tt('foot.updated').replace('{s}', String(sampleAgeSec))
      const age = sampleAgeSec

      if (compact) {
        // Collapsed sidebar: only a dot and a number fit.
        return h('div', { className: 'drm-foot', ref: rootRef },
          h('div', { className: 'drm-footrow', title: tt('foot.label') },
            h('span', { className: 'drm-dot', style: { background: tone } }),
            h('span', { className: 'drm-footcount', style: { color: tone } }, polling ? '…' : String(count))))
      }

      // The wide footer shows the whole fleet as a list — one row per
      // reachable host, sorted by idle index (the most idle first).
      const rows = [...online].sort((a, b) =>
        (b.idleIndex?.index ?? -1) - (a.idleIndex?.index ?? -1) || String(a.alias).localeCompare(String(b.alias)))

      return h('div', { className: 'drm-foot', ref: rootRef },
        h('div', { className: 'drm-foothead' },
          h('span', { className: 'drm-footlabel' }, tt('foot.label')),
          low.length > 0 ? h('span', { className: 'drm-footwarn' }, `${low.length} ${tt('foot.low')}`) : null,
          h('span', { className: 'drm-footsummary', title: ageText }, `${idle.length} ${tt('foot.idle')} · ${freeGpus} ${tt('foot.gpu')}${ageText === null ? '' : ` · ${age}s`}`)),

        h('div', { className: 'drm-footscroll' },
          rows.length === 0
            ? h('div', { className: 'drm-footempty' }, polling ? tt('foot.polling') : tt('foot.none'))
            : rows.map(host => {
              const index = host.idleIndex?.index
              const gpuText = (host.capacity?.gpuTotal ?? 0) > 0
                ? `GPU ${host.capacity.gpuFree}/${host.capacity.gpuTotal}`
                : `CPU ${percent(host.cpu?.percent, 0)}`
              return h('div', {
                key: host.alias,
                className: 'drm-footitem',
                'data-low': host.lowUsage?.low === true ? '1' : '0',
                title: `${host.alias} · ${tt('idle.index')} ${index ?? '—'} · ${gpuText} · ${duration(host.idleForSec)}`,
              },
              h('span', {
                className: 'drm-footdot',
                style: { background: host.lowUsage?.low === true ? TONE.warn : idleIndexTone(index) },
              }),
              h('span', { className: 'drm-footalias' }, host.alias),
              h('b', { className: 'drm-footidx', style: { color: idleIndexTone(index) } }, index === null || index === undefined ? '—' : index),
              h('span', { className: 'drm-footmeta' }, gpuText, ' · ', duration(host.idleForSec)))
            })))
    }

    /**
     * Register the sidebar row and the main-slot page.
     * @param {object} ctx - the client root context.
     * @returns {() => void} the disposer releasing both seats.
     */
    function registerPanel(ctx) {
      const slots = ctx.slots
      if (slots === undefined || typeof slots.inject !== 'function') throw new Error('the slots service is unavailable')
      const disposers = []

      disposers.push(slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: PANEL_ORDER,
        label: () => tt('entry.label'),
      }, MonitorIcon)))

      disposers.push(slots.inject('main', () => slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: () => ({}),
      }, MonitorPage)))

      // Footer chip: the shell only fires this when it owns the seat, so an
      // older shell without it simply shows no chip.
      try {
        disposers.push(slots.inject('sidebar.footer.action', () => slots.register({
          name: 'sidebar.footer.action',
          id: 'remote-monitor-footer',
          order: 20,
        }, FooterIndicator)))
      } catch (error) {
        console.warn('[dsh-remote-monitor] footer chip registration failed:', error)
      }

      return () => {
        for (const dispose of disposers.splice(0)) dispose()
      }
    }

    /** Required services. */
    const inject = ['slots']

    /**
     * Mount the monitor panel. DOM problems are logged, never thrown: the web
     * shell fails the whole boot when a plugin apply throws, and an external
     * plugin must not take the GUI down.
     * @param {object} ctx - the client root context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const disposers = []
        try {
          disposers.push(registerPanel(ctx))
        } catch (error) {
          console.warn('[dsh-remote-monitor] panel registration failed:', error)
        }
        return () => {
          for (const dispose of disposers.splice(0)) dispose()
        }
      }, 'dsh-remote-monitor: ui mounts')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
