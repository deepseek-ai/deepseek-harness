/** Isolated update documents share their owner's native window and input lifetime. */
import { WebContentsView, type BrowserWindow, type WebContents, type View } from 'electron'
import type { EventEmitter } from 'node:events'
import { WINDOWS_TITLEBAR_HEIGHT } from './windows-layout.ts'

/** Main-owned document with no independent native window or activation state. */
export interface DesktopUpdateOverlay {
  readonly webContents: WebContents
  /** Focus the document only while its owner already has focus. */
  focus(): void
  /** Release the view, input interception, and owner listeners. */
  destroy(): void
  /** @returns Whether the document has been destroyed. */
  isDestroyed(): boolean
  /** @param url - Shell-owned document URL. @returns Completion of document loading. */
  loadURL(url: string): Promise<void>
}

type UpdateOwner = Pick<BrowserWindow, 'getContentBounds' | 'isDestroyed' | 'isFocused'>
  & Pick<EventEmitter, 'on' | 'once' | 'off'> & {
    readonly webContents: Pick<EventEmitter, 'prependListener' | 'off'> & Pick<WebContents, 'focus'>
    readonly contentView: Pick<View, 'addChildView' | 'removeChildView'>
  }

/** Tracks isolated update views and each owner's keyboard-blocking revision. */
export class DesktopUpdateOverlays {
  private readonly inputs = new WeakMap<object, { revision: number; active: number; readonly blocked: boolean }>()

  /** @param parent - Product window. @returns Blocking state and attachment/release revision. */
  input(parent: Pick<BrowserWindow, 'isDestroyed'>): { readonly revision: number; readonly blocked: boolean } {
    const state = this.inputs.get(parent)
    return { revision: state?.revision ?? 0, blocked: state?.blocked ?? false }
  }

  /**
   * @param parent - Native owner; its caption remains operable.
   * @param preload - Isolated shell preload.
   * @returns Document attached inside the owner, without showing or activating a native window.
   */
  create(parent: UpdateOwner, preload: string): DesktopUpdateOverlay {
    const view = new WebContentsView({ webPreferences: {
      preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
    } })
    const ownerContents = parent.webContents
    const contents = view.webContents
    const input = this.inputs.get(parent) ?? { revision: 0, active: 0, get blocked() { return this.active > 0 } }
    this.inputs.set(parent, input)
    input.active++; input.revision++
    const resize = (): void => {
      const { width, height } = parent.getContentBounds()
      const top = process.platform === 'win32' ? WINDOWS_TITLEBAR_HEIGHT : 0
      view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) })
    }
    const focus = (): void => {
      if (!parent.isDestroyed() && parent.isFocused() && !contents.isDestroyed()) contents.focus()
    }
    const block = (event: Electron.Event): void => { event.preventDefault(); focus() }
    const destroy = (): void => { if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false }) }
    const release = (): void => {
      parent.off('resize', resize)
      parent.off('focus', focus)
      parent.off('closed', destroy)
      ownerContents.off('before-input-event', block)
      input.active--; input.revision++
      if (!parent.isDestroyed()) {
        parent.contentView.removeChildView(view)
        if (parent.isFocused()) ownerContents.focus()
      }
    }
    view.setBackgroundColor('#00000000')
    parent.contentView.addChildView(view)
    resize()
    parent.on('resize', resize)
    parent.on('focus', focus)
    parent.once('closed', destroy)
    ownerContents.prependListener('before-input-event', block)
    contents.once('destroyed', release)
    contents.on('did-finish-load', focus)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    return { webContents: contents, focus, destroy, isDestroyed: () => contents.isDestroyed(),
      loadURL: url => contents.loadURL(url) }
  }
}
