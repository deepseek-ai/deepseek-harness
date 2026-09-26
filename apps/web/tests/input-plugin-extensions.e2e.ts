/** Optional input contributions mount through the real Loader and preserve editor ownership. */
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const bundle = fileURLToPath(new URL('./fixtures/plugins/fixture-input-extension', import.meta.url))
const expected = fileURLToPath(new URL('./expected/input-plugin-extensions.expected.md', import.meta.url))

async function fixture(enabled: boolean) {
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally { await resources.scaffold?.close() }
  })
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: bundle, enabled }] } })
  resources.scaffold = scaffold
  const browser = await chromium.launch()
  resources.browser = browser
  const page = await newEnglishPage(browser), tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
  return { scaffold, page, tripwire }
}

it('expands an input activity and inserts one undoable result without overwriting subsequent edits', async () => {
  const { scaffold, page, tripwire } = await fixture(true)
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const input = page.locator('[data-composer-input]')
  const start = page.getByRole('button', { name: 'Input activity', exact: true })
  const model = page.getByRole('button', { name: /^Select model, current/ })
  const send = page.getByRole('button', { name: 'Send message', exact: true })
  await input.fill('Draft')
  await input.press('End')
  for (const width of [1280, 420]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(async () => {
      const activityBox = await start.boundingBox(), modelBox = await model.boundingBox(), sendBox = await send.boundingBox()
      return activityBox !== null && modelBox !== null && sendBox !== null
        && activityBox.x >= modelBox.x + modelBox.width && activityBox.x + activityBox.width <= sendBox.x
    }).toBe(true)
  }
  await start.click()
  expect(await model.isVisible()).toBe(false)
  expect(await send.isVisible()).toBe(true)
  await compareOrRefreshGolden(expected,
    await captureStableAria(page, '[data-composer-card]', scaffold.workspaceCwd), webSnapshotMode())
  await page.getByRole('button', { name: 'Insert result', exact: true }).click()
  await expect.poll(() => input.innerText()).toBe('Draft from plugin')
  await input.press('ControlOrMeta+z')
  await expect.poll(() => input.innerText()).toBe('Draft')
  await start.click()
  await input.fill('Newer draft')
  await page.getByRole('button', { name: 'Insert result', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Draft changed' }).waitFor()
  expect(await input.innerText()).toBe('Newer draft')
  await page.getByRole('button', { name: 'Cancel activity', exact: true }).click()
  expect(await model.isVisible()).toBe(true)
  expect(tripwire.pageErrors).toEqual([])
})

it('offers bundle guidance only after explicit activation and navigates to its configuration', async () => {
  const { page, tripwire } = await fixture(false)
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  const toggle = page.getByRole('switch', { name: 'Enable @fixture/input-extension', exact: true })
  await toggle.waitFor()
  const dialog = page.getByRole('dialog', { name: 'Input plugin setup', exact: true })
  expect(await dialog.count()).toBe(0)
  await toggle.click()
  await dialog.waitFor()
  await dialog.getByRole('button', { name: 'Later', exact: true }).last().click()
  await dialog.waitFor({ state: 'hidden' })
  expect(await toggle.getAttribute('aria-checked')).toBe('true')
  await toggle.click()
  await page.getByRole('switch', { name: 'Enable @fixture/input-extension', exact: true, checked: false }).waitFor()
  await toggle.click()
  await dialog.getByRole('button', { name: 'Open setup', exact: true }).click()
  await page.getByText('Input plugin configuration', { exact: true }).waitFor()
  expect(await dialog.count()).toBe(0)
  expect(tripwire.pageErrors).toEqual([])
})
