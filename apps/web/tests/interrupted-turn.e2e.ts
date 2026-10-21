// Web e2e scenario: a turn closed because DSH stopped mid-turn. Borrow the
// seeded-history recording, end its turn with the `interrupted` reason that
// restart recovery writes, and pin the stopped summary and notice without any
// model call.
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
import { newEnglishPage, saveFailureShot, WEB_FIXTURE_TIME } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/interrupted-turn', import.meta.url))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()
const SEED_ID = 'interrupted-turn-web-e2e'
const PROMPT = 'Use the read tool twice in one assistant message: read a.txt and b.txt. Then reply with the single word DONE and stop.'
const COMPLETED_END = '{"type":"turn/end","data":{"turn":1,"reason":{"kind":"completed"}}}'
const INTERRUPTED_END = '{"type":"turn/end","data":{"turn":1,"reason":{"kind":"interrupted"}}}'

describe.skipIf(MODE === 'record')('web e2e: turn interrupted by a DSH stop', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const recorded = await readFile(FIXTURE, 'utf8')
    expect(fixtureUserPrompts(recorded)).toEqual([PROMPT])
    expect(recorded.trimEnd().endsWith(COMPLETED_END)).toBe(true)
    const fixture = `${recorded.trimEnd().slice(0, -COMPLETED_END.length)}${INTERRUPTED_END}\n`
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
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows the stopped summary and the interruption notice', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-interrupted-turn'))
    const notice = page.getByRole('status').filter({ hasText: 'Task stopped' })
    await notice.waitFor({ timeout: 15_000 })
    expect(await notice.textContent()).toContain('The DSH process exited before this turn finished')
    expect(await notice.textContent()).not.toContain('INTERRUPTED')
    expect(await page.locator('[data-turn-process="1"]').textContent()).toBe('Stopped')

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
