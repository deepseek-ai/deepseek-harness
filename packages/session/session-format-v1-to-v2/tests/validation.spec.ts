import { describe, expect, it } from 'vitest'
import type {
  SessionFormatArtifact,
  SessionFormatEvent,
  SessionFormatHeader,
  SessionFormatJsonObject,
  SessionFormatJsonValue,
} from '@deepseek-ai/dsh-session-format'
import {
  RELEASED_V2_EVENT_TYPES,
  assertReleasedV2Artifact,
  assertReleasedV2Header,
  restoreReleasedV2Artifact,
} from '@deepseek-ai/dsh-session-format-v1-to-v2'

const textBlock = { type: 'text', text: 'hello' } as const
const usage = { inputTokens: 3, outputTokens: 2 } as const
const replayState = { response: { id: 'response' }, blocks: ['text-meta'] } as const

function userData(id = 'user'): SessionFormatJsonObject {
  return {
    id,
    role: 'user',
    content: [textBlock],
    source: { kind: 'user' },
  }
}

function assistantData(
  options: {
    readonly content?: readonly SessionFormatJsonValue[]
    readonly stream?: SessionFormatJsonValue
    readonly usage?: SessionFormatJsonValue
    readonly replayState?: SessionFormatJsonValue
    readonly interrupted?: true
  } = {},
): SessionFormatJsonObject {
  const sourceReplay = options.replayState === undefined ? replayState : options.replayState
  return {
    turn: 1,
    step: 1,
    message: {
      id: 'assistant',
      role: 'assistant',
      content: options.content ?? [textBlock],
      source: {
        kind: 'model',
        provider: 'mock',
        model: 'mock',
        ...(sourceReplay === null ? {} : { replayState: sourceReplay }),
      },
    },
    stream: options.stream ?? [
      { type: 'text-chunks', time0: 3, index: 0, dt: [], texts: ['hello'] },
      { type: 'chunk', time: 4, chunk: { type: 'usage', usage } },
      { type: 'chunk', time: 5, chunk: { type: 'finish', reason: { kind: 'stop' }, replayState } },
    ],
    ...(options.usage === null ? {} : { usage: options.usage ?? usage }),
    ...(options.interrupted === undefined ? {} : { interrupted: options.interrupted }),
  }
}

function toolResultData(includeMeta: boolean): SessionFormatJsonObject {
  return {
    turn: 1,
    step: 1,
    message: {
      id: 'tool',
      role: 'user',
      content: [{
        type: 'tool-result', toolCallId: 'call', content: [textBlock], isError: false,
      }],
      source: { kind: 'tool', callId: 'call' },
    },
    ...(includeMeta ? { meta: { durable: true } } : {}),
  }
}

function event(
  type: string,
  seq: number,
  data: SessionFormatJsonValue,
  optional: Readonly<Record<string, SessionFormatJsonValue>> = {},
): SessionFormatEvent {
  return { type, seq, time: seq + 1, data, ...optional }
}

function artifact(
  events: readonly SessionFormatEvent[],
  overrides: Partial<SessionFormatArtifact> = {},
): SessionFormatArtifact {
  return {
    header: { version: 2, id: 'validation', createdAt: 1, isSeeded: false, delegationDepth: 0 },
    inheritedEventCount: 0,
    events,
    ...overrides,
  }
}

function assistantLifecycle(
  type: 'assistant/attempt' | 'assistant/message',
  data: SessionFormatJsonValue,
): SessionFormatArtifact {
  return artifact([
    event('turn/start', 0, { turn: 1 }),
    event('step/start', 1, { turn: 1, step: 1 }),
    event(type, 2, data, type === 'assistant/message' ? { surfaceOp: 'append' } : {}),
    event('step/end', 3, { turn: 1, step: 1 }),
    event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
  ])
}

describe('released v2 header validation', () => {
  const minimal = {
    version: 2, id: 'validation', createdAt: 1, isSeeded: false, delegationDepth: 0,
  } as const

  it('accepts minimal and complete logical headers', () => {
    expect(() => { assertReleasedV2Header(minimal) }).not.toThrow()
    expect(() => { assertReleasedV2Header({
      ...minimal,
      cwd: '/work',
      parentSession: 'parent',
      origin: 'subagent',
      agentPreset: 'default',
    }) }).not.toThrow()
  })

  it.each([
    ['null', null, /must be an object/],
    ['array', [], /must be an object/],
    ['scalar', 'header', /must be an object/],
    ['missing field', (({ id: _id, ...rest }) => rest)(minimal), /lacks required field id/],
    ['unexpected field', { ...minimal, extra: true }, /unexpected field extra/],
    ['wrong version', { ...minimal, version: 1 }, /expected format v2/],
    ['non-string id', { ...minimal, id: 1 }, /id must be a string/],
    ['invalid createdAt', { ...minimal, createdAt: -1 }, /createdAt/],
    ['invalid depth', { ...minimal, delegationDepth: -1 }, /delegationDepth/],
    ['invalid isSeeded', { ...minimal, isSeeded: 1 }, /isSeeded must be boolean/],
    ['non-string cwd', { ...minimal, cwd: 1 }, /cwd must be absolute/],
    ['relative cwd', { ...minimal, cwd: 'relative' }, /cwd must be absolute/],
    ['invalid parent', { ...minimal, parentSession: 1 }, /parentSession must be a string/],
    ['invalid preset', { ...minimal, agentPreset: 1 }, /agentPreset must be a string/],
    ['invalid origin', { ...minimal, origin: 'parent' }, /origin must be "subagent"/],
  ])('rejects exact logical header drift: %s', (_name, value, message) => {
    expect(() => { assertReleasedV2Header(value as SessionFormatHeader) }).toThrow(message)
  })
})

describe('released v2 event envelopes and payloads', () => {
  it('accepts empty artifacts and ordinary log events with a true ignorable marker', () => {
    expect(() => { assertReleasedV2Artifact(artifact([])) }).not.toThrow()
    expect(() => { assertReleasedV2Artifact(artifact([
      event('feedback/record', 0, { text: 'feedback' }, { ignorable: true }),
    ])) }).not.toThrow()
  })

  it('preserves the referenced Session generation across containing-log migration', () => {
    const containing = (capturedFormatVersion: number): SessionFormatArtifact => artifact([
      event('user/message', 0, {
        id: 'reference',
        role: 'user',
        content: [textBlock],
        source: {
          kind: 'session-reference',
          form: 'recall',
          version: 1,
          references: [{
            sessionId: 'source',
            label: 'Source',
            capturedFormatVersion,
            capturedThroughSeq: 0,
            compacted: false,
            originalMessages: 1,
            retainedMessages: 1,
            omittedMessages: 0,
            omittedBytes: 0,
            truncated: false,
            inputIndex: 0,
          }],
        },
      }, { surfaceOp: 'append' }),
    ])

    expect(() => { assertReleasedV2Artifact(containing(1)) }).not.toThrow()
    expect(() => { assertReleasedV2Artifact(containing(2)) }).not.toThrow()
    expect(() => { assertReleasedV2Artifact(containing(0)) }).toThrow(/capturedFormatVersion/)
    expect(() => { assertReleasedV2Artifact(containing(3)) }).toThrow(/capturedFormatVersion/)
  })

  it.each([
    ['inherited count beyond events', artifact([], { inheritedEventCount: 1 }), /exceeds its events/],
    ['unseeded inherited count', artifact([event('feedback/record', 0, { text: 'x' })], { inheritedEventCount: 1 }), /unseeded.*inherited events/],
    ['non-object event', artifact([null as unknown as SessionFormatEvent]), /event 0 must be an object/],
    ['non-string type', artifact([{ type: 1, seq: 0, time: 1, data: {} } as unknown as SessionFormatEvent]), /type must be a string/],
    ['unknown type', artifact([event('external/unknown', 0, {}, { ignorable: true })]), /unknown event type.*external\/unknown/],
    ['missing envelope field', artifact([{ type: 'feedback/record', seq: 0, time: 1 } as SessionFormatEvent]), /lacks required field data/],
    ['extra log field', artifact([event('feedback/record', 0, { text: 'x' }, { surfaceOp: 'append' })]), /unexpected field surfaceOp/],
    ['extra surface field', artifact([event('user/message', 0, userData(), { surfaceOp: 'append', extra: true })]), /unexpected field extra/],
    ['non-dense seq', artifact([event('feedback/record', 1, { text: 'x' })]), /not dense/],
    ['unsafe time', artifact([{ ...event('feedback/record', 0, { text: 'x' }), time: 0.5 }]), /time/],
    ['false ignorable marker', artifact([event('feedback/record', 0, { text: 'x' }, { ignorable: false })]), /ignorable must be true/],
    ['non-object payload', artifact([event('feedback/record', 0, null)]), /data must be an object/],
    ['missing payload member', artifact([event('feedback/record', 0, {})]), /lacks required field text/],
    ['extra payload member', artifact([event('feedback/record', 0, { text: 'x', extra: true })]), /unexpected field extra/],
    ['invalid payload semantics', artifact([event('feedback/record', 0, { text: '' })]), /non-empty string/],
  ])('rejects exact event or payload drift: %s', (_name, value, message) => {
    expect(() => { assertReleasedV2Artifact(value) }).toThrow(message)
  })

  it('validates present and absent opaque payload members before relationship checks', () => {
    for (const includeMeta of [false, true]) {
      const value = artifact([
        event('turn/start', 0, { turn: 1 }),
        event('step/start', 1, { turn: 1, step: 1 }),
        event('tool/result', 2, toolResultData(includeMeta), { surfaceOp: 'append' }),
      ])
      expect(() => { assertReleasedV2Artifact(value) }).toThrow(/no advertised tool lifecycle/)
    }
    const invalidOpaque = {
      ...toolResultData(true),
      meta: { callback: undefined as unknown as SessionFormatJsonValue },
    }
    expect(() => { assertReleasedV2Artifact(artifact([
      event('turn/start', 0, { turn: 1 }),
      event('step/start', 1, { turn: 1, step: 1 }),
      event('tool/result', 2, invalidOpaque, { surfaceOp: 'append' }),
    ])) }).toThrow()
  })
})

describe('released v2 Assistant streams', () => {
  it('accepts successful, interrupted, legacy-empty, and failed-attempt streams', () => {
    expect(() => { assertReleasedV2Artifact(assistantLifecycle('assistant/message', assistantData())) }).not.toThrow()
    expect(() => { assertReleasedV2Artifact(assistantLifecycle(
      'assistant/message', assistantData({ interrupted: true }),
    )) }).not.toThrow()
    expect(() => { assertReleasedV2Artifact(assistantLifecycle('assistant/message', assistantData({
      content: [], stream: [], usage: null, replayState: null,
    }))) }).not.toThrow()
    expect(() => { assertReleasedV2Artifact(assistantLifecycle('assistant/attempt', {
      turn: 1,
      step: 1,
      stream: [{ type: 'text-chunks', time0: 3, index: 0, dt: [1], texts: ['a', 'b'] }],
    })) }).not.toThrow()
  })

  it.each([
    ['non-array stream', assistantLifecycle('assistant/attempt', { turn: 1, step: 1, stream: null }), /invalid embedded stream/],
    ['invalid compact record', assistantLifecycle('assistant/attempt', {
      turn: 1, step: 1, stream: [{ type: 'future' }],
    }), /invalid embedded stream/],
    ['invalid embedded chunk semantics', assistantLifecycle('assistant/attempt', {
      turn: 1,
      step: 1,
      stream: [{ type: 'chunk', time: 3, chunk: { type: 'future' } }],
    }), /invalid embedded stream/],
    ['invalid turn coordinate', assistantLifecycle('assistant/attempt', { turn: -1, step: 1, stream: [] }), /turn/],
    ['invalid step coordinate', assistantLifecycle('assistant/attempt', { turn: 1, step: -1, stream: [] }), /step/],
    ['content disagreement', assistantLifecycle('assistant/message', assistantData({
      content: [{ type: 'text', text: 'different' }],
    })), /content disagrees/],
    ['usage disagreement', assistantLifecycle('assistant/message', assistantData({
      usage: { inputTokens: 9, outputTokens: 2 },
    })), /usage disagrees/],
    ['replay disagreement', assistantLifecycle('assistant/message', assistantData({
      replayState: { response: { id: 'different' }, blocks: ['text-meta'] },
    })), /replay state disagrees/],
  ])('rejects an invalid embedded stream or projection: %s', (_name, value, message) => {
    expect(() => { assertReleasedV2Artifact(value) }).toThrow(message)
  })
})

describe('released v2 seed and surface relationships', () => {
  it('accepts tagged seeded lineage and an ordinary unseeded marker', () => {
    expect(() => { assertReleasedV2Artifact(artifact([
      event('session/end-seed', 0, { inherited: true }),
    ], {
      header: { version: 2, id: 'seeded', createdAt: 1, isSeeded: true, delegationDepth: 0 },
      inheritedEventCount: 0,
    })) }).not.toThrow()
    expect(() => { assertReleasedV2Artifact(artifact([
      event('session/end-seed', 0, {}),
    ])) }).not.toThrow()
  })

  it.each([
    ['seeded marker cut mismatch', artifact([event('session/end-seed', 0, { inherited: true })], {
      header: { version: 2, id: 'seeded', createdAt: 1, isSeeded: true, delegationDepth: 0 },
      inheritedEventCount: 1,
    }), /seeded header disagrees/],
    ['seeded header without marker', artifact([], {
      header: { version: 2, id: 'seeded', createdAt: 1, isSeeded: true, delegationDepth: 0 },
    }), /seeded header disagrees/],
    ['unseeded tagged marker', artifact([event('session/end-seed', 0, { inherited: true })]), /unseeded.*inherited end-seed/],
    ['invalid inherited tag', artifact([event('session/end-seed', 0, { inherited: false })]), /inherited must be true/],
  ])('rejects seed lineage disagreement: %s', (_name, value, message) => {
    expect(() => { assertReleasedV2Artifact(value) }).toThrow(message)
  })

  it('accepts append and exact replacement surface operations', () => {
    expect(() => { assertReleasedV2Artifact(artifact([
      event('user/message', 0, userData('one'), { surfaceOp: 'append' }),
    ])) }).not.toThrow()
    expect(() => { assertReleasedV2Artifact(artifact([
      event('user/message', 0, userData('one'), { surfaceOp: 'append' }),
      event('user/message', 1, userData('two'), {
        surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0],
      }),
    ])) }).not.toThrow()
  })

  it.each([
    ['assistant chunk provenance', artifact([
      event('user/message', 0, userData(), { surfaceOp: 'append' }),
      event('assistant/message', 1, assistantData({ content: [], stream: [], usage: null, replayState: null }), {
        surfaceOp: 'append', sourceEventSeqs: [0],
      }),
    ]), /obsolete chunk provenance/],
    ['non-array provenance', artifact([
      event('feedback/record', 0, { text: 'x' }),
      event('user/message', 1, userData(), { surfaceOp: 'append', sourceEventSeqs: 0 }),
    ]), /must be an array/],
    ['invalid provenance member', artifact([
      event('feedback/record', 0, { text: 'x' }),
      event('user/message', 1, userData(), { surfaceOp: 'append', sourceEventSeqs: [-1] }),
    ]), /sourceEventSeqs member/],
    ['current provenance member', artifact([
      event('feedback/record', 0, { text: 'x' }),
      event('user/message', 1, userData(), { surfaceOp: 'append', sourceEventSeqs: [1] }),
    ]), /unique earlier seqs/],
    ['duplicate provenance member', artifact([
      event('feedback/record', 0, { text: 'x' }),
      event('feedback/record', 1, { text: 'y' }),
      event('user/message', 2, userData(), { surfaceOp: 'append', sourceEventSeqs: [0, 0] }),
    ]), /unique earlier seqs/],
    ['empty provenance', artifact([
      event('feedback/record', 0, { text: 'x' }),
      event('user/message', 1, userData(), { surfaceOp: 'append', sourceEventSeqs: [] }),
    ]), /must be non-empty/],
    ['missing operation', artifact([event('user/message', 0, userData())]), /requires a surfaceOp/],
    ['non-object replacement', artifact([
      event('feedback/record', 0, { text: 'x' }),
      event('user/message', 1, userData(), { surfaceOp: true }),
    ]), /surfaceOp must be a JSON object/],
    ['missing replacement member', artifact([
      event('feedback/record', 0, { text: 'x' }),
      event('user/message', 1, userData(), { surfaceOp: { op: 'replace', start: 0 } }),
    ]), /lacks required member "end"/],
    ['extra replacement member', artifact([
      event('feedback/record', 0, { text: 'x' }),
      event('user/message', 1, userData(), { surfaceOp: { op: 'replace', start: 0, end: 0, extra: true } }),
    ]), /unexpected member "extra"/],
    ['wrong replacement op', artifact([
      event('feedback/record', 0, { text: 'x' }),
      event('user/message', 1, userData(), { surfaceOp: { op: 'append', start: 0, end: 0 } }),
    ]), /surfaceOp must replace/],
    ['invalid replacement start', artifact([
      event('feedback/record', 0, { text: 'x' }),
      event('user/message', 1, userData(), { surfaceOp: { op: 'replace', start: -1, end: 0 } }),
    ]), /surface start/],
    ['invalid replacement end', artifact([
      event('feedback/record', 0, { text: 'x' }),
      event('user/message', 1, userData(), { surfaceOp: { op: 'replace', start: 0, end: -1 } }),
    ]), /surface end/],
    ['reversed replacement', artifact([
      event('feedback/record', 0, { text: 'x' }),
      event('user/message', 1, userData(), { surfaceOp: { op: 'replace', start: 1, end: 0 } }),
    ]), /invalid surface replacement/],
    ['replacement reaches current event', artifact([
      event('feedback/record', 0, { text: 'x' }),
      event('user/message', 1, userData(), { surfaceOp: { op: 'replace', start: 0, end: 1 } }),
    ]), /invalid surface replacement/],
    ['replacement misses current surface', artifact([
      event('feedback/record', 0, { text: 'x' }),
      event('user/message', 1, userData(), {
        surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0],
      }),
    ]), /range is not on the current surface/],
  ])('rejects invalid surface metadata or relationships: %s', (_name, value, message) => {
    expect(() => { assertReleasedV2Artifact(value) }).toThrow(message)
  })

  it('reports cross-event relationship errors after exact local validation', () => {
    expect(() => { assertReleasedV2Artifact(artifact([
      event('turn/end', 0, { turn: 1, reason: { kind: 'completed' } }),
    ])) }).toThrow(/no matching open turn/)
    expect(() => { assertReleasedV2Artifact(artifact([
      event('session-log-deepseek/delivery-accepted', 0, {
        sessionId: 'other', throughSeq: 0, sessionFormatVersion: 2,
      }),
    ])) }).toThrow(/throughSeq/)
  })
})

describe('released v2 restoration seam', () => {
  it('returns the same validated artifact and preserves safe vocabulary extensions', () => {
    const value = artifact([])
    expect(restoreReleasedV2Artifact(value, new Set(RELEASED_V2_EVENT_TYPES))).toBe(value)
    const ignorableExtension = artifact([
      event('external/ignorable', 0, { retained: true }, { ignorable: true }),
    ])
    expect(restoreReleasedV2Artifact(ignorableExtension, new Set(RELEASED_V2_EVENT_TYPES)))
      .toBe(ignorableExtension)
    const installedExtension = artifact([event('external/installed', 0, { retained: true })])
    expect(restoreReleasedV2Artifact(
      installedExtension,
      new Set([...RELEASED_V2_EVENT_TYPES, 'external/installed']),
    )).toBe(installedExtension)
    const extendedPayload = artifact([event('turn/start', 0, { turn: 1, postReleaseMember: true })])
    expect(restoreReleasedV2Artifact(extendedPayload, new Set(RELEASED_V2_EVENT_TYPES)))
      .toBe(extendedPayload)
    expect(() => restoreReleasedV2Artifact(
      artifact([event('external/unknown', 0, {})]),
      new Set(RELEASED_V2_EVENT_TYPES),
    )).toThrow(/unknown event type/)
  })
})
