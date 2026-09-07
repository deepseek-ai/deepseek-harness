// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

const TONES = ['outline', 'solid', 'neutral', 'quiet', 'success', 'info', 'warning', 'danger'] as const

describe('Tag', () => {
  it('renders its caller-owned copy in a non-interactive span', () => {
    render(<Tag>Built-in</Tag>)
    const tag = screen.getByText('Built-in')
    expect(tag.tagName).toBe('SPAN')
    expect(tag.closest('button')).toBeNull()
  })

  it.each(TONES)('carries tone %s as data-tone', (tone) => {
    const { container } = render(<Tag tone={tone}>label</Tag>)
    const tag = container.firstElementChild as HTMLElement
    expect(tag.dataset['tone']).toBe(tone)
  })

  it('defaults to the outline tone', () => {
    const { container } = render(<Tag>label</Tag>)
    expect((container.firstElementChild as HTMLElement).dataset['tone']).toBe('outline')
  })

  it('keeps a caller class alongside its own so a render site can place it', () => {
    const { container } = render(<Tag className="placed">label</Tag>)
    const tag = container.firstElementChild as HTMLElement
    expect(tag.classList.contains('placed')).toBe(true)
    expect(tag.classList.length).toBeGreaterThan(1)
  })

  it('rejects unknown tones at the type level', () => {
    const bad = (tone: TagTone) => tone
    // @ts-expect-error 'muted' is not one of the eight tones
    expect(bad('muted')).toBe('muted')
  })
})
