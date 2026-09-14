// Web e2e scenario: a cold recording renders the structured Auto-review
// denial without replaying a reviewer or model call.
// The real persistence reader, shipped Web composition, permission
// projection, conversation assembler, Tool row, and Trajectory all participate.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, saveFailureShot } from './support.ts'

import { AUTO_REVIEW_FIXTURE, captureAutoReviewState } from './auto-review-fixture.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/auto-review-denial', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/auto-review-denial/session.v3.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/auto-review-denial/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'auto-review-denial-web-e2e'

describe.skipIf(MODE === 'record')('web e2e: cold Auto-review denial', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const fixture = await readFile(FIXTURE, 'utf8')
    const rows = fixture.trim().split(/\r?\n/u).slice(1).map(line => JSON.parse(line) as {
      type?: string
      data?: Record<string, unknown>
    })
    const result = rows.find(row => row.type === 'tool/result')
    expect(result?.data).toMatchObject({
      message: {
        source: { kind: 'tool', callId: 'auto-review-denied-call' },
        content: [{
          type: 'tool-result',
          toolCallId: 'auto-review-denied-call',
          isError: true,
        }],
      },
      error: {
        name: 'AutoReviewDeniedError',
        code: 'AUTO_REVIEW_DENIED',
        reason: 'raw\r\nreason',
      },
    })
    expect(result?.data).not.toHaveProperty('callId')

    scaffold = await launchWebScaffold(AUTO_REVIEW_FIXTURE)
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
    const call = page.locator('[data-tool="mystery"]')
    await expandOwningTurnProcess(page, call)
    await call.waitFor({ state: 'visible', timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows only the Auto identity and normalized denial reason', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-auto-review-denial'))
    const call = page.locator('[data-tool="mystery"]')
    const row = call.locator('[data-expandable]')
    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('false')
    expect(await call.getByText('Rejected by Auto review', { exact: true }).count()).toBe(1)
    expect(await call.getByText('Tool execution rejected by user', { exact: true }).count()).toBe(0)
    expect(await call.getByText('hidden-input', { exact: false }).count()).toBe(0)

    const inner = page.locator('[data-tool="bash"]')
    const innerRow = inner.locator('[data-expandable]')
    await expect.poll(() => innerRow.getAttribute('aria-expanded')).toBe('false')
    expect(await inner.getByText('Rejected by Auto review', { exact: true }).count()).toBe(1)

    const access = page.locator('button[aria-label^="Access mode"]').first()
    await expect.poll(() => access.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('Access mode, current: Auto review EXP')

    await captureAutoReviewState(page, 'deny-collapsed')
    const collapsed = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')

    await row.click()
    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true')
    expect(await call.getByText('IN', { exact: true }).count()).toBe(0)
    expect(await call.getByText('OUT', { exact: true }).count()).toBe(1)
    expect(await call.getByText('Tool was not executed. Reason: raw reason', { exact: true }).count()).toBe(1)
    await innerRow.click()
    expect(await inner.getByText('Tool was not executed. Reason: ptc raw reason', { exact: true }).count()).toBe(1)
    expect(await inner.getByText('IN', { exact: true }).count()).toBe(0)
    expect(await inner.getByText('hidden-input-ptc', { exact: false }).count()).toBe(0)
    expect(await call.getByText('Tool execution rejected by user', { exact: true }).count()).toBe(0)
    expect(await call.getByText('hidden-input', { exact: false }).count()).toBe(0)

    await captureAutoReviewState(page, 'deny-expanded')
    const expanded = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')

    await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
    const ledger = page.locator('[data-trajectory-scroll]')
    await ledger.locator('table[data-scroll-ready="true"]').waitFor({ timeout: 15_000 })
    const nativeRecord = ledger.locator('tr[data-kind="tool"]').filter({ hasText: 'mystery' })
    const innerRecord = ledger.locator('tr[data-kind="subtool"]').filter({ hasText: 'bash' })
    await expect.poll(() => nativeRecord.textContent()).toContain('AUTO_REVIEW_DENIED')
    await expect.poll(() => innerRecord.textContent()).toContain('AUTO_REVIEW_DENIED')
    await innerRecord.click()
    await page.getByRole('tab', { name: 'Result', exact: true }).click()
    await page.getByRole('tabpanel', { name: 'Result' })
      .getByText('AutoReviewDeniedError: AUTO_REVIEW_DENIED', { exact: true })
      .waitFor({ state: 'visible' })
    await captureAutoReviewState(page, 'deny-trajectory')
    const trajectory = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED,
      `## Collapsed\n\n${collapsed.trim()}\n\n## Expanded\n\n${expanded.trim()}\n\n## Trajectory\n\n${trajectory.trim()}`, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'ui.expected.md', 'session.v3.jsonl',
    ])
  })
})
