/** Typed Cordis plugin exports for the query-spill verification fixture. */
import type { Context } from '@deepseek-ai/cordis'

/** Scenario-local plugin identifier. */
export const name: 'query-spill-verification-path'
/** Runtime services used to resolve and execute the verification command. */
export const inject: string[]

/**
 * Translate the physical command while preserving tool logging and approval.
 * @param ctx - profile context with the real shell and filesystem providers.
 */
export function apply(ctx: Context): void
