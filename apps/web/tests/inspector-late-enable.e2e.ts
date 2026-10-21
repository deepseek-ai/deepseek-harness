/** Enabling the optional Inspector bundle on a running page mounts the bottom DevTools without a reload. */
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { PLUGIN_TOGGLE_SETTLE_MS, saveFailureShot } from './support.ts'

const bundle = fileURLToPath(new URL('../../../packages/experimental/inspector-profile', import.meta.url))
const BOOTSTRAP_PATH = '/api/experimental-inspector/bootstrap'

it('opens bottom DevTools after the Developer Tools bundle is enabled on an already loaded page', async () => {
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally { await resources.scaffold?.close() }
  })
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: bundle, enabled: false }], hmr: true },
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  resources.scaffold = scaffold
  // Only a running HMR service applies the bundle switch to this page without a restart.
  expect(scaffold.ctx.get('hmr')).toBeDefined()
  // Full Chromium matches the other Inspector browser scenarios.
  const browser = await chromium.launch({ executablePath: chromium.executablePath() })
  resources.browser = browser
  const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
  const tripwire = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-inspector-late-enable'))
  const bootstraps: number[] = []
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === BOOTSTRAP_PATH) bootstraps.push(response.status())
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.evaluate(() => { Reflect.set(window, '__inspectorLateEnableMarker', 'same-document') })

  await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
  const plugins = page.locator('[data-plugin-panel]')
  const toggle = plugins.getByRole('switch', { name: 'Enable Developer Tools', exact: true })
  await toggle.waitFor()
  expect(await toggle.getAttribute('aria-checked')).toBe('false')
  const panel = page.locator('[data-inspector-panel]')
  expect(await panel.count()).toBe(0)

  await toggle.click()
  await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe('true')
  await panel.waitFor({ state: 'attached', timeout: 20_000 }).catch((error: unknown) => {
    throw new Error(`Bottom panel did not mount; ${BOOTSTRAP_PATH} responses: ${JSON.stringify(bootstraps)}`, { cause: error })
  })
  expect(await panel.isVisible()).toBe(false)
  await page.keyboard.press('ControlOrMeta+Shift+Period')
  await panel.waitFor({ state: 'visible' })
  await page.frameLocator('iframe[data-inspector-devtools]').getByRole('tab', { name: 'Console', exact: true }).waitFor()
  expect(await page.evaluate((): unknown => Reflect.get(window, '__inspectorLateEnableMarker'))).toBe('same-document')
  expect(new Set(bootstraps)).toEqual(new Set([200]))
  expect(tripwire.pageErrors).toEqual([])
})
