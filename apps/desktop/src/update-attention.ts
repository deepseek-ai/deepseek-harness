/** Best-effort background attention never grants update or task-stop authorization. */
import { app, type BrowserWindow, Notification } from 'electron'
import type { DesktopLocale } from './locale.ts'

/** Owns one reminder per downloaded version until reset for a new download. */
export class DesktopUpdateAttention {
  private version: string | undefined
  private notification: Notification | undefined
  private stop: (() => void) | undefined

  /**
   * @param locale - Shell-owned notification copy.
   * @param platform - Native attention implementation, replaceable for platform tests.
   */
  constructor(private readonly locale: DesktopLocale, private readonly platform: string = process.platform) {}

  /**
   * @param version - Prepared target whose confirmation is waiting.
   * @param parent - Taskbar window; never restored or focused by the reminder.
   * @param modal - Existing installation confirmation.
   * @param returnToConfirmation - Rechecks current policy and returns to UI without installing.
   */
  ready(version: string, parent: BrowserWindow, modal: BrowserWindow, returnToConfirmation: () => void): void {
    if (this.version === version) return
    this.version = version
    if (parent.isFocused() || modal.isFocused()) return
    const clear = (): void => { this.clear() }
    let bounce: number | undefined
    parent.on('focus', clear)
    modal.on('focus', clear)
    this.stop = () => {
      parent.off('focus', clear)
      modal.off('focus', clear)
      if (this.platform === 'win32' && !parent.isDestroyed()) parent.flashFrame(false)
      if (bounce !== undefined) app.dock?.cancelBounce(bounce)
    }
    try {
      if (this.platform === 'win32') parent.flashFrame(true)
      if (this.platform === 'darwin') bounce = app.dock?.bounce('informational')
    } catch (error) { console.warn('desktop update: attention unavailable', error) }
    try {
      if (!Notification.isSupported()) return
      const notification = new Notification({ title: this.locale.messages.mandatoryReady,
        body: this.locale.messages.mandatoryNotification, silent: true })
      this.notification = notification
      notification.on('failed', () => {
        if (this.notification === notification) this.notification = undefined
        notification.removeAllListeners()
      })
      notification.once('click', () => {
        if (this.notification !== notification) return
        this.clear()
        returnToConfirmation()
      })
      notification.show()
    } catch (error) { console.warn('desktop update: notification unavailable', error) }
  }

  /** Release owned native reminders without scheduling another for the same target. */
  clear(): void {
    const notification = this.notification
    this.notification = undefined
    notification?.removeAllListeners()
    try { notification?.close() }
    catch (error) { console.warn('desktop update: could not close notification', error) }
    const stop = this.stop
    this.stop = undefined
    try { stop?.() }
    catch (error) { console.warn('desktop update: could not clear attention', error) }
  }

  /** Start a new download episode, or dispose all owned reminders. */
  reset(): void { this.clear(); this.version = undefined }
}
