/**
 * Unit tests for the probe layer. Run with `node --test test/`.
 *
 * The fixtures are realistic Linux outputs (a dual-socket GPU box and a
 * container), including the awkward shapes: a GNU `df` row whose device name
 * wrapped onto its own line, nvidia-smi `[N/A]` cells, and a counter reset.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildProbeScript,
  encodeProbeCommand,
  splitSections,
  parseCpuLine,
  parseMeminfo,
  parseDf,
  parseDiskstats,
  parseNetDev,
  parsePs,
  parseGpus,
  parseProbe,
  deriveSample,
  evaluateAlerts,
} from '../src/probe.js'

test('buildProbeScript: full probe carries the heavy sections, light probe does not', () => {
  const full = buildProbeScript({ topN: 5 })
  assert.match(full, /nvidia-smi/)
  assert.match(full, /df -P -k/)
  assert.match(full, /head -n 5/)
  const light = buildProbeScript({ light: true })
  assert.doesNotMatch(light, /nvidia-smi/)
  assert.doesNotMatch(light, /df -P -k/)
  assert.match(light, /\/proc\/stat/)
})

test('buildProbeScript: the process depth is forced to a bounded integer', () => {
  assert.match(buildProbeScript({ topN: 12.9 }), /head -n 12\b/)
  // A hostile value degrades to the default; nothing from it reaches the script.
  const script = buildProbeScript({ topN: '7; rm -rf /' })
  assert.match(script, /head -n 8\b/)
  assert.doesNotMatch(script, /rm -rf/)
})

test('encodeProbeCommand: base64 only, no script text on the wire', () => {
  const command = encodeProbeCommand('echo "hello $USER"')
  assert.match(command, /openssl base64 -d -A/)
  assert.ok(!command.includes('hello'))
  assert.ok(!command.includes('"'))
})

test('splitSections: markers delimit verbatim content', () => {
  const sections = splitSections('@@RMON a\n1\n@@RMON b\nx y\nz\n@@RMON end\n')
  assert.deepEqual(sections.get('a'), ['1'])
  assert.deepEqual(sections.get('b'), ['x y', 'z'])
  assert.deepEqual(sections.get('end'), [''], 'the trailing newline lands in the last section')
})

test('parseCpuLine: total excludes guest, idle folds in iowait', () => {
  const cpu = parseCpuLine('cpu  100 2 50 800 20 0 3 1 0 0')
  assert.equal(cpu.name, 'cpu')
  assert.equal(cpu.total, 100 + 2 + 50 + 800 + 20 + 0 + 3 + 1)
  assert.equal(cpu.idleTotal, 820)
})

test('parseMeminfo: converts kB to bytes and folds SReclaimable into cache', () => {
  const mem = parseMeminfo([
    'MemTotal:       32768000 kB',
    'MemFree:         1000000 kB',
    'MemAvailable:   20000000 kB',
    'Buffers:          500000 kB',
    'Cached:          8000000 kB',
    'SReclaimable:    1000000 kB',
    'SwapTotal:       2000000 kB',
    'SwapFree:        1500000 kB',
  ])
  assert.equal(mem.totalBytes, 32768000 * 1024)
  assert.equal(mem.availableBytes, 20000000 * 1024)
  assert.equal(mem.cachedBytes, 9000000 * 1024)
  assert.equal(mem.swapTotalBytes, 2000000 * 1024)
})

test('parseDf: re-attaches a wrapped device name and skips the header', () => {
  const rows = parseDf([
    'Filesystem     1024-blocks      Used Available Capacity Mounted on',
    '/dev/nvme0n1p2   491574528 120000000 350000000      26% /',
    '/dev/mapper/very-long-volume-name-that-gnu-df-wraps-onto-its-own-line',
    '                 983040000  10000000 950000000       2% /data',
    'tmpfs              16384000         0  16384000       0% /dev/shm',
  ])
  assert.equal(rows.length, 3)
  assert.equal(rows[1].filesystem, '/dev/mapper/very-long-volume-name-that-gnu-df-wraps-onto-its-own-line')
  assert.equal(rows[1].mount, '/data')
  assert.equal(rows[1].sizeBytes, 983040000 * 1024)
  assert.equal(rows[1].usePercent, 2)
})

test('parseProbe: keeps a container overlay root and drops its bind-mount twin', () => {
  // Verbatim from a GPU container: the root is an overlay (which must NOT be
  // filtered as a pseudo filesystem), and the same numbers reappear as a
  // bind-mounted /etc/hosts. Only two rows are real disks.
  const raw = parseProbe([
    '@@RMON df',
    'Filesystem         1024-blocks         Used    Available Capacity Mounted on',
    'overlay              514235444    395008768     97999608      81% /',
    'tmpfs                    65536            0        65536       0% /dev',
    'tmpfs                241172480     39884124    201288356      17% /dev/shm',
    '/dev/vda3            514235444    395008768     97999608      81% /etc/hosts',
    '11.89.250.85:/cfs 429496729600 283021788160 146474941440      66% /mnt/workspace',
    'tmpfs                483709696            0    483709696       0% /sys/fs/cgroup',
    '@@RMON end',
  ].join('\n'))
  assert.deepEqual(raw.mounts.map(mount => mount.mount), ['/', '/mnt/workspace'])
  assert.equal(raw.mounts[0].filesystem, 'overlay')
  assert.equal(raw.mounts[0].usePercent, 81)
  assert.equal(raw.mounts[1].filesystem, '11.89.250.85:/cfs')
})

test('parseDf: two genuinely separate identical disks both survive', () => {
  const rows = parseDf([
    'Filesystem     1024-blocks      Used Available Capacity Mounted on',
    '/dev/sdb1        1000000    500000    500000      50% /data1',
    '/dev/sdc1        1000000    500000    500000      50% /data2',
  ])
  assert.equal(rows.length, 2, 'identical numbers at sibling paths are not a bind mount')
})

test('parseDiskstats: sectors become bytes, partitions parse too', () => {
  const map = parseDiskstats([
    '   8       0 sda 1000 20 40000 500 2000 30 80000 900 0 1000 1400',
    '   8       1 sda1 900 10 30000 400 100 5 2000 60 0 400 460',
  ])
  assert.equal(map.get('sda').readBytes, 40000 * 512)
  assert.equal(map.get('sda').writeBytes, 80000 * 512)
  assert.equal(map.get('sda').reads, 1000)
  assert.equal(map.get('sda').busyMs, 1000)
})

test('parseNetDev: reads rx from field 1 and tx from field 9', () => {
  const map = parseNetDev([
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0',
    '  eth0: 5000000 4000 0 0 0 0 0 0 7000000 5000 0 0 0 0 0 0',
  ])
  assert.equal(map.get('eth0').rxBytes, 5000000)
  assert.equal(map.get('eth0').txBytes, 7000000)
  assert.equal(map.get('lo').rxBytes, 1000)
})

test('parsePs: keeps the command tail intact', () => {
  const rows = parsePs([
    '  1234 python3   250.5  3.2 1048576 /usr/bin/python3 train.py --epochs 10 --lr 0.001',
    '  5678  nginx      0.0  0.1   20480 nginx: worker process',
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].cpuPercent, 250.5)
  assert.equal(rows[0].rssBytes, 1048576 * 1024)
  assert.equal(rows[0].command, '/usr/bin/python3 train.py --epochs 10 --lr 0.001')
  assert.equal(rows[1].name, 'nginx')
})

test('parseGpus: joins compute processes by UUID and tolerates [N/A]', () => {
  const gpus = parseGpus(
    [
      '0, GPU-aaa, NVIDIA L20, 87, 21000, 49152, 61, 145.30, 350.00, 45, 1755',
      '1, GPU-bbb, NVIDIA L20, [N/A], 0, 49152, 40, [N/A], 350.00, 30, [N/A]',
    ],
    [
      'GPU-aaa, 4242, python3, 20000',
      'GPU-bbb, 99, Xorg, 12',
    ],
  )
  assert.equal(gpus.length, 2)
  assert.equal(gpus[0].utilPercent, 87)
  assert.equal(gpus[0].memUsedBytes, 21000 * 1024 * 1024)
  assert.equal(gpus[0].tempC, 61)
  assert.equal(gpus[0].powerW, 145.3)
  assert.deepEqual(gpus[0].processes, [{ pid: 4242, name: 'python3', memBytes: 20000 * 1024 * 1024 }])
  assert.equal(gpus[1].utilPercent, null)
  assert.equal(gpus[1].powerW, null)
  assert.equal(gpus[1].processes[0].name, 'Xorg')
})

/** A full two-tick fixture: same box, counters advanced by exactly 10 s. */
function fixturePair() {
  const head = [
    '@@RMON probe',
    '1000000.00 5000.00',
    '@@RMON loadavg',
    '2.50 2.00 1.50 3/1200 99999',
    '@@RMON nproc',
    '64',
    '@@RMON stat',
    'cpu  1000 0 500 8000 200 0 50 0 0 0',
    'cpu0 100 0 50 800 20 0 5 0 0 0',
  ]
  const second = [
    '@@RMON stat',
    'cpu  2000 0 1000 14000 400 0 100 0 0 0',
    'cpu0 200 0 100 1400 40 0 10 0 0 0',
  ]
  const tailFull = [
    '@@RMON meminfo',
    'MemTotal:       32768000 kB',
    'MemAvailable:   8192000 kB',
    'SwapTotal:       2000000 kB',
    'SwapFree:        1000000 kB',
    '@@RMON netdev',
    '  eth0: 10000000 0 0 0 0 0 0 0 20000000 0 0 0 0 0 0 0',
    '    lo: 100 0 0 0 0 0 0 0 100 0 0 0 0 0 0 0',
    '@@RMON diskstats',
    '   8       0 sda 1000 0 40000 500 2000 0 80000 900 0 1000 0',
    '@@RMON block',
    'sda',
    '@@RMON system',
    'Linux 5.15.0 x86_64',
    'gpu-node-01',
    'Ubuntu 22.04.3 LTS',
    '@@RMON df',
    'Filesystem     1024-blocks      Used Available Capacity Mounted on',
    '/dev/sda2        491574528 460000000  20000000      96% /',
    'tmpfs             16384000         0  16384000       0% /dev/shm',
    '@@RMON ps',
    '  1234 python3   300.0  3.2 1048576 python3 train.py',
    '@@RMON psmem',
    '  4321 postgres   1.0 22.5 8000000 postgres: writer',
    '@@RMON gpu',
    '0, GPU-aaa, NVIDIA L20, 97, 47000, 49152, 78, 320.00, 350.00, 90, 1900',
    '@@RMON gpuapps',
    'GPU-aaa, 1234, python3, 46000',
    '@@RMON end',
  ]
  const first = [...head, ...tailFull].join('\n')
  const secondText = [
    '@@RMON probe',
    '1000010.00 5010.00',
    '@@RMON loadavg',
    '3.00 2.40 1.80 12/1300 100000',
    '@@RMON nproc',
    '64',
    ...second,
    '@@RMON meminfo',
    'MemTotal:       32768000 kB',
    'MemAvailable:   4096000 kB',
    'SwapTotal:       2000000 kB',
    'SwapFree:         500000 kB',
    '@@RMON netdev',
    '  eth0: 11000000 0 0 0 0 0 0 0 20500000 0 0 0 0 0 0 0',
    '@@RMON diskstats',
    '   8       0 sda 1000 0 40000 500 2000 0 80000 900 0 2000 0',
  ].join('\n')
  return { first, secondText }
}

test('parseProbe: reads a full probe into counters and heavy sections', () => {
  const { first } = fixturePair()
  const raw = parseProbe(first)
  assert.equal(raw.nproc, 64)
  assert.equal(raw.load[0], 2.5)
  assert.equal(raw.mem.totalBytes, 32768000 * 1024)
  assert.equal(raw.net.get('eth0').rxBytes, 10000000)
  assert.equal(raw.disk.get('sda').writeBytes, 80000 * 512)
  assert.deepEqual(raw.blockDevices, ['sda'])
  assert.equal(raw.system.hostname, 'gpu-node-01')
  assert.equal(raw.mounts.length, 1, 'tmpfs is filtered out of the mount table')
  assert.equal(raw.mounts[0].mount, '/')
  assert.equal(raw.psCpu[0].pid, 1234)
  assert.equal(raw.psMem[0].pid, 4321)
  assert.equal(raw.gpus.length, 1)
})

test('deriveSample: computes cpu, memory, network and disk-IO deltas', () => {
  const { first, secondText } = fixturePair()
  const prev = parseProbe(first)
  const curr = parseProbe(secondText)
  const sample = deriveSample({ prev, curr, full: prev, dtMs: 10000 })

  // cpu: total delta 7750, idle delta 6200 -> 20.0% busy
  assert.equal(sample.cpu.percent, 20)
  assert.equal(sample.cpu.cores[0].percent, 20)
  assert.equal(sample.cpu.nproc, 64)
  // The breakdown is a share of the interval, not the raw jiffy counter.
  assert.equal(sample.cpu.user, 12.9)
  assert.equal(sample.cpu.system, 6.5)
  assert.equal(sample.cpu.iowait, 2.6)
  assert.equal(sample.cpu.steal, 0)

  // memory: total - available
  assert.equal(sample.mem.usedBytes, (32768000 - 4096000) * 1024)
  assert.equal(sample.mem.percent, 87.5)
  assert.equal(sample.mem.swapUsedBytes, 1500000 * 1024)

  // network: 1 MB rx over 10 s; loopback excluded by default
  assert.equal(sample.net.length, 1)
  assert.equal(sample.net[0].name, 'eth0')
  assert.equal(sample.net[0].rxBps, 100000)
  assert.equal(sample.net[0].txBps, 50000)

  // disk IO is read from the CURRENT sample, not the stale full probe
  assert.equal(sample.diskIo.length, 1)
  assert.equal(sample.diskIo[0].name, 'sda')
  assert.equal(sample.diskIo[0].busyPercent, 10)

  // heavy sections come from the last FULL probe
  assert.equal(sample.disks.length, 1)
  assert.equal(sample.disks[0].usePercent, 96)
  assert.equal(sample.topCpu[0].pid, 1234)
  assert.equal(sample.gpus[0].memPercent, 95.6)
  assert.equal(sample.system.hostname, 'gpu-node-01')
})

test('deriveSample: the first read reports no rates instead of zero', () => {
  const { first } = fixturePair()
  const raw = parseProbe(first)
  const sample = deriveSample({ prev: null, curr: raw, dtMs: 0 })
  assert.equal(sample.ratesReady, false)
  assert.equal(sample.cpu.percent, null)
  assert.equal(sample.net[0].rxBps, null)
  assert.equal(sample.mem.percent, 75, 'gauges still work without a previous read')
})

test('deriveSample: a counter reset yields null rather than a negative rate', () => {
  const { first } = fixturePair()
  const prev = parseProbe(first)
  const reset = parseProbe('@@RMON netdev\n  eth0: 5 0 0 0 0 0 0 0 5 0 0 0 0 0 0 0\n@@RMON end')
  const sample = deriveSample({ prev, curr: reset, dtMs: 5000, full: prev })
  assert.equal(sample.net[0].rxBps, null)
})

test('evaluateAlerts: fires on the configured thresholds and stays quiet below', () => {
  const { first, secondText } = fixturePair()
  const prev = parseProbe(first)
  const curr = parseProbe(secondText)
  const sample = deriveSample({ prev, curr, full: prev, dtMs: 10000 })

  const alerts = evaluateAlerts(sample, { cpu: 90, mem: 80, disk: 90, gpu: 95, temp: 75 })
  const keys = alerts.map(alert => alert.key)
  assert.ok(keys.includes('mem'))
  assert.ok(keys.includes('disk:/'))
  assert.ok(keys.includes('gpu:0'))
  assert.ok(keys.includes('gpu-temp:0'))
  assert.ok(!keys.includes('cpu'), 'cpu at 17.3% is below 90')

  assert.deepEqual(evaluateAlerts(sample, {}), [], 'a threshold of 0 disables the rule')
})
