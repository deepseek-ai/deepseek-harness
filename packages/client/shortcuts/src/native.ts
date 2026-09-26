/** Trusted product-window input exchanged with Electron's top-frame preload. */
import type { ShortcutRevision } from './persistence.ts'
import type { ShortcutCommandId } from './binding.ts'

/** Native input carries the accepted configuration identity; frame names identify the focused iframe or browser guest embedding element. */
export type DesktopShortcutInput = {
  readonly revision: ShortcutRevision
} & ({ readonly kind: 'menu'; readonly commandId: ShortcutCommandId }
  | { readonly kind: 'keyboard' | 'iframe' | 'webview'
    readonly frameName: string
    readonly code: string
    readonly secondCode?: string
    readonly control: boolean
    readonly alt: boolean
    readonly shift: boolean
    readonly meta: boolean
    readonly repeat: boolean })

/** Window-scoped capabilities exposed only to the product main frame. */
export interface DesktopKeyboardApi {
  /** Subscribe to verified native input. @param listener - current document consumer. @returns listener disposer. */
  subscribe(listener: (input: DesktopShortcutInput) => void): () => void
  /**
   * Close the owning window if its configuration is still current.
   * @param revision - accepted configuration identity.
   * @returns IPC completion.
   */
  closeWindow(revision: ShortcutRevision): Promise<void>
}
