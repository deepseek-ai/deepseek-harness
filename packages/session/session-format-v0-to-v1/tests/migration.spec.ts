import { describe, expect, it } from 'vitest'
import {
  RELEASED_V0_EVENT_TYPES,
  releasedV0SessionFormatCodec,
  releasedV1SessionFormatCodec,
  restoreReleasedV1Artifact,
  sessionFormatV0ToV1,
} from '../src/index.ts'

describe('released Session format v0 to v1', () => {
  it('changes only the version of a canonical decoded artifact', () => {
    const header = {
      type: 'session',
      version: 0,
      id: 'identity',
      createdAt: 1,
      cwd: '/work',
      delegationDepth: 0,
    }
    const rows = [
      { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 3, data: { turn: 1, step: 1 } },
      {
        type: 'text-chunks',
        seq0: 2,
        time0: 4,
        data: { turn: 1, step: 1, index: 0, dt: [1, 1], texts: ['a', 'b', 'c'] },
      },
    ]
    const source = releasedV0SessionFormatCodec.decodeArtifact(header, rows)

    const migrated = sessionFormatV0ToV1.migrate(source)

    expect(migrated).toEqual({
      ...source,
      header: { ...source.header, version: 1 },
    })
    sessionFormatV0ToV1.validateTarget(migrated)
    expect(releasedV1SessionFormatCodec.encodeArtifact(migrated, { packChunks: true })).toEqual({
      header: { ...header, version: 1 },
      rows,
    })
  })

  it('recovers only the complete row prefix and refuses a later committing turn end', () => {
    const header = {
      type: 'session',
      version: 0,
      id: 'recoverable',
      createdAt: 1,
      delegationDepth: 0,
    }
    const prefix = [
      { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const badRow = {
      type: 'text-chunks',
      seq0: 7,
      time0: 4,
      data: { turn: 2, step: 0, index: 0, dt: [1], texts: ['x', 'y'] },
    }

    expect(releasedV0SessionFormatCodec.decodeRecoverableArtifact(header, [...prefix, badRow]))
      .toEqual(releasedV0SessionFormatCodec.decodeArtifact(header, prefix))
    expect(() => releasedV0SessionFormatCodec.decodeRecoverableArtifact(header, [
      ...prefix,
      badRow,
      { type: 'turn/end', seq: 2, time: 6, data: { turn: 2, reason: { kind: 'interrupted' } } },
    ])).toThrow(/seq gap/)
  })

  it('requires canonical delegation depth and decodes provenance without mutating source rows', () => {
    const incompleteHeader = { type: 'session', version: 0, id: 'old', createdAt: 1 }
    const header = { ...incompleteHeader, delegationDepth: 0 }
    const provenanceRow = {
      type: 'assistant/message',
      seq: 3,
      time: 5,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'message',
          role: 'assistant',
          content: [],
          source: { kind: 'model', provider: 'test', model: 'test' },
        },
      },
      sourceEventSeqs: [[0, 2]],
      surfaceOp: 'append',
    }
    const rows = [
      { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 3, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/chunk', seq: 2, time: 4,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } },
      },
      provenanceRow,
    ]

    const decoded = releasedV0SessionFormatCodec.decodeArtifact(header, rows)

    expect(() => releasedV0SessionFormatCodec.decodeArtifact(incompleteHeader, rows)).toThrow(/delegationDepth/)
    expect(decoded.header.delegationDepth).toBe(0)
    expect(decoded.events[3]?.sourceEventSeqs).toEqual([0, 1, 2])
    expect(provenanceRow.sourceEventSeqs).toEqual([[0, 2]])
    const migrated = sessionFormatV0ToV1.migrate(decoded)
    expect(releasedV1SessionFormatCodec.encodeArtifact(migrated, { packChunks: false }).header)
      .toEqual({ ...header, version: 1 })
  })

  it('refuses v1-only generation fields in v0 and accepts them in v1', () => {
    const event = {
      type: 'session-log-deepseek/delivery-accepted',
      seq: 1,
      time: 2,
      data: { sessionId: 'delivery', throughSeq: 0, sessionFormatVersion: 1 },
    }
    const prefix = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }
    const v0 = { type: 'session', version: 0, id: 'delivery', createdAt: 1, delegationDepth: 0 }
    const v1 = { ...v0, version: 1 }

    expect(() => sessionFormatV0ToV1.migrate(
      releasedV0SessionFormatCodec.decodeArtifact(v0, [prefix, event]),
    )).toThrow(/unexpected member "sessionFormatVersion"/)
    expect(releasedV1SessionFormatCodec.decodeArtifact(v1, [prefix, event]).events).toEqual([prefix, event])
  })

  it('preserves a complete canonical multi-owner log except for header.version', () => {
    const physicalHeader = {
      type: 'session', version: 0, id: 'full-identity', createdAt: 1, cwd: '/work', delegationDepth: 0,
    }
    const human = {
      id: 'human', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
    }
    const rows = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: human, surfaceOp: 'append' },
      { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/chunk', seq: 3, time: 4,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hello' } },
      },
      {
        type: 'assistant/message', seq: 4, time: 5, sourceEventSeqs: [3], surfaceOp: 'append',
        data: {
          turn: 1, step: 1,
          message: {
            id: 'assistant', role: 'assistant', content: [
              { type: 'text', text: 'hello' },
              { type: 'tool-call', id: 'call', name: 'read', arguments: '{}' },
            ],
            source: { kind: 'model', provider: 'mock', model: 'mock' },
          },
        },
      },
      { type: 'tool/call', seq: 5, time: 6, data: { turn: 1, step: 1, callId: 'call', name: 'read', arguments: '{}' } },
      {
        type: 'tool/result', seq: 6, time: 7, sourceEventSeqs: [5], surfaceOp: 'append',
        data: {
          turn: 1, step: 1,
          message: {
            id: 'result', role: 'user',
            content: [{ type: 'tool-result', toolCallId: 'call', content: [{ type: 'text', text: 'ok' }], isError: false }],
            source: { kind: 'tool', callId: 'call' },
          },
          meta: { opaque: { seq: 999 } },
        },
      },
      {
        type: 'tool/code-dispatch-start', seq: 7, time: 8,
        data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'sub', name: 'read', arguments: { opaque: [1] } },
      },
      {
        type: 'tool/code-dispatch', seq: 8, time: 9,
        data: {
          rootCallId: 'root', parentCallId: 'root', subCallId: 'sub', name: 'read',
          arguments: { opaque: [1] }, isError: false, content: [],
        },
      },
      { type: 'step/end', seq: 9, time: 10, data: { turn: 1, step: 1 } },
      { type: 'session/title', seq: 10, time: 11, data: { title: 'Title', messageSeqs: [1], source: { kind: 'fallback' } } },
      { type: 'command/run', seq: 11, time: 12, data: { commandId: 'command', name: 'compact', source: { kind: 'user' } } },
      { type: 'feedback/record', seq: 12, time: 13, data: { text: 'feedback' } },
      { type: 'command/done', seq: 13, time: 14, data: { commandId: 'command', kind: 'success', sourceEventSeq: 12 } },
      { type: 'compaction/start', seq: 14, time: 15, data: { compactionId: 'compact', sourceCommandId: 'command', turn: 1 } },
      {
        type: 'compaction/summary', seq: 15, time: 16,
        data: {
          compactionId: 'compact', sourceCommandId: 'command', summary: [{ type: 'text', text: 'summary' }],
          shadowedRange: { start: 1, end: 6 }, shadowedSeqs: [1, 4, 6], shadowedTokenCount: 10,
          provider: 'mock', model: 'mock', rawOutput: [{ type: 'text', text: 'summary' }], llmStreamCall: true,
        },
      },
      {
        type: 'user/message', seq: 16, time: 17, sourceEventSeqs: [1, 4, 6],
        surfaceOp: { op: 'replace', start: 1, end: 6 },
        data: {
          id: 'checkpoint', role: 'user', content: [{ type: 'text', text: 'summary' }],
          source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact', sourceCommandId: 'command' },
        },
      },
      { type: 'compaction/end', seq: 17, time: 18, data: { compactionId: 'compact', sourceCommandId: 'command', turn: 1 } },
      {
        type: 'session-log-deepseek/delivery-accepted', seq: 18, time: 19,
        data: { sessionId: 'full-identity', throughSeq: 17 },
      },
      { type: 'turn/end', seq: 19, time: 20, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const source = releasedV0SessionFormatCodec.decodeArtifact(physicalHeader, rows)
    const migrated = sessionFormatV0ToV1.migrate(source)
    expect(migrated).toEqual({ ...source, header: { ...source.header, version: 1 } })
  })

  it('keeps the v1 physical codec vocabulary-neutral for current growth and a future source freeze', () => {
    const physicalHeader = {
      type: 'session', version: 1, id: 'ordinary-growth', createdAt: 1, delegationDepth: 0,
    }
    const ordinary = { type: 'ordinary/post-v1', seq: 0, time: 1, data: { required: true } }
    const decoded = releasedV1SessionFormatCodec.decodeArtifact(physicalHeader, [ordinary])

    expect(decoded.events).toEqual([ordinary])
    expect(() => { sessionFormatV0ToV1.validateTarget(decoded) }).toThrow(/unknown required event/)

    const generatedCurrentTypes = new Set([...RELEASED_V0_EVENT_TYPES, ordinary.type])
    expect(() => restoreReleasedV1Artifact(decoded, generatedCurrentTypes)).not.toThrow()

    const frozenFutureV1SourceTypes = new Set(generatedCurrentTypes)
    expect(() => restoreReleasedV1Artifact(decoded, frozenFutureV1SourceTypes)).not.toThrow()

    const extendedKnownPayload = releasedV1SessionFormatCodec.decodeArtifact(physicalHeader, [{
      type: 'turn/start', seq: 0, time: 1, data: { turn: 1, postReleaseMember: true },
    }])
    expect(() => { sessionFormatV0ToV1.validateTarget(extendedKnownPayload) }).toThrow(/unexpected member/)
    expect(() => restoreReleasedV1Artifact(extendedKnownPayload, generatedCurrentTypes)).not.toThrow()
  })
})
