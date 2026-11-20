/** Host Loader entry declaring window-local keyboard sequence timing; the keyboard service belongs to the Client. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ShortcutsConfig } from './types.ts'

/** Fixed shortcut sequence timing; the browser receives it through its synced Config. */
export type Config = ShortcutsConfig

/** Sequence timing synced to the browser; the upper bound keeps expiry within the browser timer limit. */
export const Config = z.object({
  stopSequenceMs: z.natural().min(1).max(2_147_483_646).default(500).volatile(),
})

/**
 * Register the browser plugin without Host behavior; the Loader validates the entry's Config, and the browser face
 * receives its volatile fields.
 * @param _ctx - Host context; unused.
 * @param _config - validated Config; unused on the Host.
 */
export function apply(_ctx: Context, _config: Config): void {}
