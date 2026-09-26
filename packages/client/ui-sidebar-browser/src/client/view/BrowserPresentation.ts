/** The presentation face is separate from page navigation and terminal disposal. */
export interface BrowserPresentation {
  /**
   * Attach the page inside a committed content container.
   * @param viewportId - content element id; its DOM ancestors must remain connected for page retention.
   * @returns ends physical attachment, without disposing the navigation model; a later mount may reload the page.
   */
  mount(viewportId: string): () => void
}
