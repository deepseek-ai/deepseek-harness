/** A source limit installed on a live Agent cannot authorize a later Agent generation. */
import { Context } from '@deepseek-ai/cordis'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { randomUUID } from 'node:crypto'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type {} from '../src/index.ts'
import { apply } from '../src/host/share-host.ts'
import { SHARED_TOOL_PROFILES } from '../src/host/shared-tools.ts'
import type { TunnelRegistrationToken, TunnelWorkerEvent } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import type { TunnelWorkerInput } from '../src/host/tunnel-worker.ts'

const worker = vi.hoisted(() => ({ event: undefined as ((event: TunnelWorkerEvent) => void) | undefined }))
vi.mock('../src/host/tunnel-worker.ts', () => ({ TunnelWorker: class {
  start() {}
  onEvent(event: (event: TunnelWorkerEvent) => void) { worker.event = event; return () => { worker.event = undefined } }
  send(_command: TunnelWorkerInput) {}
  stop() { return Promise.resolve() }
} }))

/** Replacements one layer installs at each tier; no-effect tools keep the deployment's own. */
const VIEW_SURFACE = SHARED_TOOL_PROFILES.filter(profile => profile.tier === 'view' && !profile.noFileEffect).length
const WRITE_SURFACE = SHARED_TOOL_PROFILES.filter(profile => !profile.noFileEffect).length

describe('source access lifetime', () => {
  it('reinstalls source limits and cancels pending input when the share mode narrows', async () => {
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'liveshare-source-lifetime-')))
    onTestFinished(() => { rmSync(temporary, { recursive: true, force: true }) })
    const root = join(temporary, 'workspace')
    mkdirSync(root)
    const state = join(temporary, 'owner.json')
    writeFileSync(state, JSON.stringify({ instanceId: 'owner', relayUrl: 'https://relay.invalid', shares: [{ relay: 'https://relay.invalid',
      shareId: 'share', sessionId: 'source', sessionTitle: 'Source', accessMode: 'open',
      gatewayToken: 'token', allowedSubjectIds: [], createdAt: '2026-10-08T00:00:00Z',
      sessionMode: 'view',
    }] }))
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const routes = new Map<string, (request: Request) => Promise<Response>>()
    const session = Session.create(SessionId('source'), [], {
      version: SESSION_FORMAT_VERSION, id: SessionId('source'), cwd: root, createdAt: 0, isSeeded: false,
    })
    let registrations = 0
    const dispatchEntered = Promise.withResolvers<undefined>()
    const dispatchReleased = Promise.withResolvers<undefined>()
    const dispatchSettled = Promise.withResolvers<undefined>()
    onTestFinished(() => { dispatchReleased.resolve(undefined) })
    let dispatched = 0
    const createSharedFetchHandler = () => ({ fetch: async (request: Request) => {
      dispatchEntered.resolve(undefined)
      try {
        await dispatchReleased.promise
        request.signal.throwIfAborted()
        dispatched += 1
        return Response.json({ result: { ok: true, value: { accepted: true } } })
      } finally {
        dispatchSettled.resolve(undefined)
      }
    } })
    ctx.provide('connection', { createSharedFetchHandler, createPeer: (options: ConstructorParameters<typeof Peer>[1]) => new Peer(ctx, options), fetch: { register: (route: {
      path: string
      fetch: (request: Request) => Promise<Response>
    }) => {
      routes.set(route.path, route.fetch)
      return () => { routes.delete(route.path) }
    } } } as never)
    const tools = {
      get: () => ({ execute: () => Promise.resolve({ path: root }), parameters: {} }),
      register: () => { registrations += 1; return () => {} },
      guard: () => () => {},
    }
    const scoped = (context: Context) => {
      const scope = createScope(context, {})
      Object.defineProperty(scope.ctx, 'tools', { value: tools })
      return scope
    }
    let scope = scoped(ctx)
    const live = { id: session.id, session, ctx: scope.ctx, cancel: () => {} }
    ctx.provide('agents', { get: () => live } as never)
    ctx.provide('tools', tools as never)
    ctx.provide('fs', {
      resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
    } as never)
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: session.id }) } as never)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.url.endsWith('/owner-credential')) return Response.json({ supported: true })
      return Response.json({ version: 10, accessMode: 'open', allowedSubjectIds: [], sessionMode: 'write', requests: [] })
    })
    onTestFinished(() => { vi.unstubAllGlobals() })
    const stop = await apply(ctx, { ownerStateFile: state })
    onTestFinished(stop)
    const change = () => ctx.liveshareShares.updatePermissions({ shareId: 'share', sessionMode: 'write' })
    // The restore install is asynchronous; the two concurrent changes below start from it in place.
    await vi.waitFor(() => { expect(registrations).toBe(VIEW_SURFACE) })
    await Promise.all([change(), change()])
    // The restart installed the view surface, and the two concurrent changes upgraded it once to the
    // write-capable layer: the counter counts every registration the fixture saw.
    expect(registrations).toBe(VIEW_SURFACE + WRITE_SURFACE)
    await scope.dispose()
    scope = scoped(ctx)
    live.ctx = scope.ctx
    await change()
    expect(registrations).toBe(VIEW_SURFACE + 2 * WRITE_SURFACE)
    const actor = { providerId: 'mock', tenantId: 'tenant', subjectId: 'viewer' }
    const token = 'pending-prompt' as import('@deepseek-ai/dsh-experimental-liveshare-protocol').TunnelRequestToken
    const registrationToken = randomUUID() as TunnelRegistrationToken
    worker.event?.({ type: 'share-rpc-request', registrationToken, shareId: 'share', token, id: 1, actor,
      body: { op: 'call', path: '/api/session/prompt', body: { type: 'client-request', rpcId: 'rpc',
        method: 'session/prompt', payload: { args: { request: { sessionId: 'source', requestId: 'pending',
          mode: 'queue', content: [{ type: 'text', text: 'pending' }] } } } } },
    })
    await dispatchEntered.promise
    // Narrowing to the view tier keeps the Session drivable and still cancels the pending input that was
    // admitted for the write tier.
    await ctx.liveshareShares.updatePermissions({ shareId: 'share', sessionMode: 'view' })
    dispatchReleased.resolve(undefined)
    await dispatchSettled.promise
    expect(dispatched).toBe(0)
    await stop()
    await scope.dispose()
  })
})
