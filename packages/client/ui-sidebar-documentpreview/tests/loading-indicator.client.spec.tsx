// @vitest-environment jsdom
/** The shared loading status: an icon-only spinner named by its label. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { LoadingIndicator } from '../src/client/LoadingIndicator.tsx'

afterEach(cleanup)

describe('LoadingIndicator', () => {
  it('renders no visible text and carries the label as the accessible name', () => {
    const { getByRole } = render(<LoadingIndicator label="Reading…" />)
    const status = getByRole('status')
    expect(status.textContent).toBe('')
    expect(status.getAttribute('aria-label')).toBe('Reading…')
  })
})
