import { describe, expect, it, vi, afterEach } from 'vitest'
import { Context, symbols } from '@deepseek-ai/cordis'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import RemoteAccessService, {
  type RemoteAccessAction,
  type RemoteAccessBinding,
  type RemoteAccessCondition,
  type RemoteAccessResource,
  type RemoteAccessResourceKind,
  type RemoteAccessRole,
} from '@deepseek-ai/dsh-api-remote-access'
import {
  Remote,
  RemoteScope,
  TypertRemoteService,
  type InvocationDescriptor,
  type InvocationParameterDescriptor,
  type PeerScope,
  type Principal,
  type PrincipalMap,
  type TypertContext,
  type TypertLookup,
  type TypertResource,
  type TypertResourceResolveInput,
} from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { z } from 'zod'
import TypertGatewayService, { type TypertRemoteEventDispatch } from '@deepseek-ai/dsh-api-gateway'
import { callResources, eventResources } from '../src/access.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'
import { ownerPeer, peerFor } from './peer.ts'

interface AccessAgent {
  readonly id: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller shared by the access specs. */
    'test-guest': { readonly kind: 'test-guest'; readonly guest: string }
  }
  interface TypertLookupMap {
    gatewayAccessAgent: TypertLookup<AccessAgent, string>
  }
  interface TypertContextMap {
    gatewayAccessScope: TypertContext<string>
  }
  interface TypertResourceMap {
    /** Test-only resource kinds; the Gateway itself names no kind. */
    'test-shelf': TypertResource<string>
    'test-desk': TypertResource<string>
    'test-frame': TypertResource<string>
  }
}

type Guest = PrincipalMap['test-guest']

const OWNER: Principal = { kind: 'owner' }
const GUEST: Guest = { kind: 'test-guest', guest: 'gateway' }
const GLOBAL = { kind: 'global' } as const
const shelf = (id: string) => ({ kind: 'test-shelf', id }) as const
const desk = (id: string) => ({ kind: 'test-desk', id }) as const
const frame = (id: string) => ({ kind: 'test-frame', id }) as const

const FIXTURE_ACTIONS: readonly RemoteAccessAction[] = [
  'accessFixture/open', 'accessFixture/read', 'accessFixture/byAgent', 'accessFixture/byLookup',
  'accessFixture/byLookupAndOption', 'accessFixture/byList', 'accessFixture/scoped', 'accessFixture/scopedOnDesk',
  'accessFixture/scopedByReader', 'accessFixture/annotate', 'accessFixture/bySession', 'absentAccess/read', 'event:fixture/notice', 'event:fixture/shelf',
]

function role<K extends RemoteAccessResourceKind>(resource: K): RemoteAccessRole<K> {
  return { name: `test:${resource}`, resource, actions: FIXTURE_ACTIONS }
}

/** One binding granting every fixture action on `resource`. */
function on(resource: RemoteAccessResource): RemoteAccessBinding {
  switch (resource.kind) {
    case 'global':
      return { role: role('global'), resource }
    case 'test-shelf':
      return { role: role('test-shelf'), resource }
    case 'test-desk':
      return { role: role('test-desk'), resource }
    case 'test-frame':
      return { role: role('test-frame'), resource }
    default:
      throw new Error('no fixture role for this resource kind')
  }
}

class AccessFixture extends TypertRemoteService {
  readonly principals: Principal[] = []
  readonly requests: unknown[] = []
  release: PromiseWithResolvers<void> = Promise.withResolvers()

  constructor(ctx: Context) {
    super(ctx, 'accessFixture')
  }

  @Remote
  open(): string {
    return this.seen()
  }

  @Remote
  read(request: { readonly shelfId?: unknown; readonly principal?: unknown }): string {
    void request
    return this.seen()
  }

  @Remote({ resources: { 'test-shelf': agentId => agentId } })
  byAgent(agentId: string): string {
    void agentId
    return this.seen()
  }

  @Remote
  byLookup(agent: AccessAgent): string {
    return `${agent.id}:${this.seen()}`
  }

  @Remote({ resources: { 'test-desk': (agentId, request) => [agentId, request.deskId] } })
  byLookupAndOption(agent: AccessAgent, request: { readonly deskId: string; readonly shelfId: string }): string {
    void request
    return `${agent.id}:${this.seen()}`
  }

  @Remote({ resources: { 'test-shelf': shelfIds => shelfIds } })
  byList(shelfIds: readonly string[]): string {
    void shelfIds
    return this.seen()
  }

  @Remote
  bySession(sessionId: string): string {
    void sessionId
    return this.seen()
  }

  @Remote
  annotate(request: { readonly title: string }): string {
    this.requests.push(request)
    return this.seen()
  }

  @RemoteScope('gatewayAccessScope')
  scoped(): string {
    return this.seen()
  }

  @RemoteScope('gatewayAccessScope', { resources: { 'test-desk': request => request.deskId } })
  scopedOnDesk(request: { readonly deskId: string }): string {
    void request
    return this.seen()
  }

  @RemoteScope('gatewayAccessScope', { resources: { 'test-shelf': request => request.shelfId } })
  scopedByReader(request: { readonly shelfId: string }): string {
    void request
    return this.seen()
  }

  @Remote
  async slow(): Promise<string> {
    await this.release.promise
    return this.seen()
  }

  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<string> {
    yield this.seen()
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  }

  private seen(): string {
    const principal = this.ctx.invocation?.peer.principal
    if (principal !== undefined) this.principals.push(principal)
    return principal?.kind ?? 'none'
  }
}

const roots: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(options: { readonly connection?: boolean } = {}): Promise<{
  readonly ctx: Context
  readonly fixture: AccessFixture
  /** Replace the guest's bindings: every fixture action on each listed resource. */
  readonly hold: (...resources: RemoteAccessResource[]) => void
  readonly bindings: ReturnType<typeof vi.fn<(guest: Guest) => readonly RemoteAccessBinding[]>>
}> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService)
  if (options.connection === true) {
    provideBrowserCredentials(ctx)
    await ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
  }
  ctx.typert.resources.register('test-shelf', { field: 'shelfId' })
  await ctx.plugin(AccessFixture)
  let held: readonly RemoteAccessBinding[] = []
  const bindings = vi.fn((guest: Guest): readonly RemoteAccessBinding[] => { void guest; return held })
  ctx.remoteAccess.registerPolicy('test-guest', { bindings })
  const receiver = ctx.get('accessFixture') as AccessFixture & { [symbols.original]?: AccessFixture }
  return {
    ctx,
    fixture: receiver[symbols.original] ?? receiver,
    hold: (...resources) => { held = resources.map(on) },
    bindings,
  }
}

/** Record every request the service decides from now on; the returned function lists their actions and resources in order. */
function recordDecisions(): () => { readonly action: string; readonly resources: unknown }[] {
  const decide = vi.spyOn(RemoteAccessService.prototype, 'decide')
  return () => decide.mock.calls.map(([request]) => ({ action: request.action, resources: request.resources }))
}

function call(ctx: Context, peer: PeerScope, method: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return ctx.typertGateway.invoke({ peer, namespace: 'accessFixture', method, args })
}

function registerScope(ctx: Context, resource: 'test-shelf' | undefined, resolve = vi.fn((id: string) => { void id; return ctx })): typeof resolve {
  ctx.typert.contexts.registerHost('gatewayAccessScope', {
    wire: 'scopeId',
    wireTypeSymbol: '@fixture/access#ScopeId',
    ...resource === undefined ? {} : { resource },
    resolve,
  })
  return resolve
}

function strictCodec(name: string, create: () => z.ZodType): InvocationParameterDescriptor['codec'] {
  return { mode: 'strict', typeSymbol: `@fixture/access#${name}`, create }
}

/** Give each listed fixture method a strict descriptor with these parameters. */
function registerStrict(ctx: Context, methods: Readonly<Record<string, readonly InvocationParameterDescriptor[]>>): void {
  ctx.typert.register({
    package: '@fixture/gateway-access-strict',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: Object.entries(methods).map(([method, parameters]) => ({
      id: `@fixture/gateway-access-strict#accessFixture/${method}`,
      service: 'accessFixture',
      namespace: 'accessFixture',
      method,
      invocation: { kind: 'direct' },
      parameters,
      result: { mode: 'strict', typeSymbol: '@fixture/access#Result', create: () => z.string() },
    })),
  })
}

describe('Gateway access checks', () => {
  it('dispatches the owner without resolving resources or reading the policy', async () => {
    const { ctx, bindings } = await setup()
    const decide = vi.spyOn(RemoteAccessService.prototype, 'decide')
    await expect(call(ctx, ownerPeer(ctx), 'open')).resolves.toBe('owner')
    await expect(call(ctx, ownerPeer(ctx), 'read', { request: { shelfId: 7 } })).resolves.toBe('owner')
    expect(decide).not.toHaveBeenCalled()
    expect(bindings).not.toHaveBeenCalled()
  })

  it('starts only in a composition that mounts remoteAccess', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(TypertRegistry)
    void ctx.plugin(TypertGatewayService)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.get('typertGateway')).toBeUndefined()
    await ctx.plugin(RemoteAccessService)
    await vi.waitFor(() => { expect(ctx.get('typertGateway')).toBeDefined() })
  })

  it('refuses a non-owner call no binding allows before the method runs', async () => {
    const { ctx, fixture, hold } = await setup()
    const guest = peerFor(ctx, GUEST)
    await expect(call(ctx, guest, 'open')).rejects.toMatchObject({
      code: 'remote-access/denied',
      message: 'remote access: accessFixture/open: access denied (no-allow)',
      details: { action: 'accessFixture/open', reason: 'no-allow' },
    })
    expect(fixture.principals).toEqual([])
    hold(GLOBAL)
    await expect(call(ctx, guest, 'open')).resolves.toBe('test-guest')
    expect(fixture.principals).toEqual([GUEST])
  })

  it('hands remoteAccess the endpoint action, the resolved resources, and the call arguments', async () => {
    const { ctx, hold } = await setup()
    hold(GLOBAL, shelf('s1'), shelf('s2'))
    const decide = vi.spyOn(RemoteAccessService.prototype, 'decide')
    const guest = peerFor(ctx, GUEST)
    await call(ctx, guest, 'read', { request: { shelfId: 's1' } })
    await call(ctx, guest, 'byAgent', { agentId: 's2' })
    await call(ctx, guest, 'read', { request: {} })
    expect(decide.mock.calls.map(([request]) => request)).toEqual([
      { principal: GUEST, action: 'accessFixture/read', resources: [shelf('s1')], args: { request: { shelfId: 's1' } } },
      { principal: GUEST, action: 'accessFixture/byAgent', resources: [shelf('s2')], args: { agentId: 's2' } },
      { principal: GUEST, action: 'accessFixture/read', resources: [GLOBAL], args: { request: {} } },
    ])
  })

  it('reads a lookup parameter\'s resource and lets a reader replace it for its kind', async () => {
    const { ctx, hold } = await setup()
    hold(shelf('s9'), desk('a1'), desk('a2'), desk('d9'))
    const decisions = recordDecisions()
    ctx.typert.lookups.register('gatewayAccessAgent', {
      parameter: 'agent',
      wire: 'agentId',
      resource: 'test-desk',
      hostTypeSymbol: '@fixture/access#Agent',
      wireTypeSymbol: '@fixture/access#AgentId',
      resolve: (id: string) => ({ id }),
    })
    const guest = peerFor(ctx, GUEST)
    await expect(call(ctx, guest, 'byLookup', { agentId: 'a1' })).resolves.toBe('a1:test-guest')
    await expect(call(ctx, guest, 'byLookupAndOption', { agentId: 'a2', request: { deskId: 'd9', shelfId: 's9' } }))
      .resolves.toBe('a2:test-guest')
    expect(decisions().map(({ resources }) => resources)).toEqual([
      [desk('a1')],
      // The reader owns `test-desk`; the registered `shelfId` field still names `test-shelf`.
      [shelf('s9'), desk('a2'), desk('d9')],
    ])
  })

  it('refuses an empty reader list and a malformed default field with resource-invalid without asking remoteAccess', async () => {
    const { ctx, hold, bindings } = await setup()
    hold(shelf('s1'), shelf('s2'))
    const decide = vi.spyOn(RemoteAccessService.prototype, 'decide')
    const guest = peerFor(ctx, GUEST)
    await expect(call(ctx, guest, 'byList', { shelfIds: [] })).rejects.toMatchObject({
      code: 'remote-access/denied', details: { action: 'accessFixture/byList', reason: 'resource-invalid' },
    })
    await expect(call(ctx, guest, 'read', { request: { shelfId: 7 } })).rejects.toMatchObject({
      code: 'remote-access/denied', details: { reason: 'resource-invalid' },
    })
    expect(decide).not.toHaveBeenCalled()
    expect(bindings).not.toHaveBeenCalled()
    // Every listed resource must be allowed.
    await expect(call(ctx, guest, 'byList', { shelfIds: ['s1', 's2'] })).resolves.toBe('test-guest')
    await expect(call(ctx, guest, 'byList', { shelfIds: ['s1', 's3'] })).rejects.toMatchObject({ details: { reason: 'no-allow' } })
  })

  it('resolves a strict method whose Service is absent from its arguments alone', async () => {
    const { ctx } = await setup()
    const decisions = recordDecisions()
    ctx.typert.register({
      package: '@fixture/gateway-access',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: [{
        id: '@fixture/gateway-access#absentAccess/read',
        service: 'absentAccess',
        namespace: 'absentAccess',
        method: 'read',
        invocation: { kind: 'direct' },
        parameters: [],
        result: { mode: 'strict', typeSymbol: '@fixture/gateway-access#Result', create: () => z.string() },
      }],
    })
    await expect(ctx.typertGateway.invoke({ peer: peerFor(ctx, GUEST), namespace: 'absentAccess', method: 'read', args: {} }))
      .rejects.toMatchObject({ code: 'remote-access/denied', details: { action: 'absentAccess/read', reason: 'no-allow' } })
    expect(decisions()).toEqual([{ action: 'absentAccess/read', resources: [GLOBAL] }])
  })

  it('passes declared parameter names to a registered resolver through dispatch', async () => {
    const { ctx, hold } = await setup()
    const resolve = vi.fn(({ args, parameters }: TypertResourceResolveInput) => {
      const named = parameters.find(parameter => parameter.name === 'sessionId')
      return named === undefined ? undefined : args[named.wire] as string
    })
    const dispose = ctx.typert.resources.register('test-frame', { resolve })
    const guest = peerFor(ctx, GUEST)
    hold(frame('f1'))
    await expect(call(ctx, guest, 'bySession', { sessionId: 'f1' })).resolves.toBe('test-guest')
    await expect(call(ctx, guest, 'bySession', { sessionId: 'f2' }))
      .rejects.toMatchObject({ code: 'remote-access/denied' })
    expect(resolve).toHaveBeenCalledTimes(2)
    await dispose()
  })

  it('checks access before resolving lookups, so a refused call activates nothing', async () => {
    const { ctx, hold } = await setup()
    const resolve = vi.fn((id: string) => ({ id }))
    ctx.typert.lookups.register('gatewayAccessAgent', {
      parameter: 'agent',
      wire: 'agentId',
      hostTypeSymbol: '@fixture/access#Agent',
      wireTypeSymbol: '@fixture/access#AgentId',
      resolve,
    })
    const guest = peerFor(ctx, GUEST)
    await expect(call(ctx, guest, 'byLookup', { agentId: 'a1' })).rejects.toMatchObject({ code: 'remote-access/denied' })
    expect(resolve).not.toHaveBeenCalled()
    // A lookup without a resource kind contributes nothing, so the call touches the global resource.
    hold(GLOBAL)
    await expect(call(ctx, guest, 'byLookup', { agentId: 'a1' })).resolves.toBe('a1:test-guest')
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('keeps the principal out of reach of wire fields', async () => {
    const { ctx, fixture, hold } = await setup({ connection: true })
    hold(GLOBAL)
    const guest = ctx.connection.createPeer({ principal: GUEST })
    await expect(call(ctx, guest, 'read', { request: {}, principal: OWNER })).rejects.toMatchObject({
      code: 'gateway/arguments-invalid',
    })
    const shared = ctx.connection.createSharedFetchHandler('/api')
    const response = await shared.fetch(new Request('http://host/api/accessFixture/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-1',
        method: 'accessFixture/read',
        principal: OWNER,
        payload: { args: { request: { principal: OWNER } } },
      }),
    }), guest)
    expect(await response.json()).toMatchObject({ result: { ok: true, value: 'test-guest' } })
    const payloadSibling = await shared.fetch(new Request('http://host/api/accessFixture/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-2',
        method: 'accessFixture/read',
        payload: { args: { request: {} }, principal: OWNER },
      }),
    }), guest)
    expect(await payloadSibling.json()).toMatchObject({ result: { ok: false } })
    expect(fixture.principals).toEqual([GUEST])
  })
})

describe('Gateway access checks on Typert-validated arguments', () => {
  const titleRequest = (create: () => z.ZodType = () => z.object({ title: z.string() })): InvocationParameterDescriptor =>
    ({ name: 'request', wire: 'request', source: 'json', codec: strictCodec('TitleRequest', create) })

  it('resolves resources from the decoded arguments, so an undeclared nested field names no resource', async () => {
    const { ctx, fixture, hold } = await setup()
    const create = vi.fn(() => z.object({ title: z.string() }))
    registerStrict(ctx, {
      annotate: [titleRequest(create)],
      read: [{ name: 'request', wire: 'request', source: 'json', codec: strictCodec('ShelfRequest', () => z.object({ shelfId: z.string() })) }],
    })
    const decide = vi.spyOn(RemoteAccessService.prototype, 'decide')
    const guest = peerFor(ctx, GUEST)
    hold(shelf('s1'))
    await expect(call(ctx, guest, 'annotate', { request: { title: 't', shelfId: 's1' } })).rejects.toMatchObject({
      code: 'remote-access/denied', details: { action: 'accessFixture/annotate', reason: 'no-allow' },
    })
    await expect(call(ctx, guest, 'read', { request: { shelfId: 's1', principal: OWNER } })).resolves.toBe('test-guest')
    hold(GLOBAL)
    await expect(call(ctx, guest, 'annotate', { request: { title: 't', shelfId: 's1' } })).resolves.toBe('test-guest')
    expect(decide.mock.calls.map(([request]) => request)).toEqual([
      { principal: GUEST, action: 'accessFixture/annotate', resources: [GLOBAL], args: { request: { title: 't' } } },
      { principal: GUEST, action: 'accessFixture/read', resources: [shelf('s1')], args: { request: { shelfId: 's1' } } },
      { principal: GUEST, action: 'accessFixture/annotate', resources: [GLOBAL], args: { request: { title: 't' } } },
    ])
    // Dispatch receives the value the access check read, decoded once per call.
    expect(fixture.requests).toEqual([{ title: 't' }])
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('hands a condition the decoded arguments, so it cannot read an undeclared field', async () => {
    const { ctx, bindings } = await setup()
    registerStrict(ctx, { annotate: [titleRequest()] })
    const seen: unknown[] = []
    const condition: RemoteAccessCondition<'global'> = ({ args }) => {
      seen.push(args)
      return { kind: 'allow' }
    }
    bindings.mockImplementation(() => [{ role: role('global'), resource: GLOBAL, condition }])
    await expect(call(ctx, peerFor(ctx, GUEST), 'annotate', { request: { title: 't', readOnly: false } })).resolves.toBe('test-guest')
    expect(seen).toEqual([{ request: { title: 't' } }])
  })

  it('passes readers the decoded arguments and lookup wire identities, resolving no lookup for a refused call', async () => {
    const { ctx, hold } = await setup()
    const resolve = vi.fn((id: string) => ({ id }))
    ctx.typert.lookups.register('gatewayAccessAgent', {
      parameter: 'agent',
      wire: 'agentId',
      resource: 'test-desk',
      hostTypeSymbol: '@fixture/access#Agent',
      wireTypeSymbol: '@fixture/access#AgentId',
      resolve,
    })
    registerStrict(ctx, {
      byLookupAndOption: [
        { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'gatewayAccessAgent', codec: strictCodec('AgentId', () => z.string()) },
        { name: 'request', wire: 'request', source: 'json', codec: strictCodec('DeskRequest', () => z.object({ deskId: z.string() })) },
      ],
    })
    const decisions = recordDecisions()
    const guest = peerFor(ctx, GUEST)
    const args = { agentId: 'a2', request: { deskId: 'd9', shelfId: 's9' } }
    hold(shelf('s9'), desk('a2'))
    await expect(call(ctx, guest, 'byLookupAndOption', args)).rejects.toMatchObject({ details: { reason: 'no-allow' } })
    expect(resolve).not.toHaveBeenCalled()
    hold(desk('a2'), desk('d9'))
    await expect(call(ctx, guest, 'byLookupAndOption', args)).resolves.toBe('a2:test-guest')
    expect(resolve).toHaveBeenCalledExactlyOnceWith('a2')
    // The undeclared `shelfId` names no `test-shelf` resource.
    expect(decisions().map(({ resources }) => resources)).toEqual([[desk('a2'), desk('d9')], [desk('a2'), desk('d9')]])
  })

  it('refuses arguments their codec rejects with gateway/input-invalid before the access check', async () => {
    const { ctx, fixture, bindings } = await setup()
    registerStrict(ctx, { annotate: [titleRequest()] })
    const decide = vi.spyOn(RemoteAccessService.prototype, 'decide')
    for (const peer of [peerFor(ctx, GUEST), ownerPeer(ctx)]) {
      await expect(call(ctx, peer, 'annotate', { request: { title: 7, shelfId: 's1' } })).rejects.toMatchObject({
        code: 'gateway/input-invalid', details: { endpoint: 'accessFixture/annotate', field: 'request' },
      })
    }
    expect(decide).not.toHaveBeenCalled()
    expect(bindings).not.toHaveBeenCalled()
    expect(fixture.requests).toEqual([])
  })
})

describe('Gateway access checks for Context methods', () => {
  it('reads the Context identity as the resource its adapter declares, before resolving the Context', async () => {
    const { ctx, fixture, hold } = await setup()
    const resolve = registerScope(ctx, 'test-shelf')
    const guest = peerFor(ctx, GUEST)
    await expect(call(ctx, guest, 'scoped', { scopeId: 's1' })).rejects.toMatchObject({
      code: 'remote-access/denied', details: { action: 'accessFixture/scoped', reason: 'no-allow' },
    })
    expect(resolve).not.toHaveBeenCalled()
    hold(shelf('s1'))
    await expect(call(ctx, guest, 'scoped', { scopeId: 's1' })).resolves.toBe('test-guest')
    expect(resolve).toHaveBeenCalledWith('s1')
    expect(fixture.principals).toEqual([GUEST])
  })

  it('adds the resources a reader declares to the Context resource, and lets a reader replace it for its kind', async () => {
    const { ctx, hold } = await setup()
    registerScope(ctx, 'test-shelf')
    const decisions = recordDecisions()
    const guest = peerFor(ctx, GUEST)
    hold(shelf('s1'))
    await expect(call(ctx, guest, 'scopedOnDesk', { scopeId: 's1', request: { deskId: 'd1' } })).rejects.toMatchObject({
      details: { reason: 'no-allow' },
    })
    hold(shelf('s1'), desk('d1'))
    await expect(call(ctx, guest, 'scopedOnDesk', { scopeId: 's1', request: { deskId: 'd1' } })).resolves.toBe('test-guest')
    await expect(call(ctx, guest, 'scopedByReader', { scopeId: 's9', request: { shelfId: 's1' } })).resolves.toBe('test-guest')
    expect(decisions().map(({ resources }) => resources)).toEqual([
      [shelf('s1'), desk('d1')],
      [shelf('s1'), desk('d1')],
      [shelf('s1')],
    ])
  })

  it('refuses a malformed Context identity with resource-invalid without asking remoteAccess or resolving the Context', async () => {
    const { ctx, hold, bindings } = await setup()
    const resolve = registerScope(ctx, 'test-shelf')
    hold(GLOBAL, shelf('s1'))
    const decide = vi.spyOn(RemoteAccessService.prototype, 'decide')
    const guest = peerFor(ctx, GUEST)
    for (const scopeId of [7, '']) {
      await expect(call(ctx, guest, 'scoped', { scopeId })).rejects.toMatchObject({
        code: 'remote-access/denied', details: { action: 'accessFixture/scoped', reason: 'resource-invalid' },
      })
    }
    expect(resolve).not.toHaveBeenCalled()
    expect(decide).not.toHaveBeenCalled()
    expect(bindings).not.toHaveBeenCalled()
  })

  it('resolves a Context method whose adapter declares no resource by the ordinary sources', async () => {
    const { ctx, hold } = await setup()
    registerScope(ctx, undefined)
    const decisions = recordDecisions()
    const guest = peerFor(ctx, GUEST)
    await expect(call(ctx, guest, 'scoped', { scopeId: 's1' })).rejects.toMatchObject({ details: { reason: 'no-allow' } })
    hold(GLOBAL, desk('d1'))
    await expect(call(ctx, guest, 'scoped', { scopeId: 's1' })).resolves.toBe('test-guest')
    await expect(call(ctx, guest, 'scopedOnDesk', { scopeId: 's1', request: { deskId: 'd1' } })).resolves.toBe('test-guest')
    expect(decisions().map(({ resources }) => resources)).toEqual([
      [GLOBAL],
      [GLOBAL],
      [desk('d1')],
    ])
  })
})

describe('Gateway Peer lifetime', () => {
  it('refuses calls and streams from a disposed Peer without affecting other Peers', async () => {
    const { ctx } = await setup({ connection: true })
    const peer = peerFor(ctx, OWNER)
    await peer.dispose()
    await expect(call(ctx, peer, 'open')).rejects.toMatchObject({ code: 'gateway/peer-disposed' })
    await expect(ctx.typertGateway.stream({ peer, namespace: 'accessFixture', method: 'watch', args: {} }))
      .rejects.toMatchObject({ code: 'gateway/peer-disposed' })
    await expect(ctx.typertGateway.wireStream.open('$events', { args: {} }, (async function* () {})(), peer, new AbortController().signal))
      .rejects.toMatchObject({ code: 'gateway/peer-disposed' })
    const result = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request('http://host/api/$events/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-disposed',
        method: '$events/result',
        payload: { args: { clientId: 'any', eventId: 'any', outcome: { kind: 'next' } } },
      }),
    }), peer)
    expect(await result.json()).toMatchObject({ result: { ok: false, error: { code: 'gateway/peer-disposed' } } })
    await expect(call(ctx, ownerPeer(ctx), 'open')).resolves.toBe('owner')
  })

  it('refuses a disposed Peer before reading its wire payload', async () => {
    const { ctx } = await setup({ connection: true })
    const peer = peerFor(ctx, OWNER)
    await peer.dispose()
    for (const payload of [{}, { args: 1 }, { args: {}, extra: true }]) {
      await expect(ctx.typertGateway.wireStream.open('accessFixture/watch', payload, (async function* () {})(), peer, new AbortController().signal))
        .rejects.toMatchObject({ code: 'gateway/peer-disposed' })
    }
    const response = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request('http://host/api/accessFixture/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-malformed', method: 'accessFixture/open', payload: { args: 1 } }),
    }), peer)
    expect(await response.json()).toMatchObject({ result: { ok: false, error: { code: 'gateway/peer-disposed' } } })
  })

  it('ends a disposed Peer\'s streams and lets its running unary calls finish', async () => {
    const { ctx, fixture } = await setup()
    const peer = peerFor(ctx, OWNER)
    const other = peerFor(ctx, OWNER)
    const stream = (await ctx.typertGateway.stream({ peer, namespace: 'accessFixture', method: 'watch', args: {} }))[Symbol.asyncIterator]()
    const survivorAbort = new AbortController()
    const survivor = (await ctx.typertGateway.stream({
      peer: other, namespace: 'accessFixture', method: 'watch', args: {}, signal: survivorAbort.signal,
    }))[Symbol.asyncIterator]()
    await expect(stream.next()).resolves.toEqual({ done: false, value: 'owner' })
    await expect(survivor.next()).resolves.toEqual({ done: false, value: 'owner' })
    const running = call(ctx, peer, 'slow')
    const pending = stream.next()
    await peer.dispose()
    // The stream's method signal joins the Peer's, so disposal cancels it like a carrier cancel.
    await expect(pending).rejects.toMatchObject({ code: 'gateway/cancelled' })
    fixture.release.resolve()
    await expect(running).resolves.toBe('owner')
    const next = survivor.next()
    let settled = false
    void next.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    survivorAbort.abort()
    await expect(next).rejects.toMatchObject({ code: 'gateway/cancelled' })
  })
})

/** Install a pushable event source; `push` yields one dispatch to every open `$events` stream. */
function eventSource(ctx: Context): (dispatch: TypertRemoteEventDispatch) => void {
  const queue: TypertRemoteEventDispatch[] = []
  let wake: (() => void) | undefined
  ctx.effect(() => ctx.typertGateway.registerRemoteEvents(async function* (signal) {
    while (!signal.aborted) {
      while (queue.length > 0) yield queue.shift() as TypertRemoteEventDispatch
      await new Promise<void>((resolve) => {
        wake = resolve
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
  }, { home: '/fixture' }))
  return (dispatch) => {
    queue.push(dispatch)
    wake?.()
  }
}

describe('Gateway forwarded events for non-owner Peers', () => {
  it('denies event streams and results for passive owner and guest Peers', async () => {
    const { ctx } = await setup({ connection: true })
    const passive = [
      ctx.connection.createPeer({ principal: OWNER, interactions: 'none' }),
      ctx.connection.createPeer({ principal: GUEST, interactions: 'none' }),
    ]
    const push = eventSource(ctx)
    for (const peer of passive) {
      await expect(ctx.typertGateway.wireStream.open(
        '$events', { args: {} }, (async function* () {})(), peer, new AbortController().signal,
      )).rejects.toMatchObject({ code: 'gateway/interactions-forbidden' })
      const result = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request('http://host/api/$events/result', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'rpc-passive', method: '$events/result',
          payload: { args: { clientId: 'absent', eventId: 'absent', outcome: { kind: 'next' } } },
        }),
      }), peer)
      expect(await result.json()).toMatchObject({ result: { ok: false, error: { code: 'gateway/interactions-forbidden' } } })
    }
    push({ event: 'fixture/notice', args: ['ignored'] })
    expect(ctx.typertGateway.hasLiveClient()).toBe(false)
  })

  it('delivers only allowed broadcasts and no answerable waterfall to a non-owner, and refuses its results', async () => {
    const { ctx, hold } = await setup({ connection: true })
    hold(shelf('s1'))
    const decide = vi.spyOn(RemoteAccessService.prototype, 'decide')
    const push = eventSource(ctx)
    const guest = ctx.connection.createPeer({ principal: GUEST })
    const abort = new AbortController()
    const guestEvents = (await ctx.typertGateway.wireStream.open('$events', { args: {} }, (async function* () {})(), guest, abort.signal))[Symbol.asyncIterator]()
    const guestReady = await guestEvents.next()
    // A non-owner stream receives the same Host facts but cannot answer, so it does not count as a live Client.
    expect(guestReady.value).toMatchObject({ type: 'ready', host: { home: '/fixture' } })
    expect(ctx.typertGateway.hasLiveClient()).toBe(false)
    const ownerEvents = (await ctx.typertGateway.wireStream.open('$events', { args: {} }, (async function* () {})(), ctx.connection.browserPeer, abort.signal))[Symbol.asyncIterator]()
    await expect(ownerEvents.next()).resolves.toMatchObject({ value: { type: 'ready', host: { home: '/fixture' } } })
    expect(ctx.typertGateway.hasLiveClient()).toBe(true)

    const agentCtx = ctx.extend({})
    const subject = {}
    const settled = vi.fn()
    push({
      event: 'fixture/ask',
      request: { question: 'q', agent: subject },
      context: { value: agentCtx, subject, agentId: 'agent-1' },
      resolve: settled,
      reject: settled,
    })
    const resources = { 'test-shelf': (shelfId: unknown) => shelfId }
    push({ event: 'fixture/notice', args: ['hello'] })
    push({ event: 'fixture/shelf', args: ['s2'], resources })
    push({ event: 'fixture/shelf', args: ['s1'], resources })
    await expect(ownerEvents.next()).resolves.toMatchObject({ value: { type: 'waterfall', event: 'fixture/ask' } })
    await expect(ownerEvents.next()).resolves.toMatchObject({ value: { type: 'emit', event: 'fixture/notice' } })
    await expect(ownerEvents.next()).resolves.toMatchObject({ value: { type: 'emit', event: 'fixture/shelf', args: ['s2'] } })
    await expect(ownerEvents.next()).resolves.toMatchObject({ value: { type: 'emit', event: 'fixture/shelf', args: ['s1'] } })
    // The global notice and the denied shelf never reach the non-owner; the allowed one arrives whole.
    await expect(guestEvents.next()).resolves.toEqual({ done: false, value: { type: 'emit', event: 'fixture/shelf', args: ['s1'] } })
    expect(decide.mock.calls.map(([request]) => request)).toEqual([
      { principal: GUEST, action: 'event:fixture/notice', resources: [GLOBAL] },
      { principal: GUEST, action: 'event:fixture/shelf', resources: [shelf('s2')] },
      { principal: GUEST, action: 'event:fixture/shelf', resources: [shelf('s1')] },
    ])

    const clientId: unknown = Reflect.get(guestReady.value as object, 'clientId')
    const shared = ctx.connection.createSharedFetchHandler('/api')
    const refused = await shared.fetch(new Request('http://host/api/$events/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-result',
        method: '$events/result',
        payload: { args: { clientId, eventId: 'any', outcome: { kind: 'next' } } },
      }),
    }), guest)
    expect(await refused.json()).toMatchObject({
      result: { ok: false, error: { code: 'gateway/invocation-unavailable', details: { endpoint: '$events/result' } } },
    })
    abort.abort()
    await guestEvents.return?.()
    await ownerEvents.return?.()
  })

  it('delivers a global event that a global role lists, and drops one whose resource is missing without asking remoteAccess', async () => {
    const { ctx, hold } = await setup({ connection: true })
    hold(GLOBAL, shelf('s1'))
    const decisions = recordDecisions()
    const push = eventSource(ctx)
    const abort = new AbortController()
    const open = async (): Promise<AsyncIterator<unknown>> => (await ctx.typertGateway.wireStream.open(
      '$events', { args: {} }, (async function* () {})(), ctx.connection.createPeer({ principal: GUEST }), abort.signal,
    ))[Symbol.asyncIterator]()
    const streams = [await open(), await open()]
    for (const events of streams) await events.next()
    const missing = vi.fn(() => undefined)
    push({ event: 'fixture/shelf', args: [null], resources: { 'test-shelf': missing } })
    push({ event: 'fixture/notice', args: ['hello'], resources: {} })
    for (const events of streams) {
      await expect(events.next()).resolves.toEqual({ done: false, value: { type: 'emit', event: 'fixture/notice', args: ['hello'] } })
    }
    // A frame's resources are resolved once for all non-owner streams.
    expect(missing).toHaveBeenCalledOnce()
    const notice = { action: 'event:fixture/notice', resources: [GLOBAL] }
    expect(decisions()).toEqual([notice, notice])
    abort.abort()
    for (const events of streams) await events.return?.()
  })

  it('discards the events buffered for a revoked non-owner Peer and keeps other streams', async () => {
    const { ctx, hold } = await setup({ connection: true })
    hold(shelf('s1'))
    const push = eventSource(ctx)
    const abort = new AbortController()
    const open = async (peer: PeerScope): Promise<AsyncIterator<unknown>> =>
      (await ctx.typertGateway.wireStream.open('$events', { args: {} }, (async function* () {})(), peer, abort.signal))[Symbol.asyncIterator]()
    const revoked = ctx.connection.createPeer({ principal: GUEST })
    const lagging = await open(revoked)
    const other = await open(ctx.connection.createPeer({ principal: GUEST }))
    const owner = await open(ctx.connection.browserPeer)
    for (const events of [lagging, other, owner]) await events.next()
    const resources = { 'test-shelf': (shelfId: unknown) => shelfId }
    push({ event: 'fixture/shelf', args: ['s1'], resources })
    push({ event: 'fixture/shelf', args: ['s1'], resources })
    const frame = { done: false, value: { type: 'emit', event: 'fixture/shelf', args: ['s1'] } }
    for (const events of [other, owner]) {
      await expect(events.next()).resolves.toMatchObject(frame)
      await expect(events.next()).resolves.toMatchObject(frame)
    }
    // Both frames were queued for the lagging stream before its Peer was revoked.
    await revoked.dispose()
    await expect(lagging.next()).resolves.toEqual({ done: true, value: undefined })
    push({ event: 'fixture/shelf', args: ['s1'], resources })
    for (const events of [other, owner]) await expect(events.next()).resolves.toMatchObject(frame)
    abort.abort()
    for (const events of [other, owner]) await events.return?.()
  })

  it('contains a throwing policy to the non-owner deliveries it decides', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(RemoteAccessService)
    await ctx.plugin(TypertGatewayService)
    provideBrowserCredentials(ctx)
    await ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.remoteAccess.registerPolicy('test-guest', { bindings: () => { throw new Error('binding store unavailable') } })
    const push = eventSource(ctx)
    const abort = new AbortController()
    const open = async (peer: PeerScope): Promise<AsyncIterator<unknown>> =>
      (await ctx.typertGateway.wireStream.open('$events', { args: {} }, (async function* () {})(), peer, abort.signal))[Symbol.asyncIterator]()
    const guestEvents = await open(ctx.connection.createPeer({ principal: GUEST }))
    const ownerEvents = await open(ctx.connection.browserPeer)
    await guestEvents.next()
    await ownerEvents.next()
    push({ event: 'fixture/shelf', args: ['s1'], resources: { 'test-shelf': (shelfId: unknown) => shelfId } })
    push({ event: 'fixture/notice', args: ['after'] })
    await expect(ownerEvents.next()).resolves.toMatchObject({ value: { type: 'emit', event: 'fixture/shelf' } })
    // The shared source survives the failure: later events still reach the owner.
    await expect(ownerEvents.next()).resolves.toMatchObject({ value: { type: 'emit', event: 'fixture/notice' } })
    expect(warn).toHaveBeenCalledWith(
      'remote access: the "test-guest" policy failed to list bindings for event:fixture/shelf; its further failures are not logged until access state changes')
    const guestNext = guestEvents.next()
    abort.abort()
    await expect(guestNext).resolves.toEqual({ done: true, value: undefined })
    await ownerEvents.return?.()
  })
})

describe('resource resolution', () => {
  const NEVER = new AbortController().signal
  const ROOM = { kind: 'test-shelf', id: 'r1' } as const
  const DESK = { kind: 'test-desk', id: 'd1' } as const
  const DIRECT: InvocationDescriptor['invocation'] = { kind: 'direct' }

  /** A direct method's descriptor fields carrying only what resource resolution reads. */
  function method(...wires: string[]): Pick<InvocationDescriptor, 'invocation' | 'parameters'> {
    return { invocation: DIRECT, parameters: wires.map(wire => ({ name: wire, wire, source: 'json' }) as InvocationParameterDescriptor) }
  }

  async function registry(): Promise<Context['typert']> {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(TypertRegistry)
    ctx.typert.resources.register('test-shelf', { field: 'roomId' })
    ctx.typert.resources.register('test-desk', { field: 'deskId' })
    return ctx.typert
  }

  it('reads a default field from a top-level argument, else from the first object argument, else touches global', async () => {
    const typert = await registry()
    expect(callResources(typert, undefined, method('roomId'), { roomId: 'r1' }, NEVER))
      .toEqual([ROOM])
    expect(callResources(typert, undefined, method('count', 'tags', 'none', 'request'), {
      count: 1, tags: ['r9'], none: null, request: { roomId: 'r1', deskId: 'd1' },
    }, NEVER)).toEqual([ROOM, DESK])
    // Only the first object argument is read; a later one naming the field does not count.
    expect(callResources(typert, undefined, method('first', 'second'), { first: {}, second: { roomId: 'r1' } }, NEVER))
      .toEqual([GLOBAL])
    expect(callResources(typert, undefined, method(), {}, NEVER)).toEqual([GLOBAL])
  })

  it('resolves default identities through the registered function and preserves explicit overrides', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(TypertRegistry)
    const resolve = vi.fn(({ args, parameters }: TypertResourceResolveInput) => {
      const named = parameters.find(parameter => parameter.wire === 'roomId')
      if (named !== undefined) return args[named.wire] as string | undefined
      const first = parameters[0]
      const request = first === undefined ? undefined : args[first.wire] as { address?: { id: string } } | undefined
      return request?.address?.id
    })
    const dispose = ctx.typert.resources.register('test-shelf', { resolve })
    expect(callResources(ctx.typert, undefined, method('roomId'), { roomId: 'r1' }, NEVER)).toEqual([ROOM])
    expect(callResources(ctx.typert, undefined, method('request'), { request: { address: { id: 'r1' } } }, NEVER)).toEqual([ROOM])
    expect(callResources(ctx.typert, undefined, method('request'), { request: {} }, NEVER)).toEqual([GLOBAL])
    resolve.mockClear()
    const args = { other: {}, later: { address: { id: 'r1' } } }
    expect(callResources(ctx.typert, undefined, method('other', 'later'), args, NEVER)).toEqual([GLOBAL])
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ args, parameters: method('other', 'later').parameters })
    resolve.mockClear()
    expect(callResources(ctx.typert, undefined, {
      ...method('renamed'), cancellation: { parameter: 'signal' },
    }, { renamed: { address: { id: 'r1' } } }, NEVER)).toEqual([ROOM])
    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      args: { renamed: { address: { id: 'r1' } } }, parameters: method('renamed').parameters,
    })
    expect(callResources(ctx.typert, { 'test-shelf': () => 'override' }, method('request'), {
      request: { address: { id: 'r1' } },
    }, NEVER)).toEqual([shelf('override')])
    await dispose()
    expect(ctx.typert.resources.entries()).toEqual([])
    ctx.typert.resources.register('test-shelf', { resolve: () => { throw new Error('cannot resolve') } })
    expect(callResources(ctx.typert, undefined, method('request'), { request: {} }, NEVER)).toBeUndefined()
  })

  it('rejects arrays from a default resolver instead of authorizing several identities', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(TypertRegistry)
    for (const ids of [[], ['r1'], ['r1', 'r2']]) {
      const dispose = ctx.typert.resources.register('test-shelf', {
        // Exercise invalid results from an untyped provider at the authorization boundary.
        resolve: () => ids as never,
      })
      expect(callResources(ctx.typert, undefined, method(), {}, NEVER)).toBeUndefined()
      await dispose()
    }
  })

  it('lets a reader replace the defaults for its kind, called with the positional wire arguments', async () => {
    const typert = await registry()
    const readers = { 'test-shelf': (ids: unknown) => ids }
    expect(callResources(typert, readers, method('ids'), { ids: ['r1', 'r2'] }, NEVER))
      .toEqual([ROOM, { kind: 'test-shelf', id: 'r2' }])
    expect(callResources(typert, readers, method('ids', 'roomId'), { ids: undefined, roomId: 'r9' }, NEVER))
      .toEqual([GLOBAL])
    const signal = new AbortController().signal
    const positional = vi.fn((...args: readonly unknown[]) => (args.at(-1) === signal ? args[1] : 'wrong'))
    expect(callResources(typert, { 'test-desk': positional }, {
      ...method('first', 'desk'), cancellation: { parameter: 'signal' },
    }, { first: 'f', desk: 'd1' }, signal)).toEqual([DESK])
    expect(positional).toHaveBeenCalledWith('f', 'd1', signal)
  })

  it('reads lookup parameters and a Context identity of a declared kind, an omitted optional lookup as none', async () => {
    const typert = await registry()
    typert.lookups.register('gatewayAccessAgent', {
      parameter: 'agent',
      wire: 'agentId',
      resource: 'test-desk',
      hostTypeSymbol: '@fixture/access#Agent',
      wireTypeSymbol: '@fixture/access#AgentId',
      resolve: (id: string) => ({ id }),
    })
    typert.contexts.registerHost('gatewayAccessScope', {
      wire: 'scopeId', wireTypeSymbol: '@fixture/access#ScopeId', resource: 'test-desk', resolve: () => undefined,
    })
    const agent = { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'gatewayAccessAgent' } as InvocationParameterDescriptor
    const unknownLookup = { name: 'other', wire: 'otherId', source: 'lookup', lookup: 'absentLookup' } as InvocationParameterDescriptor
    expect(callResources(typert, undefined, { invocation: DIRECT, parameters: [agent, unknownLookup] }, { agentId: undefined, otherId: 'o1' }, NEVER))
      .toEqual([GLOBAL])
    expect(callResources(typert, undefined, { invocation: DIRECT, parameters: [agent] }, { agentId: 'd1' }, NEVER))
      .toEqual([DESK])
    const scoped = (context: string): InvocationDescriptor['invocation'] => ({ kind: 'context', context, wire: 'scopeId', codec: { mode: 'src-json' } })
    expect(callResources(typert, undefined, { invocation: scoped('gatewayAccessScope'), parameters: [agent] }, { scopeId: 'd0', agentId: 'd1' }, NEVER))
      .toEqual([{ kind: 'test-desk', id: 'd0' }, DESK])
    // A required Context identity is never omitted, so a missing one is malformed.
    expect(callResources(typert, undefined, { invocation: scoped('gatewayAccessScope'), parameters: [] }, {}, NEVER))
      .toBeUndefined()
    expect(callResources(typert, undefined, { invocation: scoped('absentScope'), parameters: [] }, { scopeId: 'd0' }, NEVER))
      .toEqual([GLOBAL])
  })

  it('reports invalid resources when a reader throws or returns an empty list, or a resource id is not a non-empty string', async () => {
    const typert = await registry()
    const one = method('value')
    const throwing = { 'test-shelf': () => { throw new TypeError('malformed call') } }
    expect(callResources(typert, throwing, one, { value: 1 }, NEVER)).toBeUndefined()
    for (const value of ['', 7, ['r1', ''], [null], []]) {
      expect(callResources(typert, { 'test-shelf': (read: unknown) => read }, one, { value }, NEVER)).toBeUndefined()
    }
    // A default field names exactly one identity, so an array is malformed.
    for (const roomId of [7, ['r1'], '']) {
      expect(callResources(typert, undefined, method('roomId'), { roomId }, NEVER)).toBeUndefined()
    }
  })

  it('reads a forwarded event through the readers its entry declares, and the global resource without them', () => {
    expect(eventResources(undefined, ['r1'])).toEqual([GLOBAL])
    expect(eventResources({}, ['r1'])).toEqual([GLOBAL])
    expect(eventResources({ 'test-shelf': (id: unknown) => id }, ['r1'])).toEqual([ROOM])
    expect(eventResources({ 'test-desk': (_first: unknown, second: unknown) => second }, ['r1', 'd1']))
      .toEqual([DESK])
    // An event carries every resource it declares, so a missing one is invalid rather than a global event.
    expect(eventResources({ 'test-shelf': () => undefined }, ['r1'])).toBeUndefined()
    expect(eventResources({ 'test-shelf': () => [] }, ['r1'])).toBeUndefined()
    expect(eventResources({ 'test-shelf': () => 7 }, ['r1'])).toBeUndefined()
  })
})
