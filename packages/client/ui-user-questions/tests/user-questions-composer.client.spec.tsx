// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AskUserQuestionAnswerItem } from '@deepseek-ai/dsh-user-questions/types'
import { createWaterfallRequest, PendingQuestion, type QuestionCardSnapshot, type QuestionComposerProps } from '../src/client/contract/slots.ts'
import { createQuestionDraftStore } from '../src/client/draft-store.ts'
import { QuestionComposer as Composer, parseRecommendedLabel } from '../src/client/QuestionComposer.tsx'
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

/** Framework standard-kit stubs: the composer consumes the locale and draft-store seats;
 *  the composed props type mandates delivery of the rest (framework hooks are
 *  plain stubs per the client testing discipline). */
const kitBase: Omit<QuestionComposerProps, 'matched' | 'useStore' | 'useQuestionCard' | 'actions'> = {
  renderSlot: () => null,
  SessionProvider: ({ children }) => children,
  session: undefined,
  sessionId: SID,
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
    persistDraft: () => { throw new Error('unused') },
    addAttachments: () => { throw new Error('unused') },
    removeAttachment: () => { throw new Error('unused') },
    pruneAttachments: () => { throw new Error('unused') },
    submit: () => { throw new Error('unused') },
  },
  // The seat's key domain is question ∪ common.
  t: seatOver(zh, commonZh),
}

let kit: Omit<QuestionComposerProps, 'matched' | 'useQuestionCard'>
let draftInstance: ReturnType<ReturnType<typeof createQuestionDraftStore>['create']>

function QuestionComposer(props: Omit<QuestionComposerProps, 'useQuestionCard'>) {
  const source = props.matched
  const useQuestionCard = ((_key: string, selector?: (value: QuestionCardSnapshot | undefined) => unknown) => {
    const value = useSyncExternalStore(source.subscribe, source.getSnapshot)
    return selector === undefined ? value : selector(value)
  }) as QuestionComposerProps['useQuestionCard']
  return <Composer {...props} useQuestionCard={useQuestionCard} />
}

beforeEach(() => {
  localStorage.clear()
  const instance = createQuestionDraftStore().create(SID)
  draftInstance = instance
  const useStore: QuestionComposerProps['useStore'] = selector => useSyncExternalStore(
    listener => instance.subscribe(listener),
    () => selector(instance.getSnapshot()),
    () => selector(instance.getSnapshot()),
  )
  kit = { ...kitBase, useStore, actions: instance.actions }
})

const QUESTIONS: PendingQuestion['questions'] = [
  {
    id: 'profile', header: '偏好', question: '选择候选人类型',
    detail: '按当前空缺岗位的优先级选择。',
    options: [
      { label: '工程落地型 (Recommended)', description: '优先工程交付。' },
      { label: '研究潜力型', description: '优先研究能力。' },
    ],
  },
  {
    id: 'detail', question: '补充你的要求',
  },
  {
    id: 'signals', question: '选择重要信号（可多选）', multiSelect: true,
    options: [{ label: '系统设计' }, { label: '代码质量' }, { label: '产品判断' }],
  },
]

/** Pending waterfall fixture with observable Client response methods. */
function wait(questions: PendingQuestion['questions'] = QUESTIONS, deadline?: number) {
  const carrier = new PendingQuestion(SID, questions)
  const request = createWaterfallRequest(deadline, undefined, (channel) => { carrier.detachWaterfall(channel) })
  carrier.attachWaterfall(request.channel)
  const answer = vi.spyOn(carrier, 'answer')
  const dismiss = vi.spyOn(carrier, 'dismiss')
  void request.result.catch(() => {})
  return { carrier, answer, dismiss }
}

const answerBatch = (answers: object[]) => ({ answers })

describe('QuestionComposer', () => {
  it('a blocking request shows no wait status before or after the first edit, exactly as before timed questions', () => {
    // The blocking card never carried a countdown, so there is nothing for a
    // held or frozen label to describe; the header keeps only the question and its two controls.
    const { carrier } = wait()
    const view = render(<QuestionComposer matched={carrier} {...kit} />)
    const status = () => view.container.querySelector('[class*="waitStatus"]')

    expect(status()).toBeNull()
    expect(screen.queryByText('会一直等你回答')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: /工程落地型/ }))
    expect(carrier.snapshot()).toMatchObject({ waitState: 'editing', countdown: undefined })
    expect(status()).toBeNull()
    expect(screen.queryByText('会一直等你回答')).toBeNull()
    expect(screen.queryByRole('button', { name: '慢慢回答' })).toBeNull()
    expect(screen.getByRole('button', { name: '放弃整组问题' })).toBeTruthy()
  })

  it('keeps a recommended default selected without pausing a timed wait', () => {
    const { carrier } = wait(QUESTIONS, Date.now() + 30_000)
    try {
      const view = render(<QuestionComposer matched={carrier} {...kit} />)
      expect(screen.getByRole('radio', { name: /工程落地型/ }).getAttribute('aria-checked')).toBe('true')
      expect(carrier.snapshot().countdown?.running).toBe(true)

      fireEvent.click(screen.getByLabelText('下一题'))
      view.unmount()
      render(<QuestionComposer matched={carrier} {...kit} />)
      expect(carrier.snapshot().countdown?.running).toBe(true)
      expect(screen.getByText('2 / 3')).toBeTruthy()
    } finally {
      carrier.timeout()
    }
  })

  it('treats Enter on an unselected option as submit, without selecting it', () => {
    const { carrier, answer } = wait([{
      id: 'mode', question: 'Which mode?', options: [{ label: 'Alpha' }, { label: 'Beta' }],
    }])
    render(<QuestionComposer matched={carrier} {...kit} />)
    const option = screen.getByRole('radio', { name: 'Alpha' })
    expect(fireEvent.keyDown(option, { key: 'Enter' })).toBe(false)
    expect(option.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('status').textContent).toBe('请先完成这道问题。')
    expect(answer).not.toHaveBeenCalled()
  })

  it('collects single, custom, and multi-select answers before one batch submit', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.getByText('偏好')).toBeTruthy()
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(screen.getByText('推荐')).toBeTruthy()
    expect(screen.getByText('工程落地型')).toBeTruthy()
    expect(screen.getByRole('radio', { name: /工程落地型/ }).getAttribute('aria-checked')).toBe('true')
    const detail = screen.getByText('按当前空缺岗位的优先级选择。')
    const scrollRegion = detail.closest('[data-question-scroll]')
    expect(scrollRegion).toBeTruthy()
    expect(scrollRegion?.contains(screen.getByRole('radio', { name: /工程落地型/ }))).toBe(true)
    expect(scrollRegion?.contains(screen.getByText('下一题').closest('button'))).toBe(false)
    fireEvent.click(screen.getByRole('radio', { name: /工程落地型/ }))

    expect(screen.getByText('2 / 3')).toBeTruthy()
    // detail is per-question: the second question carries none.
    expect(screen.queryByText('按当前空缺岗位的优先级选择。')).toBeNull()
    expect(screen.queryByRole('button', { name: '填写答案' })).toBeNull()
    const custom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.change(custom, { target: { value: '要能独立排查线上问题' } })
    fireEvent.keyDown(custom, { key: 'Enter' })

    expect(screen.getByText('3 / 3')).toBeTruthy()
    // The model's question text renders verbatim — no marker filtering.
    expect(screen.getByText('选择重要信号（可多选）')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '代码质量' }))
    const multiCustom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.change(multiCustom, { target: { value: '沟通能力' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '产品判断' }))
    expect(screen.getByRole('checkbox', { name: '系统设计' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('checkbox', { name: '代码质量' }).getAttribute('aria-checked')).toBe('true')
    expect((multiCustom as HTMLInputElement).value).toBe('沟通能力')
    fireEvent.keyDown(multiCustom, { key: 'Enter' })

    // The domain face encoded the whole batch into one carrier envelope.
    expect(answer).toHaveBeenCalledWith(answerBatch([
      { id: 'profile', selected: ['工程落地型 (Recommended)'] },
      { id: 'detail', selected: [], custom: '要能独立排查线上问题' },
      { id: 'signals', selected: ['系统设计', '代码质量', '产品判断'], custom: '沟通能力' },
    ]))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '正在提交…' }).disabled).toBe(true)
  })

  it('renders plan detail through the shared assistant Markdown primitive', () => {
    const { carrier } = wait([{
      id: 'plan',
      question: '批准这个计划吗？',
      detail: '# 实施计划\n\n- **先验证**现状\n- 修改 `QuestionComposer`',
      options: [{ label: '批准' }],
    }])
    const view = render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.getByRole('heading', { level: 1, name: '实施计划' })).toBeTruthy()
    expect(view.container.querySelector('strong')?.textContent).toBe('先验证')
    expect(view.container.querySelector('code')?.textContent).toBe('QuestionComposer')
    expect(view.container.querySelectorAll('li')).toHaveLength(2)
  })

  it('skips individual questions without discarding earlier answers', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.getByRole('radio', { name: /工程落地型/ }).getAttribute('aria-checked')).toBe('true')
    expect((screen.getByText('下一题').closest('button') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('radio', { name: '研究潜力型' }))
    expect(screen.getByText('2 / 3')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '跳过' }))
    expect(screen.getByText('3 / 3')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '跳过' }))

    expect(answer).toHaveBeenCalledWith(answerBatch([
      { id: 'profile', selected: ['研究潜力型'] },
      { id: 'detail', selected: [] },
      { id: 'signals', selected: [] },
    ]))
  })

  it('keeps IME Enter inside the custom input until composition finishes', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByRole('radio', { name: '研究潜力型' }))
    const custom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.change(custom, { target: { value: '中文输入' } })

    fireEvent.keyDown(custom, { key: 'Enter', isComposing: true })
    expect(screen.getByText('2 / 3')).toBeTruthy()
    expect(answer).not.toHaveBeenCalled()

    fireEvent.keyDown(custom, { key: 'Enter', keyCode: 229 })
    expect(screen.getByText('2 / 3')).toBeTruthy()
    expect(answer).not.toHaveBeenCalled()

    fireEvent.keyDown(custom, { key: 'Enter' })
    expect(screen.getByText('3 / 3')).toBeTruthy()
  })

  it('shows the inline custom input, reports missing answers, and supports pager navigation', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.getByPlaceholderText('输入你的答案')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: '工程落地型' }))
    const emptyCustom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.keyDown(emptyCustom, { key: 'Enter', shiftKey: true })
    expect(screen.getByText('2 / 3')).toBeTruthy()
    fireEvent.keyDown(emptyCustom, { key: 'Enter' })
    expect(screen.getByText('请选择一个选项或填写自定义答案。')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('下一题'))
    fireEvent.click(screen.getByRole('checkbox', { name: '产品判断' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(screen.getByText('请先完成这道问题。')).toBeTruthy()
    expect(screen.getByText('2 / 3')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('上一题'))
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(answer).not.toHaveBeenCalled()
  })

  it('answers over multiple lines: both fields grow with the draft and keep Shift+Enter a newline', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    // Both question shapes answer into a textarea, so the engine soft-wraps a
    // long answer and Shift+Enter breaks the line natively.
    const inline = screen.getByPlaceholderText('输入你的答案')
    expect(inline.tagName).toBe('TEXTAREA')

    const multiline = '第一行\n第二行'
    fireEvent.change(inline, { target: { value: multiline } })
    // The hidden height ruler carries the draft plus the trailing newline the
    // textarea's own last line needs, so the box is as tall as the answer.
    expect(inline.previousElementSibling?.textContent).toBe(`${multiline}\n`)
    // Shift+Enter belongs to the field, never to the flow.
    fireEvent.keyDown(inline, { key: 'Enter', shiftKey: true })
    expect(screen.getByText('1 / 3')).toBeTruthy()

    fireEvent.keyDown(inline, { key: 'Enter' })
    const optionless = screen.getByPlaceholderText('输入你的答案')
    expect(optionless.tagName).toBe('TEXTAREA')
    fireEvent.change(optionless, { target: { value: multiline } })
    expect(optionless.previousElementSibling?.textContent).toBe(`${multiline}\n`)
    fireEvent.keyDown(optionless, { key: 'Enter', shiftKey: true })
    expect(screen.getByText('2 / 3')).toBeTruthy()

    fireEvent.keyDown(optionless, { key: 'Enter' })
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    // Line breaks reach the model verbatim: nothing along the way flattens them.
    expect(answer).toHaveBeenCalledWith(answerBatch([
      { id: 'profile', selected: [], custom: multiline },
      { id: 'detail', selected: [], custom: multiline },
      { id: 'signals', selected: ['系统设计'] },
    ]))
  })

  it('surfaces cancellation failures and re-arms the controls', async () => {
    const { carrier, dismiss } = wait()
    dismiss
      .mockRejectedValueOnce(new Error('第一次取消失败'))
      .mockRejectedValueOnce(new Error('第二次取消失败'))
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByRole('button', { name: '放弃整组问题' }))
    expect(await screen.findByText('第一次取消失败')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '跳过' }).disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '放弃整组问题' }))
    expect(await screen.findByText('第二次取消失败')).toBeTruthy()
  })

  it('surfaces answer rejection and resets local drafts for a different request', async () => {
    const first = wait()
    const view = render(<QuestionComposer matched={first.carrier} {...kit} />)

    fireEvent.click(screen.getByRole('radio', { name: /研究潜力型/ }))
    expect(screen.getByText('2 / 3')).toBeTruthy()
    const second = wait()
    second.answer
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockRejectedValueOnce('字符串错误')
    view.rerender(<QuestionComposer matched={second.carrier} {...kit} />)
    expect(screen.getByRole('radio', { name: /研究潜力型/ }).getAttribute('aria-checked')).toBe('false')

    fireEvent.click(screen.getByRole('radio', { name: /工程落地型/ }))
    const custom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.change(custom, { target: { value: 'x' } })
    fireEvent.keyDown(custom, { key: 'Enter' })
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(second.answer).toHaveBeenNthCalledWith(1, answerBatch([
      { id: 'profile', selected: ['工程落地型 (Recommended)'] },
      { id: 'detail', selected: [], custom: 'x' },
      { id: 'signals', selected: ['系统设计'] },
    ]))
    expect(await screen.findByText('网络中断')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '提交' }).disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(await screen.findByText('字符串错误')).toBeTruthy()
  })

  it('renders chrome copy through the English dictionary', () => {
    const { carrier } = wait([{ id: 'detail', question: '补充你的要求' }])
    render(<QuestionComposer matched={carrier} {...kit} t={seatOver(en, commonEn)} />)
    expect(screen.getByLabelText('Dismiss all questions')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Skip' })).toBeTruthy()
    expect(screen.getByPlaceholderText('Type your answer')).toBeTruthy()
  })

  it('restores the current page and drafts after the strict Session entry remounts', () => {
    const pending = wait()
    const view = render(<QuestionComposer matched={pending.carrier} {...kit} />)
    fireEvent.click(screen.getByRole('radio', { name: /研究潜力型/ }))
    const custom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.change(custom, { target: { value: '保留这段草稿' } })
    expect(screen.getByText('2 / 3')).toBeTruthy()

    view.unmount()
    render(<QuestionComposer matched={pending.carrier} {...kit} />)

    expect(screen.getByText('2 / 3')).toBeTruthy()
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>('输入你的答案').value).toBe('保留这段草稿')
    fireEvent.click(screen.getByLabelText('上一题'))
    expect(screen.getByRole('radio', { name: /研究潜力型/ }).getAttribute('aria-checked')).toBe('true')
  })
})

describe('PendingQuestion domain face', () => {
  it('exposes its Client render identity and scoped request values', () => {
    const question = new PendingQuestion(SID, QUESTIONS)
    expect(question.key).toMatch(/^question:[0-9a-f]{32}:\d+$/)
    expect(new PendingQuestion(SID, QUESTIONS).key).not.toBe(question.key)
    expect(question.sessionId).toBe(SID)
    expect(question.questions).toBe(QUESTIONS)
  })

  it('does not restore an old unnamed request draft into a new card', () => {
    draftInstance.actions.replace('question:1', {
      index: 7,
      drafts: [{ selected: ['stale'], custom: '', skipped: false }],
    })
    const question = new PendingQuestion(SID, QUESTIONS)
    render(<QuestionComposer matched={question} {...kit} />)

    expect(question.key).not.toBe('question:1')
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(screen.queryByText('stale')).toBeNull()
  })

  it('ignores persisted progress that no longer matches the question batch', () => {
    const carrier = new PendingQuestion(SID, QUESTIONS, ToolCallId('stale-progress'))
    draftInstance.actions.replace(carrier.key, { index: 7, drafts: [] })

    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.getByRole('heading', { name: QUESTIONS[0]!.question })).toBeTruthy()
    expect(screen.getByText(`1 / ${QUESTIONS.length}`)).toBeTruthy()
  })

  it('collapses the card to the header strip and expands it back', () => {
    const { carrier } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)
    // Expanded: the option list is visible.
    expect(screen.getByRole('radiogroup')).toBeTruthy()
    // Collapse: options leave the tree; the title and minimize toggle stay.
    fireEvent.click(screen.getByLabelText(zh['nav.minimize']))
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByText('选择候选人类型')).toBeTruthy()
    // Expand: the options return (the toggle label flips while collapsed).
    fireEvent.click(screen.getByLabelText(zh['nav.maximize']))
    expect(screen.getByRole('radiogroup')).toBeTruthy()
    // Expanded again: the toggle reports expanded and the option list is back.
    expect(screen.getByLabelText(zh['nav.minimize']).getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps the collapse toggle out of the cancel path and preserves drafts across collapse', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)
    fireEvent.click(screen.getByRole('radio', { name: /工程落地型/ }))
    // Single-select auto-advances to the second question; collapse and expand
    // must not lose either the picked option or the current position.
    fireEvent.click(screen.getByLabelText(zh['nav.minimize']))
    fireEvent.click(screen.getByLabelText(zh['nav.maximize']))
    const custom = screen.getByPlaceholderText(zh['custom.placeholder'])
    fireEvent.change(custom, { target: { value: '要能独立排查线上问题' } })
    // Re-expanding must not steal focus back into the textarea: it was
    // autofocused on first presentation, so focus stays on the expand toggle.
    expect(document.activeElement).not.toBe(custom)
    fireEvent.click(screen.getByLabelText('下一题'))
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(answer).toHaveBeenCalledWith(answerBatch([
      { id: 'profile', selected: ['工程落地型 (Recommended)'] },
      { id: 'detail', custom: '要能独立排查线上问题', selected: [] },
      { id: 'signals', selected: ['系统设计'] },
    ]))
  })
})

describe('parseRecommendedLabel', () => {
  it('recognizes English and Chinese suffixes without changing ordinary labels', () => {
    expect(parseRecommendedLabel('Fast (Recommended)')).toEqual({ label: 'Fast', recommended: true })
    expect(parseRecommendedLabel('稳妥（推荐）')).toEqual({ label: '稳妥', recommended: true })
    expect(parseRecommendedLabel('稳妥 (推荐)')).toEqual({ label: '稳妥', recommended: true })
    expect(parseRecommendedLabel('Plain')).toEqual({ label: 'Plain', recommended: false })
  })
})

const TIMED: PendingQuestion['questions'] = [{
  id: 'scope', question: '选择范围', options: [{ label: '仅工具' }, { label: '全部' }],
}]

/** A timed card as the Remote Event listener builds it: waterfall channel with a Client-decided deadline. */
function timedCard(deadline: number, callId = ToolCallId('ask-timed')) {
  const carrier = new PendingQuestion(SID, TIMED, callId)
  const request = createWaterfallRequest(deadline, undefined, (channel) => { carrier.detachWaterfall(channel) })
  carrier.attachWaterfall(request.channel)
  void request.result.catch(() => {})
  return { carrier, request }
}

describe('timed card', () => {
  it.each([true, false])('does not autofocus before claiming and respects manual focus until readiness: %s', async (stillFocused) => {
    vi.useFakeTimers()
    const carrier = new PendingQuestion(SID, [{ id: 'free', question: '补充说明' }], ToolCallId('claiming'))
    const request = createWaterfallRequest(Date.now() + 2_000, undefined,
      (channel) => { carrier.detachWaterfall(channel) })
    try {
      render(<QuestionComposer matched={carrier} {...kit} />)
      const field = screen.getByPlaceholderText(zh['custom.placeholder'])
      expect(document.activeElement).not.toBe(field)

      fireEvent.focus(field)
      if (!stillFocused) fireEvent.blur(field, { relatedTarget: document.body })
      act(() => { carrier.attachWaterfall(request.channel) })
      expect(carrier.snapshot().countdown).toEqual({ remainingMs: 2_000, running: !stillFocused })
      if (stillFocused) {
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
        expect(carrier.snapshot().channel).toBe('waterfall')
        fireEvent.blur(field, { relatedTarget: document.body })
        expect(carrier.snapshot().countdown).toEqual({ remainingMs: 2_000, running: true })
      }
    } finally {
      act(() => { request.channel.resolve({ answers: [{ id: 'free', selected: [] }] }) })
      await request.result
      cleanup()
      carrier.close()
      vi.useRealTimers()
    }
  })

  it('pauses a pristine countdown while the answer surface has focus and resumes its remainder on blur', async () => {
    vi.useFakeTimers()
    try {
      const { carrier, request } = timedCard(Date.now() + 2_000)
      let settled = false
      void request.result.then(() => { settled = true }, () => { settled = true })
      render(<QuestionComposer matched={carrier} {...kit} />)
      const option = screen.getByRole('radio', { name: '仅工具' })

      fireEvent.focus(option)
      expect(carrier.snapshot()).toMatchObject({ waitState: 'focused', countdown: { running: false } })
      expect(screen.getByText(/已暂停/)).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(settled).toBe(false)

      fireEvent.blur(option, { relatedTarget: document.body })
      expect(carrier.snapshot()).toMatchObject({ waitState: 'counting' })
      await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the first edited draft indefinite and restores that choice after remount', async () => {
    vi.useFakeTimers()
    try {
      const first = timedCard(Date.now() + 1_000)
      let firstSettled = false
      void first.request.result.then(() => { firstSettled = true }, () => { firstSettled = true })
      const view = render(<QuestionComposer matched={first.carrier} {...kit} />)

      fireEvent.click(screen.getByRole('radio', { name: '仅工具' }))
      expect(first.carrier.snapshot()).toMatchObject({ waitState: 'editing', countdown: { running: false } })
      expect(draftInstance.getSnapshot().progressByRequest[first.carrier.key]?.wait).toBe('editing')
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(firstSettled).toBe(false)

      view.unmount()
      const restored = timedCard(Date.now() + 1_000)
      let restoredSettled = false
      void restored.request.result.then(() => { restoredSettled = true }, () => { restoredSettled = true })
      render(<QuestionComposer matched={restored.carrier} {...kit} />)
      await act(async () => { await Promise.resolve() })
      expect(restored.carrier.snapshot()).toMatchObject({ waitState: 'editing', countdown: { running: false } })
      expect(screen.getByText('会一直等你回答')).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(restoredSettled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts down locally, settles the waterfall with ASK_TIMED_OUT at zero, and waits for the projection', async () => {
    vi.useFakeTimers()
    try {
      const { carrier, request } = timedCard(Date.now() + 1_500)
      const rejection = expect(request.result).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_TIMED_OUT' })
      render(<QuestionComposer matched={carrier} {...kit} />)
      expect(screen.getByText(/秒后继续工作/)).toBeTruthy()
      expect(screen.getByRole('button', { name: '慢慢回答' })).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })

      await rejection
      expect(carrier.snapshot()).toEqual({
        state: 'open', waitState: 'counting', countdown: undefined,
        channel: 'none', closed: false,
      })
      expect(screen.queryByText(/秒后继续工作/)).toBeNull()
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '提交' }).disabled).toBe(true)

      const answer = vi.fn(async () => true)
      act(() => {
        carrier.attachRpc({ answer })
        carrier.setState('continued')
      })
      expect(screen.getByText('已继续工作，仍可回答')).toBeTruthy()
      fireEvent.click(screen.getByRole('radio', { name: '仅工具' }))
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '提交' }).disabled).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: '提交' }))
      await act(async () => { await Promise.resolve() })
      expect(answer).toHaveBeenCalledWith({ answers: [{ id: 'scope', selected: ['仅工具'] }] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets the user cancel this countdown and keep the request blocking', async () => {
    vi.useFakeTimers()
    try {
      const { carrier, request } = timedCard(Date.now() + 1_000)
      let settled = false
      void request.result.then(() => { settled = true }, () => { settled = true })
      render(<QuestionComposer matched={carrier} {...kit} />)

      fireEvent.click(screen.getByRole('button', { name: '慢慢回答' }))

      expect(screen.queryByText(/秒后继续工作/)).toBeNull()
      expect(screen.queryByRole('button', { name: '慢慢回答' })).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(settled).toBe(false)
      expect(carrier.snapshot()).toMatchObject({ channel: 'waterfall', waitState: 'waiting' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-arms the controls with a resubmit hint when a sent answer is dropped', async () => {
    const { carrier, request } = timedCard(Date.now() + 60_000)
    render(<QuestionComposer matched={carrier} {...kit} />)
    fireEvent.click(screen.getByRole('radio', { name: '仅工具' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))

    await expect(request.result).resolves.toEqual({ answers: [{ id: 'scope', selected: ['仅工具'] }] })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '正在提交…' }).disabled).toBe(true)
    expect(draftInstance.getSnapshot().progressByRequest[carrier.key]).toBeDefined()

    act(() => { carrier.setState('continued') })

    expect(screen.getByText('回答未送达，工作已继续，请再提交一次。')).toBeTruthy()
    expect(screen.getByRole('radio', { name: '仅工具' }).getAttribute('aria-checked')).toBe('true')
    const answer = vi.fn(async () => true)
    act(() => { carrier.attachRpc({ answer }) })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await vi.waitFor(() => { expect(answer).toHaveBeenCalledWith({ answers: [{ id: 'scope', selected: ['仅工具'] }] }) })
  })

  it('steers an RPC reply, hides the panel, and rejects a duplicate before discard', async () => {
    const carrier = new PendingQuestion(SID, TIMED, ToolCallId('ask-retry'))
    const answer = vi.fn(async () => true)
    const hide = vi.fn()
    answer.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('a reply is already queued for this question'))
    carrier.attachRpc({ answer })
    carrier.attachSeat({ hide })
    carrier.setState('continued')
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByRole('radio', { name: '仅工具' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await vi.waitFor(() => { expect(hide).toHaveBeenCalledOnce() })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '提交' }).disabled).toBe(false)
    expect(screen.queryByText(zh['status.sent'])).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(await screen.findByText('a reply is already queued for this question')).toBeTruthy()
    expect(answer).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await vi.waitFor(() => { expect(answer).toHaveBeenCalledTimes(3) })
    await vi.waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '提交' }).disabled).toBe(false)
    })
  })

  it('unlocks an older reply when the rendered channel lags its continued state', async () => {
    const carrier = new PendingQuestion(SID, TIMED, ToolCallId('ask-stale-channel'))
    const hide = vi.fn()
    carrier.attachRpc({ answer: vi.fn(async () => true) })
    carrier.attachSeat({ hide })
    carrier.setState('continued')
    const rendered = { ...carrier.snapshot(), state: 'open' as const, channel: 'waterfall' as const }
    const useQuestionCard = ((_key: string, selector?: (value: QuestionCardSnapshot | undefined) => unknown) =>
      selector === undefined ? rendered : selector(rendered)) as QuestionComposerProps['useQuestionCard']
    render(<Composer matched={carrier} {...kit} useQuestionCard={useQuestionCard} />)

    fireEvent.click(screen.getByRole('radio', { name: '仅工具' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))

    await vi.waitFor(() => { expect(hide).toHaveBeenCalledOnce() })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '提交' }).disabled).toBe(false)
  })

  it('closing a continued panel only withdraws it from the seat and sends nothing', async () => {
    const carrier = new PendingQuestion(SID, TIMED, ToolCallId('ask-continued'))
    const answer = vi.fn(async () => true)
    const hide = vi.fn()
    carrier.attachRpc({ answer })
    carrier.attachSeat({ hide })
    carrier.setState('continued')
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.getByText('已继续工作，仍可回答')).toBeTruthy()
    expect(screen.queryByText(/秒后继续工作/)).toBeNull()
    // The close button names the reopen path, not a dismissal of the question.
    expect(screen.queryByLabelText('放弃整组问题')).toBeNull()
    fireEvent.click(screen.getByLabelText('收起问题面板，可从工具调用重新打开'))

    await vi.waitFor(() => { expect(hide).toHaveBeenCalledOnce() })
    expect(answer).not.toHaveBeenCalled()
    expect(carrier.snapshot()).toMatchObject({ state: 'continued', channel: 'rpc', closed: false })
  })

  it('closing a card-keyed panel with no channel left still just withdraws it', () => {
    const carrier = new PendingQuestion(SID, TIMED, ToolCallId('ask-gap'))
    const hide = vi.fn()
    carrier.attachSeat({ hide })
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByLabelText('收起问题面板，可从工具调用重新打开'))

    expect(hide).toHaveBeenCalledOnce()
    expect(screen.queryByText('当前无法提交，请稍候再试。')).toBeNull()
  })

  it('reports an unavailable channel instead of cancelling into the gap', () => {
    // A request the Host never named: closing it is the cancellation, so with
    // no channel to carry the rejection there is nothing to do but say so.
    const carrier = new PendingQuestion(SID, TIMED)
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByLabelText('放弃整组问题'))

    expect(screen.getByText('当前无法提交，请稍候再试。')).toBeTruthy()
  })

  it('prunes drafts no card owns on mount and clears its own draft when the card closes', () => {
    kit.actions.replace('question:stale', { index: 0, drafts: [{ selected: [], custom: 'old', skipped: false }] })
    const { carrier } = timedCard(Date.now() + 60_000)
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(draftInstance.getSnapshot().progressByRequest['question:stale']).toBeUndefined()
    fireEvent.click(screen.getByRole('radio', { name: '全部' }))
    expect(draftInstance.getSnapshot().progressByRequest[carrier.key]?.drafts[0]?.selected).toEqual(['全部'])

    act(() => { carrier.close() })

    expect(draftInstance.getSnapshot().progressByRequest[carrier.key]).toBeUndefined()
  })
})

const REVIEWED_CALL = 'ask-answered'
/** One settled call's answers in record order, which is not the question order. */
const RECORDED: readonly AskUserQuestionAnswerItem[] = [
  { id: 'signals', selected: [] },
  { id: 'profile', selected: ['工程落地型 (Recommended)'] },
  { id: 'detail', selected: [], custom: '要能独立排查线上问题' },
]
/** A record whose multi-select answer used the custom row beside a checked option. */
const RECORDED_CUSTOM: readonly AskUserQuestionAnswerItem[] = [
  { id: 'profile', selected: ['研究潜力型'] },
  { id: 'detail', selected: [], custom: '要能独立排查线上问题' },
  { id: 'signals', selected: ['系统设计'], custom: '沟通能力' },
]

/** A read-only card as the panel provider builds it from a settled call's transcript record. */
function reviewCard(review: readonly AskUserQuestionAnswerItem[] = RECORDED) {
  const carrier = new PendingQuestion(SID, QUESTIONS, ToolCallId(REVIEWED_CALL), undefined, review)
  const hide = vi.fn()
  carrier.attachSeat({ hide })
  return { carrier, hide }
}

describe('review card', () => {
  it('walks a settled call record with every answer surface frozen', () => {
    const { carrier } = reviewCard()
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.getByText(zh['review.status'])).toBeTruthy()
    // The recorded selection is paired by question id, not by record order.
    const chosen = screen.getByRole<HTMLButtonElement>('radio', { name: '工程落地型' })
    expect(chosen.getAttribute('aria-checked')).toBe('true')
    expect(chosen.disabled).toBe(true)
    // Nothing is left to send, and the unused free-text field would read as
    // somewhere to type.
    expect(screen.queryByRole('button', { name: '跳过' })).toBeNull()
    expect(screen.queryByRole('button', { name: '提交' })).toBeNull()
    expect(screen.queryByPlaceholderText('输入你的答案')).toBeNull()

    fireEvent.click(screen.getByLabelText('下一题'))

    expect(screen.getByText('2 / 3')).toBeTruthy()
    const optionless = screen.getByPlaceholderText<HTMLTextAreaElement>('输入你的答案')
    expect(optionless.value).toBe('要能独立排查线上问题')
    expect(optionless.disabled).toBe(true)
    expect(document.activeElement).not.toBe(optionless)

    fireEvent.click(screen.getByLabelText('下一题'))

    expect(screen.getByText('3 / 3')).toBeTruthy()
    expect(screen.getByText(zh['review.skipped'])).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '系统设计' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByPlaceholderText('输入你的答案')).toBeNull()
  })

  it('reads the record back instead of a draft the live card left under the same key', () => {
    kit.actions.replace(PendingQuestion.keyOf(SID, REVIEWED_CALL), {
      index: 2,
      drafts: [
        { selected: [], custom: '没提交的草稿', skipped: false },
        { selected: [], custom: '', skipped: false },
        { selected: ['代码质量'], custom: '', skipped: false },
      ],
    })
    const { carrier } = reviewCard(RECORDED_CUSTOM)
    render(<QuestionComposer matched={carrier} {...kit} />)

    // The page the live card was on is restored; its half-typed answers are not.
    expect(screen.getByText('3 / 3')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '系统设计' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('checkbox', { name: '代码质量' }).getAttribute('aria-checked')).toBe('false')
    const custom = screen.getByPlaceholderText<HTMLTextAreaElement>('输入你的答案')
    expect(custom.value).toBe('沟通能力')
    expect(custom.disabled).toBe(true)

    fireEvent.click(screen.getByLabelText('上一题'))
    fireEvent.click(screen.getByLabelText('上一题'))

    expect(screen.getByRole('radio', { name: '研究潜力型' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByDisplayValue('没提交的草稿')).toBeNull()
  })

  it('closing a read-only panel withdraws it and sends nothing', () => {
    const { carrier, hide } = reviewCard()
    render(<QuestionComposer matched={carrier} {...kit} />)

    // The card is keyed by its tool call, so closing names the reopen path.
    expect(screen.queryByLabelText(zh['nav.cancel'])).toBeNull()
    fireEvent.click(screen.getByLabelText(zh['nav.close']))

    expect(hide).toHaveBeenCalledOnce()
    expect(carrier.snapshot()).toEqual({
      state: 'open', waitState: 'counting', countdown: undefined,
      channel: 'none', closed: false,
    })
  })

  it('renders the read-only copy through the English dictionary', () => {
    const { carrier } = reviewCard()
    render(<QuestionComposer matched={carrier} {...kit} t={seatOver(en, commonEn)} />)

    expect(screen.getByText(en['review.status'])).toBeTruthy()
    fireEvent.click(screen.getByLabelText(en['nav.next']))
    fireEvent.click(screen.getByLabelText(en['nav.next']))
    expect(screen.getByText(en['review.skipped'])).toBeTruthy()
  })
})
