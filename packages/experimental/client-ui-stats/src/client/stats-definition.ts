/**
 * Conversation Definitions producing the performance target's nodes: one step
 * context per `step/start`, one prompt context per user message, one end marker
 * per turn, and one context per Code-Mode root call for its inner dispatches.
 *
 * Every callback is a pure function of the events it receives: turn and step
 * identity comes from the engine's match location, never from module state, so
 * one Definition set serves every Session binding and history paging
 * (`replaceWindow`/`prepend`) cannot misattribute events.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationLocation, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  StatsCompactionState, StatsEventMetrics, StatsStepState, StatsViewNode,
} from './stats-contract.ts'
import {
  CALL_LIMIT, fallbackState, foldEvent, isCodeMode, newState, promptOf, stepMetrics, triggerSenderOf,
} from './stats-fold.ts'
import {
  compactionEventId, compactionMetrics, foldCompaction, newCompactionState,
} from './stats-compaction.ts'
import { eventMetrics, locationTurnStep } from './stats-event.ts'

/** Target name shared by every Definition and the view builder. */
export const TARGET = 'stats'

/** Definition kind of one measured step. */
const STEP_KIND = 'stats-step'

/** Definition kind of one user prompt. */
const PROMPT_KIND = 'stats-prompt'

/** Definition kind of a turn's end marker. */
const END_KIND = 'stats-turn-end'

/** Definition kind of one Code-Mode root call's inner dispatches. */
const CODE_MODE_KIND = 'stats-code-mode'

/** Definition kind of one compaction transaction. */
const COMPACTION_KIND = 'stats-compaction'

/** Definition kind of one non-step event row. */
const EVENT_KIND = 'stats-event'

/** Marker ids never collide with a step number. */
const PROMPT_STEP = 0
const END_STEP = 100_000

/** Location a published node carries: the start match's, else the newest match's. */
function nodeLocation(context: ConversationNodeContext<StatsStepState>): ConversationLocation {
  return context.start?.location ?? context.matches.at(-1)?.location ?? { kind: 'unresolved' }
}

/** Wrap one contribution in the target's node envelope. */
function statsNode(
  context: ConversationNodeContext<StatsStepState>,
  anchorSeq: number,
  data: StatsViewNode['data'],
): StatsViewNode {
  return {
    key: context.key,
    kind: context.kind,
    id: context.id,
    target: TARGET,
    anchorSeq,
    location: nodeLocation(context),
    data,
  }
}

/** State a step-like Context folds from the matches a trimmed window still holds. */
function stepState(context: ConversationNodeContext<StatsStepState>): StatsStepState | undefined {
  return context.state ?? fallbackState(context.matches)
}

/** One measured step per `step/start`, updated by its stream, tools, and end. */
const stepDefinition: ConversationNodeDefinition<StatsStepState> = {
  kind: STEP_KIND,
  target: TARGET,
  match: (event) => {
    switch (event.type) {
      case 'step/start':
        return { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
      case 'step/end':
      case 'assistant/live-chunk':
      case 'assistant/attempt':
      case 'assistant/message':
      case 'llm/retry':
      case 'tool/call':
      case 'tool/result':
        return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
      default:
        return null
    }
  },
  start: (_context, match) => {
    if (match.event.type !== 'step/start') {
      throw new Error('stats-step start requires step/start')
    }
    return { ...newState(match.event.data.turn, match.event.data.step), startSeq: match.event.seq, startTime: match.event.time }
  },
  /* v8 ignore next -- the engine calls update only after start adopted a state, so folding never returns undefined here. */
  update: (context, match) => foldEvent(context.state, match.event) ?? context.state,
  publication: (match) => {
    if (match.event.type === 'step/start') return 'none'
    // Stream deltas drive no column of this table; the settled message does.
    if (match.event.type === 'assistant/live-chunk' || match.event.type === 'assistant/attempt') return 'none'
    return 'immediate'
  },
  buildViewNode: (context) => {
    const state = stepState(context)
    if (state === undefined) return null
    return statsNode(context, state.startSeq ?? context.start?.event.seq ?? 0, {
      kind: 'step',
      metrics: stepMetrics(state),
    })
  },
}

/** The trigger of one turn: one Context per `user/message`, classified by source. */
const promptDefinition: ConversationNodeDefinition<StatsStepState> = {
  kind: PROMPT_KIND,
  target: TARGET,
  match: event => (event.type === 'user/message'
    ? { id: `${event.seq}`, role: 'start' }
    : null),
  start: (_context, match) => {
    if (match.event.type !== 'user/message') {
      throw new Error('stats-prompt start requires user/message')
    }
    const located = locationTurnStep(match.location)
    const prompt = promptOf(match.event.data)
    return {
      ...newState(located?.turn ?? 0, PROMPT_STEP, 'prompt'),
      prompt: prompt.text,
      images: prompt.images,
      trigger: match.event.data.source.kind,
      triggerSender: triggerSenderOf(match.event.data),
    }
  },
  update: context => context.state,
  publication: () => 'immediate',
  buildViewNode: (context) => {
    const state = context.state
    const located = locationTurnStep(nodeLocation(context))
    if (state === undefined || located === null) return null
    return statsNode(context, context.start?.event.seq ?? 0, {
      kind: 'prompt',
      turn: located.turn,
      prompt: state.prompt,
      images: state.images,
      source: state.trigger ?? 'other',
      sender: state.triggerSender,
    })
  },
}

/** Closes a turn, including an interrupted tail whose last step never ended. */
const endDefinition: ConversationNodeDefinition<StatsStepState> = {
  kind: END_KIND,
  target: TARGET,
  match: event => (event.type === 'turn/end'
    ? { id: `${event.data.turn}:${END_STEP}`, role: 'start' }
    : null),
  start: (_context, match) => {
    if (match.event.type !== 'turn/end') {
      throw new Error('stats-turn-end start requires turn/end')
    }
    return {
      ...newState(match.event.data.turn, END_STEP, 'end'),
      ended: true,
      endTime: match.event.time,
      closed: true,
      closeKind: match.event.data.reason.kind,
    }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    return statsNode(context, context.start?.event.seq ?? 0, {
      kind: 'end',
      turn: state.turn,
      closeKind: state.closeKind,
      endTime: state.endTime,
    })
  },
}

/**
 * One Context per Code-Mode root call folds its inner dispatches; the builder
 * merges them into the owning step by the root call id. The events carry no
 * turn or step, so the Context takes both from the engine's match location.
 */
const codeModeDefinition: ConversationNodeDefinition<StatsStepState> = {
  kind: CODE_MODE_KIND,
  target: TARGET,
  match: (event) => {
    if (event.type !== 'tool/ptc-dispatch-start' && event.type !== 'tool/ptc-dispatch') return null
    return {
      id: `code:${event.data.rootCallId}`,
      role: event.type === 'tool/ptc-dispatch-start' ? 'start' : 'update',
    }
  },
  start: (_context, match) => {
    if (match.event.type !== 'tool/ptc-dispatch-start') {
      throw new Error('stats-code-mode start requires tool/ptc-dispatch-start')
    }
    const located = locationTurnStep(match.location)
    const base = located?.step === null || located === null
      ? newState(0, 0)
      : newState(located.turn, located.step)
    /* v8 ignore next -- folding a defined state always returns a state. */
    return foldEvent(base, match.event) ?? base
  },
  /* v8 ignore next -- the engine calls update only after start adopted a state, so folding never returns undefined here. */
  update: (context, match) => foldEvent(context.state, match.event) ?? context.state,
  buildViewNode: (context) => {
    const state = stepState(context)
    const located = locationTurnStep(nodeLocation(context))
    if (state === undefined || located?.step === null || located === null) return null
    const calls = stepMetrics(state).calls
      .filter(call => !isCodeMode(call.name))
      .slice(0, CALL_LIMIT)
    return statsNode(context, context.start?.event.seq ?? 0, {
      kind: 'inner',
      turn: located.turn,
      step: located.step,
      calls,
    })
  },
}

/** One synthetic row per compaction transaction, including its summary model call. */
const compactionDefinition: ConversationNodeDefinition<StatsCompactionState> = {
  kind: COMPACTION_KIND,
  target: TARGET,
  match: (event) => {
    const id = compactionEventId(event)
    if (id === null) return null
    return { id, role: event.type === 'compaction/start' ? 'start' : 'update' }
  },
  start: (_context, match) => {
    if (match.event.type !== 'compaction/start') {
      throw new Error('stats-compaction start requires compaction/start')
    }
    return newCompactionState(match.event)
  },
  update: (context, match) => foldCompaction(context.state, match.event),
  publication: () => 'immediate',
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    return {
      key: context.key,
      kind: context.kind,
      id: context.id,
      target: TARGET,
      anchorSeq: state.startSeq,
      /* v8 ignore next -- a live start match always carries a Location. */
      location: context.start?.location ?? { kind: 'unresolved' },
      data: { kind: 'compaction', metrics: compactionMetrics(state) },
    }
  },
}

/** One row per non-step event that explains request, prompt, tool, or prune changes. */
const eventDefinition: ConversationNodeDefinition<StatsEventMetrics> = {
  kind: EVENT_KIND,
  target: TARGET,
  match: event => (eventMetrics(event, undefined) === null
    ? null
    : { id: `${event.type}:${event.seq}`, role: 'start' }),
  start: (_context, match) => {
    const metrics = eventMetrics(match.event, match.location)
    /* v8 ignore next 2 -- match accepted only events this normalizer handles. */
    if (metrics === null) throw new Error('stats-event start requires a supported event')
    return metrics
  },
  /* v8 ignore next -- event rows are created by their start match and never updated. */
  update: context => context.state,
  buildViewNode: (context) => {
    const state = context.state
    const start = context.start
    /* v8 ignore next 2 -- a published node always retains its start match and state. */
    if (state === undefined || start === undefined) return null
    return {
      key: context.key,
      kind: context.kind,
      id: context.id,
      target: TARGET,
      anchorSeq: start.event.seq,
      location: start.location,
      data: { kind: 'event', metrics: state },
    }
  },
}

/**
 * Register the six Definitions. Each registration rides the caller's fiber
 * effect, so unloading the plugin removes the nodes with it.
 * @param ctx - client root context.
 */
export function registerStatsDefinitions(ctx: Context): void {
  ctx.uiConversation.events.register(stepDefinition)
  ctx.uiConversation.events.register(promptDefinition)
  ctx.uiConversation.events.register(endDefinition)
  ctx.uiConversation.events.register(codeModeDefinition)
  ctx.uiConversation.events.register(compactionDefinition)
  ctx.uiConversation.events.register(eventDefinition)
}
