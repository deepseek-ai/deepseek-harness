// Web e2e scenario: a composer draft longer than the 14-line cap scrolls,
// reveals the caret, and holds no second scroll offset.
//
// The composer is ONE contenteditable surface (see
// packages/client/ui-conversation/src/client/skeleton/InputBar.module.css):
// the Lexical editor's root carries the glyphs, the selection and the caret
// together, grows with its content, and `[data-input-scroll]` — the
// composer's single scrolling box — caps it at 14 lines. With one surface
// there is no second text layer whose offset could drift from the caret's;
// what remains to pin is the cap, the wheel gesture, and the caret reveals
// (typing at a scrolled end, pasting a long block, a trailing-newline end).
//
// Only a real engine can show any of this. Scrolling is layout: jsdom reports
// `scrollHeight === clientHeight` for every element and never scrolls one, so
// the unit spec in packages/client/ui-conversation/tests/input-bar.client.spec.tsx can
// only assert that the scrollport holds the surface.
//
// Zero model calls: a fresh workspace's blank session already carries a live
// composer, and the scenario only types into it. A stray stream would fail loud
// with NO_ADAPTER. The Home and End case types into a seeded long chat instead,
// whose conversation scrollport can move.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/composer-draft-scroll', import.meta.url))
/**
 * Committed golden of the composer's scroll geometry. The change alters no
 * accessible name, so the aria goldens the other scenarios commit are
 * byte-identical with and without it; this records the relations instead,
 * which makes a shift in the cap or in the reveal behavior a reviewable diff
 * rather than an assertion someone has to reconstruct.
 */
const GEOMETRY_EXPECTED = join(SNAPSHOT_DIR, 'geometry.expected.md')
const MODE = webSnapshotMode()

/** Marks the first and last line so the measurement can find their line boxes. */
const FIRST_MARKER = 'FIRST-LINE-MARKER'
const LAST_MARKER = 'LAST-LINE-MARKER'
/** Comfortably past the 14-line cap, so the draft overflows however the lines wrap. */
const DRAFT_LINES = 40
const DRAFT_ROWS = Array.from({ length: DRAFT_LINES }, (_unused, index) => {
  if (index === 0) return FIRST_MARKER
  if (index === DRAFT_LINES - 1) return LAST_MARKER
  return `draft line ${String(index + 1).padStart(2, '0')}`
})
/** A seeded chat long enough that its conversation scrollport scrolls. */
const HISTORY = createChatScrollFixture({ markerPrefix: 'COMPOSER_HOME_END', title: 'Composer Home and End', turns: 8 })
/** Two lines separated by a line break, far shorter than the wrap width on every platform. */
const LINE_ROWS = ['first line of the draft', 'second line of the draft'] as const

/** The live composer surface. */
function surface(page: Page): ReturnType<Page['locator']> {
  return page.locator('[data-composer-input][contenteditable="true"]').first()
}

/**
 * Read the draft as plain text.
 * @param page - the page under test.
 * @returns the draft with each paragraph boundary and line break as `\n`.
 */
function draftText(page: Page): Promise<string> {
  return surface(page).evaluate(element => Array.from(element.children, block =>
    Array.from(block.childNodes, node => node.nodeName === 'BR' ? '\n' : node.textContent ?? '').join('')).join('\n'))
}

/**
 * Measure the conversation scrollport that holds the composer.
 * @param page - the page under test.
 * @returns its scroll offset and whether its content overflows it.
 */
function conversationScroll(page: Page): Promise<{ top: number; scrollable: boolean }> {
  return surface(page).evaluate((element) => {
    const scroller = element.closest<HTMLElement>('[data-conversation-scroll]')
    if (scroller === null) throw new Error('the composer surface is not inside a conversation scrollport')
    return { top: scroller.scrollTop, scrollable: scroller.scrollHeight > scroller.clientHeight }
  })
}

/**
 * Replace the draft through real gestures: select-all, delete, then insert
 * the rows with soft line breaks (the composer's Enter submits).
 * @param page - the page under test.
 * @param rows - draft lines; a trailing empty row leaves a trailing newline.
 */
async function typeDraft(page: Page, rows: readonly string[]): Promise<void> {
  const input = surface(page)
  await input.click()
  await page.keyboard.press('ControlOrMeta+KeyA')
  await page.keyboard.press('Delete')
  for (const [index, row] of rows.entries()) {
    if (index > 0) await page.keyboard.press('Shift+Enter')
    if (row !== '') await page.keyboard.insertText(row)
  }
}

/** The composer's scroll surface as the browser lays it out. */
interface ComposerMetrics {
  /** True when the draft is taller than the capped box — the situation under test. */
  overflows: boolean
  /** Visible height of the scrollport's content box: the cap in pixels. */
  clientHeight: number
  /** Whole lines that fit in the visible box, at the composer's own line-height. */
  visibleLines: number
  /** The composer's one scroll offset. */
  scrollTop: number
  /** Furthest that offset can go. */
  scrollMax: number
  /**
   * Scrollable overflow the editable surface holds on its own — 0, or a
   * second offset exists beside the scrollport's.
   */
  surfaceScrollable: number
  /** Top of the LAST draft line relative to the visible box's top: at most `clientHeight` when on screen. */
  lastLineOffset: number
  /** Top of the FIRST draft line relative to the visible box's top: negative once it has scrolled out. */
  firstLineOffset: number
}

/**
 * Measure the composer surface in the page.
 * @param page - the page under test.
 * @returns the offset, the cap, and where the draft's first and last lines sit.
 */
function measureComposer(page: Page): Promise<ComposerMetrics> {
  return page.evaluate(({ first, last }) => {
    const input = document.querySelector<HTMLElement>('[data-composer-input][contenteditable="true"]')
    if (input === null) throw new Error('no live composer surface in the DOM')
    const scroll = input.closest<HTMLElement>('[data-input-scroll]')
    if (scroll === null) throw new Error('the composer surface is not inside a draft scrollport')
    const lineHeight = Number.parseFloat(getComputedStyle(input).lineHeight)
    /** Where the surface paints the line holding `marker`, in viewport coordinates. */
    const glyphTop = (marker: string): number => {
      const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node as Text
        const at = text.data.indexOf(marker)
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(text, at)
        range.setEnd(text, at + marker.length)
        return range.getBoundingClientRect().top
      }
      throw new Error(`marker ${marker} missing from the composer text`)
    }
    const box = scroll.getBoundingClientRect()
    return {
      overflows: scroll.scrollHeight > scroll.clientHeight,
      clientHeight: scroll.clientHeight,
      visibleLines: Math.floor(scroll.clientHeight / lineHeight),
      scrollTop: scroll.scrollTop,
      scrollMax: scroll.scrollHeight - scroll.clientHeight,
      surfaceScrollable: input.scrollHeight - input.clientHeight,
      lastLineOffset: glyphTop(last) - box.top,
      firstLineOffset: glyphTop(first) - box.top,
    }
  }, { first: FIRST_MARKER, last: LAST_MARKER })
}

/**
 * Render the golden body.
 *
 * Absolute glyph coordinates are deliberately absent: they depend on font
 * metrics and would make the fixture fail on a machine that measures text
 * differently — a golden that needs re-recording per platform documents the
 * platform, not the behavior. What is recorded is the cap, the single-offset
 * invariant, and which lines are on screen, each a comparison that survives
 * any layout keeping the behavior.
 * @param top - metrics with the draft scrolled to its start.
 * @param bottom - metrics with the draft scrolled to its end.
 * @param trailingNewline - metrics with the trailing-newline draft scrolled to its end.
 * @param pasted - metrics right after a long block was pasted at the draft's end.
 * @returns the golden body, without a trailing newline.
 */
function renderGeometry(
  top: ComposerMetrics, bottom: ComposerMetrics, trailingNewline: ComposerMetrics, pasted: ComposerMetrics,
): string {
  return [
    '# Composer draft scrolling (14-line cap, one editable surface, one scrollport)',
    '',
    '## At the start of the draft',
    '',
    `- draft overflows the capped box: ${String(top.overflows)}`,
    `- visible lines: ${String(top.visibleLines)}`,
    `- the surface holds no scroll offset of its own: ${String(top.surfaceScrollable === 0)}`,
    `- scroll offset: ${String(top.scrollTop)}px`,
    `- first draft line is on screen: ${String(top.firstLineOffset >= 0 && top.firstLineOffset < top.clientHeight)}`,
    `- last draft line is on screen: ${String(top.lastLineOffset >= 0 && top.lastLineOffset < top.clientHeight)}`,
    '',
    '## Scrolled to the end of the draft',
    '',
    `- offset moved: ${String(bottom.scrollTop > 0)}`,
    `- the surface holds no scroll offset of its own: ${String(bottom.surfaceScrollable === 0)}`,
    `- first draft line has scrolled out above: ${String(bottom.firstLineOffset < 0)}`,
    `- last draft line is on screen: ${String(bottom.lastLineOffset >= 0 && bottom.lastLineOffset < bottom.clientHeight)}`,
    '',
    '## Draft ending in a newline, scrolled to the end',
    '',
    `- the draft's own last line is on screen: ${String(
      trailingNewline.lastLineOffset >= 0 && trailingNewline.lastLineOffset < trailingNewline.clientHeight,
    )}`,
    '',
    '## Right after pasting a long block at the end',
    '',
    `- the composer scrolled to the caret it left: ${String(pasted.scrollTop > 0)}`,
    `- the pasted block's last line is on screen: ${String(
      pasted.lastLineOffset >= 0 && pasted.lastLineOffset < pasted.clientHeight,
    )}`,
  ].join('\n').trimEnd()
}

describe('web e2e: composer draft scrolling', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, HISTORY.log, 'composer-draft-scroll-home-end')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'composer-draft-scroll')
    await typeDraft(page, DRAFT_ROWS)
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('caps the draft box at 14 lines with a single scroll offset', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-draft-scroll-top'))
    // Vacuity guard: without an overflowing draft there is nothing to scroll and
    // every assertion below holds trivially.
    await expect.poll(async () => (await measureComposer(page)).overflows, { timeout: 10_000 }).toBe(true)
    // Typing the draft left the caret — and the box — at its end, so reach the
    // start by the same gesture a user would, and leave it there for the wheel
    // case below.
    await surface(page).hover()
    await page.mouse.wheel(0, -2000)
    await expect.poll(async () => (await measureComposer(page)).scrollTop, { timeout: 10_000 }).toBe(0)
    const metrics = await measureComposer(page)
    // The cap is the composer seat's `--dsh-composer-text-max-height` (336px =
    // 14 x 24px lines). The count, not the pixels: it is the figma constant and
    // survives a device-pixel-ratio change.
    expect(metrics.visibleLines).toBe(14)
    // One scrolling box: the surface grows with the draft, so it holds no
    // second offset beside the scrollport's.
    expect(metrics.surfaceScrollable).toBe(0)
    expect(metrics.scrollTop).toBe(0)
    expect(metrics.firstLineOffset).toBeGreaterThanOrEqual(0)
    expect(metrics.firstLineOffset).toBeLessThan(metrics.clientHeight)
    expect(metrics.lastLineOffset).toBeGreaterThan(metrics.clientHeight)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('a wheel gesture over a long draft moves the draft', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-draft-scroll-wheel'))
    await surface(page).hover()
    await page.mouse.wheel(0, 240)
    await expect.poll(async () => (await measureComposer(page)).scrollTop, { timeout: 10_000 })
      .toBeGreaterThan(0)
    const scrolled = await measureComposer(page)
    expect(scrolled.firstLineOffset).toBeLessThan(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('typing at the end of a scrolled draft brings the caret back into view', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-draft-scroll-typing'))
    const input = surface(page)
    // Put the caret at the very end, scroll the view away from it, then type:
    // the editor's own caret reveal must bring the end back on screen.
    // Select-all + ArrowRight lands the caret at the document end on every
    // platform (Cmd/Ctrl+End is not a caret move in mac contenteditable).
    await input.click()
    await page.keyboard.press('ControlOrMeta+KeyA')
    await page.keyboard.press('ArrowRight')
    await input.hover()
    await page.mouse.wheel(0, -2000)
    await expect.poll(async () => (await measureComposer(page)).scrollTop, { timeout: 10_000 }).toBe(0)
    await page.keyboard.insertText(' typed-at-end')
    await expect.poll(async () => {
      const m = await measureComposer(page)
      return m.lastLineOffset >= 0 && m.lastLineOffset < m.clientHeight
    }, { timeout: 10_000 }).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('a draft ending in a newline scrolls to its true end, not a line above it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-draft-scroll-trailing-newline'))
    // A trailing soft break reserves a final empty line box; the end of the
    // draft is below the last glyph line, and scrolling to the end must show it.
    await typeDraft(page, [...DRAFT_ROWS, ''])
    await expect.poll(async () => (await measureComposer(page)).overflows, { timeout: 10_000 }).toBe(true)
    await surface(page).hover()
    await page.mouse.wheel(0, 4000)
    await expect.poll(async () => {
      const m = await measureComposer(page)
      return m.scrollTop === m.scrollMax
    }, { timeout: 10_000 }).toBe(true)
    const bottom = await measureComposer(page)
    // At the very bottom the draft's own last line — the one before the empty
    // final line — is on screen.
    expect(bottom.lastLineOffset).toBeGreaterThanOrEqual(0)
    expect(bottom.lastLineOffset).toBeLessThan(bottom.clientHeight)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('matches the committed composer scroll geometry golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-draft-scroll-golden'))
    // Restore the pristine draft (the edit cases appended to it) and return to
    // its start, both through ordinary gestures.
    await typeDraft(page, DRAFT_ROWS)
    await surface(page).hover()
    await page.mouse.wheel(0, -2000)
    await expect.poll(async () => (await measureComposer(page)).scrollTop, { timeout: 10_000 }).toBe(0)
    const top = await measureComposer(page)
    await surface(page).hover()
    await page.mouse.wheel(0, 2000)
    await expect.poll(async () => (await measureComposer(page)).scrollTop, { timeout: 10_000 })
      .toBeGreaterThan(0)
    const bottom = await measureComposer(page)
    await typeDraft(page, [...DRAFT_ROWS, ''])
    await surface(page).hover()
    await page.mouse.wheel(0, 4000)
    await expect.poll(async () => {
      const m = await measureComposer(page)
      return m.scrollTop === m.scrollMax
    }, { timeout: 10_000 }).toBe(true)
    const trailingNewline = await measureComposer(page)
    // The paste path, measured the way a user meets it: a short draft, the
    // caret at its end, one long block pasted in.
    await typeDraft(page, ['one short line'])
    await surface(page).evaluate((el, text) => {
      const data = new DataTransfer()
      data.setData('text/plain', text)
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, `\n${DRAFT_ROWS.join('\n')}`)
    await expect.poll(async () => (await measureComposer(page)).overflows, { timeout: 10_000 }).toBe(true)
    await expect.poll(async () => (await measureComposer(page)).scrollTop, { timeout: 10_000 }).toBeGreaterThan(0)
    const pasted = await measureComposer(page)
    await compareOrRefreshGolden(GEOMETRY_EXPECTED, renderGeometry(top, bottom, trailingNewline, pasted), MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('Home and End move the caret to its line ends without scrolling a long conversation', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-draft-scroll-home-end'))
    // macOS key bindings map Home and End to scrolling the document, which in
    // the composer scrolled the conversation instead of moving the caret.
    // Other platforms move the caret natively, so the case holds everywhere.
    await page.getByRole('button', { name: 'Search sessions' }).click()
    await page.getByRole('textbox', { name: 'Search session names', exact: true }).fill(HISTORY.markers.user(1))
    const result = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
    await expect.poll(() => result.count(), { timeout: 60_000 }).toBe(1)
    await result.click()
    await page.getByText(HISTORY.markers.assistant(HISTORY.turns), { exact: false }).last().waitFor()
    // A line break rather than wrapping keeps both line ends independent of font metrics.
    await typeDraft(page, LINE_ROWS)
    const [first, second] = LINE_ROWS
    for (let index = 0; index < Math.floor(second.length / 2); index++) await page.keyboard.press('ArrowLeft')
    // Measure only once the opened chat holds one offset across two reads.
    let previous: number | undefined
    await expect.poll(async () => {
      const { top } = await conversationScroll(page)
      const still = top === previous
      previous = top
      return still
    }, { interval: 250, timeout: 10_000 }).toBe(true)
    const before = await conversationScroll(page)
    // Vacuity guard: the conversation must be able to scroll toward its top.
    expect(before.scrollable).toBe(true)
    expect(before.top).toBeGreaterThan(0)
    await page.keyboard.press('Home')
    await page.keyboard.insertText('[')
    await expect.poll(() => draftText(page)).toBe(`${first}\n[${second}`)
    expect((await conversationScroll(page)).top).toBe(before.top)
    await page.keyboard.press('End')
    await page.keyboard.insertText(']')
    await expect.poll(() => draftText(page)).toBe(`${first}\n[${second}]`)
    expect((await conversationScroll(page)).top).toBe(before.top)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('commits exactly the fixtures it reads', async () => {
    // Zero model calls, so the scenario records no session fixture: the geometry
    // golden is the whole inventory.
    await assertFixtureInventory(SNAPSHOT_DIR, ['geometry.expected.md'])
  })

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', () => {
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })
})
