/** Fixed-size recovery facts; positional attachment prices remain a rebuildable cache. */
import { z } from 'zod'
import { assembleAssistantStream } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { canonicalHeader, deriveEventMessage, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { estimateContent, estimateMessage, ROLE_OVERHEAD } from './estimate.ts'

const seqSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq)
const countSchema = z.number()
const usageFields = z.looseObject({
  inputTokens: countSchema,
  outputTokens: countSchema,
  totalTokens: countSchema.optional(),
  cacheReadTokens: countSchema.optional(),
  cacheWriteTokens: countSchema.optional(),
  reasoningTokens: countSchema.optional(),
})
// Keep provider fields and optional-property presence exactly as recorded.
const usageSchema = z.custom<TokenUsage>(value => usageFields.safeParse(value).success)

const measurementStateSchema = z.object({
  headerSeq: seqSchema.nullable(),
  stepStart: z.object({ turn: z.number(), step: z.number() }).strict().nullable(),
  anchor: z.object({
    headerSeq: seqSchema.nullable(),
    assistantTokens: countSchema,
    usage: usageSchema.nullable(),
  }).strict().nullable(),
  invalidSeq: seqSchema.nullable(),
}).strict()

/** One header reference, one open step, and the latest successful call's usage facts. */
export type MeasurementState = z.infer<typeof measurementStateSchema>

/**
 * Advance one measurement prefix without mutating its previous state.
 * @param state - measurement facts before the candidate event.
 * @param event - next committed journal event.
 * @returns updated measurement facts.
 * @throws the original measurement error for invalid boundaries or payloads.
 */
export function advanceMeasurement(state: MeasurementState, event: SessionEvent): MeasurementState {
  switch (event.type) {
    case 'request/header':
      canonicalHeader(event.data.header)
      return { ...state, headerSeq: event.seq }
    case 'step/start':
      if (state.stepStart !== null) {
        throw new Error(`token meter: step/start at seq ${event.seq} arrived before turn ${state.stepStart.turn}/step ${state.stepStart.step} ended`)
      }
      return { ...state, stepStart: { turn: event.data.turn, step: event.data.step } }
    case 'step/end':
      if (state.stepStart === null
        || state.stepStart.turn !== event.data.turn
        || state.stepStart.step !== event.data.step) {
        throw new Error(`token meter: step/end at seq ${event.seq} has no matching step/start event`)
      }
      return { ...state, stepStart: null }
    case 'assistant/message': {
      if (state.stepStart === null
        || state.stepStart.turn !== event.data.turn
        || state.stepStart.step !== event.data.step) {
        throw new Error(`token meter: assistant/message at seq ${event.seq} has no matching step/start event`)
      }
      let assistantTokens: number
      let usage: TokenUsage | null = null
      if (event.data.usage !== undefined && state.headerSeq !== null) {
        const content = assembleAssistantStream(event.data.stream).blocks()
        assistantTokens = content.length === 0 ? 0 : estimateContent(content) + ROLE_OVERHEAD
        usage = event.data.usage
      } else {
        const message = deriveEventMessage(event)
        assistantTokens = message === null ? 0 : estimateMessage(message)
      }
      return { ...state, anchor: { headerSeq: state.headerSeq, assistantTokens, usage } }
    }
    default:
      return state
  }
}

/** Host-only measurement facts, independent of session and surface length. */
export const measurementProjectionDefinition = {
  key: 'tokenMeasurement',
  stateVersion: 2,
  stateSchema: measurementStateSchema,
  init: (): MeasurementState => ({ headerSeq: null, stepStart: null, anchor: null, invalidSeq: null }),
  apply: (state, event) => {
    if (state.invalidSeq !== null) return state
    try {
      return advanceMeasurement(state, event)
    } catch (_error) {
      // Retain the first failed position. measure() repeats the calculation there
      // to report its original error without blocking unrelated projection units.
      return { ...state, invalidSeq: event.seq }
    }
  },
} satisfies ProjectionDefinition<'tokenMeasurement', MeasurementState>
