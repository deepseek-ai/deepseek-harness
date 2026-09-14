// Web e2e scenario: the archived-session Settings page restores a Session
// through the real wire, from its row menu through the archive set, the page,
// and the reload that rebuilds state from the host baseline. Zero model calls:
// both verbs are host RPCs and the page reads already-loaded Session summaries,
// so no replay fixture mounts and a stray model stream fails loud.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, seedSession, watchConsole, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

// The seed is another scenario's committed fixture, reused read-only: this
// spec needs any one cold Session row, not new recorded content.
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const SEED_ID = 'session-unarchive-web-e2e'

describe('web e2e: archived sessions are restored from the Settings page', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  /**
   * Expand the Ungrouped group when it renders collapsed so its rows are
   * addressable, then return the section holding them.
   * @returns the expanded Ungrouped section locator.
   */
  async function ungroupedSection(): Promise<Locator> {
    const header = page.getByText('Ungrouped', { exact: true })
    const groupRow = header.locator('..').locator('..')
    await expect.poll(async () => {
      if (await groupRow.count() === 0) return 'absent'
      if (await groupRow.getAttribute('aria-expanded') !== 'true') {
        await header.click()
        return 'collapsed'
      }
      return 'expanded'
    }, { timeout: 15_000 }).toBe('expanded')
    return groupRow.locator('..')
  }

  /**
   * Reveal and click a row action, re-hovering if a projection update replaces
   * the row before its hover-only button becomes visible.
   * @param row - the row owning the action.
   * @param name - accessible name of the action button.
   */
  async function clickHoverAction(row: Locator, name: string): Promise<void> {
    const button = row.getByRole('button', { name })
    await expect.poll(async () => {
      await row.hover()
      return await button.isVisible()
    }, { timeout: 10_000 }).toBe(true)
    await button.click()
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // Seed one cold session; with no Workspace registered it is the sidebar's
    // only row, in the Ungrouped bucket.
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

  it('archives the seed, unarchives it from Settings, and keeps it restored across reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-unarchive'))
    // Select the only visible Session, then give it a user-owned title: the
    // locator binds to the seed's own copy on both sides of the round trip.
    const seededRow = (await ungroupedSection()).locator('[role="treeitem"]')
      .filter({ has: page.locator('button[aria-label^="Session actions for "]') })
    await expect.poll(() => seededRow.count(), { timeout: 10_000 }).toBe(1)
    await seededRow.click()
    await expect.poll(() => seededRow.getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true')
    const { title } = await scaffold.ctx.sessionController.rename({
      sessionId: SessionId(SEED_ID), title: `Unarchive target ${SEED_ID}`,
    })
    const sessionRow = page.getByRole('treeitem').filter({ has: page.getByText(title, { exact: true }) })
    await expect.poll(() => sessionRow.count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => sessionRow.getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true')

    // Archive from the row menu: no confirmation dialog, and losing the last
    // visible Session withdraws the whole Ungrouped bucket.
    await clickHoverAction(sessionRow, `Session actions for ${title}`)
    await page.getByRole('menuitem', { name: 'Archive session' }).click()
    await expect.poll(() => sessionRow.count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(() => page.getByText('Ungrouped', { exact: true }).count(), { timeout: 10_000 }).toBe(0)
    // Durable on the host: the registry-global set carries the id while the
    // Session log itself stays in persistence untouched.
    expect([...scaffold.ctx.workspaceRegistry.archivedSessionIds]).toEqual([SessionId(SEED_ID)])
    expect((await scaffold.ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id))
      .toContain(SessionId(SEED_ID))

    // The Settings page lists the archived Session behind its own search box.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Archived sessions' }).click()
    const search = dialog.getByRole('searchbox', { name: 'Search archived sessions' })
    await search.waitFor({ timeout: 10_000 })
    const unarchiveRow = dialog.getByRole('button', { name: `Unarchive ${title}` })
    await expect.poll(() => unarchiveRow.count(), { timeout: 10_000 }).toBe(1)
    expect(await dialog.getByText(title, { exact: true }).count()).toBe(1)
    expect(await dialog.getByText(/^Ungrouped · /).count()).toBe(1)
    expect(await dialog.getByText('No archived sessions.', { exact: true }).count()).toBe(0)
    // The search box filters these rows in both directions.
    await search.fill('zzz-no-such-archived-session')
    await expect.poll(
      () => dialog.getByText('No matching sessions.', { exact: true }).count(),
      { timeout: 5_000 },
    ).toBe(1)
    expect(await unarchiveRow.count()).toBe(0)
    await search.fill(title)
    await expect.poll(() => unarchiveRow.count(), { timeout: 5_000 }).toBe(1)
    expect(await dialog.getByText('No matching sessions.', { exact: true }).count()).toBe(0)
    await search.fill('')
    await expect.poll(() => unarchiveRow.count(), { timeout: 5_000 }).toBe(1)

    // Unarchive: the durable set empties (the row's own RPC), the page row
    // leaves with the empty status, and the Session row is back in the sidebar.
    await unarchiveRow.click()
    await expect.poll(
      () => [...scaffold.ctx.workspaceRegistry.archivedSessionIds],
      { timeout: 10_000 },
    ).toEqual([])
    await expect.poll(() => unarchiveRow.count(), { timeout: 10_000 }).toBe(0)
    expect(await dialog.getByText(title, { exact: true }).count()).toBe(0)
    await expect.poll(
      () => dialog.getByText('No archived sessions.', { exact: true }).count(),
      { timeout: 10_000 },
    ).toBe(1)
    await dialog.getByRole('button', { name: 'Close' }).last().click()
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
    await ungroupedSection()
    await expect.poll(() => sessionRow.count(), { timeout: 15_000 }).toBe(1)

    // Reload: the restored row is rebuilt from the host baseline, so the
    // unarchive was durable and not merely client state.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await ungroupedSection()
    await expect.poll(() => sessionRow.count(), { timeout: 15_000 }).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)
})
