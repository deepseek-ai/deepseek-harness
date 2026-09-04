import { expandAssistantStream } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { AssistantMessage, TokenUsage } from '@deepseek-ai/dsh-llm/types'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/** One provider/model route that contributed a billed request attempt. */
export interface TurnTokenUsageRoute {
  readonly provider: string
  readonly model: string
}

/** Exact provider-reported token accounting for every attempt in one completed Turn. */
export interface TurnTokenUsage {
  /** Sum of uncached prompt input across all attempts. */
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  /** Exact aggregate prompt plus output total across all attempts. */
  readonly totalTokens: number
  /** Present only when every attempt reported the bucket. */
  readonly cacheReadTokens?: number
  /** Present only when every attempt reported the bucket. */
  readonly cacheWriteTokens?: number
  /** Output subset, present only when every attempt reported it. */
  readonly reasoningTokens?: number
  /** Present only when every billed attempt has provider/model attribution. */
  readonly routes?: readonly TurnTokenUsageRoute[]
}

interface NormalizedAttempt {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  readonly route?: TurnTokenUsageRoute
}

type AttemptState =
  | { readonly kind: 'idle' }
  | {
    readonly kind: 'open'
    readonly turn: number
    readonly step: number
    readonly sample?: TokenUsage
  }
  | {
    readonly kind: 'finishClosed'
    readonly turn: number
    readonly step: number
  }
  | {
    readonly kind: 'settled'
    readonly turn: number
    readonly step: number
    readonly by: 'message' | 'retry'
  }

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function safeSum(values: readonly number[]): number | undefined {
  let total = 0
  for (const value of values) {
    total += value
    if (!Number.isSafeInteger(total)) return undefined
  }
  return total
}

function messageRoute(message: AssistantMessage): TurnTokenUsageRoute | undefined {
  const { provider, model } = message.source
  return provider.length > 0 && model.length > 0 ? { provider, model } : undefined
}

function streamUsage(stream: SessionEvent<'assistant/message'>['data']['stream']): TokenUsage | undefined {
  let sample: TokenUsage | undefined
  for (const member of expandAssistantStream(stream)) {
    if (member.chunk.type === 'usage') sample = member.chunk.usage
  }
  return sample
}

function normalizeUsage(usage: TokenUsage, route?: TurnTokenUsageRoute): NormalizedAttempt | undefined {
  const {
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens,
  } = usage
  if (!isCount(inputTokens) || !isCount(outputTokens)) return undefined
  if (cacheReadTokens !== undefined && !isCount(cacheReadTokens)) return undefined
  if (cacheWriteTokens !== undefined && !isCount(cacheWriteTokens)) return undefined
  if (reasoningTokens !== undefined && (!isCount(reasoningTokens) || reasoningTokens > outputTokens)) {
    return undefined
  }

  const knownPrompt = safeSum([
    inputTokens,
    ...cacheReadTokens === undefined ? [] : [cacheReadTokens],
    ...cacheWriteTokens === undefined ? [] : [cacheWriteTokens],
  ])
  if (knownPrompt === undefined) return undefined

  let exactTotal: number
  if (totalTokens !== undefined) {
    if (!isCount(totalTokens)) return undefined
    const exactPrompt = totalTokens - outputTokens
    if (!isCount(exactPrompt) || exactPrompt < knownPrompt) return undefined
    if (cacheReadTokens !== undefined && cacheWriteTokens !== undefined && exactPrompt !== knownPrompt) {
      return undefined
    }
    exactTotal = totalTokens
  } else {
    if (cacheReadTokens === undefined || cacheWriteTokens === undefined) return undefined
    const derivedTotal = safeSum([knownPrompt, outputTokens])
    if (derivedTotal === undefined) return undefined
    exactTotal = derivedTotal
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: exactTotal,
    ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
    ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
    ...reasoningTokens === undefined ? {} : { reasoningTokens },
    ...route === undefined ? {} : { route },
  }
}

function aggregateAttempts(attempts: readonly NormalizedAttempt[]): TurnTokenUsage | undefined {
  if (attempts.length === 0) return undefined
  const inputTokens = safeSum(attempts.map(attempt => attempt.inputTokens))
  const outputTokens = safeSum(attempts.map(attempt => attempt.outputTokens))
  const totalTokens = safeSum(attempts.map(attempt => attempt.totalTokens))
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) return undefined

  const cacheRead = attempts.map(attempt => attempt.cacheReadTokens)
  const cacheWrite = attempts.map(attempt => attempt.cacheWriteTokens)
  const reasoning = attempts.map(attempt => attempt.reasoningTokens)
  const cacheReadTokens = cacheRead.every(isCount) ? safeSum(cacheRead) : undefined
  const cacheWriteTokens = cacheWrite.every(isCount) ? safeSum(cacheWrite) : undefined
  const reasoningTokens = reasoning.every(isCount) ? safeSum(reasoning) : undefined
  // A present cache bucket is bounded by exact prompt, and reasoning is bounded
  // by output. Safe required aggregates therefore imply safe optional sums.

  let routes: readonly TurnTokenUsageRoute[] | undefined
  const attributed = attempts.map(attempt => attempt.route)
  if (attributed.every((route): route is TurnTokenUsageRoute => route !== undefined)) {
    const unique = new Map<string, TurnTokenUsageRoute>()
    for (const route of attributed) unique.set(`${route.provider}\0${route.model}`, route)
    routes = [...unique.values()]
  }

  return {
    uncachedInputTokens: inputTokens,
    outputTokens,
    totalTokens,
    ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
    ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
    ...reasoningTokens === undefined ? {} : { reasoningTokens },
    ...routes === undefined ? {} : { routes },
  }
}

function sameAttempt(
  state: Exclude<AttemptState, { kind: 'idle' }>,
  turn: number,
  step: number,
): boolean {
  return state.turn === turn && state.step === step
}

/**
 * Fold one complete Turn's durable attempt lifecycle into exact token accounting.
 *
 * No attempt is inferred from a usage sample. Any missing lifecycle boundary,
 * incomplete attempt usage, unsafe count, or contradictory exact total makes
 * the whole disclosure unavailable.
 * @param events - Turn-local durable events from `turn/start` through `turn/end`.
 * @returns exact aggregate usage, or undefined when it cannot be proven.
 */
export function deriveTurnTokenUsage(events: readonly SessionEvent[]): TurnTokenUsage | undefined {
  let state: AttemptState = { kind: 'idle' }
  const attempts: NormalizedAttempt[] = []
  let turn: number | undefined
  let sawEnd = false
  let invalid = false

  const closeOpen = (route?: TurnTokenUsageRoute): boolean => {
    if (state.kind !== 'open' || state.sample === undefined) return false
    const normalized = normalizeUsage(state.sample, route)
    if (normalized === undefined) return false
    attempts.push(normalized)
    return true
  }

  for (const event of events) {
    if (invalid) break
    if (event.type === 'turn/start') {
      if (turn !== undefined || state.kind !== 'idle') invalid = true
      else turn = event.data.turn
      continue
    }
    if (turn === undefined) {
      invalid = true
      break
    }
    if (event.type === 'turn/end') {
      if (event.data.turn !== turn || state.kind !== 'idle' || sawEnd) invalid = true
      else sawEnd = true
      continue
    }
    if (sawEnd) {
      invalid = true
      break
    }
    if (event.type === 'step/start') {
      if (event.data.turn !== turn || state.kind !== 'idle') invalid = true
      else state = { kind: 'open', turn, step: event.data.step }
      continue
    }
    if (event.type === 'llm/retry-started') {
      if (event.data.turn !== turn
        || state.kind !== 'settled'
        || state.by !== 'retry'
        || !sameAttempt(state, event.data.turn, event.data.step)) invalid = true
      else state = { kind: 'open', turn, step: event.data.step }
      continue
    }
    if (event.type === 'assistant/attempt') {
      if (event.data.turn !== turn
        || state.kind !== 'open'
        || !sameAttempt(state, event.data.turn, event.data.step)) {
        invalid = true
        continue
      }
      let sample: TokenUsage | undefined = state.sample
      for (const member of expandAssistantStream(event.data.stream)) {
        if (member.chunk.type === 'usage') sample = member.chunk.usage
      }
      state = { kind: 'open', turn, step: event.data.step, ...(sample === undefined ? {} : { sample }) }
      if (!closeOpen()) invalid = true
      else state = { kind: 'finishClosed', turn, step: event.data.step }
      continue
    }
    if (event.type === 'assistant/message') {
      if (event.data.turn !== turn
        || state.kind !== 'open'
        || !sameAttempt(state, event.data.turn, event.data.step)) {
        invalid = true
        continue
      }
      const sample = event.data.usage ?? streamUsage(event.data.stream)
      if (sample !== undefined) state = { ...state, sample }
      if (!closeOpen(messageRoute(event.data.message))) invalid = true
      else state = { kind: 'settled', turn, step: event.data.step, by: 'message' }
      continue
    }
    if (event.type === 'llm/retry') {
      if (event.data.turn !== turn || state.kind === 'idle'
        || !sameAttempt(state, event.data.turn, event.data.step)) {
        invalid = true
        continue
      }
      if (state.kind === 'settled' || (state.kind === 'open' && !closeOpen())) invalid = true
      if (!invalid) state = { kind: 'settled', turn, step: event.data.step, by: 'retry' }
      continue
    }
    if (event.type === 'step/end') {
      if (event.data.turn !== turn || state.kind === 'idle'
        || !sameAttempt(state, event.data.turn, event.data.step)) {
        invalid = true
        continue
      }
      if (state.kind === 'open' && !closeOpen()) invalid = true
      if (!invalid) state = { kind: 'idle' }
    }
  }

  return invalid || !sawEnd || state.kind !== 'idle' ? undefined : aggregateAttempts(attempts)
}
