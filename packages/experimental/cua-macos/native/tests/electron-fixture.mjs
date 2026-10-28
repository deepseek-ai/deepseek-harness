/** Disposable Electron application; renderer events independently record native input effects. */
import { app, BrowserWindow, Menu } from 'electron'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.argv[2]
if (!root || !isAbsolute(root)) throw new Error('An absolute private fixture directory is required')
for (const name of ['userData', 'sessionData', 'logs']) {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  app.setPath(name, directory)
}
app.setName('DSH CUA Electron fixture')
let window
let visible = false
let hasState = false
let ready = false
function announce() {
  if (visible && hasState && !ready) {
    ready = true
    process.stdout.write(`READY ${JSON.stringify({ pid: process.pid, electron: process.versions.electron })}\n`)
  }
}
process.on('SIGTERM', () => app.quit())
app.on('window-all-closed', () => app.quit())
void app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Fixture', submenu: [{ role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'selectAll' }] },
  ]))
  window = new BrowserWindow({
    title: 'DSH CUA Electron fixture', width: 600, height: 540, useContentSize: true,
    show: false, resizable: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('console-message', ({ message }) => {
    const prefix = 'DSH_CUA_STATE '
    if (!message.startsWith(prefix)) return
    const state = JSON.parse(message.slice(prefix.length))
    const temporary = join(root, 'state.next.json')
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    renameSync(temporary, join(root, 'state.json'))
    hasState = true
    announce()
  })
  window.once('ready-to-show', () => { window.show(); visible = true; announce() })
  await window.loadFile(join(dirname(fileURLToPath(import.meta.url)), 'electron-fixture.html'))
}).catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  app.exit(1)
})
