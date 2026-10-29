/** Turn aggregation over the step metrics a window holds. */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  StatsCall, StatsCompactionMetrics, StatsContribution, StatsEventMetrics, StatsStepMetrics, StatsToolCount,
  StatsTurnMetrics,
  StatsViewNode,
} from './stats-contract.ts'
import { CALL_LIMIT, isCodeMode, toolSpanUnion } from './stats-fold.ts'
import { isNumber } from './stats-usage.ts'

/** One Code-Mode root call's inner contribution, before merging into its step. */
type InnerContribution = Extract<StatsContribution, { kind: 'inner' }>

/** Empty image list shared by turns whose trigger attached no image. */
const NO_IMAGES: readonly ImageAttachmentRef[] = []

/** Empty compaction list shared by turns without one. */
const NO_COMPACTIONS: readonly StatsCompactionMetrics[] = []

/** Empty event-row list shared by turns without one. */
const NO_EVENTS: readonly StatsEventMetrics[] = []

/** The trigger that opened one turn, kept from the highest-priority source. */
interface TurnTrigger {
  readonly text: string
  readonly images: readonly ImageAttachmentRef[]
  readonly source: string
  readonly sender: string | null
}

/** Human prompts outrank automation context; ties keep the first message. */
function triggerRank(source: string): number {
  switch (source) {
    case 'user': return 4
    case 'team-message': return 3
    case 'agent-message': return 2
    case 'subagent-settled': return 2
    case 'goal': return 1
    case 'schedule':
    case 'webhook':
    case 'tool-jobs':
    case 'cordis-host-runner': return 1
    default: return 0
  }
}

/** Context measured last in the turn: steps without usage keep the previous value. */
function lastContext(steps: readonly StatsStepMetrics[]): number | null {
  let context: number | null = null
  for (const step of steps) if (isNumber(step.context)) context = step.context
  return context
}

/** Token-weighted cache level of the turn, over the steps that reported both read and prompt tokens. */
function turnCache(steps: readonly StatsStepMetrics[]): {
  rate: number | null
  read: number | null
  write: number | null
  context: number | null
} {
  let read = 0
  let write = 0
  let context = 0
  let measured = false
  for (const step of steps) {
    if (!isNumber(step.cacheRead) || !isNumber(step.context)) continue
    read += step.cacheRead
    write += step.cacheWrite ?? 0
    context += step.context
    measured = true
  }
  const level = measured && context > 0 ? Math.min(1, read / context) : null
  return { rate: level, read: measured ? read : null, write: measured ? write : null, context: measured ? context : null }
}

/** Tool tallies by descending count; ties keep call order. */
function tallyCalls(calls: readonly StatsCall[]): StatsToolCount[] {
  const counts = new Map<string, number>()
  for (const call of calls) {
    if (call.name === null) continue
    counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count)
}

/**
 * Merge the Code-Mode dispatches of one step into its row. The runner call
 * disappears in favor of the real tools, so the row shows what the code called
 * and the characters those results pushed into the next prompt.
 * @param step - step row folded from native events only.
 * @param inner - the step's Code-Mode contributions.
 * @returns the merged row, or the original when no dispatch was recorded.
 */
function mergeInnerCalls(step: StatsStepMetrics, inner: readonly InnerContribution[]): StatsStepMetrics {
  if (inner.length === 0) return step
  const innerCalls = inner.flatMap(contribution => contribution.calls)
  const calls = [
    ...step.calls.filter(call => !isCodeMode(call.name)),
    ...innerCalls,
  ]
    .sort((left, right) => left.seq - right.seq)
    .slice(0, CALL_LIMIT)
  const chars = calls.reduce((sum, call) => sum + (call.chars ?? 0), 0)
  return {
    ...step,
    calls,
    tools: tallyCalls(calls),
    toolOutput: chars,
    toolWall: toolSpanUnion(calls),
    toolErrors: step.toolErrors + innerCalls.filter(call => call.error).length,
  }
}

/**
 * Aggregate one turn's steps into the row values the table shows.
 * @param turn - turn number.
 * @param steps - the turn's step metrics in step order.
 * @returns the turn row.
 */
export function aggregateTurn(turn: number, steps: readonly StatsStepMetrics[]): StatsTurnMetrics {
  let ttftSum = 0
  let ttftUnknown = 0
  let modelSum = 0
  let modelUnknown = 0
  let decodeSum = 0
  let decodeUnknown = 0
  let outputSum = 0
  let outputUnknown = 0
  let toolSum = 0
  let toolPairable = 0
  let toolPending = 0
  let toolWallSum = 0
  let toolWallMeasured = false
  const tools = new Map<string, number>()
  for (const step of steps) {
    for (const item of step.tools) tools.set(item.name, (tools.get(item.name) ?? 0) + item.count)
    // First-token waits accumulate too: the turn total is the sum of its steps.
    if (isNumber(step.ttft)) ttftSum += step.ttft
    else ttftUnknown += 1
    if (isNumber(step.model)) modelSum += step.model
    else modelUnknown += 1
    if (isNumber(step.decode)) decodeSum += step.decode
    else decodeUnknown += 1
    if (isNumber(step.output)) outputSum += step.output
    else outputUnknown += 1
    if (isNumber(step.tool)) {
      toolSum += step.tool
      toolPairable += 1
    }
    if (isNumber(step.toolWall)) {
      toolWallSum += step.toolWall
      toolWallMeasured = true
    }
    toolPending += step.toolPending
  }
  const first = steps[0]
  const last = steps[steps.length - 1]
  const wall = first !== undefined && last !== undefined
    && !last.running && isNumber(first.startTime) && isNumber(last.endTime)
    ? Math.max(0, last.endTime - first.startTime)
    : null
  let answer: string | null = null
  let retries = 0
  let toolErrors = 0
  let toolOutput = 0
  let lastStepWall: number | null = null
  for (const step of steps) {
    if (step.answer !== null) answer = step.answer
    retries += step.retries
    toolErrors += step.toolErrors
    if (isNumber(step.toolOutput)) toolOutput += step.toolOutput
    if (isNumber(step.wall)) lastStepWall = step.wall
  }
  const cache = turnCache(steps)
  const all = steps.length
  const toolCounts: StatsToolCount[] = [...tools.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count)
  return {
    turn,
    steps,
    startTime: first !== undefined && isNumber(first.startTime) ? first.startTime : null,
    context: lastContext(steps),
    // Only "nothing measured" counts as unrecorded; partial coverage is a lower bound.
    ttft: ttftUnknown === all ? null : ttftSum,
    ttftPending: ttftUnknown === all ? 0 : ttftUnknown,
    model: modelUnknown === all ? null : modelSum,
    modelPending: modelUnknown,
    decode: decodeUnknown === all ? null : decodeSum,
    tps: decodeSum > 0 && outputSum > 0 ? outputSum / (decodeSum / 1000) : null,
    output: outputUnknown === all ? null : outputSum,
    tool: toolPairable === 0 ? null : toolSum,
    toolWall: toolWallMeasured ? toolWallSum : null,
    toolPending: toolPairable === 0 ? 0 : toolPending,
    tools: toolCounts,
    cacheHit: cache.rate,
    cacheRead: cache.read,
    cacheWrite: cache.write,
    cacheContext: cache.context,
    retries,
    toolErrors,
    toolOutput,
    lastStepWall,
    running: last !== undefined && last.running,
    interrupted: steps.some(step => step.interrupted),
    aborted: steps.some(step => step.aborted),
    wall,
    compactions: [],
    events: [],
    prompt: null,
    promptImages: NO_IMAGES,
    promptSource: null,
    promptSender: null,
    answer,
  }
}

/** A step with no measurement at all: the empty step an interruption appends. */
function isEmptyStep(step: StatsStepMetrics): boolean {
  return step.context === null && step.ttft === null && step.model === null
    && step.tool === null && step.toolPending === 0
    && step.tools.length === 0
    && (step.wall === null || step.wall === 0)
}

/**
 * Group published nodes into ordered turns, closing each turn with its markers.
 * Code-Mode contributions merge into the step that dispatched them, identified
 * by the root call id the node carries.
 * @param nodes - every node the target builder currently holds.
 * @returns turn rows ordered oldest first.
 */
export function buildTurns(nodes: Iterable<StatsViewNode>): StatsTurnMetrics[] {
  const grouped = new Map<number, StatsStepMetrics[]>()
  // turn/end marker: turn → end time and reason, so an interrupted tail closes.
  const closedAt = new Map<number, number>()
  const closedKind = new Map<number, string>()
  // User question per turn; the first typed question wins over later retries.
  const prompts = new Map<number, TurnTrigger>()
  // Code-Mode dispatches per step, merged after the steps are ordered.
  const inner = new Map<string, InnerContribution[]>()
  // Compaction transactions per turn, ordered by start time after grouping.
  const compactions = new Map<number, StatsCompactionMetrics[]>()
  // Non-step event rows per turn, ordered by event time after grouping.
  const events = new Map<number, StatsEventMetrics[]>()
  for (const node of nodes) {
    const data = node.data
    if (data.kind === 'prompt') {
      const previous = prompts.get(data.turn)
      const rank = triggerRank(data.source)
      if (previous === undefined
        || rank > triggerRank(previous.source)
        || (rank === triggerRank(previous.source) && previous.text === '' && (data.prompt ?? '') !== '')) {
        prompts.set(data.turn, {
          text: data.prompt ?? '',
          images: data.images,
          source: data.source,
          sender: data.sender,
        })
      }
      continue
    }
    if (data.kind === 'end') {
      if (isNumber(data.endTime)) closedAt.set(data.turn, data.endTime)
      if (data.closeKind !== null) closedKind.set(data.turn, data.closeKind)
      continue
    }
    if (data.kind === 'event') {
      if (!isNumber(data.metrics.turn)) continue
      const list = events.get(data.metrics.turn)
      if (list === undefined) events.set(data.metrics.turn, [data.metrics])
      else list.push(data.metrics)
      continue
    }
    if (data.kind === 'compaction') {
      if (!isNumber(data.metrics.turn)) continue
      const list = compactions.get(data.metrics.turn)
      if (list === undefined) compactions.set(data.metrics.turn, [data.metrics])
      else list.push(data.metrics)
      continue
    }
    if (data.kind === 'inner') {
      const key = `${data.turn}:${data.step}`
      const list = inner.get(key)
      if (list === undefined) inner.set(key, [data])
      else list.push(data)
      continue
    }
    const metrics = data.metrics
    if (!isNumber(metrics.turn)) continue
    const bucket = grouped.get(metrics.turn)
    if (bucket === undefined) grouped.set(metrics.turn, [metrics])
    else bucket.push(metrics)
  }
  const turns: StatsTurnMetrics[] = []
  const order = [...grouped.keys()].sort((left, right) => left - right)
  order.forEach((turn, index) => {
    const bucket = grouped.get(turn)
    /* v8 ignore next -- turn came from the map's own keys, so the bucket always exists. */
    if (bucket === undefined) return
    const steps = bucket.slice().sort((left, right) => left.step - right.step)
    // A late re-delivery of a pruned tool result names an old turn and has no
    // start, prompt, or end in this window: it is context, not a turn row.
    const boundary = prompts.has(turn) || closedAt.has(turn)
      || steps.some(step => step.startTime !== null || step.mark === 'end')
    if (!boundary) return
    // A step followed by another step cannot still be running: a trimmed window
    // can lose its step/end, and the row would otherwise stay "running" forever.
    for (let at = 0; at < steps.length - 1; at += 1) {
      const step = steps[at]
      if (step !== undefined && step.running) steps[at] = { ...step, running: false }
    }
    const at = closedAt.get(turn)
    const tail = steps[steps.length - 1]
    // An interruption appends an empty final step that only marks the break.
    if (at !== undefined && steps.length > 1 && tail !== undefined && isEmptyStep(tail)) steps.pop()
    const last = steps[steps.length - 1]
    // Interrupted tail: close the last step at the turn/end time so it shows
    // "unsettled" with a measured duration instead of "running" with no total.
    if (at !== undefined && last !== undefined && last.endTime === null) {
      steps[steps.length - 1] = {
        ...last,
        endTime: at,
        wall: isNumber(last.startTime) ? Math.max(0, at - last.startTime) : null,
        running: false,
        aborted: true,
      }
    }
    const merged = steps.map(step => mergeInnerCalls(step, inner.get(`${turn}:${step.step}`) ?? []))
    const aggregate = aggregateTurn(turn, merged)
    const prompt = prompts.get(turn)
    turns.push({
      ...aggregate,
      compactions: (compactions.get(turn) ?? NO_COMPACTIONS).slice()
        .sort((left, right) => left.startTime - right.startTime),
      events: (events.get(turn) ?? NO_EVENTS).slice()
        .sort((left, right) => left.time - right.time),
      // A turn followed by another turn cannot still be running.
      running: (index < order.length - 1 || at !== undefined) ? false : aggregate.running,
      interrupted: closedKind.get(turn) === 'interrupted' ? true : aggregate.interrupted,
      prompt: prompt === undefined || prompt.text === '' ? null : prompt.text,
      promptImages: prompt === undefined ? NO_IMAGES : prompt.images,
      promptSource: prompt === undefined ? null : prompt.source,
      promptSender: prompt === undefined ? null : prompt.sender,
    })
  })
  return turns
}

/** How a turn or window aggregates prompt sizes: final prompt or cumulative processing. */
export type ContextMode = 'latest' | 'cumulative'

/** Totals over the turns loaded in the current window. */
export interface StatsTotals {
  readonly turnCount: number
  readonly stepCount: number
  readonly context: number | null
  readonly output: number | null
  readonly cacheHit: number | null
  readonly cacheRead: number | null
  readonly cacheWrite: number | null
  readonly cacheContext: number | null
  readonly ttft: number | null
  readonly ttftPending: number
  readonly model: number | null
  readonly modelPending: number
  readonly tps: number | null
  readonly tool: number | null
  readonly toolPending: number
  readonly toolWall: number | null
  readonly wall: number | null
}

/**
 * Context of one turn under the selected basis.
 * @param turn - aggregated turn.
 * @param mode - latest final prompt size, or the sum of its step prompt sizes.
 * @returns the context tokens, or null when no step measured one.
 */
export function turnContext(turn: StatsTurnMetrics, mode: ContextMode): number | null {
  if (mode === 'latest') return turn.context
  let sum = 0
  let measured = false
  for (const step of turn.steps) {
    if (!isNumber(step.context)) continue
    sum += step.context
    measured = true
  }
  return measured ? sum : null
}

/**
 * Aggregate the loaded turns into one totals row.
 * @param turns - aggregated turns in display order.
 * @returns summed metrics; the context column is always the cumulative step context.
 */
export function aggregateTotals(turns: readonly StatsTurnMetrics[]): StatsTotals {
  let stepCount = 0
  let outputSum = 0
  let outputMeasured = false
  let read = 0
  let write = 0
  let contextSum = 0
  let cacheMeasured = false
  let ttftSum = 0
  let ttftMeasured = false
  let ttftPending = 0
  let modelSum = 0
  let modelMeasured = false
  let modelPending = 0
  let decodeSum = 0
  let toolSum = 0
  let toolMeasured = false
  let toolPending = 0
  let toolWallSum = 0
  let toolWallMeasured = false
  let wallSum = 0
  let wallMeasured = false
  for (const turn of turns) {
    stepCount += turn.steps.length
    if (isNumber(turn.output)) {
      outputSum += turn.output
      outputMeasured = true
    }
    if (isNumber(turn.cacheRead) && isNumber(turn.cacheContext)) {
      read += turn.cacheRead
      write += turn.cacheWrite ?? 0
      contextSum += turn.cacheContext
      cacheMeasured = true
    }
    if (isNumber(turn.ttft)) {
      ttftSum += turn.ttft
      ttftMeasured = true
    }
    ttftPending += turn.ttftPending
    if (isNumber(turn.model)) {
      modelSum += turn.model
      modelMeasured = true
    }
    modelPending += turn.modelPending
    if (isNumber(turn.decode)) decodeSum += turn.decode
    if (isNumber(turn.tool)) {
      toolSum += turn.tool
      toolMeasured = true
    }
    toolPending += turn.toolPending
    if (isNumber(turn.toolWall)) {
      toolWallSum += turn.toolWall
      toolWallMeasured = true
    }
    if (isNumber(turn.wall)) {
      wallSum += turn.wall
      wallMeasured = true
    }
  }
  let cumulative = 0
  let cumulativeMeasured = false
  for (const turn of turns) {
    for (const step of turn.steps) {
      if (!isNumber(step.context)) continue
      cumulative += step.context
      cumulativeMeasured = true
    }
  }
  return {
    turnCount: turns.length,
    stepCount,
    context: cumulativeMeasured ? cumulative : null,
    output: outputMeasured ? outputSum : null,
    cacheHit: cacheMeasured && contextSum > 0 ? Math.min(1, read / contextSum) : null,
    cacheRead: cacheMeasured ? read : null,
    cacheWrite: cacheMeasured ? write : null,
    cacheContext: cacheMeasured ? contextSum : null,
    ttft: ttftMeasured ? ttftSum : null,
    ttftPending: ttftMeasured ? ttftPending : 0,
    model: modelMeasured ? modelSum : null,
    modelPending,
    tps: outputMeasured && decodeSum > 0 && outputSum > 0 ? outputSum / (decodeSum / 1000) : null,
    tool: toolMeasured ? toolSum : null,
    toolPending,
    toolWall: toolWallMeasured ? toolWallSum : null,
    wall: wallMeasured ? wallSum : null,
  }
}
