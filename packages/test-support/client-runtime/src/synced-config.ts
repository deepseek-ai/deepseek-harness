/** Synced Config objects for specs that mount a Client plugin face directly instead of through the page entry controller. */
import type { SyncedConfig, SyncedConfigValues } from '@deepseek-ai/dsh-client-config/types'
import { SyncedConfigEntry } from '@deepseek-ai/dsh-client-modules/src/client/synced-config.ts'

/**
 * Build the object a plugin activation receives as its `apply` config, holding fixed values.
 * @param values - JSON values of the plugin's top-level volatile fields.
 * @returns the activation's read-only Config object.
 */
export function syncedConfig<C>(values: SyncedConfigValues): SyncedConfig<C> {
  return new SyncedConfigEntry(values).activate() as SyncedConfig<C>
}
