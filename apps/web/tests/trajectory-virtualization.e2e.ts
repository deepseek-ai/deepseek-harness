// Browser contract for the tail-paged, virtualized Trajectory ledger. The
// scenario proves that semantic row identity survives an older-page prepend,
// DOM mounting stays bounded, and every scroll range remains reachable.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import {
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const LOAD_MORE_EXPECTED = fileURLToPath(new URL(
  './expected/trajectory-virtualization/load-more.expected.md',
  import.meta.url,
))
const SESSION_ID = 'trajectory-virtualization-e2e'
const FIXTURE = createChatScrollFixture({
  markerPrefix: 'TRAJECTORY_VIRTUAL',
  title: 'TRAJECTORY_VIRTUAL long ledger',
  turns: 88,
})
const MAX_MOUNTED_ROWS = 160
const GEOMETRY_TOLERANCE = 2
const STREAM_MARKER = 'TRAJECTORY_VIRTUAL_STREAM_FINISHED'
const STREAM_TEXT = Array.from(
  { length: 80 },
  (_, index) => `stream fragment ${String(index + 1).padStart(2, '0')} `,
).join('') + STREAM_MARKER

const STREAM_CHUNKS: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  ...Array.from({ length: 80 }, (_, index): StreamChunk => ({
    type: 'text-delta',
    index: 0,
    text: `stream fragment ${String(index + 1).padStart(2, '0')} `,
  })),
  { type: 'text-delta', index: 0, text: STREAM_MARKER },
  { type: 'block-end', index: 0, block: { type: 'text', text: STREAM_TEXT } },
  { type: 'usage', usage: { inputTokens: 2_700, outputTokens: 240 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

interface ScrollGeometry {
  readonly clientHeight: number
  readonly scrollHeight: number
  readonly scrollTop: number
}

interface RowAnchor {
  readonly key: string
  readonly top: number
}

async function openSeed(page: Page): Promise<void> {
  // Search collapsed into a header action; expand it before filling.
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  const search = page.getByRole('textbox', { name: 'Search sessions...', exact: true })
  await search.fill(FIXTURE.markers.user(1))
  const result = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => result.count(), { timeout: 60_000 }).toBe(1)
  await result.click()
  await page.getByRole('tab', { name: 'Trajectory', exact: true }).waitFor({ timeout: 30_000 })
  await page.getByText(FIXTURE.markers.assistant(FIXTURE.turns), { exact: false })
    .last()
    .waitFor({ timeout: 30_000 })
}

async function openTrajectory(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
  const pane = page.locator('[data-trajectory-scroll]')
  await pane.waitFor({ timeout: 30_000 })
  await page.locator('[data-trajectory-scroll] table[data-scroll-ready="true"]')
    .waitFor({ timeout: 30_000 })
}

async function logicalRows(page: Page): Promise<number> {
  const raw = await page.locator('[data-trajectory-scroll] table').getAttribute('aria-rowcount')
  if (raw === null || !/^\d+$/.test(raw)) {
    throw new Error(`trajectory table has invalid aria-rowcount ${JSON.stringify(raw)}`)
  }
  return Number(raw)
}

async function mountedRows(page: Page): Promise<number> {
  return page.locator('[data-trajectory-scroll] tr[data-trajectory-row-key]').count()
}

async function geometry(page: Page): Promise<ScrollGeometry> {
  return page.locator('[data-trajectory-scroll]').evaluate(host => ({
    clientHeight: host.clientHeight,
    scrollHeight: host.scrollHeight,
    scrollTop: host.scrollTop,
  }))
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => { resolve() }))
  }))
}

async function scrollToRatio(page: Page, ratio: number): Promise<void> {
  await page.locator('[data-trajectory-scroll]').evaluate((host, value) => {
    const maximum = Math.max(0, host.scrollHeight - host.clientHeight)
    host.scrollTop = Math.round(maximum * value)
    host.dispatchEvent(new Event('scroll'))
  }, ratio)
  await nextPaint(page)
}

async function firstVisibleRow(page: Page): Promise<RowAnchor> {
  return page.locator('[data-trajectory-scroll]').evaluate((host) => {
    const hostBox = host.getBoundingClientRect()
    const rows = [...host.querySelectorAll<HTMLElement>('tr[data-trajectory-row-key]')]
    const row = rows.find((candidate) => {
      const box = candidate.getBoundingClientRect()
      return candidate.dataset.requestOnly !== 'true'
        && box.bottom > hostBox.top
        && box.top < hostBox.bottom
    })
    const key = row?.dataset.trajectoryRowKey
    if (row === undefined || key === undefined) {
      throw new Error('trajectory scrollport has no visible semantic row')
    }
    return { key, top: row.getBoundingClientRect().top - hostBox.top }
  })
}

async function rowTop(page: Page, key: string): Promise<number | null> {
  return page.locator('[data-trajectory-scroll]').evaluate((host, targetKey) => {
    const rows = [...host.querySelectorAll<HTMLElement>('tr[data-trajectory-row-key]')]
    const row = rows.find(candidate => candidate.dataset.trajectoryRowKey === targetKey)
    return row === undefined
      ? null
      : row.getBoundingClientRect().top - host.getBoundingClientRect().top
  }, key)
}

async function loadToFirstTurn(page: Page): Promise<void> {
  const marker = FIXTURE.markers.user(1)
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await scrollToRatio(page, 0)
    if (await page.getByText(marker, { exact: false }).count() > 0) return
    const before = await logicalRows(page)
    const anchor = await firstVisibleRow(page)
    await expect.poll(async () => ({
      marker: await page.getByText(marker, { exact: false }).count() > 0,
      rows: await logicalRows(page),
    }), { timeout: 30_000 }).not.toEqual({ marker: false, rows: before })
    await nextPaint(page)
    await expect.poll(async () => {
      const top = await rowTop(page, anchor.key)
      return top === null ? Number.POSITIVE_INFINITY : Math.abs(top - anchor.top)
    }, { timeout: 15_000 }).toBeLessThanOrEqual(GEOMETRY_TOLERANCE)
  }
  throw new Error('trajectory did not reach the first turn after twelve older-page requests')
}

describe('web e2e: Trajectory virtualization over tail-paged history', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let replayDir: string

  beforeAll(async () => {
    replayDir = await mkdtemp(join(tmpdir(), 'dsh-trajectory-virtualization-'))
    const replayFixture = join(replayDir, 'session.jsonl')
    const replayOverride = join(replayDir, 'replay.override.json')
    await writeFile(replayFixture, FIXTURE.log)
    await writeFile(replayOverride, JSON.stringify([{
      kind: 'chunks',
      chunks: STREAM_CHUNKS,
    } satisfies ReplayEntry]))
    scaffold = await launchWebScaffold({
      paceMs: 10,
      replayFixture,
      replayOverride,
    })
    await seedSession(scaffold, FIXTURE.log, SESSION_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser, 900)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // The compact layout dropped group session counts; the seeded baseline is
    // the Ungrouped bucket once cold summaries load.
    await page.getByText('Ungrouped', { exact: true }).waitFor({ timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(replayDir, { recursive: true, force: true })
  })

  it.skipIf(MODE === 'record')('retains identity on prepend and reaches the bounded virtual range', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-trajectory-virtualization'))
    await openSeed(page)

    let held = false
    let releaseHistory: () => void = () => {}
    let finishHeldRequest: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseHistory = resolve })
    const heldRequestFinished = new Promise<void>((resolve) => { finishHeldRequest = resolve })
    await page.route('**/api/session/page', async (route) => {
      const request = route.request().postDataJSON() as {
        method?: string
        payload?: { args?: { request?: { beforeSeq?: number } } }
      }
      if (!held && request.method === 'session/page'
        && request.payload?.args?.request?.beforeSeq !== undefined) {
        held = true
        await gate
        try {
          await route.continue()
        } finally {
          finishHeldRequest()
        }
        return
      }
      await route.continue()
    })

    try {
      await openTrajectory(page)
      const initialRows = await logicalRows(page)
      expect(initialRows).toBeGreaterThan(0)
      expect(await page.getByText('Initial System Prompt', { exact: true }).count()).toBe(0)
      expect(await mountedRows(page)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS)

      const loadMore = page.locator('[data-history-load] button')
      await loadMore.waitFor({ timeout: 15_000 })
      expect(await loadMore.textContent()).toBe('Load earlier history')
      const loadMoreSnapshot = await captureStableAria(
        page,
        '[data-history-load]',
        scaffold.workspaceCwd,
      )
      await compareOrRefreshGolden(LOAD_MORE_EXPECTED, loadMoreSnapshot, MODE)
      // Avoid Playwright scrolling the offscreen first row into the automatic-load threshold.
      await loadMore.evaluate((button: HTMLButtonElement) => { button.click() })
      await expect.poll(() => logicalRows(page), { timeout: 15_000 }).toBeGreaterThan(initialRows)
      const residentRows = await logicalRows(page)
      expect(held).toBe(false)
      await expect.poll(() => loadMore.isDisabled(), { timeout: 15_000 }).toBe(false)
      await loadMore.evaluate((button: HTMLButtonElement) => { button.click() })
      await expect.poll(() => held, { timeout: 15_000 }).toBe(true)
      await expect.poll(async () => ({
        disabled: await loadMore.isDisabled(),
        label: await loadMore.getAttribute('aria-label'),
      }), { timeout: 15_000 }).toEqual({
        disabled: true,
        label: 'Loading earlier history…',
      })

      await scrollToRatio(page, 0)
      const anchor = await firstVisibleRow(page)
      const selectedRow = page.locator(
        `[data-trajectory-scroll] tr[data-trajectory-row-key=${JSON.stringify(anchor.key)}]`,
      )
      await selectedRow.click()
      await expect.poll(() => selectedRow.getAttribute('aria-selected'), { timeout: 10_000 })
        .toBe('true')

      releaseHistory()
      await expect.poll(() => logicalRows(page), { timeout: 60_000 }).toBeGreaterThan(residentRows)
      await nextPaint(page)
      await expect.poll(async () => {
        const top = await rowTop(page, anchor.key)
        return top === null ? Number.POSITIVE_INFINITY : Math.abs(top - anchor.top)
      }, { timeout: 15_000 }).toBeLessThanOrEqual(GEOMETRY_TOLERANCE)
      await expect.poll(() => selectedRow.getAttribute('aria-selected'), { timeout: 10_000 })
        .toBe('true')
      expect(await mountedRows(page)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS)

      await loadToFirstTurn(page)
      await expect.poll(
        () => page.getByText(FIXTURE.markers.user(1), { exact: false }).count(),
        { timeout: 10_000 },
      ).toBeGreaterThan(0)
      const fullRows = await logicalRows(page)

      await scrollToRatio(page, 0.5)
      const middle = await geometry(page)
      const maximum = middle.scrollHeight - middle.clientHeight
      expect(middle.scrollTop).toBeGreaterThan(maximum * 0.25)
      expect(middle.scrollTop).toBeLessThan(maximum * 0.75)
      expect(await mountedRows(page)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS)
      expect(await mountedRows(page)).toBeLessThan(fullRows)

      await scrollToRatio(page, 1)
      await expect.poll(async () => {
        const value = await geometry(page)
        return value.scrollHeight - value.clientHeight - value.scrollTop
      }, { timeout: 10_000 }).toBeLessThanOrEqual(GEOMETRY_TOLERANCE)
      await expect.poll(
        () => page.getByText(FIXTURE.markers.assistant(FIXTURE.turns), { exact: false }).count(),
        { timeout: 10_000 },
      ).toBeGreaterThan(0)
      expect(await mountedRows(page)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS)

      const trajectoryScroll = page.locator('[data-trajectory-scroll]')
      await trajectoryScroll.evaluate((host) => {
        const measuredWindow = window as Window & { __trajectoryScrollCalls?: number }
        measuredWindow.__trajectoryScrollCalls = 0
        const original = host.scrollTo.bind(host)
        const trackedScrollTo = (...args: [ScrollToOptions?] | [number, number]) => {
          measuredWindow.__trajectoryScrollCalls = (measuredWindow.__trajectoryScrollCalls ?? 0) + 1
          Reflect.apply(original, host, args)
        }
        host.scrollTo = trackedScrollTo as typeof host.scrollTo
      })
      const settled = scaffold.whenTurnSettled()
      const input = page.locator('[data-composer-input]').first()
      await input.fill('Stream one deterministic response while Trajectory remains visible.')
      await input.press('Enter')
      await settled
      await page.getByText('stream fragment 01', { exact: false }).waitFor({ timeout: 30_000 })
      await nextPaint(page)
      const streamingScrollCalls = await trajectoryScroll.evaluate(() => {
        return (window as Window & { __trajectoryScrollCalls?: number })
          .__trajectoryScrollCalls ?? 0
      })
      expect(streamingScrollCalls).toBeLessThanOrEqual(5)
      expect(await mountedRows(page)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS)
      expect({
        pageErrors: tripwire.pageErrors,
        warnings: tripwire.warnings,
      }).toEqual({ pageErrors: [], warnings: [] })
    } finally {
      releaseHistory()
      if (held) await heldRequestFinished
      await page.unroute('**/api/session/page')
    }
  }, 180_000)
})
