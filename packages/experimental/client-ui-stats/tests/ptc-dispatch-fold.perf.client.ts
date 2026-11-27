/**
 * Opt-in, threshold-free inventory for the Statistics target's cost on one wide
 * PTC run: the fold of a root call's nested dispatches and the publication that
 * follows each of them.
 *
 * Run it with the manual Web perf inventory:
 *
 * ```sh
 * pnpm exec vitest run --config vitest.web.perf.config.ts \
 *   packages/experimental/client-ui-stats/tests/ptc-dispatch-fold.perf.client.ts
 * ```
 *
 * It reports one line under `STATS_PTC_PERF_RESULT` and asserts only structure,
 * so a slower machine changes the numbers, never the outcome. The diagnostic
 * never runs in CI.
 */

import { performance } from 'node:perf_hooks'
import { it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/types'
import type { SessionEventLike, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ConversationLocation, ConversationMatch, ConversationNodeContext, ConversationNodeDefinition,
  ConversationStartMatch, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CALL_LIMIT, foldEvent, stepMetrics } from '../src/client/stats-fold.ts'
import type { StatsSnapshot, StatsStepState, StatsViewNode } from '../src/client/stats-contract.ts'
import { registerStatsDefinitions } from '../src/client/stats-definition.ts'
import { statsViewDefinition } from '../src/client/stats-snapshot-builder.ts'

/** Nested subcalls one root call dispatches; one start and one settle event each. */
const CHILDREN = [1_000, 3_000, 10_000] as const

/** Publications timed per size; each rebuilds the same published prefix. */
const PUBLISH_SAMPLES = 50

/** Result text every dispatched subcall returns. */
const RESULT_TEXT = 'ok'

const TIME_ZERO = 1_700_000_000_000

/** Captured Definition and view registries the assembler consumes. */
interface Registrations {
  readonly events: readonly ConversationNodeDefinition[]
  readonly views: readonly ConversationViewDefinition[]
}

/** Register the Statistics Definitions against a stub registry. */
function registerStats(): Registrations {
  const events: ConversationNodeDefinition[] = []
  const ctx = new Context()
  ctx.provide('uiConversation', {
    events: {
      register: (definition: ConversationNodeDefinition) => {
        events.push(definition)
        return () => undefined
      },
    },
  } as never)
  registerStatsDefinitions(ctx)
  return { events, views: [statsViewDefinition] }
}

/** Registry over the Definitions captured from registration. */
class StatsEventDefinitions {
  constructor(private readonly definitions: readonly ConversationNodeDefinition[]) {}

  entries(): readonly ConversationNodeDefinition[] {
    return this.definitions
  }

  fallbackEntry(): undefined {
    return undefined
  }
}

/** Registry over the view targets captured from registration. */
class StatsViewDefinitions {
  constructor(private readonly definitions: readonly ConversationViewDefinition[]) {}

  entries(): readonly ConversationViewDefinition[] {
    return this.definitions
  }
}

let seq = 0

/** One durable event with an ascending sequence and a time derived from it. */
function event(type: string, data: unknown): SessionEventLike {
  seq += 1
  return { type, seq: SessionSeq(seq), time: TIME_ZERO + seq, data } as SessionEventLike
}

/** One fold entry around a durable event. */
function entry(item: SessionEventLike): SessionEventLikeEntry {
  return { type: 'event', event: item as SessionEvent }
}

/** One root `run_code` call that dispatches `children` settled subcalls. */
function ptcRun(children: number): readonly SessionEventLike[] {
  seq = 0
  const events: SessionEventLike[] = []
  const root = brandString<ToolCallId>('root')
  events.push(event('turn/start', { turn: 1 }))
  events.push(event('step/start', { turn: 1, step: 1 }))
  events.push(event('tool/call', { turn: 1, step: 1, callId: root, name: 'run_code', arguments: '{}' }))
  for (let child = 0; child < children; child += 1) {
    const subCallId = brandString<ToolCallId>(`sub-${String(child)}`)
    const args = { file_path: 'src/a.ts' }
    events.push(event('tool/ptc-dispatch-start', {
      rootCallId: root, parentCallId: root, subCallId, name: 'read', arguments: args,
    }))
    events.push(event('tool/ptc-dispatch', {
      rootCallId: root, parentCallId: root, subCallId, name: 'read', arguments: args,
      isError: false, content: [{ type: 'text', text: RESULT_TEXT }],
    }))
  }
  events.push(event('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      id: 'tool-root',
      content: [{ type: 'text', text: RESULT_TEXT }],
      source: { kind: 'tool', callId: root },
      isError: false,
    },
  }))
  events.push(event('step/end', { turn: 1, step: 1 }))
  events.push(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  return events
}

/** Fold every event into one state, as a single Code-Mode Context does. */
function fold(events: readonly SessionEventLike[]): StatsStepState {
  let state: StatsStepState | undefined
  const started = performance.now()
  for (const item of events) state = foldEvent(state, item)
  total = performance.now() - started
  if (state === undefined) throw new Error('the fold produced no state')
  return state
}

let total = 0

/** Timing of the fold just performed, in milliseconds. */
function foldMs(): number {
  return Math.round(total * 10) / 10
}

/** Location data store no hand-built Location in this diagnostic reads. */
const LOCATION_DATA = {
  get: () => undefined,
  source: () => ({ getSnapshot: () => undefined, subscribe: () => () => undefined }),
} as never

/** Fabricated Step Location carrying only the identity a Definition reads. */
function stepAt(turn: number, step: number): ConversationLocation {
  return {
    kind: 'step',
    turn: { turn, start: undefined, end: undefined, status: 'open', steps: [], data: LOCATION_DATA },
    step: { turn, step, start: undefined, end: undefined, status: 'unknown', data: LOCATION_DATA },
  }
}

/** Hand-built Context for one Definition, shaped as the assembler hands it over. */
function contextOf(
  definition: ConversationNodeDefinition<StatsStepState>,
  state: StatsStepState,
  start: ConversationStartMatch,
  matches: readonly ConversationMatch[],
): ConversationNodeContext<StatsStepState> {
  return {
    key: `${definition.kind}:fixture`,
    kind: definition.kind,
    id: 'fixture',
    matches,
    start,
    state,
    current: new Map(),
  }
}

/** One publication of the Code-Mode node: the first build and the repeats that follow it. */
interface PublishTiming {
  readonly firstMs: number
  readonly repeatMs: number
  readonly calls: readonly string[]
}

/** Time the first publication of the Code-Mode node and the amortized repeats. */
function publishTiming(
  definition: ConversationNodeDefinition<StatsStepState>,
  state: StatsStepState,
  start: ConversationStartMatch,
  matches: readonly ConversationMatch[],
): PublishTiming {
  const context = contextOf(definition, state, start, matches)
  const firstStarted = performance.now()
  const node = definition.buildViewNode?.(context) as StatsViewNode | undefined
  const firstMs = performance.now() - firstStarted
  const repeatStarted = performance.now()
  for (let sample = 0; sample < PUBLISH_SAMPLES; sample += 1) definition.buildViewNode?.(context)
  const repeatMs = (performance.now() - repeatStarted) / PUBLISH_SAMPLES
  if (node === undefined || node.data.kind !== 'inner') throw new Error('the Code-Mode node published no inner contribution')
  return {
    firstMs: Math.round(firstMs * 1000) / 1000,
    repeatMs: Math.round(repeatMs * 1000) / 1000,
    calls: node.data.calls.map(call => call.callId),
  }
}

/** One appended event window folded and published by the real assembler. */
function liveAppend(registrations: Registrations, events: readonly SessionEventLike[]): {
  ms: number
  publications: number
  calls: readonly string[]
} {
  const assembler = new ConversationNodeAssembler(
    new StatsEventDefinitions(registrations.events),
    new StatsViewDefinitions(registrations.views),
  )
  assembler.activateTarget('stats')
  let publications = 0
  const started = performance.now()
  for (const item of events) {
    if (assembler.append(entry(item)) !== 'none') {
      assembler.flush()
      publications += 1
    }
  }
  const ms = performance.now() - started
  const snapshot = assembler.snapshot('stats') as StatsSnapshot | undefined
  const step = snapshot?.turns[0]?.steps[0]
  if (snapshot === undefined || step === undefined) throw new Error('the live window published no step')
  return { ms: Math.round(ms), publications, calls: step.calls.map(call => call.callId) }
}

it('inventories the fold and publication of one wide PTC run', () => {
  const registrations = registerStats()
  const codeMode = registrations.events[3] as ConversationNodeDefinition<StatsStepState>
  const rows: object[] = []
  for (const children of CHILDREN) {
    const events = ptcRun(children)
    const state = fold(events)
    if (state.calls.size === 0) throw new Error('the fold recorded no call')
    const published = stepMetrics(state).calls
    const first = events[3] as SessionEventLike
    const last = events[events.length - 3] as SessionEventLike
    const start = { event: first, role: 'start', location: stepAt(1, 1) } as ConversationStartMatch
    const matches: ConversationMatch[] = [start, { event: last, role: 'update', location: stepAt(1, 1) }]
    const publication = publishTiming(codeMode, state, start, matches)
    const live = liveAppend(registrations, events)
    rows.push({
      children,
      events: events.length,
      foldMs: foldMs(),
      retainedCalls: state.calls.size,
      outstandingStarts: state.starts.size,
      publishMs: publication.firstMs,
      republishMs: publication.repeatMs,
      publishCalls: publication.calls.length,
      liveMs: live.ms,
      livePublications: live.publications,
      liveCalls: live.calls.length,
    })
    // Structure only: the bounded prefix the table renders, and the settled totals behind it.
    if (published.length !== Math.min(CALL_LIMIT, children + 1)) {
      throw new Error(`a ${String(children)}-subcall run listed ${String(published.length)} step calls`)
    }
    if (publication.calls.length !== Math.min(CALL_LIMIT, children + 1) - 1) {
      throw new Error(`a ${String(children)}-subcall run published ${String(publication.calls.length)} inner calls`)
    }
    if (live.calls.length > CALL_LIMIT || live.calls.length === 0) {
      throw new Error(`a ${String(children)}-subcall run published ${String(live.calls.length)} merged calls`)
    }
  }
  process.stdout.write(`STATS_PTC_PERF_RESULT ${JSON.stringify({ childrenPerRoot: CHILDREN, rows })}\n`)
})
