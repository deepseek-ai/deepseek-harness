/** A delivery declared in the closing reply's step reaches the completed turn's cards when later steps add no text. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/present-after-closing-reply', import.meta.url))
const MODE = webSnapshotMode()

describe('web e2e: delivery after the closing reply', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await writeFile(join(scaffold.workspaceCwd, 'report.txt'), 'DRAFT_REPORT\n')
    await seedSession(scaffold, await readFile(join(SNAPSHOT_DIR, 'session.v4.jsonl'), 'utf8'), 'present-after-closing-reply')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByText('REPORT_READY', { exact: true }).waitFor()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows the delivery card under the closing reply and previews the file', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-present-after-closing-reply'))
    const row = page.locator('[data-turn-tail] [data-presented-files-row]')
    await row.waitFor()
    const card = row.locator('[data-presented-file]')
    expect(await card.count()).toBe(1)
    expect(await card.innerText()).toContain('report.txt')
    expect(await card.innerText()).toContain('Draft report')
    // The grid excludes the Host-desktop notice, which depends on the test platform.
    const cards = await captureStableAria(page, '[data-turn-tail] [data-presented-files-row]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'ui.expected.md'), cards, MODE)
    await card.getByRole('button', { name: `Preview ${join(scaffold.workspaceCwd, 'report.txt')} in sidebar`, exact: true }).click()
    await page.locator('[data-rightbar-col] [data-document-preview]').getByText('DRAFT_REPORT', { exact: true }).waitFor()
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v4.jsonl', 'ui.expected.md'])
  })
})
