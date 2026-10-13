/** Performance detail preference, live immediately and reconciled with accepted Host settings. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEFAULT_PERFORMANCE_USAGE, type ChatSettings, type PerformanceUsageMode } from '../chat-settings.ts'

/** Shared live preference for the settings row and chat statistics. */
export class PerformanceUsagePolicy {
  private readonly unsubscribe: () => void
  /** Current choice, reconciled with accepted Host settings when available. */
  readonly mode = createSnapshotStore<PerformanceUsageMode>(DEFAULT_PERFORMANCE_USAGE)

  /** @param host - Chat settings scope persisted through the Host. */
  constructor(private readonly host: ConfigForm<ChatSettings>) {
    const adopt = (): void => {
      const accepted = host.getSnapshot().value?.performanceUsage
      if (accepted !== undefined) this.mode.set(accepted)
    }
    this.unsubscribe = host.subscribe(adopt)
    adopt()
  }

  /** Release the accepted-value subscription. */
  dispose(): void { this.unsubscribe() }

  /**
   * Publish a choice immediately and queue its Host write.
   * @param mode - Statistics detail selected by the user.
   */
  setMode(mode: PerformanceUsageMode): void {
    if (mode === this.mode.getSnapshot()) return
    this.mode.set(mode)
    void this.host.set('performanceUsage', mode)
  }
}
