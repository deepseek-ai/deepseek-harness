/** Errors thrown while folding a local child's events reach the result capture. */

import { describe, expect, it } from 'vitest'
import { SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import { captureLocalResult, foldLocalResult, type LocalActivation } from '../src/activation.ts'
import { AssistantOutputFold, finalAssistantOutput } from '../src/assistant-output.ts'

/** The fields result folding and capture read. */
function activation(failureAt?: SessionLogOffset): LocalActivation {
  return {
    kind: 'local', output: new AssistantOutputFold(), work: undefined,
    outputFailure: undefined, workFailure: undefined, structured: undefined, failureAt,
  } as LocalActivation
}

/** An event `Session.append` accepts but one fold cannot read. */
function malformed(event: object): SessionEvent {
  return JSON.parse(JSON.stringify(event)) as SessionEvent
}

const unreadableByStopReason = malformed({
  type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, outcome: 'canceled' },
})
const unreadableByOutput = malformed({ type: 'assistant/attempt', data: { turn: 1, step: 1 } })
const answer = malformed({ type: 'assistant/message', data: { stream: [], message: { content: [{ type: 'text', text: 'answer' }] } } })

describe('local result fold failures', () => {
  it('settles an epoch that committed no event as completed with no output', () => {
    expect(captureLocalResult(activation())).toEqual({ output: [], stopReason: 'completed' })
  })

  it('rethrows the first error the stop-reason fold threw', () => {
    const subject = activation()
    foldLocalResult(subject, unreadableByStopReason)
    const first = subject.workFailure
    foldLocalResult(subject, unreadableByStopReason)

    expect(subject.workFailure).toBe(first)
    expect(() => captureLocalResult(subject)).toThrow(TypeError)
  })

  it('keeps folding output after the stop-reason fold failed, and skips that fold after a live failure', () => {
    const subject = activation(SessionLogOffset(0))
    foldLocalResult(subject, unreadableByStopReason)
    foldLocalResult(subject, answer)

    expect(captureLocalResult(subject)).toEqual({ output: [{ type: 'text', text: 'answer' }], stopReason: 'error' })
  })

  it('rethrows the output fold error ahead of the stop-reason fold error', () => {
    const subject = activation()
    foldLocalResult(subject, unreadableByStopReason)
    foldLocalResult(subject, unreadableByOutput)
    foldLocalResult(subject, answer)
    let expected: unknown
    try { finalAssistantOutput([unreadableByStopReason, unreadableByOutput, answer]) } catch (error: unknown) { expected = error }

    expect(expected).toBeInstanceOf(TypeError)
    expect(() => captureLocalResult(subject)).toThrow((expected as TypeError).message)
  })
})
