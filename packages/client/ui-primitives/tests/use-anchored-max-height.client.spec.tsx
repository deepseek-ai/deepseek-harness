// @vitest-environment jsdom
/**
 * `useAnchoredMaxHeight` clamps a bottom-anchored overlay to the space above
 * its bottom edge, keeping a 12px viewport margin that widens to the frame's
 * published `--dsh-frame-top-clearance` (the macOS window strip).
 */
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useAnchoredMaxHeight } from '../src/useAnchoredMaxHeight.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.documentElement.style.removeProperty('--dsh-frame-top-clearance')
})

/** Render the hook against an element whose bottom edge sits at `bottom`. */
function Probe({ cap, margin }: { cap: number; margin?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const maxHeight = useAnchoredMaxHeight(ref, cap, 0, margin)
  return <div ref={ref} data-testid="probe" data-max-height={maxHeight} />
}

/** Pin jsdom's zero-size layout to a fixed bottom edge. */
function stubBottom(bottom: number): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, bottom - 100, 200, 100),
  )
}

describe('useAnchoredMaxHeight', () => {
  it('clamps to the space above the bottom edge minus the 12px margin', () => {
    stubBottom(300)
    const { getByTestId } = render(<Probe cap={400} />)
    expect(getByTestId('probe').dataset.maxHeight).toBe('288')
  })

  it('widens the margin to the frame top clearance when published', () => {
    document.documentElement.style.setProperty('--dsh-frame-top-clearance', '48px')
    stubBottom(300)
    const { getByTestId } = render(<Probe cap={400} />)
    expect(getByTestId('probe').dataset.maxHeight).toBe('252')
  })

  it('keeps a caller-raised margin over a published smaller clearance', () => {
    document.documentElement.style.setProperty('--dsh-frame-top-clearance', '48px')
    stubBottom(300)
    const { getByTestId } = render(<Probe cap={400} margin={84} />)
    expect(getByTestId('probe').dataset.maxHeight).toBe('216')
  })

  it('never exceeds the design cap', () => {
    stubBottom(300)
    const { getByTestId } = render(<Probe cap={100} />)
    expect(getByTestId('probe').dataset.maxHeight).toBe('100')
  })
})
