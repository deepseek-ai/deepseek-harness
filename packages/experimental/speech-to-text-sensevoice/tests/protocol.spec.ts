/** Private worker readiness and response parsing stop on invalid process/wire output. */
import { PassThrough } from 'node:stream'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { expect, it } from 'vitest'
import { SpeechInputError } from '../src/input.ts'
import { readReady, readTranscript } from '../src/recognizer.ts'

function child() {
  const stdout = new PassThrough()
  const done = Promise.withResolvers<{ exitCode: number; signal: null }>()
  const handle: SubprocessHandle = { stdout, stdin: undefined, stderr: undefined, control: undefined,
    done: done.promise, collected: {}, terminate: () => {}, waitForExit: async () => true }
  return { stdout, done, handle }
}

it('reads a fragmented readiness frame then detaches its listener', async () => {
  const c = child()
  const pending = readReady(c.handle, 100, new AbortController().signal)
  c.stdout.write('{"port":'); c.stdout.write('12345}\n')
  expect(await pending).toBe(12345)
  expect(c.stdout.listenerCount('data')).toBe(0)
  c.done.resolve({ exitCode: 0, signal: null }); c.stdout.destroy()
})

it('rejects malformed, oversized and invalid-port readiness frames', async () => {
  for (const frame of ['no JSON\n', '{"port":0}\n', '{"port":99,"extra":1}\n', 'x'.repeat(101)]) {
    const c = child()
    const pending = readReady(c.handle, 100, new AbortController().signal)
    const rejected = expect(pending).rejects.toThrow()
    c.stdout.write(frame)
    await rejected
    c.done.resolve({ exitCode: 0, signal: null }); c.stdout.destroy()
  }
})

it('rejects process exit, spawn failure, cancellation and unavailable output', async () => {
  const exit = child()
  const pending = readReady(exit.handle, 100, new AbortController().signal)
  exit.done.resolve({ exitCode: 1, signal: null })
  await expect(pending).rejects.toThrow('before readiness'); exit.stdout.destroy()
  const spawn = child()
  const failed = readReady(spawn.handle, 100, new AbortController().signal)
  spawn.done.reject(new Error('spawn failed'))
  await expect(failed).rejects.toThrow('spawn failed'); spawn.stdout.destroy()
  const c = child(), signal = new AbortController()
  const cancelled = readReady(c.handle, 100, signal.signal)
  signal.abort(new Error('cancelled'))
  await expect(cancelled).rejects.toThrow('cancelled')
  c.done.resolve({ exitCode: 0, signal: null }); c.stdout.destroy()
  await expect(readReady({ ...c.handle, stdout: undefined }, 100, signal.signal)).rejects.toThrow('unavailable')
  const before = child()
  await expect(readReady(before.handle, 100, AbortSignal.abort(new Error('already cancelled')))).rejects.toThrow('already cancelled')
  before.done.resolve({ exitCode: 0, signal: null }); before.stdout.destroy()
})

it('validates complete worker transcripts and bounded failures', async () => {
  const value = { text: '测试', audioSeconds: 1, inferenceSeconds: 0.1 }
  expect(await readTranscript(Response.json(value), 100)).toEqual(value)
  await expect(readTranscript(new Response(null), 100)).rejects.toThrow('no response')
  await expect(readTranscript(Response.json(value), 1)).rejects.toThrow('byte limit')
  await expect(readTranscript(Response.json({ error: 'unsupported language' }, { status: 400 }), 100)).rejects.toThrow('unsupported language')
  await expect(readTranscript(Response.json({ ...value, inferenceSeconds: -1 }), 100)).rejects.toThrow()
  await expect(readTranscript(new Response('broken'), 100)).rejects.toThrow()
})

it('contains stdout failures and primitive cancellation reasons while waiting for readiness', async () => {
  const c = child(), signal = new AbortController()
  const failed = readReady(c.handle, 100, signal.signal)
  c.stdout.emit('error', new Error('pipe closed'))
  await expect(failed).rejects.toThrow('pipe closed')
  expect(c.stdout.listenerCount('error')).toBe(0)
  c.done.resolve({ exitCode: 1, signal: null }); c.stdout.destroy()
  const cancelled = child(), abort = new AbortController()
  const pending = readReady(cancelled.handle, 100, abort.signal)
  abort.abort('closed')
  await expect(pending).rejects.toThrow('Speech operation cancelled')
  cancelled.done.resolve({ exitCode: 0, signal: null }); cancelled.stdout.destroy()
})

it.each([400, 413, 500])('classifies marked input failures only on input status %s', async (status) => {
  const error = await readTranscript(Response.json({ error: 'rejected', code: 'invalid-input' }, { status }), 100).catch((value: unknown) => value)
  expect(error).toBeInstanceOf(Error)
  expect(error instanceof SpeechInputError).toBe(status !== 500)
})
