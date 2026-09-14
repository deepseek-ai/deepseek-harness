// @vitest-environment jsdom
/** Present UI derives statuses and details from durable tool records. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { RunningToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { PresentRow } from '../src/client/PresentRow.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
type Props = Parameters<typeof PresentRow>[0]
const running: RunningToolCall = { callId: 'p', name: 'present', argsRaw: '{"files":[{"path":"report.txt"}]}', turn: 1, step: 1, time: 1, subCalls: [] }
const settled: ToolResultNode = { kind: 'tool-result', seq: 2, time: 2, callId: 'p', call: { name: 'present', argsRaw: running.argsRaw }, callTime: 1, content: [{ type: 'text', text: 'Presented report.txt (4 bytes)' }], isError: false, subCalls: [] }
function props(block: Props['block'], inspect?: () => void): Props {
  return { block, callId: 'p', toolName: 'present', openFile: vi.fn(), inspect, t: makeTranslate(en) } as Props
}

it('discloses the saved result and offers call inspection', () => {
  const inspect = vi.fn()
  const view = render(<PresentRow {...props(settled, inspect)} />)
  expect(view.getByText('Delivered')).toBeTruthy()
  expect(view.getByText('report.txt')).toBeTruthy()
  expect(view.queryByText('Presented report.txt (4 bytes)')).toBeNull()
  const row = view.getByRole('button')
  fireEvent.keyDown(row, { key: 'Enter' })
  expect(view.getByText('Presented report.txt (4 bytes)')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Inspect call' }))
  expect(inspect).toHaveBeenCalledOnce()
  fireEvent.click(row)
  expect(row.getAttribute('aria-expanded')).toBe('false')
})

it.each([
  [running, 'running', 'Delivering'],
  [{ ...settled, isError: true }, 'error', 'Delivery failed'],
  [{ ...settled, error: { name: 'Interrupted', code: 'interrupted' } }, 'stopped', 'Interrupted'],
] as const)('renders call lifecycle without claiming failed delivery', (block, state, label) => {
  const view = render(<PresentRow {...props(block)} />)
  expect(view.container.querySelector('[data-tool="present"]')?.getAttribute('data-state')).toBe(state)
  expect(view.getByText(label)).toBeTruthy()
  expect(view.queryByText('Delivered')).toBeNull()
})

it.each(['', '{', 'null', '[]', '{"files":null}', '{"files":[null,{},1,{"path":false},{"path":"good.txt"}]}'])('tolerates partial arguments %s', (argsRaw) => {
  const view = render(<PresentRow {...props({ ...running, argsRaw })} />)
  expect(view.getByText('Delivering')).toBeTruthy()
  expect(view.queryByRole('button')).toBeNull()
})

it('shows orphaned error details and non-text results', () => {
  const view = render(<PresentRow {...props({ ...settled, call: null, content: [], isError: true, error: { name: 'Missing', code: 'missing' } })} />)
  fireEvent.click(view.getByRole('button'))
  expect(view.getByText('Missing: missing')).toBeTruthy()
  view.rerender(<PresentRow {...props({ ...settled, content: [{ type: 'reasoning', text: 'Recorded detail' }] })} />)
  expect(view.container.textContent).toContain('Recorded detail')
  view.rerender(<PresentRow {...props({ ...settled, content: [] })} />)
  expect(view.queryByRole('button')).toBeNull()
})
