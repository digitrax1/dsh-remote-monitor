/**
 * Host discovery tests: the ssh_config parser, the dsh-ssh store reader, and
 * the merge that decides what actually gets monitored.
 *
 * This layer is where a wrong merge silently monitors the wrong machine, so the
 * precedence rules are pinned here rather than trusted.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blocksToHosts, readSshConfigBlocks, expandTilde } from '../src/ssh-config.js'
import { HostBook, normalizeThresholds, readDshSshHosts, ALIAS_RE } from '../src/store.js'

/** A scratch directory with the given files written into it. */
function scratch(files) {
  const dir = mkdtempSync(join(tmpdir(), 'drm-test-'))
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content, 'utf8')
  }
  return dir
}

test('readSshConfigBlocks: Host blocks, Include expansion, Match dropped', () => {
  const dir = scratch({
    'config': [
      'Include extra.conf',
      '',
      'Host alpha',
      '  HostName 10.0.0.1',
      '  User root',
      '  Port 2222',
      '',
      'Match host *.internal',
      '  User nobody',
      '',
      'Host beta',
      '  User deploy',
      '  # a comment is not a directive',
      '  ProxyJump alpha',
    ].join('\n'),
    'extra.conf': 'Host gamma\n  HostName 10.0.0.3\n',
  })
  try {
    const blocks = readSshConfigBlocks(join(dir, 'config'))
    assert.deepEqual(blocks.map(block => block.pattern), ['gamma', 'alpha', 'beta'])
    assert.equal(blocks[0].props.hostname, '10.0.0.3')
    assert.equal(blocks[1].props.port, '2222')
    // The Match block must not leak its User into `beta`.
    assert.equal(blocks[2].props.user, 'deploy')
    assert.equal(blocks[2].props.proxyjump, 'alpha')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('blocksToHosts: wildcards skipped, HostName falls back to the pattern', () => {
  const hosts = blocksToHosts([
    { pattern: '*', props: { user: 'root' } },
    { pattern: 'plain', props: {} },
    { pattern: 'named', props: { hostname: 'real.example.com', user: 'someone', port: '2200' } },
    { pattern: 'withkey', props: { identityfile: '~/.ssh/id_rsa' } },
    { pattern: 'withjump', props: { proxyjump: 'a,b', proxycommand: 'ssh -W %h:%p bastion' } },
  ], { defaultUser: 'fallback' })

  assert.deepEqual(hosts.map(host => host.alias), ['plain', 'named', 'withkey', 'withjump'])
  assert.equal(hosts[0].host, 'plain', 'a block without HostName uses the pattern')
  assert.equal(hosts[0].user, 'fallback')
  assert.equal(hosts[1].port, 2200)
  assert.equal(hosts[2].auth.kind, 'key', 'an IdentityFile selects key auth')
  assert.equal(hosts[2].auth.keyPath, expandTilde('~/.ssh/id_rsa'))
  assert.equal(hosts[0].auth.kind, 'auto', 'no IdentityFile means agent-then-defaults')
  assert.deepEqual(hosts[3].proxyJump, ['a', 'b'])
  assert.equal(hosts[3].proxyCommand, 'ssh -W %h:%p bastion')
  assert.ok(hosts.every(host => host.source === 'ssh-config'))
})

test('readDshSshHosts: reads the dsh-ssh store shape and tolerates junk', () => {
  const dir = scratch({
    'dsh-ssh.json': JSON.stringify({
      version: 1,
      hosts: [
        { alias: 'good', host: '1.2.3.4', port: 22, user: 'root', auth: { kind: 'key', keyPath: '/k' }, proxyJump: [], tags: ['gpu'] },
        { alias: 'nohost', user: 'root' },
        { host: '1.1.1.1', user: 'root' },
        'junk',
      ],
    }),
  })
  try {
    const hosts = readDshSshHosts(join(dir, 'dsh-ssh.json'))
    assert.equal(hosts.length, 1)
    assert.equal(hosts[0].alias, 'good')
    assert.equal(hosts[0].auth.kind, 'key')
    assert.deepEqual(hosts[0].tags, ['gpu'])
    assert.equal(hosts[0].source, 'dsh-ssh')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HostBook: the dsh-ssh entry wins over the ssh_config block for one alias', () => {
  const dir = scratch({
    'ssh-config': 'Host shared\n  HostName 10.0.0.1\n  User root\n',
    'dsh-ssh.json': JSON.stringify({
      version: 1,
      hosts: [{ alias: 'shared', host: '10.9.9.9', port: 2222, user: 'deploy', auth: { kind: 'password', password: 'x' }, proxyJump: [], tags: [] }],
    }),
    'settings.json': '{}',
  })
  try {
    const book = new HostBook({
      settingsFile: join(dir, 'settings.json'),
      sshConfigFile: join(dir, 'ssh-config'),
      dshSshFile: join(dir, 'dsh-ssh.json'),
    })
    const host = book.find('shared')
    assert.equal(host.host, '10.9.9.9', 'the explicitly configured entry wins')
    assert.equal(host.port, 2222)
    assert.equal(host.user, 'deploy')
    assert.equal(host.source, 'dsh-ssh')
    assert.equal(book.list().length, 1, 'one alias is one host')
    assert.deepEqual(book.sources.map(source => source.source), ['ssh-config', 'dsh-ssh', 'manual'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HostBook: a manual entry adds a host, and the monitor switch persists', () => {
  const dir = scratch({ 'ssh-config': 'Host discovered\n  HostName 10.0.0.1\n', 'settings.json': '{}' })
  try {
    const book = new HostBook({
      settingsFile: join(dir, 'settings.json'),
      sshConfigFile: join(dir, 'ssh-config'),
      dshSshFile: join(dir, 'missing.json'),
    })
    assert.equal(book.find('discovered').monitor, true, 'discovered hosts are monitored by default')

    book.updateHost('manual-one', { host: '192.0.2.10', user: 'ops', port: 2200, monitor: true })
    assert.equal(book.find('manual-one').source, 'manual')
    assert.equal(book.find('manual-one').port, 2200)

    book.updateHost('discovered', { monitor: false, label: 'GPU 集群' })
    assert.equal(book.find('discovered').monitor, false)
    assert.equal(book.find('discovered').displayName, 'GPU 集群')
    assert.deepEqual(book.monitored().map(host => host.alias), ['manual-one'])

    // The switch survives a reload from disk.
    const reloaded = new HostBook({
      settingsFile: join(dir, 'settings.json'),
      sshConfigFile: join(dir, 'ssh-config'),
      dshSshFile: join(dir, 'missing.json'),
    })
    assert.equal(reloaded.find('discovered').monitor, false)
    assert.equal(reloaded.find('manual-one').host, '192.0.2.10')

    // Forgetting a manual host removes it; a discovered one comes back.
    reloaded.forgetHost('manual-one')
    assert.equal(reloaded.find('manual-one'), undefined)
    reloaded.forgetHost('discovered')
    assert.ok(reloaded.find('discovered') !== undefined)
    assert.equal(reloaded.find('discovered').monitor, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HostBook: thresholds take Config defaults, then the panel override', () => {
  const dir = scratch({ 'ssh-config': '', 'settings.json': '{}' })
  try {
    const book = new HostBook({
      settingsFile: join(dir, 'settings.json'),
      sshConfigFile: join(dir, 'ssh-config'),
      dshSshFile: join(dir, 'missing.json'),
      thresholds: { cpu: 75, disk: 70 },
    })
    assert.equal(book.thresholds().cpu, 75, 'a Config default applies')
    assert.equal(book.thresholds().mem, 90, 'an unset key keeps the built-in default')

    book.updateThresholds({ cpu: 50 })
    assert.equal(book.thresholds().cpu, 50, 'the panel override wins')
    assert.equal(book.thresholds().disk, 70, 'other Config defaults survive')

    book.updateThresholds({ disk: 0 })
    assert.equal(book.thresholds().disk, 0, 'zero is preserved (it disables the rule)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HostBook: low-usage settings take Config defaults, then the panel override', () => {
  const dir = scratch({ 'ssh-config': '', 'settings.json': '{}' })
  try {
    const options = {
      settingsFile: join(dir, 'settings.json'),
      sshConfigFile: join(dir, 'ssh-config'),
      dshSshFile: join(dir, 'missing.json'),
      lowUsage: { cpuBelow: 20, forSec: 300 },
    }
    const book = new HostBook(options)
    assert.equal(book.lowUsage().cpuBelow, 20, 'a Config default applies')
    assert.equal(book.lowUsage().gpuBelow, 10, 'an unset key keeps the built-in default')
    assert.equal(book.lowUsage().forSec, 300)
    assert.equal(book.lowUsage().enabled, true)

    book.updateLowUsage({ gpuBelow: 5, enabled: false })
    assert.equal(book.lowUsage().gpuBelow, 5, 'the panel override wins')
    assert.equal(book.lowUsage().enabled, false)

    const reloaded = new HostBook(options)
    assert.equal(reloaded.lowUsage().gpuBelow, 5, 'the override is persisted in the settings file')
    assert.equal(reloaded.lowUsage().enabled, false)
    assert.equal(reloaded.snapshot().lowUsage.cpuBelow, 20, 'the host-list payload carries the settings')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HostBook: a corrupt settings file degrades instead of throwing', () => {
  const dir = scratch({ 'ssh-config': 'Host a\n  HostName 10.0.0.1\n', 'settings.json': '{ not json' })
  try {
    const book = new HostBook({
      settingsFile: join(dir, 'settings.json'),
      sshConfigFile: join(dir, 'ssh-config'),
      dshSshFile: join(dir, 'missing.json'),
    })
    assert.equal(book.list().length, 1)
    assert.equal(book.find('a').monitor, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('normalizeThresholds and ALIAS_RE: bounds and grammar', () => {
  const thresholds = normalizeThresholds({ cpu: -5, mem: 'abc', disk: 95, temp: 0 })
  assert.equal(thresholds.cpu, 90, 'a negative value is not a threshold')
  assert.equal(thresholds.mem, 90, 'a non-numeric value falls back')
  assert.equal(thresholds.disk, 95)
  assert.equal(thresholds.temp, 0, 'zero is a legal "disabled" value')
  assert.equal(thresholds.loadPerCore, 100)

  assert.ok(ALIAS_RE.test('gpu-alias'))
  assert.ok(ALIAS_RE.test('10.0.0.1'))
  assert.ok(!ALIAS_RE.test('-leading'))
  assert.ok(!ALIAS_RE.test('has space'))
})
