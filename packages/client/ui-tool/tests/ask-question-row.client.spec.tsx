// @vitest-environment jsdom
/**
 * ask_user_question toolview acceptance: `waiting` summary while running,
 * answered-count from the result JSON once settled (skipped answers
 * excluded), readable question lists for ASK_CANCELLED and ASK_ABORTED,
 * shared ToolRow state semantics for interrupted/failed calls, and generic
 * fallbacks on malformed results.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
// Export discipline: packages/client/AGENTS.md.
import { AskQuestionRow, askQuestionToolview } from '../src/client/tool/toolviews/ask-question-row.tsx'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'

afterEach(cleanup)

const ARGS = JSON.stringify({ questions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })
const READABLE_ARGS = JSON.stringify({ questions: [
  { id: 'goal', question: 'What do you want to accomplish?' },
  { id: 'scope', question: 'Which project should this apply to?' },
  { id: 'notes', question: 'Anything else?' },
] })

const resultNode = (argsRaw: string, resultText: string | null, over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callTime: 1_000, callId: 'c1',
  call: { name: 'ask_user_question', argsRaw },
  content: resultText === null ? [] : [{ type: 'text', text: resultText }],
  isError: false, subCalls: [], ...over,
})

const runningCall = (argsRaw: string) =>
  ({ phase: 'start' as const, callId: 'c1', name: 'ask_user_question', argsRaw, turn: 1, step: 1, time: 1_000, subCalls: [] })

const t = makeTranslate(zh, commonZh)

function rowProps(block: Parameters<typeof AskQuestionRow>[0]['block']): Parameters<typeof AskQuestionRow>[0] {
  return {
    useDisclosure, callId: 'c1', toolName: 'ask_user_question', ...('kind' in block ? { phase: 'result' as const, block: block } : { phase: block.phase, block: block }), t,
    openFile: vi.fn(),
    sessionId: 's1',
    useSessions: () => undefined,
  } as Parameters<typeof AskQuestionRow>[0]
}

const answers = (entries: unknown[]): string => JSON.stringify({ answers: entries })

describe('AskQuestionRow', () => {
  it('running call reads waiting (args-independent: the composer takeover shows the questions)', () => {
    const view = render(<AskQuestionRow {...rowProps(runningCall(ARGS))} />)
    expect(screen.getByText('提问')).toBeTruthy()
    expect(screen.getByText('等待回答')).toBeTruthy()
    expect(view.container.querySelector('[data-state="running"]')).not.toBeNull()
  })

  it('settled result counts answered entries (selected choices or custom text)', () => {
    render(<AskQuestionRow {...rowProps(resultNode(ARGS, answers([
      { id: 'a', selected: ['x'] },
      { id: 'b', selected: [], custom: 'freeform' },
      { id: 'c', selected: ['y', 'z'], custom: '' },
    ])))} />)
    expect(screen.getByText('3/3 已回答')).toBeTruthy()
  })

  it('expands a successful result as paired questions and readable answer lines', () => {
    render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, answers([
      { id: 'scope', selected: ['deepseek-harness'] },
      { id: 'goal', selected: ['Develop a feature'], custom: 'Keep the API small' },
      { id: 'notes', selected: [] },
    ])))} />)

    fireEvent.click(screen.getByRole('button', { expanded: false }))

    expect(screen.getByText('What do you want to accomplish?')).toBeTruthy()
    expect(screen.getByText('Develop a feature')).toBeTruthy()
    expect(screen.getByText('Keep the API small')).toBeTruthy()
    expect(screen.getByText('Which project should this apply to?')).toBeTruthy()
    expect(screen.getByText('deepseek-harness')).toBeTruthy()
    expect(screen.getByText('Anything else?')).toBeTruthy()
    expect(screen.getByText('未回答')).toBeTruthy()
    expect(screen.queryByText(/"questions"/)).toBeNull()
    expect(screen.queryByText(/"answers"/)).toBeNull()
  })

  it('keeps generic diagnostics when a valid answer result includes a non-text block', () => {
    const resultText = answers([
      { id: 'goal', selected: ['Develop a feature'] },
      { id: 'scope', selected: ['deepseek-harness'] },
      { id: 'notes', selected: [] },
    ])
    const view = render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, resultText, {
      content: [
        { type: 'text', text: resultText },
        { type: 'reasoning', text: 'unexpected diagnostic' },
      ],
    }))} />)

    expect(screen.getByText(READABLE_ARGS)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(view.container.querySelector('[class*="ioCard"]')).not.toBeNull()
    expect(view.container.textContent).toContain('"type": "reasoning"')
    expect(view.container.textContent).toContain('"text": "unexpected diagnostic"')
  })

  it('skipped questions (no selection, no custom) stay out of the answered count', () => {
    const view = render(<AskQuestionRow {...rowProps(resultNode(ARGS, answers([
      { id: 'a', selected: ['x'] },
      { id: 'b', selected: [], custom: '' },
      { id: 'c' },
    ])))} />)
    expect(screen.getByText('1/3 已回答')).toBeTruthy()
    expect(view.container.querySelector('[data-state="ok"]')).not.toBeNull()
  })

  it.each([
    { label: 'non-JSON result text', text: 'oops' },
    { label: 'non-object result root', text: '"str"' },
    { label: 'null result root', text: 'null' },
    { label: 'missing answers array', text: '{"other":1}' },
    { label: 'null answer entries', text: '{"answers":[null]}' },
    { label: 'empty result content', text: null },
  ])('settled result falls back to the generic summary on $label', ({ text }) => {
    render(<AskQuestionRow {...rowProps(resultNode(ARGS, text))} />)
    expect(screen.getByText(ARGS)).toBeTruthy()
  })

  it.each([
    { label: 'missing id', value: { selected: ['x'] } },
    { label: 'non-array selection', value: { id: 'a', selected: 'x' } },
    { label: 'non-string selection', value: { id: 'a', selected: [1] } },
    { label: 'non-string custom text', value: { id: 'a', selected: [], custom: 1 } },
  ])('falls back to generic JSON for a result with $label', ({ value }) => {
    const view = render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, answers([value])))} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(view.container.querySelector('[class*="ioCard"]')).not.toBeNull()
  })

  it.each([
    { label: 'non-JSON args', args: 'oops' },
    { label: 'non-object args', args: '[]' },
    { label: 'missing question array', args: '{}' },
    { label: 'non-object question', args: '{"questions":[null]}' },
    { label: 'non-string question id', args: '{"questions":[{"id":1,"question":"Q"}]}' },
    { label: 'non-string question text', args: '{"questions":[{"id":"a","question":1}]}' },
    { label: 'duplicate question ids', args: '{"questions":[{"id":"a","question":"Q1"},{"id":"a","question":"Q2"}]}' },
    { label: 'different question count', args: '{"questions":[]}' },
  ])('keeps raw details when answer pairing sees $label', ({ args }) => {
    const view = render(<AskQuestionRow {...rowProps(resultNode(args, answers([
      { id: 'a', selected: ['x'] },
    ])))} />)
    expect(screen.getByText('1/1 已回答')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(view.container.querySelector('[class*="ioCard"]')).not.toBeNull()
  })

  it.each([
    { label: 'duplicate answer ids', values: [{ id: 'a', selected: ['x'] }, { id: 'a', selected: ['y'] }] },
    { label: 'unknown answer id', values: [{ id: 'other', selected: ['x'] }] },
  ])('keeps raw details for $label', ({ values }) => {
    const args = JSON.stringify({ questions: values.map((_, index) => ({
      id: String.fromCharCode(97 + index), question: `Question ${String(index + 1)}`,
    })) })
    const view = render(<AskQuestionRow {...rowProps(resultNode(args, answers(values)))} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(view.container.querySelector('[class*="ioCard"]')).not.toBeNull()
  })

  it('user cancellation shows the original questions without raw JSON or an error body', () => {
    // ASK_CANCELLED: the ask_user_question handler's cancel error.
    const view = render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, null,
      { isError: true, error: { name: 'UserQuestionError', code: 'ASK_CANCELLED' } }))} />)
    expect(screen.getByText('已取消')).toBeTruthy()
    expect(view.container.querySelector('[data-state="ok"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('本轮已取消，未提交回答')).toBeTruthy()
    expect(screen.getByText('What do you want to accomplish?')).toBeTruthy()
    expect(screen.getByText('Which project should this apply to?')).toBeTruthy()
    expect(screen.getByText('Anything else?')).toBeTruthy()
    expect(view.container.querySelector('[class*="ioCard"]')).toBeNull()
    expect(screen.queryByText(/"questions"/)).toBeNull()
    expect(screen.queryByText(/the user cancelled ask_user_question/)).toBeNull()
  })

  it('a turn abort shows the original questions with stopped semantics', () => {
    // ASK_ABORTED: the ask handler's turn-abort settlement.
    const view = render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, null,
      { isError: true, error: { name: 'UserQuestionError', code: 'ASK_ABORTED' } }))} />)
    expect(screen.getByText('已中断')).toBeTruthy()
    expect(view.container.querySelector('[data-state="stopped"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('本轮已中断，未提交回答')).toBeTruthy()
    expect(screen.getByText('What do you want to accomplish?')).toBeTruthy()
    expect(view.container.querySelector('[class*="ioCard"]')).toBeNull()
  })

  it.each([
    { label: 'non-JSON args', args: 'oops' },
    { label: 'an empty question set', args: '{"questions":[]}' },
    { label: 'a question without visible text', args: '{"questions":[{"id":"a"}]}' },
  ])('cancelled result keeps raw diagnostics for $label', ({ args }) => {
    const view = render(<AskQuestionRow {...rowProps(resultNode(args, null,
      { isError: true, error: { name: 'UserQuestionError', code: 'ASK_CANCELLED' } }))} />)
    expect(screen.getByText('已取消')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(view.container.querySelector('[class*="ioCard"]')).not.toBeNull()
  })

  it('an interrupted turn reads as stopped, not cancelled', () => {
    const view = render(<AskQuestionRow {...rowProps(resultNode(ARGS, null,
      { isError: true, error: { name: 'Interrupted', code: 'interrupted' } }))} />)
    expect(view.container.querySelector('[data-state="stopped"]')).not.toBeNull()
    expect(view.container.querySelector('[data-state="stopped"] svg')).not.toBeNull()
    expect(screen.queryByText('已取消')).toBeNull()
    expect(screen.getByText(ARGS)).toBeTruthy()
  })

  it('other tool errors keep the generic summary with the error state', () => {
    const view = render(<AskQuestionRow {...rowProps(resultNode(ARGS, null, { isError: true }))} />)
    expect(view.container.querySelector('[data-state="error"]')).not.toBeNull()
    expect(view.container.querySelector('[data-state="error"] svg')).not.toBeNull()
    expect(screen.getByText(ARGS)).toBeTruthy()
  })

  it('window-truncated result (call head lost) falls back to the callId summary', () => {
    render(<AskQuestionRow {...rowProps(resultNode('', null, { call: null }))} />)
    expect(screen.getByText('c1')).toBeTruthy()
  })

  it('leading toggle expands the raw args body', () => {
    render(<AskQuestionRow {...rowProps(resultNode(ARGS, answers([])))} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
  })

  it('askQuestionToolview injects the toolview declaration directly', () => {
    expect(askQuestionToolview.name).toBe('ask-question-toolview')
    expect(askQuestionToolview.inject).toEqual(['slots'])
    const register = vi.fn(() => () => undefined)
    const inject = vi.fn((_name: string, callback: () => () => void) => callback())
    askQuestionToolview.apply({ slots: { inject, register } } as never)
    expect(inject).toHaveBeenCalledWith('tool.call.toolview', expect.any(Function))
    expect(register).toHaveBeenCalledWith(
      { name: 'tool.call.toolview', key: 'ask_user_question', locale: 'conversation' },
      AskQuestionRow,
    )
  })
})
