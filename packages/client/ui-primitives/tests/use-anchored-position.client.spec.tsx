// @vitest-environment jsdom
/** Synchronous fixed placement across viewport changes and anchor movement. */
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { useAnchoredPosition } from '../src/useAnchoredPosition.ts'

let frames: FrameRequestCallback[]
beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => frames.push(callback)))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('innerWidth', 1000)
  vi.stubGlobal('innerHeight', 800)
  vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 300, 200, 20))
  vi.spyOn(HTMLDivElement.prototype, 'offsetWidth', 'get').mockReturnValue(120)
  vi.spyOn(HTMLDivElement.prototype, 'offsetHeight', 'get').mockReturnValue(80)
  vi.stubGlobal('CSS', { supports: (property: string) => property === '-webkit-backdrop-filter' })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function Host({ open, ...options }: Omit<Parameters<typeof useAnchoredPosition>[0], 'anchorRef' | 'panelRef' | 'gap' | 'margin'>) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({ open, anchorRef, panelRef, gap: 4, margin: 12, ...options })
  return <>
    <button ref={anchorRef} type="button">anchor</button>
    {open && <div ref={panelRef} data-testid="panel" style={{ position: 'fixed', ...position ?? { visibility: 'hidden' } }} />}
  </>
}

function show(props: Parameters<typeof Host>[0]) {
  return render(<Host {...props} />)
}

describe('useAnchoredPosition', () => {
  it.each(['anchor', 'panel'] as const)('does not measure or subscribe without the %s element', (missing) => {
    const anchor = document.createElement('button')
    const measure = vi.spyOn(anchor, 'getBoundingClientRect')
    const { result } = renderHook(() => useAnchoredPosition({
      open: true,
      anchorRef: { current: missing === 'anchor' ? null : anchor },
      panelRef: { current: missing === 'panel' ? null : document.createElement('div') },
      gap: 4,
      margin: 12,
    }))
    expect(result.current).toBeNull()
    expect(measure).not.toHaveBeenCalled()
    expect(requestAnimationFrame).not.toHaveBeenCalled()
  })

  it('does not position elements from a document without a window', () => {
    const detachedDocument = document.implementation.createHTMLDocument()
    const { result } = renderHook(() => useAnchoredPosition({
      open: true,
      anchorRef: { current: detachedDocument.createElement('button') },
      panelRef: { current: detachedDocument.createElement('div') },
      gap: 4,
      margin: 12,
    }))
    expect(result.current).toBeNull()
    expect(requestAnimationFrame).not.toHaveBeenCalled()
  })

  it.each([
    { side: 'bottom', align: 'start', left: '100px', top: '324px' },
    { side: 'bottom', align: 'end', left: '180px', top: '324px' },
    { side: 'top', align: 'start', left: '100px', top: '216px' },
    { side: 'top', align: 'end', left: '180px', top: '216px' },
    { side: 'right', align: 'start', left: '304px', top: '300px' },
    { side: 'right', align: 'end', left: '304px', top: '300px' },
  ] as const)('places $side-$align from the matching anchor edges', ({ side, align, left, top }) => {
    const ui = show({ open: true, side, align })
    expect(ui.getByTestId('panel').style.left).toBe(left)
    expect(ui.getByTestId('panel').style.top).toBe(top)
  })

  it.each([
    { side: 'top', anchorY: 100, fullscreen: false, top: 60 },
    { side: 'top', anchorY: 100, fullscreen: true, top: 20 },
    { side: 'bottom', anchorY: 0, fullscreen: false, top: 14 },
  ] as const)('keeps $side placement at $top with fullscreen=$fullscreen', ({ side, anchorY, fullscreen, top }) => {
    const root = document.documentElement
    const previous = root.getAttribute('style')
    const priorFullscreen = root.getAttribute('data-fullscreen')
    try {
      root.style.setProperty('--dsh-frame-top-clearance', '40px')
      root.toggleAttribute('data-fullscreen', fullscreen)
      vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, anchorY, 200, 10))
      vi.spyOn(HTMLDivElement.prototype, 'offsetHeight', 'get').mockReturnValue(400)
      const ui = show({ open: true, side })
      expect(ui.getByTestId('panel').style.top).toBe(`${top}px`)
    } finally {
      if (previous === null) root.removeAttribute('style')
      else root.setAttribute('style', previous)
      if (priorFullscreen === null) root.removeAttribute('data-fullscreen')
      else root.setAttribute('data-fullscreen', priorFullscreen)
    }
  })

  it('keeps the near margins when the panel exceeds the viewport', () => {
    vi.spyOn(HTMLDivElement.prototype, 'offsetWidth', 'get').mockReturnValue(1200)
    vi.spyOn(HTMLDivElement.prototype, 'offsetHeight', 'get').mockReturnValue(900)
    const ui = show({ open: true })
    expect(ui.getByTestId('panel').style.left).toBe('12px')
    expect(ui.getByTestId('panel').style.top).toBe('12px')
  })

  it('follows WebKit visual-viewport offsets, resizing, and scrolling', () => {
    const viewport = Object.assign(new EventTarget(), { width: 500, height: 400, offsetLeft: 40, offsetTop: 60 })
    vi.stubGlobal('visualViewport', viewport)
    const remove = vi.spyOn(viewport, 'removeEventListener')
    const ui = show({ open: true, side: 'top' })
    const panel = ui.getByTestId('panel')
    expect(panel.style.left).toBe('140px')
    expect(panel.style.top).toBe('276px')
    act(() => {
      viewport.offsetLeft = 100
      viewport.offsetTop = 120
      viewport.dispatchEvent(new Event('scroll'))
    })
    expect(panel.style.left).toBe('200px')
    expect(panel.style.top).toBe('336px')
    act(() => {
      viewport.height = 200
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(panel.style.top).toBe('228px')
    ui.rerender(<Host open={false} />)
    expect(remove.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['scroll', 'resize']))
  })

  it('tracks resizing and ignores observer callbacks after closing', () => {
    const records: Array<{ callback: ResizeObserverCallback; observed: Element[]; disconnect: ReturnType<typeof vi.fn> }> = []
    vi.stubGlobal('ResizeObserver', class {
      private readonly record
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, observed: [] as Element[], disconnect: vi.fn() }
        records.push(this.record)
      }
      observe(element: Element) { this.record.observed.push(element) }
      disconnect() { this.record.disconnect() }
    })
    const ui = show({ open: true, side: 'top' })
    const observer = records[0]!
    const panel = ui.getByTestId('panel')
    expect(observer.observed).toEqual([ui.getByRole('button'), ui.getByTestId('panel')])
    vi.spyOn(HTMLDivElement.prototype, 'offsetHeight', 'get').mockReturnValue(160)
    act(() => { observer.callback([], {} as ResizeObserver) })
    expect(ui.getByTestId('panel').style.top).toBe('136px')
    ui.rerender(<Host open={false} />)
    expect(observer.disconnect).toHaveBeenCalledOnce()
    const anchor = observer.observed[0]!
    const measure = vi.spyOn(anchor, 'getBoundingClientRect')
    measure.mockClear()
    act(() => { observer.callback([], {} as ResizeObserver) })
    expect(measure).not.toHaveBeenCalled()
    expect(panel.style.getPropertyValue('--dsh-anchored-max-width')).toBe('')
    expect(panel.style.getPropertyValue('--dsh-anchored-max-height')).toBe('')
  })

  it('positions without ResizeObserver and subscribes only while open', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const ui = show({ open: false })
    expect(requestAnimationFrame).not.toHaveBeenCalled()
    act(() => { ui.rerender(<Host open />) })
    expect(ui.getByTestId('panel').style.top).toBe('324px')
  })

  it('positions the first render and changed content without a microtask', () => {
    const ui = show({ open: true, side: 'top', layoutKey: 'root' })
    const panel = ui.getByTestId('panel')
    expect(panel.style.visibility).toBe('')
    expect(panel.style.top).toBe('216px')
    vi.spyOn(HTMLDivElement.prototype, 'offsetHeight', 'get').mockReturnValue(160)
    ui.rerender(<Host open side="top" layoutKey="model" />)
    expect(panel.style.top).toBe('136px')
  })

  it('uses layout-relative client rects without adding the visual offset twice', () => {
    vi.stubGlobal('CSS', { supports: () => false })
    vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { width: 500, height: 400, offsetLeft: 40, offsetTop: 60 }))
    const ui = show({ open: true, side: 'top' })
    const panel = ui.getByTestId('panel')
    expect(panel.style.left).toBe('100px')
    expect(panel.style.top).toBe('216px')
    expect(panel.style.getPropertyValue('--dsh-anchored-max-width')).toBe('476px')
    expect(panel.style.getPropertyValue('--dsh-anchored-max-height')).toBe('376px')
    ui.unmount()
    expect(panel.style.getPropertyValue('--dsh-anchored-max-width')).toBe('')
    expect(panel.style.getPropertyValue('--dsh-anchored-max-height')).toBe('')
  })

  it('tracks a moving host rect, hides a missing anchor, and stops on unmount', () => {
    let rect: DOMRect | null = null
    const getAnchorRect = vi.fn(() => rect)
    const ui = show({ open: true, getAnchorRect, minWidthFromAnchor: true })
    const panel = ui.getByTestId('panel')
    expect(panel.style.visibility).toBe('hidden')
    rect = new DOMRect(40, 50, 20, 10)
    act(() => { frames.shift()!(0) })
    expect(panel.style.left).toBe('40px')
    expect(panel.style.top).toBe('64px')
    rect.x = 70
    getAnchorRect.mockClear()
    act(() => { frames.shift()!(16) })
    expect(getAnchorRect).toHaveBeenCalledOnce()
    expect(panel.style.left).toBe('70px')
    rect.y = 80
    act(() => { frames.shift()!(32) })
    expect(panel.style.top).toBe('94px')
    rect.width = 40
    act(() => { frames.shift()!(48) })
    expect(panel.style.minWidth).toBe('40px')
    rect.height = 20
    act(() => { frames.shift()!(64) })
    expect(panel.style.top).toBe('104px')
    const measurePanel = vi.spyOn(panel, 'offsetWidth', 'get')
    measurePanel.mockClear()
    act(() => { frames.shift()!(80) })
    expect(measurePanel).not.toHaveBeenCalled()
    rect = null
    act(() => { frames.shift()!(96) })
    expect(panel.style.visibility).toBe('hidden')
    ui.unmount()
    const frame = frames.shift()!
    frame(112)
    expect(frames).toHaveLength(0)
    expect(cancelAnimationFrame).toHaveBeenCalledOnce()
  })
})
