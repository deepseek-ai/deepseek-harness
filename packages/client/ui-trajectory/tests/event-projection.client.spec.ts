import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import {
  contextForm, contextProducer, displayFailure, emptyAssistantBlock, isTokenDelta,
  toAssistantBlock, toAssistantBlocks,
} from '../src/client/trajectory-event-projection.ts'

describe('Trajectory event projection', () => {
  it('projects known, unknown, and unreadable context sources', () => {
    expect(contextProducer({ kind: 'session-reference', references: [{ label: 'A' }, { label: 'A' }] }))
      .toEqual({ role: 'recall', label: 'A' })
    expect(contextProducer({ kind: 'session-reference', references: [] }))
      .toEqual({ role: 'recall', label: 'session-reference' })
    expect(contextProducer({ kind: 'agent-instructions', changes: [{ path: 'AGENTS.md' }, null] }))
      .toEqual({ role: 'inject', label: 'AGENTS.md' })
    expect(contextProducer({ kind: 'agent-instructions', changes: 'bad' }).label)
      .toBe('agent-instructions')
    expect(contextProducer({ kind: 'p' }).label).toBe('p')
    expect(contextProducer({ kind: 'plugin', plugin: 1 }).label).toBe('plugin')
    expect(contextProducer({ kind: 'skill-invocation', name: 's' }).label).toBe('s')
    expect(contextProducer({ kind: 'future' }).label).toBe('future')
    expect(contextProducer(null)).toEqual({ role: 'inject', label: null })
    expect(contextProducer([])).toEqual({ role: 'inject', label: null })
    expect(contextProducer({ kind: '' })).toEqual({ role: 'inject', label: null })
  })

  it('accepts only forms supported by the target', () => {
    for (const form of ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall']) {
      expect(contextForm({ form })).toBe(form)
    }
    expect(contextForm({ form: 'future' })).toBeNull()
    expect(contextForm({ form: 1 })).toBeNull()
    expect(contextForm(null)).toBeNull()
  })

  it('projects finalized and empty Assistant blocks', () => {
    const content = [
      { type: 'text', text: 'a' },
      { type: 'reasoning', text: 'b' },
      { type: 'image', attachment: { attachmentId: 'x' } },
      { type: 'tool-call', id: 'c', name: 'n', arguments: '{}' },
      { type: 'future' },
    ] as unknown as ContentBlock[]
    expect(toAssistantBlocks(content).map(block => block.kind))
      .toEqual(['text', 'reasoning', 'image', 'tool-call', 'other'])
    expect(toAssistantBlock(content[0]!)).toEqual({ kind: 'text', text: 'a' })
    expect(['text', 'reasoning', 'tool-call', 'future'].map(emptyAssistantBlock))
      .toEqual([
        { kind: 'text', text: '' },
        { kind: 'reasoning', text: '' },
        { kind: 'tool-call', callId: '', name: '', argsRaw: '' },
        { kind: 'other', block: null },
      ])
  })

  it('redacts auth failures and presents other durable values', () => {
    expect(displayFailure({ code: 'AUTH', message: 'secret' })).toEqual({ code: 'AUTH', message: '' })
    expect(displayFailure({ message: 'offline' })).toEqual({ message: 'offline' })
    expect(displayFailure({ code: 'UNKNOWN' })).toEqual({ code: 'UNKNOWN', message: '{"code":"UNKNOWN"}' })
    expect(displayFailure(undefined)).toEqual({ message: 'undefined' })
  })

  it('recognizes only non-empty token deltas', () => {
    expect(isTokenDelta({ type: 'text-delta', index: 0, text: 'x' } as never)).toBe(true)
    expect(isTokenDelta({ type: 'reasoning-delta', index: 0, text: '' } as never)).toBe(false)
    expect(isTokenDelta({ type: 'tool-call-delta', index: 0, id: 'c', argumentsDelta: '}' } as never)).toBe(true)
    expect(isTokenDelta({ type: 'tool-call-delta', index: 0, id: 'c', argumentsDelta: '' } as never)).toBe(false)
    expect(isTokenDelta({ type: 'finish', reason: 'stop' } as never)).toBe(false)
  })
})
