/** Shared modal, focus, and pan/zoom controls for documentation images and diagrams. */
import Panzoom from '@panzoom/panzoom'

const messages = {
  en: {
    zoomIn: 'Zoom in', zoomOut: 'Zoom out', fit: 'Fit view', original: 'Original size (100%), currently {scale}',
    close: 'Close', helpLabel: 'Viewer help',
    help: 'Scroll or pinch to zoom · Drag or use arrow keys to pan · Esc to close',
  },
  zh: {
    zoomIn: '放大', zoomOut: '缩小', fit: '适应窗口', original: '原始尺寸（100%），当前{scale}',
    close: '关闭', helpLabel: '查看器帮助',
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

/**
 * Set the accessible name and hover hint of a viewer control.
 * @param element Button to label.
 * @param label Localized control name.
 */
export function labelButton(element: HTMLButtonElement, label: string): void {
  element.setAttribute('aria-label', label)
  element.title = label
}

/**
 * Create a viewer control with a decorative SVG icon.
 * @param doc Document that owns the control.
 * @param label Localized control name.
 * @param icon Viewer icon to display.
 * @returns A native button ready for its click handler.
 */
export function viewerButton(doc: Document, label: string, icon: keyof typeof icons): HTMLButtonElement {
  const element = doc.createElement('button')
  element.type = 'button'
  labelButton(element, label)
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.classList.add('dsh-media-icon')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const path = doc.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', icons[icon])
  svg.append(path)
  element.append(svg)
  return element
}

/** Detached content with intrinsic dimensions in CSS pixels; the viewer owns its lifetime. */
interface MediaContent {
  element: HTMLElement | SVGSVGElement
  width: number
  height: number
  title: string
  originalSize?: boolean
}

/** Owns at most one modal and restores page scrolling and trigger focus when it closes. */
export class MediaViewer {
  #close: (() => void) | undefined

  /**
   * @param doc Browser document containing the viewer's triggers.
   * @param language Current VitePress language, read when opening the modal.
   */
  constructor(private readonly doc: Document, private readonly language: () => string) {}

  /** Close the active modal and release its observers, listeners, and scroll lock. */
  close(): void {
    this.#close?.()
  }

  /**
   * Open content at a scale that fits the viewport, closing any previous modal.
   * @param content Detached image or SVG and its display metadata.
   * @param trigger Connected control to focus after the modal closes.
   * @param onClose Notify the adapter once after releasing the modal, including setup failure.
   * @returns Idempotent closer for this modal only.
   */
  open(content: MediaContent, trigger: HTMLElement, onClose: () => void): () => void {
    this.close()
    const doc = this.doc
    const copy = this.language().startsWith('zh') ? messages.zh : messages.en
    const dialog = doc.createElement('dialog')
    dialog.className = 'dsh-media-viewer'
    dialog.setAttribute('aria-labelledby', 'dsh-media-title')
    const toolbar = doc.createElement('div')
    toolbar.className = 'dsh-media-toolbar'
    const title = doc.createElement('span')
    title.className = 'dsh-media-title'
    title.id = 'dsh-media-title'
    title.textContent = content.title
    const zoomOut = viewerButton(doc, copy.zoomOut, 'zoomOut')
    const zoomIn = viewerButton(doc, copy.zoomIn, 'zoomIn')
    const original = content.originalSize ? doc.createElement('button') : undefined
    if (original) original.type = 'button'
    const scaleLabel = original ?? doc.createElement('span')
    scaleLabel.className = 'dsh-media-scale'
    const fit = viewerButton(doc, copy.fit, 'fit')
    fit.className = 'dsh-media-fit'
    const close = viewerButton(doc, copy.close, 'close')
    close.className = 'dsh-media-close'
    close.autofocus = true
    toolbar.append(zoomOut, scaleLabel, zoomIn, fit)
    const helpToggle = viewerButton(doc, copy.helpLabel, 'help')
    helpToggle.className = 'dsh-media-help-toggle'
    helpToggle.setAttribute('aria-expanded', 'false')
    helpToggle.setAttribute('aria-controls', 'dsh-media-help-text')
    const help = doc.createElement('p')
    help.className = 'dsh-media-help'
    help.id = 'dsh-media-help-text'
    help.hidden = true
    help.textContent = copy.help
    const viewport = doc.createElement('div')
    viewport.className = 'dsh-media-viewport'
    const paper = doc.createElement('div')
    paper.className = 'dsh-media-paper'
    // Shared content lives in a shadow root so Mermaid copies cannot resolve their
    // embedded styles and fragment IDs against the original diagram.
    const shadow = paper.attachShadow({ mode: 'open' })
    const clone = content.element
    Object.assign(clone.style, {
      position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
      width: `${content.width}px`, height: `${content.height}px`, maxWidth: 'none', display: 'block',
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
    const cleanup = (): void => {
      if (closed) return
      closed = true
      listeners.abort()
      resize?.disconnect()
      panzoom?.destroy()
      dialog.close()
      dialog.remove()
      doc.body.style.overflow = overflow
      if (trigger.isConnected) trigger.focus({ preventScroll: true })
      this.#close = undefined
      onClose()
    }
    this.#close = cleanup
    try {
      dialog.showModal()
      doc.body.style.overflow = 'hidden'
      const fitScale = (): number => Math.min(
        1, Math.max(1, viewport.clientWidth - 32) / content.width,
        Math.max(1, viewport.clientHeight - 32) / content.height,
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
      const updateScale = (): void => {
        const scale = `${Math.round(controller.getScale() * 100)}%`
        scaleLabel.textContent = scale
        if (original) labelButton(original, copy.original.replace('{scale}', scale))
      }
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
      original?.addEventListener('click', () => {
        controller.zoom(1, { animate: false })
        controller.pan(0, 0, { animate: false })
      }, options)
      viewport.addEventListener('wheel', event => controller.zoomWithWheel(event), { ...options, passive: false })
      dialog.addEventListener('keydown', (event) => {
        if (event.key === 'Tab') {
          const controls = [close, zoomOut, ...(original ? [original] : []), zoomIn, fit, helpToggle]
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
}
