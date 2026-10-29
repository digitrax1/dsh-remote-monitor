/**
 * Single-instance guard.
 *
 * A profile can reach the same package twice: once through a bundle's aggregate
 * row and once through a standalone row. Both mounts would then register the
 * same webserver routes, tools and system-prompt sections, and the second one
 * would fail the boot. This makes the second mount wait instead of racing.
 *
 * A refused mount is queued rather than dropped, because the Host composes a
 * reload by creating the new entries before disposing the old ones: the new
 * row is refused while the previous row still owns the name, and it must run
 * once that holder releases it — otherwise the plugin disappears for the rest
 * of the process.
 *
 * @module dsh-remote-monitor/mount-once
 */

/** Process-wide registry of mounted package names (a global so two copies of this module agree). */
const MOUNTED = Symbol.for('dsh-web.mounted-plugins')

/** Package names whose refused mount is waiting for the holder to release. */
const WAITERS = Symbol.for('dsh-web.mounted-plugins.waiters')

/** The slice of a cordis context this guard uses. */
function mountedSet() {
  const registry = globalThis
  if (registry[MOUNTED] instanceof Set) return registry[MOUNTED]
  const created = new Set()
  registry[MOUNTED] = created
  return created
}

/** The wait queues. */
function mountWaiters() {
  const registry = globalThis
  if (!(registry[WAITERS] instanceof Map)) registry[WAITERS] = new Map()
  return registry[WAITERS]
}

/**
 * Wrap a plugin `apply` so the package runs at most once per process.
 * @param {string} packageName - the npm package identity.
 * @param {Function} fn - the original apply.
 * @returns {Function} an apply of the same shape.
 */
export function mountOnce(packageName, fn) {
  const mount = (...args) => {
    const mounted = mountedSet()
    const ctx = args[0]
    if (mounted.has(packageName)) {
      const waiters = mountWaiters()
      const queue = waiters.get(packageName) ?? []
      let alive = true
      const pending = {
        run: () => {
          if (alive) mount(...args)
        },
      }
      // A fiber that dies while waiting must not be replayed: its context is
      // disposed, and registering effects on it would throw.
      ctx?.effect?.(() => () => {
        alive = false
        const index = queue.indexOf(pending)
        if (index >= 0) queue.splice(index, 1)
      })
      queue.push(pending)
      waiters.set(packageName, queue)
      return undefined
    }
    mounted.add(packageName)
    ctx?.effect?.(() => () => {
      mounted.delete(packageName)
      const waiters = mountWaiters()
      const queue = waiters.get(packageName)
      if (queue === undefined) return
      waiters.delete(packageName)
      // Defer one microtask so the disposing mount's own effects (routes,
      // tools, timers) are down before the next mount registers.
      for (const waiter of queue.splice(0)) queueMicrotask(() => { waiter.run() })
    })
    return fn(...args)
  }
  return mount
}
