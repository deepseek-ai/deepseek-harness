import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { EnvironmentHandle } from '../src/handle.ts'
import type {
  EnvironmentRegistry, EnvironmentContext, EnvironmentDefineOptions, EnvironmentFunction, EnvironmentRunner, EnvironmentValue,
} from '../src/index.ts'

const local = EnvironmentHandle('local')

interface LookupParams { id: number }
interface PathArgs { path: string; bytes?: Uint8Array; seen: Map<string, Date> }

function inferredCalls(executor: EnvironmentRegistry, signal: AbortSignal): void {
  const markRead = executor.define(async (args: { path: string }, env) => {
    expectTypeOf(args).toEqualTypeOf<{ path: string }>()
    expectTypeOf(env.origin.markRead).toBeCallableWith(args.path)
    expectTypeOf(env.origin.markRead).returns.toEqualTypeOf<Promise<boolean>>()
    const { lookup } = env.origin
    expectTypeOf(lookup({ id: 1 })).toEqualTypeOf<Promise<{ name: string }>>()
    expectTypeOf(env.origin.markRead(args.path)).toEqualTypeOf<Promise<boolean>>()
    expectTypeOf(env.origin.lookup({ id: 1 })).toEqualTypeOf<Promise<{ name: string }>>()
    expectTypeOf(env.origin.ping()).toEqualTypeOf<Promise<number>>()
    expectTypeOf(env.origin.notify()).toEqualTypeOf<Promise<EnvironmentValue>>()
    expectTypeOf(env.origin.maybe(true)).toEqualTypeOf<Promise<'value' | undefined>>()
    expectTypeOf(env.origin.bytes(new Uint8Array(1))).toEqualTypeOf<Promise<Uint8Array>>()
    expectTypeOf(env.limits.maxMessageBytes).toEqualTypeOf<number>()
    expectTypeOf(env.origin.optional()).toEqualTypeOf<Promise<string>>()
    expectTypeOf(env.origin.optional(undefined)).toEqualTypeOf<Promise<string>>()
    expectTypeOf(env.origin.optional('value')).toEqualTypeOf<Promise<string>>()
    expectTypeOf(env.origin.validate({ anything: true })).toEqualTypeOf<Promise<0 | 1>>()
    expectTypeOf(env.origin.validate).parameter(0).toEqualTypeOf<EnvironmentValue | undefined>()
    // @ts-expect-error -- only this definition's handler names are callable.
    void env.origin.missing
    // @ts-expect-error -- markRead requires a string parameter.
    void env.origin.markRead(1)
    // @ts-expect-error -- markRead requires its parameter.
    void env.origin.markRead()
    // @ts-expect-error -- lookup requires an object containing a numeric id.
    void env.origin.lookup({ id: '1' })
    const params: LookupParams = { id: 1 }
    expectTypeOf(env.origin.lookup(params)).toEqualTypeOf<Promise<{ name: string }>>()
    // @ts-expect-error -- parameters cannot widen the inferred method to another handler.
    void env.origin.markRead({ id: 1 })
    // @ts-expect-error -- a zero-argument handler does not accept a parameter.
    void env.origin.ping(1)
    // @ts-expect-error -- even unknown-parameter handlers accept only structured-clone input, which excludes symbols.
    void env.origin.validate(Symbol('value'))
    const method = args.path ? 'markRead' : 'lookup'
    // @ts-expect-error -- a union method must remain correlated with its own parameter.
    void env.origin[method](args.path)
    const possiblyRequired = args.path ? 'markRead' : 'ping'
    // @ts-expect-error -- one possible handler requires a parameter.
    void env.origin[possiblyRequired]()
    return await env.origin.markRead(args.path)
  }, {
    result: z.boolean(),
    handlers: {
      markRead: (path: string) => path.length > 0,
      lookup: async (params: LookupParams, handlerSignal: AbortSignal) => {
        expectTypeOf(handlerSignal).toEqualTypeOf<AbortSignal>()
        return { name: String(params.id) }
      },
      ping: () => 1,
      notify: () => {},
      maybe: (present: boolean) => present ? 'value' : undefined,
      bytes: (data: Uint8Array) => data,
      optional: (params?: string) => params ?? 'default',
      validate: (params: unknown) => z.object({ anything: z.boolean() }).parse(params).anything ? 1 : 0,
    },
  })
  expectTypeOf(markRead).toEqualTypeOf<EnvironmentRunner<{ path: string }, boolean>>()
  expectTypeOf(markRead(local, { path: 'note.txt' }, { signal })).toEqualTypeOf<Promise<boolean>>()
  // @ts-expect-error -- call arguments match the function's first parameter.
  void markRead(local, { path: 1 }, { signal })
  // @ts-expect-error -- every call supplies its cancellation.
  void markRead(local, { path: 'note.txt' }, {})
  // @ts-expect-error -- every call names its environment with a branded handle.
  void markRead('local', { path: 'note.txt' }, { signal })

  // Interface-typed arguments need no index signature; structured clone carries binary data, maps and dates.
  const readPath = executor.define((args: PathArgs) => args.path, { result: z.string() })
  expectTypeOf(readPath).toEqualTypeOf<EnvironmentRunner<PathArgs, string>>()
  expectTypeOf(readPath).toBeCallableWith(local, { path: 'a', seen: new Map([['a', new Date()]]) }, { signal })
  // @ts-expect-error -- symbols are not structured-clone values.
  void executor.define((args: symbol) => args.description, { result: z.string() })

  void executor.define((args, env) => {
    // An unannotated first parameter accepts any structured-clone arguments.
    expectTypeOf(args).toEqualTypeOf<EnvironmentValue>()
    // @ts-expect-error -- a definition without handlers exposes no host methods.
    void env.origin.missing
    return null
  }, { result: z.unknown() })
}
void inferredCalls

const entries: string[] = []
const record: (text: string) => void = text => entries.push(text)
const handlers = { length: (text: string) => text.length, record }
const remote: EnvironmentFunction<string, typeof handlers> = (text, env) => env.origin.length(text)
const options: EnvironmentDefineOptions<number, typeof handlers> = { handlers, result: z.number() }

function declaredCalls(executor: EnvironmentRegistry, signal: AbortSignal): void {
  const length = executor.define(remote, options)
  expectTypeOf(length(local, 'text', { signal })).toEqualTypeOf<Promise<number>>()
  // @ts-expect-error -- the remote function requires its matching handler map.
  void executor.define(remote, { result: z.number() })
  // @ts-expect-error -- explicitly supplying handler types still requires their implementations.
  void executor.define<string, number, typeof handlers>(remote, { result: z.number() })
  // @ts-expect-error -- options with known handlers require their implementations.
  const missingHandlers: EnvironmentDefineOptions<number, typeof handlers> = { result: z.number() }
  void missingHandlers
}
void declaredCalls

describe('remote host call types', () => {
  it('retains handler signatures in explicitly typed remote functions', () => {
    expectTypeOf<EnvironmentContext<typeof handlers>['origin']['length']>().toBeFunction()
    expectTypeOf(remote).toBeFunction()
    expectTypeOf<ReturnType<EnvironmentContext<{ record: typeof record }>['origin']['record']>>().toEqualTypeOf<Promise<EnvironmentValue>>()
  })
})
