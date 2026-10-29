/**
 * Browser-half tests.
 *
 * The bundle is served to the web GUI verbatim, so its *contract* is what a
 * broken install looks like: a wrong module id, a factory that never loads, an
 * `apply` that registers the wrong seats. Those assertions need no dependency
 * and always run.
 *
 * The second case mounts the panel in a real DOM and drives it with fixture
 * data, which is what catches a bad property access inside a chart or a table.
 * That one needs `react`, `react-dom` and `jsdom` (see devDependencies); it
 * skips itself when they are absent, so the shipped suite never fails for want
 * of a dev install.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const BUNDLE = new URL('../src/client.js', import.meta.url)

/** A minimal React stand-in: enough to call a component body once. */
function reactStub() {
  const noop = () => {}
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, noop],
    useEffect: noop,
    useMemo: factory => factory(),
    useCallback: fn => fn,
    useRef: value => ({ current: value }),
    Fragment: Symbol('Fragment'),
  }
}

/**
 * Evaluate the bundle with a stubbed loader and return what it published.
 * @param {object} react - the React implementation to hand the module.
 * @returns {{ loaded: object, moduleExports: object, registrations: Array<object>, applyError: Error|null, page: Function|undefined }}
 */
function loadBundle(react) {
  let loaded = null
  const window = { __ModuleLoader__: { load: options => { loaded = options } } }
  const document = {
    documentElement: { lang: 'zh-CN' },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', style: {} }),
    head: { appendChild: () => {} },
  }
  const source = readFileSync(BUNDLE, 'utf8')
  // The bundle is a classic script by design: it talks to the loader that the
  // web shell installs, not to an ES module graph.
  // eslint-disable-next-line no-new-func
  new Function('window', 'navigator', 'document', source)(window, { language: 'zh-CN' }, document)

  assert.ok(loaded !== null, 'the bundle must call window.__ModuleLoader__.load')
  const moduleExports = loaded.factory(specifier => {
    if (specifier === 'react') return react
    if (specifier === 'react/jsx-runtime') return { jsx: react.createElement, jsxs: react.createElement }
    throw new Error('unexpected require: ' + specifier)
  })

  const registrations = []
  let applyError = null
  try {
    moduleExports.apply({
      effect: callback => { callback(); return () => {} },
      slots: {
        inject: (key, callback) => { callback(); return () => {} },
        register: (options, component) => { registrations.push({ options, component }); return () => {} },
      },
    })
  } catch (error) {
    applyError = error
  }

  const page = registrations.find(entry => entry.options.name === 'main')?.component
  return { loaded, moduleExports, registrations, applyError, page }
}

test('client bundle: module id, exports and the two shell seats', () => {
  const { loaded, moduleExports, registrations, applyError } = loadBundle(reactStub())

  assert.equal(loaded.id, 'dsh-remote-monitor', 'the loader id must be the package id')
  assert.equal(typeof moduleExports.apply, 'function')
  assert.deepEqual(moduleExports.inject, ['slots'])

  assert.equal(applyError, null, 'apply must not throw: the shell fails the whole boot when a plugin apply throws')
  assert.deepEqual(
    registrations.map(entry => `${entry.options.name}:${entry.options.id ?? entry.options.key}`),
    ['sidebar.panellist:remote-monitor', 'main:remote-monitor', 'sidebar.footer.action:remote-monitor-footer'],
  )
  const row = registrations[0]
  assert.equal(typeof row.options.label, 'function', 'the shell resolves the row label per locale change')
  assert.equal(typeof row.options.order, 'number')
  assert.equal(typeof row.component, 'function')
  assert.equal(typeof registrations[1].component, 'function')
  assert.equal(typeof registrations[2].component, 'function', 'the footer chip is a component too')
})

test('client bundle: a shell without the slots service degrades instead of throwing', () => {
  let loaded = null
  const window = { __ModuleLoader__: { load: options => { loaded = options } } }
  const document = {
    documentElement: { lang: 'en' },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', style: {} }),
    head: { appendChild: () => {} },
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'navigator', 'document', readFileSync(BUNDLE, 'utf8'))(window, { language: 'en' }, document)
  const moduleExports = loaded.factory(specifier => (specifier === 'react' ? reactStub() : { jsx: () => null, jsxs: () => null }))
  assert.doesNotThrow(() => moduleExports.apply({ effect: callback => { callback(); return () => {} } }))
})

test('client bundle: the panel renders its empty state without a data source', () => {
  const { page } = loadBundle(reactStub())
  assert.equal(typeof page, 'function')
  // No fetch and no EventSource exist here: the page must still produce a tree
  // rather than throwing while the host is unreachable.
  assert.doesNotThrow(() => page({}))
})

test('client bundle: mounts in a real DOM and renders live host data', { skip: !hasDomDependencies() }, async () => {
  const { JSDOM } = await import('jsdom')
  const React = (await import('react')).default
  const { createRoot } = await import('react-dom/client')

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:19387/' })
  const { window } = dom
  // The panel picks its dictionary once at module load, so the language has to
  // be pinned before the bundle is evaluated.
  try {
    Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true })
  } catch { /* read-only in this runtime */ }

  const now = Date.now()
  const host = {
    alias: 'gpu-node', label: 'gpu-node', host: '10.0.0.5', port: 22, user: 'root', source: 'ssh-config',
    tags: [], environment: null, monitor: true, status: 'ok', ok: true, error: null, latencyMs: 120,
    samples: 2, failures: 0, nextAttemptAt: null, lastSampleAt: now, ratesReady: true,
    connection: { connected: true, since: now, attempts: [] },
    system: { hostname: 'gpu-node', uname: 'Linux x86_64', os: 'Ubuntu 24.04', uptimeSec: 100000 },
    cpu: { percent: 42.5, load: [1.5, 1.2, 1.0], nproc: 64, cores: [], user: 1, system: 1, iowait: 0.5, steal: 0 },
    mem: { totalBytes: 1024 ** 4, usedBytes: 512 * 1024 ** 3, availableBytes: 512 * 1024 ** 3, percent: 50, swapTotalBytes: 0, swapUsedBytes: null, swapPercent: null },
    disks: [{ filesystem: 'overlay', mount: '/', sizeBytes: 500 * 1024 ** 3, usedBytes: 405 * 1024 ** 3, usePercent: 81 }],
    diskIo: [{ name: 'vda', readBps: 0, writeBps: 3800, iops: 3, busyPercent: 1 }],
    net: [{ name: 'eth0', rxBytes: 1000, txBytes: 2000, rxBps: 3300, txBps: 20000 }],
    gpus: [{
      index: 0, uuid: 'GPU-a', name: 'NVIDIA L20', utilPercent: 97, memUsedBytes: 1, memTotalBytes: 2,
      memPercent: 95.6, tempC: 78, powerW: 320, powerLimitW: 350, fanPercent: null, clockSmMhz: 1900,
      processes: [{ pid: 1234, name: 'python3', memBytes: 100 }],
    }],
    topCpu: [{ pid: 1234, name: 'python3', cpuPercent: 300, memPercent: 3, rssBytes: 1024, command: 'python3 train.py' }],
    topMem: [{ pid: 1234, name: 'python3', cpuPercent: 300, memPercent: 3, rssBytes: 1024, command: 'python3 train.py' }],
    alerts: [{ key: 'cpu', level: 'warn', metric: 'cpu', target: 'cpu', value: 95, threshold: 90, message: 'cpu 95% ≥ 90%' }],
  }
  const payload = { hosts: [host], sources: [{ source: 'ssh-config', path: '/tmp/ssh-config', ok: true, count: 1 }], thresholds: { cpu: 90, mem: 90, disk: 90 }, info: { running: true, intervalMs: 5000, subscribers: 1 } }

  const streams = []
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = {}; this.closed = false; streams.push(this) }
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener) }
    emit(type, body) { for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(body) }) }
    close() { this.closed = true }
  }

  const document = window.document
  globalThis.window = window
  globalThis.document = document
  globalThis.EventSource = FakeEventSource
  globalThis.fetch = async url => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes('/history') ? { series: {} } : String(url).includes('/alerts') ? { alerts: [] } : payload),
  })

  // Load with the real React so the mount exercises the actual renderer.
  let loaded = null
  window.__ModuleLoader__ = { load: options => { loaded = options } }
  // eslint-disable-next-line no-new-func
  new Function('window', 'navigator', 'document', 'EventSource', 'fetch', readFileSync(BUNDLE, 'utf8'))(
    window, window.navigator, document, FakeEventSource, globalThis.fetch)
  const moduleExports = loaded.factory(specifier => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return { jsx: React.createElement, jsxs: React.createElement }
    throw new Error('unexpected require: ' + specifier)
  })

  let page
  moduleExports.apply({
    effect: callback => { callback(); return () => {} },
    slots: {
      inject: (key, callback) => { callback(); return () => {} },
      register: (options, component) => { if (options.name === 'main') page = component; return () => {} },
    },
  })

  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const act = React.act ?? createRequire(import.meta.url)('react-dom/test-utils').act
  const container = document.getElementById('root')
  const root = createRoot(container)
  await act(async () => { root.render(React.createElement(page)) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

  const text = container.textContent ?? ''
  assert.match(text, /gpu-node/, 'the host alias reaches the markup')
  assert.match(text, /42\.5%/, 'the cpu percentage reaches the markup')
  assert.match(text, /GPU0/, 'the gpu chip reaches the card')
  assert.match(text, /78°C/, 'the gpu temperature reaches the card')
  assert.match(text, /81%/, 'the disk usage reaches the markup')
  assert.equal(streams.length, 1, 'the panel opens exactly one SSE stream')
  assert.match(streams[0].url, /\/api\/dsh-remote-monitor\/stream/, 'the stream URL is the plugin route')

  // A pushed sample must update the view.
  await act(async () => {
    streams[0].emit('sample', { sample: { ...host, cpu: { ...host.cpu, percent: 77.7 } }, info: payload.info })
  })
  assert.match(container.textContent, /77\.7%/, 'a streamed sample updates the view')

  // The detail view is the deepest render path: tables, charts and GPU panels.
  const card = container.querySelector('.drm-card')
  assert.ok(card !== null, 'the overview renders a host card')
  await act(async () => { card.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  const detail = container.textContent ?? ''
  assert.match(detail, /NVIDIA L20/, 'the detail view names the GPU')
  assert.match(detail, /python3 train\.py/, 'the detail view lists the busiest process')
  assert.match(detail, /1234/, 'the detail view shows the GPU process id')
  assert.match(detail, /vda/, 'the detail view shows disk IO')
  assert.match(detail, /eth0/, 'the detail view shows the interface')
})

/** Whether the optional DOM test dependencies are installed. */
function hasDomDependencies() {
  try {
    const require = createRequire(import.meta.url)
    require.resolve('react')
    require.resolve('react-dom/client')
    require.resolve('jsdom')
    return true
  } catch {
    return false
  }
}
