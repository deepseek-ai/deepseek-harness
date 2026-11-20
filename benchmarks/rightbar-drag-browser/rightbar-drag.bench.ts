/** Required browser budgets for restyles and script-nested layout while dragging the right Sidebar beside a long history. */
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from '../../apps/web/tests/scaffold.ts'
import { newEnglishPage } from '../../apps/web/tests/support.ts'
import { HISTORY_TURNS, SESSION_ID, syntheticHistory } from './synthetic-history.ts'

const SAMPLES = 2
/** Below the content width's 680px floor at this width, so the drag changes the column but not the resolved content width. */
const VIEWPORT = { width: 1680, height: 1000 }
const CONTENT_WIDTH_FLOOR_PX = 680
const FIXED_VIEWPORT = { width: 2560, height: 1000 }
const FIXED_COLUMN_PX = 720
const FIXED_PANEL_START_PX = 1152
const FIXED_STEP_PX = 2
const FIXED_RESTYLE_BUDGET = 0.1
/** One fixed-column style pass, independent of the cumulative page-ratio budget. */
const FIXED_PEAK_ELEMENT_BUDGET = 512
const STEPS = 40
const STEP_PX = 8
const STEP_GAP_MS = 8
const TAIL = '[data-chat-flow-key*="turn-tail"]'
/**
 * Elements restyled over one whole drag, as a multiple of the page's elements. A drag that restyles the
 * transcript on every frame reaches about one multiple per frame; one that restyles only what the resize
 * changes stays far below a single multiple.
 */
const RESTYLE_BUDGET = 1
/** The regression put one layout inside script per step; occasional script-nested layouts need not be waste. */
const SCRIPT_NESTED_LAYOUT_BUDGET = STEPS / 2
const SCRIPT_EVENTS = new Set(['FunctionCall', 'EventDispatch', 'FireAnimationFrame', 'TimerFire', 'RunMicrotasks', 'v8.callFunction'])

interface TraceEvent {
  name: string
  ph: string
  pid: number
  tid: number
  ts: number
  dur?: number
  args?: { elementCount?: number }
}

interface TraceSummary {
  styledElements: number
  /** Element count → number of completed UpdateLayoutTree events reporting that count. */
  restylePassesByElementCount: Record<number, number>
  peakStyledElements: number
  /** Duration of the pass with the highest element count; the longer pass wins ties. */
  peakCountPassMs: number
  styleMs: number
  layoutMs: number
  layoutCount: number
  scriptNestedLayoutCount: number
}

interface DragSample extends TraceSummary {
  restyleRatio: number
  frameP95Ms: number
  maxFrameGapMs: number
  columnWidthBefore: number
  columnWidth: number
}

function expectRestylesWithinBudget(ratio: number, budget = RESTYLE_BUDGET): void {
  expect(ratio).toBeLessThanOrEqual(budget)
}

function expectFixedPeakWithinBudget(count: number): void {
  expect(count, 'most elements restyled in one fixed-column UpdateLayoutTree event').toBeLessThanOrEqual(FIXED_PEAK_ELEMENT_BUDGET)
}

function median(values: number[]): number {
  return values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!
}

/** Style recalculation and layout totals from a Chromium timeline trace. */
function summarizeTrace(buffer: Buffer): TraceSummary {
  const parsed = JSON.parse(buffer.toString('utf8')) as { traceEvents: TraceEvent[] } | TraceEvent[]
  const events = (Array.isArray(parsed) ? parsed : parsed.traceEvents).filter(event => event.ph === 'X')
  const styles = events.filter(event => event.name === 'UpdateLayoutTree')
  const layouts = events.filter(event => event.name === 'Layout')
  const scripts = events.filter(event => SCRIPT_EVENTS.has(event.name))
  expect(scripts.length, 'drag trace must contain script events').toBeGreaterThan(0)
  const end = (event: TraceEvent): number => event.ts + (event.dur ?? 0)
  const ms = (list: TraceEvent[]): number => list.reduce((total, event) => total + (event.dur ?? 0), 0) / 1000
  const restylePassesByElementCount: Record<number, number> = {}
  let styledElements = 0
  let peakStyledElements = 0
  let peakCountPassMs = 0
  for (const event of styles) {
    const count = event.args?.elementCount
    if (count === undefined || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('Chromium UpdateLayoutTree is missing a valid elementCount')
    }
    const passMs = (event.dur ?? 0) / 1000
    restylePassesByElementCount[count] = (restylePassesByElementCount[count] ?? 0) + 1
    styledElements += count
    if (count > peakStyledElements || (count === peakStyledElements && passMs > peakCountPassMs)) {
      peakStyledElements = count
      peakCountPassMs = passMs
    }
  }
  return {
    styledElements, restylePassesByElementCount, peakStyledElements, peakCountPassMs,
    styleMs: ms(styles),
    layoutMs: ms(layouts),
    layoutCount: layouts.length,
    scriptNestedLayoutCount: layouts.filter(layout => scripts.some(script =>
      script.pid === layout.pid && script.tid === layout.tid && script.ts <= layout.ts && end(layout) <= end(script),
    )).length,
  }
}

async function loadAll(page: Page): Promise<number> {
  let count = await page.locator(TAIL).count()
  while (count < HISTORY_TURNS) {
    await page.getByRole('button', { name: 'Load earlier', exact: true }).click()
    await page.waitForFunction(
      ({ selector, previous }) => document.querySelectorAll(selector).length > previous,
      { selector: TAIL, previous: count },
    )
    count = await page.locator(TAIL).count()
  }
  return count
}

async function openLoadedSidebar(page: Page, url: string): Promise<number> {
  page.setDefaultTimeout(60_000)
  await page.goto(url, { waitUntil: 'load' })
  await page.getByRole('treeitem').first().click()
  await page.getByRole('treeitem').nth(1).click()
  await page.locator(TAIL).last().waitFor()
  expect(await loadAll(page)).toBe(HISTORY_TURNS)
  await page.getByRole('button', { name: 'Open right sidebar' }).first().click()
  await page.locator('[data-side="rightbar"]').waitFor()
  // The Sidebar opens with a track transition; the drag starts from its settled width.
  await page.waitForFunction(() => document.querySelector('[data-rightbar-collapsed], [data-animating]') === null)
  return page.evaluate(() => document.querySelectorAll('*').length)
}

/** Frame timestamps the page collects during one drag. */
type FrameProbe = Window & { benchmarkFrames?: { frames: number[]; running: boolean } }
type FixedWidthProbe = typeof window & { benchmarkWidths: { column: Set<number>; panel: number } }

async function drag(browser: Browser, page: Page, direction: 1 | -1, elements: number, fixedPanelStart?: number): Promise<DragSample> {
  const box = await page.locator('[data-side="rightbar"]').boundingBox()
  if (box === null) throw new Error('right Sidebar resize handle missing')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const readColumnWidth = (): Promise<number> => page.locator('[data-chat-flow]').first().evaluate(element => element.getBoundingClientRect().width)
  const columnWidthBefore = await readColumnWidth()
  await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] })
  await page.evaluate(() => new Promise<void>((resolve) => {
    const probe = { frames: [] as number[], running: true }
    ;(window as FrameProbe).benchmarkFrames = probe
    const tick = (time: number): void => {
      if (!probe.running) return
      probe.frames.push(time)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame((time) => { tick(time); resolve() })
  }))
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let step = 1; step <= STEPS; step++) {
    const delta = direction * step * (fixedPanelStart === undefined ? STEP_PX : FIXED_STEP_PX)
    await page.mouse.move(x - delta, y)
    if (fixedPanelStart === undefined) await page.waitForTimeout(STEP_GAP_MS)
    else {
      // Observe the actual panel before sending the next move; a freeze or coalesced drag must not reduce the work count.
      await page.waitForFunction(width => (window as FixedWidthProbe).benchmarkWidths.panel === width, fixedPanelStart + delta)
    }
  }
  await page.mouse.up()
  // Two animation frames let the release reach style and layout before the trace closes.
  const frames = await page.evaluate(() => new Promise<number[]>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const probe = (window as FrameProbe).benchmarkFrames!
      probe.running = false
      resolve(probe.frames)
    }))
  }))
  const trace = summarizeTrace(await browser.stopTracing())
  const gaps = frames.slice(1).map((time, index) => time - frames[index]!).sort((a, b) => a - b)
  return {
    ...trace,
    restyleRatio: trace.styledElements / elements,
    frameP95Ms: gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))] ?? 0,
    maxFrameGapMs: gaps.at(-1) ?? 0,
    columnWidthBefore,
    columnWidth: await readColumnWidth(),
  }
}

async function measureFixedColumn(browser: Browser, url: string): Promise<void> {
  const page = await newEnglishPage(browser, FIXED_VIEWPORT.height)
  try {
    const consoleWatch = watchConsole(page)
    await page.setViewportSize(FIXED_VIEWPORT)
    await page.addInitScript(width => { localStorage.setItem('dsh.conversation.contentWidth', String(width)) }, FIXED_COLUMN_PX)
    const elements = await openLoadedSidebar(page, url)
    const panelSelector = '[data-sidebar-right-panel="push"][data-sidebar-right-open]'
    const panel = page.locator(panelSelector)
    // The sliding dock items animate inside the panel, independently of its grid track.
    await panel.evaluate(async node => {
      await Promise.all(node.getAnimations({ subtree: true }).filter(animation => animation instanceof CSSTransition && animation.transitionProperty === 'transform').map(animation => animation.finished))
    })
    await page.evaluate(selector => {
      const panel = document.querySelector(selector)!
      const column = document.querySelector('[data-chat-flow]')!
      const widths = { column: new Set<number>(), panel: 0 }
      ;(window as FixedWidthProbe).benchmarkWidths = widths
      // Use delivered border boxes rather than forcing layout from a per-frame geometry read.
      const observer = new ResizeObserver(entries => {
        for (const entry of entries) {
          const width = entry.borderBoxSize[0]!.inlineSize
          if (entry.target === panel) widths.panel = width
          else widths.column.add(width)
        }
      })
      observer.observe(panel, { box: 'border-box' })
      observer.observe(column, { box: 'border-box' })
    }, panelSelector)
    await page.waitForFunction(() => (window as FixedWidthProbe).benchmarkWidths.column.size > 0)
    const reserveRoom = (): Promise<string> => page.locator('[data-session-panel-probe]').first().evaluate(node =>
      getComputedStyle(node).getPropertyValue('--dsh-session-panel-reserve-room').trim())
    let panelStart = FIXED_PANEL_START_PX
    for (const direction of [1, -1] as const) {
      expect(await page.evaluate(() => (window as FixedWidthProbe).benchmarkWidths.panel)).toBe(panelStart)
      const reserveBefore = await reserveRoom()
      const result = await drag(browser, page, direction, elements, panelStart)
      const reserveAfter = await reserveRoom()
      const geometry = await page.evaluate(() => {
        const { panel, column } = (window as FixedWidthProbe).benchmarkWidths
        return { panelWidth: panel, columnWidths: [...column] }
      })
      console.log(JSON.stringify({
        benchmark: 'rightbar-drag-browser/fixed-column', direction, elements,
        budget: FIXED_RESTYLE_BUDGET, peakElementBudget: FIXED_PEAK_ELEMENT_BUDGET,
        panelStart, ...geometry, reserveBefore, reserveAfter, ...result,
      }))
      panelStart += direction * STEPS * FIXED_STEP_PX
      expect(geometry.panelWidth).toBe(panelStart)
      expect(geometry.columnWidths).toEqual([FIXED_COLUMN_PX])
      expect([result.columnWidthBefore, result.columnWidth]).toEqual([FIXED_COLUMN_PX, FIXED_COLUMN_PX])
      expect([reserveBefore, reserveAfter]).toEqual(direction === 1 ? ['1px', '0px'] : ['0px', '1px'])
      expect(result.styledElements).toBeGreaterThan(0)
      expectFixedPeakWithinBudget(result.peakStyledElements)
      expectRestylesWithinBudget(result.restyleRatio, FIXED_RESTYLE_BUDGET)
    }
    expect(consoleWatch.pageErrors).toEqual([])
  } finally {
    await page.close()
  }
}

it('accepts recorded restyle ratios and rejects a drag that restyles the transcript every frame', () => {
  // 200-turn local samples: 1,479,947 and 1,909,568 elements restyled beside 28,895 before the width axis
  // kept resize inputs on the Conversation body; 2,622 and 3,368 after.
  for (const restyled of [1_479_947, 1_909_568]) expect(() => expectRestylesWithinBudget(restyled / 28_895)).toThrow()
  for (const restyled of [2_622, 3_368]) expectRestylesWithinBudget(restyled / 28_895)
  expectRestylesWithinBudget(RESTYLE_BUDGET)
  expect(() => expectRestylesWithinBudget(RESTYLE_BUDGET + 0.01)).toThrow()
})

it('rejects the fixed-column drag that restyled the transcript when reserve room flipped', () => {
  const elements = 18_428
  expect(() => expectRestylesWithinBudget(18_239 / elements, FIXED_RESTYLE_BUDGET)).toThrow()
  for (const restyled of [380, 379]) expectRestylesWithinBudget(restyled / elements, FIXED_RESTYLE_BUDGET)
})

/** A Chromium trace fragment with completed style passes and a separate invalidation notification. */
function restyleTrace(passes: readonly (readonly [number | undefined, number])[]): TraceSummary {
  const span = { pid: 1, tid: 1, ph: 'X' }
  const events = [
    { ...span, ts: 0, name: 'FunctionCall', dur: 1 },
    { ...span, ts: 0, ph: 'I', name: 'ScheduleStyleInvalidationTracking', args: { elementCount: 99_999 } },
    ...passes.map(([elementCount, dur], index) => ({
      ...span, ts: (index + 1) * 10_000, name: 'UpdateLayoutTree', dur, args: { elementCount },
    })),
  ]
  return summarizeTrace(Buffer.from(JSON.stringify({ traceEvents: events })))
}

it('reports the breadth of each style pass and the duration of the broadest pass, not the slowest pass', () => {
  expect(restyleTrace([[3, 9_000], [14_911, 1_200], [3, 500], [14_911, 2_300], [0, 100]])).toMatchObject({
    styledElements: 29_828,
    restylePassesByElementCount: { 0: 1, 3: 2, 14911: 2 },
    peakStyledElements: 14_911,
    peakCountPassMs: 2.3,
  })
  expect(() => restyleTrace([[undefined, 100]])).toThrow('elementCount')
})

it('distinguishes one oversized style pass from the same total work spread over small passes', () => {
  const elements = 18_428
  const distributed = restyleTrace(Array.from({ length: 200 }, () => [3, 100] as const))
  const spike = restyleTrace([[600, 100]])
  for (const result of [distributed, spike]) {
    expect(result.styledElements).toBe(600)
    expectRestylesWithinBudget(result.styledElements / elements, FIXED_RESTYLE_BUDGET)
  }
  expectFixedPeakWithinBudget(distributed.peakStyledElements)
  expect(() => expectFixedPeakWithinBudget(spike.peakStyledElements)).toThrow()
})

it('counts each layout enclosed by script on the same thread once, including frame callbacks', () => {
  const event = (name: string, ts: number, dur: number, pid = 1, tid = 1): TraceEvent => ({ name, ph: 'X', ts, dur, pid, tid })
  const events = [
    event('FireAnimationFrame', 10, 10), event('FunctionCall', 11, 5),
    event('Layout', 10, 10), event('Layout', 12, 1),
    event('Layout', 19, 2), event('Layout', 12, 1, 2, 1), event('Layout', 12, 1, 1, 2),
    event('PrePaint', 30, 5), event('Layout', 31, 1),
  ]
  expect(summarizeTrace(Buffer.from(JSON.stringify(events)))).toMatchObject({ layoutCount: 6, scriptNestedLayoutCount: 2 })
})

it(`bounds restyles and script-nested layouts while the right Sidebar is dragged beside ${String(HISTORY_TURNS)} turns`, async () => {
  if (webSnapshotMode() !== 'replay') throw new Error('browser benchmarks require keyless replay mode')
  const samples: Record<'widen' | 'narrow', DragSample[]> = { widen: [], narrow: [] }
  for (let sample = 0; sample < SAMPLES; sample++) {
    const failures: unknown[] = []
    // The scaffold owns a private home, persistence root, and loopback listener for this sample.
    const scaffold = await launchWebScaffold()
    try {
      await seedSession(scaffold, syntheticHistory(), SESSION_ID)
      const browser = await chromium.launch({ headless: true })
      try {
        if (sample === 0) await measureFixedColumn(browser, scaffold.authenticatedUrl)
        const page = await newEnglishPage(browser, VIEWPORT.height)
        await page.setViewportSize(VIEWPORT)
        const consoleWatch = watchConsole(page)
        const elements = await openLoadedSidebar(page, scaffold.authenticatedUrl)
        for (const [direction, key] of [[1, 'widen'], [-1, 'narrow']] as const) {
          const result = await drag(browser, page, direction, elements)
          console.log(JSON.stringify({ benchmark: 'rightbar-drag-browser/sample', sample, direction: key, elements, ...result }))
          // The transcript column moves opposite the Sidebar width while the resolved content width stays at its floor.
          expect(Math.max(result.columnWidthBefore, result.columnWidth)).toBeLessThan(CONTENT_WIDTH_FLOOR_PX)
          if (key === 'widen') expect(result.columnWidth).toBeLessThan(result.columnWidthBefore)
          else expect(result.columnWidth).toBeGreaterThan(result.columnWidthBefore)
          expect(result.styledElements).toBeGreaterThan(0)
          expect(result.layoutCount).toBeGreaterThan(0)
          expect(result.scriptNestedLayoutCount).toBeLessThanOrEqual(SCRIPT_NESTED_LAYOUT_BUDGET)
          samples[key].push(result)
        }
        expect(consoleWatch.pageErrors).toEqual([])
      } catch (error) { failures.push(error) } finally {
        await browser.close().catch((error: unknown) => failures.push(error))
      }
    } catch (error) { failures.push(error) } finally {
      await scaffold.close().catch((error: unknown) => failures.push(error))
    }
    if (failures.length > 0) throw new AggregateError(failures, 'browser benchmark failed')
  }
  const aggregate = {
    widen: median(samples.widen.map(sample => sample.restyleRatio)),
    narrow: median(samples.narrow.map(sample => sample.restyleRatio)),
  }
  console.log(JSON.stringify({ benchmark: 'rightbar-drag-browser/median', turns: HISTORY_TURNS, steps: STEPS, budget: RESTYLE_BUDGET, aggregate, samples }))
  expectRestylesWithinBudget(aggregate.widen)
  expectRestylesWithinBudget(aggregate.narrow)
})
