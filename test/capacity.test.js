/**
 * Idle-capacity model tests.
 *
 * The point of this model is that "free" is not "CPU below 50 %": a machine
 * with a full disk, exhausted VRAM or a queueing load must not be advertised as
 * available for the next job. These cases pin that behaviour down.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CAPACITY,
  evaluateCapacity,
  evaluateIdleIndex,
  evaluateLowUsage,
  lowUsageAlert,
  normalizeIdleIndex,
  normalizeLowUsage,
  normalizeCapacity,
  rankByCapacity,
  summarizeFleet,
} from '../src/capacity.js'

/** A host sample with sensible idle defaults; override what a case is about. */
function sample(overrides = {}) {
  return {
    sampledAt: 1_000,
    ratesReady: true,
    cpu: { percent: 5, nproc: 32, load: [1, 1, 1], iowait: 0, steal: 0 },
    mem: { totalBytes: 64 * 1024 ** 3, usedBytes: 8 * 1024 ** 3, availableBytes: 56 * 1024 ** 3, percent: 12.5 },
    disks: [{ mount: '/', usePercent: 40 }],
    gpus: [],
    ...overrides,
  }
}

/** One idle GPU row. */
function gpu(index, overrides = {}) {
  return {
    index,
    name: 'NVIDIA L20',
    utilPercent: 0,
    memPercent: 3,
    memUsedBytes: 1 * 1024 ** 3,
    memTotalBytes: 48 * 1024 ** 3,
    tempC: 30,
    processes: [],
    ...overrides,
  }
}

test('normalizeCapacity clamps and fills defaults', () => {
  const config = normalizeCapacity({ freeScore: 200, gpuUtilMax: -5, blockDiskPercent: 0 })
  assert.equal(config.freeScore, 100)
  assert.equal(config.gpuUtilMax, 0)
  assert.equal(config.blockDiskPercent, 1)
  assert.equal(config.partialScore, DEFAULT_CAPACITY.partialScore)
})

test('a completely idle GPU host is free and schedulable', () => {
  const capacity = evaluateCapacity(sample({ gpus: [gpu(0), gpu(1), gpu(2), gpu(3)] }))
  assert.equal(capacity.state, 'free')
  assert.equal(capacity.schedulable, true)
  assert.equal(capacity.gpuTotal, 4)
  assert.equal(capacity.gpuFree, 4)
  assert.deepEqual(capacity.freeGpuIndexes, [0, 1, 2, 3])
  assert.ok(capacity.score >= 90)
  assert.equal(capacity.blockers.length, 0)
})

test('a GPU held by a process is not offered even at 0 % utilisation', () => {
  const busy = gpu(0, { utilPercent: 0, memPercent: 70, processes: [{ pid: 42, name: 'python', memBytes: 30 * 1024 ** 3 }] })
  const capacity = evaluateCapacity(sample({ gpus: [busy, gpu(1)] }))
  assert.equal(capacity.gpuTotal, 2)
  assert.equal(capacity.gpuFree, 1)
  assert.deepEqual(capacity.freeGpuIndexes, [1])
  assert.equal(capacity.freeGpuIndexes.includes(0), false)
  // One card is still free, so the machine can take a job.
  assert.equal(capacity.schedulable, true)
})

test('all GPUs saturated blocks scheduling and is reported as busy', () => {
  const saturated = [
    gpu(0, { utilPercent: 100, memPercent: 92 }),
    gpu(1, { utilPercent: 98, memPercent: 88 }),
  ]
  const capacity = evaluateCapacity(sample({ gpus: saturated }))
  assert.equal(capacity.gpuFree, 0)
  assert.equal(capacity.blockers.some(blocker => blocker.code === 'gpu'), true)
  // A GPU host with no free card has essentially no headroom for a new job.
  assert.equal(capacity.state, 'busy')
  assert.ok(capacity.score <= 25)
  assert.equal(capacity.schedulable, false)
})

test('a full disk blocks an otherwise idle machine', () => {
  const capacity = evaluateCapacity(sample({
    gpus: [gpu(0)],
    disks: [{ mount: '/', usePercent: 55 }, { mount: '/media/cfs/data', usePercent: 96 }],
  }))
  assert.equal(capacity.state, 'free')
  assert.equal(capacity.schedulable, false)
  const blocker = capacity.blockers.find(item => item.code === 'disk')
  assert.ok(blocker)
  assert.equal(blocker.target, '/media/cfs/data')
  assert.equal(blocker.value, 96)
})

test('exhausted memory blocks scheduling', () => {
  const capacity = evaluateCapacity(sample({ mem: { totalBytes: 64 * 1024 ** 3, usedBytes: 61 * 1024 ** 3, availableBytes: 3 * 1024 ** 3, percent: 95 } }))
  assert.equal(capacity.blockers.some(blocker => blocker.code === 'mem'), true)
  assert.equal(capacity.schedulable, false)
})

test('load per core is subtracted from CPU headroom', () => {
  const idle = evaluateCapacity(sample({ cpu: { percent: 10, nproc: 64, load: [1, 1, 1] } }))
  const queued = evaluateCapacity(sample({ cpu: { percent: 10, nproc: 64, load: [800, 700, 600] } }))
  assert.ok(idle.score > queued.score)
  assert.equal(queued.state, 'busy', 'a load of 12.5/core is not spare capacity')
  assert.equal(queued.schedulable, false)
  assert.equal(queued.blockers.some(blocker => blocker.code === 'load'), true)
})

test('CPU-only hosts use cpu and memory weights without GPU fields', () => {
  const capacity = evaluateCapacity(sample({ cpu: { percent: 20, nproc: 16, load: [2, 2, 2] } }))
  assert.equal(capacity.gpuTotal, 0)
  assert.equal(capacity.gpuFreePercent, null)
  assert.equal(capacity.state, 'free')
  assert.equal(capacity.freeCpuCores, 12.8)
  assert.equal(capacity.freeMemBytes, 56 * 1024 ** 3)
})

test('no sample or no counters yields unknown rather than a fake free', () => {
  assert.equal(evaluateCapacity(null).state, 'unknown')
  const capacity = evaluateCapacity({ sampledAt: 1, cpu: {}, mem: {}, disks: [], gpus: [] })
  assert.equal(capacity.state, 'unknown')
  assert.equal(capacity.score, null)
  assert.equal(capacity.schedulable, false)
})

test('a host with 30 % CPU and plenty of RAM but half its GPUs busy is partial', () => {
  const capacity = evaluateCapacity(sample({
    cpu: { percent: 30, nproc: 32, load: [2, 2, 2] },
    gpus: [gpu(0), gpu(1, { utilPercent: 95, memPercent: 90 })],
  }))
  assert.equal(capacity.gpuFree, 1)
  assert.ok(capacity.score > 0 && capacity.score < 100)
  assert.equal(capacity.blockers.length, 0, 'one busy GPU out of two is not a blocker')
})

test('summarizeFleet aggregates schedulable hosts and free resources', () => {
  const hosts = [
    { alias: 'a', status: 'ok', capacity: evaluateCapacity(sample({ gpus: [gpu(0), gpu(1)] })) },
    { alias: 'b', status: 'ok', capacity: evaluateCapacity(sample({ cpu: { percent: 95, nproc: 8, load: [8, 8, 8] } })) },
    { alias: 'c', status: 'down', capacity: null },
  ]
  const summary = summarizeFleet(hosts)
  assert.equal(summary.total, 3)
  assert.equal(summary.online, 2)
  assert.equal(summary.offline, 1)
  assert.equal(summary.schedulable, 1)
  assert.equal(summary.freeGpus, 2)
  assert.equal(summary.totalGpus, 2)
  assert.ok(summary.freeCores > 0)
})

test('rankByCapacity puts schedulable machines first, then by score', () => {
  const free = { alias: 'free', status: 'ok', capacity: evaluateCapacity(sample({ gpus: [gpu(0)] })) }
  const blocked = { alias: 'blocked', status: 'ok', capacity: evaluateCapacity(sample({ disks: [{ mount: '/', usePercent: 99 }] })) }
  const down = { alias: 'down', status: 'down', capacity: null }
  const ranked = rankByCapacity([down, blocked, free]).map(host => host.alias)
  assert.deepEqual(ranked, ['free', 'blocked', 'down'])
})

test('the model survives a thresholds-free config object', () => {
  const capacity = evaluateCapacity(sample(), {})
  assert.equal(typeof capacity.score, 'number')
})

test('low usage: an idle CPU-only host is under-used', () => {
  const usage = evaluateLowUsage(sample({ cpu: { percent: 4, nproc: 32, load: [0.2, 0.2, 0.2] } }))
  assert.equal(usage.enabled, true)
  assert.equal(usage.low, true)
  assert.match(usage.reason, /CPU 4%/)
})

test('low usage: a busy CPU host is not', () => {
  const usage = evaluateLowUsage(sample({ cpu: { percent: 62, nproc: 32, load: [4, 4, 4] } }))
  assert.equal(usage.low, false)
})

test('low usage: a queueing host with a low CPU number is not idle', () => {
  const usage = evaluateLowUsage(sample({ cpu: { percent: 6, nproc: 64, load: [96, 90, 80] } }))
  assert.equal(usage.low, false, 'load/core 1.5+ means the CPU number is lagging, not idle')
})

test('low usage: GPU host with idle cards is under-used', () => {
  const usage = evaluateLowUsage(sample({ gpus: [gpu(0), gpu(1)] }))
  assert.equal(usage.low, true)
  assert.equal(usage.gpuAvgUtil, 0)
  assert.match(usage.reason, /GPU avg 0%/)
})

test('low usage: an inference server holding VRAM is not idle at 0 % util', () => {
  const held = [gpu(0, { memPercent: 60, processes: [{ pid: 7, name: 'vllm', memBytes: 30 * 1024 ** 3 }] })]
  const usage = evaluateLowUsage(sample({ gpus: held }))
  assert.equal(usage.pinned, true)
  assert.equal(usage.low, false)
})

test('low usage: a GPU host with real utilisation is not idle', () => {
  const usage = evaluateLowUsage(sample({ gpus: [gpu(0, { utilPercent: 80 }), gpu(1, { utilPercent: 60 })] }))
  assert.equal(usage.low, false)
})

test('low usage: disabled means never low', () => {
  const usage = evaluateLowUsage(sample({ cpu: { percent: 1, nproc: 8, load: [0, 0, 0] } }), { enabled: false })
  assert.equal(usage.enabled, false)
  assert.equal(usage.low, false)
})

test('low usage: the window is clamped and the alert carries its duration', () => {
  const config = normalizeLowUsage({ forSec: 5, cpuBelow: 'x' })
  assert.equal(config.forSec, 60)
  assert.equal(config.cpuBelow, 15)
  const usage = evaluateLowUsage(sample({ cpu: { percent: 3, nproc: 16, load: [0.1, 0.1, 0.1] } }))
  const alert = lowUsageAlert(usage, 900)
  assert.equal(alert.key, 'low-usage')
  assert.equal(alert.level, 'warn')
  assert.equal(alert.kind, 'cpu')
  assert.equal(alert.forSec, 900)
  assert.match(alert.message, /idle for 15m/)
})

test('idle index: time and utilisation contribute equally', () => {
  const idleCpu = sample({ cpu: { percent: 0, nproc: 8, load: [0, 0, 0] } })
  const fresh = evaluateIdleIndex(idleCpu, 0)
  const half = evaluateIdleIndex(idleCpu, 1800)
  const long = evaluateIdleIndex(idleCpu, 7200)
  assert.equal(fresh.index, 50, '0 % CPU but idle for no time is only half the story')
  assert.equal(half.index, 75, 'one half-life lifts the time component to 50')
  assert.equal(long.index, 97, 'four half-lives: time score 93.75')
  assert.equal(fresh.basis, 'cpu')
  assert.equal(half.timeScore, 50)
})

test('idle index: a busy GPU keeps the index low however long it ran', () => {
  const busy = sample({ gpus: [gpu(0, { utilPercent: 100 }), gpu(1, { utilPercent: 80 })] })
  const result = evaluateIdleIndex(busy, 7200)
  assert.equal(result.basis, 'gpu')
  assert.equal(result.utilPercent, 90)
  assert.ok(result.index <= 52, `expected ≤52, got ${result.index}`)
})

test('idle index: a GPU idling for a long time scores high', () => {
  const idleGpu = sample({ gpus: [gpu(0), gpu(1)] })
  const result = evaluateIdleIndex(idleGpu, 3600)
  assert.equal(result.utilPercent, 0)
  assert.ok(result.index >= 80)
})

test('idle index: no utilisation data yields null rather than a fake number', () => {
  assert.equal(evaluateIdleIndex(null, 100).index, null)
  assert.equal(evaluateIdleIndex({ cpu: {}, mem: {}, disks: [], gpus: [] }, 100).index, null)
})

test('idle index: weights and half-life are clamped', () => {
  const config = normalizeIdleIndex({ halfLifeSec: 1, utilWeight: 5, timeWeight: -1 })
  assert.equal(config.halfLifeSec, 60)
  assert.equal(config.utilWeight, 1)
  assert.equal(config.timeWeight, 0)
  const zero = evaluateIdleIndex(sample({ cpu: { percent: 0, nproc: 4, load: [0, 0, 0] } }), 600, { utilWeight: 0, timeWeight: 0 })
  assert.equal(zero.index, null, 'all-zero weights cannot produce a score')
})
