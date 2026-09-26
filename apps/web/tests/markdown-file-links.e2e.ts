/** Cold-replayed Markdown references open Session files through the shipped Web composition. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/markdown-file-links', import.meta.url))
const MODE = webSnapshotMode()

describe('web e2e: Markdown file links', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await mkdir(join(scaffold.workspaceCwd, 'src'))
    await mkdir(join(scaffold.workspaceCwd, 'other'))
    await writeFile(join(scaffold.workspaceCwd, 'src/example.txt'),
      Array.from({ length: 60 }, (_, i) => `source line ${i + 1}\n`).join(''))
    await writeFile(join(scaffold.workspaceCwd, 'other/example.txt'), 'other file\n')
    await seedSession(scaffold, await readFile(join(SNAPSHOT_DIR, 'session.v3.jsonl'), 'utf8'), 'markdown-file-links')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByRole('button', { name: 'src/example.txt:24–30', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('previews relative and absolute links at the requested line without duplicate tabs', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-markdown-file-links'))
    const source = page.getByRole('button', { name: 'src/example.txt:24–30', exact: true })
    const prose = await source.locator('..').ariaSnapshot()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'links.expected.md'), prose, MODE)
    const beforeUrl = page.url()
    await source.click()
    const column = page.locator('[data-rightbar-col]')
    await expect.poll(() => column.locator('[data-textpreview-target="24"]').textContent()).toBe('source line 24\n')
    await expect.poll(() => column.locator('[data-textpreview-path]').textContent())
      .toBe(join(scaffold.workspaceCwd, 'src/example.txt'))
    const absolute = page.getByRole('button', { name: 'src/example.txt:30', exact: true })
    await absolute.focus()
    await absolute.press('Enter')
    await expect.poll(() => column.locator('[data-textpreview-target="30"]').textContent()).toBe('source line 30\n')
    expect(await column.locator('[data-dockkit-tab-title]').allTextContents()).toEqual(['example.txt'])
    expect(page.url()).toBe(beforeUrl)
    expect(page.context().pages()).toHaveLength(1)
    expect(await page.getByRole('link', { name: 'Website', exact: true }).getAttribute('target')).toBe('_blank')
    const artifacts = fileURLToPath(new URL('../../../.artifacts', import.meta.url))
    await mkdir(artifacts, { recursive: true })
    await page.screenshot({ path: join(artifacts, 'markdown-file-links.png'), animations: 'disabled' })
    await page.getByRole('button', { name: 'other/example.txt', exact: true }).click()
    await expect.poll(() => column.locator('[data-textpreview-path]').textContent())
      .toBe(join(scaffold.workspaceCwd, 'other/example.txt'))
    await expect.poll(() => column.locator('[data-textpreview-line="1"]').textContent()).toBe('other file\n')
    expect(await column.locator('[data-dockkit-tab-title]').allTextContents()).toEqual(['example.txt', 'example.txt'])
    const preview = await captureStableAria(page, '[data-textpreview-state="text"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'preview.expected.md'), preview, MODE)
    await page.getByRole('button', { name: 'Missing file', exact: true }).click()
    await column.locator('[data-textpreview-failed="workspace-file/not-found"]').waitFor()
    expect(page.url()).toBe(beforeUrl)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v3.jsonl', 'links.expected.md', 'preview.expected.md'])
  })
})
