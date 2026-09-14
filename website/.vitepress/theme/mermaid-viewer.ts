/** Full-viewport viewing of asynchronously rendered documentation diagrams. */
import Panzoom from '@panzoom/panzoom'

const messages = {
  en: {
    open: 'View diagram fullscreen', title: 'Diagram viewer',
    zoomIn: 'Zoom in', zoomOut: 'Zoom out', fit: 'Fit view', close: 'Close', helpLabel: 'Viewer help',
    help: 'Scroll or pinch to zoom · Drag or use arrow keys to pan · Esc to close',
  },
  zh: {
    open: '全屏查看图表', title: '图表查看器',
    zoomIn: '放大', zoomOut: '缩小', fit: '适应窗口', close: '关闭', helpLabel: '查看器帮助',
    help: '滚轮或双指缩放 · 拖动或方向键平移 · Esc 关闭',
  },
} satisfies Record<string, Record<string, string>>

const icons = {
  open: 'M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7',
  zoomIn: 'M5 12h14M12 5v14', zoomOut: 'M5 12h14',
  fit: 'M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5',
  close: 'M6 6l12 12M18 6 6 18',
  help: 'M9.1 8a3 3 0 0 1 5.8 1c0 2-3 2-3 4M12 17v.1',
}

/** Theme-owned resources; source SVG replacement automatically closes the current view. */
export interface MermaidViewer {
  /** Close the view and update entries after a route, language, or theme change. */
  refresh(): void
  /** Remove entries, observers, listeners, the dialog, and the page scroll lock. */
  dispose(): void
}

function labelButton(element: HTMLButtonElement, label: string): void {
  element.setAttribute('aria-label', label)
  element.title = label
}

function button(doc: Document, label: string, icon: keyof typeof icons): HTMLButtonElement {
  const element = doc.createElement('button')
  element.type = 'button'
  labelButton(element, label)
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.classList.add('dsh-diagram-icon')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const path = doc.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', icons[icon])
  svg.append(path)
  element.append(svg)
  return element
}

function dimensions(svg: SVGSVGElement): { width: number; height: number } | undefined {
  const { width, height } = svg.viewBox.baseVal
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    return { width, height }
  }
  return undefined
}

function openDiagram(
  svg: SVGSVGElement, trigger: HTMLButtonElement, copy: typeof messages.en, onClose: () => void,
): () => void {
  const size = dimensions(svg)
  if (!size) return () => {}
  const doc = svg.ownerDocument
  const dialog = doc.createElement('dialog')
  dialog.className = 'dsh-diagram-viewer'
  dialog.setAttribute('aria-labelledby', 'dsh-diagram-title')
  const toolbar = doc.createElement('div')
  toolbar.className = 'dsh-diagram-toolbar'
  const title = doc.createElement('span')
  title.className = 'dsh-diagram-title'
  title.id = 'dsh-diagram-title'
  title.textContent = doc.querySelector('.vp-doc h1')?.textContent.trim() || copy.title
  const zoomOut = button(doc, copy.zoomOut, 'zoomOut')
  const zoomIn = button(doc, copy.zoomIn, 'zoomIn')
  const scaleLabel = doc.createElement('span')
  scaleLabel.className = 'dsh-diagram-scale'
  const fit = button(doc, copy.fit, 'fit')
  fit.className = 'dsh-diagram-fit'
  const close = button(doc, copy.close, 'close')
  close.className = 'dsh-diagram-close'
  close.autofocus = true
  toolbar.append(zoomOut, scaleLabel, zoomIn, fit)
  const helpToggle = button(doc, copy.helpLabel, 'help')
  helpToggle.className = 'dsh-diagram-help-toggle'
  helpToggle.setAttribute('aria-expanded', 'false')
  helpToggle.setAttribute('aria-controls', 'dsh-diagram-help-text')
  const help = doc.createElement('p')
  help.className = 'dsh-diagram-help'
  help.id = 'dsh-diagram-help-text'
  help.hidden = true
  help.textContent = copy.help
  const viewport = doc.createElement('div')
  viewport.className = 'dsh-diagram-viewport'
  const paper = doc.createElement('div')
  paper.className = 'dsh-diagram-paper'
  // Each Mermaid SVG embeds ID-scoped styles and fragment references. A shadow root
  // keeps the enlarged copy's IDs and styles separate from the original diagram.
  const shadow = paper.attachShadow({ mode: 'open' })
  const clone = svg.cloneNode(true) as SVGSVGElement
  Object.assign(clone.style, {
    position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
    width: `${size.width}px`, height: `${size.height}px`, maxWidth: 'none', display: 'block',
  })
  shadow.append(clone)
  viewport.append(paper)
  dialog.append(viewport, title, close, toolbar, helpToggle, help)
  doc.body.append(dialog)

  const overflow = doc.body.style.overflow
  const listeners = new AbortController()
  let panzoom: ReturnType<typeof Panzoom> | undefined
  let resize: ResizeObserver | undefined
  let closed = false
  function cleanup(): void {
    if (closed) return
    closed = true
    listeners.abort()
    resize?.disconnect()
    panzoom?.destroy()
    dialog.close()
    dialog.remove()
    doc.body.style.overflow = overflow
    if (trigger.isConnected) trigger.focus({ preventScroll: true })
    onClose()
  }
  try {
    dialog.showModal()
    doc.body.style.overflow = 'hidden'
    const fitScale = (): number => Math.min(
      1, Math.max(1, viewport.clientWidth - 32) / size.width,
      Math.max(1, viewport.clientHeight - 32) / size.height,
    )
    const controller = Panzoom(paper, {
      canvas: true, startScale: fitScale(), minScale: fitScale() / 2,
      maxScale: 8, animate: false, pinchAndPan: true,
    })
    panzoom = controller
    const refit = (): void => {
      const scale = fitScale()
      controller.setOptions({ minScale: scale / 2 })
      controller.zoom(scale, { animate: false })
      controller.pan(0, 0, { animate: false })
    }
    const options = { signal: listeners.signal }
    const updateScale = (): void => { scaleLabel.textContent = `${Math.round(controller.getScale() * 100)}%` }
    updateScale()
    paper.addEventListener('panzoomchange', updateScale, options)
    helpToggle.addEventListener('click', () => {
      help.hidden = !help.hidden
      helpToggle.setAttribute('aria-expanded', String(!help.hidden))
    }, options)
    close.addEventListener('click', cleanup, options)
    dialog.addEventListener('close', cleanup, options)
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      cleanup()
    }, options)
    zoomIn.addEventListener('click', () => controller.zoomIn({ animate: false }), options)
    zoomOut.addEventListener('click', () => controller.zoomOut({ animate: false }), options)
    fit.addEventListener('click', refit, options)
    viewport.addEventListener('wheel', event => controller.zoomWithWheel(event), { ...options, passive: false })
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        const controls = [close, zoomOut, zoomIn, fit, helpToggle]
        const current = controls.indexOf(doc.activeElement as HTMLButtonElement)
        const next = current < 0 ? (event.shiftKey ? controls.length - 1 : 0)
          : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
        event.preventDefault()
        controls[next]?.focus()
        return
      }
      const distance = 64 / controller.getScale()
      const offsets: Record<string, [number, number]> = {
        ArrowLeft: [distance, 0], ArrowRight: [-distance, 0],
        ArrowUp: [0, distance], ArrowDown: [0, -distance],
      }
      const offset = offsets[event.key]
      if (offset && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        controller.pan(...offset, { relative: true, animate: false })
      }
    }, options)
    resize = new ResizeObserver(refit)
    resize.observe(viewport)
    return cleanup
  } catch (error) {
    cleanup()
    throw error
  }
}

/**
 * Enhance rendered Mermaid SVGs without modifying the canonical Markdown or renderer.
 * @param doc Browser document containing VitePress content.
 * @param language Current VitePress language, read again when entries refresh.
 * @returns Resources owned by the mounted theme.
 */
export function installMermaidViewer(doc: Document, language: () => string): MermaidViewer {
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
      if (!containers.has(container) || container.querySelector('svg:not(.dsh-diagram-icon)') !== entry.svg || !entry.button.isConnected) {
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
      const svg = container.querySelector<SVGSVGElement>('svg:not(.dsh-diagram-icon)')
      if (!svg || !dimensions(svg)) continue
      const trigger = button(doc, copy.open, 'open')
      trigger.className = 'dsh-diagram-open'
      trigger.setAttribute('aria-haspopup', 'dialog')
      trigger.addEventListener('click', () => {
        closeActive()
        close = openDiagram(svg, trigger, language().startsWith('zh') ? messages.zh : messages.en, () => {
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
