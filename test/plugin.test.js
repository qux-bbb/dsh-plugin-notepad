import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Config, apply, listProjects, renderNotes, resolveOptions } from '../lib/index.js'

/** @type {string} */
let root

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'notepad-plugin-'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * Build a minimal Cordis-like context that records what the plugin registers.
 * @param {{ withCommands?: boolean, withWebServer?: boolean }} [options] - stub shape.
 */
function makeContext({ withCommands = true, withWebServer = true } = {}) {
  const tools = new Map()
  const commands = []
  const effects = []
  const routes = []
  const injected = []
  const commandService = {
    register(definition) {
      commands.push(definition)
      return () => commands.splice(commands.indexOf(definition), 1)
    },
  }
  const webServer = {
    register(route) {
      routes.push(route)
      return () => routes.splice(routes.indexOf(route), 1)
    },
  }
  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    get(name) {
      if (name === 'commands') return withCommands ? commandService : undefined
      if (name === 'webServer') return withWebServer ? webServer : undefined
      return undefined
    },
    // Cordis runs the callback only once every injected service is available.
    inject(deps, callback) {
      injected.push(deps)
      if (!deps.includes('webServer') || withWebServer) callback(ctx)
      return () => {}
    },
    effect(callback, label) {
      effects.push({ label, dispose: callback() })
      return () => {}
    },
    logger: { info() {}, warn() {} },
    webServer,
  }
  return { ctx, tools, commands, effects, routes, injected }
}

/** A tool execution context for one session working directory. */
function exec(cwd) {
  return { agent: { session: { header: { cwd } } }, signal: new AbortController().signal }
}

describe('Config schema', () => {
  it('applies defaults', () => {
    const value = Config({})
    assert.equal(value.level, 'both')
    assert.equal(value.defaultScope, 'project')
    assert.equal(value.fileName, 'notes.jsonl')
    assert.equal(value.enableCommand, true)
    assert.equal(value.maxNotes, 1000)
    assert.deepEqual(value.projectRootMarkers, ['.git', '.hg', '.svn'])
  })

  it('rejects an invalid enum value', () => {
    assert.throws(() => Config({ level: 'everywhere' }), /expected "global"/)
    assert.throws(() => Config({ defaultScope: 'both' }), /expected "global"/)
  })
})

describe('resolveOptions', () => {
  it('mirrors schema defaults for a plain config object', () => {
    const options = resolveOptions()
    assert.equal(options.level, 'both')
    assert.equal(options.defaultScope, 'project')
    assert.equal(options.toolPrefix, 'notepad')
    assert.equal(options.enableCommand, true)
    assert.equal(options.maxContentLength, 4000)
  })

  it('accepts overrides and repairs an unusable tool prefix', () => {
    const options = resolveOptions({ level: 'global', defaultScope: 'global', toolPrefix: 'Not a Name', maxNotes: 5 })
    assert.equal(options.level, 'global')
    assert.equal(options.defaultScope, 'global')
    assert.equal(options.toolPrefix, 'notepad')
    assert.equal(options.maxNotes, 5)
  })
})

describe('apply', () => {
  it('registers the three notepad tools', () => {
    const { ctx, tools } = makeContext()
    apply(ctx, {})
    assert.deepEqual([...tools.keys()].sort(), ['notepad_add', 'notepad_clear', 'notepad_list'])
    const add = tools.get('notepad_add')
    assert.equal(add.parameters.properties.content.type, 'string')
    assert.deepEqual(add.parameters.required, ['content'])
    assert.deepEqual(add.parameters.properties.scope.enum, ['global', 'project'])
    assert.deepEqual(tools.get('notepad_clear').parameters.required, ['scope', 'confirm'])
    assert.match(add.description, /global|project/)
  })

  it('honors a custom tool prefix', () => {
    const { ctx, tools } = makeContext()
    apply(ctx, { toolPrefix: 'memo' })
    assert.deepEqual([...tools.keys()].sort(), ['memo_add', 'memo_clear', 'memo_list'])
  })

  it('adds, lists, and clears notes through the registered tools', async () => {
    const { ctx, tools } = makeContext()
    const cwd = join(root, 'roundtrip')
    apply(ctx, { globalDir: join(cwd, '.global'), dshHome: root, projectRootMarkers: [] })
    const add = tools.get('notepad_add')
    const list = tools.get('notepad_list')
    const clear = tools.get('notepad_clear')

    const first = await add.execute({ content: 'remember the milk', tags: ['errand'] }, exec(cwd))
    assert.equal(first.scope, 'project')
    assert.equal(first.total, 1)
    assert.equal(first.file, join(cwd, '.dsh', 'notepad', 'notes.jsonl'))
    assert.match(add.output.render({ content: 'x' }, first)[0].text, new RegExp(first.id))

    const second = await add.execute({ content: 'global fact', scope: 'global' }, exec(cwd))
    assert.equal(second.scope, 'global')

    const all = await list.execute({}, exec(cwd))
    assert.equal(all.total, 2)
    assert.equal(all.notes.length, 2)
    assert.match(list.output.render({}, all)[0].text, /global fact/)

    const onlyProject = await list.execute({ scope: 'project' }, exec(cwd))
    assert.equal(onlyProject.total, 1)

    const filtered = await list.execute({ query: 'MILK' }, exec(cwd))
    assert.equal(filtered.total, 1)
    assert.equal(filtered.notes[0].content, 'remember the milk')

    await assert.rejects(() => clear.execute({ scope: 'project', confirm: false }, exec(cwd)), /confirm/)
    const cleared = await clear.execute({ scope: 'project', confirm: true }, exec(cwd))
    assert.equal(cleared.removed, 1)
    assert.match(clear.output.render({}, cleared)[0].text, /Cleared 1 note/)
    assert.equal((await list.execute({}, exec(cwd))).total, 1)
  })

  it('rejects a disabled level', async () => {
    const { ctx, tools } = makeContext()
    apply(ctx, { level: 'global', defaultScope: 'global', globalDir: join(root, 'global-only'), projectRootMarkers: [] })
    await assert.rejects(
      () => tools.get('notepad_add').execute({ content: 'nope', scope: 'project' }, exec(join(root, 'disabled'))),
      /disabled/,
    )
    const added = await tools.get('notepad_add').execute({ content: 'works' }, exec(join(root, 'disabled')))
    assert.equal(added.scope, 'global')
  })

  it('registers the /note command, and can be disabled', async () => {
    const enabled = makeContext()
    apply(enabled.ctx, { globalDir: join(root, 'note-command-global'), dshHome: root, projectRootMarkers: [] })
    assert.equal(enabled.commands.length, 1)
    assert.equal(enabled.commands[0].name, 'note')
    assert.deepEqual(enabled.effects.map((effect) => effect.label), ['notepad /note command', 'notepad api route'])

    const invocation = { agent: { session: { header: { cwd: join(root, 'command') } } }, rawInput: 'from the command line' }
    const added = await enabled.commands[0].handler(invocation)
    assert.equal(added.kind, 'success')
    assert.match(added.text, /Noted p-/)
    const listed = await enabled.commands[0].handler({ ...invocation, rawInput: '  ' })
    assert.match(listed.text, /from the command line/)

    const disabled = makeContext()
    apply(disabled.ctx, { enableCommand: false })
    assert.equal(disabled.commands.length, 0)

    const withoutRegistry = makeContext({ withCommands: false })
    apply(withoutRegistry.ctx, {})
    assert.equal(withoutRegistry.commands.length, 0)
    assert.equal(withoutRegistry.tools.size, 3)
  })

  it('keeps a store per working directory', async () => {
    const { ctx, tools } = makeContext()
    apply(ctx, { globalDir: join(root, 'per-cwd-global'), dshHome: root, projectRootMarkers: [] })
    const add = tools.get('notepad_add')
    const list = tools.get('notepad_list')
    await add.execute({ content: 'in one project' }, exec(join(root, 'proj-a')))
    await add.execute({ content: 'in another project' }, exec(join(root, 'proj-b')))
    assert.equal((await list.execute({ scope: 'project' }, exec(join(root, 'proj-a')))).total, 1)
    assert.equal((await list.execute({ scope: 'project' }, exec(join(root, 'proj-b')))).total, 1)
  })

  it('serializes concurrent tool calls from two sessions inside one project', async () => {
    const { ctx, tools } = makeContext()
    const projectRoot = join(root, 'shared-project')
    const inner = join(projectRoot, 'src')
    await mkdir(join(projectRoot, '.git'), { recursive: true })
    await mkdir(inner, { recursive: true })
    // `maxNotes` makes every append rewrite the file, which is where two stores
    // over one project file used to collide on a shared `${file}.tmp`.
    apply(ctx, { dshHome: root, projectRootMarkers: ['.git'], maxNotes: 10 })
    const add = tools.get('notepad_add')
    const list = tools.get('notepad_list')

    const outcomes = await Promise.allSettled(
      Array.from({ length: 30 }, (_, index) => add.execute(
        { content: `note ${index}` },
        exec(index % 2 === 0 ? projectRoot : inner),
      )),
    )
    assert.deepEqual([...new Set(outcomes.map((outcome) => outcome.status))], ['fulfilled'])
    assert.equal((await list.execute({ scope: 'project' }, exec(projectRoot))).total, 10)
    assert.equal((await list.execute({ scope: 'project' }, exec(inner))).total, 10)
  })

  it('evicts the oldest cached store past the cache limit without losing notes', async () => {
    const { ctx, tools } = makeContext()
    apply(ctx, { globalDir: join(root, 'evict-global'), dshHome: root, projectRootMarkers: [] })
    const add = tools.get('notepad_add')
    const list = tools.get('notepad_list')
    // More directories than the cache holds: each one is written once, then the
    // oldest is evicted and must be re-created from disk on the next read.
    const directories = Array.from({ length: 40 }, (_, index) => join(root, 'evict', `cwd-${index}`))
    for (const [index, cwd] of directories.entries()) {
      await add.execute({ content: `note ${index}` }, exec(cwd))
    }
    for (const [index, cwd] of directories.entries()) {
      const listed = await list.execute({ scope: 'project' }, exec(cwd))
      assert.equal(listed.total, 1)
      assert.equal(listed.notes[0].content, `note ${index}`)
    }
  })

  it('mounts the panel route only when a Web server exists', () => {
    const withServer = makeContext()
    apply(withServer.ctx, {})
    assert.deepEqual(withServer.injected, [['webServer']])
    assert.equal(withServer.routes.length, 1)
    assert.equal(withServer.routes[0].kind, 'prefix')
    assert.equal(withServer.routes[0].path, '/api/notepad')
    assert.equal(typeof withServer.routes[0].handler, 'function')

    const withoutServer = makeContext({ withWebServer: false })
    apply(withoutServer.ctx, {})
    assert.equal(withoutServer.routes.length, 0)
    assert.equal(withoutServer.tools.size, 3)
  })
})

describe('listProjects', () => {
  it('lists registered workspaces most recently updated first', () => {
    const registry = {
      list: () => [
        { path: 'D:\\work\\old', title: 'old', updatedAt: '2026-01-01T00:00:00.000Z' },
        { path: 'D:\\work\\new', title: 'new', updatedAt: '2026-10-01T00:00:00.000Z' },
        { path: 'D:\\work\\mid', title: 'mid', updatedAt: '2026-05-01T00:00:00.000Z' },
      ],
    }
    const projects = listProjects({ get: (name) => (name === 'workspaceRegistry' ? registry : undefined) })
    assert.deepEqual(projects.map((entry) => entry.title), ['new', 'mid', 'old'])
    // Only the fields the panel needs cross the API.
    assert.deepEqual(Object.keys(projects[0]).sort(), ['path', 'title'])
  })

  it('degrades to an empty list without a usable registry', () => {
    assert.deepEqual(listProjects({ get: () => undefined }), [])
    assert.deepEqual(listProjects({ get: () => ({ list: 42 }) }), [])
    assert.deepEqual(listProjects({ get: () => ({ list() { throw new Error('registry offline') } }) }), [])
    assert.deepEqual(listProjects({}), [])
  })
})

describe('renderNotes', () => {
  it('renders an empty and a truncated listing', () => {
    assert.equal(renderNotes([], 0), 'No notes yet.')
    const notes = [{ id: 'p-1', at: '2026-01-01T00:00:00.000Z', scope: 'project', content: 'hello' }]
    assert.match(renderNotes(notes, 3), /1\. \[p-1\] 2026-01-01T00:00:00\.000Z \(project\) hello/)
    assert.match(renderNotes(notes, 3), /2 older note\(s\) not shown/)
  })
})
