import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatArtifact,
  SessionFormatArtifactDecoder,
  SessionFormatEvent,
  SessionFormatEventRun,
  SessionFormatJsonValue,
  SessionFormatMigrationContext,
  SessionFormatRecovery,
} from '@deepseek-ai/dsh-session-format'
import {
  releasedV0SessionFormatCodec,
  releasedV1SessionFormatCodec,
} from '../src/index.ts'

const fullHeader = {
  type: 'session', version: 1, id: 'codec', createdAt: 1, cwd: '/work', parentSession: 'parent',
  seedLength: 0, origin: 'subagent', delegationDepth: 1, agentPreset: 'default',
} as const
const textBlock = { type: 'text', text: 'text' } as const

class DecodedItemCollector implements SessionFormatMigrationContext {
  readonly values: Array<SessionFormatEvent | SessionFormatEventRun> = []

  emitEvent(event: SessionFormatEvent): void {
    this.values.push(event)
  }

  emitRun(run: SessionFormatEventRun): void {
    this.values.push(run)
  }
}

function decodeRow(
  decoder: SessionFormatArtifactDecoder,
  row: SessionFormatJsonValue,
): Array<SessionFormatEvent | SessionFormatEventRun> {
  const output = new DecodedItemCollector()
  decoder.decodeRow(row, output)
  return output.values
}

function decodeArtifact(
  codec: typeof releasedV0SessionFormatCodec,
  header: unknown,
  rows: readonly unknown[],
  recovery: SessionFormatRecovery = 'strict',
): SessionFormatArtifact {
  const decoder = codec.createDecoder(header, recovery)
  const context = new SessionFormatEventCollector()
  for (const row of rows) decoder.decodeRow(row, context)
  return { header: decoder.header, inheritedEventCount: decoder.finish(context), events: context.values }
}

describe('released v0/v1 physical codecs', () => {
  it('decodes every physical header field and seeded zero cut', () => {
    const decoded = decodeArtifact(releasedV1SessionFormatCodec, fullHeader, [])
    expect(decoded).toEqual({
      header: {
        version: 1, id: 'codec', createdAt: 1, cwd: '/work', parentSession: 'parent',
        isSeeded: true, origin: 'subagent', delegationDepth: 1, agentPreset: 'default',
      },
      inheritedEventCount: 0,
      events: [],
    })
    expect(releasedV0SessionFormatCodec.decodeHeader({ ...fullHeader, version: 0 }))
      .toEqual({ ...decoded.header, version: 0 })
  })

  it.each([
    ['non-object', null],
    ['extra member', { ...fullHeader, extra: true }],
    ['wrong type', { ...fullHeader, type: 'other' }],
    ['wrong version', { ...fullHeader, version: 0 }],
    ['non-string id', { ...fullHeader, id: 1 }],
    ['negative creation', { ...fullHeader, createdAt: -1 }],
    ['negative depth', { ...fullHeader, delegationDepth: -1 }],
    ['bad cwd', { ...fullHeader, cwd: 1 }],
    ['bad parent', { ...fullHeader, parentSession: 1 }],
    ['bad preset', { ...fullHeader, agentPreset: 1 }],
    ['bad origin', { ...fullHeader, origin: 'other' }],
  ])('refuses malformed physical header: %s', (_name, header) => {
    expect(() => releasedV1SessionFormatCodec.decodeHeader(header)).toThrow()
  })

  it('expands valid text, reasoning, and named or unnamed tool-call rows exactly', () => {
    const cases = [
      [{
        type: 'text-chunks', seq0: 0, time0: 1,
        data: { turn: 1, step: 2, index: 3, dt: [2], texts: ['a', 'b'] },
      }, [
        { type: 'assistant/chunk', seq: 0, time: 1, data: {
          turn: 1, step: 2, chunk: { type: 'text-delta', index: 3, text: 'a' },
        } },
        { type: 'assistant/chunk', seq: 1, time: 3, data: {
          turn: 1, step: 2, chunk: { type: 'text-delta', index: 3, text: 'b' },
        } },
      ]],
      [{
        type: 'reasoning-chunks', seq0: 0, time0: 4,
        data: { turn: 2, step: 3, index: 1, dt: [1], texts: ['c', 'd'] },
      }, [
        { type: 'assistant/chunk', seq: 0, time: 4, data: {
          turn: 2, step: 3, chunk: { type: 'reasoning-delta', index: 1, text: 'c' },
        } },
        { type: 'assistant/chunk', seq: 1, time: 5, data: {
          turn: 2, step: 3, chunk: { type: 'reasoning-delta', index: 1, text: 'd' },
        } },
      ]],
      [{
        type: 'tool-call-chunks', seq0: 0, time0: 6,
        data: { turn: 3, step: 4, index: 2, id: 'call', name: 'read', dt: [1], args: ['{', '}'] },
      }, [
        { type: 'assistant/chunk', seq: 0, time: 6, data: {
          turn: 3, step: 4,
          chunk: { type: 'tool-call-delta', index: 2, id: 'call', name: 'read', argumentsDelta: '{' },
        } },
        { type: 'assistant/chunk', seq: 1, time: 7, data: {
          turn: 3, step: 4,
          chunk: { type: 'tool-call-delta', index: 2, id: 'call', name: 'read', argumentsDelta: '}' },
        } },
      ]],
      [{
        type: 'tool-call-chunks', seq0: 0, time0: 8,
        data: { turn: 4, step: 5, index: 0, id: 'call', dt: [], args: ['x'] },
      }, [
        { type: 'assistant/chunk', seq: 0, time: 8, data: {
          turn: 4, step: 5,
          chunk: { type: 'tool-call-delta', index: 0, id: 'call', argumentsDelta: 'x' },
        } },
      ]],
    ] as const

    for (const [row, expected] of cases) {
      const decoder = releasedV1SessionFormatCodec.createDecoder(fullHeader, 'strict')
      const item = decodeRow(decoder, row)[0]
      if (item === undefined || !('runType' in item)) throw new Error('expected a packed Assistant run')
      expect([...(item as SessionFormatEventRun).expand()]).toEqual(expected)
    }
  })

  it.each([
    ['row envelope', { type: 'text-chunks', seq0: 0, time0: 1, data: {}, extra: true }],
    ['empty payload', { type: 'text-chunks', seq0: 0, time0: 1, data: { turn: 1, step: 0, index: 0, dt: [], texts: [] } }],
    ['non-string payload', { type: 'text-chunks', seq0: 0, time0: 1, data: { turn: 1, step: 0, index: 0, dt: [], texts: [1] } }],
    ['gap arity', { type: 'reasoning-chunks', seq0: 0, time0: 1, data: { turn: 1, step: 0, index: 0, dt: [], texts: ['a', 'b'] } }],
    ['coordinates', { type: 'text-chunks', seq0: 0, time0: 1, data: { turn: '1', step: 0, index: 0, dt: [], texts: ['a'] } }],
    ['tool id', { type: 'tool-call-chunks', seq0: 0, time0: 1, data: { turn: 1, step: 0, index: 0, id: 1, dt: [], args: ['a'] } }],
    ['tool name', { type: 'tool-call-chunks', seq0: 0, time0: 1, data: { turn: 1, step: 0, index: 0, id: 'id', name: 1, dt: [], args: ['a'] } }],
    ['unsafe time sum', { type: 'text-chunks', seq0: 0, time0: Number.MAX_SAFE_INTEGER, data: { turn: 1, step: 0, index: 0, dt: [1], texts: ['a', 'b'] } }],
  ])('refuses malformed packed row: %s', (_name, row) => {
    expect(() => decodeArtifact(releasedV1SessionFormatCodec, fullHeader, [row])).toThrow()
  })

  it.each([
    ['not array', 'bad'],
    ['too many scalar entries', [0, 0]],
    ['malformed range', [[0]]],
    ['reversed range', [[2, 1]]],
    ['range past event', [[0, 3]]],
    ['overlapping ranges', [[0, 1], [1, 2]]],
  ])('refuses malformed stored provenance: %s', (_name, sourceEventSeqs) => {
    const rows = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: {
        id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user' },
      }, sourceEventSeqs, surfaceOp: 'append' },
    ]
    expect(() => decodeArtifact(releasedV1SessionFormatCodec,
      { type: 'session', version: 1, id: 'codec', createdAt: 1, delegationDepth: 0 },
      rows,
    )).toThrow()
  })

  it('contains non-SessionFormatError row failures during recoverable scans', () => {
    const bad = new Proxy({}, { get: () => { throw new Error('proxy failure') } })
    const decoder = releasedV1SessionFormatCodec.createDecoder(
      { type: 'session', version: 1, id: 'codec', createdAt: 1, delegationDepth: 0 },
      'recoverable',
    )
    expect(decodeRow(decoder, bad)).toEqual([])
    expect(() => decodeRow(decoder, {
      type: 'turn/end', seq: 0, time: 2, data: { turn: 1, reason: { kind: 'completed' } },
    })).toThrow('released Session row 0 is malformed')
  })

  it('streams the same row-atomic recoverable prefix', () => {
    const create = (header: unknown) => releasedV1SessionFormatCodec.createDecoder(header, 'recoverable')
    const header = { type: 'session', version: 1, id: 'codec', createdAt: 1, delegationDepth: 0 }

    const malformed = create(header)
    expect(decodeRow(malformed, null)).toEqual([])
    const malformedProxy = create(header)
    const proxy = new Proxy({}, { get: () => { throw new Error('proxy failure') } })
    expect(decodeRow(malformedProxy, proxy)).toEqual([])
    expect(decodeRow(malformedProxy, { type: 'step/start', seq: 0, time: 1, data: { turn: 1, step: 1 } })).toEqual([])
    expect(() => decodeRow(malformedProxy, {
      type: 'turn/end', seq: 0, time: 2, data: { turn: 1, reason: { kind: 'completed' } },
    })).toThrow('released Session row 0 is malformed')

    const gap = create(header)
    expect(decodeRow(gap, { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } })).toEqual([])
    const terminalGap = create(header)
    expect(() => decodeRow(terminalGap, {
      type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } },
    })).toThrow(/seq gap/)

    const seeded = create({ ...header, seedLength: 1 })
    expect(() => seeded.finish(new DecodedItemCollector())).toThrow(/inheritedEventCount exceeds/)

    const packed = create(header)
    const runs = decodeRow(packed, {
      type: 'text-chunks', seq0: 0, time0: 1,
      data: { turn: 1, step: 1, index: 0, dt: [1], texts: ['a', 'b'] },
    })
    expect(runs).toHaveLength(1)
    expect([...((runs[0] as SessionFormatEventRun).expand())]).toHaveLength(2)
    const provenance = create(header)
    decodeRow(provenance, { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })
    const item = decodeRow(provenance, {
      type: 'user/message', seq: 1, time: 2,
      data: { id: 'm', role: 'user', content: [], source: { kind: 'user' } },
      sourceEventSeqs: [0], surfaceOp: 'append',
    })[0]
    expect(item !== undefined && !('runType' in item) ? item.sourceEventSeqs : undefined).toEqual([0])
  })

  it('ignores decodable non-terminal rows after the first recoverable issue', () => {
    const header = { type: 'session', version: 1, id: 'codec', createdAt: 1, delegationDepth: 0 }
    const recovered = decodeArtifact(releasedV1SessionFormatCodec, header, [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/start', seq: 4, time: 2, data: { turn: 2 } },
      { type: 'step/start', seq: 1, time: 3, data: { turn: 1, step: 0 } },
    ], 'recoverable')
    expect(recovered).toMatchObject({ events: [{ seq: 0 }] })
  })

  it('rejects strict gaps and a recoverable gap row that itself closes a turn', () => {
    const currentHeader = { type: 'session', version: 1, id: 'codec', createdAt: 1, delegationDepth: 0 }
    expect(() => decodeArtifact(releasedV1SessionFormatCodec, currentHeader, [
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    ])).toThrow(/seq gap/)
    expect(() => decodeArtifact(releasedV1SessionFormatCodec, currentHeader, [
      { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ], 'recoverable')).toThrow(/seq gap/)
  })

  it('refuses overlapping ranges after a valid first range', () => {
    const header = { type: 'session', version: 1, id: 'codec', createdAt: 1, delegationDepth: 0 }
    const rows = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'step/end', seq: 2, time: 3, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
      {
        type: 'user/message', seq: 4, time: 5, surfaceOp: 'append', sourceEventSeqs: [[0, 1], [1, 2]],
        data: { id: 'u', role: 'user', content: [textBlock], source: { kind: 'user' } },
      },
    ]
    expect(() => decodeArtifact(releasedV1SessionFormatCodec, header, rows)).toThrow(/strictly increasing/)
  })
})
