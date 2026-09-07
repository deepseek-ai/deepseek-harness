// Web e2e scenario: the collapsed rail's search control in the real event
// order. The rail click flips the sidebar wide and mounts WorkspaceBrowser's
// outside-click dismissal listener during its own React dispatch; the same
// click then keeps bubbling to document with the unmounted rail button as its
// target — outside searchRoot. The package-level jsdom test cannot replay
// that continuation (fireEvent does not re-bubble through listeners mounted
// mid-dispatch), so the guard that keeps the gesture alive
// (.agents/notes/archived/bug-fix/2026-08-18-rail-search-outside-click-self-dismissal.md)
// is pinned here, in the assembled application under a real browser click.
//
// Zero model calls: collapsing the sidebar and expanding the search are pure
// client layout gestures; the scenario needs no session content at all.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

/** WorkspaceBrowser's rail-search focus delay (EXPAND_SLIDE_MS) plus flush headroom. */
const FOCUS_SETTLE_MS = 600

describe('web e2e: rail search click survives its own document-level bubble', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
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

  it('expands the search and lands focus in the input from one rail click', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-rail-search-expand'))
    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    const railSearch = page.getByRole('button', { name: 'Search sessions' })
    // The wide chrome stays mounted through the 150ms collapse crossfade; the
    // rail control (no aria-expanded) replaces it at settle.
    await expect.poll(async () => railSearch.getAttribute('aria-expanded'), { timeout: 10_000 }).toBeNull()

    // The one real click under test: it must expand the sidebar AND leave the
    // search expanded after its own bubble reaches document.
    await railSearch.click()

    const wideSearch = page.getByRole('button', { name: 'Search sessions' })
    await expect.poll(async () => wideSearch.getAttribute('aria-expanded'), { timeout: 10_000 }).toBe('true')
    const input = page.getByPlaceholder('Search sessions...')
    await expect.poll(
      async () => input.evaluate(el => document.activeElement === el),
      { timeout: FOCUS_SETTLE_MS + 10_000 },
    ).toBe(true)

    // The guard ends with the gesture: a genuine outside click on an empty
    // query dismisses the expanded search as before.
    await page.getByRole('button', { name: 'New session' }).first().click()
    await expect.poll(async () => wideSearch.getAttribute('aria-expanded'), { timeout: 10_000 }).toBe('false')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
