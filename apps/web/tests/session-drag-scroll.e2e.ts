/** Scrolling the sidebar Session list while a Session drag is in progress. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { webkit, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const COUNT = 40

describe('web e2e: session drag scrolling', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const fixture = await readFile(SEED, 'utf8')
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const now = Date.now()
    for (let index = 0; index < COUNT; index++) {
      const id = await seedSession(scaffold, fixture, `drag-scroll-${index}`, undefined, {
        createdAt: now - (index + 1) * 60_000,
      })
      await workspace.attachSession(id)
      await scaffold.ctx.sessionController.rename({ sessionId: id, title: `Conversation ${index}` })
    }
    // WebKit does not autoscroll the nested Session list during a drag; Chromium does on its own.
    browser = await webkit.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.addInitScript((account) => {
      localStorage.setItem('dsh.workspace.view.v5', JSON.stringify({
        groupBy: 'workspace', orderBy: 'updated', groupExpansion: { [account]: true },
        sessionOrderByAccount: {},
      }))
    }, workspace.id)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('scrolls the Session list while a dragged Session rests near its edges', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-drag-scroll'))
    const rows = page.locator('[role="treeitem"]:not([aria-expanded])')
    const more = page.getByText(/^Show \d+ more sessions$/)
    await expect.poll(async () => {
      if (await more.count() > 0) await more.click()
      return rows.count()
    }, { timeout: 15_000 }).toBeGreaterThan(COUNT)
    const scrollTops = () => page.evaluate(() => ({
      viewport: document.querySelector('[data-sidebar-scrollport]')!.scrollTop,
      list: document.querySelector('[data-sidebar-list-area]')!.scrollTop,
    }))
    // The visible part of the list: below the toolbar and inside the sidebar viewport.
    const listEdges = () => page.evaluate(() => {
      const list = document.querySelector('[data-sidebar-list-area]')!.getBoundingClientRect()
      const viewport = document.querySelector('[data-sidebar-scrollport]')!.getBoundingClientRect()
      return { top: Math.max(list.top, viewport.top), bottom: Math.min(list.bottom, viewport.bottom) }
    })
    await page.evaluate(() => {
      document.querySelector('[data-sidebar-scrollport]')!.scrollTop = 0
      document.querySelector('[data-sidebar-list-area]')!.scrollTop = 0
    })
    const source = rows.filter({ hasText: 'Conversation 0' })
    const box = (await source.boundingBox())!
    const x = box.x + 30
    await page.mouse.move(x, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(x, box.y + box.height / 2 + 10, { steps: 3 })
    // Keep the pointer moving so the browser keeps sending dragover.
    const rest = async (y: number, done: () => Promise<boolean>): Promise<void> => {
      await expect.poll(async () => {
        await page.mouse.move(x + 1, y)
        await page.mouse.move(x, y)
        return done()
      }, { timeout: 15_000 }).toBe(true)
    }
    await rest((await listEdges()).bottom - 4, async () => (await scrollTops()).list > 300)
    expect((await scrollTops()).viewport).toBeGreaterThan(0)
    await rest((await listEdges()).top + 4, async () => (await scrollTops()).list === 0)
    await rest((await listEdges()).bottom - 4, async () => (await scrollTops()).list > 300)
    // Drop onto a row that was out of view when the drag started.
    const middle = (await listEdges()).top + 200
    await page.mouse.move(x, middle, { steps: 3 })
    await page.mouse.move(x + 1, middle)
    await page.mouse.move(x, middle)
    const target = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)!
      .closest('[role="treeitem"]')!.querySelector('[class*="title"]')!.textContent, { x, y: middle })
    expect(target).toMatch(/^Conversation (\d{2}|[89])$/)
    await page.mouse.up()
    const titles = () => rows.locator('[class*="title"]').allTextContents()
    await expect.poll(async () => {
      const order = await titles()
      return Math.abs(order.indexOf('Conversation 0') - order.indexOf(target))
    }).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
