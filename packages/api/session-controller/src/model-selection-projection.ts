/** Durable model-selection intent and request-use projection. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type {
  ModelSelection,
  ModelSelectionProjection,
  ModelSelectionProjectionState,
} from './types.ts'

const modelSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
}) as unknown as z.ZodType<ModelSelection>

const modelSelectionProjectionStateSchema = z.object({
  lastUsed: modelSelectionSchema.nullable(),
  pending: modelSelectionSchema.nullable(),
}) as z.ZodType<ModelSelectionProjectionState>

const modelSelectionProjectionSchema = z.object({
  lastUsed: modelSelectionSchema.nullable(),
  next: modelSelectionSchema.nullable(),
}) as z.ZodType<ModelSelectionProjection>

/**
 * Advance durable model-selection state by one Session event.
 * @param state - selection state before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced selection state.
 */
function applyModelSelectionProjection(
  state: ModelSelectionProjectionState,
  event: SessionEvent,
): ModelSelectionProjectionState {
  if (event.type === 'model/selection') {
    return sameSelection(state.pending, event.data)
      ? state
      : { lastUsed: state.lastUsed, pending: event.data }
  }
  if (event.type !== 'request/header') return state
  const lastUsed: ModelSelection = {
    provider: event.data.header.config.provider,
    model: event.data.header.config.model,
    ...(event.data.header.config.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: String(event.data.header.config.reasoningEffort) }),
  }
  const pending = sameSelection(state.pending, lastUsed) ? null : state.pending
  return sameSelection(state.lastUsed, lastUsed) && pending === state.pending
    ? state
    : { lastUsed, pending }
}

const modelSelectionProjection = {
  key: 'modelSelection',
  stateSchema: modelSelectionProjectionStateSchema,
  init: () => ({ lastUsed: null, pending: null }),
  apply: applyModelSelectionProjection,
  wire: {
    viewSchema: modelSelectionProjectionSchema,
    view: state => ({ lastUsed: state.lastUsed, next: state.pending ?? state.lastUsed }),
  },
  stateVersion: 2,
} satisfies ProjectionDefinition<'modelSelection', ModelSelectionProjectionState>

function sameSelection(left: ModelSelection | null, right: ModelSelection | null): boolean {
  return left === right || (left !== null && right !== null
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort)
}

/**
 * Register the durable model-selection projection when the registry is present.
 * @param ctx - Session Controller context.
 */
export function installModelSelectionProjection(ctx: Context): void {
  ctx.sessionProjections.register(modelSelectionProjection)
}
