/** A bare URL in a settled CJK reply ends before the following full-width punctuation. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/autolink-cjk-punctuation', import.meta.url))
const MODE = webSnapshotMode()
const URL_TEXT = 'http://127.0.0.1:8790/'

describe('web e2e: bare URL before CJK punctuation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, await readFile(join(SNAPSHOT_DIR, 'session.v4.jsonl'), 'utf8'), 'autolink-cjk-punctuation')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByRole('link', { name: URL_TEXT, exact: true }).waitFor()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('links only the URL and renders the following sentence as text', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-autolink-cjk-punctuation'))
    const link = page.getByRole('link', { name: URL_TEXT, exact: true })
    expect(await link.getAttribute('href')).toBe(URL_TEXT)
    const prose = await link.locator('..').ariaSnapshot()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'reply.expected.md'), prose, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v4.jsonl', 'reply.expected.md'])
  })
})
