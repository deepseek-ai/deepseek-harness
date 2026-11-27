/** Deterministic browser geometry and media primitives for real FF mounts in jsdom. */
import { vi } from 'vitest'
/** Install deterministic layout and media primitives for a real video mount. */
export function mountEnvironment() {
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  const rafs = new Map<number, FrameRequestCallback>(), resizes = new Set<ResizeObserverCallback>()
  let sequence = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { rafs.set(++sequence, callback); return sequence })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { rafs.delete(id) })
  vi.stubGlobal('ResizeObserver', class {
    constructor(readonly callback: ResizeObserverCallback) {}
    observe() { resizes.add(this.callback) }
    disconnect() { resizes.delete(this.callback) }
  })
  vi.stubGlobal('IntersectionObserver', class {
    constructor(readonly callback: (entries: { target: Element; isIntersecting: boolean }[]) => void) {}
    observe(target: Element) { this.callback([{ target, isIntersecting: true }]) }
    disconnect() {}
  })
  vi.stubGlobal('devicePixelRatio', 2)
  const animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
  const bounds = function(this: HTMLElement): DOMRect {
    const scroll = this.closest<HTMLElement>('[data-office-viewport]')
    const width = Number(scroll?.dataset.width ?? 800), height = Number(scroll?.dataset.height ?? 500)
    if (scroll !== null && this.parentElement === scroll) {
      const w = Number.parseFloat(this.style.width) || width, h = Number.parseFloat(this.style.height) || height
      return new DOMRect(Math.max(0, (width - w) / 2) - scroll.scrollLeft, -scroll.scrollTop, w, h)
    }
    return new DOMRect(0, 0, width, height)
  }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(bounds)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function(this: HTMLElement) { return bounds.call(this).width })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function(this: HTMLElement) { return bounds.call(this).height })
  const drawImage = vi.fn(), putImageData = vi.fn()
  const drawing: Partial<CanvasRenderingContext2D> = { drawImage, putImageData, fillStyle: '#fff',
    clearRect: vi.fn(), fillRect: vi.fn(), createImageData: (size: number | ImageData, suppliedHeight?: number) => {
      const width = typeof size === 'number' ? size : size.width
      const height = typeof size === 'number' ? suppliedHeight : size.height
      if (height === undefined) throw new Error('ImageData height is required')
      return { width, height, colorSpace: 'srgb', data: new Uint8ClampedArray(width * height * 4) }
    },
    getImageData: () => ({ width: 1, height: 1, colorSpace: 'srgb', data: new Uint8ClampedArray([255, 255, 255, 255]) }) }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => drawing as CanvasRenderingContext2D)
  const writer = { abort: vi.fn(async () => {}), write: vi.fn(async () => {}), close: vi.fn(async () => {}), releaseLock: vi.fn() }
  vi.stubGlobal('MediaStreamTrackGenerator', class { writable = { getWriter: () => writer }; stop = vi.fn() })
  vi.stubGlobal('MediaStream', function MediaStream() {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  return { drawImage, putImageData, writer,
    restore: () => { if (animations === undefined) Reflect.deleteProperty(Element.prototype, 'getAnimations'); else Object.defineProperty(Element.prototype, 'getAnimations', animations) },
    flush: async () => {
      for (let i = 0; i < 24; i++) {
        const callbacks = [...rafs.values()]; rafs.clear()
        for (const callback of callbacks) callback(i * 16)
        await Promise.resolve(); await Promise.resolve()
      }
    },
    resize: () => { for (const resize of resizes) resize([], {} as ResizeObserver) },
  }
}
