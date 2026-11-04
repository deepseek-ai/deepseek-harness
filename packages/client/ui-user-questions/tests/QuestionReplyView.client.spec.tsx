// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import { ja, zh } from '../src/client/locales.ts'
import { QuestionReplyBubble, QuestionReplyView } from '../src/client/QuestionReplyView.tsx'
import type { QuestionReplyData } from '../src/client/question-reply.ts'

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
afterEach(() => {
  cleanup()
  if (originalClipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard')
  else Object.defineProperty(navigator, 'clipboard', originalClipboard)
})

/** Render the keyed Chat renderer itself; the framework props it never reads are stubbed. */
function renderView(data: QuestionReplyData) {
  const props: Partial<ComponentProps<typeof QuestionReplyView>> = {
    node: {
      key: 'reply:1', id: 'msg-1', kind: 'question-reply', target: 'chat', anchorSeq: 7,
      location: { kind: 'session' }, visibility: 'visible', data,
    },
    openFile: vi.fn(),
    inspectCall: vi.fn(),
    forkAt: vi.fn(),
    loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
    useDisclosure,
    useTurnData: () => undefined,
    t,
  }
  return render(<QuestionReplyView {...props as ComponentProps<typeof QuestionReplyView>} />)
}

const t = makeTranslate(zh)
const data = {
  callId: 'call-reply',
  outcome: 'answered',
  questions: [{
    id: 'goal', question: 'What should we build?', header: 'What should we build?',
  }],
  answers: [{ id: 'goal', selected: ['A dashboard'] }],
  text: '{"questions":[],"answers":[]}',
  time: 1,
} satisfies QuestionReplyData
describe('QuestionReplyView', () => {
  it('names answered batches in Japanese', () => {
    render(<QuestionReplyBubble data={data} t={makeTranslate(ja)} />)
    expect(screen.getByRole('group', { name: '質問と回答' })).toBeTruthy()
  })

  it('shows paired questions and answers immediately without auxiliary option content', () => {
    render(<QuestionReplyBubble data={data} t={t} />)
    expect(screen.getAllByText('What should we build?')).toHaveLength(1)
    expect(screen.getAllByText('A dashboard')).toHaveLength(1)
    expect(screen.queryByText('Choose the first milestone.')).toBeNull()
    expect(screen.queryByText('A focused web surface.')).toBeNull()
    expect(screen.queryByText('A CLI')).toBeNull()
    expect(screen.queryByRole('button', { name: /展开问题详情/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'copy' })).toBeTruthy()
    expect(screen.getByText(/\d{2}:\d{2}/)).toBeTruthy()
  })

  it('copies the question with its answer, then confirms the write', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<QuestionReplyBubble data={data} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: 'copy' }))
    expect(writeText).toHaveBeenCalledWith('What should we build?\n回答：A dashboard')
    // Two microtask ticks: writeClipboard's own await, then the .then that
    // lands the success chrome.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    fireEvent.click(screen.getByRole('button', { name: 'copied' }))
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('renders through the conversation.chat.node slot with the same bubble', () => {
    renderView(data)
    expect(screen.getByRole('group', { name: '问题与回答' }).getAttribute('data-question-reply')).toBe('call-reply')
  })

  it('shows a distinct header, marks an unanswered question skipped, and falls back to the raw text', () => {
    render(<QuestionReplyBubble
      data={{
        ...data,
        questions: [
          { id: 'goal', question: 'What should we build?', header: 'Goal' },
          { id: 'notes', question: 'Any notes?' },
        ],
        answers: [{ id: 'goal', selected: [], custom: '  ' }],
      }}
      t={t}
    />)
    expect(screen.getByText('Goal')).toBeTruthy()
    expect(screen.queryByText('None')).toBeNull()
    expect(screen.getAllByText('已跳过')).toHaveLength(2)
    cleanup()

    render(<QuestionReplyBubble data={{ ...data, questions: [], answers: [], text: 'raw reply text' }} t={t} />)
    expect(screen.getByText('raw reply text')).toBeTruthy()
  })

  it('keeps the copy affordance quiet when the clipboard refuses, ignores a click while confirmed, and resets after a second', async () => {
    vi.useFakeTimers()
    try {
      const writeText = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
      render(<QuestionReplyBubble data={data} t={t} />)

      fireEvent.click(screen.getByRole('button', { name: 'copy' }))
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByRole('button', { name: 'copy' })).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'copy' }))
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      fireEvent.click(screen.getByRole('button', { name: 'copied' }))
      expect(writeText).toHaveBeenCalledTimes(2)

      act(() => { vi.advanceTimersByTime(1000) })
      expect(screen.getByRole('button', { name: 'copy' })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores repeated pending copies and does not schedule feedback after unmount', async () => {
    vi.useFakeTimers()
    try {
      let finish!: () => void
      const writeText = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
      const view = render(<QuestionReplyBubble data={data} t={t} />)
      fireEvent.click(screen.getByRole('button', { name: 'copy' }))
      fireEvent.click(screen.getByRole('button', { name: 'copy' }))
      expect(writeText).toHaveBeenCalledTimes(1)
      view.unmount()
      await act(async () => { finish(); await Promise.resolve() })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the confirmation timer when the bubble unmounts', async () => {
    vi.useFakeTimers()
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) },
      })
      const view = render(<QuestionReplyBubble data={data} t={t} />)
      fireEvent.click(screen.getByRole('button', { name: 'copy' }))
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(screen.getByRole('button', { name: 'copied' })).toBeTruthy()
      view.unmount()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('copies the complete visible question and answer', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<QuestionReplyBubble data={data} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: 'copy' }))
    expect(writeText).toHaveBeenCalledWith('What should we build?\n回答：A dashboard')
  })
})
