/**
 * The bundle's declaration-surface entry: it provides the capability surface plugins offer viewer endpoints
 * through, before any part of the share host exists.
 *
 * The share host's own load waits for a Relay connection, which arrives after the plugins that offer viewer
 * endpoints have loaded; a surface provided there would appear too late for them to register against. This
 * entry requires nothing, so it activates in the first load batch, and the share host reads the same service
 * and subscribes to it when it starts.
 * @module @deepseek-ai/dsh-experimental-liveshare/viewer-declarations
 */

import type { Context } from '@deepseek-ai/cordis'
import { ViewerDeclarations } from './host/viewer-declarations.ts'

/** Stable Cordis plugin name of the declaration-surface entry. */
export const name = 'liveshare-viewer-declarations'

/**
 * Provide the declaration surface on the bundle's own context.
 *
 * The service belongs to this entry's fiber, so it lives exactly as long as the entry does and is gone with
 * a reload of the composition.
 * @param ctx - The entry's context; the surface goes away with its fiber.
 */
export function apply(ctx: Context): void {
  new ViewerDeclarations(ctx)
}
