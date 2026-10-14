/**
 * Client-half tests.
 *
 * The bundle is a browser classic script, so this test builds the minimum page
 * environment it touches: a `window.__ModuleLoader__` sink, a `document` that
 * records the stylesheet insert, and a stub `react` (the host-side `react`
 * junction in this environment is dangling, and the browser seed table is what
 * really supplies React). It then renders the panel body by calling it directly
 * with stub hooks, which catches envelope mistakes, broken slot registrations,
 * and render-body errors without a browser.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { API_PREFIX, CLIENT_HEADER, createNotepadApi } from '../lib/api.js'

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/** The React subset the bundle uses, plus tree walkers for assertions. */
function makeReact() {
  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat().filter((child) => child !== null && child !== undefined && child !== false),
      }
    },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useRef(initial) { return { current: initial } },
    useCallback(callback) { return callback },
    // Effects are recorded, never run implicitly, so rendering a component in a
    // test cannot start timers or fetch; a test that wants them runs them.
    effects: [],
    useEffect(callback) { React.effects.push(callback) },
  }
  return React
}

/** Collect every string rendered anywhere in a stub element tree. */
function texts(node, found = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return found
  if (typeof node === 'string' || typeof node === 'number') {
    found.push(String(node))
    return found
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, found)
    return found
  }
  for (const child of node.children ?? []) texts(child, found)
  return found
}

/** Every element in a stub tree matching one type. */
function elements(node, type, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) elements(child, type, found)
    return found
  }
  if (node.type === type) found.push(node)
  for (const child of node.children ?? []) elements(child, type, found)
  return found
}

/** @type {{ registration: any, React: any, appended: any[] }} */
let page

before(async () => {
  const React = makeReact()
  const appended = []
  let registration
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = { __ModuleLoader__: { load(value) { registration = value } } }
  globalThis.document = {
    querySelector: () => null,
    createElement() { return { dataset: {}, textContent: '' } },
    head: { appendChild(node) { appended.push(node) } },
  }
  try {
    await import(new URL('../lib/client.js', import.meta.url).href)
    // Materialize once while the page stubs are installed: the factory inserts
    // its stylesheet synchronously, and the module system claims it right after.
    registration.factory((specifier) => {
      if (specifier === 'react') return React
      throw new Error(`unexpected require(${specifier})`)
    })
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
  }
  page = { registration, React, appended }
})

/** Instantiate the bundle's plugin module against the stub React. */
function loadClientModule() {
  return page.registration.factory((specifier) => {
    if (specifier === 'react') return page.React
    throw new Error(`unexpected require(${specifier})`)
  })
}

describe('notepad client bundle', () => {
  it('registers a factory under the package name and claims its stylesheet', () => {
    assert.equal(typeof page.registration, 'object')
    assert.equal(page.registration.id, 'dsh-plugin-notepad')
    assert.equal(typeof page.registration.factory, 'function')
    // The module system claims untagged <style> tags present when the factory
    // returns, so the stylesheet must be inserted while it runs.
    assert.equal(page.appended.length, 1)
    const style = page.appended[0]
    assert.equal(style.dataset.plugin, 'dsh-plugin-notepad')
    assert.equal(style.dataset.pluginCss, 'dsh-plugin-notepad/client.css')
    assert.match(style.textContent, /\.notepadPage/)
  })

  it('exposes the Cordis plugin shape and the panel parts', () => {
    const clientModule = loadClientModule()
    assert.equal(typeof clientModule.apply, 'function')
    assert.deepEqual(clientModule.inject, ['slots'])
    assert.equal(typeof clientModule.NotepadPage, 'function')
    assert.equal(typeof clientModule.NotepadIcon, 'function')
  })

  it('pairs the sidebar icon and the main panel under one id', () => {
    const clientModule = loadClientModule()
    const registered = []
    const injected = []
    const ctx = {
      slots: {
        inject(key, callback) { injected.push(key); registered.push(callback()) },
        register(options, component) { return { options, component } },
      },
    }
    clientModule.apply(ctx)
    assert.deepEqual(injected, ['main', 'sidebar.panellist', 'conversation.session.header.utilities'])
    assert.equal(registered.length, 3)
    const main = registered[0]
    const icon = registered[1]
    const bridge = registered[2]
    assert.equal(main.options.name, 'main')
    assert.equal(icon.options.name, 'sidebar.panellist')
    // The center panel is dispatched by the panellist id, so the keys must match.
    assert.equal(main.options.key, icon.options.id)
    assert.equal(icon.options.label, '速记')
    assert.equal(main.component, clientModule.NotepadPage)
    assert.equal(icon.component, clientModule.NotepadIcon)
    // The session bridge is a session-scoped, additive list entry.
    assert.equal(bridge.options.name, 'conversation.session.header.utilities')
    assert.equal(bridge.options.id, 'notepad-session')
    assert.equal(bridge.component, clientModule.NotepadSessionBridge)
  })

  it('reports the session cwd through the invisible bridge', () => {
    const clientModule = loadClientModule()
    const selectors = []
    page.React.effects.length = 0
    const bridge = clientModule.NotepadSessionBridge({
      sessionId: 'session-1234',
      useSessions: (selector) => {
        selectors.push(selector)
        return selector({ byId: { 'session-1234': { cwd: 'D:\\work\\proj' } } })
      },
    })
    assert.equal(bridge.type, 'span')
    assert.equal(bridge.props['aria-hidden'], 'true')
    assert.match(bridge.props.style.display, /none/)
    // The selector maps the session id to that session's own working directory.
    assert.equal(selectors[0]({ byId: { 'session-1234': { cwd: 'D:\\work\\proj' } } }), 'D:\\work\\proj')
    assert.equal(selectors[0]({ byId: {} }), null)
    assert.equal(selectors[0]({ byId: { other: { cwd: 'x' } } }), null)
    // The effect publishes it for the root-scoped center page.
    for (const effect of page.React.effects.splice(0)) effect()
    assert.deepEqual(clientModule.activeSession, { id: 'session-1234', cwd: 'D:\\work\\proj' })
    clientModule.activeSession.id = null
    clientModule.activeSession.cwd = null
  })

  it('never lets the project dropdown name a different project than the one in use', () => {
    const clientModule = loadClientModule()
    const workspaces = [{ path: 'D:\\work\\a', title: 'a' }, { path: 'D:\\work\\b', title: 'b' }]

    // The project in use is registered: no duplicate entry.
    const registered = clientModule.projectOptions(workspaces, 'D:\\work\\b')
    assert.deepEqual(registered.map((entry) => entry.path), ['D:\\work\\a', 'D:\\work\\b'])
    assert.deepEqual(registered.map((entry) => entry.title), ['a', 'b'])
    assert.ok(registered.every((entry) => entry.followed === false))

    // The project in use is NOT registered (a session whose directory is not a
    // workspace): it must still be an option, first and clearly labelled —
    // otherwise <select> falls back to displaying the first option and names a
    // project the panel is not editing.
    const unregistered = clientModule.projectOptions(workspaces, 'D:\\files\\projects\\trusted_data')
    assert.deepEqual(unregistered.map((entry) => entry.path), ['D:\\files\\projects\\trusted_data', 'D:\\work\\a', 'D:\\work\\b'])
    assert.equal(unregistered[0].title, 'trusted_data（当前会话）')
    assert.equal(unregistered[0].followed, true)

    // Nothing to choose from: the page renders its path input instead.
    assert.deepEqual(clientModule.projectOptions([], null), [])
    assert.deepEqual(clientModule.projectOptions([], ''), [])
  })

  it('asks the host for the session project while following it', async () => {
    const clientModule = loadClientModule()
    const requests = []
    const previousFetch = globalThis.fetch
    const cwd = 'D:\\work\\proj'
    const payload = {
      level: 'both',
      defaultScope: 'project',
      cwd,
      projectRoot: cwd,
      current: { source: 'manual', path: cwd, projectRoot: cwd },
      projects: [],
      levels: {
        global: { scope: 'global', enabled: true, total: 0, notes: [] },
        project: { scope: 'project', enabled: true, total: 0, notes: [] },
      },
    }
    globalThis.fetch = async (url) => {
      requests.push(String(url))
      return { ok: true, status: 200, json: async () => payload }
    }
    const cleanups = []
    try {
      clientModule.activeSession.id = 'session-1234'
      clientModule.activeSession.cwd = cwd
      page.React.effects.length = 0
      const tree = clientModule.NotepadPage()
      for (const effect of page.React.effects.splice(0)) {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(requests.length, 1)
      const request = decodeURIComponent(requests[0])
      assert.match(request, /limit=0/)
      assert.ok(request.includes(`project=${cwd}`), request)
      assert.ok(request.includes('session=session-1234'), request)
      // The page renders the project tab by default.
      assert.match(texts(tree).join(' | '), /项目/)
    } finally {
      for (const cleanup of cleanups) cleanup()
      globalThis.fetch = previousFetch
      clientModule.activeSession.id = null
      clientModule.activeSession.cwd = null
    }
  })

  it('renders the empty panel with both level tabs and the composer', () => {
    const clientModule = loadClientModule()
    const tree = clientModule.NotepadPage()
    assert.equal(tree.type, 'div')
    assert.match(tree.props.className, /notepadPage/)
    const rendered = texts(tree).join(' | ')
    assert.match(rendered, /速记 Notepad/)
    assert.match(rendered, /项目/)
    assert.match(rendered, /全局/)
    assert.match(rendered, /还没有笔记/)
    const textareas = elements(tree, 'textarea')
    assert.equal(textareas.length, 1)
    assert.match(textareas[0].props.placeholder, /记一条/)
    const tabs = elements(tree, 'button').filter((button) => button.props.className === 'notepadTab')
    assert.equal(tabs.length, 2)
  })

  it('renders the sidebar icon at the requested size', () => {
    const clientModule = loadClientModule()
    const icon = clientModule.NotepadIcon({ size: 18, active: true })
    assert.equal(icon.type, 'svg')
    assert.equal(icon.props.width, 18)
    assert.equal(icon.props.height, 18)
    assert.equal(icon.children.length, 2)
  })

  it('speaks the same contract as the host API', async () => {
    const source = await readFile(CLIENT_PATH, 'utf8')
    assert.match(source, new RegExp(CLIENT_HEADER))
    assert.match(source, /api\/notepad/)
    for (const route of ['/state', '/notes', '/clear']) assert.ok(source.includes(route), `bundle calls ${route}`)
    assert.equal(API_PREFIX, '/api/notepad')
    assert.equal(typeof createNotepadApi, 'function')
  })
})
