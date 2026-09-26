// Browser geometry for the input card across Chat and Trajectory. The browser
// must expose layout-consuming scrollbars, and an uncompensated control keeps
// equal rectangles from passing vacuously.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import {
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/composer-tab-geometry', import.meta.url))
/** Records platform-neutral distances between the two tabs' card rectangles. */
const GEOMETRY_EXPECTED = join(SNAPSHOT_DIR, 'geometry.expected.md')
const MODE = webSnapshotMode()

/** Long enough that the transcript overflows the lane's 1000px viewport; the scenario asserts the overflow rather than trusting it. */
const FIXTURE = createChatScrollFixture({
  markerPrefix: 'TAB_GEOMETRY',
  title: 'COMPOSER_TAB_GEOMETRY long session',
  turns: 24,
})
const SEED_ID = 'composer-tab-geometry-web-e2e'

/** Viewport widths the scenario measures at: the card capped, and the card shrinking with the column. */
const WIDE_VIEWPORT = { width: 1680, height: 1000 }
const NARROW_VIEWPORT = { width: 800, height: 1000 }

/**
 * Resize to one measurement viewport after the responsive sidebar and center
 * column finish their track transition.
 * @param page - the page under test.
 * @param viewport - the viewport dimensions to apply.
 * @param sidebarCollapsed - the sidebar state expected at this width.
 */
async function setMeasuredViewport(
  page: Page,
  viewport: { width: number; height: number },
  sidebarCollapsed: boolean,
): Promise<void> {
  await page.setViewportSize(viewport)
  await page.locator('[data-sidebar-collapsed="true"]').waitFor({
    state: sidebarCollapsed ? 'attached' : 'detached',
    timeout: 10_000,
  })
  await page.locator('[data-conversation-scroll]').evaluate(async (host) => {
    const deadline = performance.now() + 5_000
    let previous = host.getBoundingClientRect().width
    let stableFrames = 0
    while (performance.now() < deadline) {
      await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
      const current = host.getBoundingClientRect().width
      stableFrames = Math.abs(current - previous) < 0.01 ? stableFrames + 1 : 0
      if (stableFrames >= 3) return
      previous = current
    }
    throw new Error('conversation width did not settle after the viewport changed')
  })
}

/**
 * The uncompensated cascade, injected into the page: the overlay seat's `right`
 * compensation dropped to 0, so it measures the full padding box while Chat's
 * seat still rides the reserved content box. `!important` beats the module
 * rules without a rebuild, and the id lets the control be lifted again in the
 * same session.
 */
const CONTROL_STYLE_ID = 'composer-tab-geometry-control'
const CONTROL_CSS = `
[data-conversation-scroll]:has([data-conversation-composer-overlay]) > [data-composer-seat] { right: 0 !important; }
`

/** The column scroller and the input card as the browser lays them out, in one tab. */
interface TabMetrics {
  gutter: string
  overflowX: string
  overflowY: string
  band: number
  scrolls: boolean
  cardLeft: number
  cardRight: number
  cardWidth: number
}

/** One tab's metrics beside the other's, plus the distances between them. */
interface TabComparison {
  chat: TabMetrics
  trajectory: TabMetrics
  leftShift: number
  rightShift: number
  widthShift: number
}

/**
 * Measure the column scroller and the input card in the tab currently shown.
 * @param page - the page under test.
 * @returns the scroller's resolved overflow style and the card's rectangle.
 */
function measureTab(page: Page): Promise<TabMetrics> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-conversation-scroll]')
    if (host === null) throw new Error('conversation column scroller not in the DOM')
    const card = host.querySelector<HTMLElement>('[data-composer-seat] [data-composer-card]')
    if (card === null) throw new Error('no input card inside the composer seat')
    const style = getComputedStyle(host)
    const hostRect = host.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    return {
      gutter: style.scrollbarGutter,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      band: hostRect.width - host.clientWidth,
      scrolls: host.scrollHeight > host.clientHeight,
      cardLeft: cardRect.left,
      cardRight: cardRect.right,
      cardWidth: cardRect.width,
    }
  })
}

/**
 * Show one tab and wait for the view that owns it to be laid out.
 * @param page - the page under test.
 * @param tab - the tab to show.
 */
async function showTab(page: Page, tab: 'Chat' | 'Trajectory'): Promise<void> {
  await page.getByRole('tab', { name: tab, exact: true }).click()
  if (tab === 'Trajectory') await page.getByLabel('Trajectory timeline').waitFor({ timeout: 30_000 })
  else await page.locator('[data-conversation-scroll] [data-chat-anchor-key]:visible').first().waitFor({ timeout: 30_000 })
  // Both measurements are taken after a paint, so a rectangle read mid-transition
  // cannot be reported as a shift the cascade did not cause.
  await page.evaluate(() => new Promise<void>((settle) => {
    requestAnimationFrame(() => { requestAnimationFrame(() => { settle() }) })
  }))
}

/**
 * Measure both tabs and the distances between them, leaving Chat shown.
 * @param page - the page under test.
 * @returns each tab's metrics and the card's displacement between them.
 */
async function compareTabs(page: Page): Promise<TabComparison> {
  await showTab(page, 'Chat')
  const chat = await measureTab(page)
  await showTab(page, 'Trajectory')
  const trajectory = await measureTab(page)
  await showTab(page, 'Chat')
  return {
    chat,
    trajectory,
    leftShift: Math.abs(trajectory.cardLeft - chat.cardLeft),
    rightShift: Math.abs(trajectory.cardRight - chat.cardRight),
    widthShift: Math.abs(trajectory.cardWidth - chat.cardWidth),
  }
}

/**
 * Run the uncompensated cascade in the page for one measurement, then lift it:
 * the overlay seat's `right` compensation dropped to 0, so it measures the
 * full padding box while Chat's seat still rides the reserved content box.
 * @param page - the page under test.
 * @returns the comparison as the column lays out without the compensation.
 */
async function compareTabsWithoutCompensation(page: Page): Promise<TabComparison> {
  await page.evaluate(({ id, css }) => {
    const style = document.createElement('style')
    style.id = id
    style.textContent = css
    document.head.append(style)
  }, { id: CONTROL_STYLE_ID, css: CONTROL_CSS })
  try {
    return await compareTabs(page)
  } finally {
    await page.evaluate((id) => { document.getElementById(id)?.remove() }, CONTROL_STYLE_ID)
  }
}

/**
 * Open the seeded session from the sidebar search.
 *
 * Cold summaries carry the temp workspace's basename, so the persisted first
 * message is the stable identity to search for, and the query itself drives the
 * lazy content-index reconciliation. Hand-rolled polling because `expect.poll`
 * is test-scoped and this runs in `beforeAll`.
 * @param page - the page under test.
 */
async function openSeededSession(page: Page): Promise<void> {
  // Search collapsed into a header action; expand it before filling.
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  const search = page.getByRole('textbox', { name: 'Search session names', exact: true })
  await search.fill(FIXTURE.markers.user(1))
  const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  const deadline = Date.now() + 60_000
  for (;;) {
    if (await results.count() === 1) break
    if (Date.now() > deadline) throw new Error('seeded session never appeared in the sidebar search results')
    await page.waitForTimeout(200)
  }
  await results.click()
}

/**
 * Render the golden body.
 * @param wide - comparison at the viewport where the card sits at its width cap.
 * @param narrow - comparison at the viewport where the card shrinks with the column.
 * @param control - comparison at the wide viewport with the compensation removed.
 * @returns the golden body, without a trailing newline.
 */
function renderGeometry(wide: TabComparison, narrow: TabComparison, control: TabComparison): string {
  const section = (name: string, comparison: TabComparison): string[] => [
    `## ${name}`,
    '',
    `- Chat: scrollbar-gutter ${comparison.chat.gutter}, overflow ${comparison.chat.overflowX}/${comparison.chat.overflowY}`,
    `- Chat scroller scrolls: ${String(comparison.chat.scrolls)}`,
    `- Chat reserved band: ${String(comparison.chat.band)}px`,
    `- Trajectory: scrollbar-gutter ${comparison.trajectory.gutter}, overflow ${comparison.trajectory.overflowX}/${comparison.trajectory.overflowY}`,
    `- Trajectory scroller scrolls: ${String(comparison.trajectory.scrolls)}`,
    `- Trajectory reserved band: ${String(comparison.trajectory.band)}px`,
    `- input card left edge moves between tabs: ${String(comparison.leftShift)}px`,
    `- input card right edge moves between tabs: ${String(comparison.rightShift)}px`,
    `- input card width changes between tabs: ${String(comparison.widthShift)}px`,
    '',
  ]
  return [
    '# Input card position across the Chat and Trajectory tabs',
    '',
    ...section(`Wide viewport (${String(WIDE_VIEWPORT.width)}px, card at its cap)`, wide),
    ...section(`Narrow viewport (${String(NARROW_VIEWPORT.width)}px, card shrinking with the column)`, narrow),
    ...section('Wide viewport, seat compensation removed in the page (control)', control),
  ].join('\n').trimEnd()
}

describe('web e2e: input card position across view tabs', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, FIXTURE.log, SEED_ID)
    // Scrollbars must take layout space here or the comparison is vacuous.
    browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] })
    page = await newEnglishPage(browser, WIDE_VIEWPORT.height)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openSeededSession(page)
    await page.getByRole('tab', { name: 'Chat', exact: true }).waitFor({ timeout: 30_000 })
    await page.getByText(FIXTURE.markers.assistant(FIXTURE.turns), { exact: false }).last()
      .waitFor({ timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('reserves the gutter in Chat and lets Trajectory own its width', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-tab-geometry-band'))
    await setMeasuredViewport(page, WIDE_VIEWPORT, false)
    // Vacuity guard. The scenario must be able to fail: on an engine that
    // does not implement `scrollbar-gutter`, Chat reserves nothing and the
    // overlay seat's fixed compensation stands alone, manufacturing an 8px
    // deviation the equal-rectangle assertions would catch. `stable` reserves
    // even without overflow, so a short transcript is not a vacuous case; the
    // poll still pins the measurement to the overflowing state the product
    // ships.
    await expect.poll(async () => (await measureTab(page)).scrolls, { timeout: 10_000 }).toBe(true)
    const comparison = await compareTabs(page)
    expect(comparison.chat.band).toBeGreaterThan(0)
    // Chat keeps the unconditional reservation so its seat's content box never
    // jumps as the transcript starts to scroll.
    expect(comparison.chat.gutter).toBe('stable')
    // The overlay branch does NOT reserve: the view owns its own scrollers, so
    // a reserved gutter would only narrow the view's content by the bar's
    // width. The seat compensates instead, which the next test asserts.
    expect(comparison.trajectory.gutter).toBe('auto')
    expect(comparison.trajectory.band).toBe(0)
    // Declared as a scroll container on both axes rather than left to compute:
    // `overflow: hidden` would drop any reservation in WebKit, and a `visible`
    // horizontal axis computes to `auto` beside a scrolling one.
    expect(comparison.trajectory.overflowY).toBe('auto')
    expect(comparison.trajectory.overflowX).toBe('hidden')
    // Only Chat scrolls this box; the Trajectory view owns its own scrollers.
    expect(comparison.trajectory.scrolls).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('holds the input card in place when the tab changes', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-tab-geometry-wide'))
    await setMeasuredViewport(page, WIDE_VIEWPORT, false)
    const comparison = await compareTabs(page)
    // The reported symptom as a number. At this viewport the card sits at its
    // width cap, so the uncompensated cascade's shift shows up as a centring
    // difference — half the band on each edge — rather than as a width change.
    expect(comparison.leftShift).toBe(0)
    expect(comparison.rightShift).toBe(0)
    expect(comparison.widthShift).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('holds the input card in place at a viewport where it shrinks with the column', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-tab-geometry-narrow'))
    await setMeasuredViewport(page, WIDE_VIEWPORT, false)
    const capped = await measureTab(page)
    await setMeasuredViewport(page, NARROW_VIEWPORT, true)
    const comparison = await compareTabs(page)
    // The other geometry, and a different failure: below the cap the card takes
    // the column's width, so an unreserved gutter changes its WIDTH by the whole
    // band instead of shifting it by half. Asserted against the capped
    // measurement rather than against the cap's pixel value, which belongs to
    // the stylesheet.
    expect(comparison.chat.cardWidth).toBeLessThan(capped.cardWidth)
    expect(comparison.leftShift).toBe(0)
    expect(comparison.rightShift).toBe(0)
    expect(comparison.widthShift).toBe(0)
    await setMeasuredViewport(page, WIDE_VIEWPORT, false)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('moves the card again once the seat compensation is removed in the page', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-tab-geometry-control'))
    await setMeasuredViewport(page, WIDE_VIEWPORT, false)
    // The control: without it, equal rectangles could also mean the tab switch
    // never reached the layout. Under the uncompensated cascade the overlay seat
    // loses its `right` compensation and measures the full padding box, so the
    // card moves by half the band on each edge. Chat's own reservation is
    // untouched — that is the side that must not change.
    const comparison = await compareTabsWithoutCompensation(page)
    expect(comparison.chat.gutter).toBe('stable')
    expect(comparison.chat.band).toBeGreaterThan(0)
    expect(comparison.trajectory.band).toBe(0)
    expect(comparison.leftShift).toBe(comparison.chat.band / 2)
    expect(comparison.rightShift).toBe(comparison.chat.band / 2)
    // Restoring the sheet restores the compensation, so the control cannot leak
    // into the remaining measurements.
    const restored = await compareTabs(page)
    expect(restored.leftShift).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('matches the committed tab geometry golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-tab-geometry-golden'))
    await setMeasuredViewport(page, WIDE_VIEWPORT, false)
    const wide = await compareTabs(page)
    await setMeasuredViewport(page, NARROW_VIEWPORT, true)
    const narrow = await compareTabs(page)
    await setMeasuredViewport(page, WIDE_VIEWPORT, false)
    const control = await compareTabsWithoutCompensation(page)
    await compareOrRefreshGolden(GEOMETRY_EXPECTED, renderGeometry(wide, narrow, control), MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('commits exactly the fixtures it reads', async () => {
    // The seeded session is generated in-process, so the geometry golden is the
    // whole inventory.
    await assertFixtureInventory(SNAPSHOT_DIR, ['geometry.expected.md'])
  })

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', () => {
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })
})
