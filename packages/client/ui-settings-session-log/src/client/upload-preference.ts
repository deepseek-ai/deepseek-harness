/** Ordered preference writes and notices that survive the settings panel. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Fields exposed by the Session-log plugin. */
export interface UploadSettings {
  enabled: boolean
}

/** Mutation state shared by the preference row and shell notice. */
export interface UploadMutation {
  busy: boolean
  notice: 'saved' | 'failed' | null
  sequence: number
}

/** Writes the Host setting without publishing an optimistic upload state. */
export class UploadPreference {
  /** Observable mutation outcome. */
  readonly state = createSnapshotStore<UploadMutation>({ busy: false, notice: null, sequence: 0 })

  /** @param form - Host-owned configuration form. */
  constructor(private readonly form: ConfigForm<UploadSettings>) {}

  /**
   * Persist enablement; refusal or transport failure leaves the accepted value visible.
   * @param enabled - requested upload state.
   * @returns completion after the write settles.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    if (this.state.getSnapshot().busy) return
    this.state.update((state) => { state.busy = true; state.notice = null })
    let accepted = false
    try {
      accepted = await this.form.set('enabled', enabled)
    } catch (_error) {
      // The shell notice reports the failed write while the form retains accepted state.
    }
    this.state.update((state) => {
      state.busy = false
      state.notice = accepted ? 'saved' : 'failed'
      state.sequence++
    })
  }

  /** Clear the displayed mutation notice. */
  dismiss(): void {
    this.state.update((state) => { state.notice = null })
  }
}
