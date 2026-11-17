/** Native-owner visibility and focus qualification for isolated in-window update views. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { DesktopUpdateOverlays } from '../../lib/types/update-overlay.js'
const directory = fileURLToPath(new URL('../../.desktop-build/qualification/', import.meta.url))
mkdirSync(directory, { recursive: true })
const root = mkdtempSync(join(directory, 'update-overlay-'))
mkdirSync(join(root, 'profile'))
app.setPath('userData', join(root, 'profile'))
app.on('window-all-closed', () => {})
async function main() {
  await app.whenReady()
  const cases = []
  const windows = []
  const deadline = setTimeout(() => { console.error('Overlay qualification deadline exceeded'); app.exit(1) }, 30000)
  try {
    for (const initiallyVisible of [true, false]) {
      const parent = new BrowserWindow({ show: initiallyVisible, width: 800, height: 600 })
      windows.push(parent)
      await parent.loadURL('data:text/html,<h1>Update owner</h1>')
      const overlays = new DesktopUpdateOverlays()
      const overlay = overlays.create(parent, undefined)
      await overlay.loadURL('data:text/html,<h1>Isolated update</h1>')
      assert.equal(parent.getChildWindows().length, 0)
      assert.equal(parent.contentView.children.length, 1)
      const control = new BrowserWindow({ show: true, width: 300, height: 200 })
      windows.push(control)
      await control.loadURL('data:text/html,<h1>Focus control</h1>')
      const focused = control.isFocused() ? undefined : once(control, 'focus')
      control.focus(); await focused
      parent.emit('show')
      assert.equal(control.isFocused(), true)
      assert.equal(parent.isFocused(), false)
      const destroyed = once(overlay.webContents, 'destroyed')
      overlay.destroy(); await destroyed
      cases.push({ initiallyVisible, childWindows: parent.getChildWindows().length, controlKeepsFocus: control.isFocused(),
        viewsReleased: parent.contentView.children.length === 0, input: overlays.input(parent) })
      parent.destroy(); control.destroy()
    }
    const parent = new BrowserWindow({ show: false })
    windows.push(parent)
    const overlay = new DesktopUpdateOverlays().create(parent, undefined)
    const destroyed = once(overlay.webContents, 'destroyed')
    parent.destroy(); await destroyed
    cases.push({ parentDestroyed: parent.isDestroyed(), overlayDestroyed: overlay.isDestroyed() })
    assert.deepEqual(cases, JSON.parse(await readFile(new URL('../expected/update-overlay-visibility.json', import.meta.url), 'utf8')))
    await writeFile(join(root, 'result.json'), JSON.stringify(cases, null, 2) + '\n')
    console.log(`Update view qualification passed: ${root}`)
  } finally {
    clearTimeout(deadline)
    for (const window of windows) if (!window.isDestroyed()) window.destroy()
  }
}
void main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
