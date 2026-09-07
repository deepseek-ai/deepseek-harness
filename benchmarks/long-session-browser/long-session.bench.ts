/** Required browser budgets for opening, paging and continuing synthetic long history. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { chromium, type Page, type CDPSession, type Locator } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from '../../apps/web/tests/scaffold.ts'
import { newEnglishPage } from '../../apps/web/tests/support.ts'
import { ciTimeBudget, PERFORMANCE_BUDGET_HEADROOM } from '../support/calibration.ts'
import { HISTORY_TURNS, SESSION_ID, FIRST, DONE, DELTAS, PACE_MS, syntheticHistory, syntheticReply } from './synthetic-history.ts'

const SAMPLES = 3
const TAIL = '[data-chat-flow-key^="9:turn-tail"]'
const REFERENCE = { open: 200, page: 260, trajectory: 160, first: 1100, streamTask: 1800, input: 500, streamWall: 1000 }
const EXPECTED_OPEN_CI_MS = 900
const EXPECTED_PAGE_CI_MS = 700
const EXPECTED_TRAJECTORY_CI_MS = 500
const OPEN_BUDGET_MS = Math.ceil(EXPECTED_OPEN_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
const PAGE_BUDGET_MS = Math.ceil(EXPECTED_PAGE_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
const TRAJECTORY_BUDGET_MS = Math.ceil(EXPECTED_TRAJECTORY_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
const REPLAY_DURATION_MS = (DELTAS + 4) * PACE_MS

async function painted(page: Page): Promise<void> {
  // Two rAF callbacks include a rendering opportunity, not a GPU presentation timestamp.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function measure(page: Page, action: () => Promise<void>): Promise<number> {
  const start = performance.now()
  await action()
  await painted(page)
  return performance.now() - start
}

async function taskMs(cdp: CDPSession): Promise<number> {
  const result = await cdp.send('Performance.getMetrics')
  const metric = result.metrics.find(metric => metric.name === 'TaskDuration')
  if (metric === undefined) throw new Error('Chromium TaskDuration missing')
  return metric.value * 1000
}

function median(values: number[]): number {
  return values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!
}

function expectEndpointWithinBudget(value: number, budget: number): void {
  expect(value).toBeLessThanOrEqual(budget)
}

function expectInputOverlap(value: boolean): void {
  expect(value).toBe(true)
}

async function watchInputOverlap(composer: Locator): Promise<void> {
  await composer.evaluate((element, markers) => {
    element.removeAttribute('data-benchmark-input-witness')
    element.removeAttribute('data-benchmark-input-overlap')
    element.addEventListener('input', (event) => {
      const transcript = Array.from(document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')).at(-1)?.textContent ?? ''
      element.setAttribute('data-benchmark-input-overlap', String(event.isTrusted && transcript.includes(markers.first) && !transcript.includes(markers.done)))
      element.setAttribute('data-benchmark-input-witness', JSON.stringify({ trusted: event.isTrusted, first: transcript.includes(markers.first), done: transcript.includes(markers.done) }))
    }, { once: true })
  }, { first: FIRST, done: DONE })
}

it('accepts recorded hosted open samples and rejects slower endpoints', () => {
  for (const value of [681.276514, 541.051233]) {
    expect(() => expectEndpointWithinBudget(value, ciTimeBudget(REFERENCE.open))).toThrow()
    expectEndpointWithinBudget(value, OPEN_BUDGET_MS)
  }
  const repeatedMedian = median([875.306861, 1083.683529, 814.700998])
  expect(repeatedMedian).toBe(875.306861)
  expect(() => expectEndpointWithinBudget(repeatedMedian, ciTimeBudget(REFERENCE.open))).toThrow()
  expect(() => expectEndpointWithinBudget(repeatedMedian, 875)).toThrow()
  expectEndpointWithinBudget(repeatedMedian, OPEN_BUDGET_MS)
  expect(OPEN_BUDGET_MS).toBe(1125)
  expect(() => expectEndpointWithinBudget(OPEN_BUDGET_MS + 1, OPEN_BUDGET_MS)).toThrow()
  expect(() => expectEndpointWithinBudget(2000, OPEN_BUDGET_MS)).toThrow()
})

it('accepts recorded hosted paging and Trajectory medians and rejects slower endpoints', () => {
  const endpoints = [
    { samples: [843.941625, 672.834329, 684.461818], reference: REFERENCE.page, budget: PAGE_BUDGET_MS, expectedBudget: 875 },
    { samples: [605.788061, 367.754027, 485.931656], reference: REFERENCE.trajectory, budget: TRAJECTORY_BUDGET_MS, expectedBudget: 625 },
  ]
  for (const { samples, reference, budget, expectedBudget } of endpoints) {
    const value = median(samples)
    expect(() => expectEndpointWithinBudget(value, ciTimeBudget(reference))).toThrow()
    expectEndpointWithinBudget(value, budget)
    expect(budget).toBe(expectedBudget)
    expect(() => expectEndpointWithinBudget(budget + 1, budget)).toThrow()
  }
})

it('opens, pages, navigates and streams into a 240-turn browser history', async () => {
  if (webSnapshotMode() !== 'replay') throw new Error('browser benchmarks require keyless replay mode')
  const samples: { open: number; page: number; trajectory: number; first: number; streamTask: number; streamWall: number; input: number; inputOverlapped: boolean; heapMb: number; nodes: number }[] = []
  for (let sample = 0; sample < SAMPLES; sample++) {
    const failures: unknown[] = []
    const root = await mkdtemp(join(tmpdir(), 'dsh-browser-benchmark-'))
    try {
      const replayOverride = join(root, 'reply.json')
      await writeFile(replayOverride, JSON.stringify([{ kind: 'chunks', chunks: syntheticReply() }]))
      const scaffold = await launchWebScaffold({ replayFixture: join(root, 'override-only.jsonl'), replayOverride, paceMs: PACE_MS, replayContextWindow: 10000000 })
      try {
        const history = syntheticHistory()
        await seedSession(scaffold, history, SESSION_ID)
        console.log(JSON.stringify({ benchmark: 'long-session-browser/fixture', bytes: Buffer.byteLength(history) }))
        const browser = await chromium.launch({ headless: true })
        try {
          const page = await newEnglishPage(browser)
          const consoleWatch = watchConsole(page)
          page.setDefaultTimeout(30000)
          await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
          expect(new URL(page.url()).origin).toBe(scaffold.baseUrl)
          console.log(JSON.stringify({ benchmark: 'long-session-browser/server', url: scaffold.baseUrl, browser: browser.version(), sample }))
          await page.waitForSelector('[class*="frame"]')
          await page.getByRole('treeitem').first().click()
          const result = page.getByRole('treeitem').nth(1)
          await result.waitFor()
          const open = await measure(page, async () => {
            await result.click()
            await page.locator(TAIL).last().waitFor()
            await page.locator('[data-composer-input][contenteditable="true"]').last().waitFor()
          })
          const pages: number[] = []
          const initialTurns = await page.locator(TAIL).count()
          expect(initialTurns).toBeGreaterThan(0)
          expect(initialTurns).toBeLessThan(HISTORY_TURNS)
          let count = initialTurns
          while (count < HISTORY_TURNS) {
            pages.push(await measure(page, async () => {
              await page.getByRole('button', { name: 'Load earlier', exact: true }).click()
              await page.waitForFunction(({ selector, previous }) => document.querySelectorAll(selector).length > previous, { selector: TAIL, previous: count })
            }))
            count = await page.locator(TAIL).count()
          }
          const trajectory = await measure(page, async () => {
            await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
            await page.getByRole('searchbox', { name: 'Search trajectory', exact: true }).waitFor()
            await page.getByRole('row').last().waitFor()
          })
          await page.getByRole('tab', { name: 'Chat', exact: true }).click()
          await page.waitForFunction(({ selector, expected }) => document.querySelectorAll(selector).length === expected, { selector: TAIL, expected: HISTORY_TURNS })
          const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
          await composer.fill('Continue the synthetic review and summarize the validation. '.repeat(30))
          const cdp = await page.context().newCDPSession(page)
          await cdp.send('Performance.enable')
          const beforeTask = await taskMs(cdp)
          const settled = scaffold.whenTurnSettled(60000).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          )
          await watchInputOverlap(composer)
          const started = performance.now()
          await page.locator('[data-composer-seat]').getByRole('button', { name: 'Send message', exact: true }).click()
          const reply = page.locator('[data-chat-flow-kind="assistant-step"]').last()
          await reply.getByText(FIRST, { exact: false }).last().waitFor()
          const first = performance.now() - started
          // Observe the actual trusted input event, not state before asynchronous click/typing.
          const input = await measure(page, async () => {
            await composer.click()
            await page.keyboard.type('next synthetic question')
            await expect.poll(() => composer.textContent()).toBe('next synthetic question')
          })
          const inputOverlapped = await composer.getAttribute('data-benchmark-input-overlap') === 'true'
          console.log(JSON.stringify({ benchmark: 'long-session-browser/input', sample, first, input, witness: await composer.getAttribute('data-benchmark-input-witness') }))
          expectInputOverlap(inputOverlapped)
          await reply.getByText(DONE, { exact: false }).last().waitFor()
          const settlement = await settled
          if (!settlement.ok) throw settlement.error
          await page.waitForFunction(({ selector, expected }) => document.querySelectorAll(selector).length === expected, { selector: TAIL, expected: HISTORY_TURNS + 1 })
          await painted(page)
          const streamWall = performance.now() - started
          const streamTask = await taskMs(cdp) - beforeTask
          await cdp.send('HeapProfiler.collectGarbage')
          const metrics = (await cdp.send('Performance.getMetrics')).metrics
          const heap = metrics.find(metric => metric.name === 'JSHeapUsedSize')
          if (heap === undefined) throw new Error('Chromium heap metric missing')
          samples.push({ open, page: Math.max(...pages), trajectory, first, streamTask, streamWall, input, inputOverlapped, heapMb: heap.value / 1048576, nodes: await page.locator('*').count() })
          console.log(JSON.stringify({ benchmark: 'long-session-browser/sample', sample, initialTurns, pages, ...samples.at(-1) }))
          await watchInputOverlap(composer)
          await composer.click()
          await page.keyboard.type('!')
          const lateInputOverlapped = await composer.getAttribute('data-benchmark-input-overlap') === 'true'
          expect(await composer.getAttribute('data-benchmark-input-witness')).toBe(JSON.stringify({ trusted: true, first: true, done: true }))
          expect(() => expectInputOverlap(lateInputOverlapped)).toThrow()
          expect(consoleWatch.pageErrors).toEqual([])
          expect(consoleWatch.warnings).toEqual([])
        } catch (error) { failures.push(error) } finally {
          await browser.close().catch((error: unknown) => failures.push(error))
        }
      } catch (error) { failures.push(error) } finally {
        await scaffold.close().catch((error: unknown) => failures.push(error))
      }
    } catch (error) { failures.push(error) } finally {
      await rm(root, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    }
    if (failures.length > 0) throw new AggregateError(failures, 'browser benchmark failed')
  }
  const aggregate = Object.fromEntries(Object.keys(REFERENCE).map(key => [key, median(samples.map(sample => sample[key as keyof typeof REFERENCE]))]))
  const budgets: Record<string, number> = {
    ...Object.fromEntries(Object.entries(REFERENCE).map(([key, value]) => [key, ciTimeBudget(value) + (key === 'streamWall' ? REPLAY_DURATION_MS : 0)])),
    open: OPEN_BUDGET_MS, page: PAGE_BUDGET_MS, trajectory: TRAJECTORY_BUDGET_MS,
  }
  console.log(JSON.stringify({ benchmark: 'long-session-browser/median', turns: HISTORY_TURNS, deltas: DELTAS, paceMs: PACE_MS, samples, aggregate, referenceMs: REFERENCE, expectedOpenCiMs: EXPECTED_OPEN_CI_MS, expectedPageCiMs: EXPECTED_PAGE_CI_MS, expectedTrajectoryCiMs: EXPECTED_TRAJECTORY_CI_MS, budgets }))
  for (const [key, value] of Object.entries(aggregate)) expectEndpointWithinBudget(value, budgets[key]!)
})
