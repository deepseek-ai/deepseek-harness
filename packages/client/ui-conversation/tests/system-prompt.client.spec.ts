import { describe, expect, it } from 'vitest'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { inspectSystemPrompt, type SystemPromptState } from '../src/client/contract/system-prompt.ts'

function system(seq: number, text: string, replaces?: number): SessionEvent<'system/message'> {
  return {
    seq: SessionSeq(seq), time: seq, type: 'system/message',
    data: { turn: 1, step: seq, message: {
      id: brandString<MessageId>(`system-${seq}`), role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' },
    } },
    surfaceOp: replaces === undefined ? 'append' : { op: 'replace', startSeq: SessionSeq(replaces), endSeq: SessionSeq(replaces) },
  }
}

type SectionSpec = readonly [name: string, text: string | null, notice?: string]

/** A section-attributed message: each spec is `[name, text]`, or `[name, null]` to retire, with an optional notice before it. */
function sectioned(
  seq: number,
  specs: readonly SectionSpec[],
  options: { replaces?: number; reset?: true; lead?: string; order?: Readonly<Record<string, number>> } = {},
): SessionEvent<'system/message'> {
  const content: { type: 'text'; text: string }[] = options.lead === undefined ? [] : [{ type: 'text', text: options.lead }]
  const sections = specs.map(([name, text, notice]) => {
    const noticeIndex = notice === undefined ? undefined : [content.push({ type: 'text', text: notice }) - 1]
    const shared = { name, ...(noticeIndex === undefined ? {} : { noticeIndex }) }
    if (text === null) return { ...shared, state: 'retired' as const }
    return {
      ...shared, state: 'active' as const, order: options.order?.[name] ?? 100,
      contentIndex: content.push({ type: 'text', text: ` ${text}\n` }) - 1,
    }
  })
  const event = system(seq, '', options.replaces)
  return { ...event, data: { ...event.data, message: {
    ...event.data.message, content,
    source: { kind: 'system-prompt', sections, ...(options.reset === true ? { reset: true as const } : {}) },
  } } }
}

function replace(seq: number, start: number, end: number): SessionEvent<'user/message'> {
  return {
    seq: SessionSeq(seq), time: seq, type: 'user/message',
    data: { id: brandString<MessageId>(`user-${seq}`), role: 'user', source: { kind: 'user' }, content: [] },
    surfaceOp: { op: 'replace', startSeq: SessionSeq(start), endSeq: SessionSeq(end) },
  }
}

function fold(events: readonly SessionEvent[]): SystemPromptState | undefined {
  return events.reduce<SystemPromptState | undefined>((previous, event) => inspectSystemPrompt(previous, event), undefined)
}

describe('loaded system surface interpretation', () => {
  it('tracks head replacements while retaining later updates', () => {
    const events = [system(1, 'initial'), system(3, 'updated'), system(5, 'tail')]
    const first = fold([...events, system(8, 'snapshot', 1), replace(9, 2, 4)])
    expect(first?.nodes.map(item => item.node.text)).toEqual(['snapshot', 'tail'])
    const repeated = fold([...events, system(8, 'snapshot', 1), replace(9, 2, 4),
      system(10, 'new snapshot', 8), replace(11, 9, 5)])
    expect(repeated?.nodes.map(item => item.node.text)).toEqual(['new snapshot'])
    expect(first?.nodes.map(item => item.node.text)).toEqual(['snapshot', 'tail'])
  })

  it('withholds unknown replacement order until the missing prefix is loaded', () => {
    const prefix = [system(1, 'A'), system(3, 'B'), system(5, 'A2', 1)]
    const tail = [system(6, 'C', 3), system(7, 'D', 5)]
    expect(fold(tail)?.effective).toBeUndefined()
    expect(fold([...prefix, ...tail])?.effective?.text).toBe('D\n\nC')
  })

  it('restores A after compaction shadows B while preserving historical state', () => {
    const a = fold([system(1, 'A')])
    const b = inspectSystemPrompt(a, system(4, 'B'))
    const restored = inspectSystemPrompt(b, replace(7, 3, 5))
    expect(restored.effective).toMatchObject({ text: 'A', seq: 7, update: false })
    expect(a?.effective?.text).toBe('A')
    expect(b.effective?.text).toBe('A\n\nB')
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

  it('combines surviving additions across head rewrites and ignores empty tails', () => {
    const b = fold([system(1, 'A'), system(3, 'B'), system(5, 'head', 1)])
    expect(b?.effective?.text).toBe('head\n\nB')
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
    expect(inspectSystemPrompt(undefined, multiBlock).effective?.text).toBe('A\n\nB')
    expect(inspectSystemPrompt(undefined, system(2, '')).effective).toBeUndefined()
  })

  it('classifies each source of an update against the instructions in force before it', () => {
    const head = fold([sectioned(1, [['identity', 'I'], ['plan', 'on'], ['tool', 'T'], ['memo', 'M']], { order: { identity: 1 } })])
    expect(head?.introduced?.message).toBeUndefined()
    expect(head?.sections?.map(item => item.name)).toEqual(['identity', 'memo', 'plan', 'tool'])
    const update = inspectSystemPrompt(head, sectioned(4, [
      ['plan', 'off', 'plan changed'], ['tool', null, 'tool retired'], ['memo', ''], ['identity', 'I'], ['late', 'L'],
    ], { lead: 'everything shifts', order: { identity: 5 } }))
    expect(update.introduced?.message).toEqual({
      reset: false,
      notices: ['everything shifts'],
      changes: [
        { name: 'plan', change: 'updated', text: 'off', notices: ['plan changed'] },
        { name: 'tool', change: 'removed', text: '', notices: ['tool retired'] },
        { name: 'memo', change: 'cleared', text: '', notices: [] },
        { name: 'identity', change: 'reordered', text: 'I', notices: [] },
        { name: 'late', change: 'added', text: 'L', notices: [] },
      ],
    })
    expect(update.sections).toEqual([
      { name: 'identity', order: 5, text: 'I' },
      { name: 'late', order: 100, text: 'L' },
      { name: 'memo', order: 100, text: '' },
      { name: 'plan', order: 100, text: 'off' },
    ])
    expect(update.effective?.sections).toBe(update.sections)
    expect(update.effective?.message).toBe(update.introduced?.message)
    expect(head?.sections?.find(item => item.name === 'plan')?.text).toBe('on')
  })

  it('supersedes every earlier source on reset and restates unchanged text as unchanged', () => {
    const head = fold([sectioned(1, [['identity', 'I'], ['plan', 'on']])])
    const complete = inspectSystemPrompt(head, sectioned(3, [['persona', 'P'], ['plan', 'on']], { reset: true }))
    expect(complete.introduced?.message).toMatchObject({
      reset: true,
      changes: [{ name: 'persona', change: 'added' }, { name: 'plan', change: 'unchanged' }],
    })
    expect(complete.sections?.map(item => item.name)).toEqual(['persona', 'plan'])
  })

  it('changes the effective prompt when an update without text clears a source', () => {
    const head = fold([sectioned(1, [['rules', 'R'], ['memo', 'M']])])
    expect(head?.introduced?.sections).toEqual(head?.sections)
    const cleared = inspectSystemPrompt(head, sectioned(3, [['memo', '']]))
    expect(cleared.effective?.text).toBe(head?.effective?.text)
    expect(cleared.effective).not.toBe(head?.effective)
    expect(cleared.effective).toMatchObject({
      seq: 3, update: true, sections: [{ name: 'memo', text: '' }, { name: 'rules', text: 'R' }],
      message: { changes: [{ name: 'memo', change: 'cleared' }] },
    })
    expect(cleared.introduced?.sections).toBe(cleared.sections)
    // Restating the same instructions changes nothing.
    expect(inspectSystemPrompt(cleared, sectioned(5, [['memo', '']])).effective).toBe(cleared.effective)
  })

  it('marks a prompt established by replacements as rebuilt and reads no update from it', () => {
    const before = fold([sectioned(1, [['identity', 'I'], ['plan', 'on']]), sectioned(4, [['plan', 'off']])])
    expect(before?.effective).not.toHaveProperty('rebuilt')
    const cleared = inspectSystemPrompt(before, system(6, '', 4))
    expect(cleared.sections?.find(item => item.name === 'plan')?.text).toBe('on')
    expect(cleared.effective).toMatchObject({ rebuilt: true, update: false })
    const rebuilt = inspectSystemPrompt(cleared, sectioned(7, [['identity', 'I'], ['plan', 'off']], { replaces: 1, reset: true }))
    expect(rebuilt.introduced?.message).toBeUndefined()
    expect(rebuilt.effective).toMatchObject({ rebuilt: true, sections: before?.sections })
    expect(rebuilt.effective).not.toHaveProperty('message')
    const next = inspectSystemPrompt(rebuilt, sectioned(9, [['plan', 'on']]))
    expect(next.effective).not.toHaveProperty('rebuilt')
    expect(next.effective?.message?.changes).toEqual([{ name: 'plan', change: 'updated', text: 'on', notices: [] }])
  })

  it('withholds per-source instructions while a nonempty message without section metadata applies', () => {
    const legacy = fold([system(1, 'whole prompt')])
    expect(legacy?.sections).toBeUndefined()
    expect(legacy?.introduced?.message).toBeUndefined()
    const delta = inspectSystemPrompt(legacy, sectioned(3, [['plan', 'on']]))
    expect(delta.sections).toBeUndefined()
    expect(delta.effective?.sections).toBeUndefined()
    expect(delta.introduced?.message?.changes).toEqual([{ name: 'plan', change: 'added', text: 'on', notices: [] }])
    const rebuilt = inspectSystemPrompt(delta, sectioned(5, [['plan', 'on']], { replaces: 1, reset: true }))
    expect(rebuilt.sections).toEqual([{ name: 'plan', order: 100, text: 'on' }])
    expect(fold([system(1, ''), sectioned(2, [['plan', 'on']])])?.sections).toHaveLength(1)
    expect(fold([replace(12, 5, 9)])?.sections).toBeUndefined()
  })
})
