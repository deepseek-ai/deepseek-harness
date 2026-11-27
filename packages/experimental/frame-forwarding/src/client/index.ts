/** Frame-forwarding Client entry: the generated Remote contribution and the renderer-side service. */
import type { Context } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-frame-forwarding/remote'
import { mountFrameForwarding } from './mount.ts'

export { inject } from './mount.ts'
export type { FrameContentView, FrameContentWindow, FrameRxEvent } from './api.ts'
export type {
  FrameDiscardedError, FrameFailureError, FrameForwardingClient, FrameForwardingFrame, FrameFullscreenState,
  FrameRx,
} from './mount.ts'

/** Mount the generated `frameForwarding` Remote contribution and provide the renderer-side service.
 * @param ctx - Desktop Client plugin scope.
 * @returns Disposer withdrawing the service before its Remote contribution.
 */
export function apply(ctx: Context): Promise<() => Promise<void>> {
  return mountFrameForwarding(ctx, remote)
}
