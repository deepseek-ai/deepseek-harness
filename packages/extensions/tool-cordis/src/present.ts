/** Pure replay-safe render intents for runtime inspection. */
import type { GenericCallView } from '@deepseek-ai/dsh-tools'

/**
 * Render provider-directory inspection.
 * @returns replay-safe generic call presentation.
 */
export function presentInspectListCall(): GenericCallView {
  return { card: 'generic', kind: 'read', title: 'List Cordis Inspect Providers' }
}

/**
 * Render one provider query.
 * @param args - target platform, provider, and method.
 * @returns replay-safe generic call presentation.
 */
export function presentInspectQueryCall(args: { platform: string; provider: string; method: string }): GenericCallView {
  return { card: 'generic', kind: 'read', title: `Query Cordis ${args.platform} ${args.provider}.${args.method}` }
}
