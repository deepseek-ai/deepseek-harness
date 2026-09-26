/** One reconnecting Host readiness mirror shared by every voice UI occurrence. */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SpeechCatalog } from '@deepseek-ai/dsh-experimental-api-speech-to-text/types'
import type {} from '@deepseek-ai/dsh-experimental-api-speech-to-text/remote'

/** Complete provider state, with a separate transport failure that never rewrites Host readiness. */
export interface SpeechReadiness {
  readonly catalog: SpeechCatalog | null
  readonly connected: boolean
  readonly error: string | null
}

/**
 * Subscribe once per Client plugin, independent of rendered pages and Sessions.
 * @param ctx - mounted speech Remote owner.
 * @returns shared readiness snapshot and joined observation cleanup.
 */
export function observeReadiness(ctx: Context): { state: SnapshotStore<SpeechReadiness>; dispose: () => Promise<void> } {
  const state = createSnapshotStore<SpeechReadiness>({ catalog: null, connected: false, error: null })
  let disposed = false
  const isDisposed = (): boolean => disposed
  const fail = (error: unknown): void => {
    state.set({ ...state.getSnapshot(), connected: false, error: error instanceof Error ? error.message : String(error) })
  }
  const stream = ctx.remote.$stream<SpeechCatalog>({
    name: 'Speech readiness', open: signal => ctx.remote.speech.follow(signal),
    ended: () => new RemoteStreamCarrierError('Speech readiness stream ended'), carrierFailed: fail,
  })
  const observing = (async () => {
    try {
      for await (const item of stream) {
        state.set({ catalog: item.value, connected: true, error: null })
        item.accept()
      }
    } catch (error) { if (!isDisposed()) fail(error) }
  })()
  return { state, dispose: async () => { disposed = true; await stream.dispose(); await observing } }
}
