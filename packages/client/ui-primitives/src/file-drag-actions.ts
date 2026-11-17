/** Stable file preparation callbacks supplied by a transfer-owning plugin. */
import type { DragFileName } from '@deepseek-ai/dsh-util-file-drag'

/** Content source and optional Host-verifiable identity of its unmodified local original. */
export type FileDragSource = DragFileName & { readonly resourceAddress?: string | undefined } & (
  | { readonly kind: 'blob'; readonly blob: Blob }
  | { readonly kind: 'url'; readonly url: string }
)

/** Prepared operation; release cancels unused resources without ending an active browser transfer. */
export interface PreparedFileDrag {
  /**
   * Start the prepared transfer while the browser payload is writable.
   * @param transfer - writable dragstart payload.
   * @param source - native source node, retained through drag end.
   * @returns true for browser dragging; false when native dragging takes over.
   */
  start(transfer: DataTransfer, source: HTMLElement): boolean
  /** Release this preparation once the pointer leaves or the source unmounts. */
  release(): void
}

/** Presentation sees preparation and feedback; transport selection belongs to the plugin. */
export interface FileDragActions {
  /** @param source - file content and export name. @param signal - preparation cancellation. @returns the ready start/release operation. */
  prepare(source: FileDragSource, signal: AbortSignal): Promise<PreparedFileDrag>
  /** Display the plugin's localized retry message, independently of the originating component. */
  reportFailure(): void
}
