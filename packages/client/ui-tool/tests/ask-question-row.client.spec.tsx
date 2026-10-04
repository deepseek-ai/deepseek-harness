// @vitest-environment jsdom
/**
 * ask_user_question toolview acceptance: `waiting` summary while running,
 * answered-count from the result JSON once settled (skipped answers
 * excluded), the same reading for a call a late reply answered, readable
 * question lists for ASK_CANCELLED and ASK_ABORTED, the still-answerable
 * row's reopen action and its closed counterpart, shared ToolRow state
 * semantics for interrupted/failed calls, and generic fallbacks on malformed
 * results.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallBlock, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
// Export discipline: packages/client/AGENTS.md.
import { AskQuestionRow, askQuestionToolview } from '../src/client/tool/toolviews/ask-question-row.tsx'
import type { UserQuestionPanels } from '../src/client/contract/slots.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'

afterEach(cleanup)

const ARGS = JSON.stringify({ questions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })
const READABLE_ARGS = JSON.stringify({ questions: [
  { id: 'goal', question: 'What do you want to accomplish?' },
  { id: 'scope', question: 'Which project should this apply to?' },
  { id: 'notes', question: 'Anything else?' },
] })
const PENDING_RESULT = JSON.stringify({ pending: true, callId: 'c1' })

const resultNode = (argsRaw: string, resultText: string | null, over?: Partial<ToolResultNode>): ToolResultNode => {
  const call = over?.call === undefined ? { name: 'ask_user_question', argsRaw } : over.call
  return {
    kind: 'tool-result', seq: 10, time: 2_000, callTime: 1_000, callId: 'c1',
    name: call?.name ?? '', args: call === null ? PartialArguments.EMPTY : PartialArguments.fromText(call.argsRaw),
    call,
    content: resultText === null ? [] : [{ type: 'text', text: resultText }],
    isError: false, subCalls: [], ...over,
  }
}

const runningCall = (argsRaw: string): ToolCallBlock =>
  ({ phase: 'start', args: PartialArguments.fromText(argsRaw), callId: 'c1', name: 'ask_user_question', argsRaw, turn: 1, step: 1, time: 1_000, subCalls: [] })

const t = makeTranslate(zh, commonZh)

/** What the row's environment says about the call, beyond the recorded block. */
interface RowEnvironment {
  /** Call ids the `userQuestions` projection still lists as answerable; absent = none. */
  answerable?: readonly string[]
  /** Answer batches the projection settled a late reply with, by call id; absent = none. */
  settled?: Readonly<Record<string, readonly unknown[]>>
  /** Pending steers mirrored by the durable Inbox projection. */
  inbox?: { readonly 'next-turn': readonly unknown[]; readonly 'next-step': readonly unknown[] }
  /** The injected reopen verb; absent = a panel is always there to show. */
  revealPanel?: (callId: string) => boolean
  /** The injected read-only verb; absent = a provider is always there. */
  reviewPanel?: (callId: string, record: unknown) => boolean
}

function rowProps(block: ToolCallBlock, env: RowEnvironment = {}): Parameters<typeof AskQuestionRow>[0] {
  const view = {
    active: (env.answerable ?? []).map(callId => ({ callId })),
    settled: Object.entries(env.settled ?? {}).map(([callId, answers]) => ({ callId, answers })),
  }
  const useProjection = (key: string, select: (value: unknown) => unknown) =>
    select(key === 'inbox' ? env.inbox : view)
  const props = {
    useDisclosure, callId: 'c1', toolName: 'ask_user_question', t,
    ...('kind' in block ? { phase: 'result', block } : { phase: block.phase, block }),
    openFile: vi.fn(),
    loadImage: vi.fn(async () => ''),
    sessionId: 's1' as SessionId,
    useSession: vi.fn(),
    useSessions: () => undefined,
    useProjection,
    revealPanel: env.revealPanel ?? (() => true),
    reviewPanel: env.reviewPanel ?? (() => true),
  } as Parameters<typeof AskQuestionRow>[0]
  return props
}

const answers = (entries: unknown[]): string => JSON.stringify({ answers: entries })

const queuedReply = (callId: string, entries: unknown[]): unknown => ({
  source: { kind: 'user-question-reply', callId, outcome: 'answered' },
  content: [{ type: 'text', text: JSON.stringify({
    kind: 'answer_to_pending_question', tool: 'ask_user_question', callId, answers: entries,
  }) }],
})

/** Every pill the row can offer, by its visible copy. */
const PILL = { reopen: '回答', review: '查看回答' } as const

/** The panel verbs the registered toolview hands each row of one Session. */
interface PanelFace {
  revealPanel: (callId: string) => boolean
  reviewPanel: (callId: string, record: unknown) => boolean
}

/** The keyed toolview declaration, as far as this spec reads it. */
interface ToolviewDeclaration {
  inject?: (sessionId: string) => PanelFace
}

/** The optional panel provider, as far as this spec calls it. */
type PanelProvider = UserQuestionPanels

/**
 * Apply the plugin against a fake root and return the face it injects into a
 * row of Session `s1`.
 * @param get - the root's optional-service lookup.
 * @returns the injected panel verbs.
 */
function injectedFace(get: (name: string) => PanelProvider | undefined): PanelFace {
  let declaration: ToolviewDeclaration | undefined
  askQuestionToolview.apply({
    get,
    slots: {
      inject: (_name: string, callback: () => () => void) => callback(),
      register: (declared: ToolviewDeclaration) => {
        declaration = declared
        return () => undefined
      },
    },
  } as never)
  const face = declaration?.inject?.('s1')
  if (face === undefined) throw new Error('the toolview registered no injected face')
  return face
}

describe('AskQuestionRow', () => {
  it('running call reads waiting (args-independent: the composer takeover shows the questions)', () => {
    const view = render(<AskQuestionRow {...rowProps(runningCall(ARGS))} />)
    expect(screen.getByText('提问')).toBeTruthy()
    expect(screen.getByText('等待回答')).toBeTruthy()
    expect(view.container.querySelector('[data-state="running"]')).not.toBeNull()
  })

  it('a running call the projection still lists offers its panel from the row body', () => {
    const revealPanel = vi.fn(() => true)
    render(<AskQuestionRow {...rowProps(runningCall(ARGS), { answerable: ['c1'], revealPanel })} />)

    fireEvent.click(screen.getByRole('button', { name: PILL.reopen }))
    expect(revealPanel).toHaveBeenCalledWith('c1')
  })

  it('a pending row keeps the disclosure on its leading glyph while the body reopens the panel', () => {
    const revealPanel = vi.fn(() => true)
    const view = render(<AskQuestionRow {...rowProps(
      resultNode(READABLE_ARGS, PENDING_RESULT),
      { answerable: ['c1'], revealPanel },
    )} />)

    expect(view.container.querySelector('[data-disclosure-row]')?.getAttribute('role')).toBeNull()

    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
    expect(revealPanel).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: PILL.reopen }))
    expect(revealPanel).toHaveBeenCalledWith('c1')
    // Reopening is not a disclosure: the body the user already opened stays open.
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
  })

  it('shows a queued steer as a read-only submitted answer before it is admitted', () => {
    const reviewPanel = vi.fn(() => true)
    const revealPanel = vi.fn(() => true)
    const batch = [
      { id: 'goal', selected: ['Develop a feature'] },
      { id: 'scope', selected: [], custom: 'the web app' },
      { id: 'notes', selected: [] },
    ]
    render(<AskQuestionRow {...rowProps(
      resultNode(READABLE_ARGS, PENDING_RESULT),
      {
        answerable: ['c1'],
        inbox: { 'next-step': [queuedReply('other', batch), queuedReply('c1', batch)], 'next-turn': [] },
        revealPanel, reviewPanel,
      },
    )} />)

    expect(screen.getByText('2/3 已回答')).toBeTruthy()
    expect(screen.queryByRole('button', { name: PILL.reopen })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: PILL.review }))
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
    expect(screen.getByText('the web app')).toBeTruthy()
    expect(reviewPanel).not.toHaveBeenCalled()
    expect(revealPanel).not.toHaveBeenCalled()
  })

  it('returns to the answer action if the pending steer is removed', () => {
    const block = resultNode(READABLE_ARGS, PENDING_RESULT)
    const batch = [
      { id: 'goal', selected: ['Develop a feature'] },
      { id: 'scope', selected: [] },
      { id: 'notes', selected: [] },
    ]
    const view = render(<AskQuestionRow {...rowProps(block, {
      answerable: ['c1'], inbox: { 'next-step': [], 'next-turn': [queuedReply('c1', batch)] },
    })} />)
    expect(screen.getByRole('button', { name: PILL.review })).toBeTruthy()

    view.rerender(<AskQuestionRow {...rowProps(block, {
      answerable: ['c1'], inbox: { 'next-step': [], 'next-turn': [] },
    })} />)
    expect(screen.getByRole('button', { name: PILL.reopen })).toBeTruthy()
    expect(screen.queryByRole('button', { name: PILL.review })).toBeNull()
  })

  it('does not lock a question for an unrelated or malformed queued message', () => {
    const bad = { source: { kind: 'user-question-reply', callId: 'c1' }, content: [
      { type: 'text', text: JSON.stringify({ kind: 'wrong', callId: 'c1', answers: [] }) },
    ] }
    render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, PENDING_RESULT), {
      answerable: ['c1'], inbox: { 'next-step': [queuedReply('other', [])], 'next-turn': [bad] },
    })} />)
    expect(screen.getByRole('button', { name: PILL.reopen })).toBeTruthy()
    expect(screen.queryByRole('button', { name: PILL.review })).toBeNull()
  })

  it('keyboard activation of the pill leaves the row disclosure closed', () => {
    // The pill is a button inside the row's own button: without the keydown
    // guard, one Enter would both reopen the panel and expand the record.
    const revealPanel = vi.fn(() => true)
    render(<AskQuestionRow {...rowProps(
      resultNode(READABLE_ARGS, PENDING_RESULT),
      { answerable: ['c1'], revealPanel },
    )} />)
    fireEvent.keyDown(screen.getByRole('button', { name: PILL.reopen }), { key: 'Enter' })
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy()
  })

  it('a reopen that finds no panel left expands the record instead of doing nothing', () => {
    // The projection lists the call but no card answers for it — a resumed
    // Session before its repair pass, or a composition with no question UI.
    const revealPanel = vi.fn(() => false)
    render(<AskQuestionRow {...rowProps(
      resultNode(READABLE_ARGS, PENDING_RESULT),
      { answerable: ['c1'], revealPanel },
    )} />)

    fireEvent.click(screen.getByRole('button', { name: PILL.reopen }))
    expect(revealPanel).toHaveBeenCalledWith('c1')
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
    expect(screen.getByText('What do you want to accomplish?')).toBeTruthy()
  })

  it('a pending result the projection dropped reads as closed, with no action on its row', () => {
    // The recorded result stays `pending` after the reply, the skip, or the
    // timeout lands; the projection is what says the question is over.
    render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, PENDING_RESULT))} />)

    expect(screen.getByText('已结束')).toBeTruthy()
    expect(screen.queryByRole('button', { name: PILL.reopen })).toBeNull()
    expect(screen.queryByRole('button', { name: PILL.review })).toBeNull()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('该问题已结束，结果见下方对话')).toBeTruthy()
    expect(screen.getByText('What do you want to accomplish?')).toBeTruthy()
    expect(screen.queryByText(/"pending"/)).toBeNull()
  })

  it('reopens a crash-repaired question while the projection still lists it', () => {
    const revealPanel = vi.fn(() => true)
    const repaired = resultNode(READABLE_ARGS, 'The tool call was interrupted after it was recorded.', {
      isError: true, error: { name: 'SessionFormatError', code: 'TOOL_OUTCOME_UNKNOWN' },
    })
    render(<AskQuestionRow {...rowProps(repaired, { answerable: ['c1'], revealPanel })} />)

    expect(screen.getByText('已继续工作，仍可回答')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: PILL.reopen }))
    expect(revealPanel).toHaveBeenCalledWith('c1')
  })

  it('shows a late answer after crash repair through the read-only panel', () => {
    const reviewPanel = vi.fn(() => true)
    const batch = [
      { id: 'goal', selected: ['Develop a feature'] },
      { id: 'scope', selected: [], custom: 'the web app' },
      { id: 'notes', selected: [] },
    ]
    const repaired = resultNode(READABLE_ARGS, 'The tool call was interrupted after it was recorded.', {
      isError: true, error: { name: 'SessionFormatError', code: 'TOOL_OUTCOME_UNKNOWN' },
    })
    render(<AskQuestionRow {...rowProps(repaired, { settled: { c1: batch }, reviewPanel })} />)

    expect(screen.getByText('2/3 已回答')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: PILL.review }))
    expect(reviewPanel).toHaveBeenCalledWith('c1', expect.objectContaining({ answers: batch }))
  })

  it('shows an unreadable late reply after crash repair as closed', () => {
    const reviewPanel = vi.fn(() => true)
    const repaired = resultNode(READABLE_ARGS, 'The tool call was interrupted after it was recorded.', {
      isError: true, error: { name: 'SessionFormatError', code: 'TOOL_OUTCOME_UNKNOWN' },
    })
    render(<AskQuestionRow {...rowProps(repaired, { settled: { c1: [] }, reviewPanel })} />)

    expect(screen.getByText('已结束')).toBeTruthy()
    expect(screen.queryByRole('button', { name: PILL.review })).toBeNull()
    expect(reviewPanel).not.toHaveBeenCalled()
  })

  it('a late reply makes its row read exactly like one answered in time', () => {
    // The timed call's own result is the timeout, so the answers come from the
    // projection; which one beat the clock is the agent's pacing, not the
    // reader's problem.
    const reviewPanel = vi.fn(() => true)
    const answered = [
      { id: 'goal', selected: ['Develop a feature'] },
      { id: 'scope', selected: [], custom: 'the web app' },
      { id: 'notes', selected: [] },
    ]
    render(<AskQuestionRow {...rowProps(
      resultNode(READABLE_ARGS, PENDING_RESULT),
      { settled: { c1: answered }, reviewPanel },
    )} />)

    expect(screen.getByText('2/3 已回答')).toBeTruthy()
    expect(screen.queryByText('已结束')).toBeNull()
    expect(screen.queryByRole('button', { name: PILL.reopen })).toBeNull()

    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('What do you want to accomplish?')).toBeTruthy()
    expect(screen.getByText('the web app')).toBeTruthy()
    expect(screen.getByText('未回答')).toBeTruthy()
    expect(screen.queryByText(/"pending"/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: PILL.review }))
    expect(reviewPanel).toHaveBeenCalledWith('c1', {
      questions: [
        { id: 'goal', question: 'What do you want to accomplish?' },
        { id: 'scope', question: 'Which project should this apply to?' },
        { id: 'notes', question: 'Anything else?' },
      ],
      answers: answered,
    })
  })

  it('a reply that settled the call without answers leaves the row closed', () => {
    render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, PENDING_RESULT), { settled: { c1: [] } })} />)
    expect(screen.getByText('已结束')).toBeTruthy()
    expect(screen.queryByRole('button', { name: PILL.review })).toBeNull()
    expect(screen.queryByRole('button', { name: PILL.reopen })).toBeNull()
  })

  it('a still-answerable row keeps its reopen pill even after another call was settled', () => {
    render(<AskQuestionRow {...rowProps(
      resultNode(READABLE_ARGS, PENDING_RESULT),
      { answerable: ['c1'], settled: { other: [{ id: 'goal', selected: ['x'] }] } },
    )} />)
    expect(screen.getByRole('button', { name: PILL.reopen })).toBeTruthy()
    expect(screen.queryByRole('button', { name: PILL.review })).toBeNull()
  })

  it('another session question being answered leaves this row alone', () => {
    render(<AskQuestionRow {...rowProps(runningCall(ARGS), { answerable: ['other'] })} />)
    expect(screen.queryByRole('button', { name: PILL.reopen })).toBeNull()
  })

  it('settled result counts answered entries (selected choices or custom text)', () => {
    render(<AskQuestionRow {...rowProps(resultNode(ARGS, answers([
      { id: 'a', selected: ['x'] },
      { id: 'b', selected: [], custom: 'freeform' },
      { id: 'c', selected: ['y', 'z'], custom: '' },
    ])))} />)
    expect(screen.getByText('3/3 已回答')).toBeTruthy()
  })

  it('shows a pending result as readable still-answerable questions', () => {
    const view = render(<AskQuestionRow {...rowProps(
      resultNode(READABLE_ARGS, PENDING_RESULT),
      { answerable: ['c1'] },
    )} />)

    expect(screen.getByText('已继续工作，仍可回答')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('等待中的问题仍可在输入框中回答')).toBeTruthy()
    expect(screen.getByText('What do you want to accomplish?')).toBeTruthy()
    expect(view.container.querySelector('[class*="ioCard"]')).toBeNull()
    expect(screen.queryByText(/"pending"/)).toBeNull()
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

  it('a timed call the projection settled in time offers its record as a read-only panel, options included', () => {
    const args = JSON.stringify({ questions: [{
      id: 'goal',
      question: 'What do you want to accomplish?',
      header: 'Goal',
      detail: 'Pick the closest match.',
      multi_select: false,
      options: [{ label: 'Develop a feature', description: 'New behavior' }, { label: 'Fix a bug' }],
    }] })
    const reviewPanel = vi.fn(() => true)
    const batch = [{ id: 'goal', selected: ['Fix a bug'] }]
    render(<AskQuestionRow {...rowProps(
      resultNode(args, answers(batch)),
      { settled: { c1: batch }, reviewPanel },
    )} />)

    fireEvent.click(screen.getByRole('button', { name: PILL.review }))
    expect(reviewPanel).toHaveBeenCalledWith('c1', {
      questions: [{
        id: 'goal',
        question: 'What do you want to accomplish?',
        header: 'Goal',
        detail: 'Pick the closest match.',
        multiSelect: false,
        options: [{ label: 'Develop a feature', description: 'New behavior' }, { label: 'Fix a bug' }],
      }],
      answers: batch,
    })
  })

  it('an answered legacy call reads exactly as before timed questions existed: transcript, no pill', () => {
    // The projection never lists a call the blocking legacy tool made, so the
    // row has nothing to reopen and no panel to read the answers back in.
    const view = render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, answers([
      { id: 'goal', selected: ['Develop a feature'] },
      { id: 'scope', selected: [], custom: 'the web app' },
      { id: 'notes', selected: [] },
    ])))} />)

    expect(screen.getByText('2/3 已回答')).toBeTruthy()
    expect(screen.queryByRole('button', { name: PILL.review })).toBeNull()
    expect(screen.queryByRole('button', { name: PILL.reopen })).toBeNull()
    expect(view.container.querySelector('[class*="rowAction"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('the web app')).toBeTruthy()
    expect(screen.getByText('未回答')).toBeTruthy()
  })

  it('a settled call whose questions failed validation keeps only its transcript', () => {
    const batch = [{ id: 'a', selected: ['x'] }]
    render(<AskQuestionRow {...rowProps(resultNode('oops', answers(batch)), { settled: { c1: batch } })} />)
    expect(screen.getByText('1/1 已回答')).toBeTruthy()
    expect(screen.queryByRole('button', { name: PILL.review })).toBeNull()
  })

  it.each([
    { label: 'fewer answers than questions', batch: [{ id: 'goal', selected: ['x'] }] },
    { label: 'an answer to a question never asked', batch: [
      { id: 'goal', selected: ['x'] }, { id: 'scope', selected: [] }, { id: 'other', selected: ['y'] },
    ] },
    { label: 'the same question answered twice', batch: [
      { id: 'goal', selected: ['x'] }, { id: 'goal', selected: ['y'] }, { id: 'notes', selected: [] },
    ] },
  ])('a settled batch with $label offers no panel, like the transcript it cannot pair', ({ batch }) => {
    const reviewPanel = vi.fn(() => true)
    const view = render(<AskQuestionRow {...rowProps(
      resultNode(READABLE_ARGS, answers(batch)),
      { settled: { c1: batch }, reviewPanel },
    )} />)
    expect(screen.queryByRole('button', { name: PILL.review })).toBeNull()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(view.container.querySelector('[class*="ioCard"]')).not.toBeNull()
    expect(reviewPanel).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'a cancelled set', code: 'ASK_CANCELLED' },
    { label: 'an aborted turn', code: 'ASK_ABORTED' },
  ])('$label has no answers to review', ({ code }) => {
    render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, null,
      { isError: true, error: { name: 'UserQuestionError', code } }))} />)
    expect(screen.queryByRole('button', { name: PILL.review })).toBeNull()
    expect(screen.queryByRole('button', { name: PILL.reopen })).toBeNull()
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
    const register = vi.fn((_declaration: ToolviewDeclaration, _view: unknown) => () => undefined)
    const inject = vi.fn((_name: string, callback: () => () => void) => callback())
    askQuestionToolview.apply({ slots: { inject, register }, get: () => undefined } as never)
    expect(inject).toHaveBeenCalledWith('tool.call.toolview', expect.any(Function))
    expect(register).toHaveBeenCalledWith(
      {
        name: 'tool.call.toolview', key: 'ask_user_question', locale: 'conversation',
        inject: expect.any(Function) as ToolviewDeclaration['inject'],
      },
      AskQuestionRow,
    )
  })

  it('the injected reveal verb asks the optional panel provider for the row own session', () => {
    const reveal = vi.fn<UserQuestionPanels['reveal']>(() => true)
    const get = vi.fn((_name: string): PanelProvider => ({
      reveal: (_sessionId, callId) => reveal(_sessionId, callId),
      review: () => false,
    }))
    expect(injectedFace(get).revealPanel('c1')).toBe(true)
    expect(get).toHaveBeenCalledWith('userQuestionPanels')
    expect(reveal).toHaveBeenCalledWith('s1', 'c1')
  })

  it('the injected review verb hands the row own record to the panel provider', () => {
    const review = vi.fn<UserQuestionPanels['review']>(() => true)
    const get = vi.fn((_name: string): PanelProvider => ({
      reveal: () => false,
      review: (_sessionId, callId, value) => review(_sessionId, callId, value),
    }))
    const record = { questions: [], answers: [] }
    expect(injectedFace(get).reviewPanel('c1', record)).toBe(true)
    expect(get).toHaveBeenCalledWith('userQuestionPanels')
    expect(review).toHaveBeenCalledWith('s1', 'c1', record)
  })

  it('a composition with no question UI reports no panel to reveal or review', () => {
    expect(injectedFace(() => undefined).revealPanel('c1')).toBe(false)
    expect(injectedFace(() => undefined).reviewPanel('c1', { questions: [], answers: [] })).toBe(false)
  })
})
