/** Independent bottom-follow intent and native scrolling, without paging or DOM observers. */
import { useState } from 'react'

/** Scroll position, maximum top, and viewport height from one geometry read. */
export interface ViewportMetrics {
  readonly top: number
  readonly floor: number
  readonly height: number
}

/**
 * Read one scrollport without measuring its children.
 * @param element - scrolling element.
 * @returns current position and range.
 */
export function scrollMetrics(element: HTMLElement): ViewportMetrics {
  const height = element.clientHeight
  return { top: element.scrollTop, height, floor: Math.max(0, element.scrollHeight - height) }
}

/** One scrollport's follow intent; native animation progress does not count as reader movement. */
export class ScrollFollow {
  private static readonly owners = new WeakMap<HTMLElement, ScrollFollow>()
  private target: number | null = null
  private sampledTop: number | undefined

  /**
   * @param following - initial follow intent.
   * @param threshold - accepted distance from the floor, in pixels.
   */
  constructor(private following: boolean, private readonly threshold: number) {}

  /**
   * Find the mounted controller for reading-position compensation.
   * @param element - scrollport with an optional follow owner.
   * @returns its controller, when bound.
   */
  static forElement(element: HTMLElement): ScrollFollow | undefined { return this.owners.get(element) }

  /**
   * Share this controller with reading-position compensation for the same scrollport.
   * @param element - owned scrollport.
   * @returns release the association on unmount or close.
   */
  bind(element: HTMLElement): () => void {
    ScrollFollow.owners.set(element, this)
    return () => { if (ScrollFollow.owners.get(element) === this) ScrollFollow.owners.delete(element) }
  }

  /**
   * Expose follow intent independently of the current offset.
   * @returns whether content growth should follow the floor.
   */
  get active(): boolean { return this.following }

  /**
   * Expose outstanding native motion before accepting reader input.
   * @returns whether a native follow animation has an outstanding target.
   */
  get animating(): boolean { return this.target !== null }

  /**
   * Classify bottom arrivals using this scrollport's own tolerance.
   * @param metrics - current scroll geometry.
   * @returns whether the position is within the follow threshold.
   */
  nearBottom(metrics: ViewportMetrics): boolean { return metrics.floor - metrics.top <= this.threshold }

  /**
   * Commit caller-owned follow decisions without moving the scrollport.
   * @param active - externally committed follow intent.
   */
  setFollowing(active: boolean): void {
    this.following = active
    if (!active) this.target = null
  }

  /** Adopt the next visible layout as a fresh reader position. */
  reset(): void {
    this.setFollowing(false)
    this.sampledTop = undefined
  }

  /**
   * Adopt delivered scrolling while retaining intent during native animation.
   * @param metrics - current geometry.
   * @param movedByReader - caller attribution; omitted callers compare the last sampled position.
   * @returns updated follow intent.
   */
  sample(metrics: ViewportMetrics, movedByReader = this.sampledTop === undefined
    || Math.abs(metrics.top - this.sampledTop) > 0.5): boolean {
    this.sampledTop = metrics.top
    if (!this.animating && movedByReader) this.following = this.nearBottom(metrics)
    return this.active
  }

  /**
   * Settle native scrolling; an off-target stop releases follow intent.
   * @param metrics - actual geometry delivered at scrollend.
   * @returns follow intent after completing or interrupting native motion.
   */
  settle(metrics: ViewportMetrics): boolean {
    const target = this.target
    this.target = null
    return this.sample(metrics, target === null ? undefined
      : Math.abs(metrics.top - Math.min(target, metrics.floor)) > this.threshold)
  }

  /**
   * Position immediately and adopt the resulting follow intent.
   * @param element - scrolling element.
   * @param metrics - geometry before positioning.
   * @param top - requested offset, clamped to the measured range.
   * @returns geometry after positioning.
   */
  jump(element: HTMLElement, metrics: ViewportMetrics, top: number): ViewportMetrics {
    const animated = this.animating
    this.target = null
    const target = Math.max(0, Math.min(metrics.floor, top))
    if (animated) element.scrollTo({ top: target, behavior: 'instant' })
    else if (target !== metrics.top) element.scrollTop = target
    const landed = { ...metrics, top: element.scrollTop }
    this.sampledTop = landed.top
    this.following = this.nearBottom(landed)
    return landed
  }

  /**
   * Follow the measured floor, respecting reduced motion for smooth requests.
   * An outstanding smooth target finishes before another is issued.
   * Within-tolerance positioning is immediate while no animation is outstanding.
   * @param element - scrolling element.
   * @param metrics - current geometry.
   * @param behavior - native animation for growth, or immediate positioning.
   * @returns current geometry; smooth requests retain their starting position until native scroll delivery.
   */
  toBottom(element: HTMLElement, metrics: ViewportMetrics, behavior: 'instant' | 'smooth'): ViewportMetrics {
    this.following = true
    if (behavior === 'instant' || metrics.top >= metrics.floor
      || (!this.animating && this.nearBottom(metrics))) return this.jump(element, metrics, metrics.floor)
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return this.jump(element, metrics, metrics.floor)
    }
    if (this.target === null) {
      this.target = metrics.floor
      element.scrollTo({ top: metrics.floor, behavior: 'smooth' })
    }
    return metrics
  }

  /**
   * Cancel native motion before a reader gesture; only subsequent actual movement changes follow intent.
   * @param element - scrolling element.
   * @param metrics - position at interruption.
   */
  interrupt(element: HTMLElement, metrics: ViewportMetrics): void {
    if (!this.animating) return
    this.target = null
    this.sampledTop = metrics.top
    element.scrollTo({ top: metrics.top, behavior: 'instant' })
  }
}

/**
 * Retain one independent follow controller without React updates for scroll samples.
 * @param initial - initial follow intent.
 * @param threshold - accepted distance from the floor, in pixels.
 * @returns the stable controller shared by the caller's scroll and resize handlers.
 */
export function useScrollFollow(initial: boolean, threshold: number): ScrollFollow {
  const [follow] = useState(() => new ScrollFollow(initial, threshold))
  return follow
}
