import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatEvent,
  SessionFormatEventRun,
} from '@deepseek-ai/dsh-session-format'
import {
  RELEASED_V0_EVENT_TYPES,
  releasedV1SessionFormatCodec,
  restoreReleasedV1Artifact,
  sessionFormatV0ToV1,
} from '../src/index.ts'
import { restoreV0ToV1, restoreV1 } from '../src/testing/restore.ts'

function createMigrationStage(id: string) {
  const sourceHeader = { version: 0, id, createdAt: 1, isSeeded: false, delegationDepth: 0 }
  const stage = sessionFormatV0ToV1.createStage({
    sourceHeader,
    targetHeader: sessionFormatV0ToV1.migrateHeader(sourceHeader),
    sourceInheritedEventCount: 0,
    sourceKind: 'decoded',
  })
  return {
    transform(event: SessionFormatEvent): SessionFormatEvent[] {
      const context = new SessionFormatEventCollector()
      stage.transformEvent(event, context)
      return context.values
    },
  }
}

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
    const migrated = restoreV0ToV1(header, rows)

    expect(migrated).toEqual({
      header: {
        version: 1, id: 'identity', createdAt: 1, cwd: '/work', isSeeded: false, delegationDepth: 0,
      },
      inheritedEventCount: 0,
      events: [
        rows[0],
        rows[1],
        { type: 'assistant/chunk', seq: 2, time: 4, data: {
          turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' },
        } },
        { type: 'assistant/chunk', seq: 3, time: 5, data: {
          turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'b' },
        } },
        { type: 'assistant/chunk', seq: 4, time: 6, data: {
          turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'c' },
        } },
      ],
    })
  })

  it('expands an unrecognized compact run through the identity stage', () => {
    const sourceHeader = {
      version: 0, id: 'generic-run', createdAt: 1, isSeeded: false, delegationDepth: 0,
    } as const
    const stage = sessionFormatV0ToV1.createStage({
      sourceHeader,
      targetHeader: sessionFormatV0ToV1.migrateHeader(sourceHeader),
      sourceInheritedEventCount: 0,
      sourceKind: 'transformed',
    })
    const source = {
      type: 'feedback/record', seq: 0, time: 2, data: { text: 'retained' },
    } as const
    const run: SessionFormatEventRun = {
      runType: 'test-run', firstSeq: 0, eventCount: 1, *expand() { yield source },
    }
    const output = new SessionFormatEventCollector()

    stage.transformRun(run, output)

    expect(output.values).toEqual([source])
  })

  it('accepts an inherited delivery marker for its source generation', () => {
    const sourceHeader = {
      version: 0, id: 'child', createdAt: 1, parentSession: 'parent', isSeeded: true, delegationDepth: 0,
    } as const
    const stage = sessionFormatV0ToV1.createStage({
      sourceHeader,
      targetHeader: sessionFormatV0ToV1.migrateHeader(sourceHeader),
      sourceInheritedEventCount: 2,
      sourceKind: 'decoded',
    })
    const marker = {
      type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 2,
      data: { sessionId: 'parent', throughSeq: 0 },
    } as const
    const output = new SessionFormatEventCollector()

    stage.transformEvent(marker, output)

    expect(output.values).toEqual([marker])
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

    expect(restoreV0ToV1(header, [...prefix, badRow], 'recoverable'))
      .toEqual(restoreV0ToV1(header, prefix))
    expect(() => restoreV0ToV1(header, [
      ...prefix,
      badRow,
      { type: 'turn/end', seq: 2, time: 6, data: { turn: 2, reason: { kind: 'interrupted' } } },
    ], 'recoverable')).toThrow(/seq gap/)
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

    const migrated = restoreV0ToV1(header, rows)

    expect(() => restoreV0ToV1(incompleteHeader, rows)).toThrow(/delegationDepth/)
    expect(migrated.header.delegationDepth).toBe(0)
    expect(migrated.events[3]?.sourceEventSeqs).toEqual([0, 1, 2])
    expect(provenanceRow.sourceEventSeqs).toEqual([[0, 2]])
    expect(migrated.header).toEqual({
      version: 1, id: 'old', createdAt: 1, isSeeded: false, delegationDepth: 0,
    })
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

    expect(() => restoreV0ToV1(v0, [prefix, event])).toThrow(/unexpected member "sessionFormatVersion"/)
    expect(restoreV1(v1, [prefix, event]).events).toEqual([prefix, event])
  })

  it('does not synthesize over an explicitly invalid retry id', () => {
    const header = { type: 'session', version: 0, id: 'retry', createdAt: 1, delegationDepth: 0 }
    const rows = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'request/header', seq: 2, time: 3, data: {
        header: { config: { provider: 'p', model: 'm' } }, reason: 'initial',
      } },
      { type: 'llm/retry', seq: 3, time: 4, data: {
        retryId: null, turn: 1, step: 1, provider: 'p', mode: 'normal', policyKey: 'k',
        retry: 1, maxRetries: 1, delayMs: 0, failure: { message: 'retry', code: 'SERVER' },
      } },
    ]
    expect(() => restoreV0ToV1(header, rows)).toThrow(/retryId/)

    const transformer = createMigrationStage('retry')
    const retry = (seq: number, attempt: number) => ({
      type: 'llm/retry', seq, time: seq + 1,
      data: {
        turn: 1, step: 1, provider: 'p', mode: 'normal', policyKey: 'k', retry: attempt,
        maxRetries: 2, delayMs: 0, failure: { message: 'retry', code: 'SERVER' },
      },
    })
    expect(transformer.transform(retry(0, 1))[0]?.data).toMatchObject({ retryId: 'legacy-retry:retry:0' })
    expect(transformer.transform(retry(1, 2))[0]?.data).toMatchObject({ retryId: 'legacy-retry:retry:0' })
  })

  it('normalizes legacy compaction names and assigns one deterministic id to the group', () => {
    const transformer = createMigrationStage('compact')
    const rows = [
      { type: 'compaction/start', seq: 0, time: 1, data: { turn: null } },
      {
        type: 'compaction/summary', seq: 1, time: 2,
        data: {
          summary: [{ type: 'text', text: 'summary' }], shadowedRange: { start: 0, end: 0 },
          shadowedSeqs: [0], shadowedTokenCount: 0, provider: 'p', model: 'm',
        },
      },
      {
        type: 'compaction/prune', seq: 2, time: 3,
        data: { shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], shadowedTokenCount: 1 },
      },
      {
        type: 'user/message', seq: 3, time: 4,
        data: {
          id: 'checkpoint', role: 'user', content: [{ type: 'text', text: 'summary' }],
          source: { kind: 'plugin', plugin: 'compact' },
        },
        sourceEventSeqs: [0, 1], surfaceOp: { op: 'replace', start: 0, end: 0 },
      },
      { type: 'compaction/end', seq: 4, time: 5, data: { turn: null } },
    ]

    const migrated = rows.map(row => transformer.transform(row)[0])
    expect(migrated.map(event => event?.type === 'user/message'
      ? (event.data as { source: { compactionId: string } }).source.compactionId
      : (event?.data as { compactionId: string }).compactionId))
      .toEqual([
        'legacy-compaction:compact:0',
        'legacy-compaction:compact:0',
        undefined,
        'legacy-compaction:compact:0',
        'legacy-compaction:compact:0',
      ])

    const historical = rows.map(row => ({
      ...row,
      type: row.type.replace(/^compaction\//, 'compact/'),
    }))
    const historicalTransformer = createMigrationStage('compact')
    expect(historical.map(row => historicalTransformer.transform(row as SessionFormatEvent)[0])).toEqual(migrated)

    const reset = createMigrationStage('compact')
    expect(() => reset.transform({
      ...(rows[0] as SessionFormatEvent), data: { turn: null, compactionId: null },
    })).toThrow(/compactionId/)
    reset.transform(rows[0] as never)
    expect(reset.transform({ type: 'feedback/record', seq: 1, time: 2, data: { text: 'kept' } })[0]?.type)
      .toBe('feedback/record')
    reset.transform({ type: 'session/end-seed', seq: 2, time: 3, data: {} })
    expect(() => reset.transform({ ...(rows[1] as SessionFormatEvent), seq: 3 })).toThrow(/compactionId/)
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
    const migrated = restoreV0ToV1(physicalHeader, rows)
    expect(migrated).toEqual({
      header: {
        version: 1, id: 'full-identity', createdAt: 1, cwd: '/work', isSeeded: false, delegationDepth: 0,
      },
      inheritedEventCount: 0,
      events: rows,
    })
  })

  it('keeps the v1 physical codec vocabulary-neutral for current growth and a future source freeze', () => {
    const physicalHeader = {
      type: 'session', version: 1, id: 'ordinary-growth', createdAt: 1, delegationDepth: 0,
    }
    const ordinary = { type: 'ordinary/post-v1', seq: 0, time: 1, data: { required: true } }
    const decoder = releasedV1SessionFormatCodec.createDecoder(physicalHeader, 'strict')
    const events = new SessionFormatEventCollector()
    decoder.decodeRow(ordinary, events)
    const decoded = {
      header: decoder.header,
      inheritedEventCount: decoder.finish(events),
      events: events.values,
    }

    expect(decoded.events).toEqual([ordinary])
    expect(RELEASED_V0_EVENT_TYPES).not.toContain(ordinary.type)

    const generatedCurrentTypes = new Set([...RELEASED_V0_EVENT_TYPES, ordinary.type])
    expect(() => restoreReleasedV1Artifact(decoded, generatedCurrentTypes)).not.toThrow()

    const frozenFutureV1SourceTypes = new Set(generatedCurrentTypes)
    expect(() => restoreReleasedV1Artifact(decoded, frozenFutureV1SourceTypes)).not.toThrow()

    const extendedDecoder = releasedV1SessionFormatCodec.createDecoder(physicalHeader, 'strict')
    const extendedEvents = new SessionFormatEventCollector()
    extendedDecoder.decodeRow({
      type: 'turn/start', seq: 0, time: 1, data: { turn: 1, postReleaseMember: true },
    }, extendedEvents)
    const extendedKnownPayload = {
      header: extendedDecoder.header,
      inheritedEventCount: extendedDecoder.finish(extendedEvents),
      events: extendedEvents.values,
    }
    expect(extendedKnownPayload.events).toEqual([{
      type: 'turn/start', seq: 0, time: 1, data: { turn: 1, postReleaseMember: true },
    }])
    expect(() => restoreReleasedV1Artifact(extendedKnownPayload, generatedCurrentTypes)).not.toThrow()
  })
})
