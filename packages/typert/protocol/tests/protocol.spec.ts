import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  bindTypertRemote,
  TypertRemoteService,
  Remote,
  RemoteScope,
  remoteMethods,
  type TypertClientEventListener,
  type TypertContext,
  type TypertForwardableEvent,
  type TypertForwardableEventEntry,
  type TypertLookup,
  type TypertRemoteEvent,
} from '@deepseek-ai/dsh-typert-protocol'

const REMOTE_METHOD_DESCRIPTOR_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

interface MetaFixtureSubject {
  readonly subjectId: string
}

interface MetaFixtureRequest {
  readonly agent: MetaFixtureSubject
  readonly signal?: AbortSignal
  readonly nested: readonly [{ readonly owner?: MetaFixtureSubject }]
  readonly transform: (subject: MetaFixtureSubject) => Promise<MetaFixtureSubject | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Test-only one-way event: bound to no Scope and returning nothing.
     * @param value - marker payload.
     */
    'meta-fixture/forwardable'(value: string): void
    /**
     * Test-only Scope-bound event, which no carrier can deliver one-way.
     * @param value - marker payload.
     */
    'meta-fixture/scoped'(this: Context, value: string): void
    /**
     * Test-only scoped waterfall whose result can make the return trip.
     * @param value - marker payload.
     * @param next - delegates to the next listener.
     * @returns the claimed or delegated value.
     */
    'meta-fixture/waterfall'(
      this: Context,
      request: MetaFixtureRequest,
      next: () => Promise<string>,
    ): Promise<string>
    /**
     * Test-only answered event, whose result no one-way delivery can return.
     * @param value - marker payload.
     * @returns the replacement value.
     */
    'meta-fixture/answered'(value: string): string
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    metaFixture: TypertLookup<MetaFixtureSubject, string>
  }

  interface TypertContextMap {
    metaFixture: TypertContext<string>
    otherFixture: TypertContext<string>
  }

  interface TypertRemoteEventSelection extends
    Record<'meta-fixture/forwardable' | 'meta-fixture/waterfall' | 'meta-fixture/absent', true> {}
}

describe('typert-protocol Remote declarations', () => {
  it('binds a TypertRemoteService name and executes decorators through the Vitest source transform', async () => {
    class Goals extends TypertRemoteService {
      constructor(ctx: Context) {
        super(ctx, 'goals')
      }

      @Remote
      create(value: string): string {
        return value
      }

      @Remote({ mode: 'stream' })
      *watch(): Iterable<string> {
        yield 'value'
      }

      @RemoteScope('metaFixture')
      scoped(value: string): string {
        return value
      }
    }

    class NamespacedGoals extends TypertRemoteService {
      constructor(ctx: Context) {
        super(ctx, 'internalGoals', { namespace: 'goals' })
      }
    }

    const ctx = new Context()
    const goals = new Goals(ctx)
    const namespaced = new NamespacedGoals(ctx)
    expect(goals.typertRemote).toEqual({ service: goals, serviceKey: 'goals', namespace: 'goals' })
    expect(namespaced.typertRemote).toEqual({
      service: namespaced,
      serviceKey: 'internalGoals',
      namespace: 'goals',
    })
    expect(remoteMethods(goals)).toEqual([
      { method: 'create', invocation: { kind: 'direct' } },
      { method: 'watch', mode: 'stream', invocation: { kind: 'direct' } },
      { method: 'scoped', invocation: { kind: 'context', context: 'metaFixture' } },
    ])
    await ctx.fiber.dispose()
  })

  it('executes standard decorator syntax through the TSX source launcher', () => {
    const fixture = fileURLToPath(new URL('./fixtures/source-launch.ts', import.meta.url))
    const output = execFileSync(process.execPath, ['--import', 'tsx/esm', fixture], { encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual([
      { method: 'create', invocation: { kind: 'direct' } },
      { method: 'scoped', invocation: { kind: 'context', context: 'agent' } },
    ])
  })

  it('stores a non-enumerable versioned marker descriptor on the prototype', () => {
    class Goals {
      readonly typertRemote = bindTypertRemote(this, 'goals')

      create(agent: object, request: object): object {
        return { agent, request }
      }

      scoped(request: object): object {
        return request
      }
    }

    const initializers: Array<(this: Goals) => void> = []
    Remote(
      Reflect.get(Goals.prototype, 'create') as (this: Goals, ...args: unknown[]) => unknown,
      methodContext('create', initializers),
    )
    RemoteScope('metaFixture')(
      Reflect.get(Goals.prototype, 'scoped') as (this: Goals, ...args: unknown[]) => unknown,
      methodContext('scoped', initializers),
    )

    const goals = new Goals()
    for (const initialize of initializers) initialize.call(goals)
    expect(goals.typertRemote).toEqual({ service: goals, serviceKey: 'goals', namespace: 'goals' })
    expect(Object.isFrozen(goals.typertRemote)).toBe(true)
    expect(remoteMethods(goals)).toEqual([
      { method: 'create', invocation: { kind: 'direct' } },
      { method: 'scoped', invocation: { kind: 'context', context: 'metaFixture' } },
    ])
    expect(Reflect.ownKeys(Goals)).toEqual(['length', 'name', 'prototype'])
    expect(Reflect.ownKeys(Goals.prototype)).toEqual([
      'constructor', 'create', 'scoped', REMOTE_METHOD_DESCRIPTOR_KEY,
    ])
    expect(Object.keys(Goals.prototype)).toEqual([])
    expect(Object.getOwnPropertyDescriptor(Goals.prototype, REMOTE_METHOD_DESCRIPTOR_KEY)).toMatchObject({
      configurable: true,
      enumerable: false,
      writable: false,
    })
  })

  it('keeps markers idempotent across instances and returns detached snapshots', () => {
    class Service {
      run(value: string): string {
        return value
      }
    }

    const initializers: Array<(this: Service) => void> = []
    Remote(
      Reflect.get(Service.prototype, 'run') as (this: Service, ...args: unknown[]) => unknown,
      methodContext('run', initializers),
    )

    const first = new Service()
    const second = new Service()
    for (const initialize of initializers) {
      initialize.call(first)
      initialize.call(second)
    }
    const snapshot = remoteMethods(first)
    expect(remoteMethods(second)).toEqual(snapshot)
    ;(snapshot as unknown as { method: string }[])[0]!.method = 'changed'
    expect(remoteMethods(first)).toEqual([{ method: 'run', invocation: { kind: 'direct' } }])
  })

  it.each([
    [null, 'Remote method descriptor must be an object'],
    [{ version: 2, methods: [] }, 'unsupported Remote method descriptor version 2'],
    [{ version: 1, methods: {} }, 'Remote method descriptor methods must be an array'],
  ])('rejects malformed prototype descriptor %#', (value, message) => {
    const prototype = {}
    Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR_KEY, { value })
    expect(() => remoteMethods(Object.create(prototype) as object)).toThrow(message)
  })

  it('supports explicit export names and prototype-less inputs', () => {
    class Service {
      run(value: string): string {
        return value
      }

      scoped(value: string): string {
        return value
      }
    }
    const initializers: Array<(this: Service) => void> = []
    Remote('execute')(
      Reflect.get(Service.prototype, 'run') as (this: Service, ...args: unknown[]) => unknown,
      methodContext('run', initializers),
    )
    RemoteScope('metaFixture', 'inspect')(
      Reflect.get(Service.prototype, 'scoped') as (this: Service, ...args: unknown[]) => unknown,
      methodContext('scoped', initializers),
    )
    const service = new Service()
    for (const initialize of initializers) initialize.call(service)

    expect(remoteMethods(service)).toEqual([
      { method: 'run', exportName: 'execute', invocation: { kind: 'direct' } },
      { method: 'scoped', exportName: 'inspect', invocation: { kind: 'context', context: 'metaFixture' } },
    ])
    expect(remoteMethods({})).toEqual([])
    const prototypeLess: object = {}
    Reflect.setPrototypeOf(prototypeLess, null)
    expect(remoteMethods(prototypeLess)).toEqual([])
  })

  it('records the stream mode on the Remote marker', () => {
    class Jobs {
      follow(): void {}
    }
    const initializers: Array<(this: Jobs) => void> = []
    Remote({ mode: 'stream' })(Reflect.get(Jobs.prototype, 'follow'), methodContext('follow', initializers))
    const jobs = new Jobs()
    for (const initialize of initializers) initialize.call(jobs)
    expect(remoteMethods(jobs)).toEqual([
      { method: 'follow', mode: 'stream', invocation: { kind: 'direct' } },
    ])
  })

  it('registers the invocation accessor once per tree, on the root', async () => {
    const root = new Context()
    class First extends TypertRemoteService {
      constructor(ctx: Context) {
        super(ctx, 'first')
      }

      outside(): unknown {
        return this.ctx.invocation
      }
    }
    class Second extends TypertRemoteService {
      constructor(ctx: Context) {
        super(ctx, 'second')
      }
    }
    await root.plugin(First)
    const second = root.plugin(Second)
    await second
    const child = root.plugin(() => {})
    await child
    expect(child.ctx.invocation).toBeUndefined()
    expect((root.get('first') as First).outside()).toBeUndefined()
    // The accessor belongs to the root, so a Remote Service leaving does not take it along.
    await second.dispose()
    expect(child.ctx.invocation).toBeUndefined()
  })

  it('provides the invocation accessor for a plain Service bound with bindTypertRemote', async () => {
    const root = new Context()
    expect(Object.hasOwn(root.reflect.props, 'invocation')).toBe(false)
    class Plain extends Service {
      readonly typertRemote = bindTypertRemote(this, 'plain')

      constructor(ctx: Context) {
        super(ctx, 'plain')
      }
    }
    await root.plugin(Plain)
    expect(Object.hasOwn(root.reflect.props, 'invocation')).toBe(true)
    expect(root.invocation).toBeUndefined()
    expect((root.get('plain') as Plain).typertRemote.namespace).toBe('plain')
  })

  it('rejects malformed decorator calls and targets', () => {
    const method: (this: object) => void = function (this: object): void {}
    expect(() => { (Remote as unknown as (value: typeof method) => void)(method) }).toThrow('context is missing')
    expect(() => Remote('bad/name')).toThrow('export name')
    expect(() => Remote('bad#name')).toThrow('export name')
    expect(() => Remote('bad name')).toThrow('export name')
    expect(() => Remote('.')).toThrow('export name')
    expect(() => Remote('..')).toThrow('export name')
    expect(() => Remote({ mode: 'unary' } as unknown as { mode: 'stream' })).toThrow('exactly mode')
    expect(() => Remote({ mode: 'stream', extra: true } as unknown as { mode: 'stream' })).toThrow('exactly mode')
    const bogusMode: string = 'duplex'
    expect(() => Remote({ mode: bogusMode } as { mode: 'stream' }))
      .toThrow('Remote options must contain exactly mode: "stream"')
    expect(() => RemoteScope('' as 'metaFixture')).toThrow('Scope key')
    expect(() => RemoteScope('metaFixture', 'bad/name')).toThrow('export name')

    for (const context of [
      { ...methodContext('run', []), private: true },
      { ...methodContext('run', []), static: true },
      { ...methodContext('run', []), name: Symbol('run') },
    ]) {
      expect(() => { Remote(method, context) })
        .toThrow('public instance method')
    }
  })

  it('rejects prototype-less initialization and conflicting markers', () => {
    const method: (this: object) => void = function (this: object): void {}
    const direct: Array<(this: object) => void> = []
    Remote(method, methodContext('run', direct))
    const prototypeLess: object = {}
    Reflect.setPrototypeOf(prototypeLess, null)
    expect(() => { direct[0]!.call(prototypeLess) }).toThrow('without a prototype')

    const stream: Array<(this: object) => void> = []
    Remote({ mode: 'stream' })(method, methodContext('run', stream))
    const conflict = Object.create({}) as object
    direct[0]!.call(conflict)
    expect(() => { stream[0]!.call(conflict) }).toThrow('conflicting invocation markers')

    class Service {
      run(): void {}
    }
    const conflicting: Array<(this: Service) => void> = []
    Remote(
      Reflect.get(Service.prototype, 'run'),
      methodContext('run', conflicting),
    )
    RemoteScope('metaFixture')(
      Reflect.get(Service.prototype, 'run'),
      methodContext('run', conflicting),
    )
    const service = new Service()
    conflicting[0]!.call(service)
    expect(() => { conflicting[1]!.call(service) }).toThrow('conflicting invocation markers')

    class ScopedService {
      run(): void {}
    }
    const firstScope: Array<(this: ScopedService) => void> = []
    const otherScope: Array<(this: ScopedService) => void> = []
    RemoteScope('metaFixture')(
      Reflect.get(ScopedService.prototype, 'run'),
      methodContext('run', firstScope),
    )
    RemoteScope('otherFixture')(
      Reflect.get(ScopedService.prototype, 'run'),
      methodContext('run', otherScope),
    )
    const scopedService = new ScopedService()
    firstScope[0]!.call(scopedService)
    expect(() => { otherScope[0]!.call(scopedService) }).toThrow('conflicting invocation markers')

    class ReverseService {
      run(): void {}
    }
    const scopedFirst: Array<(this: ReverseService) => void> = []
    const directSecond: Array<(this: ReverseService) => void> = []
    RemoteScope('metaFixture')(
      Reflect.get(ReverseService.prototype, 'run'),
      methodContext('run', scopedFirst),
    )
    Remote(
      Reflect.get(ReverseService.prototype, 'run'),
      methodContext('run', directSecond),
    )
    const reverseService = new ReverseService()
    scopedFirst[0]!.call(reverseService)
    expect(() => { directSecond[0]!.call(reverseService) }).toThrow('conflicting invocation markers')
  })

  it('rejects ambiguous binding names', () => {
    expect(() => bindTypertRemote({}, '')).toThrow('service key')
    expect(() => bindTypertRemote({}, 'goals', { namespace: 'api/goals' })).toThrow('namespace')
    expect(() => bindTypertRemote({}, 'goals', { namespace: 'api goals' })).toThrow('namespace')
  })

  it('admits notifications and same-result scoped waterfalls selected from Cordis Events', () => {
    expectTypeOf<'meta-fixture/forwardable'>().toExtend<TypertForwardableEvent>()
    expectTypeOf<'meta-fixture/waterfall'>().toExtend<TypertForwardableEvent>()
    expectTypeOf<'meta-fixture/scoped'>().not.toExtend<TypertForwardableEvent>()
    expectTypeOf<'meta-fixture/answered'>().not.toExtend<TypertForwardableEvent>()

    expectTypeOf<'meta-fixture/forwardable'>().toExtend<TypertRemoteEvent>()
    expectTypeOf<'meta-fixture/waterfall'>().toExtend<TypertRemoteEvent>()
    expectTypeOf<'meta-fixture/scoped'>().not.toExtend<TypertRemoteEvent>()
    expectTypeOf<'meta-fixture/absent'>().not.toExtend<TypertRemoteEvent>()

    expectTypeOf<{ event: 'meta-fixture/forwardable'; mode: 'emit' }>()
      .toExtend<TypertForwardableEventEntry>()
    expectTypeOf<{ event: 'meta-fixture/waterfall'; mode: 'waterfall' }>()
      .toExtend<TypertForwardableEventEntry>()
    expectTypeOf<{ event: 'meta-fixture/waterfall'; mode: 'emit' }>()
      .not.toExtend<TypertForwardableEventEntry>()
  })

  it('derives Client Context arguments from the selected Cordis waterfall declaration', () => {
    type ExpectedListener = (
      this: Context,
      request: {
        readonly agent: Context
        readonly signal?: AbortSignal
        readonly nested: readonly [{ readonly owner?: MetaFixtureSubject }]
        readonly transform: (subject: MetaFixtureSubject) => Promise<MetaFixtureSubject | undefined>
      },
      next: () => Promise<string>,
    ) => Promise<string>

    expectTypeOf<TypertClientEventListener<'meta-fixture/waterfall'>>()
      .toEqualTypeOf<ExpectedListener>()
    expectTypeOf<TypertClientEventListener<'meta-fixture/forwardable'>>()
      .toEqualTypeOf<(value: string) => void>()
  })
})

function methodContext<This extends object>(
  name: string,
  initializers: Array<(this: This) => void>,
): ClassMethodDecoratorContext<This, (this: This, ...args: unknown[]) => unknown> {
  return {
    kind: 'method',
    name,
    static: false,
    private: false,
    metadata: {},
    access: {
      has: object => name in object,
      get: object => (object as Record<string, unknown>)[name] as (this: This, ...args: unknown[]) => unknown,
    },
    addInitializer: (initializer) => { initializers.push(initializer) },
  }
}
