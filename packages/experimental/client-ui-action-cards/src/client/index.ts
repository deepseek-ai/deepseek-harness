/** Bind generated Remote descriptors to the source-tested browser lifecycle. */
import type { Context } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-action-cards/remote'
import { mountActionCards } from './mount.ts'
export { inject } from './mount.ts'
export type { ActionCardBodyProps, ActionCardDescriptor, ActionCardRegistry, FoldedTextProps } from './registry.ts'

/**
 * Mount action cards and their Remote.
 * @param ctx - Client plugin context.
 * @returns disposer for every contribution.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountActionCards(ctx, remote)
}
