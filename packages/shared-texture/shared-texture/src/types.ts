/**
 * Shared-texture vocabulary without Cordis `Context` declarations. Both compiler faces import this module and neither
 * one's `Context.sharedTexture` declaration enters the other's program; the root entry and the Client entry re-export
 * these names, so consumers never name this module directly.
 */

/**
 * Borrowed shared frame; the consumer releases it once it no longer uses `frame`. The presentation host returns the
 * texture to its producer only after the GPU work that read `frame` has completed.
 */
export interface SharedTextureLease {
  frame: VideoFrame
  /** The presenting Host consumer's metadata, parsed from the JSON text it sent; null when it sent none. */
  metadata: unknown
  release(): void
}

/**
 * Renderer texture bridge exposed by a host shell to its product document. The document consumes every texture the
 * Host presents; it cannot request, resize, or close textures.
 */
export interface SharedTextureClientExport {
  /**
   * Register the single consumer of presented textures; each delivered lease must be released. A texture that arrives
   * without a consumer is refused before import, and the Host learns that its presentation failed.
   * @param listener - Takes ownership of each delivered lease.
   * @returns Disposer that stops future delivery without releasing delivered leases.
   */
  onFrame(listener: (lease: SharedTextureLease) => void): () => void
}

/**
 * The presentation document's global as a host shell installs it before the document boots. The Client plugin reads
 * only {@link SharedTextureClientExport} here; a shell that presents no textures leaves `textures` out, and documents
 * without a shell global have none.
 */
export interface SharedTextureHostExport {
  readonly dshDesktop?: { readonly textures?: SharedTextureClientExport }
}
