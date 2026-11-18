/** Host Loader entry declaring the browser menu preparation budget; menus belong to the Client. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContextMenuConfig } from './types.ts'

/** Live preparation budget; the browser receives it through its synced Config. */
export type Config = ContextMenuConfig

/** Live preparation budget synced to the browser. */
export const Config = z.object({
  resolutionTimeoutMs: z.natural().min(1).default(1000).volatile(),
})

/**
 * Register the browser plugin without Host behavior; the Loader validates the entry's Config, and the browser face
 * receives its volatile fields.
 * @param _ctx - Host context; unused.
 * @param _config - validated Config; unused on the Host.
 */
export function apply(_ctx: Context, _config: Config): void {}
