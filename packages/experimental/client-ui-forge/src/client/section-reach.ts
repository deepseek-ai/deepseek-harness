/**
 * Reach of the changes view's file sections: a section's lines mount once the
 * section first comes within a margin of the files scrollport, and stay
 * mounted, so long diffs draw only what the reader approaches.
 */

/** Distance beyond the scrollport's edges within which a section counts as reached. */
const REACH_MARGIN = '1200px 0px'

const noop = (): void => {}

/**
 * Watches the file sections of one changes view against its scrollport. Without
 * `IntersectionObserver` every section is reached at once.
 */
export class SectionReach {
  private observer: IntersectionObserver | undefined
  private readonly waiting = new Map<Element, () => void>()

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
