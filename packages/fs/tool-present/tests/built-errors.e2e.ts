/** Built tool and runtime bundles must preserve their shared structured error classes. */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const bundle = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const execFileAsync = promisify(execFile)
const probe = String.raw`
import assert from 'node:assert/strict'
import { Context } from './vendor/cordis/lib/index.js'
import AgentRegistry from './packages/core/agent/lib/index.js'
import LocalFileSystem from './packages/fs/fs-local/lib/index.js'
import SystemPrompt from './packages/core/system-prompt/lib/index.js'
import ToolRuntime from './packages/core/tools/lib/index.js'
import { Session, SESSION_FORMAT_VERSION } from './packages/core/session/lib/index.js'
import * as Present from './packages/fs/tool-present/lib/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = await mkdtemp(join(tmpdir(), 'present-built-'))
const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  ctx.provide('sessionProjections', { stateOf() { return { openTurnStartSeq: 1, lastTurn: 1 } } })
  await ctx.plugin(Present, { maxFiles: 2 })
  const scope = ctx.plugin(() => {})
  const session = Session.create('built-present', [], { version: SESSION_FORMAT_VERSION, id: 'built-present', createdAt: 0, cwd: root, isSeeded: false })
  const owner = { id: 'built-present', session, ctx: scope.ctx, options: {}, status: 'idle' }
  await ctx.agents.register(owner)
  const events = []
  ctx.on('tools/result', (_exec, result) => events.push(result))
  let n = 0
  for (const [files, code] of [[[{ path: 'missing' }], 'FS_NOT_FOUND'], [[{ path: 42 }], 'INVALID_ARGS']]) {
    const result = await ctx.tools.execute({ signal: new AbortController().signal, name: 'present', callId: 'call-' + (++n), arguments: { files }, agent: owner })
    assert.equal(result.isError, true)
    assert.equal(result.error.info.code, code)
    assert.equal(events.at(-1).error.info.code, code)
    console.log('built ToolRuntime result preserved ' + code)
  }
} finally {
  try { await ctx.fiber.dispose() }
  finally { await rm(root, { recursive: true, force: true }) }
}
`

it.skipIf(!existsSync(bundle))('preserves present error codes through built ToolRuntime results', { retry: 0 }, async ({ signal }) => {
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', probe], { cwd: repoRoot, signal })
  expect(stdout.trim().split('\n')).toEqual([
    'built ToolRuntime result preserved FS_NOT_FOUND',
    'built ToolRuntime result preserved INVALID_ARGS',
  ])
})
