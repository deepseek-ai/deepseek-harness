import { describe, expect, it } from 'vitest'
import { sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import type { SessionFormatArtifact, SessionFormatEvent } from '@deepseek-ai/dsh-session-format'

const message = {
  id: 'assistant-1',
  role: 'assistant',
  content: [{ type: 'text', text: 'hello' }],
  source: { kind: 'model', provider: 'mock', model: 'mock' },
} as const

const userMessage = {
  id: 'user-1',
  role: 'user',
  content: [{ type: 'text', text: 'question' }],
  source: { kind: 'user' },
} as const

function event(type: string, seq: number, time: number, data: SessionFormatEvent['data']): SessionFormatEvent {
  return { type, seq, time, data }
}

describe('sessionFormatV1ToV2', () => {
  it('migrates one exact released-v1 header without reading events', () => {
    const header = {
      version: 1,
      id: 'header-only',
      createdAt: 1,
      isSeeded: false,
      delegationDepth: 0,
    }
    expect(sessionFormatV1ToV2.migrateHeader(header)).toStrictEqual({ ...header, version: 2 })
    expect(() => sessionFormatV1ToV2.migrateHeader({ ...header, version: 0 })).toThrow(/v1 header/)
  })

  it('embeds an interleaved successful stream and densely remaps survivors', () => {
    const source: SessionFormatArtifact = {
      header: {
        version: 1,
        id: 'v1-success',
        createdAt: 1,
        isSeeded: false,
        delegationDepth: 0,
      },
      inheritedEventCount: 0,
      events: [
        event('turn/start', 0, 100, { turn: 1 }),
        event('step/start', 1, 101, { turn: 1, step: 1 }),
        event('assistant/chunk', 2, 110, {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'hello' },
        }),
        event('feedback/record', 3, 111, { text: 'interleaved' }),
        event('assistant/chunk', 4, 120, {
          turn: 1,
          step: 1,
          chunk: { type: 'finish', reason: { kind: 'stop' } },
        }),
        {
          ...event('assistant/message', 5, 121, { turn: 1, step: 1, message }),
          sourceEventSeqs: [2, 4],
          surfaceOp: 'append',
        },
        event('step/end', 6, 122, { turn: 1, step: 1 }),
        event('turn/end', 7, 123, { turn: 1, reason: { kind: 'completed' } }),
        event('command/run', 8, 124, { commandId: 'command-1', name: 'inspect', source: { kind: 'user' } }),
        event('command/done', 9, 125, {
          commandId: 'command-1',
          kind: 'success',
          sourceEventSeq: 5,
        }),
      ],
    }

    expect(sessionFormatV1ToV2.migrate(source)).toStrictEqual({
      header: { ...source.header, version: 2 },
      inheritedEventCount: 0,
      events: [
        event('turn/start', 0, 100, { turn: 1 }),
        event('step/start', 1, 101, { turn: 1, step: 1 }),
        event('feedback/record', 2, 111, { text: 'interleaved' }),
        {
          ...event('assistant/message', 3, 121, {
            turn: 1,
            step: 1,
            message,
            stream: [
              { type: 'text-chunks', time0: 110, index: 0, dt: [], texts: ['hello'] },
              { type: 'chunk', time: 120, chunk: { type: 'finish', reason: { kind: 'stop' } } },
            ],
          }),
          surfaceOp: 'append',
        },
        event('step/end', 4, 122, { turn: 1, step: 1 }),
        event('turn/end', 5, 123, { turn: 1, reason: { kind: 'completed' } }),
        event('command/run', 6, 124, { commandId: 'command-1', name: 'inspect', source: { kind: 'user' } }),
        event('command/done', 7, 125, {
          commandId: 'command-1',
          kind: 'success',
          sourceEventSeq: 3,
        }),
      ],
    })
  })

  it('retains a failed no-output attempt without fabricating a surface message', () => {
    const failure = { message: 'provider failed', code: 'PROVIDER_ERROR' }
    const source: SessionFormatArtifact = {
      header: {
        version: 1,
        id: 'v1-failed',
        createdAt: 1,
        isSeeded: false,
        delegationDepth: 0,
      },
      inheritedEventCount: 0,
      events: [
        event('turn/start', 0, 100, { turn: 1 }),
        event('step/start', 1, 101, { turn: 1, step: 1 }),
        event('assistant/chunk', 2, 110, {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'partial' },
        }),
        event('assistant/chunk', 3, 120, {
          turn: 1,
          step: 1,
          chunk: { type: 'finish', reason: { kind: 'error', failure } },
        }),
        event('step/end', 4, 121, { turn: 1, step: 1 }),
        event('turn/end', 5, 122, { turn: 1, reason: { kind: 'error', error: failure } }),
      ],
    }

    expect(sessionFormatV1ToV2.migrate(source)).toStrictEqual({
      header: { ...source.header, version: 2 },
      inheritedEventCount: 0,
      events: [
        event('turn/start', 0, 100, { turn: 1 }),
        event('step/start', 1, 101, { turn: 1, step: 1 }),
        event('assistant/attempt', 2, 120, {
          turn: 1,
          step: 1,
          stream: [
            { type: 'text-chunks', time0: 110, index: 0, dt: [], texts: ['partial'] },
            { type: 'chunk', time: 120, chunk: { type: 'finish', reason: { kind: 'error', failure } } },
          ],
        }),
        event('step/end', 3, 121, { turn: 1, step: 1 }),
        event('turn/end', 4, 122, { turn: 1, reason: { kind: 'error', error: failure } }),
      ],
    })
  })

  it('separates an unterminated failed prefix from a retried attempt in the same step', () => {
    const source: SessionFormatArtifact = {
      header: {
        version: 1,
        id: 'v1-retry-prefix',
        createdAt: 1,
        isSeeded: false,
        delegationDepth: 0,
      },
      inheritedEventCount: 0,
      events: [
        event('turn/start', 0, 100, { turn: 1 }),
        event('step/start', 1, 101, { turn: 1, step: 1 }),
        event('request/header', 2, 102, {
          header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial',
        }),
        event('assistant/chunk', 3, 110, {
          turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'partial' },
        }),
        event('llm/retry', 4, 120, {
          retryId: 'retry-1',
          turn: 1,
          step: 1,
          provider: 'mock',
          mode: 'normal',
          policyKey: 'default',
          retry: 1,
          maxRetries: 1,
          delayMs: 0,
          failure: { code: 'SERVER', message: 'retry' },
        }),
        event('llm/retry-started', 5, 121, {
          retryId: 'retry-1', turn: 1, step: 1, retry: 1,
        }),
        event('assistant/chunk', 6, 130, {
          turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hello' },
        }),
        event('assistant/chunk', 7, 140, {
          turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } },
        }),
        {
          ...event('assistant/message', 8, 141, { turn: 1, step: 1, message }),
          sourceEventSeqs: [6, 7],
          surfaceOp: 'append',
        },
        event('step/end', 9, 142, { turn: 1, step: 1 }),
        event('turn/end', 10, 143, { turn: 1, reason: { kind: 'completed' } }),
      ],
    }

    const migrated = sessionFormatV1ToV2.migrate(source)
    expect(migrated.events.filter(event => event.type.startsWith('assistant/'))).toStrictEqual([
      event('assistant/attempt', 3, 110, {
        turn: 1,
        step: 1,
        stream: [{ type: 'text-chunks', time0: 110, index: 0, dt: [], texts: ['partial'] }],
      }),
      {
        ...event('assistant/message', 6, 141, {
          turn: 1,
          step: 1,
          message,
          stream: [
            { type: 'text-chunks', time0: 130, index: 0, dt: [], texts: ['hello'] },
            { type: 'chunk', time: 140, chunk: { type: 'finish', reason: { kind: 'stop' } } },
          ],
        }),
        surfaceOp: 'append',
      },
    ])
  })

  it('moves and tags the seeded child marker after collapsing an inherited attempt', () => {
    const source: SessionFormatArtifact = {
      header: {
        version: 1,
        id: 'v1-seeded',
        createdAt: 1,
        parentSession: 'parent',
        isSeeded: true,
        delegationDepth: 0,
      },
      inheritedEventCount: 7,
      events: [
        event('turn/start', 0, 100, { turn: 1 }),
        event('step/start', 1, 101, { turn: 1, step: 1 }),
        event('assistant/chunk', 2, 110, {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'hello' },
        }),
        event('assistant/chunk', 3, 120, {
          turn: 1,
          step: 1,
          chunk: { type: 'finish', reason: { kind: 'stop' } },
        }),
        {
          ...event('assistant/message', 4, 121, { turn: 1, step: 1, message }),
          sourceEventSeqs: [2, 3],
          surfaceOp: 'append',
        },
        event('step/end', 5, 122, { turn: 1, step: 1 }),
        event('turn/end', 6, 123, { turn: 1, reason: { kind: 'completed' } }),
        event('session/end-seed', 7, 124, {}),
      ],
    }

    const migrated = sessionFormatV1ToV2.migrate(source)
    expect(migrated.inheritedEventCount).toBe(5)
    expect(migrated.events[5]).toStrictEqual({
      type: 'session/end-seed',
      seq: 5,
      time: 124,
      data: { inherited: true },
    })
  })

  it('inserts the tagged marker for an explicitly empty inherited seed', () => {
    const source: SessionFormatArtifact = {
      header: {
        version: 1,
        id: 'v1-empty-seed',
        createdAt: 42,
        parentSession: 'parent',
        isSeeded: true,
        delegationDepth: 0,
      },
      inheritedEventCount: 0,
      events: [],
    }

    expect(sessionFormatV1ToV2.migrate(source)).toStrictEqual({
      header: { ...source.header, version: 2 },
      inheritedEventCount: 0,
      events: [{
        type: 'session/end-seed',
        seq: 0,
        time: 42,
        data: { inherited: true },
      }],
    })
  })

  it('inserts a tagged marker after a retained non-empty inherited prefix', () => {
    const source: SessionFormatArtifact = {
      header: {
        version: 1, id: 'v1-retained-seed', createdAt: 1, parentSession: 'parent',
        isSeeded: true, delegationDepth: 0,
      },
      inheritedEventCount: 1,
      events: [event('feedback/record', 0, 9, { text: 'inherited' })],
    }
    expect(sessionFormatV1ToV2.migrate(source)).toMatchObject({
      inheritedEventCount: 1,
      events: [
        { type: 'feedback/record', seq: 0 },
        { type: 'session/end-seed', seq: 1, time: 9, data: { inherited: true } },
      ],
    })
  })

  it('refuses a v1 message whose content disagrees with its cited stream', () => {
    const source: SessionFormatArtifact = {
      header: {
        version: 1,
        id: 'v1-disagreement',
        createdAt: 1,
        isSeeded: false,
        delegationDepth: 0,
      },
      inheritedEventCount: 0,
      events: [
        event('turn/start', 0, 100, { turn: 1 }),
        event('step/start', 1, 101, { turn: 1, step: 1 }),
        event('assistant/chunk', 2, 110, {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'actual' },
        }),
        event('assistant/chunk', 3, 120, {
          turn: 1,
          step: 1,
          chunk: { type: 'finish', reason: { kind: 'stop' } },
        }),
        {
          ...event('assistant/message', 4, 121, {
            turn: 1,
            step: 1,
            message: { ...message, content: [{ type: 'text', text: 'different' }] },
          }),
          sourceEventSeqs: [2, 3],
          surfaceOp: 'append',
        },
        event('step/end', 5, 122, { turn: 1, step: 1 }),
        event('turn/end', 6, 123, { turn: 1, reason: { kind: 'completed' } }),
      ],
    }

    expect(() => sessionFormatV1ToV2.migrate(source)).toThrow(/message content disagrees with its embedded stream/)
  })

  it('refuses an undeclared reference into the last consumed chunk of a failed attempt', () => {
    const source: SessionFormatArtifact = {
      header: {
        version: 1,
        id: 'v1-consumed-reference',
        createdAt: 1,
        isSeeded: false,
        delegationDepth: 0,
      },
      inheritedEventCount: 0,
      events: [
        event('turn/start', 0, 100, { turn: 1 }),
        event('step/start', 1, 101, { turn: 1, step: 1 }),
        event('assistant/chunk', 2, 110, {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'partial' },
        }),
        event('assistant/chunk', 3, 120, {
          turn: 1,
          step: 1,
          chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: 'failed' } } },
        }),
        event('step/end', 4, 121, { turn: 1, step: 1 }),
        event('turn/end', 5, 122, {
          turn: 1,
          reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'failed' } },
        }),
        event('command/run', 6, 123, {
          commandId: 'command-1', name: 'inspect', source: { kind: 'user' },
        }),
        event('command/done', 7, 124, {
          commandId: 'command-1', kind: 'success', sourceEventSeq: 3,
        }),
      ],
    }

    expect(() => sessionFormatV1ToV2.migrate(source)).toThrow(
      /command\/done 7 sourceEventSeq targets consumed assistant\/chunk 3/,
    )
  })

  it('refuses an undeclared v1 event even when its envelope says ignorable', () => {
    const source: SessionFormatArtifact = {
      header: {
        version: 1,
        id: 'v1-unknown',
        createdAt: 1,
        isSeeded: false,
        delegationDepth: 0,
      },
      inheritedEventCount: 0,
      events: [{
        ...event('external/info', 0, 100, { text: 'unknown' }),
        ignorable: true,
      }],
    }

    expect(() => sessionFormatV1ToV2.migrate(source)).toThrow(
      /format v1 contains unknown event type "external\/info" at seq 0/,
    )
  })

  it.each([undefined, []] as const)(
    'retains a legacy message with provenance %s as an empty embedded stream',
    (sourceEventSeqs) => {
      const source: SessionFormatArtifact = {
        header: {
          version: 1, id: `v1-legacy-${String(sourceEventSeqs)}`, createdAt: 1,
          isSeeded: false, delegationDepth: 0,
        },
        inheritedEventCount: 0,
        events: [
          event('turn/start', 0, 1, { turn: 1 }),
          event('step/start', 1, 2, { turn: 1, step: 1 }),
          {
            ...event('assistant/message', 2, 3, { turn: 1, step: 1, message }),
            ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs: [...sourceEventSeqs] }),
            surfaceOp: 'append',
          },
          event('step/end', 3, 4, { turn: 1, step: 1 }),
          event('turn/end', 4, 5, { turn: 1, reason: { kind: 'completed' } }),
        ],
      }
      const migrated = sessionFormatV1ToV2.migrate(source)
      expect(migrated.events[2]).toMatchObject({
        type: 'assistant/message', data: { stream: [] }, surfaceOp: 'append',
      })
    },
  )

  it('refuses missing, partial, or reordered provenance for a present v1 attempt', () => {
    const build = (sourceEventSeqs: readonly number[] | undefined): SessionFormatArtifact => ({
      header: {
        version: 1, id: `v1-provenance-${String(sourceEventSeqs)}`, createdAt: 1,
        isSeeded: false, delegationDepth: 0,
      },
      inheritedEventCount: 0,
      events: [
        event('turn/start', 0, 1, { turn: 1 }),
        event('step/start', 1, 2, { turn: 1, step: 1 }),
        event('assistant/chunk', 2, 3, {
          turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hello' },
        }),
        event('assistant/chunk', 3, 4, {
          turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } },
        }),
        {
          ...event('assistant/message', 4, 5, { turn: 1, step: 1, message }),
          ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs: [...sourceEventSeqs] }),
          surfaceOp: 'append',
        },
        event('step/end', 5, 6, { turn: 1, step: 1 }),
        event('turn/end', 6, 7, { turn: 1, reason: { kind: 'completed' } }),
      ],
    })
    expect(() => sessionFormatV1ToV2.migrate(build(undefined))).toThrow(/does not cite/)
    expect(() => sessionFormatV1ToV2.migrate(build([2]))).toThrow(/complete ordered attempt/)
    expect(() => sessionFormatV1ToV2.migrate(build([3, 2]))).toThrow(/complete ordered attempt/)
  })

  it('refuses a lineage cut between members of one interleaved stream', () => {
    const source: SessionFormatArtifact = {
      header: {
        version: 1, id: 'v1-split-cut', createdAt: 1, parentSession: 'parent',
        isSeeded: true, delegationDepth: 0,
      },
      inheritedEventCount: 3,
      events: [
        event('turn/start', 0, 1, { turn: 1 }),
        event('step/start', 1, 2, { turn: 1, step: 1 }),
        event('assistant/chunk', 2, 3, {
          turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hello' },
        }),
        event('session/end-seed', 3, 4, {}),
        event('assistant/chunk', 4, 5, {
          turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } },
        }),
        {
          ...event('assistant/message', 5, 6, { turn: 1, step: 1, message }),
          sourceEventSeqs: [2, 4],
          surfaceOp: 'append',
        },
        event('step/end', 6, 7, { turn: 1, step: 1 }),
        event('turn/end', 7, 8, { turn: 1, reason: { kind: 'completed' } }),
      ],
    }
    expect(() => sessionFormatV1ToV2.migrate(source)).toThrow(/cut 3 splits one Assistant attempt/)
  })

  it('refuses a lineage cut between a complete stream and its committed message', () => {
    const source: SessionFormatArtifact = {
      header: {
        version: 1, id: 'v1-message-split-cut', createdAt: 1, parentSession: 'parent',
        isSeeded: true, delegationDepth: 0,
      },
      inheritedEventCount: 4,
      events: [
        event('turn/start', 0, 1, { turn: 1 }),
        event('step/start', 1, 2, { turn: 1, step: 1 }),
        event('assistant/chunk', 2, 3, {
          turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hello' },
        }),
        event('assistant/chunk', 3, 4, {
          turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } },
        }),
        event('session/end-seed', 4, 5, {}),
        {
          ...event('assistant/message', 5, 6, { turn: 1, step: 1, message }),
          sourceEventSeqs: [2, 3],
          surfaceOp: 'append',
        },
        event('step/end', 6, 7, { turn: 1, step: 1 }),
        event('turn/end', 7, 8, { turn: 1, reason: { kind: 'completed' } }),
      ],
    }
    expect(() => sessionFormatV1ToV2.migrate(source)).toThrow(/cut 4 splits one Assistant attempt/)
  })

  it('keeps referenced-session generation provenance frozen', () => {
    const reference = {
      ...userMessage,
      id: 'reference',
      source: {
        kind: 'session-reference',
        form: 'recall',
        version: 1,
        references: [{
          sessionId: 'source',
          label: 'Source',
          capturedFormatVersion: 1,
          capturedThroughSeq: 7,
          compacted: false,
          originalMessages: 1,
          retainedMessages: 1,
          omittedMessages: 0,
          omittedBytes: 0,
          truncated: false,
          inputIndex: 0,
        }],
      },
    }
    const source: SessionFormatArtifact = {
      header: {
        version: 1, id: 'v1-reference-generation', createdAt: 1,
        isSeeded: false, delegationDepth: 0,
      },
      inheritedEventCount: 0,
      events: [{ ...event('user/message', 0, 1, reference), surfaceOp: 'append' }],
    }

    const migrated = sessionFormatV1ToV2.migrate(source)
    expect(migrated.events[0]?.data).toStrictEqual(reference)
  })

  it('remaps surface, compaction, title, and optional command references explicitly', () => {
    const source: SessionFormatArtifact = {
      header: {
        version: 1, id: 'v1-reference-map', createdAt: 1,
        isSeeded: false, delegationDepth: 0,
      },
      inheritedEventCount: 0,
      events: [
        event('turn/start', 0, 1, { turn: 1 }),
        { ...event('user/message', 1, 2, userMessage), surfaceOp: 'append' },
        {
          ...event('user/message', 2, 3, {
            ...userMessage,
            id: 'checkpoint',
            source: { kind: 'plugin', plugin: 'test' },
          }),
          sourceEventSeqs: [1],
          surfaceOp: { op: 'replace', start: 1, end: 1 },
        },
        event('step/start', 3, 4, { turn: 1, step: 1 }),
        event('assistant/chunk', 4, 5, {
          turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hello' },
        }),
        event('assistant/chunk', 5, 6, {
          turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } },
        }),
        {
          ...event('assistant/message', 6, 7, { turn: 1, step: 1, message }),
          sourceEventSeqs: [4, 5], surfaceOp: 'append',
        },
        event('step/end', 7, 8, { turn: 1, step: 1 }),
        event('compaction/prune', 8, 9, {
          shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 1,
        }),
        event('session/title', 9, 10, {
          title: 'Question', messageSeqs: [1], source: { kind: 'fallback' },
        }),
        event('session/title-llm-request', 10, 11, {
          titleProvider: 'title-1', messageSeqs: [1], route: { provider: 'mock', model: 'mock' },
          system: 'title',
          messages: [{
            id: 'title-request',
            role: 'user',
            content: [{
              type: 'text',
              text: 'Generate the session title from this JSON array of human messages:\n'
                + JSON.stringify([{ seq: 1, text: 'question' }]),
            }],
            source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
          }],
          maxTokens: 20,
        }),
        event('command/run', 11, 12, {
          commandId: 'without-source', name: 'inspect', source: { kind: 'user' },
        }),
        event('command/done', 12, 13, { commandId: 'without-source', kind: 'success' }),
        event('command/run', 13, 14, {
          commandId: 'with-source', name: 'inspect', source: { kind: 'user' },
        }),
        event('command/done', 14, 15, {
          commandId: 'with-source', kind: 'success', sourceEventSeq: 8,
        }),
        event('turn/end', 15, 16, { turn: 1, reason: { kind: 'completed' } }),
      ],
    }
    const migrated = sessionFormatV1ToV2.migrate(source)
    expect(migrated.events.find(event => event.type === 'compaction/prune')?.data).toMatchObject({
      shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2],
    })
    expect(migrated.events.filter(event => event.type.startsWith('session/title')).map(event => event.data))
      .toEqual(expect.arrayContaining([expect.objectContaining({ messageSeqs: [1] })]))
    expect(migrated.events.filter(event => event.type === 'command/done').map(event => event.data))
      .toEqual([
        { commandId: 'without-source', kind: 'success' },
        { commandId: 'with-source', kind: 'success', sourceEventSeq: 6 },
      ])
    expect(migrated.events[2]).toMatchObject({
      sourceEventSeqs: [1], surfaceOp: { op: 'replace', start: 1, end: 1 },
    })
  })

  it('preserves source-sequence text in a title request while remapping its references', () => {
    const framed = 'Generate the session title from this JSON array of human messages:\n'
      + JSON.stringify([{ seq: 6, text: 'question' }])
    const source: SessionFormatArtifact = {
      header: {
        version: 1, id: 'v1-title-source-seq', createdAt: 1,
        isSeeded: false, delegationDepth: 0,
      },
      inheritedEventCount: 0,
      events: [
        event('turn/start', 0, 1, { turn: 1 }),
        event('step/start', 1, 2, { turn: 1, step: 1 }),
        event('assistant/chunk', 2, 3, {
          turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hello' },
        }),
        event('assistant/chunk', 3, 4, {
          turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } },
        }),
        {
          ...event('assistant/message', 4, 5, { turn: 1, step: 1, message }),
          sourceEventSeqs: [2, 3], surfaceOp: 'append',
        },
        event('step/end', 5, 6, { turn: 1, step: 1 }),
        { ...event('user/message', 6, 7, userMessage), surfaceOp: 'append' },
        event('session/title-llm-request', 7, 8, {
          titleProvider: 'title-1', messageSeqs: [6], route: { provider: 'mock', model: 'mock' },
          system: 'title',
          messages: [{
            id: 'title-request', role: 'user', content: [{ type: 'text', text: framed }],
            source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
          }],
          maxTokens: 20,
        }),
        event('turn/end', 8, 9, { turn: 1, reason: { kind: 'completed' } }),
      ],
    }

    const migrated = sessionFormatV1ToV2.migrate(source)
    const titleRequest = migrated.events.find(event => event.type === 'session/title-llm-request')

    expect(titleRequest?.data).toMatchObject({
      messageSeqs: [4],
      messages: [{ content: [{ text: framed }] }],
    })
  })

  it('remaps compaction summaries and closes prior-turn groups independently', () => {
    const source: SessionFormatArtifact = {
      header: {
        version: 1, id: 'v1-summary-map', createdAt: 1,
        isSeeded: false, delegationDepth: 0,
      },
      inheritedEventCount: 0,
      events: [
        event('turn/start', 0, 1, { turn: 1 }),
        { ...event('user/message', 1, 2, userMessage), surfaceOp: 'append' },
        event('compaction/start', 2, 3, { compactionId: 'c', turn: 1 }),
        event('compaction/summary', 3, 4, {
          compactionId: 'c', summary: [{ type: 'text', text: 'summary' }],
          shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 1,
          provider: 'mock', model: 'mock',
        }),
        {
          ...event('user/message', 4, 5, {
            ...userMessage,
            id: 'compact',
            source: { kind: 'plugin', plugin: 'compact', compactionId: 'c' },
          }),
          sourceEventSeqs: [1], surfaceOp: { op: 'replace', start: 1, end: 1 },
        },
        event('compaction/end', 5, 6, { compactionId: 'c', turn: 1 }),
        event('turn/end', 6, 7, { turn: 1, reason: { kind: 'completed' } }),
        event('turn/start', 7, 8, { turn: 2 }),
        event('step/start', 8, 9, { turn: 2, step: 1 }),
        event('step/end', 9, 10, { turn: 2, step: 1 }),
        event('turn/end', 10, 11, { turn: 2, reason: { kind: 'completed' } }),
      ],
    }
    expect(sessionFormatV1ToV2.migrate(source).events[3]?.data).toMatchObject({
      shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1],
    })
  })

  it('keeps attempt delimiters isolated across consecutive turns', () => {
    const failure = { code: 'UNKNOWN', message: 'failed' }
    const source: SessionFormatArtifact = {
      header: {
        version: 1, id: 'v1-two-turn-attempts', createdAt: 1,
        isSeeded: false, delegationDepth: 0,
      },
      inheritedEventCount: 0,
      events: [
        event('turn/start', 0, 1, { turn: 1 }),
        event('step/start', 1, 2, { turn: 1, step: 1 }),
        event('assistant/chunk', 2, 3, {
          turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'error', failure } },
        }),
        event('step/end', 3, 4, { turn: 1, step: 1 }),
        event('turn/end', 4, 5, { turn: 1, reason: { kind: 'error', error: failure } }),
        event('turn/start', 5, 6, { turn: 2 }),
        event('step/start', 6, 7, { turn: 2, step: 1 }),
        event('assistant/chunk', 7, 8, {
          turn: 2, step: 1, chunk: { type: 'finish', reason: { kind: 'error', failure } },
        }),
        event('step/end', 8, 9, { turn: 2, step: 1 }),
        event('turn/end', 9, 10, { turn: 2, reason: { kind: 'error', error: failure } }),
      ],
    }
    expect(sessionFormatV1ToV2.migrate(source).events.filter(event => event.type === 'assistant/attempt'))
      .toHaveLength(2)
  })
})
