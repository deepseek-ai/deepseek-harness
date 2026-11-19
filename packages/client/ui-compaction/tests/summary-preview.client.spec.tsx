// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { SummaryPreview, SummaryTitle } from '../src/client/SummaryPreview.tsx'

afterEach(cleanup)

const address = 'dsh-resource://compaction/s/5'
const t = (key: string) => key
const useTabInfo = () => ({ tab: { contentId: address } })

it.each([
  ['loading', undefined, 'status', 'preview.loading'],
  ['none', undefined, 'alert', 'preview.notFound'],
  ['failed', 'compaction-summary/not-found', 'alert', 'preview.notFound'],
  ['failed', 'compaction-summary/invalid-address', 'alert', 'preview.notFound'],
  ['failed', 'compaction-summary/read-failed', 'alert', 'preview.readFailed'],
] as const)('shows the resource state %s (%s) in the tab', (status, code, role, key) => {
  const props = { t, useTabInfo, useResource: () => ({ status, failure: code === undefined ? undefined : { code } }) }
  const view = render(createElement(SummaryPreview, props as never))
  expect(view.getByRole(role).textContent).toBe(key)
})

it('renders a saved summary using the shared Markdown body and its localized title', () => {
  const renderFactorySlot = vi.fn(() => createElement('p', null, 'Rendered summary'))
  const props = { t, useTabInfo, useResource: () => ({ value: { markdown: '# Heading\n' } }), renderFactorySlot }
  const view = render(<><SummaryTitle t={t as never} />{createElement(SummaryPreview, props as never)}</>)
  expect(view.getByText('preview.title')).toBeTruthy()
  expect(view.container.querySelector('svg[width="16"] [data-file-type-mark]')).toBeTruthy()
  expect(view.getByText('Rendered summary')).toBeTruthy()
  expect(renderFactorySlot).toHaveBeenCalledWith('sidebar.right.content.preview', {
    title: 'preview.title', content: { mediaType: 'text/markdown', text: '# Heading\n' }, useTabInfo,
  })
})
