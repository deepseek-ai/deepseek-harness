/** One-time Windows confirmation before hiding the application in the tray. */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import type { DesktopLocale } from './locale.ts'

/** Persistent acknowledgement and the shared shell dialog. */
export interface DesktopBackgroundNoticeOptions {
  /** Acknowledgement under Electron userData; updates retain it and uninstall removes it. */
  readonly markerPath: string
  readonly locale: () => DesktopLocale
  readonly show: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  readonly focus: () => void
}

/** Only an explicit acknowledgement permits the first hide; cancelled prompts remain eligible. */
export class DesktopBackgroundNotice {
  private acknowledged = false
  private pending = false
  private disposed = false

  /** @param options - Marker path, localized copy, and shell dialog actions. */
  constructor(private readonly options: DesktopBackgroundNoticeOptions) {}

  /**
   * Request a window hide, prompting until acknowledged and coalescing repeated requests.
   * @param hide - Hide the still-owned window after acknowledgement, or immediately when already recorded.
   */
  close(hide: () => void): void {
    if (this.disposed) return
    if (this.pending) { this.options.focus(); return }
    if (this.acknowledged || existsSync(this.options.markerPath)) { hide(); return }
    this.pending = true
    void this.confirm(hide)
  }

  /** Ignore late dialog responses after application shutdown begins. */
  dispose(): void { this.disposed = true }

  private async confirm(hide: () => void): Promise<void> {
    try {
      const { messages } = this.options.locale()
      const result = await this.options.show({ type: 'info', title: messages.aboutProduct,
        message: messages.backgroundNoticeBody, buttons: [messages.backgroundNoticeConfirm], defaultId: 0, cancelId: -1 })
      if (this.disposed || result.response !== 0) return
      this.acknowledged = true
      try {
        mkdirSync(dirname(this.options.markerPath), { recursive: true })
        writeFileSync(this.options.markerPath, '')
      } catch (error) { console.warn('desktop tray: could not record background confirmation', error) }
      hide()
    } catch (error) { console.warn('desktop tray: background confirmation unavailable', error) }
    finally { this.pending = false }
  }
}
