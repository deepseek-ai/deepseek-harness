/** Original content and native file-save outcomes. */
/** Original content; the URL must identify the original, not a resized preview. */
export interface FileActionSource {
  readonly url: string
  /** Read through the resource owner's authorized carrier when the source is not a browser URL. */
  readonly read?: (signal: AbortSignal) => Promise<Blob>
  readonly name?: string
  readonly mediaType?: string
}
/** Result of an explicit save gesture. Only native completion supplies an absolute destination path. */
export type FileSaveResult = { readonly status: 'cancelled' }
  | { readonly status: 'requested' }
  | { readonly status: 'saved'; readonly path: string }
/** Desktop-owned operations exposed only to the trusted application frame. */
export interface DesktopFileActions {
  /**
   * @param request - captured original URL, suggested filename and destination policy.
   * @returns the completed destination path, or cancellation.
   */
  save(this: void, request: { url: string; name?: string; mediaType?: string; mode: 'download' | 'saveAs' }): Promise<FileSaveResult>
  /**
   * Read cross-origin originals only for the source-captured clipboard operation.
   * @param url - HTTP(S) original fetched without credentials.
   * @returns original bytes and response MIME.
   */
  readClipboardImage(this: void, url: string): Promise<{ bytes: Uint8Array; mediaType: string }>
}
/** UI-independent Client file actions. */
export interface FileActions {
  /**
   * Save original bytes to the selected destination.
   * @param source - original content.
   * @param mode - download on either platform, or saveAs on Desktop only.
   * @returns native save outcome or browser download request; rejects unsupported saveAs calls.
   */
  save(source: FileActionSource, mode: 'download' | 'saveAs'): Promise<FileSaveResult>
  /**
   * Copy a decoded, pasteable image.
   * @param source - encoded original.
   * @returns after a pasteable image is on the clipboard.
   */
  copyImage(source: FileActionSource): Promise<void>
  /** Whether the Desktop adapter can offer an explicit save picker; always false on Web. */
  readonly canSaveAs: boolean
}
