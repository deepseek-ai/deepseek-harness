/** Latest-only whole-window painting; geometry keeps moving independently of render success. */
import type { FrameContentView, FrameContentWindow } from '@deepseek-ai/dsh-frame-forwarding/client'
import type { FrameForwardingViewport } from '@deepseek-ai/dsh-frame-forwarding/types'
import type { OfficeOpenedDocument, OfficePaintRequest, Rect } from '../types.ts'
import { MAX_OFFICE_PIXEL_DIMENSION } from '../render-limits.ts'

/** Stop after four presentation failures without a successful video track write. */
const PRESENTATION_FAILURE_LIMIT = 4
/** Failures more than ten seconds apart start a new count. */
const PRESENTATION_FAILURE_WINDOW_MS = 10_000
/** Fixed backoff: the first failure redraws at once, later ones after 250 ms, doubling; all stay inside the window. */
const PRESENTATION_RETRY_BASE_MS = 250

interface Demand {
  view: FrameContentView
  width: number
  height: number
  deviceScale: number
  document: { width: number; height: number }
  part: number
  visible: boolean
}
interface WindowPlan {
  window: FrameContentWindow
  pixelWidth: number
  pixelHeight: number
  deviceScale: number
  marginX: number
  marginY: number
}
interface RendererOwner {
  setView(view: FrameContentView): void
  setWindow(window: FrameContentWindow): Promise<FrameForwardingViewport>
  viewport(): FrameForwardingViewport | undefined
  ready(): Promise<void>
  paint(request: Omit<OfficePaintRequest, 'frame'>, generation: number): Promise<void>
  retry(error: unknown): 'stale' | 'credit' | undefined
  rebuild(): Promise<void>
  waiting(waiting: boolean): void
  failure(error: unknown): void
}

function visibleArea(demand: Demand): Rect {
  const { view, document } = demand
  const x = Math.max(0, Math.min(document.width - 1, view.x)), y = Math.max(0, Math.min(document.height - 1, view.y))
  return { x, y, width: Math.max(1, Math.min(document.width, view.x + demand.width / view.scale) - x),
    height: Math.max(1, Math.min(document.height, view.y + demand.height / view.scale) - y) }
}

/** Choose the largest configured margin that fits Kit's 4096-pixel edges, reducing DPR only after margins reach zero.
 * @param demand - Latest visible content and physical scale.
 * @param overscan - Configured viewport fraction on each side.
 * @returns Integer twip window, physical dimensions and usable margins.
 */
export function renderWindow(demand: Demand, overscan: number): WindowPlan {
  const visible = visibleArea(demand)
  const deviceScale = Math.min(demand.deviceScale, MAX_OFFICE_PIXEL_DIMENSION / (Math.ceil(visible.width) * demand.view.scale),
    MAX_OFFICE_PIXEL_DIMENSION / (Math.ceil(visible.height) * demand.view.scale))
  const density = deviceScale * demand.view.scale
  const marginX = Math.max(0, Math.min(visible.width * overscan, (MAX_OFFICE_PIXEL_DIMENSION / density - Math.ceil(visible.width)) / 2))
  const marginY = Math.max(0, Math.min(visible.height * overscan, (MAX_OFFICE_PIXEL_DIMENSION / density - Math.ceil(visible.height)) / 2))
  const x = Math.max(0, Math.floor(visible.x - marginX)), y = Math.max(0, Math.floor(visible.y - marginY))
  const window = { x, y,
    width: Math.max(1, Math.min(Math.ceil(demand.document.width), Math.ceil(visible.x + visible.width + marginX)) - x),
    height: Math.max(1, Math.min(Math.ceil(demand.document.height), Math.ceil(visible.y + visible.height + marginY)) - y) }
  return { window, deviceScale, marginX, marginY,
    pixelWidth: Math.min(MAX_OFFICE_PIXEL_DIMENSION, Math.max(1, Math.round(window.width * density))),
    pixelHeight: Math.min(MAX_OFFICE_PIXEL_DIMENSION, Math.max(1, Math.round(window.height * density))) }
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** One paint at a time; stop joins the admitted request before another mount can take ownership. */
export class ViewportRenderer {
  private demand: Demand | undefined
  private requested: { plan: WindowPlan; part: number; scale: number; dpr: number } | undefined
  private displayed: Rect | undefined
  private paintedGeneration: number | undefined
  private dirty = 1
  private painted = 0
  private enabled = true
  private stopped = false
  private running: Promise<void> | undefined
  private settle: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private creditFailures = 0
  private presentationFailures: { count: number; at: number } | undefined
  private presentationRetry: ReturnType<typeof setTimeout> | undefined

  /** @param settings - Validated Host rendering configuration. @param timeoutMs - Credit backoff ceiling.
   * @param owner - Mount and business-operation owner; it reports terminal failures.
   */
  constructor(private readonly settings: OfficeOpenedDocument['rendering'], private readonly timeoutMs: number,
    private readonly owner: RendererOwner) {}

  /** Synchronize view even when painting is disabled or failed.
   * @param demand - Latest viewport and document geometry; unsent demand replaces earlier demand.
   */
  update(demand: Demand): void {
    if (this.stopped) return
    this.owner.setView(demand.view)
    if (this.demand !== undefined && this.demand.view.scale !== demand.view.scale) {
      clearTimeout(this.settle)
      this.settle = setTimeout(() => { this.settle = undefined; this.kick() }, this.settings.zoomSettleMs)
    }
    this.demand = demand
    this.kick()
  }

  /** Pause paint and clear credit waiting/retries without stopping view synchronization.
   * @param enabled - Whether render operations may start.
   */
  enable(enabled: boolean): void { this.enabled = enabled; this.kick() }

  /** React to a submitted mount viewport; painting waits for its acknowledgement. */
  viewportChanged(): void { this.kick() }

  /** Record the window actually displayed for invalidation intersection.
   * @param window - Displayed window, or undefined when the presenter has no observable content.
   */
  content(window: Rect | undefined): void { this.displayed = window }

  /** Each successful video track write ends the current run of presentation failures. */
  presented(): void { this.presentationFailures = undefined }

  /**
   * Repaint after a frame failed to reach the display: the first failure at once, later ones with backoff. The failure
   * that reaches {@link PRESENTATION_FAILURE_LIMIT} without a successful track write stops painting and goes to the
   * owner's failure callback once.
   * @param error - The presentation failure.
   */
  presentationFailed(error: Error): void {
    if (this.stopped) return
    const now = performance.now(), previous = this.presentationFailures
    const count = previous === undefined || now - previous.at > PRESENTATION_FAILURE_WINDOW_MS ? 1 : previous.count + 1
    this.presentationFailures = { count, at: now }
    if (count === 1) {
      clearTimeout(this.presentationRetry)
      this.presentationRetry = undefined
      this.invalidate()
      return
    }
    if (count >= PRESENTATION_FAILURE_LIMIT) {
      clearTimeout(this.presentationRetry)
      this.presentationRetry = undefined
      if (count > PRESENTATION_FAILURE_LIMIT) return
      this.enabled = false
      this.owner.failure(error)
      return
    }
    // Failures that arrive while a repaint waits share it.
    this.presentationRetry ??= setTimeout(() => {
      this.presentationRetry = undefined
      this.invalidate()
    }, PRESENTATION_RETRY_BASE_MS * 2 ** (count - 2))
  }

  /** Invalidate a displayed or requested region without creating a new generation.
   * @param area - Dirty twip rectangle; omitted means all content, including a new producer.
   */
  invalidate(area?: Rect): void {
    if (area !== undefined
      && ![this.displayed, this.requested?.plan.window].some(window => window !== undefined && intersects(window, area))) return
    this.dirty++
    this.kick()
  }

  private needsWindow(demand: Demand): boolean {
    const requested = this.requested
    if (requested === undefined || requested.part !== demand.part || requested.scale !== demand.view.scale
      || requested.dpr !== demand.deviceScale) return true
    const { window: w, marginX, marginY } = requested.plan, v = visibleArea(demand), h = this.settings.reanchorHysteresis
    return v.x < (w.x === 0 ? 0 : w.x + marginX * h)
      || v.y < (w.y === 0 ? 0 : w.y + marginY * h)
      || v.x + v.width > (w.x + w.width >= demand.document.width ? demand.document.width : w.x + w.width - marginX * h)
      || v.y + v.height > (w.y + w.height >= demand.document.height ? demand.document.height : w.y + w.height - marginY * h)
  }

  private active(): boolean {
    return !this.stopped && this.enabled && this.demand?.visible === true && this.owner.viewport()?.visible === true
  }

  private canPaint(): boolean {
    return this.active() && this.settle === undefined && this.retryTimer === undefined
  }

  private clearRetry(): void {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.creditFailures = 0
    this.owner.waiting(false)
  }

  private needed(): boolean {
    return this.demand !== undefined && (this.needsWindow(this.demand) || this.painted !== this.dirty
      || this.paintedGeneration !== this.owner.viewport()?.version)
  }

  private kick(): void {
    if (!this.active()) { this.clearRetry(); return }
    if (this.running !== undefined || !this.canPaint() || !this.needed()) return
    this.running = this.paint().finally(() => { this.running = undefined; this.kick() })
  }

  private async paint(): Promise<void> {
    try {
      await this.owner.ready()
      const demand = this.demand, requested = this.requested
      if (!this.canPaint() || demand === undefined) return
      const plan = requested === undefined || this.needsWindow(demand)
        ? renderWindow(demand, this.settings.overscanViewports) : requested.plan
      // This call is reached only after the preceding paint promise settled.
      await this.owner.setWindow(plan.window)
      this.requested = { plan, part: demand.part, scale: demand.view.scale, dpr: demand.deviceScale }
      if (!this.canPaint()) return
      await this.owner.ready()
      if (!this.canPaint()) return
      const generation = (this.owner.viewport() as FrameForwardingViewport).version, dirty = this.dirty
      await this.owner.paint({ ...plan.window, part: demand.part, pixelWidth: plan.pixelWidth, pixelHeight: plan.pixelHeight }, generation)
      this.painted = dirty
      this.paintedGeneration = generation
      this.creditFailures = 0
      this.owner.waiting(false)
    } catch (error) {
      if (!this.active()) return
      const retry = this.owner.retry(error)
      if (retry === undefined) { this.enabled = false; this.owner.failure(error); return }
      this.dirty++
      if (retry === 'credit') {
        this.owner.waiting(true)
        if (++this.creditFailures >= this.settings.creditRetryLimit) {
          this.creditFailures = 0
          try { await this.owner.rebuild() } catch (failure) {
            if (!this.stopped) { this.enabled = false; this.owner.failure(failure) }
            return
          }
        }
      }
      if (!this.active()) return
      const delay = retry === 'stale' ? Math.max(1, this.settings.zoomSettleMs)
        : Math.min(this.timeoutMs, Math.max(1, this.settings.zoomSettleMs) * 2 ** Math.min(20, this.creditFailures))
      this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.kick() }, delay)
    }
  }

  /** Stop new work and join the admitted paint; does not own or clear displayed pixels.
   * @returns Completion after the outstanding render operation settles.
   */
  stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.settle)
    clearTimeout(this.presentationRetry)
    this.clearRetry()
    return this.running ?? Promise.resolve()
  }
}
