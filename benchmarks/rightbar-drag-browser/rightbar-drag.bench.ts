/** Required browser budget for transcript restyles while the right Sidebar is dragged beside a long history. */
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from '../../apps/web/tests/scaffold.ts'
import { newEnglishPage } from '../../apps/web/tests/support.ts'
import { HISTORY_TURNS, SESSION_ID, syntheticHistory } from './synthetic-history.ts'

const SAMPLES = 2
/** Below the content width's 680px floor at this width, so the drag changes the column but not the resolved content width. */
const VIEWPORT = { width: 1680, height: 1000 }
const CONTENT_WIDTH_FLOOR_PX = 680
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

interface TraceEvent {
  name: string
  ph: string
  dur?: number
  args?: { elementCount?: number }
}

/** Measurements of one drag; only `restyleRatio` is budgeted. */
interface DragSample {
  restyleRatio: number
  styledElements: number
  styleMs: number
  layoutMs: number
  frameP95Ms: number
  columnWidth: number
}

function expectRestylesWithinBudget(ratio: number): void {
  expect(ratio).toBeLessThanOrEqual(RESTYLE_BUDGET)
}

function median(values: number[]): number {
  return values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!
}

/** Style recalculation and layout totals from a Chromium timeline trace. */
function summarizeTrace(buffer: Buffer): { styledElements: number; styleMs: number; layoutMs: number } {
  const parsed = JSON.parse(buffer.toString('utf8')) as { traceEvents: TraceEvent[] } | TraceEvent[]
  const events = (Array.isArray(parsed) ? parsed : parsed.traceEvents).filter(event => event.ph === 'X')
  const styles = events.filter(event => event.name === 'UpdateLayoutTree')
  const ms = (list: TraceEvent[]): number => list.reduce((total, event) => total + (event.dur ?? 0), 0) / 1000
  return {
    styledElements: styles.reduce((total, event) => total + (event.args?.elementCount ?? 0), 0),
    styleMs: ms(styles),
    layoutMs: ms(events.filter(event => event.name === 'Layout')),
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

/** Frame timestamps the page collects during one drag. */
type FrameProbe = Window & { benchmarkFrames?: { frames: number[]; running: boolean } }

async function drag(browser: Browser, page: Page, direction: 1 | -1, elements: number): Promise<DragSample> {
  const box = await page.locator('[data-side="rightbar"]').boundingBox()
  if (box === null) throw new Error('right Sidebar resize handle missing')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.evaluate(() => {
    const probe = { frames: [] as number[], running: true }
    ;(window as FrameProbe).benchmarkFrames = probe
    const tick = (time: number): void => {
      if (!probe.running) return
      probe.frames.push(time)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] })
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let step = 1; step <= STEPS; step++) {
    await page.mouse.move(x - direction * step * STEP_PX, y)
    await page.waitForTimeout(STEP_GAP_MS)
  }
  await page.mouse.up()
  // Two animation frames let the release reach style and layout before the trace closes.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const trace = summarizeTrace(await browser.stopTracing())
  const frames = await page.evaluate(() => {
    const probe = (window as FrameProbe).benchmarkFrames!
    probe.running = false
    return probe.frames
  })
  const gaps = frames.slice(1).map((time, index) => time - frames[index]!).sort((a, b) => a - b)
  const columnWidth = await page.locator('[data-chat-flow]').first().evaluate(element => element.getBoundingClientRect().width)
  return {
    restyleRatio: trace.styledElements / elements,
    styledElements: trace.styledElements,
    styleMs: trace.styleMs,
    layoutMs: trace.layoutMs,
    frameP95Ms: gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))] ?? 0,
    columnWidth,
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

it(`restyles a bounded share of the page while the right Sidebar is dragged beside ${String(HISTORY_TURNS)} turns`, async () => {
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
        const page = await newEnglishPage(browser, VIEWPORT.height)
        await page.setViewportSize(VIEWPORT)
        const consoleWatch = watchConsole(page)
        page.setDefaultTimeout(60_000)
        await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        await page.getByRole('treeitem').first().click()
        await page.getByRole('treeitem').nth(1).click()
        await page.locator(TAIL).last().waitFor()
        expect(await loadAll(page)).toBe(HISTORY_TURNS)
        await page.getByRole('button', { name: 'Open right sidebar' }).first().click()
        await page.locator('[data-side="rightbar"]').waitFor()
        // The Sidebar opens with a track transition; the drag starts from its settled width.
        await page.waitForFunction(() => document.querySelector('[data-rightbar-collapsed], [data-animating]') === null)
        const elements = await page.evaluate(() => document.querySelectorAll('*').length)
        for (const [direction, key] of [[1, 'widen'], [-1, 'narrow']] as const) {
          const result = await drag(browser, page, direction, elements)
          // The budget presumes an unchanged content width: the column stays below its floor.
          expect(result.columnWidth).toBeLessThan(CONTENT_WIDTH_FLOOR_PX)
          samples[key].push(result)
          console.log(JSON.stringify({ benchmark: 'rightbar-drag-browser/sample', sample, direction: key, elements, ...result }))
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
