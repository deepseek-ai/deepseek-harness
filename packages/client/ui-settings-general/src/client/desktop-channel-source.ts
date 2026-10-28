/** One shell-owned channel subscription shared by Settings views. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DesktopChannelBridge, DesktopChannelState, DesktopUpdateChannel } from '../types.ts'

/** Client observation; no Host service or configuration file is read here. */
export class DesktopChannelSource {
  /** Stable settings observation shared by mounted General views. */
  readonly store = createSnapshotStore<{ state?: DesktopChannelState; failed: boolean }>({ failed: false })
  private live = true
  private revision = 0
  private readonly unsubscribe: () => void

  /** @param bridge - Isolated shell API, present only in Desktop. */
  constructor(private readonly bridge: DesktopChannelBridge) {
    this.unsubscribe = bridge.subscribe((state) => {
      if (!this.live) return
      this.revision++
      this.store.set({ state, failed: false })
    })
    void bridge.get().then((state) => {
      if (this.live && this.revision === 0) this.store.set({ state, failed: false })
    }, () => {
      if (this.live && this.revision === 0) this.store.set({ failed: true })
    })
  }

  /**
   * Ask the shell to persist and apply a UI choice; failures remain visible.
   * @param channel - Selected feed.
   * @returns After the shell reports the result.
   */
  async select(channel: DesktopUpdateChannel): Promise<void> {
    if (!this.isLive()) return
    const revision = this.revision
    try {
      const state = await this.bridge.set(channel)
      if (this.live && revision === this.revision) this.store.set({ state, failed: false })
    } catch (_error) {
      if (this.live && revision === this.revision) this.store.set({ ...this.store.getSnapshot(), failed: true })
    }
  }

  private isLive(): boolean { return this.live }

  /** Detach the shell subscription and ignore late IPC responses. */
  dispose(): void { this.live = false; this.unsubscribe() }
}
