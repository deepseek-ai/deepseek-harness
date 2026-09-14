// Keyless browser regression for durable per-message feedback. Cold-seeds a
// settled two-turn transcript (zero model calls), records a Like through the
// feedback dialog, replaces it through the same dialog with a Dislike, proves
// the judgment survives a full page reload from the Host's canonical log, then
// retracts it.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold,
  seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

// Borrowed read-only: this scenario needs any settled assistant message to
// address, not a new recording (message-actions / sidebar-scrollbar pattern).
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'message-feedback-web-e2e'
const POSITIVE_NOTE = 'Clear and complete.'
const NOTE = 'Read both files before answering.'

describe('web e2e: durable per-message feedback', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, await readFile(SEED, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /**
   * Open the seeded transcript. The first treeitem is the collapsible group
   * row; the session itself is the row beneath it. The group is already
   * expanded on a fresh load, so clicking it unconditionally would collapse it
   * and hide the session row.
   */
  async function openSeededSession(): Promise<void> {
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    if (await groupRow.getAttribute('aria-expanded') !== 'true') await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 15_000 })
    await sessionRow.click()
  }

  it.skipIf(MODE === 'record')('submits both ratings through the dialog, persists the Dislike, then retracts it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-message-feedback'))
    await openSeededSession()

    // The controls live in the assistant message's IconActions row, which the
    // transcript reveals on hover/focus like copy and branch. Wait for the
    // settled closing text first: the strip mounts with that turn's tail.
    await page.getByText('DONE', { exact: true }).waitFor({ timeout: 30_000 })
    const like = page.getByRole('button', { name: 'Good response' }).first()
    await like.waitFor({ timeout: 30_000 })
    await like.scrollIntoViewIfNeeded()
    await like.hover()
    await like.click()
    const dialog = page.getByRole('dialog', { name: 'Submit feedback' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Stability and speed', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'Feedback details' }).fill(POSITIVE_NOTE)
    await dialog.getByRole('button', { name: 'Submit', exact: true }).click()
    await expect.poll(() => dialog.count(), { timeout: 10_000 }).toBe(0)
    await page.getByRole('alert').filter({ hasText: 'Thanks for your feedback' }).waitFor({ timeout: 10_000 })
    const rated = page.getByRole('button', { name: 'Remove rating' }).first()
    await expect.poll(() => rated.getAttribute('aria-pressed'), { timeout: 10_000 }).toBe('true')

    // The same dialog records a negative judgment with its own category and
    // note, replacing the positive judgment only after submission.
    await page.getByRole('button', { name: 'Bad response' }).first().click()
    await dialog.waitFor({ timeout: 10_000 })
    await expect.poll(() => dialog.getByRole('textbox', { name: 'Feedback details' }).getAttribute('placeholder'))
      .toBe('Add details to help us improve. Your submission will include the current conversation log.')
    await dialog.getByRole('button', { name: 'Task result', exact: true }).click()
    const details = dialog.getByRole('textbox', { name: 'Feedback details' })
    await details.fill('x'.repeat(8193))
    await dialog.getByRole('button', { name: 'Submit', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'The description is too long' }).waitFor({ timeout: 10_000 })
    expect(await dialog.count()).toBe(1)
    await details.fill(NOTE)
    await dialog.getByRole('button', { name: 'Submit', exact: true }).click()
    await expect.poll(() => dialog.count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(() => rated.getAttribute('aria-label'), { timeout: 10_000 }).toBe('Remove rating')
    await expect.poll(() => like.getAttribute('aria-pressed'), { timeout: 10_000 }).toBe('false')

    // The durable assertion: a cold browser re-reads the sidecar over the wire.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openSeededSession()
    await page.getByText('DONE', { exact: true }).waitFor({ timeout: 30_000 })

    // The controller defers its list read to the first hover or focus, so a
    // cold reload shows the unrated label until the strip is touched. Hovering
    // the unrated control is what triggers the authoritative re-read.
    const cold = page.getByRole('button', { name: 'Good response' }).first()
    await cold.waitFor({ timeout: 30_000 })
    await cold.scrollIntoViewIfNeeded()
    await cold.hover()

    const restored = page.getByRole('button', { name: 'Remove rating' }).first()
    await restored.waitFor({ timeout: 30_000 })
    await restored.scrollIntoViewIfNeeded()
    await restored.hover()
    await expect.poll(() => restored.getAttribute('aria-pressed'), { timeout: 15_000 }).toBe('true')
    // The retract label sits on the Dislike side: the Like stays unpressed.
    await expect.poll(() => cold.getAttribute('aria-pressed'), { timeout: 10_000 }).toBe('false')
    const agent = scaffold.ctx.agents.get(SessionId(SEED_ID))
    if (agent === undefined) throw new Error('seeded session did not attach an agent')
    const puts = agent.session.snapshotEvents().filter(event => event.type === 'feedback/message-put')
    expect(puts.map(event => event.type === 'feedback/message-put' ? event.data.item : undefined)).toMatchObject([
      { rating: 'positive', note: POSITIVE_NOTE, category: 'service-stability' },
      { rating: 'negative', note: NOTE, category: 'task-result' },
    ])

    // Re-clicking the active rating retracts it, and the note goes with it.
    await restored.click()
    await expect.poll(
      () => page.getByRole('button', { name: 'Bad response' }).first().getAttribute('aria-pressed'),
      { timeout: 10_000 },
    ).toBe('false')
    const last = agent.session.snapshotEvents().at(-1)
    expect(last?.type).toBe('feedback/message-delete')
  }, 90_000)

  it.skipIf(MODE === 'record')('kept the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
