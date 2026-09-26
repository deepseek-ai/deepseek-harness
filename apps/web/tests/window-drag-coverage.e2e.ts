// Browser coverage for the macOS window drag surface: which chrome rows drag,
// which pixels stay content, and that no control is swallowed by the band.
//
// The lane boots the real composition in Chromium and marks the document root
// darwin — the one platform where these rules exist (ui-web base.css and
// ui-layout AppFrame scope every app-region rule to it). CDP-injected clicks
// cannot decide this class: the swallow happens in Electron's native window, so
// the claims here are geometry claims decided by the shared composition model
// (ui-web window-drag/regions.ts).
//
// Probes are anchored to stable data hooks and derived from live rects, so a
// layout change moves them rather than invalidating them. The ui-theme app-region
// gate holds the other half of the claim: it pins each row's mark, its sheet, and
// its authored height, and refuses a `data-window-drag` mark anywhere else. A
// probe whose expectation is not yet met carries `gap` and fails loudly, so a
// recorded gap shrinks here first and the manifest follows.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { initialShortcutConfig } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import {
  INTERACTIVE_SELECTOR, RECALL_MARK, isDraggableAt, type RegionRect,
} from '@deepseek-ai/dsh-client-web/src/window-drag/regions.ts'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

/** One collected box: its app-region value, whether it is interactive, and where it is. */
interface CollectedRegion extends RegionRect {
  /** Whether the element itself matches the interactive selector. */
  readonly interactive: boolean
  /** Sample points at which the browser's hit test reaches this element or its content. */
  readonly hits: readonly (readonly [number, number])[]
}

/** A point the coverage table claims something about. */
interface CoverageProbe {
  /** Row the probe speaks for, for the failure message. */
  readonly row: string
  /** What the point is, for the failure message. */
  readonly what: string
  /** Resolves the point from the live rects captured for the state under test. */
  readonly at: () => readonly [number, number]
  /** Whether the window would drag there. */
  readonly drag: boolean
  /** Set when the expectation is a recorded gap the refactor must close. */
  readonly gap?: string
}

/** A viewport rect. */
interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const EMPTY: Rect = { x: 0, y: 0, width: 0, height: 0 }

/** A browser-half bundle whose row registers configuration into the plugin page. */
const FIXTURE_PLUGINS = fileURLToPath(new URL('./fixtures/plugins', import.meta.url))

/** Read one hook's viewport rect, or a zero rect while it is not rendered. */
async function rectOf(page: Page, selector: string): Promise<Rect> {
  const locator = page.locator(selector).first()
  if (await locator.count() === 0) return EMPTY
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
}

/**
 * Collect every visible app-region box in DOM order.
 * @param page - the page under test.
 * @returns the boxes, in document order, with the interactive flag of each element.
 */
async function collectedRegions(page: Page, selector: string): Promise<CollectedRegion[]> {
  return page.evaluate((interactiveSelector) => {
    const collected: {
      x: number
      y: number
      width: number
      height: number
      draggable: boolean
      interactive: boolean
      hits: [number, number][]
    }[] = []
    for (const element of Array.from(document.querySelectorAll('*'))) {
      const style = getComputedStyle(element)
      const region = style.getPropertyValue('-webkit-app-region')
      if (region !== 'drag' && region !== 'no-drag') continue
      if (style.visibility === 'hidden' || style.display === 'none') continue
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      const interactive = element.matches(interactiveSelector)
      const insetX = Math.min(2, rect.width / 4)
      const insetY = Math.min(2, rect.height / 4)
      const samples: [number, number][] = [
        [rect.x + rect.width / 2, rect.y + rect.height / 2],
        [rect.x + insetX, rect.y + insetY],
        [rect.x + rect.width - insetX, rect.y + insetY],
        [rect.x + insetX, rect.y + rect.height - insetY],
        [rect.x + rect.width - insetX, rect.y + rect.height - insetY],
      ]
      const hits = interactive
        ? samples.filter(([x, y]) => {
          const top = document.elementFromPoint(x, y)
          // A pane's programmatic focus target also contains its window-drag strip.
          // The strip owns those pixels; controls inside it still need their own subtraction.
          const strip = top?.closest('[data-dockkit-strip][data-window-drag]')
          if (element.matches('[data-dockkit-pane][tabindex="-1"]')
            && strip != null && element.contains(strip)) return false
          return top !== null && (top === element || element.contains(top))
        })
        : []
      collected.push({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        draggable: region === 'drag',
        interactive,
        hits,
      })
    }
    return collected
  }, selector)
}

/**
 * Interactive boxes whose press cannot reach the page, as printable descriptions.
 * A sample counts only where the browser's own hit test reaches the control: a
 * box clipped away by its column (the collapsed sidebar's hidden controls sit at
 * negative x) is not hittable anywhere it overlaps a drag row, and a press there
 * belongs to whatever is painted.
 * @param regions - collected boxes in DOM order.
 * @returns one description per interactive box with a hittable sample inside the drag surface.
 */
function swallowedBoxes(regions: readonly CollectedRegion[]): string[] {
  return regions
    .filter(region => region.interactive)
    .filter(region => region.hits.some(([x, y]) => isDraggableAt(regions, x, y)))
    .map(region => `${Math.round(region.x)},${Math.round(region.y)} ${Math.round(region.width)}x${Math.round(region.height)}`)
}

/**
 * Settle when the shell first pulses the drag recall mark, or false when 15s pass
 * without one. Start it before the gesture under test and await it after.
 * @param page - the page under test.
 * @returns the pending observation of the first pulse.
 */
function firstRecallPulse(page: Page): Promise<boolean> {
  return page.evaluate((mark: string) => new Promise<boolean>((resolve) => {
    const observer = new MutationObserver((records) => {
      const pulsed = records.some(record => record.attributeName === mark
        && (record.target as Element).hasAttribute(mark))
      if (!pulsed) return
      observer.disconnect()
      resolve(true)
    })
    observer.observe(document.body, { attributes: true, attributeFilter: [mark] })
    setTimeout(() => {
      observer.disconnect()
      resolve(false)
    }, 15_000)
  }), RECALL_MARK)
}

/**
 * Wait until nothing under the page is animating, so a probe measures the settled
 * layout instead of a frame of a column slide.
 * @param page - the page under test.
 */
async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.getAnimations()
    .every(animation => animation.playState === 'finished' || animation.playState === 'idle')),
  { timeout: 20_000 }).toBe(true)
}

describe('web e2e: macOS window drag coverage', () => {
  let scaffold: WebScaffold
  let browser: Browser

  beforeAll(async () => {
    // A manageable profile: the plugin page draws its card list — and so its
    // detail views — only when the deployment runs a profile it can manage.
    scaffold = await launchWebScaffold({
      profile: { packages: [{ dir: join(FIXTURE_PLUGINS, 'fixture-live-client') }] },
    })
    browser = await chromium.launch()
  }, 180_000)

  afterAll(async () => {
    try { await browser?.close() }
    finally { await scaffold?.close() }
  })

  /**
   * Open a darwin-marked page in the shipped composition.
   * @returns the page and its console tripwire.
   */
  async function darwinPage(): Promise<{ page: Page; tripwire: ReturnType<typeof watchConsole> }> {
    const page = await newEnglishPage(browser)
    await page.addInitScript(({ value, snapshot }) => {
      // The Desktop platform marker requires the preload's keyboard and preference capabilities.
      Object.assign(window, { dshDesktop: { protocolVersion: 1,
        keyboard: { subscribe: () => () => {}, closeWindow: async () => {} },
        shortcuts: { get: async () => ({ ...snapshot, status: 'ready' }),
          subscribe: () => () => {}, recording: async () => {},
          edit: async () => ({ status: 'not-ready', snapshot }) },
      } })
      const mark = (): void => { document.documentElement.setAttribute('data-platform', value) }
      if (document.documentElement === null) document.addEventListener('DOMContentLoaded', mark, { once: true })
      else mark()
    }, { value: 'darwin', snapshot: initialShortcutConfig() })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    return { page, tripwire }
  }

  it('leaves no interactive box inside the drag surface, and keeps the panel strip row draggable', async () => {
    const { page, tripwire } = await darwinPage()
    try {
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      const agent = scaffold.ctx.agents.list()[0]
      if (agent === undefined) throw new Error('connected workspace did not create an Agent')
      agent.session.append('turn/start', { turn: 1 })
      const pulsing = firstRecallPulse(page)
      await page.locator('[data-sidebar-right-expand]').click()
      await page.locator('[data-sidebar-right-panel][data-sidebar-right-open]').waitFor({ timeout: 15_000 })
      // The panel slides in from the frame's right edge; probing before the slide
      // settles measures the hidden position, where the band does not reach.
      await expect.poll(async () => page.locator('[data-sidebar-right-panel]').evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return Math.round(innerWidth - rect.right) === 0
          && element.getAnimations({ subtree: true })
            .every(animation => animation.playState === 'finished' || animation.playState === 'idle')
      }), { timeout: 15_000 }).toBe(true)

      // The shell's watcher, not the panel, is what keeps the native drag rects in
      // step with the slide: it must have pulsed while the panel moved and must be
      // settled now — a mark left set would subtract the whole surface.
      expect(await pulsing, 'the shell pulses the drag recall mark while the panel slides').toBe(true)
      // The watcher clears the mark on the frame after the geometry settles.
      await expect.poll(
        () => page.evaluate((mark: string) => document.body.hasAttribute(mark), RECALL_MARK),
        { timeout: 5_000 },
      ).toBe(false)

      const regions = await collectedRegions(page, INTERACTIVE_SELECTOR)
      const strip = await rectOf(page, '[data-dockkit-strip]')
      const panel = await rectOf(page, '[data-sidebar-right-panel]')
      const tabs = await rectOf(page, '[data-conversation-tabs]')
      const header = await rectOf(page, '[data-slot="conversation.header"] > header')
      const seat = await rectOf(page, '[data-shell-leading]')
      // The sidebar column drags through its own rows (ui-sidebar), so its
      // coverage is the rows' geometry rather than a frame band's height.
      const toggle = await rectOf(page, 'button[aria-label="Collapse sidebar"]')

      const probes: CoverageProbe[] = [
        {
          row: 'right sidebar panel strip',
          what: 'the strip row top inset, above the controls',
          at: () => [strip.x + strip.width / 2, strip.y + 4],
          drag: true,
        },
        {
          row: 'right sidebar panel strip',
          what: 'the run below the strip row, over the pane body',
          at: () => [panel.x + panel.width / 2, strip.y + strip.height + 4],
          drag: false,
        },
        {
          row: 'conversation header',
          what: 'the blank run right of the view tabs, on the tab strip row',
          at: () => [tabs.x + tabs.width + 8, tabs.y + tabs.height / 2],
          drag: true,
        },
        {
          row: 'conversation header',
          what: 'the title row blank run',
          at: () => [header.x + header.width / 2, header.y + 4],
          drag: true,
        },
        {
          row: 'conversation header',
          what: 'the transcript run below the header block',
          at: () => [header.x + header.width / 2, header.y + header.height + 4],
          drag: false,
        },
      ]
      if (toggle.width > 0) {
        probes.push(
          {
            row: 'sidebar top strip',
            what: 'the blank run left of the collapse toggle',
            at: () => [toggle.x - 40, toggle.y + toggle.height / 2],
            drag: true,
          },
          {
            row: 'sidebar column',
            what: 'the content run below the chrome rows',
            at: () => [toggle.x - 40, toggle.y + toggle.height + 70],
            drag: false,
          },
        )
      }
      if (seat.width > 0) {
        probes.push({
          row: 'shell.leading seat',
          what: 'the row of window-chrome controls',
          at: () => [seat.x + 4, seat.y + seat.height / 2],
          drag: false,
        })
      }

      for (const probe of probes) {
        const [x, y] = probe.at()
        const expected = `${probe.row}: ${probe.what} at ${Math.round(x)},${Math.round(y)}`
          + (probe.gap === undefined ? '' : ` (recorded gap — ${probe.gap})`)
        expect(isDraggableAt(regions, x, y), expected).toBe(probe.drag)
      }

      // The invariant that has no gap budget: a press inside any control box must
      // reach the page instead of dragging the window.
      expect(swallowedBoxes(regions), 'interactive boxes inside the drag surface').toEqual([])

      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, 'window-drag-coverage')
      throw error
    } finally {
      await page.close()
    }
  }, 180_000)

  it('keeps the Conversation header draggable over the collapsed column, and the seat out of it', async () => {
    const { page, tripwire } = await darwinPage()
    try {
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
      await page.locator('[data-shell-leading]').waitFor({ state: 'visible', timeout: 15_000 })
      await settled(page)
      const regions = await collectedRegions(page, INTERACTIVE_SELECTOR)
      const header = await rectOf(page, '[data-slot="conversation.header"] > header')
      const seat = await rectOf(page, '[data-shell-leading]')

      // With the column hidden the centre starts at the frame's left edge, where
      // the Conversation header owns the run.
      expect(
        isDraggableAt(regions, header.x + 40, header.y + 4),
        'the Conversation header over the frame’s left edge',
      ).toBe(true)
      expect(
        isDraggableAt(regions, seat.x + seat.width / 2, seat.y + seat.height / 2),
        'the seat holding the reopen controls',
      ).toBe(false)

      expect(swallowedBoxes(regions), 'interactive boxes inside the drag surface').toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, 'window-drag-coverage-collapsed')
      throw error
    } finally {
      await page.close()
    }
  }, 120_000)

  it('keeps an entry page’s chrome row draggable', async () => {
    const { page, tripwire } = await darwinPage()
    try {
      await page.getByRole('button', { name: 'Plugins', exact: true }).click()
      const head = page.locator('[class*="pageHead"]').first()
      await head.waitFor({ timeout: 15_000 })
      await settled(page)
      const rect = await head.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height }
      })

      const regions = await collectedRegions(page, INTERACTIVE_SELECTOR)
      // The row starts at the window's top edge: a page inset above it would be a strip
      // no drag region covers, which is the dead band at the very top of this page.
      expect(rect.y, 'the page head starts at the window’s top edge').toBeLessThanOrEqual(0.5)
      // The page head owns its run, clearance included: that is the entry page's
      // window strip, with no frame band behind it.
      expect(
        isDraggableAt(regions, rect.x + 40, rect.y + 8),
        'the plugin manager page head',
      ).toBe(true)
      expect(
        isDraggableAt(regions, rect.x + 40, rect.y + rect.height + 40),
        'the page body below the head',
      ).toBe(false)

      expect(swallowedBoxes(regions), 'interactive boxes inside the drag surface').toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, 'window-drag-coverage-entry-page')
      throw error
    } finally {
      await page.close()
    }
  }, 120_000)

  it('keeps a detail page’s head row draggable and its body out of the drag surface', async () => {
    const { page, tripwire } = await darwinPage()
    try {
      await page.getByRole('button', { name: 'Plugins', exact: true }).click()
      const cards = page.locator('[data-plugin-package], [data-plugin-item]')
      await cards.first().waitFor({ timeout: 30_000 })
      await settled(page)
      // The card's head carries the one control that opens its page.
      await cards.first().locator('button').first().click()
      // The mark sits on the head row the detail views share, not on the detail
      // container: marking the container would drag the window over its text and
      // form labels wherever no control covers them.
      const detail = page.locator('[data-plugin-item-detail], [data-plugin-detail], [data-plugin-row-detail]').first()
      await detail.waitFor({ timeout: 15_000 })
      const geometry = await detail.evaluate((element) => {
        const detailBox = element.getBoundingClientRect()
        const headBox = element.firstElementChild?.getBoundingClientRect()
        return {
          detail: { x: detailBox.x, y: detailBox.y, width: detailBox.width, height: detailBox.height },
          head: headBox === undefined
            ? null
            : { x: headBox.x, y: headBox.y, width: headBox.width, height: headBox.height },
          viewport: { width: innerWidth, height: innerHeight },
        }
      })
      if (geometry.head === null) throw new Error('the detail view rendered no head row')
      const { detail: detailRect, head: headRect, viewport } = geometry
      const regions = await collectedRegions(page, INTERACTIVE_SELECTOR)

      // The head's top inset is the window clearance above the crumb: blank, so
      // it drags like the entry page's head. The row also starts at the window's top
      // edge, or the strip above it belongs to no drag region.
      expect(headRect.y, 'the detail head row starts at the window’s top edge').toBeLessThanOrEqual(0.5)
      expect(
        isDraggableAt(regions, headRect.x + headRect.width / 2, headRect.y + 4),
        'the detail head row’s top inset',
      ).toBe(true)

      // Below the head, a point that no control covers is content: pressing the
      // description, a label, or a gap in the form must reach the page.
      const interactive = regions.filter(region => region.interactive)
      const bodyTop = headRect.y + headRect.height
      const bodyBottom = Math.min(detailRect.y + detailRect.height, viewport.height - 4)
      const dragging: string[] = []
      for (let row = 0; row < 8; row += 1) {
        for (let column = 0; column < 5; column += 1) {
          const x = detailRect.x + (detailRect.width * (column + 0.5)) / 5
          const y = bodyTop + ((bodyBottom - bodyTop) * (row + 0.5)) / 8
          if (y <= bodyTop || y > viewport.height - 4 || x > viewport.width - 4) continue
          if (interactive.some(region => x >= region.x && x < region.x + region.width
            && y >= region.y && y < region.y + region.height)) continue
          if (isDraggableAt(regions, x, y)) dragging.push(`${Math.round(x)},${Math.round(y)}`)
        }
      }
      expect(dragging, 'content points inside the detail body that drag the window').toEqual([])

      expect(swallowedBoxes(regions), 'interactive boxes inside the drag surface').toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, 'window-drag-coverage-detail-page')
      throw error
    } finally {
      await page.close()
    }
  }, 120_000)

  it('keeps a covering overlay out of the drag surface', async () => {
    const { page, tripwire } = await darwinPage()
    try {
      await page.getByRole('button', { name: 'Account menu', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
      const dialog = page.locator('[role="dialog"]').first()
      await dialog.waitFor({ timeout: 15_000 })
      await settled(page)
      const layer = await dialog.evaluate((element) => {
        const overlay = element.parentElement
        const rect = overlay?.getBoundingClientRect()
        return {
          parentIsBody: overlay?.parentElement === document.body,
          coversWindow: rect !== undefined && rect.top <= 0 && rect.bottom >= innerHeight,
        }
      })
      // A covering surface inside #root precedes the columns' chrome, so a drag
      // row declared later would override its subtraction; beside the root,
      // ui-web base.css's body rule subtracts it instead.
      expect(layer.parentIsBody, 'the covering overlay portals beside #root').toBe(true)
      expect(layer.coversWindow).toBe(true)

      const regions = await collectedRegions(page, INTERACTIVE_SELECTOR)
      const header = await rectOf(page, '[data-slot="conversation.header"] > header')
      expect(
        isDraggableAt(regions, header.x + header.width / 2, 8),
        'the window top behind an open covering overlay',
      ).toBe(false)
      expect(swallowedBoxes(regions), 'interactive boxes inside the drag surface').toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, 'window-drag-coverage-overlay')
      throw error
    } finally {
      await page.close()
    }
  }, 120_000)
})
