/** Main-owned update confirmations; closing or replacing a dialog never grants installation permission. */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron'
import type { DesktopLocale } from './locale.ts'
import type { DesktopUpdateOverlays } from './update-overlay.ts'

/** Channels available only to the isolated update-dialog document. */
export const UPDATE_DIALOG_IPC = { status: 'dsh-update-dialog:status', changed: 'dsh-update-dialog:changed', respond: 'dsh-update-dialog:respond' } as const

/** Text and choices supplied by the main process, never by product documents. */
export interface UpdateDialogView {
  /** Identifies the displayed choices; a response from an older prompt is rejected. */
  readonly revision: number
  readonly locale: string
  readonly title: string
  readonly message: string
  readonly detail: string
  readonly buttons: readonly string[]
  readonly cancelId: number
  readonly closeLabel: string
  readonly technicalDetails: string
  readonly technicalDetailsLabel: string
}

/** Electron message options with separately expandable, main-owned diagnostics. */
export interface UpdateDialogOptions extends MessageBoxOptions {
  readonly technicalDetails?: string
}

/** The document can select only a displayed response index. */
export interface UpdateDialogApi {
  status(): Promise<UpdateDialogView | null>
  respond(revision: number, index: number): Promise<void>
  subscribe(listener: (view: UpdateDialogView | null) => void): () => void
}

// main.ts's protocol.handle shell route serves this document and its renderer assets; the modal requires that route.
const page = 'dsh-app://shell/update-dialog.html'

/** One fading backdrop with replaceable confirmation content; aborted checks and mandatory policy cancel ordinary prompts. */
export class DesktopUpdateDialog {
  private disposed = false
  private revision = 0
  private window: BrowserWindow | undefined
  private parent: BrowserWindow | undefined
  private closing: ReturnType<typeof setTimeout> | undefined
  private active: { window: BrowserWindow; view: UpdateDialogView; finish: (index: number, retain?: boolean) => void } | undefined

  /** Focus the current explanation or confirmation without replacing it or granting permission. */
  focus(): void { this.active?.window.focus() }

  /** Whether a shell prompt is awaiting a response. */
  get isOpen(): boolean { return this.active !== undefined }

  /**
   * @param preload - Bundled isolated preload.
   * @param locale - Shell-owned copy or a reader of the current UI language.
   * @param overlays - Application-owned overlay creation and input tracking.
   */
  constructor(private readonly preload: string, private readonly locale: DesktopLocale | (() => DesktopLocale),
    private readonly overlays: Pick<DesktopUpdateOverlays, 'create'>) {
    ipcMain.handle(UPDATE_DIALOG_IPC.status, (event) => { this.owned(event); return this.active?.view ?? null })
    ipcMain.handle(UPDATE_DIALOG_IPC.respond, (event, revision: unknown, index: unknown) => {
      this.owned(event)
      const active = this.active
      if (active === undefined || revision !== active.view.revision) throw new Error('desktop update: stale dialog response')
      if (typeof index !== 'number' || !Number.isInteger(index)
        || (index !== active.view.cancelId && (index < 0 || index >= active.view.buttons.length))) {
        throw new Error('desktop update: invalid dialog response')
      }
      active.finish(index)
    })
  }

  /**
   * @param parent - Window blocked by this confirmation.
   * @param options - Main-owned localized content, response choices, and optional cancellation signal.
   * @returns A displayed response, or cancellation on replacement, abort, close, or load failure; backdrop dismissal fades independently.
   */
  show(parent: BrowserWindow, options: UpdateDialogOptions): Promise<MessageBoxReturnValue> {
    const locale = typeof this.locale === 'function' ? this.locale() : this.locale
    const buttons = options.buttons ?? [locale.messages.updateAcknowledge]
    const cancelId = options.cancelId ?? buttons.length - 1
    if (this.disposed || options.signal?.aborted === true || parent.isDestroyed()) {
      return Promise.resolve({ response: cancelId, checkboxChecked: false })
    }
    if (this.parent !== parent) { this.cancel(); this.close() }
    this.active?.finish(this.active.view.cancelId, true)
    clearTimeout(this.closing)
    this.closing = undefined
    const existing = this.window
    const window = existing ?? this.overlays.create(parent, this.preload, options.title ?? locale.messages.updateTitle, false)
    this.window = window
    this.parent = parent
    const view: UpdateDialogView = { revision: ++this.revision, locale: locale.id, title: options.title ?? '', message: options.message,
      detail: options.detail ?? '', buttons, cancelId, closeLabel: locale.messages.updateClose,
      technicalDetails: options.technicalDetails ?? '', technicalDetailsLabel: locale.messages.updateTechnicalDetails }
    return new Promise((resolve) => {
      const abort = (): void => { finish(cancelId) }
      const finish = (response: number, retain = false): void => {
        if (this.active?.view !== view) return
        this.active = undefined
        options.signal?.removeEventListener('abort', abort)
        if (!retain && !window.isDestroyed()) {
          window.webContents.send(UPDATE_DIALOG_IPC.changed, null)
          this.closing = setTimeout(() => { this.close() }, 150)
        }
        resolve({ response, checkboxChecked: false })
      }
      this.active = { window, view, finish }
      options.signal?.addEventListener('abort', abort, { once: true })
      if (existing !== undefined) { window.webContents.send(UPDATE_DIALOG_IPC.changed, view); return }
      const failed = (): void => { if (this.window === window) { this.cancel(); this.close() } }
      window.once('closed', failed)
      window.webContents.on('will-navigate', (event, url) => { if (url !== page) event.preventDefault() })
      window.webContents.once('render-process-gone', failed)
      void window.loadURL(page).catch(failed)
    })
  }

  /** Cancel the displayed prompt without authorizing any operation. */
  cancel(): void { this.active?.finish(this.active.view.cancelId) }

  /** Close the document and detach its private IPC handlers. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel()
    this.close()
    ipcMain.removeHandler(UPDATE_DIALOG_IPC.status)
    ipcMain.removeHandler(UPDATE_DIALOG_IPC.respond)
  }

  private close(): void {
    clearTimeout(this.closing)
    this.closing = undefined
    const window = this.window
    this.window = undefined
    this.parent = undefined
    if (window !== undefined && !window.isDestroyed()) window.destroy()
  }

  private owned(event: IpcMainInvokeEvent): void {
    const window = this.window
    if (window === undefined || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) {
      throw new Error('desktop update: rejected unowned dialog renderer')
    }
  }
}
