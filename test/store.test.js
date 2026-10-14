import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  DEFAULT_FILE_NAME,
  DEFAULT_PROJECT_MARKERS,
  NotepadError,
  NotepadStore,
  findProjectRoot,
  normalizeFileName,
  normalizeTags,
  resolveDshHome,
  resolveScope,
} from '../lib/store.js'

/** @type {string} */
let root

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'notepad-store-'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A fresh isolated directory inside the test root. */
async function dir(name) {
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  return path
}

/** Build a store whose two levels point inside that test's own directory. */
function makeStore(projectCwd, overrides = {}) {
  return new NotepadStore({
    cwd: projectCwd,
    level: 'both',
    defaultScope: 'project',
    dshHome: root,
    globalDir: join(projectCwd, '.global'),
    projectRootMarkers: [],
    ...overrides,
  })
}

describe('path resolution', () => {
  it('prefers configured home, then $DSH_HOME, then ~/.dsh', () => {
    const configured = resolveDshHome(join(root, 'custom'), { DSH_HOME: join(root, 'env') })
    assert.equal(configured, resolve(join(root, 'custom')))
    assert.equal(resolveDshHome('', { DSH_HOME: join(root, 'env') }), resolve(join(root, 'env')))
    assert.equal(resolveDshHome('   ', { DSH_HOME: '  ' }), resolve(join(process.env.USERPROFILE ?? process.env.HOME, '.dsh')))
  })

  it('expands a leading tilde', () => {
    const home = process.env.USERPROFILE ?? process.env.HOME
    assert.equal(resolveDshHome('~/.dsh-elsewhere', {}), resolve(join(home, '.dsh-elsewhere')))
  })

  it('walks up to the nearest project root marker', () => {
    const deep = join(root, 'proj', 'a', 'b')
    const seen = []
    const exists = (path) => {
      seen.push(path)
      return path === join(root, 'proj', '.git')
    }
    assert.equal(findProjectRoot(deep, ['.git', '.dsh'], exists), join(root, 'proj'))
    assert.deepEqual(seen[0], join(deep, '.git'))
  })

  it('falls back to cwd when no marker exists anywhere', () => {
    assert.equal(findProjectRoot(join(root, 'lonely'), ['.git'], () => false), resolve(join(root, 'lonely')))
  })

  it('never treats the harness home as a project root by default', async () => {
    assert.equal(DEFAULT_PROJECT_MARKERS.includes('.dsh'), false)
    const home = await dir('fake-home')
    await mkdir(join(home, '.dsh'), { recursive: true })
    const nested = join(home, 'work', 'repo')
    await mkdir(nested, { recursive: true })
    assert.equal(findProjectRoot(nested), resolve(nested))
  })
})

describe('scope configuration', () => {
  it('resolves an omitted scope to the default, or to the only enabled level', () => {
    assert.equal(resolveScope({ level: 'both', defaultScope: 'project' }), 'project')
    assert.equal(resolveScope({ level: 'both', defaultScope: 'global' }), 'global')
    assert.equal(resolveScope({ level: 'global', defaultScope: 'project' }), 'global')
    assert.equal(resolveScope({ requested: 'global', level: 'both', defaultScope: 'project' }), 'global')
  })

  it('rejects an unknown or disabled explicit scope', () => {
    assert.throws(() => resolveScope({ requested: 'nope', level: 'both', defaultScope: 'project' }), NotepadError)
    assert.throws(() => resolveScope({ requested: 'project', level: 'global', defaultScope: 'global' }), /disabled/)
  })

  it('rejects a file name that escapes its level directory', () => {
    assert.equal(normalizeFileName('../notes.jsonl'), DEFAULT_FILE_NAME)
    assert.equal(normalizeFileName('a/b.jsonl'), DEFAULT_FILE_NAME)
    assert.equal(normalizeFileName('notes.md'), 'notes.md')
  })

  it('normalizes tags', () => {
    assert.deepEqual(normalizeTags([' a ', 'a', '', 7, 'b']), ['a', 'b'])
    assert.deepEqual(normalizeTags('nope'), [])
  })
})

describe('NotepadStore', () => {
  it('appends a note to the project level by default', async () => {
    const cwd = await dir('proj-add')
    const store = makeStore(cwd)
    const result = await store.add({ content: 'first', tags: [' a ', 'a'] })
    assert.equal(result.note.scope, 'project')
    assert.equal(result.note.content, 'first')
    assert.deepEqual(result.note.tags, ['a'])
    assert.match(result.note.id, /^p-/)
    assert.equal(result.file, join(cwd, '.dsh', 'notepad', 'notes.jsonl'))
    assert.equal(result.total, 1)
    const raw = await readFile(result.file, 'utf8')
    assert.equal(raw.endsWith('\n'), true)
    assert.deepEqual(JSON.parse(raw.trim()).content, 'first')
  })

  it('appends to the global level when asked', async () => {
    const cwd = await dir('proj-global')
    const store = makeStore(cwd)
    const { note, file } = await store.add({ content: 'shared', scope: 'global' })
    assert.equal(note.scope, 'global')
    assert.match(note.id, /^g-/)
    assert.equal(file, join(cwd, '.global', 'notes.jsonl'))
  })

  it('returns notes newest first, merges levels, filters and limits', async () => {
    const cwd = await dir('proj-list')
    const store = makeStore(cwd)
    await store.add({ content: 'older project note', tags: ['keep'] })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await store.add({ content: 'newer project note' })
    await store.add({ content: 'global note', scope: 'global' })

    const all = await store.list()
    assert.equal(all.total, 3)
    assert.deepEqual(all.scopes, ['global', 'project'])
    assert.equal(all.notes.length, 3)
    assert.equal(all.notes[all.notes.length - 1].content, 'older project note')

    const projectOnly = await store.list({ scope: 'project' })
    assert.equal(projectOnly.total, 2)
    assert.ok(projectOnly.notes.every((note) => note.scope === 'project'))

    const filtered = await store.list({ query: 'GLOBAL' })
    assert.equal(filtered.total, 1)
    assert.equal(filtered.notes[0].content, 'global note')

    const byTag = await store.list({ query: 'keep' })
    assert.equal(byTag.total, 1)
    assert.equal(byTag.notes[0].content, 'older project note')

    const limited = await store.list({ limit: 1 })
    assert.equal(limited.returned, 1)
    assert.equal(limited.truncated, true)
    assert.equal((await store.list({ limit: 0 })).returned, 3)
    assert.equal((await store.list({ limit: 1 })).notes[0].content, 'global note')
  })

  it('survives a hand-edited line', async () => {
    const cwd = await dir('proj-broken')
    const store = makeStore(cwd)
    await store.add({ content: 'good' })
    await writeFile(store.fileFor('project'), 'not json\n{"content":42}\n\n', { flag: 'a' })
    const listed = await store.list()
    assert.equal(listed.total, 1)
  })

  it('rejects blank and oversized notes', async () => {
    const cwd = await dir('proj-invalid')
    const store = makeStore(cwd, { maxContentLength: 10 })
    assert.throws(() => store.add({ content: '   ' }), /non-blank/)
    assert.throws(() => store.add({ content: 'x'.repeat(11) }), /limit for one note/)
    await store.add({ content: 'x'.repeat(10) })
  })

  it('prunes the oldest notes past maxNotes', async () => {
    const cwd = await dir('proj-prune')
    const store = makeStore(cwd, { maxNotes: 3 })
    for (const label of ['n1', 'n2', 'n3', 'n4']) {
      const { pruned } = await store.add({ content: label })
      if (label === 'n4') assert.equal(pruned, 1)
    }
    const listed = await store.list({ limit: 0 })
    assert.equal(listed.total, 3)
    assert.deepEqual(listed.notes.map((note) => note.content), ['n4', 'n3', 'n2'])
  })

  it('does not interleave concurrent appends', async () => {
    const cwd = await dir('proj-concurrent')
    const store = makeStore(cwd)
    await Promise.all(Array.from({ length: 25 }, (_, index) => store.add({ content: `note ${index}` })))
    const raw = await readFile(store.fileFor('project'), 'utf8')
    const lines = raw.split('\n').filter((line) => line.length > 0)
    assert.equal(lines.length, 25)
    for (const line of lines) assert.equal(typeof JSON.parse(line).content, 'string')
    assert.equal((await store.list({ limit: 0 })).total, 25)
  })

  it('clears exactly the requested level', async () => {
    const cwd = await dir('proj-clear')
    const store = makeStore(cwd)
    await store.add({ content: 'project note' })
    await store.add({ content: 'global note', scope: 'global' })
    const report = await store.clear({ scope: 'project' })
    assert.equal(report.removed, 1)
    assert.equal(report.files[0].scope, 'project')
    assert.equal((await store.list({ scope: 'project' })).total, 0)
    assert.equal((await store.list({ scope: 'global' })).total, 1)
    assert.equal((await store.clear({ scope: 'project' })).removed, 0)
    const both = await store.clear()
    assert.equal(both.removed, 1)
    assert.deepEqual(both.scopes, ['global', 'project'])
  })

  it('honors a level restriction and an explicit project directory', async () => {
    const cwd = await dir('proj-level')
    const store = makeStore(cwd, { level: 'global', defaultScope: 'global' })
    assert.equal(store.fileFor(), join(cwd, '.global', 'notes.jsonl'))
    assert.throws(() => store.fileFor('project'), /disabled/)

    const explicit = makeStore(cwd, { projectDir: join(root, 'explicit-project') })
    assert.equal(explicit.fileFor('project'), join(root, 'explicit-project', 'notes.jsonl'))
  })

  it('derives the project root from the nearest marker', async () => {
    const outer = await dir('proj-root')
    await mkdir(join(outer, '.git'), { recursive: true })
    const inner = join(outer, 'packages', 'app')
    await mkdir(inner, { recursive: true })
    const store = new NotepadStore({ cwd: inner, globalDir: join(root, 'global') })
    assert.equal(store.fileFor('project'), join(outer, '.dsh', 'notepad', 'notes.jsonl'))
  })
})
