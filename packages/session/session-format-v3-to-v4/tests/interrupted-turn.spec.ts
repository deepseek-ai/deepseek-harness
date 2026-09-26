import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector, type SessionFormatEvent, type SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { createSessionFormatCatalogWithChildren, sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { Session, SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import { createSessionFormatV3ToV4 } from '../src/index.ts'
import { remapV3References } from '../src/references.ts'

const header = { type: 'session', version: 3, id: 'restart', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const nativeHeader: SessionHeader = { version: 4, id: SessionId(header.id), createdAt: 1, isSeeded: false, delegationDepth: 0 }
const user = (id: string) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: id }] })
const row = (type: string, data: SessionFormatJsonObject) => ({ type, data })
const splice = () => row('agent/inbox/spliced', { target: 'next-turn', inserted: [user('next')] })
const start = (turn: number) => row('turn/start', { turn })
const end = (turn: number) => row('turn/end', { turn, reason: { kind: 'completed' } })
const titleMessage = { ...user('captured seq 4'), source: { kind: 'dsh-session-title-llm' } }
const prefix = () => [start(1), row('step/start', { turn: 1, step: 1 }), row('step/end', { turn: 1, step: 1 }), splice()]
function events(rows: readonly object[]): SessionFormatEvent[] {
  return rows.map((event, seq) => ({ ...event, seq, time: seq + 10 }) as SessionFormatEvent)
}
function restore(rows: readonly SessionFormatEvent[], physical = header) {
  const reader = createSessionFormatCatalogWithChildren([]).createRestore(physical, { recovery: 'strict', validation: 'current' })
  for (const event of rows) reader.decodeRow(event)
  return reader.finish()
}

describe('V3 interrupted-turn migration', () => {
  it('closes an interrupted turn at the next-turn restart and reopens the resulting V4 unchanged', () => {
    const source = events([...prefix(), start(2), end(2)])
    const original = structuredClone(source)
    const artifact = restore(source)
    expect(artifact.events).toEqual([
      ...source.slice(0, 4),
      { type: 'turn/end', seq: 4, time: 14, data: { turn: 1, reason: { kind: 'interrupted' } } },
      ...source.slice(4).map(event => ({ ...event, seq: event.seq + 1 })),
    ])
    const native = sessionFormatCatalog.createRestore({ ...header, version: 4 }, { recovery: 'strict', validation: 'current' })
    for (const event of artifact.events) native.decodeRow(event)
    expect(native.finish()).toEqual(artifact)
    expect(source).toEqual(original)
    expect(() => restore(source, { ...header, version: 4 })).toThrow('turn/start does not open the expected turn')
  })

  it('retains open tails and balanced turns, and repairs each independently evidenced restart', () => {
    const tail = events(prefix())
    expect(restore(tail).events).toEqual(tail)
    const balanced = events([...prefix(), end(1), start(2), end(2)])
    expect(restore(balanced).events).toEqual(balanced)
    const twice = restore(events([...prefix(), start(2), splice(), start(3), end(3)]))
    expect(twice.events.filter(event => event.type === 'turn/end').map(event => event.data)).toEqual([
      { turn: 1, reason: { kind: 'interrupted' } }, { turn: 2, reason: { kind: 'interrupted' } },
      { turn: 3, reason: { kind: 'completed' } },
    ])
    expect(twice.events.map(event => event.seq)).toEqual(twice.events.map((_, seq) => seq))
  })

  it.each([
    ['repeated turn', [...prefix(), start(1)]],
    ['skipped turn', [...prefix(), start(3)]],
    ['empty splice', [...prefix().slice(0, 3), row('agent/inbox/spliced', { target: 'next-turn', inserted: [] }), start(2)]],
    ['step splice', [...prefix().slice(0, 3), row('agent/inbox/spliced', { target: 'next-step', inserted: [user('next')] }), start(2)]],
    ['nonadjacent splice', [...prefix(), row('feedback/record', {}), start(2)]],
    ['open step', [...prefix().slice(0, 2), splice(), start(2)]],
    ['unsettled compaction', [start(1), row('compaction/start', { compactionId: 'c', turn: 1 }), splice(), start(2)]],
  ])('refuses %s', (_name, rows) => {
    expect(() => restore(events(rows as object[]))).toThrow()
  })

  it('remaps both sides of a restart through compaction, surface replacement, command completion, and titles', () => {
    const source = events([
      start(1), { ...row('user/message', user('before')), surfaceOp: 'append' }, splice(), start(2),
      { ...row('user/message', user('after')), surfaceOp: 'append' },
      row('compaction/start', { compactionId: 'c', turn: 2 }),
      row('compaction/summary', { compactionId: 'c', summary: [{ type: 'text', text: 'summary' }], shadowedRange: { start: 1, end: 4 }, shadowedSeqs: [1, 4], shadowedTokenCount: 1, provider: 'mock', model: 'mock' }),
      { ...row('user/message', { ...user('checkpoint'), source: { kind: 'plugin', plugin: 'compact', compactionId: 'c' } }), surfaceOp: { op: 'replace', startSeq: 1, endSeq: 4 }, sourceEventSeqs: [1, 4, 5, 6] },
      row('compaction/end', { compactionId: 'c', turn: 2 }),
      row('command/run', { commandId: 'cmd', name: 'test', source: { kind: 'user' } }),
      row('command/done', { commandId: 'cmd', kind: 'success', sourceEventSeq: 7 }),
      row('session/title', { title: 'title', source: { kind: 'generated' }, messageSeqs: [1, 4] }),
      row('session/title-llm-request', { messageSeqs: [1, 4], messages: [titleMessage] }),
      row('session-log-deepseek/delivery-accepted', { sessionId: header.id, sessionFormatVersion: 3, throughSeq: 12 }),
      { ...row('user/message', { ...user('capture'), source: { kind: 'plugin', plugin: 'session-reference', sessionId: 'other', seq: 4, sessionFormatVersion: 3 } }), surfaceOp: 'append' },
      { ...row('external/opaque', { seq: 4 }), ignorable: true, sourceEventSeqs: [4], surfaceOp: { opaque: 4 } },
      end(2),
    ])
    const original = structuredClone(source)
    const artifact = restore(source)
    expect(artifact.events[7]).toMatchObject({ data: { shadowedRange: { start: 1, end: 5 }, shadowedSeqs: [1, 5] } })
    expect(artifact.events[8]).toMatchObject({ sourceEventSeqs: [1, 5, 6, 7], surfaceOp: { op: 'replace', startSeq: 1, endSeq: 5 } })
    expect(artifact.events[11]).toMatchObject({ data: { sourceEventSeq: 8 } })
    expect(artifact.events[12]).toMatchObject({ data: { messageSeqs: [1, 5] } })
    expect(artifact.events[13]).toMatchObject({ data: { messageSeqs: [1, 5], messages: [titleMessage] } })
    expect(artifact.events[14]?.data).toEqual(source[13]?.data)
    expect(artifact.events[15]).toMatchObject({ data: { source: { kind: 'session-reference', sessionId: 'other', seq: 4, sessionFormatVersion: 3 } } })
    expect(artifact.events[16]).toEqual({ ...source[15], type: 'plugin:external/opaque', seq: 16 })
    expect(artifact.header).toEqual(nativeHeader)
    const session = Session.fromRestore(nativeHeader.id, artifact.events as SessionEvent[], nativeHeader, SessionLogOffset(0), 'detached')
    expect(session.deriveMessages().map(message => message.id)).toEqual(['checkpoint', 'capture'])
    expect(source).toEqual(original)
  })

  it('remaps image offload targets while retaining occurrence indexes and image identities', () => {
    const image = { type: 'image', attachment: { attachmentId: 'image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }
    const artifact = restore(events([...prefix(), start(2),
      { ...row('user/message', { ...user('picture'), content: [image] }), surfaceOp: 'append' },
      row('image/offload', { targets: [{ seq: 5, imageIndexes: [0] }] }), end(2),
    ]))
    expect(artifact.events[7]).toMatchObject({ data: { targets: [{ seq: 6, imageIndexes: [0] }] } })
    expect(artifact.header).toEqual(nativeHeader)
    const session = Session.fromRestore(nativeHeader.id, artifact.events as SessionEvent[], nativeHeader, SessionLogOffset(0), 'detached', [imageOffloadProjection])
    expect(session.deriveMessages()).toMatchObject([{ id: 'picture', content: [{ type: 'image', attachment: image.attachment, offloaded: true }] }])
  })

  it('remaps the final inherited cut and validates delivery ownership in source coordinates', () => {
    const seeded = { ...header, isSeeded: true, parentSession: 'parent' }
    const marker = row('session/end-seed', { inherited: true })
    const foreign = row('session-log-deepseek/delivery-accepted', { sessionId: 'parent', throughSeq: 4, sessionFormatVersion: 3 })
    const source = events([...prefix(), start(2), foreign, end(2), marker])
    expect(restore(source, seeded).inheritedEventCount).toBe(8)
    expect(restore(events([...prefix(), start(2), marker, foreign, marker]), seeded).inheritedEventCount).toBe(8)
    expect(restore(events([...prefix(), end(1), marker, start(2), splice(), start(3)]), seeded).inheritedEventCount).toBe(5)
    expect(() => restore(events([...prefix(), start(2), marker, foreign]), seeded)).toThrow('wrong Session')
    const current = createSessionFormatV3ToV4([]).createStage({ sourceHeader: seeded, targetHeader: { ...seeded, version: 4 }, sourceKind: 'decoded', sourceInheritedEventCount: 7 })
    const output = new SessionFormatEventCollector()
    current.transformRun({ runType: 'restart', eventCount: source.length, firstSeq: 0, *expand() { yield* source } }, output)
    expect(current.finish(output)).toBe(8)
    expect(output.values).toEqual(restore(source, seeded).events)
  })

  it('refuses unresolved tool advertisements even when a restart has the expected splice', () => {
    const source = events([
      ...prefix().slice(0, 2),
      { ...row('assistant/message', { turn: 1, step: 1, stream: [], message: {
        id: 'assistant', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [{ type: 'tool-call', id: 'call', name: 'test', arguments: '{}' }],
      } }), surfaceOp: 'append' },
      ...prefix().slice(2), start(2),
    ])
    expect(() => restore(source)).toThrow('unresolved')
  })

  it('remaps prune ranges and optional command references without interpreting unrelated data', () => {
    expect(remapV3References({ ...row('compaction/prune', { shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1] }), seq: 2, time: 1 }, 3, [0, 2]).data)
      .toEqual({ shadowedRange: { start: 0, end: 2 }, shadowedSeqs: [0, 2] })
    expect(remapV3References({ ...row('command/done', { commandId: 'c', kind: 'error' }), seq: 1, time: 1 }, 2, [0]).data)
      .toEqual({ commandId: 'c', kind: 'error' })
    expect(remapV3References({ type: 'feedback/record', data: null, seq: 1, time: 1 }, 2, [0]).data).toBeNull()
  })

  it.each([
    { type: 'command/done', data: null },
    row('command/done', { sourceEventSeq: 2 }),
    row('command/done', { sourceEventSeq: -1 }),
    row('session/title', { messageSeqs: null }),
    row('image/offload', { targets: null }),
    row('image/offload', { targets: [null] }),
  ])('refuses malformed source references after insertion: %j', (source) => {
    expect(() => remapV3References({ ...source, seq: 2, time: 1 }, 3, [0, 2])).toThrow()
  })
})
