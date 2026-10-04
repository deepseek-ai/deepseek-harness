/** Card and waterfall settlement edges the composer and plugin specs do not reach. */
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createWaterfallRequest, PendingQuestion } from '../src/client/contract/slots.ts'

const SID = 's1' as SessionId
const CALL = ToolCallId('call-1')
const QUESTIONS = [{ id: 'mode', question: 'Choose a mode' }]
const ANSWER = { answers: [{ id: 'mode', selected: ['Fast'] }] }

function attached(card: PendingQuestion, deadline?: number) {
  const request = createWaterfallRequest(deadline, undefined, (channel) => { card.detachWaterfall(channel) })
  card.attachWaterfall(request.channel)
  return { card, request }
}

describe('createWaterfallRequest', () => {
  it('settles once: later resolutions, rejections and delegations are ignored', async () => {
    const onSettle = vi.fn()
    const request = createWaterfallRequest(1_000, undefined, onSettle)
    request.channel.resolve(ANSWER)
    request.channel.reject('ASK_CANCELLED')
    request.channel.delegate()
    await expect(request.result).resolves.toBe(ANSWER)
    expect(onSettle).toHaveBeenCalledOnce()
    expect(request.channel.deadline).toBe(1_000)
  })

  it('rejects immediately when the request arrives already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const onSettle = vi.fn()
    const request = createWaterfallRequest(undefined, controller.signal, onSettle)
    await expect(request.result).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
    expect(onSettle).toHaveBeenCalledOnce()
  })
})

describe('PendingQuestion', () => {
  it.each([true, false])('retains focus before a deadline arrives only while still focused: %s', (stillFocused) => {
    vi.useFakeTimers()
    const card = new PendingQuestion(SID, QUESTIONS, CALL)
    try {
      card.holdFocus()
      if (!stillFocused) card.releaseFocus()
      expect(vi.getTimerCount()).toBe(0)

      attached(card, Date.now() + 60_000)
      expect(card.snapshot()).toMatchObject({
        waitState: stillFocused ? 'focused' : 'counting',
        countdown: { remainingMs: 60_000, running: !stillFocused },
      })
      card.releaseFocus()
      expect(card.snapshot().countdown).toEqual({ remainingMs: 60_000, running: true })
    } finally {
      card.close()
      vi.useRealTimers()
    }
  })

  it('does not start a timer when an indefinite question loses focus', () => {
    vi.useFakeTimers()
    const card = new PendingQuestion(SID, QUESTIONS)
    try {
      attached(card)
      card.holdFocus()
      card.releaseFocus()
      expect(card.snapshot().countdown).toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      card.close()
      vi.useRealTimers()
    }
  })

  it('publishes only real state changes', () => {
    const card = new PendingQuestion(SID, QUESTIONS, CALL)
    const listener = vi.fn()
    card.subscribe(listener)

    card.setState('open')
    card.timeout()
    card.takeTime()
    card.takeTime()
    card.timeout()
    card.close()
    card.close()

    expect(listener).toHaveBeenCalledTimes(2)
    expect(card.snapshot()).toMatchObject({ state: 'open', countdown: undefined, channel: 'none', closed: true })
    expect(card.liveKeys()).toEqual([card.key])
  })

  it('keeps a held or edited card without a countdown when a later request attaches', () => {
    vi.useFakeTimers()
    try {
      const now = Date.now()
      const held = new PendingQuestion(SID, QUESTIONS, CALL)
      held.takeTime()
      attached(held, now + 60_000)
      expect(held.snapshot()).toMatchObject({ waitState: 'waiting', countdown: { remainingMs: 0, running: false } })

      const edited = new PendingQuestion(SID, QUESTIONS, CALL)
      edited.engage(now)
      attached(edited, now + 60_000)
      expect(edited.snapshot()).toMatchObject({ waitState: 'editing', countdown: { remainingMs: 0, running: false } })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('freezes the remaining wait while focused, also across a re-delivered request', () => {
    vi.useFakeTimers()
    try {
      const now = Date.now()
      const card = new PendingQuestion(SID, QUESTIONS, CALL)
      const first = attached(card, now + 60_000)
      card.holdFocus(now + 10_000)
      expect(card.snapshot()).toMatchObject({ waitState: 'focused', countdown: { remainingMs: 50_000, running: false } })
      expect(vi.getTimerCount()).toBe(0)

      // The focused hold survives the request being re-delivered: a deadline
      // carried by the new channel is frozen too, one without leaves it as is.
      card.detachWaterfall(first.request.channel)
      attached(card, now + 40_000)
      expect(card.snapshot()).toMatchObject({ waitState: 'focused', countdown: { remainingMs: 40_000, running: false } })
      attached(card)
      expect(card.snapshot()).toMatchObject({ waitState: 'focused', countdown: undefined })

      card.releaseFocus(now + 20_000)
      expect(card.snapshot()).toMatchObject({ waitState: 'counting', countdown: undefined })
      card.releaseFocus(now + 20_000)
      expect(card.snapshot().waitState).toBe('counting')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to end an unnamed request that has no live channel', async () => {
    const card = new PendingQuestion(SID, QUESTIONS)
    expect(card.dismissal).toBe('cancel')
    await expect(card.dismiss()).rejects.toThrow(/no channel accepts a cancellation/)
  })

  it('turns a throwing settlement into the rejected submission', async () => {
    const boom = new Error('subscriber failed')
    const first = attached(new PendingQuestion(SID, QUESTIONS, CALL))
    first.card.subscribe(() => { throw boom })
    await expect(first.card.answer(ANSWER)).rejects.toBe(boom)

    const second = attached(new PendingQuestion(SID, QUESTIONS))
    const cancelled = expect(second.request.result).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    second.card.subscribe(() => { throw 'not an error' })
    await expect(second.card.dismiss()).rejects.toMatchObject({
      message: 'pending question cancellation failed', cause: 'not an error',
    })
    await cancelled
  })
})
