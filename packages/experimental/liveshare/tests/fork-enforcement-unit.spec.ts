/** Fork enforcement installation refusals and the confined tool bodies it registers. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { READ_ONLY_FORK_CEILING, type ForkCeiling } from '../src/host/fork-policy.ts'
import { SHARED_TOOL_PROFILES, sharedToolNames } from '../src/host/shared-tools.ts'
import {
  installForkEnforcement,
  installHostForkEnforcement,
  installSourceSessionAccess,
  preflightForkChild,
} from '../src/host/fork-enforcement.ts'
import type { ForkEnforcementFailure } from '../src/host/fork-enforcement.ts'

interface RegisteredTool {
  readonly name: string
  readonly execute: (args: unknown, exec: Record<string, unknown>) => Promise<unknown>
}

function deploymentTool(name: string, body = vi.fn(async () => 'ran')): ToolDefinition & RegisteredTool {
  return {
    name,
    description: 'deployment tool',
    parameters: {},
    output: { schema: { type: 'string' }, render: () => [] },
    execute: body,
  } as never
}

function harness(options: { readonly read?: RegisteredTool; readonly write?: RegisteredTool; readonly registerThrows?: string } = {}) {
  const registered = new Map<string, RegisteredTool>()
  if (options.read !== undefined) registered.set(options.read.name, options.read)
  if (options.write !== undefined) registered.set(options.write.name, options.write)
  let guardFunction: ((execution: Record<string, unknown>) => string | undefined) | undefined
  const tools = {
    get: vi.fn((name: string) => registered.get(name)),
    register: vi.fn((definition: RegisteredTool) => {
      if (options.registerThrows === definition.name) throw new Error(`duplicate ${definition.name}`)
      registered.set(definition.name, definition)
      return () => { registered.delete(definition.name) }
    }),
    guard: vi.fn((guard: (execution: Record<string, unknown>) => string | undefined) => {
      guardFunction = guard
      return () => {}
    }),
  }
  const listeners = new Map<string, (value: unknown) => unknown>()
  const childContext = {
    tools,
    waterfall: vi.fn(async (...args: unknown[]) => {
      const fallback = args.at(-1)
      return typeof fallback === 'function' ? (fallback as () => unknown)() : undefined
    }),
    on: vi.fn((event: string, listener: (value: unknown) => unknown) => {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    }),
    emit: vi.fn(),
  }
  const files = new Map<string, string>()
  const fs = {
    resolve: vi.fn(async (path: string) => path.includes('outside')
      ? '/outside'
      : `/granted/${path.replace(/^\/+/u, '')}`),
    contains: vi.fn((root: string, path: string) => path.startsWith(root)),
    processPath: vi.fn((path: string) => path),
    writeText: vi.fn(async (path: string, content: string) => {
      files.set(path, content)
      return { operation: 'create', before: undefined, after: 'v1', version: 'v1' }
    }),
    editText: vi.fn(async () => ({ before: 'old', after: 'new', version: 'v2' })),
  }
  const forks = {
    enforcementInstalled: vi.fn(() => true),
    enforcedCeiling: vi.fn((_id: string): ForkCeiling | undefined => undefined),
    installEnforcement: vi.fn(() => true),
    releaseEnforcement: vi.fn(),
  }
  const describe = vi.fn(() => ({ paths: ['inside.ts'], noFileEffect: false }))
  const failure: ForkEnforcementFailure = {}
  const target = {
    childSessionId: 'child-1',
    childContext,
    childScope: { name: 'child-scope' },
    grantedRoot: '/granted',
    cwd: '/granted',
    resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: '/granted', sessionId: 'child-1' }),
    fs,
    tools: { get: (name: string) => registered.get(name) },
    forks,
    describe,
    authorized: undefined as ((tool: string) => boolean) | undefined,
    refreshAuthorized: undefined as (() => Promise<void>) | undefined,
  }
  return {
    target, childContext, tools, registered, fs, forks, describe, failure, listeners,
    guard: () => guardFunction,
  }
}

describe('confined fork tools', () => {
  it('installs nothing when the deployment ships no tool to shadow', () => {
    const h = harness()
    expect(installForkEnforcement(h.target as never, h.failure)).toBeTypeOf('function')
    expect(h.tools.guard).toHaveBeenCalled()
  })

  it('refuses a fork read with no named file, outside its grant, or after release', async () => {
    const read = deploymentTool('read')
    const h = harness({ read })
    installForkEnforcement(h.target as never, h.failure)
    const confined = h.registered.get('read')!
    await expect(confined.execute({}, { signal: undefined })).rejects.toThrow('may only use read with the paths')
    await expect(confined.execute('not a record', { signal: undefined })).rejects.toThrow('may only use read with the paths')
    await expect(confined.execute({ file_path: 'outside.txt' }, { signal: undefined }))
      .rejects.toThrow('inside the workspace')
    // The grant itself decides, so a path the fake reports inside succeeds and runs the deployment body.
    const inside = await confined.execute({ file_path: 'inside.ts' }, { signal: undefined })
    expect(inside).toBe('ran')
    expect(read.execute).toHaveBeenCalledWith({ file_path: '/granted/inside.ts' }, expect.anything())

    h.forks.enforcementInstalled.mockReturnValue(false)
    await expect(confined.execute({ file_path: 'inside.ts' }, { signal: undefined }))
      .rejects.toThrow('no longer holds permission')
  })

  it('refuses a read it could not register and keeps the registration error', () => {
    const read = deploymentTool('read')
    const h = harness({ read, registerThrows: 'read' })
    expect(installForkEnforcement(h.target as never, h.failure)).toBeUndefined()
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed test doubles and mock calls.
    expect(h.failure.registration).toMatchObject({ tool: 'read', error: expect.any(Error) })
  })

  it('unwinds later replacements when the read replacement could not register', () => {
    const read = deploymentTool('read')
    const h = harness({ read, registerThrows: 'read' })
    // The view surface installs in table order, so glob is registered after the read failure and must be
    // released again when the installation is refused as a whole.
    h.registered.set('glob', deploymentTool('glob'))
    expect(installForkEnforcement(h.target as never, h.failure)).toBeUndefined()
    expect(h.registered.has('glob')).toBe(false)
  })

  it('bounds a fork edit to the granted root under the current policy', async () => {
    const read = deploymentTool('read')
    const write = deploymentTool('write')
    const h = harness({ read, write })
    h.registered.set('edit', deploymentTool('edit'))
    expect(installForkEnforcement({ ...h.target, write: true } as never, h.failure)).toBeDefined()
    const edit = h.registered.get('edit')!

    // The body runs the deployment's own argument checks itself, because it replaces its execution.
    await expect(edit.execute('not a record', { signal: undefined }))
      .rejects.toThrow('replacing non-empty text')
    await expect(edit.execute({}, { signal: undefined })).rejects.toThrow('replacing non-empty text')
    await expect(edit.execute({ file_path: 'inside.ts', old_string: '', new_string: 'b' }, { signal: undefined }))
      .rejects.toThrow('replacing non-empty text')
    await expect(edit.execute({ file_path: 'inside.ts', old_string: 'a', new_string: 'a' }, { signal: undefined }))
      .rejects.toThrow('replacing non-empty text')
    // The containment check runs inside the body too, so a target the guard did not see is still refused.
    await expect(edit.execute({ file_path: '../outside.ts', old_string: 'a', new_string: 'b' }, { signal: undefined }))
      .rejects.toThrow('inside the workspace')
    expect(h.fs.editText).not.toHaveBeenCalled()

    const result = await edit.execute({
      file_path: 'inside.ts', old_string: 'old', new_string: 'new', replace_all: true,
    }, { signal: undefined })
    expect(result).toEqual({ path: '/granted/inside.ts', before: 'old', after: 'new' })
    expect(h.fs.editText).toHaveBeenCalledWith(
      '/granted/inside.ts',
      { oldString: 'old', newString: 'new', replaceAll: true },
      undefined,
      undefined,
      expect.objectContaining({ workspaceRoot: '/granted' }),
    )
    expect(h.childContext.emit).toHaveBeenCalledWith(
      'fs/observed', '/granted/inside.ts', { kind: 'present', version: 'v2' }, expect.anything(),
    )

    h.forks.enforcementInstalled.mockReturnValue(false)
    await expect(edit.execute({ file_path: 'inside.ts', old_string: 'a', new_string: 'b' }, { signal: undefined }))
      .rejects.toThrow('no longer holds permission')
  })

  it('refuses a write-capable child when the deployment ships no write to replace', () => {
    const read = deploymentTool('read')
    const h = harness({ read })
    expect(installForkEnforcement({ ...h.target, write: true } as never, h.failure)).toBeUndefined()
    // The read replacement it registered first is released again.
    expect(h.registered.has('read')).toBe(false)
  })

  it('refuses a write-capable child whose write replacement could not register', () => {
    const read = deploymentTool('read')
    const write = deploymentTool('write')
    const h = harness({ read, write, registerThrows: 'write' })
    expect(installForkEnforcement({ ...h.target, write: true } as never, h.failure)).toBeUndefined()
    expect(h.failure.registration).toMatchObject({ tool: 'write' })
  })

  it('confines a fork write to the granted root and writes under the current policy', async () => {
    const read = deploymentTool('read')
    const write = deploymentTool('write')
    const h = harness({ read, write })
    expect(installForkEnforcement({ ...h.target, write: true } as never, h.failure)).toBeDefined()
    const confined = h.registered.get('write')!

    await expect(confined.execute({ file_path: 'inside.ts' }, { signal: undefined }))
      .rejects.toThrow('named file with text content')
    await expect(confined.execute('not a record', { signal: undefined }))
      .rejects.toThrow('named file with text content')
    await expect(confined.execute({ file_path: '../outside', content: 'x' }, { signal: undefined }))
      .rejects.toThrow('inside the workspace')
    h.forks.enforcementInstalled.mockReturnValue(false)
    await expect(confined.execute({ file_path: 'inside.ts', content: 'x' }, { signal: undefined }))
      .rejects.toThrow('no longer holds permission')

    h.forks.enforcementInstalled.mockReturnValue(true)
    const result = await confined.execute({ file_path: 'inside.ts', content: 'hello' }, { signal: undefined })
    expect(result).toEqual({ path: 'inside.ts', operation: 'create', before: null, after: 'v1' })
    expect(h.fs.writeText).toHaveBeenCalledWith('/granted/inside.ts', 'hello', undefined, undefined, expect.anything())
    expect(h.childContext.emit).toHaveBeenCalledWith('fs/observed', '/granted/inside.ts', { kind: 'present', version: 'v1' }, expect.anything())
  })

  it('refuses an execution it cannot attribute, a forbidden tool, and one it cannot verify', async () => {
    const read = deploymentTool('read')
    const h = harness({ read })
    installForkEnforcement(h.target as never, h.failure)
    h.forks.enforcedCeiling.mockReturnValue(READ_ONLY_FORK_CEILING)
    const guard = h.guard() as (execution: Record<string, unknown>) => string | undefined
    expect(guard).toBeDefined()
    expect(guard?.({ name: 'read', arguments: { file_path: 'inside.ts' }, agent: { id: 'other' } }))
      .toContain('without a child session')

    h.target.authorized = () => false
    expect(guard?.({ name: 'read', arguments: { file_path: 'inside.ts' }, agent: { id: 'child-1' }, token: Symbol('t') }))
      .toContain('which this host did not install')

    h.target.authorized = () => true
    expect(guard?.({ name: 'read', arguments: { file_path: 'inside.ts' }, agent: { id: 'child-1' } }))
      .toContain('may only read inside the workspace')

    // A definition visible from both registries is trusted even though this host did not install it.
    const visible = harness({ read })
    installForkEnforcement(visible.target as never, visible.failure)
    visible.forks.enforcedCeiling.mockReturnValue(READ_ONLY_FORK_CEILING)
    const visibleGuard = visible.guard()
    expect(visibleGuard?.({ name: 'read', arguments: { file_path: 'inside.ts' }, agent: { id: 'child-1' } }))
      .toContain('may only read inside the workspace')
    expect(visibleGuard?.({ name: 'write', arguments: {}, agent: { id: 'child-1' } }))
      .toContain('may not use write')

    // A tool the ceiling allows but this host did not install is trusted only when both registries
    // hand back the same definition.
    const visibleTool = harness()
    installForkEnforcement(visibleTool.target as never, visibleTool.failure)
    visibleTool.registered.set('grep', deploymentTool('grep'))
    visibleTool.forks.enforcedCeiling.mockReturnValue({ ...READ_ONLY_FORK_CEILING, allowedTools: ['grep', 'ghost'] })
    const visibleToolGuard = visibleTool.guard()
    // The ceiling names grep, but this installation never registered a confined grep for the child:
    // the name alone does not make the deployment's definition executable.
    expect(visibleToolGuard?.({ name: 'grep', arguments: { file_path: 'inside.ts' }, agent: { id: 'child-1' } }))
      .toContain('which this host did not install')
    expect(visibleToolGuard?.({ name: 'ghost', arguments: {}, agent: { id: 'child-1' } }))
      .toContain('which this host did not install')

    // A verdict produced for this execution authorizes its path.
    const token = Symbol('verified')
    const preExecute = visible.listeners.get('tools/pre-execute') as
      ((value: Record<string, unknown>, next: () => unknown) => Promise<unknown>) | undefined
    await preExecute?.({ token, arguments: { file_path: 'inside.ts' }, agent: { id: 'child-1' } }, () => 'next')
    expect(h.guard()?.({ name: 'read', arguments: { file_path: 'inside.ts' }, agent: { id: 'child-1' }, token }))
      .toContain('may only read inside the workspace')
  })

  it('refuses a no-effect tool whose visible definition changed after the limit was installed', () => {
    const read = deploymentTool('read')
    const h = harness({ read })
    h.registered.set('todo_write', deploymentTool('todo_write'))
    expect(installForkEnforcement(h.target as never, h.failure)).toBeDefined()
    h.forks.enforcedCeiling.mockReturnValue(READ_ONLY_FORK_CEILING)
    h.describe.mockReturnValue({ paths: [], noFileEffect: true })
    const guard = h.guard() as (execution: Record<string, unknown>) => string | undefined
    const call = () => guard({ name: 'todo_write', arguments: {}, agent: { id: 'child-1' } })
    // The deployment's own definition is the one the limit vouched for, so the no-effect tool runs.
    expect(call()).toBeUndefined()
    // A different definition answering to the same name is not the one this host installed or vouched
    // for; the name alone is not permission.
    h.registered.set('todo_write', deploymentTool('todo_write'))
    expect(call()).toContain('which this host did not install')
  })

  it('records no verdicts for an execution that names no path', async () => {
    const read = deploymentTool('read')
    const h = harness({ read })
    installForkEnforcement(h.target as never, h.failure)
    h.describe.mockReturnValueOnce({ paths: ['inside.ts'], noFileEffect: false }).mockReturnValue({ paths: undefined, noFileEffect: false } as never)
    const preExecute = h.listeners.get('tools/pre-execute') as
      ((value: Record<string, unknown>, next: () => unknown) => Promise<unknown>) | undefined
    await preExecute?.({ token: Symbol('t'), arguments: {} }, () => 'next')
    expect(h.fs.resolve).not.toHaveBeenCalled()
  })

  it('returns nothing when the child guard cannot register', () => {
    const read = deploymentTool('read')
    const h = harness({ read })
    h.tools.guard.mockReturnValue(undefined as never)
    expect(installForkEnforcement(h.target as never, h.failure)).toBeUndefined()
  })

  it('records verdicts only for executions that name a path and can be resolved', async () => {
    const read = deploymentTool('read')
    const h = harness({ read })
    installForkEnforcement(h.target as never, h.failure)
    const preExecute = h.listeners.get('tools/pre-execute') as
      ((value: Record<string, unknown>, next: () => unknown) => Promise<unknown>) | undefined
    expect(preExecute).toBeDefined()
    // No token and no paths both leave no verdict.
    const next = (): string => 'next'
    await preExecute?.({ token: undefined, arguments: {} }, next)
    await preExecute?.({ token: Symbol('t'), arguments: {} }, next)
    h.fs.resolve.mockRejectedValueOnce(new Error('cancelled'))
    await preExecute?.({ token: Symbol('t2'), arguments: { file_path: 'inside.ts' } }, next)
    expect(h.fs.resolve).toHaveBeenCalled()
  })
})

describe('host installation guards', () => {
  it('installs nothing without an agents lookup or a live agent', async () => {
    const ctx = new Context()
    await expect(installHostForkEnforcement(ctx, 'child-1', {} as never)).resolves.toBeUndefined()
    ctx.provide('agents', { get: () => undefined } as never)
    await expect(installHostForkEnforcement(ctx, 'child-1', {} as never)).resolves.toBeUndefined()
  })

  it('installs nothing for a host missing its filesystem, scope, or child workspace', async () => {
    const missingServices = new Context()
    missingServices.provide('agents', { get: () => ({ ctx: new Context(), session: { header: { cwd: '/root' } } }) } as never)
    await expect(installHostForkEnforcement(missingServices, 'child-1', {} as never)).resolves.toBeUndefined()

    const missingScope = new Context()
    missingScope.provide('agents', { get: () => ({ ctx: new Context(), session: { header: { cwd: '/root' } } }) } as never)
    missingScope.provide('fs', { resolve: vi.fn(async () => '/root') } as never)
    missingScope.provide('sandboxPolicy', { resolve: () => ({ workspaceRoot: '/root' }) } as never)
    missingScope.provide('tools', {} as never)
    await expect(installHostForkEnforcement(missingScope, 'child-1', {} as never)).resolves.toBeUndefined()
  })

  it('installs a child limit through its own scoped context and policy', async () => {
    const base = new Context()
    const tools = {
      get: vi.fn((name: string) => name === 'write' ? deploymentTool('write') : undefined),
      register: vi.fn((definition: RegisteredTool) => {
        registered.set(definition.name, definition)
        return () => { registered.delete(definition.name) }
      }),
      guard: vi.fn(() => () => {}),
    }
    const registered = new Map<string, RegisteredTool>()
    const fs = {
      resolve: vi.fn(async () => '/granted/inside.ts'),
      contains: vi.fn(() => true),
      processPath: vi.fn((path: string) => path),
      writeText: vi.fn(async () => ({ operation: 'update', before: 'v0', after: 'v1', version: 'v1' })),
    }
    const policy = { resolve: vi.fn(() => ({ mode: 'workspace-write', workspaceRoot: '/granted', sessionId: 'child-1' })) }
    base.provide('fs', fs as never)
    base.provide('sandboxPolicy', policy as never)
    base.provide('tools', tools as never)
    const scope = createScope(base, { session: { id: 'child-1' } })
    base.provide('agents', { get: () => ({ ctx: scope.ctx, session: { id: 'child-1', header: { cwd: '/granted' } } }) } as never)
    const dispose = await installHostForkEnforcement(base, 'child-1', {
      forks: {
        enforcementInstalled: () => true,
        enforcedCeiling: () => undefined,
        installEnforcement: () => true,
        releaseEnforcement: () => {},
      },
      describe: () => ({ paths: ['inside.ts'], noFileEffect: false }),
      write: true,
      authorized: () => true,
      refreshAuthorized: async () => {},
    } as never)
    expect(dispose).toBeTypeOf('function')
    const write = registered.get('write')!
    await expect(write.execute({ file_path: 'inside.ts', content: 'hello' }, { signal: undefined }))
      .resolves.toMatchObject({ path: 'inside.ts' })
    expect(policy.resolve).toHaveBeenCalled()
    expect(fs.writeText).toHaveBeenCalled()
    dispose?.()
  })

  it('refuses a scoped child whose Session states no workspace', async () => {
    const base = new Context()
    base.provide('fs', { resolve: vi.fn(async () => '/granted') } as never)
    base.provide('sandboxPolicy', { resolve: () => ({ workspaceRoot: '/granted' }) } as never)
    base.provide('tools', { get: vi.fn(), register: vi.fn(), guard: vi.fn(() => () => {}) } as never)
    const scope = createScope(base, { session: { id: 'child-1' } })
    base.provide('agents', { get: () => ({ ctx: scope.ctx, session: { id: 'child-1', header: {} } }) } as never)
    await expect(installHostForkEnforcement(base, 'child-1', {} as never)).resolves.toBeUndefined()
  })

  it('preflights nothing when the host cannot observe the Session or resolve a path', async () => {
    const withoutQuery = new Context()
    await expect(preflightForkChild(withoutQuery, 'child-1')).resolves.toBeUndefined()
    const withoutFs = new Context()
    withoutFs.provide('sessionQuery', { observeSession: vi.fn() } as never)
    await expect(preflightForkChild(withoutFs, 'child-1')).resolves.toBeUndefined()
  })

  it('reports an unreadable, workspace-less, or unresolvable child Session', async () => {
    const unreadable = new Context()
    unreadable.provide('fs', { resolve: vi.fn(async () => '/root') } as never)
    unreadable.provide('sessionQuery', {
      observeSession: async () => { throw 'session unavailable' },
    } as never)
    await expect(preflightForkChild(unreadable, 'child-1')).rejects.toThrow('session unavailable')

    const noWorkspace = new Context()
    noWorkspace.provide('fs', { resolve: vi.fn(async () => '/root') } as never)
    noWorkspace.provide('sessionQuery', {
      observeSession: async () => ({ header: {}, [Symbol.dispose]: () => {} }),
    } as never)
    await expect(preflightForkChild(noWorkspace, 'child-1')).rejects.toThrow('has no workspace')

    const unresolvable = new Context()
    unresolvable.provide('fs', { resolve: async () => { throw new Error('outside workspace') } } as never)
    unresolvable.provide('sessionQuery', {
      observeSession: async () => ({ header: { cwd: '/workspace' }, [Symbol.dispose]: () => {} }),
    } as never)
    await expect(preflightForkChild(unresolvable, 'child-1')).rejects.toThrow('cannot be confined')
  })
})

describe('source-session sandbox', () => {
  function sourceHarness(options: {
    readonly tools?: readonly string[]
    readonly writeGate?: { mayWrite: () => boolean }
    readonly registerThrows?: string
    readonly refresh?: () => Promise<void>
    readonly resolve?: (path: string) => Promise<string>
  } = {}) {
    const deployments = new Map<string, RegisteredTool>()
    for (const name of options.tools ?? ['read']) deployments.set(name, deploymentTool(name))
    const registered = new Map<string, RegisteredTool>(deployments)
    const installed = new Map<string, RegisteredTool>()
    let guardFunction: ((execution: Record<string, unknown>) => string | undefined) | undefined
    const guard = vi.fn((fn: (execution: Record<string, unknown>) => string | undefined) => {
      guardFunction = fn
      return () => {}
    })
    const context = {
      tools: {
        get: vi.fn((name: string) => registered.get(name)),
        register: vi.fn((definition: RegisteredTool) => {
          if (options.registerThrows === definition.name) throw new Error(`duplicate ${definition.name}`)
          installed.set(definition.name, definition)
          return () => { installed.delete(definition.name) }
        }),
        guard,
      },
      waterfall: vi.fn(async () => undefined),
      on: vi.fn(() => () => {}),
      emit: vi.fn(),
    }
    const fs = {
      resolve: vi.fn(async (path: string) => {
        if (options.resolve !== undefined) return await options.resolve(path)
        if (path.includes('outside')) return '/outside'
        return path.startsWith('/') ? path : `/granted/${path}`
      }),
      contains: vi.fn((root: string, path: string) => path === root || path.startsWith(`${root}/`)),
      processPath: vi.fn((path: string) => path),
      writeText: vi.fn(async () => ({ operation: 'update', before: 'v0', after: 'v1', version: 'v1' })),
      editText: vi.fn(async () => ({ before: 'old', after: 'new', version: 'v2' })),
    }
    const target = {
      sessionId: 'session-1',
      context,
      scope: { name: 'source-scope' },
      grantedRoot: '/granted',
      cwd: '/granted',
      fs,
      tools: { get: (name: string) => registered.get(name) },
      resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: '/granted', sessionId: 'session-1' }),
      describe: () => ({ paths: ['inside.ts'], noFileEffect: false }),
      ...(options.writeGate === undefined ? {} : { write: options.writeGate }),
      ...(options.refresh === undefined ? {} : { refreshAuthorization: options.refresh }),
    }
    return {
      target, context, fs, registered, deployments, installed, guard,
      guardFunction: () => guardFunction,
      call: (name: string, args: unknown) => {
        const definition = installed.get(name) ?? registered.get(name)
        if (definition === undefined) throw new Error(`${name} was not installed`)
        return definition.execute(args, { signal: undefined })
      },
    }
  }

  it('reports the deployment read it cannot replace and the guard it installs', () => {
    const missing = sourceHarness({ tools: [] })
    const unavailable = installSourceSessionAccess(missing.target as never)
    expect(unavailable).toMatchObject({ refusal: 'tool-unavailable' })
    expect(missing.guard).toHaveBeenCalled()

    const refused = sourceHarness({ tools: ['read'], registerThrows: 'read' })
    expect(installSourceSessionAccess(refused.target as never)).toMatchObject({
      refusal: 'register-refused', registrationFailure: { tool: 'read' },
    })
    expect(refused.guard).toHaveBeenCalled()
  })

  it('installs one replacement per admitted tool and refuses every other name', () => {
    const h = sourceHarness({ tools: [...sharedToolNames('view'), 'write', 'edit'] })
    const installed = installSourceSessionAccess(h.target as never)
    expect(installed).toMatchObject({ readConfined: true, writeConfined: false })
    // Path-bearing tools get a replacement; no-effect tools keep the deployment's own definition.
    expect([...h.installed.keys()].sort()).toEqual(
      SHARED_TOOL_PROFILES.filter(profile => profile.tier === 'view' && !profile.noFileEffect)
        .map(profile => profile.name).sort(),
    )

    const guard = h.guardFunction() as (execution: { readonly name: string }) => string | undefined
    for (const name of sharedToolNames('view')) expect(guard({ name })).toBeUndefined()
    for (const name of ['write', 'edit', 'bash', 'pwsh', 'cua', 'plugin_manager', 'schedule_create', 'ghost']) {
      expect(guard({ name })).toContain('may not use')
      expect(h.installed.has(name)).toBe(false)
    }
  })

  it('resolves each tool’s declared paths and delegates with their canonical form', async () => {
    const h = sourceHarness({ tools: sharedToolNames('view') })
    installSourceSessionAccess(h.target as never)

    await expect(h.call('read', { file_path: 'inside.ts', offset: 2 })).resolves.toBe('ran')
    expect(h.fs.resolve).toHaveBeenCalledWith('inside.ts', expect.objectContaining({ cwd: '/granted' }))
    expect(h.deployments.get('read')!.execute).toHaveBeenCalledWith(
      { file_path: '/granted/inside.ts', offset: 2 }, expect.anything(),
    )
    await expect(h.call('read_image', { file_path: 'image.png' })).resolves.toBe('ran')
    expect(h.deployments.get('read_image')!.execute).toHaveBeenCalledWith(
      { file_path: '/granted/image.png' }, expect.anything(),
    )
    // A pathless search reads the Session's working directory, which the replacement supplies as a path.
    await expect(h.call('glob', { pattern: '**/*.ts' })).resolves.toBe('ran')
    expect(h.fs.resolve).toHaveBeenCalledWith('/granted', expect.objectContaining({ cwd: '/granted' }))
    expect(h.deployments.get('glob')!.execute).toHaveBeenCalledWith(
      { pattern: '**/*.ts', path: '/granted' }, expect.anything(),
    )
    await expect(h.call('grep', { pattern: 'x', path: 'src' })).resolves.toBe('ran')
    expect(h.deployments.get('grep')!.execute).toHaveBeenCalledWith(
      { pattern: 'x', path: '/granted/src' }, expect.anything(),
    )
    await expect(h.call('present', {
      files: [{ path: 'a.ts', description: 'A' }, { path: 'b.ts' }],
    })).resolves.toBe('ran')
    expect(h.deployments.get('present')!.execute).toHaveBeenCalledWith({
      files: [{ path: '/granted/a.ts', description: 'A' }, { path: '/granted/b.ts' }],
    }, expect.anything())
    // No-filesystem-effect tools delegate without resolving anything.
    h.fs.resolve.mockClear()
    await expect(h.call('todo_write', { todos: [{ content: 'one' }] })).resolves.toBe('ran')
    await expect(h.call('skill', { name: 'one' })).resolves.toBe('ran')
    await expect(h.call('web_search', { queries: ['q'] })).resolves.toBe('ran')
    await expect(h.call('web_fetch', { url: 'https://example.test' })).resolves.toBe('ran')
    expect(h.fs.resolve).not.toHaveBeenCalled()
    expect(h.deployments.get('todo_write')!.execute).toHaveBeenCalledWith(
      { todos: [{ content: 'one' }] }, expect.anything(),
    )
  })

  it('refuses every path outside the granted root and runs no tool body', async () => {
    const h = sourceHarness({ tools: sharedToolNames('view') })
    installSourceSessionAccess(h.target as never)
    const outsideCalls: [string, unknown][] = [
      ['read', { file_path: 'outside/secret.txt' }],
      ['read_image', { file_path: 'outside/secret.png' }],
      ['glob', { pattern: '**/*.ts', path: 'outside' }],
      ['grep', { pattern: 'x', path: 'outside' }],
      ['present', { files: [{ path: 'inside.ts' }, { path: 'outside/secret.txt' }] }],
    ]
    for (const [name, args] of outsideCalls) {
      await expect(h.call(name, args)).rejects.toThrow('inside the workspace')
    }

    const malformed: [string, unknown][] = [
      ['read', {}],
      ['read_image', { file_path: 2 }],
      ['glob', { pattern: 'x', path: '' }],
      ['grep', { pattern: 'x', path: 2 }],
      ['present', { files: [{ description: 'no path' }] }],
      ['present', { files: 'not a list' }],
    ]
    for (const [name, args] of malformed) {
      await expect(h.call(name, args)).rejects.toThrow('with the paths it declares')
    }

    // A resolution the filesystem refuses is the refusal: no verdict is guessed from the spelling.
    const failing = sourceHarness({ tools: ['read'], resolve: async () => { throw new Error('resolution failed') } })
    installSourceSessionAccess(failing.target as never)
    await expect(failing.call('read', { file_path: 'inside.ts' })).rejects.toThrow('resolution failed')
  })

  it('confines every read of the session and refreshes its grants first', async () => {
    const refresh = vi.fn(async () => {})
    const h = sourceHarness({ refresh })
    const installed = installSourceSessionAccess(h.target as never)
    expect(installed).toMatchObject({ readConfined: true })
    const confined = h.installed.get('read')!

    // There is no owner bypass: the sandbox belongs to the Session, so every turn reads through it.
    await expect(confined.execute({ file_path: 'x' }, { signal: undefined })).resolves.toBe('ran')
    expect(refresh).toHaveBeenCalledTimes(1)
    await expect(confined.execute({}, { signal: undefined })).rejects.toThrow('only use read with the paths')
    await expect(confined.execute('not a record', { signal: undefined })).rejects.toThrow('only use read with the paths')
    await expect(confined.execute({ file_path: 'outside' }, { signal: undefined })).rejects.toThrow('inside the workspace')
    await expect(confined.execute({ file_path: 'inside.ts' }, { signal: undefined })).resolves.toBe('ran')
    // Every call re-reads the grants before it consumes them, including one it then refuses.
    expect(refresh).toHaveBeenCalledTimes(5)
  })

  it('powers the admitted view surface through the read wrapper it actually installed', async () => {
    const h = sourceHarness({ tools: sharedToolNames('view') })
    installSourceSessionAccess(h.target as never)
    // The definition a Session would run is the wrapper, whose every path is resolved before the
    // deployment's own body sees it.
    await expect(h.call('read', { file_path: 'inside.ts', offset: 1 }))
      .resolves.toBe('ran')
    expect(h.fs.resolve).toHaveBeenCalledWith('inside.ts', expect.objectContaining({ cwd: '/granted' }))
  })

  it('keeps a view tool it could not register refused by the guard', () => {
    const h = sourceHarness({ tools: sharedToolNames('view'), registerThrows: 'glob' })
    const installed = installSourceSessionAccess(h.target as never)
    expect(installed).toMatchObject({ readConfined: true, registrationFailure: { tool: 'glob' } })
    expect(h.installed.has('glob')).toBe(false)
    const guard = h.guardFunction() as (execution: { readonly name: string }) => string | undefined
    expect(guard({ name: 'glob' })).toContain('may not use')
    expect(guard({ name: 'grep' })).toBeUndefined()
  })

  it('leaves a view tool the deployment does not ship uninstalled and refused', () => {
    const h = sourceHarness({ tools: ['read'] })
    installSourceSessionAccess(h.target as never)
    // Nothing casts the deployment's missing present tool into a permit: the guard only knows registered
    // names.
    const guard = h.guardFunction() as (execution: { readonly name: string }) => string | undefined
    expect(guard({ name: 'present' })).toContain('may not use')
    expect(h.installed.has('present')).toBe(false)
  })

  it('confines a source write under its share gate and policy', async () => {
    const h = sourceHarness({ tools: ['read', 'write'], writeGate: { mayWrite: () => true } })
    expect(installSourceSessionAccess(h.target as never)).toMatchObject({ readConfined: true, writeConfined: true })
    const confined = h.installed.get('write')!

    await expect(confined.execute({ file_path: 'inside.ts' }, { signal: undefined })).rejects.toThrow('named file with text content')
    await expect(confined.execute('not a record', { signal: undefined })).rejects.toThrow('named file with text content')
    await expect(confined.execute({ file_path: '../outside', content: 'x' }, { signal: undefined }))
      .rejects.toThrow('inside the workspace')
    const narrowing = sourceHarness({ tools: ['read', 'write'], writeGate: { mayWrite: vi.fn().mockReturnValueOnce(true).mockReturnValue(false) } })
    expect(installSourceSessionAccess(narrowing.target as never).writeConfined).toBe(true)
    await expect(narrowing.installed.get('write')!.execute({ file_path: 'inside.ts', content: 'x' }, { signal: undefined }))
      .rejects.toThrow('does not allow writing')

    const blocked = sourceHarness({ tools: ['read', 'write'], writeGate: { mayWrite: () => false } })
    installSourceSessionAccess(blocked.target as never)
    await expect(blocked.installed.get('write')!.execute({ file_path: 'inside.ts', content: 'x' }, { signal: undefined }))
      .rejects.toThrow('does not allow writing')

    h.target.write = { mayWrite: () => true }
    const result = await confined.execute({ file_path: 'inside.ts', content: 'hello' }, { signal: undefined })
    expect(result).toEqual({ path: 'inside.ts', operation: 'update', before: 'v0', after: 'v1' })
    expect(h.fs.writeText).toHaveBeenCalled()
  })

  it('confines a source edit through the same root check and policy', async () => {
    const h = sourceHarness({
      tools: ['read', 'write', 'edit'],
      writeGate: { mayWrite: vi.fn().mockReturnValue(true) },
    })
    expect(installSourceSessionAccess(h.target as never)).toMatchObject({ readConfined: true, writeConfined: true })
    const edit = h.installed.get('edit')!

    await expect(edit.execute({ file_path: 'inside.ts', old_string: '', new_string: 'b' }, { signal: undefined }))
      .rejects.toThrow('replacing non-empty text')
    await expect(edit.execute({ file_path: '', old_string: 'a', new_string: 'b' }, { signal: undefined }))
      .rejects.toThrow('replacing non-empty text')
    await expect(edit.execute({ file_path: 'inside.ts', old_string: 'a', new_string: 'a' }, { signal: undefined }))
      .rejects.toThrow('replacing non-empty text')
    await expect(edit.execute({ file_path: 'inside.ts', old_string: 'a' }, { signal: undefined }))
      .rejects.toThrow('replacing non-empty text')
    await expect(edit.execute({ file_path: 'outside.ts', old_string: 'a', new_string: 'b' }, { signal: undefined }))
      .rejects.toThrow('inside the workspace')
    // The intent comes from the shipped waterfall, and the edit is written under the Session policy.
    const result = await edit.execute({ file_path: 'inside.ts', old_string: 'old', new_string: 'new', replace_all: true }, { signal: undefined })
    expect(result).toEqual({ path: '/granted/inside.ts', before: 'old', after: 'new' })
    expect(h.context.waterfall).toHaveBeenCalledWith('fs/edit-intent', '/granted/inside.ts', expect.anything(), expect.any(Function))
    expect(h.fs.editText).toHaveBeenCalledWith(
      '/granted/inside.ts',
      { oldString: 'old', newString: 'new', replaceAll: true },
      undefined,
      undefined,
      expect.objectContaining({ workspaceRoot: '/granted' }),
    )

    // A gate already closed when the edit starts refuses before the arguments are even read.
    const closedEdit = sourceHarness({
      tools: ['read', 'write', 'edit'],
      writeGate: { mayWrite: () => false },
    })
    installSourceSessionAccess(closedEdit.target as never)
    await expect(closedEdit.installed.get('edit')!.execute({
      file_path: 'inside.ts', old_string: 'a', new_string: 'b',
    }, { signal: undefined })).rejects.toThrow('does not allow writing')
    // The replacement's own argument check refuses arguments it cannot read.
    await expect(edit.execute('not a record', { signal: undefined })).rejects.toThrow('replacing non-empty text')

    // A share that narrows while the edit intent awaits stops the edit before it reaches the backend.
    const narrowing = sourceHarness({
      tools: ['read', 'write', 'edit'],
      writeGate: { mayWrite: vi.fn().mockReturnValueOnce(true).mockReturnValue(false) },
    })
    installSourceSessionAccess(narrowing.target as never)
    await expect(narrowing.installed.get('edit')!.execute({
      file_path: 'inside.ts', old_string: 'a', new_string: 'b',
    }, { signal: undefined })).rejects.toThrow('does not allow writing')
    expect(narrowing.fs.editText).not.toHaveBeenCalled()
  })

  it('refuses a write it could not register without losing the read', () => {
    const h = sourceHarness({ tools: ['read', 'write'], writeGate: { mayWrite: () => true }, registerThrows: 'write' })
    expect(installSourceSessionAccess(h.target as never)).toMatchObject({
      readConfined: true, writeConfined: false, registrationFailure: { tool: 'write' },
    })
  })

  it('keeps a write share’s edit refused when only the edit replacement failed', () => {
    const h = sourceHarness({
      tools: sharedToolNames('write'),
      writeGate: { mayWrite: () => true },
      registerThrows: 'edit',
    })
    const installed = installSourceSessionAccess(h.target as never)
    expect(installed).toMatchObject({ readConfined: true, writeConfined: true, registrationFailure: { tool: 'edit' } })
    const guard = h.guardFunction() as (execution: { readonly name: string }) => string | undefined
    expect(guard({ name: 'edit' })).toContain('may not use')
    expect(guard({ name: 'write' })).toBeUndefined()
  })

  it('refuses a no-effect tool once another definition answers to its name', () => {
    const h = sourceHarness({ tools: [...sharedToolNames('view')] })
    installSourceSessionAccess(h.target as never)
    const guard = h.guardFunction() as (execution: { readonly name: string }) => string | undefined
    // The definition the installation found at install time is the one it vouches for.
    expect(guard({ name: 'todo_write' })).toBeUndefined()
    // A scope registration that replaces it later is a different tool under a permitted name.
    h.registered.set('todo_write', deploymentTool('todo_write'))
    expect(guard({ name: 'todo_write' })).toContain('may not use')
  })

  it('guards every tool but this installation’s replacements', () => {
    const h = sourceHarness({})
    installSourceSessionAccess(h.target as never)
    const provider = h.guardFunction() as ((execution: unknown) => unknown) | undefined
    expect(provider).toBeDefined()
    expect(provider?.({ arguments: {} })).toContain('may not use')
    expect(provider?.({ arguments: {}, name: 'other' })).toContain('may not use')
    expect(provider?.({ arguments: {}, name: 'read' })).toBeUndefined()
    // A view Session installs no write or edit name, so the guard refuses the deployment's own.
    expect(provider?.({ arguments: {}, name: 'write' })).toContain('may not use')
    expect(provider?.({ arguments: {}, name: 'edit' })).toContain('may not use')
    // A name the deployment has but this installation did not register is refused: the name is not
    // evidence that a constrained definition would run.
    expect(provider?.({ arguments: {}, name: 'glob' })).toContain('may not use')

    const writable = sourceHarness({ tools: ['read', 'write'], writeGate: { mayWrite: () => true } })
    installSourceSessionAccess(writable.target as never)
    const writableGuard = writable.guardFunction() as ((execution: unknown) => unknown) | undefined
    expect(writableGuard?.({ arguments: {}, name: 'write' })).toBeUndefined()
    expect(writableGuard?.({ arguments: {}, name: 'edit' })).toContain('may not use')
  })
})
