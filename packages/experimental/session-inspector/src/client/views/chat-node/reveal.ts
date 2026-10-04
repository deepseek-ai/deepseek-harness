/** Inspector-owned DOM reveal and native scrolling, without a Conversation request channel. */

import { flushSync } from 'react-dom'
import type { InspectorChatTarget } from '../objects.ts'
import { displayed, findChatTargets } from './dom.ts'
import { placeChatHighlight, visibleChatRect } from './highlight.ts'
import css from '../inspector.module.css'

const SCROLL_QUIET_MS = 150
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Escape'])

function hasRenderedBox(element: HTMLElement): boolean {
  if (!displayed(element)) return false
  const box = element.getBoundingClientRect()
  return box.width > 0 && box.height > 0
}

/** Owns one deferred reveal and body-level flash, without modifying Chat content nodes. */
export class InspectorChatRevealer {
  private frame: number | undefined
  private overlay: HTMLElement | undefined
  private animation: Animation | undefined
  private cancelScroll: (() => void) | undefined

  /** @param getRoot - Current Session's main Chat, or undefined when it is not displayed. */
  constructor(private readonly getRoot: () => HTMLElement | undefined) {}

  /**
   * Reveal the first usable occurrence, falling back to the displayed Chat column.
   * Hidden or empty candidates do not prevent nearby content from being highlighted.
   * The highlight waits for scrolling to settle; reduced-motion mode scrolls immediately without a flash.
   * @param targets - Exact and approximate Node, Group, or Turn identities in preference order.
   */
  reveal(targets: readonly InspectorChatTarget[]): void {
    this.dispose()
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined
      const root = this.getRoot()
      if (root === undefined) return
      for (const initial of findChatTargets(root, targets)) {
        if (!root.contains(initial)) continue
        const hidden: HTMLElement[] = []
        for (let element: HTMLElement | null = initial; element !== null && element !== root; element = element.parentElement) {
          if (element.getAttribute('hidden') === 'until-found') hidden.push(element)
        }
        if (hidden.length > 0 || visibleChatRect(initial) === undefined) {
          root.closest('[data-conversation-scroll]')?.dispatchEvent(new Event('beforematch'))
        }
        for (const element of hidden.reverse()) flushSync(() => { element.dispatchEvent(new Event('beforematch')) })
        if (this.getRoot() !== root) return
        const row = root.contains(initial) ? initial : findChatTargets(root, targets).find(hasRenderedBox)
        if (row === undefined || !hasRenderedBox(row)) continue
        if (visibleChatRect(row) === undefined) {
          if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            this.smoothScroll(row, root, targets)
            return
          }
          row.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' })
        }
        this.queueFlash(row, root, targets)
        return
      }
      if (displayed(root) && visibleChatRect(root) !== undefined) this.queueFlash(root, root, targets)
    })
  }

  /** Cancel pending native scrolling and remove the Inspector-owned overlay. */
  dispose(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame)
    this.frame = undefined
    this.cancelScroll?.()
    if (this.animation !== undefined) {
      this.animation.onfinish = null
      this.animation.cancel()
    }
    this.animation = undefined
    this.overlay?.remove()
    this.overlay = undefined
  }

  private queueFlash(row: HTMLElement, root: HTMLElement, targets: readonly InspectorChatTarget[]): void {
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined
      if (this.getRoot() !== root) { this.dispose(); return }
      if (this.flash(row)) return
      for (const candidate of findChatTargets(root, targets)) {
        if (candidate !== row && this.flash(candidate)) return
      }
      if (row !== root && this.flash(root)) return
      this.dispose()
    })
  }

  private smoothScroll(row: HTMLElement, root: HTMLElement, targets: readonly InspectorChatTarget[]): void {
    const parents = new Set<Element>()
    for (let element = row.parentElement; element !== null; element = element.parentElement) parents.add(element)
    const moving = new Set<Element>()
    let pending = true
    let quiet: number | undefined
    let settledFrame: number | undefined
    const targetOf = (event: Event): Element | undefined => {
      const target = event.target === document ? document.scrollingElement : event.target
      return target instanceof Element && parents.has(target) ? target : undefined
    }
    const cleanup = (): void => {
      pending = false
      window.clearTimeout(quiet)
      if (settledFrame !== undefined) cancelAnimationFrame(settledFrame)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('scrollend', onEnd, true)
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.removeEventListener(type, interrupt, true)
      this.cancelScroll = undefined
    }
    const finish = (): void => {
      if (!pending) return
      cleanup()
      this.queueFlash(row, root, targets)
    }
    const awaitQuiet = (): void => {
      window.clearTimeout(quiet)
      // A no-op scroll and browsers without scrollend still release the observation.
      quiet = window.setTimeout(finish, SCROLL_QUIET_MS)
    }
    const onScroll = (event: Event): void => {
      const target = targetOf(event)
      if (target === undefined) return
      moving.add(target)
      awaitQuiet()
    }
    const onEnd = (event: Event): void => {
      const target = targetOf(event)
      if (target === undefined || !moving.delete(target) || moving.size > 0 || settledFrame !== undefined) return
      settledFrame = requestAnimationFrame(() => {
        settledFrame = undefined
        if (moving.size === 0) finish()
      })
    }
    const cancel = (): void => {
      if (!pending) return
      cleanup()
      for (const element of parents) {
        if (element.isConnected && (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth)) {
          element.scrollTo({ top: element.scrollTop, left: element.scrollLeft, behavior: 'instant' })
        }
      }
    }
    const interrupt = (event: Event): void => {
      if (event instanceof KeyboardEvent && !SCROLL_KEYS.has(event.key)) return
      cancel()
      this.dispose()
    }
    this.cancelScroll = cancel
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('scrollend', onEnd, { capture: true, passive: true })
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      window.addEventListener(type, interrupt, { capture: true, passive: true })
    }
    awaitQuiet()
    row.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  }

  private flash(row: HTMLElement): boolean {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { this.dispose(); return true }
    if (!displayed(row)) return false
    const overlay = document.createElement('div')
    if (!placeChatHighlight(overlay, row)) return false
    // oxlint-disable-next-line typescript/no-non-null-assertion -- This class is declared in the imported CSS Module.
    overlay.className = css.chatReveal!
    overlay.dataset.sessionInspectorHighlight = 'reveal'
    overlay.setAttribute('aria-hidden', 'true')
    document.body.append(overlay)
    this.overlay = overlay
    const animation = overlay.animate([{ opacity: 0.65 }, { opacity: 0.1 }, { opacity: 0.5 }, { opacity: 0 }], { duration: 700 })
    this.animation = animation
    animation.onfinish = () => { if (this.animation === animation) this.dispose() }
    return true
  }
}
