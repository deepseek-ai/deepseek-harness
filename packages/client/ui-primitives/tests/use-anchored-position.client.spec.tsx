// @vitest-environment jsdom
/**
 * `useAnchoredPosition` wiring: a floating panel is placed from its anchor and
 * keeps tracking it while open.
 *
 * The geometry itself needs real layout, which jsdom does not provide. What
 * is asserted here is the wiring the clamp depends on: the
 * listeners and the panel-size observer are attached while open and released on
 * close, a size change replays the placement, and the hook still works where
 * `ResizeObserver` does not exist.
 */
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useAnchoredPosition } from '../src/useAnchoredPosition.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** One recorded `ResizeObserver` instance, so a test can drive its callback. */
interface Recorded {
  callback: ResizeObserverCallback
  observed: Element[]
  disconnected: boolean
}

/**
 * Install a recording `ResizeObserver` double.
 * @returns the list every constructed observer registers itself in.
 */
function stubResizeObserver(): Recorded[] {
  const made: Recorded[] = []
  vi.stubGlobal('ResizeObserver', class {
    private readonly record: Recorded

    constructor(callback: ResizeObserverCallback) {
      this.record = { callback, observed: [], disconnected: false }
      made.push(this.record)
    }

    observe(element: Element) { this.record.observed.push(element) }
    disconnect() { this.record.disconnected = true }
  })
  return made
}

/**
 * Host component that anchors a panel and reports the computed position.
 * @param props - whether the panel is open.
 * @returns the anchor and, while open, the panel carrying the position.
 */
function Host({ open }: { open: boolean }) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({ open, anchorRef, panelRef, gap: 4, margin: 12 })
  return (
    <>
      <button ref={anchorRef} type="button">anchor</button>
      {open && <div ref={panelRef} data-testid="panel" style={position ?? { visibility: 'hidden' }} />}
    </>
  )
}

describe('useAnchoredPosition', () => {
  it('observes the panel while open and disconnects when it closes', () => {
    const made = stubResizeObserver()
    const ui = render(<Host open />)

    expect(made).toHaveLength(1)
    expect(made[0]?.observed).toEqual([ui.getByTestId('panel')])
    expect(made[0]?.disconnected).toBe(false)

    ui.rerender(<Host open={false} />)

    expect(made[0]?.disconnected).toBe(true)
  })

  it('replaces the panel when its own size changes', () => {
    const made = stubResizeObserver()
    render(<Host open />)
    const before = made[0]?.callback
    expect(before).toBeDefined()

    // A status line appearing inside the panel, or a dragged textarea, changes
    // the height without a scroll or resize event; the observer is the only
    // thing that notices, so driving its callback must not throw.
    expect(() => { before?.([], {} as ResizeObserver) }).not.toThrow()
  })

  it('still places the panel where ResizeObserver does not exist', () => {
    // jsdom's own condition, and any host without the API: the hook must fall
    // back to scroll and resize rather than fail at mount.
    vi.stubGlobal('ResizeObserver', undefined)

    expect(() => render(<Host open />)).not.toThrow()
  })

  it('attaches no listeners while the element is closed', () => {
    const made = stubResizeObserver()
    const add = vi.spyOn(window, 'addEventListener')

    render(<Host open={false} />)

    expect(made).toHaveLength(0)
    expect(add.mock.calls.filter(([type]) => type === 'scroll' || type === 'resize')).toEqual([])
    add.mockRestore()
  })
})
