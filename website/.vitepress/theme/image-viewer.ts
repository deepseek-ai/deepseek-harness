/** Full-viewport viewing of loaded, standalone content images in documentation pages. */
import { labelButton, type MediaViewer, viewerButton } from './media-viewer.ts'

const messages = {
  en: 'View image fullscreen: {alt}',
  zh: '全屏查看图片：{alt}',
}

interface ImageEntry {
  container: HTMLElement
  button: HTMLButtonElement
  events: AbortController
  source: string
}

/** Enhances standalone image paragraphs without moving or replacing their source images. */
export class ImageViewer {
  readonly #entries = new Map<HTMLImageElement, ImageEntry>()
  readonly #observer: MutationObserver
  readonly #events = new AbortController()
  #active: HTMLImageElement | undefined
  #close: (() => void) | undefined

  /**
   * @param doc Browser document containing VitePress content.
   * @param language Current VitePress language, read again when entries refresh.
   * @param viewer Shared modal owner for images and diagrams.
   */
  constructor(
    private readonly doc: Document,
    private readonly language: () => string,
    private readonly viewer: Pick<MediaViewer, 'open'>,
  ) {
    const root = doc.querySelector('#VPContent') ?? doc.body
    const scan = (): void => { this.#scan() }
    this.#observer = new MutationObserver(scan)
    this.#observer.observe(root, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['src', 'srcset', 'alt', 'role', 'aria-hidden', 'data-no-zoom'],
    })
    const options = { capture: true, signal: this.#events.signal }
    root.addEventListener('load', scan, options)
    root.addEventListener('error', scan, options)
    this.#scan()
  }

  /** Close the image view and refresh controls after route, language, or theme changes. */
  refresh(): void {
    this.#closeActive()
    this.#scan()
  }

  /** Remove image enhancements, event handlers, observers, and any active image modal. */
  dispose(): void {
    this.#observer.disconnect()
    this.#events.abort()
    this.#closeActive()
    for (const [image, entry] of this.#entries) this.#remove(image, entry)
  }

  #closeActive(): void {
    this.#close?.()
    this.#close = undefined
    this.#active = undefined
  }

  #remove(image: HTMLImageElement, entry: ImageEntry): void {
    if (image === this.#active) this.#closeActive()
    entry.events.abort()
    entry.button.remove()
    entry.container.classList.remove('dsh-image-container')
    image.classList.remove('dsh-image-zoomable')
    this.#entries.delete(image)
  }

  #scan(): void {
    const images = new Set(Array.from(this.doc.querySelectorAll<HTMLImageElement>('.vp-doc p > img')).filter((image) => {
      const entry = this.#entries.get(image)
      return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0 && image.alt.trim()
        && !image.closest('a, button, .mermaid, [data-no-zoom], [aria-hidden="true"], [role="presentation"], [role="none"]')
        && Array.from(image.parentNode?.childNodes ?? []).every(node => node === image || node === entry?.button
          || (node.nodeType === 3 && !node.textContent?.trim()))
    }))
    for (const [image, entry] of this.#entries) {
      if (!images.has(image) || image.parentElement !== entry.container || !entry.button.isConnected
        || entry.source !== (image.currentSrc || image.src)) {
        this.#remove(image, entry)
      }
    }
    const copy = this.language().startsWith('zh') ? messages.zh : messages.en
    for (const image of images) {
      const label = copy.replace('{alt}', () => image.alt)
      const existing = this.#entries.get(image)
      if (existing) {
        if (existing.button.getAttribute('aria-label') !== label) labelButton(existing.button, label)
        continue
      }
      const container = image.parentElement
      if (!container) continue
      const button = viewerButton(this.doc, label, 'open')
      button.className = 'dsh-image-open'
      button.setAttribute('aria-haspopup', 'dialog')
      const events = new AbortController()
      const open = (): void => {
        this.#closeActive()
        const content = this.doc.createElement('img')
        content.src = image.currentSrc || image.src
        content.alt = image.alt
        content.draggable = false
        this.#close = this.viewer.open({
          element: content, width: image.naturalWidth, height: image.naturalHeight,
          title: image.alt, originalSize: true,
        }, button, () => {
          this.#close = undefined
          this.#active = undefined
        })
        this.#active = image
      }
      button.addEventListener('click', open, { signal: events.signal })
      image.addEventListener('click', open, { signal: events.signal })
      container.classList.add('dsh-image-container')
      image.classList.add('dsh-image-zoomable')
      container.append(button)
      this.#entries.set(image, { container, button, events, source: image.currentSrc || image.src })
    }
  }
}
