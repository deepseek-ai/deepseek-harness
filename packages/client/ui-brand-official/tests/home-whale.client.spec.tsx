// @vitest-environment jsdom
import { cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WHALE_ARTWORK, type WhaleArtwork } from '../src/client/home-whale/artwork.ts'
import { attachPixelWhale } from '../src/client/home-whale/renderer.ts'

const releases: (() => void)[] = []
afterEach(() => {
  for (const release of releases.splice(0)) release()
  cleanup()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function scene(options: WhaleArtwork = WHALE_ARTWORK, missingContext = -1) {
  let now = 0
  let nextFrame = 1
  const frames = new Map<number, FrameRequestCallback>()
  const pixels = new Uint8ClampedArray(2304 * 1296 * 4)
  for (let i = 0; i < 137; i++) {
    const offset = (Math.floor(i / 12) * 108 * 2304 + (i % 12) * 192) * 4
    pixels[offset] = 90
    pixels[offset + 1] = 180
  }
  const drawing = () => ({
    clearRect: vi.fn(), drawImage: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), setTransform: vi.fn(),
    fillText: vi.fn<(text: string, x: number, y: number) => void>(),
    measureText: vi.fn((text: string) => ({ width: text.length * 6 }) as TextMetrics),
    createImageData: vi.fn((size: number | ImageData, rows?: number) => {
      const width = typeof size === 'number' ? size : size.width
      const height = typeof size === 'number' ? rows ?? 0 : size.height
      return { data: new Uint8ClampedArray(width * height * 4), width, height, colorSpace: 'srgb' as const }
    }),
    putImageData: vi.fn<(data: ImageData, x: number, y: number) => void>(),
    getImageData: vi.fn(() => ({ data: pixels, width: 2304, height: 1296, colorSpace: 'srgb' as const })),
    globalAlpha: 1,
  })
  const contexts: ReturnType<typeof drawing>[] = []
  const canvases: HTMLCanvasElement[] = []
  const image = document.createElement('img')
  Object.defineProperties(image, { naturalWidth: { value: 2304, configurable: true }, naturalHeight: { value: 1296 } })
  vi.stubGlobal('Image', function () { return image })
  const media = Object.assign(new EventTarget(), { matches: false })
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const disposers: ReturnType<typeof vi.fn>[] = []
  let onResize = () => {}
  let onTheme = () => {}
  let onVisibility: (entries: { isIntersecting: boolean }[]) => void = () => {}
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const context = drawing()
    const partial: Partial<CanvasRenderingContext2D> = context
    contexts.push(context)
    canvases.push(this)
    return contexts.length - 1 === missingContext ? null : partial as CanvasRenderingContext2D
  })
  vi.stubGlobal('devicePixelRatio', 3)
  vi.stubGlobal('matchMedia', () => media)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { onResize = callback; disposers.push(this.disconnect) }
    observe() {}
    disconnect = vi.fn()
  })
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof onVisibility) { onVisibility = callback; disposers.push(this.disconnect) }
    observe() {}
    disconnect = vi.fn()
  })
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { onTheme = callback; disposers.push(this.disconnect) }
    observe() {}
    disconnect = vi.fn()
  })
  const surface = document.createElement('div')
  const canvas = document.createElement('canvas')
  let width = 1200
  Object.defineProperties(canvas, {
    clientWidth: { get: () => width }, clientHeight: { get: () => 900 },
  })
  vi.spyOn(canvas, 'getBoundingClientRect').mockImplementation(() => new DOMRect(10, 20, width, 900))
  surface.append(canvas)
  document.body.append(surface)
  const whale = attachPixelWhale(canvas, options, 'data:image/webp;base64,fixture')
  const dispose = whale.dispose
  releases.push(dispose)
  const click = whale.play
  function step(time: number) {
    now = time
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(time)
  }
  return {
    canvas, surface, contexts, canvases, image, media, hidden, disposers, frames,
    dispose, click, step, getContext, pixels,
    load: () => image.dispatchEvent(new Event('load')),
    theme: () => { onTheme() },
    width: (value: number) => { width = value; onResize() },
    visibility: (entries: { isIntersecting: boolean }[]) => { onVisibility(entries) },
  }
}

describe('official home pixel whale', () => {
  it('alternates dots and code on completed clicks, without interrupting or automatically repeating', () => {
    const s = scene()
    const output = s.contexts[0]!
    expect(s.image.hasAttribute('src')).toBe(false)
    expect(s.frames.size).toBe(0)
    s.click()
    expect(s.image.getAttribute('src')).toBe('data:image/webp;base64,fixture')
    s.click()
    expect(s.frames.size).toBe(0)
    s.load()
    expect(s.canvases[1]!.width).toBe(0)
    s.step(1500)
    expect(output.arc).toHaveBeenCalled()
    expect(output.globalAlpha).toBe(1)
    s.click()
    s.step(5750)
    expect(s.frames.size).toBe(0)
    const draws = output.arc.mock.calls.length
    s.step(6000)
    expect(output.arc).toHaveBeenCalledTimes(draws)
    s.click()
    s.step(6100)
    expect(output.arc).toHaveBeenCalledTimes(draws)
    expect(output.drawImage).toHaveBeenCalled()
    expect(s.contexts[2]!.fillText).toHaveBeenCalled()
    expect(s.contexts).toHaveLength(4)
    s.step(12000)
    expect(s.frames.size).toBe(0)
    s.click(); s.step(13000)
    expect(output.arc.mock.calls.length).toBeGreaterThan(draws)
    s.dispose()
    for (const canvas of s.canvases.slice(2)) expect(canvas.width).toBe(0)
  })

  it('fills the code whale only with authored snippets', () => {
    const options = { ...WHALE_ARTWORK, phrases: ['ctx.effect(() => dispose)', 'await agent.run()'] }
    const s = scene(options)
    for (let y = 15; y < 80; y++) {
      for (let x = 20; x < 165; x++) s.pixels[((3 * 108 + y) * 2304 + x) * 4 + 1] = 180
    }
    s.click(); s.load(); s.step(5800)
    s.click(); s.step(7300)
    const texts = s.contexts[2]!.fillText.mock.calls.map(call => call[0])
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.every(text => options.phrases.includes(text))).toBe(true)
    const mask = s.contexts[3]!.putImageData.mock.calls.at(-1)![0].data
    expect(mask[3]).toBe(180)
    expect(mask[7]).toBe(0)
    const count = s.contexts[2]!.fillText.mock.calls.length
    s.step(7400)
    expect(s.contexts[2]!.fillText).toHaveBeenCalledTimes(count)
  })

  it('plays only when its handle requests it', () => {
    const s = scene()
    s.surface.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 200, clientY: 200 }))
    expect(s.image.hasAttribute('src')).toBe(false)
    s.click()
    expect(s.image.hasAttribute('src')).toBe(true)
  })

  it('keeps a large breach in narrow homes and clips both fills within the canvas', () => {
    const s = scene()
    s.width(390)
    s.step(16)
    s.click(); s.load(); s.step(1500)
    const dot = s.contexts[0]!.arc.mock.calls.at(-1)!
    expect(dot[0]).toBeLessThan(0)
    expect(s.canvas.width).toBe(780)
    s.step(5800); s.click(); s.step(7300)
    const image = s.contexts[0]!.drawImage.mock.calls.at(-1)!
    expect(image[1]).toBeLessThan(0)
    expect(image[3]).toBeGreaterThan(390)
    expect(s.canvas.width).toBe(780)
  })

  it('stops hidden work, expires elapsed animations, and clears when reduced motion is enabled', () => {
    const s = scene()
    s.click(); s.load(); s.step(100)
    s.hidden.mockReturnValue(true)
    s.step(200)
    expect(s.frames.size).toBe(0)
    s.hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(s.frames.size).toBe(1)
    s.visibility([])
    expect(s.frames.size).toBe(0)
    s.visibility([{ isIntersecting: true }])
    expect(s.frames.size).toBe(1)
    s.media.matches = true
    s.media.dispatchEvent(new Event('change'))
    expect(s.frames.size).toBe(0)
    s.click()
    s.media.matches = false
    s.media.dispatchEvent(new Event('change'))
    expect(s.frames.size).toBe(0)
    s.click()
    s.media.matches = true
    s.step(400)
    expect(s.frames.size).toBe(0)
    s.media.matches = false
    s.click()
    s.visibility([])
    s.step(10000)
    s.visibility([{ isIntersecting: true }])
    expect(s.frames.size).toBe(0)
  })

  it('does not start a late load after motion is disabled, but allows a subsequent explicit click', () => {
    const s = scene()
    s.click()
    s.media.matches = true
    s.load()
    expect(s.frames.size).toBe(0)
    s.media.matches = false
    s.click()
    expect(s.frames.size).toBe(1)
  })

  it('redraws for theme and size changes without decoding the atlas again', () => {
    const s = scene()
    s.click(); s.load(); s.step(100)
    const draws = s.contexts[0]!.arc.mock.calls.length
    s.theme()
    s.theme()
    expect(s.contexts[0]!.arc.mock.calls.length).toBe(draws)
    s.step(150)
    expect(s.contexts[0]!.arc.mock.calls.length).toBeGreaterThan(draws)
    s.width(0)
    s.step(200)
    expect(s.frames.size).toBe(0)
    s.width(390)
    expect(s.canvas.width).not.toBe(780)
    s.step(250)
    expect(s.canvas.width).toBe(780)
    expect(s.contexts).toHaveLength(2)
  })

  it('throttles to the artwork frame rate and relays out the code fill on resize', () => {
    const s = scene()
    s.click(); s.load(); s.step(100)
    const draws = s.contexts[0]!.arc.mock.calls.length
    s.step(110)
    expect(s.contexts[0]!.arc).toHaveBeenCalledTimes(draws)
    s.step(5800); s.click(); s.step(7300)
    const lettering = s.contexts[2]!
    const layouts = lettering.setTransform.mock.calls.length
    s.width(900)
    s.step(7320)
    expect(lettering.setTransform.mock.calls.length).toBeGreaterThan(layouts)
  })

  it('stops decoration when the code fill cannot allocate its canvases', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = scene(WHALE_ARTWORK, 2)
    s.click(); s.load(); s.step(5800)
    s.click(); s.step(7300)
    expect(warning).toHaveBeenCalledOnce()
    expect(s.frames.size).toBe(0)
  })

  it('cancels frames and rejects callbacks retained before disposal', () => {
    const s = scene()
    s.click()
    const lateLoad = s.image.onload!
    const lateError = s.image.onerror!
    s.dispose()
    lateLoad.call(s.image, new Event('load'))
    lateError.call(s.image, new Event('error'))
    s.theme()
    s.visibility([{ isIntersecting: true }])
    s.click()
    expect(s.frames.size).toBe(0)
    expect(s.contexts).toHaveLength(1)
    expect(s.image.hasAttribute('src')).toBe(false)
    for (const disconnect of s.disposers) expect(disconnect).toHaveBeenCalledOnce()
  })

  it('leaves home usable without Canvas through an inert handle', () => {
    const s = scene(WHALE_ARTWORK, 0)
    s.click()
    s.dispose()
    expect(s.frames.size).toBe(0)
    expect(s.disposers).toHaveLength(0)
    expect(s.image.hasAttribute('src')).toBe(false)
  })

  it.each(['decode', 'geometry', 'context', 'pixels'] as const)('contains %s failure and does not retry until remount', (failure) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = scene(WHALE_ARTWORK, failure === 'context' ? 1 : -1)
    s.click()
    if (failure === 'decode') s.image.dispatchEvent(new Event('error'))
    else {
      if (failure === 'geometry') Object.defineProperty(s.image, 'naturalWidth', { value: 1 })
      if (failure === 'pixels') {
        const original = s.getContext.getMockImplementation()!
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
          const ctx = original.call(this, '2d') as CanvasRenderingContext2D
          ctx.getImageData = () => { throw new Error('Unreadable atlas') }
          return ctx
        })
      }
      s.load()
    }
    expect(warning).toHaveBeenCalledOnce()
    s.click(); s.step(100)
    expect(s.frames.size).toBe(0)
    expect(s.contexts[0]!.arc).not.toHaveBeenCalled()
  })
})
