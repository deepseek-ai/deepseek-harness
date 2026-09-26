// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TextShimmer } from '../src/TextShimmer.tsx'

afterEach(cleanup)

describe('TextShimmer', () => {
  it('retains its text span across activity, text, and owner-class changes', () => {
    const view = render(<TextShimmer active className="title">Run</TextShimmer>)
    const span = view.getByText('Run')
    expect(span.tagName).toBe('SPAN')
    expect(span.dataset.textShimmer).toBe('true')
    expect(span.classList.contains('title')).toBe(true)
    expect(span.style.getPropertyValue('--dsh-text-shimmer-spread')).toBe('24px')

    view.rerender(<TextShimmer active={false}>End</TextShimmer>)
    expect(view.getByText('End')).toBe(span)
    expect(span.hasAttribute('data-text-shimmer')).toBe(false)
    expect(span.classList.contains('title')).toBe(false)
    expect(span.style.getPropertyValue('--dsh-text-shimmer-spread')).toBe('24px')

    view.rerender(<TextShimmer active>Running</TextShimmer>)
    expect(view.getByText('Running')).toBe(span)
    expect(span.dataset.textShimmer).toBe('true')
    expect(span.style.getPropertyValue('--dsh-text-shimmer-spread')).toBe('56px')
  })

})
