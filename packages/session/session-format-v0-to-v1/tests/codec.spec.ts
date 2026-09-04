import { describe, expect, it } from 'vitest'
import type { SessionFormatArtifact, SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import {
  releasedV0SessionFormatCodec,
  releasedV1SessionFormatCodec,
} from '../src/index.ts'

const fullHeader = {
  type: 'session', version: 1, id: 'codec', createdAt: 1, cwd: '/work', parentSession: 'parent',
  seedLength: 0, origin: 'subagent', delegationDepth: 1, agentPreset: 'default',
} as const
const textBlock = { type: 'text', text: 'text' } as const

function chunk(
  seq: number,
  type: 'text-delta' | 'reasoning-delta' | 'tool-call-delta',
  value: string,
  options: { turn?: number; step?: number; index?: number; time?: number; name?: string } = {},
): SessionFormatEvent {
  const stream = type === 'tool-call-delta'
    ? { type, index: options.index ?? 0, id: 'call', ...(options.name === undefined ? {} : { name: options.name }), argumentsDelta: value }
    : { type, index: options.index ?? 0, text: value }
  return {
    type: 'assistant/chunk', seq, time: options.time ?? seq + 1,
    data: { turn: options.turn ?? 1, step: options.step ?? 0, chunk: stream },
  }
}

function artifact(events: readonly SessionFormatEvent[], overrides: Partial<SessionFormatArtifact> = {}): SessionFormatArtifact {
  return {
    header: { version: 1, id: 'codec', createdAt: 1, isSeeded: false, delegationDepth: 0 },
    inheritedEventCount: 0,
    events,
    ...overrides,
  }
}

describe('released v0/v1 physical codecs', () => {
  it('round-trips every physical header field and seeded zero cut', () => {
    const decoded = releasedV1SessionFormatCodec.decodeArtifact(fullHeader, [])
    expect(decoded).toEqual({
      header: {
        version: 1, id: 'codec', createdAt: 1, cwd: '/work', parentSession: 'parent',
        isSeeded: true, origin: 'subagent', delegationDepth: 1, agentPreset: 'default',
      },
      inheritedEventCount: 0,
      events: [],
    })
    expect(releasedV1SessionFormatCodec.encodeArtifact(decoded, { packChunks: false }).header).toEqual(fullHeader)
    expect(releasedV0SessionFormatCodec.encodeArtifact({
      ...decoded,
      header: { ...decoded.header, version: 0 },
    }, { packChunks: false }).header).toEqual({ ...fullHeader, version: 0 })
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

  it('packs and expands text, reasoning, and named tool-call runs exactly', () => {
    const events = [
      chunk(0, 'text-delta', 'a'), chunk(1, 'text-delta', 'b'), chunk(2, 'text-delta', 'c'),
      chunk(3, 'reasoning-delta', 'd'), chunk(4, 'reasoning-delta', 'e'), chunk(5, 'reasoning-delta', 'f'),
      chunk(6, 'tool-call-delta', '{', { name: 'read' }),
      chunk(7, 'tool-call-delta', '}', { name: 'read' }),
      chunk(8, 'tool-call-delta', '', { name: 'read' }),
    ]
    const v0 = { ...artifact(events), header: { ...artifact(events).header, version: 0 } }
    const encoded = releasedV0SessionFormatCodec.encodeArtifact(v0, { packChunks: true })
    expect(encoded.rows.map(row => row['type'])).toEqual(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])
    expect(releasedV0SessionFormatCodec.decodeArtifact(encoded.header, encoded.rows).events).toEqual(events)

    const unnamed = [
      chunk(0, 'tool-call-delta', 'a'),
      chunk(1, 'tool-call-delta', 'b'),
      chunk(2, 'tool-call-delta', 'c'),
    ]
    const unnamedV0 = { ...artifact(unnamed), header: { ...artifact(unnamed).header, version: 0 } }
    const unnamedEncoded = releasedV0SessionFormatCodec.encodeArtifact(unnamedV0, { packChunks: true })
    expect(unnamedEncoded.rows[0]?.['data']).not.toHaveProperty('name')
    expect(releasedV0SessionFormatCodec.decodeArtifact(unnamedEncoded.header, unnamedEncoded.rows).events).toEqual(unnamed)
  })

  it('keeps short or non-continuing chunk runs unpacked', () => {
    const events = [
      chunk(0, 'text-delta', 'a'),
      chunk(1, 'text-delta', 'b', { index: 1 }),
      chunk(2, 'text-delta', 'c', { turn: 2 }),
      chunk(3, 'text-delta', 'd', { step: 1 }),
      chunk(4, 'tool-call-delta', 'a'),
      chunk(5, 'tool-call-delta', 'b', { name: 'read' }),
      chunk(6, 'tool-call-delta', 'c', { name: 'read' }),
    ]
    const v0 = { ...artifact(events), header: { ...artifact(events).header, version: 0 } }
    const encoded = releasedV0SessionFormatCodec.encodeArtifact(v0, { packChunks: true })
    expect(encoded.rows).toEqual(events)
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
    expect(() => releasedV1SessionFormatCodec.decodeArtifact(fullHeader, [row])).toThrow()
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
    expect(() => releasedV1SessionFormatCodec.decodeArtifact(
      { type: 'session', version: 1, id: 'codec', createdAt: 1, delegationDepth: 0 },
      rows,
    )).toThrow()
  })

  it('contains non-SessionFormatError row failures during recoverable scans', () => {
    const bad = new Proxy({}, { ownKeys: () => { throw new Error('proxy failure') } })
    const recovered = releasedV1SessionFormatCodec.decodeRecoverableArtifact(
      { type: 'session', version: 1, id: 'codec', createdAt: 1, delegationDepth: 0 },
      [bad],
    )
    expect(recovered).toMatchObject({ events: [] })
  })

  it('ignores decodable non-terminal rows after the first recoverable issue', () => {
    const header = { type: 'session', version: 1, id: 'codec', createdAt: 1, delegationDepth: 0 }
    const recovered = releasedV1SessionFormatCodec.decodeRecoverableArtifact(header, [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/start', seq: 4, time: 2, data: { turn: 2 } },
      { type: 'step/start', seq: 1, time: 3, data: { turn: 1, step: 0 } },
    ])
    expect(recovered).toMatchObject({ events: [{ seq: 0 }] })
  })

  it('rejects strict gaps and a recoverable gap row that itself closes a turn', () => {
    const currentHeader = { type: 'session', version: 1, id: 'codec', createdAt: 1, delegationDepth: 0 }
    expect(() => releasedV1SessionFormatCodec.decodeArtifact(currentHeader, [
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    ])).toThrow(/seq gap/)
    expect(() => releasedV1SessionFormatCodec.decodeRecoverableArtifact(currentHeader, [
      { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ])).toThrow(/seq gap/)
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
    expect(() => releasedV1SessionFormatCodec.decodeArtifact(header, rows)).toThrow(/strictly increasing/)
  })

  it('keeps non-consecutive provenance scalar and leaves invalid v0 chunks unpacked', () => {
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'step/end', seq: 2, time: 3, data: { turn: 1, step: 1 } },
      {
        type: 'user/message', seq: 3, time: 4, surfaceOp: 'append', sourceEventSeqs: [0, 2],
        data: { id: 'u', role: 'user', content: [textBlock], source: { kind: 'user' } },
      },
    ] as SessionFormatEvent[]
    expect(releasedV1SessionFormatCodec.encodeArtifact(artifact(events), { packChunks: false }).rows[3])
      .toEqual(events[3])

    const invalidChunk = { type: 'assistant/chunk', seq: 0, time: 1, data: { turn: 1, step: 0, chunk: null } }
    const v0 = {
      header: { version: 0, id: 'codec', createdAt: 1, isSeeded: false, delegationDepth: 0 },
      inheritedEventCount: 0,
      events: [invalidChunk],
    } as unknown as SessionFormatArtifact
    expect(releasedV0SessionFormatCodec.encodeArtifact(v0, { packChunks: true }).rows).toEqual([invalidChunk])

    const causal = {
      ...v0,
      events: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: 2, surfaceOp: 'append', data: {
          id: 'one', role: 'user', content: [textBlock], source: { kind: 'user' },
        } },
        { type: 'user/message', seq: 2, time: 3, surfaceOp: 'append', data: {
          id: 'two', role: 'user', content: [textBlock], source: { kind: 'user' },
        } },
        { type: 'user/message', seq: 3, time: 4, surfaceOp: 'append', sourceEventSeqs: [2, 0], data: {
          id: 'three', role: 'user', content: [textBlock], source: { kind: 'user' },
        } },
      ],
    } as unknown as SessionFormatArtifact
    expect(releasedV0SessionFormatCodec.encodeArtifact(causal, { packChunks: false }).rows[3]?.['sourceEventSeqs'])
      .toEqual([2, 0])

    for (const badData of [
      null,
      { turn: 1, step: 1, chunk: null },
      { turn: 1, step: 1, chunk: { type: 'other', index: 0 } },
      { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 1 } },
      { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 1, argumentsDelta: 'x' } },
    ]) {
      const bad = { ...v0, events: [{ type: 'assistant/chunk', seq: 0, time: 1, data: badData }] } as unknown as SessionFormatArtifact
      expect(releasedV0SessionFormatCodec.encodeArtifact(bad, { packChunks: true }).rows).toHaveLength(1)
    }

    const farTimes = [
      chunk(0, 'text-delta', 'a', { time: Number.MIN_SAFE_INTEGER }),
      chunk(1, 'text-delta', 'b', { time: Number.MAX_SAFE_INTEGER }),
      chunk(2, 'text-delta', 'c', { time: Number.MAX_SAFE_INTEGER }),
    ]
    const far = { ...v0, events: farTimes } as unknown as SessionFormatArtifact
    expect(releasedV0SessionFormatCodec.encodeArtifact(far, { packChunks: true }).rows).toHaveLength(3)

    const ignorable = [
      { ...chunk(0, 'text-delta', 'a'), ignorable: true },
      { ...chunk(1, 'text-delta', 'b'), ignorable: true },
      { ...chunk(2, 'text-delta', 'c'), ignorable: true },
    ] as SessionFormatEvent[]
    const ignorableV0 = { ...v0, events: ignorable } as unknown as SessionFormatArtifact
    expect(releasedV0SessionFormatCodec.encodeArtifact(ignorableV0, { packChunks: true }).rows)
      .toEqual(ignorable)
  })
})
