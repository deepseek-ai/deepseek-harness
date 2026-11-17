/** Recorded empty-include searches retain the specialized Web result cards. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, selectedSessionFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandTurnProcesses, newEnglishPage, saveFailureShot } from './support.ts'

const ROOT = fileURLToPath(new URL('../../../snapshots', import.meta.url))
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: search-empty-include', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const fixture = await selectedSessionFixture(`${ROOT}/session/toolcall-unused-args/session.v4.jsonl`)
    await seedSession(scaffold, await readFile(fixture, 'utf8'), 'search-empty-include')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  })

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      await scaffold?.close()
    }
  })

  it('renders both recorded searches as file-grouped matches rather than generic JSON', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-empty-include'))
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })
    await expandTurnProcesses(page)
    const calls = page.locator('[data-variant="search"]')
    expect(await calls.count()).toBe(2)
    const views: string[] = []
    for (const [index, extension] of ['.ts', '.md'].entries()) {
      const call = calls.nth(index)
      await call.locator('[data-expandable]').click()
      const matches = call.locator('[data-search="matches"]')
      await matches.waitFor()
      expect(await matches.textContent()).toContain(`example${extension}`)
      expect(await matches.textContent()).toContain('marker')
      views.push(await captureStableAria(page, `[data-variant="search"] >> nth=${index}`, scaffold.workspaceCwd))
    }
    const snapshotDir = `${ROOT}/web/search-empty-include`
    await compareOrRefreshGolden(`${snapshotDir}/ui.expected.md`, views.join('\n'), MODE)
    await assertFixtureInventory(snapshotDir, ['ui.expected.md'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
