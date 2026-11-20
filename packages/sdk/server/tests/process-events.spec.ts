/** The process-event record keeps the event before teardown and leaves ownership of each event unchanged. */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { observeRuntime } from '../src/process-events.ts'

function setup() {
  const ctx = new Context()
  const events = new EventEmitter()
  const input = new PassThrough()
  // The launcher owns these two; nothing owns SIGINT in this composition.
  const seenByOwner: (string | undefined)[] = []
  const owner = (): void => { seenByOwner.push(last()?.description) }
  events.on('SIGTERM', owner)
  events.on('unhandledRejection', owner)
  const runtime = observeRuntime(ctx, ctx.fiber, events, input)
  const last = () => runtime.lastProcessEvent()
  return { ctx, events, input, runtime, last, seenByOwner }
}

describe('SDK process-event record', () => {
  it('records a signal before the listener that owns it runs', async () => {
    const { ctx, events, last, seenByOwner } = setup()
    expect(last()).toBeUndefined()

    const before = Date.now()
    events.emit('SIGTERM')

    expect(seenByOwner).toEqual(['SIGTERM'])
    expect(last()?.description).toBe('SIGTERM')
    expect(last()?.at.getTime()).toBeGreaterThanOrEqual(before)
    await ctx.fiber.dispose()
  })

  it('leaves an event without an owner to the Node default', async () => {
    const { ctx, events, last } = setup()

    expect(events.listenerCount('SIGINT')).toBe(0)
    events.emit('SIGINT')

    expect(last()).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('records the first line of a failure, bounded to 200 characters', async () => {
    const { ctx, events, last } = setup()

    events.emit('unhandledRejection', new Error('route failed\n    at connect'))
    expect(last()?.description).toBe('unhandled rejection: route failed')

    events.emit('uncaughtExceptionMonitor', 'x'.repeat(300))
    expect(last()?.description).toBe(`uncaught exception: ${'x'.repeat(200)}`)
    await ctx.fiber.dispose()
  })

  it('records a failure without a string form and still reaches the listener that owns the event', async () => {
    const { ctx, events, last, seenByOwner } = setup()

    events.emit('unhandledRejection', Object.create(null))

    expect(last()?.description).toBe('unhandled rejection: <unprintable>')
    expect(seenByOwner).toEqual(['unhandled rejection: <unprintable>'])
    await ctx.fiber.dispose()
  })

  it('records the end of protocol input', async () => {
    const { ctx, input, last } = setup()

    input.resume()
    input.end()
    await new Promise<void>((resolve) => { input.once('end', resolve) })

    expect(last()?.description).toBe('stdin closed')
    await ctx.fiber.dispose()
  })

  it('keeps the event before teardown and removes its listeners on disposal', async () => {
    const { ctx, events, input, runtime, last } = setup()
    events.emit('SIGTERM')
    expect(runtime.unloading()).toBe(false)
    let unloadingDuringTeardown: boolean | undefined
    // Registered last, so this runs while the record's listeners are still attached.
    ctx.effect(() => () => {
      unloadingDuringTeardown = runtime.unloading()
      events.emit('unhandledRejection', new Error('caused by teardown'))
    }, 'test teardown failure')

    await ctx.fiber.dispose()

    expect(unloadingDuringTeardown).toBe(true)
    expect(last()?.description).toBe('SIGTERM')
    expect(events.listenerCount('SIGTERM')).toBe(1)
    expect(events.listenerCount('unhandledRejection')).toBe(1)
    expect(events.listenerCount('uncaughtExceptionMonitor')).toBe(0)
    expect(input.listenerCount('end')).toBe(0)
  })
})
