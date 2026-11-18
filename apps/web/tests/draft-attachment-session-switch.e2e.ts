// Web e2e scenario: a composer draft's pasted image survives a sidebar session
// switch. The reported defect spans the whole chain — sidebar row click, Session
// scope retirement, the input shell's teardown, and the rail's rebuild — so only
// the real composition can pin it. Units cover each link separately (hub/shell/
// service specs); this covers the assembled path and the rail the user sees.
//
// Zero model calls: a seeded session is non-blank (so the sidebar can create a
// second one instead of reusing it) and the scenario never submits.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const SEED_ID = 'draft-attachment-switch-a'
const PEER_ID = 'draft-attachment-switch-b'
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v3.jsonl', import.meta.url))
const PNG = fileURLToPath(new URL('../../../snapshots/session/read-image/workspace/red.png', import.meta.url))
const DRAFT_TEXT = 'draft text that survives the switch'

/** The composer's pending-attachment rail, present only while it holds items. */
const RAIL = '[role="group"][aria-label="Pending attachments"]'

/**
 * Paste one real PNG into the composer through a genuine clipboard event, the
 * same intake a user's screenshot paste performs.
 * @param page - page holding the composer.
 * @param bytes - PNG bytes.
 */
async function pasteImage(page: Page, bytes: Uint8Array): Promise<void> {
  await page.locator('[data-composer-input]').first().evaluate((surface, data) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(data)], 'draft.png', { type: 'image/png' }))
    surface.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: transfer, bubbles: true, cancelable: true,
    }))
  }, [...bytes])
}

describe.skipIf(MODE === 'record')('web e2e: draft attachment across a session switch', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const log = await readFile(FIXTURE, 'utf8')
    await seedSession(scaffold, log, SEED_ID)
    await seedSession(scaffold, log, PEER_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // Expand the workspace group and open the seeded session.
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator(`[data-row-key="session:${SEED_ID}"]`)
    await sessionRow.waitFor({ timeout: 15_000 })
    await sessionRow.click()
    await page.locator('[data-composer-input]').first().waitFor({ timeout: 15_000 })
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps the pasted image and the typed draft when the sidebar leaves and returns', async () => {
    onTestFailed(() => saveFailureShot(page, 'draft-attachment-session-switch'))
    // (a) paste an image, then type text into the seeded session's composer.
    await pasteImage(page, await readFile(PNG))
    await expect.poll(() => page.locator(`${RAIL} img`).count(), { timeout: 15_000 }).toBe(1)
    await page.locator('[data-composer-input]').first().click()
    await page.keyboard.type(DRAFT_TEXT, { delay: 5 })
    await expect.poll(() => page.locator(RAIL).locator('img').count(), { timeout: 10_000 }).toBe(1)

    // (b) leave through the sidebar: switching to another session retires this
    // one's Session scope.
    await page.locator(`[data-row-key="session:${PEER_ID}"]`).click()
    await expect.poll(() => page.locator(RAIL).count(), { timeout: 15_000 }).toBe(0)

    // (c) return: the rebuilt composer must show the image AND the text.
    await page.locator(`[data-row-key="session:${SEED_ID}"]`).click()
    await expect.poll(() => page.locator(`${RAIL} img`).count(), { timeout: 15_000 }).toBe(1)
    await expect.poll(
      () => page.locator('[data-composer-input]').first().innerText(),
      { timeout: 10_000 },
    ).toContain(DRAFT_TEXT)
    expect(tripwire.pageErrors).toEqual([])
  })
})
