/**
 * Note storage for `dsh-plugin-notepad`.
 *
 * Notes are plain JSON Lines (`{"id","at","scope","tags","content"}` per line),
 * one file per level, so the store stays readable and greppable without any
 * database dependency:
 *
 * - `global`  → `<dshHome>/notepad/notes.jsonl` — shared by every project.
 * - `project` → `<projectRoot>/.dsh/notepad/notes.jsonl` — one file per project,
 *   where `projectRoot` is the nearest ancestor holding a project root marker.
 *
 * Writes are serialized per note file (not per store instance), so concurrent
 * tool calls — including calls landing on two different stores that resolve to
 * the same project file — cannot interleave a partial line or lose an update.
 *
 * @module dsh-plugin-notepad/store
 */
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** The two note levels, in listing order. */
export const SCOPES = ['global', 'project']
/** The `level` config values: one level, or both. */
export const LEVELS = ['global', 'project', 'both']
/** Default note file name inside a level directory. */
export const DEFAULT_FILE_NAME = 'notes.jsonl'
/**
 * Default project-root markers, checked in order at every ancestor. Deliberately
 * excludes `.dsh`: the harness home is itself `<home>/.dsh`, so treating it as a
 * marker would resolve every path under the user's home to the harness home and
 * silently merge project notes into the global level.
 */
export const DEFAULT_PROJECT_MARKERS = ['.git', '.hg', '.svn']
/** Default per-file note cap (oldest notes are pruned past it). */
export const DEFAULT_MAX_NOTES = 1000
/** Default content length cap, in characters. */
export const DEFAULT_MAX_CONTENT_LENGTH = 4000
/** Default `limit` for a listing that omits one. */
export const DEFAULT_LIST_LIMIT = 20

/** A user-facing configuration or input problem. */
export class NotepadError extends Error {
  /**
   * @param {string} message - the problem, phrased for the caller.
   */
  constructor(message) {
    super(message)
    this.name = 'NotepadError'
  }
}

/**
 * Expand the supported tilde prefixes against the operating-system home.
 * @param {string} path - configured path that may begin with `~`, `~/`, or `~\`.
 * @returns {string} the expanded path.
 */
export function expandHomePath(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the DeepSeek Harness home. Precedence: explicit config, `$DSH_HOME`,
 * then `~/.dsh` — the same order the harness itself uses.
 * @param {string} [configured] - explicit harness-home override.
 * @param {Record<string, string | undefined>} [env] - environment mapping.
 * @returns {string} the absolute harness home.
 */
export function resolveDshHome(configured, env = process.env) {
  const fromConfig = typeof configured === 'string' && configured.trim().length > 0 ? configured.trim() : undefined
  const fromEnv = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim().length > 0 ? env.DSH_HOME.trim() : undefined
  return resolve(expandHomePath(fromConfig ?? fromEnv ?? join(homedir(), '.dsh')))
}

/**
 * Find the project root for a session working directory: the nearest ancestor
 * (starting at `cwd`) that contains one of `markers`, else `cwd` itself.
 * @param {string} cwd - the session working directory.
 * @param {readonly string[]} [markers] - project root markers; empty entries are ignored.
 * @param {(path: string) => boolean} [exists] - existence probe, injectable for tests.
 * @returns {string} the absolute project root.
 */
export function findProjectRoot(cwd, markers = DEFAULT_PROJECT_MARKERS, exists = existsSync) {
  const start = resolve(cwd)
  const wanted = markers.filter((marker) => typeof marker === 'string' && marker.length > 0)
  if (wanted.length === 0) return start
  let current = start
  for (;;) {
    if (wanted.some((marker) => exists(join(current, marker)))) return current
    const parent = dirname(current)
    if (parent === current) return start
    current = parent
  }
}

/**
 * Normalize a configured level.
 * @param {unknown} value - raw level.
 * @returns {'global' | 'project' | 'both'} the accepted level.
 */
export function normalizeLevel(value) {
  return LEVELS.includes(value) ? value : 'both'
}

/**
 * Normalize a configured default scope.
 * @param {unknown} value - raw scope.
 * @returns {'global' | 'project'} the accepted scope.
 */
export function normalizeDefaultScope(value) {
  return SCOPES.includes(value) ? value : 'project'
}

/**
 * Resolve the level a single call addresses.
 *
 * An explicit scope must be both a known scope and enabled for this
 * deployment; an omitted scope falls back to the configured default, or to the
 * only enabled level when that default is disabled.
 * @param {object} input - resolution input.
 * @param {string} [input.requested] - the scope the call asked for, if any.
 * @param {'global' | 'project' | 'both'} input.level - enabled level(s).
 * @param {'global' | 'project'} input.defaultScope - preferred omitted scope.
 * @returns {'global' | 'project'} the scope to use.
 * @throws {NotepadError} when an explicit scope is unknown or disabled.
 */
export function resolveScope({ requested, level, defaultScope }) {
  const enabled = level === 'both' ? [...SCOPES] : [level]
  if (requested === undefined || requested === null || requested === '') {
    return enabled.includes(defaultScope) ? defaultScope : enabled[0]
  }
  if (!SCOPES.includes(requested)) {
    throw new NotepadError(`unknown scope ${JSON.stringify(requested)}: expected one of ${SCOPES.join(', ')}`)
  }
  if (!enabled.includes(requested)) {
    throw new NotepadError(`scope ${JSON.stringify(requested)} is disabled: this notepad exposes ${enabled.join(' + ')} (change \`level\` to enable it)`)
  }
  return requested
}

/**
 * Keep a usable note file name: a bare file name, never a path.
 * @param {unknown} value - configured file name.
 * @returns {string} the accepted file name.
 */
export function normalizeFileName(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length > 0 && !trimmed.includes('/') && !trimmed.includes('\\') && trimmed !== '.' && trimmed !== '..') return trimmed
  }
  return DEFAULT_FILE_NAME
}

/**
 * Accept a non-negative integer count, else a fallback.
 * @param {unknown} value - configured count.
 * @param {number} fallback - value used when the input is not a non-negative integer.
 * @returns {number} the accepted count.
 */
function normalizeCount(value, fallback) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

/**
 * Normalize note tags: trimmed, non-empty, de-duplicated strings.
 * @param {unknown} tags - raw tags.
 * @returns {string[]} the accepted tags.
 */
export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  const seen = new Set()
  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    const trimmed = tag.trim()
    if (trimmed.length > 0) seen.add(trimmed)
  }
  return [...seen]
}

/**
 * Whether a filesystem error means "nothing is stored there yet".
 * @param {unknown} error - a thrown error.
 * @returns {boolean} true for absence errors.
 */
function isAbsent(error) {
  return typeof error === 'object' && error !== null && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/**
 * Coerce one parsed JSON Lines entry into a note, or `undefined` when the line
 * is not a note (a hand-edited or truncated line is skipped, never fatal).
 * @param {unknown} value - parsed line.
 * @param {'global' | 'project'} scope - level the line was read from.
 * @returns {{ id: string, at: string, scope: string, tags: string[], content: string } | undefined} the note.
 */
function toNote(value, scope) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  if (typeof value.content !== 'string') return undefined
  return {
    id: typeof value.id === 'string' ? value.id : '',
    at: typeof value.at === 'string' ? value.at : '',
    scope: typeof value.scope === 'string' ? value.scope : scope,
    tags: normalizeTags(value.tags),
    content: value.content,
  }
}

/**
 * Write chains in flight, keyed by the absolute note file they write.
 *
 * Serialization is per *file*, not per store instance: two `NotepadStore`
 * instances can address the same note file (two session directories inside one
 * project root, a store recreated after cache eviction, …), and a read-modify-write
 * from each of them must not interleave.
 * @type {Map<string, Promise<unknown>>}
 */
const writeChains = new Map()

/**
 * Run one operation as the next writer of `file`.
 * @template T
 * @param {string} file - absolute note file this operation writes.
 * @param {() => Promise<T>} operation - the queued operation.
 * @returns {Promise<T>} the operation's own outcome.
 */
function serializeOn(file, operation) {
  const previous = writeChains.get(file) ?? Promise.resolve()
  const run = previous.then(operation, operation)
  const settled = run.then(() => undefined, () => undefined)
  writeChains.set(file, settled)
  // Drop the chain once it is idle, so the map does not grow without bound.
  void settled.then(() => {
    if (writeChains.get(file) === settled) writeChains.delete(file)
  })
  return run
}

/** One note per line, the on-disk JSON Lines encoding. */
function serializeNotes(notes) {
  return notes.map((note) => `${JSON.stringify(note)}\n`).join('')
}

/** A unique sibling temp path, so concurrent rewriters never share one file. */
let temporarySequence = 0
function temporaryPathFor(file) {
  temporarySequence += 1
  return `${file}.${process.pid}.${temporarySequence.toString(36)}.tmp`
}

/**
 * Replace a note file atomically: write a private temp file, then rename it over
 * the target. The temp name is unique per write, so a second writer cannot
 * consume or clobber it mid-flight.
 * @param {string} file - destination note file.
 * @param {string} content - complete new file content.
 * @returns {Promise<void>} resolves once the rename landed.
 */
async function writeAtomic(file, content) {
  const temporary = temporaryPathFor(file)
  try {
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * One note store over a fixed working directory.
 */
export class NotepadStore {
  /**
   * @param {object} [options] - store configuration.
   * @param {string} [options.cwd] - session working directory (project scope is derived from it).
   * @param {string} [options.dshHome] - harness home override.
   * @param {'global' | 'project' | 'both'} [options.level] - enabled level(s).
   * @param {'global' | 'project'} [options.defaultScope] - scope used when a call omits one.
   * @param {string} [options.globalDir] - global note directory override.
   * @param {string} [options.projectDir] - project note directory override.
   * @param {string} [options.fileName] - note file name inside a level directory.
   * @param {readonly string[]} [options.projectRootMarkers] - project root markers.
   * @param {number} [options.maxNotes] - per-file note cap; 0 disables pruning.
   * @param {number} [options.maxContentLength] - content length cap in characters.
   * @param {number} [options.defaultLimit] - default listing limit.
   */
  constructor(options = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd())
    this.dshHome = resolveDshHome(options.dshHome)
    this.level = normalizeLevel(options.level)
    this.defaultScope = normalizeDefaultScope(options.defaultScope)
    this.fileName = normalizeFileName(options.fileName)
    this.globalDir = options.globalDir ? resolve(expandHomePath(options.globalDir)) : join(this.dshHome, 'notepad')
    this.projectRoot = findProjectRoot(this.cwd, options.projectRootMarkers ?? DEFAULT_PROJECT_MARKERS)
    this.projectDir = options.projectDir ? resolve(expandHomePath(options.projectDir)) : join(this.projectRoot, '.dsh', 'notepad')
    this.maxNotes = normalizeCount(options.maxNotes, DEFAULT_MAX_NOTES)
    this.maxContentLength = normalizeCount(options.maxContentLength, DEFAULT_MAX_CONTENT_LENGTH)
    this.defaultLimit = normalizeCount(options.defaultLimit, DEFAULT_LIST_LIMIT)
    /** @type {number} per-store id sequence. */
    this.sequence = 0
  }

  /** The levels this deployment exposes, in listing order. */
  get scopes() {
    return this.level === 'both' ? [...SCOPES] : [this.level]
  }

  /**
   * The directory holding one level's notes.
   * @param {'global' | 'project'} [scope] - requested level; defaults to the configured default.
   * @returns {string} the absolute directory (not necessarily created yet).
   * @throws {NotepadError} when the scope is unknown or disabled.
   */
  dirFor(scope) {
    const target = resolveScope({ requested: scope, level: this.level, defaultScope: this.defaultScope })
    return target === 'global' ? this.globalDir : this.projectDir
  }

  /**
   * The note file of one level.
   * @param {'global' | 'project'} [scope] - requested level.
   * @returns {string} the absolute note file path.
   */
  fileFor(scope) {
    return join(this.dirFor(scope), this.fileName)
  }

  /**
   * Append one note.
   * @param {object} input - note input.
   * @param {string} input.content - note text; required and non-blank.
   * @param {string[]} [input.tags] - optional tags.
   * @param {'global' | 'project'} [input.scope] - target level.
   * @returns {Promise<{ note: { id: string, at: string, scope: string, tags: string[], content: string }, file: string, total: number, pruned: number }>} the recorded note and its postcondition.
   * @throws {NotepadError} when the content is missing or too long.
   */
  add({ content, tags = [], scope } = {}) {
    const text = typeof content === 'string' ? content.trim() : ''
    if (text.length === 0) throw new NotepadError('content must be a non-blank string')
    if (this.maxContentLength > 0 && text.length > this.maxContentLength) {
      throw new NotepadError(`content is ${text.length} characters; the limit for one note is ${this.maxContentLength}`)
    }
    const target = resolveScope({ requested: scope, level: this.level, defaultScope: this.defaultScope })
    const note = {
      id: this.#nextId(target),
      at: new Date().toISOString(),
      scope: target,
      tags: normalizeTags(tags),
      content: text,
    }
    return serializeOn(this.fileFor(target), async () => {
      const file = this.fileFor(target)
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, `${JSON.stringify(note)}\n`, 'utf8')
      // Pruning already read the file, so it also reports the resulting total:
      // a second read here would parse the whole file again for nothing.
      const { pruned, total } = await this.#prune(target)
      return { note, file, total, pruned }
    })
  }

  /**
   * Read notes, newest first.
   * @param {object} [query] - listing query.
   * @param {'global' | 'project'} [query.scope] - restrict to one level; omitted reads every enabled level.
   * @param {string} [query.query] - case-insensitive substring filter over content, tags, and id.
   * @param {number} [query.limit] - maximum notes returned; `0` means all, omitted uses the configured default.
   * @returns {Promise<{ scopes: string[], total: number, returned: number, truncated: boolean, notes: Array<{ id: string, at: string, scope: string, tags: string[], content: string, file: string }> }>} the listing.
   */
  async list({ scope, query, limit } = {}) {
    const scopes = scope === undefined || scope === null || scope === ''
      ? this.scopes
      : [resolveScope({ requested: scope, level: this.level, defaultScope: this.defaultScope })]
    /** @type {Array<{ id: string, at: string, scope: string, tags: string[], content: string, file: string }>} */
    let notes = []
    for (const target of scopes) {
      const file = this.fileFor(target)
      for (const note of await this.#read(target)) notes.push({ ...note, file })
    }
    const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
    if (needle.length > 0) {
      notes = notes.filter((note) =>
        note.content.toLowerCase().includes(needle)
        || note.id.toLowerCase().includes(needle)
        || note.tags.some((tag) => tag.toLowerCase().includes(needle)))
    }
    notes.reverse()
    notes.sort((left, right) => (left.at === right.at ? 0 : left.at < right.at ? 1 : -1))
    const total = notes.length
    const take = limit === 0 ? total : normalizeCount(limit, this.defaultLimit)
    const picked = notes.slice(0, take)
    return { scopes, total, returned: picked.length, truncated: picked.length < total, notes: picked }
  }

  /**
   * Delete the note file of one level, or of every enabled level.
   * @param {object} [input] - clear input.
   * @param {'global' | 'project'} [input.scope] - level to clear; omitted clears every enabled level.
   * @returns {Promise<{ scopes: string[], removed: number, files: Array<{ scope: string, file: string, removed: number }> }>} the deletion report.
   */
  async clear({ scope } = {}) {
    const scopes = scope === undefined || scope === null || scope === ''
      ? this.scopes
      : [resolveScope({ requested: scope, level: this.level, defaultScope: this.defaultScope })]
    const files = []
    let removed = 0
    // One file lock at a time, released between levels, so no caller ever holds
    // two of them.
    for (const target of scopes) {
      const outcome = await serializeOn(this.fileFor(target), async () => {
        const file = this.fileFor(target)
        const count = (await this.#read(target)).length
        await rm(file, { force: true })
        return { scope: target, file, removed: count }
      })
      files.push(outcome)
      removed += outcome.removed
    }
    return { scopes, removed, files }
  }

  /**
   * Rewrite one note in place, keeping its id and creation time.
   * @param {object} input - edit input.
   * @param {'global' | 'project'} [input.scope] - level holding the note.
   * @param {string} input.id - id of the note to edit.
   * @param {string} [input.content] - replacement text; omitted keeps the current text.
   * @param {string[]} [input.tags] - replacement tags; omitted keeps the current tags.
   * @returns {Promise<{ note: { id: string, at: string, scope: string, tags: string[], content: string, editedAt: string }, file: string, total: number }>} the updated note.
   * @throws {NotepadError} when the id is unknown or the new text is unusable.
   */
  async update({ scope, id, content, tags } = {}) {
    if (typeof id !== 'string' || id.trim().length === 0) throw new NotepadError('id must be a non-blank string')
    const target = resolveScope({ requested: scope, level: this.level, defaultScope: this.defaultScope })
    let replacement
    if (content !== undefined) {
      const text = typeof content === 'string' ? content.trim() : ''
      if (text.length === 0) throw new NotepadError('content must be a non-blank string')
      if (this.maxContentLength > 0 && text.length > this.maxContentLength) {
        throw new NotepadError(`content is ${text.length} characters; the limit for one note is ${this.maxContentLength}`)
      }
      replacement = text
    }
    const nextTags = tags === undefined ? undefined : normalizeTags(tags)
    return serializeOn(this.fileFor(target), async () => {
      const notes = await this.#read(target)
      const index = notes.findIndex((note) => note.id === id)
      if (index < 0) throw new NotepadError(`no note ${JSON.stringify(id)} in the ${target} level`)
      const previous = notes[index]
      const note = {
        ...previous,
        content: replacement ?? previous.content,
        tags: nextTags ?? previous.tags,
        editedAt: new Date().toISOString(),
      }
      notes[index] = note
      const file = await this.#rewrite(target, notes)
      return { note, file, total: notes.length }
    })
  }

  /**
   * Delete one note by id.
   * @param {object} input - delete input.
   * @param {'global' | 'project'} [input.scope] - level holding the note.
   * @param {string} input.id - id of the note to delete.
   * @returns {Promise<{ removed: number, file: string, total: number, note: object | undefined }>} the deletion report.
   */
  async remove({ scope, id } = {}) {
    if (typeof id !== 'string' || id.trim().length === 0) throw new NotepadError('id must be a non-blank string')
    const target = resolveScope({ requested: scope, level: this.level, defaultScope: this.defaultScope })
    return serializeOn(this.fileFor(target), async () => {
      const notes = await this.#read(target)
      const index = notes.findIndex((note) => note.id === id)
      const file = this.fileFor(target)
      if (index < 0) return { removed: 0, file, total: notes.length, note: undefined }
      const [note] = notes.splice(index, 1)
      await this.#rewrite(target, notes)
      return { removed: 1, file, total: notes.length, note }
    })
  }

  /**
   * Atomically rewrite one level's note file.
   * @param {'global' | 'project'} scope - level to write.
   * @param {Array<object>} notes - the complete note list, in file order.
   * @returns {Promise<string>} the written file path.
   */
  async #rewrite(scope, notes) {
    const file = this.fileFor(scope)
    await mkdir(dirname(file), { recursive: true })
    await writeAtomic(file, serializeNotes(notes))
    return file
  }

  /**
   * Read one level's notes in file order (oldest first).
   * @param {'global' | 'project'} scope - level to read.
   * @returns {Promise<Array<{ id: string, at: string, scope: string, tags: string[], content: string }>>} parsed notes.
   */
  async #read(scope) {
    const file = this.fileFor(scope)
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (isAbsent(error)) return []
      throw error
    }
    const notes = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let parsed
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue
      }
      const note = toNote(parsed, scope)
      if (note !== undefined) notes.push(note)
    }
    return notes
  }

  /**
   * Enforce the per-file note cap by rewriting the newest `maxNotes` entries.
   *
   * The file is read exactly once per append: the resulting total is returned
   * alongside the pruned count so the caller need not read it again.
   * @param {'global' | 'project'} scope - level to prune.
   * @returns {Promise<{ pruned: number, total: number }>} notes dropped, and notes kept.
   */
  async #prune(scope) {
    const notes = await this.#read(scope)
    if (this.maxNotes <= 0 || notes.length <= this.maxNotes) return { pruned: 0, total: notes.length }
    const kept = notes.slice(notes.length - this.maxNotes)
    await writeAtomic(this.fileFor(scope), serializeNotes(kept))
    return { pruned: notes.length - kept.length, total: kept.length }
  }

  /**
   * Mint a short, readable, collision-resistant note id.
   * @param {'global' | 'project'} scope - level the note lands in.
   * @returns {string} the new id, for example `p-lx9c2k-01ab3f`.
   */
  #nextId(scope) {
    this.sequence += 1
    const time = Date.now().toString(36)
    const sequence = this.sequence.toString(36).padStart(2, '0')
    const random = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
    return `${scope === 'global' ? 'g' : 'p'}-${time}-${sequence}${random}`
  }
}
