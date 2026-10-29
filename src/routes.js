/**
 * HTTP route family `/api/dsh-remote-monitor/*`.
 *
 * Every route is fenced to loopback with a same-origin check, because these
 * endpoints read remote machines with credentials the host owns. The SSE
 * stream is the dashboard's live path: it is also what keeps the sampler
 * running (see monitor.js), and it stops the moment the browser goes away.
 *
 * @module dsh-remote-monitor/routes
 */

import { isLoopbackRequest } from './loopback.js'

/** Route prefix. */
export const API_PREFIX = '/api/dsh-remote-monitor'

/** JSON body cap for the small settings payloads these routes accept. */
const BODY_MAX_BYTES = 64 * 1024

/** SSE heartbeat period. */
const SSE_HEARTBEAT_MS = 15_000

/** The route table, as the panel and the tests read it. */
export const ROUTES = {
  hosts: API_PREFIX + '/hosts',
  thresholds: API_PREFIX + '/thresholds',
  reload: API_PREFIX + '/reload',
  snapshot: API_PREFIX + '/snapshot',
  history: API_PREFIX + '/history',
  alerts: API_PREFIX + '/alerts',
  stream: API_PREFIX + '/stream',
  test: API_PREFIX + '/test',
}

/** JSON response headers. */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
}

/**
 * Write a JSON response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - the payload.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/**
 * Read a bounded JSON object body.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<object|null>} the parsed object, or null when absent/invalid/oversized.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_MAX_BYTES) {
      req.destroy()
      return null
    }
    chunks.push(chunk)
  }
  if (size === 0) return null
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Build the route table for one plugin mount.
 * @param {object} deps - wiring.
 * @param {import('./store.js').HostBook} deps.book - the host book.
 * @param {import('./monitor.js').Monitor} deps.monitor - the sampler.
 * @param {import('./pool.js').SshPool} deps.pool - the SSH pool.
 * @param {(hosts: Array<object>) => void} [deps.onHostsChanged] - notified after a host edit.
 * @returns {{ routes: Array<object>, dispose: () => void }} the routes and the SSE teardown.
 */
export function makeRoutes({ book, monitor, pool, onHostsChanged }) {
  /** @type {Set<import('node:http').ServerResponse>} */
  const streams = new Set()

  /** The host-list payload shared by several routes. */
  const hostsPayload = () => ({
    hosts: monitor.all(),
    sources: book.sources.map(source => ({ ...source })),
    thresholds: book.thresholds(),
    lowUsage: book.lowUsage(),
    info: monitor.info(),
  })

  /** Re-resolve a possibly stale host entry, then invalidate its connection. */
  const afterHostEdit = alias => {
    pool.invalidate(alias)
    monitor.prune()
    onHostsChanged?.(book.list())
  }

  /**
   * Wrap one handler with the loopback fence and a uniform error response.
   * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL) => Promise<void>|void} handler - the route body.
   * @returns {object} a WebRoute registration.
   */
  const route = (path, handler) => ({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'this endpoint is available on loopback only' })
        return
      }
      let url
      try {
        url = new URL(req.url ?? '/', 'http://localhost')
      } catch {
        sendJson(res, 400, { error: 'invalid url' })
        return
      }
      try {
        await handler(req, res, url)
      } catch (error) {
        if (!res.headersSent) sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        else res.end()
      }
    },
  })

  const routes = [
    // ---- host list ------------------------------------------------------
    route(ROUTES.hosts, async (req, res, url) => {
      if (req.method === 'GET') {
        sendJson(res, 200, hostsPayload())
        return
      }
      if (req.method === 'DELETE') {
        const alias = url.searchParams.get('alias') ?? ''
        book.forgetHost(alias)
        afterHostEdit(alias)
        sendJson(res, 200, hostsPayload())
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(req)
      if (body === null || typeof body.alias !== 'string') {
        sendJson(res, 400, { error: 'a JSON body with an alias is required' })
        return
      }
      const alias = body.alias
      // Editing a discovered host records only this plugin's own overrides; a
      // host that exists in neither source becomes a manual entry.
      const known = book.find(alias)
      if (known === undefined && typeof body.host !== 'string') {
        sendJson(res, 400, { error: `unknown alias '${alias}': pass host/user/port to create a manual entry` })
        return
      }
      book.updateHost(alias, body)
      afterHostEdit(alias)
      sendJson(res, 200, hostsPayload())
    }),

    // ---- alert thresholds ----------------------------------------------
    route(ROUTES.thresholds, async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(req)
      if (body === null) {
        sendJson(res, 400, { error: 'a JSON body is required' })
        return
      }
      // One dialog saves both blocks: the numeric thresholds and the nested
      // low-utilisation reminder. `pickThresholds` ignores the nested object.
      if (typeof body.lowUsage === 'object' && body.lowUsage !== null) book.updateLowUsage(body.lowUsage)
      book.updateThresholds(body)
      sendJson(res, 200, { thresholds: book.thresholds(), lowUsage: book.lowUsage() })
    }),

    // ---- re-read ~/.ssh/config and the dsh-ssh store --------------------
    route(ROUTES.reload, async (req, res) => {
      if (req.method !== 'POST' && req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      book.refresh()
      monitor.prune()
      monitor.demand()
      sendJson(res, 200, hostsPayload())
    }),

    // ---- on-demand read -------------------------------------------------
    route(ROUTES.snapshot, async (req, res, url) => {
      const alias = url.searchParams.get('alias')
      const fresh = url.searchParams.get('fresh') !== '0'
      if (alias === null || alias === '') {
        const hosts = await monitor.readAllNow({ fresh })
        sendJson(res, 200, { hosts })
        return
      }
      const host = await monitor.readNow(alias, { fresh })
      if (host === undefined) {
        sendJson(res, 404, { error: `unknown alias '${alias}'` })
        return
      }
      sendJson(res, 200, { host })
    }),

    // ---- chart history --------------------------------------------------
    route(ROUTES.history, async (req, res, url) => {
      const alias = url.searchParams.get('alias') ?? ''
      const limit = Number(url.searchParams.get('limit'))
      if (alias === '') {
        const series = {}
        for (const host of book.list()) series[host.alias] = monitor.history(host.alias)
        sendJson(res, 200, { series, intervalMs: monitor.intervalMs })
        return
      }
      sendJson(res, 200, { alias, points: monitor.history(alias, Number.isFinite(limit) ? limit : undefined), intervalMs: monitor.intervalMs })
    }),

    // ---- recent threshold breaches --------------------------------------
    route(ROUTES.alerts, async (req, res, url) => {
      const limit = Number(url.searchParams.get('limit'))
      sendJson(res, 200, { alerts: monitor.alerts(Number.isFinite(limit) ? limit : 20), thresholds: book.thresholds() })
    }),

    // ---- connectivity test ----------------------------------------------
    route(ROUTES.test, async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(req)
      if (body === null || typeof body.alias !== 'string') {
        sendJson(res, 400, { error: 'a JSON body with an alias is required' })
        return
      }
      const started = Date.now()
      const host = await monitor.readNow(body.alias, { fresh: true })
      if (host === undefined) {
        sendJson(res, 404, { error: `unknown alias '${body.alias}'` })
        return
      }
      sendJson(res, 200, {
        alias: host.alias,
        ok: host.ok,
        error: host.error,
        latencyMs: Date.now() - started,
        system: host.system,
        connection: host.connection,
      })
    }),

    // ---- live stream -----------------------------------------------------
    route(ROUTES.stream, async (req, res, url) => {
      const filter = (url.searchParams.get('aliases') ?? '').split(',').map(part => part.trim()).filter(part => part !== '')
      const wants = alias => filter.length === 0 || filter.includes(alias)

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'referrer-policy': 'no-referrer',
      })
      res.write('retry: 3000\n\n')
      res.write(`event: hosts\ndata: ${JSON.stringify(hostsPayload())}\n\n`)

      const send = (event, data) => {
        if (res.writableEnded) return
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }

      const unsubscribe = monitor.subscribe(event => {
        try {
          if (event.type === 'hosts') {
            send('hosts', hostsPayload())
            return
          }
          if (event.type === 'samples') {
            send('samples', { samples: event.samples.filter(sample => wants(sample.alias)), at: event.at, info: monitor.info() })
            return
          }
          if (event.type === 'sample' && wants(event.sample.alias)) {
            send('sample', { sample: event.sample, info: monitor.info() })
          }
        } catch {
          cleanup()
        }
      })

      const heartbeat = setInterval(() => {
        if (res.writableEnded) {
          cleanup()
          return
        }
        res.write(`: ping ${Date.now()}\n\n`)
      }, SSE_HEARTBEAT_MS)
      heartbeat.unref?.()

      let cleaned = false
      function cleanup() {
        if (cleaned) return
        cleaned = true
        clearInterval(heartbeat)
        unsubscribe()
        streams.delete(res)
        if (!res.writableEnded) res.end()
      }

      streams.add(res)
      req.on('close', cleanup)
      req.on('error', cleanup)
      res.on('close', cleanup)

      // Push whatever is already known so the first paint is immediate.
      send('samples', { samples: monitor.all().filter(sample => wants(sample.alias)), at: Date.now(), info: monitor.info() })
    }),
  ]

  return {
    routes,
    dispose: () => {
      for (const res of [...streams]) {
        try {
          res.end()
        } catch { /* already gone */ }
      }
      streams.clear()
    },
  }
}
