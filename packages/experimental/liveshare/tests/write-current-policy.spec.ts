/** LiveShare's bounded write carries the Session's current policy through the real sandboxed filesystem. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as FsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { assertWorkspaceOutsideTemp, outsideTempWorkspaceParent } from '../../../../scripts/snapshot-workspace-parent.ts'
import { installForkEnforcementForAgent, installSourceSessionAccess } from '../src/host/fork-enforcement.ts'
import type { ForkToolExecution } from '../src/host/fork-tool-guard.ts'
import { ForkRegistry } from '../src/host/fork-registry.ts'
import { executeOneTool } from './tool-call.ts'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'

const viewer = { providerId: 'feishu', tenantId: 'tenant-a', subjectId: 'viewer' }
type AccessKind = 'source' | 'fork'
let base: string
let root: string
let deploymentRoot: string
let ctx: Context
let scope: Scope
let agent: Agent
let backend: SandboxedFileSystem
let forks: ForkRegistry
let admitted: boolean
let disposeAccess: (() => void) | undefined
let calls = 0

function describeTool(execution: ForkToolExecution) {
  const args = execution.arguments
  const path = typeof args === 'object' && args !== null && 'file_path' in args ? args.file_path : undefined
  return typeof path === 'string'
    ? { paths: [path], noFileEffect: false }
    : { paths: undefined, noFileEffect: false }
}

function standInAgent(id: SessionId, cwd: string): Omit<Agent, 'ctx'> {
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false,
  })
  const unsupported = (): never => { throw new Error('this fixture does not drive an Inbox') }
  return {
    id, session, options: {}, status: 'idle',
    model: { current: () => undefined, select: () => {} },
    inbox: {
      nextTurn: [], nextStep: [], clear: unsupported, append: unsupported,
      prepend: unsupported, replace: unsupported, remove: unsupported, splice: unsupported,
    },
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: task => task(new AbortController().signal),
  }
}

beforeEach(async ({ onTestFinished }) => {
  base = realpathSync(mkdtempSync(join(outsideTempWorkspaceParent(), '.dsh-liveshare-policy-')))
  ctx = new Context()
  disposeAccess = undefined
  onTestFinished(async () => {
    try {
      disposeAccess?.()
      await ctx.fiber.dispose()
    } finally {
      vi.restoreAllMocks()
      rmSync(base, { recursive: true, force: true })
    }
  })
  // Neither workspace may inherit a platform-temp write grant: default A must not authorize Session B.
  assertWorkspaceOutsideTemp(base)
  root = join(base, 'session-b')
  deploymentRoot = join(base, 'deployment-a')
  mkdirSync(root)
  mkdirSync(deploymentRoot)
  writeFileSync(join(root, 'file.txt'), 'original\n')
  provideWorkingDirectoryFixture(ctx, root)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: deploymentRoot })
  await ctx.plugin(SandboxedFileSystem, { cwd: deploymentRoot })
  await ctx.plugin(FsObservationPolicy)
  await ctx.plugin(ToolFs)
  if (!(ctx.fs instanceof SandboxedFileSystem)) throw new Error('the fixture requires the sandboxed filesystem')
  backend = ctx.fs
  const key = standInAgent(SessionId('liveshare-policy-session'), root)
  let minted: Scope | undefined
  await ctx.plugin(Object.assign(
    (inner: Context) => { minted = createScope(inner, key) },
    { inject: ['tools', 'fs', 'systemPrompt'] },
  ))
  if (minted === undefined) throw new Error('the Session scope was not minted')
  scope = minted
  agent = Object.assign(key, { ctx: scope.ctx })
  setSandboxMode(agent.session, 'workspace-write')
  forks = new ForkRegistry(join(base, 'forks.json'))
  await forks.record({
    childSessionId: agent.id, shareId: 'share-policy', sourceSessionId: 'owner-session',
    boundary: 0, creator: viewer, createdAt: '2026-10-08T00:00:00.000Z',
  })
  admitted = true
})

async function install(kind: AccessKind): Promise<void> {
  if (kind === 'source') {
    const access = installSourceSessionAccess({
      sessionId: agent.id, context: scope.ctx, scope: agent,
      grantedRoot: await ctx.fs.resolve(root), cwd: root, fs: ctx.fs, tools: ctx.tools,
      describe: describeTool,
      write: { mayWrite: () => admitted },
      resolvePolicy: () => ctx.sandboxPolicy.resolve({ session: agent.session }),
      // The host refreshes the Session's grants before each operation; a share that stopped admitting
      // this viewer makes that read fail, which refuses the write before it reaches the backend.
      refreshAuthorization: async () => {
        if (!admitted) throw new Error('share-not-found')
      },
    })
    disposeAccess = () => { access.dispose() }
    expect(access.readConfined).toBe(true)
    expect(access.writeConfined).toBe(true)
  } else {
    disposeAccess = await installForkEnforcementForAgent(ctx, agent.id, scope.ctx, agent.session, {
      forks, describe: describeTool, write: true, authorized: () => admitted,
    })
    expect(disposeAccess).toBeDefined()
  }
}

function call(name: string, args: unknown) {
  return executeOneTool(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`current-policy-${++calls}`), name, arguments: args, agent,
  })
}

const text = (result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string =>
  result.content.filter(block => block.type === 'text').map(block => block.text).join('')

/** Hold the actual write-intent waterfall before it delegates to the real observation policy. */
function intentBarrier() {
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  const dispose = scope.ctx.on('fs/write-intent', async (_target, _actor, next) => {
    entered.resolve(undefined)
    await released.promise
    return next()
  }, true)
  return { entered: entered.promise, release: () => { released.resolve(undefined) }, dispose }
}

describe('LiveShare current write policy', () => {
  it.each(['source', 'fork'] as const)('uses Session B rather than deployment A for %s publication', async (kind) => {
    await install(kind)
    const path = join(root, 'file.txt')
    expect((await call('read', { file_path: path })).isError).toBe(false)
    const publish = vi.spyOn(backend, 'writeText')
    const result = await call('write', { file_path: path, content: 'viewer\n' })
    expect(result.isError).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('viewer\n')
    expect(publish).toHaveBeenCalledOnce()
    expect(publish.mock.calls[0]?.[4]).toEqual({
      mode: 'workspace-write', workspaceRoot: root, sessionId: agent.session.id,
    })
    expect(readdirSync(deploymentRoot)).toEqual([])
  })

  it.each(['source', 'fork'] as const)('uses a policy change after %s installation rather than pinning its mode', async (kind) => {
    setSandboxMode(agent.session, 'read-only')
    await install(kind)
    const path = join(root, 'file.txt')
    expect((await call('read', { file_path: path })).isError).toBe(false)
    expect((await call('write', { file_path: path, content: 'denied\n' })).isError).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('original\n')
    setSandboxMode(agent.session, 'workspace-write')
    expect((await call('write', { file_path: path, content: 'current\n' })).isError).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('current\n')
  })

  it.each([
    { kind: 'source', present: true }, { kind: 'fork', present: true },
    { kind: 'source', present: false }, { kind: 'fork', present: false },
  ] as const)('denies $kind after policy narrows while write-intent is awaiting (present: $present)', async ({ kind, present }) => {
    await install(kind)
    const path = join(root, present ? 'file.txt' : 'new.txt')
    if (present) expect((await call('read', { file_path: path })).isError).toBe(false)
    const observed: string[] = []
    scope.ctx.on('fs/observed', (target) => { observed.push(target.displayPath) })
    const publish = vi.spyOn(backend, 'writeText')
    const barrier = intentBarrier()
    const pending = call('write', { file_path: path, content: 'must not publish\n' })
    try {
      await barrier.entered
      expect(publish).not.toHaveBeenCalled()
      setSandboxMode(agent.session, 'read-only')
      barrier.release()
      const result = await pending
      expect(result.isError).toBe(true)
      expect(text(result)).toMatch(/read-only/u)
      expect(publish).toHaveBeenCalledOnce()
      expect(publish.mock.calls[0]?.[4]).toEqual({
        mode: 'read-only', workspaceRoot: root, sessionId: agent.session.id,
      })
      expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('original\n')
      if (!present) expect(existsSync(path)).toBe(false)
      expect(readdirSync(root)).toEqual(['file.txt'])
      expect(observed).toEqual([])
    } finally {
      barrier.release()
      await pending
      barrier.dispose()
    }
  })

  it('[P0] denies a source write whose share narrows to view while write-intent is awaiting', async () => {
    // The host's bounded write carries the share tier twice: before the intent waterfall and again after
    // the final admission refresh. A share narrowed to view while the intent awaits must be refused by
    // the second gate, before anything reaches the backend.
    let tier: 'write' | 'view' = 'write'
    let mayWriteChecks = 0
    let refreshes = 0
    const access = installSourceSessionAccess({
      sessionId: agent.id, context: scope.ctx, scope: agent,
      grantedRoot: await ctx.fs.resolve(root), cwd: root, fs: ctx.fs, tools: ctx.tools,
      describe: describeTool,
      write: { mayWrite: () => { mayWriteChecks += 1; return tier === 'write' } },
      refreshAuthorization: async () => { refreshes += 1 },
      resolvePolicy: () => ctx.sandboxPolicy.resolve({ session: agent.session }),
    })
    disposeAccess = () => { access.dispose() }
    expect(access.writeConfined).toBe(true)
    const path = join(root, 'file.txt')
    expect((await call('read', { file_path: path })).isError).toBe(false)
    const refreshesBefore = refreshes
    const publish = vi.spyOn(backend, 'writeText')
    const barrier = intentBarrier()
    const pending = call('write', { file_path: path, content: 'must not publish\n' })
    try {
      await barrier.entered
      expect(publish).not.toHaveBeenCalled()
      expect(mayWriteChecks).toBe(1)
      // The share narrows while the intent is held; the refresh before the final gate reads the new tier.
      tier = 'view'
      barrier.release()
      const result = await pending
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('does not allow writing this Session')
      // The final gate asked again after the refresh; trusting the first verdict would have let this write
      // reach fs.writeText.
      expect(mayWriteChecks).toBe(2)
      expect(refreshes - refreshesBefore).toBe(2)
      expect(publish).not.toHaveBeenCalled()
      expect(readFileSync(path, 'utf8')).toBe('original\n')
      expect(readdirSync(root)).toEqual(['file.txt'])
    } finally {
      barrier.release()
      await pending
      barrier.dispose()
    }
  })

  it.each(['source', 'fork'] as const)('denies %s after share revocation while write-intent is awaiting', async (kind) => {
    await install(kind)
    const path = join(root, 'file.txt')
    expect((await call('read', { file_path: path })).isError).toBe(false)
    const observed: string[] = []
    scope.ctx.on('fs/observed', (target) => { observed.push(target.displayPath) })
    const publish = vi.spyOn(backend, 'writeText')
    const barrier = intentBarrier()
    const pending = call('write', { file_path: path, content: 'revoked\n' })
    try {
      await barrier.entered
      admitted = false
      if (kind === 'fork') await forks.revokeShare('share-policy', '2026-10-08T00:01:00.000Z')
      barrier.release()
      const result = await pending
      expect(result.isError).toBe(true)
      expect(text(result)).toMatch(/share-not-found|no longer holds permission/u)
      expect(publish).not.toHaveBeenCalled()
      expect(readFileSync(path, 'utf8')).toBe('original\n')
      expect(readdirSync(root)).toEqual(['file.txt'])
      expect(observed).toEqual([])
    } finally {
      barrier.release()
      await pending
      barrier.dispose()
    }
  })

  it('carries the Session’s current policy for a turn of the owner as well', async () => {
    await install('source')
    const path = join(root, 'owner.txt')
    const ordinary = vi.spyOn(backend, 'writeText')
    // The sandbox belongs to the Session: the owner's own turn writes through the same bounded path and
    // under the same policy, not through the deployment's own write tool.
    const result = await call('write', { file_path: path, content: 'owner\n' })
    expect(result.isError).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('owner\n')
    expect(ordinary.mock.calls[0]?.[4]).toEqual({
      mode: 'workspace-write', workspaceRoot: root, sessionId: agent.session.id,
    })
    // And the grant still bounds it: a path outside the Session's workspace is refused.
    const outside = join(deploymentRoot, 'escaped.txt')
    expect((await call('write', { file_path: outside, content: 'no\n' })).isError).toBe(true)
    expect(existsSync(outside)).toBe(false)
    setSandboxMode(agent.session, 'read-only')
    expect((await call('write', { file_path: join(root, 'owner-denied.txt'), content: 'denied' })).isError).toBe(true)
    expect(existsSync(join(root, 'owner-denied.txt'))).toBe(false)
  })
})
