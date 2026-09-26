/** Native quit confirmation; quitting proceeds silently only when the Host reports nothing to interrupt. */

import type { MessageBoxOptions, MessageBoxReturnValue, NativeImage } from 'electron'
import type { DesktopQuitInspection } from './host-process.ts'
import type { DesktopLocale, DesktopMessages } from './locale.ts'

/** Locale key of the explanation shown before quitting, or none when quitting interrupts nothing. */
export type DesktopQuitPrompt = Extract<keyof DesktopMessages, 'quitActiveTasks' | 'quitScheduledTasks' | 'quitActiveAndScheduledTasks'> | undefined

/**
 * Choose the confirmation copy for one inspection result.
 * @param inspection - Host answer, or `unknown` when the inspection failed or missed its deadline.
 * @returns the explanation key; an unknown state warns about running tasks rather than quitting silently.
 */
export function resolveDesktopQuitPrompt(inspection: DesktopQuitInspection | 'unknown'): DesktopQuitPrompt {
  if (inspection === 'unknown') return 'quitActiveTasks'
  if (inspection.activeTasks && inspection.scheduledTasks) return 'quitActiveAndScheduledTasks'
  if (inspection.activeTasks) return 'quitActiveTasks'
  if (inspection.scheduledTasks) return 'quitScheduledTasks'
  return undefined
}

/** Main-process collaborators of the confirmation. */
export interface DesktopQuitConfirmationOptions {
  readonly locale: () => DesktopLocale
  /** Start one Host inspection; undefined while no Host is ready, when nothing can be running and the quit proceeds. */
  readonly inspect: () => Promise<DesktopQuitInspection> | undefined
  /** Native message box without an owner window: hidden windows stay hidden and the box comes to the front. */
  readonly show: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  /** Bring the open confirmation to the front when quit is requested again while it is open. */
  readonly focus: () => void
  readonly platform?: NodeJS.Platform
  /** Application icon for the Windows task dialog; macOS composes the app icon onto its warning icon itself. */
  readonly icon?: NativeImage
}

/** One quit decision at a time; repeated quit requests join the open confirmation instead of stacking. */
export class DesktopQuitConfirmation {
  private pending: Promise<boolean> | undefined
  private disposed = false

  /** @param options - Locale, inspection, and native dialog collaborators. */
  constructor(private readonly options: DesktopQuitConfirmationOptions) {}

  /**
   * Decide whether the quit may proceed. The inspection runs once per decision; work that starts or ends
   * while the confirmation is open does not change its copy, and approval never re-inspects.
   * @returns true to quit now, false when the user cancelled.
   */
  confirm(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    if (this.pending !== undefined) {
      this.options.focus()
      return this.pending
    }
    const pending = this.decide().finally(() => { if (this.pending === pending) this.pending = undefined })
    this.pending = pending
    return pending
  }

  /**
   * The application is quitting through a path that does not ask: a pending decision resolves to
   * false without opening a box, and later requests do the same. An already open native box has no
   * close API and disappears with the process.
   */
  dispose(): void { this.disposed = true }

  private async decide(): Promise<boolean> {
    const inspection = this.options.inspect()
    if (inspection === undefined) return true
    const prompt = resolveDesktopQuitPrompt(await inspection.catch((error: unknown) => {
      console.warn('desktop quit: task inspection unavailable', error)
      return 'unknown' as const
    }))
    if (this.disposed) return false
    if (prompt === undefined) return true
    const { messages } = this.options.locale()
    const windows = (this.options.platform ?? process.platform) === 'win32'
    // Button order follows each platform: macOS lays buttons out right-to-left from index 0, so
    // "Quit" sits right of "Cancel"; the Windows task dialog keeps array order, "Quit" left of "Cancel".
    const result = await this.options.show({
      type: windows ? 'none' : 'warning',
      ...(windows && this.options.icon !== undefined ? { icon: this.options.icon } : {}),
      title: messages.aboutProduct,
      message: messages.quitTitle,
      detail: messages[prompt],
      buttons: [messages.quit, messages.cancel],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- A bypassing quit can dispose while the box is open.
    if (this.disposed) return false
    return result.response === 0
  }
}
