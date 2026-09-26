/** PDF.js's viewer owns selection boundaries and copy normalization; the overlay follows its canvas. */
// The official viewer resolves its version-matched engine through pdfjsLib.
import 'pdfjs-dist'
import { TextLayerBuilder } from 'pdfjs-dist/web/pdf_viewer.mjs'
import type { RenderPdfText } from './document.ts'

/**
 * Create a selectable overlay in a component-owned host.
 * @param host - absolute overlay matching the displayed canvas dimensions.
 * @returns renderer whose cancellation also releases its resize observer and DOM.
 */
export function pdfTextRenderer(host: HTMLDivElement): RenderPdfText {
  return (page, viewport) => {
    // cancel() releases the builder's shared selection listener after the last page leaves.
    const layer = new TextLayerBuilder({ pdfPage: page })
    const container = layer.div
    container.style.setProperty('--total-scale-factor', String(viewport.scale * viewport.userUnit))
    container.style.setProperty('--scale-round-x', '1px')
    container.style.setProperty('--scale-round-y', '1px')
    host.append(container)
    const resize = (): void => {
      // Width fitting must compose with the viewer's page rotation and translation.
      container.style.scale = String(host.getBoundingClientRect().width / viewport.width)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()
    return {
      // PDF.js 6 declares images as required, but its viewer also renders text-only layers without it.
      promise: layer.render({ viewport } as Parameters<TextLayerBuilder['render']>[0]),
      cancel() {
        observer.disconnect()
        layer.cancel()
        container.remove()
      },
    }
  }
}
