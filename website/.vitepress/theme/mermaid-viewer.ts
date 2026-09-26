/** Full-viewport viewing of asynchronously rendered documentation diagrams. */
import { labelButton, type MediaViewer, viewerButton } from './media-viewer.ts'

const messages = {
  en: { open: 'View diagram fullscreen', title: 'Diagram viewer' },
  zh: { open: '全屏查看图表', title: '图表查看器' },
}

/** Theme-owned resources; source SVG replacement automatically closes the current view. */
export interface MermaidViewer {
  /** Close the view and update entries after a route, language, or theme change. */
  refresh(): void
  /** Remove entries, observers, listeners, the dialog, and the page scroll lock. */
  dispose(): void
}

function dimensions(svg: SVGSVGElement): { width: number; height: number } | undefined {
  const { width, height } = svg.viewBox.baseVal
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    return { width, height }
  }
  return undefined
}

/**
 * Enhance rendered Mermaid SVGs without modifying the canonical Markdown or renderer.
 * @param doc Browser document containing VitePress content.
 * @param language Current VitePress language, read again when entries refresh.
 * @param viewer Shared modal owner for images and diagrams.
 * @returns Resources owned by the mounted theme.
 */
export function installMermaidViewer(
  doc: Document, language: () => string, viewer: Pick<MediaViewer, 'open'>,
): MermaidViewer {
  const entries = new Map<Element, { svg: SVGSVGElement; button: HTMLButtonElement }>()
  let active: SVGSVGElement | undefined
  let close: (() => void) | undefined
  const closeActive = (): void => {
    close?.()
    close = undefined
    active = undefined
  }
  const scan = (): void => {
    const copy = language().startsWith('zh') ? messages.zh : messages.en
    const containers = new Set(doc.querySelectorAll('.vp-doc .mermaid'))
    for (const [container, entry] of entries) {
      if (!containers.has(container) || container.querySelector('svg:not(.dsh-media-icon)') !== entry.svg || !entry.button.isConnected) {
        if (entry.svg === active) closeActive()
        entry.button.remove()
        entries.delete(container)
      }
    }
    for (const container of containers) {
      const existing = entries.get(container)
      if (existing) {
        if (existing.button.getAttribute('aria-label') !== copy.open) labelButton(existing.button, copy.open)
        continue
      }
      const svg = container.querySelector<SVGSVGElement>('svg:not(.dsh-media-icon)')
      if (!svg || !dimensions(svg)) continue
      const trigger = viewerButton(doc, copy.open, 'open')
      trigger.className = 'dsh-diagram-open'
      trigger.setAttribute('aria-haspopup', 'dialog')
      trigger.addEventListener('click', () => {
        closeActive()
        const size = dimensions(svg)
        if (!size) return
        const copy = language().startsWith('zh') ? messages.zh : messages.en
        close = viewer.open({
          element: svg.cloneNode(true) as SVGSVGElement,
          ...size,
          title: doc.querySelector('.vp-doc h1')?.textContent.trim() || copy.title,
        }, trigger, () => {
          close = undefined
          active = undefined
        })
        active = svg
      })
      container.prepend(trigger)
      entries.set(container, { svg, button: trigger })
    }
  }
  const observer = new MutationObserver(scan)
  observer.observe(doc.querySelector('#VPContent') ?? doc.body, { childList: true, subtree: true })
  scan()
  return {
    refresh() {
      closeActive()
      scan()
    },
    dispose() {
      observer.disconnect()
      closeActive()
      for (const entry of entries.values()) entry.button.remove()
      entries.clear()
    },
  }
}
