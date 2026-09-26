// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'

let bubbleSize: ResizeObserverSize
let automaticResize: boolean
const observers: TooltipResizeObserver[] = []

class TooltipResizeObserver implements ResizeObserver {
  private target: Element | undefined
  constructor(private readonly callback: ResizeObserverCallback) { observers.push(this) }
  observe(target: Element): void {
    this.target = target
    if (automaticResize) this.deliver()
  }
  unobserve(): void { this.target = undefined }
  disconnect(): void { this.target = undefined }
  deliver(): void {
    if (this.target === undefined) return
    this.callback([{
      target: this.target, borderBoxSize: [bubbleSize], contentBoxSize: [bubbleSize],
      devicePixelContentBoxSize: [bubbleSize],
      contentRect: new DOMRect(0, 0, bubbleSize.inlineSize, bubbleSize.blockSize),
    }], this)
  }
}

beforeEach(() => {
  bubbleSize = { inlineSize: 0, blockSize: 0 }
  automaticResize = true
  observers.length = 0
  vi.stubGlobal('ResizeObserver', TooltipResizeObserver)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Tooltip', () => {
  it('updates independent keycaps and the accessible combination while visible', () => {
    const view = render(<Tooltip label="Reload" shortcutKeys={['⌘', 'R']}><button>anchor</button></Tooltip>)
    fireEvent.focus(screen.getByText('anchor'))
    expect(Array.from(screen.getByRole('tooltip', { name: 'Reload ⌘ R' }).querySelectorAll('kbd'), key => key.textContent)).toEqual(['⌘', 'R'])
    view.rerender(<Tooltip label="Reload" shortcutKeys={['Ctrl', '+', 'R']}><button>anchor</button></Tooltip>)
    expect(Array.from(screen.getByRole('tooltip', { name: 'Reload Ctrl + R' }).querySelectorAll('kbd'), key => key.textContent)).toEqual(['Ctrl', '+', 'R'])
    view.rerender(<Tooltip label="Reload" shortcutKeys={[]}><button>anchor</button></Tooltip>)
    expect(screen.getByRole('tooltip').querySelector('kbd')).toBeNull()
    fireEvent.click(screen.getByText('anchor'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('fits from observed sizes without synchronously measuring the bubble', () => {
    automaticResize = false
    const measured = vi.spyOn(Element.prototype, 'getBoundingClientRect')
    const view = render(<Tooltip label="Observed" side="bottom"><button>anchor</button></Tooltip>)
    const anchor = screen.getByText('anchor')
    fireEvent.mouseEnter(anchor)
    const bubble = view.container.querySelector<HTMLElement>('[role="tooltip"]')!
    expect(measured.mock.contexts).toEqual([anchor])
    expect(bubble.style.visibility).toBe('hidden')
    fireEvent(window, new Event('resize'))
    expect(bubble.style.visibility).toBe('hidden')
    expect(measured.mock.contexts).toEqual([anchor])
    bubbleSize = { inlineSize: 100, blockSize: 20 }
    act(() => { observers[0]!.deliver() })
    expect(screen.getByRole('tooltip').style.left).toBe('62px')
    fireEvent(window, new Event('resize'))
    expect(measured.mock.contexts).toEqual([anchor])
    const disconnect = vi.spyOn(observers[0]!, 'disconnect')
    view.unmount()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('resolves lazy labels only after the bubble becomes visible', () => {
    vi.useFakeTimers()
    try {
      const label = vi.fn(() => 'Timing details')
      render(
        <Tooltip label={label} delayMs={500}>
          <button type="button">anchor</button>
        </Tooltip>,
      )
      expect(label).not.toHaveBeenCalled()
      fireEvent.mouseEnter(screen.getByText('anchor'))
      act(() => { vi.advanceTimersByTime(499) })
      expect(label).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(1) })
      expect(screen.getByRole('tooltip').textContent).toBe('Timing details')
      expect(label).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('can delay pointer hover without delaying keyboard focus', () => {
    vi.useFakeTimers()
    try {
      render(
        <Tooltip label="Timing details" delayMs={500}>
          <button type="button">anchor</button>
        </Tooltip>,
      )
      const anchor = screen.getByText('anchor')
      fireEvent.mouseEnter(anchor)
      act(() => { vi.advanceTimersByTime(499) })
      expect(screen.queryByRole('tooltip')).toBeNull()
      fireEvent.mouseLeave(anchor)
      act(() => { vi.advanceTimersByTime(1) })
      expect(screen.queryByRole('tooltip')).toBeNull()
      fireEvent.mouseEnter(anchor)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getByRole('tooltip').textContent).toBe('Timing details')
      fireEvent.mouseLeave(anchor)
      fireEvent.focus(anchor)
      expect(screen.getByRole('tooltip').textContent).toBe('Timing details')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the bubble to the right on hover and hides it on leave', () => {
    render(
      <Tooltip label="Open sidebar">
        <button type="button">anchor</button>
      </Tooltip>,
    )
    const anchor = screen.getByText('anchor')
    fireEvent.mouseEnter(anchor)
    const bubble = screen.getByRole('tooltip')
    expect(bubble.textContent).toBe('Open sidebar')
    expect(bubble.getAttribute('data-side')).toBe('right')
    expect(bubble.style.left).toBe('12px')
    expect(bubble.style.top).toBe('0px')
    fireEvent.mouseLeave(anchor)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('supports bottom placement and the focus/blur channel', () => {
    render(
      <Tooltip label="Below" side="bottom">
        <button type="button">anchor</button>
      </Tooltip>,
    )
    const anchor = screen.getByText('anchor')
    fireEvent.focus(anchor)
    const bubble = screen.getByRole('tooltip')
    expect(bubble.getAttribute('data-side')).toBe('bottom')
    // Zero-width jsdom rect at x=0 clamps to the 12px edge margin.
    expect(bubble.style.left).toBe('12px')
    expect(bubble.style.top).toBe('8px')
    fireEvent.blur(anchor)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  // Anchor geometry and observed bubble sizes are independent browser inputs.
  const rect = (left: number, right: number): DOMRect =>
    ({ left, right, top: 0, bottom: 20, width: right - left, height: 20, x: left, y: 0, toJSON: () => ({}) })

  it('aligns the end of a bottom tooltip with the anchor right edge', () => {
    bubbleSize = { inlineSize: 100, blockSize: 20 }
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect(100, 200))
    try {
      render(
        <Tooltip label="End aligned" side="bottom" align="end">
          <button type="button">anchor</button>
        </Tooltip>,
      )
      fireEvent.mouseEnter(screen.getByText('anchor'))
      const bubble = screen.getByRole('tooltip')
      expect(bubble.getAttribute('data-align')).toBe('end')
      expect(bubble.style.left).toBe('200px')
    } finally {
      spy.mockRestore()
    }
  })

  it('caps the bubble width where the label would otherwise slab across the surface', () => {
    render(
      <Tooltip label="A description long enough to need a cap" side="bottom" maxWidth={360}>
        <button type="button">anchor</button>
      </Tooltip>,
    )
    fireEvent.mouseEnter(screen.getByText('anchor'))

    // The stylesheet's half-viewport cap stays the default; this one overrides it.
    expect(screen.getByRole('tooltip').style.maxWidth).toBe('360px')
  })

  it('clamps a bubble overflowing the right viewport edge back inside', () => {
    bubbleSize = { inlineSize: 200, blockSize: 20 }
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect(900, 1100))
    try {
      render(
        <Tooltip label="Wide" side="bottom">
          <button type="button">anchor</button>
        </Tooltip>,
      )
      fireEvent.mouseEnter(screen.getByText('anchor'))
      // pos.x = 1000 (anchor center); measured right edge 1100 overflows the
      // 1024 viewport's 12px safe margin (limit 1012) by 88, so the clamp
      // shifts left to 912.
      expect(screen.getByRole('tooltip').style.left).toBe('912px')
    } finally {
      spy.mockRestore()
    }
  })

  it('reclamps after label and viewport width changes', () => {
    const originalWidth = window.innerWidth
    bubbleSize = { inlineSize: 200, blockSize: 20 }
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect(900, 1000))
    try {
      const view = render(
        <Tooltip label="Wide" side="bottom">
          <button type="button">anchor</button>
        </Tooltip>,
      )
      fireEvent.mouseEnter(screen.getByText('anchor'))
      expect(screen.getByRole('tooltip').style.left).toBe('912px')

      view.rerender(
        <Tooltip label="Short" side="bottom">
          <button type="button">anchor</button>
        </Tooltip>,
      )
      bubbleSize = { inlineSize: 100, blockSize: 20 }
      act(() => { observers[0]!.deliver() })
      expect(screen.getByRole('tooltip').style.left).toBe('950px')

      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 })
      fireEvent(window, new Event('resize'))
      expect(screen.getByRole('tooltip').style.left).toBe('838px')
      expect(observers).toHaveLength(1)
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
      spy.mockRestore()
    }
  })

  it('clamps a bubble past the left viewport edge back inside', () => {
    bubbleSize = { inlineSize: 100, blockSize: 20 }
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect(-20, 80))
    try {
      render(
        <Tooltip label="Wide" side="bottom">
          <button type="button">anchor</button>
        </Tooltip>,
      )
      fireEvent.mouseEnter(screen.getByText('anchor'))
      // pos.x = 30 (anchor center); measured left edge -20 underflows the
      // 12px safe margin by 32, so the clamp shifts right to 62.
      expect(screen.getByRole('tooltip').style.left).toBe('62px')
    } finally {
      spy.mockRestore()
    }
  })

  const placed = (top: number, bottom: number, bubbleHeight: number) => {
    bubbleSize = { inlineSize: 100, blockSize: bubbleHeight }
    return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 100, right: 200, top, bottom, width: 100, height: bottom - top, x: 100, y: top, toJSON: () => ({}),
    })
  }

  it('supports top placement for anchors at the viewport bottom', () => {
    const spy = placed(700, 720, 20)
    try {
      render(
        <Tooltip label="Above" side="top">
          <button type="button">anchor</button>
        </Tooltip>,
      )
      fireEvent.mouseEnter(screen.getByText('anchor'))
      const bubble = screen.getByRole('tooltip')
      // There is room above, so the requested side stands: the bubble's own
      // top sits at the anchor's top less the 8px gutter.
      expect(bubble.getAttribute('data-side')).toBe('top')
      expect(bubble.style.top).toBe('692px')
      expect(bubble.style.left).toBe('150px')
    } finally {
      spy.mockRestore()
    }
  })

  it('flips a bottom bubble above an anchor with no room below', () => {
    // jsdom's viewport is 768 tall: a 300px bubble under an anchor ending at
    // 700 would run off, and there is room for it above.
    const spy = placed(600, 700, 300)
    try {
      render(
        <Tooltip label="Tall" side="bottom">
          <button type="button">anchor</button>
        </Tooltip>,
      )
      fireEvent.mouseEnter(screen.getByText('anchor'))
      const bubble = screen.getByRole('tooltip')
      expect(bubble.getAttribute('data-side')).toBe('top')
      expect(bubble.style.top).toBe('592px')
    } finally {
      spy.mockRestore()
    }
  })

  it('flips a top bubble below an anchor with no room above', () => {
    const spy = placed(10, 40, 100)
    try {
      render(
        <Tooltip label="Tall" side="top">
          <button type="button">anchor</button>
        </Tooltip>,
      )
      fireEvent.mouseEnter(screen.getByText('anchor'))
      const bubble = screen.getByRole('tooltip')
      expect(bubble.getAttribute('data-side')).toBe('bottom')
      expect(bubble.style.top).toBe('48px')
    } finally {
      spy.mockRestore()
    }
  })

  it.each(['bottom', 'top'] as const)('uses a custom gap to position and flip a %s tooltip', (side) => {
    const anchorBottom = side === 'bottom' ? window.innerHeight - 36 : 56
    const spy = placed(anchorBottom - 20, anchorBottom, 20)
    try {
      const view = render(<Tooltip label="Gap" side={side} gap={4}><button type="button">anchor</button></Tooltip>)
      fireEvent.mouseEnter(screen.getByText('anchor'))
      const bubble = screen.getByRole('tooltip')
      expect(bubble.getAttribute('data-side')).toBe(side)
      expect(bubble.style.top).toBe(`${side === 'bottom' ? anchorBottom + 4 : anchorBottom - 24}px`)
      view.rerender(<Tooltip label="Gap" side={side} gap={12}><button type="button">anchor</button></Tooltip>)
      expect(bubble.getAttribute('data-side')).toBe(side === 'bottom' ? 'top' : 'bottom')
      expect(bubble.style.top).toBe(`${side === 'bottom' ? anchorBottom - 32 : anchorBottom + 12}px`)
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps the requested side when neither side fits', () => {
    // A bubble taller than the viewport has no home; oscillating between the
    // two would be worse than honouring the request.
    const spy = placed(300, 400, 900)
    try {
      render(
        <Tooltip label="Huge" side="bottom">
          <button type="button">anchor</button>
        </Tooltip>,
      )
      fireEvent.mouseEnter(screen.getByText('anchor'))
      expect(screen.getByRole('tooltip').getAttribute('data-side')).toBe('bottom')
    } finally {
      spy.mockRestore()
    }
  })

  it('a click on the anchor dismisses the bubble even while the anchor stays focused', () => {
    render(
      <Tooltip label="Pin session">
        <button type="button">anchor</button>
      </Tooltip>,
    )
    const anchor = screen.getByText('anchor')
    // Pointer click: browsers focus the button first, then deliver the click.
    fireEvent.focus(anchor)
    fireEvent.mouseEnter(anchor)
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.click(anchor)
    expect(screen.queryByRole('tooltip')).toBeNull()
    // The retained focus alone must not resurrect it on mouse leave.
    fireEvent.mouseLeave(anchor)
    expect(screen.queryByRole('tooltip')).toBeNull()
    // A fresh hover shows the (possibly relabelled) bubble again.
    fireEvent.mouseEnter(anchor)
    expect(screen.getByRole('tooltip')).toBeTruthy()
  })

  it('focus arriving after a pointer interaction does not raise the bubble', () => {
    render(
      <Tooltip label="View options">
        <button type="button">anchor</button>
      </Tooltip>,
    )
    const anchor = screen.getByText('anchor')
    // A closing menu refocuses its trigger after a mouse selection: the last
    // interaction was a pointerdown on the menu row, not a key press.
    fireEvent.pointerDown(document.body)
    fireEvent.focus(anchor)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.blur(anchor)
    // The next key press restores focus-driven bubbles (keyboard selection).
    fireEvent.keyDown(document.body, { key: 'Tab' })
    fireEvent.focus(anchor)
    expect(screen.getByRole('tooltip')).toBeTruthy()
  })

  it('chains the anchor\'s own handlers ahead of the tooltip\'s', () => {
    const onMouseEnter = vi.fn()
    const onMouseLeave = vi.fn()
    const onClick = vi.fn()
    const onFocus = vi.fn()
    const onBlur = vi.fn()
    render(
      <Tooltip label="Chained">
        <button type="button" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onClick={onClick} onFocus={onFocus} onBlur={onBlur}>anchor</button>
      </Tooltip>,
    )
    const anchor = screen.getByText('anchor')
    fireEvent.mouseEnter(anchor)
    fireEvent.mouseLeave(anchor)
    fireEvent.click(anchor)
    fireEvent.focus(anchor)
    fireEvent.blur(anchor)
    expect(onMouseEnter).toHaveBeenCalledOnce()
    expect(onMouseLeave).toHaveBeenCalledOnce()
    expect(onClick).toHaveBeenCalledOnce()
    expect(onFocus).toHaveBeenCalledOnce()
    expect(onBlur).toHaveBeenCalledOnce()
  })

  it('suppresses the bubble while disabled without remounting the anchor', () => {
    const { rerender } = render(
      <Tooltip label="Rail" disabled>
        <button type="button">anchor</button>
      </Tooltip>,
    )
    const anchor = screen.getByText('anchor')
    fireEvent.mouseEnter(anchor)
    expect(screen.queryByRole('tooltip')).toBeNull()
    rerender(
      <Tooltip label="Rail">
        <button type="button">anchor</button>
      </Tooltip>,
    )
    // Same DOM node: toggling disabled never remounted the anchor.
    expect(screen.getByText('anchor')).toBe(anchor)
    fireEvent.mouseEnter(anchor)
    expect(screen.getByRole('tooltip')).toBeTruthy()
  })

  it('mouse leave hides the bubble immediately, even while the anchor stays focused', () => {
    render(
      <Tooltip label="Sticky">
        <button type="button">anchor</button>
      </Tooltip>,
    )
    const anchor = screen.getByText('anchor')
    // Focused AND hovered: leaving with the mouse drops the bubble at once.
    fireEvent.focus(anchor)
    fireEvent.mouseEnter(anchor)
    fireEvent.mouseLeave(anchor)
    expect(screen.queryByRole('tooltip')).toBeNull()
    // Re-entering shows it again; blurring while still hovered keeps it.
    fireEvent.mouseEnter(anchor)
    fireEvent.blur(anchor)
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.mouseLeave(anchor)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('forwards the anchor element to the child ref (object and callback)', () => {
    const objectRef = { current: null as HTMLButtonElement | null }
    const callbackRef = vi.fn()
    const { rerender } = render(
      <Tooltip label="Add">
        <button type="button" ref={objectRef}>anchor</button>
      </Tooltip>,
    )
    expect(objectRef.current).toBe(screen.getByText('anchor'))
    // Tooltip's own positioning still works through the merged ref.
    fireEvent.mouseEnter(screen.getByText('anchor'))
    expect(screen.getByRole('tooltip')).toBeTruthy()
    rerender(
      <Tooltip label="Add">
        <button type="button" ref={callbackRef}>anchor</button>
      </Tooltip>,
    )
    expect(callbackRef).toHaveBeenCalledWith(screen.getByText('anchor'))
  })

  it('drops an already-visible bubble when disabled flips mid-hover', () => {
    const { rerender } = render(
      <Tooltip label="Rail">
        <button type="button">anchor</button>
      </Tooltip>,
    )
    fireEvent.mouseEnter(screen.getByText('anchor'))
    expect(screen.getByRole('tooltip')).toBeTruthy()
    // e.g. clicking a rail control expands the sidebar: no mouseleave fires.
    rerender(
      <Tooltip label="Rail" disabled>
        <button type="button">anchor</button>
      </Tooltip>,
    )
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('withdraws the enclosing bubble while a nested tooltip shows its own', () => {
    render(
      <Tooltip label="Open sidebar">
        <button type="button">
          anchor
          <Tooltip label="Update — V1.2.3">
            <span data-testid="badge" />
          </Tooltip>
        </button>
      </Tooltip>,
    )
    const anchor = screen.getByText('anchor')
    const badge = screen.getByTestId('badge')
    fireEvent.mouseEnter(anchor)
    expect(screen.getByRole('tooltip').textContent).toBe('Open sidebar')

    // Entering the nested anchor withdraws the enclosing bubble instead of
    // stacking both; the enclosing anchor stays hovered, so nothing is lost.
    fireEvent.mouseEnter(badge)
    expect(screen.getAllByRole('tooltip').map(bubble => bubble.textContent)).toEqual(['Update — V1.2.3'])

    // Leaving the nested anchor for the enclosing one restores its bubble;
    // the pointer never left the enclosing anchor, so only the badge is left.
    fireEvent.mouseLeave(badge, { relatedTarget: anchor })
    expect(screen.getByRole('tooltip').textContent).toBe('Open sidebar')

    fireEvent.mouseLeave(anchor)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('releases the enclosing bubble when a shown nested tooltip unmounts', () => {
    const view = render(
      <Tooltip label="Open sidebar">
        <button type="button">
          anchor
          <Tooltip label="Update"><span data-testid="badge" /></Tooltip>
        </button>
      </Tooltip>,
    )
    fireEvent.mouseEnter(screen.getByText('anchor'))
    fireEvent.mouseEnter(screen.getByTestId('badge'))
    expect(screen.getAllByRole('tooltip').map(bubble => bubble.textContent)).toEqual(['Update'])

    view.rerender(
      <Tooltip label="Open sidebar">
        <button type="button">anchor</button>
      </Tooltip>,
    )
    expect(screen.getByRole('tooltip').textContent).toBe('Open sidebar')
  })
})


it('keeps the anchor in its clipping container and portals only the tooltip', () => {
  const view = render(<div style={{ overflow: 'hidden', contain: 'layout' }}>
    <Tooltip portal label="Open in Music" side="bottom"><button type="button">File action</button></Tooltip>
  </div>)
  const anchor = screen.getByRole('button', { name: 'File action' })
  fireEvent.mouseEnter(anchor)
  const tooltip = screen.getByRole('tooltip')
  expect(tooltip.parentElement).toBe(document.body)
  expect(view.container.contains(anchor)).toBe(true)
  expect(view.container.contains(tooltip)).toBe(false)
  view.unmount()
  expect(screen.queryByRole('tooltip')).toBeNull()
})
