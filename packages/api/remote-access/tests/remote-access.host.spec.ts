import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import {
  Remote,
  TypertRemoteService,
  type PeerScope,
  type Principal,
  type PrincipalMap,
  type RemoteInvocation,
  type TypertResource,
} from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccessService, {
  REMOTE_ACCESS_SNAPSHOT_KEY,
  type RemoteAccessBinding,
  type RemoteAccessCondition,
  type RemoteAccessFrame,
  type RemoteAccessGrant,
  type RemoteAccessPolicy,
  type RemoteAccessRequest,
  type RemoteAccessResource,
  type RemoteAccessResourceOf,
  type RemoteAccessRole,
} from '../src/index.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller shared by the access specs. */
    'test-guest': { readonly kind: 'test-guest'; readonly guest: string }
    /** Test-only non-owner caller whose identity carries a list. */
    'test-crew': { readonly kind: 'test-crew'; readonly members: readonly string[] }
  }
  interface TypertResourceMap {
    /** Test-only resource kinds; the service itself names no kind. */
    'test-shelf': TypertResource<string>
    'test-desk': TypertResource<string>
  }
}

type Guest = PrincipalMap['test-guest']

const OWNER: Principal = { kind: 'owner' }
const GUEST: Guest = { kind: 'test-guest', guest: 'a' }
const OTHER: Guest = { kind: 'test-guest', guest: 'b' }
const CREW: Principal = { kind: 'test-crew', members: ['a', 'b'] }
const GLOBAL: RemoteAccessResourceOf<'global'> = { kind: 'global' }
const ROOM: RemoteAccessResourceOf<'test-shelf'> = { kind: 'test-shelf', id: 'r1' }
const ROOM2: RemoteAccessResourceOf<'test-shelf'> = { kind: 'test-shelf', id: 'r2' }
const DESK: RemoteAccessResourceOf<'test-desk'> = { kind: 'test-desk', id: 'd1' }

const READER: RemoteAccessRole<'global'> = {
  name: 'test:reader',
  resource: 'global',
  actions: ['notes/read', 'notes/rooms', 'notes/write', 'event:notes/changed'],
}
const SHELF_READER: RemoteAccessRole<'test-shelf'> = {
  name: 'test:shelf-reader',
  resource: 'test-shelf',
  actions: ['notes/rooms', 'notes/read', 'event:notes/changed'],
}
const SHELF_WRITER: RemoteAccessRole<'test-shelf'> = { name: 'test:shelf-writer', resource: 'test-shelf', actions: ['notes/write'] }
const DESK_WRITER: RemoteAccessRole<'test-desk'> = { name: 'test:desk-writer', resource: 'test-desk', actions: ['notes/write'] }

class Notes extends TypertRemoteService {
  static inject = ['remoteAccess']

  constructor(ctx: Context) { super(ctx, 'notes') }

  @Remote
  read(): string { return 'read' }

  /** Resolves to the shelf its request names through the registered default field. */
  @Remote
  write(request: { readonly shelfId: string; readonly text: string }): string { return request.text }

  @Remote
  hidden(): string { return 'hidden' }

  /** A list method: a global call, then one `allows()` check per item. */
  @Remote
  rooms(): string[] {
    return ['r1', 'r2'].filter(id => this.ctx.remoteAccess.allows({ kind: 'test-shelf', id }))
  }
}

/** A policy whose bindings live in memory per guest, the way a business package preloads them. */
class GuestPolicy implements RemoteAccessPolicy<Guest> {
  readonly held = new Map<string, readonly RemoteAccessBinding[]>()
  readonly bindings = vi.fn((guest: Guest): readonly RemoteAccessBinding[] => this.held.get(guest.guest) ?? [])

  hold(guest: Guest, ...bindings: RemoteAccessBinding[]): void {
    this.held.set(guest.guest, bindings)
  }
}

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(): Promise<{ readonly ctx: Context; readonly access: RemoteAccessService }> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService)
  ctx.typert.resources.register('test-shelf', { field: 'shelfId' })
  await ctx.plugin(Notes)
  return { ctx, access: ctx.remoteAccess }
}

function call(ctx: Context, principal: Principal, method: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return ctx.typertGateway.invoke({ peer: new Peer(ctx, { principal }), namespace: 'notes', method, args })
}

/** A request by `principal` for `action` on `resources`. */
function ask(principal: Principal, action: RemoteAccessRequest<Principal>['action'], ...resources: RemoteAccessResource[]): RemoteAccessRequest<Principal> {
  return { principal, action, resources }
}

const NEVER = new AbortController().signal

/** The invocation a Gateway binds while dispatching `remoteAccess/follow` for one principal. */
function invocationOf(ctx: Context, principal: Principal, method = 'follow', namespace = 'remoteAccess'): RemoteInvocation {
  return {
    request: { namespace, method, args: {} },
    service: namespace,
    peer: new Peer(ctx, { principal }),
    signal: NEVER,
    uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
  }
}

async function follow(ctx: Context, principal: Principal): Promise<{
  readonly frames: RemoteAccessFrame[]
  readonly next: () => Promise<RemoteAccessFrame>
  readonly stop: () => Promise<void>
}> {
  const abort = new AbortController()
  const peer: PeerScope = new Peer(ctx, { principal })
  const stream = await ctx.typertGateway.stream({ peer, namespace: 'remoteAccess', method: 'follow', args: {}, signal: abort.signal })
  const iterator = stream[Symbol.asyncIterator]()
  const frames: RemoteAccessFrame[] = []
  return {
    frames,
    next: async () => {
      const result = await iterator.next()
      if (result.done === true) throw new Error('access stream ended')
      const frame = result.value as RemoteAccessFrame
      frames.push(frame)
      return frame
    },
    stop: async () => {
      abort.abort()
      await iterator.return?.()
    },
  }
}

interface SpiedListenerMethod {
  readonly mock: { readonly calls: readonly unknown[][]; readonly contexts: readonly unknown[] }
}

/** `abort` registrations a spied `EventTarget` method received on AbortSignals. */
function abortListenerCalls(spy: SpiedListenerMethod): number {
  return spy.mock.calls.filter((args, index) => args[0] === 'abort' && spy.mock.contexts[index] instanceof AbortSignal).length
}

describe('RemoteAccessService registrations', () => {
  it('removes a policy with its disposer and with the plugin fiber that registered it', async () => {
    const { ctx, access } = await setup()
    const policy = new GuestPolicy()
    policy.hold(GUEST, { role: READER, resource: GLOBAL })
    const dispose = access.registerPolicy('test-guest', policy)
    await expect(call(ctx, GUEST, 'read')).resolves.toBe('read')
    dispose()
    await expect(call(ctx, GUEST, 'read')).rejects.toMatchObject({ code: 'remote-access/denied', details: { reason: 'no-allow' } })
    const fiber = ctx.plugin({
      inject: ['remoteAccess'],
      apply: (pluginCtx: Context) => { pluginCtx.remoteAccess.registerPolicy('test-guest', policy) },
    })
    await fiber
    await expect(call(ctx, GUEST, 'read')).resolves.toBe('read')
    await fiber.dispose()
    await expect(call(ctx, GUEST, 'read')).rejects.toMatchObject({ code: 'remote-access/denied', details: { reason: 'no-allow' } })
  })

  it('accepts one policy per principal kind', async () => {
    const { access } = await setup()
    access.registerPolicy('test-guest', new GuestPolicy())
    expect(() => access.registerPolicy('test-guest', new GuestPolicy()))
      .toThrow('remote access: principal kind "test-guest" already has a policy')
    access.registerPolicy('test-crew', { bindings: () => [{ role: READER, resource: GLOBAL }] })
    expect(access.decide(ask(CREW, 'notes/read', GLOBAL))).toEqual({ kind: 'allow' })
  })
})

describe('RemoteAccessService.decide', () => {
  it('allows the owner without any policy and refuses a kind without a policy', async () => {
    const { ctx, access } = await setup()
    expect(access.decide(ask(OWNER, 'notes/hidden', ROOM))).toEqual({ kind: 'allow' })
    await expect(call(ctx, OWNER, 'hidden')).resolves.toBe('hidden')
    await expect(call(ctx, GUEST, 'read')).rejects.toMatchObject({
      code: 'remote-access/denied', details: { action: 'notes/read', reason: 'no-allow' },
    })
  })

  it('allows only actions a bound role lists on the resource the binding names', async () => {
    const { ctx, access } = await setup()
    const policy = new GuestPolicy()
    access.registerPolicy('test-guest', policy)
    policy.hold(GUEST, { role: READER, resource: GLOBAL }, { role: SHELF_WRITER, resource: ROOM })
    await expect(call(ctx, GUEST, 'read')).resolves.toBe('read')
    await expect(call(ctx, GUEST, 'hidden')).rejects.toMatchObject({ details: { action: 'notes/hidden', reason: 'no-allow' } })
    await expect(call(ctx, GUEST, 'write', { request: { shelfId: 'r1', text: 'hi' } })).resolves.toBe('hi')
    await expect(call(ctx, GUEST, 'write', { request: { shelfId: 'r2', text: 'hi' } })).rejects.toMatchObject({ details: { reason: 'no-allow' } })
    await expect(call(ctx, OTHER, 'read')).rejects.toMatchObject({ details: { reason: 'no-allow' } })
    // Resources are independent: a global grant implies nothing on a shelf, and a shelf grant nothing on global.
    expect(access.decide(ask(GUEST, 'notes/read', ROOM))).toEqual({ kind: 'deny', reason: 'no-allow' })
    expect(access.decide(ask(GUEST, 'notes/write', GLOBAL))).toEqual({ kind: 'allow' })
    policy.hold(GUEST, { role: SHELF_WRITER, resource: ROOM })
    expect(access.decide(ask(GUEST, 'notes/write', GLOBAL))).toEqual({ kind: 'deny', reason: 'no-allow' })
  })

  it('requires the action on every resource of the target', async () => {
    const { access } = await setup()
    const policy = new GuestPolicy()
    access.registerPolicy('test-guest', policy)
    const both = ask(GUEST, 'notes/write', ROOM, DESK)
    policy.hold(GUEST, { role: SHELF_WRITER, resource: ROOM })
    expect(access.decide(both)).toEqual({ kind: 'deny', reason: 'no-allow' })
    policy.hold(GUEST, { role: SHELF_WRITER, resource: ROOM }, { role: DESK_WRITER, resource: DESK })
    expect(access.decide(both)).toEqual({ kind: 'allow' })
    expect(policy.bindings).toHaveBeenCalledTimes(2)
  })

  it('asks a matching binding\'s condition, which can refuse with its own reason', async () => {
    const { ctx, access } = await setup()
    const policy = new GuestPolicy()
    access.registerPolicy('test-guest', policy)
    const paused = vi.fn<RemoteAccessCondition<'test-shelf'>>(() => ({ kind: 'deny', reason: 'shelf-paused' }))
    const locked = vi.fn<RemoteAccessCondition<'test-shelf'>>(() => ({ kind: 'deny', reason: 'shelf-locked' }))
    const short = vi.fn<RemoteAccessCondition<'test-shelf'>>(({ args }) => {
      const request: unknown = args?.['request']
      return typeof request === 'object' && request !== null && Reflect.get(request, 'text') === 'ok'
        ? { kind: 'allow' }
        : { kind: 'deny', reason: 'text-refused' }
    })
    const unrelated = vi.fn<RemoteAccessCondition<'test-shelf'>>(() => ({ kind: 'allow' }))
    policy.hold(GUEST,
      { role: SHELF_READER, resource: ROOM, condition: unrelated },
      { role: SHELF_WRITER, resource: ROOM2, condition: unrelated },
      { role: SHELF_WRITER, resource: ROOM, condition: paused },
      { role: SHELF_WRITER, resource: ROOM, condition: locked })
    await expect(call(ctx, GUEST, 'write', { request: { shelfId: 'r1', text: 'x' } })).rejects.toMatchObject({
      code: 'remote-access/denied', details: { action: 'notes/write', reason: 'shelf-paused' },
    })
    expect(paused).toHaveBeenCalledWith({ action: 'notes/write', resource: ROOM, args: { request: { shelfId: 'r1', text: 'x' } } })
    expect(locked).toHaveBeenCalledOnce()
    // A condition runs only for a binding whose resource matches and whose role lists the action.
    expect(unrelated).not.toHaveBeenCalled()

    policy.hold(GUEST, { role: SHELF_WRITER, resource: ROOM, condition: short })
    await expect(call(ctx, GUEST, 'write', { request: { shelfId: 'r1', text: 'x' } })).rejects.toMatchObject({ details: { reason: 'text-refused' } })
    await expect(call(ctx, GUEST, 'write', { request: { shelfId: 'r1', text: 'ok' } })).resolves.toBe('ok')

    // Any binding without a condition, or with an allowing one, allows.
    policy.hold(GUEST, { role: SHELF_WRITER, resource: ROOM, condition: paused }, { role: SHELF_WRITER, resource: ROOM })
    expect(access.decide(ask(GUEST, 'notes/write', ROOM))).toEqual({ kind: 'allow' })
    expect(paused).toHaveBeenLastCalledWith({ action: 'notes/write', resource: ROOM })
  })

  it('names the reason explain() gives once no binding allows, without changing the decision', async () => {
    const { access } = await setup()
    const policy = new GuestPolicy()
    const explain = vi.fn((request: { readonly action: string }) => (request.action === 'notes/write' ? 'share-not-writable' : undefined))
    access.registerPolicy('test-guest', { bindings: policy.bindings, explain })
    policy.hold(GUEST, { role: READER, resource: GLOBAL })
    expect(access.decide(ask(GUEST, 'notes/read', GLOBAL))).toEqual({ kind: 'allow' })
    expect(explain).not.toHaveBeenCalled()
    const write = { ...ask(GUEST, 'notes/write', ROOM, DESK), args: { request: {} } }
    expect(access.decide(write)).toEqual({ kind: 'deny', reason: 'share-not-writable' })
    expect(explain).toHaveBeenCalledWith({ principal: GUEST, action: 'notes/write', resources: [ROOM, DESK], args: { request: {} } })
    expect(access.decide(ask(GUEST, 'notes/hidden', GLOBAL))).toEqual({ kind: 'deny', reason: 'no-allow' })
    expect(explain).toHaveBeenLastCalledWith({ principal: GUEST, action: 'notes/hidden', resources: [GLOBAL] })
    // A refusing condition's reason comes first.
    const paused: RemoteAccessCondition<'test-shelf'> = () => ({ kind: 'deny', reason: 'shelf-paused' })
    policy.hold(GUEST, { role: SHELF_WRITER, resource: ROOM, condition: paused })
    expect(access.decide(ask(GUEST, 'notes/write', ROOM))).toEqual({ kind: 'deny', reason: 'shelf-paused' })
    expect(explain).toHaveBeenCalledTimes(2)
  })

  it('refuses with policy-failed when bindings(), a condition, or explain() throws, logging each policy once per change', async () => {
    const { ctx, access } = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const failures = (): unknown[] => warn.mock.calls.flatMap(([value]) => (value instanceof Error ? [value.message] : []))
    let mode: 'bindings' | 'condition' | 'explain' = 'bindings'
    access.registerPolicy('test-guest', {
      bindings: () => {
        if (mode === 'bindings') throw new Error('binding store unavailable')
        return [{ role: SHELF_WRITER, resource: ROOM, condition: () => { throw new Error('condition failed') } }]
      },
      explain: () => { throw new Error('explain failed') },
    })
    access.registerPolicy('test-crew', { bindings: () => { throw new Error('crew store unavailable') } })
    for (let round = 0; round < 3; round++) {
      expect(access.decide(ask(GUEST, 'notes/write', ROOM))).toEqual({ kind: 'deny', reason: 'policy-failed' })
      expect(access.decide(ask(CREW, 'notes/write', ROOM))).toEqual({ kind: 'deny', reason: 'policy-failed' })
    }
    await expect(call(ctx, GUEST, 'write', { request: { shelfId: 'r1', text: 'x' } })).rejects.toMatchObject({
      code: 'remote-access/denied', details: { action: 'notes/write', reason: 'policy-failed' },
    })
    expect(failures()).toEqual(['binding store unavailable', 'crew store unavailable'])
    expect(warn).toHaveBeenCalledWith(
      'remote access: the "test-guest" policy failed to list bindings for notes/write; its further failures are not logged until access state changes')

    mode = 'condition'
    access.invalidate(OTHER)
    expect(access.decide(ask(GUEST, 'notes/write', ROOM))).toEqual({ kind: 'deny', reason: 'policy-failed' })
    expect(warn).toHaveBeenCalledWith(
      'remote access: the "test-guest" policy failed to evaluate a condition for notes/write; its further failures are not logged until access state changes')

    mode = 'explain'
    access.invalidate()
    expect(access.decide(ask(GUEST, 'notes/read', ROOM))).toEqual({ kind: 'deny', reason: 'policy-failed' })
    expect(warn).toHaveBeenCalledWith(
      'remote access: the "test-guest" policy failed to explain a refusal of notes/read; its further failures are not logged until access state changes')
    expect(failures()).toEqual(['binding store unavailable', 'crew store unavailable', 'condition failed', 'explain failed'])
  })

  it('always lets a Peer open its own access snapshot', async () => {
    const { ctx, access } = await setup()
    access.registerPolicy('test-guest', { bindings: () => [] })
    const guest = await follow(ctx, GUEST)
    await expect(guest.next()).resolves.toEqual({ type: 'baseline', owner: false, grants: [] })
    await guest.stop()
  })
})

describe('RemoteAccessService.allows', () => {
  it('filters list items for non-owners on one resource without arguments', async () => {
    const { ctx, access } = await setup()
    const policy = new GuestPolicy()
    access.registerPolicy('test-guest', policy)
    const reader = vi.fn<RemoteAccessCondition<'test-shelf'>>(() => ({ kind: 'allow' }))
    policy.hold(GUEST, { role: READER, resource: GLOBAL }, { role: SHELF_READER, resource: ROOM, condition: reader })
    await expect(call(ctx, GUEST, 'rooms')).resolves.toEqual(['r1'])
    expect(reader).toHaveBeenCalledWith({ action: 'notes/rooms', resource: ROOM })
    // One call for the Gateway's decision and one per item check.
    expect(policy.bindings).toHaveBeenCalledTimes(3)
    policy.bindings.mockClear()
    await expect(call(ctx, OWNER, 'rooms')).resolves.toEqual(['r1', 'r2'])
    expect(access.allows(ROOM)).toBe(true)
    expect(policy.bindings).not.toHaveBeenCalled()
  })

  it('reads the bindings on every check, so a running call sees binding changes from its next check on', async () => {
    const { ctx, access } = await setup()
    const policy = new GuestPolicy()
    access.registerPolicy('test-guest', policy)
    policy.hold(GUEST, { role: SHELF_READER, resource: ROOM })
    // One long-running call, such as a follow stream that filters every frame.
    const stream = ctx.extend({ invocation: invocationOf(ctx, GUEST, 'rooms', 'notes') }).remoteAccess
    expect(stream.allows(ROOM)).toBe(true)
    expect(stream.allows(ROOM2)).toBe(false)
    policy.hold(GUEST, { role: SHELF_READER, resource: ROOM2 })
    expect(stream.allows(ROOM)).toBe(false)
    expect(stream.allows(ROOM2)).toBe(true)
  })

  it('allows nothing when the principal kind has no policy or the policy fails', async () => {
    const { ctx, access } = await setup()
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const crewCall = ctx.extend({ invocation: invocationOf(ctx, CREW, 'rooms', 'notes') })
    expect(crewCall.remoteAccess.allows(ROOM)).toBe(false)
    const bindings = vi.fn((): readonly RemoteAccessBinding[] => { throw new Error('binding store unavailable') })
    access.registerPolicy('test-guest', { bindings })
    const guestCall = ctx.extend({ invocation: invocationOf(ctx, GUEST, 'rooms', 'notes') })
    expect(guestCall.remoteAccess.allows(ROOM)).toBe(false)
    expect(guestCall.remoteAccess.allows(ROOM2)).toBe(false)
    expect(bindings).toHaveBeenCalledTimes(2)
  })
})

describe('first snapshots', () => {
  it('gives the owner the owner baseline and a non-owner its current grants', async () => {
    const { access } = await setup()
    const policy = new GuestPolicy()
    policy.hold(GUEST, { role: READER, resource: GLOBAL })
    access.registerPolicy('test-guest', policy)
    expect(access.snapshotFor(OWNER)).toEqual({ type: 'baseline', owner: true })
    expect(access.snapshotFor(GUEST)).toEqual({
      type: 'baseline', owner: false, grants: [{ resource: GLOBAL, actions: ['notes/read', 'notes/rooms', 'notes/write'] }],
    })
    expect(access.snapshotFor(CREW)).toEqual({ type: 'baseline', owner: false, grants: [] })
    expect(REMOTE_ACCESS_SNAPSHOT_KEY).toBe('__DSH_REMOTE_ACCESS__')
  })

  it('injects the access snapshot of the Peer each index speaks for', async () => {
    const { ctx, access } = await setup()
    const policy = new GuestPolicy()
    policy.hold(GUEST, { role: READER, resource: GLOBAL })
    access.registerPolicy('test-guest', policy)
    const render = (principal: Principal): IndexInjection[] => {
      const table: IndexInjection[] = []
      ctx.emit('webserver/index-inject', table, new Peer(ctx, { principal }))
      return table
    }
    expect(render(OWNER)).toEqual([])
    ctx.provide('webServer', {} as Context['webServer'])
    await vi.waitFor(() => {
      expect(render(OWNER)).toEqual([{ kind: 'global', name: '__DSH_REMOTE_ACCESS__', value: { type: 'baseline', owner: true } }])
    })
    expect(render(GUEST)).toEqual([{ kind: 'global', name: '__DSH_REMOTE_ACCESS__', value: {
      type: 'baseline', owner: false, grants: [{ resource: GLOBAL, actions: ['notes/read', 'notes/rooms', 'notes/write'] }],
    } }])
    // A grant change reaches the next render.
    policy.hold(GUEST)
    expect(render(GUEST)).toEqual([{ kind: 'global', name: '__DSH_REMOTE_ACCESS__', value: { type: 'baseline', owner: false, grants: [] } }])
  })

  it('lists per bound resource the endpoint actions decide() allows there without arguments, and no grant where none is allowed', async () => {
    const { ctx, access } = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const policy = new GuestPolicy()
    access.registerPolicy('test-guest', policy)
    const writeOnly: RemoteAccessCondition<'test-shelf'> = ({ action }) =>
      action === 'notes/write' ? { kind: 'allow' } : { kind: 'deny', reason: 'read-paused' }
    policy.hold(GUEST,
      { role: SHELF_READER, resource: ROOM, condition: writeOnly },
      { role: SHELF_WRITER, resource: ROOM },
      { role: DESK_WRITER, resource: DESK, condition: () => { throw new Error('condition failed') } },
      { role: READER, resource: GLOBAL })
    const grants: RemoteAccessGrant[] = [
      { resource: ROOM, actions: ['notes/write'] },
      { resource: GLOBAL, actions: ['notes/read', 'notes/rooms', 'notes/write'] },
    ]
    expect(access.snapshotFor(GUEST)).toEqual({ type: 'baseline', owner: false, grants })
    for (const resource of [ROOM, GLOBAL]) {
      for (const action of ['notes/read', 'notes/rooms', 'notes/write'] as const) {
        const listed = grants.find(grant => grant.resource === resource)?.actions.includes(action) === true
        expect(access.decide(ask(GUEST, action, resource)).kind).toBe(listed ? 'allow' : 'deny')
      }
    }
    // Event actions are decided per notification and never enter the snapshot.
    expect(access.decide(ask(GUEST, 'event:notes/changed', GLOBAL))).toEqual({ kind: 'allow' })
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'condition failed' }))
  })

  it('gives a principal whose bindings() throws no grant', async () => {
    const { ctx, access } = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    access.registerPolicy('test-guest', { bindings: () => { throw new Error('binding store unavailable') } })
    expect(access.snapshotFor(GUEST)).toEqual({ type: 'baseline', owner: false, grants: [] })
    const guest = await follow(ctx, GUEST)
    await expect(guest.next()).resolves.toEqual({ type: 'baseline', owner: false, grants: [] })
    expect(warn).toHaveBeenCalledWith(
      'remote access: the "test-guest" policy failed to list bindings for a snapshot; its further failures are not logged until access state changes')
    await guest.stop()
  })
})

describe('remoteAccess/follow', () => {
  it('sends the owner one owner baseline and nothing else', async () => {
    const { ctx } = await setup()
    const owner = await follow(ctx, OWNER)
    await expect(owner.next()).resolves.toEqual({ type: 'baseline', owner: true })
    await owner.stop()
    expect(owner.frames).toHaveLength(1)

    // Outside a Remote call the caller is trusted in-process code, answered as the owner.
    for (const abortWhileWaiting of [false, true]) {
      const abort = new AbortController()
      const direct = ctx.remoteAccess.follow(abort.signal)[Symbol.asyncIterator]()
      await expect(direct.next()).resolves.toEqual({ done: false, value: { type: 'baseline', owner: true } })
      if (!abortWhileWaiting) abort.abort()
      const end = direct.next()
      if (abortWhileWaiting) abort.abort()
      await expect(end).resolves.toEqual({ done: true, value: undefined })
    }
  })

  it('pushes upserts and removals after invalidation and policy changes', async () => {
    const { ctx, access } = await setup()
    const policy = new GuestPolicy()
    access.registerPolicy('test-guest', policy)
    const guest = await follow(ctx, GUEST)
    const other = await follow(ctx, OTHER)
    const crew = await follow(ctx, CREW)
    await expect(guest.next()).resolves.toEqual({ type: 'baseline', owner: false, grants: [] })
    await other.next()
    await expect(crew.next()).resolves.toEqual({ type: 'baseline', owner: false, grants: [] })

    policy.hold(GUEST, { role: SHELF_WRITER, resource: ROOM })
    access.invalidate(GUEST)
    await expect(guest.next()).resolves.toEqual({ type: 'upsert', grant: { resource: ROOM, actions: ['notes/write'] } })

    policy.hold(GUEST, { role: SHELF_WRITER, resource: ROOM }, { role: SHELF_READER, resource: ROOM })
    access.invalidate()
    await expect(guest.next()).resolves.toEqual({
      type: 'upsert', grant: { resource: ROOM, actions: ['notes/read', 'notes/rooms', 'notes/write'] },
    })

    policy.hold(GUEST, { role: READER, resource: GLOBAL })
    access.invalidate(GUEST)
    await expect(guest.next()).resolves.toEqual({
      type: 'upsert', grant: { resource: GLOBAL, actions: ['notes/read', 'notes/rooms', 'notes/write'] },
    })
    await expect(guest.next()).resolves.toEqual({ type: 'remove', resource: ROOM })

    // An unchanged grant is not pushed again.
    policy.hold(GUEST, { role: READER, resource: GLOBAL }, { role: SHELF_WRITER, resource: ROOM2 })
    access.invalidate(GUEST)
    await expect(guest.next()).resolves.toEqual({ type: 'upsert', grant: { resource: ROOM2, actions: ['notes/write'] } })
    policy.hold(GUEST,
      { role: { ...READER, actions: ['notes/hidden', 'notes/read', 'notes/rooms'] }, resource: GLOBAL },
      { role: SHELF_WRITER, resource: ROOM2 })
    access.invalidate(GUEST)
    await expect(guest.next()).resolves.toEqual({
      type: 'upsert', grant: { resource: GLOBAL, actions: ['notes/hidden', 'notes/read', 'notes/rooms'] },
    })
    // A resource on which no action stays allowed loses its grant.
    const paused: RemoteAccessCondition<'test-shelf'> = () => ({ kind: 'deny', reason: 'shelf-paused' })
    policy.hold(GUEST,
      { role: { ...READER, actions: ['notes/hidden', 'notes/read', 'notes/rooms'] }, resource: GLOBAL },
      { role: SHELF_WRITER, resource: ROOM2, condition: paused })
    access.invalidate(GUEST)
    await expect(guest.next()).resolves.toEqual({ type: 'remove', resource: ROOM2 })

    const disposeCrew = access.registerPolicy('test-crew', { bindings: () => [{ role: SHELF_WRITER, resource: ROOM2 }] })
    await expect(crew.next()).resolves.toEqual({ type: 'upsert', grant: { resource: ROOM2, actions: ['notes/write'] } })
    access.invalidate({ kind: 'test-crew', members: ['a', 'b'] })
    disposeCrew()
    await expect(crew.next()).resolves.toEqual({ type: 'remove', resource: ROOM2 })

    await guest.stop()
    await crew.stop()
    // Every recomputation for the other principal produced the same grants, so it received no increment.
    expect(other.frames).toHaveLength(1)
    await other.stop()
  })

  it('keeps no abort listener from a wait that a change ended', async () => {
    const { ctx, access } = await setup()
    const policy = new GuestPolicy()
    access.registerPolicy('test-guest', policy)
    const abort = new AbortController()
    const stream = ctx.extend({ invocation: invocationOf(ctx, GUEST) }).remoteAccess.follow(abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    const add = vi.spyOn(EventTarget.prototype, 'addEventListener')
    const remove = vi.spyOn(EventTarget.prototype, 'removeEventListener')
    try {
      for (let round = 0; round < 30; round++) {
        // The reader is already waiting when the change arrives.
        const pending = stream.next()
        policy.hold(GUEST, { role: round % 2 === 0 ? READER : { ...READER, actions: ['notes/read'] }, resource: GLOBAL })
        access.invalidate(GUEST)
        await expect(pending).resolves.toMatchObject({ done: false, value: { type: 'upsert' } })
      }
      expect(abortListenerCalls(add)).toBeGreaterThan(0)
      expect(abortListenerCalls(add) - abortListenerCalls(remove)).toBe(0)
    } finally {
      add.mockRestore()
      remove.mockRestore()
    }
    abort.abort()
    await stream.return?.()
  })

  it('ends every open generation when the service unloads, so a reloaded service starts from a fresh baseline', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(TypertRegistry)
    const service = ctx.plugin(RemoteAccessService)
    await service
    await ctx.plugin(TypertGatewayService)
    await ctx.plugin(Notes)
    const policy = new GuestPolicy()
    policy.hold(GUEST, { role: READER, resource: GLOBAL })
    ctx.remoteAccess.registerPolicy('test-guest', policy)
    const open = async (principal: Principal): Promise<AsyncIterator<unknown>> =>
      (await ctx.typertGateway.stream({
        peer: new Peer(ctx, { principal }), namespace: 'remoteAccess', method: 'follow', args: {},
      }))[Symbol.asyncIterator]()
    const guest = await open(GUEST)
    const owner = await open(OWNER)
    await expect(guest.next()).resolves.toMatchObject({
      value: { type: 'baseline', grants: [{ resource: GLOBAL, actions: ['notes/read', 'notes/rooms', 'notes/write'] }] },
    })
    await expect(owner.next()).resolves.toMatchObject({ value: { type: 'baseline', owner: true } })
    const guestEnd = guest.next()
    await service.dispose()
    await expect(guestEnd).resolves.toEqual({ done: true, value: undefined })
    await expect(owner.next()).resolves.toEqual({ done: true, value: undefined })

    await ctx.plugin(RemoteAccessService)
    await vi.waitFor(() => { expect(ctx.get('typertGateway')).toBeDefined() })
    const reopened = await follow(ctx, GUEST)
    await expect(reopened.next()).resolves.toEqual({ type: 'baseline', owner: false, grants: [] })
    await reopened.stop()
  })

  it('stops a non-owner generation that is cancelled while waiting', async () => {
    const { ctx, access } = await setup()
    access.registerPolicy('test-guest', new GuestPolicy())
    const abort = new AbortController()
    const stream = ctx.extend({ invocation: invocationOf(ctx, GUEST) }).remoteAccess.follow(abort.signal)[Symbol.asyncIterator]()
    await expect(stream.next()).resolves.toMatchObject({ value: { type: 'baseline', owner: false } })
    const pending = stream.next()
    abort.abort()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    // A cancelled generation no longer receives invalidations.
    access.invalidate()
  })
})
