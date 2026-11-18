/** Direct content inputs for transient sidebar and floating previews. */
import type { SidebarRightOpenResourceOptions } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** Content owned by the open tab; bytes and text are not persisted in layout. */
export type PreviewContent =
  | { readonly mediaType: string; readonly text: string }
  | { readonly mediaType: string; readonly bytes: Uint8Array<ArrayBuffer> }

/** Placement and identity for a transient content preview. */
export interface ContentPreviewOptions {
  readonly title: string
  /** Reuses a preview in the current window; omission creates a new preview. */
  readonly key?: string
  readonly destination?: SidebarRightOpenResourceOptions['destination']
}

/** Opens caller-supplied content without a resource provider. */
export interface ContentPreviews {
  /**
   * Open content through the shared sidebar controller. Reopening a key replaces its navigation input.
   * @param content - text or bytes to render.
   * @param options - title, identity and placement.
   */
  open(content: PreviewContent, options: ContentPreviewOptions): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Transient content preview navigation. */
    contentPreviews: ContentPreviews
  }
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightResourceParamsMap {
    /** Content remains in navigation memory and expires on reload. */
    'content-preview': { readonly previewContent: PreviewContent; readonly previewTitle: string }
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Actions for the current caller-supplied content. */
    'sidebar.right.tab.content.actions': {
      kind: 'list'
      scope: 'session'
      owner: {
        readonly address: string
        readonly content: PreviewContent
      }
    }
  }
}
