/** Shell-owned modal windows cover the parent's content without replacing its native window controls. */
import { BrowserWindow } from 'electron'

const unblockedInput = { revision: 0, blocked: false } as const

/** Tracks application-owned update overlays and their parent input state. */
export class DesktopUpdateOverlays {
  private readonly inputStates = new WeakMap<BrowserWindow, { revision: number; active: number; readonly blocked: boolean }>()

  /**
   * @param parent - Product window whose input may belong to an update dialog.
   * @returns Current blocking state; its revision changes whenever an overlay opens or closes.
   */
  input(parent: BrowserWindow): { readonly revision: number; readonly blocked: boolean } {
    return this.inputStates.get(parent) ?? unblockedInput
  }

  /**
   * @param parent - Product window whose content is blocked while the overlay is open.
   * @param preload - Isolated shell-only preload.
   * @param title - Localized window title.
   * @param nativeModal - Use a native modal; false keeps overlays out of macOS sheets.
   * @returns A transparent child that follows its parent's bounds and visibility after loading and releases its listeners on close.
   */
  create(parent: BrowserWindow, preload: string, title: string, nativeModal = true): BrowserWindow {
    const window = new BrowserWindow({
      parent, modal: nativeModal || process.platform !== 'darwin', show: false, frame: false, transparent: true,
      ...parent.getContentBounds(), resizable: false, minimizable: false, maximizable: false,
      skipTaskbar: true, hasShadow: false, title,
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
    })
    const inputState = this.inputStates.get(parent) ?? { revision: 0, active: 0, get blocked() { return this.active > 0 } }
    this.inputStates.set(parent, inputState)
    inputState.active++; inputState.revision++
    window.once('closed', () => { inputState.active--; inputState.revision++ })
    // macOS native modals animate the entire viewport as a sheet.
    const focus = (): void => { if (!window.isDestroyed()) window.focus() }
    const blockInput = (event: Electron.Event): void => { event.preventDefault(); focus() }
    if (!nativeModal && process.platform === 'darwin') {
      parent.on('focus', focus)
      // Shell dialogs block input before product shortcut listeners can dispatch it.
      parent.webContents.prependListener('before-input-event', blockInput)
      window.once('closed', () => {
        parent.off('focus', focus)
        if (!parent.isDestroyed()) parent.webContents.off('before-input-event', blockInput)
      })
    }
    const follow = (): void => { if (!window.isDestroyed()) window.setBounds(parent.getContentBounds()) }
    parent.on('move', follow)
    parent.on('resize', follow)
    window.once('closed', () => { parent.off('move', follow); parent.off('resize', follow) })
    let ready = false
    const show = (): void => {
      if (ready && !window.isDestroyed() && !parent.isDestroyed() && parent.isVisible()) window.show()
    }
    parent.on('show', show)
    window.once('closed', () => { parent.off('show', show) })
    window.once('ready-to-show', () => { ready = true; show() })
    window.setMenu(null)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    return window
  }
}
