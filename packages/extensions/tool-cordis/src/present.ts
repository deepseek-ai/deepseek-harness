/** Pure replay-safe render intents for runtime inspection. */
import type { GenericCallView } from '@deepseek-ai/dsh-tools'

/**
 * Render a provider directory or one exact query.
 * @param args - Optional query target.
 * @returns replay-safe generic call presentation.
 */
export function presentInspectCall(args: { query?: { platform: string; provider: string; method: string } }): GenericCallView {
  return { card: 'generic', kind: 'read', title: args.query === undefined
    ? 'List Cordis Inspect Providers'
    : `Query Cordis ${args.query.platform} ${args.query.provider}.${args.query.method}` }
}
