import { describe, expect, it } from 'vitest'
import { createSessionFormatCatalog, SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatHeader, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { assertReleasedV3Header, releasedV2SessionFormatCodec, releasedV3SessionFormatCodec, restoreReleasedV3Artifact, sessionFormatV2ToV3 } from '../src/index.ts'

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

const header: SessionFormatHeader = { version: 2, id: 'identity', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const request = (system?: string) => ({ header: { config: { provider: 'mock', model: 'mock' }, ...(system === undefined ? {} : { system }) }, reason: 'initial' })
const user = (id = 'user') => ({ role: 'user', id, source: { kind: 'user' }, content: [{ type: 'text', text: id }] })
const event = (type: string, data: SessionFormatEvent['data'], surfaceOp?: SessionFormatEvent['surfaceOp']): SessionFormatEvent => ({ type, seq: 0, time: 42, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) })
const dense = (events: readonly SessionFormatEvent[]) => events.map((e, seq) => ({ ...e, seq }))
const opening = () => [event('turn/start', { turn: 1 }), event('step/start', { turn: 1, step: 1 })]
function stage(source = header, sourceCut?: number) {
  const target = sessionFormatV2ToV3.migrateHeader(source)
  return { target, value: sessionFormatV2ToV3.createStage({ sourceHeader: source, targetHeader: target, sourceInheritedEventCount: sourceCut, sourceKind: 'decoded' }), collector: new SessionFormatEventCollector() }
}
function migrate(events: readonly SessionFormatEvent[], source = header, cut: number | undefined = 0): SessionFormatArtifact {
  const h = stage(source, cut)
  for (const e of dense(events)) h.value.transformEvent(e, h.collector)
  const artifact = { header: h.target, inheritedEventCount: h.value.finish(h.collector), events: h.collector.values }
  return restoreReleasedV3Artifact(artifact, new Set(['feedback/message-put', 'feedback/message-delete']))
}
const catalog = createSessionFormatCatalog({
  currentVersion: 3,
  codecs: [releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, releasedV2SessionFormatCodec, releasedV3SessionFormatCodec],
  currentEncoder: releasedV3SessionFormatCodec,
  migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3],
  restoreCurrent: artifact => restoreReleasedV3Artifact(artifact, new Set()),
  restoreTransformedCurrent: artifact => restoreReleasedV3Artifact(artifact, new Set()),
  restoreCurrentHeader(value) { assertReleasedV3Header(value); return value },
})
function requests(events: readonly SessionFormatEvent[], version: 2 | 3) {
  const surface: SessionFormatEvent[] = []
  let prompt = ''
  const result: unknown[] = []
  for (const e of events) {
    if (e['surfaceOp'] === 'append') surface.push(e)
    else if (e['surfaceOp'] !== undefined) {
      const op = e['surfaceOp'] as SessionFormatJsonObject
      const start = surface.findIndex(x => x.seq === op[version === 2 ? 'start' : 'startSeq'])
      const end = surface.findIndex(x => x.seq === op[version === 2 ? 'end' : 'endSeq'])
      surface.splice(start, end - start + 1, e)
    }
    if (e.type === 'request/header') {
      const h = (e.data as SessionFormatJsonObject)['header'] as SessionFormatJsonObject
      prompt = typeof h['system'] === 'string' ? h['system'] : ''
      const messages = surface.flatMap((x) => {
        const d = x.data as SessionFormatJsonObject
        const m = (x.type === 'user/message' ? d : d['message']) as SessionFormatJsonObject
        return x.type === 'system/message' && (m['content'] as unknown[]).length === 0 ? [] : [{ role: m['role'], content: m['content'] }]
      })
      if (version === 2 && prompt !== '') messages.unshift({ role: 'system', content: [{ type: 'text', text: prompt }] })
      result.push(messages)
    }
  }
  return result
}

describe('streaming V2 system prompt migration', () => {
  it('emits an empty head immediately after first step, preserves chronology, and captures changed and cleared prompts', () => {
    const input = dense([...opening(), event('user/message', user(), 'append'), event('request/header', request('first')), event('request/header', request('first')), event('request/header', request('changed')), event('request/header', request()), event('request/header', request(''))])
    const h = stage()
    h.value.transformEvent(input[0]!, h.collector)
    expect(h.collector.values).toHaveLength(1)
    h.value.transformEvent(input[1]!, h.collector)
    expect(h.collector.values.map(e => e.type)).toEqual(['turn/start', 'step/start', 'system/message'])
    for (const e of input.slice(2)) h.value.transformEvent(e, h.collector)
    expect(h.value.finish(h.collector)).toBe(0)
    const output = migrate(input)
    expect(output.events.filter(e => e.type === 'system/message')).toHaveLength(4)
    expect(requests(output.events, 3)).toEqual(requests(input, 2))
    expect(output.events.filter(e => e.type !== 'system/message').map(e => [e.type, e.time])).toEqual(input.map(e => [e.type, e.time]))
    expect(output.events.filter(e => e.type === 'request/header').every(e => !Object.hasOwn((e.data as SessionFormatJsonObject)['header'] as SessionFormatJsonObject, 'system'))).toBe(true)
    expect(migrate(input)).toEqual(output)
    expect(input[3]!.data).toEqual(request('first'))
  })

  it('remaps exact local ranges and lists without putting the head inside compaction', () => {
    const source = dense([...opening(), event('user/message', user('a'), 'append'), event('request/header', request('sys')), event('user/message', user('b'), 'append'), event('compaction/prune', { shadowedRange: { start: 2, end: 4 }, shadowedSeqs: [2, 4], shadowedTokenCount: 20 }), { ...event('user/message', user('replacement'), { op: 'replace', start: 2, end: 4 }), sourceEventSeqs: [2, 4] }, event('command/run', { commandId: 'c', name: 'x', source: { kind: 'user' } }), event('command/done', { commandId: 'c', kind: 'success', sourceEventSeq: 6 }), event('session/title', { title: 'title', messageSeqs: [2, 4], source: { kind: 'fallback' } })])
    const target = migrate(source)
    const mapped = target.events.filter(e => e.type !== 'system/message')
    const prune = mapped[5]!.data as SessionFormatJsonObject
    expect(prune['shadowedSeqs']).toEqual([mapped[2]!.seq, mapped[4]!.seq])
    expect(mapped[6]!['sourceEventSeqs']).toEqual(prune['shadowedSeqs'])
    expect((mapped[8]!.data as SessionFormatJsonObject)['sourceEventSeq']).toBe(mapped[6]!.seq)
    expect((mapped[9]!.data as SessionFormatJsonObject)['messageSeqs']).toEqual(prune['shadowedSeqs'])
    expect(() => restoreReleasedV3Artifact({ ...target, events: target.events.map(e => e.type === 'compaction/prune' ? { ...e, data: { ...e.data as SessionFormatJsonObject, shadowedRange: { start: 4, end: 4 }, shadowedSeqs: [4] } } : e) }, new Set())).toThrow(/protected/)
  })

  it('keeps headerless aborted steps and metadata-only logs without inventing a tail request', () => {
    const empty = migrate([])
    expect(empty.events).toEqual([])
    expect(migrate([...opening(), event('user/message', user(), 'append')]).events.at(-1)?.type).toBe('user/message')
    expect(migrate([event('feedback/record', { text: 'metadata' })]).events).toHaveLength(1)
  })

  it('detects deterministic head and update identity collisions with source messages in either order', () => {
    const input = [...opening(), event('user/message', user(), 'append'), event('request/header', request('system'))]
    const output = migrate(input)
    const ids = output.events.filter(e => e.type === 'system/message').map(e => ((e.data as SessionFormatJsonObject)['message'] as SessionFormatJsonObject)['id'] as string)
    for (const id of ids) {
      const colliding = [...opening(), event('user/message', user(id), 'append'), event('request/header', request('system'))]
      expect(() => migrate(colliding)).toThrow(/collides/)
    }
    const priorInbox = event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [user('placeholder')] })
    const shifted = migrate([priorInbox, ...input])
    const head = shifted.events.find(e => e.type === 'system/message')!
    const id = ((head.data as SessionFormatJsonObject)['message'] as SessionFormatJsonObject)['id'] as string
    expect(() => migrate([event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [user(id)] }), ...input])).toThrow(/collides/)
  })

  it('refuses pre-step surfaces and changed prompts outside a step rather than reorder source history', () => {
    expect(() => migrate([event('user/message', user(), 'append'), ...opening()])).toThrow(/before first step/)
    expect(() => migrate([event('turn/start', { turn: 1 }), event('request/header', request('early')), event('step/start', { turn: 1, step: 1 })])).toThrow(/outside an open step/)
    expect(() => migrate([...opening(), event('step/end', { turn: 1, step: 1 }), event('request/header', request('late'))])).toThrow(/outside an open step/)
  })

  it.each([undefined, 0, 1, 2])('preserves delivery generation coordinates (%s) and validates ownership before promotion', (version) => {
    const marker = event('session-log-deepseek/delivery-accepted', { sessionId: header.id, throughSeq: 1, ...(version === undefined ? {} : { sessionFormatVersion: version }) })
    const target = migrate([...opening(), marker])
    expect(target.events.at(-1)?.data).toEqual(marker.data)
    expect(() => migrate([...opening(), { ...marker, data: { ...marker.data as SessionFormatJsonObject, sessionId: 'foreign', sessionFormatVersion: 2 } }])).toThrow(/wrong Session/)
  })

  it('derives unknown seeded cuts after insertion and isolates simultaneous stages', () => {
    const source = { ...header, isSeeded: true, parentSession: 'parent' }
    const events = dense([...opening(), event('request/header', request('seed')), event('session-log-deepseek/delivery-accepted', { sessionId: 'parent', throughSeq: 1, sessionFormatVersion: 2 }), event('session/end-seed', { inherited: true })])
    const a = stage(source, undefined)
    const b = stage()
    expect(a.value.headerInheritedEventCount).toBeUndefined()
    expect(b.value.headerInheritedEventCount).toBe(0)
    for (const e of events) a.value.transformEvent(e, a.collector)
    expect(a.value.finish(a.collector)).toBe(6)
    expect(b.value.finish(b.collector)).toBe(0)
    expect(migrate(events, source, 4).inheritedEventCount).toBe(6)
    expect(() => migrate(events, source, 3)).toThrow(/source cut/)
    expect(() => migrate([], source, undefined)).toThrow(/inherited/)
    expect(() => migrate([event('session/end-seed', { inherited: true })])).toThrow(/inherited/)
  })

  it('preserves exact TOOL_NOT_STARTED message IDs through coordinate shifts', () => {
    const callId = 'call-with-dashes'
    const assistant = event('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'assistant', role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'test', arguments: '{}' }], source: { kind: 'model', provider: 'mock', model: 'mock' } } }, 'append')
    const repair = event('tool/result', { turn: 1, step: 1, error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' }, message: { id: 'interrupted-tool-result-' + callId + '-4', role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, isError: true, content: [{ type: 'text', text: 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.' }] }] } }, 'append')
    const input = [...opening(), event('request/header', request('system')), assistant, repair, event('step/end', { turn: 1, step: 1 })]
    const target = migrate(input)
    expect(target.events.find(e => e.type === 'tool/result')?.data).toEqual(repair.data)
    expect(target.events.find(e => e.type === 'tool/result')?.seq).toBe(6)
    const data = repair.data as SessionFormatJsonObject
    const historical = { ...repair, data: { ...data, message: { ...data['message'] as SessionFormatJsonObject, id: 'interrupted-tool-result-' + callId + '-999' } } }
    const inherited = migrate([...input.slice(0, 4), historical, ...input.slice(5)])
    expect(inherited.events.find(e => e.type === 'tool/result')?.data).toEqual(historical.data)
    expect(restoreReleasedV3Artifact(inherited, new Set())).toBe(inherited)
    expect(() => migrate([...input.slice(0, 4), { ...repair, data: { ...data, message: { ...data['message'] as SessionFormatJsonObject, id: 'arbitrary-repair-id' } } }])).toThrow(/canonical historical/)
  })

  it('preserves other-session captures, workflow-local seq, and model input containing source numbers', () => {
    const reference = { kind: 'session-reference', form: 'recall', version: 1, references: [{ sessionId: 'other', label: 'other', capturedThroughSeq: 99, capturedFormatVersion: 2, compacted: false, originalMessages: 1, retainedMessages: 1, omittedMessages: 0, omittedBytes: 0, truncated: false, inputIndex: 0 }] }
    const input = [...opening(), event('user/message', { ...user(), source: reference }, 'append'), event('tool-workflow/agent-start', { runId: 'run', seq: 99, label: 'child', childId: 'other' }), event('user/message', user('human'), 'append'), event('session/title-llm-request', { titleProvider: 'mock', messageSeqs: [4], route: { provider: 'mock', model: 'mock' }, system: 'title system', messages: [{ ...user('title'), source: { kind: 'plugin', plugin: 'dsh-session-title-llm' }, content: [{ type: 'text', text: 'source seq=4 (preserved model input)' }] }], maxTokens: 20 })]
    const target = migrate(input)
    const kept = target.events.filter(e => e.type !== 'system/message')
    expect(kept[2]?.data).toEqual(input[2]?.data)
    expect(kept[3]?.data).toEqual(input[3]?.data)
    expect((kept[5]!.data as SessionFormatJsonObject)['messageSeqs']).toEqual([5])
    expect((kept[5]!.data as SessionFormatJsonObject)['messages']).toEqual((input[5]!.data as SessionFormatJsonObject)['messages'])
  })

  it('expands compact input incrementally through independent stage state', () => {
    const h = stage()
    const input = dense([...opening(), event('request/header', request('run'))])
    h.value.transformRun({ runType: 'test', firstSeq: 0, eventCount: 3, *expand() { yield* input } }, h.collector)
    expect(h.value.finish(h.collector)).toBe(0)
    expect(h.collector.values).toEqual(migrate(input).events)
  })

  it.each([0, 1])('derives the inherited cut after V%s assistant chunks collapse upstream', (version) => {
    const chunks = [
      event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hello' } }),
      event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } }),
    ]
    const assistant = { ...event('assistant/message', { turn: 1, step: 1, message: { id: 'assistant', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [{ type: 'text', text: 'hello' }] } }, 'append'), sourceEventSeqs: [3, 4] }
    const source = dense([...opening(), event('request/header', request('seed')), ...chunks, assistant, event('step/end', { turn: 1, step: 1 }), event('turn/end', { turn: 1, reason: { kind: 'completed' } }), event('session/end-seed', {})])
    const restore = catalog.createRestore({ type: 'session', version, id: header.id, createdAt: 1, delegationDepth: 0, seedLength: 8 }, { recovery: 'strict', validation: 'current' })
    for (const e of source) restore.decodeRow(e)
    const output = restore.finish()
    expect(output.inheritedEventCount).toBe(8)
    expect(output.events.filter(e => e.type === 'assistant/chunk')).toHaveLength(0)
    expect(output.events.filter(e => e.type === 'system/message')).toHaveLength(2)
    expect(output.events.at(-1)?.seq).toBe(output.inheritedEventCount)
  })

  it.each([0, 1, 2])('restores seeded V%s through physical codecs and every adjacent stage', (version) => {
    const source = dense([...opening(), event('user/message', user(), 'append'), event('request/header', request('seed')), event('step/end', { turn: 1, step: 1 }), event('turn/end', { turn: 1, reason: { kind: 'completed' } }), event('session/end-seed', version === 2 ? { inherited: true } : {})])
    const physical = version === 2 ? { type: 'session', ...header, version, isSeeded: true } : { type: 'session', version, id: header.id, createdAt: 1, delegationDepth: 0, seedLength: 6 }
    const restore = catalog.createRestore(physical, { recovery: 'strict', validation: 'current' })
    for (const e of source) restore.decodeRow(e)
    const output = restore.finish()
    expect(output.inheritedEventCount).toBe(8)
    expect(requests(output.events, 3)).toEqual(requests(source, 2))
  })

  it.each([event('external/opaque', { seq: 1 }), { ...event('external/opaque', {}), ignorable: true }, event('request/header', { ...request(), futureRef: 0 }), event('user/message', { ...user(), source: { kind: 'future', seq: 0 } }, 'append')])('rejects unaudited payloads %j', (bad) => {
    expect(() => migrate([...opening(), bad])).toThrow(/unclassified|unexpected/)
  })

  it('rejects invalid references, future generation claims, and unclassified message content', () => {
    expect(() => migrate([...opening(), { ...event('user/message', user(), 'append'), sourceEventSeqs: [99] }])).toThrow(/earlier/)
    expect(() => migrate([...opening(), event('system/message', {})])).toThrow(/unclassified/)
    expect(() => migrate([...opening(), event('session-log-deepseek/delivery-accepted', { sessionId: header.id, throughSeq: 1, sessionFormatVersion: 3 })])).toThrow(/format v3|between/)
    expect(() => migrate([...opening(), event('user/message', { ...user(), content: [{ type: 'future-block', seq: 1 }] }, 'append')])).toThrow(/unclassified message content/)
  })

  it('migrates audited agent relay sources and file blocks verbatim, refusing unclassified members', () => {
    const source = { kind: 'agent-message', form: 'relay', senderSessionId: 'other-session' }
    const attachment = { attachmentId: 'sha256:content', name: 'poem.txt', bytes: 16 }
    const message = { ...user('relay'), source, content: [{ type: 'file', attachment }] }
    const inbox = event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
    const output = migrate([inbox, ...opening(), event('user/message', message, 'append')])
    expect(output.events[0]?.data).toEqual(inbox.data)
    expect(output.events.at(-1)?.data).toEqual(message)
    const badMessages = [
      { ...message, source: { ...source, sourceEventSeq: 0 } },
      { ...message, source: { ...source, form: 'notice' } },
      { ...message, content: [{ type: 'file', attachment: { ...attachment, seq: 0 } }] },
      { ...message, content: [{ type: 'file', attachment: { ...attachment, bytes: -1 } }] },
    ]
    for (const bad of badMessages) expect(() => migrate([...opening(), event('user/message', bad, 'append')])).toThrow()
  })

  it.each([0, 1, 2])('restores log-only failed attempts from V%s without invoking the V0 event inventory', (version) => {
    const stream = [{ type: 'finish', reason: { kind: 'error', error: { name: 'ProviderError', message: 'failed' } } }]
    const attempts = version === 2
      ? [event('assistant/attempt', { turn: 1, step: 1, stream })]
      : [event('assistant/chunk', { turn: 1, step: 1, chunk: stream[0]! })]
    const source = dense([...opening(), ...attempts])
    const physical = version === 2 ? { type: 'session', ...header } : { type: 'session', version, id: header.id, createdAt: 1, delegationDepth: 0 }
    const restore = catalog.createRestore(physical, { recovery: 'strict', validation: 'current' })
    for (const row of source) restore.decodeRow(row)
    expect(restore.finish().events.at(-1)?.type).toBe('assistant/attempt')
  })

  it('rejects malformed V2 attempts and unaudited attempt fields', () => {
    const invalid = [{ turn: 0, step: 1, stream: [] }, { turn: 1, step: 1, stream: null }, { turn: 1, step: 1, stream: [], seqRef: 0 }]
    for (const data of invalid) {
      expect(() => migrate([...opening(), event('assistant/attempt', data)])).toThrow()
    }
  })

  it('preserves message feedback identities and rejects unaudited feedback fields', () => {
    const feedback = event('feedback/message-put', { sessionId: 'other', item: { messageId: 'unchanged', rating: 'positive', version: 'opaque', createdAt: 1, updatedAt: 2 } })
    expect(migrate([...opening(), feedback]).events.at(-1)?.data).toEqual(feedback.data)
    const bad = { ...feedback, data: { ...feedback.data as SessionFormatJsonObject, seq: 2 } }
    expect(() => migrate([...opening(), bad])).toThrow(/unexpected/)
  })
})

describe('native V3 codec and restorer', () => {
  it('round-trips system messages and empty heads, returning no projected user-message substitutes', () => {
    const target = migrate([...opening(), event('request/header', request('system'))])
    const restore = catalog.createRestore(releasedV3SessionFormatCodec.encodeHeader(target.header, 0), { recovery: 'strict', validation: 'current' })
    for (const e of target.events) restore.decodeRow(releasedV3SessionFormatCodec.encodeEvent(e))
    const output = restore.finish()
    expect(output).toEqual(target)
    expect(restoreReleasedV3Artifact(target, new Set())).toBe(target)
    expect(target.events.filter(e => e.type === 'user/message')).toHaveLength(0)
  })
  it('rejects retired header.system on encode, decode, and logical restore', () => {
    const bad = { ...event('request/header', request('retired')), seq: 2 }
    expect(() => releasedV3SessionFormatCodec.encodeEvent(bad)).toThrow(/header.system/)
    const decoder = releasedV3SessionFormatCodec.createDecoder({ type: 'session', ...header, version: 3 }, 'strict')
    const context = new SessionFormatEventCollector()
    for (const e of dense(opening())) decoder.decodeRow(e, context)
    expect(() =>{  decoder.decodeRow(bad, context) }).toThrow(/header.system/)
    const artifact = { header: { ...header, version: 3 }, inheritedEventCount: 0, events: [...dense(opening()), bad] }
    expect(() => restoreReleasedV3Artifact(artifact, new Set())).toThrow(/header.system/)
  })
  it('rejects malformed native system payloads and foreign payload members', () => {
    const target = migrate(opening())
    const system = target.events[2]!
    const data = system.data as SessionFormatJsonObject
    const message = data['message'] as SessionFormatJsonObject
    const invalid = [
      { ...system, data: { ...data, extra: 0 } },
      { ...system, data: { ...data, message: { ...message, role: 'user' } } },
      { ...system, data: { ...data, message: { ...message, source: { kind: 'user' } } } },
      { ...system, data: { ...data, message: { ...message, content: [{ type: 'text', text: 12 }] } } },
      { ...system, surfaceOp: { op: 'replace', start: 0, end: 1 }, sourceEventSeqs: [0, 1] },
    ]
    for (const bad of invalid) {
      expect(() => restoreReleasedV3Artifact({ ...target, events: [...target.events.slice(0, 2), bad] }, new Set())).toThrow()
    }
    const decoder = releasedV3SessionFormatCodec.createDecoder({ type: 'session', ...header, version: 3 }, 'recoverable')
    const collector = new SessionFormatEventCollector()
    for (const e of dense(opening())) decoder.decodeRow(e, collector)
    decoder.decodeRow(null, collector)
    expect(() =>{  decoder.decodeRow({ ...event('request/header', request('retired')), seq: 2 }, collector) }).toThrow(/header.system/)
  })

  it('rejects system nodes outside the open step and mixed head replacements', () => {
    const target = migrate([...opening(), event('user/message', user(), 'append'), event('request/header', request('system'))])
    const systems = target.events.filter(e => e.type === 'system/message')
    const wrongStep = target.events.map(e => e === systems[0] ? { ...e, data: { ...e.data as SessionFormatJsonObject, step: 2 } } : e)
    expect(() => restoreReleasedV3Artifact({ ...target, events: wrongStep }, new Set())).toThrow(/open step/)
    expect(() => restoreReleasedV3Artifact({ ...target, events: target.events.map(e => e === systems[1] ? { ...e, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 }, sourceEventSeqs: [2, 3] } : e) }, new Set())).toThrow(/exactly/)
  })
  it('round-trips in-history system append, replacement, and compaction without shadowing the head', () => {
    const base = migrate([...opening(), event('user/message', user(), 'append')])
    const system = base.events.find(e => e.type === 'system/message')!
    const message = (system.data as SessionFormatJsonObject)['message'] as SessionFormatJsonObject
    const append = { ...system, seq: 4, data: { ...system.data as SessionFormatJsonObject, message: { ...message, id: 'tail', source: { kind: 'plugin', plugin: 'context-plugin' }, content: [{ type: 'text', text: 'tail context' }, { type: 'reasoning', text: 'retained content' }] } } }
    const replace = { ...system, seq: 5, sourceEventSeqs: [4], surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 } }
    const prune = { ...event('compaction/prune', { shadowedRange: { start: 5, end: 5 }, shadowedSeqs: [5], shadowedTokenCount: 0 }), seq: 6 }
    const checkpoint = { ...event('user/message', user('checkpoint'), { op: 'replace', startSeq: 5, endSeq: 5 }), sourceEventSeqs: [5], seq: 7 }
    const artifact = { ...base, events: [...base.events, append, replace, prune, checkpoint] }
    expect(restoreReleasedV3Artifact(artifact, new Set())).toBe(artifact)
    const restore = catalog.createRestore(releasedV3SessionFormatCodec.encodeHeader(base.header, 0), { recovery: 'strict', validation: 'current' })
    for (const e of artifact.events) restore.decodeRow(releasedV3SessionFormatCodec.encodeEvent(e))
    expect(restore.finish()).toEqual(artifact)
    const protectedPrune = { ...prune, data: { shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 0 } }
    const invalid = { ...base, events: [...base.events, append, replace, protectedPrune] }
    expect(() => restoreReleasedV3Artifact(invalid, new Set())).toThrow(/protected/)
  })

  it('keeps native ordinary payload and message-source extensions distinct from structural migration admission', () => {
    const target = migrate([...opening(), event('user/message', user(), 'append')])
    const events = target.events.map(e => e.type === 'user/message' ? { ...e, data: { ...e.data as SessionFormatJsonObject, installedExtension: true, source: { kind: 'installed-source', revision: 1 } } } : e)
    const native = { ...target, events }
    expect(restoreReleasedV3Artifact(native, new Set())).toBe(native)
    expect(() => migrate([...opening(), event('user/message', { ...user(), installedExtension: true }, 'append')])).toThrow(/unexpected/)
  })

  it('round-trips native header extensions while refusing them as unclassified V2 input', () => {
    const data = { ...request(), header: { ...request().header, messagePrefix: ['current extension'] } }
    const target = migrate(opening())
    const extended = { ...event('request/header', data), seq: target.events.length }
    const artifact = { ...target, events: [...target.events, extended] }
    const restore = catalog.createRestore(releasedV3SessionFormatCodec.encodeHeader(target.header, 0), { recovery: 'strict', validation: 'current' })
    for (const row of artifact.events) restore.decodeRow(releasedV3SessionFormatCodec.encodeEvent(row))
    expect(restore.finish()).toEqual(artifact)
    expect(() => migrate([...opening(), event('request/header', data)])).toThrow(/unexpected/)
    expect(() => releasedV3SessionFormatCodec.encodeEvent({ ...extended, data: { ...data, header: { ...data.header, system: 'retired' } } })).toThrow(/header.system/)
  })

  it('retains equal-generation ignorable events but rejects unknown required events', () => {
    const artifact = { header: { ...header, version: 3 }, inheritedEventCount: 0, events: [{ ...event('external/event', null), ignorable: true }] }
    expect(restoreReleasedV3Artifact(artifact, new Set())).toBe(artifact)
    expect(() => restoreReleasedV3Artifact({ ...artifact, events: [event('external/event', null)] }, new Set())).toThrow(/unknown event/)
  })
  it.each([null, [], false, { version: 2 }])('rejects non-v3 physical metadata %j', (value) => {
    expect(() => releasedV3SessionFormatCodec.decodeHeader(value)).toThrow(/format v3 physical/)
  })
})


describe('composed V3 system and PTC migration', () => {
  const message = (plugin: string, id = plugin) => ({ ...user(id), source: { kind: 'plugin', plugin } })
  const dispatch = { rootCallId: 'tools-code-mode:root', parentCallId: 'tools-code-mode:root', subCallId: 'tools-code-mode:child', name: 'read', arguments: { text: 'tools-code-mode', type: 'tool/code-dispatch' } }

  it('renames PTC after system insertion and remaps local references without touching tool JSON or identities', () => {
    const input = dense([
      ...opening(), event('user/message', message('tools-code-mode', 'tools-code-mode:message'), 'append'),
      event('request/header', request('prompt')), event('tool/code-dispatch-start', dispatch),
      event('tool/code-dispatch', { ...dispatch, isError: false, content: [{ type: 'text', text: 'tool/code-dispatch tools-code-mode' }] }),
      event('command/run', { commandId: 'cmd', name: 'test', source: { kind: 'user' } }),
      event('command/done', { commandId: 'cmd', kind: 'success', sourceEventSeq: 5 }),
      { ...event('user/message', message('tools-ptc', 'tools-ptc:message'), { op: 'replace', start: 2, end: 2 }), sourceEventSeqs: [2, 5] },
      event('request/header', request()),
    ])
    deepFreeze(input)
    const before = JSON.stringify(input)
    const output = migrate(input)
    expect(output.events.find(e => e.type === 'tool/ptc-dispatch-start')?.data).toEqual(dispatch)
    const settle = output.events.find(e => e.type === 'tool/ptc-dispatch')!
    expect(settle.data).toEqual(input[5]?.data)
    expect(output.events.find(e => e.type === 'command/done')?.data).toMatchObject({ sourceEventSeq: settle.seq })
    const users = output.events.filter(e => e.type === 'user/message')
    expect(users[0]?.data).toEqual(message('tools-ptc', 'tools-code-mode:message'))
    expect(users[1]?.data).toEqual(message('tools-ptc', 'tools-ptc:message'))
    expect(users[1]?.['sourceEventSeqs']).toEqual([users[0]?.seq, settle.seq])
    expect(requests(output.events, 3)).toEqual(requests(input, 2))
    expect(JSON.stringify(input)).toBe(before)
  })

  it('renames exact attribution slots in inbox and title messages but not similar plugin labels or text', () => {
    const old = message('tools-code-mode')
    const untouched = message('tools-code-mode-extra')
    const input = [
      event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [old, untouched] }),
      ...opening(), event('user/message', user('human'), 'append'),
      event('session/title-llm-request', { titleProvider: 'mock', messageSeqs: [3], route: { provider: 'mock', model: 'mock' }, system: 'tools-code-mode', messages: [old, untouched], maxTokens: 10 }),
    ]
    const h = stage()
    for (const e of dense(input)) h.value.transformEvent(e, h.collector)
    expect((h.collector.values[0]!.data as SessionFormatJsonObject)['inserted']).toEqual([message('tools-ptc', 'tools-code-mode'), untouched])
    const title = h.collector.values.at(-1)!.data as SessionFormatJsonObject
    expect(title['messages']).toEqual([message('tools-ptc', 'tools-code-mode'), untouched])
    expect(title['system']).toBe('tools-code-mode')
  })

  it.each(['decoded', 'transformed'] as const)('refuses both required and ignorable reserved PTC tags in %s sources', (sourceKind) => {
    for (const type of ['tool/ptc-dispatch-start', 'tool/ptc-dispatch']) {
      for (const ignorable of [false, true]) {
        const value = sessionFormatV2ToV3.createStage({
          sourceHeader: header, targetHeader: { ...header, version: 3 }, sourceInheritedEventCount: 0, sourceKind,
        })
        expect(() => { value.transformEvent(event(type, null, undefined), new SessionFormatEventCollector()) }).toThrow(/unclassified/)
        expect(() => migrate([{ ...event(type, null), ...(ignorable ? { ignorable: true } : {}) }])).toThrow(/unclassified/)
      }
    }
  })

  it.each(['tool/code-dispatch-start', 'tool/code-dispatch'])('refuses retired required %s after recoverable corruption', (type) => {
    const decoder = releasedV3SessionFormatCodec.createDecoder({ type: 'session', ...header, version: 3 }, 'recoverable')
    const collector = new SessionFormatEventCollector()
    decoder.decodeRow(null, collector)
    expect(() => { decoder.decodeRow({ type, seq: 0, time: 1, data: null }, collector) }).toThrow(/unknown event type/)
    expect(() => releasedV3SessionFormatCodec.encodeEvent(event(type, null))).toThrow(/unknown event type/)
  })
})

describe('v3 PTC event admission and relationships', () => {
  const turn = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }
  const dispatch = {
    rootCallId: 'tools-code-mode:root', parentCallId: 'tools-code-mode:root', subCallId: 'tools-code-mode:child',
    name: 'read', arguments: { path: 'tools-code-mode', nested: [1, { text: 'tool/code-dispatch' }] },
  }
  const start = { type: 'tool/ptc-dispatch-start', seq: 1, time: 2, data: dispatch }
  const settle = {
    type: 'tool/ptc-dispatch', seq: 2, time: 3,
    data: { ...dispatch, isError: false, content: [{ type: 'text', text: 'tools-code-mode' }] },
  }
  const artifact = (events: SessionFormatEvent[]) => deepFreeze({
    header: { ...header, version: 3 }, inheritedEventCount: 0, events,
  })

  it('validates a frozen complete PTC lifecycle and returns original names, IDs, and references', () => {
    const source = artifact([turn, start, settle, { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } }])
    const before = JSON.stringify(source)
    const restored = restoreReleasedV3Artifact(source, new Set(['tool/ptc-dispatch-start', 'tool/ptc-dispatch']))
    expect(restored).toBe(source)
    expect(restored.events).toBe(source.events)
    for (const [index, event] of source.events.entries()) expect(restored.events[index]).toBe(event)
    expect(JSON.stringify(source)).toBe(before)
  })

  it('accepts an unfinished PTC start without requiring a fabricated settlement', () => {
    const source = artifact([turn, start])
    expect(restoreReleasedV3Artifact(source, new Set())).toBe(source)
  })

  it('rejects an orphan PTC settlement', () => {
    expect(() => restoreReleasedV3Artifact(artifact([turn, { ...settle, seq: 1 }]), new Set())).toThrow(/no unique start/)
  })

  it.each([
    { name: 'other' }, { arguments: { path: 'different' } }, { subCallId: 'other-child' },
    { parentCallId: 'missing-parent' }, { rootCallId: 'different-root' },
  ])('rejects a PTC settlement whose identity or input disagrees with its start: %j', (override) => {
    expect(() => restoreReleasedV3Artifact(artifact([turn, start, { ...settle, data: { ...settle.data, ...override } }]), new Set()))
      .toThrow(/does not match|no unique start|parentCallId|rootCallId/)
  })

  it.each([start, settle])('rejects $type outside an open turn', (event) => {
    expect(() => restoreReleasedV3Artifact(artifact([{ ...event, seq: 0 }]), new Set())).toThrow(/outside an open turn/)
  })

  it('rejects duplicate PTC starts and settlements', () => {
    expect(() => restoreReleasedV3Artifact(artifact([turn, start, { ...start, seq: 2 }]), new Set())).toThrow(/repeats subCallId/)
    expect(() => restoreReleasedV3Artifact(artifact([turn, start, settle, { ...settle, seq: 3 }]), new Set())).toThrow(/no unique start/)
  })

  it.each(['tool/code-dispatch-start', 'tool/code-dispatch'])('rejects required obsolete %s even when installed', (type) => {
    expect(() => restoreReleasedV3Artifact(artifact([{ type, seq: 0, time: 1, data: null }]), new Set([type])))
      .toThrow(/format v3 contains unknown event type/)
  })

  it.each(['tool/code-dispatch-start', 'tool/code-dispatch', 'external/future'])('preserves ignorable %s as opaque data outside a turn', (type) => {
    const source = artifact([{
      type, seq: 0, time: -5, ignorable: true,
      data: { source: { kind: 'plugin', plugin: 'tools-code-mode' }, invalidLifecycle: true, content: ['tool/code-dispatch'] },
    }])
    expect(restoreReleasedV3Artifact(source, new Set())).toBe(source)
    expect(source.events[0]?.type).toBe(type)
  })

  it('does not let an ignorable obsolete start satisfy a current PTC settlement', () => {
    const obsolete = { ...start, type: 'tool/code-dispatch-start', ignorable: true }
    expect(() => restoreReleasedV3Artifact(artifact([turn, obsolete, settle]), new Set())).toThrow(/no unique start/)
  })
})
