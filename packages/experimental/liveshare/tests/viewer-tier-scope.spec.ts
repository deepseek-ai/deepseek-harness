/**
 * What a shared Session may reach while its sandbox is mounted.
 *
 * The sandbox confines the turns a share viewer starts: those read through the confined replacement, and
 * a write-tier Session adds the bounded write this host installs. Everything the grant does not contain is
 * refused on the way in — a read outside the workspace, the write name at the view tier, and any tool that
 * is neither replacement — which is what keeps "may drive this Session" from meaning "may run anything".
 * The owner's own turns keep the deployment's tools until the layer is released.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import {
  installSourceSessionAccess,
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
  const agentSession = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false,
  })
  const unsupported = (): never => { throw new Error('this test Agent does not support Inbox mutations') }
  return {
    id,
    options: {},
    model: { current: () => undefined, select: () => {} },
    session: agentSession,
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

/**
 * Install the source-session access layer for one tier.
 * @param tier - `view` installs the confined read alone, `write` adds this host's bounded write.
 * @param grantedRoot - Root the grant contains.
 * @returns The installation.
 */
async function install(
  tier: 'view' | 'write',
  grantedRoot: FsTarget,
  confined: () => boolean = () => true,
): Promise<SourceSessionAccessInstallation> {
  return installSourceSessionAccess({
    sessionId: session,
    context: scope.ctx,
    scope: shared,
    grantedRoot,
    cwd: root,
    resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: shared.session.id }),
    fs: ctx.fs,
    tools: ctx.tools,
    describe: describeTool,
    confinedExecution: confined,
    ...(tier === 'write' ? { write: { mayWrite: () => true } } : {}),
  })
}

beforeEach(async () => {
  tree = mkdtempSync(join(tmpdir(), 'liveshare-tier-'))
  root = join(tree, 'workspace')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'inside.txt'), 'inside\n')
  writeFileSync(join(tree, 'outside.txt'), 'outside\n')

  ctx = new Context()
  provideWorkingDirectoryFixture(ctx, root)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(ToolFs)

  const key = standInAgent(SessionId(session), root)
  let minted: Scope | undefined
  await ctx.plugin(Object.assign(
    (inner: Context) => { minted = createScope(inner, key) },
    { inject: ['tools', 'fs', 'systemPrompt'] },
  ))
  if (minted === undefined) throw new Error('the shared Session scope was not minted')
  scope = minted
  shared = Object.assign(key, { ctx: scope.ctx })
})

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
    callId: ToolCallId(`tier-${String(calls)}`),
    name,
    arguments: args,
    agent: shared,
  })
}

const text = (result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string =>
  result.content.filter(block => block.type === 'text').map(block => block.text).join('')

describe('viewer tier scope', () => {
  it('drives the shared Session at the view tier, and refuses a read outside the granted workspace', async () => {
    access = await install('view', await ctx.fs.resolve(root))
    expect(access.readConfined).toBe(true)
    expect(access.writeConfined).toBe(false)

    // Inside the grant the turn reads, which is what "drives the loop" means for this tier.
    const inside = await call('read', { file_path: join(root, 'inside.txt') })
    expect(inside.isError).toBe(false)
    expect(text(inside)).toContain('inside')

    // Outside it the read is refused, in the workspace it was granted.
    const outside = await call('read', { file_path: join(tree, 'outside.txt') })
    expect(outside.isError).toBe(true)
    expect(text(outside)).toMatch(/not inside the workspace this session was granted/u)
  })

  it('refuses the write name at the view tier, and every other tool with it', async () => {
    access = await install('view', await ctx.fs.resolve(root))

    const write = await call('write', { file_path: join(root, 'inside.txt'), content: 'viewer\n' })
    expect(write.isError).toBe(true)
    expect(text(write)).toMatch(/may not use write/u)
    expect(readFileSync(join(root, 'inside.txt'), 'utf8')).toBe('inside\n')

    // A tool this installation never replaced is refused too, so a driven turn cannot reach around it.
    const other = await call('read-directory', { path: root })
    expect(other.isError).toBe(true)
    expect(text(other)).toMatch(/may not use read-directory/u)
  })

  it('writes only inside the granted workspace at the write tier', async () => {
    access = await install('write', await ctx.fs.resolve(root))
    expect(access.writeConfined).toBe(true)

    const inside = await call('write', { file_path: join(root, 'inside.txt'), content: 'viewer\n' })
    expect(inside.isError).toBe(false)
    expect(readFileSync(join(root, 'inside.txt'), 'utf8')).toBe('viewer\n')

    const outside = await call('write', { file_path: join(tree, 'outside.txt'), content: 'viewer\n' })
    expect(outside.isError).toBe(true)
    expect(text(outside)).toMatch(/not inside the workspace this session was granted/u)
    expect(readFileSync(join(tree, 'outside.txt'), 'utf8')).toBe('outside\n')
  })

  it('leaves the owner’s own turn on the deployment’s tools while the layer is mounted', async () => {
    // The share bounds only the turns a viewer starts: an owner-started turn reads outside the granted
    // workspace, and a viewer-started turn of the same layer is confined again.
    const grantedRoot = await ctx.fs.resolve(root)
    let viewerTurn = false
    access = await install('view', grantedRoot, () => viewerTurn)

    const ownerRead = await call('read', { file_path: join(tree, 'outside.txt') })
    expect(ownerRead.isError).toBe(false)
    expect(text(ownerRead)).toContain('outside')

    viewerTurn = true
    const viewerRead = await call('read', { file_path: join(tree, 'outside.txt') })
    expect(viewerRead.isError).toBe(true)
    expect(text(viewerRead)).toMatch(/not inside the workspace this session was granted/u)
    expect(text(viewerRead)).not.toContain('outside\n')

    // Releasing the layer restores the deployment's reach for every turn.
    access.dispose()
    const restored = await call('read', { file_path: join(tree, 'outside.txt') })
    expect(restored.isError).toBe(false)
    expect(text(restored)).toContain('outside')
    access = undefined
  })
})
