import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  ToolCallId,
  boundContextSummary,
  CONTEXT_SUMMARY_MAX_CHARS,
  createAssistantMessage,
  createDeveloperMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  freezeMessage,
  MessageId,
} from '@deepseek-ai/dsh-llm'

describe('message construction', () => {
  it('detaches and freezes developer tool names without copying their definitions', () => {
    const content = [{ type: 'tool-addition' as const, toolName: 'search' }]
    const message = createDeveloperMessage({ content, source: { kind: 'test' } })
    content[0]!.toolName = 'changed'
    expect(message.role).toBe('developer')
    expect(message.content).toEqual([{ type: 'tool-addition', toolName: 'search' }])
    expect(Object.isFrozen(message.content[0])).toBe(true)
    expect(freezeMessage(message).id).toBe(message.id)
  })

  it('bounds producer summaries while preserving summaries at the exact limit', () => {
    const exact = 'x'.repeat(CONTEXT_SUMMARY_MAX_CHARS)
    expect(boundContextSummary(exact)).toBe(exact)
    expect(boundContextSummary(exact + 'x')).toBe(exact.slice(0, -1) + '…')
  })

  it('preserves system-prompt attribution on immutable system messages', () => {
    const expectedSource: { kind: 'system-prompt' } = { kind: 'system-prompt' }
    const message = createSystemMessage('rule')
    expectTypeOf(message.source).toEqualTypeOf(expectedSource)
    expect(message.role).toBe('system')
    expect(message.content).toEqual([{ type: 'text', text: 'rule' }])
    expect(message.source).toEqual(expectedSource)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.source)).toBe(true)
    expect(createSystemMessage('').content).toEqual([])
  })

  it('assigns identity immediately and returns a detached deep-frozen message', () => {
    const input = {
      content: [{ type: 'text' as const, text: 'original' }],
      source: { kind: 'test' as const },
    }

    const message = createUserMessage(input)

    expect(message.id).toEqual(expect.any(String))
    expect(message.role).toBe('user')
    expect(message.id).not.toHaveLength(0)
    expect(message).not.toBe(input)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content)).toBe(true)
    expect(Object.isFrozen(message.content[0])).toBe(true)
    expect(Object.isFrozen(message.source)).toBe(true)

    input.content[0]!.text = 'caller mutation'
    expect(message.content).toEqual([{ type: 'text', text: 'original' }])
    expect(() => {
      (message.content[0] as { text: string }).text = 'observer mutation'
    }).toThrow()
  })

  it('freezes an existing identity without minting a replacement', () => {
    const id = MessageId('existing')
    const input = {
      id,
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'answer' }],
      source: { kind: 'model' as const, provider: 'test', model: 'test' },
    }

    const message = freezeMessage(input)

    expect(message).not.toBe(input)
    expect(message.id).toBe(id)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content[0])).toBe(true)
  })

  it('fixes the assistant role and model source kind at creation', () => {
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'answer' }],
      source: {
        provider: 'test-provider',
        model: 'test-model',
        replayState: { request: 1 },
      },
    })

    expect(message).toMatchObject({
      role: 'assistant',
      source: {
        kind: 'model',
        provider: 'test-provider',
        model: 'test-model',
        replayState: { request: 1 },
      },
    })
    expect(message.id).not.toHaveLength(0)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.source)).toBe(true)
  })

  it('couples tool-result content and its cited call seq to one call identity', () => {
    const callId = ToolCallId('call-1')
    const message = createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'result' }],
      isError: false,
    })

    expect(message).toMatchObject({
      role: 'tool',
      toolCallId: callId,
      isError: false,
      source: { kind: 'tool', callId },
      content: [{ type: 'text', text: 'result' }],
    })
    expect(message.id).not.toHaveLength(0)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content[0])).toBe(true)
  })
})
