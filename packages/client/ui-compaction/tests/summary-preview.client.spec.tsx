// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import type { DocumentBodyInput } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
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
  const renderFactorySlot = vi.fn((_slot: string, input: DocumentBodyInput) => {
    input.scrollportRef(null)
    return createElement('p', null, 'Rendered summary')
  })
  const props = { t, useTabInfo, useResource: () => ({ value: { markdown: '# Heading\n' } }), renderFactorySlot }
  const view = render(<><SummaryTitle t={t as never} />{createElement(SummaryPreview, props as never)}</>)
  expect(view.getByText('preview.title')).toBeTruthy()
  expect(view.getByRole('region').textContent).toBe('Rendered summary')
  expect(renderFactorySlot).toHaveBeenCalledWith('sidebar.right.document.body', expect.objectContaining({
    rendererId: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown', resourceAddress: address,
    content: { kind: 'text', text: '# Heading\n', eof: true, pages: [{ offset: 1, text: '# Heading', lines: 1 }] },
  }))
})
