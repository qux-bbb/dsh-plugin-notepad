import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { API_PREFIX, CLIENT_HEADER, createNotepadApi } from '../lib/api.js'
import { NotepadStore } from '../lib/store.js'

/** @type {string} */
let root
/** @type {string} */
let project

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'notepad-api-'))
  project = join(root, 'proj')
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * Build an API over real stores, plus a raw dispatcher that always sends the
 * marker header (tests that specifically probe the guard pass `headers`).
 */
function makeApi(name, { level = 'both', defaultScope = 'project', projects = [], sessions = {} } = {}) {
  const stores = new Map()
  const storeFor = (cwd) => {
    let store = stores.get(cwd)
    if (store === undefined) {
      store = new NotepadStore({
        cwd,
        level,
        defaultScope,
        dshHome: root,
        globalDir: join(cwd, '.global'),
        projectRootMarkers: [],
      })
      stores.set(cwd, store)
    }
    return store
  }
  const api = createNotepadApi({
    storeFor,
    listProjects: () => projects,
    resolveSessionCwd: (sessionId) => sessions[sessionId],
  })
  const cwd = join(project, name)
  return {
    cwd,
    stores,
    send: (method, route, { body, query, headers } = {}) => api.handle({
      method,
      pathname: `${API_PREFIX}${route}`,
      query,
      headers: { [CLIENT_HEADER]: '1', ...headers },
      body,
    }),
    raw: (request) => api.handle(request),
  }
}

describe('notepad api', () => {
  it('applies the host session gate before anything else', async () => {
    const stores = new Map()
    const storeFor = (cwd) => {
      let store = stores.get(cwd)
      if (store === undefined) {
        store = new NotepadStore({ cwd, globalDir: join(cwd, '.global'), projectRootMarkers: [] })
        stores.set(cwd, store)
      }
      return store
    }
    const denied = createNotepadApi({ storeFor, admit: () => 401 })
    const response = await denied.handle({
      method: 'GET',
      pathname: `${API_PREFIX}/state`,
      headers: { [CLIENT_HEADER]: '1' },
    })
    assert.equal(response.status, 401)
    assert.match(response.body.error, /unauthenticated/)

    const fenced = createNotepadApi({ storeFor, admit: () => 403 })
    const fencedResponse = await fenced.handle({ method: 'GET', pathname: `${API_PREFIX}/state`, headers: {} })
    assert.equal(fencedResponse.status, 403)
    assert.match(fencedResponse.body.error, /origin fence/)

    // The gate sees exactly the headers the Web handler received.
    const seen = []
    const gated = createNotepadApi({
      storeFor,
      admit: (request) => {
        seen.push(request.headers)
        return undefined
      },
    })
    await gated.handle({ method: 'GET', pathname: `${API_PREFIX}/state`, headers: { host: '127.0.0.1:19387', cookie: 'a=b' } })
    assert.deepEqual(seen, [{ host: '127.0.0.1:19387', cookie: 'a=b' }])
  })

  it('requires the client marker header', async () => {
    const api = makeApi('guard')
    const denied = await api.raw({ method: 'GET', pathname: `${API_PREFIX}/state`, headers: {} })
    assert.equal(denied.status, 403)
    assert.match(denied.body.error, /x-notepad-client/)
    assert.equal((await api.send('GET', '/state', { query: { project: api.cwd } })).status, 200)
  })

  it('describes both levels, the project root, and the project list', async () => {
    const api = makeApi('state', { projects: [{ path: project, title: 'proj' }] })
    const response = await api.send('GET', '/state', { query: { project: api.cwd, limit: '0' } })
    assert.equal(response.status, 200)
    assert.equal(response.body.level, 'both')
    assert.equal(response.body.defaultScope, 'project')
    assert.equal(response.body.projectRoot, api.cwd)
    assert.deepEqual(response.body.current, { source: 'manual', path: api.cwd, projectRoot: api.cwd })
    assert.deepEqual(response.body.projects, [{ path: project, title: 'proj' }])
    assert.equal(response.body.levels.global.enabled, true)
    assert.equal(response.body.levels.project.enabled, true)
    assert.match(response.body.levels.project.file, /\.dsh[\\/]notepad[\\/]notes\.jsonl$/)
    assert.equal(response.body.levels.global.file, join(api.cwd, '.global', 'notes.jsonl'))
  })

  it('marks a disabled level instead of hiding it', async () => {
    const api = makeApi('state-global-only', { level: 'global', defaultScope: 'global' })
    const response = await api.send('GET', '/state', { query: { project: api.cwd } })
    assert.equal(response.body.levels.global.enabled, true)
    assert.deepEqual(response.body.levels.project, { scope: 'project', enabled: false, notes: [], total: 0 })
  })

  it('follows the panel selector: live session first, then a manual project, then the newest project', async () => {
    const recentPath = join(project, 'recent')
    const livePath = join(project, 'live')
    const api = makeApi('selector', {
      projects: [{ path: recentPath, title: 'recent' }, { path: livePath, title: 'live' }],
      sessions: { 'session-live': livePath },
    })

    const followed = await api.send('GET', '/state', { query: { session: 'session-live' } })
    assert.equal(followed.body.current.source, 'session')
    assert.equal(followed.body.current.path, livePath)
    assert.equal(followed.body.projectRoot, livePath)

    const manual = await api.send('GET', '/state', { query: { session: 'session-live', project: recentPath } })
    assert.equal(manual.body.current.source, 'manual')
    assert.equal(manual.body.current.path, recentPath)

    // An unknown session (closed or from another app run) falls back to the
    // most recently updated project rather than failing.
    const unknown = await api.send('GET', '/state', { query: { session: 'session-gone' } })
    assert.equal(unknown.body.current.source, 'default')
    assert.equal(unknown.body.current.path, recentPath)

    // A mutation addresses exactly the project the visible list came from.
    await api.send('POST', '/notes', { body: { session: 'session-live', scope: 'project', content: 'live note' } })
    const afterWrite = await api.send('GET', '/state', { query: { session: 'session-live' } })
    assert.equal(afterWrite.body.levels.project.notes[0].content, 'live note')
    assert.equal((await api.send('GET', '/state', { query: { project: recentPath } })).body.levels.project.total, 0)
  })

  it('adds, edits, and deletes notes through the routes', async () => {
    const api = makeApi('roundtrip')
    const added = await api.send('POST', '/notes', {
      body: { project: api.cwd, scope: 'project', content: 'from the panel', tags: [' ui ', 'ui'] },
    })
    assert.equal(added.status, 201)
    assert.equal(added.body.note.content, 'from the panel')
    assert.deepEqual(added.body.note.tags, ['ui'])
    assert.equal(added.body.total, 1)
    assert.equal(added.body.scope, 'project')

    const edited = await api.send('PUT', '/notes', {
      body: { project: api.cwd, scope: 'project', id: added.body.note.id, content: 'edited in the panel' },
    })
    assert.equal(edited.status, 200)
    assert.equal(edited.body.note.id, added.body.note.id)
    assert.equal(edited.body.note.content, 'edited in the panel')
    assert.equal(edited.body.notes[0].content, 'edited in the panel')

    const global = await api.send('POST', '/notes', {
      body: { project: api.cwd, scope: 'global', content: 'global from the panel' },
    })
    assert.equal(global.body.note.scope, 'global')
    assert.equal(global.body.total, 1)

    const deleted = await api.send('DELETE', '/notes', {
      body: { project: api.cwd, scope: 'project', id: added.body.note.id },
    })
    assert.equal(deleted.status, 200)
    assert.equal(deleted.body.removed, 1)
    assert.equal(deleted.body.total, 0)

    const missing = await api.send('DELETE', '/notes', {
      body: { project: api.cwd, scope: 'project', id: added.body.note.id },
    })
    assert.equal(missing.status, 404)
    assert.equal(missing.body.removed, 0)
    assert.equal((await api.send('GET', '/state', { query: { project: api.cwd } })).body.levels.global.total, 1)
  })

  it('clears one level', async () => {
    const api = makeApi('clear')
    await api.send('POST', '/notes', { body: { project: api.cwd, scope: 'global', content: 'a' } })
    await api.send('POST', '/notes', { body: { project: api.cwd, scope: 'project', content: 'b' } })
    const cleared = await api.send('POST', '/clear', { body: { project: api.cwd, scope: 'global' } })
    assert.equal(cleared.status, 200)
    assert.equal(cleared.body.removed, 1)
    assert.equal(cleared.body.scope, 'global')
    assert.equal(cleared.body.total, 0)
    const state = await api.send('GET', '/state', { query: { project: api.cwd } })
    assert.equal(state.body.levels.global.total, 0)
    assert.equal(state.body.levels.project.total, 1)
  })

  it('rejects malformed input with 400 and unknown routes with 404', async () => {
    const api = makeApi('errors')
    const blank = await api.send('POST', '/notes', { body: { project: api.cwd, content: '   ' } })
    assert.equal(blank.status, 400)
    assert.match(blank.body.error, /content must be/)
    const badScope = await api.send('POST', '/notes', { body: { project: api.cwd, content: 'x', scope: 'nope' } })
    assert.equal(badScope.status, 400)
    assert.match(badScope.body.error, /unknown scope/)
    const badTags = await api.send('POST', '/notes', { body: { project: api.cwd, content: 'x', tags: 'a' } })
    assert.equal(badTags.status, 400)
    const badJson = await api.send('POST', '/notes', { body: 'not-an-object' })
    assert.equal(badJson.status, 400)
    const unknown = await api.send('GET', '/nope', { query: { project: api.cwd } })
    assert.equal(unknown.status, 404)
    const wrongVerb = await api.send('PATCH', '/clear', { body: { project: api.cwd } })
    assert.equal(wrongVerb.status, 405)
    const badLimit = await api.send('GET', '/state', { query: { project: api.cwd, limit: '-1' } })
    assert.equal(badLimit.status, 400)
  })

  it('routes each project path to its own notes', async () => {
    const api = makeApi('projects')
    const other = join(project, 'other')
    await api.send('POST', '/notes', { body: { project: api.cwd, content: 'in one' } })
    await api.send('POST', '/notes', { body: { project: other, content: 'in the other' } })
    const first = await api.send('GET', '/state', { query: { project: api.cwd } })
    const second = await api.send('GET', '/state', { query: { project: other } })
    assert.equal(first.body.levels.project.total, 1)
    assert.equal(first.body.levels.project.notes[0].content, 'in one')
    assert.equal(second.body.levels.project.notes[0].content, 'in the other')
    assert.equal(api.stores.size, 2)
  })
})
