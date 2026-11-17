/** Cordis rc.12 root access, intercept metadata, isolation, disposal and event errors. */
import { Context, FiberState, Service, ValidationError } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'

interface Metadata {
  a?: number
  b?: number
  c?: number
  tags?: string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    rc12Meta: MetadataService
    rc12View: string
  }
}

class MetadataService extends Service<Metadata> {
  constructor(ctx: Context) {
    super(ctx, 'rc12Meta')
  }

  read(): Metadata {
    return this[Service.resolveIntercept]()
  }
}

function root() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  return ctx
}

describe('Cordis rc.12 core', () => {
  it('exposes the root context through Context.root only', async () => {
    const ctx = root()
    const seen: unknown[] = []
    await ctx.plugin((child: Context) => {
      seen.push(child[Context.root])
      seen.push(child[Symbol.for('cordis.root') as typeof Context.root])
      expect(() => { Reflect.get(child, 'root') }).toThrow('cannot get property "root" without inject')
    })
    expect(seen).toEqual([ctx, ctx])
  })

  it('merges injected metadata under context intercepts', async () => {
    const ctx = root()
    await ctx.plugin(MetadataService)
    let metadata!: Metadata
    await ctx.intercept('rc12Meta', { b: 2 }).inject({ rc12Meta: { a: 1, b: 1 } }, (child) => {
      metadata = child.intercept('rc12Meta', { c: 3 }).rc12Meta.read()
    })
    expect(metadata).toEqual({ a: 1, b: 2, c: 3 })
  })

  it('merges through an overridden mergeIntercept in increasing precedence', async () => {
    class Tagged extends MetadataService {
      override [Service.mergeIntercept](...values: Metadata[]): Metadata {
        return { tags: values.flatMap(value => value.tags ?? []) }
      }
    }
    const ctx = root()
    await ctx.plugin(Tagged)
    let metadata!: Metadata
    await ctx.intercept('rc12Meta', { tags: ['outer'] }).inject({ rc12Meta: { tags: ['inject'] } }, (child) => {
      metadata = child.intercept('rc12Meta', { tags: ['inner'] }).rc12Meta.read()
    })
    expect(metadata).toEqual({ tags: ['inject', 'outer', 'inner'] })
  })

  it('does not inherit the injected view across an isolation boundary', async () => {
    const ctx = root()
    ctx.provide('rc12View', 'outer')
    const results: string[] = []
    const read = (child: Context) => {
      try {
        return child.rc12View
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }
    await ctx.inject(['rc12View'], async (owner) => {
      await owner.plugin((child) => { results.push(read(child)) })
      await owner.isolate('rc12View').plugin((child) => { results.push(read(child)) })
    })
    expect(results).toEqual(['outer', 'cannot get property "rc12View" without inject'])
  })

  it('isolates a context pinned to its parent realm label from the injected view', async () => {
    const ctx = root()
    ctx.provide('rc12View', 'outer')
    let message = ''
    await ctx.inject(['rc12View'], async (owner) => {
      const pinned = owner.isolate('rc12View', owner[Context.isolate].rc12View)
      expect(() => pinned.rc12View).toThrow('cannot get property "rc12View" without inject')
      await pinned.plugin((child) => {
        try {
          void child.rc12View
        } catch (error) {
          message = error instanceof Error ? error.message : String(error)
        }
      })
    })
    expect(message).toBe('cannot get property "rc12View" without inject')
  })

  it('settles pending and failed fibers to DISPOSED', async () => {
    const ctx = root()
    const pending = ctx.inject(['rc12NeverProvided'], () => {})
    expect(pending.state).toBe(FiberState.PENDING)
    await pending.dispose()
    expect(pending.state).toBe(FiberState.DISPOSED)

    const failed = ctx.plugin(() => { throw new Error('rc12 boom') })
    await expect(failed.await()).rejects.toThrow('rc12 boom')
    expect(ctx.logger.buffer.some(message => message.type === 'error' && message.args[0] instanceof Error && message.args[0].message === 'rc12 boom')).toBe(true)
    expect(failed.state).toBe(FiberState.FAILED)
    await failed.dispose()
    expect(failed.state).toBe(FiberState.DISPOSED)
  })

  it('names the failing event in the parallel AggregateError', async () => {
    const ctx = root()
    ctx.on('rc12-parallel' as never, () => { throw new Error('listener failed') })
    const symbol = Symbol('rc12-symbol')
    ctx.on(symbol as never, () => { throw new Error('symbol listener failed') })
    await expect(ctx.parallel('rc12-parallel' as never)).rejects.toThrow('one or more listeners of event "rc12-parallel" failed')
    await expect(ctx.parallel(symbol as never)).rejects.toThrow('one or more listeners of event Symbol(rc12-symbol) failed')
  })

  it('formats config validation paths with keyed segments', () => {
    const error = new ValidationError([{ message: 'bad', path: [{ key: 0 }, 'name'] }])
    expect(ValidationError.is(error)).toBe(true)
    expect(ValidationError.is(new TypeError('bad'))).toBe(false)
    expect(error.issues).toHaveLength(1)
    expect(error.message).toBe('invalid config:\n  - bad (at 0.name)')
    expect(ValidationError.normalizePath([{ key: 'a' }, 1])).toEqual(['a', 1])
    expect(ValidationError.formatPath(undefined)).toBe('')
    expect(new ValidationError([{ message: 'bad', path: [] }]).message).toBe('invalid config:\n  - bad')
  })

  it('logs an AggregateError without members as itself', () => {
    const ctx = root()
    const aggregate = new AggregateError([], 'empty')
    ctx.logger.error(aggregate)
    expect(ctx.logger.buffer.at(-1)?.args[0]).toBe(aggregate)
  })
})
