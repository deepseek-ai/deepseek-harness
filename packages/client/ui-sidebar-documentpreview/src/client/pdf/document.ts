/** Canvas rendering with cancellation and page cleanup, shared by the PDF body and real-library smoke. */
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist'

/** The document operations used by one mounted PDF body. */
export type PdfDocument = Pick<PDFDocumentProxy, 'numPages' | 'getPage'>

/** One in-flight PDF load and its complete cleanup operation. */
export interface PdfSession {
  readonly document: Promise<PdfDocument>
  /**
   * Cancel loading and rendering, destroy the document, and release its worker.
   * Library teardown failures are logged after native resources are released.
   * @returns cleanup completion without rejection.
   */
  dispose(): Promise<void>
}

/** Page geometry expressed in CSS pixels. */
export interface PdfPageSize {
  readonly width: number
  readonly height: number
}

/** Optional DOM text rendering that shares the canvas page's cleanup barrier. */
export type RenderPdfText = (page: PDFPageProxy, viewport: PageViewport) => {
  readonly promise: Promise<void>
  cancel(): void
}

/**
 * Render one page into an exclusively owned canvas. Cancellation cannot write
 * dimensions after a delayed getPage; active render tasks are cancelled and
 * awaited before the page is cleaned up.
 * @param document - loaded pdfjs document.
 * @param pageNumber - 1-based selected page.
 * @param canvas - canvas owned by this render only.
 * @param signal - render lifetime.
 * @param pixelRatio - device pixel ratio multiplied by the settled document zoom.
 * @param renderText - optional selectable text layer sharing this page and viewport.
 * @returns the page's CSS dimensions after rendering completes.
 */
export async function renderPdfPage(
  document: PdfDocument,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  signal: AbortSignal,
  pixelRatio: number,
  renderText?: RenderPdfText,
): Promise<PdfPageSize> {
  signal.throwIfAborted()
  const page: PDFPageProxy = await document.getPage(pageNumber)
  try {
    signal.throwIfAborted()
    const viewport = page.getViewport({ scale: 96 / 72 })
    // Limit raster allocation without changing the document's display dimensions.
    const ratio = Math.min(pixelRatio, Math.sqrt(16_777_216 / (viewport.width * viewport.height)))
    canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
    canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
    canvas.style.setProperty('--pdf-page-width', `${viewport.width}px`)
    canvas.style.setProperty('--pdf-page-height', `${viewport.height}px`)
    const task = page.render({
      canvas,
      viewport,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
    })
    let text: ReturnType<RenderPdfText> | undefined
    let cancelled = false
    const cancel = (): void => {
      if (cancelled) return
      cancelled = true
      task.cancel()
      text?.cancel()
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      text = renderText?.(page, viewport)
      if (signal.aborted) cancel()
      await Promise.all([task.promise, text?.promise])
      signal.throwIfAborted()
      return { width: viewport.width, height: viewport.height }
    } catch (error) {
      cancel()
      await Promise.allSettled([task.promise, text?.promise])
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  } finally {
    page.cleanup()
  }
}
