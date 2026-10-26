import { describe, expect, it, vi } from 'vitest'
import { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { TurnEndReason } from '@deepseek-ai/dsh-session/types'
import { createContinuationSource } from '../src/client/input/continuation.ts'
import { continuationTurn as turn } from './continuation-fixture.client.ts'

const failed = (code: string): TurnEndReason => ({ kind: 'error', error: { code, message: code } })

describe('manual generation continuation', () => {
  it.each(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'STREAM_CLOSED'])(
    'offers continuation for an admitted request ending with %s', (code) => {
      const feed = new MutableSessionEventSource()
      feed.replace(turn(failed(code)), false)
      expect(createContinuationSource(feed).getSnapshot()).toBe(5)
    },
  )

  it.each(['AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'UNKNOWN_MODEL',
    'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'TOOL_ACTIVATION_FAILED', 'MALFORMED_RESPONSE', 'PI_AI_ERROR', 'UNKNOWN'])(
    'leaves %s to its own recovery action', (code) => {
      const feed = new MutableSessionEventSource()
      feed.replace(turn(failed(code)), false)
      expect(createContinuationSource(feed).getSnapshot()).toBeUndefined()
    },
  )

  it.each<TurnEndReason>([
    { kind: 'completed' }, { kind: 'max-tokens' }, { kind: 'blocked' },
    { kind: 'interrupted' }, { kind: 'forked' }, { kind: 'aborted', reason: { kind: 'user' } },
  ])('leaves a $kind turn unchanged', (reason) => {
    const feed = new MutableSessionEventSource()
    feed.replace(turn(reason), false)
    expect(createContinuationSource(feed).getSnapshot()).toBeUndefined()
  })

  it('requires user input from the failed turn to have entered model history', () => {
    const feed = new MutableSessionEventSource()
    const source = createContinuationSource(feed)
    const entries = turn(failed('TIMEOUT'), 2)
    feed.replace([...turn({ kind: 'completed' }), ...entries.filter(entry => entry.event.type !== 'user/message')], false)
    expect(source.getSnapshot()).toBeUndefined()
    const user = entries[2]!
    if (user.event.type !== 'user/message') throw new Error('expected user input')
    const replacement: SessionLiveEventEntry = { type: 'event', event: {
      ...user.event, surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(1) },
    } }
    feed.replace(entries.map(entry => entry === user ? replacement : entry), false)
    expect(source.getSnapshot()).toBeUndefined()
  })

  it('keeps failures before request dispatch in their preparation flow', () => {
    const feed = new MutableSessionEventSource()
    const source = createContinuationSource(feed)
    feed.replace(turn(failed('TIMEOUT')).filter(entry => entry.event.type !== 'assistant/attempt'), false)
    expect(source.getSnapshot()).toBeUndefined()
  })

  it('restores eligibility from paging and replacement, and retires it when a later turn starts', () => {
    const feed = new MutableSessionEventSource()
    const source = createContinuationSource(feed)
    const entries = turn(failed('SERVER'))
    feed.replace(entries.slice(1), true)
    expect(source.getSnapshot()).toBeUndefined()
    feed.prepend(entries.slice(0, 1), false)
    expect(source.getSnapshot()).toBe(5)
    expect(createContinuationSource(feed).getSnapshot()).toBe(5)
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)
    feed.append({ type: 'event', event: { type: 'turn/start', seq: SessionSeq(6), time: 1, data: { turn: 2 } } })
    expect(listener).toHaveBeenCalledOnce()
    expect(source.getSnapshot()).toBeUndefined()
    unsubscribe()
    feed.replace(turn({ kind: 'completed' }), false)
    expect(listener).toHaveBeenCalledOnce()
    expect(source.getSnapshot()).toBeUndefined()
    feed.replace([], false)
    expect(source.getSnapshot()).toBeUndefined()
  })
})
