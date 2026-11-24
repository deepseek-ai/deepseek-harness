/** Browser entry for the optional read-aloud Remote contribution and message action. */
import type { Context } from '@deepseek-ai/cordis'
import readAloudRemote from '@deepseek-ai/dsh-read-aloud/remote'
import { mountReadAloud } from './mount.ts'

export { inject } from './mount.ts'

/**
 * Activate the experimental read-aloud contribution.
 * @param ctx - Client runtime.
 * @returns complete UI and Remote disposer.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountReadAloud(ctx, readAloudRemote)
}
