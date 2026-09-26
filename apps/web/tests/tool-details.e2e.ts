/** Authored Session rendering of compact recorded Tool results. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, saveFailureShot, scrollIntoView } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/tool-details', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/tool-details/session.v3.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/tool-details/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'tool-details-web-e2e'
const PROMPT = 'Show a goal, a to-do list, and reminders.'

describe.skipIf(MODE === 'record')('web e2e: compact Tool details', () => {
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
    const skillRow = page.locator('[data-tool="create_goal"]')
    await expandOwningTurnProcess(page, skillRow)
    await skillRow.waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('expands every recorded tool through its keyed renderer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-tool-details'))
    // `[data-chat-call-id]` scopes the keyed tool cells: the Schedule client's
    // turn-tail create card carries the same `data-tool` marker without being
    // one of the keyed call views this case walks.
    const rows = page.locator('[data-chat-call-id] [data-tool]')
    expect(await rows.count()).toBe(45)
    for (const row of await rows.all()) {
      await row.getByRole('button', { expanded: false }).first().click()
      expect(await row.getByRole('listitem').count()).toBeGreaterThan(0)
      expect(await row.locator('[class*="ioCard"]').count()).toBe(0)
      expect(await row.getByRole('button', { name: 'Inspect', exact: true }).count()).toBe(1)
    }
    const changedTodos = page.locator('[data-tool="todo_write"]').nth(1)
    await changedTodos.getByText('1 added · 1 updated · 1 removed', { exact: true }).waitFor()
    for (const summary of await page.locator('[data-tool] details > summary').all()) await summary.click()
    await page.locator('[data-tool="create_goal"]').getByText('Awaiting continuation', { exact: true }).waitFor()
    const schema = page.locator('[data-tool="cordis_inspect_list"] pre').first()
    await expect.poll(() => schema.textContent()).toContain('"properties"')
    const callIds = [
      ...Array.from({ length: 3 }, (_, index) => `details-call-${index + 1}`),
      // The authored schedule_update round sits beside its schedule_create sibling.
      'details-call-3b',
      ...Array.from({ length: 41 }, (_, index) => `details-call-${index + 4}`),
    ]
    const snapshots = await Promise.all(callIds.map(id =>
      captureStableAria(page, `[data-chat-call-id="${id}"] [data-tool]`, scaffold.workspaceCwd)))
    const snapshot = snapshots.join('\n')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    await page.setViewportSize({ width: 360, height: 800 })
    const card = page.locator('[data-chat-call-id] [data-tool="schedule_create"]')
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    const reminders = page.locator('[data-tool="schedule_list"]')
    await scrollIntoView(reminders)
    const list = reminders.getByRole('list').first()
    await list.evaluate((element) => {
      const second = element.children[1]!
      element.scrollTop += second.getBoundingClientRect().top - element.getBoundingClientRect().top
    })
    expect(await list.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    const geometry = await reminders.evaluate((element) => {
      const title = element.querySelector('ul')!.children[1]!.querySelector('[class*="heading"] > span')!.getBoundingClientRect()
      const inspect = element.querySelector('[class*="inspectButton"]')!.getBoundingClientRect()
      return {
        verticalOverlap: Math.min(title.bottom, inspect.bottom) - Math.max(title.top, inspect.top),
        horizontalGap: inspect.left - title.right,
      }
    })
    expect(geometry.verticalOverlap).toBeGreaterThan(0)
    expect(geometry.horizontalGap).toBeGreaterThanOrEqual(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps the snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v3.jsonl', 'ui.expected.md'])
  })

})
