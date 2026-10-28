// @vitest-environment node
/**
 * The share host's reader wiring for a session that is driven rather than only read: the record it
 * publishes for each viewer request, the source preparation a write prompt asks for, the child limit a
 * fork installs, and the limit a cold child gets before its first prompt is admitted.
 *
 * The Gateway is a scripted transport here: these cases pin the host's own wiring (which services it
 * reads and which record it writes), not the Gateway's answers.
 */

import { Context } from '@deepseek-ai/cordis'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { randomUUID } from 'node:crypto'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
/** Every replacement one write-capable layer installs; no-effect tools keep the deployment's own. */
const WRITE_SURFACE = SHARED_TOOL_PROFILES.filter(profile => !profile.noFileEffect).length
const CREATOR = { providerId: 'feishu', tenantId: 'tenant-a', subjectId: 'ou_reader' }

interface HostOptions {
  /** Make every tool registration throw, as a child scope that refuses its limit does. */
  readonly registerThrows?: boolean
  /** Mount no tools service, so an installation cannot even try. */
  readonly noTools?: boolean
  /** Recorded child to restore beside the share; absent records none. */
  readonly child?: string
}

/** The guard and pre-execute listener one installed child limit registered in its own scope. */
interface ToolHooks {
  guard?: ((execution: unknown) => string | undefined) | undefined
  preExecute?: ((execution: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
}

/**
 * Boot a host holding one write share that allows forks, over a live source Session and the recorded
 * child a cold prompt may name.
 * @param options - Whether registrations fail, and which child is recorded.
 * @returns The context, the capture of the agent listener, the counters read, and the request helper.
 */
async function host(options: HostOptions = {}) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'liveshare-fork-wiring-')))
  onTestFinished(() => { rmSync(temporary, { recursive: true, force: true }) })
  const root = join(temporary, 'workspace')
  mkdirSync(root)
  const state = join(temporary, 'owner.json')
  writeFileSync(state, JSON.stringify({ instanceId: 'owner', relayUrl: 'https://relay.invalid', shares: [{ relay: 'https://relay.invalid',
    shareId: 'share', sessionId: 'source', sessionTitle: 'Source', accessMode: 'open',
    gatewayToken: 'token', allowedSubjectIds: [], createdAt: '2026-10-08T00:00:00Z',
    sessionMode: 'write', allowsFork: true,
  }] }))
  if (options.child !== undefined) {
    writeFileSync(join(temporary, 'forks.json'), JSON.stringify({ version: 1, forks: [{
      childSessionId: options.child, shareId: 'share', sourceSessionId: 'source', boundary: 0,
      creator: CREATOR, createdAt: '2026-10-08T00:00:00Z',
    }] }))
  }
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(RemoteAccessService)
  const sessionOf = (id: string) => Session.create(SessionId(id), [], {
    version: SESSION_FORMAT_VERSION, id: SessionId(id), cwd: root, createdAt: 0, isSeeded: false,
  })
  const sessions = new Map<string, Session>()
  const scopes = new Map<string, Context>()
  const scopeListeners = new Map<string, Map<string, (...args: never[]) => unknown>>()
  const live = (id: string) => {
    let session = sessions.get(id)
    if (session === undefined) { session = sessionOf(id); sessions.set(id, session) }
    let scope = scopes.get(id)
    if (scope === undefined) {
      scope = createScope(ctx, {}).ctx
      Object.defineProperty(scope, 'tools', { value: tools })
      const listeners = new Map<string, (...args: never[]) => unknown>()
      const originalOn = scope.on.bind(scope)
      scope.on = ((name: string, listener: (...args: never[]) => unknown) => {
        listeners.set(name, listener)
        return originalOn(name as never, listener as never)
      }) as never
      scopeListeners.set(id, listeners)
      scopes.set(id, scope)
    }
    return { id: SessionId(id), session, ctx: scope, cancel: () => {} }
  }
  let registrations = 0
  // The deployment's own definitions are what a confined replacement wraps; keeping them apart from the
  // registrations a scope accepted lets one case run the replacement without recursing into another layer.
  const deploymentDefinitions = new Map<string, Record<string, unknown>>()
  const registeredDefinitions = new Map<string, Record<string, unknown>>()
  const definition = (name: string) => {
    const held = deploymentDefinitions.get(name)
    if (held !== undefined) return held
    const created = {
      name,
      description: 'fixture tool',
      parameters: {},
      output: { schema: {}, render: () => [] },
      execute: () => Promise.resolve(undefined),
    }
    deploymentDefinitions.set(name, created)
    return created
  }
  const hooks: ToolHooks = {}
  const tools = {
    get: (name: string) => definition(name),
    register: (registered: { readonly name: string }) => {
      if (options.registerThrows === true) throw new Error('that child scope refused the registration')
      registrations += 1
      registeredDefinitions.set(registered.name, registered)
      return () => { registeredDefinitions.delete(registered.name) }
    },
    guard: (guard: ToolHooks['guard']) => {
      hooks.guard = guard
      return () => { delete hooks.guard }
    },
  }
  if (options.noTools !== true) ctx.provide('tools', tools as never)
  ctx.provide('agents', { get: (id: string) => live(id) } as never)
  ctx.provide('fs', {
    resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
    contains: () => true,
    processPath: (target: { readonly targetKey: string }) => target.targetKey,
    writeText: async () => ({ version: 1, operation: 'create' as const }),
  } as never)
  ctx.provide('sandboxPolicy', {
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: SessionId('source') }),
  } as never)
  ctx.provide('typert', { lookups: { get: (key: string) => key === 'agent'
    ? { resolve: async (id: string) => live(id) }
    : undefined } } as never)
  const dispatch = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname
    return Response.json({
      type: 'server-response',
      rpcId: 'fixture',
      result: path === '/api/session/fork'
        ? { ok: true, value: { sessionId: 'fork-child' } }
        : { ok: true, value: {} },
    })
  })
  ctx.provide('connection', {
    createSharedFetchHandler: () => ({ requestBodyMode: () => 'buffered', fetch: dispatch }),
    createPeer: (peerOptions: ConstructorParameters<typeof Peer>[1]) => new Peer(ctx, peerOptions),
    fetch: { register: () => () => {} },
  } as never)
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const originalOn = ctx.on.bind(ctx)
  ctx.on = ((name: string, listener: (...args: never[]) => unknown) => {
    listeners.set(name, listener)
    return originalOn(name as never, listener as never)
  }) as never
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.url.endsWith('/owner-credential')) return Response.json({ supported: true })
    return Response.json({
      version: 1, accessMode: 'open', allowedSubjectIds: [], requests: [], sessionMode: 'write',
    })
  })
  onTestFinished(() => { vi.unstubAllGlobals() })
  const stop = await apply(ctx, { ownerStateFile: state })
  onTestFinished(stop)
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  worker.event?.({ type: 'share-access-state', registrationToken: randomUUID() as TunnelRegistrationToken,
    shareId: 'share', version: 1, accessMode: 'open', allowedSubjectIds: [], sessionMode: 'write' } as never)
  /** Send one viewer request the way the Relay forwards it. */
  const ask = async (body: unknown): Promise<{ readonly status: number; readonly body: unknown }> => {
    const token = `wiring-${randomUUID()}` as TunnelRequestToken
    worker.event?.({ type: 'share-rpc-request', registrationToken: randomUUID() as TunnelRegistrationToken,
      shareId: 'share', token, id: 1, actor: reader, body })
    return vi.waitFor(() => {
      const found = worker.sent.find((command): command is { token: string; status: number; body: unknown } =>
        typeof command === 'object' && command !== null && 'token' in command && command.token === token)
      if (found === undefined) throw new Error('no answer yet')
      return found
    })
  }
  /** The limit one installed child registered in its own scope. */
  const hooksOf = (id: string): {
    readonly guard: (execution: unknown) => string | undefined
    readonly preExecute: (execution: unknown, next: () => Promise<unknown>) => Promise<unknown>
  } => {
    const preExecute = scopeListeners.get(id)?.get('tools/pre-execute')
    if (hooks.guard === undefined || preExecute === undefined) throw new Error(`child ${id} installed no limit`)
    return { guard: hooks.guard, preExecute: preExecute as never }
  }
  /** One definition this fixture registered, so a case can run the confined tool itself. */
  const toolDefinition = (name: string): { execute: (args: unknown, exec: unknown) => Promise<unknown> } => {
    const held = registeredDefinitions.get(name)
    if (held === undefined) throw new Error(`no ${name} definition was registered`)
    return held as { execute: (args: unknown, exec: unknown) => Promise<unknown> }
  }
  return {
    ctx, ask, dispatch, listeners, hooksOf, toolDefinition,
    registrations: () => registrations,
    forks: () => (JSON.parse(readFileSync(join(temporary, 'forks.json'), 'utf8')) as {
      forks: { childSessionId: string }[]
    }).forks.map(entry => entry.childSessionId),
  }
}

const forkRequest = {
  op: 'call' as const,
  path: '/api/session/fork',
  body: { sessionId: 'source', requestId: 'fork-1', address: { kind: 'session', sessionId: 'source' } },
}

/** One prompt naming a Session, as the viewer page's composer sends it. */
function promptRequest(sessionId: string) {
  return {
    op: 'call' as const,
    path: '/api/session/prompt',
    body: { sessionId, requestId: 'prompt-1', mode: 'queue', content: [{ type: 'text', text: 'hello' }] },
  }
}

describe('share-host fork wiring', () => {
  it('records a forked child and installs its limit before answering', async () => {
    const fixture = await host()
    const before = fixture.registrations()

    const answer = await fixture.ask(forkRequest)

    expect(answer.status).toBe(200)
    expect(fixture.forks()).toContain('fork-child')
    // The child's own confined view surface and its bounded write and edit are the layer the answer
    // promises.
    expect(fixture.registrations()).toBe(before + WRITE_SURFACE)
    expect(fixture.dispatch).toHaveBeenCalled()
  })

  it('prepares a cold child before admitting its prompt', async () => {
    const fixture = await host({ child: 'child-1' })
    const before = fixture.registrations()

    const answer = await fixture.ask(promptRequest('child-1'))

    expect(answer.status).toBe(200)
    expect(fixture.registrations()).toBe(before + WRITE_SURFACE)
  })

  it('refuses a cold child whose limit its scope will not take', async () => {
    const fixture = await host({ child: 'child-1', registerThrows: true })

    const answer = await fixture.ask(promptRequest('child-1'))

    expect(answer.status).toBe(403)
    expect(answer.body).toMatchObject({ error: 'fork-prepare-failed' })
    expect(String((answer.body as { message?: unknown }).message)).toContain('refused the registration')
  })

  it('installs a recorded child limit when its agent is announced', async () => {
    const fixture = await host({ child: 'child-1' })
    const before = fixture.registrations()
    const listener = fixture.listeners.get('agent/created')
    if (listener === undefined) throw new Error('the host registered no agent listener')

    await listener({ agent: { id: 'child-1', session: { id: 'child-1', header: { cwd: '/' } }, ctx: new Context() } } as never)

    expect(fixture.registrations()).toBe(before + WRITE_SURFACE)
    await fixture.ctx.fiber.dispose()
  })

  it('judges one tool execution of an installed child through its own record', async () => {
    const fixture = await host()
    await fixture.ask(forkRequest)
    const hooks = fixture.hooksOf('fork-child')
    const execution = {
      name: 'read',
      arguments: { file_path: '/workspace/file.txt' },
      agent: { id: 'fork-child' },
      token: Symbol('execution'),
      signal: new AbortController().signal,
    }

    // The pre-execute verdict asks the share's authority again and names the paths this host confines.
    await expect(hooks.preExecute(execution, () => Promise.resolve({ kind: 'allow' })))
      .resolves.toEqual({ kind: 'allow' })
    // The guard reads the same record, so one execution is judged the same on both hooks.
    expect(hooks.guard(execution)).toBeUndefined()
  })

  it('refuses a cold child limit it has no services to install', async () => {
    const fixture = await host({ child: 'child-1', noTools: true })

    const answer = await fixture.ask(promptRequest('child-1'))

    expect(answer.status).toBe(403)
    expect(answer.body).toMatchObject({ error: 'fork-prepare-failed' })
    expect(String((answer.body as { message?: unknown }).message))
      .toContain('fork execution limits are unavailable')
  })

  it('refreshes the share authority before a confined tool executes', async () => {
    const fixture = await host()
    await fixture.ask(forkRequest)
    const read = fixture.toolDefinition('read')

    await expect(read.execute({ file_path: '/workspace/file.txt' },
      { signal: new AbortController().signal })).resolves.toBeUndefined()
  })
})
