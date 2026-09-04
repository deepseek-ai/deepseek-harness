import { describe, expect, it, vi } from 'vitest'
import type {
  SessionEventLike, SessionEventLikeEntry, SessionLiveEventEntry,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  ConversationLocationIndex,
  ConversationNodeAssembler as RuntimeConversationNodeAssembler,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ConversationMatch, ConversationNodeContext,
  ConversationNodeDefinition, ConversationViewDefinition, ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

interface ScopeProbeStepData {
  readonly value: number
}

interface ScopeProbeTurnData {
  readonly valueSeenFromStep: number
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationStepDataMap {
    'scope-probe': ScopeProbeStepData
  }

  interface ConversationTurnDataMap {
    'scope-probe': ScopeProbeTurnData
  }
}

interface TestSnapshot {
  readonly order: readonly string[]
  readonly nodes: ReadonlyMap<string, ConversationViewNode>
}

class TestEventDefinitions {
  readonly definitions: readonly ConversationNodeDefinition[]
  readonly fallback: ConversationNodeDefinition | undefined

  constructor(
    definitions: readonly ConversationNodeDefinition[],
    fallback?: ConversationNodeDefinition,
  ) {
    this.definitions = definitions
    this.fallback = fallback
  }

  entries(): readonly ConversationNodeDefinition[] {
    return this.definitions
  }

  fallbackEntry(): ConversationNodeDefinition | undefined {
    return this.fallback
  }
}

class TestViewDefinitions {
  constructor(readonly definitions: readonly ConversationViewDefinition[]) {}

  entries(): readonly ConversationViewDefinition[] {
    return this.definitions
  }
}

class ConversationNodeAssembler extends RuntimeConversationNodeAssembler {
  constructor(events: TestEventDefinitions, views: TestViewDefinitions) {
    super(events, views)
    for (const view of views.entries()) this.activateTarget(view.target)
  }
}

function testView(
  apply = vi.fn(),
): ConversationViewDefinition<ConversationViewNode, TestSnapshot> {
  return {
    target: 'test',
    create: () => {
      let current: TestSnapshot = { order: [], nodes: new Map() }
      return {
        empty: current,
        replace: ({ nodes }) => {
          current = { order: nodes.map(node => node.key), nodes: new Map(nodes.map(node => [node.key, node])) }
          return current
        },
        apply: ({ upserts }) => {
          apply(upserts)
          const nodes = new Map(current.nodes)
          const order = [...current.order]
          for (const node of upserts) {
            if (!nodes.has(node.key)) order.push(node.key)
            nodes.set(node.key, node)
          }
          current = { order, nodes }
          return current
        },
      }
    },
  }
}

function trackedView(target: string) {
  const replace = vi.fn(({ nodes }: { readonly nodes: readonly ConversationViewNode[] }) => nodes)
  const apply = vi.fn(({ upserts }: { readonly upserts: readonly ConversationViewNode[] }) => upserts)
  const create = vi.fn(() => ({
    empty: [] as readonly ConversationViewNode[],
    replace,
    apply,
  }))
  const definition: ConversationViewDefinition<ConversationViewNode, readonly ConversationViewNode[]> = {
    target,
    create,
  }
  return { definition, create, replace, apply }
}

function at(seq: SessionSeq, type: string, data: unknown): SessionEvent {
  return { seq, time: 1_700_000_000_000 + seq, type, data } as SessionEvent
}

function input(event: SessionEvent): SessionLiveEventEntry {
  return { type: 'event', event }
}

function transientChunk(
  seq: number,
  turn: number,
  step: number,
  chunk: StreamChunk,
): SessionEventLikeEntry {
  return {
    type: 'transient',
    event: {
      type: 'assistant/live-chunk',
      seq,
      time: 1_700_000_000_000 + seq,
      data: { attemptId: LlmAttemptId('test-attempt'), turn, step, chunk },
    },
  }
}

function testSnapshot(assembler: ConversationNodeAssembler): TestSnapshot | undefined {
  return assembler.snapshot('test') as TestSnapshot | undefined
}

function node(
  context: Parameters<NonNullable<ConversationNodeDefinition['buildViewNode']>>[0],
  data: unknown,
): ConversationViewNode {
  return {
    key: context.key,
    kind: context.kind,
    id: context.id,
    target: 'test',
    data,
  }
}

function fallbackDefinition(start: () => string): ConversationNodeDefinition<string> {
  return {
    kind: 'fallback',
    target: 'test',
    match: event => ({ id: String(event.seq), role: 'start' }),
    start,
    update: context => context.state,
    buildViewNode: context => node(context, context.state),
  }
}

describe('ConversationNodeAssembler', () => {
  it('publishes Location data through stable per-key sources', () => {
    const index = new ConversationLocationIndex()
    const turnStart = at(SessionSeq(1), 'turn/start', { turn: 1 })
    const stepStart = at(SessionSeq(2), 'step/start', { turn: 1, step: 1 })
    index.rebuild([input(turnStart), input(stepStart)])
    const location = index.locationOf(stepStart)
    if (location.kind !== 'step') throw new Error('scope probe requires a Step Location')
    const source = location.step.data.source('scope-probe')
    const listener = vi.fn()
    source.subscribe(listener)
    const initial = { value: 1 }

    expect(location.step.data.source('scope-probe')).toBe(source)
    expect(source.getSnapshot()).toBeUndefined()
    expect(index.replaceData([{
      owner: 'scope-probe:1:1',
      data: { kind: 'step', turn: 1, step: 1, key: 'scope-probe', value: initial },
    }])).toBe(true)
    expect(source.getSnapshot()).toBe(initial)
    expect(listener).not.toHaveBeenCalled()

    index.publishData()
    expect(listener).toHaveBeenCalledOnce()
    listener.mockClear()

    index.replaceData([])
    index.replaceData([{
      owner: 'scope-probe:1:1',
      data: { kind: 'step', turn: 1, step: 1, key: 'scope-probe', value: initial },
    }])
    index.publishData()
    expect(listener).not.toHaveBeenCalled()

    const changed = { value: 2 }
    index.replaceData([{
      owner: 'scope-probe:1:1',
      data: { kind: 'step', turn: 1, step: 1, key: 'scope-probe', value: changed },
    }])
    index.publishData()
    expect(source.getSnapshot()).toBe(changed)
    expect(listener).toHaveBeenCalledOnce()

    index.replaceData([])
    index.publishData()
    expect(source.getSnapshot()).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('reports a replacement only when an active target has a registered builder', () => {
    const assembler = new RuntimeConversationNodeAssembler(
      new TestEventDefinitions([]),
      new TestViewDefinitions([]),
    )

    expect(assembler.activateTarget('registered-later')).toBe(false)
    assembler.replaceWindow([], false)

    expect(assembler.flush()).toBe(false)
  })

  it('updates only active targets and never deactivates one after first use', () => {
    type State = { readonly updates: number }
    const definition = (
      target: string,
      buildViewNode: NonNullable<ConversationNodeDefinition<State>['buildViewNode']>,
    ): ConversationNodeDefinition<State> => ({
      kind: `active-${target}`,
      target,
      match: (event) => {
        const type = event.type as string
        if (type === 'active/start') return { id: 'one', role: 'start' }
        if (type === 'active/update') return { id: 'one', role: 'update' }
        return null
      },
      start: () => ({ updates: 0 }),
      update: context => ({ updates: context.state.updates + 1 }),
      buildViewNode,
    })
    const chat = trackedView('chat')
    const trajectory = trackedView('trajectory')
    const build = (target: string) => vi.fn((context: ConversationNodeContext<State>): ConversationViewNode => ({
      key: context.key,
      kind: context.kind,
      id: context.id,
      target,
      data: context.state,
    }))
    const buildChat = build('chat')
    const buildTrajectory = build('trajectory')
    const assembler = new RuntimeConversationNodeAssembler(
      new TestEventDefinitions([
        definition('chat', buildChat),
        definition('trajectory', buildTrajectory),
      ]),
      new TestViewDefinitions([chat.definition, trajectory.definition]),
    )

    assembler.replaceWindow([input(at(SessionSeq(1), 'active/start', {}))], false)
    expect(assembler.flush()).toBe(false)
    expect(chat.create).not.toHaveBeenCalled()
    expect(trajectory.create).not.toHaveBeenCalled()
    expect(buildChat).not.toHaveBeenCalled()
    expect(buildTrajectory).not.toHaveBeenCalled()

    expect(assembler.activateTarget('chat')).toBe(true)
    expect(chat.replace).toHaveBeenCalledOnce()
    expect(trajectory.replace).not.toHaveBeenCalled()
    expect(buildChat).toHaveBeenCalledOnce()
    expect(buildTrajectory).not.toHaveBeenCalled()

    assembler.append(input(at(SessionSeq(2), 'active/update', {})))
    expect(assembler.flush()).toBe(true)
    expect(chat.apply).toHaveBeenCalledOnce()
    expect(trajectory.apply).not.toHaveBeenCalled()
    expect(buildTrajectory).not.toHaveBeenCalled()

    expect(assembler.activateTarget('trajectory')).toBe(true)
    expect(trajectory.replace).toHaveBeenCalledOnce()
    expect((assembler.snapshot('trajectory') as readonly ConversationViewNode[])
      .map(node => node.data)).toEqual([{ updates: 1 }])

    assembler.append(input(at(SessionSeq(3), 'active/update', {})))
    expect(assembler.flush()).toBe(true)
    expect(chat.apply).toHaveBeenCalledTimes(2)
    expect(trajectory.apply).toHaveBeenCalledOnce()
    expect(assembler.activateTarget('chat')).toBe(false)
    expect(assembler.activateTarget('trajectory')).toBe(false)
    expect(chat.replace).toHaveBeenCalledOnce()
    expect(trajectory.replace).toHaveBeenCalledOnce()
  })

  it('appends through an exact business-id Context without replaying unrelated Contexts', () => {
    const starts = vi.fn((
      _context: ConversationNodeContext<{ callSeq: number; results: number }>,
      match: ConversationMatch,
    ) => ({ callSeq: match.event.seq, results: 0 }))
    const updates = vi.fn((context: { state: { callSeq: number; results: number } }) => ({
      ...context.state,
      results: context.state.results + 1,
    }))
    const definition: ConversationNodeDefinition<{ callSeq: number; results: number }> = {
      kind: 'tool',
      match: (event) => {
        if (event.type === 'tool/call') return { id: String(event.data.callId), role: 'start' }
        if (event.type === 'tool/result') return { id: String(event.data.message.source.callId), role: 'update' }
        return null
      },
      start: starts,
      update: updates,
      target: 'test',
      buildViewNode: context => node(context, context.state),
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([definition]),
      new TestViewDefinitions([testView()]),
    )
    assembler.replaceWindow([
      input(at(SessionSeq(1), 'tool/call', { turn: 1, step: 1, callId: 'a', name: 'x', arguments: '{}' })),
      input(at(SessionSeq(2), 'tool/call', { turn: 1, step: 1, callId: 'b', name: 'x', arguments: '{}' })),
    ], false)
    assembler.flush()
    starts.mockClear()

    assembler.append(input(at(SessionSeq(3), 'tool/result', {
      turn: 1,
      step: 1,
      message: { source: { type: 'tool-result', callId: 'a' }, content: [], isError: false },
    })))
    assembler.flush()

    expect(starts).not.toHaveBeenCalled()
    expect(updates).toHaveBeenCalledOnce()
    const snapshot = testSnapshot(assembler)
    expect([...snapshot?.nodes.values() ?? []].map(value => value.data)).toEqual([
      { callSeq: 1, results: 1 },
      { callSeq: 2, results: 0 },
    ])
  })

  it('keeps one Match collection while a long Context appends without replay', () => {
    const starts = vi.fn(() => 0)
    const updates = vi.fn((context: ConversationNodeContext<number> & { readonly state: number }) => (
      context.state + 1
    ))
    const matchCollections = new Set<readonly ConversationMatch[]>()
    const definition: ConversationNodeDefinition<number> = {
      kind: 'append-linear',
      match: (event) => {
        const type: string = event.type
        if (type === 'linear/start') return { id: 'one', role: 'start' }
        if (type === 'linear/update') return { id: 'one', role: 'update' }
        return null
      },
      start: (context) => {
        matchCollections.add(context.matches)
        return starts()
      },
      update: (context) => {
        matchCollections.add(context.matches)
        return updates(context)
      },
      target: 'test',
      buildViewNode: context => node(context, context.state),
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([definition]),
      new TestViewDefinitions([testView()]),
    )
    assembler.replaceWindow([input(at(SessionSeq(1), 'linear/start', {}))], false)
    starts.mockClear()

    for (let seq = 2; seq <= 1_001; seq++) {
      assembler.append(input(at(SessionSeq(seq), 'linear/update', {})))
    }
    assembler.flush()

    expect(starts).not.toHaveBeenCalled()
    expect(updates).toHaveBeenCalledTimes(1_000)
    expect(matchCollections.size).toBe(1)
    expect([...testSnapshot(assembler)?.nodes.values() ?? []][0]?.data).toBe(1_000)
  })

  it('keeps one transient Match through replace, Location replay, and Registry rebuild', () => {
    interface State {
      readonly updates: readonly string[]
      readonly transientStatus: string | undefined
    }

    const matches = vi.fn((event: SessionEventLike) => {
      if (event.type === 'step/start') return { id: '2:3', role: 'start' as const }
      if ((event.type as string) === 'probe/update'
        || event.type === 'assistant/live-chunk') {
        return { id: '2:3', role: 'update' as const }
      }
      return null
    })
    const passiveMatches = vi.fn(() => null)
    const updates = vi.fn((
      context: ConversationNodeContext<State> & { readonly state: State },
      match: ConversationMatch,
    ): State => {
      if (match.event.type === 'assistant/live-chunk') {
        return {
          ...context.state,
          updates: [
            ...context.state.updates,
            `transient:${String(match.event.seq)}:${match.event.data.chunk.type}`,
          ],
          transientStatus: match.location.kind === 'step'
            ? match.location.step.status
            : match.location.kind,
        }
      }
      return {
        ...context.state,
        updates: [...context.state.updates, `event:${String(match.event.seq)}`],
      }
    })
    const definition: ConversationNodeDefinition<State> = {
      kind: 'transient-probe',
      match: matches,
      start: () => ({ updates: [], transientStatus: undefined }),
      update: updates,
      target: 'test',
      buildViewNode: context => context.state === undefined
        ? null
        : node(context, {
          ...context.state,
          matches: context.matches.map(match => ({
            type: match.event.type,
            seq: match.event.seq,
          })),
        }),
    }
    const passive: ConversationNodeDefinition<null> = {
      kind: 'transient-passive',
      match: passiveMatches,
      start: () => null,
      update: context => context.state,
    }
    const delta = transientChunk(12.5, 2, 3, { type: 'text-delta', index: 0, text: 'abc' })
    const inputs: SessionEventLikeEntry[] = [
      input(at(SessionSeq(10), 'step/start', { turn: 2, step: 3 })),
      input(at(SessionSeq(11), 'probe/update', { turn: 2, step: 3 })),
      delta,
      input(at(SessionSeq(15), 'probe/update', { turn: 2, step: 3 })),
    ]
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([definition, passive]),
      new TestViewDefinitions([testView()]),
    )

    assembler.replaceWindow(inputs, false)
    assembler.flush()

    expect(matches).toHaveBeenCalledTimes(4)
    expect(passiveMatches).toHaveBeenCalledTimes(4)
    expect(updates).toHaveBeenCalledTimes(3)
    expect(updates.mock.calls.filter(([, match]) => (
      match.event.type === 'assistant/live-chunk'
    ))).toHaveLength(1)
    expect([...testSnapshot(assembler)?.nodes.values() ?? []][0]?.data).toEqual({
      updates: ['event:11', 'transient:12.5:text-delta', 'event:15'],
      transientStatus: 'open',
      matches: [
        { type: 'step/start', seq: 10 },
        { type: 'probe/update', seq: 11 },
        { type: 'assistant/live-chunk', seq: 12.5 },
        { type: 'probe/update', seq: 15 },
      ],
    })

    assembler.append(input(at(SessionSeq(16), 'step/end', { turn: 2, step: 3 })))
    assembler.flush()

    expect(updates.mock.calls.filter(([, match]) => (
      match.event.type === 'assistant/live-chunk'
    ))).toHaveLength(2)
    expect([...testSnapshot(assembler)?.nodes.values() ?? []][0]?.data).toMatchObject({
      updates: ['event:11', 'transient:12.5:text-delta', 'event:15'],
      transientStatus: 'closed',
    })

    matches.mockClear()
    passiveMatches.mockClear()
    updates.mockClear()
    assembler.rebuildRegistry()
    assembler.flush()

    expect(matches).toHaveBeenCalledTimes(5)
    expect(passiveMatches).toHaveBeenCalledTimes(5)
    expect(updates).toHaveBeenCalledTimes(3)
    expect(updates.mock.calls.filter(([, match]) => (
      match.event.type === 'assistant/live-chunk'
    ))).toHaveLength(1)
  })

  it('settles one Assistant attempt without replacing unrelated Contexts', () => {
    interface State { readonly events: readonly string[] }
    const definition: ConversationNodeDefinition<State> = {
      kind: 'assistant-settlement',
      target: 'test',
      match: (event) => {
        if (event.type === 'step/start') {
          return { id: `${String(event.data.turn)}:${String(event.data.step)}`, role: 'start' }
        }
        if (event.type === 'assistant/live-chunk'
          || event.type === 'assistant/message'
          || event.type === 'assistant/attempt'
          || event.type === 'llm/retry') {
          return { id: `${String(event.data.turn)}:${String(event.data.step)}`, role: 'update' }
        }
        return null
      },
      start: () => ({ events: [] }),
      update: (context, match) => ({
        events: [...context.state.events, match.event.type],
      }),
      buildViewNode: context => context.state === undefined
        ? null
        : node(context, context.state.events),
    }
    const apply = vi.fn()
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([definition]),
      new TestViewDefinitions([testView(apply)]),
    )
    const firstStart = input(at(SessionSeq(10), 'step/start', { turn: 2, step: 3 }))
    const secondStart = input(at(SessionSeq(11), 'step/start', { turn: 2, step: 4 }))
    const delta = transientChunk(11.5, 2, 3, { type: 'text-delta', index: 0, text: 'abc' })
    const later = input(at(SessionSeq(13), 'llm/retry', { turn: 2, step: 3 }))
    assembler.replaceWindow([firstStart, secondStart, delta, later], false)
    assembler.flush()
    const before = [...testSnapshot(assembler)?.nodes.values() ?? []]
    const unaffected = before.find(candidate => candidate.id === '2:4')
    expect(unaffected).toBeDefined()
    apply.mockClear()
    const settlementEvent = at(SessionSeq(12), 'assistant/message', {
      turn: 2,
      step: 3,
      message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
      stream: [],
    })
    if (settlementEvent.type !== 'assistant/message') throw new Error('expected Assistant settlement')
    const settlement = { type: 'event' as const, event: settlementEvent }

    expect(assembler.settleAssistant(LlmAttemptId('test-attempt'), settlement)).toBe('immediate')
    assembler.flush()

    const after = [...testSnapshot(assembler)?.nodes.values() ?? []]
    expect(after.find(candidate => candidate.id === '2:3')?.data)
      .toEqual(['assistant/message', 'llm/retry'])
    expect(after.find(candidate => candidate.id === '2:4')).toBe(unaffected)
    expect(apply).toHaveBeenCalledOnce()
    expect(apply.mock.calls[0]?.[0]).toHaveLength(1)

    assembler.append(transientChunk(13.5, 2, 3, { type: 'reasoning-delta', index: 0, text: 'x' }))
    assembler.flush()
    expect(assembler.settleAssistant(LlmAttemptId('test-attempt'))).toBe('immediate')
    assembler.flush()
    expect([...testSnapshot(assembler)?.nodes.values() ?? []]
      .find(candidate => candidate.id === '2:3')?.data)
      .toEqual(['assistant/message', 'llm/retry'])
  })

  it('replays one pending transient Match after prepend supplies its durable start', () => {
    const starts = vi.fn(() => ({ batches: 0, status: 'unresolved' }))
    const updates = vi.fn((
      context: ConversationNodeContext<{ batches: number; status: string }> & {
        readonly state: { batches: number; status: string }
      },
      match: ConversationMatch,
    ) => ({
      batches: context.state.batches + 1,
      status: match.location.kind === 'step' ? match.location.step.status : match.location.kind,
    }))
    const definition: ConversationNodeDefinition<{ batches: number; status: string }> = {
      kind: 'transient-pending',
      match: (event) => {
        if (event.type === 'step/start') {
          return { id: `${String(event.data.turn)}:${String(event.data.step)}`, role: 'start' }
        }
        if (event.type === 'assistant/live-chunk') {
          return { id: `${String(event.data.turn)}:${String(event.data.step)}`, role: 'update' }
        }
        return null
      },
      start: starts,
      update: updates,
      target: 'test',
      buildViewNode: context => context.state === undefined
        ? null
        : node(context, {
          ...context.state,
          matches: context.matches.map(match => [match.event.type, match.event.seq]),
        }),
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([definition]),
      new TestViewDefinitions([testView()]),
    )
    const delta = transientChunk(21, 4, 5, { type: 'reasoning-delta', index: 0, text: 'x' })

    assembler.replaceWindow([delta], true)
    assembler.flush()

    expect(starts).not.toHaveBeenCalled()
    expect(updates).not.toHaveBeenCalled()
    expect(testSnapshot(assembler)?.order).toEqual([])

    assembler.prepend([
      input(at(SessionSeq(20), 'step/start', { turn: 4, step: 5 })),
    ], false)
    assembler.flush()

    expect(starts).toHaveBeenCalledOnce()
    expect(updates).toHaveBeenCalledOnce()
    expect([...testSnapshot(assembler)?.nodes.values() ?? []][0]?.data).toEqual({
      batches: 1,
      status: 'open',
      matches: [['step/start', 20], ['assistant/live-chunk', 21]],
    })
  })

  it('rejects a transient event classified as a Context start', () => {
    const definition: ConversationNodeDefinition<null> = {
      kind: 'invalid-transient-start',
      match: event => event.type === 'assistant/live-chunk'
        ? { id: 'one', role: 'start' }
        : null,
      start: () => null,
      update: context => context.state,
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([definition]),
      new TestViewDefinitions([testView()]),
    )
    const delta = transientChunk(1, 1, 1, { type: 'text-delta', index: 0, text: 'abc' })

    expect(() => assembler.replaceWindow([delta], false)).toThrow(
      'conversation Context 23:invalid-transient-startone received a transient start Match',
    )
  })

  it('merges an older page and replays its affected Context once', () => {
    const starts = vi.fn(() => 0)
    const updates = vi.fn((context: ConversationNodeContext<number> & { readonly state: number }) => (
      context.state + 1
    ))
    const definition: ConversationNodeDefinition<number> = {
      kind: 'prepend-linear',
      match: (event) => {
        const type: string = event.type
        if (type === 'linear/start') return { id: 'one', role: 'start' }
        if (type === 'linear/update') return { id: 'one', role: 'update' }
        return null
      },
      start: starts,
      update: updates,
      target: 'test',
      buildViewNode: context => node(context, context.state),
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([definition]),
      new TestViewDefinitions([testView()]),
    )
    const current = Array.from({ length: 100 }, (_, index) => (
      input(at(SessionSeq(index + 102), 'linear/update', {}))
    ))
    assembler.replaceWindow(current, true)
    assembler.flush()
    expect(starts).not.toHaveBeenCalled()
    expect(updates).not.toHaveBeenCalled()

    const older = [
      input(at(SessionSeq(1), 'linear/start', {})),
      ...Array.from({ length: 100 }, (_, index) => (
        input(at(SessionSeq(index + 2), 'linear/update', {}))
      )),
    ]
    assembler.prepend(older, false)
    assembler.flush()

    expect(starts).toHaveBeenCalledOnce()
    expect(updates).toHaveBeenCalledTimes(200)
    expect([...testSnapshot(assembler)?.nodes.values() ?? []][0]?.data).toBe(200)
  })

  it('collects an update before its start and replays it once prepend supplies the start', () => {
    const updates = vi.fn((context: { state: { settled: boolean } }) => ({ ...context.state, settled: true }))
    const definition: ConversationNodeDefinition<{ settled: boolean }> = {
      kind: 'tool',
      match: (event) => {
        if (event.type === 'tool/call') return { id: String(event.data.callId), role: 'start' }
        if (event.type === 'tool/result') return { id: String(event.data.message.source.callId), role: 'update' }
        return null
      },
      start: () => ({ settled: false }),
      update: updates,
      target: 'test',
      buildViewNode: context => node(context, context.state ?? { pendingStart: true }),
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([definition]),
      new TestViewDefinitions([testView()]),
    )
    assembler.replaceWindow([input(at(SessionSeq(10), 'tool/result', {
      turn: 1,
      step: 1,
      message: { source: { type: 'tool-result', callId: 'a' }, content: [], isError: false },
    }))], true)
    assembler.flush()
    expect([...testSnapshot(assembler)?.nodes.values() ?? []][0]?.data)
      .toEqual({ pendingStart: true })

    assembler.prepend([input(at(SessionSeq(5), 'tool/call', {
      turn: 1, step: 1, callId: 'a', name: 'x', arguments: '{}',
    }))], false)
    assembler.flush()

    expect(updates).toHaveBeenCalledOnce()
    expect([...testSnapshot(assembler)?.nodes.values() ?? []][0]?.data)
      .toEqual({ settled: true })
  })

  it('rejects a Definition whose declared start follows an update in log order', () => {
    const definition: ConversationNodeDefinition<null> = {
      kind: 'invalid-lifecycle',
      match: event => event.type === 'turn/end'
        ? { id: 'one', role: 'start' }
        : event.type === 'turn/start' ? { id: 'one', role: 'update' } : null,
      start: () => null,
      update: context => context.state,
      target: 'test',
      buildViewNode: () => null,
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([definition]),
      new TestViewDefinitions([testView()]),
    )

    expect(() => assembler.replaceWindow([
      input(at(SessionSeq(1), 'turn/start', { turn: 1 })),
      input(at(SessionSeq(2), 'turn/end', { turn: 1, reason: { kind: 'completed' } })),
    ], false)).toThrow('received an update before its start Match')
  })

  it('replays a window-gap reader when prepend supplies a nearer predecessor', () => {
    const source: ConversationNodeDefinition<number> = {
      kind: 'source',
      match: event => event.type === 'user/message'
        ? { id: String(event.data.id), role: 'start' }
        : null,
      start: (_context, match) => Number((match.event.data as { value?: unknown }).value ?? 0),
      update: context => context.state,
      target: 'test',
      buildViewNode: () => null,
    }
    const consumerStart = vi.fn((
      _context: Parameters<ConversationNodeDefinition<number>['start']>[0],
      _match: Parameters<ConversationNodeDefinition<number>['start']>[1],
      reader: Parameters<ConversationNodeDefinition<number>['start']>[2],
    ) => reader.previous<number>('source')?.state ?? -1)
    const consumer: ConversationNodeDefinition<number> = {
      kind: 'consumer',
      match: event => event.type === 'assistant/message'
        ? { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
        : null,
      start: consumerStart,
      update: context => context.state,
      target: 'test',
      buildViewNode: context => node(context, context.state),
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([source, consumer]),
      new TestViewDefinitions([testView()]),
    )
    assembler.replaceWindow([input(at(SessionSeq(10), 'assistant/message', {
      turn: 2, step: 1, message: { role: 'assistant', content: [] },
      stream: [],
    }))], true)
    assembler.flush()
    expect([...testSnapshot(assembler)?.nodes.values() ?? []][0]?.data).toBe(-1)

    assembler.prepend([input(at(SessionSeq(5), 'user/message', {
      id: 'm1', value: 7, content: [], source: { kind: 'user' },
    }))], false)
    assembler.flush()

    expect(consumerStart).toHaveBeenCalledTimes(2)
    expect([...testSnapshot(assembler)?.nodes.values() ?? []][0]?.data).toBe(7)
  })

  it('keeps the predecessor index ordered across prepend and append', () => {
    const source: ConversationNodeDefinition<number> = {
      kind: 'source',
      match: event => event.type === 'user/message'
        ? { id: String(event.data.id), role: 'start' }
        : null,
      start: (_context, match) => match.event.seq,
      update: context => context.state,
      target: 'test',
      buildViewNode: () => null,
    }
    const consumer: ConversationNodeDefinition<number> = {
      kind: 'consumer',
      match: event => event.type === 'assistant/message'
        ? { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
        : null,
      start: (_context, _match, reader) => reader.previous<number>('source')?.state ?? -1,
      update: context => context.state,
      target: 'test',
      buildViewNode: context => node(context, context.state),
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([source, consumer]),
      new TestViewDefinitions([testView()]),
    )
    assembler.replaceWindow([
      input(at(SessionSeq(40), 'user/message', { id: 'm40', content: [], source: { kind: 'user' } })),
      input(at(SessionSeq(50), 'assistant/message', {
        turn: 1, step: 1, message: { role: 'assistant', content: [] },
        stream: [],
      })),
    ], true)
    assembler.flush()

    assembler.prepend([
      input(at(SessionSeq(10), 'user/message', { id: 'm10', content: [], source: { kind: 'user' } })),
      input(at(SessionSeq(30), 'user/message', { id: 'm30', content: [], source: { kind: 'user' } })),
    ], false)
    assembler.flush()
    assembler.append(input(at(SessionSeq(60), 'user/message', {
      id: 'm60', content: [], source: { kind: 'user' },
    })))
    assembler.append(input(at(SessionSeq(70), 'assistant/message', {
      turn: 2, step: 1, message: { role: 'assistant', content: [] },
      stream: [],
    })))
    assembler.flush()

    expect([...testSnapshot(assembler)?.nodes.values() ?? []].map(value => value.data))
      .toEqual([40, 60])
  })

  it('replays a window-gap reader when an empty prepend closes the unknown prefix', () => {
    const consumerStart = vi.fn((
      _context: Parameters<ConversationNodeDefinition<number>['start']>[0],
      _match: Parameters<ConversationNodeDefinition<number>['start']>[1],
      reader: Parameters<ConversationNodeDefinition<number>['start']>[2],
    ) => reader.previous<number>('source')?.state ?? -1)
    const consumer: ConversationNodeDefinition<number> = {
      kind: 'consumer',
      match: event => event.type === 'assistant/message'
        ? { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
        : null,
      start: consumerStart,
      update: context => context.state,
      target: 'test',
      buildViewNode: context => node(context, context.state),
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([consumer]),
      new TestViewDefinitions([testView()]),
    )
    assembler.replaceWindow([input(at(SessionSeq(10), 'assistant/message', {
      turn: 2, step: 1, message: { role: 'assistant', content: [] },
      stream: [],
    }))], true)
    assembler.flush()

    expect(assembler.prepend([], false)).toBe('immediate')
    assembler.flush()

    expect(consumerStart).toHaveBeenCalledTimes(2)
    expect([...testSnapshot(assembler)?.nodes.values() ?? []][0]?.data).toBe(-1)
  })

  it('replays direct dependents when an append revises their predecessor Context', () => {
    const source: ConversationNodeDefinition<number> = {
      kind: 'source',
      match: (event) => {
        if (event.type === 'user/message') return { id: 'one', role: 'start' }
        if ((event.type as string) === 'source/update') return { id: 'one', role: 'update' }
        return null
      },
      start: () => 1,
      update: (_context, match) => (match.event.data as unknown as { value: number }).value,
      target: 'test',
      buildViewNode: () => null,
    }
    const consumerStart = vi.fn((
      _context: Parameters<ConversationNodeDefinition<number>['start']>[0],
      _match: Parameters<ConversationNodeDefinition<number>['start']>[1],
      reader: Parameters<ConversationNodeDefinition<number>['start']>[2],
    ) => reader.previous<number>('source')?.state ?? -1)
    const consumer: ConversationNodeDefinition<number> = {
      kind: 'consumer',
      match: event => event.type === 'assistant/message'
        ? { id: 'one', role: 'start' }
        : null,
      start: consumerStart,
      update: context => context.state,
      target: 'test',
      buildViewNode: context => node(context, context.state),
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([source, consumer]),
      new TestViewDefinitions([testView()]),
    )
    assembler.replaceWindow([
      input(at(SessionSeq(1), 'user/message', { id: 'source', content: [], source: { kind: 'user' } })),
      input(at(SessionSeq(2), 'assistant/message', {
        turn: 1, step: 1, message: { role: 'assistant', content: [] }, stream: [],
      })),
    ], false)
    assembler.flush()

    expect(assembler.append(input(at(SessionSeq(3), 'source/update', { value: 2 })))).toBe('immediate')
    assembler.flush()

    expect(consumerStart).toHaveBeenCalledTimes(2)
    expect([...testSnapshot(assembler)?.nodes.values() ?? []][0]?.data).toBe(2)
  })

  it('replays a transitive dependency closure in start order', () => {
    const sourceA: ConversationNodeDefinition<number> = {
      kind: 'diamond-a',
      match: (event) => {
        if (event.type === 'user/message') return { id: 'one', role: 'start' }
        if ((event.type as string) === 'diamond/a') return { id: 'one', role: 'update' }
        return null
      },
      start: () => 1,
      update: (_context, match) => (match.event.data as unknown as { value: number }).value,
      target: 'test',
      buildViewNode: () => null,
    }
    const sourceX: ConversationNodeDefinition<number> = {
      kind: 'diamond-x',
      match: (event) => {
        if (event.type === 'turn/start') return { id: 'one', role: 'start' }
        if ((event.type as string) === 'diamond/x') return { id: 'one', role: 'update' }
        return null
      },
      start: () => 10,
      update: (_context, match) => (match.event.data as unknown as { value: number }).value,
      target: 'test',
      buildViewNode: () => null,
    }
    const middle: ConversationNodeDefinition<number> = {
      kind: 'diamond-b',
      match: event => event.type === 'assistant/message'
        ? { id: 'one', role: 'start' }
        : null,
      start: (_context, _match, reader) => (
        (reader.previous<number>('diamond-a')?.state ?? 0)
        + (reader.previous<number>('diamond-x')?.state ?? 0)
      ),
      update: context => context.state,
      target: 'test',
      buildViewNode: context => node(context, context.state),
    }
    const consumer: ConversationNodeDefinition<number> = {
      kind: 'diamond-c',
      match: event => event.type === 'tool/call'
        ? { id: 'one', role: 'start' }
        : null,
      start: (_context, _match, reader) => (
        (reader.previous<number>('diamond-a')?.state ?? 0) * 100
        + (reader.previous<number>('diamond-b')?.state ?? 0)
      ),
      update: context => context.state,
      target: 'test',
      buildViewNode: context => node(context, context.state),
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([sourceA, sourceX, middle, consumer]),
      new TestViewDefinitions([testView()]),
    )
    assembler.replaceWindow([
      input(at(SessionSeq(1), 'user/message', { id: 'source', content: [], source: { kind: 'user' } })),
      input(at(SessionSeq(2), 'turn/start', { turn: 1 })),
      input(at(SessionSeq(3), 'assistant/message', {
        turn: 1, step: 1, message: { role: 'assistant', content: [] }, stream: [],
      })),
      input(at(SessionSeq(4), 'tool/call', { turn: 1, step: 1, callId: 'call', name: 'x', arguments: '{}' })),
    ], false)

    assembler.append(input(at(SessionSeq(5), 'diamond/x', { value: 20 })))
    assembler.append(input(at(SessionSeq(6), 'diamond/a', { value: 2 })))
    assembler.flush()

    const value = [...testSnapshot(assembler)?.nodes.values() ?? []]
      .find(candidate => candidate.kind === 'diamond-c')
    expect(value?.data).toBe(222)
  })

  it('replays Location-derived State and rebuilds only owned Nodes when a step closes', () => {
    const apply = vi.fn()
    const starts = vi.fn((
      _context: Parameters<ConversationNodeDefinition<string>['start']>[0],
      match: Parameters<ConversationNodeDefinition<string>['start']>[1],
    ) => match.location.kind === 'step' ? match.location.step.status : 'missing')
    const definition: ConversationNodeDefinition<string> = {
      kind: 'step',
      match: event => event.type === 'step/start'
        ? { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
        : null,
      start: starts,
      update: context => context.state,
      target: 'test',
      buildViewNode: context => node(context, context.state),
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([definition]),
      new TestViewDefinitions([testView(apply)]),
    )
    assembler.replaceWindow([
      input(at(SessionSeq(1), 'turn/start', { turn: 1 })),
      input(at(SessionSeq(2), 'step/start', { turn: 1, step: 1 })),
    ], false)
    assembler.flush()
    expect([...testSnapshot(assembler)?.nodes.values() ?? []][0]?.data).toBe('open')

    assembler.append(input(at(SessionSeq(3), 'step/end', { turn: 1, step: 1 })))
    assembler.flush()

    expect(starts).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenCalledOnce()
    expect([...testSnapshot(assembler)?.nodes.values() ?? []][0]?.data).toBe('closed')
  })

  it('lets one Context publish Step and Turn data in phase order', () => {
    interface State {
      readonly turn: number
      readonly step: number
      readonly value: number
    }

    const definition: ConversationNodeDefinition<State> = {
      kind: 'scope-probe',
      match: (event) => {
        if (event.type === 'step/start') {
          return { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
        }
        if ((event.type as string) === 'scope-probe/update') {
          return { id: '1:1', role: 'update' }
        }
        return null
      },
      start: (_context, match) => {
        if (match.event.type !== 'step/start') throw new Error('scope probe requires step/start')
        return { turn: match.event.data.turn, step: match.event.data.step, value: 1 }
      },
      update: (_context, match) => ({
        turn: 1,
        step: 1,
        value: (match.event.data as unknown as { value: number }).value,
      }),
      buildLocationData: (context, scope) => {
        const state = context.state
        if (state === undefined) return null
        if (scope === 'step') {
          return {
            kind: 'step',
            turn: state.turn,
            step: state.step,
            key: 'scope-probe',
            value: { value: state.value },
          }
        }
        const location = context.start?.location
        const stepValue = location?.kind === 'step'
          ? location.step.data.get('scope-probe')?.value
          : undefined
        return {
          kind: 'turn',
          turn: state.turn,
          key: 'scope-probe',
          value: { valueSeenFromStep: stepValue ?? -1 },
        }
      },
      target: 'test',
      buildViewNode: (context) => {
        const location = context.start?.location
        if (location?.kind !== 'step') return null
        return node(context, {
          step: location.step.data.get('scope-probe')?.value,
          turn: location.turn.data.get('scope-probe')?.valueSeenFromStep,
        })
      },
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([definition]),
      new TestViewDefinitions([testView()]),
    )
    assembler.replaceWindow([
      input(at(SessionSeq(1), 'turn/start', { turn: 1 })),
      input(at(SessionSeq(2), 'step/start', { turn: 1, step: 1 })),
    ], false)
    assembler.flush()
    expect([...testSnapshot(assembler)?.nodes.values() ?? []][0]?.data)
      .toEqual({ step: 1, turn: 1 })

    assembler.append(input(at(SessionSeq(3), 'scope-probe/update', { turn: 1, step: 1, value: 2 })))
    assembler.flush()

    expect([...testSnapshot(assembler)?.nodes.values() ?? []][0]?.data)
      .toEqual({ step: 2, turn: 2 })
  })

  it('does not republish an equivalent Location value', () => {
    const apply = vi.fn()
    const initialValue = { value: 1 }
    const changedValue = { value: 2 }
    const definition: ConversationNodeDefinition<{ readonly value: ScopeProbeStepData }> = {
      kind: 'scope-probe',
      match: (event) => {
        if (event.type === 'step/start') return { id: '1:1', role: 'start' }
        if ((event.type as string) === 'scope-probe/update') return { id: '1:1', role: 'update' }
        return null
      },
      start: () => ({ value: initialValue }),
      update: (_context, match) => ({
        value: (match.event.data as unknown as { changed: boolean }).changed
          ? changedValue
          : initialValue,
      }),
      buildLocationData: (context, scope, previous) => {
        if (scope !== 'step' || context.state === undefined) return null
        if (previous?.kind === 'step'
          && previous.turn === 1
          && previous.step === 1
          && previous.key === 'scope-probe'
          && previous.value === context.state.value) return previous
        return { kind: 'step', turn: 1, step: 1, key: 'scope-probe', value: context.state.value }
      },
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([definition]),
      new TestViewDefinitions([testView(apply)]),
    )
    assembler.replaceWindow([
      input(at(SessionSeq(1), 'turn/start', { turn: 1 })),
      input(at(SessionSeq(2), 'step/start', { turn: 1, step: 1 })),
    ], false)
    assembler.flush()

    assembler.append(input(at(SessionSeq(3), 'scope-probe/update', { turn: 1, step: 1, changed: false })))
    expect(assembler.flush()).toBe(false)
    expect(apply).not.toHaveBeenCalled()

    assembler.append(input(at(SessionSeq(4), 'scope-probe/update', { turn: 1, step: 1, changed: true })))
    expect(assembler.flush()).toBe(true)
    expect(apply).toHaveBeenCalledOnce()
  })

  it('updates existing turn Locations when their Step membership changes', () => {
    const apply = vi.fn()
    const definition: ConversationNodeDefinition<null> = {
      kind: 'turn-probe',
      match: event => event.type === 'turn/start'
        ? { id: String(event.data.turn), role: 'start' }
        : null,
      start: () => null,
      update: context => context.state,
      target: 'test',
      buildViewNode: context => node(context, context.start?.location.kind === 'turn'
        ? context.start.location.turn.steps.length
        : -1),
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([definition]),
      new TestViewDefinitions([testView(apply)]),
    )
    assembler.replaceWindow([input(at(SessionSeq(1), 'turn/start', { turn: 1 }))], false)
    assembler.flush()
    expect([...testSnapshot(assembler)?.nodes.values() ?? []][0]?.data).toBe(0)

    assembler.append(input(at(SessionSeq(2), 'step/start', { turn: 1, step: 1 })))
    assembler.flush()

    expect(apply).toHaveBeenCalledOnce()
    expect([...testSnapshot(assembler)?.nodes.values() ?? []][0]?.data).toBe(1)
  })

  it('publishes a changed timeline even when no business Definition claims the boundary', () => {
    const apply = vi.fn()
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([]),
      new TestViewDefinitions([testView(apply)]),
    )
    assembler.replaceWindow([], false)
    assembler.flush()

    assembler.append(input(at(SessionSeq(1), 'turn/start', { turn: 1 })))
    assembler.flush()

    expect(apply).toHaveBeenCalledOnce()
    expect(testSnapshot(assembler)?.order).toEqual([])
  })

  it('clears the prior Step at a new Turn and honors explicit session ownership', () => {
    const definition: ConversationNodeDefinition<null> = {
      kind: 'location-probe',
      match: (event) => {
        if ((event.type as string) === 'command/run') {
          return {
            id: (event.data as unknown as { commandId: string }).commandId,
            role: 'start',
          }
        }
        if ((event.type as string) === 'compaction/start') {
          return {
            id: (event.data as unknown as { compactionId: string }).compactionId,
            role: 'start',
          }
        }
        return null
      },
      start: () => null,
      update: context => context.state,
      target: 'test',
      buildViewNode: (context) => {
        const location = context.start?.location
        const data = location?.kind === 'step'
          ? `step:${location.turn.turn}:${location.step.step}`
          : location?.kind === 'turn' ? `turn:${location.turn.turn}` : location?.kind
        return node(context, data)
      },
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([definition]),
      new TestViewDefinitions([testView()]),
    )
    assembler.replaceWindow([
      input(at(SessionSeq(1), 'turn/start', { turn: 1 })),
      input(at(SessionSeq(2), 'step/start', { turn: 1, step: 1 })),
      input(at(SessionSeq(3), 'turn/start', { turn: 2 })),
      input(at(SessionSeq(4), 'command/run', { commandId: 'command', name: 'x' })),
      input(at(SessionSeq(5), 'compaction/start', { compactionId: 'compact', turn: null })),
    ], false)
    assembler.flush()

    expect([...testSnapshot(assembler)?.nodes.values() ?? []].map(value => value.data))
      .toEqual(['turn:2', 'session'])
  })

  it('assigns turn boundaries to the Turn even when a Step remains open', () => {
    const definition: ConversationNodeDefinition<null> = {
      kind: 'turn-boundary-probe',
      match: event => event.type === 'turn/end'
        ? { id: String(event.data.turn), role: 'start' }
        : null,
      start: () => null,
      update: context => context.state,
      target: 'test',
      buildViewNode: context => node(context, context.start?.location.kind),
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([definition]),
      new TestViewDefinitions([testView()]),
    )
    assembler.replaceWindow([
      input(at(SessionSeq(1), 'turn/start', { turn: 1 })),
      input(at(SessionSeq(2), 'step/start', { turn: 1, step: 1 })),
    ], false)
    assembler.flush()

    assembler.append(input(at(SessionSeq(3), 'turn/end', { turn: 1, reason: { kind: 'aborted' } })))
    assembler.flush()

    expect([...testSnapshot(assembler)?.nodes.values() ?? []][0]?.data).toBe('turn')
  })

  it('carries explicit coordinates across coordinate-free events in a partial window and live tail', () => {
    const definition: ConversationNodeDefinition<null> = {
      kind: 'location-probe',
      match: event => (event.type as string) === 'tool/code-dispatch-start'
        ? { id: String(event.seq), role: 'start' }
        : null,
      start: () => null,
      update: context => context.state,
      target: 'test',
      buildViewNode: (context) => {
        const location = context.start?.location
        return node(context, location?.kind === 'step'
          ? `${location.turn.turn}:${location.step.step}`
          : location?.kind)
      },
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([definition]),
      new TestViewDefinitions([testView()]),
    )
    assembler.replaceWindow([
      input(at(SessionSeq(10), 'tool/call', { turn: 2, step: 3, callId: 'root', name: 'x', arguments: '{}' })),
      input(at(SessionSeq(11), 'tool/code-dispatch-start', { rootCallId: 'root', subCallId: 'a' })),
    ], true)
    assembler.flush()

    assembler.append(input(at(SessionSeq(12), 'tool/code-dispatch-start', { rootCallId: 'root', subCallId: 'b' })))
    assembler.flush()

    expect([...testSnapshot(assembler)?.nodes.values() ?? []].map(value => value.data))
      .toEqual(['2:3', '2:3'])
  })

  it('treats loaded end boundaries as closed when their starts precede the window', () => {
    const definition: ConversationNodeDefinition<null> = {
      kind: 'location-probe',
      match: event => event.type === 'tool/call'
        ? { id: String(event.data.callId), role: 'start' }
        : null,
      start: () => null,
      update: context => context.state,
      target: 'test',
      buildViewNode: (context) => {
        const location = context.start?.location
        return node(context, location?.kind === 'step'
          ? `${location.turn.status}:${location.step.status}`
          : location?.kind)
      },
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([definition]),
      new TestViewDefinitions([testView()]),
    )
    assembler.replaceWindow([
      input(at(SessionSeq(10), 'tool/call', { turn: 2, step: 3, callId: 'root', name: 'x', arguments: '{}' })),
      input(at(SessionSeq(11), 'step/end', { turn: 2, step: 3 })),
      input(at(SessionSeq(12), 'turn/end', { turn: 2, reason: { kind: 'completed' } })),
    ], true)
    assembler.flush()

    expect([...testSnapshot(assembler)?.nodes.values() ?? []][0]?.data)
      .toBe('closed:closed')
  })

  it('restarts State creation from undefined when Location changes replay a Context', () => {
    const seen = vi.fn((context: Parameters<ConversationNodeDefinition<number>['start']>[0]) => {
      expect(context.state).toBeUndefined()
      return 1
    })
    const definition: ConversationNodeDefinition<number> = {
      kind: 'replay-probe',
      match: event => event.type === 'step/start'
        ? { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
        : null,
      start: seen,
      update: context => context.state,
      target: 'test',
      buildViewNode: context => node(context, context.state),
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([definition]),
      new TestViewDefinitions([testView()]),
    )
    assembler.replaceWindow([input(at(SessionSeq(1), 'step/start', { turn: 1, step: 1 }))], false)
    assembler.flush()

    assembler.append(input(at(SessionSeq(2), 'step/end', { turn: 1, step: 1 })))
    assembler.flush()

    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('invokes the fallback when only a State-only Definition claims an event', () => {
    const fallbackStart = vi.fn(() => 'fallback')
    const claimed: ConversationNodeDefinition<null> = {
      kind: 'claimed-state',
      match: event => (event.type as string) === 'command/run'
        ? { id: 'claimed', role: 'start' }
        : null,
      start: () => null,
      update: context => context.state,
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([claimed], fallbackDefinition(fallbackStart)),
      new TestViewDefinitions([testView()]),
    )

    assembler.replaceWindow([input(at(SessionSeq(1), 'command/run', { commandId: 'one', name: 'x' }))], false)
    assembler.flush()

    expect(fallbackStart).toHaveBeenCalledOnce()
    expect(testSnapshot(assembler)?.order).toHaveLength(1)
  })

  it('invokes the fallback when only another target claims an event', () => {
    const fallbackStart = vi.fn(() => 'fallback')
    const claimed: ConversationNodeDefinition<null> = {
      kind: 'claimed-trajectory',
      target: 'trajectory',
      match: event => (event.type as string) === 'command/run'
        ? { id: 'claimed', role: 'start' }
        : null,
      start: () => null,
      update: context => context.state,
      buildViewNode: () => null,
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([claimed], fallbackDefinition(fallbackStart)),
      new TestViewDefinitions([testView()]),
    )

    assembler.replaceWindow([input(at(SessionSeq(1), 'command/run', { commandId: 'one', name: 'x' }))], false)
    assembler.flush()

    expect(fallbackStart).toHaveBeenCalledOnce()
    expect(testSnapshot(assembler)?.order).toHaveLength(1)
  })

  it('suppresses the fallback when the same target claims an event', () => {
    const fallbackStart = vi.fn(() => 'fallback')
    const claimed: ConversationNodeDefinition<null> = {
      kind: 'claimed',
      target: 'test',
      match: event => (event.type as string) === 'command/run' ? { id: 'claimed', role: 'start' } : null,
      start: () => null,
      update: context => context.state,
      buildViewNode: () => null,
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([claimed], fallbackDefinition(fallbackStart)),
      new TestViewDefinitions([testView()]),
    )
    assembler.replaceWindow([input(at(SessionSeq(1), 'command/run', { commandId: 'one', name: 'x' }))], false)
    assembler.flush()

    expect(fallbackStart).not.toHaveBeenCalled()
    expect(testSnapshot(assembler)?.order).toEqual([])
  })

  it('rejects withdrawing a previously materialized Node during an incremental update', () => {
    const definition: ConversationNodeDefinition<boolean> = {
      kind: 'toggle',
      match: (event) => {
        if ((event.type as string) === 'command/run') return { id: 'one', role: 'start' }
        if ((event.type as string) === 'toggle/hide') return { id: 'one', role: 'update' }
        return null
      },
      start: () => true,
      update: () => false,
      target: 'test',
      buildViewNode: context => context.state === true ? node(context, true) : null,
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([definition]),
      new TestViewDefinitions([testView()]),
    )
    assembler.replaceWindow([input(at(SessionSeq(1), 'command/run', { commandId: 'one', name: 'x' }))], false)
    assembler.flush()
    expect(testSnapshot(assembler)?.order).toHaveLength(1)

    assembler.append(input(at(SessionSeq(2), 'toggle/hide', {})))
    expect(() => assembler.flush()).toThrow(/withdrew materialized target "test"/)

    expect(testSnapshot(assembler)?.order).toHaveLength(1)
  })

  it('fails loud when a Definition returns undefined State', () => {
    const startUndefined: ConversationNodeDefinition = {
      kind: 'undefined-start',
      match: event => (event.type as string) === 'command/run' ? { id: 'one', role: 'start' } : null,
      start: () => undefined,
      update: context => context.state,
      target: 'test',
      buildViewNode: () => null,
    }
    const startAssembler = new ConversationNodeAssembler(
      new TestEventDefinitions([startUndefined]),
      new TestViewDefinitions([testView()]),
    )
    expect(() => startAssembler.replaceWindow([
      input(at(SessionSeq(1), 'command/run', { commandId: 'one', name: 'x' })),
    ], false)).toThrow(/Definition "undefined-start" returned undefined from start/)

    const updateUndefined: ConversationNodeDefinition<boolean> = {
      kind: 'undefined-update',
      match: (event) => {
        if ((event.type as string) === 'command/run') return { id: 'one', role: 'start' }
        if ((event.type as string) === 'command/done') return { id: 'one', role: 'update' }
        return null
      },
      start: () => true,
      update: () => undefined as never,
      target: 'test',
      buildViewNode: context => node(context, context.state),
    }
    const updateAssembler = new ConversationNodeAssembler(
      new TestEventDefinitions([updateUndefined]),
      new TestViewDefinitions([testView()]),
    )
    updateAssembler.replaceWindow([
      input(at(SessionSeq(1), 'command/run', { commandId: 'one', name: 'x' })),
    ], false)
    expect(() => updateAssembler.append(
      input(at(SessionSeq(2), 'command/done', { commandId: 'one', kind: 'success' })),
    )).toThrow(/Definition "undefined-update" returned undefined from update/)
  })

  it('rejects a duplicate start before mutating the existing Context', () => {
    const definition: ConversationNodeDefinition<number> = {
      kind: 'single-start',
      match: event => (event.type as string) === 'command/run' ? { id: 'one', role: 'start' } : null,
      start: (_context, match) => match.event.seq,
      update: context => context.state,
      target: 'test',
      buildViewNode: context => node(context, context.state),
    }
    const assembler = new ConversationNodeAssembler(
      new TestEventDefinitions([definition]),
      new TestViewDefinitions([testView()]),
    )
    assembler.replaceWindow([
      input(at(SessionSeq(1), 'command/run', { commandId: 'one', name: 'x' })),
    ], false)
    assembler.flush()

    expect(() => assembler.append(
      input(at(SessionSeq(2), 'command/run', { commandId: 'two', name: 'x' })),
    )).toThrow(/received more than one start Match/)
    assembler.flush()
    expect([...testSnapshot(assembler)?.nodes.values() ?? []][0]?.data).toBe(1)
  })
})
