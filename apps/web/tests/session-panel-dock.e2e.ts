/**
 * Session panel docking in the shipped Web composition. The panel's stylesheet
 * decides whether the Chat View's end gutter holds the docked panel and tells
 * the plugin through a 1px dock probe; jsdom cannot evaluate that stylesheet,
 * so this measures the probe, the panel, and the toggle around the boundary.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v3.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = brandString<SessionId>('session-panel-dock-web-e2e')
/** The default transcript width in a frame wide enough to dock. */
const TRANSCRIPT = 880
/** The gutter that holds the docked panel: 40px clear of the transcript, its 300px minimum width, and the 8px edge inset. */
const DOCK_GUTTER = 348

/** What the layout says about docking: the gutter, the probe, the panel's presentation and insets, and the toggle. */
function docking(page: Page) {
  return page.evaluate(() => {
    const layer = document.querySelector<HTMLElement>('[data-chat-aside]')
    const column = document.querySelector<HTMLElement>('[data-chat-flow]')
    const probe = document.querySelector<HTMLElement>('[data-session-panel-probe]')
    const toggle = document.querySelector<HTMLElement>('[data-session-panel-toggle]')
    if (layer === null || column === null || probe === null || toggle === null) {
      throw new Error('aside layer, transcript column, dock probe, or panel toggle is missing')
    }
    const frame = layer.getBoundingClientRect()
    const flow = column.getBoundingClientRect()
    const panel = document.querySelector<HTMLElement>('[data-session-panel]')
    const box = panel?.getBoundingClientRect()
    return {
      gutter: (frame.width - flow.width) / 2,
      probe: probe.getBoundingClientRect().width,
      presentation: panel?.dataset['sessionPanel'] ?? null,
      expanded: toggle.getAttribute('aria-expanded'),
      panel: box === undefined ? null : { width: box.width, clear: box.left - flow.right, edge: frame.right - box.right },
    }
  })
}

describe.skipIf(MODE === 'record')('web e2e: Session panel docking', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  /** Viewport width the application keeps outside the Chat frame. */
  let chrome = 0

  /** Resize the window so the Chat View's end gutter is exactly `gutter`, and wait for the layout to follow. */
  async function setGutter(gutter: number): Promise<void> {
    await page.setViewportSize({ width: TRANSCRIPT + 2 * gutter + chrome, height: page.viewportSize()!.height })
    await expect.poll(async () => (await docking(page)).gutter, { timeout: 10_000 }).toBe(gutter)
  }

  /** Wait until the panel shows this way (null: not at all) and its entrance has finished. */
  async function shows(presentation: 'docked' | 'overlay' | null): Promise<void> {
    await expect.poll(async () => (await docking(page)).presentation, { timeout: 10_000 }).toBe(presentation)
    if (presentation === null) return
    await page.locator('[data-session-panel]').evaluate(async (element) => {
      await Promise.all(element.getAnimations().map(animation => animation.finished))
    })
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  }, 120_000)

  /** Open the seeded Session and learn how much of the window lies outside the Chat frame. */
  async function openSession(): Promise<void> {
    if (chrome !== 0) return
    const session = page.locator(`[data-row-key="session:${SEED_ID}"]`)
    await expect.poll(async () => {
      if (await session.isVisible()) return true
      const group = page.locator('[role="treeitem"][aria-expanded]').first()
      if (await group.count() > 0 && await group.getAttribute('aria-expanded') === 'false') await group.click()
      return session.isVisible()
    }, { timeout: 15_000 }).toBe(true)
    await session.click()
    await page.locator('[data-session-panel-probe]').waitFor({ state: 'attached', timeout: 30_000 })
    const frame = await page.locator('[data-chat-aside]').evaluate(element => element.getBoundingClientRect().width)
    chrome = page.viewportSize()!.width - frame
  }

  afterAll(async () => {
    const failures: unknown[] = []
    try { await browser?.close() } catch (error) { failures.push(error) }
    try { await scaffold?.close() } catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'Session panel docking teardown failed')
  })

  it('docks exactly from the gutter that holds the panel at its minimum width', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-panel-dock'))
    await openSession()
    expect(Number.isInteger(chrome)).toBe(true)

    await setGutter(DOCK_GUTTER - 1)
    await shows(null)
    expect(await docking(page)).toEqual({ gutter: DOCK_GUTTER - 1, probe: 0, presentation: null, expanded: 'false', panel: null })

    // Half a pixel short, the probe is half a pixel wide and the panel stays hidden.
    await setGutter(DOCK_GUTTER - 0.5)
    expect(await docking(page)).toEqual({ gutter: DOCK_GUTTER - 0.5, probe: 0.5, presentation: null, expanded: 'false', panel: null })

    await setGutter(DOCK_GUTTER)
    await shows('docked')
    expect(await docking(page)).toEqual({
      gutter: DOCK_GUTTER, probe: 1, presentation: 'docked', expanded: 'true', panel: { width: 300, clear: 40, edge: 8 },
    })

    // A wider gutter widens the panel to its maximum at the same edge inset; the probe stays 1px.
    await setGutter(DOCK_GUTTER + 100)
    expect(await docking(page)).toEqual({
      gutter: DOCK_GUTTER + 100, probe: 1, presentation: 'docked', expanded: 'true', panel: { width: 360, clear: 80, edge: 8 },
    })

    await setGutter(DOCK_GUTTER - 1)
    await shows(null)
    expect((await docking(page)).expanded).toBe('false')
    expect(tripwire.pageErrors).toEqual([])
  })

  it('floats narrower than it docks, at the same edge inset, and docks once the gutter holds it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-panel-overlay'))
    await openSession()
    const toggle = page.locator('[data-session-panel-toggle]')
    await setGutter(260)
    await shows(null)
    await toggle.click()
    await shows('overlay')
    const overlay = await docking(page)
    expect(overlay).toMatchObject({ probe: 0, presentation: 'overlay', expanded: 'true', panel: { width: 280, edge: 8 } })
    // The overlay covers part of the transcript instead of keeping clear of it.
    expect(overlay.panel?.clear).toBeLessThan(0)

    await page.keyboard.press('Escape')
    await shows(null)
    expect((await docking(page)).expanded).toBe('false')

    // An open overlay gives way to the docked panel when the window widens enough.
    await toggle.click()
    await shows('overlay')
    await setGutter(DOCK_GUTTER)
    await shows('docked')
    expect(await docking(page)).toMatchObject({ probe: 1, expanded: 'true', panel: { width: 300, clear: 40, edge: 8 } })
    expect(tripwire.pageErrors).toEqual([])
  })
})
