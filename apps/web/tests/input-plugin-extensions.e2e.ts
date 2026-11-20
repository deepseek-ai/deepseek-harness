/** Optional input contributions mount through the real Loader and preserve editor ownership. */
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEntryYaml, stringifyEntryYaml } from '@deepseek-ai/cordis-plugin-include'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const bundle = fileURLToPath(new URL('./fixtures/plugins/fixture-input-extension', import.meta.url))
const shortcutsBundle = fileURLToPath(new URL('./fixtures/plugins/demo-composer-shortcuts', import.meta.url))
const reviewBundle = fileURLToPath(new URL('./fixtures/plugins/demo-composer-review-session', import.meta.url))
const schemastery = fileURLToPath(new URL('../../../vendor/schemastery', import.meta.url))
const expected = fileURLToPath(new URL('./expected/input-plugin-extensions.expected.md', import.meta.url))

async function fixture(packages: { dir: string; enabled: boolean }[]) {
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally { await resources.scaffold?.close() }
  })
  const scaffold = await launchWebScaffold({ profile: { packages } })
  resources.scaffold = scaffold
  const browser = await chromium.launch()
  resources.browser = browser
  const page = await newEnglishPage(browser), tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
  return { scaffold, browser, page, tripwire }
}

it('shows shortcuts, a Plan outline, and Session review steps before restoring the built-in placeholder', async () => {
  // Install a private copy so the review bundle can resolve its Host schema dependency.
  const installedReview = await mkdtemp(join(tmpdir(), 'dsh-composer-review-session-'))
  onTestFinished(() => rm(installedReview, { recursive: true, force: true }))
  await cp(reviewBundle, installedReview, { recursive: true })
  const scopeDir = join(installedReview, 'node_modules', '@deepseek-ai')
  await mkdir(scopeDir, { recursive: true })
  await symlink(schemastery, join(scopeDir, 'schemastery'), 'junction')
  const { scaffold, browser, page, tripwire } = await fixture([
    { dir: shortcutsBundle, enabled: true },
    { dir: installedReview, enabled: true },
  ])
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const input = page.getByRole('textbox', { name: '/ Browse commands · @ Mention files or sessions', exact: true })
  const placeholder = page.locator('[data-composer-placeholder]')
  await input.waitFor()
  expect(await placeholder.locator('kbd').allTextContents()).toEqual(['/', '@'])
  expect((await input.innerText()).trim()).toBe('')
  const captureInput = () => captureStableAria(page, '[data-composer-input]', scaffold.workspaceCwd)
  const shortcutsAria = await captureInput()

  await input.focus()
  const editor = page.locator('[data-composer-input]')
  await editor.dispatchEvent('compositionstart')
  await placeholder.waitFor({ state: 'hidden' })
  await editor.dispatchEvent('compositionend', { data: '' })
  await placeholder.waitFor({ state: 'visible' })

  await editor.fill('/plan ')
  await editor.press('Enter')
  const planButton = page.getByRole('button', { name: 'Plan mode on, press to turn off', exact: true })
  const planInput = page.getByRole('textbox', {
    name: 'Plan outline Goal · Constraints · Success criteria', exact: true,
  })
  await planButton.waitFor()
  await planInput.waitFor()
  const outline = placeholder.locator('[data-demo-composer-plan]')
  for (const step of ['Goal', 'Constraints', 'Success criteria']) {
    expect(await outline.getByText(step, { exact: true }).isVisible()).toBe(true)
  }
  const planAria = await captureInput()
  await planButton.click()
  await planButton.waitFor({ state: 'hidden' })
  await input.waitFor()
  expect(await placeholder.locator('kbd').allTextContents()).toEqual(['/', '@'])

  const session = await page.locator('[data-conversation-session]').getAttribute('data-conversation-session')
  if (session === null || session === '') throw new Error('The composer has no Session ID')
  const patchFile = join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml')
  const parsed = parseEntryYaml(await readFile(patchFile, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error('The scaffold profile patch is not a list')
  const profilePatches: readonly unknown[] = parsed
  const configureReviewSession = (sessionId: string) => writeFile(patchFile, stringifyEntryYaml([
    ...profilePatches,
    { id: 'demo-composer-review-session', config: { sessionId } },
  ]))
  const reviewInput = page.getByRole('textbox', {
    name: 'Review Changes Risks Tests', exact: true,
  })
  await configureReviewSession(session)
  await reviewInput.waitFor()
  const reviewSteps = placeholder.locator('[data-demo-review-path] [data-demo-review-step]')
  expect(await reviewSteps.allTextContents()).toEqual(['Changes', 'Risks', 'Tests'])
  const reviewAria = await captureInput()

  await configureReviewSession(`${session}-other`)
  await input.waitFor()
  await configureReviewSession(session)
  await reviewInput.waitFor()

  const plugins = await newEnglishPage(browser)
  await plugins.goto(scaffold.authenticatedUrl)
  await plugins.getByRole('button', { name: 'Plugins', exact: true }).click()
  await plugins.getByRole('switch', { name: 'Enable @fixture/composer-review-session', exact: true, checked: true }).click()
  await input.waitFor()
  await plugins.getByRole('switch', { name: 'Enable @fixture/composer-shortcuts', exact: true, checked: true }).click()
  const homePrompt = 'Describe what you want to build, / commands, @ files or sessions'
  await page.getByRole('textbox', { name: homePrompt, exact: true }).waitFor()
  expect(await placeholder.innerText()).toBe(homePrompt)
  expect(await placeholder.locator('kbd').count()).toBe(0)
  await compareOrRefreshGolden(fileURLToPath(new URL('./expected/input-plugin-placeholder.expected.md', import.meta.url)),
    [shortcutsAria, planAria, reviewAria, await captureInput()].join('\n'), webSnapshotMode())
  expect(tripwire.pageErrors).toEqual([])
})

it('expands an input activity and inserts one undoable result without overwriting subsequent edits', async () => {
  const { scaffold, page, tripwire } = await fixture([{ dir: bundle, enabled: true }])
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
  const { page, tripwire } = await fixture([{ dir: bundle, enabled: false }])
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
