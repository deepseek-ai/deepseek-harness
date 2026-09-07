// Browser geometry contracts for a long Chat transcript. These scenarios are
// deliberately virtualizer-neutral: they assert semantic-row position,
// bottom ownership, interaction state, and the real outer scroll host rather
// than DOM cardinality or implementation-specific spacer markup.
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { ReplayEntry, ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createChatScrollFixture, type ChatScrollFixture } from './chat-scroll-fixture.ts'
import {
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const HISTORY_SESSION_ID = 'chat-scroll-history-e2e'
const TOOL_SESSION_ID = 'chat-scroll-tool-e2e'
const RESTORE_SESSION_A_ID = 'chat-scroll-restore-a-e2e'
const RESTORE_SESSION_B_ID = 'chat-scroll-restore-b-e2e'
const REPLAY_CONTEXT_WINDOW = 10_000_000
const STREAM_PACE_MS = 24
const GEOMETRY_TOLERANCE = 2
const RESPONSIVE_REFLOW_TOLERANCE = 32
const LIVE_TEXT_PROMPT = 'CHAT_SCROLL_LIVE_USER Continue this long conversation while I inspect older history.'
const LIVE_TEXT_FIRST = 'CHAT_SCROLL_LIVE_FIRST'
const LIVE_TEXT_DONE = 'CHAT_SCROLL_LIVE_DONE'
const LIVE_TOOL_PROMPT = 'CHAT_SCROLL_TOOL_USER Run the requested diagnostic and then summarize it.'
const LIVE_TOOL_CALL_ID = ToolCallId('chat-scroll-live-tool-call')
const LIVE_TOOL_RESULT = 'CHAT_SCROLL_LIVE_TOOL_RESULT'
const LIVE_TOOL_FIRST = 'CHAT_SCROLL_TOOL_STREAM_FIRST'
const LIVE_TOOL_DONE = 'CHAT_SCROLL_TOOL_STREAM_DONE'
const TOOL_READY_FILE = '.chat-scroll-tool-ready'
const TOOL_RELEASE_FILE = '.chat-scroll-tool-release'
const INPUTS_SESSION_ID = 'chat-scroll-inputs-e2e'
const RAIL_SESSION_ID = 'chat-scroll-rail-e2e'
const FLING_SESSION_ID = 'chat-scroll-fling-e2e'
const LIVE_FLING_PROMPT = 'CHAT_SCROLL_FLING_USER Keep streaming while I fling back through older output.'
const LIVE_FLING_FIRST = 'CHAT_SCROLL_FLING_STREAM_FIRST'
const LIVE_FLING_DONE = 'CHAT_SCROLL_FLING_STREAM_DONE'

const HISTORY_FIXTURE = createChatScrollFixture({
  markerPrefix: 'HISTORY',
  title: 'CHAT_SCROLL_HISTORY long paging session',
})
const TOOL_FIXTURE = createChatScrollFixture({
  markerPrefix: 'TOOL',
  title: 'CHAT_SCROLL_TOOL live tool session',
})
const RESTORE_FIXTURE_A = createChatScrollFixture({
  markerPrefix: 'RESTORE_A',
  title: 'CHAT_SCROLL_RESTORE_A long session',
})
const RESTORE_FIXTURE_B = createChatScrollFixture({
  markerPrefix: 'RESTORE_B',
  title: 'CHAT_SCROLL_RESTORE_B comparison session',
  turns: 32,
})
const INPUTS_FIXTURE = createChatScrollFixture({
  markerPrefix: 'INPUTS',
  title: 'CHAT_SCROLL_INPUTS non-wheel reader input session',
})

interface ScrollGeometry {
  readonly distanceFromBottom: number
  readonly scrollTop: number
}

interface FlowAnchor {
  readonly key: string
  readonly top: number
}

interface ScrollWorld {
  readonly assistantFrames: AssistantStreamFrame[]
  readonly events: SessionEvent[]
  readonly page: Page
  readonly replayDir?: string
  readonly scaffold: WebScaffold
  readonly tripwire: ReturnType<typeof watchConsole>
}

interface ScrollWorldOptions {
  readonly failureShot: string
  readonly replay?: ReplayOverrideDoc
  readonly seeds: readonly { fixture: ChatScrollFixture; id: string }[]
}

function textStream(first: string, done: string, deltaCount: number): StreamChunk[] {
  const deltas = Array.from({ length: deltaCount }, (_, index) => {
    if (index === 0) return `${first} `
    if (index === deltaCount - 1) return `${done}.`
    return `stream-chunk-${String(index).padStart(3, '0')} ${'incremental response '.repeat(3)}`
  })
  const response = deltas.join('')
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...deltas.map(text => ({ type: 'text-delta' as const, index: 0, text })),
    { type: 'block-end', index: 0, block: { type: 'text', text: response } },
    {
      type: 'usage',
      usage: { inputTokens: 512, outputTokens: Math.ceil(response.length / 4) },
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolStream(): StreamChunk[] {
  const command = [
    `: > ${TOOL_READY_FILE}`,
    `while [ ! -f ${TOOL_RELEASE_FILE} ]; do sleep 0.02; done`,
    'line=1',
    `while [ "$line" -le 64 ]; do printf '${LIVE_TOOL_RESULT} line %02d\\n' "$line"; line=$((line + 1)); done`,
  ].join('; ')
  const args = JSON.stringify({ command, description: LIVE_TOOL_RESULT })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'tool-call-delta',
      index: 0,
      id: LIVE_TOOL_CALL_ID,
      name: 'bash',
      argumentsDelta: args,
    },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: LIVE_TOOL_CALL_ID, name: 'bash', arguments: args },
    },
    { type: 'usage', usage: { inputTokens: 256, outputTokens: 48 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function replayEntry(chunks: StreamChunk[]): ReplayEntry {
  return { kind: 'chunks', chunks }
}

async function launchScrollWorld(options: ScrollWorldOptions): Promise<ScrollWorld> {
  let replayDir: string | undefined
  let scaffold: WebScaffold | undefined
  let page: Page | undefined
  try {
    if (options.replay !== undefined) {
      replayDir = await mkdtemp(join(tmpdir(), 'dsh-chat-scroll-replay-'))
      const replayOverride = join(replayDir, 'replay.override.json')
      await writeFile(replayOverride, JSON.stringify(options.replay))
      scaffold = await launchWebScaffold({
        replayFixture: join(replayDir, 'override-only.jsonl'),
        replayOverride,
        paceMs: STREAM_PACE_MS,
        replayContextWindow: REPLAY_CONTEXT_WINDOW,
      })
    } else {
      scaffold = await launchWebScaffold({})
    }
    for (const seed of options.seeds) await seedSession(scaffold, seed.fixture.log, seed.id)
    const events: SessionEvent[] = []
    const assistantFrames: AssistantStreamFrame[] = []
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
    scaffold.ctx.on('agent/assistant-stream', ({ frame }) => { assistantFrames.push(frame) })
    page = await newEnglishPage(browser, 900)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // Session-list bootstrap can replace the controlled search state. Wait
    // for the seeded baseline before openSeed starts the lazy content query
    // (the compact layout dropped group session counts; the Ungrouped bucket
    // row is the barrier).
    await page.getByText('Ungrouped', { exact: true }).waitFor({ timeout: 30_000 })
    return {
      assistantFrames,
      events,
      page,
      scaffold,
      tripwire,
      ...(replayDir === undefined ? {} : { replayDir }),
    }
  } catch (error) {
    const failures: unknown[] = [error]
    if (page !== undefined) await page.context().close().catch((cleanupError: unknown) => failures.push(cleanupError))
    if (scaffold !== undefined) await scaffold.close().catch((cleanupError: unknown) => failures.push(cleanupError))
    if (replayDir !== undefined) {
      await rm(replayDir, { recursive: true, force: true }).catch((cleanupError: unknown) => failures.push(cleanupError))
    }
    if (failures.length === 1) throw error
    throw new AggregateError(failures, 'chat-scroll browser world setup failed and cleanup was incomplete')
  }
}

async function closeScrollWorld(world: ScrollWorld): Promise<void> {
  const failures: unknown[] = []
  // newEnglishPage/browser.newPage owns an isolated context. Close the whole
  // context so its SSE connection and cache cannot leak into the next world
  // in this file's shared Chromium process.
  await world.page.context().close().catch((error: unknown) => failures.push(error))
  await world.scaffold.close().catch((error: unknown) => failures.push(error))
  if (world.replayDir !== undefined) {
    await rm(world.replayDir, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'chat-scroll browser world cleanup failed')
}

async function withScrollWorld(
  options: ScrollWorldOptions,
  run: (world: ScrollWorld) => Promise<void>,
): Promise<void> {
  const world = await launchScrollWorld(options)
  let runFailure: unknown
  try {
    await run(world)
  } catch (error) {
    runFailure = error
    try {
      await saveFailureShot(world.page, options.failureShot)
    } catch {
      // Best-effort evidence must never prevent cleanup of the owned world.
    }
  }
  let cleanupFailure: unknown
  try {
    await closeScrollWorld(world)
  } catch (error) {
    cleanupFailure = error
  }
  if (runFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError([runFailure, cleanupFailure], 'chat-scroll scenario and cleanup both failed')
  }
  if (runFailure !== undefined) throw runFailure
  if (cleanupFailure !== undefined) throw cleanupFailure
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>(resolve => requestAnimationFrame(() => {
      requestAnimationFrame(() => { resolve() })
    }))
  })
}

function scrollGeometry(page: Page): Promise<ScrollGeometry> {
  return page.locator('[data-conversation-scroll]').evaluate(host => ({
    distanceFromBottom: host.scrollHeight - host.clientHeight - host.scrollTop,
    scrollTop: host.scrollTop,
  }))
}

/**
 * Rendered transcript rows in the loaded window. The stats strip cannot serve
 * as this probe: its turn/step counts ride the whole-log sessionStats
 * projection and stay fixed across paging by design, while the row count is
 * exactly what grows when an older page prepends or a live turn streams in.
 * @param page - the scenario page.
 * @returns the number of mounted chat flow rows.
 */
async function loadedFlowRows(page: Page): Promise<number> {
  return page.locator('[data-chat-flow-key]').count()
}

async function openSeed(page: Page, fixture: ChatScrollFixture, tailMarker?: string): Promise<void> {
  // Search collapsed into a header action; expand it before filling.
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  const search = page.getByRole('textbox', { name: 'Search sessions...', exact: true })
  // Cold summaries initially show the temporary workspace basename, so the
  // persisted first-prompt marker is the stable user-facing identity. The
  // query itself triggers lazy content-index reconciliation; no transient
  // empty-state paint is used as a barrier.
  await search.fill(fixture.markers.user(1))
  const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => results.count(), { timeout: 60_000 }).toBe(1)
  await results.click()
  await page.getByRole('tab', { name: 'Chat', exact: true }).waitFor({ timeout: 30_000 })
  if (tailMarker !== undefined) {
    await page.getByText(tailMarker, { exact: false }).last().waitFor({ timeout: 30_000 })
  }
  await nextPaint(page)
}

async function wheelTranscript(page: Page, deltaY: number): Promise<void> {
  const box = await page.locator('[data-conversation-scroll]').boundingBox()
  if (box === null) throw new Error('conversation scrollport has no layout box')
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(140, box.height / 3))
  await page.mouse.wheel(0, deltaY)
  await nextPaint(page)
}

/**
 * Touch-style momentum fling over the transcript. Headless Chromium in the
 * test lane cannot synthesize device scrolling (Input.synthesizeScrollGesture
 * and Input.dispatchTouchEvent both deliver DOM events without moving any
 * scroller, and compositor scrollbars ignore synthetic mouse input), so the
 * fling replays the signature a real pan leaves on the scrollport: per-frame
 * decaying displacements the component never authored, carrying no wheel
 * events. Wheel-sign semantics: positive deltaY reads downward.
 */
async function flingTranscript(page: Page, deltaY: number): Promise<void> {
  await page.locator('[data-conversation-scroll]').evaluate(async (host, delta) => {
    const direction = Math.sign(delta)
    let remaining = Math.abs(delta)
    // Fast launch decaying toward a floor speed, like a released finger. The
    // floor stays above the follow threshold so contended frames (streaming
    // writes racing the fling) still deviate far enough to read as input.
    let velocity = Math.max(120, remaining / 8)
    while (remaining > 0) {
      const step = Math.min(velocity, remaining)
      host.scrollTop += direction * step
      remaining -= step
      velocity = Math.max(48, velocity * 0.9)
      await new Promise<void>(resolve => requestAnimationFrame(() => { resolve() }))
    }
  }, deltaY)
  await nextPaint(page)
}

async function wheelToHistoryStart(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if ((await scrollGeometry(page)).scrollTop <= 1) break
    await wheelTranscript(page, -2_400)
  }
  await expect.poll(async () => (await scrollGeometry(page)).scrollTop, { timeout: 10_000 })
    .toBeLessThanOrEqual(1)
}

async function wheelUntilMounted(page: Page, selector: string, deltaY: number): Promise<void> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    if (await page.locator(selector).count() > 0) return
    await wheelTranscript(page, deltaY)
  }
  throw new Error(`selector did not mount during transcript wheel: ${selector}`)
}

async function wheelUntilVisible(page: Page, selector: string, deltaY: number): Promise<void> {
  const target = page.locator(selector)
  for (let attempt = 0; attempt < 32; attempt += 1) {
    if (await target.count() > 0 && await target.evaluate((row) => {
      const host = row.closest<HTMLElement>('[data-conversation-scroll]')
      if (host === null) return false
      const viewport = host.getBoundingClientRect()
      const composer = host.querySelector<HTMLElement>('[data-composer-seat]')
      const visibleBottom = composer?.getBoundingClientRect().top ?? viewport.bottom
      const rect = row.getBoundingClientRect()
      return rect.bottom > viewport.top && rect.top < visibleBottom
    })) return
    await wheelTranscript(page, deltaY)
  }
  throw new Error(`selector did not become visible during transcript wheel: ${selector}`)
}

function visibleFlowAnchor(page: Page): Promise<FlowAnchor> {
  return page.locator('[data-conversation-scroll]').evaluate((host) => {
    const rows = [...host.querySelectorAll<HTMLElement>('[data-chat-anchor-key]:not([hidden])')]
    const viewport = host.getBoundingClientRect()
    const composer = host.querySelector<HTMLElement>('[data-composer-seat]')
    const visibleBottom = composer?.getBoundingClientRect().top ?? viewport.bottom
    const visible = rows.filter((candidate) => {
      const rect = candidate.getBoundingClientRect()
      return rect.bottom > viewport.top && rect.top < visibleBottom
    })
    const row = visible[0]
    if (row?.dataset.chatAnchorKey === undefined) {
      throw new Error(`no visible settled Chat row: ${JSON.stringify({
        composerTop: visibleBottom,
        host: { bottom: viewport.bottom, top: viewport.top },
        rows: rows.slice(0, 4).map(candidate => ({
          callId: candidate.dataset.chatCallId,
          key: candidate.dataset.chatAnchorKey,
          rect: {
            bottom: candidate.getBoundingClientRect().bottom,
            top: candidate.getBoundingClientRect().top,
          },
        })),
        totalRows: rows.length,
      })}`)
    }
    return {
      key: row.dataset.chatAnchorKey,
      top: row.getBoundingClientRect().top - viewport.top,
    }
  })
}

function flowTop(page: Page, key: string): Promise<number> {
  return page.locator('[data-chat-anchor-key]').evaluateAll((rows, anchorKey) => {
    const row = rows.find(candidate => (candidate as HTMLElement).dataset.chatAnchorKey === anchorKey)
    if (!(row instanceof HTMLElement)) throw new Error(`stable Chat anchor ${anchorKey} is not mounted`)
    const host = row.closest('[data-conversation-scroll]')
    if (!(host instanceof HTMLElement)) throw new Error('flow row has no conversation scrollport')
    return row.getBoundingClientRect().top - host.getBoundingClientRect().top
  }, key)
}

async function expectSameFlowTop(
  page: Page,
  anchor: FlowAnchor,
  tolerance = GEOMETRY_TOLERANCE,
): Promise<void> {
  await expect.poll(async () => Math.abs((await flowTop(page, anchor.key)) - anchor.top), {
    timeout: 10_000,
    message: `flow row ${anchor.key} moved relative to the transcript viewport`,
  }).toBeLessThanOrEqual(tolerance)
}

async function expectBottom(page: Page): Promise<void> {
  await expect.poll(async () => Math.abs((await scrollGeometry(page)).distanceFromBottom), {
    timeout: 10_000,
  }).toBeLessThanOrEqual(1)
}

async function expectMarkerAboveComposer(page: Page, marker: string): Promise<void> {
  const geometry = await page.getByText(marker, { exact: false }).last().evaluate((node) => {
    const row = node.closest('[data-chat-flow-key], [data-streaming]')
    const composer = node.closest('[data-conversation-scroll]')?.querySelector('[data-composer-seat]')
    if (!(row instanceof HTMLElement) || !(composer instanceof HTMLElement)) {
      throw new Error('latest marker or composer geometry is unavailable')
    }
    return {
      composerTop: composer.getBoundingClientRect().top,
      rowBottom: row.getBoundingClientRect().bottom,
    }
  })
  expect(geometry.rowBottom).toBeLessThanOrEqual(geometry.composerTop + GEOMETRY_TOLERANCE)
}

async function loadEarlierWithAnchor(page: Page): Promise<void> {
  await wheelToHistoryStart(page)
  const older = page.getByRole('button', { name: 'Load earlier', exact: true })
  const loading = page.getByRole('button', { name: 'Loading…', exact: true })
  await older.waitFor({ timeout: 10_000 })
  const anchor = await visibleFlowAnchor(page)
  const before = await loadedFlowRows(page)
  await older.click()
  await expect.poll(async () => (
    await loadedFlowRows(page) > before && await loading.count() === 0
  ), { timeout: 30_000 }).toBe(true)
  await nextPaint(page)
  if (await page.getByRole('button', { name: 'Load earlier', exact: true }).count() === 0) {
    expect(await page.locator('[data-turn-process][aria-expanded="false"]').count()).toBeGreaterThan(0)
    return
  }
  await expectSameFlowTop(page, anchor)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function eventCarries(event: SessionEvent, marker: string): boolean {
  return JSON.stringify(event).includes(marker)
}

function assertClean(world: ScrollWorld): void {
  expect(world.tripwire.pageErrors).toEqual([])
  expect(world.tripwire.warnings).toEqual([])
}

let browser: Browser

describe('web e2e: long Chat scroll contract', () => {
  beforeAll(async () => {
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
  })

  it.skipIf(MODE === 'record')('preserves the reader anchor when history and streaming arrive concurrently', async () => {
    await withScrollWorld({
      failureShot: 'web-e2e-chat-scroll-history-stream',
      replay: [replayEntry(textStream(LIVE_TEXT_FIRST, LIVE_TEXT_DONE, 120))],
      seeds: [{ fixture: HISTORY_FIXTURE, id: HISTORY_SESSION_ID }],
    }, async (world) => {
      await openSeed(
        world.page,
        HISTORY_FIXTURE,
        HISTORY_FIXTURE.markers.assistant(HISTORY_FIXTURE.turns),
      )
      await expectBottom(world.page)

      let releaseHistory = (): void => {}
      let held = false
      let releaseGate: (() => void) | undefined
      const gate = new Promise<void>((resolve) => { releaseGate = resolve })
      releaseHistory = () => { releaseGate?.() }
      await world.page.route('**/api/session/page', async (route) => {
        const request = route.request().postDataJSON() as {
          method?: string
          payload?: { args?: { request?: { beforeSeq?: number } } }
        }
        if (!held && request.method === 'session/page'
          && request.payload?.args?.request?.beforeSeq !== undefined) {
          held = true
          await gate
        }
        await route.continue()
      })

      const settled = world.scaffold.whenTurnSettled(60_000)
      try {
        const composer = world.page.locator('[data-composer-input][contenteditable="true"]').last()
        await composer.fill(LIVE_TEXT_PROMPT)
        await world.page.getByRole('button', { name: 'Send message', exact: true }).click()
        await world.page.getByText(LIVE_TEXT_FIRST, { exact: false }).last().waitFor({ timeout: 15_000 })
        await wheelToHistoryStart(world.page)
        const beforeRows = await loadedFlowRows(world.page)
        await world.page.getByRole('button', { name: 'Load earlier', exact: true }).click()
        await expect.poll(() => held, { timeout: 10_000 }).toBe(true)

        await wheelTranscript(world.page, 420)
        const readerAnchor = await visibleFlowAnchor(world.page)
        const chunksAfterAnchor = world.assistantFrames.filter(frame => frame.type === 'chunk').length
        await expect.poll(
          () => world.assistantFrames.filter(frame => frame.type === 'chunk').length,
          { timeout: 10_000 },
        ).toBeGreaterThan(chunksAfterAnchor + 5)

        releaseHistory()
        await expect.poll(() => loadedFlowRows(world.page), { timeout: 30_000 }).toBeGreaterThan(beforeRows)
        await nextPaint(world.page)
        await expectSameFlowTop(world.page, readerAnchor)
      } finally {
        releaseHistory()
      }

      await settled
      await expect.poll(() => world.page.locator('[data-streaming="true"]').count(), { timeout: 15_000 }).toBe(0)
      await world.page.getByText(LIVE_TEXT_DONE, { exact: false }).last().waitFor({ timeout: 15_000 })
      await world.page.unroute('**/api/session/page')

      let additionalPages = 0
      while (additionalPages < 8) {
        await wheelToHistoryStart(world.page)
        if (await world.page.getByRole('button', { name: 'Load earlier', exact: true }).count() === 0) break
        await loadEarlierWithAnchor(world.page)
        additionalPages += 1
      }
      expect(additionalPages).toBeGreaterThan(0)
      // The whole log is loaded: turn 1's unique marker renders in the
      // transcript (scoped: the sidebar search row also carries it) and no
      // page remains.
      expect(await world.page.locator('[data-conversation-scroll]')
        .getByText(HISTORY_FIXTURE.markers.user(1), { exact: false }).count()).toBe(1)
      expect(await world.page.getByRole('button', { name: 'Load earlier', exact: true }).count()).toBe(0)
      assertClean(world)
    })
  }, 180_000)

  it.skipIf(MODE === 'record')('offers every outline turn on the rail and jumps to an unloaded one', async () => {
    await withScrollWorld({
      failureShot: 'web-e2e-turn-rail-jump',
      seeds: [{ fixture: HISTORY_FIXTURE, id: RAIL_SESSION_ID }],
    }, async (world) => {
      await openSeed(world.page, HISTORY_FIXTURE, HISTORY_FIXTURE.markers.assistant(HISTORY_FIXTURE.turns))
      await expectBottom(world.page)

      // The whole-log outline reaches the rail before any paging: one mark
      // per fixture turn, the oldest still in its load-and-jump form.
      const rail = world.page.getByRole('navigation', { name: 'Turn navigation' })
      await expect.poll(() => rail.getByRole('button').count(), { timeout: 15_000 })
        .toBe(HISTORY_FIXTURE.turns)
      const firstUnloaded = rail.getByRole('button', { name: 'Load and jump to turn 1', exact: true })
      expect(await firstUnloaded.count()).toBe(1)
      // Fixed pitch: the ladder keeps its natural height, scrolls inside the
      // frame, and (following the active tail mark) fades its upper end.
      expect(await rail.evaluate(nav => nav.style.getPropertyValue('--turn-natural-height')))
        .toBe(`${String((HISTORY_FIXTURE.turns - 1) * 10 + 12)}px`)
      const railScroller = rail.locator('[class*="scroller"]')
      await expect.poll(() => railScroller.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
      await expect.poll(() => rail.locator('[class*="fadeTop"]').count(), { timeout: 15_000 }).toBe(1)

      // Activate the unloaded mark by keyboard: pointer input belongs to the
      // rail frame, while each mark is the keyboard/AT destination. Focus
      // first shows the outline-backed preview: prompt and settled response
      // both travel ahead of the events.
      const beforeRows = await loadedFlowRows(world.page)
      await firstUnloaded.focus()
      const tooltip = world.page.getByRole('tooltip')
      await expect.poll(() => tooltip.count(), { timeout: 15_000 }).toBe(1)
      expect(await tooltip.textContent()).toContain(HISTORY_FIXTURE.markers.user(1))
      expect(await tooltip.textContent()).toContain(HISTORY_FIXTURE.markers.assistant(1))
      const transcriptLayers = await tooltip.evaluate((preview) => {
        const railSlot = preview.closest('nav')?.parentElement
        const codeBanner = document.querySelector<HTMLElement>('.md-code-block > :first-child')
        if (!(railSlot instanceof HTMLElement) || codeBanner === null) {
          throw new Error('turn preview or code-block banner stacking context is unavailable')
        }
        return {
          codeBanner: Number(getComputedStyle(codeBanner).zIndex),
          rail: Number(getComputedStyle(railSlot).zIndex),
        }
      })
      expect(transcriptLayers.rail).toBeGreaterThan(transcriptLayers.codeBanner)
      await world.page.keyboard.press('Enter')

      // The jump pages history in and lands on turn 1: its mark flips to the
      // loaded label and becomes current, the window grew, and the turn-1
      // user row sits at the reading line.
      const firstLoaded = rail.getByRole('button', { name: 'Jump to turn 1', exact: true })
      await expect.poll(() => firstLoaded.count(), { timeout: 60_000 }).toBe(1)
      await expect.poll(() => firstLoaded.getAttribute('aria-current'), { timeout: 15_000 }).toBe('true')
      expect(await loadedFlowRows(world.page)).toBeGreaterThan(beforeRows)
      // Drop mark focus so its hover/focus preview (which echoes the prompt
      // marker) leaves the DOM before the transcript count below.
      await firstLoaded.evaluate((el) => { (el as HTMLElement).blur() })
      await expect.poll(() => world.page.getByRole('tooltip').count(), { timeout: 15_000 }).toBe(0)
      await nextPaint(world.page)
      const marker = world.page.locator('[data-conversation-scroll]')
        .getByText(HISTORY_FIXTURE.markers.user(1), { exact: false })
      expect(await marker.count()).toBe(1)
      const scrollport = await world.page.locator('[data-conversation-scroll]').boundingBox()
      const row = await marker.boundingBox()
      if (scrollport === null || row === null) throw new Error('turn-1 row or scrollport has no layout box')
      expect(row.y - scrollport.y).toBeGreaterThanOrEqual(0)
      expect(row.y - scrollport.y).toBeLessThanOrEqual(160)
      // The rail followed the landing to the ladder top, so the fade now
      // marks the other (downward) end.
      await expect.poll(() => rail.locator('[class*="fadeBottom"]').count(), { timeout: 15_000 }).toBe(1)
      assertClean(world)
    })
  }, 180_000)

  it.skipIf(MODE === 'record')('keeps streaming ownership and tool disclosure state across a long scroll-away cycle', async () => {
    await withScrollWorld({
      failureShot: 'web-e2e-chat-scroll-live-tool',
      replay: [
        replayEntry(toolStream()),
        replayEntry(textStream(LIVE_TOOL_FIRST, LIVE_TOOL_DONE, 84)),
      ],
      seeds: [{ fixture: TOOL_FIXTURE, id: TOOL_SESSION_ID }],
    }, async (world) => {
      const readyPath = join(world.scaffold.workspaceCwd, TOOL_READY_FILE)
      const releasePath = join(world.scaffold.workspaceCwd, TOOL_RELEASE_FILE)
      await openSeed(world.page, TOOL_FIXTURE, TOOL_FIXTURE.markers.assistant(TOOL_FIXTURE.turns))
      const settled = world.scaffold.whenTurnSettled(60_000)
      let released = false
      try {
        const composer = world.page.locator('[data-composer-input][contenteditable="true"]').last()
        await composer.fill(LIVE_TOOL_PROMPT)
        await world.page.getByRole('button', { name: 'Send message', exact: true }).click()
        await expect.poll(() => fileExists(readyPath), { timeout: 15_000 }).toBe(true)
        const liveRow = world.page.locator(`[data-chat-call-id="${LIVE_TOOL_CALL_ID}"] [data-sample="bash"]`)
        await liveRow.waitFor({ timeout: 15_000 })
        expect(await liveRow.getAttribute('data-state')).toBe('running')
        await expectBottom(world.page)
        expect(await world.page.getByRole('button', { name: 'Back to bottom', exact: true }).count()).toBe(0)

        await wheelTranscript(world.page, -1_200)
        await world.page.getByRole('button', { name: 'Back to bottom', exact: true }).waitFor({ timeout: 10_000 })
        const awayAnchor = await visibleFlowAnchor(world.page)
        const chunksBeforeRelease = world.assistantFrames.filter(frame => frame.type === 'chunk').length
        await writeFile(releasePath, 'release\n')
        released = true
        await expect.poll(
          () => world.assistantFrames.filter(frame => frame.type === 'chunk').length,
          { timeout: 15_000 },
        ).toBeGreaterThan(chunksBeforeRelease + 5)
        await nextPaint(world.page)
        // The loop appends tool/result before starting the next model request;
        // these synchronous Host listeners therefore observe it before later chunks.
        expect(world.events.some(event => event.type === 'tool/result')).toBe(true)
        expect(Math.abs((await flowTop(world.page, awayAnchor.key)) - awayAnchor.top))
          .toBeLessThanOrEqual(GEOMETRY_TOLERANCE)

        const chunksAtRepin = world.assistantFrames.filter(frame => frame.type === 'chunk').length
        await world.page.getByRole('button', { name: 'Back to bottom', exact: true }).click()
        await expect.poll(
          () => world.assistantFrames.filter(frame => frame.type === 'chunk').length,
          { timeout: 15_000 },
        ).toBeGreaterThan(chunksAtRepin + 5)
        await nextPaint(world.page)
        expect(Math.abs((await scrollGeometry(world.page)).distanceFromBottom)).toBeLessThanOrEqual(1)
      } finally {
        if (!released) await writeFile(releasePath, 'release\n').catch(() => {})
      }

      await settled
      expect(world.events.some(event => eventCarries(event, LIVE_TOOL_FIRST))).toBe(true)
      await expect.poll(() => world.page.locator('[data-streaming="true"]').count(), { timeout: 15_000 }).toBe(0)
      await world.page.getByText(LIVE_TOOL_DONE, { exact: false }).last().waitFor({ timeout: 15_000 })
      await expectBottom(world.page)
      await expectMarkerAboveComposer(world.page, LIVE_TOOL_DONE)

      const liveRowSelector = `[data-chat-call-id="${LIVE_TOOL_CALL_ID}"] [data-sample="bash"]`
      const liveRow = world.page.locator(liveRowSelector)
      await expandOwningTurnProcess(world.page, liveRow)
      await wheelUntilVisible(world.page, liveRowSelector, -300)
      const toolAnchor = await liveRow.evaluate((row) => {
        const flow = row.closest<HTMLElement>('[data-chat-anchor-key]')
        const host = row.closest<HTMLElement>('[data-conversation-scroll]')
        if (flow?.dataset.chatAnchorKey === undefined || host === null) {
          throw new Error('live tool row has no settled flow identity')
        }
        return {
          key: flow.dataset.chatAnchorKey,
          top: flow.getBoundingClientRect().top - host.getBoundingClientRect().top,
        }
      })
      await liveRow.click()
      await expect.poll(() => liveRow.getAttribute('aria-expanded'), { timeout: 10_000 }).toBe('true')
      await expectSameFlowTop(world.page, toolAnchor)
      await wheelToHistoryStart(world.page)
      await world.page.getByRole('button', { name: 'Back to bottom', exact: true }).click()
      await expectBottom(world.page)
      await wheelUntilMounted(world.page, liveRowSelector, -1_100)
      const restoredRow = world.page.locator(liveRowSelector)
      await restoredRow.waitFor({ timeout: 10_000 })
      expect(await restoredRow.getAttribute('aria-expanded')).toBe('true')
      expect(await world.page.getByText(LIVE_TOOL_RESULT, { exact: false }).count()).toBeGreaterThan(0)
      assertClean(world)
    })
  }, 180_000)

  it.skipIf(MODE === 'record')('restores tab/session position and keeps composer resizing on the correct scroll owner', async () => {
    await withScrollWorld({
      failureShot: 'web-e2e-chat-scroll-restore-composer',
      seeds: [
        { fixture: RESTORE_FIXTURE_A, id: RESTORE_SESSION_A_ID },
        { fixture: RESTORE_FIXTURE_B, id: RESTORE_SESSION_B_ID },
      ],
    }, async (world) => {
      await openSeed(
        world.page,
        RESTORE_FIXTURE_A,
        RESTORE_FIXTURE_A.markers.assistant(RESTORE_FIXTURE_A.turns),
      )
      await loadEarlierWithAnchor(world.page)
      await loadEarlierWithAnchor(world.page)
      await wheelToHistoryStart(world.page)
      await wheelTranscript(world.page, 1_300)
      const sessionAnchor = await visibleFlowAnchor(world.page)

      await world.page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
      await world.page.getByLabel('Trajectory timeline').waitFor({ timeout: 30_000 })
      await world.page.setViewportSize({ width: 700, height: 900 })
      // The narrow breakpoint auto-collapses the sidebar. Re-open it because
      // this scenario switches sessions while pinning the narrow Chat scroll owner.
      await world.page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
      await world.page.getByRole('tab', { name: 'Chat', exact: true }).click()
      await nextPaint(world.page)
      await expectSameFlowTop(world.page, sessionAnchor, RESPONSIVE_REFLOW_TOLERANCE)
      const narrowSessionAnchor = await visibleFlowAnchor(world.page)

      await openSeed(
        world.page,
        RESTORE_FIXTURE_B,
        RESTORE_FIXTURE_B.markers.assistant(RESTORE_FIXTURE_B.turns),
      )
      await openSeed(
        world.page,
        RESTORE_FIXTURE_A,
      )
      await expectSameFlowTop(world.page, narrowSessionAnchor)

      const backToBottom = world.page.getByRole('button', { name: 'Back to bottom', exact: true })
      await backToBottom.evaluate((button) => {
        if (!(button instanceof HTMLElement)) throw new Error('Back-to-bottom control is not an HTML element')
        button.click()
        const trajectory = [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
          .find(tab => tab.textContent?.trim() === 'Trajectory')
        if (!(trajectory instanceof HTMLElement)) {
          throw new Error('Trajectory tab is unavailable during pinned remount')
        }
        trajectory.click()
      })
      await world.page.getByLabel('Trajectory timeline').waitFor({ timeout: 30_000 })
      await world.page.getByRole('tab', { name: 'Chat', exact: true }).click()
      await expectBottom(world.page)
      await openSeed(
        world.page,
        RESTORE_FIXTURE_B,
        RESTORE_FIXTURE_B.markers.assistant(RESTORE_FIXTURE_B.turns),
      )
      await openSeed(
        world.page,
        RESTORE_FIXTURE_A,
        RESTORE_FIXTURE_A.markers.assistant(RESTORE_FIXTURE_A.turns),
      )
      await expectBottom(world.page)
      const composer = world.page.locator('[data-composer-input][contenteditable="true"]').last()
      const longDraft = Array.from(
        { length: 18 },
        (_, index) => `composer resize line ${String(index + 1).padStart(2, '0')}`,
      ).join('\n')
      await composer.fill(longDraft)
      await nextPaint(world.page)
      await expectBottom(world.page)
      await expectMarkerAboveComposer(
        world.page,
        RESTORE_FIXTURE_A.markers.assistant(RESTORE_FIXTURE_A.turns),
      )

      await composer.fill('short draft')
      await nextPaint(world.page)
      await wheelTranscript(world.page, -900)
      const resizeAnchor = await visibleFlowAnchor(world.page)
      await composer.fill(longDraft)
      await nextPaint(world.page)
      await expectSameFlowTop(world.page, resizeAnchor)
      await composer.fill('short draft')
      await nextPaint(world.page)
      await expectSameFlowTop(world.page, resizeAnchor)

      const beforeChain = await scrollGeometry(world.page)
      await composer.hover()
      await world.page.mouse.wheel(0, -320)
      await expect.poll(async () => (await scrollGeometry(world.page)).scrollTop, { timeout: 10_000 })
        .toBeLessThan(beforeChain.scrollTop)
      assertClean(world)
    })
  }, 180_000)

  // Keyboard is the only non-wheel device this lane's Chromium can drive for
  // real (see flingTranscript for the probe results on touch and scrollbars),
  // so it stands in for the whole hardware input pipeline here.
  it.skipIf(MODE === 'record')('keyboard paging owns bottom-follow without wheel input', async () => {
    await withScrollWorld({
      failureShot: 'web-e2e-chat-scroll-keyboard',
      seeds: [{ fixture: INPUTS_FIXTURE, id: INPUTS_SESSION_ID }],
    }, async (world) => {
      await openSeed(
        world.page,
        INPUTS_FIXTURE,
        INPUTS_FIXTURE.markers.assistant(INPUTS_FIXTURE.turns),
      )
      await expectBottom(world.page)
      const backToBottom = world.page.getByRole('button', { name: 'Back to bottom', exact: true })

      // Focus rides the last seeded tool row (a tabbable button whose keydown
      // handler passes scrolling keys through). End first normalizes the
      // focus-driven scrollIntoView back to the floor.
      const lastToolRow = world.page.locator(
        `[data-chat-call-id="chat-scroll-${String(INPUTS_FIXTURE.turns).padStart(3, '0')}-1"] [data-sample="bash"]`,
      )
      await expandOwningTurnProcess(world.page, lastToolRow)
      await lastToolRow.focus()
      await world.page.keyboard.press('End')
      await expectBottom(world.page)
      await expect.poll(() => backToBottom.count(), { timeout: 10_000 }).toBe(0)
      for (let press = 0; press < 3; press += 1) {
        await world.page.keyboard.press('PageUp')
        await nextPaint(world.page)
      }
      await backToBottom.waitFor({ timeout: 10_000 })
      await expect.poll(async () => (await scrollGeometry(world.page)).distanceFromBottom, { timeout: 10_000 })
        .toBeGreaterThan(100)
      await world.page.keyboard.press('End')
      await expectBottom(world.page)
      await expect.poll(() => backToBottom.count(), { timeout: 10_000 }).toBe(0)
      assertClean(world)
    })
  }, 180_000)

  it.skipIf(MODE === 'record')('touch-style fling scrolling owns streaming bottom-follow without wheel input', async () => {
    await withScrollWorld({
      failureShot: 'web-e2e-chat-scroll-fling-stream',
      replay: [
        replayEntry(toolStream()),
        replayEntry(textStream(LIVE_FLING_FIRST, LIVE_FLING_DONE, 240)),
      ],
      seeds: [{ fixture: INPUTS_FIXTURE, id: FLING_SESSION_ID }],
    }, async (world) => {
      const readyPath = join(world.scaffold.workspaceCwd, TOOL_READY_FILE)
      const releasePath = join(world.scaffold.workspaceCwd, TOOL_RELEASE_FILE)
      await openSeed(world.page, INPUTS_FIXTURE, INPUTS_FIXTURE.markers.assistant(INPUTS_FIXTURE.turns))
      const backToBottom = world.page.getByRole('button', { name: 'Back to bottom', exact: true })
      const settled = world.scaffold.whenTurnSettled(60_000)
      let released = false
      try {
        const composer = world.page.locator('[data-composer-input][contenteditable="true"]').last()
        await composer.fill(LIVE_FLING_PROMPT)
        await world.page.getByRole('button', { name: 'Send message', exact: true }).click()
        await expect.poll(() => fileExists(readyPath), { timeout: 15_000 }).toBe(true)
        await expectBottom(world.page)

        // Fling away while the turn is mid-flight: the scroll burst alone must
        // release bottom ownership, exactly like a wheel scroll would, even
        // while streaming keeps re-asserting the floor between frames.
        await flingTranscript(world.page, -900)
        await backToBottom.waitFor({ timeout: 10_000 })
        const awayAnchor = await visibleFlowAnchor(world.page)
        const chunksBeforeRelease = world.assistantFrames.filter(frame => frame.type === 'chunk').length
        await writeFile(releasePath, 'release\n')
        released = true
        await expect.poll(
          () => world.events.some(event => event.type === 'tool/result'),
          { timeout: 15_000 },
        ).toBe(true)
        await expect.poll(
          () => world.assistantFrames.filter(frame => frame.type === 'chunk').length,
          { timeout: 15_000 },
        ).toBeGreaterThan(chunksBeforeRelease + 5)
        await expectSameFlowTop(world.page, awayAnchor)

        // Fling back to the floor: re-pin must come from the reader's scroll
        // itself, and follow must then own the still-streaming tail. The
        // retry loop chases the floor that streaming keeps pushing down.
        for (let attempt = 0; attempt < 8; attempt += 1) {
          if ((await scrollGeometry(world.page)).distanceFromBottom <= 1) break
          await flingTranscript(world.page, 1_600)
        }
        await expectBottom(world.page)
        await expect.poll(() => backToBottom.count(), { timeout: 10_000 }).toBe(0)
        const chunksAtRepin = world.assistantFrames.filter(frame => frame.type === 'chunk').length
        await expect.poll(
          () => world.assistantFrames.filter(frame => frame.type === 'chunk').length,
          { timeout: 15_000 },
        ).toBeGreaterThan(chunksAtRepin + 5)
        await expectBottom(world.page)
      } finally {
        if (!released) await writeFile(releasePath, 'release\n').catch(() => {})
      }

      await settled
      await expect.poll(() => world.page.locator('[data-streaming="true"]').count(), { timeout: 15_000 }).toBe(0)
      await world.page.getByText(LIVE_FLING_DONE, { exact: false }).last().waitFor({ timeout: 15_000 })
      await expectBottom(world.page)
      assertClean(world)
    })
  }, 180_000)
})
