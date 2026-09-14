import { describe, expect, it } from 'vitest'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { SessionFormatEventCollector, SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { releasedV3SessionFormatCodec, restoreReleasedV3Artifact } from '../src/index.ts'

const header = { type: 'session', version: 2, id: 'combined', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const config = { provider: 'mock', model: 'mock' }
const message = {
  id: 'tools-code-mode:message', role: 'user', source: { kind: 'plugin', plugin: 'tools-code-mode' },
  content: [{ type: 'text', text: 'tool/code-dispatch tools-code-mode' }],
}
const outer = { rootCallId: 'tools-code-mode:root', parentCallId: 'tools-code-mode:root', subCallId: 'tools-code-mode:child', name: 'run_code', arguments: {} }
const inner = { ...outer, parentCallId: outer.subCallId, subCallId: 'tools-ptc:child', name: 'read', arguments: { path: 'tools-code-mode' } }
function event(type: string, seq: number, data: SessionFormatEvent['data'], fields = {}): SessionFormatEvent {
  return { type, seq, time: seq + 1, data, ...fields }
}
const source = [
  event('turn/start', 0, { turn: 1 }),
  event('step/start', 1, { turn: 1, step: 1 }),
  event('user/message', 2, message, { surfaceOp: 'append' }),
  event('request/header', 3, { reason: 'initial', header: { config, system: 'prompt', tools: [], adapterDefaults: {} } }),
  event('tool/code-dispatch-start', 4, outer),
  event('tool/code-dispatch-start', 5, inner),
  event('tool/code-dispatch', 6, { ...inner, isError: false, content: message.content }),
  event('tool/code-dispatch', 7, { ...outer, isError: false, content: message.content }),
  event('compaction/prune', 8, { shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 17 }),
  event('user/message', 9, { ...message, id: 'tools-ptc:message' }, { surfaceOp: { op: 'replace', start: 2, end: 2 }, sourceEventSeqs: [2] }),
  event('request/header', 10, { reason: 'change', header: { config, system: '', tools: [], adapterDefaults: {} } }),
  event('step/end', 11, { turn: 1, step: 1 }),
  event('turn/end', 12, { turn: 1, reason: { kind: 'completed' } }),
]

function assertComposite(events: readonly SessionFormatEvent[]): void {
  const systems = events.filter(row => row.type === 'system/message')
  expect(systems.map(row => ({
    seq: row.seq, surfaceOp: row['surfaceOp'], sourceEventSeqs: row['sourceEventSeqs'],
    content: ((row.data as SessionFormatJsonObject)['message'] as SessionFormatJsonObject)['content'],
  }))).toEqual([
    { seq: 2, surfaceOp: 'append', sourceEventSeqs: undefined, content: [] },
    { seq: 4, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2], content: [{ type: 'text', text: 'prompt' }] },
    { seq: 12, surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 }, sourceEventSeqs: [4], content: [] },
  ])
  expect(events.filter(row => row.type !== 'system/message').slice(0, source.length)).toEqual(source.map(row => ({
    ...row,
    seq: row.seq + (row.seq < 2 ? 0 : row.seq < 3 ? 1 : row.seq < 10 ? 2 : 3),
    type: row.type === 'tool/code-dispatch-start' ? 'tool/ptc-dispatch-start' : row.type === 'tool/code-dispatch' ? 'tool/ptc-dispatch' : row.type,
    ...(row.type === 'user/message' ? { data: { ...row.data as SessionFormatJsonObject, source: { kind: 'plugin', plugin: 'tools-ptc' } } } : {}),
    ...(row.type === 'request/header' ? { data: { ...row.data as SessionFormatJsonObject, header: { config } } } : {}),
    ...(row.type === 'compaction/prune' ? { data: { shadowedRange: { start: 3, end: 3 }, shadowedSeqs: [3], shadowedTokenCount: 17 } } : {}),
    ...(row.seq === 9 ? { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, sourceEventSeqs: [3] } : {}),
  })))
}

describe('combined structural, canonical-envelope and PTC catalog migration', () => {
  it('inserts and clears system prompts while remapping replacement and nested PTC history without rewriting identities', () => {
    const before = JSON.stringify(source)
    const reader = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    for (const row of source) reader.decodeRow(row)
    const target = reader.finish()
    expect(target.header.version).toBe(3)
    expect(target.events).toHaveLength(source.length + 3)
    assertComposite(target.events)
    expect(restoreReleasedV3Artifact(target, new Set())).toBe(target)
    expect(JSON.stringify(source)).toBe(before)
    const native = sessionFormatCatalog.createRestore({ ...header, version: 3 }, { recovery: 'strict', validation: 'current' })
    for (const row of target.events) native.decodeRow(releasedV3SessionFormatCodec.encodeEvent(row))
    expect(native.finish()).toEqual(target)
    const mismatched = target.events.map(row => row.type === 'tool/ptc-dispatch' && (row.data as SessionFormatJsonObject)['subCallId'] === inner.subCallId
      ? { ...row, data: { ...inner, parentCallId: 'missing', isError: false, content: [] } } : row)
    expect(() => restoreReleasedV3Artifact({ ...target, events: mismatched }, new Set())).toThrow(/parentCallId/)
  })

  it('composes header and scalar preset renames with every structural and canonical transformation', () => {
    const reader = sessionFormatCatalog.createRestore({ ...header, agentPreset: 'code' }, { recovery: 'strict', validation: 'current' })
    const selection = event('agent-preset/selected', source.length, { agentPreset: 'code' })
    for (const row of [...source, selection]) reader.decodeRow(row)
    const target = reader.finish()
    expect(target.header).toMatchObject({ version: 3, agentPreset: 'ptc' })
    expect(target.events.at(-1)).toEqual({ ...selection, seq: source.length + 3, data: { agentPreset: 'ptc' } })
    assertComposite(target.events)
    expect(restoreReleasedV3Artifact(target, new Set())).toBe(target)
  })

  it('refuses unaudited V2 preset extensions but preserves native nested preset data', () => {
    const selection = event('agent-preset/selected', source.length, { agentPreset: 'code', extension: { agentPreset: 'code' } })
    const reader = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    for (const row of source) reader.decodeRow(row)
    expect(() => { reader.decodeRow(selection) }).toThrow(/unexpected field extension/)
    const native = sessionFormatCatalog.createRestore({ ...header, version: 3 }, { recovery: 'strict', validation: 'current' })
    const row = { ...selection, seq: 0 }
    native.decodeRow(row)
    expect(native.finish().events).toEqual([row])
  })

  it.each([
    ['old replacement fields', source[9]!, /exact replace fields/],
    ['old PTC tag', source[4]!, /unknown event type/],
  ])('rejects %s in native V3 encoding, decoding, and restoration', (_name, row, error) => {
    expect(() => releasedV3SessionFormatCodec.encodeEvent(row)).toThrow(error)
    const logicalHeader = releasedV3SessionFormatCodec.decodeHeader({ ...header, version: 3 })
    expect(() => restoreReleasedV3Artifact({ header: logicalHeader, inheritedEventCount: 0, events: [row] }, new Set())).toThrow(error)
    const reader = sessionFormatCatalog.createRestore({ ...header, version: 3 }, { recovery: 'strict', validation: 'transformed' })
    for (let seq = 0; seq < row.seq; seq++) reader.decodeRow(event('external/event', seq, {}, { ignorable: true }))
    expect(() => { reader.decodeRow(row) }).toThrow(error)
  })

  it.each(['tool/code-dispatch-start', 'tool/code-dispatch'])('refuses required obsolete %s during recoverable decoding', (type) => {
    const decoder = releasedV3SessionFormatCodec.createDecoder({ ...header, version: 3 }, 'recoverable')
    const output = new SessionFormatEventCollector()
    const first = event('turn/start', 0, { turn: 1 })
    decoder.decodeRow(first, output)
    expect(() => { decoder.decodeRow(event(type, 1, outer), output) }).toThrow(SessionFormatUnsupportedMigrationError)
    expect(output.values).toEqual([first])
  })

  it('refuses unsupported admission after a canonical semantic-tail error', () => {
    const decoder = releasedV3SessionFormatCodec.createDecoder({ ...header, version: 3 }, 'recoverable')
    const output = new SessionFormatEventCollector()
    decoder.decodeRow(event('turn/start', 0, { turn: 1 }), output)
    decoder.decodeRow(event('user/message', 1, message), output)
    expect(() => { decoder.decodeRow(event('tool/code-dispatch-start', 2, outer), output) })
      .toThrow(SessionFormatUnsupportedMigrationError)
  })

  it('withholds a malformed canonical tail without advancing the accepted inherited cut', () => {
    const decoder = releasedV3SessionFormatCodec.createDecoder({ ...header, version: 3, isSeeded: true }, 'recoverable')
    const output = new SessionFormatEventCollector()
    const first = event('external/event', 0, {}, { ignorable: true })
    const marker = event('session/end-seed', 1, { inherited: true })
    decoder.decodeRow(first, output)
    decoder.decodeRow(marker, output)
    decoder.decodeRow({ ...source[9]!, seq: 2, sourceEventSeqs: [0], surfaceOp: { op: 'replace', start: 0, end: 0 } }, output)
    decoder.decodeRow(event('session/end-seed', 3, { inherited: true }), output)
    expect(decoder.finish(output)).toBe(1)
    expect(output.values).toEqual([first, marker])
    expect(() => { decoder.decodeRow(event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }), output) }).toThrow(/exact replace fields/)
  })

  it.each([undefined, 0, 1, 2, 4])('preserves historical delivery generation %s while remapping its envelope and inherited cut', (version) => {
    const reader = sessionFormatCatalog.createRestore({ ...header, isSeeded: true, parentSession: 'parent' }, { recovery: 'strict', validation: 'current' })
    const marker = event('session-log-deepseek/delivery-accepted', source.length, {
      sessionId: 'parent', throughSeq: source.length - 1, ...(version === undefined ? {} : { sessionFormatVersion: version }),
    })
    const cut = event('session/end-seed', source.length + 1, { inherited: true })
    for (const row of [...source, marker, cut]) reader.decodeRow(row)
    const target = reader.finish()
    expect(target.events.at(-2)).toEqual({ ...marker, seq: source.length + 3 })
    expect(target.events.at(-2)?.data).toEqual(marker.data)
    expect(target.inheritedEventCount).toBe(source.length + 4)
    expect(target.events.at(-1)).toEqual({ ...cut, seq: target.inheritedEventCount })
    assertComposite(target.events)
    const reopened = sessionFormatCatalog.createRestore(releasedV3SessionFormatCodec.encodeHeader(target.header, target.inheritedEventCount), { recovery: 'strict', validation: 'current' })
    for (const row of target.events) reopened.decodeRow(releasedV3SessionFormatCodec.encodeEvent(row))
    expect(reopened.finish()).toEqual(target)
  })

  it('refuses target V3 delivery activation after replacement and PTC migration', () => {
    const reader = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    for (const row of source) reader.decodeRow(row)
    expect(() => {
      reader.decodeRow(event('session-log-deepseek/delivery-accepted', source.length, {
        sessionId: header.id, throughSeq: source.length - 1, sessionFormatVersion: 3,
      }))
      reader.finish()
    }).toThrow(/format v2 delivery marker claims target format v3/)
  })
})
