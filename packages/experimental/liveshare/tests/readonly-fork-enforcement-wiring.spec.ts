/**
 * The host's enforcement wiring: service presence, install ordering, and the listener protocol it
 * registers.
 *
 * The contexts and services here are fakes, so this spec proves the wiring's own refusals and the
 * waterfall contract it presents to the tool runtime. `readonly-fork-tool-execution.spec.ts` drives
 * the same installer through the real tool runtime, filesystem, and shipped `read`/`write` tools.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { FsTargetKey, FsVersion, type FsEditOutcome, type FsTarget, type FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type { PreToolDecision, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  installForkEnforcement,
  installForkEnforcementForAgent,
  installHostForkEnforcement,
  installSourceSessionAccess,
  preflightForkChild,
  type ForkEnforcementFailure,
  type ForkEnforcementFs,
  type ForkToolRegistry,
} from '../src/host/fork-enforcement.ts'
import { ForkRegistry } from '../src/host/fork-registry.ts'
import { SHARED_TOOL_PROFILES } from '../src/host/shared-tools.ts'
import type { ForkToolExecution } from '../src/host/fork-tool-guard.ts'

const child = 'child-1'
/** The viewer identity the registry recorded for this child. */
const viewer = { providerId: 'feishu', tenantId: 'tenant-a', subjectId: 'ou_viewer' } as const
/** Temp directories this spec allocated, removed after each test. */
const temporary: string[] = []

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const grantedRoot = '/granted'
/** The child's own scope key, which the guard compares its visible tool definitions against. */
const childScope = { child }
/** One definition object, so an unshadowed name compares equal on both sides. */
const readDefinition: ToolDefinition = {
  name: 'read',
  description: 'a fixture read definition',
  parameters: {},
  output: { schema: {}, render: () => [] },
  execute: () => Promise.resolve(undefined),
}

/** One child context capturing what the wiring registers on it. */
function childContext() {
  const captured: {
    guard?: (execution: ForkToolExecution) => string | undefined
    preExecute?: (execution: ForkToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>
    result?: (execution: ForkToolExecution) => void
    readonly definitions: Map<string, ToolDefinition>
  } = { definitions: new Map() }
  const ctx = Object.assign(new Context(), {
    tools: {
      guard: (guard: (execution: ForkToolExecution) => string | undefined) => {
        captured.guard = guard
        return () => { delete captured.guard }
      },
      get: (): ToolDefinition | undefined => readDefinition,
      register: (definition: ToolDefinition) => {
        captured.definitions.set(definition.name, definition)
        return () => { captured.definitions.delete(definition.name) }
      },
    },
    on: (event: string, listener: never) => {
      if (event === 'tools/pre-execute') captured.preExecute = listener
      else captured.result = listener
      return () => {
        if (event === 'tools/pre-execute') delete captured.preExecute
        else delete captured.result
      }
    },
  })
  return { captured, ctx }
}

/** A registry that already recorded one child of one share. */
async function registry(): Promise<ForkRegistry> {
  const directory = mkdtempSync(join(tmpdir(), 'liveshare-enforce-'))
  temporary.push(directory)
  const forks = new ForkRegistry(join(directory, 'forks.json'))
  await forks.record({
    childSessionId: child,
    shareId: 'share-1',
    sourceSessionId: 'session-1',
    boundary: 5,
    creator: viewer,
    createdAt: '2026-09-12T00:00:00.000Z',
  })
  return forks
}

/** The host's own argument reader: the shipped read tool names its path `file_path`. */
function describeTool(execution: ForkToolExecution) {
  const args = execution.arguments
  const path = typeof args === 'object' && args !== null && 'file_path' in args
    ? (args as { readonly file_path?: unknown }).file_path
    : undefined
  return typeof path === 'string'
    ? { paths: [path], noFileEffect: false }
    : { paths: undefined, noFileEffect: false }
}

/** A stand-in target for the fake provider; only `contains` reads it. */
const pathOf = (target: FsTarget): string => target.displayPath

/** A host filesystem whose resolution knows one granted root. */
const fs: ForkEnforcementFs = {
  resolve: (path: string): Promise<FsTarget> => Promise.resolve({ targetKey: FsTargetKey(path), displayPath: path }),
  contains: (parent: FsTarget, candidate: FsTarget): boolean => pathOf(candidate).startsWith(pathOf(parent)),
  processPath: (target: FsTarget): string => pathOf(target),
  // The write the bounded write tool delegates to once containment holds; the fake writes the candidate itself.
  writeText: (): Promise<FsWriteOutcome> => Promise.resolve({
    operation: 'update' as const,
    version: FsVersion('fake-next'),
    before: null,
    after: '',
  }),
  // The edit the bounded edit tool delegates to once containment holds.
  editText: (): Promise<FsEditOutcome> => Promise.resolve({
    version: FsVersion('fake-edited'),
    before: 'old',
    after: 'new',
  }),
}

/** The tool registry half: one definition per name, shared by the host and an unshadowed child view. */
const trusted: ForkToolRegistry = { get: (_name: string): ToolDefinition | undefined => readDefinition }

describe('fork resume preflight', () => {
  /** A host context whose session query answers one stored child and whose filesystem is the caller's. */
  function preflightContext(
    resolve: (path: string) => Promise<unknown>,
    cwd?: string,
  ): { readonly ctx: Context; readonly announced: string[] } {
    const ctx = new Context()
    const announced: string[] = []
    ctx.on('agent/created' as never, (() => { announced.push('created') }) as never)
    ctx.provide('fs', { resolve } as never)
    ctx.provide('sessionQuery', {
      observeSession: async (id: string) => ({
        header: { id, ...(cwd === undefined ? {} : { cwd }) },
        [Symbol.dispose]: () => {},
      }),
    } as never)
    return { ctx, announced }
  }

  it('resolves the recorded workspace before anything is announced', async () => {
    const resolved: string[] = []
    const { ctx, announced } = preflightContext(async (path) => {
      resolved.push(path)
      return { path }
    }, '/granted/ws')
    await preflightForkChild(ctx, child)
    expect(resolved).toEqual(['/granted/ws'])
    // The preflight itself never publishes; publication is what happens after it when it succeeds.
    expect(announced).toEqual([])
    await ctx.fiber.dispose()
  })

  it('refuses a workspace that no longer resolves before the child is announced', async () => {
    const { ctx, announced } = preflightContext(
      () => Promise.reject(Object.assign(new Error('not a directory'), { code: 'ENOTDIR' })), '/broken/ws',
    )
    await expect(preflightForkChild(ctx, child)).rejects.toThrow(/cannot be confined/)
    // No `agent/created` announcement reached the watcher, so a watcher of this process records no child.
    expect(announced).toEqual([])
    await ctx.fiber.dispose()
  })

  it('refuses a recorded child that states no workspace', async () => {
    const { ctx } = preflightContext(async path => ({ path }))
    await expect(preflightForkChild(ctx, child)).rejects.toThrow(/has no workspace/)
    await ctx.fiber.dispose()
  })

  it('fails the preflight when the stored child cannot be read', async () => {
    const ctx = new Context()
    ctx.provide('fs', { resolve: async (path: string) => ({ path }) } as never)
    ctx.provide('sessionQuery', {
      observeSession: () => Promise.reject(new Error('the stored log is unreadable')),
    } as never)
    // A Session this host cannot read is a preflight failure, not a reason to activate and hope: the
    // child's limitation cannot be proven, so the caller must refuse it.
    await expect(preflightForkChild(ctx, child)).rejects.toThrow(
      'fork child-1 preflight failed: the stored log is unreadable',
    )
    await ctx.fiber.dispose()
  })
})

describe('fork enforcement wiring', () => {
  // The `liveshare/fork-enforcement` event was removed by the minimal-surface rule; these cases assert
  // the child's resulting state instead of the stages an observer used to see.
  it('leaves the prompt gate closed when the host holds no live child', async () => {
    const ctx = new Context()
    // No agent registry at all: nothing installs, so the child's prompt gate stays closed.
    const forks = await registry()
    expect(await installHostForkEnforcement(ctx, 'child-1', { forks, describe: describeTool }))
      .toBeUndefined()
    expect(forks.enforcementInstalled('child-1')).toBe(false)
    expect(forks.allowsPrompt('child-1', viewer))
      .toMatchObject({ ok: false, code: 'fork-ceiling-uninstalled' })

    // An agent the host does not hold is the same consequence: nothing was installed for the child.
    ctx.provide('agents', { get: () => undefined })
    expect(await installHostForkEnforcement(ctx, 'child-1', { forks, describe: describeTool }))
      .toBeUndefined()
    expect(forks.enforcementInstalled('child-1')).toBe(false)
    expect(forks.allowsPrompt('child-1', viewer))
      .toMatchObject({ ok: false, code: 'fork-ceiling-uninstalled' })
    await ctx.fiber.dispose()
  })

  it('fails a cold entry whose granted workspace cannot resolve, and keeps the prompt gate closed', async () => {
    const ctx = new Context()
    // Every service the installer needs except a filesystem that can resolve: the granted root cannot be
    // resolved, which is the failure a real restart hit and could not observe.
    ctx.provide('fs', {
      resolve: () => Promise.reject(new Error('the workspace is gone')),
      contains: () => false,
      processPath: () => '',
      writeText: () => Promise.reject(new Error('unused')),
    })
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/workspace' }) })
    ctx.provide('tools', { get: () => undefined })

    // A scoped child context, as the prepublish setup hands in: the installer must get past its own
    // checks and fail on the workspace itself.
    const forks = await registry()
    const scope = createScope(ctx, { id: 'child-1' })
    await expect(installForkEnforcementForAgent(
      ctx,
      'child-1',
      scope.ctx,
      { header: { cwd: '/workspace' } } as never,
      { forks, describe: describeTool },
    )).rejects.toThrow('the workspace is gone')

    // The error still propagates, and the child it failed to install for stays unpromptable.
    expect(forks.enforcementInstalled('child-1')).toBe(false)
    expect(forks.allowsPrompt('child-1', viewer))
      .toMatchObject({ ok: false, code: 'fork-ceiling-uninstalled' })
    await ctx.fiber.dispose()
  })

  it('gives a child the bounded write only when the host says the share writes', async () => {
    /** Drive the cold entry with one host flag and report what the child's scope received. */
    const install = async (host: { readonly write?: boolean }) => {
      const ctx = new Context()
      ctx.provide('fs', fs)
      ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: grantedRoot }) })
      const registered: string[] = []
      ctx.provide('tools', {
        get: (tool: string): ToolDefinition | undefined => ({ ...readDefinition, name: tool }),
        guard: () => () => {},
        register: (definition: ToolDefinition) => {
          registered.push(definition.name)
          return () => {}
        },
      })
      const scope = createScope(ctx, { id: child })
      const dispose = await installForkEnforcementForAgent(
        ctx,
        child,
        scope.ctx,
        { header: { cwd: grantedRoot } } as never,
        { forks: await registry(), describe: describeTool, ...host },
      )
      await ctx.fiber.dispose()
      return { registered, installed: dispose !== undefined }
    }

    const reading = await install({})
    expect(reading.installed).toBe(true)
    // The path-bearing view surface, including the tools that only search or read images.
    expect(reading.registered).toEqual(expect.arrayContaining([
      ...SHARED_TOOL_PROFILES.filter(profile => profile.tier === 'view' && !profile.noFileEffect).map(profile => profile.name),
    ]))
    // A share whose mode is unknown, or reading, never gets the write ceiling's replacements.
    expect(reading.registered).not.toContain('write')
    expect(reading.registered).not.toContain('edit')

    const writing = await install({ write: true })
    expect(writing.registered).toEqual(expect.arrayContaining([
      ...SHARED_TOOL_PROFILES.filter(profile => !profile.noFileEffect).map(profile => profile.name),
    ]))
  })

  it('produces a verdict through the host resolution and lets the guard allow that read', async () => {
    const { ctx, captured } = childContext()
    const forks = await registry()
    const dispose = installForkEnforcement({
      childSessionId: child,
      childContext: ctx,
      childScope,
      grantedRoot: { targetKey: FsTargetKey(grantedRoot), displayPath: grantedRoot },
      cwd: grantedRoot,
      resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: grantedRoot, sessionId: SessionId(child) }),
      fs,
      tools: trusted,
      forks,
      describe: describeTool,
    })

    expect(dispose).toBeDefined()
    expect(forks.enforcementInstalled(child)).toBe(true)
    // The child's own read is this host's: the deployment's definition is shadowed by a confined one.
    expect(captured.definitions.get('read')?.name).toBe('read')
    expect(captured.definitions.get('read')).not.toBe(readDefinition)
    const inside: ForkToolExecution = {
      name: 'read',
      arguments: { file_path: `${grantedRoot}/a.ts` },
      agent: { id: child },
      token: Symbol('inside'),
    }
    await captured.preExecute?.(inside, () => Promise.resolve({ kind: 'allow' }))
    // The verdict comes from the host's resolve/contains pair, not from the guard reading the string.
    expect(captured.guard?.(inside)).toBeUndefined()

    // The verdict is bound to that execution's token: a different execution naming the same authorized
    // path has no verdict of its own and is refused.
    const other: ForkToolExecution = {
      name: 'read',
      arguments: { file_path: `${grantedRoot}/a.ts` },
      agent: { id: child },
      token: Symbol('another-execution'),
    }
    expect(captured.guard?.(other)).toMatch(/workspace/u)

    // A path the resolution did not confirm is refused for that same execution.
    const outside: ForkToolExecution = { ...inside, arguments: { file_path: '/etc/passwd' } }
    await captured.preExecute?.(outside, () => Promise.resolve({ kind: 'allow' }))
    expect(captured.guard?.(outside)).toMatch(/workspace/u)
  })

  it('refuses a child whose scope cannot register the confined read, and keeps the prompt gate closed', async () => {
    const ctx = new Context()
    ctx.provide('fs', fs)
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: grantedRoot }) })
    ctx.provide('tools', {
      get: () => readDefinition,
      guard: () => () => {},
      register: () => { throw new Error('the scope already holds this name') },
    })
    const forks = await registry()
    const scope = createScope(ctx, { id: child })

    const dispose = await installForkEnforcementForAgent(
      ctx,
      child,
      scope.ctx,
      { header: { cwd: grantedRoot } } as never,
      { forks, describe: describeTool },
    )

    // The deployment's unconfined read is never vouched for, and the child it was refused for stays
    // unpromptable: the registry's own gate names that consequence.
    expect(dispose).toBeUndefined()
    expect(forks.enforcementInstalled(child)).toBe(false)
    expect(forks.allowsPrompt(child, viewer)).toMatchObject({ ok: false, code: 'fork-ceiling-uninstalled' })
    await ctx.fiber.dispose()
  })

  it('keeps the error a refused write registration raised for the caller to state', async () => {
    const ctx = new Context()
    ctx.provide('fs', fs)
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: grantedRoot }) })
    const registered: string[] = []
    ctx.provide('tools', {
      get: (tool: string): ToolDefinition | undefined => ({ ...readDefinition, name: tool }),
      guard: () => () => {},
      register: (definition: ToolDefinition) => {
        if (definition.name === 'write') throw new Error('the child scope already holds write')
        registered.push(definition.name)
        return () => {}
      },
    })
    const forks = await registry()
    const scope = createScope(ctx, { id: child })
    const failure: ForkEnforcementFailure = {}

    const dispose = await installForkEnforcementForAgent(
      ctx,
      child,
      scope.ctx,
      { header: { cwd: grantedRoot } } as never,
      { forks, describe: describeTool, write: true },
      failure,
    )

    // The write-capable installation is refused as a whole, and the scope's own error survives for the
    // caller that reports `fork execution limits are unavailable: <message>`.
    expect(dispose).toBeUndefined()
    expect(registered).toEqual(SHARED_TOOL_PROFILES.filter(profile => profile.tier === 'view' && !profile.noFileEffect).map(profile => profile.name))
    expect(failure.registration).toMatchObject({ tool: 'write' })
    expect((failure.registration?.error as Error).message).toBe('the child scope already holds write')
    expect(forks.enforcementInstalled(child)).toBe(false)
    await ctx.fiber.dispose()
  })

  it('installs the guard alone, and says so, when the deployment has no read tool for a shared session', () => {
    const { ctx, captured } = childContext()
    ctx.tools.get = () => undefined
    const installation = installSourceSessionAccess({
      sessionId: 'session-shared',
      context: ctx,
      scope: childScope,
      grantedRoot: { targetKey: FsTargetKey(grantedRoot), displayPath: grantedRoot },
      cwd: grantedRoot,
      resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: grantedRoot, sessionId: SessionId('session-shared') }),
      fs,
      tools: { get: () => undefined },
      describe: describeTool,
      write: { mayWrite: () => true },
    })

    // Nothing usable was installed, and the caller is told which tool is missing.
    expect(installation.readConfined).toBe(false)
    expect(installation.refusal).toBe('tool-unavailable')
    expect(captured.definitions.size).toBe(0)
    // The guard still refuses every tool of the Session, so it never falls back to the owner's own
    // definitions...
    const call = (name: string) =>
      ({ name, arguments: {}, agent: { id: child }, token: Symbol(name) }) as never
    expect(captured.guard?.(call('read'))).toMatch(/may not use/u)
    expect(captured.guard?.(call('bash'))).toMatch(/may not use/u)
    // ...and a released layer stops refusing anything.
    installation.dispose()
    expect(captured.guard).toBeUndefined()
  })

  it('keeps the error a source-session registration raised on the installation', () => {
    const { ctx } = childContext()
    ctx.tools.register = () => { throw new Error('the source scope already holds read') }
    const installation = installSourceSessionAccess({
      sessionId: 'session-shared',
      context: ctx,
      scope: childScope,
      grantedRoot: { targetKey: FsTargetKey(grantedRoot), displayPath: grantedRoot },
      cwd: grantedRoot,
      resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: grantedRoot, sessionId: SessionId('session-shared') }),
      fs,
      tools: { get: () => readDefinition },
      describe: describeTool,
    })

    // The layer still refuses the Session's tools, and the error the scope raised is not lost.
    expect(installation.readConfined).toBe(false)
    expect(installation.refusal).toBe('register-refused')
    expect(installation.registrationFailure).toMatchObject({ tool: 'read' })
    expect((installation.registrationFailure?.error as Error).message).toBe('the source scope already holds read')
    installation.dispose()
  })

  it('runs as a waterfall listener: it awaits the producer and returns the pipeline’s own decision', async () => {
    const { ctx, captured } = childContext()
    installForkEnforcement({
      childSessionId: child,
      childContext: ctx,
      childScope,
      grantedRoot: { targetKey: FsTargetKey(grantedRoot), displayPath: grantedRoot },
      cwd: grantedRoot,
      resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: grantedRoot, sessionId: SessionId(child) }),
      fs,
      tools: trusted,
      forks: await registry(),
      describe: describeTool,
    })

    let nextCalls = 0
    const decision: PreToolDecision = { kind: 'deny', reason: 'a later listener denied this' }
    const recorded = await captured.preExecute?.(
      {
        name: 'read',
        arguments: { file_path: '/etc/passwd' },
        agent: { id: child },
        token: Symbol('a'),
      },
      () => { nextCalls += 1; return Promise.resolve({ kind: 'allow' }) },
    )
    // A verdict the host could not confirm leaves no missing decision behind: the pipeline still sees
    // the rest of the chain's answer, and the guard refuses the execution on its own.
    expect(nextCalls).toBe(1)
    expect(recorded).toEqual({ kind: 'allow' })
    const denied = await captured.preExecute?.(
      {
        name: 'read',
        arguments: { file_path: `${grantedRoot}/a.ts` },
        agent: { id: child },
        token: Symbol('b'),
      },
      () => { nextCalls += 1; return Promise.resolve(decision) },
    )
    // An existing denial downstream stays the decision: this listener never answers in its place.
    expect(denied).toBe(decision)
    expect(nextCalls).toBe(2)
  })

  it('refuses to install anything while one real dependency is missing', async () => {
    const forks = await registry()
    // No `fs` on this deployment: nothing could apply a limit, so the record must stay unwritten.
    const withoutFs = {
      get: (name: string) => name === 'fs'
        ? undefined
        : { get: () => undefined, resolve: () => ({ mode: 'workspace-write', workspaceRoot: grantedRoot }) },
    }
    expect(await installHostForkEnforcement(
      Object.assign(new Context(), withoutFs), child, { forks, describe: describeTool },
    ))
      .toBeUndefined()
    expect(forks.enforcementInstalled(child)).toBe(false)
  })

  it('releases the guard, the verdicts, and the record when the child goes away', async () => {
    const { ctx, captured } = childContext()
    const forks = await registry()
    const dispose = installForkEnforcement({
      childSessionId: child,
      childContext: ctx,
      childScope,
      grantedRoot: { targetKey: FsTargetKey(grantedRoot), displayPath: grantedRoot },
      cwd: grantedRoot,
      resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: grantedRoot, sessionId: SessionId(child) }),
      fs,
      tools: trusted,
      forks,
      describe: describeTool,
    })

    expect(captured.guard).toBeDefined()
    // The verdict sink is registered with the limit so a settled execution's verdict is dropped.
    expect(captured.result).toBeDefined()
    dispose?.()
    // The guard stays registered: with the record gone it refuses, where unregistering it would leave
    // the child running with no limit at all.
    expect(captured.guard).toBeDefined()
    expect(captured.guard?.({ name: 'read', arguments: {}, agent: { id: child } }))
      .toMatch(/limits are not installed/u)
    expect(captured.preExecute).toBeUndefined()
    expect(captured.result).toBeUndefined()
    expect(forks.enforcementInstalled(child)).toBe(false)
  })
})
