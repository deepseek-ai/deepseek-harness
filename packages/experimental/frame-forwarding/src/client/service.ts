/** Renderer half of frame forwarding: receive channels over `ctx.sharedTexture` and the Host's `frameForwarding` Remote. */
import type { Context } from '@deepseek-ai/cordis'
import type { SharedTextureClientExport } from '@deepseek-ai/dsh-shared-texture/client'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-frame-forwarding/remote'
import type { FrameForwardingEvent, FrameRxId } from '../types.ts'
import { FrameDiscardedError } from './errors.ts'
import { FrameRx } from './rx.ts'
import type { FrameForwardingBridge, FrameForwardingClient } from './api.ts'
import { adaptFrameForwardingBridge } from './wire.ts'

/** Generated Client methods of the Host frame-forwarding service. */
export type FrameForwardingRemote = TypertClientRemote['frameForwarding']

/** One renderer's subscription to channel events and its adapter over `ctx.sharedTexture`. */
export class FrameForwardingClientService implements FrameForwardingClient {
  private readonly bridge: FrameForwardingBridge

  /**
   * Consume shared textures and subscribe to channel states for this renderer until the plugin scope is disposed.
   * @param ctx - Client plugin scope with the mounted `frameForwarding` Remote namespace.
   * @param textures - Client `ctx.sharedTexture` bridge; throws when another consumer holds it.
   */
  constructor(ctx: Context, textures: SharedTextureClientExport) {
    const remote = ctx.remote.frameForwarding
    const bridge = adaptFrameForwardingBridge(textures, remote)
    ctx.effect(() => () => { bridge.dispose() })
    this.bridge = bridge
    const events = ctx.remote.$stream<FrameForwardingEvent>({
      name: 'Frame-forwarding channel events', open: signal => remote.events(signal),
      ended: () => new Error('Frame-forwarding channel events ended.'),
    })
    // The Remote stream ends with an error only when it can no longer recover; every channel then fails, while the
    // service stays provided and `connect` returns channels that fail at once.
    void (async () => {
      for await (const frame of events) {
        frame.accept()
        bridge.apply(frame.value)
      }
    })().catch((error: unknown) => {
      ctx.logger.warn(error)
      bridge.fail(`Frame-forwarding channel events failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    ctx.effect(() => () => events.dispose())
  }

  connect(rx: FrameRxId): FrameRx {
    return new FrameRx(rx, this.bridge)
  }

  discardReason(error: unknown): FrameDiscardedError['reason'] | undefined {
    return error instanceof FrameDiscardedError ? error.reason : undefined
  }
}
