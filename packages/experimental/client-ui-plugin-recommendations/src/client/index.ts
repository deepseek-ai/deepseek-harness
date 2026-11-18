/** Bind the generated Remote contribution to the source-tested browser lifecycle. */
import type { Context } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-plugin-recommendations/remote'
import { mountRecommendations } from './mount.ts'
export { inject } from './mount.ts'

/** Mount recommendation UI and its optional Remote.
 * @param ctx - Client plugin context.
 * @returns disposer for both contributions.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountRecommendations(ctx, remote)
}
