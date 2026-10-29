/** Real Chromium qualification of shared shell tokens and app-resolved palette changes. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, nativeTheme, protocol } from 'electron'
import { resolveDesktopLocale } from '../../lib/types/locale.js'
import { UPDATE_DIALOG_IPC } from '../../lib/types/update-dialog.js'
import { MANDATORY_IPC } from '../../lib/types/mandatory-update-ipc.js'

const directory = fileURLToPath(new URL('../../.desktop-build/qualification/', import.meta.url))
mkdirSync(directory, { recursive: true })
const root = mkdtempSync(join(directory, 'update-theme-'))
app.setPath('userData', root)
protocol.registerSchemesAsPrivileged([{ scheme: 'dsh-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const original = nativeTheme.themeSource
  const locale = resolveDesktopLocale('en')
  const results = []
  const windows = []
  const deadline = setTimeout(() => { console.error('Theme qualification deadline exceeded'); app.exit(1) }, 30000)
  protocol.handle('dsh-app', async request => {
    const name = new URL(request.url).pathname.slice(1)
    const file = new URL(`${name === 'design-platform.css' ? '../../lib/welcome' : '../../renderer'}/${name}`, import.meta.url)
    const mime = name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript'
      : name.endsWith('.svg') ? 'image/svg+xml' : 'text/html'
    return new Response(await readFile(file), { headers: { 'content-type': mime } })
  })
  ipcMain.handle(UPDATE_DIALOG_IPC.status, () => ({ revision: 1, locale: locale.id,
    title: 'Check for updates', message: 'Update ready', detail: 'Shell palette qualification',
    buttons: ['Install', 'Later'], cancelId: 1, closeLabel: 'Close', technicalDetails: 'Details', technicalDetailsLabel: 'Details' }))
  ipcMain.handle(MANDATORY_IPC.status, () => ({ locale, policy: { blocking: true, checking: false },
    update: { phase: 'error', failedOperation: 'download', version: '1.0.0', technicalDetails: 'Details' }, deferred: false }))
  try {
    assert.equal(await readFile(new URL('../../lib/welcome/design-platform.css', import.meta.url), 'utf8'),
      await readFile(new URL('../../../../packages/client/ui-theme/src/styles/design-platform.css', import.meta.url), 'utf8'))
    for (const document of ['update-dialog', 'mandatory-update']) {
      for (const initial of ['light', 'dark']) {
        nativeTheme.themeSource = initial
        const window = new BrowserWindow({ show: true, width: 600, height: 650,
          webPreferences: { preload: fileURLToPath(new URL(`../../lib/preload-${document === 'update-dialog' ? 'update-dialog' : 'mandatory'}.cjs`, import.meta.url)),
            contextIsolation: true, sandbox: true, nodeIntegration: false } })
        windows.push(window)
        // Palette checks exclude the user's pointer so hover cannot select an interaction color.
        window.setIgnoreMouseEvents(true)
        await window.loadURL(`dsh-app://shell/${document}.html`)
        for (const source of [initial, initial === 'light' ? 'dark' : 'light', 'system']) {
          nativeTheme.themeSource = source
          const dark = nativeTheme.shouldUseDarkColors
          const colors = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const dark = ${dark};
            const deadline = setTimeout(() => { observer.disconnect(); reject(new Error('Palette did not settle')); }, 10000);
            const observer = new MutationObserver(check);
            function check() {
              if (!document.body.classList.contains('visible') || document.body.hasAttribute('data-ds-dark-theme') !== dark) return;
              observer.disconnect(); clearTimeout(deadline);
              const card = getComputedStyle(document.querySelector('main'));
              const primary = getComputedStyle(document.querySelector('.primary'));
              resolve({ dark, surface: card.backgroundColor, label: card.color, primary: primary.backgroundColor,
                primaryLabel: primary.color, boxShadow: card.boxShadow,
                diagnostic: getComputedStyle(document.querySelector('pre, #address')).backgroundColor, body: getComputedStyle(document.body).backgroundColor,
                mask: getComputedStyle(document.body, '::before').backgroundColor,
                close: document.querySelector('.close') ? getComputedStyle(document.querySelector('.close'), '::before').backgroundColor : null });
            }
            observer.observe(document.body, { attributes: true }); check();
          })`)
          const { boxShadow, ...palette } = colors
          if (dark) assert.match(boxShadow, /0px 0px 0px 1px inset$/)
          else assert.equal(boxShadow, 'none')
          assert.deepEqual(palette, { dark, surface: dark ? 'rgb(35, 35, 36)' : 'rgb(255, 255, 255)',
            label: dark ? 'rgb(249, 250, 251)' : 'rgb(15, 17, 21)',
            primary: dark ? 'rgb(249, 250, 251)' : 'rgb(15, 17, 21)',
            primaryLabel: dark ? 'rgb(53, 54, 56)' : 'rgb(255, 255, 255)',
            diagnostic: dark ? 'rgb(27, 27, 28)' : 'rgb(249, 250, 251)', body: 'rgba(0, 0, 0, 0)',
            mask: dark ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.24)',
            close: document === 'update-dialog' ? dark ? 'rgb(249, 250, 251)' : 'rgb(15, 17, 21)' : null })
          results.push({ document, initial, source, ...colors })
          if (source === initial) {
            await window.webContents.executeJavaScript('Promise.all(document.getAnimations().map(animation => animation.finished))')
            await writeFile(join(root, `${document}-${initial}.png`), (await window.webContents.capturePage()).toPNG())
          }
        }
        window.destroy()
      }
    }
    await writeFile(join(root, 'result.json'), JSON.stringify(results, null, 2) + '\n')
    console.log(`Update theme qualification passed (${results.length} cases): ${root}`)
  } finally {
    clearTimeout(deadline)
    for (const window of windows) if (!window.isDestroyed()) window.destroy()
    ipcMain.removeHandler(UPDATE_DIALOG_IPC.status)
    ipcMain.removeHandler(MANDATORY_IPC.status)
    protocol.unhandle('dsh-app')
    nativeTheme.themeSource = original
  }
}
void main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
