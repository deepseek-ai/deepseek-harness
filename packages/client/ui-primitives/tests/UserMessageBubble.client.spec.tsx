// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { UserMessageBubble } from '../src/UserMessageBubble.tsx'

afterEach(cleanup)

describe('UserMessageBubble', () => {
  it('preserves caller content, attributes, and layout class', () => {
    render(<UserMessageBubble className="owner-layout" role="group" aria-label="answer">
      <dl><dt>Which color?</dt><dd>Blue</dd></dl>
    </UserMessageBubble>)
    const surface = screen.getByRole('group', { name: 'answer' })
    expect(surface.classList.contains('owner-layout')).toBe(true)
    expect(screen.getByText('Which color?').tagName).toBe('DT')
    expect(screen.getByText('Blue').tagName).toBe('DD')
  })

  it('renders a plain surface without additional interaction', () => {
    render(<UserMessageBubble>Plain user text</UserMessageBubble>)
    expect(screen.getByText('Plain user text').tagName).toBe('DIV')
    expect(screen.queryByRole('button')).toBeNull()
  })
})
