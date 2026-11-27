// @vitest-environment jsdom
/** Page completion and cancellation are driven by owned promises, independently of native latency. */
import { afterEach, expect, test, vi } from 'vitest'
import { ProgressivePages, pageOrder, previewPages, visiblePage, type PreviewPage } from '../src/client/progressive.ts'
import type { OfficePagePreviewReply } from '../src/types.ts'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })
type Pixels = Pick<OfficePagePreviewReply, 'width' | 'height' | 'rgba'>
function pixels(width: number, height: number): Pixels { return { width, height, rgba: new Uint8Array(width * height * 4) } }

function fixture(count = 5, bytes = 4096, presentation = false) {
  const callbacks = new Map<number, FrameRequestCallback>()
  let id = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.set(++id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (key: number) => { callbacks.delete(key) })
  const context: Partial<CanvasRenderingContext2D> = { putImageData: vi.fn(),
    createImageData: (size: number | ImageData, suppliedHeight?: number) => {
      const width = typeof size === 'number' ? size : size.width
      const height = typeof size === 'number' ? suppliedHeight : size.height
      if (height === undefined) throw new Error('ImageData height is required')
      return { width, height, colorSpace: 'srgb', data: new Uint8ClampedArray(width * height * 4) }
    } }
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D)
  const layer = document.createElement('div')
  document.body.append(layer)
  const requests: {
    page: PreviewPage
    width: number
    height: number
    resolve: (pixels: Pixels) => void
    reject: (error: Error) => void
  }[] = []
  const pages = Array.from({ length: count }, (_, index) => ({ index, x: 0, y: presentation ? 0 : index * 3000,
    width: 1440, height: 2880, ...presentation ? { part: index } : {} }))
  const ready = vi.fn(), failure = vi.fn()
  const load = (page: PreviewPage, width: number, height: number): Promise<Pixels> => {
    const pending = Promise.withResolvers<Pixels>()
    requests.push({ page, width, height, resolve: pending.resolve, reject: pending.reject })
    return pending.promise
  }
  const cache = new ProgressivePages(layer, pages, bytes, load, ready, failure)
  const tick = (): void => {
    const next = [...callbacks.values()]; callbacks.clear()
    for (const callback of next) callback(0)
  }
  const complete = async (): Promise<void> => {
    const request = requests.at(-1)!
    request.resolve(pixels(request.width, request.height))
    await vi.waitFor(() => { expect(ready).toHaveBeenCalledWith(request.page.index) })
  }
  return { cache, layer, requests, ready, failure, callbacks, tick, complete, getContext }
}

test('reload priorities alternate below and above the saved page, including document edges', () => {
  expect(pageOrder(6, 3)).toEqual([3, 4, 2, 5, 1, 0])
  expect(pageOrder(4, 0)).toEqual([0, 1, 2, 3])
  expect(pageOrder(4, 20)).toEqual([3, 2, 1, 0])
  expect(pageOrder(0, 0)).toEqual([])
  const pages = previewPages({ renderBackend: 'ganesh', documentType: 'text', width: 100, height: 220, rectangles: '0,0,100,100;0,120,100,100', part: 0, parts: [] })
  expect(visiblePage(pages, 130, 0)).toBe(1)
  expect(visiblePage(pages, 0, 0)).toBe(0)
})

test('a page cache smaller than one pixel per page rejects before requesting native paint', () => {
  expect(() => fixture(2, 4)).toThrow('Office page previews exceed the configured cache budget')
})

test('a disposed cache does not restart rendering on a late viewport notification', async () => {
  const f = fixture()
  await f.cache.dispose()
  f.cache.viewport(0, 1, 0)
  f.tick()
  expect(f.requests).toHaveLength(0)
  expect(f.callbacks.size).toBe(0)
})

test('one completed page becomes visible while later pages remain queued; all canvases stay within the byte budget', async () => {
  const f = fixture()
  try {
    f.cache.viewport(2, 1, 0); f.tick()
    expect(f.requests.map(request => request.page.index)).toEqual([2])
    expect(f.layer.children).toHaveLength(0)
    await f.complete()
    expect(f.layer.children).toHaveLength(1)
    expect(f.ready.mock.calls).toEqual([[2]])
    for (let i = 1; i < 5; i++) { f.tick(); await f.complete() }
    expect(f.requests.map(request => request.page.index)).toEqual([2, 3, 1, 4, 0])
    expect([...f.layer.querySelectorAll('canvas')].reduce((sum, canvas) => sum + canvas.width * canvas.height * 4, 0)).toBeLessThanOrEqual(4096)
    f.cache.viewport(4, 1.5, 0); f.tick()
    expect(f.requests).toHaveLength(5)
    expect(f.layer.querySelector<HTMLCanvasElement>('[data-office-page-preview="4"]')?.style.top).toBe('1200px')
    expect(f.failure).not.toHaveBeenCalled()
  } finally { await f.cache.dispose() }
})

test('scrolling reprioritizes unsent pages, and pausing joins the accepted page before playback', async () => {
  const f = fixture()
  try {
    f.cache.viewport(0, 1, 0); f.tick()
    f.cache.viewport(4, 1, 0)
    await f.complete(); f.tick()
    expect(f.requests.map(request => request.page.index)).toEqual([0, 4])
    let settled = false
    const paused = f.cache.pause().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await f.complete(); await paused
    f.tick()
    expect(f.requests).toHaveLength(2)
    f.cache.viewport(4, 1, 0); f.tick(); await f.complete()
    expect(f.requests.at(-1)?.page.index).toBe(3)
  } finally { await f.cache.dispose() }
})

test('closing ignores a late RGBA reply without drawing or publishing its page or scheduling another request', async () => {
  const f = fixture()
  f.cache.viewport(0, 1, 0); f.tick()
  let settled = false
  const closing = f.cache.dispose().then(() => { settled = true })
  await Promise.resolve(); expect(settled).toBe(false)
  f.requests[0]!.resolve(pixels(1, 1))
  await closing
  expect(f.getContext).not.toHaveBeenCalled()
  expect(f.ready).not.toHaveBeenCalled()
  expect(f.layer.children).toHaveLength(0)
  expect(f.callbacks.size).toBe(0)
})

test('a failed background page stops the queue and reports the failure', async () => {
  const f = fixture()
  try {
    f.cache.viewport(0, 1, 0); f.tick()
    f.requests[0]!.reject(new Error('engine stopped'))
    await vi.waitFor(() => { expect(f.failure).toHaveBeenCalledWith(new Error('engine stopped')) })
    f.tick(); expect(f.requests).toHaveLength(1)
  } finally { await f.cache.dispose() }
})

test('a hidden page cancellation cannot fail a resumed preview or drop its completed pages', async () => {
  const f = fixture(2)
  try {
    f.cache.viewport(0, 1, 0); await f.complete()
    const first = f.layer.firstElementChild
    f.tick()
    expect(f.requests).toHaveLength(2)
    const paused = f.cache.pause()
    f.cache.viewport(1, 1, 0)
    f.requests[1]!.reject(new Error('hidden viewport discarded'))
    await paused
    expect(f.failure).not.toHaveBeenCalled()
    expect(f.layer.firstElementChild).toBe(first)
    f.tick(); expect(f.requests).toHaveLength(3)
    await f.complete()
    expect(f.layer.children).toHaveLength(2)
    expect(f.layer.firstElementChild).toBe(first)
  } finally { await f.cache.dispose() }
})

test('a refresh admitted before pause cannot begin a page request after the view stops', async () => {
  const f = fixture()
  try {
    f.cache.viewport(0, 1, 0)
    await f.complete()
    const admitted = [...f.callbacks.values()][0]!
    await f.cache.pause()
    admitted(0)
    await Promise.resolve()
    expect(f.requests).toHaveLength(1)
  } finally { await f.cache.dispose() }
})

test.each([false, true])('unchanged preview styles and hidden attributes survive 30 scroll frames (hole=%s)', async (withHole) => {
  const f = fixture(3), observer = new MutationObserver(() => {})
  try {
    f.cache.viewport(0, 1, 0)
    for (let page = 0; page < 3; page++) { await f.complete(); f.tick() }
    const displayed = withHole ? { x: 100, y: 750, width: 1000, height: 800 } : undefined
    f.cache.content(displayed, { x: 0, y: 0, width: 1440, height: 2880 })
    const canvases = [...f.layer.querySelectorAll('canvas')]
    const styles = canvases.map(canvas => canvas.style.cssText)
    observer.observe(f.layer, { attributes: true, subtree: true, attributeFilter: ['style', 'hidden'] })
    for (let frame = 1; frame <= 30; frame++) {
      f.cache.content(displayed && { ...displayed }, { x: 0, y: frame * 5, width: 1440, height: 2880 })
      f.cache.viewport(0, 1, 0)
      f.tick()
    }
    expect(observer.takeRecords()).toHaveLength(0)
    expect(canvases.map(canvas => canvas.style.cssText)).toEqual(styles)
    f.cache.viewport(0, 2, 0)
    const resized = observer.takeRecords()
    for (const canvas of canvases) {
      expect(resized.filter(record => record.target === canvas && record.attributeName === 'style')).toHaveLength(1)
      expect(canvas.style.width).toBe('192px')
      expect(canvas.hidden).toBe(false)
    }
    expect(canvases[0]!.style.clipPath).toBe(withHole
      ? 'path(evenodd, "M0 0H192V384H0Z M13.333333333333334 100H146.66666666666666V206.66666666666666H13.333333333333334Z")' : '')
    f.cache.viewport(0, 2, 0)
    expect(observer.takeRecords()).toHaveLength(0)
  } finally { observer.disconnect(); await f.cache.dispose() }
})

test('slide visibility mutates only on part changes, including a return to the previous slide', async () => {
  const f = fixture(2, 4096, true), observer = new MutationObserver(() => {})
  try {
    f.cache.viewport(0, 1, 0, false)
    expect(f.requests).toHaveLength(0)
    f.cache.viewport(0, 1, 0, true); await f.complete(); f.tick()
    expect(f.requests).toHaveLength(1)
    f.cache.viewport(1, 1, 1, true); await f.complete()
    f.cache.viewport(0, 1, 0)
    const canvases = [...f.layer.querySelectorAll('canvas')]
    expect(canvases.map(canvas => canvas.hidden)).toEqual([false, true])
    observer.observe(f.layer, { attributes: true, subtree: true })
    for (let frame = 0; frame < 30; frame++) f.cache.viewport(0, 1, 0)
    expect(observer.takeRecords()).toHaveLength(0)
    for (const part of [1, 0]) {
      f.cache.viewport(part, 1, part)
      expect(observer.takeRecords().map(record => [record.target, record.attributeName]))
        .toEqual(canvases.map(canvas => [canvas, 'hidden']))
      expect(canvases.map(canvas => canvas.hidden)).toEqual([part !== 0, part !== 1])
      for (let frame = 0; frame < 30; frame++) f.cache.viewport(part, 1, part)
      expect(observer.takeRecords()).toHaveLength(0)
    }
  } finally { observer.disconnect(); await f.cache.dispose() }
})

test('only changed preview holes mutate styles, including clearing and restoring the same hole', async () => {
  const f = fixture(1), observer = new MutationObserver(() => {})
  try {
    f.cache.viewport(0, 1, 0); await f.complete()
    const canvas = f.layer.firstElementChild as HTMLCanvasElement
    observer.observe(canvas, { attributes: true, attributeFilter: ['style', 'hidden'] })
    const displayed = { x: 0, y: 0, width: 1440, height: 1500 }
    for (const [window, visible, expected] of [
      [displayed, { x: 0, y: 750, width: 1440, height: 2000 }, 'path(evenodd, "M0 0H96V192H0Z M0 50H96V100H0Z")'],
      [displayed, { x: 0, y: 900, width: 1440, height: 2000 }, 'path(evenodd, "M0 0H96V192H0Z M0 60H96V100H0Z")'],
      [displayed, { x: 0, y: 3000, width: 1440, height: 2000 }, ''],
      [displayed, { x: 0, y: 750, width: 1440, height: 2000 }, 'path(evenodd, "M0 0H96V192H0Z M0 50H96V100H0Z")'],
      [undefined, { x: 0, y: 750, width: 1440, height: 2000 }, ''],
      [displayed, { x: 0, y: 750, width: 1440, height: 2000 }, 'path(evenodd, "M0 0H96V192H0Z M0 50H96V100H0Z")'],
    ] as const) {
      f.cache.content(window, visible)
      expect(observer.takeRecords()).toHaveLength(1)
      expect(canvas.style.clipPath).toBe(expected)
      f.cache.content(window && { ...window }, { ...visible })
      f.cache.viewport(0, 1, 0)
      expect(observer.takeRecords()).toHaveLength(0)
    }
  } finally { observer.disconnect(); await f.cache.dispose() }
})

test('only the displayed window intersecting the visible area punches a hole in page previews', async () => {
  const f = fixture(1)
  f.cache.viewport(0, 1, 0); await f.complete()
  const canvas = f.layer.firstElementChild as HTMLCanvasElement
  expect(canvas.style.clipPath).toBe('')
  f.cache.content({ x: 0, y: 0, width: 1440, height: 1500 }, { x: 0, y: 750, width: 1440, height: 2000 })
  expect(canvas.style.clipPath).toBe('path(evenodd, "M0 0H96V192H0Z M0 50H96V100H0Z")')
  f.cache.content(undefined, { x: 0, y: 750, width: 1440, height: 2000 })
  expect(canvas.style.clipPath).toBe('')
  await f.cache.dispose()
})


test.each(['width', 'height', 'bytes', 'array', 'context'] as const)('a page with invalid %s never publishes a canvas', async (invalid) => {
  const f = fixture(1)
  try {
    f.cache.viewport(0, 1, 0)
    const request = f.requests[0]!
    let result = pixels(request.width, request.height)
    if (invalid === 'width') result = { ...result, width: result.width + 1 }
    else if (invalid === 'height') result = { ...result, height: result.height + 1 }
    else if (invalid === 'bytes') result = { ...result, rgba: new Uint8Array(0) }
    else if (invalid === 'array') result = { ...result, rgba: [] as never }
    else f.getContext.mockReturnValueOnce(null)
    request.resolve(result)
    await vi.waitFor(() => { expect(f.failure).toHaveBeenCalledOnce() })
    await f.cache.pause()
    expect(f.layer.children).toHaveLength(0)
    expect(f.ready).not.toHaveBeenCalled()
  } finally { await f.cache.dispose() }
})
