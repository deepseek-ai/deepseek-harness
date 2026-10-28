// @vitest-environment node
/**
 * A write share gets its access layer when a reader asks for the page, and a revision bump no longer
 * abandons an installation.
 *
 * A host that restarts with a write share installs no layer while that Session's agent is not live, and a
 * Relay authority refresh that lands mid-install used to abandon the installation silently. Either way the
 * reader's own snapshot carried no write action, so its composer stayed inert and the prompt path that
 * prepares the source was never reached. The reader's page request has to break that circle, without making
 * the reader wait and without leaving the share writable when it cannot be driven.
 */

import { Context } from '@deepseek-ai/cordis'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { randomUUID } from 'node:crypto'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type {
  TunnelRegistrationToken,
  TunnelRequestToken,
  TunnelWorkerEvent,
} from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import type {} from '../src/index.ts'
import { apply } from '../src/host/share-host.ts'
import { SHARED_TOOL_PROFILES } from '../src/host/shared-tools.ts'
import type { TunnelWorkerInput } from '../src/host/tunnel-worker.ts'
import { shareViewerPrincipal } from '../src/host/viewer-principal.ts'

const worker = vi.hoisted(() => ({
  event: undefined as ((event: TunnelWorkerEvent) => void) | undefined,
  sent: [] as unknown[],
}))
vi.mock('../src/host/tunnel-worker.ts', () => ({ TunnelWorker: class {
  start() {}
  onEvent(event: (event: TunnelWorkerEvent) => void) { worker.event = event; return () => { worker.event = undefined } }
  send(command: TunnelWorkerInput) { worker.sent.push(command) }
  stop() { return Promise.resolve() }
} }))

const reader = { providerId: 'feishu', tenantId: 'tenant-a', subjectId: 'ou_reader' }
/** Replacements one layer installs at each tier; no-effect tools keep the deployment's own. */
const VIEW_SURFACE = SHARED_TOOL_PROFILES.filter(profile => profile.tier === 'view' && !profile.noFileEffect).length
const WRITE_SURFACE = SHARED_TOOL_PROFILES.filter(profile => !profile.noFileEffect).length

interface HostOptions {
  /** Whether the source Session's agent is live as the host mounts. */
  readonly live?: boolean
  /** How the agent lookup answers a preparation: the agent appears, is absent, or never answers. */
  readonly activation?: 'live' | 'nothing' | 'never'
  /** Resolves each workspace resolution; absent resolves at once. */
  readonly workspace?: () => Promise<void>
  /** Whether the host mounts a sandbox policy service. */
  readonly sandboxPolicy?: boolean
  /** Whether the filesystem resolves the granted workspace root. */
  readonly fsResolves?: boolean
  /** Whether the Relay reports a session mode at all. */
  readonly relayMode?: 'view' | 'write' | 'none'
  /** Mode the restored share was recorded with; write unless a case starts read-only. */
  readonly recordedMode?: 'view' | 'write'
}

/**
 * Boot a host that restarted with one write share recorded, over a source Session whose agent is only
 * activated by this host's own lookup.
 * @param options - Live agent, workspace gate, mounted services, and what the Relay reports.
 * @returns The context, the reader snapshot, a viewer caller, and the counters read.
 */
async function host(options: HostOptions = {}) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'liveshare-write-recovery-')))
  onTestFinished(() => { rmSync(temporary, { recursive: true, force: true }) })
  const root = join(temporary, 'workspace')
  mkdirSync(root)
  const state = join(temporary, 'owner.json')
  writeFileSync(state, JSON.stringify({ instanceId: 'owner', relayUrl: 'https://relay.invalid', shares: [{ relay: 'https://relay.invalid',
    shareId: 'share', sessionId: 'source', sessionTitle: 'Source', accessMode: 'open',
    gatewayToken: 'token', allowedSubjectIds: [], createdAt: '2026-10-08T00:00:00Z',
    sessionMode: options.recordedMode ?? 'write',
  }] }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(RemoteAccessService)
  const session = Session.create(SessionId('source'), [], {
    version: SESSION_FORMAT_VERSION, id: SessionId('source'), cwd: root, createdAt: 0, isSeeded: false,
  })
  let registrations = 0
  const tools = {
    get: () => ({ execute: () => Promise.resolve({ path: root }), parameters: {} }),
    register: () => { registrations += 1; return () => {} },
    guard: () => () => {},
  }
  const scope = createScope(ctx, {})
  Object.defineProperty(scope.ctx, 'tools', { value: tools })
  onTestFinished(() => scope.dispose())
  let activated = options.live === true
  const live = { id: session.id, session, ctx: scope.ctx, cancel: () => {} }
  ctx.provide('agents', { get: () => (activated ? live : undefined) } as never)
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  ctx.provide('tools', tools as never)
  ctx.provide('fs', {
    resolve: async (path: string) => {
      if (options.workspace !== undefined) await options.workspace()
      if (options.fsResolves === false) throw new Error('workspace not resolvable')
      return { targetKey: path, displayPath: path }
    },
  } as never)
  if (options.sandboxPolicy !== false) {
    ctx.provide('sandboxPolicy', {
      resolve: () => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: session.id }),
    } as never)
  }
  ctx.provide('typert', { lookups: { get: (key: string) => key === 'agent'
    ? { resolve: () => {
      if (options.activation === 'never') return new Promise<undefined>(() => {})
      if (options.activation === 'live') activated = true
      return Promise.resolve(options.activation === 'nothing' ? undefined : live)
    } }
    : undefined } } as never)
  ctx.provide('connection', {
    createSharedFetchHandler: () => ({ requestBodyMode: () => 'buffered', fetch: async () => Response.json({}) }),
    createPeer: (peerOptions: ConstructorParameters<typeof Peer>[1]) => new Peer(ctx, peerOptions),
    fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
      routes.set(route.path, route.fetch)
      return () => { routes.delete(route.path) }
    } },
  } as never)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.url.endsWith('/owner-credential')) return Response.json({ supported: true })
    return Response.json({
      version: 10, accessMode: 'open', allowedSubjectIds: [], requests: [],
      ...(options.relayMode === 'none' ? {} : { sessionMode: options.relayMode ?? 'write' }),
    })
  })
  onTestFinished(() => { vi.unstubAllGlobals() })
  const stop = await apply(ctx, { ownerStateFile: state })
  onTestFinished(stop)
  /** The reader's own snapshot, exactly what the served document and its stream carry. */
  const snapshot = (): readonly string[] => {
    const baseline = ctx.remoteAccess.snapshotFor(shareViewerPrincipal('share', reader))
    return baseline.owner ? [] : baseline.grants.flatMap(grant => [...grant.actions])
  }
  /** Forward one Relay authority frame the way the tunnel does. */
  const authority = (shareId: string, version: number, tier: 'view' | 'write' = 'write'): void => {
    worker.event?.({ type: 'share-access-state', registrationToken: randomUUID() as TunnelRegistrationToken,
      shareId, version, accessMode: 'open', allowedSubjectIds: [], sessionMode: tier } as never)
  }
  /** Send one viewer request the way the Relay forwards it. */
  const ask = async (body: unknown): Promise<{ readonly status: number; readonly body: unknown }> => {
    const token = `recovery-${randomUUID()}` as TunnelRequestToken
    worker.event?.({ type: 'share-rpc-request', registrationToken: randomUUID() as TunnelRegistrationToken,
      shareId: 'share', token, id: 1, actor: reader, body })
    return vi.waitFor(() => {
      const found = worker.sent.find((command): command is { token: string; status: number; body: unknown } =>
        typeof command === 'object' && command !== null && 'token' in command && command.token === token)
      if (found === undefined) throw new Error('no answer yet')
      return found
    })
  }
  return { ctx, snapshot, ask, authority, registrations: () => registrations, activated: () => activated }
}

describe('restored write share preparation', () => {
  it('gains the write actions in the reader snapshot after a page request', async () => {
    const fixture = await host({ activation: 'live' })
    // The restart installed nothing, so the reader holds no write action yet.
    expect(fixture.registrations()).toBe(0)
    expect(fixture.snapshot()).not.toContain('session/prompt')

    // One page request, the ordinary document read.
    await fixture.ask({ op: 'asset', path: '' })

    await vi.waitFor(() => { expect(fixture.snapshot()).toContain('session/prompt') })
    expect(fixture.activated()).toBe(true)
    expect(fixture.snapshot()).toContain('session/cancel')
    // One installation registers a confined replacement for every tool the write tier admits.
    expect(fixture.registrations()).toBe(WRITE_SURFACE)
  })

  it('keeps an installation a Relay authority refresh arrived during', async () => {
    // The workspace resolution is held open so the authority frame lands inside the installation window:
    // its revision bump used to abandon the installation silently, which no later path retried.
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const fixture = await host({
      live: true,
      workspace: () => { entered.resolve(undefined); return release.promise },
    })
    await entered.promise
    expect(fixture.registrations()).toBe(0)

    fixture.authority('share', 11)
    // One turn of the loop is enough for the frame's synchronous `applyRelayAccess` to run.
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    release.resolve(undefined)

    await vi.waitFor(() => { expect(fixture.registrations()).toBe(WRITE_SURFACE) })
    await vi.waitFor(() => { expect(fixture.snapshot()).toContain('session/prompt') })
    expect(fixture.snapshot()).toContain('session/cancel')
  })

  it('makes a share writable when the owner moves it to write on a live Session', async () => {
    // The restored share carries the view tier, so the restart installs the confined read it drives with.
    const fixture = await host({ live: true, activation: 'live', recordedMode: 'view', relayMode: 'view' })
    // The Relay authority admits this reader and reports the share's own view tier.
    fixture.authority('share', 11, 'view')
    await vi.waitFor(() => { expect(fixture.snapshot()).toContain('session/list') })
    // The page's own request prepares the confined layer the view tier drives with.
    await fixture.ask({ op: 'asset', path: '' })
    await vi.waitFor(() => { expect(fixture.snapshot()).toContain('session/prompt') })
    // The view surface, and no bounded write: the tier in force is not the write one.
    expect(fixture.registrations()).toBe(VIEW_SURFACE)

    const permissions = await fixture.ctx.liveshareShares.updatePermissions({ shareId: 'share', sessionMode: 'write' })

    // ...and moving it to write installs the write-capable layer before the owner is told it took effect:
    // the view installation is replaced, so the counter (which counts every registration the fixture ever
    // saw) moves by the write surface the new layer registers.
    expect(permissions).toMatchObject({ shareId: 'share', sessionMode: 'write', allowsFork: false })
    expect(fixture.registrations()).toBe(VIEW_SURFACE + WRITE_SURFACE)
    // The tier change re-registers the share with the Relay, which drops this host's stale authority: the
    // reader's writes follow the Relay's own answer for the new tier, arriving with the installed layer.
    fixture.authority('share', 12, 'write')
    await vi.waitFor(() => { expect(fixture.snapshot()).toContain('session/prompt') })
    expect(fixture.snapshot()).toContain('session/cancel')
  })


  it('states why a write prompt could not prepare the layer it needs', async () => {
    // A host with no sandbox policy cannot confine the source, so the prompt path prepares and then
    // refuses with the reason the record holds instead of driving the owner's Session unconstrained.
    const fixture = await host({ live: true, sandboxPolicy: false })
    fixture.authority('share', 12, 'write')
    await vi.waitFor(() => { expect(fixture.snapshot()).toContain('session/list') })

    const answer = await fixture.ask({
      op: 'call',
      path: '/api/session/prompt',
      body: { sessionId: 'source', requestId: 'write-1', mode: 'queue', content: [{ type: 'text', text: 'hello' }] },
    })

    expect(answer.status).toBe(403)
    // The preparation ran and the layer still could not be installed, so the refusal names that fact.
    expect(answer.body).toMatchObject({ error: 'source-write-unavailable', prepared: true, session: 'known' })
  })

  it('answers the page and keeps the share refused while the Session cannot be activated', async () => {
    const fixture = await host({ activation: 'nothing' })
    const answer = await fixture.ask({ op: 'asset', path: '' })
    expect(answer.status).toBeGreaterThan(0)
    await vi.waitFor(() => { expect(fixture.activated()).toBe(false) })
    expect(fixture.snapshot()).not.toContain('session/prompt')
    expect(fixture.snapshot()).not.toContain('session/cancel')
  })

  it('answers the page without waiting for an activation that never settles', async () => {
    const fixture = await host({ activation: 'never' })
    // The document read is answered although the preparation it started never settles.
    const answer = await fixture.ask({ op: 'asset', path: '' })
    expect(answer.status).toBeGreaterThan(0)
    expect(fixture.snapshot()).not.toContain('session/prompt')
  })
})

describe('write access diagnostics', () => {
  /**
   * Run one case with viewer debugging on.
   * @returns The warned lines, in order.
   */
  const debug = (): string[] => {
    vi.stubEnv('LIVESHARE_VIEWER_DEBUG', '1')
    onTestFinished(() => { vi.unstubAllEnvs() })
    const warned: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args.map(String).join(' ')) })
    onTestFinished(() => { spy.mockRestore() })
    return warned
  }

  it('names the guard that refused an installation', async () => {
    const refused = debug()
    const fixture = await host({ live: true, sandboxPolicy: false })
    await vi.waitFor(() => {
      expect(refused.some(line => line.includes('source access not installed')
        && line.includes('trigger=restore') && line.includes('reason=no-sandbox-policy'))).toBe(true)
      expect(fixture.registrations()).toBe(0)
    })

    const unresolvable = debug()
    const second = await host({ live: true, fsResolves: false })
    await vi.waitFor(() => {
      expect(unresolvable.some(line => line.includes('reason=workspace-unresolved'))).toBe(true)
      expect(second.registrations()).toBe(0)
    })
  })

  it('states why a reader request prepared no layer, naming the guard that refused', async () => {
    // A reader's page request starts the preparation itself, so a host that cannot install a layer has to
    // say which guard refused rather than leaving the operator to guess why nothing was prepared.
    const warned = debug()
    const fixture = await host({ live: true, sandboxPolicy: false })
    await fixture.ask({ op: 'asset', path: '' })
    await vi.waitFor(() => {
      expect(warned.some(line => line.includes('source access not installed')
        && line.includes('trigger=reader') && line.includes('reason=no-sandbox-policy'))).toBe(true)
    })
  })
})
