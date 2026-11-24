/** Every control shares one subscription to availability and voices, including reconnect and terminal failure. */
import { Context } from '@deepseek-ai/cordis'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type { ReadAloudStatus } from '@deepseek-ai/dsh-read-aloud/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { observeStatus } from '../src/client/status.ts'

const READY: ReadAloudStatus = { state: 'ready', synthesis: { voices: ['stella', 'tide'], voice: 'tide', sampleRate: 24_000 } }

function fixture(failure?: Error) {
  const abort = new AbortController(), release = Promise.withResolvers<undefined>(), accept = vi.fn()
  let options!: RemoteStreamOptions<ReadAloudStatus>
  const follow = vi.fn()
  const stream = {
    signal: abort.signal,
    async* [Symbol.asyncIterator]() {
      yield { value: READY, accept }
      await release.promise
      if (failure !== undefined) throw failure
    },
    dispose: async () => { abort.abort(); release.resolve(undefined) },
  }
  // Only the Gateway-owned transport is replaced; the mirror's publication remains real.
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  ctx.provide('remote', { readAloud: { follow }, $stream: (value: typeof options) => { options = value; return stream } })
  const mirror = observeStatus(ctx)
  return { mirror, options, follow, accept, release }
}

it('starts unavailable, mirrors the Host status with its voices, and falls back while the carrier is down', async () => {
  const b = fixture()
  expect(b.mirror.state.getSnapshot()).toEqual({ state: 'unavailable' })
  await vi.waitFor(() => { expect(b.mirror.state.getSnapshot()).toEqual(READY) })
  expect(b.accept).toHaveBeenCalledOnce()
  const signal = new AbortController().signal
  b.options.open(signal)
  expect(b.follow).toHaveBeenCalledWith(signal)
  expect(b.options.ended(true)).toBeInstanceOf(RemoteStreamCarrierError)
  b.options.carrierFailed?.(new RemoteStreamCarrierError('connection lost'))
  expect(b.mirror.state.getSnapshot()).toEqual({ state: 'unavailable' })
  await b.mirror.dispose()
})

it('reports a terminal stream failure as unavailable', async () => {
  const b = fixture(new Error('invalid snapshot'))
  await vi.waitFor(() => { expect(b.mirror.state.getSnapshot()).toEqual(READY) })
  b.release.resolve(undefined)
  await vi.waitFor(() => { expect(b.mirror.state.getSnapshot()).toEqual({ state: 'unavailable' }) })
  await b.mirror.dispose()
})
