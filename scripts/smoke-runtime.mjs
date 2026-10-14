#!/usr/bin/env node
/**
 * Real-runtime smoke test for the notepad plugin.
 *
 * It mounts the plugin on an actual Cordis `Context` together with the actual
 * `@deepseek-ai/dsh-tools` registry, then drives add → list → clear through the
 * real `ctx.tools.execute` pipeline. That covers what the unit tests cannot:
 * Cordis plugin wiring, `inject`, the tool registry's argument/output schema
 * validation, and dispatch.
 *
 * Run from this repository (the bundled runtime works too):
 *   node scripts/smoke-runtime.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as notepad from '../lib/index.js'

const root = await mkdtemp(join(tmpdir(), 'notepad-smoke-'))
const cwd = join(root, 'project')
const globalDir = join(root, 'global')
/** Minimal Agent stand-in: the notepad plugin reads `agent.session.header.cwd`. */
const agent = { session: { header: { cwd } } }
let sequence = 0

/** Dispatch one call through the real registry and fail loudly on error results. */
async function call(ctx, name, args, { expectError = false } = {}) {
  const result = await ctx.tools.execute({
    callId: `smoke-${++sequence}`,
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })
  if (expectError) {
    assert.equal(result.isError, true, `${name} was expected to fail`)
    return result
  }
  assert.equal(result.isError, false, `${name} failed: ${JSON.stringify(result.content)}`)
  return result
}

try {
  await mkdir(cwd, { recursive: true })
  const ctx = new Context()
  // The real tool registry declares `inject: ['systemPrompt']`, so mount the real
  // prompt service first; the notepad plugin itself is then mounted by name.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(notepad, { globalDir, defaultScope: 'project', projectRootMarkers: [] })

  const schemas = ctx.tools.schemas().map((schema) => schema.name).sort()
  assert.deepEqual(schemas, ['notepad_add', 'notepad_clear', 'notepad_list'])
  console.log(`✓ registered on the live registry: ${schemas.join(', ')}`)

  const added = await call(ctx, 'notepad_add', { content: 'smoke: project note', tags: ['smoke'] })
  assert.equal(added.value.scope, 'project')
  assert.equal(added.value.total, 1)
  assert.equal(added.value.file, join(cwd, '.dsh', 'notepad', 'notes.jsonl'))
  const onDisk = await readFile(added.value.file, 'utf8')
  assert.equal(JSON.parse(onDisk.trim()).content, 'smoke: project note')
  assert.match(added.content[0].text, /Noted p-/)
  console.log(`✓ notepad_add wrote ${added.value.file}`)

  const global = await call(ctx, 'notepad_add', { content: 'smoke: global note', scope: 'global' })
  assert.equal(global.value.file, join(globalDir, 'notes.jsonl'))
  console.log(`✓ notepad_add wrote ${global.value.file}`)

  const listed = await call(ctx, 'notepad_list', {})
  assert.equal(listed.value.total, 2)
  assert.equal(listed.value.notes.length, 2)
  const rendered = listed.content[0].text
  assert.match(rendered, /smoke: project note/)
  assert.match(rendered, /smoke: global note/)
  console.log(`✓ notepad_list returned ${listed.value.total} notes across ${listed.value.scopes.join(' + ')}`)

  const filtered = await call(ctx, 'notepad_list', { scope: 'project', query: 'PROJECT' })
  assert.equal(filtered.value.total, 1)
  console.log('✓ notepad_list filtered by scope and query')

  const refused = await call(ctx, 'notepad_clear', { scope: 'project', confirm: false }, { expectError: true })
  assert.match(refused.error.message, /confirm/)
  console.log('✓ notepad_clear refused without confirm: true')

  const cleared = await call(ctx, 'notepad_clear', { scope: 'project', confirm: true })
  assert.equal(cleared.value.removed, 1)
  assert.match(cleared.content[0].text, /Cleared 1 note/)
  assert.equal((await call(ctx, 'notepad_list', {})).value.total, 1)
  console.log('✓ notepad_clear removed only the project level')

  const unknown = await call(ctx, 'notepad_add', { content: 'x', scope: 'nope' }, { expectError: true })
  assert.equal(unknown.error.info?.code, 'INVALID_ARGS')
  assert.match(unknown.error.message, /"scope" must be one of/)
  console.log('✓ the registry rejects an invalid scope before dispatch')

  await ctx.fiber.dispose()
  console.log('\nnotepad runtime smoke test: PASS')
} finally {
  await rm(root, { recursive: true, force: true })
}
