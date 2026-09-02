// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { PendingQuestion, type QuestionComposerProps } from '../src/client/contract/slots.ts'
import { createQuestionDraftStore } from '../src/client/draft-store.ts'
import { QuestionComposer, parseRecommendedLabel } from '../src/client/QuestionComposer.tsx'
import { en, zh } from '../src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

afterEach(cleanup)

const SID = 's1' as SessionId

const seatOver = (dict: Record<string, string>, common: Record<string, string>): QuestionComposerProps['t'] =>
  (key => dict[key] ?? common[key] ?? key)

type SessionState = Parameters<Parameters<QuestionComposerProps['useSession']>[0]>[0]
type ConversationState = Parameters<Parameters<QuestionComposerProps['useConversation']>[0]>[0]
type ChatState = Parameters<Parameters<QuestionComposerProps['useChat']>[0]>[0]
type TrajectoryState = Parameters<Parameters<QuestionComposerProps['useTrajectory']>[0]>[0]
type InputState = Parameters<Parameters<QuestionComposerProps['useInput']>[0]>[0]
type AttentionState = Parameters<Parameters<QuestionComposerProps['useSessionPendingInteraction']>[0]>[0]

const sessionState: SessionState = {
  sessionId: SID,
  queue: [],
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
  byId: { [SID]: { id: SID, displayTitle: 'Session', running: false, blank: false, updatedAt: 0 } },
  current: SID,
  phase: 'ready' as const,
  subagentsByParent: {},
  jobsBySession: {},
  currentAddress: undefined,
}
const attentionState: AttentionState = new Map()
const workspaceState = {
  items: [],
  archivedSessionIds: [],
  state: 'idle' as const,
  phase: 'ready' as const,
  error: null,
}
const conversationState: ConversationState = {
  views: { get: () => undefined },
  activeTargets: new Set(),
}
const emptyKeys: readonly string[] = []
const emptyNodeSource = { getSnapshot: () => undefined, subscribe: () => () => {} }
const chatState: ChatState = {
  order: emptyKeys,
  nodes: {
    get: () => undefined,
    source: () => emptyNodeSource,
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
  imageIds: [],
  draftRev: 0,
  phase: 'plain',
  occurrences: [],
  queue: [],
}

/** Framework standard-kit stubs: the composer consumes the locale and draft-store seats;
 *  the composed props type mandates delivery of the rest (framework hooks are
 *  plain stubs per the client testing discipline). */
const kitBase: Omit<QuestionComposerProps, 'matched' | 'useStore' | 'actions'> = {
  session: undefined,
  sessionId: SID,
  pendingInteraction: undefined,
  useSession: selector => selector(sessionState),
  useSessions: selector => selector(sessionList),
  useSessionPendingInteraction: selector => selector(attentionState),
  useWorkspaces: selector => selector(workspaceState),
  useConversation: selector => selector(conversationState),
  useChat: selector => selector(chatState),
  useTrajectory: selector => selector(trajectoryState),
  useProjection: (() => undefined),
  useInput: selector => selector(inputState),
  inputActions: {
    setDraft: () => { throw new Error('unused') },
    addImages: () => { throw new Error('unused') },
    removeImage: () => { throw new Error('unused') },
    pruneImages: () => { throw new Error('unused') },
    submit: () => { throw new Error('unused') },
  },
  // The seat's key domain is question ∪ common.
  t: seatOver(zh, commonZh),
}

let kit: Omit<QuestionComposerProps, 'matched'>

beforeEach(() => {
  const instance = createQuestionDraftStore().create(SID)
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
function wait(questions: PendingQuestion['questions'] = QUESTIONS) {
  const carrier = new PendingQuestion(SID, questions)
  const answer = vi.spyOn(carrier, 'answer')
  const cancel = vi.spyOn(carrier, 'cancel')
  void carrier.result.catch(() => {})
  return { carrier, answer, cancel }
}

const answerBatch = (answers: object[]) => ({ answers })

describe('QuestionComposer', () => {
  it('collects single, custom, and multi-select answers before one batch submit', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.getByText('偏好')).toBeTruthy()
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(screen.getByText('推荐')).toBeTruthy()
    expect(screen.getByText('工程落地型')).toBeTruthy()
    const detail = screen.getByText('按当前空缺岗位的优先级选择。')
    const scrollRegion = detail.closest('[data-question-scroll]')
    expect(scrollRegion).toBeTruthy()
    expect(scrollRegion?.contains(screen.getByRole('radio', { name: /工程落地型/ }))).toBe(true)
    expect(scrollRegion?.contains(screen.getByText('下一题').closest('button'))).toBe(false)
    fireEvent.keyDown(screen.getByRole('radio', { name: /工程落地型/ }), { key: 'Enter' })
    expect(answer).not.toHaveBeenCalled()
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

    expect((screen.getByText('下一题').closest('button') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: '研究潜力型' }))
    expect(screen.getByText('2 / 3')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '跳过本题' }))
    expect(screen.getByText('3 / 3')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '跳过本题' }))

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
    const { carrier, cancel } = wait()
    cancel
      .mockRejectedValueOnce(new Error('第一次取消失败'))
      .mockRejectedValueOnce(new Error('第二次取消失败'))
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByRole('button', { name: '放弃整组问题' }))
    expect(await screen.findByText('第一次取消失败')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '跳过本题' }).disabled).toBe(false)

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
    expect(screen.getByRole('button', { name: 'Skip this question' })).toBeTruthy()
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
  it('resolves the waterfall result with the answer batch and settles once', async () => {
    const question = new PendingQuestion(SID, QUESTIONS)
    const batch = { answers: [{ id: 'mode', selected: ['Fast'] }] }
    await expect(question.answer(batch)).resolves.toBeUndefined()
    await expect(question.result).resolves.toBe(batch)
    await expect(question.answer(batch)).rejects.toThrow(/already settled/)
  })

  it('rejects the waterfall result with ASK_CANCELLED and settles once', async () => {
    const question = new PendingQuestion(SID, QUESTIONS)
    const result = question.result.catch((error: unknown) => error)
    await expect(question.cancel()).resolves.toBeUndefined()
    await expect(result).resolves.toMatchObject({
      name: 'UserQuestionError',
      code: 'ASK_CANCELLED',
      message: 'the user cancelled ask_user_question',
    })
    await expect(question.cancel()).rejects.toThrow(/already settled/)
  })

  it('exposes its Client render identity and scoped request values', () => {
    const question = new PendingQuestion(SID, QUESTIONS)
    expect(question.key).toMatch(/^question:\d+$/)
    expect(question.sessionId).toBe(SID)
    expect(question.questions).toBe(QUESTIONS)
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
