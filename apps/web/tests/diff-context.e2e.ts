/** Cold Session rendering covers exact context and bounded whole-fragment replacements. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandTurnProcesses, newEnglishPage, saveFailureShot } from './support.ts'

const ROOT = fileURLToPath(new URL('../../../snapshots', import.meta.url))
const MODE = webSnapshotMode()

const CASES = [
  { name: 'diff-context', source: 'session/fs-edit/session.v3.jsonl', totals: '+1 -1', shared: 'level=info', inventory: ['ui.expected.md'] },
  { name: 'diff-bounded', source: 'web/diff-bounded/session.v3.jsonl', totals: '+130 -130', shared: 'shared heading', inventory: ['session.v3.jsonl', 'ui.expected.md'] },
]

describe.skipIf(MODE === 'record').each(CASES)('web e2e: $name', (scenario) => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, await readFile(`${ROOT}/${scenario.source}`, 'utf8'), scenario.name)
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

  it('keeps collapsed and expanded counts consistent with the displayed diff', async () => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-${scenario.name}`))
    const group = page.locator('[role="treeitem"]').first()
    await group.waitFor({ timeout: 15_000 })
    await group.click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })
    await expandTurnProcesses(page)
    const edit = page.locator('[data-variant="edit"]')
    expect(await edit.textContent()).toContain(scenario.totals)
    expect(await edit.locator('[data-diff]').count()).toBe(0)
    await edit.locator('[data-expandable]').click()
    const card = edit.locator('[data-diff]')
    await card.waitFor()
    expect(await card.getByText(scenario.shared, { exact: true }).count()).toBe(1)
    expect(await card.textContent()).toContain(`${scenario.totals} · 1 file`)
    const snapshotDir = `${ROOT}/web/${scenario.name}`
    await compareOrRefreshGolden(`${snapshotDir}/ui.expected.md`,
      await captureStableAria(page, '[data-variant="edit"]', scaffold.workspaceCwd), MODE)
    await assertFixtureInventory(snapshotDir, scenario.inventory)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
