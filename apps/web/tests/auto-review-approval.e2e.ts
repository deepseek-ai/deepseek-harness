// Web e2e scenario: a cold recording renders an Auto-review denial the user
// rejected and a reviewer failure without replaying a reviewer or model call.
// The real persistence reader, shipped Web composition, permission
// projection, conversation assembler, and Tool rows all participate.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, saveFailureShot, WEB_FIXTURE_TIME } from './support.ts'

import { AUTO_REVIEW_FIXTURE } from './auto-review-fixture.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/auto-review-approval', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/auto-review-approval/session.v3.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/auto-review-approval/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'auto-review-approval-web-e2e'
const FAILURE = 'Auto review of tool "mystery" failed; its body was not executed: auto-review: reviewer ended with error UNKNOWN: provider unavailable'

describe.skipIf(MODE === 'record')('web e2e: cold Auto-review user rejection and reviewer failure', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const fixture = await readFile(FIXTURE, 'utf8')
    scaffold = await launchWebScaffold(AUTO_REVIEW_FIXTURE)
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
    const call = page.locator('[data-tool="mystery"]').first()
    await expandOwningTurnProcess(page, call)
    await call.waitFor({ state: 'visible', timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows the user rejection and the specific reviewer failure, not an Auto denial', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-auto-review-approval'))
    const calls = page.locator('[data-tool="mystery"]')
    await expect.poll(() => calls.count()).toBe(2)
    expect(await page.getByText('Rejected by Auto review', { exact: true }).count()).toBe(0)

    const access = page.locator('button[aria-label^="Access mode"]').first()
    await expect.poll(() => access.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('Access mode, current: Auto review EXP')
    const collapsed = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')

    for (const index of [0, 1]) {
      const row = calls.nth(index).locator('[data-expandable]')
      await row.click()
      await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true')
    }
    await calls.nth(1).getByText(FAILURE, { exact: false }).first().waitFor({ state: 'visible' })
    const expanded = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')

    await compareOrRefreshGolden(UI_EXPECTED, `## Collapsed\n\n${collapsed.trim()}\n\n## Expanded\n\n${expanded.trim()}`, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'ui.expected.md', 'session.v3.jsonl',
    ])
  })
})
