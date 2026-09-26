/** Developer messages and deferred schemas survive native V4 persistence. */
import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { assertV4RowAdmission, releasedV4SessionFormatCodec as codec, restoreReleasedV4Artifact } from '../src/index.ts'

const header = { version: 4, id: 'developer', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const message = { id: 'developer-1', role: 'developer', source: { kind: 'tool-registry' }, content: [{ type: 'tool-addition', toolName: 'search' }, { type: 'tool-removal', toolName: 'old' }] }
const developer: SessionFormatEvent = { type: 'developer/message', seq: 3, time: 4, surfaceOp: 'append', data: { turn: 1, step: 1, headerSeq: 2, message } }
const request: SessionFormatEvent = { type: 'request/header', seq: 2, time: 3, data: {
  reason: 'initial', header: { config: { provider: 'test', model: 'test' }, tools: [{ name: 'search', description: 'Search', parameters: {}, deferLoading: true }] },
} }
function events(): SessionFormatEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    request, developer,
    { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}
function roundTrip(input: SessionFormatEvent[]): SessionFormatEvent[] {
  const decoder = codec.createDecoder(codec.encodeHeader(header, 0), 'strict')
  const output = new SessionFormatEventCollector()
  for (const event of input) decoder.decodeRow(codec.encodeEvent(event), output)
  decoder.finish(output)
  return output.values
}

describe('V4 developer messages', () => {
  it('round trips native messages and deferred schemas without rewriting native payloads', () => {
    const input = events()
    expect(roundTrip(input)).toEqual(input)
    const artifact = { header, events: input, inheritedEventCount: 0 }
    expect(restoreReleasedV4Artifact(artifact, new Set(input.map(event => event.type)))).toBe(artifact)
  })

  it('preserves additional JSON fields in developer data, messages, sources, and blocks', () => {
    const input = events()
    input[3] = { ...developer, data: { turn: 1, step: 1, headerSeq: 2, metadata: { future: true }, message: {
      ...message, metadata: ['retained'], source: { kind: 'tool-registry', future: 1 }, content: [
        { type: 'tool-addition', toolName: 'search', future: true },
        { type: 'tool-removal', toolName: 'old', future: true },
      ],
    } } }
    input[2] = { ...request, data: { reason: 'initial', header: { config: { provider: 'test', model: 'test' }, tools: [{ name: 'search', description: 'Search', parameters: {}, deferLoading: true, future: { retained: true } }] } } }
    expect(roundTrip(input)).toEqual(input)
    const artifact = { header, events: input, inheritedEventCount: 0 }
    expect(restoreReleasedV4Artifact(artifact, new Set(input.map(event => event.type)))).toBe(artifact)
  })

  it.each([undefined, null, '', 1])('rejects a malformed addition name %#', (toolName) => {
    const row = { ...developer, data: { turn: 1, step: 1, headerSeq: 2, message: {
      ...message, content: [{ type: 'tool-addition', ...(toolName === undefined ? {} : { toolName }) }],
    } } }
    expect(() => codec.encodeEvent(row)).toThrow('nonempty toolName')
    expect(() => { assertV4RowAdmission(row) }).toThrow('nonempty toolName')
  })

  it('refuses an inline definition even when a header and name are present', () => {
    const row = { ...developer, data: { turn: 1, step: 1, headerSeq: 2, message: {
      ...message, content: [{ type: 'tool-addition', toolName: 'search', tool: { name: 'search', description: 'Duplicate', parameters: {} } }],
    } } }
    expect(() => codec.encodeEvent(row)).toThrow('omit inline tool definitions')
    expect(() => { assertV4RowAdmission(row) }).toThrow('omit inline tool definitions')
  })

  it.each([undefined, null, -1, -0, 1.5, '2'])('rejects an absent or invalid addition header sequence %#', (headerSeq) => {
    const row = { ...developer, data: { turn: 1, step: 1, message, ...(headerSeq === undefined ? {} : { headerSeq }) } }
    expect(() => codec.encodeEvent(row)).toThrow('headerSeq')
    expect(() => { assertV4RowAdmission(row) }).toThrow('headerSeq')
  })

  it('requires removal-only messages to omit the header sequence', () => {
    const row = { ...developer, data: { turn: 1, step: 1, headerSeq: 2, message: {
      ...message, content: [{ type: 'tool-removal', toolName: 'search' }],
    } } }
    expect(() => codec.encodeEvent(row)).toThrow('omit headerSeq')
  })

  it.each([0, 3, 50])('refuses a non-header or non-earlier schema reference %s', (headerSeq) => {
    const input = events()
    input[3] = { ...developer, data: { turn: 1, step: 1, headerSeq, message } }
    expect(() => restoreReleasedV4Artifact({ header, events: input, inheritedEventCount: 0 }, new Set(input.map(event => event.type))))
      .toThrow(/headerSeq.*earlier/)
  })

  it.each([
    { tools: undefined },
    { tools: [null] },
    { tools: [{ name: 'different', description: '', parameters: {} }] },
    { tools: [{ name: 'search', description: 'First', parameters: {} }, { name: 'search', description: 'Second', parameters: {} }] },
  ])('refuses missing or ambiguous names in the referenced header %#', ({ tools }) => {
    const input = events()
    input[2] = { ...request, data: { reason: 'initial', header: { config: { provider: 'test', model: 'test' }, ...(tools === undefined ? {} : { tools }) } } }
    expect(() => restoreReleasedV4Artifact({ header, events: input, inheritedEventCount: 0 }, new Set(input.map(event => event.type))))
      .toThrow('exactly one tool')
  })

  it.each([
    { name: 'search' },
    { name: 'search', description: null, parameters: {} },
    { name: 'search', description: '', parameters: [] },
    { name: 'search', description: '', parameters: null },
  ])('refuses an incomplete referenced definition %#', (tool) => {
    const input = events()
    input[2] = { ...request, data: { reason: 'initial', header: { config: { provider: 'test', model: 'test' }, tools: [tool] } } }
    expect(() => restoreReleasedV4Artifact({ header, events: input, inheritedEventCount: 0 }, new Set(input.map(event => event.type))))
      .toThrow('complete tool definition')
  })

  it.each([null, request.data])('does not interpret an unknown ignorable header referenced by a known developer event %#', (data) => {
    const input = events()
    input[2] = { ...request, ignorable: true, data }
    const known = new Set(input.map(event => event.type))
    known.delete('request/header')
    expect(() => restoreReleasedV4Artifact({ header, events: input, inheritedEventCount: 0 }, known)).toThrow('known request/header')
    input[3] = { ...developer, ignorable: true, data: { opaque: true, headerSeq: { future: true } }, surfaceOp: { future: true } }
    known.delete('developer/message')
    const artifact = { header, events: input, inheritedEventCount: 0 }
    expect(restoreReleasedV4Artifact(artifact, known)).toBe(artifact)
  })

  it('keeps historical schema references when compaction shadows their developer nodes', () => {
    const input = [
      ...events().slice(0, 4),
      { type: 'compaction/prune', seq: 4, time: 5, data: { shadowedRange: { start: 3, end: 3 }, shadowedSeqs: [3], shadowedTokenCount: 0 } },
      ...events().slice(4).map(event => ({ ...event, seq: event.seq + 1 })),
    ]
    const artifact = { header, events: input, inheritedEventCount: 0 }
    expect(restoreReleasedV4Artifact(artifact, new Set(input.map(event => event.type)))).toBe(artifact)
    expect(input[2]).toEqual(request)
  })

  it.each([null, [], 'invalid'])('refuses non-object developer data %j before recovery', (data) => {
    const row = { ...developer, data }
    expect(() => codec.encodeEvent(row)).toThrow('developer/message data must be an object')
    expect(() => { assertV4RowAdmission(row) }).toThrow('developer/message data must be an object')
  })

  it.each([{ turn: 1, step: 1 }, { turn: 1, step: 1, message: null }])(
    'rejects malformed developer event fields %#', (data) => {
      expect(() => codec.encodeEvent({ ...developer, data })).toThrow('requires turn, step, and a developer message')
    },
  )

  it('leaves malformed legacy stream chunks to canonical decoding', () => {
    expect(() => { assertV4RowAdmission({ type: 'assistant/attempt', seq: 2, time: 3,
      data: { stream: [{ type: 'chunk', chunk: null }] },
    }) }).not.toThrow()
  })

  it.each(['agent/inbox/spliced', 'session/title-llm-request'])('leaves malformed ordinary arrays in %s to canonical decoding', (type) => {
    const key = type === 'agent/inbox/spliced' ? 'inserted' : 'messages'
    expect(() => { assertV4RowAdmission({ type, seq: 2, time: 3, data: { [key]: null } }) }).not.toThrow()
  })

  it.each([false, true])('preserves ordinary tools alongside deferred tools: %s', (mixed) => {
    const ordinary = { name: 'ordinary', description: 'Ordinary', parameters: {} }
    const tools = mixed ? [ordinary, { ...ordinary, name: 'deferred', deferLoading: true }] : [ordinary]
    const input = events()
    input[2] = { ...request, data: { reason: 'initial', header: { config: { provider: 'test', model: 'test' }, tools } } }
    expect(roundTrip(input)).toEqual(input)
  })

  it('does not interpret tool entries without deferred markers', () => {
    const row = { ...request, data: { reason: 'initial', header: { config: { provider: 'test', model: 'test' }, tools: [null] } } }
    expect(() => { assertV4RowAdmission(row) }).not.toThrow()
  })

  it('preserves the historical header while replacing a developer surface node', () => {
    const replacement = { ...developer, seq: 4, time: 5, surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, sourceEventSeqs: [3],
      data: { turn: 1, step: 1, headerSeq: 2, message: { ...message, id: 'developer-2' } } }
    const input = [...events().slice(0, 4), replacement, ...events().slice(4).map(event => ({ ...event, seq: event.seq + 1 }))]
    expect(roundTrip(input)).toEqual(input)
    const restored = restoreReleasedV4Artifact({ header, events: input, inheritedEventCount: 0 }, new Set(input.map(event => event.type)))
    expect(restored.events).toEqual(input)
  })

  it.each([false, null, 'true', 1])('rejects invalid deferred marker %j', (deferLoading) => {
    const row = { ...request, data: { reason: 'initial', header: { config: { provider: 'test', model: 'test' }, tools: [{ name: 'search', description: '', parameters: {}, deferLoading }] } } }
    expect(() => codec.encodeEvent(row)).toThrow('deferLoading')
    expect(() => { assertV4RowAdmission(row) }).toThrow('deferLoading')
  })

  it.each([
    { ...message, role: 'user' },
    { ...message, id: '' },
    { ...message, source: { kind: 'plugin' } },
    { ...message, content: [{ type: 'tool-addition', toolName: '' }] },
    { ...message, content: [{ type: 'tool-removal', toolName: '' }] },
  ])('rejects malformed developer message %#', (invalid) => {
    const row = { ...developer, data: { turn: 1, step: 1, message: invalid } }
    expect(() => codec.encodeEvent(row)).toThrow()
    expect(() => { assertV4RowAdmission(row) }).toThrow()
  })

  it('preserves developer messages inside an inherited prefix', () => {
    const inheritedHeader = { ...header, isSeeded: true, parentSession: 'parent' }
    const input = events()
    const inherited = [
      ...input.slice(0, 4),
      { type: 'session/end-seed', seq: 4, time: 5, data: { inherited: true } },
      ...input.slice(4).map(event => ({ ...event, seq: event.seq + 1 })),
    ]
    const decoder = codec.createDecoder(codec.encodeHeader(inheritedHeader, 4), 'strict')
    const output = new SessionFormatEventCollector()
    for (const event of inherited) decoder.decodeRow(codec.encodeEvent(event), output)
    expect(decoder.finish(output)).toBe(4)
    expect(output.values).toEqual(inherited)
    const artifact = { header: inheritedHeader, events: output.values, inheritedEventCount: 4 }
    expect(restoreReleasedV4Artifact(artifact, new Set(inherited.map(event => event.type)))).toBe(artifact)
  })

  it('refuses developer history when the reader does not know the event type', () => {
    const input = events()
    const known = new Set(input.map(event => event.type))
    known.delete('developer/message')
    expect(() => restoreReleasedV4Artifact({ header, events: input, inheritedEventCount: 0 }, known)).toThrow('unknown event type')
  })

  it('checks request coordinates and the open step', () => {
    const input = events()
    input[3] = { ...developer, data: { ...(developer.data as SessionFormatJsonObject), step: 2 } }
    const known = new Set(input.map(event => event.type))
    expect(() => restoreReleasedV4Artifact({ header, events: input, inheritedEventCount: 0 }, known)).toThrow(/open.*step/)
    expect(() => codec.encodeEvent({ ...developer, data: { turn: 0, step: 1, message } })).toThrow('positive')
  })

  it.each(['user', 'system', 'assistant', 'tool'])('rejects tool-change blocks in %s messages', (role) => {
    for (const type of ['tool-addition', 'tool-removal']) {
      const source = role === 'system' ? { kind: 'system-prompt' }
        : role === 'assistant' ? { kind: 'model', provider: 'test', model: 'test' }
          : role === 'tool' ? { kind: 'tool', callId: 'call' } : { kind: 'user' }
      const invalid = { ...message, role, source, content: [{ type, toolName: 'search' }],
        ...role === 'tool' ? { toolCallId: 'call', isError: false } : {},
      }
      const eventType = role === 'tool' ? 'tool/result' : `${role}/message`
      const row = { ...developer, type: eventType, data: role === 'user' ? invalid : { turn: 1, step: 1, message: invalid } }
      expect(() => codec.encodeEvent(row)).toThrow('developer role')
      expect(() => { assertV4RowAdmission(row) }).toThrow('developer role')
      const decoder = codec.createDecoder(codec.encodeHeader(header, 0), 'strict')
      expect(() => { decoder.decodeRow(row, new SessionFormatEventCollector()) }).toThrow('developer role')
      const input = events()
      input[3] = row
      const artifact = { header, events: input, inheritedEventCount: 0 }
      expect(() => restoreReleasedV4Artifact(artifact, new Set(input.map(event => event.type)))).toThrow('developer role')
    }
  })

  it.each(['user/message', 'system/message', 'assistant/message', 'tool/result'])('rejects developer role inside %s before payload recovery', (type) => {
    const row = { ...developer, type, data: type === 'user/message' ? message : { turn: 1, step: 1, message } }
    expect(() => codec.encodeEvent(row)).toThrow(/must occur together|requires a tool-role message/)
    expect(() => { assertV4RowAdmission(row) }).toThrow('must occur together')
    const decoder = codec.createDecoder(codec.encodeHeader(header, 0), 'strict')
    expect(() => { decoder.decodeRow(row, new SessionFormatEventCollector()) }).toThrow('must occur together')
  })

  it.each(['agent/inbox/spliced', 'session/title-llm-request'])('rejects developer role in %s message arrays', (type) => {
    const key = type === 'agent/inbox/spliced' ? 'inserted' : 'messages'
    const row = { type, seq: 3, time: 4, data: { [key]: [null, message] } }
    expect(() => codec.encodeEvent(row)).toThrow('must occur together')
    expect(() => { assertV4RowAdmission(row) }).toThrow('must occur together')
    const decoder = codec.createDecoder(codec.encodeHeader(header, 0), 'strict')
    expect(() => { decoder.decodeRow(row, new SessionFormatEventCollector()) }).toThrow('must occur together')
    const input = events()
    input[3] = row
    const artifact = { header, events: input, inheritedEventCount: 0 }
    expect(() => restoreReleasedV4Artifact(artifact, new Set(input.map(event => event.type)))).toThrow('must occur together')
  })

  it('retains unknown ignorable developer records without interpreting their payload or surface', () => {
    const input = events()
    input[3] = { ...developer, ignorable: true, data: { future: true }, surfaceOp: { future: true } }
    const known = new Set(input.map(event => event.type))
    known.delete('developer/message')
    const artifact = { header, events: input, inheritedEventCount: 0 }
    expect(restoreReleasedV4Artifact(artifact, known)).toBe(artifact)
  })

  it('still validates known ignorable developer records', () => {
    const input = events()
    input[3] = { ...developer, ignorable: true, data: { turn: 1, step: 2, headerSeq: 2, message } }
    const known = new Set(input.map(event => event.type))
    expect(() => restoreReleasedV4Artifact({ header, events: input, inheritedEventCount: 0 }, known)).toThrow(/open.*step/)
  })

  it.each(['tool-addition', 'tool-removal'])('rejects %s outside developer content, including streamed blocks', (type) => {
    const block = { type, toolName: 'search' }
    const payloads = [
      { type: 'compaction/summary', data: { summary: [block] } },
      { type: 'compaction/summary', data: { rawOutput: [block] } },
      { type: 'assistant/attempt', data: { stream: [{ type: 'chunk', chunk: { type: 'block-end', block } }] } },
      { type: 'assistant/attempt', data: { stream: [{ type: 'chunk', chunk: { type: 'block-start', blockType: type } }] } },
      { type: 'agent/inbox/spliced', data: { inserted: [{ ...message, role: 'user', content: [block] }] } },
      { type: 'session/title-llm-request', data: { messages: [{ ...message, role: 'user', content: [block] }] } },
    ]
    for (const payload of payloads) {
      expect(() => { assertV4RowAdmission({ seq: 2, time: 3, ...payload }) }).toThrow('developer role')
    }
  })
})
