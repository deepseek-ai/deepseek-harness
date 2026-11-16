import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, type ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createSettlementMessage } from '../src/continuation-messages.ts'

const childId = brandString<SessionId>('settled-child')
const childName = 'reviewer/checker'
const summary = { type: 'text', text: `Background subagent ${childName} finished and will do no further work unless you send it more.` }
const reasoning: ContentBlock = { type: 'reasoning', text: 'private child reasoning' }
const toolCall: ContentBlock = { type: 'tool-call', id: brandString<ToolCallId>('child-call'), name: 'read', arguments: '{}' }

describe('settlement attribution', () => {
  it.each(['completed', 'aborted', 'max-tokens', 'refusal', 'error'] as const)(
    'records the exact %s stop reason without changing model content', (stopReason) => {
      const terminal = { stopReason, output: [{ type: 'text' as const, text: '  answer\n' }] }
      const message = createSettlementMessage(childId, childName, terminal)
      expect(message.source).toMatchObject({
        kind: 'subagent-settled', form: 'notice',
        senderSessionId: childId, stopReason,
      })
      expect(message.content.slice(1)).toEqual([
        { type: 'text', text: 'Its closing message:' },
        ...terminal.output,
      ])
    },
  )

  it('preserves historical notices without inferring missing attribution from English', () => {
    const source = { kind: 'subagent-settled' as const, form: 'notice' as const,
      summary: 'Historical runtime summary', senderSessionId: childId }
    const content = [{ type: 'text' as const, text: 'Background subagent settled-child finished.' }]
    const message = createUserMessage({ source, content })
    expect(message.source).toEqual(source)
    expect(message.source).not.toHaveProperty('stopReason')
    expect(message.content).toEqual(content)
  })
})

describe('continuable settlement content', () => {
  it.each([
    ['reasoning before the answer', [reasoning, { type: 'text', text: 'answer' }]],
    ['a tool call after the answer', [{ type: 'text', text: 'answer' }, toolCall]],
  ] satisfies [string, ContentBlock[]][])('reports only the closing text with %s', (_label, output) => {
    const original = structuredClone(output)
    const message = createSettlementMessage(childId, childName, { stopReason: 'completed', output })

    expect(message.role).toBe('user')
    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: 'answer' },
    ])
    expect(output).toEqual(original)
  })

  it.each([
    ['empty output', []],
    ['reasoning-only output', [reasoning]],
    ['empty text', [{ type: 'text', text: '' }]],
  ] satisfies [string, ContentBlock[]][])('reports no closing message for %s', (_label, output) => {
    const message = createSettlementMessage(childId, childName, { stopReason: 'completed', output })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'It left no closing message.' },
    ])
  })

  it('preserves text block order and bytes around omitted reasoning and tool calls', () => {
    const first: ContentBlock = { type: 'text', text: '  first\n' }
    const second: ContentBlock = { type: 'text', text: '\n第二段  ' }
    const message = createSettlementMessage(childId, childName, {
      stopReason: 'completed',
      output: [reasoning, first, toolCall, second],
    })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      first,
      second,
    ])
  })
})

it('includes closing text alongside structured results and diagnostics', () => {
  expect(createSettlementMessage(childId, childName, {
    stopReason: 'completed', output: [{ type: 'text', text: 'final answer' }],
    structured: { answer: 42 }, diagnostic: 'safe diagnostic',
  }).content).toEqual([
    summary,
    { type: 'text', text: 'Its closing message:' },
    { type: 'text', text: 'final answer' },
    { type: 'text', text: 'Structured result: {"answer":42}' },
    { type: 'text', text: 'safe diagnostic' },
  ])
})

it('omits the closing text after the child messaged its parent, keeping structured results and diagnostics', () => {
  expect(createSettlementMessage(childId, childName, {
    stopReason: 'completed', output: [{ type: 'text', text: 'final answer, restated' }],
    structured: { answer: 42 }, diagnostic: 'safe diagnostic',
  }, true, true).content).toEqual([
    summary,
    { type: 'text', text: 'It sent you a message just before finishing, so its closing message is omitted.' },
    { type: 'text', text: 'Structured result: {"answer":42}' },
    { type: 'text', text: 'safe diagnostic' },
  ])
})
