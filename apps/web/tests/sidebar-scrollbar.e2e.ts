// Browser geometry for the sidebar scrollbar reservation and theme. Headless
// Chromium uses overlay scrollbars, so the reserved band and `timeCoveredBy`
// together distinguish reserved space from a bar painted over content. Its
// computed pseudo-element style also folds in `:hover`, so the test reads that
// declaration from the cascade.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v2.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/sidebar-scrollbar', import.meta.url))
/** Geometry and resolved style are absent from ARIA snapshots, so this scenario records them directly. */
const GEOMETRY_EXPECTED = join(SNAPSHOT_DIR, 'geometry.expected.md')
const MODE = webSnapshotMode()
/** Enough rows that the list overflows the 800px-tall viewport's sidebar; the scenario asserts the overflow rather than trusting it. */
const SEED_COUNT = 24

/** Geometry and resolved scrollbar style of one scroll container, measured in the page. */
interface ListMetrics {
  gutter: string
  width: string
  track: string
  standardWidth: string
  standardColor: string
  hoverRules: string[]
  token: string
  hoverToken: string
  overflows: boolean
  band: number
  scrollbarEdgeOffset: number
  rowEdgeInset: number
  clientRight: number
  borderRight: number
  timeRight: number
  /**
   * Pixels of relative time under the scrollbar, measured against the bar's
   * width because an overlay scrollbar does not move the client edge.
   */
  timeCoveredBy: number
}

/**
 * Measure the sidebar list in the page.
 * @param page - the page under test.
 * @returns the list's resolved scrollbar style and the geometry the
 * scrollbar-gutter/thin-scrollbar declarations shape.
 */
function measureList(page: Page): Promise<ListMetrics> {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[role="tree"][aria-label="Sessions"]')
    if (list === null) throw new Error('sidebar session list not in the DOM')
    const time = list.querySelector<HTMLElement>('[class*="time"]')
    if (time === null) throw new Error('no row relative-time element in the sidebar list')
    const row = list.querySelector<HTMLElement>('[role="treeitem"]')
    if (row === null) throw new Error('no row in the sidebar list')
    // Use one probe per variable because computed style declarations are live;
    // the color property also normalizes palette syntax.
    const resolve = (name: string): string => {
      const probe = document.createElement('span')
      probe.style.color = `var(${name})`
      list.append(probe)
      const value = getComputedStyle(probe).color
      probe.remove()
      return value
    }
    // Computed pseudo style folds in hover even at rest, so inspect the cascade.
    // Cross-origin sheets may throw and cannot contain the app-owned rule.
    const hoverRules = [...document.styleSheets]
      .flatMap((sheet) => {
        try {
          return [...sheet.cssRules]
        } catch {
          return []
        }
      })
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .filter(rule => rule.selectorText === '::-webkit-scrollbar-thumb:hover')
      .map(rule => rule.style.getPropertyValue('background'))
    const style = getComputedStyle(list)
    const pseudoWidth = getComputedStyle(list, '::-webkit-scrollbar').width
    const barWidth = pseudoWidth === 'auto' ? 15 : Number.parseFloat(pseudoWidth)
    const listRect = list.getBoundingClientRect()
    const sidebarEdge = list.parentElement?.getBoundingClientRect().right
    if (sidebarEdge === undefined) throw new Error('sidebar session list has no layout parent')
    return {
      gutter: style.scrollbarGutter,
      width: pseudoWidth,
      track: getComputedStyle(list, '::-webkit-scrollbar-track').backgroundColor,
      standardWidth: style.scrollbarWidth,
      standardColor: style.scrollbarColor,
      hoverRules,
      token: resolve('--dsh-scrollbar-thumb'),
      hoverToken: resolve('--dsh-scrollbar-thumb-hover'),
      overflows: list.scrollHeight > list.clientHeight,
      band: listRect.width - list.clientWidth,
      scrollbarEdgeOffset: sidebarEdge - listRect.right,
      rowEdgeInset: sidebarEdge - row.getBoundingClientRect().right,
      clientRight: listRect.left + list.clientWidth,
      borderRight: listRect.right,
      timeRight: time.getBoundingClientRect().right,
      // The bar is drawn in the rightmost `barWidth` of the border box, whether
      // or not that space was reserved. Its width comes from the sheet where the
      // sheet applies, and from the UA's own overlay bar otherwise — 15px is
      // what this chromium paints, measured with the rule absent. Taking the
      // UA width as the fallback is what keeps the assertion
      // honest: assuming 0 there would report no occlusion precisely in the
      // state that has it.
      timeCoveredBy: Math.max(0, time.getBoundingClientRect().right - (listRect.right - barWidth)),
    }
  })
}

/**
 * Measure only overflow and row inset, which remain observable when every
 * session is hidden under a collapsed workspace group.
 * @param page - the page under test.
 * @returns the list overflow state and first row's trailing inset.
 */
function measureRowInset(page: Page): Promise<Pick<ListMetrics, 'overflows' | 'rowEdgeInset'>> {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[role="tree"][aria-label="Sessions"]')
    if (list === null) throw new Error('sidebar session list not in the DOM')
    const row = list.querySelector<HTMLElement>('[role="treeitem"]')
    if (row === null) throw new Error('no row in the sidebar list')
    const sidebarEdge = list.parentElement?.getBoundingClientRect().right
    if (sidebarEdge === undefined) throw new Error('sidebar session list has no layout parent')
    return {
      overflows: list.scrollHeight > list.clientHeight,
      rowEdgeInset: sidebarEdge - row.getBoundingClientRect().right,
    }
  })
}

/** One palette's readings, taken at both pointer positions. */
interface PaletteMetrics {
  hovered: ListMetrics
  quietThumb: string
}

/**
 * Read one palette at both pointer positions, ending with the pointer back
 * over the list so a caller measuring further leaves it revealed.
 * @param page - the page under test.
 * @returns the palette's quiet thumb and its hovered metrics.
 */
async function measurePalette(page: Page): Promise<PaletteMetrics> {
  await pointAt(page, 'away')
  // Poll rather than sleep the linger out: the wait is the column's, and a
  // fixed sleep would either race it or pad every palette.
  await expect.poll(async () => resolveThumb(page), { timeout: 10_000 }).toBe(NO_THUMB)
  const quietThumb = await resolveThumb(page)
  await pointAt(page, 'list')
  // Poll the reveal too: the reading below is a colour, and taking it in the
  // same tick as the pointer move would race React's flush and land a
  // transparent thumb in the golden.
  await expect.poll(async () => resolveThumb(page), { timeout: 10_000 }).not.toBe(NO_THUMB)
  return { hovered: await measureList(page), quietThumb }
}

/**
 * Render platform-neutral differences and comparisons instead of absolute
 * coordinates that depend on sidebar width and font metrics.
 * @param light - metrics measured under the light palette.
 * @param dark - metrics measured under the dark palette.
 * @returns the golden body, without a trailing newline.
 */
function renderGeometry(light: PaletteMetrics, dark: PaletteMetrics): string {
  const palette = (name: string, { hovered: metrics, quietThumb }: PaletteMetrics): string[] => [
    `## ${name}`,
    '',
    `- --dsh-scrollbar-thumb, pointer outside the sidebar: ${quietThumb}`,
    `- scrollbar-gutter: ${metrics.gutter}`,
    `- ::-webkit-scrollbar width: ${metrics.width}`,
    `- ::-webkit-scrollbar-track background: ${metrics.track}`,
    `- scrollbar-width: ${metrics.standardWidth}`,
    `- scrollbar-color: ${metrics.standardColor}`,
    `- ::-webkit-scrollbar-thumb:hover declarations: ${metrics.hoverRules.join(' | ')}`,
    `- --dsh-scrollbar-thumb, pointer over the list: ${metrics.token}`,
    `- --dsh-scrollbar-thumb-hover, pointer over the list: ${metrics.hoverToken}`,
    `- list overflows: ${String(metrics.overflows)}`,
    `- reserved band: ${String(metrics.band)}px`,
    `- scrollbar inset from the sidebar edge: ${String(metrics.scrollbarEdgeOffset)}px`,
    `- row background inset from the sidebar edge: ${String(metrics.rowEdgeInset)}px`,
    `- relative time covered by the bar: ${String(metrics.timeCoveredBy)}px`,
    `- relative time ends inside the content area: ${String(metrics.timeRight <= metrics.clientRight)}`,
    `- content area ends before the border box: ${String(metrics.clientRight < metrics.borderRight)}`,
    '',
  ]
  return [
    '# Sidebar session list scrollbar',
    '',
    ...palette('Light palette', light),
    ...palette('Dark palette', dark),
  ].join('\n').trimEnd()
}

/**
 * Resolve `--dsh-scrollbar-thumb` as the list sees it, without the rest of the
 * geometry. Own probe element for the same reason {@link measureList} uses
 * one: `getComputedStyle` returns a live declaration.
 * @param page - the page under test.
 * @returns the resolved thumb colour, serialized as `rgb`/`rgba`.
 */
function resolveThumb(page: Page): Promise<string> {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[role="tree"][aria-label="Sessions"]')
    if (list === null) throw new Error('sidebar session list not in the DOM')
    const probe = document.createElement('span')
    probe.style.color = 'var(--dsh-scrollbar-thumb)'
    list.append(probe)
    const value = getComputedStyle(probe).color
    probe.remove()
    return value
  })
}

/** Fully transparent, which is how the quiet column spells "no thumb". */
const NO_THUMB = 'rgba(0, 0, 0, 0)'

/**
 * Park the pointer over the session list or outside the sidebar entirely. The
 * column reveals its scrollbars from real pointer movement, so a scenario that
 * never moves the mouse measures the quiet state whatever it intended to.
 * @param page - the page under test.
 * @param where - `list` to point at the session list, `away` for the far side
 * of the viewport (the conversation column).
 */
async function pointAt(page: Page, where: 'list' | 'away'): Promise<void> {
  const box = await page.locator('[role="tree"][aria-label="Sessions"]').boundingBox()
  if (box === null) throw new Error('sidebar session list has no layout box')
  const viewport = page.viewportSize()
  if (viewport === null) throw new Error('page has no viewport')
  const target = where === 'list'
    ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    : { x: viewport.width - 5, y: box.y + box.height / 2 }
  await page.mouse.move(target.x, target.y)
}

/**
 * Reveal the seeded rows: every seeded session is unattached, so they all sit
 * in the collapsed Ungrouped bucket. Open the bucket, then use its transient
 * Show-more control because an open group intentionally renders only five
 * rows by default. Hand-rolled polling because
 * `expect.poll` is test-scoped and this runs in `beforeAll`.
 * @param page - the page under test.
 */
async function expandSeededSessions(page: Page): Promise<void> {
  const bucket = page.getByText('Ungrouped', { exact: true }).locator('..').locator('..')
  await bucket.waitFor({ timeout: 15_000 })
  const rows = page.locator('[role="tree"][aria-label="Sessions"] [role="treeitem"]')
  const deadline = Date.now() + 30_000
  for (;;) {
    if (await bucket.getAttribute('aria-expanded') !== 'true') {
      await page.getByText('Ungrouped', { exact: true }).click()
    }
    const showMore = page.getByRole('button', { name: /Show \d+ more sessions/ })
    if (await bucket.getAttribute('aria-expanded') === 'true'
      && await rows.count() <= SEED_COUNT / 2
      && await showMore.count() > 0) {
      await showMore.click()
    }
    if (await bucket.getAttribute('aria-expanded') === 'true' && await rows.count() > SEED_COUNT / 2) return
    if (Date.now() > deadline) {
      throw new Error(`Ungrouped bucket never revealed more than ${SEED_COUNT / 2} rows`)
    }
    await page.waitForTimeout(200)
  }
}

describe('web e2e: sidebar session list scrollbar (reserved gutter / themed thumb)', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const fixture = await readFile(SEED, 'utf8')
    for (let index = 0; index < SEED_COUNT; index += 1) {
      await seedSession(scaffold, fixture, `sidebar-scrollbar-web-e2e-${String(index).padStart(2, '0')}`)
    }
    browser = await chromium.launch()
    // Shorter than the other scenarios' 1000px so SEED_COUNT rows overflow
    // the list with room to spare.
    page = await newEnglishPage(browser, 800)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await expandSeededSessions(page)
    // Every assertion about a thumb colour needs a drawn thumb, and the column
    // only draws one under the pointer; the quiet state is asserted where it is
    // the subject rather than left as an ambient condition of the whole file.
    await pointAt(page, 'list')
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('reserves a scrollbar gutter on the overflowing session list', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-scrollbar-gutter'))
    // Vacuity guard: with a non-overflowing list `stable` still reserves, but
    // the scenario would no longer be reproducing the reported situation.
    await expect.poll(async () => (await measureList(page)).overflows, { timeout: 10_000 }).toBe(true)
    const metrics = await measureList(page)
    expect(metrics.gutter).toBe('stable')
    // Pin presence, not width, because the width is platform-dependent.
    expect(metrics.band).toBeGreaterThan(0)
    expect(metrics.scrollbarEdgeOffset).toBe(2)
    expect(metrics.rowEdgeInset).toBe(12)
    // Measure against the bar because overlay scrollbars do not move the client edge.
    expect(metrics.timeCoveredBy).toBe(0)
    expect(metrics.timeRight).toBeLessThanOrEqual(metrics.clientRight)
    expect(metrics.clientRight).toBeLessThan(metrics.borderRight)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('draws no thumb until the pointer is over the column, and lingers on the way out', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-scrollbar-pointer'))
    const revealed = await resolveThumb(page)
    expect(revealed).not.toBe(NO_THUMB)
    await pointAt(page, 'away')
    // The linger, measured as a state rather than a duration: the thumb is
    // still drawn on the leave itself, and gone once the window has passed. A
    // tighter timing assertion would pin the wall clock of a CI machine.
    expect(await resolveThumb(page)).toBe(revealed)
    await expect.poll(async () => resolveThumb(page), { timeout: 10_000 }).toBe(NO_THUMB)
    // The reservation is unconditional, so nothing moved while the bar was
    // hidden — this is what buys `transparent` over hiding the bar itself.
    const quiet = await measureList(page)
    expect(quiet.gutter).toBe('stable')
    expect(quiet.band).toBeGreaterThan(0)
    expect(quiet.timeCoveredBy).toBe(0)
    // Scrolling without a pointer — what a keyboard or a touch drag does —
    // leaves the column quiet. This is the one deliberate loss, and
    // it is pinned here rather than only described, so making a scroll
    // re-reveal the bar has to be a decision rather than a side effect.
    await page.locator('[role="tree"][aria-label="Sessions"]').evaluate((el) => { el.scrollTop += 200 })
    await page.waitForTimeout(500)
    expect(await resolveThumb(page)).toBe(NO_THUMB)
    await pointAt(page, 'list')
    await expect.poll(async () => resolveThumb(page), { timeout: 10_000 }).toBe(revealed)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps the row background inset when overflow disappears', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-scrollbar-stable-inset'))
    expect(await measureRowInset(page)).toEqual({ overflows: true, rowEdgeInset: 12 })
    const bucket = page.getByText('Ungrouped', { exact: true }).locator('..').locator('..')
    await bucket.click()
    try {
      await expect.poll(async () => (await measureRowInset(page)).overflows, { timeout: 10_000 }).toBe(false)
      expect(await measureRowInset(page)).toEqual({ overflows: false, rowEdgeInset: 12 })
    } finally {
      await expandSeededSessions(page)
    }
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('renders the themed thumb through the WebKit path in both palettes', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-scrollbar-theme'))
    const light = await measureList(page)
    // The gate's signature on this engine, and the reason it exists: chromium
    // implements `::-webkit-scrollbar`, so the standard properties stay at
    // their initial `auto`. A concrete value here would mean the gate leaked,
    // which is exactly what makes chromium discard the pseudo-element rules —
    // the hover token included.
    expect(light.standardWidth).toBe('auto')
    expect(light.standardColor).toBe('auto')
    // The pseudo-element path is the one in force: the sheet's own 8px sizing
    // and transparent track reached a container it never names.
    expect(light.width).toBe('8px')
    expect(light.track).toBe('rgba(0, 0, 0, 0)')
    // The resting and the hover rule each read the rebindable indirection, and
    // the two resolve to DIFFERENT colours on this list: the l1 pair arrived
    // here intact rather than collapsing to one value or falling back.
    expect(light.hoverRules).toEqual(['var(--dsh-scrollbar-thumb-hover)'])
    expect(light.token).toMatch(/^rgba?\(/)
    expect(light.hoverToken).not.toBe(light.token)
    // The dark palette declares different scrollbar tokens; driving the body
    // attribute pins the cascade the way lifecycle-chrome does (the Settings
    // gesture that sets it is owned there).
    await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
    const dark = await measureList(page)
    expect(dark.token).not.toBe(light.token)
    expect(dark.hoverToken).not.toBe(dark.token)
    expect(dark.hoverToken).not.toBe(light.hoverToken)
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
    const restored = await measureList(page)
    expect(restored.token).toBe(light.token)
    expect(restored.hoverToken).toBe(light.hoverToken)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('matches the committed scrollbar geometry golden in both palettes', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-scrollbar-golden'))
    const light = await measurePalette(page)
    await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
    const dark = await measurePalette(page)
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
    await compareOrRefreshGolden(GEOMETRY_EXPECTED, renderGeometry(light, dark), MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('commits exactly the fixtures it reads', async () => {
    // The scenario borrows seeded-history's session.v2.jsonl rather than committing a
    // second copy, so this directory holds the golden alone.
    await assertFixtureInventory(SNAPSHOT_DIR, ['geometry.expected.md'])
  })

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', () => {
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })
})
