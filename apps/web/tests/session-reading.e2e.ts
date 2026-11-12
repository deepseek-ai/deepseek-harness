/** Reading marks through the shipped Web profile, real Session history, and two Clients. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/session-reading/unread-menu.expected.md', import.meta.url))
const FAILED_EXPECTED = fileURLToPath(new URL('./expected/session-reading/failed-unread.expected.md', import.meta.url))
let scaffold: WebScaffold
let browser: Browser
let first: Page
let second: Page
let sessionId: string
let failedSessionId: string

beforeAll(async () => {
  scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  const history = await readFile(SEED, 'utf8')
  sessionId = await seedSession(scaffold, history, 'session-reading-web')
  const failedHistory = `${history.trimEnd()}\n${JSON.stringify({ type: 'turn/start', data: { turn: 2 } })}\n${JSON.stringify({
    type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'Request failed' } } },
  })}\n`
  failedSessionId = await seedSession(scaffold, failedHistory, 'session-reading-failed')
  browser = await chromium.launch()
  first = await newEnglishPage(browser)
  second = await newEnglishPage(browser)
  for (const [page, platform] of [[first, 'MacIntel'], [second, 'Win32']] as const) {
    await page.addInitScript((value) => { Object.defineProperty(navigator, 'platform', { value }) }, platform)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const group = page.getByText('Ungrouped', { exact: true }).locator('xpath=ancestor::*[@role="treeitem"][1]')
    await group.waitFor({ timeout: 30_000 })
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    await page.locator(`[data-row-key="session:${sessionId}"]`).waitFor({ timeout: 10_000 })
  }
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await scaffold?.close()
})

async function mark(page: Page, name: 'Mark as read' | 'Mark as unread', id = sessionId): Promise<void> {
  await page.bringToFront()
  const row = page.locator(`[data-row-key="session:${id}"]`)
  await row.hover()
  await row.getByRole('button', { name: /^Session actions for / }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

async function unread(page: Page): Promise<number> {
  return page.locator(`[data-row-key="session:${sessionId}"]`).getByText('Unread', { exact: true }).count()
}

it('synchronizes manual marks, retains them across reload, and acknowledges only on a new view entry', async () => {
  onTestFailed(() => saveFailureShot(first, 'session-reading'))
  const left = watchConsole(first)
  const right = watchConsole(second)
  const row = first.locator(`[data-row-key="session:${sessionId}"]`)
  const title = row.locator(':scope > span').nth(1)
  const initialWeight = await title.evaluate(element => getComputedStyle(element).fontWeight)
  await mark(first, 'Mark as unread')
  await expect.poll(() => unread(first)).toBe(1)
  await expect.poll(() => unread(second)).toBe(1)
  expect(await row.locator('[data-state="done"]').count()).toBe(1)
  expect(await title.evaluate(element => getComputedStyle(element).fontWeight)).toBe(initialWeight)
  expect(await first.getByRole('alert').count()).toBe(0)

  await row.hover()
  await row.getByRole('button', { name: /^Session actions for / }).click()
  expect(await first.getByRole('menuitem', { name: 'Mark as read', exact: true }).getAttribute('aria-keyshortcuts')).toBe('Shift+Meta+U')
  const menuSnapshot = await captureStableAria(first, '[role="menu"]', scaffold.workspaceCwd)
  const rowState = await row.locator('[data-state]').getAttribute('data-state')
  const titleWeight = await title.evaluate(element => getComputedStyle(element).fontWeight)
  await compareOrRefreshGolden(EXPECTED, `${menuSnapshot}\nRow state: ${rowState}\nTitle font weight: ${titleWeight}`, webSnapshotMode())
  await first.keyboard.press('Escape')

  const warningStart = right.warnings.length
  await second.reload({ waitUntil: 'load' })
  await expect.poll(() => unread(second)).toBe(1)
  acknowledgeReloadConnectionLoss(right, warningStart)

  await first.bringToFront()
  await row.click()
  await expect.poll(() => unread(first)).toBe(0)
  await expect.poll(() => unread(second)).toBe(0)
  await first.bringToFront()
  await first.keyboard.press('Meta+Shift+U')
  await expect.poll(() => unread(first)).toBe(1)
  await expect.poll(() => unread(second)).toBe(1)
  await first.keyboard.press('Meta+Shift+U')
  await expect.poll(() => unread(first)).toBe(0)
  await expect.poll(() => unread(second)).toBe(0)
  await second.bringToFront()
  await second.locator(`[data-row-key="session:${sessionId}"]`).click()
  await second.keyboard.press('Control+Shift+U')
  await expect.poll(() => unread(first)).toBe(1)
  await expect.poll(() => unread(second)).toBe(1)
  await second.keyboard.press('Control+Shift+U')
  await expect.poll(() => unread(first)).toBe(0)
  await expect.poll(() => unread(second)).toBe(0)
  expect(await first.getByRole('alert').count()).toBe(0)
  expect(await second.getByRole('alert').count()).toBe(0)
  await mark(first, 'Mark as unread')
  await expect.poll(() => unread(first)).toBe(1)
  await expect.poll(() => unread(second)).toBe(1)
  await mark(second, 'Mark as read')
  await expect.poll(() => unread(first)).toBe(0)
  await expect.poll(() => unread(second)).toBe(0)
  expect(left.pageErrors).toEqual([])
  expect(right.pageErrors).toEqual([])
  expect(left.warnings).toEqual([])
  expect(right.warnings).toEqual([])
})

it('shares a manual reminder on restored history without claiming its outcome', async () => {
  onTestFailed(() => saveFailureShot(first, 'session-reading-restored'))
  const row = (page: Page) => page.locator(`[data-row-key="session:${failedSessionId}"]`)
  const errors = (page: Page) => row(page).locator('[data-state="error"]').count()
  const done = (page: Page) => row(page).locator('[data-state="done"]').count()
  await first.bringToFront()
  await mark(first, 'Mark as unread', failedSessionId)
  await expect.poll(() => done(first)).toBe(1)
  await expect.poll(() => done(second)).toBe(1)
  expect(await errors(first)).toBe(0)
  expect(await row(first).getByText('Unread', { exact: true }).count()).toBe(1)
  await compareOrRefreshGolden(FAILED_EXPECTED, await captureStableAria(
    first, `[data-row-key="session:${failedSessionId}"]`, scaffold.workspaceCwd, { normalizeAge: true },
  ), webSnapshotMode())
  const consoleState = watchConsole(second)
  const warningStart = consoleState.warnings.length
  await second.reload({ waitUntil: 'load' })
  await expect.poll(() => done(second)).toBe(1)
  acknowledgeReloadConnectionLoss(consoleState, warningStart)
  await mark(first, 'Mark as read', failedSessionId)
  await expect.poll(() => done(first)).toBe(0)
  await expect.poll(() => done(second)).toBe(0)
  await mark(first, 'Mark as unread', failedSessionId)
  await expect.poll(() => done(second)).toBe(1)
  expect(consoleState.pageErrors).toEqual([])
  expect(consoleState.warnings).toEqual([])
})

it('preserves manual unread on window focus and clears it after the main view leaves and returns', async () => {
  onTestFailed(() => saveFailureShot(first, 'session-reading-entry'))
  const row = first.locator(`[data-row-key="session:${sessionId}"]`)
  const content = (id: string) => first.locator(`[data-conversation-content][data-conversation-session="${id}"]`)
  await first.bringToFront()
  await row.click()
  await content(sessionId).waitFor()
  await mark(first, 'Mark as unread')
  await expect.poll(() => unread(first)).toBe(1)
  await expect.poll(() => unread(second)).toBe(1)

  await second.bringToFront()
  await first.bringToFront()
  await expect.poll(() => first.evaluate(() => document.hasFocus())).toBe(true)
  await row.hover()
  await row.getByRole('button', { name: /^Session actions for / }).click()
  await first.getByRole('menuitem', { name: 'Mark as read', exact: true }).waitFor()
  expect(await unread(first)).toBe(1)
  expect(await unread(second)).toBe(1)
  await first.keyboard.press('Escape')

  await first.locator(`[data-row-key="session:${failedSessionId}"]`).click()
  await content(failedSessionId).waitFor()
  expect(await unread(first)).toBe(1)
  await row.click()
  await expect.poll(() => unread(first)).toBe(0)
  await expect.poll(() => unread(second)).toBe(0)
})
