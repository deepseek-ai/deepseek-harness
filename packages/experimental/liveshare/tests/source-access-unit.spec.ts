/** Source Session access layering: refusals, preparation, turn control, and child authorization. */

import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activateSession, createSourceAccess } from '../src/host/source-access.ts'

const viewer = { providerId: 'p', tenantId: 't', subjectId: 'alice' }
const ROOT = '/granted'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

function share(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    shareId: 'share-1', sessionId: 'session-1', sessionTitle: 'Session', accessMode: 'open',
    relay: 'https://relay.example.test/liveshare', gatewayToken: 'token', allowedSubjectIds: [],
    createdAt: '2026-01-01T00:00:00Z', revision: 1, allowsFork: false, sessionMode: 'view', online: true,
    ...overrides,
  }
}

function liveAgent(session: Record<string, unknown> | undefined, context?: Context) {
  return {
    status: 'running',
    session,
    ...(context === undefined ? {} : { ctx: context }),
    cancel: vi.fn(),
  }
}

interface Options {
  readonly noScope?: boolean
  readonly session?: Record<string, unknown>
  readonly services?: readonly ('fs' | 'tools' | 'sandboxPolicy')[]
  readonly mode?: 'view' | 'write' | undefined
  readonly registeredTools?: Map<string, unknown>
}

function harness(options: Options = {}) {
  const base = new Context()
  // The deployment's own definitions live in `registered`; the layer's replacements shadow them in
  // `scoped`, so disposing a layer restores what the deployment registered rather than deleting it.
  const registered = new Map<string, unknown>([['read', {
    name: 'read', description: 'read', parameters: {}, output: { schema: {}, render: () => [] },
    execute: vi.fn(async () => 'read'),
  }]])
  const scoped = new Map<string, unknown>()
  const tools = {
    get: vi.fn((name: string) => scoped.get(name) ?? registered.get(name)),
    register: vi.fn((definition: { name: string }) => {
      scoped.set(definition.name, definition)
      return () => { scoped.delete(definition.name) }
    }),
    guard: vi.fn(() => () => {}),
  }
  const fs = {
    resolve: vi.fn(async () => `${ROOT}/file`),
    contains: vi.fn(() => true),
    processPath: vi.fn((path: string) => path),
    writeText: vi.fn(async () => ({ operation: 'update', before: 'v0', after: 'v1', version: 'v1' })),
  }
  const sandboxPolicy = { resolve: vi.fn(() => ({ mode: 'workspace-write', workspaceRoot: ROOT, sessionId: 'session-1' })) }
  const services = options.services ?? ['fs', 'tools', 'sandboxPolicy']
  if (services.includes('fs')) base.provide('fs', fs as never)
  if (services.includes('tools')) base.provide('tools', tools as never)
  if (services.includes('sandboxPolicy')) base.provide('sandboxPolicy', sandboxPolicy as never)
  const session = options.session ?? { id: 'session-1', header: { cwd: ROOT } }
  const scope = options.noScope === true ? undefined : createScope(base, { session: { id: 'session-1' } })
  const live = liveAgent(session, options.noScope === true ? new Context() : scope?.ctx)
  const agents = { get: vi.fn((id: string) => id === 'session-1' ? live : undefined), activate: vi.fn(async () => {}) }
  base.provide('agents', agents as never)
  const typertLookup = { resolve: vi.fn(async () => ({})) }
  base.provide('typert', { lookups: { get: () => typertLookup } } as never)
  const ownerShares = new Map<string, Record<string, unknown>>()
  const forks = {
    find: vi.fn((id: string): Record<string, unknown> | undefined => ({ childSessionId: id, shareId: 'share-1', creator: viewer, revokedAt: undefined })),
    listForShare: vi.fn(() => [{ childSessionId: 'child-1', shareId: 'share-1', creator: viewer }]),
  }
  const relay = {
    drivableModeOf: vi.fn((): 'view' | 'write' | undefined => options.mode === undefined ? 'view' : options.mode),
    viewerAdmitted: vi.fn(() => true),
    refreshRelayAccess: vi.fn(async () => {}),
    applyRelayAccess: vi.fn(),
    forgetRelayAccess: vi.fn(),
    invalidateRelayAccess: vi.fn(),
  }
  const state = { disposed: false }
  const access = createSourceAccess({
    ctx: base,
    ownerShares,
    forks,
    relay,
    disposed: () => state.disposed,
    accessChanged: vi.fn(),
  } as never)
  return {
    access, base, ownerShares, forks, relay, state,
    live, agents, scope, tools, fs, sandboxPolicy, registered, scoped, session, typertLookup,
  }
}

describe('source layer installation refusals', () => {
  it('refuses when the Session is not live or has no scope', async () => {
    const h = harness()
    const missing = await h.access.apply(share({ sessionId: 'other' }) as never)
    expect(missing).toEqual({ kind: 'refused', reason: 'no-live-session' })

    const unscoped = harness({ noScope: true })
    expect(await unscoped.access.apply(share() as never)).toEqual({ kind: 'refused', reason: 'no-session-scope' })
  })

  it('names each host service the layer cannot work without', async () => {
    for (const [service, reason] of [
      ['fs', 'no-filesystem'], ['tools', 'no-tool-registry'], ['sandboxPolicy', 'no-sandbox-policy'],
    ] as const) {
      const h = harness({ services: ['fs', 'tools', 'sandboxPolicy'].filter(name => name !== service) as never })
      expect(await h.access.apply(share() as never)).toEqual({ kind: 'refused', reason })
    }
  })

  it('refuses a Session without a granted root or working directory, or a root that will not resolve', async () => {
    const noRoot = harness({ session: { id: 'session-1', header: { cwd: ROOT } } })
    noRoot.sandboxPolicy.resolve.mockReturnValue({} as never)
    expect(await noRoot.access.apply(share() as never)).toEqual({ kind: 'refused', reason: 'no-workspace-root' })

    const noCwd = harness({ session: { id: 'session-1', header: {} } })
    expect(await noCwd.access.apply(share() as never)).toEqual({ kind: 'refused', reason: 'no-session-cwd' })

    const unresolved = harness()
    unresolved.fs.resolve.mockRejectedValueOnce(new Error('missing'))
    expect(await unresolved.access.apply(share() as never)).toEqual({ kind: 'refused', reason: 'workspace-unresolved' })
  })

  it('refuses a share removed or reassigned while the workspace resolved', async () => {
    const h = harness()
    h.fs.resolve.mockImplementationOnce(async () => {
      h.ownerShares.clear()
      return `${ROOT}/file`
    })
    expect(await h.access.apply(share() as never)).toEqual({ kind: 'refused', reason: 'share-gone' })

    const reassigned = harness()
    reassigned.ownerShares.set('share-1', share({ sessionId: 'other-session' }))
    expect(await reassigned.access.apply(share() as never)).toEqual({ kind: 'refused', reason: 'share-reassigned' })
  })

  it('installs a usable layer, keeps it for the same tier, and reports its refusal codes', async () => {
    const h = harness()
    h.ownerShares.set('share-1', share())
    const installed = await h.access.apply(share() as never)
    expect(installed).toMatchObject({ kind: 'installed', installation: { readConfined: true } })
    expect(h.access.confined('share-1')).toBe(true)
    expect(h.access.confinementRefusal('share-1')).toBeUndefined()

    const kept = await h.access.apply(share() as never)
    expect(kept).toMatchObject({ kind: 'kept' })

    expect(h.access.confinementRefusal('absent')).toBe('share-unknown')
    h.relay.drivableModeOf.mockReturnValue(undefined)
    expect(h.access.confinementRefusal('share-1')).toBe('share-mode-unknown')
  })

  it('reports the refusal recorded on an installation that confined no read', async () => {
    const h = harness()
    h.ownerShares.set('share-1', share())
    h.registered.clear()
    h.tools.get.mockReturnValue(undefined)
    const outcome = await h.access.apply(share() as never)
    expect(outcome).toMatchObject({ kind: 'installed', installation: { readConfined: false, refusal: 'tool-unavailable' } })
    expect(h.access.confined('share-1')).toBe(false)
    expect(h.access.refusalOf('share-1')).toBe('tool-unavailable')
    expect(h.access.confinementRefusal('share-1')).toBe('layer-read-unconfined')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('source session not confined'))
  })

  it('states a write layer whose replacement could not register, and logs debug outcomes', async () => {
    vi.stubEnv('LIVESHARE_VIEWER_DEBUG', '1')
    const h = harness({ mode: 'write' })
    h.ownerShares.set('share-1', share({ sessionMode: 'write' }))
    h.registered.set('write', { name: 'write', description: 'write', parameters: {}, output: { schema: {}, render: () => [] } })
    h.tools.register.mockImplementation((definition: { name: string }) => {
      if (definition.name === 'write') throw new Error('duplicate write')
      h.registered.set(definition.name, definition)
      return () => { h.registered.delete(definition.name) }
    })
    const outcome = await h.access.apply(share({ sessionMode: 'write' }) as never)
    expect(outcome).toMatchObject({ kind: 'installed', installation: { readConfined: true, writeConfined: false } })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('write not confined'))

    const clean = harness({ mode: 'write' })
    clean.ownerShares.set('share-1', share({ sessionMode: 'write' }))
    clean.registered.set('write', { name: 'write', description: 'write', parameters: {}, output: { schema: {}, render: () => [] } })
    await clean.access.apply(share({ sessionMode: 'write' }) as never)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('source access installed'))
  })

  it('logs an unconfined read with its registration error and a non-Error cause', async () => {
    const h = harness()
    h.ownerShares.set('share-1', share())
    h.tools.register.mockImplementation((definition: { name: string }) => {
      throw definition.name === 'read' ? 'plain read failure' : new Error('unexpected')
    })
    const outcome = await h.access.apply(share() as never)
    expect(outcome).toMatchObject({ kind: 'installed', installation: { readConfined: false, registrationFailure: { tool: 'read' } } })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('plain read failure'))
  })

  it('drives the confined write through the Session’s current grants', async () => {
    const h = harness({ mode: 'write' })
    h.ownerShares.set('share-1', share({ sessionMode: 'write' }))
    h.registered.set('write', { name: 'write', description: 'write', parameters: {}, output: { schema: {}, render: () => [] } })
    await h.access.apply(share({ sessionMode: 'write' }) as never)
    const write = h.scoped.get('write') as { execute: (args: unknown, exec: unknown) => Promise<unknown> }
    await expect(write.execute({ file_path: 'file', content: 'text' }, {
      arguments: { file_path: 'file' }, agent: { id: 'session-1', session: h.session }, signal: undefined,
    })).resolves.toBeDefined()
    // The refresh reads the grants of the shares that keep this Session drivable.
    expect(h.relay.refreshRelayAccess).toHaveBeenCalledWith('share-1')
  })

  it('reports the refusal code a share with no recorded layer carries', () => {
    const h = harness()
    expect(h.access.refusalOf('absent')).toBeUndefined()
    expect(h.access.confinementRefusal('absent')).toBe('share-unknown')
  })

  it('names the refused guard in debug mode', async () => {
    vi.stubEnv('LIVESHARE_VIEWER_DEBUG', '1')
    const h = harness()
    await h.access.apply(share({ sessionId: 'other' }) as never)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('source access not installed'))
  })

  it('refuses a live context without a session scope', async () => {
    const h = harness({ noScope: true })
    expect(await h.access.apply(share() as never)).toEqual({ kind: 'refused', reason: 'no-session-scope' })
  })

  it('refuses a tier that changed while the workspace resolved, and keeps a concurrent layer', async () => {
    const h = harness({ mode: 'write' })
    h.ownerShares.set('share-1', share({ sessionMode: 'write' }))
    h.fs.resolve.mockImplementationOnce(async () => {
      // The only share over the Session narrowed while the workspace resolved.
      h.ownerShares.set('share-1', share({ sessionMode: 'view' }))
      return `${ROOT}/file`
    })
    expect(await h.access.apply(share({ sessionMode: 'write' }) as never))
      .toEqual({ kind: 'refused', reason: 'share-mode-changed' })

    const concurrent = harness()
    concurrent.ownerShares.set('share-1', share())
    let release: (() => void) | undefined
    concurrent.fs.resolve.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => { resolve(`${ROOT}/file`) }
    }))
    const slow = concurrent.access.apply(share() as never)
    await Promise.resolve()
    // Another attempt finishes first and records the layer.
    await concurrent.access.apply(share() as never)
    release?.()
    expect(await slow).toMatchObject({ kind: 'kept' })
  })

  it('reinstalls a write tier whose recorded layer confined no write', async () => {
    const h = harness({ mode: 'write' })
    h.ownerShares.set('share-1', share({ sessionMode: 'write' }))
    h.registered.delete('write')
    await h.access.apply(share({ sessionMode: 'write' }) as never)
    expect(h.access.confinementRefusal('share-1')).toBe('layer-write-unconfined')
    h.registered.set('write', { name: 'write', description: 'write', parameters: {}, output: { schema: {}, render: () => [] } })
    expect(await h.access.apply(share({ sessionMode: 'write' }) as never)).toMatchObject({ kind: 'installed' })
  })
})

describe('turn and tool helpers', () => {
  it('stops the running turn of a share that ends, whoever started it', () => {
    const h = harness()
    h.access.cancelShareTurn('absent')
    h.ownerShares.set('share-1', share())
    h.access.cancelShareTurn('share-1')
    expect(h.live.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    h.live.cancel.mockClear()
    // A share that is not being served by a running Session stops nothing.
    h.live.status = 'idle'
    h.access.cancelShareTurn('share-1')
    expect(h.live.cancel).not.toHaveBeenCalled()
  })

  it('releases the Session’s layer once none of its shares is active', async () => {
    const h = harness()
    const granted = share()
    h.ownerShares.set('share-1', granted)
    await h.access.apply(granted as never)
    expect(h.access.confined('share-1')).toBe(true)

    h.ownerShares.clear()
    h.access.reconcileSessionAccess('session-1')
    expect(h.access.confinementRefusal('share-1')).toBe('share-unknown')
    // A Session with neither shares nor a layer reconciles to nothing.
    h.access.reconcileSessionAccess('session-1')
    h.ownerShares.set('share-1', granted)
    expect(h.access.confinementRefusal('share-1')).toBe('layer-absent')
  })

  it('releases a layer whose only share passes its deadline', async () => {
    const h = harness()
    const expiring = share({ expiresAt: '2000-01-01T00:00:00.000Z' })
    h.ownerShares.set('share-1', expiring)
    // A record past its deadline installs nothing, so the Session keeps its own tools.
    expect(await h.access.apply(expiring as never)).toEqual({ kind: 'refused', reason: 'share-inactive' })
  })

  it('re-installs the read-only layer when the last write share narrows to view', async () => {
    const h = harness({ mode: 'write' })
    const writable = share({ sessionMode: 'write' })
    h.ownerShares.set('share-1', writable)
    h.registered.set('write', { name: 'write', description: 'write', parameters: {}, output: { schema: {}, render: () => [] } })
    expect(await h.access.apply(writable as never)).toMatchObject({ kind: 'installed', installation: { writeConfined: true } })

    h.relay.drivableModeOf.mockReturnValue('view')
    h.ownerShares.set('share-1', share({ sessionMode: 'view' }))
    h.access.reconcileSessionAccess('session-1')
    await vi.waitFor(() => { expect(h.access.confined('share-1')).toBe(true) })
    // The write name is gone from the Session's layer, and so is the bounded write behind it.
    expect(h.scoped.has('write')).toBe(false)
    expect(h.scoped.has('read')).toBe(true)
  })

  it('does not prepare a layer that is already usable', async () => {
    const h = harness()
    h.ownerShares.set('share-1', share())
    await h.access.apply(share() as never)
    await expect(h.access.prepareSourceSession('session-1', 'prompt')).resolves.toBeUndefined()
  })

  it('starts one preparation per Session while another is in flight', async () => {
    const h = harness()
    const deferred = Promise.withResolvers<Record<string, unknown>>()
    h.typertLookup.resolve.mockReturnValueOnce(deferred.promise)
    h.ownerShares.set('share-1', share())
    h.access.prepareSourceForReader('share-1')
    h.access.prepareSourceForReader('share-1')
    deferred.resolve({})
    await vi.waitFor(() => { expect(h.typertLookup.resolve).toHaveBeenCalledTimes(1) })
  })

  it('reads the paths each admitted tool call names', () => {
    const h = harness()
    const paths = (name: string, args: unknown) => h.access.forkToolPaths({ name, arguments: args })
    expect(paths('read', { file_path: 'x' })).toEqual({ paths: ['x'], noFileEffect: false })
    expect(paths('read', { file_path: '' })).toEqual({ paths: undefined, noFileEffect: false })
    expect(paths('read', 'plain')).toEqual({ paths: undefined, noFileEffect: false })
    expect(paths('read_image', { file_path: 'img.png' })).toEqual({ paths: ['img.png'], noFileEffect: false })
    // A pathless search names no path of its own: the host supplies the workspace default.
    expect(paths('glob', { pattern: '**/*.ts' })).toEqual({ paths: [], noFileEffect: false })
    expect(paths('grep', { pattern: 'x', path: 'src' })).toEqual({ paths: ['src'], noFileEffect: false })
    expect(paths('grep', { pattern: 'x', path: '' })).toEqual({ paths: undefined, noFileEffect: false })
    expect(paths('present', { files: [{ path: 'a.ts' }, { path: 'b.ts' }] }))
      .toEqual({ paths: ['a.ts', 'b.ts'], noFileEffect: false })
    expect(paths('present', { files: [{ path: 'a.ts' }, { description: 'no path' }] }))
      .toEqual({ paths: undefined, noFileEffect: false })
    // No-filesystem-effect tools declare that instead of naming paths.
    expect(paths('todo_write', { todos: [] })).toEqual({ paths: [], noFileEffect: true })
    expect(paths('skill', { name: 'one' })).toEqual({ paths: [], noFileEffect: true })
    // A name the surface does not admit establishes no path, so its ceiling decision is the only answer.
    expect(paths('bash', { command: 'ls' })).toEqual({ paths: undefined, noFileEffect: false })
  })

  it('reports why activation cannot run', async () => {
    const bare = new Context()
    await expect(activateSession(bare, 'session-1')).rejects.toThrow('no agent lookup')
    const unresolved = new Context()
    unresolved.provide('typert', { lookups: { get: () => ({ resolve: async () => undefined }) } } as never)
    await expect(activateSession(unresolved, 'session-1')).rejects.toThrow('answered with nothing')
  })
})

describe('child and turn control', () => {
  it('cancels only the child turns of the named share and viewer', () => {
    const h = harness()
    const cancel = vi.fn()
    h.agents.get.mockImplementation(((id: string) => id === 'session-1' ? h.live : { cancel }) as never)
    h.forks.listForShare.mockReturnValue([
      { childSessionId: 'mine', shareId: 'share-1', creator: viewer },
      { childSessionId: 'theirs', shareId: 'share-1', creator: { ...viewer, subjectId: 'bob' } },
    ] as never)
    h.access.cancelChildTurns('share-1', viewer)
    expect(cancel).toHaveBeenCalledTimes(1)
    h.access.cancelChildTurns('share-1')
    expect(cancel).toHaveBeenCalledTimes(3)
  })

  it('authorizes a child only while its share still admits it and its tier allows the tool', () => {
    const h = harness({ mode: 'view' })
    h.ownerShares.set('share-1', share())
    expect(h.access.childToolAuthorized('child-1', 'read')).toBe(true)
    expect(h.access.childToolAuthorized('child-1', 'grep')).toBe(true)
    expect(h.access.childToolAuthorized('child-1', 'todo_write')).toBe(true)
    expect(h.access.childToolAuthorized('child-1', 'write')).toBe(false)
    expect(h.access.childToolAuthorized('child-1', 'edit')).toBe(false)
    expect(h.access.childToolAuthorized('child-1', 'bash')).toBe(false)
    expect(h.access.childToolAuthorized('child-1', 'ghost')).toBe(false)
    h.relay.drivableModeOf.mockReturnValue('write')
    expect(h.access.childToolAuthorized('child-1', 'write')).toBe(true)
    expect(h.access.childToolAuthorized('child-1', 'edit')).toBe(true)
    h.forks.find.mockReturnValue(undefined)
    expect(h.access.childToolAuthorized('absent', 'read')).toBe(false)
    h.forks.find.mockReturnValue({ childSessionId: 'child-1', shareId: 'share-1', creator: viewer, revokedAt: 'now' })
    expect(h.access.childToolAuthorized('child-1', 'read')).toBe(false)
    h.forks.find.mockReturnValue({ childSessionId: 'child-1', shareId: 'share-1', creator: viewer })
    h.relay.viewerAdmitted.mockReturnValue(false)
    expect(h.access.childToolAuthorized('child-1', 'read')).toBe(false)
    h.relay.viewerAdmitted.mockReturnValue(true)
    h.relay.drivableModeOf.mockReturnValue(undefined)
    expect(h.access.childToolAuthorized('child-1', 'read')).toBe(false)
    h.relay.drivableModeOf.mockReturnValue('view')
    h.ownerShares.get('share-1')!.expiresAt = '2000-01-01T00:00:00Z'
    expect(h.access.childToolAuthorized('child-1', 'read')).toBe(false)
  })

})

describe('preparation', () => {
  it('prepares a source Session only while a share names it and needs a layer', async () => {
    const h = harness()
    await expect(h.access.prepareSourceSession('absent', 'prompt')).resolves.toBeUndefined()
    h.ownerShares.set('share-1', share())
    h.agents.get.mockReturnValue(h.live)
    await h.access.prepareSourceSession('session-1', 'prompt')
    expect(h.access.confined('share-1')).toBe(true)
  })

  it('prepares from a reader request only for a share that needs it and is not already preparing', async () => {
    const h = harness()
    h.access.prepareSourceForReader('absent')
    h.state.disposed = true
    h.access.prepareSourceForReader('share-1')
    h.state.disposed = false
    h.ownerShares.set('share-1', share())
    h.relay.drivableModeOf.mockReturnValue(undefined)
    h.access.prepareSourceForReader('share-1')
    // A preparation that rejects is reported and leaves the share refused.
    const failing = harness()
    failing.ownerShares.set('share-1', share())
    failing.typertLookup.resolve.mockRejectedValueOnce(new Error('activation failed'))
    failing.access.prepareSourceForReader('share-1')
    await vi.waitFor(() => { expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('preparing the source failed')) })

    // A prepared share with no live agent installs nothing and stays unconfined.
    const unlive = harness()
    unlive.ownerShares.set('share-1', share())
    unlive.agents.get.mockReturnValue(undefined)
    unlive.access.prepareSourceForReader('share-1')
    await vi.waitFor(() => { expect(vi.mocked(console.warn).mock.calls.length).toBeGreaterThan(0) })
    expect(unlive.access.confined('share-1')).toBe(false)
  })
})
