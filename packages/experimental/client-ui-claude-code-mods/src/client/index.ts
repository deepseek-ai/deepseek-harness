/** Browser entry: mounts the bridge's Remote and registers the band above the prompt. */

import type { Context } from '@deepseek-ai/cordis'
import modsRemote from '@deepseek-ai/dsh-experimental-claude-code-mods/remote'
import { mountModsBand } from './mount.ts'

export { inject } from './mount.ts'
export type { BandInjected, BandProps } from './Band.tsx'
export type { ModsBandKey } from './locales.ts'

/**
 * Register the mods band on the Client Context.
 * @param ctx - Client Context with the declared `inject` services available.
 * @returns the disposer that withdraws the band.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountModsBand(ctx, modsRemote)
}
