/**
 * `notepad` — a deliberately small DeepSeek Harness plugin that records short
 * notes.
 *
 * It registers three model-facing tools on `ctx.tools` and, when the deployment
 * has a command registry, one human `/note` command:
 *
 * - `notepad_add`   — append one note.
 * - `notepad_list`  — read notes back, newest first.
 * - `notepad_clear` — delete one level's notes (requires `confirm: true`).
 *
 * Notes live in one of two levels, selected by the `level` / `defaultScope`
 * config and overridable per call:
 *
 * - `global`  → `<dshHome>/notepad/notes.jsonl`, shared by every project.
 * - `project` → `<projectRoot>/.dsh/notepad/notes.jsonl`, one file per project.
 *
 * @module dsh-plugin-notepad
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { API_PREFIX, ApiError, CLIENT_HEADER, MAX_BODY_BYTES, createNotepadApi } from './api.js'
import {
  DEFAULT_FILE_NAME,
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_CONTENT_LENGTH,
  DEFAULT_MAX_NOTES,
  DEFAULT_PROJECT_MARKERS,
  LEVELS,
  NotepadStore,
  SCOPES,
  normalizeLevel,
} from './store.js'

/** Loader entry name. */
export const name = 'notepad'
/** Required services: the tool registry (the command registry is optional). */
export const inject = ['tools']

const LEVEL_SCHEMA = z.union([z.const('global'), z.const('project'), z.const('both')])
const SCOPE_SCHEMA = z.union([z.const('global'), z.const('project')])

/**
 * Deployment configuration.
 *
 * `level` chooses which levels exist here and `defaultScope` chooses where an
 * omitted scope lands, so one config shape covers both supported deployments:
 * a global notepad (`level: global`), a project notepad (`level: project`), or
 * both at once (`level: both`).
 */
export const Config = z.object({
  level: LEVEL_SCHEMA.default('both').description('Note levels this deployment exposes: `global` ($DSH_HOME), `project` (per project root), or `both`.'),
  defaultScope: SCOPE_SCHEMA.default('project').description('Level used when a call omits `scope`.'),
  dshHome: z.string().default('').description('Harness home for the global level; empty resolves $DSH_HOME, then ~/.dsh.'),
  globalDir: z.string().default('').description('Global note directory; empty uses `<dshHome>/notepad`.'),
  projectDir: z.string().default('').description('Project note directory; empty uses `<projectRoot>/.dsh/notepad`.'),
  fileName: z.string().default(DEFAULT_FILE_NAME).description('Note file name inside a level directory.'),
  projectRootMarkers: z.array(z.string()).default([...DEFAULT_PROJECT_MARKERS]).description('Ancestor markers that identify a project root, nearest first.'),
  maxNotes: z.natural().default(DEFAULT_MAX_NOTES).description('Notes kept per file; older notes are pruned. 0 disables pruning.'),
  maxContentLength: z.natural().default(DEFAULT_MAX_CONTENT_LENGTH).description('Maximum characters in one note.'),
  defaultLimit: z.natural().default(DEFAULT_LIST_LIMIT).description('Notes returned by a listing that omits `limit`.'),
  toolPrefix: z.string().default('notepad').description('Prefix of the registered tool names.'),
  enableCommand: z.boolean().default(true).description('Whether to register the human `/note` command when a command registry is present.'),
})

/**
 * Resolve raw config into the effective options, applying the same defaults the
 * Config schema would. `apply` stays correct when it is called with a plain
 * object (tests, `cordis:` builtins) instead of loader-validated config.
 * @param {Record<string, unknown>} [config] - raw plugin config.
 * @returns {{ level: 'global' | 'project' | 'both', defaultScope: 'global' | 'project', dshHome: string, globalDir: string, projectDir: string, fileName: string, projectRootMarkers: string[], maxNotes: number, maxContentLength: number, defaultLimit: number, toolPrefix: string, enableCommand: boolean }} effective options.
 */
export function resolveOptions(config = {}) {
  const raw = typeof config === 'object' && config !== null ? config : {}
  const text = (value, fallback) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback)
  const count = (value, fallback) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback)
  // An explicit empty list is meaningful: "the session directory is the project root".
  const markers = Array.isArray(raw.projectRootMarkers)
    ? raw.projectRootMarkers.filter((marker) => typeof marker === 'string' && marker.trim().length > 0)
    : [...DEFAULT_PROJECT_MARKERS]
  const prefix = text(raw.toolPrefix, 'notepad')
  return {
    level: normalizeLevel(raw.level),
    defaultScope: SCOPES.includes(raw.defaultScope) ? raw.defaultScope : 'project',
    dshHome: text(raw.dshHome, ''),
    globalDir: text(raw.globalDir, ''),
    projectDir: text(raw.projectDir, ''),
    fileName: text(raw.fileName, DEFAULT_FILE_NAME),
    projectRootMarkers: markers.length > 0 ? markers : [],
    maxNotes: count(raw.maxNotes, DEFAULT_MAX_NOTES),
    maxContentLength: count(raw.maxContentLength, DEFAULT_MAX_CONTENT_LENGTH),
    defaultLimit: count(raw.defaultLimit, DEFAULT_LIST_LIMIT),
    toolPrefix: /^[a-z][a-z0-9_-]*$/.test(prefix) ? prefix : 'notepad',
    enableCommand: raw.enableCommand !== false,
  }
}

/**
 * The session working directory a call belongs to, falling back to the host
 * process directory for a non-agent caller.
 * @param {{ agent?: { session?: { header?: { cwd?: string } } } } | undefined} exec - tool execution context.
 * @returns {string} an absolute working directory.
 */
function cwdOf(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd()
}

/**
 * The one-line rendering shared by the `/note` command and error text.
 * @param {Array<{ id: string, at: string, scope: string, content: string }>} notes - notes, newest first.
 * @param {number} total - total matching notes before the limit.
 * @returns {string} the rendered listing.
 */
export function renderNotes(notes, total) {
  if (notes.length === 0) return 'No notes yet.'
  const head = notes.map((note, index) => `${index + 1}. [${note.id}] ${note.at} (${note.scope}) ${note.content}`)
  const tail = notes.length < total ? `\n… ${total - notes.length} older note(s) not shown.` : ''
  return `${head.join('\n')}${tail}`
}

/** The `enabled` clause appended to guidance about a disabled level. */
function scopeHint(options) {
  return options.level === 'both'
    ? 'Use `global` for cross-project notes or `project` for this project\'s notes.'
    : `This deployment stores notes at the \`${options.level}\` level only.`
}

/**
 * Register the notepad tools, and optionally the `/note` command, on the
 * calling context.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context. `ctx.tools` is required; `ctx.commands` is used when present.
 * @param {Record<string, unknown>} [config] - raw plugin config.
 */
export function apply(ctx, config = {}) {
  const options = resolveOptions(config)
  /** @type {Map<string, NotepadStore>} per-working-directory stores. */
  const stores = new Map()
  const storeFor = (cwd) => {
    const key = cwd
    let store = stores.get(key)
    if (store === undefined) {
      if (stores.size >= 32) stores.clear()
      store = new NotepadStore({ cwd: key, ...options })
      stores.set(key, store)
    }
    return store
  }

  ctx.tools.register(defineTool({
    name: `${options.toolPrefix}_add`,
    description: `Append one short note to the notepad so it can be recalled later. ${scopeHint(options)} Notes are stored as JSON Lines, one file per level, and every note gets a timestamp and a short id.`,
    parameters: {
      content: { type: 'string', required: true, description: 'The note text. One self-contained fact, decision, or reminder.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional free-form tags used for later filtering.' },
      scope: { type: 'string', enum: [...SCOPES], description: 'Storage level for this note; omitted uses the configured default level.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          at: { type: 'string', required: true },
          scope: { type: 'string', required: true, enum: [...SCOPES] },
          tags: { type: 'array', required: true, items: { type: 'string' } },
          content: { type: 'string', required: true },
          file: { type: 'string', required: true },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Noted ${value.id} at ${value.at} in the ${value.scope} notepad (${value.total} note(s) there).\nFile: ${value.file}`,
      }],
    },
    async execute(args, exec) {
      const store = storeFor(cwdOf(exec))
      const { note, file, total } = await store.add({ content: args.content, tags: args.tags, scope: args.scope })
      return { ...note, file, total }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Notepad: add note',
      kind: 'other',
      rawInput: typeof args.content === 'string' ? args.content : args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: `${options.toolPrefix}_list`,
    description: `Read notes back from the notepad, newest first. ${scopeHint(options)} Omit \`scope\` to read every enabled level at once; use \`query\` to filter and \`limit\` to bound the result (0 returns every match).`,
    parameters: {
      scope: { type: 'string', enum: [...SCOPES], description: 'Level to read; omitted reads every enabled level.' },
      query: { type: 'string', description: 'Case-insensitive substring filter over note text, tags, and id.' },
      limit: { type: 'integer', description: `Maximum notes to return; 0 returns every match. Defaults to ${options.defaultLimit}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scopes: { type: 'array', required: true, items: { type: 'string' } },
          total: { type: 'integer', required: true },
          returned: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          notes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                at: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                tags: { type: 'array', required: true, items: { type: 'string' } },
                content: { type: 'string', required: true },
                file: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderNotes(value.notes, value.total),
      }],
    },
    async execute(args, exec) {
      return await storeFor(cwdOf(exec)).list({ scope: args.scope, query: args.query, limit: args.limit })
    },
    presentCall: () => ({ card: 'generic', title: 'Notepad: list notes', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: `${options.toolPrefix}_clear`,
    description: `Delete stored notes. ${scopeHint(options)} Destructive: pass \`confirm: true\`, and pass an explicit \`scope\` to clear exactly one level.`,
    parameters: {
      scope: { type: 'string', required: true, enum: [...SCOPES], description: 'The one level to clear.' },
      confirm: { type: 'boolean', required: true, description: 'Must be true; the call is refused otherwise.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', required: true },
          removed: { type: 'integer', required: true },
          file: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.removed === 0
          ? `The ${value.scope} notepad was already empty (${value.file}).`
          : `Cleared ${value.removed} note(s) from the ${value.scope} notepad (${value.file}).`,
      }],
    },
    async execute(args, exec) {
      if (args.confirm !== true) throw new Error('refusing to clear notes: pass `confirm: true` to confirm the deletion')
      const store = storeFor(cwdOf(exec))
      const report = await store.clear({ scope: args.scope })
      const entry = report.files[0]
      return { scope: args.scope, removed: entry?.removed ?? 0, file: entry?.file ?? store.fileFor(args.scope) }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Notepad: clear notes', kind: 'delete', rawInput: args.scope }),
  }))

  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : ctx.commands
  if (options.enableCommand && commands !== undefined && typeof commands.register === 'function') {
    ctx.effect(() => commands.register({
      name: 'note',
      description: 'Record a quick note, or list the most recent ones',
      input: { hint: '<text> — 留空则列出最近 5 条' },
      handler: async (invocation) => {
        const store = storeFor(invocation.agent?.session?.header?.cwd ?? process.cwd())
        const text = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
        if (text.length === 0) {
          const { notes, total } = await store.list({ limit: 5 })
          return { kind: 'success', text: renderNotes(notes, total) }
        }
        const { note, file, total } = await store.add({ content: text })
        return { kind: 'success', text: `Noted ${note.id} (${note.scope}, ${total} note(s)).\nFile: ${file}` }
      },
    }), 'notepad /note command')
  }

  // The panel's data channel. `webServer` is optional: a profile without a Web
  // carrier (headless, sdk) keeps the tools and the `/note` command only.
  const api = createNotepadApi({
    storeFor,
    listProjects: () => listProjects(ctx),
    // The panel follows the session the user is in: its session-scoped client
    // registration reports the id, and the host resolves that session's cwd to
    // the same project the model tools use.
    resolveSessionCwd: (sessionId) => {
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      if (agents === undefined || typeof agents.get !== 'function') return undefined
      try {
        return agents.get(sessionId)?.session?.header?.cwd
      } catch {
        return undefined
      }
    },
    // Reuse the host's own browser-session gate: this route shadows the API
    // gateway prefix, so nothing else would authenticate it.
    admit: (request) => {
      const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
      if (connection === undefined || typeof connection.requestRejection !== 'function') return undefined
      try {
        return connection.requestRejection({ headers: request.headers })
      } catch {
        return undefined
      }
    },
  })
  ctx.inject(['webServer'], (routeCtx) => {
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => {
        void serveNotepadApi(api, req, res, routeCtx.logger)
      },
    }), 'notepad api route')
  })
}

/**
 * The project directories the panel can target: every registered workspace,
 * most recently updated first so the panel's fallback and its dropdown both
 * prefer the project that was touched last.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @returns {Array<{ path: string, title: string }>} registered workspaces.
 */
function listProjects(ctx) {
  const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  if (registry === undefined || typeof registry.list !== 'function') return []
  try {
    return registry.list()
      .map((workspace) => ({ path: workspace.path, title: workspace.title, updatedAt: workspace.updatedAt }))
      .sort((left, right) => (left.updatedAt === right.updatedAt ? 0 : left.updatedAt < right.updatedAt ? 1 : -1))
      .map(({ path, title }) => ({ path, title }))
  } catch {
    return []
  }
}

/**
 * Read a request body, bounded by {@link MAX_BODY_BYTES}.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<string>} the body text.
 * @throws {ApiError} 413 when the body exceeds the cap.
 */
async function readRequestBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new ApiError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - JSON-serializable body.
 */
function respondJson(res, status, payload) {
  const text = JSON.stringify(payload ?? null)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Serve one notepad API request over HTTP. The route is same-origin only: it
 * answers no CORS preflight, and the API itself requires {@link CLIENT_HEADER}.
 * @param {ReturnType<typeof createNotepadApi>} api - the API.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {{ warn?: (value: unknown) => void }} [logger] - host logger.
 */
async function serveNotepadApi(api, req, res, logger) {
  try {
    const method = String(req.method ?? 'GET').toUpperCase()
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) {
      respondJson(res, 404, { error: `unknown notepad route ${JSON.stringify(url.pathname)}` })
      return
    }
    const query = Object.fromEntries(url.searchParams.entries())
    let body
    if (method !== 'GET' && method !== 'HEAD') {
      const raw = await readRequestBody(req)
      if (raw.trim().length > 0) {
        try {
          body = JSON.parse(raw)
        } catch {
          respondJson(res, 400, { error: 'request body must be valid JSON' })
          return
        }
      }
    }
    const result = await api.handle({ method, pathname: url.pathname, query, headers: req.headers ?? {}, body })
    respondJson(res, result.status, result.body)
  } catch (error) {
    if (error instanceof ApiError) {
      respondJson(res, error.status, { error: error.message })
      return
    }
    logger?.warn?.(error)
    respondJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

export { NotepadStore, NotepadError, SCOPES, LEVELS } from './store.js'
// Exported for tests.
export { listProjects }

// Named exports only, like every first-party DSH plugin. The loader unwraps a
// module as `exports.default ?? exports`, so an extra default object is only a
// second, competing plugin shape here.
