/** Shared Session-list projection ownership for API and model-tool readers. */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { SessionListMetadata } from './types.ts'

const sessionListMetadataSchema: z.ZodType<SessionListMetadata> = z.object({
  blank: z.boolean(),
  lastPromptAt: z.number().nullable(),
})

/** Advance blankness and human-prompt recency without retaining history. */
function applySessionListMetadata(
  state: SessionListMetadata,
  event: SessionEvent,
): SessionListMetadata {
  const blank = state.blank && event.type !== 'turn/start'
  const lastPromptAt = event.type === 'user/message' && event.data.source.kind === 'user'
    ? event.time
    : state.lastPromptAt
  return blank === state.blank && lastPromptAt === state.lastPromptAt
    ? state
    : { blank, lastPromptAt }
}

const sessionListMetadataDefinition = {
  key: 'sessionListMetadata',
  stateSchema: sessionListMetadataSchema,
  init: () => ({ blank: true, lastPromptAt: null }),
  apply: applySessionListMetadata,
  wire: { viewSchema: sessionListMetadataSchema, view: state => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<'sessionListMetadata', SessionListMetadata>

/**
 * Acquire the shared Session-list unit on the caller's fiber.
 * Concurrent callers share one projection; disposal releases only the caller's reference.
 * @param ctx - owner context with the required projection registry.
 * @returns a synchronous domain reader ready for prepared live Sessions.
 */
export async function registerSessionListMetadata(
  ctx: Context,
): Promise<(session: Session) => SessionListMetadata> {
  const handle = await ctx.sessionProjections.register(sessionListMetadataDefinition)
  return session => handle.stateOf(session)
}
