/** All voice views share one readiness subscription, including reconnect and terminal failure. */
import { Context } from '@deepseek-ai/cordis'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type { SpeechCatalog } from '@deepseek-ai/dsh-experimental-api-speech-to-text/types'
import { expect, it, vi, onTestFinished } from 'vitest'
import { observeReadiness } from '../src/client/readiness.ts'

const catalog: SpeechCatalog = { providers: [], selection: { providerId: 'local' as SpeechProviderId, language: 'auto' },
  maxAudioBytes: 100, maxDurationSeconds: 120 }

function fixture(failure?: unknown) {
  const abort = new AbortController(), release = Promise.withResolvers<undefined>(), accept = vi.fn()
  let options!: RemoteStreamOptions<SpeechCatalog>
  const follow = vi.fn()
  const stream = {
    signal: abort.signal,
    async *[Symbol.asyncIterator]() {
      yield { value: catalog, accept }
      await release.promise
      if (failure !== undefined) { abort.abort(); throw failure }
    },
    dispose: async () => { abort.abort(); release.resolve(undefined) },
  }
  // Only the Gateway-owned transport is replaced; the readiness publication remains real.
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  ctx.provide('remote', { speech: { follow },
    $stream: (value: typeof options) => { options = value; return stream },
  })
  const mirror = observeReadiness(ctx)
  return { mirror, options, follow, accept, release }
}

it('accepts a Host snapshot and keeps preparation ownership outside observation disposal', async () => {
  const b = fixture()
  await vi.waitFor(() => { expect(b.mirror.state.getSnapshot()).toEqual({ catalog, connected: true, error: null }) })
  expect(b.accept).toHaveBeenCalledOnce()
  const signal = new AbortController().signal
  b.options.open(signal)
  expect(b.follow).toHaveBeenCalledWith(signal)
  expect(b.options.ended(true)).toBeInstanceOf(RemoteStreamCarrierError)
  b.options.carrierFailed?.(new RemoteStreamCarrierError('connection lost'))
  expect(b.mirror.state.getSnapshot()).toMatchObject({ connected: false, error: 'connection lost' })
  await b.mirror.dispose()
})

it.each([new Error('invalid snapshot'), 'invalid snapshot'])('reports a terminal stream failure after its transport aborts', async (failure) => {
  const b = fixture(failure)
  b.release.resolve(undefined)
  await vi.waitFor(() => { expect(b.mirror.state.getSnapshot()).toMatchObject({ connected: false, error: 'invalid snapshot' }) })
  await b.mirror.dispose()
})

it('does not publish a disposal rejection as a Host failure', async () => {
  const b = fixture(new Error('disposed'))
  await vi.waitFor(() => { expect(b.mirror.state.getSnapshot().connected).toBe(true) })
  await b.mirror.dispose()
  expect(b.mirror.state.getSnapshot().error).toBeNull()
})
