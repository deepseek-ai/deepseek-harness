import { WINDOWS_TITLEBAR_HEIGHT } from './windows-layout.ts'
/** Synchronizes Windows context menus and caption colors with the application document. */
import { ipcRenderer } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'
import { installWindowsMenu } from './preload-menu.ts'

/** Install the Windows-only titlebar marker and observe application language and palette changes. */
export function syncWindowsAppearance(): void {
  if (process.platform !== 'win32') return
  const mark = (): void => {
    const root = document.documentElement
    root.dataset.windowsTitlebar = ''
    root.style.setProperty('--dsh-windows-titlebar-height', `${WINDOWS_TITLEBAR_HEIGHT}px`)
  }
  // The root can be absent before the HTML parser creates it.
  if ((document.documentElement as HTMLElement | null) !== null) mark()
  const install = (): void => {
    mark()
    const root = document.documentElement
    const menu = installWindowsMenu()
    const probe = document.createElement('span')
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;background-color:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary)'
    document.body.append(probe)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) throw new Error('Desktop caption requires a 2D canvas context')
    const nativeColor = (color: string): string => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
      return `rgba(${red}, ${green}, ${blue}, ${Number(alpha) / 255})`
    }
    let previous = ''
    const send = (): void => {
      const style = getComputedStyle(probe)
      const color = nativeColor(style.backgroundColor)
      const symbolColor = nativeColor(style.color)
      const values = [root.lang, color, symbolColor]
      const current = JSON.stringify(values)
      if (current === previous) return
      previous = current
      menu.update()
      ipcRenderer.send(DESKTOP_IPC.windowsAppearance, ...values)
    }
    const observer = new MutationObserver(send)
    observer.observe(root, { attributes: true, attributeFilter: ['lang'] })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'] })
    observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    document.head.addEventListener('load', send, true)
    window.addEventListener('pagehide', () => {
      observer.disconnect()
      menu.dispose()
      probe.remove()
      document.head.removeEventListener('load', send, true)
    }, { once: true })
    send()
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', install, { once: true })
  else install()
}
