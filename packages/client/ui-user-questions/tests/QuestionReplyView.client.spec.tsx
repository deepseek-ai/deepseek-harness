// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import { zh } from '../src/client/locales.ts'
import { QuestionReplyBubble, QuestionReplyView } from '../src/client/QuestionReplyView.tsx'
import type { QuestionReplyData } from '../src/client/question-reply.ts'

afterEach(cleanup)

/** Render the keyed Chat renderer itself; the framework props it never reads are stubbed. */
function renderView(data: QuestionReplyData) {
  const props: Partial<ComponentProps<typeof QuestionReplyView>> = {
    node: {
      key: 'reply:1', id: 'msg-1', kind: 'question-reply', target: 'chat', anchorSeq: 7,
      location: { kind: 'session' }, visibility: 'visible', data,
    },
    openFile: vi.fn(),
    openSkill: vi.fn(),
    renderMessageImages: () => null,
    inspectCall: vi.fn(),
    forkAt: vi.fn(),
    loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
    fileMentions: vi.fn(),
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
    id: 'goal', question: 'What should we build?', header: 'What should we build?', detail: 'Choose the first milestone.',
    options: [{ label: 'A dashboard', description: 'A focused web surface.' }, { label: 'A CLI' }],
  }],
  answers: [{ id: 'goal', selected: ['A dashboard'] }],
  text: '{"questions":[],"answers":[]}',
  time: 1,
} satisfies QuestionReplyData
describe('QuestionReplyView', () => {
  it('reopens the settled question details from the history bubble', () => {
    render(<QuestionReplyBubble data={data} t={t} />)

    const bubble = screen.getByRole('button', { name: /展开问题详情/ })
    expect(bubble.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getAllByText('A dashboard')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'copy' })).toBeTruthy()
    expect(screen.getByText(/\d{2}:\d{2}/)).toBeTruthy()
    expect(screen.queryByText('What should we build?')).toBeNull()

    fireEvent.click(bubble)

    expect(screen.getByRole('button', { name: /收起问题详情/ }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('What should we build?')).toBeTruthy()
    expect(screen.getAllByText('What should we build?')).toHaveLength(1)
    expect(screen.getByText('A dashboard — A focused web surface.')).toBeTruthy()
    expect(screen.getByText('回答：')).toBeTruthy()
    expect(screen.getAllByText('A dashboard')).toHaveLength(1)
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
    expect(screen.getByRole('group', { name: '回答先前等待中的问题' }).getAttribute('data-question-reply')).toBe('call-reply')
  })

  it('shows a distinct header, marks an unanswered question skipped, and falls back to the raw text', () => {
    render(<QuestionReplyBubble
      data={{
        ...data,
        questions: [
          { id: 'goal', question: 'What should we build?', header: 'Goal' },
          { id: 'notes', question: 'Any notes?', options: [{ label: 'None' }] },
        ],
        answers: [{ id: 'goal', selected: [], custom: '  ' }],
      }}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: /展开问题详情/ }))
    expect(screen.getByText('Goal')).toBeTruthy()
    expect(screen.getByText('None')).toBeTruthy()
    expect(screen.getAllByText('已跳过')).toHaveLength(2)
    cleanup()

    render(<QuestionReplyBubble data={{ ...data, questions: [], answers: [], text: 'raw reply text' }} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /展开问题详情/ }))
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

  it('copies the same text once the bubble is open', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<QuestionReplyBubble data={data} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: /展开问题详情/ }))
    fireEvent.click(screen.getByRole('button', { name: 'copy' }))
    expect(writeText).toHaveBeenCalledWith('What should we build?\n回答：A dashboard')
  })
})
