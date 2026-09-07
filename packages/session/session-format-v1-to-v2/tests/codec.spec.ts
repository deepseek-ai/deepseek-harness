import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatArtifact,
  SessionFormatArtifactDecoder,
  SessionFormatEvent,
  SessionFormatJsonObject,
  SessionFormatRecovery,
} from '@deepseek-ai/dsh-session-format'
import { decodeSeqRanges as decodeCurrentSeqRanges } from '@deepseek-ai/dsh-session'
import { releasedV2SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v1-to-v2'

const minimalPhysicalHeader = {
  type: 'session', version: 2, id: 'codec', createdAt: 1, isSeeded: false, delegationDepth: 0,
} as const

const fullPhysicalHeader = {
  ...minimalPhysicalHeader,
  cwd: '/work',
  parentSession: 'parent',
  origin: 'subagent',
  agentPreset: 'default',
} as const

const textBlock = { type: 'text', text: 'text' } as const

function throwUnknown(value: unknown): never {
  throw value
}

function feedback(seq: number): SessionFormatEvent {
  return { type: 'feedback/record', seq, time: seq + 1, data: { text: `feedback-${seq}` } }
}

function userMessage(seq: number, sourceEventSeqs?: readonly number[]): SessionFormatEvent {
  return {
    type: 'user/message',
    seq,
    time: seq + 1,
    data: {
      id: `user-${seq}`, role: 'user', content: [textBlock], source: { kind: 'user' },
    },
    surfaceOp: 'append',
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
  }
}

function artifact(
  events: readonly SessionFormatEvent[],
  overrides: Partial<SessionFormatArtifact> = {},
): SessionFormatArtifact {
  return {
    header: { version: 2, id: 'codec', createdAt: 1, isSeeded: false, delegationDepth: 0 },
    inheritedEventCount: 0,
    events,
    ...overrides,
  }
}

function decodeV2(
  header: unknown,
  rows: readonly unknown[],
  recovery: SessionFormatRecovery = 'strict',
): SessionFormatArtifact {
  const decoder: SessionFormatArtifactDecoder = releasedV2SessionFormatCodec.createDecoder(header, recovery)
  const context = new SessionFormatEventCollector()
  for (const row of rows) decoder.decodeRow(row, context)
  return { header: decoder.header, inheritedEventCount: decoder.finish(context), events: context.values }
}

function encodeV2(source: SessionFormatArtifact): {
  readonly header: SessionFormatJsonObject
  readonly rows: readonly SessionFormatJsonObject[]
} {
  return {
    header: releasedV2SessionFormatCodec.encodeHeader(source.header, source.inheritedEventCount),
    rows: source.events.map(event => releasedV2SessionFormatCodec.encodeEvent(event)),
  }
}

describe('releasedV2SessionFormatCodec headers', () => {
  it('round-trips the minimal and complete optional header images', () => {
    expect(releasedV2SessionFormatCodec.version).toBe(2)
    expect(releasedV2SessionFormatCodec.decodeHeader(minimalPhysicalHeader)).toStrictEqual({
      version: 2, id: 'codec', createdAt: 1, isSeeded: false, delegationDepth: 0,
    })
    expect(releasedV2SessionFormatCodec.decodeHeader(fullPhysicalHeader)).toStrictEqual({
      version: 2,
      id: 'codec',
      createdAt: 1,
      cwd: '/work',
      parentSession: 'parent',
      isSeeded: false,
      origin: 'subagent',
      delegationDepth: 0,
      agentPreset: 'default',
    })

    const encodedMinimal = encodeV2(artifact([]))
    expect(encodedMinimal).toStrictEqual({ header: minimalPhysicalHeader, rows: [] })
    const complete = artifact([], {
      header: {
        version: 2,
        id: 'codec',
        createdAt: 1,
        cwd: '/work',
        parentSession: 'parent',
        isSeeded: false,
        origin: 'subagent',
        delegationDepth: 0,
        agentPreset: 'default',
      },
    })
    expect(encodeV2(complete).header)
      .toStrictEqual(fullPhysicalHeader)
    expect(() => releasedV2SessionFormatCodec.encodeHeader(
      artifact([]).header,
      1,
    )).toThrow(/unseeded.*inherited events/)
  })

  it.each([
    ['null', null, /must be an object/],
    ['array', [], /must be an object/],
    ['scalar', 'session', /must be an object/],
    ['actually absent required member', (({ id: _id, ...rest }) => rest)(minimalPhysicalHeader), /lacks id/],
    ['unexpected member', { ...minimalPhysicalHeader, seedLength: 0 }, /unexpected field seedLength/],
    ['wrong type tag', { ...minimalPhysicalHeader, type: 'other' }, /expected released v2/],
    ['wrong version', { ...minimalPhysicalHeader, version: 1 }, /expected released v2/],
    ['non-string id', { ...minimalPhysicalHeader, id: 1 }, /id must be a string/],
    ['negative creation time', { ...minimalPhysicalHeader, createdAt: -1 }, /createdAt/],
    ['negative delegation depth', { ...minimalPhysicalHeader, delegationDepth: -1 }, /delegationDepth/],
    ['non-boolean lineage', { ...minimalPhysicalHeader, isSeeded: 0 }, /isSeeded must be boolean/],
    ['non-string cwd', { ...minimalPhysicalHeader, cwd: 1 }, /cwd must be a string/],
    ['relative cwd', { ...minimalPhysicalHeader, cwd: 'relative' }, /cwd must be absolute/],
    ['non-string parent', { ...minimalPhysicalHeader, parentSession: 1 }, /parentSession must be a string/],
    ['non-string preset', { ...minimalPhysicalHeader, agentPreset: 1 }, /agentPreset must be a string/],
    ['bad origin', { ...minimalPhysicalHeader, origin: 'user' }, /origin must be "subagent"/],
  ])('refuses a malformed physical header: %s', (_name, header, message) => {
    expect(() => releasedV2SessionFormatCodec.decodeHeader(header)).toThrow(message)
  })
})

describe('releasedV2SessionFormatCodec rows', () => {
  it('stores one event per row and compacts scalar, pair, and long-run provenance exactly', () => {
    const source = artifact([
      feedback(0),
      userMessage(1, [0]),
      userMessage(2, [0, 1]),
      userMessage(3, [0, 1, 2]),
    ])
    const encoded = encodeV2(source)
    expect(encoded.rows.map(row => row['sourceEventSeqs'])).toStrictEqual([
      undefined,
      [0],
      [0, 1],
      [[0, 2]],
    ])
    expect(decodeV2(encoded.header, encoded.rows)).toStrictEqual(source)
  })

  it('keeps non-monotonic provenance scalar-only for the current backend reader', () => {
    const sourceEventSeqs = [4, 5, 1, 2, 3]
    const source = artifact([
      feedback(0), feedback(1), feedback(2), feedback(3), feedback(4), feedback(5),
      userMessage(6, sourceEventSeqs),
    ])

    const encoded = encodeV2(source)
    const stored = encoded.rows[6]?.['sourceEventSeqs']

    expect(stored).toStrictEqual(sourceEventSeqs)
    expect(decodeCurrentSeqRanges(stored, 6)).toStrictEqual(sourceEventSeqs)
    expect(decodeV2(encoded.header, encoded.rows)).toStrictEqual(source)
  })

  it('keeps the v2 physical codec vocabulary-neutral for current growth and a future source freeze', () => {
    const source = artifact([
      { type: 'external/required', seq: 0, time: 1, data: { retained: true } },
      { type: 'external/ignorable', seq: 1, time: 2, data: { retained: true }, ignorable: true },
      { type: 'turn/start', seq: 2, time: 3, data: { turn: 1, postReleaseMember: true } },
    ])

    const encoded = encodeV2(source)

    expect(decodeV2(encoded.header, encoded.rows)).toStrictEqual(source)
  })

  it('expands mixed stored ranges and preserves non-provenance rows', () => {
    const rows: SessionFormatJsonObject[] = [feedback(0), feedback(1), feedback(2), feedback(3), feedback(4), {
      ...userMessage(5),
      sourceEventSeqs: [[0, 2], 4],
    }]
    const decoded = decodeV2(minimalPhysicalHeader, rows)
    expect(decoded.events[0]).toStrictEqual(feedback(0))
    expect(decoded.events[5]?.sourceEventSeqs).toStrictEqual([0, 1, 2, 4])
    const descending = decodeV2(minimalPhysicalHeader, [
      feedback(0), feedback(1), { ...userMessage(2), sourceEventSeqs: [1, 0] },
    ])
    expect(descending.events[2]?.sourceEventSeqs).toStrictEqual([1, 0])
  })

  it.each([
    ['not an array', 'bad', /must be an array/],
    ['invalid scalar', [-1], /sourceEventSeqs member/],
    ['malformed range', [[0]], /must be a \[start, end\] pair/],
    ['invalid range start', [[-1, 0]], /range start/],
    ['invalid range end', [[0, -1]], /range end/],
    ['reversed range', [[2, 1]], /range exceeds/],
    ['range ending at the event', [[0, 4]], /range exceeds/],
    ['ranges with too many expanded members', [0, 1, 2, [0, 1]], /range exceeds/],
    ['scalar at the event', [4], /unique earlier/],
    ['duplicate scalars', [0, 0], /unique earlier/],
    ['overlapping range and scalar', [[0, 1], 1], /unique earlier/],
    ['non-monotonic range', [3, [0, 2]], /strictly increasing/],
  ])('refuses malformed stored provenance: %s', (_name, sourceEventSeqs, message) => {
    const rows = [feedback(0), feedback(1), feedback(2), feedback(3), {
      ...userMessage(4), sourceEventSeqs,
    }]
    expect(() => decodeV2(minimalPhysicalHeader, rows)).toThrow(message)
  })

  it('contains ordinary and non-SessionFormatError row failures in a recoverable tail', () => {
    const explosive = new Proxy(feedback(1), { ownKeys: () => { throw new Error('proxy failure') } })
    const primitiveFailure = new Proxy(feedback(1), {
      ownKeys: () => throwUnknown('primitive proxy failure'),
    })
    expect(decodeV2(
      minimalPhysicalHeader,
      [feedback(0), explosive],
      'recoverable',
    ).events).toStrictEqual([feedback(0)])
    expect(decodeV2(
      minimalPhysicalHeader,
      [feedback(0), null],
      'recoverable',
    ).events).toStrictEqual([feedback(0)])
    expect(decodeV2(
      minimalPhysicalHeader,
      [feedback(0), primitiveFailure],
      'recoverable',
    ).events).toStrictEqual([feedback(0)])
    expect(decodeV2(
      minimalPhysicalHeader,
      [null, [], feedback(0)],
      'recoverable',
    ).events).toStrictEqual([])
  })

  it('refuses malformed strict rows, strict gaps, and terminal recoverable tails', () => {
    expect(() => decodeV2(minimalPhysicalHeader, [null]))
      .toThrow(/row 0/)
    expect(() => decodeV2(minimalPhysicalHeader, [feedback(1)]))
      .toThrow(/seq gap/)
    expect(() => decodeV2(minimalPhysicalHeader, [{
      type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } },
    }], 'recoverable')).toThrow(/seq gap/)
    expect(() => decodeV2(minimalPhysicalHeader, [null, {
      type: 'turn/end', seq: 0, time: 1, data: { turn: 1, reason: { kind: 'completed' } },
    }], 'recoverable')).toThrow(/row 0/)
    expect(() => decodeV2(minimalPhysicalHeader, [{ ...feedback(0), extra: true }]))
      .toThrow(/unexpected field extra/)
    expect(() => decodeV2(minimalPhysicalHeader, [{ type: 'feedback/record', seq: 0, time: 1 }]))
      .toThrow(/lacks required field data/)
    expect(() => decodeV2(minimalPhysicalHeader, [{ ...feedback(0), type: 1 }]))
      .toThrow(/type must be a string/)
    expect(() => decodeV2(minimalPhysicalHeader, [{ ...feedback(0), ignorable: false }]))
      .toThrow(/ignorable must be true/)
  })

  it('keeps the prefix before a recoverable non-terminal seq gap', () => {
    expect(decodeV2(minimalPhysicalHeader, [
      feedback(0), feedback(3), feedback(1),
    ], 'recoverable').events).toStrictEqual([feedback(0)])
  })

  it('derives the last tagged seed marker and rejects lineage disagreements', () => {
    const seededHeader = { ...minimalPhysicalHeader, id: 'seeded', isSeeded: true }
    const markers = [
      { type: 'session/end-seed', seq: 0, time: 1, data: { inherited: true } },
      { type: 'session/end-seed', seq: 1, time: 2, data: {} },
      { type: 'session/end-seed', seq: 2, time: 3, data: { inherited: true } },
    ]
    expect(decodeV2(seededHeader, markers).inheritedEventCount).toBe(2)
    expect(decodeV2(seededHeader, [markers[0]]).inheritedEventCount).toBe(0)
    expect(() => decodeV2(seededHeader, []))
      .toThrow(/lacks an inherited end-seed marker/)
    expect(() => decodeV2(minimalPhysicalHeader, [markers[0]]))
      .toThrow(/unseeded Session contains an inherited end-seed marker/)
    expect(() => decodeV2(seededHeader, [{
      type: 'session/end-seed', seq: 0, time: 1, data: null,
    }])).toThrow(/must be an object/)
  })
})
