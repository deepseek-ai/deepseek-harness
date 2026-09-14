import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { restoreReleasedV3Artifact, sessionFormatV2ToV3 } from '../src/index.ts'

const header = { version: 2, id: 'content-admission', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const text = { type: 'text', text: 'input' }
const future = { type: 'future-content', seq: 987, content: [{ type: 'text', text: 'opaque' }] }
const user = { id: 'user', role: 'user', source: { kind: 'user' }, content: [text] }
const model = { kind: 'model', provider: 'mock', model: 'mock' }
const dispatch = { rootCallId: 'root', parentCallId: 'root', subCallId: 'sub', name: 'read', arguments: {} }
function event(type: string, data: SessionFormatJsonObject, surface = false): SessionFormatEvent {
  return { type, seq: 0, time: 1, data, ...(surface ? { surfaceOp: 'append' } : {}) }
}
const opening = [event('turn/start', { turn: 1 }), event('step/start', { turn: 1, step: 1 }), event('user/message', user, true)]
const closing = [event('step/end', { turn: 1, step: 1 }), event('turn/end', { turn: 1, reason: { kind: 'completed' } })]
function migrate(rows: readonly SessionFormatEvent[]) {
  const targetHeader = sessionFormatV2ToV3.migrateHeader(header)
  const stage = sessionFormatV2ToV3.createStage({ sourceHeader: header, targetHeader, sourceInheritedEventCount: 0, sourceKind: 'decoded' })
  const collector = new SessionFormatEventCollector()
  for (const [seq, row] of rows.entries()) stage.transformEvent({ ...row, seq }, collector)
  return { header: targetHeader, inheritedEventCount: stage.finish(collector), events: collector.values }
}
function nested(content: SessionFormatJsonValue): SessionFormatJsonObject & { type: 'tool-result' } {
  return { type: 'tool-result', toolCallId: 'nested', content }
}
function assistant(type: string, stream: SessionFormatJsonValue, content: SessionFormatJsonValue = [text]): SessionFormatEvent {
  return event(type, { turn: 1, step: 1, stream, ...(type === 'assistant/message' ? { message: { id: 'assistant', role: 'assistant', source: model, content } } : {}) }, type === 'assistant/message')
}
const messageCarriers = [
  { type: 'user/message', path: 'data.content', seq: 3, rows: (content: SessionFormatJsonValue) => [event('user/message', { ...user, id: 'second', content }, true)] },
  { type: 'assistant/message', path: 'data.message.content', seq: 3, rows: (content: SessionFormatJsonValue) => [event('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'assistant', role: 'assistant', source: model, content } }, true)] },
  { type: 'tool/result', path: 'data.message.content[0].content', seq: 5, rows: (content: SessionFormatJsonValue) => [
    event('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'assistant', role: 'assistant', source: model, content: [{ type: 'tool-call', id: 'call', name: 'read', arguments: '{}' }] } }, true),
    event('tool/call', { turn: 1, step: 1, callId: 'call', name: 'read', arguments: '{}' }),
    event('tool/result', { turn: 1, step: 1, message: { id: 'result', role: 'user', source: { kind: 'tool', callId: 'call' }, content: [{ type: 'tool-result', toolCallId: 'call', content }] } }, true),
  ] },
  { type: 'agent/inbox/spliced', path: 'data.inserted[0].content', seq: 3, rows: (content: SessionFormatJsonValue) => [event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ ...user, id: 'inbox', content }] })] },
  { type: 'session/title-llm-request', path: 'data.messages[0].content', seq: 3, rows: (content: SessionFormatJsonValue) => [event('session/title-llm-request', { titleProvider: 'mock', messageSeqs: [2], route: { provider: 'mock', model: 'mock' }, system: 'title', maxTokens: 987, messages: [{ ...user, id: 'title', source: { kind: 'plugin', plugin: 'dsh-session-title-llm' }, content }] })] },
]
const carriers = [
  ...messageCarriers,
  { type: 'team/message/queued', path: 'data.message.content', seq: 3, rows: (content: SessionFormatJsonValue) => [
    event('team/message/queued', { version: 1, teamId: 'team', message: { id: 'queued', senderId: 'lead', senderName: 'lead', targetId: 'worker', delivery: 'quiet', content } }),
  ] },
  ...['summary', 'rawOutput'].map(field => ({ type: 'compaction/summary', path: 'data.' + field, seq: 4, rows: (content: SessionFormatJsonValue) => [
    event('compaction/start', { compactionId: 'compact', turn: 1 }),
    event('compaction/summary', { compactionId: 'compact', provider: 'mock', model: 'mock', summary: [text], [field]: content, shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 987 }),
    event('compaction/end', { compactionId: 'compact', turn: 1 }),
  ] })),
  { type: 'tool/code-dispatch', path: 'data.content', seq: 4, rows: (content: SessionFormatJsonValue) => [
    event('tool/code-dispatch-start', dispatch), event('tool/code-dispatch', { ...dispatch, content, isError: false }),
  ] },
]

const admitted = [
  text,
  { type: 'reasoning', text: '' },
  { type: 'image', attachment: { attachmentId: 'image', mediaType: 'image/png', bytes: 987, width: 1, height: 2, name: '', originalDimensions: { width: 3, height: 4 } } },
  { type: 'file', attachment: { attachmentId: 'file', name: '', bytes: 987 } },
  { type: 'tool-call', id: 'opaque-call', name: 'read', arguments: '{"type":"future-content","seq":987}' },
  { ...nested([text]), isError: false },
]
const malformed = [
  { block: { type: 'text', text: 12 }, kind: 'text' },
  { block: { type: 'reasoning', text: 'ok', extra: true }, kind: 'reasoning' },
  { block: { type: 'image', attachment: {} }, kind: 'image' },
  { block: { type: 'file', attachment: { attachmentId: 'file', name: 'file', bytes: -1 } }, kind: 'file' },
  { block: { type: 'tool-call', id: '', name: 'read', arguments: '{}' }, kind: 'tool-call' },
  { block: { type: 'tool-result', toolCallId: '', content: [] }, kind: 'tool-result' },
  { block: { type: 'tool-result', toolCallId: 'call', content: null }, kind: 'tool-result' },
] satisfies { block: SessionFormatJsonObject; kind: string }[]

function catalog(rows: readonly SessionFormatEvent[], version: 0 | 1 | 3, validation: 'current' | 'transformed' = 'current') {
  const physical = version === 3 ? { type: 'session', ...header, version } : { type: 'session', version, id: header.id, createdAt: 1, delegationDepth: 0 }
  const reader = sessionFormatCatalog.createRestore(physical, { recovery: 'strict', validation })
  for (const [seq, row] of rows.entries()) reader.decodeRow({ ...row, seq })
  return reader.finish()
}

describe('V2 content admission', () => {
  it('preserves opaque JSON, serialized arguments, compact runs and non-content counters exactly', () => {
    const opaque = { ...future, blockType: 'future-content', block: future, blocks: [future], summary: [future], message: { content: [future] } }
    const replayState = { response: opaque, blocks: [opaque, opaque] }
    const stream = [
      { type: 'text-chunks', time0: 1, index: 0, dt: [0], texts: [JSON.stringify(opaque), ''] },
      { type: 'tool-call-chunks', time0: 1, index: 1, id: 'opaque-call', name: 'read', dt: [], args: [JSON.stringify(opaque)] },
      { type: 'chunk', time: 1, chunk: { type: 'finish', reason: { kind: 'tool-calls' }, replayState } },
    ]
    const nestedDispatch = { ...dispatch, arguments: opaque }
    const input = [...opening,
      event('tool/code-dispatch-start', nestedDispatch), event('tool/code-dispatch', { ...nestedDispatch, content: [text], isError: false }),
      event('assistant/message', { turn: 1, step: 1, stream, message: { id: 'assistant', role: 'assistant', source: { ...model, replayState }, content: [{ type: 'text', text: JSON.stringify(opaque) }, { type: 'tool-call', id: 'opaque-call', name: 'read', arguments: JSON.stringify(opaque) }] } }, true),
      event('tool/call', { turn: 1, step: 1, callId: 'opaque-call', name: 'read', arguments: JSON.stringify(opaque) }),
      event('tool/result', { turn: 1, step: 1, message: { id: 'result', role: 'user', source: { kind: 'tool', callId: 'opaque-call' }, content: [{ type: 'tool-result', toolCallId: 'opaque-call', content: [text] }] } }, true),
      ...closing]
    const before = JSON.stringify(input)
    const output = migrate(input)
    expect(restoreReleasedV3Artifact(output, new Set())).toBe(output)
    expect(output.events.filter(row => ['tool/ptc-dispatch-start', 'tool/ptc-dispatch', 'assistant/message'].includes(row.type)).map(row => row.data)).toEqual(input.slice(3, 6).map(row => row.data))
    expect(JSON.stringify(input)).toBe(before)
  })

  it.each([0, 1] as const)('routes historical V%s queued content through V2 admission', (version) => {
    const good = carriers.find(carrier => carrier.type === 'team/message/queued')!.rows([text])
    expect(catalog([...opening, ...good, ...closing], version).header.version).toBe(3)
    const bad = carriers.find(carrier => carrier.type === 'team/message/queued')!.rows([nested([future])])
    expect(() => catalog([...opening, ...bad, ...closing], version)).toThrow('format v2 team/message/queued at seq 3 data.message.content[0].content[0]')
  })

  it.each([0, 1] as const)('routes historical V%s chunk starts and ends through V2 admission', (version) => {
    for (const chunk of [{ type: 'block-start', index: 987, blockType: 'text' }, { type: 'block-end', index: 987, block: text }]) {
      expect(catalog([...opening, event('assistant/chunk', { turn: 1, step: 1, chunk })], version).header.version).toBe(3)
    }
    for (const chunk of [{ type: 'block-start', index: 987, blockType: 'future-content' }, { type: 'block-end', index: 987, block: nested([future]) }]) {
      expect(() => catalog([...opening, event('assistant/chunk', { turn: 1, step: 1, chunk })], version)).toThrow('format v2 assistant/attempt at seq 3 data.stream[0].chunk')
    }
  })

  it.each(['current', 'transformed'] as const)('keeps native V3 extension acceptance in content and raw stream records (%s)', (validation) => {
    const base = migrate([...opening, ...closing])
    const body = base.events.slice(0, -2)
    const extensionRows = [
      event('user/message', { ...user, id: 'extension', content: [future, nested([future])] }, true),
      ...carriers.find(carrier => carrier.type === 'team/message/queued')!.rows([future]),
      assistant('assistant/message', [{ type: 'chunk', time: 987, chunk: { type: 'block-end', index: 987, block: future } }]),
      assistant('assistant/attempt', [{ type: 'chunk', time: 987, chunk: { type: 'block-start', index: 987, blockType: 'future-content' } }]),
    ]
    const output = catalog([...body, ...extensionRows, ...closing], 3, validation)
    expect(output.events.slice(body.length, -2).map(row => row.data)).toEqual(extensionRows.map(row => row.data))
  })

  it.each(carriers.filter(carrier => carrier.type !== 'session/title-llm-request'))('accepts empty $type $path arrays', (carrier) => {
    const output = migrate([...opening, ...carrier.rows([]), ...closing])
    expect(restoreReleasedV3Artifact(output, new Set())).toBe(output)
  })

  for (const carrier of carriers) {
    it('accepts valid historical ' + carrier.path + ' in ' + carrier.type, () => {
      const output = migrate([...opening, ...carrier.rows([text]), ...closing])
      expect(restoreReleasedV3Artifact(output, new Set())).toBe(output)
    })
    it('preserves valid content without mutating ' + carrier.type + ' ' + carrier.path, () => {
      // Title request relationships require a single text block; assistant tool advertisements require results.
      const content = carrier.type === 'session/title-llm-request' ? [text] : [nested(admitted), ...admitted.filter(block => block.type !== 'tool-call')]
      const input = [...opening, ...carrier.rows(content), ...closing]
      const before = JSON.stringify(input)
      const output = migrate(input)
      expect(restoreReleasedV3Artifact(output, new Set())).toBe(output)
      expect(JSON.stringify(input)).toBe(before)
      const migrated = output.events.find(row => row.type === (carrier.type === 'tool/code-dispatch' ? 'tool/ptc-dispatch' : carrier.type) && row.seq === carrier.seq + 1)!
      if (carrier.type === 'compaction/summary') {
        expect(migrated.data).toEqual({
          ...input[carrier.seq]!.data as SessionFormatJsonObject, shadowedRange: { start: 3, end: 3 }, shadowedSeqs: [3],
        })
      } else if (carrier.type === 'session/title-llm-request') {
        expect(migrated.data).toEqual({ ...input[carrier.seq]!.data as SessionFormatJsonObject, messageSeqs: [3] })
      } else expect(migrated.data).toEqual(input[carrier.seq]!.data)
    })
    it.each(malformed)('rejects malformed $kind in ' + carrier.type + ' ' + carrier.path, ({ block, kind }) => {
      const input = [...opening, ...carrier.rows([nested([block])]), ...closing]
      const before = JSON.stringify(input)
      expect(() => migrate(input)).toThrow('format v2 ' + carrier.type + ' at seq ' + String(carrier.seq) + ' ' + carrier.path + '[0].content[0]')
      expect(() => migrate(input)).toThrow('kind "' + kind + '"')
      expect(JSON.stringify(input)).toBe(before)
    })
    it.each([null, false, {}, [null], [nested(null)]])('rejects malformed content arrays in ' + carrier.type + ' %j', (content) => {
      expect(() => migrate([...opening, ...carrier.rows(content), ...closing])).toThrow('format v2 ' + carrier.type + ' at seq ' + String(carrier.seq) + ' ' + carrier.path)
    })
    it.each([false, true])('rejects unknown kind in ' + carrier.type + ' nested=%s', (deep) => {
      const content = deep ? [text, nested([text, nested([future])])] : [future]
      const path = carrier.path + (deep ? '[1].content[1].content[0]' : '[0]')
      expect(() => migrate([...opening, ...carrier.rows(content), ...closing])).toThrow(
        'format v2 ' + carrier.type + ' at seq ' + String(carrier.seq) + ' ' + path + ': cannot safely transform unclassified message content kind "future-content"',
      )
    })
  }

  for (const type of ['assistant/message', 'assistant/attempt']) {
    it.each(malformed)('rejects malformed raw block-end $kind in ' + type, ({ block, kind }) => {
      const stream = [{ type: 'chunk', time: 4, chunk: { type: 'block-end', index: 987, block: nested([block]) } }]
      expect(() => migrate([...opening, assistant(type, stream)])).toThrow('format v2 ' + type + ' at seq 3 data.stream[0].chunk.block.content[0]')
      expect(() => migrate([...opening, assistant(type, stream)])).toThrow('kind "' + kind + '"')
    })
    it.each([{}, { blockType: null }, { blockType: 1 }, { blockType: '' }])('rejects missing or malformed block-start kind in ' + type + ' %j', (fields) => {
      const stream = [{ type: 'chunk', time: 4, chunk: { type: 'block-start', index: 987, ...fields } }]
      expect(() => migrate([...opening, assistant(type, stream)])).toThrow('format v2 ' + type + ' at seq 3 data.stream[0].chunk.blockType: cannot safely transform unclassified message content kind')
    })
    it.each([null, {}, [null], [{ type: 'chunk' }], [{ type: 'chunk', chunk: [] }], [{ type: 'chunk', chunk: { type: 'block-end' } }]])('narrows owned durable stream containers in ' + type + ' %j', (stream) => {
      expect(() => migrate([...opening, assistant(type, stream)])).toThrow('format v2 ' + type + ' at seq 3 data.stream')
    })
    it.each(admitted)('preserves admitted raw block kind $type in ' + type, (block) => {
      const stream = [{ type: 'chunk', time: 4, chunk: { type: 'block-start', index: 987, blockType: block.type } }, { type: 'chunk', time: 5, chunk: { type: 'block-end', index: 987, block } }]
      const settled = type === 'assistant/message' && block.type === 'tool-call' ? [
        event('tool/call', { turn: 1, step: 1, callId: 'opaque-call', name: 'read', arguments: '{"type":"future-content","seq":987}' }),
        event('tool/result', { turn: 1, step: 1, message: { id: 'result', role: 'user', source: { kind: 'tool', callId: 'opaque-call' }, content: [{ type: 'tool-result', toolCallId: 'opaque-call', content: [text] }] } }, true),
      ] : []
      const input = [...opening, assistant(type, stream, [block]), ...settled, ...closing]
      const before = JSON.stringify(input)
      const output = migrate(input)
      expect(restoreReleasedV3Artifact(output, new Set())).toBe(output)
      expect(output.events.find(row => row.type === type)?.data).toEqual(input[3]!.data)
      expect(JSON.stringify(input)).toBe(before)
    })
    it('accepts historical raw block chunks in ' + type, () => {
      const stream = [{ type: 'chunk', time: 4, chunk: { type: 'block-start', index: 987, blockType: 'text' } }, { type: 'chunk', time: 5, chunk: { type: 'block-end', index: 987, block: text } }]
      const output = migrate([...opening, assistant(type, stream), ...closing])
      expect(restoreReleasedV3Artifact(output, new Set())).toBe(output)
    })
    it.each([false, true])('rejects raw block-end unknown kind in ' + type + ' nested=%s', (deep) => {
      const block = deep ? nested([future]) : future
      const path = 'data.stream[0].chunk.block' + (deep ? '.content[0]' : '')
      expect(() => migrate([...opening, assistant(type, [{ type: 'chunk', time: 4, chunk: { type: 'block-end', index: 987, block } }]), ...closing])).toThrow(
        'format v2 ' + type + ' at seq 3 ' + path + ': cannot safely transform unclassified message content kind "future-content"',
      )
    })
    it('rejects raw block-start unknown kind without an end in ' + type, () => {
      expect(() => migrate([...opening, assistant(type, [{ type: 'chunk', time: 4, chunk: { type: 'block-start', index: 987, blockType: 'future-content' } }])])).toThrow(
        'format v2 ' + type + ' at seq 3 data.stream[0].chunk.blockType: cannot safely transform unclassified message content kind "future-content"',
      )
    })
  }
})
