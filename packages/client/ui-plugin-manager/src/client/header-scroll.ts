/** Scroll-linked header geometry keeps both responsive layouts without changing the list's flow height. */

/** Entry-owned measurement callbacks for the plugin page. */
export interface PluginHeaderLayoutFace {
  /** Create one element-ref lifecycle for each mounted page header. */
  createHeaderRef: () => (element: HTMLDivElement | null) => void
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface Part {
  element: HTMLElement
  from: Box
  to: Box
  distance: number
  clipStart?: number
  clipEnd?: number
}

const PARTS = ['title', 'intro', 'toolbar', 'tabs'] as const

/**
 * Measure the existing resting and compact CSS layouts in an inert, out-of-flow copy.
 * Their independent flex wrapping requires pixel measurements; interpolating only positioned
 * contents leaves the real header's resting footprint and the scroll range unchanged.
 * @returns A ref callback that disposes its element observers and scroll listener on detachment.
 */
export function createPluginHeaderRef(): (element: HTMLDivElement | null) => void {
  let dispose: (() => void) | undefined
  return (element) => {
    dispose?.()
    dispose = element === null ? undefined : attach(element)
  }
}

function attach(bar: HTMLDivElement): () => void {
  const body = bar.parentElement as HTMLElement
  const parts: Part[] = []
  let distance = 1
  let restHeight = 0
  let compactHeight = 0
  let disposed = false

  const scroll = (): void => {
    const offset = Math.max(0, body.scrollTop)
    bar.toggleAttribute('data-compact', offset >= distance)
    bar.toggleAttribute('data-scrolled', offset > 0)
    for (const part of parts) {
      const progress = Math.min(1, offset / part.distance)
      part.element.style.translate = `${(part.to.x - part.from.x) * progress}px ${(part.to.y - part.from.y) * progress}px`
      part.element.style.width = `${part.from.width + (part.to.width - part.from.width) * progress}px`
      if (part.clipStart !== undefined && part.clipEnd !== undefined) {
        const clip = Math.max(0, Math.min(1, (offset - part.clipStart) / (part.clipEnd - part.clipStart)))
        part.element.style.clipPath = `inset(${clip * 100}% 0 0)`
      } else {
        part.element.style.removeProperty('clip-path')
      }
      if (part.element.dataset.pluginHeaderPart === 'intro') {
        part.element.inert = offset >= (part.clipEnd ?? part.distance)
      }
    }
    bar.style.setProperty('--plugin-header-paint-height', `${Math.max(compactHeight, restHeight - offset)}px`)
  }

  const measure = (): void => {
    if (disposed) return
    body.style.setProperty('--plugin-page-scrollbar-width', `${body.offsetWidth - body.clientWidth}px`)
    const clone = bar.cloneNode(true) as HTMLDivElement
    clone.removeAttribute('data-natural')
    clone.removeAttribute('data-compact')
    clone.removeAttribute('data-scrolled')
    clone.setAttribute('data-measuring', '')
    clone.setAttribute('aria-hidden', 'true')
    clone.inert = true
    clone.style.width = `${bar.getBoundingClientRect().width}px`
    for (const element of clone.querySelectorAll<HTMLElement>('[id], [data-plugin-header-part]')) {
      element.removeAttribute('id')
      if (element.hasAttribute('data-plugin-header-part')) element.removeAttribute('style')
    }
    body.append(clone)
    const snapshot = (): { height: number; boxes: Map<string, Box> } => {
      const head = (clone.querySelector('header') as HTMLElement).getBoundingClientRect()
      const boxes = new Map<string, Box>()
      for (const name of PARTS) {
        const element = clone.querySelector<HTMLElement>(`[data-plugin-header-part="${name}"]`)
        if (element === null) continue
        const box = element.getBoundingClientRect()
        boxes.set(name, { x: box.x - head.x, y: box.y - head.y, width: box.width, height: box.height })
      }
      return { height: clone.getBoundingClientRect().height, boxes }
    }
    let resting: ReturnType<typeof snapshot>
    let compact: ReturnType<typeof snapshot>
    try {
      resting = snapshot()
      clone.setAttribute('data-compact', '')
      compact = snapshot()
    } finally {
      clone.remove()
    }
    restHeight = resting.height
    compactHeight = compact.height
    distance = Math.max(1, restHeight - compactHeight)
    parts.length = 0
    const hasTabs = resting.boxes.has('tabs')
    const compactTitle = compact.boxes.get('title') as Box
    for (const name of PARTS) {
      const from = resting.boxes.get(name)
      if (from === undefined) continue
      const element = bar.querySelector(`[data-plugin-header-part="${name}"]`) as HTMLElement
      let to = compact.boxes.get(name) as Box
      let clipStart: number | undefined
      let clipEnd: number | undefined
      if (name === 'intro' || (name === 'title' && hasTabs)) {
        to = { ...from, y: -from.height }
        if (name === 'intro' && !hasTabs) {
          clipStart = Math.max(0, from.y - compactTitle.y - compactTitle.height)
          clipEnd = clipStart + from.height
          to.y = from.y - clipEnd
        }
      }
      const travel = Math.max(1, Math.abs(to.y - from.y))
      distance = Math.max(distance, travel)
      element.style.setProperty('--plugin-part-x', `${from.x}px`)
      element.style.setProperty('--plugin-part-y', `${from.y}px`)
      element.style.setProperty('--plugin-part-width', `${from.width}px`)
      parts.push({
        element, from, to, distance: travel,
        ...clipStart !== undefined && clipEnd !== undefined ? { clipStart, clipEnd } : {},
      })
    }
    bar.style.setProperty('--plugin-header-rest-height', `${restHeight}px`)
    bar.style.setProperty('--plugin-header-compact-height', `${compactHeight}px`)
    bar.style.setProperty('--plugin-header-travel', `${distance}px`)
    body.style.setProperty('--plugin-header-scroll-padding', `${compactHeight + 8}px`)
    bar.setAttribute('data-natural', '')
    scroll()
  }

  measure()
  const resize = new ResizeObserver(measure)
  resize.observe(body)
  const mutation = new MutationObserver(measure)
  mutation.observe(bar.querySelector('header') as HTMLElement, {
    childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden'],
  })
  body.addEventListener('scroll', scroll, { passive: true })
  document.fonts.addEventListener('loadingdone', measure)
  return () => {
    disposed = true
    resize.disconnect()
    mutation.disconnect()
    body.removeEventListener('scroll', scroll)
    document.fonts.removeEventListener('loadingdone', measure)
    body.style.removeProperty('--plugin-header-scroll-padding')
    body.style.removeProperty('--plugin-page-scrollbar-width')
  }
}
