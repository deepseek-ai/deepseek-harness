/** Developer surface positions and admission remain distinct from unknown ignorable records. */
import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { assertV4RowAdmission, releasedV4SessionFormatCodec as codec, restoreReleasedV4Artifact } from '../src/index.ts'

type Row = {
  type: string
  data: SessionFormatJsonValue
  surfaceOp?: SessionFormatJsonValue
  sourceEventSeqs?: SessionFormatJsonValue
  ignorable?: true
}
const coordinates = { turn: 1, step: 1 }
const begin: Row[] = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: coordinates },
]
const system: Row = { type: 'system/message', surfaceOp: 'append', data: {
  ...coordinates, message: { id: 'system', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'System' }] },
} }
const emptyDeveloper: Row = { type: 'developer/message', surfaceOp: 'append', data: {
  ...coordinates, message: { id: 'developer', role: 'developer', source: { kind: 'tool-registry' }, content: [] },
} }

function artifact(rows: readonly Row[]): SessionFormatArtifact {
  return {
    header: { version: 4, id: 'developer-relations', createdAt: 1, isSeeded: false, delegationDepth: 0 },
    events: rows.map((row, seq): SessionFormatEvent => ({ ...row, seq, time: seq + 1 })),
    inheritedEventCount: 0,
  }
}

function restore(rows: readonly Row[]): SessionFormatArtifact {
  const input = artifact(rows)
  return restoreReleasedV4Artifact(input, new Set(input.events.map(event => event.type)))
}

describe('V4 developer relationship admission', () => {
  it('retains an empty developer position while replacing the protected system head', () => {
    const replacement: Row = { ...system, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2], data: {
      ...coordinates, message: { id: 'replacement', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'Updated' }] },
    } }
    const input = restore([...begin, system, emptyDeveloper, replacement])
    const session = Session.fromRestore(SessionId(input.header.id), input.events as SessionEvent[],
      input.header as unknown as SessionHeader, SessionLogOffset(0), 'detached')
    expect(session.surface.nodes).toEqual([4, 3])
    expect(session.deriveMessages().map(message => message.id)).toEqual(['replacement'])
    expect(input.events[3]?.data).toEqual(emptyDeveloper.data)
  })

  it('rejects an empty developer replacement of the protected system head', () => {
    const replacement = { ...emptyDeveloper, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] }
    expect(() => restore([...begin, system, replacement])).toThrow(/protected system head/)
  })

  it('includes empty developer nodes in compaction spans and protects the system head', () => {
    const prune: Row = { type: 'compaction/prune', data: {
      shadowedRange: { start: 3, end: 3 }, shadowedSeqs: [3], shadowedTokenCount: 0,
    } }
    expect(() => restore([...begin, system, emptyDeveloper, prune])).not.toThrow()
    expect(() => restore([...begin, system, emptyDeveloper, { ...prune, data: {
      shadowedRange: { start: 2, end: 3 }, shadowedSeqs: [2, 3], shadowedTokenCount: 0,
    } }])).toThrow(/protected system head/)
  })

  it.each([
    { rows: [begin[0]!, emptyDeveloper] },
    { rows: [...begin, { ...emptyDeveloper, data: { ...coordinates, step: 2, message: {
      id: 'developer', role: 'developer', source: { kind: 'tool-registry' }, content: [],
    } } }] },
  ])('requires known developer messages to match the current open step %#', ({ rows }) => {
    expect(() => restore(rows)).toThrow(/open.*step/)
  })


  it('defers ignorable developer payloads during physical decoding while keeping encoder validation', () => {
    const opaque: Row = { type: 'developer/message', ignorable: true, data: {
      message: { role: 'developer', source: { kind: 'plugin' } }, future: true,
    }, surfaceOp: { future: true } }
    const input = artifact([opaque, ...begin, system])
    const physicalHeader = codec.encodeHeader(input.header, 0)
    const decoded = new SessionFormatEventCollector()
    const decoder = codec.createDecoder(physicalHeader, 'strict')
    for (const event of input.events) decoder.decodeRow(event, decoded)
    decoder.finish(decoded)
    expect(decoded.values).toEqual(input.events)
    expect(() => codec.encodeEvent(input.events[0]!)).toThrow()
    expect(() => { assertV4RowAdmission(input.events[0], new Set()) }).not.toThrow()
    expect(() => { assertV4RowAdmission(input.events[0], new Set(['developer/message'])) }).toThrow()

    const known = { ...input.events[0]!, data: emptyDeveloper.data }
    expect(codec.encodeEvent(known)).toMatchObject({ type: 'developer/message', ignorable: true })
  })

  it('keeps unknown ignorable developer fields and coordinates opaque before an ordinary step', () => {
    const opaque: Row = { type: 'developer/message', ignorable: true, data: {
      message: { role: 'developer', source: { kind: 'plugin' } }, future: true,
    }, surfaceOp: { future: true }, sourceEventSeqs: { future: true } }
    const input = artifact([opaque, ...begin, system])
    const before = JSON.stringify(input)
    const known = new Set(input.events.map(event => event.type))
    known.delete('developer/message')
    expect(restoreReleasedV4Artifact(input, known)).toBe(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(input.events.map(event => event.seq)).toEqual([0, 1, 2, 3])
    known.add('developer/message')
    expect(() => restoreReleasedV4Artifact(input, known)).toThrow()
  })
})
