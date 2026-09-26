import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { createSessionFormatCatalogWithChildren, historicalSessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { assertV4RowAdmission, releasedV4SessionFormatCodec, restoreReleasedV4Artifact } from '../src/index.ts'

const header = { version: 4, id: 'retired-content', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const wrapper: SessionFormatJsonObject = {
  type: 'tool-result', toolCallId: 'retired-call', content: [{ type: 'text', text: 'saved result' }],
}
const content = [wrapper]
const user = { id: 'user', role: 'user', source: { kind: 'user' }, content }
const message = (role: string): SessionFormatJsonObject => ({
  id: role, role, content,
  source: role === 'assistant' ? { kind: 'model', provider: 'test', model: 'test' }
    : role === 'tool' ? { kind: 'tool', callId: 'call' } : { kind: `${role}-prompt` },
  ...(role === 'tool' ? { toolCallId: 'call' } : {}),
})
const cases: readonly { name: string; type: string; data: SessionFormatJsonObject; error?: RegExp }[] = [
  { name: 'user message', type: 'user/message', data: user },
  ...['system', 'developer', 'assistant'].map(role => ({
    name: `${role} message`, type: `${role}/message`, data: { turn: 1, step: 1, message: message(role) },
    ...(role === 'system' ? { error: /rejects retired tool-result/ } : {}),
  })),
  { name: 'native tool message', type: 'tool/result', data: { turn: 1, step: 1, message: message('tool') } },
  { name: 'queued input', type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [user] } },
  { name: 'title request', type: 'session/title-llm-request', data: { messages: [user] } },
  { name: 'compaction summary', type: 'compaction/summary', data: { summary: content } },
  { name: 'compaction raw output', type: 'compaction/summary', data: { summary: [], rawOutput: content } },
  { name: 'PTC result', type: 'tool/ptc-dispatch', data: { content } },
  { name: 'team message', type: 'team/message/queued', data: { message: user } },
  ...['assistant/message', 'assistant/attempt'].flatMap(type => ['block-start', 'block-end'].map(kind => ({
    name: `${type} stream ${kind}`, type, data: {
      turn: 1, step: 1, message: { ...message('assistant'), content: [] },
      stream: [{ type: 'chunk', elapsedMs: 0, chunk: kind === 'block-start'
        ? { type: kind, index: 0, blockType: 'tool-result' }
        : { type: kind, index: 0, block: wrapper } }],
    },
  }))),
]

function row(type: string, data: SessionFormatJsonObject): SessionFormatEvent {
  return { type, data, seq: 0, time: 1 }
}

describe('retired tool-result content admission', () => {
  it.each(cases)('refuses $name in native encoding, restoration and recoverable suffixes', ({ type, data, error = /released tool-result wrapper/ }) => {
    const event = row(type, data)
    const before = structuredClone(event)
    expect(() => releasedV4SessionFormatCodec.encodeEvent(event)).toThrow(error)
    expect(() => restoreReleasedV4Artifact({ header, inheritedEventCount: 0, events: [event] }, new Set([type])))
      .toThrow(error)
    for (const recovery of ['strict', 'recoverable'] as const) {
      const decoder = releasedV4SessionFormatCodec.createDecoder({ type: 'session', ...header }, recovery)
      const collector = new SessionFormatEventCollector()
      if (recovery === 'recoverable') decoder.decodeRow(null, collector)
      expect(() => { decoder.decodeRow(event, collector) }).toThrow(error)
    }
    expect(event).toEqual(before)
  })

  it('refuses a V3 user wrapper at the V4 target while leaving the released reader and source intact', () => {
    const event = { ...row('user/message', user), surfaceOp: 'append' } as SessionFormatEvent
    const before = structuredClone(event)
    const physical = { type: 'session', ...header, version: 3 }
    const historical = historicalSessionFormatCatalog.createRestore(physical, { recovery: 'strict', validation: 'current' })
    historical.decodeRow(event)
    expect(historical.finish().events).toEqual([event])
    const current = createSessionFormatCatalogWithChildren([]).createRestore(physical, { recovery: 'strict', validation: 'current' })
    expect(() => { current.decodeRow(event); current.finish() }).toThrow(/released tool-result wrapper/)
    expect(event).toEqual(before)
  })

  it('interprets ignorable developer content only for a reader that knows the event, or for encoding', () => {
    const event = { ...row('developer/message', { turn: 1, step: 1, message: message('developer') }), ignorable: true }
    const collector = new SessionFormatEventCollector()
    const decoder = releasedV4SessionFormatCodec.createDecoder({ type: 'session', ...header }, 'strict')
    decoder.decodeRow(event, collector)
    expect(collector.values).toEqual([event])
    expect(() => { assertV4RowAdmission(event, new Set()) }).not.toThrow()
    expect(() => { assertV4RowAdmission(event, new Set(['developer/message'])) }).toThrow(/released tool-result wrapper/)
    expect(() => releasedV4SessionFormatCodec.encodeEvent(event)).toThrow(/released tool-result wrapper/)
    const artifact = { header, inheritedEventCount: 0, events: [event] }
    expect(restoreReleasedV4Artifact(artifact, new Set())).toBe(artifact)
  })

  it('keeps tool arguments, replay state, schemas, nested metadata, and unknown ignorable payloads opaque', () => {
    const rows: SessionFormatEvent[] = [
      row('user/message', { ...user, content: [{ type: 'text', text: 'text', metadata: wrapper }], replayState: { content } }),
      row('tool/call', { arguments: JSON.stringify(wrapper), metadata: { content } }),
      row('tool/ptc-dispatch', { content: [{ type: 'text', text: 'result' }], arguments: wrapper }),
      row('request/header', { header: { config: { provider: 'test', model: 'test' }, tools: [{
        name: 'example', description: '', parameters: { type: 'object', examples: [wrapper] },
      }] } }),
      { ...row('future/opaque', { content, message: user, stream: [{ type: 'chunk', chunk: { type: 'block-end', block: wrapper } }] }), ignorable: true },
    ]
    for (const event of rows) {
      const before = structuredClone(event)
      const encoded = releasedV4SessionFormatCodec.encodeEvent(event)
      const collector = new SessionFormatEventCollector()
      releasedV4SessionFormatCodec.createDecoder({ type: 'session', ...header }, 'strict').decodeRow(encoded, collector)
      expect(collector.values).toEqual([before])
      expect(event).toEqual(before)
    }
    const opaque = rows.at(-1)!
    const migrated = createSessionFormatCatalogWithChildren([]).createRestore({ type: 'session', ...header, version: 3 }, {
      recovery: 'strict', validation: 'current',
    })
    migrated.decodeRow(opaque)
    expect(migrated.finish().events).toEqual([{ ...opaque, type: 'plugin:future/opaque' }])
  })
})
