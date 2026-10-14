import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { NotepadStore } from '../lib/store.js'

/** @type {string} */
let root

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'notepad-edit-'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A store whose two levels live inside one isolated directory. */
function makeStore(name, overrides = {}) {
  const cwd = join(root, name)
  return {
    cwd,
    store: new NotepadStore({
      cwd,
      level: 'both',
      defaultScope: 'project',
      dshHome: root,
      globalDir: join(cwd, '.global'),
      projectRootMarkers: [],
      ...overrides,
    }),
  }
}

describe('NotepadStore.update', () => {
  it('replaces the text in place, keeping id and creation time', async () => {
    const { store } = makeStore('update-basic')
    const { note, file } = await store.add({ content: 'before', tags: ['a'] })
    const edited = await store.update({ id: note.id, content: 'after', tags: ['b', 'c'] })
    assert.equal(edited.note.id, note.id)
    assert.equal(edited.note.at, note.at)
    assert.equal(edited.note.content, 'after')
    assert.deepEqual(edited.note.tags, ['b', 'c'])
    assert.equal(typeof edited.note.editedAt, 'string')
    assert.equal(edited.total, 1)

    const listed = await store.list({ limit: 0 })
    assert.equal(listed.total, 1)
    assert.equal(listed.notes[0].content, 'after')
    const raw = await readFile(file, 'utf8')
    assert.equal(raw.trim().split('\n').length, 1)
  })

  it('keeps the fields the caller omitted', async () => {
    const { store } = makeStore('update-partial')
    const { note } = await store.add({ content: 'text stays', tags: ['keep'] })
    const tagsOnly = await store.update({ id: note.id, tags: ['changed'] })
    assert.equal(tagsOnly.note.content, 'text stays')
    assert.deepEqual(tagsOnly.note.tags, ['changed'])
    const textOnly = await store.update({ id: note.id, content: 'text changed' })
    assert.equal(textOnly.note.content, 'text changed')
    assert.deepEqual(textOnly.note.tags, ['changed'])
  })

  it('edits only the requested level', async () => {
    const { store } = makeStore('update-levels')
    const project = await store.add({ content: 'project note' })
    const global = await store.add({ content: 'global note', scope: 'global' })
    await store.update({ id: project.note.id, content: 'project edited' })
    const listed = await store.list({ limit: 0 })
    assert.equal(listed.notes.find((note) => note.id === global.note.id).content, 'global note')
    assert.equal(listed.notes.find((note) => note.id === project.note.id).content, 'project edited')
  })

  it('rejects an unknown id, a blank body, and an oversized body', async () => {
    const { store } = makeStore('update-invalid', { maxContentLength: 10 })
    const { note } = await store.add({ content: 'ok' })
    await assert.rejects(() => store.update({ id: 'nope', content: 'x' }), /no note/)
    await assert.rejects(() => store.update({ id: note.id, content: '   ' }), /non-blank/)
    await assert.rejects(() => store.update({ id: note.id, content: 'x'.repeat(11) }), /limit for one note/)
    await assert.rejects(() => store.update({ content: 'x' }), /id must be/)
    assert.equal((await store.list({ limit: 0 })).notes[0].content, 'ok')
  })

  it('rejects a disabled level', async () => {
    const { store } = makeStore('update-disabled', { level: 'global', defaultScope: 'global' })
    const { note } = await store.add({ content: 'global only' })
    await assert.rejects(() => store.update({ id: note.id, content: 'x', scope: 'project' }), /disabled/)
  })
})

describe('NotepadStore.remove', () => {
  it('deletes exactly one note and leaves the rest in order', async () => {
    const { store } = makeStore('remove-basic')
    const first = await store.add({ content: 'one' })
    const second = await store.add({ content: 'two' })
    const third = await store.add({ content: 'three' })
    const report = await store.remove({ id: second.note.id })
    assert.equal(report.removed, 1)
    assert.equal(report.total, 2)
    assert.equal(report.note.content, 'two')
    const listed = await store.list({ limit: 0 })
    assert.deepEqual(listed.notes.map((note) => note.content), ['three', 'one'])
    assert.ok(first.note.id !== third.note.id)
  })

  it('reports a miss without touching the file', async () => {
    const { store } = makeStore('remove-miss')
    await store.add({ content: 'stays' })
    const report = await store.remove({ id: 'missing' })
    assert.equal(report.removed, 0)
    assert.equal(report.note, undefined)
    assert.equal((await store.list({ limit: 0 })).total, 1)
  })

  it('removes a global note independently of the project level', async () => {
    const { store } = makeStore('remove-scope')
    const project = await store.add({ content: 'project' })
    const global = await store.add({ content: 'global', scope: 'global' })
    assert.equal((await store.remove({ id: global.note.id, scope: 'global' })).removed, 1)
    assert.equal((await store.list({ scope: 'global' })).total, 0)
    assert.equal((await store.list({ scope: 'project' })).total, 1)
    assert.equal((await store.remove({ id: project.note.id })).removed, 1)
    await assert.rejects(() => store.remove({}), /id must be/)
  })

  it('is serialized against concurrent appends', async () => {
    const { store } = makeStore('remove-concurrent')
    const first = await store.add({ content: 'seed' })
    await Promise.all([
      store.remove({ id: first.note.id }),
      store.add({ content: 'a' }),
      store.add({ content: 'b' }),
    ])
    const listed = await store.list({ limit: 0 })
    assert.equal(listed.total, 2)
    assert.deepEqual([...listed.notes.map((note) => note.content)].sort(), ['a', 'b'])
  })
})
