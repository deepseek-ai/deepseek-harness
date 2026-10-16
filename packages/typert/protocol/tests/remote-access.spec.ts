import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  Remote,
  RemoteScope,
  principalOf,
  remoteMethods,
  type PeerScope,
  type Principal,
  type RemoteAccessResource,
  type RemoteAccessResourceKind,
  type RemoteAccessResourceOf,
  type RemoteInvocation,
  type RemoteMethodMarker,
  type RemoteScopeOptions,
  type TypertContext,
  type TypertResource,
  type TypertResourceReader,
  type TypertLookup,
} from '@deepseek-ai/dsh-typert-protocol'

type WireSessionId = string & { readonly __wire: 'protocol-access-session' }

/** Its member name is unique, so no other spec's lookup Host type matches it structurally. */
interface AccessFixtureAgent {
  readonly protocolAccessAgentId: WireSessionId
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller shared by the access specs. */
    'test-guest': { readonly kind: 'test-guest'; readonly guest: string }
  }
  interface TypertLookupMap {
    protocolAccessAgent: TypertLookup<AccessFixtureAgent, WireSessionId>
  }
  interface TypertContextMap {
    protocolAccessRoom: TypertContext<WireSessionId>
  }
  interface TypertResourceMap {
    /** Test-only resource kind whose identity is the fixture's wire id. */
    'test-room': TypertResource<WireSessionId>
  }
}

const GUEST: Principal = { kind: 'test-guest', guest: 'g1' }
const OWNER: Principal = { kind: 'owner' }

function invocationAs(principal: Principal): RemoteInvocation {
  const peer = { principal } as PeerScope
  return { peer } as RemoteInvocation
}

function markerOf(service: object, method: string): RemoteMethodMarker {
  const marker = remoteMethods(service).find(candidate => candidate.method === method)
  if (marker === undefined) throw new Error(`${method} is not marked`)
  return marker
}

function readerOf(marker: RemoteMethodMarker, kind: string): TypertResourceReader {
  const reader = marker.resources?.[kind]
  if (reader === undefined) throw new Error(`${marker.method} declares no ${kind} reader`)
  return reader
}

describe('principalOf', () => {
  it('reports a non-owner caller and nothing for the owner or code outside a call', () => {
    expect(principalOf(undefined)).toBeUndefined()
    expect(principalOf(invocationAs(OWNER))).toBeUndefined()
    expect(principalOf(invocationAs(GUEST))).toBe(GUEST)
    const lookalike = JSON.parse('{"kind":"Owner"}') as Principal
    expect(principalOf(invocationAs(lookalike))).toBe(lookalike)
  })
})

describe('RemoteAccessResource', () => {
  it('names the identity-less global resource or one identity of a declared kind', () => {
    expectTypeOf<'global'>().toExtend<RemoteAccessResourceKind>()
    expectTypeOf<'test-room'>().toExtend<RemoteAccessResourceKind>()
    expectTypeOf<{ readonly kind: 'global' }>().toExtend<RemoteAccessResource>()
    expectTypeOf<{ readonly kind: 'test-room'; readonly id: WireSessionId }>().toExtend<RemoteAccessResource>()
    expectTypeOf<{ readonly kind: 'test-room' }>().not.toExtend<RemoteAccessResource>()
    expectTypeOf<{ readonly kind: 'test-room'; readonly id: string }>().not.toExtend<RemoteAccessResource>()
    expectTypeOf<RemoteAccessResourceOf<'global'>>().toEqualTypeOf<{ readonly kind: 'global' }>()
    expectTypeOf<RemoteAccessResourceOf<'test-room'>>().toEqualTypeOf<{ readonly kind: 'test-room'; readonly id: WireSessionId }>()
  })
})

describe('@Remote resources', () => {
  class Marked {
    @Remote
    plain(request: { readonly sessionId: string }): string { return request.sessionId }

    @Remote({ resources: { 'test-room': agent => agent } })
    lookup(agent: AccessFixtureAgent): string { return agent.protocolAccessAgentId }

    @Remote({ name: 'rooms', mode: 'stream', resources: { 'test-room': request => request.rooms } })
    *watch(request: { readonly rooms: readonly WireSessionId[] }): Iterable<number> { void request }
  }

  it('records frozen readers on the Remote marker when the Service is constructed', () => {
    const service = new Marked()
    expect(markerOf(service, 'plain')).toEqual({ method: 'plain', invocation: { kind: 'direct' } })
    const lookup = markerOf(service, 'lookup')
    expect(Object.isFrozen(lookup.resources)).toBe(true)
    expect(readerOf(lookup, 'test-room')('s1')).toBe('s1')
    const watch = markerOf(service, 'watch')
    expect(watch).toMatchObject({ method: 'watch', exportName: 'rooms', mode: 'stream', invocation: { kind: 'direct' } })
    expect(readerOf(watch, 'test-room')({ rooms: ['s1', 's2'] })).toEqual(['s1', 's2'])
    expect(remoteMethods(new Marked())).toEqual(remoteMethods(service))
  })

  it('rejects resources without a reader function at decoration time', () => {
    expect(() => Remote({ resources: {} })).toThrow('Remote resources require at least one reader')
    const notReader: unknown = 'session-id'
    expect(() => Remote({ resources: { 'test-room': notReader as () => undefined } }))
      .toThrow('Remote resource reader "test-room" must be a function')
  })

  it('rejects a second declaration of one method with other readers', () => {
    const initializers: Array<(this: object) => void> = []
    const context = (): ClassMethodDecoratorContext<object, (this: object, ...args: unknown[]) => unknown> => ({
      kind: 'method', name: 'run', private: false, static: false, metadata: {},
      access: { has: () => true, get: () => () => undefined },
      addInitializer: (initializer) => { initializers.push(initializer) },
    })
    const method = function (this: object): void {}
    const first = Remote({ resources: { 'test-room': () => undefined } })
    first(method, context())
    first(method, context())
    Remote({ resources: { 'test-room': () => undefined } })(method, context())
    const service = Object.create({}) as object
    initializers[0]!.call(service)
    initializers[1]!.call(service)
    expect(() => { initializers[2]!.call(service) }).toThrow('conflicting invocation markers')
  })

  it('infers each reader argument from the decorated method, mapping lookups to wire identities', () => {
    class Inferred {
      @Remote({
        resources: {
          'test-room': (agent, request) => {
            expectTypeOf(agent).toEqualTypeOf<WireSessionId>()
            expectTypeOf(request).toEqualTypeOf<{ readonly rooms: readonly WireSessionId[] }>()
            return request.rooms
          },
        },
      })
      both(agent: AccessFixtureAgent, request: { readonly rooms: readonly WireSessionId[] }): void { void agent; void request }

      @Remote({ resources: { 'test-room': (agent?) => { expectTypeOf(agent).toEqualTypeOf<WireSessionId | undefined>(); return agent } } })
      optional(agent?: AccessFixtureAgent): void { void agent }

      @Remote({
        mode: 'stream',
        resources: {
          'test-room': (request, signal) => {
            expectTypeOf(signal).toEqualTypeOf<AbortSignal>()
            return request.address.kind === 'room' ? request.address.roomId : undefined
          },
        },
      })
      *stream(
        request: { readonly address: { kind: 'room'; roomId: WireSessionId } | { kind: 'child'; childId: string } },
        signal: AbortSignal,
      ): Iterable<number> { void request; void signal }

      @Remote({
        resources: {
          'test-room': (request) => {
            expectTypeOf(request).toEqualTypeOf<{ readonly roomId: WireSessionId }>()
            return request.roomId
          },
        },
      })
      fewer(request: { readonly roomId: WireSessionId }, signal: AbortSignal): void { void request; void signal }

      // @ts-expect-error -- `nope` is not a field of the decorated method's request.
      // oxlint-disable-next-line typescript/no-unsafe-return -- the compile error above is the assertion.
      @Remote({ resources: { 'test-room': request => request.nope } })
      missing(request: { readonly roomId: WireSessionId }): void { void request }

      // @ts-expect-error -- the decorated method has no second argument.
      // oxlint-disable-next-line typescript/no-confusing-void-expression -- the failed overload resolution above is the assertion.
      @Remote({ resources: { 'test-room': (request, extra: WireSessionId) => extra } })
      outOfRange(request: { readonly roomId: WireSessionId }): void { void request }

      // @ts-expect-error -- the decorated method has no parameter after its signal.
      // oxlint-disable-next-line typescript/no-confusing-void-expression -- the failed overload resolution above is the assertion.
      @Remote({ resources: { 'test-room': (request, signal, extra: WireSessionId) => extra } })
      afterSignal(request: { readonly roomId: WireSessionId }, signal: AbortSignal): void { void request; void signal }

      // @ts-expect-error -- a reader for this kind returns its identity type, not a number.
      // oxlint-disable-next-line typescript/no-confusing-void-expression -- the failed overload resolution above is the assertion.
      @Remote({ resources: { 'test-room': () => 7 } })
      wrongIdentity(): void {}

      // @ts-expect-error -- `global` is a built-in resource with no identity, not a declared kind.
      // oxlint-disable-next-line typescript/no-confusing-void-expression -- the failed overload resolution above is the assertion.
      @Remote({ resources: { global: () => undefined } })
      globalReader(): void {}
    }
    const inferred = new Inferred()
    expect(markerOf(inferred, 'both').resources).toBeDefined()
    expect(readerOf(markerOf(inferred, 'fewer'), 'test-room')({ roomId: 'r1' }, new AbortController().signal)).toBe('r1')
  })
})

describe('@RemoteScope resources', () => {
  class Scoped {
    @RemoteScope('protocolAccessRoom')
    plain(): void {}

    @RemoteScope('protocolAccessRoom', { name: 'inspect' })
    named(): void {}

    @RemoteScope('protocolAccessRoom', {
      name: 'move',
      resources: {
        'test-room': (request) => {
          expectTypeOf(request).toEqualTypeOf<{ readonly targetRoomId: WireSessionId }>()
          return request.targetRoomId
        },
      },
    })
    relocate(request: { readonly targetRoomId: WireSessionId }): void { void request }

    // @ts-expect-error -- `nope` is not a field of the decorated method's request.
    // oxlint-disable-next-line typescript/no-unsafe-return -- the compile error above is the assertion.
    @RemoteScope('protocolAccessRoom', { resources: { 'test-room': request => request.nope } })
    missing(request: { readonly roomId: WireSessionId }): void { void request }

    // @ts-expect-error -- a reader for this kind returns its identity type, not a number.
    @RemoteScope('protocolAccessRoom', { resources: { 'test-room': () => 7 } })
    wrongIdentity(): void {}

    @RemoteScope('protocolAccessRoom', { resources: { 'test-room': request => request.roomId } })
    fewer(request: { readonly roomId: WireSessionId }, signal: AbortSignal): void { void request; void signal }

    // @ts-expect-error -- the decorated method has no parameter after its signal.
    @RemoteScope('protocolAccessRoom', { resources: { 'test-room': (request, signal, extra: WireSessionId) => extra } })
    afterSignal(request: { readonly roomId: WireSessionId }, signal: AbortSignal): void { void request; void signal }

    // @ts-expect-error -- no package declares this resource kind.
    @RemoteScope('protocolAccessRoom', { resources: { 'protocol-undeclared-kind': () => undefined } })
    undeclaredKind(): void {}
  }

  it('records the export name and readers on the scoped Remote marker', () => {
    const service = new Scoped()
    const invocation = { kind: 'context', context: 'protocolAccessRoom' }
    expect(markerOf(service, 'plain')).toEqual({ method: 'plain', invocation })
    expect(markerOf(service, 'named')).toEqual({ method: 'named', exportName: 'inspect', invocation })
    const relocate = markerOf(service, 'relocate')
    expect(relocate).toMatchObject({ method: 'relocate', exportName: 'move', invocation })
    expect(Object.isFrozen(relocate.resources)).toBe(true)
    expect(readerOf(relocate, 'test-room')({ targetRoomId: 'r2' })).toBe('r2')
  })

  it('rejects options a Remote Scope method cannot carry', () => {
    // @ts-expect-error -- a Remote Scope method has no stream option.
    expect(() => RemoteScope('protocolAccessRoom', { mode: 'stream' })).toThrow('RemoteScope options require name or resources')
    const empty: object = {}
    expect(() => RemoteScope('protocolAccessRoom', empty as RemoteScopeOptions<unknown[]>)).toThrow('RemoteScope options require name or resources')
    expect(() => RemoteScope('protocolAccessRoom', { name: 'bad/name' })).toThrow('export name')
    expect(() => RemoteScope('protocolAccessRoom', { resources: {} })).toThrow('Remote resources require at least one reader')
  })
})
