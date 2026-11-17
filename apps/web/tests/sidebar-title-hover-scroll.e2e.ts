// Web e2e scenario: hovering a sidebar session row marquees a title wider than
// its cell. The jsdom lane pins only the distance and time the handler hands
// the stylesheet; the assembled browser is where the title really clips,
// really travels toward its own hovered extent (the trailing relative-time
// cell yields to the row menu while the pointer rests on the row, so the
// hovered cell is wider than the resting one) without a frame script, really
// fades its cut edges, and really returns to its start when the pointer leaves.
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
    // The title text sits in the span that travels; its parent clips it.
    const travel = row.getByText(TITLE, { exact: true })
    const title = travel.locator('xpath=..')
    /** How far the text has travelled from its start, in CSS pixels. */
    const travelled = async (): Promise<number> => travel.evaluate((el) => {
      const transform = getComputedStyle(el).transform
      return transform === 'none' ? 0 : -new DOMMatrix(transform).m41
    })
    /** Top of the title's glyphs: the text keeps its line while its span becomes a box to travel. */
    const glyphTop = async (): Promise<number> => travel.evaluate((el) => {
      const glyphs = document.createRange()
      glyphs.selectNodeContents(el)
      return glyphs.getBoundingClientRect().top
    })
    /** The distance the hook measured for the hovered cell. */
    const range = async (): Promise<number> => title.evaluate(el => Number.parseFloat(el.style.getPropertyValue('--dsh-marquee-range')))

    // At rest the row clips its title with an ellipsis and holds its start.
    expect(await title.evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0)
    expect(await title.evaluate(el => getComputedStyle(el).textOverflow)).toBe('ellipsis')
    expect(await travelled()).toBe(0)
    const restingTop = await glyphTop()

    // The stylesheet moves the text, so the page runs no frame callback per frame while it travels.
    await page.evaluate(() => {
      const request = window.requestAnimationFrame.bind(window)
      Reflect.set(window, 'marqueeFrames', 0)
      window.requestAnimationFrame = (callback) => {
        Reflect.set(window, 'marqueeFrames', Number(Reflect.get(window, 'marqueeFrames')) + 1)
        return request(callback)
      }
    })
    await row.hover()
    // The marquee travels instead of jumping: the title is caught mid-travel,
    // strictly between its start and its far edge, with both cut edges faded.
    await expect.poll(async () => await travelled() > 0, { timeout: 5_000 }).toBe(true)
    expect(await travelled()).toBeLessThan(await range() - 1)
    expect(await title.evaluate(el => el.hasAttribute('data-marquee'))).toBe(true)
    expect(await title.evaluate(el => getComputedStyle(el).maskImage)).toContain('calc(100% - 12px)')
    expect(Math.abs(await glyphTop() - restingTop)).toBeLessThan(0.5)
    // Constant 30px/s: one second of travel covers about 30px.
    const before = await travelled()
    const started = Date.now()
    await page.waitForTimeout(1_000)
    const speed = (await travelled() - before) / ((Date.now() - started) / 1_000)
    expect(speed).toBeGreaterThan(24)
    expect(speed).toBeLessThan(36)
    // The travel still reaches the far edge of the hovered cell (the wider
    // one — the relative-time label yields to the row menu) and rests there,
    // lifting the end fade so the final character reads at full strength.
    await expect.poll(async () => await travelled() >= await range() - 1, { timeout: 20_000 }).toBe(true)
    await expect.poll(
      async () => title.evaluate(el => getComputedStyle(el).maskImage.includes('calc(100% - 12px)')),
      { timeout: 5_000 },
    ).toBe(false)
    expect(await title.evaluate(el => getComputedStyle(el).maskImage)).toContain('linear-gradient')
    // At its extent, the title must not paint the ellipsis over the
    // characters the marquee reached.
    expect(await title.evaluate(el => getComputedStyle(el).textOverflow)).toBe('clip')
    // A frame script would have run once per frame for the whole travel; other parts of the page may ask for a frame or two.
    expect(await page.evaluate(() => Number(Reflect.get(window, 'marqueeFrames')))).toBeLessThan(10)

    // Leaving returns in one step: a travel back would still be under way
    // inside this window, and it would carry the resting ellipsis with it.
    await page.mouse.move(0, 0)
    await expect.poll(travelled, { timeout: 150, interval: 20 }).toBe(0)
    expect(await title.evaluate(el => el.hasAttribute('data-marquee'))).toBe(false)
    expect(await title.evaluate(el => getComputedStyle(el).textOverflow)).toBe('ellipsis')

    // Reduced motion shows the far edge at once instead of travelling to it.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await row.hover()
    await expect.poll(async () => await travelled() >= await range() - 1, { timeout: 500, interval: 20 }).toBe(true)
    await page.mouse.move(0, 0)
    await page.emulateMedia({ reducedMotion: null })
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)
})
