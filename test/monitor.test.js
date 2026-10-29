/**
 * Sampler integration tests.
 *
 * The capacity model is unit-tested on its own; this file checks the wiring the
 * dashboard and the tools actually receive: every sample carries `capacity`,
 * the payload exposes `idleForSec`, and a host that has been free for a while
 * says so. The SSH pool is stubbed with real probe text, so `read()` runs end
 * to end (both the cold-start pair and the ordinary poll).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Monitor } from '../src/monitor.js'

/** Probe text for an idle dual-GPU box: 41 % disk, 2.4 % memory, no GPU work. */
const IDLE_PROBE = [
  '@@RMON probe',
  '1000000.00 6000.00',
  '@@RMON loadavg',
  '1.00 1.00 1.00 2/1200 99999',
  '@@RMON nproc',
  '64',
  '@@RMON stat',
  'cpu  1000 0 500 8000 200 0 50 0 0 0',
  'cpu0 100 0 50 800 20 0 5 0 0 0',
  '@@RMON meminfo',
  'MemTotal:       33554432 kB',
  'MemFree:         20000000 kB',
  'MemAvailable:   28000000 kB',
  'SwapTotal:             0 kB',
  'SwapFree:              0 kB',
  '@@RMON netdev',
  '  eth0: 10000000 0 0 0 0 0 0 0 20000000 0 0 0 0 0 0 0',
  '@@RMON diskstats',
  '   8       0 sda 1000 0 40000 500 2000 0 80000 900 0 1000 0',
  '@@RMON block',
  'sda',
  '@@RMON system',
  'Linux 5.15.0 x86_64',
  'idle-gpu-01',
  'Ubuntu 22.04.3 LTS',
  '@@RMON df',
  'Filesystem     1024-blocks      Used Available Capacity Mounted on',
  '/dev/sda2        491574528 200000000 291574528      41% /',
  '@@RMON ps',
  '  1234 python3   0.5  1.2 1048576 python3 idle.py',
  '@@RMON psmem',
  '  1234 python3   0.5  1.2 1048576 python3 idle.py',
  '@@RMON gpu',
  '0, GPU-aaa, NVIDIA L20, 0, 1000, 49152, 30, 40.00, 350.00, 30, 1900',
  '1, GPU-bbb, NVIDIA L20, 0, 2000, 49152, 31, 42.00, 350.00, 30, 1900',
  '@@RMON gpuapps',
  '',
  '@@RMON end',
].join('\n')

/** A box whose root disk is full while the CPU is idle. */
const FULL_DISK_PROBE = IDLE_PROBE
  .replace('200000000 291574528      41% /', '470000000  21574528      96% /')
  .replace('idle-gpu-01', 'full-disk-01')

/** Both GPUs held by a training process. */
const BUSY_GPU_PROBE = IDLE_PROBE
  .replace('NVIDIA L20, 0, 1000, 49152, 30', 'NVIDIA L20, 99, 46000, 49152, 74')
  .replace('NVIDIA L20, 0, 2000, 49152, 31', 'NVIDIA L20, 97, 44000, 49152, 72')
  .replace('@@RMON gpuapps\n\n', '@@RMON gpuapps\nGPU-aaa, 1234, python3, 46000\nGPU-bbb, 1235, python3, 44000\n')
  .replace('idle-gpu-01', 'busy-gpu-01')

/** Build a monitor whose pool returns one probe text. */
function makeMonitor(alias, probeText) {
  const entry = {
    alias, host: '10.0.0.1', port: 22, user: 'root', source: 'ssh-config',
    monitor: true, displayName: null, tags: [], environment: null,
  }
  const book = {
    thresholds: () => ({}),
    monitored: () => [entry],
    find: name => (name === alias ? entry : undefined),
    list: () => [entry],
    refresh: () => {},
  }
  const pool = {
    async exec() { return { ok: true, stdout: probeText } },
    status: () => ({ connected: true, since: Date.now(), attempts: 1 }),
    dispose: () => {},
  }
  const monitor = new Monitor({ book, pool, config: { rateProbeDelayMs: 200 } })
  return { monitor, entry, alias }
}

test('read() attaches capacity and a free host is schedulable', async () => {
  const { monitor, alias } = makeMonitor('idle-gpu-01', IDLE_PROBE)
  try {
    const payload = await monitor.readNow(alias, { fresh: true })
    assert.equal(payload.status, 'ok')
    assert.ok(payload.capacity, 'every payload carries the capacity view')
    assert.equal(payload.capacity.state, 'free')
    assert.equal(payload.capacity.schedulable, true)
    assert.equal(payload.capacity.gpuTotal, 2)
    assert.equal(payload.capacity.gpuFree, 2)
    assert.deepEqual(payload.capacity.freeGpuIndexes, [0, 1])
    assert.ok(payload.capacity.score >= 60)
    assert.equal(typeof payload.idleForSec, 'number')
    // The history ring keeps the score so a chart can draw it later.
    const history = monitor.history(alias)
    assert.equal(history.length, 1)
    assert.equal(history[0].score, payload.capacity.score)
    assert.equal(history[0].freeGpu, 2)
    assert.equal(typeof payload.idleIndex.index, 'number', 'every sample carries an idle index')
    assert.equal(history[0].index, payload.idleIndex.index, 'history keeps the index for charts')
  } finally {
    monitor.dispose()
  }
})

test('idleForSec grows while the host stays schedulable', async () => {
  const { monitor, alias } = makeMonitor('idle-gpu-01', IDLE_PROBE)
  try {
    await monitor.readNow(alias, { fresh: true })
    const state = monitor.states.get(alias)
    assert.ok(typeof state.idleSince === 'number' && state.idleSince > 0, 'a free host starts its idle clock')
    state.idleSince = Date.now() - 125_000
    const payload = monitor.get(alias)
    assert.ok(payload.idleForSec >= 124, `idleForSec should report 2m, got ${payload.idleForSec}`)
  } finally {
    monitor.dispose()
  }
})

test('a full disk makes an idle host unschedulable but still reports headroom', async () => {
  const { monitor, alias } = makeMonitor('full-disk-01', FULL_DISK_PROBE)
  try {
    const payload = await monitor.readNow(alias, { fresh: true })
    assert.equal(payload.capacity.schedulable, false)
    assert.equal(payload.capacity.blockers.some(blocker => blocker.code === 'disk'), true)
    assert.equal(payload.idleForSec, 0, 'a blocked host is not "idle for" anything')
  } finally {
    monitor.dispose()
  }
})

test('both GPUs held by training makes the host busy', async () => {
  const { monitor, alias } = makeMonitor('busy-gpu-01', BUSY_GPU_PROBE)
  try {
    const payload = await monitor.readNow(alias, { fresh: true })
    assert.equal(payload.capacity.gpuFree, 0)
    assert.equal(payload.capacity.state, 'busy')
    assert.equal(payload.capacity.schedulable, false)
    assert.equal(payload.idleForSec, 0)
  } finally {
    monitor.dispose()
  }
})

test('an unreachable host loses its idle streak', async () => {
  const entry = { alias: 'gone', host: '10.0.0.9', port: 22, user: 'root', source: 'ssh-config', monitor: true }
  const book = { thresholds: () => ({}), monitored: () => [entry], find: () => entry, list: () => [entry], refresh: () => {} }
  const pool = {
    async exec() { return { ok: false, error: 'connect timeout' } },
    status: () => ({ connected: false, since: null, attempts: 1 }),
    dispose: () => {},
  }
  const monitor = new Monitor({ book, pool, config: {} })
  try {
    const payload = await monitor.readNow('gone', { fresh: true })
    assert.equal(payload.status, 'down')
    assert.equal(payload.capacity, null)
    assert.equal(payload.idleForSec, 0)
  } finally {
    monitor.dispose()
  }
})

test('a sustained low-utilisation period becomes a warning alert', async () => {
  const { monitor, alias } = makeMonitor('idle-gpu-01', IDLE_PROBE)
  monitor.lowUsageOptions = { enabled: true, cpuBelow: 15, gpuBelow: 10, forSec: 60 }
  try {
    const first = await monitor.readNow(alias, { fresh: true })
    assert.equal(first.lowUsage.low, true, 'an idle box is under-used from the first sample')
    assert.equal(first.status, 'ok')
    assert.equal(first.alerts.some(alert => alert.key === 'low-usage'), false, 'but not before the window elapses')

    const state = monitor.states.get(alias)
    state.lowSince = Date.now() - 125_000
    const second = await monitor.readNow(alias, { fresh: true })
    const alert = second.alerts.find(item => item.key === 'low-usage')
    assert.ok(alert, 'the warning fires once the window has elapsed')
    assert.equal(alert.level, 'warn')
    assert.ok(alert.forSec >= 120)
    assert.equal(second.lowUsage.forSec >= 120, true)
  } finally {
    monitor.dispose()
  }
})

test('the low-utilisation reminder can be switched off', async () => {
  const { monitor, alias } = makeMonitor('idle-gpu-01', IDLE_PROBE)
  monitor.lowUsageOptions = { enabled: false, cpuBelow: 15, gpuBelow: 10, forSec: 60 }
  try {
    await monitor.readNow(alias, { fresh: true })
    monitor.states.get(alias).lowSince = Date.now() - 500_000
    const payload = await monitor.readNow(alias, { fresh: true })
    assert.equal(payload.lowUsage.enabled, false)
    assert.equal(payload.alerts.some(alert => alert.key === 'low-usage'), false)
  } finally {
    monitor.dispose()
  }
})

test('an observation gap restarts the clocks instead of claiming unobserved idleness', async () => {
  const { monitor, alias } = makeMonitor('idle-gpu-01', IDLE_PROBE)
  monitor.lowUsageOptions = { enabled: true, cpuBelow: 15, gpuBelow: 10, forSec: 60 }
  try {
    await monitor.readNow(alias, { fresh: true })
    const state = monitor.states.get(alias)
    state.idleSince = Date.now() - 500_000
    state.lowSince = Date.now() - 500_000
    state.lastSample.sampledAt = Date.now() - 3_600_000 // nobody watched for an hour
    const payload = await monitor.readNow(alias, { fresh: true })
    assert.ok(payload.idleForSec < 60, `idle clock should restart, got ${payload.idleForSec}`)
    assert.equal(payload.alerts.some(alert => alert.key === 'low-usage'), false)
    assert.ok(payload.lowUsage.forSec < 60)
  } finally {
    monitor.dispose()
  }
})

test('footer polling settings are exposed and clamped', () => {
  const { monitor } = makeMonitor('idle-gpu-01', IDLE_PROBE)
  try {
    assert.deepEqual(monitor.info().footer, { enabled: true, live: true, pollSec: 60 })
    monitor.applyTuning({ footer: { pollSec: 5 } })
    assert.equal(monitor.info().footer.pollSec, 30, 'a too-eager poll is clamped')
    monitor.applyTuning({ footer: { enabled: false, pollSec: 300 } })
    assert.deepEqual(monitor.info().footer, { enabled: false, live: true, pollSec: 300 })
  } finally {
    monitor.dispose()
  }
})

test('the idle index grows as the host stays idle', async () => {
  const { monitor, alias } = makeMonitor('idle-gpu-01', IDLE_PROBE)
  try {
    const first = await monitor.readNow(alias, { fresh: true })
    assert.ok(first.idleIndex.index >= 40 && first.idleIndex.index <= 60, 'freshly idle scores around half')
    const state = monitor.states.get(alias)
    state.idleSince = Date.now() - 3600_000
    const second = await monitor.readNow(alias, { fresh: true })
    assert.ok(second.idleIndex.index >= 80, `after an hour the index should be high, got ${second.idleIndex.index}`)
    assert.equal(second.idleIndex.basis, 'gpu')
  } finally {
    monitor.dispose()
  }
})
