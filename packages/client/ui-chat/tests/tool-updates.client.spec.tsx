// @vitest-environment jsdom
/** Tool updates share the context disclosure while keeping names and counts readable. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ContextInjectionRow } from '../src/client/chat/ContextInjectionRow.tsx'
import { en, zh } from '../src/client/locale.ts'

afterEach(cleanup)

describe.each([
  { locale: 'en', t: makeTranslate(en, commonEn), title: 'Tools updated', summary: '2 added, 1 removed', added: 'Added: search, read_file', removed: 'Removed: old_search' },
  { locale: 'zh', t: makeTranslate(zh, commonZh), title: '工具已更新', summary: '新增 2 个，移除 1 个', added: '新增：search, read_file', removed: '移除：old_search' },
])('tool update disclosure ($locale)', ({ t, title, summary, added, removed }) => {
  it('shows counts collapsed and compact name lists when expanded', () => {
    render(<ContextInjectionRow
      content={[{ type: 'tool-addition', toolName: 'search' }, { type: 'tool-addition', toolName: 'read_file' }, { type: 'tool-removal', toolName: 'old_search' }]}
      source={{ kind: 'tool-registry' }}
      producer={{ role: 'inject', label: 'tool-registry' }}
      form={null}
      t={t}
    />)
    const row = screen.getByRole('button', { name: new RegExp(title) })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText(summary)).toBeTruthy()
    expect(screen.queryByText('tool-registry')).toBeNull()
    fireEvent.click(row)
    expect(screen.getByText(added)).toBeTruthy()
    expect(screen.getByText(removed)).toBeTruthy()
    expect(screen.queryByText(/Active tools:/)).toBeNull()
  })
})

it.each([
  ['tool-addition', 'Tool added: last_tool'],
  ['tool-removal', 'Tool removed: last_tool'],
] as const)('names a single %s without a disclosure', (type, label) => {
  render(<ContextInjectionRow
    content={[{ type, toolName: 'last_tool' }]}
    source={{ kind: 'tool-registry' }}
    producer={{ role: 'inject', label: 'tool-registry' }}
    form={null}
    t={makeTranslate(en, commonEn)}
  />)
  expect(screen.getByText(label)).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  fireEvent.click(screen.getByText(label))
  expect(screen.queryByText(/Active tools:/)).toBeNull()
})
