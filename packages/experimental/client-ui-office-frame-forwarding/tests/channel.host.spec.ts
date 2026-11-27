/** Remote stream queues deliver callbacks in order and end once. */
import { expect, test, vi } from 'vitest'
import { AsyncChannel } from '../src/channel.ts'

async function drain<T>(iteration: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iteration) items.push(item)
  return items
}

test('items queued before and after iteration are delivered until the stream ends', async () => {
  const channel = new AsyncChannel<number>(), closed = vi.fn()
  channel.push(1)
  const items = drain(channel.iterate(new AbortController().signal, closed))
  await Promise.resolve()
  channel.push(2)
  channel.end()
  channel.push(3)
  channel.fail(new Error('ignored'))
  expect(await items).toEqual([1, 2])
  expect(closed).toHaveBeenCalledOnce()
})

test('a failure is delivered after queued items', async () => {
  const channel = new AsyncChannel<string>()
  channel.push('first')
  channel.fail(new Error('engine failed'))
  const received: string[] = []
  await expect((async () => { for await (const item of channel.iterate(new AbortController().signal)) received.push(item) })())
    .rejects.toThrow('engine failed')
  expect(received).toEqual(['first'])
})

test('consumer cancellation ends a waiting or already-cancelled iteration', async () => {
  const waiting = new AsyncChannel<number>(), controller = new AbortController()
  const items = drain(waiting.iterate(controller.signal))
  await Promise.resolve()
  controller.abort()
  expect(await items).toEqual([])
  waiting.push(1)
  const cancelled = new AsyncChannel<number>()
  cancelled.push(1)
  expect(await drain(cancelled.iterate(AbortSignal.abort()))).toEqual([1])
})
