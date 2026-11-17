/** Synced Config objects for Connection Client specs; this package cannot depend on the test runtime that depends on it. */
import type { SyncedConfig } from '@deepseek-ai/dsh-client-config/types'
import type { ConnectionRecoveryConfig } from '../src/recovery-config.ts'
import type { ConnectionConfig } from '../src/types.ts'

/**
 * Build the activation's synced Config holding a fixed recovery value.
 * @param recovery - synced recovery timing; omission models a value the Host did not send.
 * @returns the object a Client activation receives as its `apply` config.
 */
export function syncedConnectionConfig(recovery?: ConnectionRecoveryConfig): SyncedConfig<ConnectionConfig> {
  return { recovery: { get: () => recovery, getSnapshot: () => recovery, subscribe: () => () => {} } }
}
