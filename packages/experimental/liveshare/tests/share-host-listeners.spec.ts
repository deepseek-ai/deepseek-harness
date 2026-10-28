/** Share-host assembly: configuration guards, agent listeners, and owner state projection. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, publishedShareState, type Config, type OwnerShare } from '../src/host/share-host.ts'
import type { ForkToolExecution } from '../src/host/fork-tool-guard.ts'
import { FakeTunnelWorker } from './tunnel-supervision-fake-worker.ts'
import { shareViewerPrincipal } from '../src/host/viewer-principal.ts'

vi.mock('../src/host/tunnel-worker.ts', async () => {
  const { FakeTunnelWorker: Fake } = await import('./tunnel-supervision-fake-worker.ts')
  return { TunnelWorker: Fake }
})

const RELAY = 'https://relay.example.test/liveshare'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
  FakeTunnelWorker.instances.length = 0
})

function stateFile(options: {
  readonly shares?: readonly Record<string, unknown>[]
  readonly forks?: readonly Record<string, unknown>[]
  /** Saved address; `null` stores none, and the default saves RELAY. */
  readonly relayUrl?: string | null
} = {}): { readonly file: string; readonly forkFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'liveshare-host-listeners-'))
  roots.push(root)
  const file = join(root, 'owner-shares.json')
  const relayUrl = options.relayUrl === undefined ? RELAY : options.relayUrl
  writeFileSync(file, JSON.stringify({
    ...(relayUrl === null ? {} : { relayUrl }),
    shares: (options.shares ?? []).map(share => relayUrl === null ? share : { relay: relayUrl, ...share }),
  }))
  if (options.forks !== undefined) {
    writeFileSync(join(root, 'forks.json'), JSON.stringify({ version: 1, forks: options.forks }))
  }
  return { file, forkFile: join(root, 'forks.json') }
}

function stored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    shareId: 'share-1', sessionId: 'session-1', sessionTitle: 'Session', accessMode: 'open',
    gatewayToken: 'token', allowedSubjectIds: [], createdAt: '2026-01-01T00:00:00Z',
    allowsFork: false, sessionMode: 'view', online: false, ...overrides,
  }
}

function forkRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    childSessionId: 'child-1', shareId: 'share-1', sourceSessionId: 'session-1', boundary: 1,
    creator: { providerId: 'p', tenantId: 't', subjectId: 'alice' }, createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

interface Mounted {
  readonly ctx: Context
  readonly handlers: Map<string, (...args: unknown[]) => Promise<unknown>>
  readonly routes: Map<string, (...args: never[]) => unknown>
}

async function mount(
  config: Partial<Config> & {
    readonly state?: ReturnType<typeof stateFile>
    /** Mount with no owner state file configured, so the DSH_HOME default is read. */
    readonly useDshHome?: boolean
  } = {},
): Promise<Mounted> {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const routes = new Map<string, (...args: never[]) => unknown>()
  const ctx = Object.assign(new Context(), {
    connection: {
      authenticatedUrl: () => 'http://127.0.0.1:3092/?token=test',
      fetch: {
        register: (route: { readonly path: string; readonly fetch: (...args: never[]) => unknown }) => {
          routes.set(route.path, route.fetch)
          return Promise.resolve(async () => {})
        },
      },
    },
    webServer: { port: 3092 },
  })
  const originalOn = ctx.on.bind(ctx)
  ctx.on = ((name: string, listener: (...args: never[]) => unknown) => {
    if (!handlers.has(name)) handlers.set(name, listener as (...args: unknown[]) => Promise<unknown>)
    return originalOn(name as never, listener as never)
  }) as never
  const { state, useDshHome, ...rest } = config
  const files = state ?? stateFile()
  await apply(ctx, {
    ...(useDshHome === true ? {} : { ownerStateFile: files.file }),
    ...rest,
  })
  return { ctx, handlers, routes }
}

describe('configuration guards', () => {
  it('refuses missing or unusable configuration at load', async () => {
    const base = { connection: { fetch: { register: () => Promise.resolve(async () => {}) } } }
    await expect(apply(Object.assign(new Context(), base), {
      allowedSubjectIds: [''], ownerStateFile: stateFile().file,
    })).rejects.toThrow('allowedSubjectIds must not contain an empty subject')
    await expect(apply(Object.assign(new Context(), base), { ownerStateFile: '' }))
      .rejects.toThrow('ownerStateFile must not be empty')
    await expect(apply(Object.assign(new Context(), base), {
      ownerIdentityProvider: 'p', ownerStateFile: stateFile().file,
    })).rejects.toThrow('ownerIdentity fields require provider, tenant, and subject')
  })

  it('resolves the owner identity from complete fields', async () => {
    const mounted = await mount({
      ownerIdentityProvider: 'p', ownerIdentityTenant: 't', ownerIdentitySubject: 'owner',
      ownerIdentityDisplayName: 'Named Owner',
    })
    await expect(mounted.ctx.liveshareShares.identity({ relay: RELAY })).resolves.toBeDefined()
    await mounted.ctx.fiber.dispose()
  })

  it('publishes a share record with and without optional fields', async () => {
    // An owner record that names no plugin endpoints, deadline, or tier still publishes the facts the
    // reader decides against, with the optional fields absent rather than defaulted.
    // A record restored from an older owner state carries no tier; drop it after typing the record so
    // the published facts show the field absent rather than defaulted.
    const legacy: OwnerShare = {
      shareId: 'share-1', sessionId: 'session-1', sessionTitle: 'Session', accessMode: 'open',
      gatewayToken: 'token', allowedSubjectIds: [], createdAt: '2026-01-01T00:00:00Z',
      allowsFork: false, online: false, link: '', relay: RELAY, revision: 0, sessionMode: 'view',
    }
    delete (legacy as { sessionMode?: OwnerShare['sessionMode'] }).sessionMode
    expect(publishedShareState(legacy)).toEqual({
      shareId: 'share-1', sessionId: 'session-1', allowsFork: false, viewerAdmitted: true,
      stopped: false, sessionMode: undefined,
    })
    expect(publishedShareState({
      shareId: 'share-2', sessionId: 'session-2', sessionTitle: 'Session', accessMode: 'open',
      gatewayToken: 'token', allowedSubjectIds: [], createdAt: '2026-01-01T00:00:00Z',
      allowsFork: true, online: true, link: '', relay: RELAY, revision: 0,
      sessionMode: 'write', expiresAt: '2026-01-02T00:00:00Z',
      viewerCapabilities: [{ plugin: 'mekGit', readable: ['mekGit/getGraph'], writable: [] }],
    })).toMatchObject({
      viewerCapabilities: [{ plugin: 'mekGit', readable: ['mekGit/getGraph'], writable: [] }],
      expiresAt: '2026-01-02T00:00:00Z',
    })
  })

  it('derives its default owner state file from DSH_HOME', async () => {
    const root = mkdtempSync(join(tmpdir(), 'liveshare-dsh-home-'))
    roots.push(root)
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('LIVESHARE_OWNER_STATE_FILE', '')
    vi.stubEnv('LIVESHARE_OWNER_CREDENTIAL_FILE', '')
    const mounted = await mount({ useDshHome: true })
    expect(mounted.routes.size).toBeGreaterThan(0)
    await mounted.ctx.fiber.dispose()
  })

  it('falls back to the user home when neither DSH_HOME nor a state file is named', async () => {
    const root = mkdtempSync(join(tmpdir(), 'liveshare-home-'))
    roots.push(root)
    vi.stubEnv('HOME', root)
    vi.stubEnv('DSH_HOME', '')
    vi.stubEnv('LIVESHARE_OWNER_STATE_FILE', '')
    vi.stubEnv('LIVESHARE_OWNER_CREDENTIAL_FILE', '')
    const mounted = await mount({ useDshHome: true })
    expect(mounted.routes.size).toBeGreaterThan(0)
    await mounted.ctx.fiber.dispose()
  })

  it('names an owner identity without a display name by its subject', async () => {
    const mounted = await mount({ ownerIdentityProvider: 'p', ownerIdentityTenant: 't', ownerIdentitySubject: 'owner' })
    await expect(mounted.ctx.liveshareShares.identity({ relay: RELAY })).resolves.toBeDefined()
    await mounted.ctx.fiber.dispose()
  })


  it('drops a startup claim that answers after the host was disposed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'liveshare-claim-late-'))
    roots.push(root)
    const state = join(root, 'owner-shares.json')
    writeFileSync(state, JSON.stringify({
      instanceId: 'owner', relayUrl: RELAY, shares: [{ relay: RELAY, ...stored() }],
    }))
    writeFileSync(join(root, 'owner-credential.json'), JSON.stringify({ relay: RELAY, credential: 'token' }))
    const claim = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const request = new Request(input)
      if (request.url.endsWith('/owner-credential')) return Promise.resolve(Response.json({ supported: true }))
      return claim.promise
    }))
    const mounted = await mount({ state: { file: state, forkFile: join(root, 'forks.json') } })
    await mounted.ctx.fiber.dispose()
    // The pass was in flight when this host went away, so its answer is not recorded anywhere.
    claim.resolve(Response.json({ claimed: true }))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })

  it('reports the saved Relay address', async () => {
    const files = stateFile({ relayUrl: 'https://override.example.test/liveshare' })
    const mounted = await mount({ state: files })
    expect(mounted.ctx.liveshareShares.relay()).toEqual({
      override: 'https://override.example.test/liveshare',
      effective: 'https://override.example.test/liveshare',
    })
    await mounted.ctx.fiber.dispose()
  })

  it('loads with no saved address and refuses to publish before one exists', async () => {
    const mounted = await mount({ state: stateFile({ relayUrl: null }) })

    // A host without an address is a valid composition: the sharing surfaces load and say so.
    expect(mounted.ctx.liveshareShares.relay()).toEqual({})
    await expect(mounted.ctx.liveshareShares.create({ sessionId: 'session-1' }))
      .rejects.toMatchObject({ code: 'liveshareShares/relay-url-required' })
    await expect(mounted.ctx.liveshareShares.identity({}))
      .rejects.toMatchObject({ code: 'liveshareShares/relay-url-required' })
    await mounted.ctx.fiber.dispose()
  })
})

describe('agent created listener', () => {
  function agentFor(id: string, session = { id: 'session-1', header: { cwd: '/workspace' } }): Record<string, unknown> {
    const scope = new Context()
    return { id, session, ctx: scope }
  }

  it('installs a published share layer and ignores an unrecorded child', async () => {
    const mounted = await mount({ state: stateFile({ shares: [stored()] }) })
    const listener = mounted.handlers.get('agent/created')
    expect(listener).toBeDefined()
    await expect(listener?.({ agent: agentFor('session-1') })).resolves.toBeUndefined()
    await expect(listener?.({ agent: { id: 'unrecorded', session: { id: 'session-2', header: {} }, ctx: new Context() } }))
      .resolves.toBeUndefined()
    await mounted.ctx.fiber.dispose()
  })

  it('refuses a revoked child and one it cannot limit', async () => {
    const revoked = await mount({ state: stateFile({ shares: [stored()], forks: [forkRecord({ revokedAt: 'now' })] }) })
    await expect(revoked.handlers.get('agent/created')?.({ agent: agentFor('child-1') }))
      .rejects.toThrow('no longer active')
    await revoked.ctx.fiber.dispose()

    const unlimited = await mount({ state: stateFile({ shares: [stored()], forks: [forkRecord()] }) })
    await expect(unlimited.handlers.get('agent/created')?.({ agent: agentFor('child-1') }))
      .rejects.toThrow('could not be given read-only limits')
    await unlimited.ctx.fiber.dispose()
  })
})

describe('viewer turn confinement', () => {
  /**
   * Mount a host whose source Session can actually install its layer: a live scoped Agent and the four
   * services the layer reads. The captured guard is what the real tool pipeline would consult.
   */
  async function mountedSource() {
    const mounted = await mount({ state: stateFile({ shares: [stored()] }) })
    const root = '/workspace'
    const registered = new Map<string, ToolDefinition>()
    let guard: ((execution: ForkToolExecution) => string | undefined) | undefined
    const read: ToolDefinition = {
      name: 'read', description: 'a deployment read', parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
      },
      execute: () => Promise.resolve('read ran'),
    }
    registered.set('read', read)
    const scope = createScope(mounted.ctx, { session: 'session-1' })
    const live = {
      id: 'session-1',
      session: { id: 'session-1', header: { cwd: root } },
      ctx: scope.ctx,
    }
    mounted.ctx.provide('agents', { get: (id: string) => id === 'session-1' ? live : undefined } as never)
    mounted.ctx.provide('fs', {
      resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
      contains: () => true,
      processPath: (path: string) => path,
      writeText: async () => ({ operation: 'update', before: null, after: 'v1', version: 'v1' }),
      editText: async () => ({ before: null, after: 'v1', version: 'v1' }),
    } as never)
    mounted.ctx.provide('tools', {
      get: (name: string) => registered.get(name),
      register: (definition: ToolDefinition) => {
        registered.set(definition.name, definition)
        return () => { registered.delete(definition.name) }
      },
      guard: (registeredGuard: (execution: ForkToolExecution) => string | undefined) => {
        guard = registeredGuard
        return () => { guard = undefined }
      },
    } as never)
    mounted.ctx.provide('sandboxPolicy', {
      resolve: () => ({ mode: 'read-only', workspaceRoot: root, sessionId: 'session-1' }),
    } as never)
    await mounted.handlers.get('agent/created')?.({ agent: live })
    return { mounted, live, guard: () => guard }
  }

  const viewerMessage = {
    source: { kind: 'user' as const, principal: shareViewerPrincipal('share-1', { providerId: 'p', tenantId: 't', subjectId: 'alice' }) },
  }
  const ownerMessage = { source: { kind: 'user' as const } }

  it('confines a viewer-started turn, keeps an owner’s turn native, and keeps owner steering confined', async () => {
    const { mounted, live, guard } = await mountedSource()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      version: 1, accessMode: 'open', allowedSubjectIds: [], sessionMode: 'view', requests: [],
    })))
    const preStep = mounted.handlers.get('agent/pre-step')
    const runStep = (turn: number, messages: readonly unknown[]) =>
      preStep?.({ agent: live, turn, signal: new AbortController().signal, messages }, async () => ({
        kind: 'enter', messages,
      }))

    // A viewer-started turn is confined: the shell is not a name this installation replaced.
    await expect(runStep(1, [viewerMessage])).resolves.toMatchObject({ kind: 'enter' })
    expect(guard()?.({ name: 'bash', arguments: { command: 'ls' }, agent: live })).toMatch(/may not use bash/u)
    // The owner's steering input joins that same turn, which stays confined.
    await expect(runStep(1, [ownerMessage])).resolves.toMatchObject({ kind: 'enter' })
    expect(guard()?.({ name: 'bash', arguments: { command: 'ls' }, agent: live })).toMatch(/may not use bash/u)

    // The next turn is the owner's: the deployment's own tools run, unchanged by the mounted layer.
    await expect(runStep(2, [ownerMessage])).resolves.toMatchObject({ kind: 'enter' })
    expect(guard()?.({ name: 'bash', arguments: { command: 'ls' }, agent: live })).toBeUndefined()
    // An execution this host cannot attribute to an Agent is confined rather than escaping the layer.
    expect(guard()?.({ name: 'bash', arguments: { command: 'ls' }, agent: { id: 42 } }))
      .toMatch(/may not use bash/u)
    // A viewer message in a later step of the owner's running turn narrows that same turn.
    await expect(runStep(2, [viewerMessage])).resolves.toMatchObject({ kind: 'enter' })
    expect(guard()?.({ name: 'bash', arguments: { command: 'ls' }, agent: live })).toMatch(/may not use bash/u)
    // A viewer's later turn is confined again.
    await expect(runStep(3, [viewerMessage])).resolves.toMatchObject({ kind: 'enter' })
    expect(guard()?.({ name: 'bash', arguments: { command: 'ls' }, agent: live })).toMatch(/may not use bash/u)
    await mounted.ctx.fiber.dispose()
  })
})

describe('agent pre-step gate', () => {
  const decision = { kind: 'enter', messages: [] }
  const next = async () => decision

  it('passes a decision it does not need to gate', async () => {
    const mounted = await mount()
    const listener = mounted.handlers.get('agent/pre-step')
    await expect(listener?.({ agent: { session: { id: 'child-1' } }, turn: 1 }, async () => ({ kind: 'reject' })))
      .resolves.toEqual({ kind: 'reject' })
    await expect(listener?.({ agent: { session: { id: 'session-1' } }, turn: 1 }, next)).resolves.toEqual(decision)
    await mounted.ctx.fiber.dispose()
  })

  it('admits a reader-owned turn of its own recorded child', async () => {
    const mounted = await mount({ state: stateFile({ shares: [stored()], forks: [forkRecord()] }) })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      version: 1, accessMode: 'open', allowedSubjectIds: [], sessionMode: 'view', requests: [],
    })))
    const decision = {
      kind: 'enter' as const,
      messages: [{
        source: {
          kind: 'user',
          principal: shareViewerPrincipal('share-1', { providerId: 'p', tenantId: 't', subjectId: 'alice' }),
        },
      }],
    }

    await expect(mounted.handlers.get('agent/pre-step')?.(
      { agent: { session: { id: 'child-1' } }, turn: 1 },
      async () => decision,
    )).resolves.toEqual(decision)
    await mounted.ctx.fiber.dispose()
  })

  it('refuses queued input for a child without a live limit', async () => {
    const mounted = await mount({ state: stateFile({ shares: [stored()], forks: [forkRecord({ revokedAt: 'now' })] }) })
    await expect(mounted.handlers.get('agent/pre-step')?.({ agent: { session: { id: 'child-1' } }, turn: 1 }, next))
      .resolves.toEqual({ kind: 'reject' })
    await mounted.ctx.fiber.dispose()
  })


  it('leaves a queued message from a principal this package does not drive alone', async () => {
    const mounted = await mount()
    const decision = { kind: 'enter' as const, messages: [{ source: { kind: 'user', principal: { kind: 'owner' } } }] }
    await expect(mounted.handlers.get('agent/pre-step')?.(
      { agent: { session: { id: 'session-1' } }, turn: 1 },
      async () => decision,
    )).resolves.toEqual(decision)
    await mounted.ctx.fiber.dispose()
  })

  it('refuses a reader-owned turn that names a Session this share does not reach', async () => {
    const mounted = await mount({ state: stateFile({ shares: [stored()] }) })
    const actor = { providerId: 'p', tenantId: 't', subjectId: 'alice' }
    // The Relay still admits this reader, but the step drives a Session the share neither names nor
    // reached through a fork of this reader.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      version: 1, accessMode: 'open', allowedSubjectIds: [], sessionMode: 'view', requests: [],
    })))
    const decision = { kind: 'enter' as const, messages: [{
      source: { kind: 'user', principal: shareViewerPrincipal('share-1', actor) },
    }] }

    await expect(mounted.handlers.get('agent/pre-step')?.(
      { agent: { session: { id: 'other-session' } }, turn: 1 },
      async () => decision,
    )).resolves.toEqual({ kind: 'reject' })
    await mounted.ctx.fiber.dispose()
  })

  it('refuses queued input for a revoked child while its share still answers', async () => {
    const mounted = await mount({ state: stateFile({ shares: [stored()], forks: [forkRecord({ revokedAt: 'now' })] }) })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      version: 1, accessMode: 'open', allowedSubjectIds: [], sessionMode: 'view', requests: [],
    })))

    await expect(mounted.handlers.get('agent/pre-step')?.(
      { agent: { session: { id: 'child-1' } }, turn: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )).resolves.toEqual({ kind: 'reject' })
    await mounted.ctx.fiber.dispose()
  })

  it('refuses queued input whose share authority cannot be refreshed', async () => {
    const mounted = await mount({ state: stateFile({ shares: [stored()] }) })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(mounted.handlers.get('agent/pre-step')?.(
      { agent: { session: { id: 'session-1' } }, turn: 1 },
      async () => ({
        kind: 'enter',
        messages: [{
          source: {
            kind: 'user',
            principal: shareViewerPrincipal('share-1', { providerId: 'p', tenantId: 't', subjectId: 'alice' }),
          },
        }],
      }),
    )).resolves.toEqual({ kind: 'reject' })
    await mounted.ctx.fiber.dispose()
  })
})
