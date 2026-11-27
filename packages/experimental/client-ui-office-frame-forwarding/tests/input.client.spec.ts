/** Native latency cannot reorder discrete input or accumulate obsolete drag positions. */
import { expect, test, vi } from 'vitest'
import { OfficeInput } from '../src/client/input.ts'
import { headerCells } from '../src/client/headers.ts'

test('drag coalescing preserves mouse-up and the save barrier', async () => {
  const input = new OfficeInput(),
    first = Promise.withResolvers<undefined>(),
    calls: string[] = []
  const failure = vi.fn()
  const down = input.send(async () => {
    calls.push('down')
    await first.promise
  })
  for (let i = 0; i < 1000; i++)
    input.move(async () => {
      calls.push(`move:${i}`)
    }, failure)
  const up = input.send(async () => {
    calls.push('up')
  })
  input.move(async () => {
    calls.push('move:after-up')
  }, failure)
  const save = input.send(async () => {
    calls.push('save')
    return 7
  })
  expect(calls).toEqual(['down'])
  first.resolve(undefined)
  await Promise.all([down, up])
  expect(await save).toBe(7)
  expect(calls).toEqual(['down', 'move:999', 'up', 'move:after-up', 'save'])
  expect(failure).not.toHaveBeenCalled()
})

test('an input failure rejects its caller without stranding later operations', async () => {
  const input = new OfficeInput()
  const failed = input.send(async () => {
    throw new Error('engine')
  })
  const next = input.send(async () => 'next')
  await expect(failed).rejects.toThrow('engine')
  expect(await next).toBe('next')
})

test('a non-Error pointer failure is reported without blocking the next input', async () => {
  const input = new OfficeInput(), failure = vi.fn()
  input.move(async () => { throw 'producer gone' }, failure)
  await input.send(async () => {})
  expect(failure).toHaveBeenCalledWith(new Error('producer gone'))
})

test('scrolled Calc labels retain native document pixels and skip hidden dimensions', () => {
  expect(
    headerCells([
      { text: 21, size: 359 },
      { text: '22', size: 376 },
      { text: '23', size: 376 },
      { text: '24', size: 410 },
    ], 1),
  ).toEqual([
    { text: '22', start: 359, end: 376 },
    { text: '24', start: 376, end: 410 },
  ])
  expect(() =>
    headerCells([
      { text: 0, size: 30 },
      { text: '1', size: 10 },
    ], 1),
  ).toThrow('boundary')
})
