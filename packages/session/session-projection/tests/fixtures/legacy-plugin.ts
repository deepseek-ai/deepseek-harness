/** Third-party-style projection plugin using synchronous registration and keyed reads. */
/* oxlint-disable typescript/no-deprecated -- this fixture intentionally keeps the legacy plugin API. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'fixture/legacy-projection': number
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    legacyProjectionFixture: {
      read(session: Session): unknown
      release(): void | Promise<void>
    }
  }
}

/** Fixture plugin identity. */
export const name = 'legacy-projection-fixture'
/** The original plugin declares its registry dependency. */
export const inject = ['sessionProjections']

const definition = {
  key: 'fixture/legacy-projection',
  stateSchema: z.number(),
  stateVersion: 1,
  init: () => 0,
  apply: state => state + 1,
  wire: { viewSchema: z.number(), view: state => state },
} satisfies ProjectionDefinition<'fixture/legacy-projection', number>

/**
 * Publish the old plugin's read and early-release operations.
 * @param ctx - Loader-owned plugin context.
 */
export function apply(ctx: Context): void {
  const registration = ctx.sessionProjections.register(definition)
  // Old compiled plugins call the runtime disposer without the current Promise-only type.
  const dispose = registration as typeof registration & (() => void | Promise<void>)
  ctx.provide('legacyProjectionFixture', {
    read: session => ctx.sessionProjections.stateOf(session, 'fixture/legacy-projection'),
    release: dispose,
  })
}
