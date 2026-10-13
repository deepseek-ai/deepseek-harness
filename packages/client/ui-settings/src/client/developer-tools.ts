/** One accepted preference drives every developer-tool consumer. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { DeveloperToolsSettings } from '../developer-tools-settings.ts'
import type { ConfigForm } from './config-form-types.ts'

/** Shared preference; Host-backed features stay disabled until an accepted value arrives. */
export class DeveloperToolsPreference {
  /** Accepted enablement, observable through renderer-bound hooks. */
  readonly enabled: ObservableSnapshot<boolean>

  /**
   * @param scope - settings-owned namespace controller.
   */
  constructor(private readonly scope: ConfigForm<DeveloperToolsSettings>) {
    this.enabled = {
      getSnapshot: () => scope.getSnapshot().value?.enabled ?? false,
      subscribe: (listener) => {
        let previous = this.enabled.getSnapshot()
        return scope.subscribe(() => {
          const next = this.enabled.getSnapshot()
          if (next === previous) return
          previous = next
          listener()
        })
      },
    }
  }

  /**
   * Persist the choice on the Host with ordered writes.
   * @param enabled - requested developer-tool mode.
   * @returns settlement after Host acceptance; rejects after a refused write recovers.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    if (!await this.scope.set('enabled', enabled)) throw new Error('Developer tools preference was not saved')
  }
}
