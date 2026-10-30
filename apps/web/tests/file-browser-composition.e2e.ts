/**
 * The workspace file browser and the document preview each work without the
 * other in the shipped Web composition: without the preview the files page
 * lists the workspace and leaves files it cannot open unclickable; without the
 * file browser a preview opens with no navigator or toggle beside it.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

/** A settled Session whose answer links `src/example.txt`, borrowed from the Markdown file links case. */
const SEED = fileURLToPath(new URL('../../../snapshots/web/markdown-file-links/session.v3.jsonl', import.meta.url))

/** Boot the composition with one plugin disabled, a workspace holding `src/example.txt`, and the seeded Session open. */
async function open(overlay: string, name: string) {
  const scaffold: WebScaffold = await launchWebScaffold({ extraOverlayPath: fileURLToPath(new URL(overlay, import.meta.url)) })
  onTestFinished(() => scaffold.close())
  await mkdir(join(scaffold.workspaceCwd, 'src'))
  await writeFile(join(scaffold.workspaceCwd, 'src/example.txt'), Array.from({ length: 40 }, (_, i) => `source line ${i + 1}\n`).join(''))
  await seedSession(scaffold, await readFile(SEED, 'utf8'), name)
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, `web-e2e-${name}`))
  const errors = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.locator('[role="treeitem"]').first().click()
  await page.locator('[role="treeitem"]').nth(1).click()
  await page.getByRole('button', { name: 'src/example.txt:24–30', exact: true }).waitFor()
  return { page, errors, column: page.locator('[data-rightbar-col]') }
}

it('lists the workspace without the document preview, leaving files nothing can open unclickable', async () => {
  const { page, errors, column } = await open('./no-sidebar-documentpreview.overlay.yml', 'composition-no-preview')
  await page.locator('[data-sidebar-right-expand]').click()
  await column.locator('[data-sidebar-right-guide-entry="files"]').click()
  const navigator = column.locator('[data-files-navigator]')
  await navigator.getByRole('button', { name: 'src', exact: true }).click()
  const row = navigator.locator('[data-files-path$="/src/example.txt"]')
  await row.waitFor()
  expect(await row.locator('button').count()).toBe(0)
  expect(await row.locator('[aria-disabled="true"]').getAttribute('title')).toBe('No viewer can open this file.')
  const tabs = await column.locator('[data-dockkit-tab]').count()
  await row.click()
  expect(await column.locator('[data-dockkit-tab]').count()).toBe(tabs)
  expect(await column.locator('[data-files-page]').count()).toBe(1)
  expect(errors).toEqual({ warnings: [], pageErrors: [] })
}, 120_000)

it('previews a linked file without the file browser, with no navigator or toggle beside it', async () => {
  const { page, errors, column } = await open('./no-sidebar-files.overlay.yml', 'composition-no-files')
  await page.getByRole('button', { name: 'src/example.txt:24–30', exact: true }).click()
  await expect.poll(() => column.locator('[data-textpreview-target="24"]').textContent()).toBe('source line 24\n')
  expect(await column.locator('[data-files-navigator], [data-files-navigator-toggle]').count()).toBe(0)
  expect(await column.locator('[data-textpreview-content] > *').evaluateAll(children =>
    children.map(child => child.hasAttribute('data-textpreview-body')))).toEqual([true])
  expect(await column.locator('[data-sidebar-right-guide-entry="files"]').count()).toBe(0)
  expect(errors).toEqual({ warnings: [], pageErrors: [] })
}, 120_000)
