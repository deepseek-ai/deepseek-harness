// @vitest-environment jsdom
/** Document loading text and compact additional-page feedback. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { LoadingIndicator } from '../src/client/LoadingIndicator.tsx'

afterEach(cleanup)

describe('LoadingIndicator', () => {
  it('shows the localized document status with a larger spinner', () => {
    const { getByRole } = render(<LoadingIndicator label="文档渲染中..." />)
    const status = getByRole('status', { name: '文档渲染中...' })
    expect(status.textContent).toBe('文档渲染中...')
    expect(status.querySelector('svg')?.getAttribute('width')).toBe('28')
  })

  it('keeps additional-page loading compact and accessible', () => {
    const { getByRole } = render(<LoadingIndicator inline label="Reading…" />)
    const status = getByRole('status')
    expect(status.textContent).toBe('')
    expect(status.getAttribute('aria-label')).toBe('Reading…')
    expect(status.querySelector('[data-state="ongoing"]')).not.toBeNull()
  })
})
