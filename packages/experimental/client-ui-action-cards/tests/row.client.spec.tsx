// @vitest-environment jsdom
/** The process row reads the card title from the recorded arguments and expands only a refused call. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { StartedToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { ProposeRow } from '../src/client/ProposeRow.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
type Props = Parameters<typeof ProposeRow>[0]
const argsRaw = JSON.stringify({ action: 'test_action', title: 'Counter', brief: 'Keep count.', details: {} })
const running: StartedToolCall = { phase: 'start', args: PartialArguments.fromText(argsRaw), callId: 'c', name: 'propose_action', argsRaw, turn: 1, step: 1, time: 1, subCalls: [] }
const settled: ToolResultNode = { kind: 'tool-result', seq: 2, time: 2, callId: 'c', name: 'propose_action', args: PartialArguments.fromText(argsRaw),
  call: { name: 'propose_action', argsRaw }, callTime: 1, content: [{ type: 'text', text: 'Card shown below your answer. Do not restate it. Invite the user.' }], isError: false, subCalls: [] }
function props(block: Props['block'], inspect?: () => void): Props {
  return { ...('kind' in block ? { phase: 'result' as const, block } : { phase: block.phase, block }),
    callId: 'c', toolName: 'propose_action', openFile: vi.fn(), inspect, t: makeTranslate(en) } as Props
}

it('shows a proposed card on one line without exposing the model-facing result', () => {
  const view = render(<ProposeRow {...props(settled)} />)
  expect(view.container.querySelector('[data-tool="propose_action"]')?.getAttribute('data-state')).toBe('ok')
  expect(view.getByText('Proposed')).toBeTruthy()
  expect(view.getByText('Counter')).toBeTruthy()
  expect(view.queryByRole('button')).toBeNull()
  expect(view.container.textContent).not.toContain('Card shown below your answer. Do not restate it. Invite the user.')
})

it('explains a refused call and offers call inspection', () => {
  const inspect = vi.fn()
  const view = render(<ProposeRow {...props({ ...settled, isError: true,
    content: [{ type: 'text', text: 'Error: Load skill test-skill first, then call propose_action.' }, { type: 'reasoning', text: 'hidden' }] }, inspect)} />)
  expect(view.getByText('Not shown')).toBeTruthy()
  const row = view.getByRole('button')
  fireEvent.click(row)
  expect(view.container.querySelector('pre')?.textContent).toBe('Error: Load skill test-skill first, then call propose_action.')
  fireEvent.click(view.getByRole('button', { name: 'Inspect call' }))
  expect(inspect).toHaveBeenCalledOnce()
  fireEvent.click(row)
  expect(row.getAttribute('aria-expanded')).toBe('false')
})

it.each([
  ['preparing', { phase: 'preparing', args: PartialArguments.EMPTY, callId: 'c', name: 'propose_action', turn: 1, step: 1, time: 1, subCalls: [] }, 'Preparing a card'],
  ['running', running, 'Proposing'],
  ['stopped', { ...settled, isError: true, content: [], error: { name: 'Interrupted', code: 'interrupted' } }, 'Interrupted'],
] as const)('renders the %s call stage without claiming a card', (state, block, label) => {
  const view = render(<ProposeRow {...props(block)} />)
  expect(view.container.querySelector('[data-tool="propose_action"]')?.getAttribute('data-state')).toBe(state)
  expect(view.getAllByText(label).length).toBeGreaterThan(0)
  expect(view.queryByText('Proposed')).toBeNull()
  expect(view.queryByRole('button')).toBeNull()
})
