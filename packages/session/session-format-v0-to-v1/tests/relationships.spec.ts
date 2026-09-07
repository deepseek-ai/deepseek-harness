import { describe, expect, it } from 'vitest'
import { SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import {
  assertReleasedArtifactRelationships,
} from '../src/index.ts'
import { restoreV0ToV1, restoreV1 } from '../src/testing/restore.ts'

const header = {
  type: 'session', version: 1, id: 'relationships', createdAt: 1, delegationDepth: 0,
} as const
const user = (id: string, source: object = { kind: 'user' }) => ({
  id, role: 'user', content: [{ type: 'text', text: id }], source,
})

function decode(rows: readonly unknown[], physicalHeader: unknown = header) {
  return restoreV1(physicalHeader, rows)
}

describe('released v1 whole-artifact relationships', () => {
  it.each([
    ['lone turn/end', [
      { type: 'turn/end', seq: 0, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ]],
    ['orphan retry-started', [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'llm/retry-started', seq: 2, time: 3, data: { retryId: 'retry', turn: 1, step: 1, retry: 1 } },
    ]],
    ['title citing a turn marker', [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'session/title', seq: 1, time: 2, data: { title: 'Bad', messageSeqs: [0], source: { kind: 'fallback' } } },
    ]],
    ['compaction/end without start', [
      { type: 'compaction/end', seq: 0, time: 1, data: { compactionId: 'c', turn: null } },
    ]],
    ['PTC dispatch outside a turn', [
      {
        type: 'tool/code-dispatch-start', seq: 0, time: 1,
        data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'sub', name: 'read', arguments: {} },
      },
    ]],
    ['surface replace without shadow provenance', [
      { type: 'user/message', seq: 0, time: 1, data: user('one'), surfaceOp: 'append' },
      {
        type: 'user/message', seq: 1, time: 2, data: user('two'),
        surfaceOp: { op: 'replace', start: 0, end: 0 },
      },
    ]],
    ['impossible session-reference statistics', [
      {
        type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
        data: user('reference', {
          kind: 'session-reference', form: 'recall', version: 1,
          references: [{
            sessionId: 'source', label: 'Source', capturedThroughSeq: null, compacted: false,
            originalMessages: 1, retainedMessages: 2, omittedMessages: 0, omittedBytes: 0,
            truncated: false, inputIndex: 0,
          }],
        }),
      },
    ]],
  ])('refuses %s', (_name, rows) => {
    expect(() => decode(rows)).toThrow()
  })

  it('refuses a relative restored cwd', () => {
    expect(() => decode([], { ...header, cwd: 'relative' })).toThrow(/cwd must be absolute/)
  })

  it('accepts complete core, retry, title, compaction, PTC, and replacement relationships', () => {
    const rows = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: user('one'), surfaceOp: 'append' },
      { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
      {
        type: 'request/header', seq: 3, time: 4,
        data: { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' },
      },
      {
        type: 'llm/retry', seq: 4, time: 5,
        data: {
          retryId: 'retry', turn: 1, step: 1, provider: 'mock', mode: 'normal', policyKey: 'default',
          retry: 1, maxRetries: 2, delayMs: 1, failure: { message: 'retry', code: 'SERVER' },
        },
      },
      { type: 'llm/retry-started', seq: 5, time: 6, data: { retryId: 'retry', turn: 1, step: 1, retry: 1 } },
      {
        type: 'tool/code-dispatch-start', seq: 6, time: 7,
        data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'sub', name: 'read', arguments: {} },
      },
      {
        type: 'tool/code-dispatch', seq: 7, time: 8,
        data: {
          rootCallId: 'root', parentCallId: 'root', subCallId: 'sub', name: 'read', arguments: {},
          isError: false, content: [],
        },
      },
      { type: 'step/end', seq: 8, time: 9, data: { turn: 1, step: 1 } },
      { type: 'session/title', seq: 9, time: 10, data: { title: 'Title', messageSeqs: [1], source: { kind: 'fallback' } } },
      { type: 'compaction/start', seq: 10, time: 11, data: { compactionId: 'c', turn: 1 } },
      { type: 'compaction/end', seq: 11, time: 12, data: { compactionId: 'c', turn: 1, error: 'skipped' } },
      {
        type: 'user/message', seq: 12, time: 13, data: user('replacement'), sourceEventSeqs: [1],
        surfaceOp: { op: 'replace', start: 1, end: 1 },
      },
      { type: 'turn/end', seq: 13, time: 14, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    expect(decode(rows).events).toEqual(rows)
  })

  it('accepts a compaction surface span whose sequence values descend', () => {
    const rows = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: user('zero'), surfaceOp: 'append' },
      { type: 'user/message', seq: 2, time: 3, data: user('one'), surfaceOp: 'append' },
      { type: 'user/message', seq: 3, time: 4, data: user('two'), surfaceOp: 'append' },
      {
        type: 'user/message', seq: 4, time: 5, data: user('prior checkpoint'),
        sourceEventSeqs: [1, 2], surfaceOp: { op: 'replace', start: 1, end: 2 },
      },
      { type: 'compaction/start', seq: 5, time: 6, data: { compactionId: 'c', turn: 1 } },
      {
        type: 'compaction/summary', seq: 6, time: 7,
        data: {
          compactionId: 'c', summary: [{ type: 'text', text: 'summary' }],
          shadowedRange: { start: 4, end: 3 }, shadowedSeqs: [4, 3], shadowedTokenCount: 2,
          provider: 'p', model: 'm',
        },
      },
      {
        type: 'user/message', seq: 7, time: 8,
        data: user('checkpoint', { kind: 'plugin', plugin: 'compact', compactionId: 'c' }),
        sourceEventSeqs: [5, 6, 4, 3], surfaceOp: { op: 'replace', start: 4, end: 3 },
      },
      { type: 'compaction/end', seq: 8, time: 9, data: { compactionId: 'c', turn: 1 } },
      { type: 'turn/end', seq: 9, time: 10, data: { turn: 1, reason: { kind: 'completed' } } },
    ]

    expect(decode(rows).events).toEqual(rows)
  })

  it('keeps the latest request provider across later steps and turns', () => {
    const rows = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      {
        type: 'request/header', seq: 2, time: 3,
        data: { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' },
      },
      { type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 5, time: 6, data: { turn: 2 } },
      { type: 'step/start', seq: 6, time: 7, data: { turn: 2, step: 1 } },
      {
        type: 'llm/retry', seq: 7, time: 8,
        data: {
          retryId: 'retry', turn: 2, step: 1, provider: 'mock', mode: 'normal', policyKey: 'default',
          retry: 1, maxRetries: 2, delayMs: 1, failure: { message: 'retry', code: 'SERVER' },
        },
      },
      { type: 'llm/retry-started', seq: 8, time: 9, data: { retryId: 'retry', turn: 2, step: 1, retry: 1 } },
      { type: 'step/end', seq: 9, time: 10, data: { turn: 2, step: 1 } },
      { type: 'turn/end', seq: 10, time: 11, data: { turn: 2, reason: { kind: 'completed' } } },
    ]

    expect(decode(rows).events).toEqual(rows)
  })

  it('preserves merge-extensible nested union variants and ignorable current events', () => {
    const rows = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'user/message', seq: 1, time: 2, surfaceOp: 'append',
        data: {
          id: 'plugin-message', role: 'user',
          content: [{ type: 'plugin/block', value: { nested: true } }],
          source: { kind: 'plugin/source', detail: 'opaque' },
        },
      },
      { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/chunk', seq: 3, time: 4,
        data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'plugin-finish', detail: 1 } } },
      },
      { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'plugin-turn', detail: 1 } } },
      { type: 'plugin/informational', seq: 6, time: 7, data: { value: 1 }, ignorable: true },
    ]
    expect(decode(rows).events).toEqual(rows)
    expect(() => decode([{ type: 'plugin/required', seq: 0, time: 1, data: {} }]))
      .toThrow(SessionFormatUnsupportedMigrationError)
    for (const data of ['value', [1], null]) {
      expect(decode([{ type: 'plugin/scalar', seq: 0, time: 1, data, ignorable: true }]).events[0]?.data)
        .toEqual(data)
    }
  })

  it('binds advertised, started, repaired, and resolved tool lifecycles', () => {
    const turnAndStep = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    ]
    const advertised = {
      type: 'assistant/message', seq: 2, time: 3, surfaceOp: 'append',
      data: {
        turn: 1, step: 1,
        message: {
          id: 'assistant-tools', role: 'assistant',
          content: [{ type: 'tool-call', id: 'a', name: 'read', arguments: '{}' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        },
      },
    }
    const started = {
      type: 'tool/call', seq: 3, time: 4,
      data: { turn: 1, step: 1, callId: 'a', name: 'read', arguments: '{}' },
    }
    const result = (seq: number, sourceId = 'a', blockId = 'a') => ({
      type: 'tool/result', seq, time: seq + 1, surfaceOp: 'append',
      data: {
        turn: 1, step: 1,
        message: {
          id: 'result', role: 'user',
          content: [{ type: 'tool-result', toolCallId: blockId, content: [], isError: false }],
          source: { kind: 'tool', callId: sourceId },
        },
      },
    })

    expect(() => decode([...turnAndStep, advertised, { ...started, data: { ...started.data, name: 'write' } }]))
      .toThrow(/advertised tool call/)
    expect(() => decode([...turnAndStep, { ...started, seq: 2, time: 3 }])).toThrow(/advertised tool call/)
    expect(() => decode([...turnAndStep, result(2)])).toThrow(/no advertised tool lifecycle/)
    expect(() => decode([...turnAndStep, {
      ...advertised,
      data: {
        ...advertised.data,
        message: {
          ...advertised.data.message,
          content: [
            ...advertised.data.message.content,
            { type: 'tool-call', id: 'a', name: 'read', arguments: '{}' },
          ],
        },
      },
    }])).toThrow(/repeats advertised tool call/)
    expect(() => decode([...turnAndStep, advertised, started, result(4, 'b')])).toThrow(/tool-result block|tool lifecycle/)
    expect(() => decode([...turnAndStep, advertised, {
      type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 },
    }])).toThrow(/unresolved tool call/)
    expect(() => decode([...turnAndStep, advertised, started, {
      type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } },
    }])).toThrow(/open step|unresolved tool call/)
    expect(decode([...turnAndStep, advertised]).events).toHaveLength(3)
    expect(decode([...turnAndStep, advertised, started]).events).toHaveLength(4)
    expect(decode([...turnAndStep, advertised, started, result(4)]).events).toHaveLength(5)

    const synthetic = {
      ...result(3),
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'interrupted-tool-result-a-3', role: 'user', content: [{
            type: 'tool-result', toolCallId: 'a', isError: true,
            content: [{
              type: 'text',
              text: 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
            }],
          }],
          source: { kind: 'tool', callId: 'a' },
        },
        error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' },
      },
    }
    expect(decode([...turnAndStep, advertised, synthetic]).events).toHaveLength(4)
    expect(() => decode([...turnAndStep, advertised, {
      ...synthetic,
      data: { ...synthetic.data, error: { name: 'Other', code: 'TOOL_NOT_STARTED' } },
    }])).toThrow(/TOOL_NOT_STARTED repair/)
  })

  it('enforces retry mode, failure, route, and policy-chain relationships', () => {
    const prefix = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'request/header', seq: 2, time: 3, data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' } },
    ]
    const retry = (overrides: Record<string, unknown> = {}) => ({
      type: 'llm/retry', seq: 3, time: 4,
      data: {
        retryId: 'r', turn: 1, step: 1, provider: 'p', mode: 'normal', policyKey: 'k', retry: 1,
        maxRetries: 2, delayMs: 1, failure: { message: 'x', code: 'X' }, ...overrides,
      },
    })
    expect(() => decode([...prefix, retry({ maxRetries: undefined })])).toThrow()
    expect(() => decode([...prefix, retry({ retry: 2, maxRetries: 1 })])).toThrow()
    expect(() => decode([...prefix, retry({ turn: 2 })])).toThrow(/current turn/)
    expect(() => decode([...prefix, retry({ provider: 'q' })])).toThrow(/provider/)
    expect(() => decode([...prefix, retry({ failure: { message: 'x', code: 'X', status: 99 } })])).toThrow(/status/)
    expect(() => decode([...prefix, retry({ delayMs: -0.5 })])).toThrow(/non-negative/)
    expect(() => decode([...prefix, retry({ delayMs: 2_147_483_648 })])).toThrow(/timer/)
    expect(() => decode([...prefix, retry({ failure: { message: 'x', code: 'X', providerRetryAfterMs: 0 } })])).toThrow(/positive/)
    expect(decode([...prefix, retry({ delayMs: 1.5 })]).events).toHaveLength(4)
    expect(decode([...prefix, retry({ failure: { message: 'x', code: 'X', providerRetryAfterMs: 1.5 } })]).events)
      .toHaveLength(4)
  })

  it('accepts a legacy retry scheduled immediately after its step closes', () => {
    const rows = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'request/header', seq: 2, time: 3, data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' } },
      { type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } },
      {
        type: 'llm/retry', seq: 4, time: 5,
        data: {
          retryId: 'r', turn: 1, step: 1, provider: 'p', mode: 'normal', policyKey: 'k', retry: 1,
          maxRetries: 2, delayMs: 1, failure: { message: 'retry', code: 'SERVER' },
        },
      },
      { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
    ]

    expect(decode(rows).events).toHaveLength(rows.length)
  })

  it('enforces command pairing and authoritative source-event rules', () => {
    expect(() => decode([{
      type: 'command/done', seq: 0, time: 1, data: { commandId: 'c', kind: 'success' },
    }])).toThrow(/no prior command\/run/)
    const run = { type: 'command/run', seq: 0, time: 1, data: { commandId: 'c', name: 'x', source: { kind: 'user' } } }
    expect(() => decode([run, {
      type: 'command/done', seq: 1, time: 2,
      data: { commandId: 'c', kind: 'error', text: 'x', sourceEventSeq: 0 },
    }])).toThrow(/sourceEventSeq/)
    expect(decode([run, {
      type: 'command/done', seq: 1, time: 2, data: { commandId: 'c', kind: 'success' },
    }]).events).toHaveLength(2)
    expect(() => decode([run, {
      type: 'command/done', seq: 1, time: 2,
      data: { commandId: 'c', kind: 'success', sourceEventSeq: 0 },
    }])).toThrow(/sourceEventSeq/)
  })

  it('enforces title source cardinality and exact auxiliary framing', () => {
    const human = { type: 'user/message', seq: 1, time: 2, data: user('human'), surfaceOp: 'append' }
    const prefix = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }, human]
    expect(() => decode([...prefix, {
      type: 'session/title', seq: 2, time: 3,
      data: { title: 'bad', messageSeqs: [], source: { kind: 'fallback' } },
    }])).toThrow(/empty exactly/)
    expect(() => decode([...prefix, {
      type: 'session/title', seq: 2, time: 3,
      data: { title: 'bad', messageSeqs: [1], source: { kind: 'user' } },
    }])).toThrow(/empty exactly/)
    expect(() => decode([...prefix, {
      type: 'session/title-llm-request', seq: 2, time: 3,
      data: {
        titleProvider: 'p', messageSeqs: [1], route: { provider: 'p', model: 'm' }, system: 's',
        messages: [user('unrelated', { kind: 'plugin', plugin: 'dsh-session-title-llm' })], maxTokens: 1,
      },
    }])).toThrow(/do not represent/)
  })

  it('validates own delivery ids while preserving inherited ancestor markers', () => {
    const marker = (sessionId: string, version: number | undefined, seq: number) => ({
      type: 'session-log-deepseek/delivery-accepted', seq, time: seq + 1,
      data: { sessionId, ...(version === undefined ? {} : { sessionFormatVersion: version }), throughSeq: 0 },
    })
    const prefix = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }]
    expect(() => decode([...prefix, marker('wrong', 1, 1)])).toThrow(/wrong Session/)
    const seeded = {
      type: 'session', version: 1, id: 'child', createdAt: 1, parentSession: 'parent',
      seedLength: 2, delegationDepth: 1,
    }
    expect(decode([...prefix, marker('ancestor-of-parent', 1, 1)], seeded).events).toHaveLength(2)

    const inertV0 = {
      type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 2,
      data: { sessionId: 9, sessionFormatVersion: 0, throughSeq: { futureCoordinate: true } },
    }
    const decoded = decode([...prefix, inertV0])
    expect(decoded.events[1]).toEqual(inertV0)
    expect(() => {
      assertReleasedArtifactRelationships(decoded, { legacyInterruptedTurnRestart: true })
    }).not.toThrow()
  })

  it('validates versioned subagent descriptors by source/current policy', () => {
    const future = {
      type: 'subagent/descriptor', seq: 0, time: 1,
      data: { version: 4, future: true },
    }
    expect(decode([future]).events).toEqual([future])
    const v0Header = { ...header, version: 0 }
    expect(() => restoreV0ToV1(v0Header, [future]))
      .toThrow(SessionFormatUnsupportedMigrationError)
  })

  it('enforces compaction ownership, summaries, turn boundaries, and surface spans', () => {
    const startTurn = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }
    const start = (seq: number, turn: number | null = 1) => ({
      type: 'compaction/start', seq, time: seq + 1, data: { compactionId: 'c', turn },
    })
    const end = (seq: number, data: Record<string, unknown> = {}) => ({
      type: 'compaction/end', seq, time: seq + 1,
      data: { compactionId: 'c', turn: 1, ...data },
    })
    const summary = (seq: number) => ({
      type: 'compaction/summary', seq, time: seq + 1,
      data: {
        compactionId: 'c', summary: [{ type: 'text', text: 'summary' }],
        shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 1,
        provider: 'p', model: 'm',
      },
    })
    expect(() => decode([startTurn, start(1, null)])).toThrow(/open turn/)
    expect(() => decode([startTurn, start(1), start(2)])).toThrow(/overlaps/)
    expect(() => decode([startTurn, start(1), end(2, { turn: 2, error: 'x' })])).toThrow(/owner turn/)
    expect(() => decode([startTurn, start(1), end(2)])).toThrow(/requires one summary/)
    expect(() => decode([startTurn, start(1), {
      type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } },
    }])).toThrow(/crosses/)
    expect(() => decode([startTurn, start(1), {
      ...summary(2),
      data: { ...summary(2).data, shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0] },
    }])).toThrow(/surface span/)
    const userEvent = { type: 'user/message', seq: 1, time: 2, data: user('one'), surfaceOp: 'append' }
    expect(() => decode([startTurn, userEvent, start(2), summary(3), summary(4)])).toThrow(/repeats/)
    expect(() => decode([startTurn, {
      type: 'compaction/prune', seq: 1, time: 2,
      data: { shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], shadowedTokenCount: 1 },
    }])).toThrow(/surface span/)
    expect(() => decode([startTurn, {
      type: 'user/message', seq: 1, time: 2, data: user('base'), surfaceOp: 'append',
    }, {
      type: 'user/message', seq: 2, time: 3, data: {
        ...user('checkpoint'), source: { kind: 'plugin', plugin: 'compact', compactionId: 'missing' },
      }, sourceEventSeqs: [1], surfaceOp: { op: 'replace', start: 1, end: 1 },
    }])).toThrow()
  })

  it('requires each PTC settle to match exactly one start', () => {
    const turn = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }
    const start = {
      type: 'tool/code-dispatch-start', seq: 1, time: 2,
      data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'sub', name: 'a', arguments: { x: 1 } },
    }
    const settle = (seq: number, overrides: Record<string, unknown> = {}) => ({
      type: 'tool/code-dispatch', seq, time: seq + 1,
      data: {
        rootCallId: 'root', parentCallId: 'root', subCallId: 'sub', name: 'a', arguments: { x: 1 },
        isError: false, content: [], ...overrides,
      },
    })
    expect(() => decode([turn, start, settle(2, { name: 'b' })])).toThrow(/does not match/)
    expect(() => decode([turn, start, settle(2, { arguments: { x: 2 } })])).toThrow(/does not match/)
    expect(() => decode([turn, start, settle(2), settle(3)])).toThrow(/unique start/)
    expect(decode([turn, start]).events).toHaveLength(2)
    const arrayStart = {
      ...start,
      data: { ...start.data, subCallId: 'array', arguments: [1, { x: 2 }] },
    }
    const arraySettle = {
      ...settle(2),
      data: { ...settle(2).data, subCallId: 'array', arguments: [1, { x: 2 }] },
    }
    expect(decode([turn, arrayStart, arraySettle]).events).toHaveLength(3)
    expect(() => decode([
      turn,
      arrayStart,
      { ...arraySettle, data: { ...arraySettle.data, arguments: [1, { x: 2 }, 3] } },
    ])).toThrow(/does not match/)
  })

  it('refuses a wrong own-session v0 delivery marker before the header bump', () => {
    const v0 = { ...header, version: 0 }
    const rows = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 2,
        data: { sessionId: 'wrong', throughSeq: 0 },
      },
    ]
    expect(() => restoreV0ToV1(v0, rows))
      .toThrow(/wrong Session/)
  })

  it('accepts the released interrupted-turn restart sequence during v0 migration', () => {
    const v0 = { ...header, version: 0 }
    const rows = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'step/end', seq: 2, time: 3, data: { turn: 1, step: 1 } },
      {
        type: 'agent/inbox/spliced', seq: 3, time: 4,
        data: { target: 'next-turn', start: 0, inserted: [user('queued')] },
      },
      { type: 'turn/start', seq: 4, time: 5, data: { turn: 2 } },
      { type: 'turn/end', seq: 5, time: 6, data: { turn: 2, reason: { kind: 'completed' } } },
    ]

    expect(restoreV0ToV1(v0, rows).events).toEqual(rows)
    expect(() => restoreV0ToV1(v0, rows.map(candidate => candidate.seq === 3
      ? { ...candidate, data: { ...candidate.data, inserted: [] } }
      : candidate))).toThrow(/does not open expected turn/)
  })

  it('accepts recoverable open tails for later interrupted-turn repair', () => {
    const v0 = { ...header, version: 0 }
    const rows = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'request/header', seq: 2, time: 3, data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' } },
      {
        type: 'llm/retry', seq: 3, time: 4,
        data: {
          retryId: 'r', turn: 1, step: 1, provider: 'p', mode: 'normal', policyKey: 'k', retry: 1,
          maxRetries: 2, delayMs: 1, failure: { message: 'x', code: 'X' },
        },
      },
      {
        type: 'assistant/message', seq: 4, time: 5, surfaceOp: 'append',
        data: {
          turn: 1, step: 1,
          message: {
            id: 'tail-assistant', role: 'assistant',
            content: [{ type: 'tool-call', id: 'call', name: 'read', arguments: '{}' }],
            source: { kind: 'model', provider: 'p', model: 'm' },
          },
        },
      },
      { type: 'tool/call', seq: 5, time: 6, data: { turn: 1, step: 1, callId: 'call', name: 'read', arguments: '{}' } },
      {
        type: 'tool/code-dispatch-start', seq: 6, time: 7,
        data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'sub', name: 'read', arguments: {} },
      },
      { type: 'compaction/start', seq: 7, time: 8, data: { compactionId: 'c', turn: 1 } },
    ]
    expect(restoreV0ToV1(v0, rows, 'recoverable').events).toHaveLength(rows.length)
  })

  it('refuses invalid core openings, request placement, and replacement placement', () => {
    expect(() => decode([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/start', seq: 1, time: 2, data: { turn: 2 } },
    ])).toThrow(/expected turn/)
    expect(() => decode([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 2 } },
    ])).toThrow(/next step/)
    expect(() => decode([{
      type: 'request/header', seq: 0, time: 1,
      data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' },
    }])).toThrow(/outside an open turn/)
    expect(() => decode([{
      type: 'request/context', seq: 0, time: 1, data: { provider: 'p', model: 'm' },
    }])).toThrow(/outside an open turn/)
    expect(() => decode([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ])).toThrow(/crosses an open step/)
    const base = { type: 'user/message', seq: 0, time: 1, data: user('base'), surfaceOp: 'append' }
    const replacement = {
      type: 'tool/result', seq: 1, time: 2, sourceEventSeqs: [0],
      surfaceOp: { op: 'replace', start: 0, end: 0 },
      data: {
        turn: 1, step: 1,
        message: {
          id: 'r', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c', content: [] }],
          source: { kind: 'tool', callId: 'c' },
        },
      },
    }
    expect(() => decode([base, replacement])).toThrow(/outside an open turn/)
    const { surfaceOp: _surfaceOp, ...withoutSurface } = base
    expect(() => decode([withoutSurface])).toThrow(/surfaceOp/)
    expect(() => decode([base, {
      type: 'feedback/record', seq: 1, time: 2, data: { text: 'log-only' },
    }, {
      type: 'user/message', seq: 2, time: 3, data: user('missing'), sourceEventSeqs: [1],
      surfaceOp: { op: 'replace', start: 1, end: 1 },
    }])).toThrow(/not on the current surface/)
  })

  it('rejects PTC ancestry/root/start violations', () => {
    const turn = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }
    const start = (seq: number, overrides: Record<string, unknown> = {}) => ({
      type: 'tool/code-dispatch-start', seq, time: seq + 1,
      data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'sub', name: 'a', arguments: {}, ...overrides },
    })
    expect(() => decode([turn, start(1, { parentCallId: 'missing' })])).toThrow(/parentCallId/)
    expect(() => decode([turn, start(1), start(2, { rootCallId: 'other' })])).toThrow(/rootCallId/)
    expect(() => decode([turn, start(1), start(2)])).toThrow(/repeats subCallId/)
  })

  it('rejects repeated retry starts and invalid retry chains', () => {
    const prefix = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'request/header', seq: 2, time: 3, data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' } },
    ]
    const retry = (seq: number, retry: number, retryId = 'r', policyKey = 'k') => ({
      type: 'llm/retry', seq, time: seq + 1,
      data: {
        retryId, turn: 1, step: 1, provider: 'p', mode: 'normal', policyKey, retry,
        maxRetries: 3, delayMs: 1, failure: { message: 'x', code: 'X' },
      },
    })
    const started = (seq: number, step = 1) => ({
      type: 'llm/retry-started', seq, time: seq + 1, data: { retryId: 'r', turn: 1, step, retry: 1 },
    })
    expect(() => decode([...prefix, retry(3, 1), started(4, 2)])).toThrow(/scheduled turn/)
    expect(() => decode([...prefix, retry(3, 1), started(4), started(5)])).toThrow(/repeats/)
    expect(() => decode([...prefix, retry(3, 2)])).toThrow(/retry 1/)
    expect(() => decode([...prefix, retry(3, 1), retry(4, 2, 'other')])).toThrow(/preserve retryId/)
    expect(() => decode([...prefix, retry(3, 1), retry(4, 1, 'r', 'other')])).toThrow(/reuses retryId/)
    expect(decode([...prefix, retry(3, 1), retry(4, 2)]).events).toHaveLength(5)
  })

  it('rejects duplicate commands and clears inherited orphan compactions at end-seed', () => {
    const run = (seq: number) => ({
      type: 'command/run', seq, time: seq + 1, data: { commandId: 'c', name: 'x', source: { kind: 'user' } },
    })
    expect(() => decode([run(0), run(1)])).toThrow(/repeats commandId/)
    const rows = [
      { type: 'compaction/start', seq: 0, time: 1, data: { compactionId: 'c', turn: null } },
      { type: 'session/end-seed', seq: 1, time: 2, data: {} },
      { type: 'turn/start', seq: 2, time: 3, data: { turn: 1 } },
    ]
    expect(decode(rows).events).toEqual(rows)
    expect(decode([{ type: 'session/end-seed', seq: 0, time: 1, data: {} }]).events).toHaveLength(1)
  })

  it('accepts exact title-LLM framing and rejects non-human citations', () => {
    const direct = { type: 'user/message', seq: 1, time: 2, data: user('human'), surfaceOp: 'append' }
    const framed = 'Generate the session title from this JSON array of human messages:\n'
      + JSON.stringify([{ seq: 1, text: 'human' }])
    const request = {
      type: 'session/title-llm-request', seq: 2, time: 3,
      data: {
        titleProvider: 'p', messageSeqs: [1], route: { provider: 'p', model: 'm' }, system: 's', maxTokens: 1,
        messages: [{
          id: 'framed', role: 'user', content: [{ type: 'text', text: framed }],
          source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
        }],
      },
    }
    const prefix = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }, direct]
    expect(decode([...prefix, request]).events).toHaveLength(3)
    const mixedHuman = {
      type: 'user/message', seq: 1, time: 2, surfaceOp: 'append',
      data: {
        id: 'mixed', role: 'user',
        content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'visible' }],
        source: { kind: 'user' },
      },
    }
    const mixedFramed = 'Generate the session title from this JSON array of human messages:\n'
      + JSON.stringify([{ seq: 1, text: 'visible' }])
    const mixedRequest = {
      ...request,
      data: {
        ...request.data,
        messages: [{
          id: 'mixed-frame', role: 'user', content: [{ type: 'text', text: mixedFramed }],
          source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
        }],
      },
    }
    expect(decode([prefix[0], mixedHuman, mixedRequest]).events).toHaveLength(3)
    expect(() => decode([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: user('plugin', { kind: 'plugin', plugin: 'x' }), surfaceOp: 'append' },
      { type: 'session/title', seq: 2, time: 3, data: { title: 'x', messageSeqs: [1], source: { kind: 'fallback' } } },
    ])).toThrow(/human user/)
    expect(() => decode([...prefix, {
      ...request,
      data: { ...request.data, messages: [] },
    }])).toThrow(/do not represent/)
  })

  it('accepts turn-enclosed request context and refuses step work without an open step', () => {
    const turn = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }
    expect(decode([turn, {
      type: 'request/context', seq: 1, time: 2, data: { provider: 'p', model: 'm' },
    }]).events).toHaveLength(2)
    expect(() => decode([turn, {
      type: 'assistant/chunk', seq: 1, time: 2,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } },
    }])).toThrow(/open turn and step/)
  })
})
