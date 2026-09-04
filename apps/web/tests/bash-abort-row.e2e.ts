// Web e2e scenario: a cancelled Bash call can settle without terminal-card
// material. Borrow the real cancellation fixture and prove the keyed Bash row
// still exposes the recorded command and full error without any model call.
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
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/acp/cancel-tool-calls/session.v2.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/bash-abort-row', import.meta.url))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()
const SEED_ID = 'bash-abort-row-web-e2e'
const PROMPT = 'Run two shell commands: wait for cancellation, then write skipped.txt.'

describe.skipIf(MODE === 'record')('web e2e: cancelled Bash row disclosure', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const fixture = await readFile(FIXTURE, 'utf8')
    expect(fixtureUserPrompts(fixture)).toEqual([PROMPT])
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, fixture, SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await page.locator('[data-sample="bash"]').nth(1).waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('expands the aborted row to its command and full error', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bash-abort-row'))
    const row = page.locator('[data-sample="bash"]').first()
    const call = row.locator('xpath=..')
    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('false')
    await expect.poll(() => call.getByText('Error: tool call aborted', { exact: true }).count()).toBe(1)
    await row.click()

    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true')
    await call.getByText('IN', { exact: true }).waitFor()
    await call.getByText('OUT', { exact: true }).waitFor()
    await call.getByText('Wait until cancellation', { exact: false }).waitFor()
    await call.getByText('setInterval(() => {}, 1000)', { exact: false }).waitFor()
    await expect.poll(() => call.getByText('Error: tool call aborted', { exact: true }).count()).toBe(2)

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      // The borrowed fixture's UTC date is still the previous day in PDT;
      // the disclosure golden must not depend on the runner timezone.
      .replace(/\b\d{1,2}\/\d{1,2}(?= \{\{clock\}\})/g, '{{date}}')
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
