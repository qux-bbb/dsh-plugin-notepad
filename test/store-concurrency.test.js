/**
 * Cross-instance write serialization.
 *
 * Two `NotepadStore` instances can resolve to the same project note file — for
 * example two session directories (`<repo>` and `<repo>/src`) inside one project
 * root, or a store recreated after the plugin's cache evicted it. Their writes
 * must not interleave: before writes were serialized per note file, both
 * instances shared one `${file}.tmp` name, so a read-modify-write pair lost
 * notes and failed a rename with ENOENT.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { NotepadStore } from '../lib/store.js'

/** @type {string} */
let root

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'notepad-concurrency-'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * One project root holding `count` sibling session directories, plus one store
 * per directory. The `.git` marker makes every directory resolve to that root,
 * so all of the returned stores address one project note file.
 * @param {string} name - test-local directory name.
 * @param {number} count - how many session directories to create.
 * @param {object} [overrides] - extra store options.
 * @returns {Promise<{ projectRoot: string, stores: NotepadStore[] }>} the fixture.
 */
async function project(name, count, overrides = {}) {
  const projectRoot = join(root, name)
  await mkdir(join(projectRoot, '.git'), { recursive: true })
  const stores = []
  for (let index = 0; index < count; index += 1) {
    const cwd = join(projectRoot, `session-${index}`)
    await mkdir(cwd, { recursive: true })
    stores.push(new NotepadStore({ cwd, dshHome: root, projectRootMarkers: ['.git'], ...overrides }))
  }
  return { projectRoot, stores }
}

/** Every non-empty line of a note file, tolerating an absent file. */
async function lines(file) {
  const raw = await readFile(file, 'utf8').catch(() => '')
  return raw.split('\n').filter((line) => line.trim().length > 0)
}

describe('one note file shared by several store instances', () => {
  it('serializes concurrent removals so no note is lost and no rename fails', async () => {
    const { stores } = await project('remove-race', 2)
    const [first, second] = stores
    assert.equal(first.fileFor('project'), second.fileFor('project'))

    const ids = []
    for (let index = 0; index < 20; index += 1) {
      ids.push((await first.add({ content: `note ${index}` })).note.id)
    }

    const outcomes = await Promise.allSettled(
      ids.map((id, index) => (index % 2 === 0 ? first : second).remove({ id })),
    )
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ids.map(() => 'fulfilled'))
    assert.equal((await first.list({ limit: 0 })).total, 0)
    assert.deepEqual(await lines(first.fileFor('project')), [])
  })

  it('keeps the file parseable, complete, and free of temp files under mixed load', async () => {
    const { stores } = await project('mixed-race', 2)
    const [first, second] = stores
    const file = first.fileFor('project')

    const seeded = []
    for (let index = 0; index < 10; index += 1) {
      seeded.push((await first.add({ content: `seed ${index}` })).note.id)
    }

    const writes = []
    for (let index = 0; index < 15; index += 1) {
      writes.push((index % 2 === 0 ? first : second).add({ content: `live ${index}` }))
    }
    for (const id of seeded) writes.push(second.remove({ id }))

    const outcomes = await Promise.allSettled(writes)
    assert.deepEqual([...new Set(outcomes.map((outcome) => outcome.status))], ['fulfilled'])

    const remaining = await lines(file)
    for (const line of remaining) assert.equal(typeof JSON.parse(line).content, 'string')
    assert.equal(remaining.length, 15)
    assert.deepEqual((await readdir(dirname(file))).filter((name) => name.endsWith('.tmp')), [])
  })

  it('still enforces the note cap when several instances append at once', async () => {
    const { stores } = await project('prune-race', 3, { maxNotes: 20 })
    const writes = []
    for (let index = 0; index < 30; index += 1) {
      writes.push(stores[index % stores.length].add({ content: `note ${index}` }))
    }

    const outcomes = await Promise.allSettled(writes)
    assert.deepEqual([...new Set(outcomes.map((outcome) => outcome.status))], ['fulfilled'])

    const listed = await stores[0].list({ limit: 0 })
    assert.equal(listed.total, 20)
    // The cap keeps the newest notes; note 29 must be among them.
    assert.ok(listed.notes.some((note) => note.content === 'note 29'))
    assert.deepEqual((await readdir(dirname(stores[0].fileFor('project')))).filter((name) => name.endsWith('.tmp')), [])
  })

  it('does not lose a clear that races a writer on the same file', async () => {
    const { stores } = await project('clear-race', 2)
    const [first, second] = stores
    for (let index = 0; index < 5; index += 1) await first.add({ content: `note ${index}` })

    const [cleared] = await Promise.all([
      first.clear({ scope: 'project' }),
      second.add({ content: 'after clear' }),
    ])
    assert.equal(cleared.removed, 5)
    // Whichever order the two landed in, the store must agree with the file and
    // the file must stay parseable.
    const remaining = await lines(first.fileFor('project'))
    for (const line of remaining) JSON.parse(line)
    assert.equal((await first.list({ limit: 0 })).total, remaining.length)
  })
})
