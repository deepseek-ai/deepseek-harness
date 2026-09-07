import { describe, expect, it } from 'vitest'
import {
  assertReleasedV2Header,
  releasedV2SessionFormatCodec,
  sessionFormatV1ToV2,
} from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { assertReleasedV2Artifact } from '../src/testing/validation.ts'
import {
  releasedV0SessionFormatCodec,
  releasedV1SessionFormatCodec,
  sessionFormatV0ToV1,
} from '@deepseek-ai/dsh-session-format-v0-to-v1'
import type {
  SessionFormatArtifact,
  SessionFormatEvent,
  SessionFormatEventRun,
  SessionFormatHeader,
  SessionFormatJsonObject,
} from '@deepseek-ai/dsh-session-format'
import { createSessionFormatCatalog, SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'

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

const catalog = createSessionFormatCatalog({
  currentVersion: 2,
  codecs: [releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, releasedV2SessionFormatCodec],
  currentEncoder: releasedV2SessionFormatCodec,
  migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2],
  restoreCurrent(artifact) {
    assertReleasedV2Artifact(artifact)
    return artifact
  },
  restoreTransformedCurrent(artifact) {
    assertReleasedV2Artifact(artifact)
    return artifact
  },
  restoreCurrentHeader(header) {
    assertReleasedV2Header(header)
    return header
  },
})

function physicalV1Header(header: SessionFormatHeader, inheritedEventCount: number) {
  return {
    type: 'session',
    version: 1,
    id: header.id,
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
    ...(header.isSeeded ? { seedLength: inheritedEventCount } : {}),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    delegationDepth: header.delegationDepth,
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
  }
}

function migrateV1ToV2(source: SessionFormatArtifact): SessionFormatArtifact {
  const restore = catalog.createRestore(
    physicalV1Header(source.header, source.inheritedEventCount),
    { recovery: 'strict', validation: 'current' },
  )
  for (const row of source.events) restore.decodeRow(row)
  return restore.finish()
}

function stageHarness(options: {
  readonly id?: string
  readonly sourceCut?: number
  readonly seeded?: boolean
  readonly sourceKind?: 'decoded' | 'transformed'
} = {}) {
  const sourceHeader: SessionFormatHeader = {
    version: 1,
    id: options.id ?? 'stage',
    createdAt: 1,
    ...(options.seeded === true ? { parentSession: 'parent' } : {}),
    isSeeded: options.seeded === true,
    delegationDepth: 0,
  }
  const stage = sessionFormatV1ToV2.createStage({
    sourceHeader,
    targetHeader: sessionFormatV1ToV2.migrateHeader(sourceHeader),
    sourceInheritedEventCount: options.sourceCut ?? 0,
    sourceKind: options.sourceKind ?? 'decoded',
  })
  return { stage, output: new SessionFormatEventCollector() }
}

function packedRun(options: {
  readonly firstSeq: number
  readonly eventCount?: number
  readonly turn?: number
  readonly step?: number
  readonly lastTime: number
  readonly stream: SessionFormatJsonObject
}): SessionFormatEventRun {
  const eventCount = options.eventCount ?? 1
  return {
    runType: 'released-assistant-chunks',
    firstSeq: options.firstSeq,
    eventCount,
    turn: options.turn ?? 1,
    step: options.step ?? 1,
    lastSeq: options.firstSeq + eventCount - 1,
    lastTime: options.lastTime,
    stream: options.stream,
    *expand() {},
  } as SessionFormatEventRun
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

  it('validates a directly decoded v1 source before transforming it', () => {
    const header = {
      version: 1, id: 'source-validation', createdAt: 1, isSeeded: false, delegationDepth: 0,
    }
    expect(() => migrateV1ToV2({
      header,
      inheritedEventCount: 0,
      events: [event('external/post-v1', 0, 1, null)],
    })).toThrow(/unknown event type/)
    expect(() => migrateV1ToV2({
      header,
      inheritedEventCount: 0,
      events: [{
        type: 'turn/start', seq: 0, time: 1, data: { turn: 1, postReleaseMember: true },
      }],
    })).toThrow(/unexpected member/)
  })

  it.each([
    ['unexpected member', { ...event('assistant/chunk', 0, 1, {}), extra: true }, /unexpected member extra/],
    ['missing member', { type: 'assistant/chunk', seq: 0, time: 1 }, /lacks required member data/],
    ['invalid ignorable marker', { ...event('assistant/chunk', 0, 1, {}), ignorable: false }, /ignorable must be true/],
  ])('refuses an Assistant chunk envelope with an %s', (_name, candidate, expected) => {
    const { stage, output } = stageHarness({ sourceKind: 'transformed' })
    expect(() => { stage.transformEvent(candidate as SessionFormatEvent, output) }).toThrow(expected)
  })

  it('checks own-generation delivery markers but accepts inherited markers', () => {
    const marker = (sessionId: string): SessionFormatEvent => event(
      'session-log-deepseek/delivery-accepted',
      1,
      2,
      { sessionId, throughSeq: 0, sessionFormatVersion: 1 },
    )
    const own = stageHarness({ id: 'child' })
    expect(() => { own.stage.transformEvent(marker('other'), own.output) }).toThrow(/wrong Session/)

    const inherited = stageHarness({ id: 'child', seeded: true, sourceCut: 2 })
    inherited.stage.transformEvent(marker('parent'), inherited.output)
    expect(inherited.output.values).toEqual([{ ...marker('parent'), seq: 0 }])
  })

  it('expands generic runs and refuses a packed run split by the inherited cut', () => {
    const generic = stageHarness({ sourceKind: 'transformed' })
    const retained = event('feedback/record', 0, 1, { text: 'retained' })
    generic.stage.transformRun({
      runType: 'test-run', firstSeq: 0, eventCount: 1, *expand() { yield retained },
    }, generic.output)
    expect(generic.output.values).toEqual([retained])

    const split = stageHarness({ seeded: true, sourceCut: 1 })
    expect(() => { split.stage.transformRun(packedRun({
      firstSeq: 0,
      eventCount: 2,
      lastTime: 2,
      stream: { type: 'text-chunks', time0: 1, index: 0, dt: [1], texts: ['a', 'b'] },
    }), split.output) }).toThrow(/splits one Assistant attempt/)
  })

  it('coalesces adjacent packed text and tool-call runs without expanding them', () => {
    const text = stageHarness()
    text.stage.transformRun(packedRun({
      firstSeq: 0, lastTime: 1,
      stream: { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['a'] },
    }), text.output)
    text.stage.transformRun(packedRun({
      firstSeq: 1, eventCount: 2, lastTime: 4,
      stream: { type: 'text-chunks', time0: 3, index: 0, dt: [1], texts: ['b', 'c'] },
    }), text.output)
    text.stage.finish(text.output)
    expect(text.output.values[0]?.data).toMatchObject({
      stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [2, 1], texts: ['a', 'b', 'c'] }],
    })

    const tool = stageHarness()
    tool.stage.transformEvent(event('assistant/chunk', 0, 1, {
      turn: 1, step: 1,
      chunk: { type: 'tool-call-delta', index: 0, id: 'call', name: 'read', argumentsDelta: '{' },
    }), tool.output)
    tool.stage.transformRun(packedRun({
      firstSeq: 1, eventCount: 2, lastTime: 3,
      stream: {
        type: 'tool-call-chunks', time0: 2, index: 0,
        id: 'call', name: 'read', dt: [1], args: ['}', '!'],
      },
    }), tool.output)
    tool.stage.finish(tool.output)
    expect(tool.output.values[0]?.data).toMatchObject({
      stream: [{
        type: 'tool-call-chunks', time0: 1, index: 0,
        id: 'call', name: 'read', dt: [1, 1], args: ['{', '}', '!'],
      }],
    })
  })

  it('keeps incompatible packed records and attempt groups separate', () => {
    const mismatched = [
      { index: 1, id: 'call', name: 'read', time0: 2 },
      { index: 0, id: 'other', name: 'read', time0: 2 },
      { index: 0, id: 'call', name: 'write', time0: 2 },
      { index: 0, id: 'call', name: 'read', time0: Number.MAX_SAFE_INTEGER },
    ] as const
    for (const [index, next] of mismatched.entries()) {
      const current = stageHarness()
      current.stage.transformRun(packedRun({
        firstSeq: 0,
        lastTime: index === mismatched.length - 1 ? Number.MIN_SAFE_INTEGER : 1,
        stream: {
          type: 'tool-call-chunks', time0: index === mismatched.length - 1 ? Number.MIN_SAFE_INTEGER : 1,
          index: 0, id: 'call', name: 'read', dt: [], args: ['a'],
        },
      }), current.output)
      current.stage.transformRun(packedRun({
        firstSeq: 1,
        lastTime: next.time0,
        stream: {
          type: 'tool-call-chunks', time0: next.time0,
          index: next.index, id: next.id, name: next.name, dt: [], args: ['b'],
        },
      }), current.output)
      current.stage.finish(current.output)
      expect((current.output.values[0]?.data as { stream: unknown[] }).stream).toHaveLength(2)
    }

    const groups = stageHarness()
    groups.stage.transformRun(packedRun({
      firstSeq: 0, lastTime: 1,
      stream: { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['a'] },
    }), groups.output)
    groups.stage.transformRun(packedRun({
      firstSeq: 1, step: 2, lastTime: 2,
      stream: { type: 'text-chunks', time0: 2, index: 0, dt: [], texts: ['b'] },
    }), groups.output)
    groups.stage.finish(groups.output)
    expect(groups.output.values).toHaveLength(2)
  })

  it('copies incompatible accumulator records behind an owned packed prefix', () => {
    const text = stageHarness()
    text.stage.transformRun(packedRun({
      firstSeq: 0, lastTime: 1,
      stream: { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['packed'] },
    }), text.output)
    text.stage.transformEvent(event('assistant/chunk', 1, 2, {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'a' },
    }), text.output)
    text.stage.transformEvent(event('assistant/chunk', 2, 3, {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'b' },
    }), text.output)
    text.stage.transformRun(packedRun({
      firstSeq: 3, lastTime: 4,
      stream: { type: 'reasoning-chunks', time0: 4, index: 0, dt: [], texts: ['flush'] },
    }), text.output)
    text.stage.finish(text.output)
    expect((text.output.values[0]?.data as { stream: unknown[] }).stream).toHaveLength(3)

    const tool = stageHarness()
    tool.stage.transformRun(packedRun({
      firstSeq: 0, lastTime: 1,
      stream: { type: 'tool-call-chunks', time0: 1, index: 0, id: 'call', dt: [], args: ['a'] },
    }), tool.output)
    tool.stage.transformEvent(event('assistant/chunk', 1, 2, {
      turn: 1, step: 1,
      chunk: { type: 'tool-call-delta', index: 0, id: 'other', argumentsDelta: 'b' },
    }), tool.output)
    tool.stage.transformRun(packedRun({
      firstSeq: 2, lastTime: 3,
      stream: { type: 'text-chunks', time0: 3, index: 0, dt: [], texts: ['flush'] },
    }), tool.output)
    tool.stage.finish(tool.output)
    expect((tool.output.values[0]?.data as { stream: unknown[] }).stream).toHaveLength(3)
  })

  it('separates a terminal packed successor and a message from another attempt', () => {
    const terminal = stageHarness()
    terminal.stage.transformEvent(event('assistant/chunk', 0, 1, {
      turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } },
    }), terminal.output)
    terminal.stage.transformRun(packedRun({
      firstSeq: 1, lastTime: 2,
      stream: { type: 'text-chunks', time0: 2, index: 0, dt: [], texts: ['next'] },
    }), terminal.output)
    terminal.stage.finish(terminal.output)
    expect(terminal.output.values).toHaveLength(2)

    const messageMismatch = stageHarness()
    messageMismatch.stage.transformEvent(event('assistant/chunk', 0, 1, {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'partial' },
    }), messageMismatch.output)
    messageMismatch.stage.transformEvent({
      ...event('assistant/message', 1, 2, { turn: 2, step: 1, message }),
      surfaceOp: 'append',
    }, messageMismatch.output)
    expect(messageMismatch.output.values).toHaveLength(2)
  })

  it('settles incremental attempts and rejects ambiguous streamed input', () => {
    const header = {
      version: 1, id: 'streaming', createdAt: 1, isSeeded: false, delegationDepth: 0,
    }
    const chunk = (seq: number, value: string | undefined, turn = 1): SessionFormatEvent => event(
      'assistant/chunk',
      seq,
      seq + 1,
      {
        turn,
        step: 1,
        chunk: value === undefined
          ? { type: 'finish', reason: { kind: 'stop' } }
          : { type: 'text-delta', index: 0, text: value },
      },
    )
    const assistant = (
      seq: number,
      turn: number,
      sourceEventSeqs?: readonly number[],
    ): SessionFormatEvent => ({
      ...event('assistant/message', seq, seq + 1, { turn, step: 1, message }),
      ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
      surfaceOp: 'append',
    })

    const restarted = migrateV1ToV2({
      header,
      inheritedEventCount: 0,
      events: [
        event('turn/start', 0, 1, { turn: 1 }),
        event('step/start', 1, 2, { turn: 1, step: 1 }),
        chunk(2, 'first'),
        chunk(3, undefined),
        chunk(4, 'second'),
        event('step/end', 5, 6, { turn: 1, step: 1 }),
        event('turn/end', 6, 7, { turn: 1, reason: { kind: 'completed' } }),
      ],
    })
    expect(restarted.events.filter(candidate => candidate.type === 'assistant/attempt')).toHaveLength(2)

    expect(() => migrateV1ToV2({
      header,
      inheritedEventCount: 0,
      events: [chunk(0, 'partial'), assistant(1, 1)],
    })).toThrow(/does not cite/)

    expect(() => migrateV1ToV2({
      header,
      inheritedEventCount: 0,
      events: [chunk(0, 'partial'), assistant(1, 1, [1])],
    })).toThrow(/complete ordered attempt/)
    expect(() => migrateV1ToV2({
      header,
      inheritedEventCount: 0,
      events: [event('external/unknown', 0, 1, null)],
    })).toThrow(/unknown event type/)

    const seededHeader = { ...header, parentSession: 'parent', isSeeded: true }
    expect(migrateV1ToV2({ header: seededHeader, inheritedEventCount: 0, events: [] }).events).toEqual([{
      type: 'session/end-seed', seq: 0, time: 1, data: { inherited: true },
    }])
    expect(migrateV1ToV2({
      header: seededHeader,
      inheritedEventCount: 0,
      events: [event('turn/start', 0, 2, { turn: 1 })],
    }).events[0]).toEqual({
      type: 'session/end-seed', seq: 0, time: 2, data: { inherited: true },
    })

    expect(() => migrateV1ToV2({
      header: seededHeader,
      inheritedEventCount: 1,
      events: [chunk(0, 'partial'), assistant(1, 1, [0])],
    })).toThrow(/splits one Assistant attempt/)
  })

  it('splits a legacy goal mutation from its preserved model-visible message', () => {
    const change = {
      kind: 'goal/change', version: 1, operation: 'create',
      goal: { id: 'goal-1', revision: 1, objective: 'finish', phase: 'active', maxGoalRounds: 2 },
      roundsStarted: 0, createdAt: 1, updatedAt: 1,
    }
    const payload = {
      goal: change.goal,
      roundsStarted: change.roundsStarted,
      createdAt: change.createdAt,
      updatedAt: change.updatedAt,
    }
    const source: SessionFormatArtifact = {
      header: { version: 1, id: 'legacy-goal', createdAt: 1, isSeeded: false, delegationDepth: 0 },
      inheritedEventCount: 0,
      events: [
        {
          ...event('user/message', 0, 1, {
            id: 'goal-message', role: 'user',
            content: [{ type: 'text', text: `<goal_state>${JSON.stringify(payload)}</goal_state>` }],
            source: { kind: 'goal', goalId: 'goal-1', revision: 1, round: 0, change },
          }),
          surfaceOp: 'append',
        },
      ],
    }

    expect(migrateV1ToV2(source).events).toMatchObject([
      { type: 'goal/change', seq: 0, data: change },
      { type: 'user/message', seq: 1, data: { source: { kind: 'plugin', plugin: 'goal' } } },
    ])
  })

  it('closes the prior turn for the bounded legacy next-turn resume pattern', () => {
    const source: SessionFormatArtifact = {
      header: { version: 1, id: 'legacy-turn', createdAt: 1, isSeeded: false, delegationDepth: 0 },
      inheritedEventCount: 0,
      events: [
        event('turn/start', 0, 1, { turn: 1 }),
        event('step/start', 1, 2, { turn: 1, step: 1 }),
        event('step/end', 2, 3, { turn: 1, step: 1 }),
        event('agent/inbox/spliced', 3, 4, {
          target: 'next-turn', start: 0, inserted: [userMessage],
        }),
        event('turn/start', 4, 5, { turn: 2 }),
        event('turn/end', 5, 6, { turn: 2, reason: { kind: 'completed' } }),
      ],
    }

    const migrated = migrateV1ToV2(source)
    expect(migrated.events.map(candidate => candidate.type)).toEqual([
      'turn/start', 'step/start', 'step/end', 'agent/inbox/spliced',
      'turn/end', 'turn/start', 'turn/end',
    ])
    expect(migrated.events[4]).toMatchObject({
      data: { turn: 1, reason: { kind: 'interrupted' } },
    })

    const invalid = {
      ...source,
      events: source.events.map(candidate => candidate.seq === 3
        ? event('agent/inbox/spliced', 3, 4, { target: 'next-turn', start: 0, inserted: [] })
        : candidate),
    }
    expect(() => migrateV1ToV2(invalid)).toThrow(/turn\/start 2/)
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

    expect(migrateV1ToV2(source)).toStrictEqual({
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

    expect(migrateV1ToV2(source)).toStrictEqual({
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

    const migrated = migrateV1ToV2(source)
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

    const migrated = migrateV1ToV2(source)
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

    expect(migrateV1ToV2(source)).toStrictEqual({
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
    expect(migrateV1ToV2(source)).toMatchObject({
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

    expect(() => migrateV1ToV2(source)).toThrow(/message content disagrees with its embedded stream/)
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

    expect(() => migrateV1ToV2(source)).toThrow(
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

    expect(() => migrateV1ToV2(source)).toThrow(
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
      const migrated = migrateV1ToV2(source)
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
    expect(() => migrateV1ToV2(build(undefined))).toThrow(/does not cite/)
    expect(() => migrateV1ToV2(build([2]))).toThrow(/complete ordered attempt/)
    expect(() => migrateV1ToV2(build([3, 2]))).toThrow(/complete ordered attempt/)
  })

  it.each([
    ['a message after its attempt step has closed', [
      event('turn/start', 0, 1, { turn: 1 }),
      event('step/start', 1, 2, { turn: 1, step: 1 }),
      event('assistant/chunk', 2, 3, {
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hello' },
      }),
      event('assistant/chunk', 3, 4, {
        turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } },
      }),
      event('step/end', 4, 5, { turn: 1, step: 1 }),
      { ...event('assistant/message', 5, 6, { turn: 1, step: 1, message }), surfaceOp: 'append' },
      event('turn/end', 6, 7, { turn: 1, reason: { kind: 'completed' } }),
    ]],
    ['a message that cites a different pending attempt', [
      event('turn/start', 0, 1, { turn: 1 }),
      event('step/start', 1, 2, { turn: 1, step: 1 }),
      event('assistant/chunk', 2, 3, {
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hello' },
      }),
      event('assistant/chunk', 3, 4, {
        turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } },
      }),
      {
        ...event('assistant/message', 4, 5, { turn: 1, step: 2, message }),
        sourceEventSeqs: [2, 3],
        surfaceOp: 'append',
      },
      event('step/end', 5, 6, { turn: 1, step: 1 }),
      event('turn/end', 6, 7, { turn: 1, reason: { kind: 'completed' } }),
    ]],
  ] as const)('rejects %s during complete target validation', (_name, events) => {
    expect(() => migrateV1ToV2({
      header: {
        version: 1, id: 'v1-final-validation', createdAt: 1,
        isSeeded: false, delegationDepth: 0,
      },
      inheritedEventCount: 0,
      events,
    })).toThrow(/does not match an open turn and step/)
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
    expect(() => migrateV1ToV2(source)).toThrow(/cut 3 splits one Assistant attempt/)
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
    expect(() => migrateV1ToV2(source)).toThrow(/cut 4 splits one Assistant attempt/)
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

    const migrated = migrateV1ToV2(source)
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
    const migrated = migrateV1ToV2(source)
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

    const migrated = migrateV1ToV2(source)
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
    expect(migrateV1ToV2(source).events[3]?.data).toMatchObject({
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
    expect(migrateV1ToV2(source).events.filter(event => event.type === 'assistant/attempt'))
      .toHaveLength(2)
  })
})
