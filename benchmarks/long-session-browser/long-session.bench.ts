/** Required browser budgets for opening, paging and continuing synthetic long history. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { chromium, type Page, type CDPSession, type Locator } from 'playwright'
import { expect, it, vi } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from '../../apps/web/tests/scaffold.ts'
import { newEnglishPage } from '../../apps/web/tests/support.ts'
import { ciTimeBudget, PERFORMANCE_BUDGET_HEADROOM } from '../support/calibration.ts'
import { recordTimings, type BenchmarkCase } from '../support/scaling-report.ts'
import { HISTORY_TURNS, SESSION_ID, FIRST, DONE, DELTAS, PACE_MS, syntheticHistory, syntheticReply } from './synthetic-history.ts'

const SAMPLES = 3
const TAIL = '[data-chat-flow-key^="9:turn-tail"]'
const REFERENCE = { open: 200, page: 260, trajectory: 160, first: 1100, streamTask: 1800, input: 500, streamWall: 1000 }
const EXPECTED_OPEN_CI_MS = 900
const EXPECTED_PAGE_CI_MS = 700
const EXPECTED_TRAJECTORY_CI_MS = 520
const OPEN_BUDGET_MS = Math.ceil(EXPECTED_OPEN_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
const PAGE_BUDGET_MS = Math.ceil(EXPECTED_PAGE_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
const TRAJECTORY_BUDGET_MS = Math.ceil(EXPECTED_TRAJECTORY_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
const REPLAY_DURATION_MS = (DELTAS + 4) * PACE_MS
/** Endpoints without paced replay waits, so CPU scaling applies to their whole duration. */
const SCALED_ENDPOINTS = ['open', 'page', 'trajectory', 'streamTask'] as const
/** Estimated storage wait: the Host reads the seeded Session log, which the page cache usually holds. */
const IO_SHARE = 0.05
const CASE: BenchmarkCase = {
  id: 'long-session-browser',
  measures: 'Chromium on the built Web GUI: opening a 240-turn Session, the slowest older page, first Trajectory view, and main-thread task time while a reply streams.',
  affects: 'Everyday Web GUI use with a long Session.',
}

async function painted(page: Page): Promise<void> {
  // Two rAF callbacks include a rendering opportunity, not a GPU presentation timestamp.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function measure(page: Page, action: () => Promise<void>, now = () => performance.now()): Promise<number> {
  const start = now()
  await action()
  await painted(page)
  return now() - start
}

/** Time one trusted paging action after resolving its unique button. */
async function measureOlderPage(page: Page, previous: number, now = () => performance.now()): Promise<number> {
  const locator = page.getByRole('button', { name: 'Load earlier', exact: true })
  await locator.waitFor({ state: 'attached' })
  const buttons = await locator.elementHandles()
  try {
    expect(buttons).toHaveLength(1)
    return await measure(page, async () => {
      await buttons[0]!.click()
      await page.waitForFunction(({ selector, previous }) => document.querySelectorAll(selector).length > previous, { selector: TAIL, previous })
    }, now)
  } finally {
    await Promise.all(buttons.map(button => button.dispose()))
  }
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

async function waitForReplyMarker(page: Page, marker: string, timeout = 30000) {
  return page.waitForFunction(({ marker, first, done }) => {
    const reply = Array.from(document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')).at(-1)
    if (!reply) return false
    const text = document.createTreeWalker(reply, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = text.nextNode())) {
      if (!node.textContent?.includes(marker) || !node.parentElement?.checkVisibility({ checkVisibilityCSS: true })) continue
      const composer = Array.from(document.querySelectorAll('[data-composer-input][contenteditable="true"]')).at(-1)
      const transcript = reply.textContent ?? ''
      return { atMs: window.performance.now(), focused: document.activeElement === composer, first: transcript.includes(first), done: transcript.includes(done) }
    }
    return false
  }, { marker, first: FIRST, done: DONE }, { polling: 'raf', timeout })
}

async function waitForTrajectory(page: Page, timeout = 30000): Promise<void> {
  // Selector retry backoff can delay observation after the view is already ready.
  const ready = await page.waitForFunction(() => {
    const search = document.querySelector('input[type="search"][aria-label="Search trajectory"]')
    if (!search?.checkVisibility({ checkVisibilityCSS: true })) return false
    return Array.from(document.querySelectorAll('[data-trajectory-scroll] [data-trajectory-row-key]'))
      .some(row => row.checkVisibility({ checkVisibilityCSS: true }))
  }, undefined, { polling: 'raf', timeout })
  await ready.dispose()
}

async function watchInputOverlap(composer: Locator): Promise<void> {
  await composer.evaluate((element, markers) => {
    element.removeAttribute('data-benchmark-input-witness')
    element.removeAttribute('data-benchmark-input-overlap')
    element.removeAttribute('data-benchmark-input-timing')
    element.addEventListener('input', (event) => {
      const transcript = Array.from(document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')).at(-1)?.textContent ?? ''
      element.setAttribute('data-benchmark-input-overlap', String(event.isTrusted && transcript.includes(markers.first) && !transcript.includes(markers.done)))
      element.setAttribute('data-benchmark-input-witness', JSON.stringify({ trusted: event.isTrusted, first: transcript.includes(markers.first), done: transcript.includes(markers.done) }))
      element.setAttribute('data-benchmark-input-timing', JSON.stringify({ atMs: window.performance.now(), eventAtMs: event.timeStamp, focused: document.activeElement === element }))
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
    { samples: [605.788061, 367.754027, 485.931656], reference: REFERENCE.trajectory, budget: TRAJECTORY_BUDGET_MS, expectedBudget: 650 },
    { samples: [630.843184, 418.578099, 635.550009], reference: REFERENCE.trajectory, budget: TRAJECTORY_BUDGET_MS, expectedBudget: 650 },
  ]
  for (const { samples, reference, budget, expectedBudget } of endpoints) {
    const value = median(samples)
    expect(() => expectEndpointWithinBudget(value, ciTimeBudget(reference))).toThrow()
    expectEndpointWithinBudget(value, budget)
    expect(budget).toBe(expectedBudget)
    expect(() => expectEndpointWithinBudget(budget + 1, budget)).toThrow()
  }
})

it('waits for visible marker text in the latest Assistant step', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`<div data-chat-flow-kind="assistant-step">${FIRST}</div><div data-chat-flow-kind="assistant-step"><span style="visibility:hidden">${FIRST}</span></div>`)
    await expect(waitForReplyMarker(page, FIRST, 100)).rejects.toThrow('Timeout')
    await page.locator('span').evaluate(element => { element.style.visibility = 'visible' })
    const observation = await waitForReplyMarker(page, FIRST)
    expect(await observation.jsonValue()).toMatchObject({ first: true, done: false })
    await observation.dispose()
    await expect(waitForReplyMarker(page, DONE, 100)).rejects.toThrow('Timeout')
  } finally {
    await browser.close()
  }
})

it('waits for visible Trajectory controls and records rather than unrelated table rows', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<input type="search" aria-label="Search trajectory" style="visibility:hidden"><table><tbody><tr><td>unrelated</td></tr></tbody></table><div data-trajectory-scroll><table><tbody><tr data-trajectory-row-key="record"><td>record</td></tr></tbody></table></div>')
    await expect(waitForTrajectory(page, 100)).rejects.toThrow('Timeout')
    await page.locator('[data-trajectory-row-key]').evaluate(element => { element.style.display = 'none' })
    await page.locator('input').evaluate(element => { element.style.visibility = 'visible' })
    await expect(waitForTrajectory(page, 100)).rejects.toThrow('Timeout')
    await page.locator('[data-trajectory-row-key]').evaluate(element => { element.style.display = 'table-row' })
    await waitForTrajectory(page)
  } finally {
    await browser.close()
  }
})

it('excludes older-page selector preparation while retaining the trusted click', async () => {
  const browser = await chromium.launch({ headless: true })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let operation: Promise<{ value: number } | { error: unknown }> | undefined
  try {
    const page = await browser.newPage()
    await page.setContent('<button type="button">Load earlier</button><div data-chat-flow-key="9:turn-tail"></div>')
    await page.locator('button').evaluate(button => {
      button.addEventListener('click', event => {
        button.setAttribute('data-click-trusted', String(event.isTrusted))
        const tail = document.createElement('div')
        tail.setAttribute('data-chat-flow-key', '9:turn-tail:next')
        document.body.append(tail)
      })
    })
    const button = page.getByRole('button', { name: 'Load earlier', exact: true })
    const click = button.click.bind(button)
    const elementHandles = button.elementHandles.bind(button)
    const prepare = async (): Promise<void> => { entered.resolve(undefined); await release.promise }
    vi.spyOn(page, 'getByRole').mockReturnValue(button)
    // The Locator spy gates preparation in the original selector-inside-timer control.
    vi.spyOn(button, 'click').mockImplementation(async options => { await prepare(); await click(options) })
    vi.spyOn(button, 'elementHandles').mockImplementation(async () => { await prepare(); return elementHandles() })
    let now = 0
    operation = measureOlderPage(page, 1, () => now).then(value => ({ value }), (error: unknown) => ({ error }))
    await Promise.race([
      entered.promise,
      operation.then(outcome => {
        if ('error' in outcome) throw outcome.error
        throw new Error('Paging completed before the selector preparation barrier')
      }),
    ])
    expect(await page.locator('button').getAttribute('data-click-trusted')).toBeNull()
    expect(await page.locator(TAIL).count()).toBe(1)
    now = PAGE_BUDGET_MS + 1
    release.resolve(undefined)
    const outcome = await operation
    if ('error' in outcome) throw outcome.error
    expectEndpointWithinBudget(outcome.value, PAGE_BUDGET_MS)
    expect(outcome.value).toBe(0)
    expect(await page.locator('button').getAttribute('data-click-trusted')).toBe('true')
    expect(await page.locator(TAIL).count()).toBe(2)
  } finally {
    release.resolve(undefined)
    try { await browser.close() } finally {
      try { await operation } finally { vi.restoreAllMocks() }
    }
  }
})

it('waits for a named older-page control before starting its clock', async () => {
  const browser = await chromium.launch({ headless: true })
  const entered = Promise.withResolvers<undefined>()
  let operation: Promise<{ value: number } | { error: unknown }> | undefined
  try {
    const page = await browser.newPage()
    await page.setContent('<button type="button" disabled>Loading…</button><div data-chat-flow-key="9:turn-tail"></div>')
    await page.locator('button').evaluate(button => {
      button.addEventListener('click', event => {
        button.setAttribute('data-click-trusted', String(event.isTrusted))
        const tail = document.createElement('div')
        tail.setAttribute('data-chat-flow-key', '9:turn-tail:next')
        document.body.append(tail)
      })
    })
    const locator = page.getByRole('button', { name: 'Load earlier', exact: true })
    const waitFor = locator.waitFor.bind(locator)
    vi.spyOn(page, 'getByRole').mockReturnValue(locator)
    vi.spyOn(locator, 'waitFor').mockImplementation(options => { entered.resolve(undefined); return waitFor(options) })
    let now = 0
    operation = measureOlderPage(page, 1, () => now).then(value => ({ value }), (error: unknown) => ({ error }))
    await Promise.race([
      entered.promise,
      operation.then(outcome => {
        if ('error' in outcome) throw outcome.error
        throw new Error('Paging completed before control readiness')
      }),
    ])
    expect(await page.locator('button').getAttribute('data-click-trusted')).toBeNull()
    now = PAGE_BUDGET_MS + 1
    await page.locator('button').evaluate(button => {
      button.textContent = 'Load earlier'
      button.removeAttribute('disabled')
    })
    const outcome = await operation
    if ('error' in outcome) throw outcome.error
    expect(outcome.value).toBe(0)
    expect(await page.locator('button').getAttribute('data-click-trusted')).toBe('true')
    expect(await page.locator(TAIL).count()).toBe(2)
  } finally {
    try { await browser.close() } finally {
      try { await operation } finally { vi.restoreAllMocks() }
    }
  }
})

it('keeps browser deadlines active with a fixed measurement clock', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await expect(measure(page, async () => {
      const pending = await page.waitForFunction(() => false, undefined, { timeout: 100 })
      await pending.dispose()
    }, () => 0)).rejects.toThrow('Timeout 100ms exceeded')
  } finally {
    await browser.close()
  }
})

it('rejects older-page rendering beyond the unchanged paging ceiling', async () => {
  const browser = await chromium.launch({ headless: true })
  let operation: Promise<{ value: number } | { error: unknown }> | undefined
  try {
    const page = await browser.newPage()
    await page.setContent('<button type="button">Load earlier</button><div data-chat-flow-key="9:turn-tail"></div>')
    await page.locator('button').evaluate(button => {
      button.addEventListener('click', event => { button.setAttribute('data-click-trusted', String(event.isTrusted)) })
    })
    let now = 0
    operation = measureOlderPage(page, 1, () => now).then(value => ({ value }), (error: unknown) => ({ error }))
    await page.waitForFunction(() => document.querySelector('button')?.getAttribute('data-click-trusted') === 'true')
    now = PAGE_BUDGET_MS + 1
    await page.evaluate(() => {
      const tail = document.createElement('div')
      tail.setAttribute('data-chat-flow-key', '9:turn-tail:next')
      document.body.append(tail)
    })
    const outcome = await operation
    if ('error' in outcome) throw outcome.error
    expect(outcome.value).toBe(PAGE_BUDGET_MS + 1)
    expect(() => expectEndpointWithinBudget(outcome.value, PAGE_BUDGET_MS)).toThrow()
  } finally {
    try { await browser.close() } finally {
      try { await operation } finally { vi.restoreAllMocks() }
    }
  }
})

it('rejects ambiguous or replaced older-page buttons before paging', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<button type="button">Load earlier</button><button type="button">Load earlier</button>')
    await expect(measureOlderPage(page, 0)).rejects.toThrow('strict mode violation')
    await page.setContent('<button type="button">Load earlier</button>')
    const button = page.getByRole('button', { name: 'Load earlier', exact: true })
    const elementHandles = button.elementHandles.bind(button)
    vi.spyOn(page, 'getByRole').mockReturnValue(button)
    vi.spyOn(button, 'elementHandles').mockImplementation(async () => {
      const handles = await elementHandles()
      await button.evaluate(element => { element.replaceWith(element.cloneNode(true)) })
      return handles
    })
    await expect(measureOlderPage(page, 0)).rejects.toThrow('Element is not attached')
  } finally {
    try { await browser.close() } finally { vi.restoreAllMocks() }
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
            pages.push(await measureOlderPage(page, count))
            count = await page.locator(TAIL).count()
          }
          const trajectory = await measure(page, async () => {
            await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
            await waitForTrajectory(page)
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
          await page.keyboard.press('Enter')
          const firstMarker = await waitForReplyMarker(page, FIRST)
          const first = performance.now() - started
          // Keep focus across submission; mouse actionability must not delay the input probe.
          const input = await measure(page, async () => {
            await page.keyboard.type('next synthetic question')
            await expect.poll(() => composer.textContent()).toBe('next synthetic question')
          })
          const inputOverlapped = await composer.getAttribute('data-benchmark-input-overlap') === 'true'
          const firstObservation = await firstMarker.jsonValue()
          await firstMarker.dispose()
          console.log(JSON.stringify({ benchmark: 'long-session-browser/input', sample, first, input, firstObservation, witness: await composer.getAttribute('data-benchmark-input-witness'), inputTiming: await composer.getAttribute('data-benchmark-input-timing') }))
          expectInputOverlap(inputOverlapped)
          await (await waitForReplyMarker(page, DONE)).dispose()
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
  recordTimings(CASE, Object.fromEntries(SCALED_ENDPOINTS.map(key => [key, { ms: aggregate[key]!, ioShare: IO_SHARE }])), budgets)
  for (const [key, value] of Object.entries(aggregate)) expectEndpointWithinBudget(value, budgets[key]!)
})
