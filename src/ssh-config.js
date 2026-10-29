/**
 * `~/.ssh/config` reader.
 *
 * Only the directives this plugin needs are honoured: `Host`, `HostName`,
 * `User`, `Port`, `IdentityFile`, `IdentityAgent`, `ProxyJump`,
 * `ProxyCommand`. `Include` is expanded by textual inlining (with a visited
 * set as the cycle guard). `Match` blocks are dropped rather than merged into
 * the preceding `Host` block, because their options are conditional and
 * attributing them to that block would silently pick the wrong target.
 *
 * Deliberate simplifications: a multi-pattern `Host a b` line contributes only
 * its first pattern, and values are kept as raw strings.
 *
 * @module dsh-remote-monitor/ssh-config
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

/** `Keyword value...` — the only line shape ssh_config defines. */
const LINE_RE = /^([A-Za-z0-9_-]+)\s+(.+)$/

/** Include recursion guard. */
const MAX_INCLUDE_DEPTH = 16

/** Expand a leading `~` the way OpenSSH does. */
export function expandTilde(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/** Expand a leading `~` in an arbitrary filesystem path. */
export function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/** Build a whole-segment glob matcher (`*` and `?` only). */
function segmentMatcher(segment) {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
}

/** Expand a path segment list against the filesystem, returning matching files. */
function globSegments(prefix, segments) {
  const [head, ...rest] = segments
  if (head === undefined) return [prefix]
  if (!/[*?]/.test(head)) return globSegments(join(prefix, head), rest)
  let names
  try {
    names = readdirSync(prefix)
  } catch {
    return []
  }
  const matcher = segmentMatcher(head)
  return names.filter(name => matcher.test(name)).sort().flatMap(name => globSegments(join(prefix, name), rest))
}

/** Resolve one `Include` argument to the regular files it names. */
function resolveInclude(spec, baseDir) {
  const expanded = expandTilde(spec)
  const full = isAbsolute(expanded) ? expanded : join(baseDir, expanded)
  if (!/[*?]/.test(full)) return existsSync(full) ? [full] : []
  const root = /^([A-Za-z]:[\\/]|[\\/])/.exec(full)?.[1] ?? ''
  const segments = full.slice(root.length).split(/[\\/]+/).filter(part => part !== '')
  return globSegments(root === '' ? '.' : root, segments).filter(path => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  })
}

/** Read one file into lines with every `Include` spliced in place. */
function readLines(file, baseDir, visited, depth) {
  if (depth > MAX_INCLUDE_DEPTH) return []
  let key
  try {
    key = realpathSync(file)
  } catch {
    return []
  }
  if (visited.has(key)) return []
  visited.add(key)
  let text
  try {
    text = readFileSync(key, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const raw of text.split(/\r?\n/)) {
    const match = LINE_RE.exec(raw.trim())
    if (match === null || match[1].toLowerCase() !== 'include') {
      out.push(raw)
      continue
    }
    for (const spec of match[2].trim().split(/\s+/).filter(part => part !== '')) {
      for (const included of resolveInclude(spec, baseDir)) {
        out.push(...readLines(included, baseDir, visited, depth + 1))
      }
    }
  }
  return out
}

/**
 * Parse an ssh_config file into Host blocks.
 * @param {string} configPath - absolute path to the config file.
 * @returns {Array<{ pattern: string, props: Record<string, string> }>} blocks in
 *   file order; `props` keys are lowercased and the last occurrence wins.
 */
export function readSshConfigBlocks(configPath) {
  const blocks = []
  const lines = readLines(configPath, dirname(configPath), new Set(), 0)
  let current
  for (const raw of lines) {
    const match = LINE_RE.exec(raw.trim())
    if (match === null) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim()
    if (key === 'host') {
      current = { pattern: value, props: {} }
      blocks.push(current)
      continue
    }
    if (key === 'match') {
      // Conditional options must never be attributed to the block above.
      current = undefined
      continue
    }
    if (current !== undefined) current.props[key] = value
  }
  return blocks
}

/**
 * Default private keys, in the order `ssh(1)` itself tries them.
 *
 * The order is load-bearing rather than cosmetic: every key tried costs one
 * full transport (and, for a ProxyCommand host, one bastion session), so
 * matching OpenSSH's own order means the key that already works from the shell
 * is the one tried first.
 */
export const DEFAULT_KEY_NAMES = ['id_rsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519', 'id_ed25519_sk', 'id_xmss', 'id_dsa']

/**
 * Convert parsed blocks into monitor host entries.
 *
 * A block with no `IdentityFile` becomes `auth.kind: 'auto'`, which the pool
 * resolves as ssh-agent, then the default private keys — the same order a
 * plain `ssh host` would try, and the reason a machine that already works from
 * the shell works here without any extra configuration.
 *
 * @param {Array<{ pattern: string, props: Record<string, string> }>} blocks - parsed blocks.
 * @param {{ defaultUser?: string }} [options] - user fallback for blocks without `User`.
 * @returns {Array<object>} host entries tagged `source: 'ssh-config'`.
 */
export function blocksToHosts(blocks, options = {}) {
  const hosts = []
  const seen = new Set()
  for (const block of blocks) {
    const pattern = block.pattern.split(/\s+/)[0]
    if (pattern === undefined || pattern === '') continue
    if (pattern.includes('*') || pattern.includes('?')) continue
    if (seen.has(pattern)) continue
    seen.add(pattern)
    const props = block.props
    const identityFile = props.identityfile !== undefined && props.identityfile !== ''
      ? expandTilde(props.identityfile.split(/\s+/)[0])
      : undefined
    const identityAgent = props.identityagent !== undefined && props.identityagent.toLowerCase() !== 'none'
      ? props.identityagent
      : undefined
    const proxyJump = props.proxyjump !== undefined && props.proxyjump.toLowerCase() !== 'none'
      ? props.proxyjump.split(',').map(hop => hop.trim()).filter(hop => hop !== '')
      : []
    const port = props.port !== undefined ? Number.parseInt(props.port, 10) : 22
    hosts.push({
      alias: pattern,
      host: props.hostname !== undefined && props.hostname !== '' ? props.hostname : pattern,
      port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22,
      user: props.user ?? options.defaultUser ?? 'root',
      auth: {
        kind: identityFile !== undefined ? 'key' : identityAgent !== undefined ? 'agent' : 'auto',
        keyPath: identityFile,
        agentPath: identityAgent,
      },
      proxyJump,
      proxyCommand: props.proxycommand !== undefined && props.proxycommand.toLowerCase() !== 'none'
        ? props.proxycommand
        : undefined,
      description: props.description,
      environment: props.environment,
      tags: (props.tags ?? '').split(',').map(tag => tag.trim()).filter(tag => tag !== ''),
      location: props.location,
      source: 'ssh-config',
    })
  }
  return hosts
}
