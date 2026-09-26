// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import {
  PendingQuestion, planReviewOf, type QuestionComposerProps, type QuestionWait,
} from '../src/client/contract/slots.ts'
import { createQuestionDraftStore } from '../src/client/draft-store.ts'
import { QuestionComposer } from '../src/client/QuestionComposer.tsx'
import { en, zh } from '../src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// Every session-scope fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)


const SID = 's1' as SessionId

const seatOver = (dict: Record<string, string>, common: Record<string, string>): QuestionComposerProps['t'] =>
  (key => dict[key] ?? common[key] ?? key)

type SessionState = Parameters<Parameters<QuestionComposerProps['useSession']>[0]>[0]
type ConversationState = Parameters<Parameters<QuestionComposerProps['useConversation']>[0]>[0]
type ChatState = Parameters<Parameters<QuestionComposerProps['useChat']>[0]>[0]
type TrajectoryState = Parameters<Parameters<QuestionComposerProps['useTrajectory']>[0]>[0]
type InputState = Parameters<Parameters<QuestionComposerProps['useInput']>[0]>[0]
type AttentionState = Parameters<Parameters<QuestionComposerProps['useSessionStatus']>[0]>[0]

const sessionState: SessionState = {
  sessionId: SID,
  pendingSubmissions: [],
  running: false,
  subagent: null,
  removed: false,
  openState: 'open',
  openError: null,
  hasMore: false,
  loadingOlder: false,
  promptError: null,
  blank: false,
  lastAgentError: null,
  promptAttempted: false,
  awaitingFirstTurn: false,
}
const sessionList = {
  ids: [SID],
  byId: { [SID]: { id: SID, displayTitle: 'Session', running: false, retainedBy: {}, blank: false, updatedAt: 0 } },
  phase: 'ready' as const,
  projectionsBySession: {},
}
const attentionState: AttentionState = new Map()
const workspaceState = {
  items: [],
  archivedSessionIds: [],
  pinnedSessionIds: [],
  state: 'idle' as const,
  phase: 'ready' as const,
  error: null,
}
const conversationState: ConversationState = {
  views: { get: () => undefined, grouped: () => undefined },
  activeTargets: new Set(),
}
const emptyKeys: readonly string[] = []
const emptyNodeSource = { getSnapshot: () => undefined, subscribe: () => () => {} }
const chatState: ChatState = {
  order: emptyKeys,
  nodes: {
    get: () => undefined,
    source: () => emptyNodeSource,
    turnDataSource: () => { throw new Error('unused') },
    processSource: () => emptyNodeSource,
    values: () => [],
  },
  locations: { getTurn: () => emptyKeys, getStep: () => emptyKeys },
  navigation: { items: () => [] },
  timeline: { turnOrder: [], turns: new Map() },
  legacy: {
    nodes: [],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
  },
}
const trajectoryState: TrajectoryState = {
  eventNodes: [],
  eventLocations: new Map(),
  requests: [],
  callSchemas: new Map(),
  partial: null,
  runningCalls: [],
}
const inputState: InputState = {
  draft: '',
  attachmentIds: [],
  draftRev: 0,
  phase: 'plain',
  occurrences: [],
  queue: [],
}

const questionDraftStore = createQuestionDraftStore().create(SID)

/** Framework standard-kit stubs: the panel consumes only the locale seat. */
const kit: Omit<QuestionComposerProps, 'matched'> = {
  renderSlot: () => null,
  SessionProvider: ({ children }) => children,
  sessionId: SID,
  session: undefined,
  pendingInteraction: undefined,
  useSession: selector => selector(sessionState),
  useSessions: selector => selector(sessionList),
  usePanelInfo, useResource,
  useSessionStatus: selector => selector(attentionState),
  useSessionRetainInfo: () => undefined,
  useWorkspaces: selector => selector(workspaceState),
  useConversation: selector => selector(conversationState),
  useChat: selector => selector(chatState),
  useTrajectory: selector => selector(trajectoryState),
  useProjection: (() => undefined),
  useInput: selector => selector(inputState),
  inputActions: {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
    insertText: () => false,
    setDraft: () => { throw new Error('unused') },
    addAttachments: () => { throw new Error('unused') },
    removeAttachment: () => { throw new Error('unused') },
    pruneAttachments: () => { throw new Error('unused') },
    submit: () => { throw new Error('unused') },
  },
  useStore: selector => selector(questionDraftStore.getSnapshot()),
  actions: questionDraftStore.actions,
  t: seatOver(zh, commonZh),
}

const PLAN = '# Ship the picker\n\n- read the store\n- render the rows\n'

/** The plan-mode request shape: one question, the plan as detail, approve named. */
const questions = (): QuestionWait['questions'] => [{
  id: 'plan-review',
  header: 'Plan review',
  question: 'Approve this plan and leave plan mode?',
  detail: PLAN,
  options: [
    { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
    { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
  ],
  intent: { kind: 'plan-review', approve: 'Approve' },
}]

/** Pending waterfall fixture with observable Client response methods. */
function wait(items: QuestionWait['questions'] = questions()) {
  const carrier = new PendingQuestion(SID, items)
  const answer = vi.spyOn(carrier, 'answer')
  const cancel = vi.spyOn(carrier, 'cancel')
  void carrier.result.catch(() => {})
  return { carrier, answer, cancel }
}

const decision = (label: string) => ({ answers: [{ id: 'plan-review', selected: [label] }] })

describe('planReviewOf', () => {
  it('narrows a plan-review request to its decision, options included', () => {
    expect(planReviewOf(questions())).toEqual({
      id: 'plan-review',
      question: 'Approve this plan and leave plan mode?',
      plan: PLAN,
      approve: { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
      decline: { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
    })
  })

  it('retains the logged invocation so the review can reopen its exact plan', () => {
    const question = questions()[0]!
    const callId = 'plan-call' as ToolCallId
    const review = planReviewOf([{
      ...question,
      intent: { kind: 'plan-review', approve: 'Approve', callId },
    }])
    expect(review).toEqual({ ...planReviewOf([question]), callId })
  })

  it('leaves the decline absent when the asker offered approve alone', () => {
    const [question] = questions()
    const review = planReviewOf([{ ...question as object, options: [{ label: 'Approve' }] } as never])
    expect(review?.approve).toEqual({ label: 'Approve' })
    expect(review === undefined ? true : 'decline' in review).toBe(false)
  })

  it.each([
    ['a batch of more than one question', () => [...questions(), ...questions()]],
    ['no intent at all', () => [{ ...questions()[0] as object, intent: undefined }]],
    ['an intent without the plan as detail', () => [{ ...questions()[0] as object, detail: undefined }]],
    ['an intent whose approve names no option', () => [{
      ...questions()[0] as object, intent: { kind: 'plan-review', approve: 'Ship it' },
    }]],
    ['an intent with no options at all', () => [{ ...questions()[0] as object, options: undefined }]],
    // Two buttons cannot send a third label or a combination, and the generic
    // flow can: an intent never costs the user a reachable answer.
    ['a third option the card could not offer', () => [{
      ...questions()[0] as object,
      options: [{ label: 'Approve' }, { label: 'Keep planning' }, { label: 'Start over' }],
    }]],
    ['a multi-select decision', () => [{ ...questions()[0] as object, multiSelect: true }]],
  ])('declines %s, leaving the request to the generic flow', (_case, build) => {
    expect(planReviewOf(build() as never)).toBeUndefined()
  })

  it('declines an empty batch, which the generic flow reports as such', () => {
    expect(planReviewOf([])).toBeUndefined()
  })
})

describe('PlanReviewPanel', () => {
  it('passes distinct pending request identities to the preview action for unlogged reviews', () => {
    const rendered = vi.fn<(key: string, owner: unknown) => void>()
    const renderSlot: QuestionComposerProps['renderSlot'] = (key, owner) => { rendered(key, owner); return null }
    const first = wait()
    const second = wait()
    const view = render(<QuestionComposer matched={first.carrier} {...kit} renderSlot={renderSlot} />)
    expect(rendered).toHaveBeenLastCalledWith('conversation.plan-review.actions', {
      review: planReviewOf(first.carrier.questions), requestKey: first.carrier.key,
    })
    view.rerender(<QuestionComposer matched={second.carrier} {...kit} renderSlot={renderSlot} />)
    expect(rendered).toHaveBeenLastCalledWith('conversation.plan-review.actions', {
      review: planReviewOf(second.carrier.questions), requestKey: second.carrier.key,
    })
    expect(first.carrier.key).not.toBe(second.carrier.key)
    expect(first.answer).not.toHaveBeenCalled()
    expect(second.answer).not.toHaveBeenCalled()
  })
  it('shows the plan title and summary above two review actions', () => {
    const { carrier } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(document.querySelector('[data-plan-review-key]')?.getAttribute('data-plan-review-key')).toBe(carrier.key)
    expect(screen.getByText(zh['plan.header'])).toBeTruthy()
    expect(document.querySelector('[data-plan-review-key] [data-state="warning"]')).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Ship the picker' })).toBeTruthy()
    expect(screen.getByText('read the store')).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(screen.queryByText('render the rows')).toBeNull()
    expect(document.querySelector('[data-plan-review-scroll]')).toBeNull()
    // The question text stays as the card's accessible name rather than a title
    // that reads like a test item.
    expect(screen.getByLabelText('Approve this plan and leave plan mode?')).toBeTruthy()
    // No pager, no numbered options, no skip, no custom answer.
    expect(screen.queryByText('1 / 1')).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByText(zh['action.skip'])).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('extracts a plain summary and keeps a heading-only plan compact', () => {
    const question = questions()[0]!
    const detail = '# **Release** plan\n\nReview the [changes](https://example.com) before **shipping**.\n\n## Steps\n- Build'
    const { carrier } = wait([{ ...question, detail }])
    const view = render(<QuestionComposer matched={carrier} {...kit} />)
    expect(screen.getByRole('heading', { name: 'Release plan' })).toBeTruthy()
    expect(screen.getByText('Review the changes before shipping.')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
    const onlyTitle = wait([{ ...question, detail: '# Plan without a summary' }])
    view.rerender(<QuestionComposer matched={onlyTitle.carrier} {...kit} />)
    expect(screen.getByRole('heading', { name: 'Plan without a summary' })).toBeTruthy()
    expect(document.querySelector('[data-plan-review-key] p')).toBeNull()
    const paragraph = wait([{ ...question, detail: 'A single paragraph plan.' }])
    view.rerender(<QuestionComposer matched={paragraph.carrier} {...kit} />)
    expect(screen.getAllByText('A single paragraph plan.')).toHaveLength(1)
  })

  it('answers with the asker\'s approve label and keeps its description as the tooltip', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    const approve = screen.getByRole('button', { name: zh['plan.approve'] })
    expect(approve.getAttribute('title')).toBe('Leave plan mode; the plan is carried out from the next step.')
    fireEvent.click(approve)
    expect(answer).toHaveBeenCalledWith(decision('Approve'))
    expect(document.querySelector('[data-plan-review-key] [data-state="ongoing"]')).not.toBeNull()
    expect(document.querySelector('[data-plan-review-key] section')?.getAttribute('aria-busy')).toBe('true')
    // One-shot: every action locks until the host's resolved frame lands.
    expect(approve.hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: zh['plan.discuss'] }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(approve)
    expect(answer).toHaveBeenCalledTimes(1)
  })


  it('dismisses the request so the composer returns for a plain message', () => {
    const { carrier, cancel, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByRole('button', { name: zh['plan.discuss'] }))
    expect(cancel).toHaveBeenCalledWith()
    expect(answer).not.toHaveBeenCalled()
  })

  it('omits the tooltip for an option carrying no description', () => {
    const { carrier } = wait([{
      ...questions()[0] as object,
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
    }] as never)
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.getByRole('button', { name: zh['plan.approve'] }).hasAttribute('title')).toBe(false)
  })

  it('hides the decline action when the asker offered approve alone', () => {
    const { carrier } = wait([{
      ...questions()[0] as object, options: [{ label: 'Approve' }],
    }] as never)
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.queryByRole('button', { name: zh['plan.decline'] })).toBeNull()
    expect(screen.getByRole('button', { name: zh['plan.approve'] })).toBeTruthy()
  })

  it('re-arms the actions and says why when the decision does not land', async () => {
    const { carrier, answer } = wait()
    answer.mockRejectedValue(new Error('question response rejected: not-pending'))
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByRole('button', { name: zh['plan.approve'] }))
    const failure = await screen.findByText('question response rejected: not-pending')
    expect(failure.getAttribute('role')).toBe('status')
    // Re-armed for the retry: a lost click must not leave a dead card.
    expect(screen.getByRole('button', { name: zh['plan.approve'] }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: zh['plan.approve'] }))
    expect(answer).toHaveBeenCalledTimes(2)
  })

  it('reports a non-Error transport failure as its stringified value', async () => {
    // A non-Error rejection is the case under test: a carrier can reject with
    // anything, and the panel must still show the user something.
    const { carrier, cancel } = wait()
    cancel.mockRejectedValue('socket gone')
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByRole('button', { name: zh['plan.discuss'] }))
    expect(await screen.findByText('socket gone')).toBeTruthy()
  })

  it('carries the same decision surface in English', () => {
    const { carrier } = wait()
    render(<QuestionComposer matched={carrier} {...kit} t={seatOver(en, commonEn)} />)

    expect(screen.getByText('Plan review')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Refuse' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Request changes' })).toBeTruthy()
  })
})
