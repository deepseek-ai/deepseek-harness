import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV3Header, releasedV3SessionFormatCodec, restoreReleasedV3Artifact, sessionFormatV2ToV3 } from '../src/index.ts'
import { assertEvent } from '../src/payload.ts'
import { remapEvent } from '../src/references.ts'

const header = { version: 2, id: 'admission', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const user = { id: 'user', role: 'user', content: [{ type: 'text', text: 'input' }], source: { kind: 'user' } }
const system = { turn: 1, step: 1, message: { ...user, role: 'system', source: { kind: 'plugin', plugin: 'context' } } }
function event(type: string, data: SessionFormatJsonValue, extra: SessionFormatJsonObject = {}): SessionFormatEvent {
  return { type, seq: 0, time: 1, data, ...extra }
}
function migrate(input: readonly SessionFormatEvent[], source = header, cut: number | undefined = 0) {
  const target = sessionFormatV2ToV3.migrateHeader(source)
  const stage = sessionFormatV2ToV3.createStage({ sourceHeader: source, targetHeader: target, sourceInheritedEventCount: cut, sourceKind: 'decoded' })
  const collector = new SessionFormatEventCollector()
  for (const [seq, value] of input.entries()) stage.transformEvent({ ...value, seq }, collector)
  return { header: target, inheritedEventCount: stage.finish(collector), events: collector.values }
}
const opening = [event('turn/start', { turn: 1 }), event('step/start', { turn: 1, step: 1 })]
function native(input: readonly SessionFormatEvent[]) {
  const artifact = { header: { ...header, version: 3 }, inheritedEventCount: 0, events: input.map((value, seq) => ({ ...value, seq })) }
  return restoreReleasedV3Artifact(artifact, new Set())
}

describe('durable V3 admission failures', () => {
  it.each([
    event('step/start', null),
    event('step/start', { turn: 1 }),
    event('step/start', { turn: 1, step: 1 }, { ignorable: false }),
    event('user/message', user),
    event('session/end-seed', { inherited: false }),
  ])('rejects malformed source records before emitting %j', (bad) => {
    expect(() => migrate([bad])).toThrow()
  })

  it('retains admitted ignorable markers and does not insert another head on later steps', () => {
    const output = migrate([...opening, event('feedback/record', { text: 'audit' }, { ignorable: true }), event('step/end', { turn: 1, step: 1 }), event('step/start', { turn: 1, step: 2 })])
    expect(output.events.filter(value => value.type === 'system/message')).toHaveLength(1)
    expect(output.events[3]?.['ignorable']).toBe(true)
    expect(() => restoreReleasedV3Artifact(output, new Set())).not.toThrow()
  })

  it('rejects non-dense source stage input rather than generating ambiguous identities', () => {
    const stage = sessionFormatV2ToV3.createStage({ sourceHeader: header, targetHeader: { ...header, version: 3 }, sourceInheritedEventCount: 0, sourceKind: 'decoded' })
    expect(() =>{  stage.transformEvent({ ...opening[0]!, seq: 1 }, new SessionFormatEventCollector()) }).toThrow(/dense/)
  })

  it('checks native metadata versions before applying released header validation', () => {
    expect(() =>{  assertReleasedV3Header(header) }).toThrow(/format v3 header/)
    expect(releasedV3SessionFormatCodec.decodeHeader({ type: 'session', ...header, version: 3 })).toEqual({ ...header, version: 3 })
  })

  it('retains native source extensions through payload validation without classifying their references', () => {
    const extension = event('user/message', { ...user, source: { kind: 'custom-source', localRef: 77 } }, { surfaceOp: 'append' })
    expect(() =>{  assertEvent(extension, 3) }).not.toThrow()
    expect(() =>{  assertEvent(extension, 2) }).toThrow(/unclassified/)
  })

  it.each([0, -1, 1.5])('rejects invalid system step coordinates %s', (step) => {
    expect(() => releasedV3SessionFormatCodec.encodeEvent(event('system/message', { ...system, step }, { surfaceOp: 'append' }))).toThrow()
  })

  it('refuses appending system context after a history with no protected head', () => {
    expect(() => native([...opening, event('user/message', user, { surfaceOp: 'append' }), event('system/message', system, { surfaceOp: 'append' })])).toThrow(/protected first/)
  })

  it('rejects ordinary replacements that consume the protected head', () => {
    expect(() => native([...opening, event('system/message', system, { surfaceOp: 'append' }), event('user/message', user, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] })])).toThrow(/protected/)
  })

  it.each([
    { attachmentId: '', name: 'file', bytes: 1 },
    { attachmentId: 1, name: 'file', bytes: 1 },
    { attachmentId: 'sha256:abc', name: false, bytes: 1 },
  ])('rejects malformed audited file metadata %j', (attachment) => {
    expect(() => migrate([...opening, event('user/message', { ...user, content: [{ type: 'file', attachment }] }, { surfaceOp: 'append' })])).toThrow(/file attachment/)
  })
})

describe('feedback payload admission', () => {
  const item = { messageId: 'assistant', rating: 'negative', version: 'opaque', createdAt: 1, updatedAt: 2, note: 'reason' }
  it('preserves negative ratings, notes, and deletions', () => {
    const put = event('feedback/message-put', { sessionId: header.id, item })
    const deleted = event('feedback/message-delete', { sessionId: header.id, messageId: item.messageId })
    expect(migrate([put, deleted]).events.map(value => value.data)).toEqual([put.data, deleted.data])
  })
  it.each([
    event('feedback/message-delete', { sessionId: 1, messageId: 'id' }),
    event('feedback/message-delete', { sessionId: 'session', messageId: 1 }),
    event('feedback/message-put', { sessionId: 'session', item: { ...item, messageId: false } }),
    event('feedback/message-put', { sessionId: 'session', item: { ...item, version: 0 } }),
    event('feedback/message-put', { sessionId: 'session', item: { ...item, rating: 'neutral' } }),
    event('feedback/message-put', { sessionId: 'session', item: { ...item, note: 12 } }),
  ])('rejects malformed feedback %j', (bad) => {
    expect(() => migrate([bad])).toThrow(/feedback/)
  })
})

describe('tool result restoration', () => {
  const call = { type: 'tool-call', id: 'call', name: 'tool', arguments: '{}' }
  const assistant = event('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'assistant', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [call] } }, { surfaceOp: 'append' })
  const started = event('tool/call', { turn: 1, step: 1, callId: 'call', name: 'tool', arguments: '{}' })
  const result = { turn: 1, step: 1, message: { id: 'result', role: 'user', source: { kind: 'tool', callId: 'call' }, content: [{ type: 'tool-result', toolCallId: 'call', isError: true, content: [{ type: 'text', text: 'result' }] }] } }
  it.each([undefined, { name: 'ToolError', code: 'TOOL_ERROR' }])('restores started tool results without repair identity projection %j', (error) => {
    const output = migrate([...opening, assistant, started, event('tool/result', { ...result, ...(error === undefined ? {} : { error }) }, { surfaceOp: 'append' })])
    expect(restoreReleasedV3Artifact(output, new Set())).toBe(output)
  })
  it('rejects untagged repair identities in native restoration instead of projecting arbitrary IDs', () => {
    const repair = event('tool/result', { ...result, error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' } }, { surfaceOp: 'append' })
    expect(() => native([...opening, assistant, repair])).toThrow(/exact TOOL_NOT_STARTED/)
    const malformedSource = { ...result.message, source: { kind: 'tool', callId: 123 } }
    const malformed = event('tool/result', { ...result, message: malformedSource, error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' } }, { surfaceOp: 'append' })
    expect(() => native([...opening, assistant, malformed])).toThrow(/advertised tool/)
  })
})

describe('coordinate remapping', () => {
  it('rejects dangling mappings and malformed reference arrays at the mapper boundary', () => {
    const source = { ...event('command/done', { sourceEventSeq: 1 }), seq: 2 }
    expect(() => remapEvent(source, 3, [])).toThrow(/earlier/)
    expect(() => remapEvent({ ...source, data: { sourceEventSeq: 2 } }, 3, [0, 1, 2])).toThrow(/earlier/)
    expect(() => remapEvent({ ...source, sourceEventSeqs: null }, 3, [0, 1])).toThrow(/array/)
  })

  it('leaves command completions without a source unchanged', () => {
    const output = migrate([event('command/run', { commandId: 'cmd', name: 'test', source: { kind: 'user' } }), event('command/done', { commandId: 'cmd', kind: 'error', text: 'failed' })])
    expect(restoreReleasedV3Artifact(output, new Set())).toBe(output)
  })

  it('remaps a successful compaction summary and preserves its token accounting', () => {
    const range = { start: 2, end: 2 }
    const summary = event('compaction/summary', { compactionId: 'compact', summary: [{ type: 'text', text: 'summary' }], shadowedRange: range, shadowedSeqs: [2], shadowedTokenCount: 123, provider: 'mock', model: 'mock' })
    const output = migrate([...opening, event('user/message', user, { surfaceOp: 'append' }), event('compaction/start', { compactionId: 'compact', turn: 1 }), summary, event('compaction/end', { compactionId: 'compact', turn: 1 })])
    expect(restoreReleasedV3Artifact(output, new Set())).toBe(output)
    expect(output.events.find(value => value.type === 'compaction/summary')?.data).toEqual({ ...summary.data as SessionFormatJsonObject, shadowedRange: { start: 3, end: 3 }, shadowedSeqs: [3] })
  })
})
