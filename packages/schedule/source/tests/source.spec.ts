/** Typed sources compose through object references without kinds, task bindings, or a graph executor. */
import { describe, expect, expectTypeOf, it, onTestFinished } from 'vitest'
import { AutomationSource } from '../src/source.ts'
import type { SourceConnection } from '../src/types.ts'

class NumberSource extends AutomationSource<number> {
  publish(value: number): Promise<void> { return this.emit(value) }
}

class SumSource extends AutomationSource<string> {
  private total = 0
  private readonly inputs: SourceConnection[]

  constructor(inputs: readonly NumberSource[]) {
    super()
    this.inputs = inputs.map(input => input.subscribe(async (value) => {
      this.total += value
      await this.emit(`total=${this.total}`)
    }))
  }

  override async dispose(): Promise<void> {
    await Promise.all(this.inputs.map(input => input.dispose()))
    await super.dispose()
  }
}

function source(): NumberSource {
  const result = new NumberSource()
  onTestFinished(async () => { await result.dispose() })
  return result
}

describe('source instances', () => {
  it('combines two instances of one class into another typed source', async () => {
    const first = source()
    const second = source()
    const sum = new SumSource([first, second])
    onTestFinished(async () => { await sum.dispose() })
    const values: string[] = []
    sum.subscribe(async (value) => { expectTypeOf(value).toEqualTypeOf<string>(); values.push(value) })
    await first.publish(2)
    await second.publish(3)
    expect(values).toEqual(['total=2', 'total=5'])
    await sum.dispose()
    await first.publish(10)
    await second.publish(20)
    expect(values).toEqual(['total=2', 'total=5'])
  })

  it('supports no subscribers, independent duplicate subscriptions, and detached connections', async () => {
    const input = source()
    await input.publish(0)
    const values: number[] = []
    const receive = async (value: number): Promise<void> => { values.push(value) }
    const first = input.subscribe(receive)
    const second = input.subscribe(receive)
    await input.publish(1)
    await first.dispose()
    await first.dispose()
    await input.publish(2)
    await second.dispose()
    await input.publish(3)
    expect(values).toEqual([1, 1, 2])
  })

  it('awaits every receiver after both synchronous and asynchronous failures', async () => {
    const input = source()
    const release = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const syncFailure = new Error('synchronous failure')
    const asyncFailure = new Error('asynchronous failure')
    input.subscribe(() => { throw syncFailure })
    input.subscribe(async () => { throw asyncFailure })
    let accepted = false
    input.subscribe(async () => { entered.resolve(undefined); await release.promise; accepted = true })
    let settled = false
    const result = input.publish(1).catch((error) => { settled = true; return error })
    await entered.promise
    expect(settled).toBe(false)
    release.resolve(undefined)
    expect(await result).toMatchObject({
      name: 'SourceError', code: 'SOURCE_DELIVERY_FAILED', cause: { errors: [syncFailure, asyncFailure] },
    })
    expect(accepted).toBe(true)
  })

  it('drains a detached receiver and prevents new output or subscriptions during disposal', async () => {
    const input = source()
    const release = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    let calls = 0
    const connection = input.subscribe(async () => { calls++; entered.resolve(undefined); await release.promise })
    const accepted = input.publish(1)
    await entered.promise
    const disconnected = connection.dispose()
    await input.publish(2)
    let drained = false
    const closing = input.dispose()
    expect(input.dispose()).toBe(closing)
    void closing.then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(() => input.subscribe(async () => {})).toThrowError(expect.objectContaining({ code: 'SOURCE_CLOSED' }))
    await expect(input.publish(3)).rejects.toMatchObject({ code: 'SOURCE_CLOSED' })
    release.resolve(undefined)
    await Promise.all([accepted, disconnected, closing])
    expect(calls).toBe(1)
    expect(drained).toBe(true)
  })

  it('accepts a stable subscriber snapshot before a receiver changes the connections', async () => {
    const input = source()
    const values: string[] = []
    let disconnect: Promise<void> | undefined
    input.subscribe(async (value) => {
      values.push(`first:${value}`)
      disconnect = other.dispose()
      input.subscribe(async (next) => { values.push(`late:${next}`) })
    })
    const other = input.subscribe(async (value) => { values.push(`second:${value}`) })
    await input.publish(1)
    await disconnect
    expect(values).toEqual(['first:1', 'second:1'])
    await input.publish(2)
    expect(values).toEqual(['first:1', 'second:1', 'first:2', 'late:2'])
  })
})
