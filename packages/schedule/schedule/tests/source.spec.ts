/** Typed receiving endpoints share directed delivery, broadcast, and quiescent disposal. */
import { describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest'
import { SourceError, SourceInput, SourceOutput } from '@deepseek-ai/dsh-schedule'
import { AutomationSource } from '../src/source.ts'
import type { AutomationConnection } from '../src/source-types.ts'

class ValueSource<T> extends AutomationSource<T> {
  publish(value: T): Promise<void> { return this.emit(value) }
}

class SumSource extends AutomationSource<string> {
  private total = 0
  readonly connect = this.createInput<number>(async (value) => {
    this.total += value
    await this.emit(`total=${this.total}`)
  }).connect

  connectText(output: SourceOutput<string>): AutomationConnection<string> {
    return this.createInput<string>(value => this.emit(value)).connect(output)
  }
}

function scope() {
  const resources: Array<{ dispose(): Promise<void> }> = []
  const pending: Promise<unknown>[] = []
  const releases: Array<() => void> = []
  onTestFinished(async () => {
    for (const release of releases) release()
    await Promise.allSettled(pending)
    await Promise.all(resources.reverse().map(resource => resource.dispose()))
  })
  return {
    own<T extends { dispose(): Promise<void> }>(resource: T): T { resources.push(resource); return resource },
    track<T>(work: Promise<T>): Promise<T> { pending.push(Promise.allSettled([work])); return work },
    gate() {
      const gate = Promise.withResolvers<undefined>()
      releases.push(() => { gate.resolve(undefined) })
      return gate
    },
  }
}

describe('source connections', () => {
  it('composes multiple typed inputs through the same receiving endpoint used by a terminal consumer', async () => {
    const test = scope()
    const first = test.own(new ValueSource<number>())
    const second = test.own(new ValueSource<number>())
    const text = test.own(new ValueSource<string>())
    const sum = test.own(new SumSource())
    const firstConnection = sum.connect(first.output)
    expectTypeOf(firstConnection).toEqualTypeOf<AutomationConnection<number>>()
    sum.connect(second.output)
    sum.connectText(text.output)
    const values: string[] = []
    const terminal = test.own(new SourceInput<string>(async (value) => {
      expectTypeOf(value).toEqualTypeOf<string>()
      values.push(value)
    }))
    terminal.connect(sum.output)
    await first.publish(2)
    await second.publish(3)
    await text.publish('text')
    expect(values).toEqual(['total=2', 'total=5', 'text'])
    await sum.dispose()
    await first.publish(10)
    await second.publish(20)
    expect(values).toEqual(['total=2', 'total=5', 'text'])
    expect(() => sum.connectText(text.output)).toThrow(expect.objectContaining({ code: 'SOURCE_CLOSED' }))
  })

  it('accepts a narrow output at a wider receiver without widening the writable output', async () => {
    const test = scope()
    const output = test.own(new SourceOutput<number>())
    const values: Array<number | string> = []
    const input = test.own(new SourceInput<number | string>(async (value) => { values.push(value) }))
    const connection = input.connect(output)
    expectTypeOf(connection).toEqualTypeOf<AutomationConnection<number>>()
    expectTypeOf<AutomationConnection<number>>().not.toExtend<AutomationConnection<number | string>>()
    expectTypeOf<SourceOutput<number>>().not.toExtend<SourceOutput<number | string>>()
    expectTypeOf<SourceOutput<number | string>>().not.toExtend<Parameters<SourceInput<number>['connect']>[0]>()
    await connection.send(1)
    await output.emit(2)
    expect(values).toEqual([1, 2])
  })

  it('directs shared connection sends only to their fixed receiver', async () => {
    const test = scope()
    const source = test.own(new ValueSource<number>())
    const first: number[] = []
    const second: number[] = []
    const a = test.own(new SourceInput<number>(async (value) => { first.push(value) }))
    const b = test.own(new SourceInput<number>(async (value) => { second.push(value) }))
    const connection = a.connect(source.output)
    b.connect(source.output)
    const share = (value: AutomationConnection<number>): AutomationConnection<number> => value
    const otherHolder = share(connection)
    expect(otherHolder).toBe(connection)
    await otherHolder.send(1)
    await connection.send(2)
    expect(first).toEqual([1, 2])
    expect(second).toEqual([])
    await source.publish(3)
    expect(first).toEqual([1, 2, 3])
    expect(second).toEqual([3])
    const closing = otherHolder.dispose()
    expect(connection.dispose()).toBe(closing)
    await closing
    await expect(connection.send(4)).rejects.toMatchObject({ code: 'SOURCE_CONNECTION_CLOSED' })
    await expect(otherHolder.send(5)).rejects.toMatchObject({ code: 'SOURCE_CONNECTION_CLOSED' })
  })

  it('keeps duplicate connections independent and does not retain output for late receivers', async () => {
    const test = scope()
    const source = test.own(new ValueSource<number>())
    await source.publish(0)
    const values: number[] = []
    const receiver = test.own(new SourceInput<number>(async (value) => { values.push(value) }))
    const first = receiver.connect(source.output)
    const second = receiver.connect(source.output)
    expect(first).not.toBe(second)
    expect(values).toEqual([])
    await source.publish(1)
    await first.dispose()
    await source.publish(2)
    await second.dispose()
    await source.publish(3)
    expect(values).toEqual([1, 1, 2])
  })

  it.each(['direct', 'broadcast'] as const)('allows concurrent %s calls without a FIFO', async (mode) => {
    const test = scope()
    const source = test.own(new ValueSource<number>())
    const entered = test.gate()
    const release = test.gate()
    const values: number[] = []
    const receiver = test.own(new SourceInput<number>(async (value) => {
      if (value === 1) { entered.resolve(undefined); await release.promise }
      values.push(value)
    }))
    const connection = receiver.connect(source.output)
    const send = (value: number): Promise<void> => mode === 'direct' ? connection.send(value) : source.publish(value)
    const first = test.track(send(1))
    await Promise.race([entered.promise, first])
    await send(2)
    expect(values).toEqual([2])
    release.resolve(undefined)
    await first
    expect(values).toEqual([2, 1])
  })

  it.each(['synchronous', 'asynchronous'] as const)('preserves a %s receiver error on direct sends without retry', async (mode) => {
    const test = scope()
    const output = test.own(new SourceOutput<number>())
    const failure = new SourceError('Receiver refused the value.', 'SOURCE_TASK_BUSY')
    let calls = 0
    const input = test.own(new SourceInput<number>((value) => {
      calls++
      if (value !== 1) return Promise.resolve()
      if (mode === 'synchronous') throw failure
      return Promise.reject(failure)
    }))
    const connection = input.connect(output)
    await expect(connection.send(1)).rejects.toBe(failure)
    expect(calls).toBe(1)
    await connection.send(2)
    expect(calls).toBe(2)
  })

  it('waits for all broadcast receivers and aggregates failures without rollback or retry', async () => {
    const test = scope()
    const source = test.own(new ValueSource<number>())
    const entered = test.gate()
    const release = test.gate()
    const syncFailure = new Error('synchronous failure')
    const asyncFailure = new Error('asynchronous failure')
    test.own(new SourceInput<number>(() => { throw syncFailure })).connect(source.output)
    test.own(new SourceInput<number>(async () => { throw asyncFailure })).connect(source.output)
    const values: number[] = []
    test.own(new SourceInput<number>(async (value) => {
      entered.resolve(undefined)
      await release.promise
      values.push(value)
    })).connect(source.output)
    let settled = false
    const result = test.track(source.publish(1).catch((error: unknown) => { settled = true; return error }))
    await entered.promise
    expect(settled).toBe(false)
    release.resolve(undefined)
    expect(await result).toMatchObject({
      name: 'SourceError', code: 'SOURCE_DELIVERY_FAILED', cause: { errors: [syncFailure, asyncFailure] },
    })
    expect(values).toEqual([1])
  })

  it('admits the complete broadcast snapshot before callbacks detach peers or connect late receivers', async () => {
    const test = scope()
    const source = test.own(new ValueSource<number>())
    const values: string[] = []
    let disconnected: Promise<void> | undefined
    const late = test.own(new SourceInput<number>(async (value) => { values.push(`late:${value}`) }))
    test.own(new SourceInput<number>(async (value) => {
      values.push(`first:${value}`)
      disconnected = test.track(other.dispose())
      late.connect(source.output)
    })).connect(source.output)
    const other = test.own(new SourceInput<number>(async (value) => { values.push(`second:${value}`) })).connect(source.output)
    await source.publish(1)
    await disconnected
    expect(values).toEqual(['first:1', 'second:1'])
    await source.publish(2)
    expect(values).toEqual(['first:1', 'second:1', 'first:2', 'late:2'])
  })

  it.each(['connection', 'input', 'output', 'source'] as const)('drains detached accepted calls before %s cleanup releases their resource', async (owner) => {
    const test = scope()
    const source = test.own(new ValueSource<number>())
    const entered = test.gate()
    const release = test.gate()
    let resourceOpen = true
    let finished = false
    const input = test.own(new SourceInput<number>(async () => {
      entered.resolve(undefined)
      await release.promise
      expect(resourceOpen).toBe(true)
      finished = true
    }))
    const connection = input.connect(source.output)
    const work = test.track(connection.send(1))
    await Promise.race([entered.promise, work])
    const detached = test.track(connection.dispose())
    const endpoint = owner === 'connection' ? connection : owner === 'input' ? input : owner === 'output' ? source.output : source
    const closing = endpoint.dispose()
    expect(endpoint.dispose()).toBe(closing)
    const cleanup = test.track(closing.then(() => { resourceOpen = false }))
    await expect(connection.send(2)).rejects.toMatchObject({ code: 'SOURCE_CONNECTION_CLOSED' })
    release.resolve(undefined)
    await Promise.all([work, detached, cleanup])
    expect(finished).toBe(true)
    expect(resourceOpen).toBe(false)
  })

  it('closes output connections with their producer while leaving the receiving input reusable', async () => {
    const test = scope()
    const first = test.own(new ValueSource<number>())
    const second = test.own(new ValueSource<number>())
    const values: number[] = []
    const input = test.own(new SourceInput<number>(async (value) => { values.push(value) }))
    const connection = input.connect(first.output)
    const closing = first.dispose()
    await expect(connection.send(1)).rejects.toMatchObject({ code: 'SOURCE_CONNECTION_CLOSED' })
    await expect(first.publish(2)).rejects.toMatchObject({ code: 'SOURCE_CLOSED' })
    expect(() => input.connect(first.output)).toThrow(expect.objectContaining({ code: 'SOURCE_CLOSED' }))
    await closing
    input.connect(second.output)
    await second.publish(3)
    expect(values).toEqual([3])
  })

  it('closes receiving connections without disposing borrowed upstream outputs', async () => {
    const test = scope()
    const source = test.own(new ValueSource<number>())
    const input = test.own(new SourceInput<number>(async () => {}))
    const connection = input.connect(source.output)
    const closing = input.dispose()
    expect(() => input.connect(source.output)).toThrow(expect.objectContaining({ code: 'SOURCE_CLOSED' }))
    await expect(connection.send(1)).rejects.toMatchObject({ code: 'SOURCE_CONNECTION_CLOSED' })
    await closing
    const values: number[] = []
    test.own(new SourceInput<number>(async (value) => { values.push(value) })).connect(source.output)
    await source.publish(2)
    expect(values).toEqual([2])
  })

  it('closes output synchronously after individually disposed owned inputs have drained', async () => {
    const test = scope()
    const source = test.own(new class extends AutomationSource<number> {
      open() { return this.createInput<number>(value => this.emit(value)) }
    }())
    const upstream = test.own(new ValueSource<number>())
    const values: number[] = []
    const terminal = test.own(new SourceInput<number>(async (value) => { values.push(value) }))
    const downstream = terminal.connect(source.output)
    for (const value of [1, 2, 3]) {
      const input = source.open()
      const connection = input.connect(upstream.output)
      await connection.send(value)
      const closed = input.dispose()
      expect(input.dispose()).toBe(closed)
      await closed
    }
    expect(values).toEqual([1, 2, 3])
    const closing = test.track(source.dispose())
    expect(source.dispose()).toBe(closing)
    await expect(downstream.send(4)).rejects.toMatchObject({ code: 'SOURCE_CONNECTION_CLOSED' })
    await closing
    expect(values).toEqual([1, 2, 3])
    expect(() => source.open()).toThrow(expect.objectContaining({ code: 'SOURCE_CLOSED' }))
  })

  it('retains an owned input after cleanup rejects and preserves the cleanup promise', async () => {
    const test = scope()
    const source = test.own(new class extends AutomationSource<number> {
      open() { return this.createInput<number>(async () => {}) }
    }())
    const upstream = test.own(new ValueSource<number>())
    const input = source.open()
    const connection = input.connect(upstream.output)
    const failure = new Error('input cleanup failed')
    const failed = test.track(Promise.reject(failure))
    const dispose = vi.spyOn(SourceInput.prototype, 'dispose').mockReturnValueOnce(failed)
    onTestFinished(() => { dispose.mockRestore() })
    try {
      const closing = input.dispose()
      expect(closing).toBe(failed)
      await expect(closing).rejects.toBe(failure)
    } finally {
      dispose.mockRestore()
    }
    const closing = test.track(source.dispose())
    await expect(connection.send(1)).rejects.toMatchObject({ code: 'SOURCE_CONNECTION_CLOSED' })
    await closing
  })

  it.each(['emit', 'fail'] as const)('retains an individually closing owned input until it can %s and settle', async (outcome) => {
    const test = scope()
    const entered = test.gate()
    const release = test.gate()
    const failure = new Error('owned input failed after release')
    const source = test.own(new class extends AutomationSource<string> {
      open() {
        return this.createInput<number>(async (value) => {
          entered.resolve(undefined)
          await release.promise
          if (outcome === 'fail') throw failure
          await this.emit(`accepted:${value}`)
        })
      }
    }())
    const upstream = test.own(new ValueSource<number>())
    const input = source.open()
    const connection = input.connect(upstream.output)
    const values: string[] = []
    const terminal = test.own(new SourceInput<string>(async (value) => { values.push(value) }))
    const downstream = terminal.connect(source.output)
    const work = test.track(connection.send(1))
    await Promise.race([entered.promise, work])
    const inputClosing = test.track(input.dispose())
    expect(input.dispose()).toBe(inputClosing)
    const closing = test.track(source.dispose())
    expect(source.dispose()).toBe(closing)
    await expect(connection.send(2)).rejects.toMatchObject({ code: 'SOURCE_CONNECTION_CLOSED' })
    await downstream.send('while draining')
    release.resolve(undefined)
    if (outcome === 'fail') await expect(work).rejects.toBe(failure)
    else await work
    await Promise.all([inputClosing, closing])
    expect(values).toEqual(outcome === 'emit' ? ['while draining', 'accepted:1'] : ['while draining'])
    await expect(downstream.send('late')).rejects.toMatchObject({ code: 'SOURCE_CONNECTION_CLOSED' })
    await upstream.publish(3)
  })

  it.each(['emit', 'fail'] as const)('keeps composite output usable until accepted input can %s and settle', async (outcome) => {
    const test = scope()
    const entered = test.gate()
    const release = test.gate()
    const failure = new Error('input failed after release')
    const source = test.own(new ValueSource<number>())
    const composite = test.own(new class extends AutomationSource<string> {
      readonly connect = this.createInput<number>(async (value) => {
        entered.resolve(undefined)
        await release.promise
        if (outcome === 'fail') throw failure
        await this.emit(`accepted:${value}`)
      }).connect
    }())
    const connection = composite.connect(source.output)
    const values: string[] = []
    const output = test.own(new SourceInput<string>(async (value) => { values.push(value) }))
    const downstream = output.connect(composite.output)
    const work = test.track(connection.send(1))
    await Promise.race([entered.promise, work])
    const closing = test.track(composite.dispose())
    expect(composite.dispose()).toBe(closing)
    expect(() => composite.connect(source.output)).toThrow(expect.objectContaining({ code: 'SOURCE_CLOSED' }))
    await expect(connection.send(2)).rejects.toMatchObject({ code: 'SOURCE_CONNECTION_CLOSED' })
    release.resolve(undefined)
    if (outcome === 'fail') await expect(work).rejects.toBe(failure)
    else await work
    await closing
    expect(values).toEqual(outcome === 'emit' ? ['accepted:1'] : [])
    await expect(downstream.send('late')).rejects.toMatchObject({ code: 'SOURCE_CONNECTION_CLOSED' })
    await expect(composite.output.emit('late')).rejects.toMatchObject({ code: 'SOURCE_CLOSED' })
    await source.publish(3)
  })
})
