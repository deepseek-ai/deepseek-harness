import { WINDOWS_TITLEBAR_HEIGHT } from '../../lib/types/windows-layout.js'
/** Real Electron main entry, preload, shared Web Host, and local updater; no installer executes. */
import { mandatoryFrameDriver } from './mandatory-frame.mjs'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, Menu } from 'electron'
import updaterModule from 'electron-updater'
import { createUpdateServer } from './update-server.mjs'
import { fixture } from './workspace-update-adapters.mjs'
import { DesktopUpdateHttpExecutor } from '../../lib/types/update-http-executor.js'
import { desktopUpdateReadyConfirmation, resolveDesktopLocale } from '../../lib/types/locale.js'

const root = process.env.DSH_WORKSPACE_UPDATE_ROOT
assert.ok(root)
const interactive = process.argv.includes('--interactive')
const application = join(root, 'app')
app.setAppPath(application)
app.setPath('userData', join(root, 'electron'))
const entry = pathToFileURL(join(application, 'lib/main.js')).href
const adapters = new URL('./workspace-update-adapters.mjs', import.meta.url).href
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === entry && ['./update-coordinator.js', './host-process.js', './update-error.js'].includes(specifier)) {
    return { url: adapters, shortCircuit: true }
  }
  return next(specifier, context)
} })
const server = await createUpdateServer()
server.select('healthy', '0.1.6-nightly.1')
process.env.DSH_DESKTOP_APP_ID = 'com.deepseek.qualification'
process.env.DSH_DESKTOP_MANDATORY_UPDATE_CONFIG = JSON.stringify({ origin: new URL(server.url).origin,
  allowedPageOrigins: ['https://downloads.example.com'], intervalMs: 600_000, timeoutMs: 5000, maxBackoffMs: 600_000, jitter: 0 })
const config = join(root, 'app-update.yml')
await writeFile(config, 'updaterCacheDirName: private-workspace-cache\n')
const forbidden = () => { throw new Error('Qualification must not quit or relaunch through updater') }
const updater = new updaterModule.NsisUpdater(undefined, {
  version: '0.1.5-rc.1', name: 'workspace-update-qualification', isPackaged: true,
  appUpdateConfigPath: config, userDataPath: root, baseCachePath: root,
  whenReady: () => app.whenReady(), quit: forbidden, relaunch: forbidden, onQuit: forbidden,
})
updater.logger = null
updater.httpExecutor = new DesktopUpdateHttpExecutor(interactive ? 600_000 : 10_000)
updater.disableDifferentialDownload = true
updater.disableWebInstaller = true
updater.setFeedURL({ provider: 'generic', url: server.url, channel: 'nightly' })
updater.quitAndInstall = (...args) => { fixture.installations.push(args) }
fixture.updater = updater

async function observed(window, subject, operation) {
  const record = event => appendFile(join(root, 'operations.jsonl'), JSON.stringify({ at: Date.now(), subject, ...event }) + '\n')
  await record({ phase: 'start', url: window.webContents.getURL() })
  const contents = window.webContents
  const throttled = contents.getBackgroundThrottling()
  // Concurrent test windows may occlude this page; its real layout animations must still advance.
  contents.setBackgroundThrottling(false)
  let timer
  try {
    const result = await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Renderer operation timed out: ${subject}`)), 20_000)
    })])
    await record({ phase: 'done' })
    return result
  } catch (error) {
    const state = { destroyed: window.isDestroyed() }
    if (!state.destroyed) {
      Object.assign(state, { visible: window.isVisible(), focused: window.isFocused(), enabled: window.isEnabled() })
      let diagnosticTimer
      try {
        state.renderer = await Promise.race([window.webContents.executeJavaScript(`({
          visibility: document.visibilityState, focused: document.hasFocus(),
          animations: document.getAnimations().map(animation => ({ playState: animation.playState,
            pending: animation.pending, currentTime: animation.currentTime, playbackRate: animation.playbackRate,
            timing: animation.effect?.getComputedTiming() }))
        })`), new Promise((_, reject) => { diagnosticTimer = setTimeout(() => reject(new Error('Renderer diagnostics timed out')), 2000) })])
      } catch (diagnosticError) { state.diagnosticError = String(diagnosticError) }
      finally { clearTimeout(diagnosticTimer) }
    }
    await record({ phase: 'failed', error: String(error), state })
    throw error
  } finally {
    clearTimeout(timer)
    if (!contents.isDestroyed()) {
      contents.setBackgroundThrottling(throttled)
      assert.equal(contents.getBackgroundThrottling(), throttled)
    }
  }
}

async function documentReady(window, expression) {
  return observed(window, `document: ${expression}`, () => window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const test = () => { if (${expression}) { observer.disconnect(); clearTimeout(timer); resolve(true); } };
    const observer = new MutationObserver(test);
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(${JSON.stringify(`Document condition timed out: ${expression}`)})); }, 20000);
    observer.observe(document, { childList: true, subtree: true, attributes: true }); test();
  })`))
}
async function windowAt(url) {
  if (process.platform === 'win32' && url === 'dsh-app://shell/mandatory-update.html') {
    return mandatoryFrameDriver(await windowAt('dsh-app://app/'))
  }
  const existing = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url)
  if (existing) return existing
  return new Promise((resolve, reject) => {
    const watched = []
    const cleanup = () => { clearTimeout(timer); app.off('browser-window-created', watch); for (const [contents, check] of watched) contents.off('did-finish-load', check) }
    const watch = (_event, window) => {
      const contents = window.webContents
      const check = () => { if (contents.getURL() === url) { cleanup(); resolve(window) } }
      watched.push([contents, check]); contents.on('did-finish-load', check); check()
    }
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Window did not load ${url}`)) }, 25000)
    app.on('browser-window-created', watch)
    for (const window of BrowserWindow.getAllWindows()) watch(undefined, window)
  })
}
async function control(action) {
  const { url } = JSON.parse(await readFile(join(root, 'host-control.json'), 'utf8'))
  const response = await fetch(`${url}/${action}`, { method: 'POST', headers: { 'x-qualification-token': process.env.DSH_WORKSPACE_UPDATE_TOKEN } })
  assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text())
  return response.json()
}
async function screenshot(window, name) {
  await observed(window, `screenshot layout: ${name}`, () => window.webContents.executeJavaScript(`(async () => {
    await new Promise(resolve => requestAnimationFrame(resolve));
    const finite = document.getAnimations().filter(animation => animation.effect
      && Number.isFinite(animation.effect.getComputedTiming().endTime));
    await Promise.all(finite.map(animation => animation.finished));
  })()`))
  await writeFile(join(root, name), (await observed(window, `capture: ${name}`, () => window.webContents.capturePage())).toPNG())
}
async function waitFor(check, subject) {
  const deadline = Date.now() + 20_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${subject}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
async function press(window, expression) {
  window.focus()
  await documentReady(window, `(() => { const target = ${expression}; return target && !target.disabled && target.getClientRects().length > 0; })()`)
  const point = await observed(window, `click layout: ${expression}`, () => window.webContents.executeJavaScript(`(async () => {
    const target = ${expression};
    const movements = document.getAnimations().filter(animation => animation.effect instanceof KeyframeEffect
      && animation.effect.target instanceof Element && animation.effect.target.contains(target)
      && Number.isFinite(animation.effect.getComputedTiming().endTime));
    await Promise.all(movements.map(animation => animation.finished));
    const rect = target.getBoundingClientRect();
    const point = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    if (!target.contains(document.elementFromPoint(point.x, point.y))) throw new Error('Click target is obscured');
    return point;
  })()`))
  await window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  await window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  await window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
}
async function clickText(window, label) {
  const title = await window.webContents.executeJavaScript("document.getElementById('title').textContent")
  await press(window, `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})`)
  await waitFor(async () => window.isDestroyed()
    || await window.webContents.executeJavaScript("document.getElementById('title').textContent") !== title, `dialog response: ${label}`)
}
async function dialogWith(message) {
  let found
  await waitFor(async () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.webContents.getURL() !== 'dsh-app://shell/update-dialog.html') continue
      try {
        const ready = await window.webContents.executeJavaScript(`document.getElementById('title')?.textContent === ${JSON.stringify(message)} && !!document.querySelector('#actions button')`)
        if (ready) { found = window; return true }
      } catch (error) { if (!window.isDestroyed()) throw error }
    }
    return false
  }, `dialog: ${message}`)
  return found
}
async function qualify() {
  let mainWindow
  try {
    await import(entry)
    console.log('workspace qualification: compiled main module loaded')
    await fixture.ready.promise
    console.log('workspace qualification: Host process ready')
    mainWindow = await windowAt('dsh-app://app/')
    await documentReady(mainWindow, `document.querySelector('[class*="frame"]') && window.dshDesktop?.updates`)
    assert.equal(mainWindow.isVisible(), true, 'Workspace qualification requires a visible application window')
    console.log('workspace qualification: workspace document ready')
    const acknowledgeNotice = `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '继续')`
    await press(mainWindow, acknowledgeNotice)
    await waitFor(async () => !await mainWindow.webContents.executeJavaScript(`!!(${acknowledgeNotice})`), 'first-run notice dismissal')
    console.log('workspace qualification: first-run notice dismissed')
    await waitFor(async () => !await fixture.host.updateTasks('inspect'), 'workspace startup API requests to settle')
    console.log('workspace qualification: startup API requests settled')
    const messages = resolveDesktopLocale(app.getLocale()).messages
    await screenshot(mainWindow, 'workspace.png')
    let menu
    if (process.platform === 'win32') {
      const popup = Menu.prototype.popup
      try {
        Menu.prototype.popup = function (options) { menu = this.items; options.callback?.() }
        await mainWindow.webContents.executeJavaScript("document.querySelector('[data-windows-menu]').shadowRoot.querySelector('button').click()")
        await waitFor(() => menu !== undefined, 'Windows application menu')
      } finally { Menu.prototype.popup = popup }
    } else menu = Menu.getApplicationMenu().items[0].submenu.items
    const checkMenu = menu.find(item => item.label === messages.checkUpdatesMenu)
    assert.ok(checkMenu)
    if (interactive) {
      const { runInteractiveUpdates } = await import('./workspace-updates-interactive.mjs')
      await runInteractiveUpdates({ mainWindow, server, fixture, checkMenu, control, root })
      return
    }
    const cases = ['real-workspace-preload-and-host']

    server.select('hold-check', '0.1.5-rc.1')
    checkMenu.click()
    await server.arrived()
    const checking = await dialogWith(messages.updateChecking)
    await screenshot(checking, 'checking.png')
    server.release()
    const current = await dialogWith(messages.updateCurrent)
    assert.equal(current, checking)
    await clickText(current, messages.updateAcknowledge)
    assert.equal(server.requests.filter(path => path === '/payload.exe').length, 0)
    cases.push('native-menu-checking-and-current-without-download')
    console.log('workspace qualification: manual no-update feedback complete')

    server.select('healthy', '0.1.6-nightly.1')
    checkMenu.click()
    const available = await dialogWith(messages.updateAvailable.replace('{version}', '0.1.6-nightly.1'))
    server.select('corrupt', '0.1.6-nightly.1')
    await clickText(available, messages.updateDownload)
    await waitFor(() => fixture.coordinator.state.phase === 'error', 'checksum failure')
    const downloadError = await dialogWith(messages.updateDownloadFailed)
    assert.equal(await downloadError.webContents.executeJavaScript("document.getElementById('technical-details').open"), false)
    assert.equal(await downloadError.webContents.executeJavaScript("document.getElementById('technical-details-content').textContent"), fixture.coordinator.state.message)
    await screenshot(downloadError, 'download-error.png')
    await clickText(downloadError, messages.updateAcknowledge)
    await documentReady(mainWindow, `document.querySelector('button[data-error="true"]')`)
    await screenshot(mainWindow, 'retry.png')
    await press(mainWindow, `document.querySelector('button[aria-label="收起侧边栏"]')`)
    await documentReady(mainWindow, `document.querySelector('button[aria-label="打开侧边栏"] [role="img"][data-error="true"]')`)
    await screenshot(mainWindow, 'collapsed-error.png')
    await press(mainWindow, `document.querySelector('button[aria-label="打开侧边栏"]')`)
    await documentReady(mainWindow, `document.querySelector('button[data-error="true"]')`)
    cases.push('download-integrity-error-and-persistent-retry')

    server.select('hold-download', '0.1.6-nightly.1')
    await press(mainWindow, `document.querySelector('button[data-error="true"]')`)
    await server.arrived()
    await documentReady(mainWindow, `document.querySelector('button[aria-disabled="true"]')`)
    assert.equal(BrowserWindow.getAllWindows().some(window => window.webContents.getURL() === 'dsh-app://shell/update-dialog.html'), false)
    await screenshot(mainWindow, 'downloading.png')
    server.release()
    const confirmation = desktopUpdateReadyConfirmation(messages, '0.1.6-nightly.1', process.platform)
    const ready = await dialogWith(confirmation.message)
    assert.equal(fixture.installations.length, 0)
    await screenshot(ready, 'install-confirmation.png')
    cases.push('sidebar-retry-direct-download-and-separate-install-dialog')

    assert.equal((await control('queue')).queued, 1)
    await clickText(ready, messages.installAndRestart)
    await waitFor(() => fixture.coordinator.state.phase === 'error', 'task-change protection')
    assert.equal(fixture.coordinator.state.message, messages.updateTasksChanged)
    assert.equal(fixture.installations.length, 0)
    assert.equal((await control('status')).queued, 1)
    const changed = await dialogWith(messages.updateTasksChanged)
    await screenshot(changed, 'new-task-refusal.png')
    await clickText(changed, messages.updateAcknowledge)
    cases.push('new-task-during-idle-confirmation-refuses-install-and-preserves-work')

    await press(mainWindow, `document.querySelector('button[data-error="true"]')`)
    const warning = await dialogWith(messages.updateActiveTasks)
    await screenshot(warning, 'active-task-warning.png')
    await clickText(warning, messages.updateLater)
    await waitFor(() => fixture.coordinator.state.phase === 'ready', 'deferred install readiness')
    assert.equal((await control('status')).queued, 1)
    assert.equal(fixture.installations.length, 0)
    cases.push('task-warning-deferral-preserves-work-and-ready-package')
    console.log('workspace qualification: real task confirmation and deferral complete')

    server.policy('force')
    checkMenu.click()
    console.log('workspace qualification: mandatory check dispatched')
    const mandatory = await windowAt('dsh-app://shell/mandatory-update.html')
    console.log('workspace qualification: mandatory window loaded')
    await documentReady(mandatory, `document.getElementById('title')?.textContent === '需要更新'`)
    console.log('workspace qualification: mandatory title rendered')
    assert.equal(await mandatory.webContents.executeJavaScript(`document.getElementById('title').children.length`), 0)
    assert.equal(mandatory.isModal(), false)
    await waitFor(() => mainWindow.isEnabled(), 'ordinary modal releases the main window')
    assert.equal(mainWindow.isEnabled(), true)
    if (process.platform === 'win32') assert.equal(mainWindow.getChildWindows().length, 0)
    const originalBounds = mainWindow.getBounds()
    mainWindow.setPosition(originalBounds.x + 20, originalBounds.y + 20)
    mainWindow.maximize()
    await waitFor(() => mainWindow.isMaximized(), 'blocked parent maximize')
    mainWindow.unmaximize()
    await waitFor(() => !mainWindow.isMaximized(), 'blocked parent restore')
    if (process.platform === 'win32') {
      const viewport = await mandatory.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight })')
      const bounds = mainWindow.getContentBounds()
      assert.deepEqual(viewport, { width: bounds.width, height: bounds.height - WINDOWS_TITLEBAR_HEIGHT })
    }
    mandatory.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    mandatory.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    assert.equal((await control('status')).queued, 1)
    await screenshot(mandatory, 'mandatory-block.png')
    server.policy('failure')
    checkMenu.click()
    await waitFor(async () => (await mandatory.webContents.executeJavaScript('window.dshMandatoryUpdate.status()')).policy.error === 'unavailable', 'retained policy failure')
    assert.equal(await mandatory.webContents.executeJavaScript("document.getElementById('error').hidden"), true)
    assert.equal((await control('status')).queued, 1)
    await screenshot(mandatory, 'mandatory-retained-error.png')
    server.policy('clear')
    checkMenu.click()
    await waitFor(() => mandatory.isDestroyed(), 'fresh no-force response to clear the modal')
    assert.equal(mainWindow.isEnabled(), true)
    assert.equal(fixture.installations.length, 0)
    cases.push('mandatory-main-entry-block-retains-real-work-through-failure-and-clearance')

    await press(mainWindow, `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(messages.installAndRestart)})`)
    const stop = await dialogWith(messages.updateActiveTasks)
    const stoppedHost = fixture.host
    await control('hold-shutdown')
    await clickText(stop, messages.updateStopTasks)
    await documentReady(mainWindow, `[...document.querySelectorAll('button')].some(button => button.textContent.trim() === ${JSON.stringify(messages.updateInstalling)})`)
    assert.equal(await mainWindow.webContents.executeJavaScript("document.body.innerText.includes('重新连接中')"), false)
    await screenshot(mainWindow, 'installing-before-host-exit.png')
    await waitFor(() => fixture.coordinator.state.phase === 'error', 'unclean Host stop rejection')
    assert.equal(fixture.coordinator.state.message, messages.updateStopFailed)
    assert.match(fixture.coordinator.state.technicalDetails, /did not complete graceful task teardown/)
    assert.equal(fixture.installations.length, 0)
    const failedStop = await dialogWith(fixture.coordinator.state.message)
    await screenshot(failedStop, 'stop-failure.png')
    cases.push('actual-host-teardown-timeout-refuses-installer')
    await clickText(failedStop, messages.updateAcknowledge)
    await waitFor(() => fixture.host !== stoppedHost && fixture.readyHosts.has(fixture.host), 'replacement Host after non-graceful shutdown')
    await waitFor(async () => !await fixture.host.updateTasks('inspect'), 'replacement Host ready without active work')
    await press(mainWindow, `document.querySelector('button[data-error="true"]')`)
    const retryInstall = await dialogWith(confirmation.message)
    assert.equal(fixture.installations.length, 0)
    await screenshot(retryInstall, 'recovered-install-confirmation.png')
    await press(retryInstall, `document.getElementById('close')`)
    await waitFor(() => retryInstall.isDestroyed(), 'recovered confirmation dismissal')
    await waitFor(() => fixture.coordinator.state.phase === 'ready', 'recovered update ready for explicit retry')
    assert.equal(fixture.installations.length, 0)
    cases.push('non-graceful-stop-restores-host-and-requires-fresh-install-confirmation')

    server.policy('force')
    checkMenu.click()
    let forcedRecovery = await windowAt('dsh-app://shell/mandatory-update.html')
    await waitFor(() => mainWindow.isEnabled(), 'ordinary modal releases the main window for recovery')
    await press(forcedRecovery, `document.getElementById('update')`)
    await documentReady(forcedRecovery, `document.getElementById('update')?.textContent === ${JSON.stringify(messages.installAndRestart)}`)
    assert.equal(BrowserWindow.getAllWindows().some(window => window.webContents.getURL() === 'dsh-app://shell/update-dialog.html'), false)
    const forcedHost = fixture.host
    await control('hold-shutdown')
    await press(forcedRecovery, `document.getElementById('update')`)
    await waitFor(() => fixture.coordinator.state.phase === 'error', 'mandatory Host stop rejection')
    await documentReady(forcedRecovery, `document.getElementById('error')?.textContent === ${JSON.stringify(messages.updateStopFailed)}`)
    await screenshot(forcedRecovery, 'mandatory-stop-failure.png')
    await waitFor(() => fixture.host !== forcedHost && fixture.readyHosts.has(fixture.host), 'mandatory replacement Host readiness')
    if (process.platform === 'win32') {
      await waitFor(() => forcedRecovery.isDestroyed(), 'recovery reload replaces the embedded document')
      forcedRecovery = await mandatoryFrameDriver(mainWindow)
    }
    assert.equal(mainWindow.isEnabled(), true)
    assert.equal(fixture.installations.length, 0)
    await control('queue')
    await press(forcedRecovery, `document.getElementById('update')`)
    await documentReady(forcedRecovery, `document.getElementById('update')?.textContent === ${JSON.stringify(messages.updateStopTasks)}`)
    await screenshot(forcedRecovery, 'mandatory-recovered-confirmation.png')
    await press(forcedRecovery, `document.getElementById('later')`)
    await waitFor(() => fixture.coordinator.state.phase === 'ready', 'mandatory deferred retry readiness')
    assert.equal(forcedRecovery.isDestroyed(), false)
    assert.equal(mainWindow.isEnabled(), true)
    assert.equal(fixture.installations.length, 0)
    server.policy('clear')
    checkMenu.click()
    await waitFor(() => forcedRecovery.isDestroyed(), 'mandatory recovery policy clearance')
    cases.push('mandatory-stop-recovery-preserves-block-and-requires-fresh-install-confirmation')
    await writeFile(join(root, 'result.json'), JSON.stringify({ realElectron: true, realHostProcess: true,
      realPreload: true, compiledMainEntry: true, installerExecuted: false, cases,
      menu: menu.map(item => item.label), phases: fixture.states.map(state => state.phase) }, null, 2) + '\n')
  } catch (error) {
    await writeFile(join(root, 'failure.txt'), String(error.stack ?? error))
    await writeFile(join(root, 'failure-update-state.json'), JSON.stringify(fixture.coordinator?.state, null, 2))
    await writeFile(join(root, 'task-queries.json'), JSON.stringify(fixture.taskQueries, null, 2))
    try { await writeFile(join(root, 'failure-host-state.json'), JSON.stringify(await control('status'), null, 2)) }
    catch (diagnosticError) { await writeFile(join(root, 'failure-host-state.txt'), String(diagnosticError)) }
    const windows = []
    for (const window of BrowserWindow.getAllWindows()) {
      const state = { url: window.webContents.getURL(), visible: window.isVisible(), title: window.getTitle() }
      try {
        state.document = await observed(window, 'failure window content', () => window.webContents.executeJavaScript(`({
          title: document.getElementById('title')?.textContent,
          buttons: [...document.querySelectorAll('button')].map(button => button.textContent),
        })`))
      } catch (diagnosticError) { state.error = String(diagnosticError) }
      windows.push(state)
    }
    await writeFile(join(root, 'failure-windows.json'), JSON.stringify(windows, null, 2))
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        await writeFile(join(root, 'failure-buttons.json'), JSON.stringify(await observed(mainWindow, 'failure buttons', () =>
          mainWindow.webContents.executeJavaScript(
            `[...document.querySelectorAll('button')].map(button => ({ text: button.textContent, aria: button.getAttribute('aria-label') }))`)), null, 2))
        await screenshot(mainWindow, 'failure-workspace.png')
      } catch (diagnosticError) {
        await writeFile(join(root, 'failure-artifact-error.txt'), String(diagnosticError.stack ?? diagnosticError))
      }
    }
    throw error
  } finally {
    hooks.deregister()
    await server.close()
    app.quit()
  }
}
const fail = error => { console.error(error); app.exit(1) }
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)
void qualify().catch(fail)
