// Web e2e scenario: with the feedback note editor open, the assistant IconActions
// row stays one intact line (no wrapping, nothing pushed out), and the note
// editor floats above the transcript in a popover that escapes the conversation
// column's overflow clip and stays inside the viewport.
//
// The hazard this pins: a slot-contributed note editor (260px textarea plus
// Save and Cancel) cannot fit the shared IconActions row at ANY viewport, and an
// inline expansion made the row wider than the column — full-screen desktop
// included — so the branch action and the clock were pushed out of view by later
// flex items. The fix is to not mount the editor in the row at all: it is a
// popover portaled to document.body and fixed-positioned from the note trigger's
// rect, so the row keeps its single 28px line of icons and the trigger, and the
// panel cannot be cropped by the column's overflow because it lives outside it.
//
// The sweep records, per viewport, whether the open editor keeps the actions row
// on one line with zero overflow, whether the panel is outside the column (proof
// it escapes the clip), whether the panel stays inside the viewport (proof the
// clamp works), and whether it sits by its trigger. All relations, no absolute
// pixels: the column width follows the viewport, the sidebar, and the platform's
// scrollbar, so a golden carrying pixels would document the platform, not the
// behavior.
//
// Zero model calls: a settled transcript is cold-seeded, so nothing streams.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/message-feedback-layout', import.meta.url))
/**
 * Committed golden of the popover relations at every stop. Booleans and counts
 * only, never absolute coordinates.
 */
const GEOMETRY_EXPECTED = join(SNAPSHOT_DIR, 'geometry.expected.md')
const MODE = webSnapshotMode()
/** Borrowed read-only: this scenario needs any settled assistant message to rate. */
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v2.jsonl', import.meta.url))
const SEED_ID = 'message-feedback-layout-e2e'
/** Viewport widths from full-screen desktop down to a narrow window. */
const WIDTHS = [1680, 1280, 1024, 900, 700, 600]

/** One viewport stop: how the row reads with the note editor closed and open, plus the popover's own relations. */
export interface PopoverMetrics {
  /** Viewport width the stop was measured at. */
  width: number
  /** The row's scrollable overflow with the note editor closed (natural row width). */
  rowOverflowClosed: number
  /** The row's scrollable overflow with the note editor open; must equal the closed value. */
  rowOverflowOpen: number
  /** Flex lines the row occupies with the note editor open; the editor must not reflow it. */
  rowLines: number
  /** Row items whose right edge escapes the column, editor closed. */
  itemsOutsideColumnClosed: number
  /** Row items whose right edge escapes the column, editor open; must equal the closed value. */
  itemsOutsideColumnOpen: number
  /** True when the portaled panel is NOT inside the column (escapes its overflow clip). */
  panelOutsideColumn: boolean
  /** True when the panel lies fully inside the viewport (the clamp holds). */
  panelWithinViewport: boolean
  /** Horizontal separation between the panel's left edge and the note trigger's, in px. */
  panelToTriggerGap: number
}

/**
 * Measure the feedback row (and the open popover, when present) at the current
 * viewport. The same reader serves the closed and open readings so the two
 * sides differ only by whether the editor is open.
 * @param page - the page under test.
 * @param width - the viewport width already applied, recorded with the reading.
 * @param editorOpen - true to also read the popover's relations; throws if it is absent.
 * @returns the stop's relations.
 */
function measurePopover(page: Page, width: number, editorOpen: boolean): Promise<PopoverMetrics> {
  return page.evaluate(({ viewportWidth, open }) => {
    const rated = document.querySelector<HTMLElement>('button[aria-label="Remove rating"]')
    if (rated === null) throw new Error('no rated feedback control in the DOM')
    const row = rated.parentElement?.closest<HTMLElement>('div[class*="actions"]') ?? null
    if (row === null) throw new Error('the IconActions row is not an ancestor of the feedback control')
    const trigger = row.querySelector<HTMLElement>('button[aria-haspopup="dialog"]')
    if (trigger === null) throw new Error('the note trigger is not in the row')

    /**
     * The real flex items of the row. A slot contributor (the feedback strip)
     * arrives as a `display: contents` wrapper (the `assistant-actions` slot
     * renders inside a transparent `data-slot` div), which reports an all-zero
     * rect; a zero box would be miscounted as a phantom flex line. The actual
     * items are the boxes inside it.
     * @param element - the row whose items to read.
     * @returns the real flex-item boxes, in flex/DOM order.
     */
    const flexItemBoxes = (element: HTMLElement): DOMRect[] => {
      const boxes: DOMRect[] = []
      for (const child of Array.from(element.children)) {
        const el = child as HTMLElement
        const rect = el.getBoundingClientRect()
        if (el.style.display === 'contents') {
          boxes.push(...flexItemBoxes(el))
        } else if (rect.height > 0 && rect.width > 0) {
          boxes.push(rect)
        }
      }
      return boxes
    }
    /**
     * Group items into flex lines by overlapping vertical extent.
     * @param boxes - the row items' boxes, in DOM order.
     * @returns the number of distinct lines.
     */
    const countFlexLines = (boxes: DOMRect[]): number => {
      const centres: number[] = []
      for (const box of boxes) {
        const centre = box.top + box.height / 2
        if (!centres.some(known => Math.abs(known - centre) <= box.height / 2)) centres.push(centre)
      }
      return centres.length
    }

    const column = row.closest<HTMLElement>('[data-conversation-scroll]')
    const columnRight = (column?.getBoundingClientRect().left ?? 0) + (column?.clientWidth ?? 0)
    const itemRects = flexItemBoxes(row)
    // A half-pixel tolerance: subpixel layout puts a contained edge a fraction
    // over the boundary on some device scale factors.
    const itemsOutsideColumn = itemRects.filter(box => box.right > columnRight + 0.5).length
    // The editor is a portal, so the row measures identically whether the
    // editor is open or not; the closed/open fields differ by call so the sweep
    // can assert a zero delta on them.
    const overflow = row.scrollWidth - row.clientWidth

    let builder: {
      panelOutsideColumn: boolean
      panelWithinViewport: boolean
      panelToTriggerGap: number
    }
    if (!open) {
      builder = { panelOutsideColumn: true, panelWithinViewport: true, panelToTriggerGap: 0 }
    } else {
      const panel = document.body.querySelector<HTMLElement>('[role="dialog"]')
      if (panel === null) throw new Error('the note popover is not open')
      const panelBox = panel.getBoundingClientRect()
      const triggerBox = trigger.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      builder = {
        // The panel portals out of the column, so the clip cannot reach it.
        panelOutsideColumn: column === null ? true : !column.contains(panel),
        panelWithinViewport:
          panelBox.left >= -0.5
          && panelBox.right <= vw + 0.5
          && panelBox.top >= -0.5
          && panelBox.bottom <= vh + 0.5,
        // The panel is fixed from the trigger's left, so a zero gap says it is
        // anchored; a clamp can only widen it.
        panelToTriggerGap: Math.abs(panelBox.left - triggerBox.left),
      }
    }

    return {
      width: viewportWidth,
      rowOverflowClosed: overflow,
      rowOverflowOpen: overflow,
      rowLines: countFlexLines(itemRects),
      itemsOutsideColumnClosed: itemsOutsideColumn,
      itemsOutsideColumnOpen: itemsOutsideColumn,
      ...builder,
    }
  }, { viewportWidth: width, open: editorOpen })
}

/**
 * Render the golden body: one line per stop, relations and counts only. The
 * row-overflow and outside-column readings are deltas (open minus closed) so
 * the golden records that opening the editor leaves the row untouched, not an
 * absolute count that many unrelated controls could move.
 * @param stops - the measured stops, in sweep order.
 * @returns the golden body, without a trailing newline.
 */
function renderGeometry(stops: PopoverMetrics[]): string {
  return [
    '# Assistant actions row with the feedback note popover open',
    '',
    '| viewport | row overflow delta | row lines | items-outside delta '
      + '| panel outside the column | panel within the viewport | panel-to-trigger gap |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...stops.map(stop => `| ${String(stop.width)}px | ${String(stop.rowOverflowOpen - stop.rowOverflowClosed)}px `
      + `| ${String(stop.rowLines)} | ${String(stop.itemsOutsideColumnOpen - stop.itemsOutsideColumnClosed)} `
      + `| ${String(stop.panelOutsideColumn)} | ${String(stop.panelWithinViewport)} `
      + `| ${String(stop.panelToTriggerGap)}px |`),
  ].join('\n')
}

describe('web e2e: the feedback note editor floats above the column', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, await readFile(SEED, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser, 900)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /**
   * Open the seeded transcript. The first treeitem is the collapsible group
   * row; the session itself is the row beneath it.
   * @returns nothing.
   */
  async function openSeededSession(): Promise<void> {
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    if (await groupRow.getAttribute('aria-expanded') !== 'true') await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 15_000 })
    await sessionRow.click()
  }

  /**
   * Resize to a viewport and read the row once its width stops moving. The
   * frame eases its column tracks, so reading straight after a resize can
   * report the previous viewport's relation.
   * @param width - viewport width to settle at.
   * @param editorOpen - whether the note editor is currently open; reads the popover relations when so.
   * @returns the row's (and popover's) readings at that width.
   */
  const settleAt = async (width: number, editorOpen: boolean): Promise<PopoverMetrics> => {
    await page.setViewportSize({ width, height: 900 })
    let previous = -1
    await expect.poll(async () => {
      const current = await page.evaluate(() =>
        document.querySelector('[data-conversation-scroll]')?.clientWidth ?? -1)
      const settled = current === previous
      previous = current
      return settled
    }, { timeout: 10_000 }).toBe(true)
    // The popover is JS-positioned from the trigger rect and re-places on
    // resize/scroll, so once the column width stops moving we nudge it to the
    // final layout; otherwise the panel can sit at a transient position from
    // mid-resize and the anchor reading would be off.
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))
    return measurePopover(page, width, editorOpen)
  }

  /**
   * Rate a message, then for every stop read the row once with the note editor
   * closed and once with it open, handing the SAME measured readings to both
   * assertions so the golden and the assertions describe one measurement
   * rather than two runs that could disagree.
   * @returns the stops in {@link WIDTHS} order.
   */
  let swept: Promise<PopoverMetrics[]> | undefined
  const sweep = (): Promise<PopoverMetrics[]> => {
    swept ??= (async () => {
      await openSeededSession()
      await page.getByText('DONE', { exact: true }).waitFor({ timeout: 30_000 })
      // The controller defers its list read to the first hover or focus, so the
      // strip has to be touched before it can be rated.
      const like = page.getByRole('button', { name: 'Good response' }).first()
      await like.waitFor({ timeout: 30_000 })
      await like.scrollIntoViewIfNeeded()
      await like.hover()
      await like.click()
      await page.getByRole('button', { name: 'Remove rating' }).first()
        .waitFor({ timeout: 15_000 })
      const noteTrigger = page.getByRole('button', { name: 'Add a note' }).first()
      const stops: PopoverMetrics[] = []
      for (const width of WIDTHS) {
        // Reset to the closed baseline at each stop before opening.
        if (await noteTrigger.getAttribute('aria-expanded') === 'true') await noteTrigger.click()
        const closed = await settleAt(width, false)
        await page.getByRole('button', { name: 'Add a note' }).first().click()
        await page.getByRole('dialog').waitFor({ timeout: 10_000 })
        const open = await settleAt(width, true)
        stops.push({
          width,
          rowOverflowClosed: closed.rowOverflowClosed,
          rowOverflowOpen: open.rowOverflowOpen,
          rowLines: open.rowLines,
          itemsOutsideColumnClosed: closed.itemsOutsideColumnClosed,
          itemsOutsideColumnOpen: open.itemsOutsideColumnOpen,
          panelOutsideColumn: open.panelOutsideColumn,
          panelWithinViewport: open.panelWithinViewport,
          panelToTriggerGap: open.panelToTriggerGap,
        })
      }
      return stops
    })()
    return swept
  }

  it('keeps the actions row untouched by the note popover, which stays in the viewport', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-message-feedback-layout'))
    const stops = await sweep()
    for (const stop of stops) {
      // The popover lives outside the row, so opening it must not change the
      // row at all. This is the vacuity guard of the whole redesign: an inline
      // editor would widen or reflow the row, pushing the delta off zero.
      expect(stop.rowOverflowOpen - stop.rowOverflowClosed, `viewport ${String(stop.width)}`).toBe(0)
      expect(stop.itemsOutsideColumnOpen - stop.itemsOutsideColumnClosed, `viewport ${String(stop.width)}`).toBe(0)
      // The row is one 28px line; the editor never forces a reflow.
      expect(stop.rowLines, `viewport ${String(stop.width)}`).toBe(1)
      // The panel escapes the column's overflow clip by living outside it.
      expect(stop.panelOutsideColumn, `viewport ${String(stop.width)}`).toBe(true)
      // The placement clamps the panel inside the viewport at every width.
      expect(stop.panelWithinViewport, `viewport ${String(stop.width)}`).toBe(true)
      // The panel stays anchored to its trigger rather than drifting off.
      expect(stop.panelToTriggerGap, `viewport ${String(stop.width)}`).toBeLessThanOrEqual(4)
    }
    expect(tripwire.pageErrors).toEqual([])
  }, 180_000)

  it('matches the committed geometry golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-message-feedback-layout-golden'))
    await compareOrRefreshGolden(GEOMETRY_EXPECTED, renderGeometry(await sweep()), MODE)
  }, 180_000)

  it('kept the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
