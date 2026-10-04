/** One-shot Inspector picking through a real click-catching mask over the main Chat. */

import { matchChatElement, type InspectorPickTarget } from './pick-match.ts'
import { displayed, inChat } from './dom.ts'
import { placeChatHighlight } from './highlight.ts'
import css from '../inspector.module.css'

const POINTER_ACTIONS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick', 'dblclick', 'contextmenu'] as const

/** Owns the mask, preview, and geometry observers for one picking gesture. */
export class InspectorChatPicker {
  private mask: HTMLElement | undefined
  private overlay: HTMLElement | undefined
  private root: HTMLElement | undefined
  private observing: MutationObserver | undefined
  private resizing: ResizeObserver | undefined

  /**
   * @param getRoot - Current Session's displayed main Chat.
   * @param owner - Inspector button; hiding or removing it cancels picking.
   * @param picked - True completes selection; false keeps the mask for another pick.
   * @param cancelled - Clear the owning panel's picking state.
   * @param released - Forget this gesture after its DOM resources are released.
   */
  constructor(private readonly getRoot: () => HTMLElement | undefined, private readonly owner: HTMLElement,
    private readonly picked: (target: InspectorPickTarget) => boolean, private readonly cancelled: () => void,
    private readonly released: () => void) {}

  /**
   * Begin picking in the visible main Chat.
   * @returns Whether a visible Chat was found and its mask installed.
   */
  start(): boolean {
    const root = this.getRoot()
    if (root === undefined || !displayed(root) || !displayed(this.owner)) return false
    const mask = document.createElement('div')
    if (!placeChatHighlight(mask, root)) return false
    // oxlint-disable-next-line typescript/no-non-null-assertion -- This class is declared in the imported CSS Module.
    mask.className = css.chatPickMask!
    mask.dataset.sessionInspectorPicker = ''
    mask.setAttribute('aria-hidden', 'true')
    this.root = root
    this.mask = mask
    mask.addEventListener('pointermove', this.move)
    mask.addEventListener('pointerleave', this.hide)
    mask.addEventListener('click', this.click)
    mask.addEventListener('wheel', this.wheel, { passive: false })
    for (const type of POINTER_ACTIONS) mask.addEventListener(type, this.suppress)
    document.body.append(mask)
    window.addEventListener('keydown', this.keydown, true)
    window.addEventListener('blur', this.cancel)
    window.addEventListener('scroll', this.position, true)
    window.addEventListener('resize', this.position)
    this.observing = new MutationObserver(this.verify)
    for (const start of [this.owner, root]) {
      for (let element: HTMLElement | null = start; element !== null; element = element.parentElement) {
        this.observing.observe(element, { attributes: true, attributeFilter: ['hidden', 'style', 'class'], childList: true })
      }
    }
    if (typeof ResizeObserver !== 'undefined') {
      this.resizing = new ResizeObserver(this.position)
      this.resizing.observe(root)
    }
    return true
  }

  /** Remove the mask and observers without calling panel callbacks during unmount. */
  dispose(): void {
    const mask = this.mask
    if (mask !== undefined) {
      mask.removeEventListener('pointermove', this.move)
      mask.removeEventListener('pointerleave', this.hide)
      mask.removeEventListener('click', this.click)
      mask.removeEventListener('wheel', this.wheel)
      for (const type of POINTER_ACTIONS) mask.removeEventListener(type, this.suppress)
      mask.remove()
    }
    this.mask = undefined
    this.root = undefined
    window.removeEventListener('keydown', this.keydown, true)
    window.removeEventListener('blur', this.cancel)
    window.removeEventListener('scroll', this.position, true)
    window.removeEventListener('resize', this.position)
    this.observing?.disconnect()
    this.observing = undefined
    this.resizing?.disconnect()
    this.resizing = undefined
    this.hide()
    this.released()
  }

  private currentRoot(): HTMLElement | undefined {
    const root = this.root
    return root !== undefined && this.getRoot() === root && displayed(root) && displayed(this.owner) ? root : undefined
  }

  private readonly position = (): void => {
    this.hide()
    this.verify()
  }

  private readonly verify = (): void => {
    if (this.mask === undefined) return
    const root = this.currentRoot()
    if (root === undefined || !placeChatHighlight(this.mask, root)) this.cancel()
  }

  private hit(event: MouseEvent): { element: Element; root: HTMLElement } | undefined {
    if (this.mask === undefined) return undefined
    const root = this.currentRoot()
    if (root === undefined) { this.cancel(); return undefined }
    const element = document.elementsFromPoint(event.clientX, event.clientY)
      .find(element => element !== this.mask && element !== this.overlay)
    return element !== undefined && inChat(element, root) ? { element, root } : undefined
  }

  private readonly hide = (): void => { this.overlay?.remove(); this.overlay = undefined }
  /** Stop the gesture and clear its owning panel's picking state. */
  readonly cancel = (): void => {
    if (this.mask === undefined) return
    this.dispose()
    this.cancelled()
  }

  private readonly move = (event: PointerEvent): void => {
    const hit = this.hit(event)
    const match = hit === undefined ? undefined : matchChatElement(hit.element, hit.root)
    if (match === undefined) { this.hide(); return }
    const overlay = this.overlay ?? document.createElement('div')
    // oxlint-disable-next-line typescript/no-non-null-assertion -- This class is declared in the imported CSS Module.
    overlay.className = css.chatPick!
    overlay.dataset.sessionInspectorHighlight = 'pick'
    overlay.setAttribute('aria-hidden', 'true')
    if (!placeChatHighlight(overlay, match.element)) { this.hide(); return }
    if (this.overlay === undefined) { document.body.append(overlay); this.overlay = overlay }
  }

  private readonly suppress = (event: Event): void => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  private readonly click = (event: MouseEvent): void => {
    this.suppress(event)
    if (event.button !== 0) return
    const hit = this.hit(event)
    const match = hit === undefined ? undefined : matchChatElement(hit.element, hit.root)
    if (match !== undefined && this.picked(match.target)) this.dispose()
  }

  private readonly wheel = (event: WheelEvent): void => {
    this.suppress(event)
    const hit = this.hit(event)
    for (let element: Element | null = hit?.element ?? null; element !== null; element = element.parentElement) {
      if (!(element instanceof HTMLElement) || !element.matches('[data-conversation-scroll], [data-step-process-body]')) continue
      const vertical = event.deltaY < 0 ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight
      const horizontal = event.deltaX < 0 ? element.scrollLeft > 0 : element.scrollLeft + element.clientWidth < element.scrollWidth
      if (!(event.deltaY !== 0 && vertical || event.deltaX !== 0 && horizontal)) continue
      const style = getComputedStyle(element)
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? element.clientHeight
        : event.deltaMode === WheelEvent.DOM_DELTA_LINE ? Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) || 1 : 1
      element.scrollBy({ top: event.deltaY * scale, left: event.deltaX * scale, behavior: 'instant' })
      break
    }
  }

  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    this.suppress(event)
    this.cancel()
  }
}
