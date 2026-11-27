/** One Remote connection and retained bodies shared by every Office tab. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { FrameForwardingClient } from '@deepseek-ai/dsh-frame-forwarding/client'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { OfficeClientId, OfficeDocumentEvent, OfficeRetentionFrame } from '../types.ts'
import { OfficeConnection } from './connection.ts'
import { RetainedOfficeViews } from './retained-views.ts'

/** The connection, engine events, and retained bodies outlive individual preview bodies. */
export class OfficePreviewClient {
  /** Remote operations and shared views used by every preview body. */
  readonly connection: OfficeConnection
  /** Tab-owned bodies preserve native sessions and bounded drawing caches while hidden. */
  readonly views: RetainedOfficeViews

  /**
   * Subscribe to engine events for this renderer until the plugin scope is disposed.
   * @param ctx - Client plugin scope with the mounted `officePreview` Remote namespace.
   * @param frames - Renderer-side frame forwarding.
   */
  constructor(ctx: Context, frames: FrameForwardingClient) {
    const remote = ctx.remote.officePreview
    const clientId = brandString<OfficeClientId>(randomUUID())
    const connection = new OfficeConnection(frames, remote, (documentId, carrierFailed) => ctx.remote.$stream<OfficeRetentionFrame>({
      name: 'Office document lease', carrierFailed, open: signal => remote.retain(documentId, clientId, signal),
      ended: () => new Error('Office document lease ended.'),
    }))
    this.connection = connection
    this.views = new RetainedOfficeViews((error) => { ctx.logger.warn(error) })
    const events = ctx.remote.$stream<OfficeDocumentEvent>({
      name: 'Office preview events', open: signal => remote.events(signal),
      ended: () => new Error('Office preview events ended.'),
    })
    // The Gateway retries carrier failures itself; a thrown error ends the stream for good, so no later engine failure
    // could reach the views. Disposal ends the loop without an error.
    void (async () => {
      for await (const frame of events) {
        frame.accept()
        connection.dispatch(frame.value)
      }
    })().catch((error: unknown) => {
      ctx.logger.warn(error)
      const message = error instanceof Error ? error.message : String(error)
      connection.failAll(new Error(`Office engine events are unavailable: ${message}`, { cause: error }))
    })
    ctx.effect(() => async () => {
      this.views.dispose()
      try { await connection.dispose() } finally { await events.dispose() }
    })
  }
}
