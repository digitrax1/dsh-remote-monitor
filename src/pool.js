/**
 * SSH connection pool.
 *
 * One long-lived ssh2 connection per (alias, connection identity); an idle
 * reaper closes them again so a host that stopped being watched does not hold
 * a session open forever. The pool only ever runs the probe command produced
 * by `probe.js` — it exposes no way to run caller-supplied text on a remote
 * host, which is what keeps the agent tools read-only.
 *
 * Authentication follows a chain, because a machine that already works from a
 * shell must work here without extra configuration: the entry's own credential
 * first (an explicit key, or a password when the user stored one), then
 * ssh-agent, then OpenSSH's default private keys. Each step is a separate
 * connect attempt, since ssh2 binds one key to one client.
 *
 * `ProxyJump` is resolved recursively (each hop is itself a host-book entry),
 * and `ProxyCommand` runs locally with this process' privileges — exactly the
 * trust `ssh(1)` gives the same line.
 *
 * Host keys are accepted without a known_hosts check. That is stated plainly in
 * the README: this plugin reads resource counters, and a man-in-the-middle
 * would see counters. It does not transport credentials or payloads.
 *
 * @module dsh-remote-monitor/pool
 */

import { spawn, execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { Client } from 'ssh2'
import { DEFAULT_KEY_NAMES, expandHome } from './ssh-config.js'

/** Default time an idle connection stays pooled. */
const DEFAULT_IDLE_MS = 10 * 60 * 1000

/** Default per-attempt TCP+auth budget. */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

/** Default remote command budget. */
const DEFAULT_EXEC_TIMEOUT_MS = 30_000

/** Per-stream output cap; the probe output is bounded, this is a backstop. */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

/** How many ProxyJump hops are followed before giving up. */
const MAX_JUMP_DEPTH = 5

/**
 * The identity a pooled connection is keyed by. A connection is reused only
 * while every field that shaped its authentication and transport is unchanged,
 * so editing a host in the panel never reuses a session opened with the old
 * credentials.
 * @param {object} entry - a host-book entry.
 * @returns {string} the cache key.
 */
export function connectionKey(entry) {
  const auth = entry.auth ?? {}
  return JSON.stringify([
    entry.alias, entry.host, entry.port, entry.user,
    auth.kind, auth.keyPath ?? null, auth.password === undefined ? null : '***', auth.agentPath ?? null,
    entry.proxyJump ?? [], entry.proxyCommand ?? null,
  ])
}

/** Read a private key file as a Buffer, or undefined when unreadable. */
function readKey(path) {
  try {
    const resolved = expandHome(path)
    if (!existsSync(resolved)) return undefined
    return readFileSync(resolved)
  } catch {
    return undefined
  }
}

/** The ssh-agent socket to use, or undefined when none is configured/running. */
function resolveAgentPath(entry) {
  const explicit = entry.auth?.agentPath
  if (typeof explicit === 'string' && explicit !== '' && explicit.toLowerCase() !== 'none') return explicit
  const fromEnv = process.env.SSH_AUTH_SOCK
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : undefined
}

/** The default private keys that exist on this machine. */
function defaultKeyPaths() {
  const dir = join(homedir(), '.ssh')
  return DEFAULT_KEY_NAMES.map(name => join(dir, name)).filter(path => existsSync(path))
}

/**
 * Build the ordered authentication attempts for one host.
 * @param {object} entry - a host-book entry.
 * @returns {Array<{ label: string, method: string, config: object }>} attempts, best first.
 */
export function authAttempts(entry) {
  const auth = entry.auth ?? {}
  const attempts = []
  const add = (label, method, config) => {
    attempts.push({ label, method, config })
  }

  const explicitKey = typeof auth.keyPath === 'string' && auth.keyPath !== '' ? readKey(auth.keyPath) : undefined
  const agent = resolveAgentPath(entry)
  const password = typeof auth.password === 'string' && auth.password !== '' ? auth.password : undefined

  if (auth.kind === 'password' && password !== undefined) {
    add('password', 'password', { password })
  }
  if (explicitKey !== undefined) {
    add('key:' + auth.keyPath, 'publickey', {
      privateKey: explicitKey,
      ...(typeof auth.passphrase === 'string' && auth.passphrase !== '' ? { passphrase: auth.passphrase } : {}),
    })
  }
  if (agent !== undefined) add('agent', 'agent', { agent })
  if (auth.kind !== 'password' || password === undefined) {
    for (const path of defaultKeyPaths()) {
      const key = readKey(path)
      if (key !== undefined) add('key:' + path, 'publickey', { privateKey: key })
    }
  }
  if (password !== undefined && !attempts.some(attempt => attempt.method === 'password')) {
    // A stored password is the last resort for a key/agent/auto entry.
    add('password', 'password', { password })
  }
  return attempts
}

/**
 * Expand the OpenSSH `ProxyCommand` tokens.
 *
 * `ssh -W %h:%p bastion` is the idiomatic way to reach a host behind a jump
 * box, and the tokens are expanded by `ssh(1)` itself — a library that reads
 * the line verbatim would spawn `ssh -W %h:%p bastion` and hang or fail. This
 * is therefore not cosmetic: it is what makes such a config work here.
 *
 * Supported (the set OpenSSH documents for ProxyCommand): `%h` target host,
 * `%n` original host name as given on the command line, `%p` target port,
 * `%r` remote username, `%%` a literal percent.
 *
 * @param {string} command - the raw ProxyCommand.
 * @param {object} entry - the target host entry.
 * @returns {string} the command with tokens substituted.
 */
export function expandProxyTokens(command, entry) {
  return command.replace(/%[hnpr%]/g, token => {
    switch (token) {
      case '%h': return entry.host
      case '%n': return entry.alias
      case '%p': return String(entry.port)
      case '%r': return entry.user
      default: return '%'
    }
  })
}

/**
 * Open the local transport a `ProxyCommand` describes.
 * @param {string} command - the command line from ssh_config.
 * @returns {Duplex} a duplex wrapping the child's stdio.
 */
function proxyCommandSocket(command) {
  const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'inherit'] })
  const socket = new Duplex({
    read() { child.stdout.resume() },
    write(chunk, encoding, callback) { child.stdin.write(chunk, encoding, callback) },
    final(callback) { child.stdin.end(); callback() },
    destroy(error, callback) { child.kill(); callback(error) },
  })
  child.stdout.on('data', chunk => { if (!socket.push(chunk)) child.stdout.pause() })
  child.stdout.on('end', () => socket.push(null))
  child.on('error', error => socket.destroy(error))
  child.on('close', () => socket.push(null))
  return socket
}

/** How long an ssh-agent emptiness verdict is trusted. */
const AGENT_PROBE_TTL_MS = 30_000

/**
 * Ask ssh-agent whether it actually holds identities.
 *
 * An ssh-agent socket usually exists on a desktop even when nothing has been
 * added to it, and trying it costs a full transport — for a `ProxyCommand`
 * host that means a whole extra bastion session. This is the difference
 * between one bastion login and two on every connect.
 *
 * @param {string} agentPath - the agent socket.
 * @returns {Promise<boolean>} true when the agent holds at least one identity.
 */
async function agentHasIdentities(agentPath) {
  const now = Date.now()
  if (agentCache.path === agentPath && now - agentCache.at < AGENT_PROBE_TTL_MS) return agentCache.usable
  const usable = await new Promise(resolve => {
    execFile('ssh-add', ['-l'], {
      env: { ...process.env, SSH_AUTH_SOCK: agentPath },
      timeout: 3000,
      encoding: 'utf8',
    }, (error, stdout) => {
      // Exit 1 means "the agent has no identities"; exit 2 means unreachable.
      resolve(error === null && String(stdout ?? '').trim() !== '')
    })
  })
  agentCache = { path: agentPath, at: Date.now(), usable }
  return usable
}

/** Cached ssh-agent verdict. */
let agentCache = { path: '', at: 0, usable: false }

/**
 * The lane a host's connection establishment must run in.
 *
 * A `ProxyCommand` bastion client is frequently single-session: the user's own
 * `wsCli` gateway drops concurrent handshakes with "Connection lost before
 * handshake" when several hosts behind it are polled at the same time. Hosts
 * that share one transport therefore take turns establishing a connection,
 * while hosts reached directly (or through different bastions) still connect in
 * parallel. The lane key is the UNEXPANDED command, because
 * `ssh -W %h:%p bastion` reaches a different target for each host while still
 * sharing one bastion.
 *
 * @param {object} entry - a host-book entry.
 * @returns {string|undefined} the lane key, or undefined when nothing is shared.
 */
export function laneKey(entry) {
  if (typeof entry.proxyCommand === 'string' && entry.proxyCommand.trim() !== '') {
    return 'proxy:' + entry.proxyCommand.trim()
  }
  if (Array.isArray(entry.proxyJump) && entry.proxyJump.length > 0) {
    return 'jump:' + entry.proxyJump.join(',')
  }
  return undefined
}

/** An attempt that failed faster than this looks like a dropped link, not a dead target. */
const FAST_FAILURE_MS = 3000

/** Sleep helper. */
function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms).unref?.() })
}

/** One pooled connection plus its bookkeeping. */
class PooledConnection {
  /**
   * @param {Client} client - the connected ssh2 client.
   * @param {{ close?: () => void }} [dependencies] - extra resource to release with it (a jump hop).
   */
  constructor(client, dependencies = {}) {
    this.client = client
    this.dependencies = dependencies
    this.lastUsed = Date.now()
    this.createdAt = Date.now()
    /** @type {Error|undefined} */
    this.failure = undefined
  }

  /** Whether the underlying transport is still usable. */
  get alive() {
    return this.failure === undefined
  }

  /** Release the connection and anything it was tunneled through. */
  dispose() {
    try {
      this.client.end()
    } catch { /* already gone */ }
    try {
      this.dependencies.close?.()
    } catch { /* already gone */ }
  }
}

/**
 * The pool. One instance per plugin mount.
 */
export class SshPool {
  /**
   * @param {{ idleMs?: number, connectTimeoutMs?: number, execTimeoutMs?: number, resolveAlias?: (alias: string) => object|undefined }} [options] - tuning and the jump-host lookup.
   */
  constructor(options = {}) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.execTimeoutMs = options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
    this.resolveAlias = options.resolveAlias ?? (() => undefined)
    /**
     * Whether hosts sharing one `ProxyCommand`/`ProxyJump` bastion establish
     * their connections one at a time.
     *
     * Measured off by default: three reachable hosts behind one `wsCli`
     * gateway connect concurrently in 6.0 s and serialized in 17.0 s, with no
     * failure either way — the concurrency failure that first suggested this
     * switch turned out to be a genuinely dead host. It stays configurable
     * because a gateway that really is single-session cannot be detected from
     * here, only configured.
     */
    this.serializeBastion = options.serializeBastion === true
    /** @type {Map<string, PooledConnection>} */
    this.connections = new Map()
    /** @type {Map<string, Promise<PooledConnection>>} */
    this.pending = new Map()
    /** @type {Map<string, Array<object>>} memoized credential chains */
    this.attemptCache = new Map()
    /** @type {Map<string, Promise<void>>} serialization lanes, keyed by shared transport */
    this.lanes = new Map()
    this.disposed = false
    this.reaper = setInterval(() => this.reap(), 60_000)
    // Never hold the host process open just to reap connections.
    this.reaper.unref?.()
    /** @type {Map<string, string>} */
    this.lastError = new Map()
  }

  /** Close connections that have been idle past the budget. */
  reap() {
    const cutoff = Date.now() - this.idleMs
    for (const [key, connection] of this.connections) {
      if (connection.lastUsed < cutoff) {
        connection.dispose()
        this.connections.delete(key)
      }
    }
  }

  /**
   * Drop the pooled connection for one alias (used when its config changes).
   * @param {string} alias - the alias to invalidate.
   */
  invalidate(alias) {
    for (const [key, connection] of this.connections) {
      if (key.includes(`"${alias}"`)) {
        connection.dispose()
        this.connections.delete(key)
      }
    }
    for (const key of [...this.attemptCache.keys()]) {
      if (key.includes(`"${alias}"`)) this.attemptCache.delete(key)
    }
    this.lastError.delete(alias)
  }

  /** Close everything and stop the reaper. */
  dispose() {
    this.disposed = true
    clearInterval(this.reaper)
    for (const connection of this.connections.values()) connection.dispose()
    this.connections.clear()
    this.pending.clear()
    this.attemptCache.clear()
    this.lanes.clear()
  }

  /**
   * Connection state for one entry, for the panel and the agent tools.
   * @param {object} entry - a host-book entry.
   * @returns {{ connected: boolean, since: number|null, lastUsed: number|null, error: string|null, attempts: string[] }}
   */
  status(entry) {
    const pooled = this.connections.get(connectionKey(entry))
    return {
      connected: pooled !== undefined && pooled.alive,
      since: pooled?.createdAt ?? null,
      lastUsed: pooled?.lastUsed ?? null,
      error: this.lastError.get(entry.alias) ?? null,
      attempts: this.attemptsFor(entry).map(attempt => attempt.label),
    }
  }

  /**
   * Run the probe command on one host and collect its output.
   * @param {object} entry - a host-book entry.
   * @param {string} command - the remote command (always a probe from probe.js).
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - execution options.
   * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, code: number|null, durationMs: number, timedOut: boolean, error?: string }>}
   */
  async exec(entry, command, options = {}) {
    const started = Date.now()
    let connection
    // Connecting needs a deadline of its own. `readyTimeout` covers the SSH
    // handshake, but a transport that dies without saying so (a ProxyCommand
    // child that exits after "No route to host", for instance) can otherwise
    // leave `acquire` pending forever — and a hung poll takes the whole host
    // list's tick down with it.
    const controller = new AbortController()
    const budgetMs = (options.connectTimeoutMs ?? this.connectTimeoutMs) + 5000
    const connectTimer = setTimeout(() => {
      controller.abort(new Error(`connect timed out after ${budgetMs} ms`))
    }, budgetMs)
    connectTimer.unref?.()
    const signal = options.signal === undefined
      ? controller.signal
      : (typeof AbortSignal.any === 'function' ? AbortSignal.any([controller.signal, options.signal]) : controller.signal)

    try {
      connection = await this.acquire(entry, signal)
    } catch (error) {
      this.lastError.set(entry.alias, describe(error))
      return {
        ok: false, stdout: '', stderr: '', code: null,
        durationMs: Date.now() - started, timedOut: /timed out/i.test(describe(error)), error: describe(error),
      }
    } finally {
      clearTimeout(connectTimer)
    }
    connection.lastUsed = Date.now()
    try {
      const result = await this.run(connection, command, options.timeoutMs ?? this.execTimeoutMs)
      this.lastError.delete(entry.alias)
      return { ...result, durationMs: Date.now() - started }
    } catch (error) {
      // A failed command does not necessarily mean a dead transport, but a
      // transport error does: mark and drop so the next poll reconnects.
      if (isTransportError(error)) {
        connection.failure = error instanceof Error ? error : new Error(String(error))
        this.connections.delete(connectionKey(entry))
        connection.dispose()
      }
      this.lastError.set(entry.alias, describe(error))
      return {
        ok: false, stdout: '', stderr: '', code: null,
        durationMs: Date.now() - started, timedOut: false, error: describe(error),
      }
    }
  }

  /**
   * Get a live connection for one entry, opening (and authenticating) one when
   * the pool has none.
   * @param {object} entry - a host-book entry.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<PooledConnection>} the pooled connection.
   */
  async acquire(entry, signal) {
    if (this.disposed) throw new Error('pool disposed')
    const key = connectionKey(entry)
    const existing = this.connections.get(key)
    if (existing !== undefined && existing.alive) return existing
    const inFlight = this.pending.get(key)
    if (inFlight !== undefined) return inFlight

    const promise = this.connect(entry, 0, signal)
      .then(connection => {
        if (this.disposed) {
          connection.dispose()
          throw new Error('pool disposed')
        }
        this.connections.set(key, connection)
        return connection
      })
      .finally(() => { this.pending.delete(key) })
    this.pending.set(key, promise)
    return promise
  }

  /**
   * Open one connection, serialized against every other connection that shares
   * the same bastion (see {@link laneKey}).
   * @param {object} entry - a host-book entry.
   * @param {number} depth - jump recursion depth.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<PooledConnection>} the connected client.
   */
  async connect(entry, depth, signal) {
    if (depth > MAX_JUMP_DEPTH) throw new Error('ProxyJump chain is too deep')
    const lane = this.serializeBastion ? laneKey(entry) : undefined
    if (lane === undefined) return this.connectInner(entry, depth, signal)
    return this.withLane(lane, () => this.connectInner(entry, depth, signal))
  }

  /**
   * Run `fn` after every previously queued task on `key` has settled. Failures
   * release the lane: one unreachable host must not block the others.
   * @param {string} key - the lane.
   * @param {() => Promise<*>} fn - the critical section.
   * @returns {Promise<*>} the section's result.
   */
  async withLane(key, fn) {
    const previous = this.lanes.get(key) ?? Promise.resolve()
    let release
    const gate = new Promise(resolve => { release = resolve })
    const queued = previous.then(() => gate, () => gate)
    this.lanes.set(key, queued)
    await previous.catch(() => {})
    try {
      return await fn()
    } finally {
      release()
      if (this.lanes.get(key) === queued) this.lanes.delete(key)
    }
  }

  /**
   * Walk the credential chain for one host.
   *
   * A transport is opened per attempt and released the moment that attempt
   * fails. That is not tidiness: a `ProxyCommand` child (a bastion client, most
   * likely) survives its ssh2 client, so leaking one per failed attempt piles
   * up live bastion sessions against the very host we are trying to reach —
   * which shows up as "No route to host" on the next attempt.
   *
   * A bastion link is also flaky by nature, so a transport failure on a proxied
   * host is retried once before the host is declared unreachable.
   *
   * @param {object} entry - a host-book entry.
   * @param {number} depth - jump recursion depth.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<PooledConnection>} the connected client.
   */
  async connectInner(entry, depth, signal) {
    const candidates = this.attemptsFor(entry)
    const attempts = []
    for (const attempt of candidates) {
      if (attempt.method === 'agent' && !(await agentHasIdentities(attempt.config.agent))) continue
      attempts.push(attempt)
    }
    if (attempts.length === 0) {
      throw new Error('no usable credential: add a key, a password, or start ssh-agent')
    }

    const proxied = laneKey(entry) !== undefined
    const rounds = proxied ? 2 : 1
    let lastError
    for (let round = 0; round < rounds; round += 1) {
      if (round > 0) await sleep(1500 * round)
      const errors = []
      let retryable = false
      for (const attempt of attempts) {
        if (signal?.aborted === true) throw new Error('cancelled')
        /** @type {{ sock?: Duplex, close?: () => void }} */
        let transport = {}
        const attemptStartedAt = Date.now()
        try {
          transport = await this.openTransport(entry, depth, signal)
          const client = await this.connectWith(entry, attempt, transport.sock, signal)
          return new PooledConnection(client, { close: transport.close })
        } catch (error) {
          transport.close?.()
          errors.push(`${attempt.label}: ${describe(error)}`)
          lastError = error
          // Only a rejected credential is worth trying another credential for.
          // A transport failure (unreachable host, dead ProxyCommand, handshake
          // timeout) will fail identically for every credential.
          if (!isAuthFailure(error)) {
            // A hiccup on the bastion fails almost immediately; a target that
            // is genuinely unreachable first pays for bringing the tunnel up.
            // Retrying only the fast failure keeps a dead host cheap while
            // still absorbing a dropped first handshake.
            retryable = isRetryableTransportFailure(error) && Date.now() - attemptStartedAt < FAST_FAILURE_MS
            break
          }
        }
      }
      if (!retryable) {
        throw new Error(`all authentication attempts failed (${errors.join('; ')})`)
      }
      if (round === rounds - 1) {
        throw new Error(`${describe(lastError)}${errors.length > 0 ? ` (${errors.join('; ')})` : ''}`)
      }
    }
    throw new Error(describe(lastError))
  }

  /**
   * The ordered credential list for one host, memoized per connection identity
   * so a status read never re-reads private key files from disk.
   * @param {object} entry - a host-book entry.
   * @returns {Array<object>} attempts.
   */
  attemptsFor(entry) {
    const key = connectionKey(entry)
    let attempts = this.attemptCache.get(key)
    if (attempts === undefined) {
      attempts = authAttempts(entry)
      this.attemptCache.set(key, attempts)
    }
    return attempts
  }

  /**
   * Establish the transport for one host: direct, `ProxyCommand`, or
   * `ProxyJump`.
   * @param {object} entry - a host-book entry.
   * @param {number} depth - jump recursion depth.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{ sock?: Duplex, close?: () => void }>} the transport.
   */
  async openTransport(entry, depth, signal) {
    if (typeof entry.proxyCommand === 'string' && entry.proxyCommand.trim() !== '') {
      const socket = proxyCommandSocket(expandProxyTokens(entry.proxyCommand, entry))
      return { sock: socket, close: () => socket.destroy() }
    }
    if (Array.isArray(entry.proxyJump) && entry.proxyJump.length > 0) {
      return this.openJumpTransport(entry, depth, signal)
    }
    return {}
  }

  /**
   * Connect to the jump host, then tunnel a channel to the target.
   * @param {object} entry - the target entry.
   * @param {number} depth - recursion depth.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{ sock: Duplex, close: () => void }>} the transport.
   */
  async openJumpTransport(entry, depth, signal) {
    let lastError
    for (const hop of entry.proxyJump) {
      const jumpEntry = this.resolveAlias(hop)
      if (jumpEntry === undefined) {
        lastError = new Error(`ProxyJump hop '${hop}' is not a known host`)
        continue
      }
      try {
        const jump = await this.connect(jumpEntry, depth + 1, signal)
        const stream = await new Promise((resolve, reject) => {
          jump.client.forwardOut('127.0.0.1', 0, entry.host, entry.port, (error, channel) => {
            if (error) reject(error)
            else resolve(channel)
          })
        })
        return {
          sock: stream,
          close: () => {
            try { stream.destroy() } catch { /* gone */ }
            jump.dispose()
          },
        }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('no reachable ProxyJump hop')
  }

  /**
   * One connect + authenticate attempt.
   * @param {object} entry - the target entry.
   * @param {{ method: string, config: object }} attempt - the credential.
   * @param {Duplex} [sock] - a pre-established transport.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<Client>} the ready client.
   */
  connectWith(entry, attempt, sock, signal) {
    return new Promise((resolve, reject) => {
      const client = new Client()
      let settled = false
      const fail = error => {
        if (settled) return
        settled = true
        try { client.end() } catch { /* never connected */ }
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const onAbort = () => fail(signal.reason instanceof Error ? signal.reason : new Error('cancelled'))
      signal?.addEventListener('abort', onAbort, { once: true })

      client.on('ready', () => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        resolve(client)
      })
      client.on('error', error => {
        signal?.removeEventListener('abort', onAbort)
        fail(error)
      })
      client.on('close', () => fail(new Error('connection closed before authentication')))

      // A pooled client that dies later must drop itself from the pool: the
      // pool keys by identity, so the entry is found through the key we know.
      client.on('close', () => {
        const key = connectionKey(entry)
        const pooled = this.connections.get(key)
        if (pooled !== undefined && pooled.client === client) this.connections.delete(key)
      })

      const config = {
        host: entry.host,
        port: entry.port,
        username: entry.user,
        readyTimeout: this.connectTimeoutMs,
        keepaliveInterval: 20_000,
        keepaliveCountMax: 3,
        // Try only the method this attempt carries, in ssh2's own order.
        authHandler: ['none', attempt.method],
        ...attempt.config,
      }
      if (sock !== undefined) config.sock = sock
      try {
        client.connect(config)
      } catch (error) {
        signal?.removeEventListener('abort', onAbort)
        fail(error)
      }
    })
  }

  /**
   * Run one command on a live pooled connection.
   * @param {PooledConnection} connection - the pooled client.
   * @param {string} command - the remote command.
   * @param {number} timeoutMs - budget in milliseconds.
   * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, code: number|null, timedOut: boolean }>}
   */
  run(connection, command, timeoutMs) {
    return new Promise((resolve, reject) => {
      let timedOut = false
      let stdout = ''
      let stderr = ''
      let settled = false
      /** @type {number|null} */
      let code = null
      /** @type {{ close(): void } | undefined} */
      let channel

      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: !timedOut && code === 0, stdout, stderr, code, timedOut })
      }

      const timer = setTimeout(() => {
        timedOut = true
        try { channel?.close() } catch { /* already closed */ }
        finish()
      }, timeoutMs)
      timer.unref?.()

      try {
        channel = connection.client.exec(command, { pty: false }, (error, stream) => {
          if (error) {
            clearTimeout(timer)
            settled = true
            reject(error)
            return
          }
          // `stream` is the channel; `channel` above may already point at the
          // same object from a timeout race, in which case finish() has run.
          if (settled) {
            try { stream.close() } catch { /* gone */ }
            return
          }
          channel = stream
          stream.on('data', chunk => {
            if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8')
          })
          stream.stderr.on('data', chunk => {
            if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8')
          })
          stream.on('exit', exitCode => { code = exitCode ?? null })
          stream.on('close', () => finish())
          stream.on('error', closeError => {
            clearTimeout(timer)
            settled = true
            reject(closeError)
          })
        })
      } catch (error) {
        clearTimeout(timer)
        settled = true
        reject(error)
      }
    })
  }
}

/** Human-readable error text. */
function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Whether an error means the server refused the credential (so the next one in
 * the chain is worth trying) rather than the transport being unusable.
 * @param {unknown} error - the thrown value.
 * @returns {boolean} true for a credential rejection.
 */
function isAuthFailure(error) {
  if (error !== null && typeof error === 'object' && error.level === 'client-authentication') return true
  return /all configured authentication methods failed|authentication methods failed|permission denied/i.test(describe(error))
}

/**
 * Whether a transport failure is worth one more attempt.
 *
 * A single-session bastion drops a *concurrent* handshake quickly ("Connection
 * lost before handshake", "No route to host"), and such a failure usually
 * succeeds on a second try. A handshake that simply times out means the host is
 * unreachable, and retrying only doubles the wait while holding the bastion
 * lane — so it is deliberately not retried.
 *
 * @param {unknown} error - the thrown value.
 * @returns {boolean} true when a retry is likely to help.
 */
function isRetryableTransportFailure(error) {
  const message = describe(error)
  if (/timed out/i.test(message)) return false
  return /Connection lost|No route to host|channel open failure|socket hang up|ECONNRESET|EPIPE|closed before authentication/i.test(message)
}

/**
 * Whether an error means the transport itself is gone (as opposed to the
 * command merely failing), in which case the pooled connection must be dropped.
 * @param {unknown} error - the thrown value.
 * @returns {boolean} true for transport failures.
 */
function isTransportError(error) {
  const message = describe(error)
  return /not connected|Connection lost|channel open failure|socket hang up|EPIPE|ECONNRESET|closed before authentication/i.test(message)
}
