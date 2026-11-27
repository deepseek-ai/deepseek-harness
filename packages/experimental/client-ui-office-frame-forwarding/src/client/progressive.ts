/** Bounded RGBA page previews fill content not covered by the displayed render window. */
import { pageRectangles } from './pages.ts'
import type { OfficeDocumentInfo, OfficePagePreviewReply, Rect } from '../types.ts'
import { MAX_OFFICE_PIXEL_DIMENSION } from '../render-limits.ts'

/** Page coordinates are twips; presentation parts have separate coordinate origins. */
export interface PreviewPage extends Rect { index: number; part?: number }

/** Derive preview page rectangles from document metadata.
 * @param info - Native pagination.
 * @returns Ordered Word pages or presentation slides.
 */
export function previewPages(info: OfficeDocumentInfo): PreviewPage[] {
  if (info.documentType === 'text') return pageRectangles(info.rectangles).map((page, index) => ({ ...page, index }))
  if (info.documentType === 'presentation') return info.parts.map(({ index: part }, index) => ({ index, part, x: 0, y: 0, width: info.width, height: info.height }))
  return []
}

/** Prioritize preview work around the visible page.
 * @param count - Page count.
 * @param anchor - Zero-based visible page.
 * @returns Current, next, previous, then progressively farther pages.
 */
export function pageOrder(count: number, anchor: number): number[] {
  const start = Math.max(0, Math.min(count - 1, anchor)), order: number[] = []
  if (count === 0) return order
  order.push(start)
  for (let distance = 1; order.length < count; distance++) {
    if (start + distance < count) order.push(start + distance)
    if (start - distance >= 0) order.push(start - distance)
  }
  return order
}

/** Find the preview page containing the current viewing position.
 * @param pages - Word rectangles or slides.
 * @param top - Viewport top in twips.
 * @param part - Active slide.
 * @returns The page containing the viewing position.
 */
export function visiblePage(pages: readonly PreviewPage[], top: number, part: number): number {
  const slide = pages.findIndex(page => page.part === part)
  if (slide >= 0) return slide
  return Math.max(0, pages.findLastIndex(page => page.y <= top))
}

/** One page request at a time; all retained preview canvases share a fixed byte budget. */
export class ProgressivePages {
  private readonly canvases = new Map<number, HTMLCanvasElement>()
  private readonly styles = new WeakMap<HTMLCanvasElement, { position: string; clipPath: string; hidden: boolean }>()
  private readonly sizes: { width: number; height: number }[]
  private order: number[] = []
  private zoom = 1
  private part = 0
  private enabled = false
  private disposed = false
  private scheduled = 0
  private running: Promise<void> | undefined
  private epoch = 0
  private hole: Rect | undefined

  constructor(
    private readonly layer: HTMLDivElement,
    readonly pages: readonly PreviewPage[],
    maxBytes: number,
    private readonly load: (page: PreviewPage, width: number, height: number) => Promise<Pick<OfficePagePreviewReply, 'width' | 'height' | 'rgba'>>,
    private readonly ready: (page: number) => void,
    private readonly failure: (error: unknown) => void,
  ) {
    const area = pages.reduce((sum, page) => sum + page.width * page.height, 0)
    const scale = Math.min(1 / 15, Math.sqrt(Math.max(0, maxBytes / 4 - pages.length) / Math.max(1, area)))
    this.sizes = pages.map((page) => {
      const ratio = Math.min(scale, MAX_OFFICE_PIXEL_DIMENSION / page.width, MAX_OFFICE_PIXEL_DIMENSION / page.height)
      return { width: Math.max(1, Math.floor(page.width * ratio)), height: Math.max(1, Math.floor(page.height * ratio)) }
    })
    if (this.sizes.reduce((sum, size) => sum + size.width * size.height * 4, 0) > maxBytes)
      throw new Error('Office page previews exceed the configured cache budget.')
  }

  /** Reprioritize page rendering around the visible page.
   * @param anchor - Visible page.
   * @param zoom - CSS scale at 96 DPI.
   * @param part - Active slide.
   * @param loadSlide - Whether the active slide needs a static image outside its native window or during a frame shortage.
   */
  viewport(anchor: number, zoom: number, part: number, loadSlide = true): void {
    if (this.disposed) return
    this.enabled = true
    const reposition = this.zoom !== zoom || this.part !== part
    this.zoom = zoom
    this.part = part
    this.order = this.pages[anchor]?.part === undefined ? pageOrder(this.pages.length, anchor) : loadSlide ? [anchor] : []
    if (reposition) for (const [index, canvas] of this.canvases) this.position(canvas, this.pages[index] as PreviewPage)
    if (this.order.length !== 0 && !this.canvases.has(anchor) && this.running === undefined) {
      cancelAnimationFrame(this.scheduled)
      this.scheduled = 0
      this.start()
    } else this.schedule()
  }

  private position(canvas: HTMLCanvasElement, page: PreviewPage): void {
    const scale = this.zoom / 15
    const position = `position:absolute;left:${page.x * scale}px;top:${page.y * scale}px;width:${page.width * scale}px;height:${page.height * scale}px;pointer-events:none`
    const hidden = page.part !== undefined && page.part !== this.part, hole = this.hole
    let clipPath = ''
    if (hole !== undefined) {
      const x = Math.max(page.x, hole.x) - page.x, y = Math.max(page.y, hole.y) - page.y
      const right = Math.min(page.x + page.width, hole.x + hole.width) - page.x
      const bottom = Math.min(page.y + page.height, hole.y + hole.height) - page.y
      if (right > x && bottom > y)
        clipPath = `path(evenodd, "M0 0H${page.width * scale}V${page.height * scale}H0Z M${x * scale} ${y * scale}H${right * scale}V${bottom * scale}H${x * scale}Z")`
    }
    const previous = this.styles.get(canvas)
    if (previous?.position !== position) {
      // Replacing cssText also replaces the clip; commit both in one style mutation.
      canvas.style.cssText = clipPath === '' ? position : `${position};clip-path:${clipPath}`
    } else if (previous.clipPath !== clipPath) canvas.style.clipPath = clipPath
    if ((previous?.hidden ?? canvas.hidden) !== hidden) canvas.hidden = hidden
    this.styles.set(canvas, { position, clipPath, hidden })
  }

  private schedule(): void {
    if (!this.enabled || this.disposed || this.running !== undefined || this.scheduled !== 0) return
    if (this.order.every(index => this.canvases.has(index))) return
    this.scheduled = requestAnimationFrame(() => {
      this.scheduled = 0
      this.start()
    })
  }

  private start(): void {
    this.running = this.paint().finally(() => { this.running = undefined; this.schedule() })
  }

  private async paint(): Promise<void> {
    const epoch = this.epoch
    const index = this.order.find(index => !this.canvases.has(index))
    if (index === undefined || !this.enabled || this.disposed) return
    const page = this.pages[index] as PreviewPage, size = this.sizes[index] as { width: number; height: number }
    try {
      const pixels = await this.load(page, size.width, size.height)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispose() can run while the page request is pending.
      if (this.disposed) return
      if (pixels.width !== size.width || pixels.height !== size.height || !(pixels.rgba instanceof Uint8Array)
        || pixels.rgba.byteLength !== pixels.width * pixels.height * 4) throw new Error('Invalid Office page response.')
      const canvas = this.layer.ownerDocument.createElement('canvas')
      canvas.width = pixels.width; canvas.height = pixels.height
      const context = canvas.getContext('2d')
      if (context === null) throw new Error('Office page preview canvas is unavailable.')
      const image = context.createImageData(pixels.width, pixels.height)
      image.data.set(pixels.rgba)
      context.putImageData(image, 0, 0)
      canvas.dataset.officePagePreview = String(index)
      this.position(canvas, page)
      this.canvases.set(index, canvas)
      this.layer.append(canvas)
      this.ready(index)
    } catch (error) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispose() can run before the page request rejects.
      if (!this.disposed && epoch === this.epoch) { this.enabled = false; this.failure(error) }
    }
  }

  /** Reveal only the content actually displayed within the visible region.
   * @param displayed - Displayed image's immutable twip window, or undefined for a cleared presenter.
   * @param visible - Visible content rectangle in twips.
   */
  content(displayed: Rect | undefined, visible: Rect): void {
    let hole: Rect | undefined
    if (displayed !== undefined) {
      const x = Math.max(displayed.x, visible.x), y = Math.max(displayed.y, visible.y)
      hole = { x, y, width: Math.max(0, Math.min(displayed.x + displayed.width, visible.x + visible.width) - x),
        height: Math.max(0, Math.min(displayed.y + displayed.height, visible.y + visible.height) - y) }
    }
    if (this.hole?.x === hole?.x && this.hole?.y === hole?.y
      && this.hole?.width === hole?.width && this.hole?.height === hole?.height) return
    this.hole = hole
    for (const [index, canvas] of this.canvases) {
      const page = this.pages[index] as PreviewPage
      this.position(canvas, page)
    }
  }

  /** Pause new page work.
   * @returns Completion of the accepted page request; no further page is queued.
   */
  pause(): Promise<void> {
    this.epoch++
    this.enabled = false
    cancelAnimationFrame(this.scheduled)
    this.scheduled = 0
    return this.running ?? Promise.resolve()
  }

  /** Release every retained page canvas.
   * @returns Completion of the accepted request after releasing every retained canvas.
   */
  dispose(): Promise<void> {
    this.disposed = true
    const stopped = this.pause()
    for (const canvas of this.canvases.values()) { canvas.remove(); canvas.width = 0; canvas.height = 0 }
    this.canvases.clear()
    return stopped
  }
}
