/** Accessible menu groups with shared sticky-heading presentation and viewport observation. */
import { useId, type ReactNode } from 'react'
import css from './MenuGroup.module.css'

/**
 * Render a named group with an instance-owned heading id and an inaccessible position sentinel.
 * @param props - Caller-localized label and optional menu rows.
 * @returns A section named by its direct heading, followed by the supplied children.
 */
export function MenuGroup({ label, children }: { label: string; children?: ReactNode }) {
  const headingId = useId()
  return (
    <section role="group" aria-labelledby={headingId} data-menu-group="" className={css.group}>
      <span aria-hidden="true" data-menu-group-start="" className={css.start} />
      <div id={headingId} data-menu-group-heading="" className={css.heading}>{label}</div>
      {children}
    </section>
  )
}

/**
 * Update heading backgrounds asynchronously from native intersection and viewport-size observations.
 * Headings remain transparent until observations identify a section crossing the viewport top.
 * Without IntersectionObserver or ResizeObserver, CSS sticky headings remain transparent.
 * Group membership is captured at setup; dispose before observing changed groups or the same viewport again.
 * @param viewport - Unpadded, borderless scroll container with direct MenuGroup children.
 * @returns Cleanup owning both intersection observers and the viewport resize observer; disconnects
 * them, ignores queued callbacks, and clears managed data-stuck attributes. No valid groups acquires nothing.
 */
export function observeStickyMenuGroups(viewport: HTMLElement): () => void {
  const groups = [...viewport.querySelectorAll<HTMLElement>(':scope > [data-menu-group]')].flatMap((section) => {
    const heading = section.querySelector<HTMLElement>(':scope > [data-menu-group-heading]')
    const start = section.querySelector<HTMLElement>(':scope > [data-menu-group-start]')
    return heading === null || start === null ? [] : [{
      section, heading, start, atTop: false, above: false, topTime: -Infinity, aboveTime: -Infinity,
    }]
  })
  if (groups.length === 0 || typeof IntersectionObserver === 'undefined' || typeof ResizeObserver === 'undefined') {
    return () => {}
  }

  const sections = new Map<Element, typeof groups[number]>(groups.map(group => [group.section, group]))
  const starts = new Map<Element, typeof groups[number]>(groups.map(group => [group.start, group]))
  let disposed = false
  let stripObserver: IntersectionObserver | undefined
  let viewportHeight: number | undefined
  const render = (group: typeof groups[number]): void => {
    const stuck = group.atTop && group.above
    if (group.heading.hasAttribute('data-stuck') !== stuck) group.heading.toggleAttribute('data-stuck', stuck)
  }
  const startObserver = new IntersectionObserver((entries) => {
    if (disposed) return
    for (const entry of entries) {
      const group = starts.get(entry.target)
      if (!group || entry.rootBounds === null || entry.time < group.aboveTime) continue
      group.above = entry.boundingClientRect.top < entry.rootBounds.top
      group.aboveTime = entry.time
      render(group)
    }
  }, { root: viewport, threshold: [0, 1] })
  for (const { start } of groups) startObserver.observe(start)

  const sizeObserver = new ResizeObserver((entries) => {
    if (disposed) return
    for (const entry of entries) {
      if (entry.target !== viewport || entry.contentRect.height === viewportHeight) continue
      viewportHeight = entry.contentRect.height
      stripObserver?.disconnect()
      // A full section crossing this strip is observable even when scrolling skips its start sentinel.
      const observer = new IntersectionObserver((intersections) => {
        if (disposed || stripObserver !== observer) return
        for (const intersection of intersections) {
          const group = sections.get(intersection.target)
          if (!group || intersection.rootBounds === null) continue
          const top = intersection.rootBounds.top
          if (intersection.time >= group.topTime) {
            group.atTop = intersection.isIntersecting && intersection.boundingClientRect.bottom > top
            group.topTime = intersection.time
          }
          // Both observers describe the section's normal-flow start; the newest sample wins.
          if (intersection.time >= group.aboveTime) {
            group.above = intersection.boundingClientRect.top < top
            group.aboveTime = intersection.time
          }
          render(group)
        }
      }, { root: viewport, rootMargin: `0px 0px ${Math.min(1, viewportHeight) - viewportHeight}px 0px`, threshold: 0 })
      stripObserver = observer
      for (const { section } of groups) observer.observe(section)
    }
  })
  sizeObserver.observe(viewport)
  return () => {
    if (disposed) return
    disposed = true
    startObserver.disconnect()
    stripObserver?.disconnect()
    sizeObserver.disconnect()
    for (const { heading } of groups) {
      if (heading.hasAttribute('data-stuck')) heading.removeAttribute('data-stuck')
    }
  }
}
