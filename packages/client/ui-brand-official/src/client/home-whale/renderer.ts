/** Alternating dot and code breaches sharing one bundled animation atlas. */
import type { WhaleArtwork } from './artwork.ts'
import { createCodeFill } from './code-fill.ts'

// Geometry of assets/breach-atlas.webp: 137 frames at 192 × 108 cells, in twelve columns.
const ATLAS = { width: 192, height: 108, columns: 12, frames: 137 } as const

/** Control of one attached whale decoration. */
export interface PixelWhaleHandle {
  /** Request one playback; ignored while playing, failed, hidden, or under reduced motion. */
  play: () => void
  /** Release frame work, atlas pixels, and observers; late atlas loads are ignored. */
  dispose: () => void
}

const NO_WHALE: PixelWhaleHandle = { play: () => {}, dispose: () => {} }

/**
 * Bind one noninteractive, initially transparent home decoration.
 * Missing Canvas support returns a no-op handle, so home stays usable without decoration.
 * An atlas failure stops decoration and logs a reload action.
 * @param canvas - presentation-owned output, with its neutral color supplied by CSS.
 * @param options - fixed opacity, lettering, frame rate, and duration artwork.
 * @param atlasUrl - URL of the packaged frame atlas, loaded once on the first eligible playback.
 * @returns the playback trigger and its teardown.
 */
export function attachPixelWhale(canvas: HTMLCanvasElement, options: WhaleArtwork, atlasUrl: string): PixelWhaleHandle {
  const context = canvas.getContext('2d')
  if (context === null) return NO_WHALE
  const ctx = context
  const image = new Image()
  const media = matchMedia('(prefers-reduced-motion: reduce)')
  let pixels: Uint8ClampedArray | undefined
  let started: number | undefined
  let loading = false
  let disposed = false
  let failed = false
  let visible = true
  let frame = 0
  let layoutFrame = 0
  let last = -Infinity
  let width = 0
  let height = 0
  let sceneWidth = 0
  let left = 0
  let top = 0
  let fill: 'pixels' | 'code' = 'code'
  let code: ReturnType<typeof createCodeFill> | undefined

  const moving = () => !media.matches
  const drawable = () => !disposed && !document.hidden && visible && width > 0 && height > 0

  function clear(): void {
    ctx.clearRect(0, 0, width, height)
  }

  function stop(): void {
    cancelAnimationFrame(frame)
    frame = 0
    started = undefined
    clear()
  }

  function fail(error: unknown): void {
    if (disposed) return
    failed = true
    stop()
    console.warn('Home whale animation is unavailable; home remains usable. Reload the page to retry.', error)
  }

  function paint(now: number): void {
    clear()
    if (pixels === undefined || started === undefined) return
    const progress = (now - started) / options.rippleDurationMs
    if (progress >= 1) {
      started = undefined
      return
    }
    const index = Math.floor(progress * ATLAS.frames)
    const offsetX = (index % ATLAS.columns) * ATLAS.width
    const offsetY = Math.floor(index / ATLAS.columns) * ATLAS.height
    const stride = ATLAS.width * ATLAS.columns
    const cell = sceneWidth / ATLAS.width
    const fade = Math.min(1, progress * 15, (1 - progress) * 10)
    if (fill === 'code' && code !== undefined) {
      code.paint(ctx, pixels, index, left, top, sceneWidth, Math.min(1, options.activeOpacity * 1.5) * fade)
      return
    }
    for (let y = 0; y < ATLAS.height; y++) {
      for (let x = 0; x < ATLAS.width; x++) {
        const offset = ((offsetY + y) * stride + offsetX + x) * 4
        const alpha = (pixels[offset + 1] as number) / 255
        if (alpha < 0.015) continue
        ctx.globalAlpha = alpha * options.activeOpacity * fade * 0.8
        ctx.beginPath()
        ctx.arc(left + (x + 0.5) * cell, top + (y + 0.5) * cell, (pixels[offset] as number) / 255 * cell, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
  }

  function tick(now: number): void {
    frame = 0
    if (!drawable()) return
    if (!moving()) { stop(); return }
    if (now - last + 0.5 >= 1000 / options.frameRate) {
      paint(now)
      last = now
    }
    if (started !== undefined) frame = requestAnimationFrame(tick)
  }

  function resume(): void {
    cancelAnimationFrame(frame)
    frame = 0
    if (disposed) return
    if (!moving()) { stop(); return }
    if (!drawable()) return
    paint(performance.now())
    last = performance.now()
    if (started !== undefined) frame = requestAnimationFrame(tick)
  }

  function resize(): void {
    width = canvas.clientWidth
    height = canvas.clientHeight
    const dpr = Math.min(devicePixelRatio, 2)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = getComputedStyle(canvas).color
    sceneWidth = Math.min(Math.max(width * 0.94, 720), height * 1.6, 1120) * 1.12
    const sceneHeight = sceneWidth * ATLAS.height / ATLAS.width
    left = (width - sceneWidth) / 2
    top = height * 0.43 - sceneHeight / 2
    if (code !== undefined && sceneWidth > 0) code.resize(canvas, sceneWidth)
    resume()
  }

  // Layout redraws all code lettering, so bursts of size or theme changes collapse into one frame.
  function scheduleResize(): void {
    if (disposed || layoutFrame !== 0) return
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0
      resize()
    })
  }

  function begin(): void {
    if (!moving() || !drawable()) return
    if (fill === 'pixels') {
      code ??= createCodeFill(options, ATLAS)
      if (code === undefined) { fail(new Error('Home whale code Canvas context is unavailable')); return }
      code.resize(canvas, sceneWidth)
    }
    fill = fill === 'pixels' ? 'code' : 'pixels'
    started = performance.now()
    resume()
  }

  image.onload = () => {
    if (disposed) return
    const source = document.createElement('canvas')
    source.width = image.naturalWidth
    source.height = image.naturalHeight
    try {
      if (source.width !== ATLAS.width * ATLAS.columns
        || source.height !== ATLAS.height * Math.ceil(ATLAS.frames / ATLAS.columns)) {
        throw new Error('Home whale atlas dimensions do not match its frame geometry')
      }
      const reader = source.getContext('2d')
      if (reader === null) { fail(new Error('Home whale atlas Canvas context is unavailable')); return }
      reader.drawImage(image, 0, 0)
      pixels = reader.getImageData(0, 0, source.width, source.height).data
    } catch (error) {
      fail(error)
      return
    } finally {
      source.width = source.height = 0
      image.removeAttribute('src')
    }
    begin()
  }
  image.onerror = () => { fail(new Error('Home whale atlas could not be decoded')) }

  function play(): void {
    if (failed || !moving() || !drawable() || started !== undefined) return
    if (pixels !== undefined) { begin(); return }
    if (loading) return
    loading = true
    image.src = atlasUrl
  }

  const sizeObserver = new ResizeObserver(scheduleResize)
  const visibilityObserver = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false
    resume()
  })
  const themeObserver = new MutationObserver(scheduleResize)
  sizeObserver.observe(canvas)
  visibilityObserver.observe(canvas)
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'] })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ds-theme-source', 'style'] })
  document.addEventListener('visibilitychange', resume)
  media.addEventListener('change', resume)
  resize()
  const dispose = (): void => {
    disposed = true
    stop()
    cancelAnimationFrame(layoutFrame)
    layoutFrame = 0
    image.onload = image.onerror = null
    image.removeAttribute('src')
    pixels = undefined
    code?.dispose()
    code = undefined
    sizeObserver.disconnect()
    visibilityObserver.disconnect()
    themeObserver.disconnect()
    document.removeEventListener('visibilitychange', resume)
    media.removeEventListener('change', resume)
  }
  return { play, dispose }
}
