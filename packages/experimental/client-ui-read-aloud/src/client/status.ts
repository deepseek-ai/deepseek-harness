/** One reconnecting mirror of the Host's read-aloud availability and voices, shared by every control. */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ReadAloudStatus } from '@deepseek-ai/dsh-read-aloud/types'
import type {} from '@deepseek-ai/dsh-read-aloud/remote'

/** The Host's latest status; `unavailable` without voices until the first report and while the stream is down. */
export type StatusStore = SnapshotStore<ReadAloudStatus>

/**
 * Follow availability once per Client plugin, independent of rendered pages and Sessions.
 * @param ctx - mounted read-aloud Remote owner.
 * @returns the mirrored status and a disposer that joins the observation.
 */
export function observeStatus(ctx: Context): { state: StatusStore; dispose: () => Promise<void> } {
  const state: StatusStore = createSnapshotStore<ReadAloudStatus>({ state: 'unavailable' })
  const down = (): void => { state.set({ state: 'unavailable' }) }
  const stream = ctx.remote.$stream<ReadAloudStatus>({
    name: 'Read-aloud status',
    open: signal => ctx.remote.readAloud.follow(signal),
    ended: () => new RemoteStreamCarrierError('Read-aloud status stream ended'),
    carrierFailed: down,
  })
  const following = (async () => {
    for await (const item of stream) {
      state.set(item.value)
      item.accept()
    }
  })().catch(down)
  return { state, dispose: async () => { await stream.dispose(); await following } }
}
