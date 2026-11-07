/**
 * Reach of the changes view's file sections: a section's lines mount once the
 * section first comes within a margin of the files scrollport, and stay
 * mounted, so long diffs draw only what the reader approaches.
 */

import { createContext } from 'react'

/** Distance beyond the scrollport's edges within which a section counts as reached. */
const REACH_MARGIN = '1200px 0px'

/** Time, in milliseconds, the scrollport stays still before deferred highlighting runs. */
const SCROLL_QUIET_MS = 200

const noop = (): void => {}

/**
 * Watches the file sections of one changes view against its scrollport. Without
 * `IntersectionObserver` every section is reached at once.
 */
export class SectionReach {
  private observer: IntersectionObserver | undefined
  private readonly waiting = new Map<Element, () => void>()
  private scrolledAt = Number.NEGATIVE_INFINITY

  /** Record that the scrollport scrolled, which holds back work started through {@link whenSettled}. */
  scrolled(): void {
    this.scrolledAt = performance.now()
  }

  /**
   * Run `task` once the page is idle and the scrollport has been still for {@link SCROLL_QUIET_MS}, so work that
   * can wait never interrupts a scroll in progress.
   * @param task - deferrable work; it receives the idle period, or undefined without one.
   * @returns the canceller, which has no effect after `task` ran.
   */
  whenSettled(task: (deadline: IdleDeadline | undefined) => void): () => void {
    let cancel = noop
    const attempt = (deadline: IdleDeadline | undefined): void => {
      const wait = this.scrolledAt + SCROLL_QUIET_MS - performance.now()
      if (wait <= 0) {
        task(deadline)
        return
      }
      const id = setTimeout(() => { cancel = whenIdle(attempt) }, wait)
      cancel = () => { clearTimeout(id) }
    }
    cancel = whenIdle(attempt)
    return () => { cancel() }
  }

  /**
   * Measure sections against `root`, or stop measuring when it unmounts. Sections that are still waiting move to the new root.
   * @param root - the files scrollport, or null.
   */
  attach(root: HTMLElement | null): void {
    this.observer?.disconnect()
    this.observer = undefined
    if (root === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const reached = this.waiting.get(entry.target)
        /* v8 ignore next -- the observer reports only sections still waiting, which it stops watching on release */
        if (reached === undefined) continue
        this.waiting.delete(entry.target)
        observer.unobserve(entry.target)
        reached()
      }
    }, { root, rootMargin: REACH_MARGIN })
    this.observer = observer
    for (const element of this.waiting.keys()) observer.observe(element)
  }

  /**
   * Call `reached` once when `element` comes within reach.
   * @param element - a file section inside the scrollport.
   * @param reached - runs once, from the observer's callback or at once without `IntersectionObserver`.
   * @returns the disposer that stops watching before the section is reached.
   */
  observe(element: Element, reached: () => void): () => void {
    if (typeof IntersectionObserver === 'undefined') {
      reached()
      return noop
    }
    this.waiting.set(element, reached)
    this.observer?.observe(element)
    return () => {
      this.waiting.delete(element)
      this.observer?.unobserve(element)
    }
  }
}

/** The reach of the enclosing changes view; null outside one, where every section counts as reached. */
export const SectionReachContext = createContext<SectionReach | null>(null)

/** Whether the enclosing changes tab is visible and may show temporary menus; true outside one. */
export const ViewVisibleContext = createContext(true)

/** Longest wait, in milliseconds, before deferred highlighting runs although the page stays busy. */
const IDLE_TIMEOUT_MS = 500

/**
 * Run `task` when the page is next idle, or after other queued work where the browser lacks `requestIdleCallback`.
 * @param task - work that may wait for a frame to finish; it receives the idle period, or undefined without one.
 * @returns the canceller, which has no effect after `task` ran.
 */
export function whenIdle(task: (deadline: IdleDeadline | undefined) => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(task, { timeout: IDLE_TIMEOUT_MS })
    return () => { cancelIdleCallback(id) }
  }
  const id = setTimeout(() => { task(undefined) }, 0)
  return () => { clearTimeout(id) }
}
