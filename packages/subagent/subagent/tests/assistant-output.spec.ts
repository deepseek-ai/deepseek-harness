import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AssistantOutputFold, finalAssistantOutput } from '../src/assistant-output.ts'

function message(content: ContentBlock[]): SessionEvent {
  return { type: 'assistant/message', data: { stream: [], message: { content } } } as SessionEvent
}

function textDelta(text: string): SessionEvent {
  return {
    type: 'assistant/attempt',
    data: { stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [], texts: [text] }] },
  } as SessionEvent
}

function reasoningDelta(text: string): SessionEvent {
  return {
    type: 'assistant/attempt',
    data: { stream: [{ type: 'reasoning-chunks', time0: 0, index: 0, dt: [], texts: [text] }] },
  } as SessionEvent
}

function toolResult(text: string): SessionEvent {
  return {
    type: 'tool/result',
    data: {
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'text', text }],
          isError: false,
        }],
      },
    },
  } as SessionEvent
}

describe('finalAssistantOutput', () => {
  it('selects the last non-empty message past a later empty usage-only message', () => {
    const events = [
      message([{ type: 'text', text: 'step one' }]),
      message([{ type: 'text', text: 'step two' }]),
      message([]),
    ]
    expect(finalAssistantOutput(events)).toEqual([{ type: 'text', text: 'step two' }])
  })

  it('prefers a non-empty message over text streamed before and after it', () => {
    const events = [
      textDelta('earlier partial'),
      message([{ type: 'text', text: 'complete answer' }]),
      textDelta('later partial'),
      message([]),
    ]
    expect(finalAssistantOutput(events)).toEqual([{ type: 'text', text: 'complete answer' }])
  })

  it('treats textless assistant content as a non-empty message', () => {
    const content: ContentBlock[] = [{ type: 'reasoning', text: 'complete reasoning' }]
    expect(finalAssistantOutput([
      textDelta('streamed text'),
      message(content),
      textDelta('later partial'),
    ])).toEqual(content)
  })

  it('falls back to text deltas without including reasoning or tool-result content', () => {
    const events = [
      reasoningDelta('thinking'),
      textDelta('partial '),
      toolResult('tool output'),
      textDelta('answer'),
      message([]),
    ]
    expect(finalAssistantOutput(events)).toEqual([{ type: 'text', text: 'partial answer' }])
  })

  it('returns undefined when the child produced neither messages nor text', () => {
    expect(finalAssistantOutput([])).toBeUndefined()
    expect(finalAssistantOutput([reasoningDelta('thinking'), message([])])).toBeUndefined()
  })
})

describe('AssistantOutputFold', () => {
  it('folds raw text pieces into the same streamed fallback (ACP chunk transport)', () => {
    const fold = new AssistantOutputFold()
    fold.pushText('partial ')
    fold.pushText('')
    fold.pushText('answer')
    expect(fold.collect()).toEqual([{ type: 'text', text: 'partial answer' }])
  })

  it('collects undefined until any output is folded', () => {
    expect(new AssistantOutputFold().collect()).toBeUndefined()
  })
})
