// Web e2e scenario: a web_fetch transport failure leads its collapsed row with the
// localized failure summary and keeps the recorded code and detail in the expanded
// output. Borrow the headless transport-failure fixture without any model call.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandTurnProcesses, newEnglishPage, saveFailureShot, WEB_FIXTURE_TIME } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/session/web-fetch-transport-failure/session.v4.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/web-fetch-failure-row', import.meta.url))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()
const SEED_ID = 'web-fetch-failure-row-web-e2e'
const PROMPT = 'Use the web_fetch tool exactly once to fetch http://public.test:43117/menu.html, then reply with exactly DONE. Do not describe the content.'
const SUMMARY = 'Connection interrupted. Try again later.'
const DETAIL = 'Error: web fetch failed: the connection was interrupted (UND_ERR_SOCKET): other side closed'

describe.skipIf(MODE === 'record')('web e2e: web_fetch transport failure row', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const fixture = await readFile(FIXTURE, 'utf8')
    expect(fixtureUserPrompts(fixture)).toEqual([PROMPT])
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, fixture, SEED_ID, undefined, { createdAt: WEB_FIXTURE_TIME })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.clock.setFixedTime(WEB_FIXTURE_TIME)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expandTurnProcesses(page)
    await page.getByText(SUMMARY, { exact: true }).waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('leads with the localized summary and expands to the recorded detail', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-web-fetch-failure-row'))
    const summary = page.getByText(SUMMARY, { exact: true })
    expect(await page.getByText(DETAIL, { exact: true }).count()).toBe(0)
    await summary.click()
    await page.getByText(DETAIL, { exact: true }).waitFor()

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
