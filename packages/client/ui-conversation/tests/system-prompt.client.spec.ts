import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { inspectSystemPrompt, type SystemPromptState } from '../src/client/contract/system-prompt.ts'

function system(seq: number, text: string, replaces?: number): SessionEvent {
  return {
    seq, time: seq, type: 'system/message',
    data: { turn: 1, step: seq, message: { role: 'system', content: [{ type: 'text', text }] } },
    surfaceOp: replaces === undefined ? 'append' : { op: 'replace', startSeq: replaces, endSeq: replaces },
  } as SessionEvent
}

function replace(seq: number, start: number, end: number): SessionEvent {
  return { seq, time: seq, type: 'user/message', surfaceOp: { op: 'replace', startSeq: start, endSeq: end } } as SessionEvent
}

function fold(events: readonly SessionEvent[]): SystemPromptState | undefined {
  return events.reduce<SystemPromptState | undefined>((previous, event) => inspectSystemPrompt(previous, event), undefined)
}

describe('loaded system surface interpretation', () => {
  it('withholds unknown replacement order until the missing prefix is loaded', () => {
    const prefix = [system(1, 'A'), system(3, 'B'), system(5, 'A2', 1)]
    const tail = [system(6, 'C', 3), system(7, 'D', 5)]
    expect(fold(tail)?.effective).toBeUndefined()
    expect(fold([...prefix, ...tail])?.effective?.text).toBe('C')
  })

  it('restores A after compaction shadows B while preserving historical state', () => {
    const a = fold([system(1, 'A')])
    const b = inspectSystemPrompt(a, system(4, 'B'))
    const restored = inspectSystemPrompt(b, replace(7, 3, 5))
    expect(restored.effective).toMatchObject({ text: 'A', seq: 7, update: false })
    expect(a?.effective?.text).toBe('A')
    expect(b.effective?.text).toBe('B')
    expect(inspectSystemPrompt(restored, replace(8, 7, 7)).effective).toBe(restored.effective)
  })

  it('uses surface order across chained replacements with reversed chronological endpoints', () => {
    const state = fold([
      system(1, 'A'), system(4, 'B'), system(6, 'C'),
      system(8, 'new A', 1), replace(9, 3, 5), replace(10, 9, 6),
    ])
    expect(state?.effective).toMatchObject({ text: 'new A', seq: 10 })
    expect(state?.nodes.map(item => item.node.text)).toEqual(['new A'])
  })

  it('keeps later nonempty nodes authoritative over head rewrites and ignores empty tails', () => {
    const b = fold([system(1, 'A'), system(3, 'B'), system(5, 'head', 1)])
    expect(b?.effective?.text).toBe('B')
    const head = inspectSystemPrompt(b, system(6, '', 3))
    expect(head.effective).toMatchObject({ text: 'head', seq: 6, update: false })
    expect(inspectSystemPrompt(head, system(7, '', 5)).effective?.text).toBe('')
  })

  it('does not invent an unloaded head after a cross-window replacement', () => {
    const state = fold([system(8, 'B'), replace(12, 5, 9)])
    expect(state?.nodes).toEqual([])
    expect(state?.effective).toBeUndefined()
    expect(fold([replace(12, 5, 9)])?.effective).toBeUndefined()
  })

  it('drops shadowed replacement endpoints without mutating historical prefixes', () => {
    const first = fold([system(1, 'A'), system(2, 'B', 1)])
    let state = first
    for (let seq = 3; seq < 100; seq++) state = inspectSystemPrompt(state, system(seq, 'C', seq - 1))
    expect(state?.replacements.size).toBe(1)
    expect([...state!.replacements]).toEqual([[99, 1]])
    expect([...first!.replacements]).toEqual([[2, 1]])
    expect(first?.effective?.text).toBe('B')
  })

  it('extracts text blocks once and treats an empty initial node as no prompt', () => {
    const event = system(1, 'A')
    if (event.type !== 'system/message') throw new Error('expected system event')
    const multiBlock = { ...event, data: { ...event.data, message: {
      ...event.data.message, content: [{ type: 'text' as const, text: 'A' }, { type: 'text' as const, text: 'B' }],
    } } }
    expect(inspectSystemPrompt(undefined, multiBlock).effective?.text).toBe('AB')
    expect(inspectSystemPrompt(undefined, system(2, '')).effective).toBeUndefined()
  })
})
