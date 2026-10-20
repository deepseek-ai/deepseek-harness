/** Bind the source-owned permission UI to its generated Remote contribution. */
import type { Context } from '@deepseek-ai/cordis'
import cuaRemote from '@deepseek-ai/dsh-cua/remote'
import { mountCuaPermissions } from './mount.ts'

export { inject } from './mount.ts'

/**
 * Activate the optional Computer Use permission controls.
 * @param ctx Browser plugin context.
 * @returns Cleanup of the UI and Remote contribution.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return mountCuaPermissions(ctx, cuaRemote)
}
