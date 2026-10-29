/**
 * Host book — where the monitored machines come from.
 *
 * Three sources are merged by alias, most explicit last:
 *   1. `~/.ssh/config`               (source: 'ssh-config')
 *   2. `$DSH_HOME/dsh-ssh.json`      (source: 'dsh-ssh')  — the dsh-ssh plugin's store
 *   3. `$DSH_HOME/dsh-remote-monitor.json` (source: 'manual') — this plugin's own entries
 *
 * Only the third file is ever written by this plugin, and it holds no secrets:
 * it stores the per-alias monitoring switch, a display label, an optional
 * manual host definition, the alert thresholds, and the low-utilisation
 * reminder settings. Credentials stay wherever
 * the user already put them (an ssh-agent, a private key, or the ssh_config /
 * dsh-ssh.json entry), which is why re-entering a host is never necessary.
 *
 * @module dsh-remote-monitor/store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { normalizeLowUsage } from './capacity.js'
import { blocksToHosts, expandHome, readSshConfigBlocks } from './ssh-config.js'

/** Settings file format version. */
const FORMAT_VERSION = 1

/**
 * Resolve the DSH home directory: `$DSH_HOME` wins, `~/.dsh` is the fallback.
 * @param {Record<string, string|undefined>} [env] - environment to read.
 * @returns {string} absolute directory path.
 */
export function dshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(expandHome(fromEnv.trim()))
  return join(homedir(), '.dsh')
}

/** The dsh-ssh host store path. */
export function dshSshStorePath(env = process.env) {
  return join(dshHome(env), 'dsh-ssh.json')
}

/** This plugin's own settings path. */
export function settingsPath(env = process.env) {
  return join(dshHome(env), 'dsh-remote-monitor.json')
}

/** The user's OpenSSH config path. */
export function sshConfigPath() {
  return join(homedir(), '.ssh', 'config')
}

/** Merge defaults into a threshold set. */
export function normalizeThresholds(raw) {
  const source = typeof raw === 'object' && raw !== null ? raw : {}
  const pick = (key, fallback) => {
    const value = Number(source[key])
    return Number.isFinite(value) && value >= 0 ? value : fallback
  }
  return {
    cpu: pick('cpu', 90),
    mem: pick('mem', 90),
    swap: pick('swap', 50),
    disk: pick('disk', 90),
    gpu: pick('gpu', 95),
    gpuMem: pick('gpuMem', 95),
    temp: pick('temp', 85),
    loadPerCore: pick('loadPerCore', 100),
  }
}

/** Read a JSON file, or undefined when absent/unreadable/invalid. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Validate an alias: letters/digits plus dots, hyphens, underscores. */
export const ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * Read the host list out of the dsh-ssh plugin's store, if the user has one.
 * @param {string} path - the dsh-ssh.json path.
 * @returns {Array<object>} host entries tagged `source: 'dsh-ssh'`.
 */
export function readDshSshHosts(path) {
  const file = readJson(path)
  if (file === undefined || !Array.isArray(file.hosts)) return []
  const hosts = []
  for (const entry of file.hosts) {
    if (typeof entry !== 'object' || entry === null) continue
    const alias = typeof entry.alias === 'string' ? entry.alias : undefined
    if (alias === undefined || alias === '' || typeof entry.host !== 'string') continue
    const auth = typeof entry.auth === 'object' && entry.auth !== null ? entry.auth : {}
    const kind = auth.kind === 'key' || auth.kind === 'password' || auth.kind === 'agent' ? auth.kind : 'auto'
    hosts.push({
      alias,
      host: entry.host,
      port: Number.isInteger(entry.port) ? entry.port : 22,
      user: typeof entry.user === 'string' && entry.user !== '' ? entry.user : 'root',
      auth: {
        kind,
        keyPath: typeof auth.keyPath === 'string' ? auth.keyPath : undefined,
        passphrase: typeof auth.passphrase === 'string' ? auth.passphrase : undefined,
        password: typeof auth.password === 'string' ? auth.password : undefined,
        agentPath: typeof auth.agentPath === 'string' ? auth.agentPath : undefined,
      },
      proxyJump: Array.isArray(entry.proxyJump) ? entry.proxyJump.filter(hop => typeof hop === 'string') : [],
      proxyCommand: typeof entry.proxyCommand === 'string' ? entry.proxyCommand : undefined,
      description: typeof entry.description === 'string' ? entry.description : undefined,
      environment: typeof entry.environment === 'string' ? entry.environment : undefined,
      tags: Array.isArray(entry.tags) ? entry.tags.filter(tag => typeof tag === 'string') : [],
      location: typeof entry.location === 'string' ? entry.location : undefined,
      source: 'dsh-ssh',
    })
  }
  return hosts
}

/** Keep only the numeric threshold keys a caller actually supplied. */
function pickThresholds(raw) {
  const out = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const [key, value] of Object.entries(raw)) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) out[key] = parsed
  }
  return out
}

/** Keep only the low-utilisation keys a caller actually supplied. */
function pickLowUsage(raw) {
  const out = {}
  if (typeof raw !== 'object' || raw === null) return out
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  for (const key of ['cpuBelow', 'gpuBelow', 'forSec']) {
    const parsed = Number(raw[key])
    if (Number.isFinite(parsed) && parsed >= 0) out[key] = parsed
  }
  return out
}

/** The empty settings document. */
function emptySettings() {
  return { version: FORMAT_VERSION, hosts: {}, thresholds: {}, lowUsage: {} }
}

/** Coerce a persisted document into the current shape. */
function normalizeSettings(raw) {
  if (typeof raw !== 'object' || raw === null) return emptySettings()
  const hosts = {}
  const rawHosts = typeof raw.hosts === 'object' && raw.hosts !== null ? raw.hosts : {}
  for (const [alias, value] of Object.entries(rawHosts)) {
    if (typeof value !== 'object' || value === null) continue
    const entry = {}
    if (typeof value.monitor === 'boolean') entry.monitor = value.monitor
    if (typeof value.label === 'string' && value.label.trim() !== '') entry.label = value.label.trim()
    if (typeof value.host === 'string' && value.host.trim() !== '') {
      entry.host = value.host.trim()
      entry.user = typeof value.user === 'string' && value.user.trim() !== '' ? value.user.trim() : 'root'
      const port = Number(value.port)
      entry.port = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22
      if (typeof value.keyPath === 'string' && value.keyPath.trim() !== '') entry.keyPath = expandHome(value.keyPath.trim())
      if (typeof value.password === 'string' && value.password !== '') entry.password = value.password
      if (typeof value.agentPath === 'string' && value.agentPath.trim() !== '') entry.agentPath = value.agentPath.trim()
    }
    hosts[alias] = entry
  }
  return {
    version: FORMAT_VERSION,
    hosts,
    thresholds: pickThresholds(raw.thresholds),
    lowUsage: pickLowUsage(raw.lowUsage),
  }
}

/**
 * The host book: discovered hosts merged with this plugin's own settings.
 * Pure file I/O — no cordis, no ssh2 — so it is unit-testable.
 */
export class HostBook {
  /**
   * @param {{ settingsFile?: string, sshConfigFile?: string, dshSshFile?: string, thresholds?: object, lowUsage?: object }} [options] - path and default overrides (tests, and the plugin's own Config schema).
   */
  constructor(options = {}) {
    this.settingsFile = resolve(options.settingsFile ?? settingsPath())
    this.sshConfigFile = resolve(options.sshConfigFile ?? sshConfigPath())
    this.dshSshFile = resolve(options.dshSshFile ?? dshSshStorePath())
    /**
     * Threshold defaults from the plugin Config schema. A value the user
     * changed in the panel (persisted in the settings file) wins over it, so
     * the settings page and the panel are both usable without one silently
     * overriding the other.
     */
    this.thresholdDefaults = normalizeThresholds(options.thresholds)
    /** Low-utilisation defaults from the Config schema; panel overrides win. */
    this.lowUsageDefaults = normalizeLowUsage(options.lowUsage)
    /** @type {{ version: number, hosts: Record<string, object>, thresholds: object, lowUsage: object }} */
    this.settings = emptySettings()
    /** @type {Array<object>} */
    this.hosts = []
    /** @type {Array<{ source: string, path: string, ok: boolean, count: number, error?: string }>} */
    this.sources = []
    this.refresh()
  }

  /**
   * Re-read every source from disk and rebuild the merged host list.
   * @returns {{ hosts: Array<object>, sources: Array<object>, thresholds: object }}
   */
  refresh() {
    const settingsRaw = readJson(this.settingsFile)
    this.settings = settingsRaw === undefined ? emptySettings() : normalizeSettings(settingsRaw)

    const sources = []
    const byAlias = new Map()

    // 1. ~/.ssh/config
    if (existsSync(this.sshConfigFile)) {
      try {
        const blocks = readSshConfigBlocks(this.sshConfigFile)
        const hosts = blocksToHosts(blocks, { defaultUser: process.env.USER ?? 'root' })
        for (const host of hosts) byAlias.set(host.alias, host)
        sources.push({ source: 'ssh-config', path: this.sshConfigFile, ok: true, count: hosts.length })
      } catch (error) {
        sources.push({ source: 'ssh-config', path: this.sshConfigFile, ok: false, count: 0, error: message(error) })
      }
    } else {
      sources.push({ source: 'ssh-config', path: this.sshConfigFile, ok: true, count: 0 })
    }

    // 2. dsh-ssh store (more explicit than a raw ssh_config block)
    if (existsSync(this.dshSshFile)) {
      try {
        const hosts = readDshSshHosts(this.dshSshFile)
        for (const host of hosts) byAlias.set(host.alias, { ...(byAlias.get(host.alias) ?? {}), ...host })
        sources.push({ source: 'dsh-ssh', path: this.dshSshFile, ok: true, count: hosts.length })
      } catch (error) {
        sources.push({ source: 'dsh-ssh', path: this.dshSshFile, ok: false, count: 0, error: message(error) })
      }
    } else {
      sources.push({ source: 'dsh-ssh', path: this.dshSshFile, ok: true, count: 0 })
    }

    // 3. This plugin's own entries and per-alias overrides.
    let manualCount = 0
    for (const [alias, entry] of Object.entries(this.settings.hosts)) {
      if (!ALIAS_RE.test(alias)) continue
      if (typeof entry.host === 'string') {
        manualCount += 1
        byAlias.set(alias, {
          alias,
          host: entry.host,
          port: entry.port ?? 22,
          user: entry.user ?? 'root',
          auth: {
            kind: entry.keyPath !== undefined ? 'key' : entry.password !== undefined ? 'password' : 'auto',
            keyPath: entry.keyPath,
            password: entry.password,
            agentPath: entry.agentPath,
          },
          proxyJump: [],
          tags: [],
          source: 'manual',
        })
      }
    }
    sources.push({ source: 'manual', path: this.settingsFile, ok: true, count: manualCount })

    const hosts = []
    for (const [alias, host] of byAlias) {
      const override = this.settings.hosts[alias] ?? {}
      hosts.push({
        ...host,
        monitor: override.monitor !== false,
        label: override.label ?? host.label ?? null,
        displayName: override.label ?? host.description ?? alias,
        // A `~/.ssh/config` entry that shadows another alias' jump host is still
        // a real machine; only an explicit switch hides one.
        enabled: override.monitor !== false,
      })
    }
    hosts.sort((a, b) => a.alias.localeCompare(b.alias))
    this.hosts = hosts
    this.sources = sources
    return this.snapshot()
  }

  /** The current merged view. */
  snapshot() {
    return {
      hosts: this.hosts.map(host => ({ ...host })),
      sources: this.sources.map(source => ({ ...source })),
      thresholds: this.thresholds(),
      lowUsage: this.lowUsage(),
    }
  }

  /** All known hosts. */
  list() {
    return this.hosts
  }

  /** Hosts the user has left switched on. */
  monitored() {
    return this.hosts.filter(host => host.monitor)
  }

  /** One host by alias. */
  find(alias) {
    return this.hosts.find(host => host.alias === alias)
  }

  /** Effective alert thresholds: Config defaults with the panel's overrides applied. */
  thresholds() {
    return normalizeThresholds({ ...this.thresholdDefaults, ...this.settings.thresholds })
  }

  /** Effective low-utilisation settings: Config defaults with panel overrides. */
  lowUsage() {
    return normalizeLowUsage({ ...this.lowUsageDefaults, ...this.settings.lowUsage })
  }

  /**
   * Patch the low-utilisation reminder. A `forSec` of 0 is not allowed; use
   * `enabled: false` to switch it off.
   * @param {object} patch - present fields only.
   * @returns {object} the effective settings.
   */
  updateLowUsage(patch) {
    const next = { ...this.settings.lowUsage }
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new Error('lowUsage.enabled must be a boolean')
      next.enabled = patch.enabled
    }
    for (const key of ['cpuBelow', 'gpuBelow', 'forSec']) {
      if (patch[key] === undefined) continue
      const parsed = Number(patch[key])
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`lowUsage.${key} must be a non-negative number`)
      next[key] = parsed
    }
    this.settings.lowUsage = next
    this.save()
    return this.lowUsage()
  }

  /**
   * Patch one alias' settings (monitoring switch, label, manual definition).
   * @param {string} alias - the alias to patch.
   * @param {object} patch - present fields only.
   * @returns {object} the stored entry.
   */
  updateHost(alias, patch) {
    if (!ALIAS_RE.test(alias)) throw new Error('alias must be letters, digits, dots, hyphens or underscores')
    const current = this.settings.hosts[alias] ?? {}
    const next = { ...current }
    if (patch.monitor !== undefined) {
      if (typeof patch.monitor !== 'boolean') throw new Error('monitor must be a boolean')
      next.monitor = patch.monitor
    }
    if (patch.label !== undefined) {
      if (typeof patch.label !== 'string') throw new Error('label must be a string')
      if (patch.label.trim() === '') delete next.label
      else next.label = patch.label.trim()
    }
    if (patch.host !== undefined) {
      if (typeof patch.host !== 'string' || patch.host.trim() === '') throw new Error('host must be a non-empty string')
      next.host = patch.host.trim()
      next.user = typeof patch.user === 'string' && patch.user.trim() !== '' ? patch.user.trim() : (current.user ?? 'root')
      const port = Number(patch.port ?? current.port ?? 22)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be an integer in 1..65535')
      next.port = port
      if (typeof patch.keyPath === 'string' && patch.keyPath.trim() !== '') next.keyPath = expandHome(patch.keyPath.trim())
      if (typeof patch.password === 'string' && patch.password !== '') next.password = patch.password
      if (typeof patch.agentPath === 'string' && patch.agentPath.trim() !== '') next.agentPath = patch.agentPath.trim()
    }
    this.settings.hosts[alias] = next
    this.save()
    this.refresh()
    return next
  }

  /**
   * Remove one alias' local override (a discovered host comes back on the next
   * refresh; a manual host disappears).
   * @param {string} alias - the alias to forget.
   */
  forgetHost(alias) {
    if (this.settings.hosts[alias] === undefined) return
    delete this.settings.hosts[alias]
    this.save()
    this.refresh()
  }

  /**
   * Patch the threshold overrides (persisted).
   * @param {object} patch - partial thresholds; a value of 0 disables that rule.
   * @returns {object} the effective thresholds.
   */
  updateThresholds(patch) {
    this.settings.thresholds = { ...this.settings.thresholds, ...pickThresholds(patch) }
    this.save()
    return this.thresholds()
  }

  /** Persist the settings document atomically. */
  save() {
    const dir = dirname(this.settingsFile)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = this.settingsFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.settings, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.settingsFile)
  }
}

/** Error to message. */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}

/** `statSync` mtime for cache invalidation, or undefined. */
export function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}
