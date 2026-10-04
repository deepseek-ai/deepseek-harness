// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextShimmer } from '../src/TextShimmer.tsx'

afterEach(cleanup)

describe('TextShimmer', () => {
  it('retains a string child as its activity and text change', () => {
    const view = render(<TextShimmer active>Reading</TextShimmer>)
    const text = view.getByText('Reading')
    expect(view.container.textContent).toBe('Reading')
    expect(view.container.querySelectorAll('[data-shimmer="true"]')).toHaveLength(1)

    view.rerender(<TextShimmer active={false}>Read</TextShimmer>)
    expect(view.getByText('Read')).toBe(text)
    expect(view.container.querySelector('[data-shimmer]')).toBeNull()
    expect(view.container.querySelector('[inert]')).toBeNull()
  })

  it('retains text and controls while nested fragments share one inert decoration', () => {
    const open = vi.fn()
    const row = (active: boolean, title: string) => (
      <TextShimmer active={active}>
        <TextShimmer>{title}</TextShimmer>
        <button type="button" onClick={open}><TextShimmer>file.ts</TextShimmer></button>
      </TextShimmer>
    )
    const view = render(row(true, 'Read'))
    const title = view.getByText('Read')
    const button = view.getByRole('button', { name: 'file.ts' })
    const decoration = view.container.querySelector('[inert]')!
    expect(decoration.getAttribute('aria-hidden')).toBe('true')
    expect(view.container.querySelectorAll('[inert]')).toHaveLength(1)
    expect([...decoration.querySelectorAll('[data-shimmer-text]')].map(node => node.getAttribute('data-shimmer-text')))
      .toEqual(['Read', 'file.ts'])
    expect(view.container.textContent).toBe('Readfile.ts')
    fireEvent.click(button)
    expect(open).toHaveBeenCalledOnce()

    view.rerender(row(true, 'Reading'))
    expect(view.getByText('Reading')).toBe(title)
    expect(view.getByRole('button', { name: 'file.ts' })).toBe(button)
    expect(view.container.querySelector('[inert]')).toBe(decoration)

    view.rerender(row(false, 'Read'))
    expect(view.getByText('Read')).toBe(title)
    expect(view.getByRole('button', { name: 'file.ts' })).toBe(button)
    expect(view.container.querySelector('[inert]')).toBeNull()
  })
})
