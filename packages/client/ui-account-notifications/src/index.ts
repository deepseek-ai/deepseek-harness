/** Host Loader entry declaring the account notification polling interval; polling belongs to the Client. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { AccountNotificationsConfig } from './types.ts'

/** Initial polling interval; the browser receives it through its synced Config. */
export type Config = AccountNotificationsConfig

/** Initial polling interval synced to the browser; the upper bound is the browser timer limit. */
export const Config = Schema.object({
  notificationPollIntervalMs: Schema.natural().min(1).max(2_147_483_647).default(600_000).volatile(),
})

/**
 * Register the browser plugin without Host behavior; the Loader validates the entry's Config, and the browser face
 * receives its volatile fields.
 * @param _ctx - Host context; unused.
 * @param _config - validated Config; unused on the Host.
 */
export function apply(_ctx: Context, _config: Config): void {}
