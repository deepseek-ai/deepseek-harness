/** Selected-result transport releases values on carrier loss and closes on inspector disposal. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { RemoteStream, RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionToolResultValue } from '../src/types.ts'
import { createToolResultWatcher } from '../src/client/watch-tool-result.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

const connection = {
  generation: {
    getSnapshot: () => ({ id: 1, host: { home: '/fixture' } }),
    subscribe: () => () => {},
  },
}

function remote(source: (signal: AbortSignal) => AsyncIterable<SessionToolResultValue>): Parameters<typeof createToolResultWatcher>[0] {
  return {
    $stream: options => new RemoteStream(connection, options),
    toolResults: {
      watch: (_request, signal) => ({
        [Symbol.asyncIterator]: () => source(signal ?? new AbortController().signal)[Symbol.asyncIterator](),
        send: () => undefined, end: () => undefined, dispose: () => undefined,
      }),
    },
  }
}

it('cancels the selected subscription to quiescence without publishing late values', async () => {
  const opened = deferred()
  const finished = deferred()
  const publish = vi.fn(opened.resolve)
  const report = vi.fn()
  const watcher = createToolResultWatcher(remote(async function* (signal) {
    try {
      const aborted = new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      yield { available: true, value: { answer: 42 } }
      await aborted
      yield { available: true, value: 'late' }
    } finally {
      finished.resolve()
    }
  }), SessionId('selected'), report)
  const close = watcher(42, publish)
  onTestFinished(async () => { close(); await finished.promise })
  await opened.promise
  close()
  await finished.promise
  expect(publish.mock.calls).toEqual([[{ answer: 42 }]])
  expect(report).not.toHaveBeenCalled()
})

it('clears the displayed object on carrier loss while the reconnect owner waits', async () => {
  const cleared = deferred()
  const values: unknown[] = []
  const watcher = createToolResultWatcher(remote(async function* () {
    yield { available: true, value: { answer: 42 } }
    throw new RemoteStreamCarrierError('connection lost')
  }), SessionId('selected'), () => {})
  const close = watcher(42, (value) => {
    values.push(value)
    if (value === undefined) cleared.resolve()
  })
  onTestFinished(close)
  await cleared.promise
  expect(values).toEqual([{ answer: 42 }, undefined])
})
