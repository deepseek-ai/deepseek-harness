// @vitest-environment jsdom
/** Summary tabs display only the Markdown supplied by the current navigation. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { SummaryPreview, SummaryTitle } from '../src/client/SummaryPreview.tsx'
import { harness, t } from './fixtures.client.ts'

afterEach(cleanup)

it('shows the recorded Markdown and names the region after the summary tab', () => {
  const props = harness().props({ revision: 1, params: { summaryMarkdown: '## Recorded summary' } })
  render(<SummaryPreview {...props} t={t} />)
  expect(screen.getByRole('region', { name: 'summary.title' }).contains(
    screen.getByRole('heading', { name: 'Recorded summary', level: 2 }),
  )).toBe(true)
})

it.each([undefined, { line: 1 }])('shows the expired state without summary content', (params) => {
  render(<SummaryPreview {...harness().props({ revision: 1, params })} t={t} />)
  expect(screen.getByRole('status').textContent).toBe('summary.expired')
})

it('uses the localized title and Markdown glyph in the tab strip', () => {
  const { container } = render(<SummaryTitle t={t} />)
  expect(container.textContent).toBe('summary.title')
  expect(container.querySelector('svg[width="16"] [data-file-type-mark]')).toBeTruthy()
})
