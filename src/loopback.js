/**
 * Loopback trust fence for this plugin's route family.
 *
 * The socket address is authoritative — `X-Forwarded-For` is never consulted,
 * because a proxy would be the thing sitting between the browser and us. On
 * top of the address the request must carry a loopback `Host` header and must
 * not announce itself as cross-site, which is what stops a random page in the
 * user's browser from driving these endpoints.
 *
 * @module dsh-remote-monitor/loopback
 */

/** IPv4 127/8 predicate. */
export function isIPv4Loopback(address) {
  const parts = String(address).split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket address is loopback (127/8, ::1, or an IPv4-mapped form). */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Whether a URL hostname names a loopback authority. */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Request-level trust fence.
 * @param {import('node:http').IncomingMessage} request - the incoming request.
 * @returns {boolean} true when the request originates from this machine's browser session.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}
