/**
 * The bounded write under the deployment's real observation policy.
 *
 * The policy that decides a write — a file must have been read first, and an observed version must still
 * hold — runs on this path through the same `fs/write-intent` waterfall the shipped write fires, so these
 * cases are the policy's own answers rather than this host's substitute for them.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionToken, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import {
  installSourceSessionAccess,
  type ForkEnforcementFs,
  type SourceSessionAccessInstallation,
} from '../src/host/fork-enforcement.ts'
import type { ForkToolExecution } from '../src/host/fork-tool-guard.ts'
import { executeOneTool } from './tool-call.ts'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'

const testToolSignal = new AbortController().signal
const session = 'session-shared'

let tree: string
let root: string
let ctx: Context
let scope: Scope
/** The shared Session's own scope key, which the replacements are registered against. */
let scopeKey: object
let shared: Agent
let access: SourceSessionAccessInstallation | undefined
let calls = 0

/** The host's own argument reader: the shipped filesystem tools name their path `file_path`. */
function describeTool(execution: ForkToolExecution) {
  const args = execution.arguments
  const path = typeof args === 'object' && args !== null && 'file_path' in args
    ? (args as { readonly file_path?: unknown }).file_path
    : undefined
  return typeof path === 'string'
    ? { paths: [path], noFileEffect: false }
    : { paths: undefined, noFileEffect: false }
}

/** A session-scoped Agent stand-in the real tool runtime can drive without an AgentLoop. */
function standInAgent(id: SessionId, cwd: string): Omit<Agent, 'ctx'> {
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false,
  })
  const unsupported = (): never => { throw new Error('this test Agent does not support Inbox mutations') }
  return {
    id,
    options: {},
    model: { current: () => undefined, select: () => {} },
    session,
    inbox: {
      nextTurn: [], nextStep: [], clear: unsupported, append: unsupported,
      prepend: unsupported, replace: unsupported, remove: unsupported, splice: unsupported,
    },
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: task => task(new AbortController().signal),
  }
}

beforeEach(async () => {
  tree = mkdtempSync(join(tmpdir(), 'liveshare-observe-'))
  root = join(tree, 'workspace')
  writeFileSync(join(tree, 'kept.txt'), '')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'file.txt'), 'original\n')

  ctx = new Context()
  provideWorkingDirectoryFixture(ctx, root)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)

  const key = standInAgent(SessionId(session), root)
  let minted: Scope | undefined
  await ctx.plugin(Object.assign(
    (inner: Context) => { minted = createScope(inner, key) },
    { inject: ['tools', 'fs', 'systemPrompt'] },
  ))
  if (minted === undefined) throw new Error('the shared Session scope was not minted')
  scope = minted
  scopeKey = key
  shared = Object.assign(key, { ctx: scope.ctx })
  access = await install(ctx.fs)
  expect(access.readConfined).toBe(true)
})

/** Install the source-session access layer over one filesystem view of the shared Session. */
async function install(over: ForkEnforcementFs): Promise<SourceSessionAccessInstallation> {
  return installSourceSessionAccess({
    sessionId: session,
    context: scope.ctx,
    scope: scopeKey,
    grantedRoot: await ctx.fs.resolve(root),
    cwd: root,
    resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: shared.session.id }),
    fs: over,
    tools: ctx.tools,
    describe: describeTool,
    write: { mayWrite: () => true },
  })
}

afterEach(async () => {
  try {
    access?.dispose()
    await scope.dispose()
    await ctx.fiber.dispose()
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})

/** Run one tool as a turn of the shared Session. */
function call(name: string, args: unknown) {
  calls += 1
  return executeOneTool(ctx, {
    signal: testToolSignal,
    callId: ToolCallId(`observe-${String(calls)}`),
    name,
    arguments: args,
    agent: shared,
  })
}

const text = (result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string =>
  result.content.filter(block => block.type === 'text').map(block => block.text).join('')

describe('bounded write under the observation policy', () => {
  it('refuses a write to a file this caller never read', async () => {
    const result = await call('write', { file_path: join(root, 'file.txt'), content: 'viewer\n' })

    expect(result.isError).toBe(true)
    // The policy expresses "never read" as `createIfAbsent`, which the provider refuses for a file that is
    // already there.
    expect(text(result)).toMatch(/without reading it first/u)
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('original\n')
  })

  it('allows the write once the caller has read the file', async () => {
    const read = await call('read', { file_path: join(root, 'file.txt') })
    expect(read.isError).toBe(false)

    const result = await call('write', { file_path: join(root, 'file.txt'), content: 'viewer\n' })

    expect(result.isError).toBe(false)
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('viewer\n')
  })

  it('confines a turn of the owner while the layer is installed', async () => {
    // The sandbox belongs to the Session, so a turn no viewer started reads and writes through the same
    // bounded path. Disposing the layer is what restores the deployment's own tools.
    expect(access?.readConfined).toBe(true)
    const path = join(root, 'file.txt')
    const outside = join(dirname(root), 'owner-outside.txt')

    const read = await call('read', { file_path: path })
    expect(read.isError).toBe(false)
    const write = await call('write', { file_path: path, content: 'owner\n' })
    expect(write.isError).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('owner\n')
    const outsideWrite = await call('write', { file_path: outside, content: 'owner\n' })
    expect(outsideWrite.isError).toBe(true)
    expect(existsSync(outside)).toBe(false)

    access?.dispose()
    access = undefined
    const restored = await call('write', { file_path: outside, content: 'owner\n' })
    expect(restored.isError).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('owner\n')
  })

  it('takes the version its own write published as the basis of the next one', async () => {
    const read = await call('read', { file_path: join(root, 'file.txt') })
    expect(read.isError).toBe(false)
    const first = await call('write', { file_path: join(root, 'file.txt'), content: 'first\n' })
    expect(first.isError).toBe(false)

    // The second write has no read of its own in between: the version the first one published is what
    // this caller observed, exactly as the shipped write records it.
    const second = await call('write', { file_path: join(root, 'file.txt'), content: 'second\n' })

    expect(second.isError).toBe(false)
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('second\n')
  })

  it('refuses a write whose observed version no longer holds', async () => {
    const read = await call('read', { file_path: join(root, 'file.txt') })
    expect(read.isError).toBe(false)
    // Another writer changes the file directly, as a concurrent owner write would.
    const target = await ctx.fs.resolve(join(root, 'file.txt'))
    await ctx.fs.writeText(target, 'someone else\n')

    const result = await call('write', { file_path: join(root, 'file.txt'), content: 'viewer\n' })

    expect(result.isError).toBe(true)
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('someone else\n')
  })

  it('records absence for a target the grant confirms is missing, so a later write creates it', async () => {
    const path = join(root, 'file.txt')
    expect((await call('read', { file_path: path })).isError).toBe(false)
    // The file goes away, as an owner's own tool or another process could leave it.
    rmSync(path)

    const missing = await call('read', { file_path: path })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toMatch(/not found/u)

    // The miss is the caller's own observation, exactly as the shipped read records it, so the create that
    // follows is a create rather than a stale replacement.
    const created = await call('write', { file_path: path, content: 'recreated\n' })
    expect(created.isError).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('recreated\n')
  })

  it('claims no absence once a granted parent is replaced by a link to an outside directory', async () => {
    // The parent the grant authorizes is replaced by a link, and the outside directory holds a file of the
    // requested name: a lookup that followed the path would be asking about that other tree entirely.
    const parent = join(root, 'sub')
    const held = join(root, 'held')
    const outside = join(tree, 'outside')
    mkdirSync(parent)
    mkdirSync(outside)
    writeFileSync(join(outside, 'theirs.txt'), 'theirs\n')
    renameSync(parent, held)
    symlinkSync(outside, parent)

    const read = await call('read', { file_path: join(parent, 'theirs.txt') })
    expect(read.isError).toBe(true)
    // The refusal names confinement, not absence: the grant never confirmed anything about that target.
    expect(text(read)).toMatch(/not inside the workspace/iu)
    expect(text(read)).not.toMatch(/not found/iu)

    const write = await call('write', { file_path: join(parent, 'theirs.txt'), content: 'viewer\n' })
    expect(write.isError).toBe(true)
    expect(readFileSync(join(outside, 'theirs.txt'), 'utf8')).toBe('theirs\n')
  })

  it('records no absence for a missing target outside the granted workspace', async () => {
    const outside = join(dirname(root), 'absent-outside.txt')

    const missing = await call('read', { file_path: outside })
    expect(missing.isError).toBe(true)
    // Nothing about that path was observed, so a write there is refused rather than treated as a create
    // the grant would authorize.
    const created = await call('write', { file_path: outside, content: 'viewer\n' })
    expect(created.isError).toBe(true)
    expect(existsSync(outside)).toBe(false)
  })

  it('refuses a write outside the granted workspace whatever the policy says', async () => {
    const outside = join(dirname(root), 'outside.txt')
    writeFileSync(outside, 'owner\n')

    const result = await call('write', { file_path: outside, content: 'viewer\n' })

    expect(result.isError).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('owner\n')
  })

  it('refuses an outside target with an error identified by the FS_SANDBOX_DENIED code', async () => {
    const outside = join(dirname(root), 'outside.txt')
    writeFileSync(outside, 'owner\n')
    const callId = ToolCallId('observe-direct')
    const run = (name: string, args: Record<string, string>): Promise<unknown> => {
      const replacement = scope.ctx.tools.get(name, scopeKey)
      if (replacement === undefined) throw new Error(`the shared Session has no ${name} tool`)
      const exec: ToolRunContext = {
        callId, rootCallId: callId, name, arguments: args, agent: shared, signal: testToolSignal,
        token: Symbol(name) as ToolExecutionToken, deferContext: () => {}, concludeTurn: () => {},
      }
      return replacement.execute(args, exec)
    }

    const read = run('read', { file_path: outside })
    await expect(read).rejects.toThrow(/not inside the workspace/u)
    await expect(read).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(run('write', { file_path: outside, content: 'viewer\n' })).rejects.toMatchObject({
      code: 'FS_SANDBOX_DENIED',
    })
    expect(readFileSync(outside, 'utf8')).toBe('owner\n')
  })
})
