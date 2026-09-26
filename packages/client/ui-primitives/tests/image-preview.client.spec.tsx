// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ImagePreview } from '../src/ImagePreview.tsx'

afterEach(cleanup)
it('keeps status inside the preview and resets failures when the source changes', () => {
  const props = { src: '/one.png', alt: 'Comparison', loadingLabel: 'Loading image', failedLabel: 'Image unavailable' }
  const { rerender } = render(<ImagePreview {...props} />)
  expect(screen.getByRole('status').textContent).toBe('Loading image')
  fireEvent.error(screen.getByRole('img'))
  expect(screen.getByRole('status').textContent).toBe('Image unavailable')
  expect(screen.queryByRole('img')).toBeNull()
  rerender(<ImagePreview {...props} src="/two.png" />)
  expect(screen.getByRole('status').textContent).toBe('Loading image')
  fireEvent.load(screen.getByRole('img'))
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
})
