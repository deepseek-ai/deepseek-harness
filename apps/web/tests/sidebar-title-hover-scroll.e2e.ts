// Web e2e scenario: hovering a sidebar session row marquees a title wider than
// its cell. The jsdom lane pins only the positions the handler writes; the
// assembled browser is where the title really clips, really crawls toward its
// own hovered extent (the trailing relative-time cell yields to the row menu
// while the pointer rests on the row, so the hovered cell is wider than the
// resting one), really fades its moved left edge, and really returns to its
// start when the pointer leaves.
//
// Zero model calls: seeding one renamed session and hovering its row touches no
// provider.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
/** Wider than the sidebar cell, under the 80-byte title limit, with a far-edge suffix the marquee must reach. */
const TITLE = 'Forked session clipped before its suffix (1)'

describe('web e2e: hovering a clipped session title marquees it to its far edge', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const id = await seedSession(scaffold, await readFile(SEED, 'utf8'), 'sidebar-title-hover-scroll')
    await workspace.attachSession(id)
    await scaffold.ctx.sessionController.rename({ sessionId: id, title: TITLE })
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

  it('crawls the clipped title under the pointer and restores its start after', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-title-hover-scroll'))
    const row = page.getByRole('treeitem').filter({ has: page.getByText(TITLE, { exact: true }) })
    await row.waitFor({ timeout: 20_000 })
    const title = row.getByText(TITLE, { exact: true })

    // At rest the row clips its title with an ellipsis and holds its start.
    expect(await title.evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0)
    expect(await title.evaluate(el => getComputedStyle(el).textOverflow)).toBe('ellipsis')
    expect(await title.evaluate(el => el.scrollLeft)).toBe(0)

    await row.hover()
    // The marquee crawls instead of jumping: the title is caught mid-travel,
    // strictly between its start and its far edge, with both cut edges
    // publishing their fade-mask hooks.
    await expect.poll(
      async () => title.evaluate(el => el.scrollLeft > 0),
      { timeout: 5_000 },
    ).toBe(true)
    expect(await title.evaluate(el => el.scrollLeft < el.scrollWidth - el.clientWidth - 1)).toBe(true)
    expect(await title.evaluate(el => el.hasAttribute('data-scrolled'))).toBe(true)
    expect(await title.evaluate(el => el.hasAttribute('data-clipped'))).toBe(true)
    expect(await title.evaluate(el => getComputedStyle(el).maskImage)).toContain('linear-gradient')
    // The crawl still reaches the far edge of the hovered cell (the wider
    // one — the relative-time label yields to the row menu) and rests there,
    // lifting the right fade so the final character reads at full strength.
    // The fade lifts on the frame that lands exactly on the far edge, one or
    // two frames after scrollLeft first rounds within a pixel of it.
    await expect.poll(
      async () => title.evaluate(el => el.scrollLeft >= el.scrollWidth - el.clientWidth - 1),
      { timeout: 20_000 },
    ).toBe(true)
    await expect.poll(
      async () => title.evaluate(el => el.hasAttribute('data-clipped')),
      { timeout: 5_000 },
    ).toBe(false)
    // At its extent, the title must not paint the ellipsis over the
    // characters the marquee reached.
    expect(await title.evaluate(el => getComputedStyle(el).textOverflow)).toBe('clip')

    // Leaving returns in one step: a crawl back would still be travelling
    // inside this window, and it would carry the resting ellipsis with it.
    await page.mouse.move(0, 0)
    await expect.poll(
      async () => title.evaluate(el => el.scrollLeft),
      { timeout: 150, interval: 20 },
    ).toBe(0)
    expect(await title.evaluate(el => el.hasAttribute('data-scrolled'))).toBe(false)
    expect(await title.evaluate(el => getComputedStyle(el).textOverflow)).toBe('ellipsis')

    // Reduced motion reaches the handler's matchMedia probe: the reveal jumps
    // to the far edge instead of crawling.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await row.hover()
    await expect.poll(
      async () => title.evaluate(el => el.scrollLeft >= el.scrollWidth - el.clientWidth - 1),
      { timeout: 500, interval: 20 },
    ).toBe(true)
    await page.mouse.move(0, 0)
    await page.emulateMedia({ reducedMotion: null })
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)
})
