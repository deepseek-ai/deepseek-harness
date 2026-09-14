import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { drainOutput } from '../src/output-stream.ts'

afterEach(() => vi.useRealTimers())

it('waits for queued output and accepts an already ended or absent stream', async () => {
  const stream = new PassThrough()
  const chunks: string[] = []
  stream.on('data', chunk => chunks.push(String(chunk)))
  const pending = drainOutput(stream, 1000)
  stream.end('last output')
  expect(await pending).toBe(true)
  expect(chunks).toEqual(['last output'])
  expect(await drainOutput(stream, 1000)).toBe(true)
  expect(await drainOutput(undefined, 1000)).toBe(true)
})

it('bounds an output descriptor retained after the process exits', async () => {
  vi.useFakeTimers()
  const stream = new PassThrough()
  const pending = drainOutput(stream, 100)
  await vi.advanceTimersByTimeAsync(100)
  expect(await pending).toBe(false)
  stream.destroy()
  expect(await drainOutput(stream, 100)).toBe(false)
})

it.each(['close', 'error'])('reports incomplete output on %s', async (event) => {
  const stream = new PassThrough()
  const pending = drainOutput(stream, 1000)
  stream.emit(event, new Error('pipe failed'))
  expect(await pending).toBe(false)
  stream.destroy()
})
