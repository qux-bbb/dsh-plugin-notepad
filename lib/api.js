/**
 * JSON API behind the notepad panel.
 *
 * `createNotepadApi` owns every decision (routing, validation, state shape) and
 * returns a framework-free `handle(request)` result, so the same code is unit
 * testable and is what the host's HTTP route calls. The client half talks to it
 * over the Web server under {@link API_PREFIX}.
 *
 * Requests must carry the {@link CLIENT_HEADER} marker header: a custom header
 * cannot be attached by a cross-site form or image request without a CORS
 * preflight this route never approves, which keeps other local pages from
 * writing the user's notes. The route is otherwise unauthenticated, like every
 * other plugin route on the local Web server.
 *
 * @module dsh-plugin-notepad/api
 */
import { NotepadError, SCOPES } from './store.js'

/** Route prefix every notepad API request starts with. */
export const API_PREFIX = '/api/notepad'
/** Marker header the browser half sends and every handler requires. */
export const CLIENT_HEADER = 'x-notepad-client'
/** Largest accepted request body, in bytes. */
export const MAX_BODY_BYTES = 256 * 1024

/** A rejected request carrying its HTTP status. */
export class ApiError extends Error {
  /**
   * @param {number} status - HTTP status this failure answers with.
   * @param {string} message - the caller-facing problem.
   */
  constructor(status, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * Read one string field.
 * @param {unknown} value - raw field value.
 * @param {string} field - field name for the error message.
 * @param {{ required?: boolean }} [options] - whether absence is an error.
 * @returns {string | undefined} the trimmed value.
 */
function readString(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ApiError(400, `${field} must be a non-blank string`)
    return undefined
  }
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be a string`)
  return value
}

/**
 * Read one request body field as an object, rejecting arrays and scalars.
 * @param {unknown} body - parsed request body.
 * @returns {Record<string, unknown>} the body object.
 */
function readBody(body) {
  if (body === undefined || body === null) return {}
  if (typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'request body must be a JSON object')
  return body
}

/**
 * Read a non-negative integer field.
 * @param {unknown} value - raw field value.
 * @param {string} field - field name for the error message.
 * @returns {number | undefined} the parsed value.
 */
function readCount(value, field) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new ApiError(400, `${field} must be a non-negative integer`)
  return parsed
}

/**
 * Build the notepad API.
 * @param {object} options - API dependencies.
 * @param {(cwd: string) => import('./store.js').NotepadStore} options.storeFor - store per session directory.
 * @param {() => Array<{ path: string, title: string }>} [options.listProjects] - registered project directories.
 * @param {(request: { headers: Record<string, unknown> }) => 401 | 403 | undefined} [options.admit] - the host's browser-session gate (`connection.requestRejection`); omitted means no gate.
 * @param {(sessionId: string) => string | undefined} [options.resolveSessionCwd] - working directory of a live session, so the panel follows the project the user is in.
 * @returns {{ handle: (request: { method: string, pathname: string, query?: Record<string, string | undefined>, headers?: Record<string, unknown>, body?: unknown }) => Promise<{ status: number, body: unknown }> }} the API.
 */
export function createNotepadApi({ storeFor, listProjects = () => [], admit, resolveSessionCwd }) {
  /**
   * Resolve one request to the store it addresses plus the project it selected.
   *
   * Precedence: an explicit `project` (the panel's manual choice), else the
   * `session` the panel is following (its live cwd), else the most recently
   * updated registered workspace, else the host process directory.
   * @param {Record<string, unknown>} source - body object or query map.
   * @returns {{ store: import('./store.js').NotepadStore, current: { source: string, path: string, projectRoot: string } }} the resolution.
   */
  const resolve = (source) => {
    const project = readString(source.project, 'project')
    if (project !== undefined) {
      const store = storeFor(project)
      return { store, current: { source: 'manual', path: project, projectRoot: store.projectRoot } }
    }
    const session = readString(source.session, 'session')
    const sessionCwd = session === undefined || resolveSessionCwd === undefined ? undefined : resolveSessionCwd(session)
    if (sessionCwd !== undefined && sessionCwd !== null && sessionCwd !== '') {
      const store = storeFor(sessionCwd)
      return { store, current: { source: 'session', path: store.cwd, projectRoot: store.projectRoot } }
    }
    const fallback = listProjects()[0]?.path ?? process.cwd()
    const store = storeFor(fallback)
    return { store, current: { source: 'default', path: fallback, projectRoot: store.projectRoot } }
  }

  /**
   * One level's listing, or its disabled marker.
   * @param {import('./store.js').NotepadStore} store - the request's store.
   * @param {'global' | 'project'} scope - level to describe.
   * @param {number | undefined} limit - maximum notes to include; omitted means every note.
   * @returns {Promise<Record<string, unknown>>} the level payload.
   */
  const levelOf = async (store, scope, limit) => {
    if (!store.scopes.includes(scope)) return { scope, enabled: false, notes: [], total: 0 }
    const listing = await store.list({ scope, limit })
    return {
      scope,
      enabled: true,
      dir: store.dirFor(scope),
      file: store.fileFor(scope),
      total: listing.total,
      notes: listing.notes,
    }
  }

  /**
   * The full panel state for one store.
   * @param {import('./store.js').NotepadStore} store - the request's store.
   * @param {number | undefined} limit - maximum notes per level.
   * @param {{ source: string, path: string, projectRoot: string }} current - the project this request resolved to.
   * @returns {Promise<Record<string, unknown>>} the state payload.
   */
  const stateOf = async (store, limit, current) => ({
    level: store.level,
    defaultScope: store.defaultScope,
    cwd: store.cwd,
    projectRoot: store.projectRoot,
    current,
    projects: listProjects(),
    levels: {
      global: await levelOf(store, 'global', limit),
      project: await levelOf(store, 'project', limit),
    },
  })

  /**
   * One level's fresh listing after a mutation.
   * @param {import('./store.js').NotepadStore} store - the request's store.
   * @param {'global' | 'project'} scope - the mutated level.
   * @returns {Promise<Record<string, unknown>>} the level payload.
   */
  const afterMutation = async (store, scope) => ({ ok: true, ...await levelOf(store, scope, undefined) })

  /**
   * Answer one API request.
   * @param {object} request - the parsed request.
   * @param {string} request.method - HTTP method.
   * @param {string} request.pathname - absolute pathname.
   * @param {Record<string, string | undefined>} [request.query] - query parameters.
   * @param {Record<string, unknown>} [request.headers] - lowercased request headers.
   * @param {unknown} [request.body] - parsed JSON body.
   * @returns {Promise<{ status: number, body: unknown }>} the response.
   */
  const handle = async ({ method, pathname, query = {}, headers = {}, body }) => {
    try {
      // The host's own browser-session gate first: this route shadows the
      // API-gateway prefix, so it must apply the same Host/Origin fence and
      // cookie authentication the framework applies to its own routes.
      const rejection = admit === undefined ? undefined : admit({ headers })
      if (rejection !== undefined) {
        return {
          status: rejection,
          body: {
            error: rejection === 401
              ? 'unauthenticated: open the notepad panel from the GUI (its browser session cookie is required)'
              : 'rejected: the request failed the host/origin fence',
          },
        }
      }
      if (headers[CLIENT_HEADER] !== '1') throw new ApiError(403, `missing ${CLIENT_HEADER} header`)
      const route = pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'
      const verb = String(method ?? 'GET').toUpperCase()

      if (route === '/state') {
        if (verb !== 'GET') throw new ApiError(405, `${verb} is not allowed on ${API_PREFIX}/state`)
        const { store, current } = resolve(query)
        return { status: 200, body: await stateOf(store, readCount(query.limit, 'limit'), current) }
      }

      if (route === '/notes') {
        const input = readBody(body)
        const { store } = resolve(input)
        const scope = readString(input.scope, 'scope')
        if (verb === 'POST') {
          const content = readString(input.content, 'content', { required: true })
          const tags = input.tags === undefined ? [] : input.tags
          if (!Array.isArray(tags)) throw new ApiError(400, 'tags must be an array of strings')
          const added = await store.add({ content, tags, scope })
          return { status: 201, body: { ...await afterMutation(store, added.note.scope), note: added.note } }
        }
        if (verb === 'PUT' || verb === 'PATCH') {
          const id = readString(input.id, 'id', { required: true })
          const content = input.content === undefined ? undefined : readString(input.content, 'content')
          const tags = input.tags === undefined ? undefined : input.tags
          if (tags !== undefined && !Array.isArray(tags)) throw new ApiError(400, 'tags must be an array of strings')
          const updated = await store.update({ scope, id, content, tags })
          return { status: 200, body: { ...await afterMutation(store, updated.note.scope), note: updated.note } }
        }
        if (verb === 'DELETE') {
          const id = readString(input.id, 'id', { required: true })
          const removed = await store.remove({ scope, id })
          const level = SCOPES.includes(scope)
            ? scope
            : store.scopes.includes(store.defaultScope) ? store.defaultScope : store.scopes[0]
          return { status: removed.removed > 0 ? 200 : 404, body: { ...await afterMutation(store, level), removed: removed.removed } }
        }
        throw new ApiError(405, `${verb} is not allowed on ${API_PREFIX}/notes`)
      }

      if (route === '/clear') {
        if (verb !== 'POST') throw new ApiError(405, `${verb} is not allowed on ${API_PREFIX}/clear`)
        const input = readBody(body)
        const { store } = resolve(input)
        const scope = readString(input.scope, 'scope')
        const report = await store.clear({ scope })
        const level = report.scopes[0]
        return { status: 200, body: { ...await afterMutation(store, level), removed: report.removed } }
      }

      throw new ApiError(404, `unknown notepad route ${JSON.stringify(pathname)}`)
    } catch (error) {
      if (error instanceof ApiError) return { status: error.status, body: { error: error.message } }
      if (error instanceof NotepadError) return { status: 400, body: { error: error.message } }
      if (error instanceof TypeError) return { status: 400, body: { error: error.message } }
      return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } }
    }
  }

  return { handle }
}

export { SCOPES }
