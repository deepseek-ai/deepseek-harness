/**
 * Blank-area matrix for "On next message" folding. A human message folds the
 * previous exchange's work details; each case records the largest band between
 * the scrollport top and the composer that no visible row covers, after the fold
 * settles, after the Turn the message started settles, and on every animation
 * frame in between. Cases cover the main Session and a subagent child Session
 * hosted in the right Sidebar, across reader positions and input origins.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page, Route } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import {
  SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq, type SessionEvent, type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { sessionFixtureName } from '@deepseek-ai/dsh-session-snapshot'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { createChatScrollFixture, type ChatScrollFixture } from './chat-scroll-fixture.ts'
import { launchWebScaffold, parseSeedFixture, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, openSettings } from './support.ts'

declare global {
  interface Window {
    foldProbe?: { readonly samples: Geometry[]; stop(): void }
    foldMeasure?: (root: string) => Geometry
  }
}

const MODE = webSnapshotMode()
const SEEDED_TURNS = 8
const SEEDED_STEPS = 6
const LIVE_STEPS = 6
/** Live Steps the steered Turn replays before the steering message is delivered. */
const STEER_STEPS = 3
const BLANK_LIMIT = 120
/**
 * Frames whose layout gap may exceed {@link BLANK_LIMIT}. The gap counts rows by their boxes, so a
 * closing row that has faded but not finished shrinking still covers its space.
 */
const TRANSIENT_FRAMES = 1
const EVIDENCE = fileURLToPath(new URL('../../../.artifacts/screenshots/fold-blank-matrix/', import.meta.url))
const MAIN_ROOT = '[data-conversation-scroll]:not([data-sidebar-chat] [data-conversation-scroll])'
const SIDE_ROOT = '[data-sidebar-chat] [data-conversation-scroll]'
const CHILD_LABEL = 'fold matrix child'
const READ_FILE = 'fold-matrix-notes.txt'
const NEXT_INPUT = 'FOLDMX_NEXT_INPUT'

/** Where the reader stands when the message is sent. */
type Reader =
  | { readonly kind: 'bottom' }
  | { readonly kind: 'marker'; readonly marker: string; readonly align: 'center' | 'top' }

const AT_BOTTOM: Reader = { kind: 'bottom' }
const SEEDED_MID_BODY: Reader = { kind: 'marker', marker: 'FOLDMX_BODY', align: 'center' }
const SEEDED_BODY_TOP: Reader = { kind: 'marker', marker: 'FOLDMX_BODY', align: 'top' }
const SEEDED_STEPS_READER: Reader = { kind: 'marker', marker: 'FOLDMX_STEP_4', align: 'top' }
const PREVIOUS_TURN: Reader = { kind: 'marker', marker: `FOLDMX_PREVIOUS_${SEEDED_TURNS - 1}`, align: 'top' }
const LIVE_MID_BODY: Reader = { kind: 'marker', marker: 'FOLDMX_LIVE_BODY', align: 'center' }

/**
 * How the folding message arrives.
 * - `composer`: this page's composer sends while the Session is idle.
 * - `error`: as `composer`, but the Turn fails before its user message is recorded.
 * - `other-tab`: a second page sends; this page receives it without a local echo.
 * - `queued`: this page queues the message while a long live Turn runs; it is delivered after that Turn ends.
 * - `steer`: as `queued`, but the queued message is steered into the running Turn.
 * - `parent-message`: the live parent Agent messages the child (side chat only).
 * - `big-exchange`: two parent messages wake long child Turns before the human message (side chat only).
 */
type Origin = 'composer' | 'error' | 'other-tab' | 'queued' | 'steer' | 'parent-message' | 'big-exchange'

interface Case {
  readonly id: string
  readonly surface: 'main' | 'side'
  readonly origin: Origin
  readonly reader: Reader
  readonly bodyParagraphs: number
  readonly mode: 'Detailed' | 'Standard'
  readonly timing: 'On next message' | 'On completion'
  /**
   * `tail`: the view ends at the floor. `reader`: the reader's anchor row keeps its screen position.
   */
  readonly landing: 'tail' | 'reader'
  /** The reader's anchor row is itself folded, so only the blank area is asserted. */
  readonly anchorFolds?: true
  /** Content above the viewport never slides back down, so a short body leaves room until newer content fills it. */
  readonly roomUntilReply?: true
}

const MAIN = {
  surface: 'main', origin: 'composer', bodyParagraphs: 40, mode: 'Detailed', timing: 'On next message', landing: 'tail',
} as const
const SIDE = { ...MAIN, surface: 'side' } as const

const CASES: readonly Case[] = [
  { ...MAIN, id: 'main/composer/bottom', reader: AT_BOTTOM },
  { ...MAIN, id: 'main/composer/mid-body', reader: SEEDED_MID_BODY },
  { ...MAIN, id: 'main/composer/body-top', reader: SEEDED_BODY_TOP },
  { ...MAIN, id: 'main/composer/steps', reader: SEEDED_STEPS_READER },
  { ...MAIN, id: 'main/composer/previous-turn', reader: PREVIOUS_TURN },
  { ...MAIN, id: 'main/composer/short-body/bottom', reader: AT_BOTTOM, bodyParagraphs: 2, roomUntilReply: true },
  { ...MAIN, id: 'main/composer/short-body/steps', reader: SEEDED_STEPS_READER, bodyParagraphs: 2, roomUntilReply: true },
  { ...MAIN, id: 'main/composer/short-body/previous-turn', reader: PREVIOUS_TURN, bodyParagraphs: 2 },
  { ...MAIN, id: 'main/error-before-message/bottom', origin: 'error', reader: AT_BOTTOM },
  { ...MAIN, id: 'main/error-before-message/mid-body', origin: 'error', reader: SEEDED_MID_BODY },
  { ...MAIN, id: 'main/other-tab/bottom', origin: 'other-tab', reader: AT_BOTTOM },
  { ...MAIN, id: 'main/other-tab/mid-body', origin: 'other-tab', reader: SEEDED_MID_BODY, landing: 'reader' },
  { ...MAIN, id: 'main/other-tab/steps', origin: 'other-tab', reader: SEEDED_STEPS_READER, landing: 'reader', anchorFolds: true },
  { ...MAIN, id: 'main/other-tab/previous-turn', origin: 'other-tab', reader: PREVIOUS_TURN, landing: 'reader' },
  { ...MAIN, id: 'main/queued/bottom', origin: 'queued', reader: AT_BOTTOM },
  { ...MAIN, id: 'main/queued/mid-body', origin: 'queued', reader: LIVE_MID_BODY, landing: 'reader' },
  // Control: steering joins the running Turn, which opens no exchange and folds nothing.
  { ...MAIN, id: 'main/steer/no-fold-control', origin: 'steer', reader: AT_BOTTOM },
  { ...MAIN, id: 'main/composer/standard/mid-body', reader: SEEDED_MID_BODY, mode: 'Standard' },
  { ...MAIN, id: 'main/composer/completion/mid-body', reader: SEEDED_MID_BODY, timing: 'On completion' },
  { ...SIDE, id: 'side/composer/bottom', reader: AT_BOTTOM },
  { ...SIDE, id: 'side/composer/mid-body', reader: SEEDED_MID_BODY },
  { ...SIDE, id: 'side/composer/steps', reader: SEEDED_STEPS_READER },
  { ...SIDE, id: 'side/composer/previous-turn', reader: PREVIOUS_TURN },
  { ...SIDE, id: 'side/queued/bottom', origin: 'queued', reader: AT_BOTTOM },
  { ...SIDE, id: 'side/queued/mid-body', origin: 'queued', reader: LIVE_MID_BODY, landing: 'reader' },
  // Control: a parent message is a notice, which opens no exchange and folds nothing.
  { ...SIDE, id: 'side/parent-message/no-fold-control', origin: 'parent-message', reader: SEEDED_MID_BODY, landing: 'reader' },
  { ...SIDE, id: 'side/big-exchange/bottom', origin: 'big-exchange', reader: AT_BOTTOM },
]

interface Geometry {
  readonly top: number
  readonly floor: number
  readonly spacer: number
  /** Largest band between the scrollport top and the composer that no visible row covers. */
  readonly maxGap: number
  readonly gapAt: number
  /** Empty height between the last visible row and the composer. */
  readonly tailGap: number
  readonly following: boolean
  /** A row was closing on this sample. */
  readonly collapsing: boolean
}

/** Installed into each measured page before load; reads one scrollport's blank-area geometry. */
function installMeasure(): void {
  window.foldMeasure = (root) => {
    const host = document.querySelector<HTMLElement>(root)
    if (host === null) throw new Error(`scrollport is absent: ${root}`)
    const viewport = host.getBoundingClientRect()
    const composer = host.querySelector<HTMLElement>('[data-composer-seat]')
    if (composer === null) throw new Error(`composer is absent: ${root}`)
    const composerTop = composer.getBoundingClientRect().top
    const spacer = host.querySelector<HTMLElement>('[data-chat-turn-spacer]')?.getBoundingClientRect().height ?? 0
    const intervals = [...host.querySelectorAll<HTMLElement>('[data-chat-flow-key], [data-submission-echo], [data-pending-steering], [data-streaming], [data-chat-running]')]
      .filter(element => element.closest('[hidden]') === null)
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return [Math.max(rect.top, viewport.top), Math.min(rect.bottom, composerTop)] as const
      })
      .filter(([top, bottom]) => bottom - top > 0.5)
      .sort((left, right) => left[0] - right[0])
    let cursor = viewport.top
    let maxGap = 0
    let gapAt = 0
    for (const [top, bottom] of intervals) {
      if (top - cursor > maxGap) {
        maxGap = top - cursor
        gapAt = cursor - viewport.top
      }
      cursor = Math.max(cursor, bottom)
    }
    if (composerTop - cursor > maxGap) {
      maxGap = composerTop - cursor
      gapAt = cursor - viewport.top
    }
    return {
      top: host.scrollTop, floor: Math.max(0, host.scrollHeight - host.clientHeight), spacer,
      maxGap, gapAt, tailGap: composerTop - cursor,
      following: host.querySelector('[data-chat-following-tail]') !== null,
      collapsing: host.querySelector('[data-chat-motion="collapse"]') !== null,
    }
  }
}

function paragraphs(marker: string, count: number, text: string): string {
  return `${marker}\n\n${Array.from({ length: count }, (_, line) => `${text} ${line}.`).join('\n\n')}`
}

/** Main-session log: settled Turns, then a long last Turn of expanded reasoning Steps and a final body. */
function seededFixture(id: string, bodyParagraphs: number): ChatScrollFixture {
  const base = createChatScrollFixture({ markerPrefix: 'FOLDMX', title: `FOLDMX ${id}`, turns: SEEDED_TURNS })
  const parsed = parseSeedFixture(base.log)
  const boundary = parsed.events.findIndex(event => event.type === 'turn/start' && event.data.turn === SEEDED_TURNS)
  const drafts: (SessionEvent | { type: string; data: object; surfaceOp?: 'append' })[] = parsed.events.slice(0, boundary)
    .map((event) => {
      if (event.type !== 'assistant/message' || event.data.turn !== SEEDED_TURNS - 1) return event
      return { ...event, data: { ...event.data, message: createAssistantMessage({
        content: [{ type: 'text', text: paragraphs(`FOLDMX_PREVIOUS_${SEEDED_TURNS - 1}`, 6, 'Previous Turn answer paragraph') }],
        source: { provider: 'fixture', model: 'fixture' },
      }) } }
    })
  drafts.push(
    { type: 'turn/start', data: { turn: SEEDED_TURNS } },
    { type: 'step/start', data: { turn: SEEDED_TURNS, step: 1 } },
    { type: 'user/message', data: createUserMessage({
      content: [{ type: 'text', text: 'FOLDMX_LAST_USER' }], source: { kind: 'user' },
    }), surfaceOp: 'append' },
  )
  for (let step = 1; step <= SEEDED_STEPS; step++) {
    if (step > 1) drafts.push({ type: 'step/start', data: { turn: SEEDED_TURNS, step } })
    drafts.push({ type: 'assistant/message', surfaceOp: 'append', data: {
      turn: SEEDED_TURNS, step, stream: [], message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: paragraphs(`FOLDMX_STEP_${step}`, 18, `Reasoning stage ${step} explains an intermediate decision, paragraph`) },
          { type: 'text', text: `FOLDMX_PROGRESS_${step}` },
        ],
        source: { provider: 'fixture', model: 'fixture' },
      }),
    } })
    drafts.push({ type: 'step/end', data: { turn: SEEDED_TURNS, step } })
  }
  drafts.push(
    { type: 'step/start', data: { turn: SEEDED_TURNS, step: SEEDED_STEPS + 1 } },
    { type: 'assistant/message', surfaceOp: 'append', data: {
      turn: SEEDED_TURNS, step: SEEDED_STEPS + 1, stream: [], message: createAssistantMessage({
        content: [{ type: 'text', text: paragraphs('FOLDMX_BODY', bodyParagraphs, 'Final answer paragraph that remains after the work details fold') }],
        source: { provider: 'fixture', model: 'fixture' },
      }),
    } },
    { type: 'step/end', data: { turn: SEEDED_TURNS, step: SEEDED_STEPS + 1 } },
    { type: 'turn/end', data: { turn: SEEDED_TURNS, reason: { kind: 'completed' } } },
  )
  return { ...base, log: [parsed.headerLine,
    ...drafts.map((event, seq) => JSON.stringify({ ...event, seq, time: seq + 1 })), ''].join('\n') }
}

function finish(kind: 'stop' | 'tool-calls'): StreamChunk[] {
  return [
    { type: 'usage', usage: { inputTokens: 512, outputTokens: 64 } },
    { type: 'finish', reason: { kind } },
  ]
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
  ]
}

function replyEntry(marker: string): ReplayEntry {
  return { kind: 'chunks', chunks: [...textChunks(`${marker} short answer.`), ...finish('stop')] }
}

/** One live Turn: Steps of narration plus a workspace read, then a long final body. */
function liveLongTurn(prefix: string): ReplayEntry[] {
  const entries: ReplayEntry[] = []
  for (let step = 1; step <= LIVE_STEPS; step++) {
    const id = ToolCallId(`${prefix.toLowerCase()}-read-${step}`)
    const args = JSON.stringify({ file_path: READ_FILE })
    entries.push({ kind: 'chunks', chunks: [
      ...textChunks(paragraphs(`${prefix}_STEP_${step}`, 10, `${prefix} narration for step ${step}, paragraph`)),
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id, name: 'read', argumentsDelta: args },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: 'read', arguments: args } },
      ...finish('tool-calls'),
    ] })
  }
  entries.push({ kind: 'chunks', chunks: [
    ...textChunks(paragraphs(prefix === 'FOLDMX_LIVE' ? 'FOLDMX_LIVE_BODY' : `${prefix}_BODY`, 40, `${prefix} final answer paragraph`)),
    ...finish('stop'),
  ] })
  return entries
}

function replayFor(scenario: Case): ReplayEntry[] {
  switch (scenario.origin) {
    case 'composer':
    case 'other-tab':
      return [replyEntry('FOLDMX_REPLY')]
    case 'queued':
      return [...liveLongTurn('FOLDMX_LIVE'), replyEntry('FOLDMX_REPLY')]
    case 'steer':
      return [...liveLongTurn('FOLDMX_LIVE').slice(0, STEER_STEPS), replyEntry('FOLDMX_STEERED')]
    case 'parent-message':
      return [replyEntry('FOLDMX_PARENT_REPLY')]
    case 'error':
      // The Turn fails before its model call; launchScaffold mounts only the provider catalog.
      return []
    case 'big-exchange':
      return [...liveLongTurn('FOLDMX_WAKE_A'), ...liveLongTurn('FOLDMX_WAKE_B'), replyEntry('FOLDMX_REPLY')]
  }
}

async function stableScroll(page: Page, root: string, timeoutMs = 20_000): Promise<void> {
  await page.evaluate(async ([selector, limit]) => {
    const host = document.querySelector<HTMLElement>(selector)
    if (host === null) throw new Error(`scrollport is absent: ${selector}`)
    let previous = host.scrollTop
    const started = performance.now()
    let stableSince = started
    await new Promise<void>((resolveStable, reject) => {
      const check = (): void => {
        const now = performance.now()
        const moving = host.querySelector('[data-chat-motion="collapse"], [data-chat-motion="reveal"]') !== null
        if (Math.abs(host.scrollTop - previous) > 0.25 || moving) stableSince = now
        previous = host.scrollTop
        if (now - stableSince >= 300) resolveStable()
        else if (now - started >= limit) reject(new Error(`scroll did not settle within ${String(limit)}ms: top ${String(host.scrollTop)}, motion ${String(moving)}`))
        else requestAnimationFrame(check)
      }
      requestAnimationFrame(check)
    })
  }, [root, timeoutMs] as const)
}

function measure(page: Page, root: string): Promise<Geometry> {
  return page.evaluate((selector) => {
    if (window.foldMeasure === undefined) throw new Error('fold measurement is not installed')
    return window.foldMeasure(selector)
  }, root)
}

async function startTrace(page: Page, root: string): Promise<void> {
  await page.evaluate((selector) => {
    const read = window.foldMeasure
    if (read === undefined) throw new Error('fold measurement is not installed')
    const samples: Geometry[] = []
    let frame = 0
    const tick = (): void => {
      // A scrollport can remount between frames; that frame contributes no sample.
      try { samples.push(read(selector)) } catch (_remounting) { /* skip this frame */ }
      frame = requestAnimationFrame(tick)
    }
    window.foldProbe = { samples, stop: () => { cancelAnimationFrame(frame) } }
    frame = requestAnimationFrame(tick)
  }, root)
}

async function stopTrace(page: Page): Promise<Geometry[]> {
  return page.evaluate(() => {
    const probe = window.foldProbe
    if (probe === undefined) throw new Error('fold trace was not started')
    probe.stop()
    return probe.samples
  })
}

/** Screen position of the smallest visible row containing a marker, relative to the scrollport top. */
function anchorTop(page: Page, root: string, marker: string): Promise<number | null> {
  return page.evaluate(([selector, text]) => {
    const host = document.querySelector<HTMLElement>(selector)!
    const row = [...host.querySelectorAll<HTMLElement>('[data-chat-flow-key], [data-streaming]')]
      .filter(candidate => candidate.closest('[hidden]') === null && (candidate.textContent ?? '').includes(text))
      .sort((left, right) => left.getBoundingClientRect().height - right.getBoundingClientRect().height)[0]
    return row === undefined ? null : row.getBoundingClientRect().top - host.getBoundingClientRect().top
  }, [root, marker] as const)
}

async function toBottom(page: Page, root: string): Promise<void> {
  const button = page.locator(root).getByRole('button', { name: 'Back to bottom', exact: true })
  if (await button.count() > 0) await button.click()
  await stableScroll(page, root)
  await expect.poll(() => page.locator(`${root} [data-chat-following-tail]`).count()).toBe(1)
}

async function placeReader(page: Page, root: string, reader: Reader): Promise<void> {
  if (reader.kind === 'bottom') {
    await toBottom(page, root)
    return
  }
  const delta = await page.evaluate(([selector, marker, align]) => {
    const host = document.querySelector<HTMLElement>(selector)!
    const viewport = host.getBoundingClientRect()
    const composerTop = host.querySelector<HTMLElement>('[data-composer-seat]')!.getBoundingClientRect().top
    const rows = [...host.querySelectorAll<HTMLElement>('[data-chat-flow-key], [data-streaming]')]
      .filter(row => row.closest('[hidden]') === null && (row.textContent ?? '').includes(marker))
      .sort((left, right) => left.getBoundingClientRect().height - right.getBoundingClientRect().height)
    const row = rows[0]
    if (row === undefined) throw new Error(`reader anchor is absent: ${marker}`)
    const rect = row.getBoundingClientRect()
    return align === 'center'
      ? rect.top + rect.height / 2 - (viewport.top + composerTop) / 2
      : rect.top - viewport.top - 24
  }, [root, reader.marker, reader.align] as const)
  const box = await page.locator(root).boundingBox()
  if (box === null) throw new Error('scrollport has no layout box')
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(140, box.height / 3))
  await page.mouse.wheel(0, delta)
  await stableScroll(page, root)
  // Reader movement is sampled on scrollend or after the sampling interval.
  await page.waitForTimeout(700)
  expect(await page.locator(`${root} [data-chat-following-tail]`).count()).toBe(0)
}

async function openSessionBySearch(page: Page, query: string): Promise<void> {
  await page.getByText('Ungrouped', { exact: true }).waitFor({ timeout: 30_000 })
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  await page.getByRole('textbox', { name: 'Search session names', exact: true }).fill(query)
  const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => results.count(), { timeout: 60_000 }).toBe(1)
  await results.click()
}

async function choosePreferences(page: Page, scenario: Case): Promise<void> {
  await openSettings(page, 'en')
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  const timing = dialog.getByText('When to Collapse Work Details', { exact: true }).locator('../..')
  await timing.getByRole('button').click()
  await page.getByRole('menuitem', { name: scenario.timing, exact: true }).click()
  const details = dialog.getByText('Work details', { exact: true }).locator('../..')
  await details.getByRole('button').click()
  await page.getByRole('menuitem', { name: scenario.mode, exact: true }).click()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
}

async function expandSeededSteps(page: Page, root: string, scenario: Case): Promise<void> {
  if (scenario.mode !== 'Detailed' || scenario.timing !== 'On next message') return
  const thoughts = page.locator(`${root} [data-chat-turn="${SEEDED_TURNS}"] [data-variant="think"]`)
  await expect.poll(() => thoughts.count()).toBe(SEEDED_STEPS)
  for (let index = 0; index < SEEDED_STEPS; index++) {
    const button = thoughts.nth(index).getByRole('button').first()
    if (await button.getAttribute('aria-expanded') !== 'true') await button.click()
  }
  // Focus left inside a folding row keeps that row open; a reader who moved on has focused nothing there.
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
}

/** Model-call barrier for one live Turn. */
interface FinishHold {
  /** Resolves when the held call streams its finish; rejects after the timeout. */
  reached(timeoutMs: number): Promise<void>
  release(): void
  dispose(): void
  /** Model calls observed since installation and the target Session's latest event types. */
  describe(): string
}

/**
 * Hold the finish of the first model call for `session` whose streamed text contains `marker`.
 * The call is identified by its replayed content, so auxiliary or reordered calls cannot shift the barrier.
 */
function holdFinishOf(scaffold: WebScaffold, session: SessionId, marker: string): FinishHold {
  const gate = Promise.withResolvers<undefined>()
  const reached = Promise.withResolvers<undefined>()
  const calls: string[] = []
  let held = false
  const dispose = scaffold.ctx.on('llm/stream', async function* (options, next) {
    const index = calls.length
    calls.push(`#${String(index)} ${options.sessionId ?? 'no-session'}/${options.purpose ?? 'turn'}`)
    let matched = false
    for await (const chunk of next()) {
      if (chunk.type === 'block-end' && chunk.block.type === 'text' && chunk.block.text.includes(marker)) matched = true
      if (chunk.type === 'finish') {
        calls[index] = `${calls[index] ?? ''} finish=${chunk.reason.kind}${matched ? ` ${marker}` : ''}`
        if (!held && matched && options.sessionId === session) {
          held = true
          reached.resolve(undefined)
          await gate.promise
        }
      }
      yield chunk
    }
  })
  const describe = (): string => {
    const events = scaffold.ctx.agents.get(session)?.session.snapshotEvents() ?? []
    return `model calls: [${calls.join('; ')}]; ${session} event tail: ${events.slice(-12).map(event => event.type).join(', ')}`
  }
  return {
    reached: async (timeoutMs) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`no model call streamed ${marker} within ${String(timeoutMs)}ms`)) }, timeoutMs)
      })
      try {
        await Promise.race([reached.promise, expired])
      } finally {
        clearTimeout(timer)
      }
    },
    release: () => { gate.resolve(undefined) },
    dispose: () => { gate.resolve(undefined); dispose() },
    describe,
  }
}

interface World {
  readonly browser: Browser
  readonly scaffold: WebScaffold
  readonly page: Page
  readonly root: string
  /** Session receiving the folding message. */
  readonly target: SessionId
  /** Live parent Agent for a side-chat case. */
  readonly parentId?: SessionId
  readonly tripwire: ReturnType<typeof watchConsole>
  /** Session-search text that selects the target's root Session. */
  readonly searchQuery: string
}

function sessionKey(scenario: Case): string {
  return `foldmx-${scenario.id.replaceAll('/', '-')}`
}

async function createChild(scaffold: WebScaffold, parentId: SessionId, scenario: Case): Promise<SessionId> {
  const childId = SessionId(`${sessionKey(scenario)}-child`)
  const createdAt = Date.now() - 30_000
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION, id: childId, createdAt, isSeeded: false, cwd: scaffold.workspaceCwd,
    parentSession: parentId, origin: 'subagent', delegationDepth: 1,
  }
  const parsed = parseSeedFixture(seededFixture(scenario.id, scenario.bodyParagraphs).log)
  const firstUser = parsed.events.findIndex(event => event.type === 'user/message')
  const ordered = [
    ...parsed.events.slice(0, firstUser + 1),
    { type: 'subagent/descriptor', data: snapshotSubagentDescriptor({
      mode: 'continuable', provider: 'spawn', label: CHILD_LABEL, agentProvider: 'deepseek-official', agentModel: 'deepseek-v4-flash',
    }) },
    ...parsed.events.slice(firstUser + 1),
  ]
  const events = ordered.map((event, seq) => ({ ...event, seq: SessionSeq(seq), time: createdAt + seq })) as SessionEvent[]
  const handle = await scaffold.ctx.sessionPersistence.create(header)
  await handle.append(events)
  await handle.close()
  scaffold.ctx.sessionProjectionCache.coldSnapshot(header, SessionLogOffset(0), events)
  const deadline = Date.now() + 10_000
  while (scaffold.ctx.sessionProjectionCache.cachedSnapshot(header) === undefined) {
    if (Date.now() >= deadline) throw new Error('child projection cache row did not land')
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
  const parent = scaffold.ctx.agents.get(parentId)
  if (parent === undefined) throw new Error('parent Agent is not live')
  parent.session.append('subagent/catalog', { version: 0, childId, childCreatedAt: createdAt, mode: 'continuable', label: CHILD_LABEL })
  return childId
}

async function openWorld(browser: Browser, scenario: Case, replayDir: string): Promise<World> {
  const scaffold = await launchScaffold(scenario, replayDir)
  let page: Page | undefined
  try {
    page = await newEnglishPage(browser, 900)
    return await prepareWorld(browser, scenario, scaffold, page)
  } catch (error) {
    const failures: unknown[] = [error]
    if (page !== undefined) await page.context().close().catch((cleanupError: unknown) => failures.push(cleanupError))
    await scaffold.close().catch((cleanupError: unknown) => failures.push(cleanupError))
    if (failures.length === 1) throw error
    throw new AggregateError(failures, `${scenario.id}: world setup failed and cleanup was incomplete`)
  }
}

/**
 * Launch the scaffold with the case's replay script. A Turn that fails before its model call consumes
 * no script, so that case mounts only the provider catalog from a header-only fixture.
 */
async function launchScaffold(scenario: Case, replayDir: string): Promise<WebScaffold> {
  if (scenario.origin === 'error') {
    const header = seededFixture(scenario.id, scenario.bodyParagraphs).log.split('\n')[0] ?? ''
    const fixture = join(replayDir, sessionFixtureName(0, SESSION_FORMAT_VERSION))
    await writeFile(fixture, `${header}\n`)
    return launchWebScaffold({ replayFixture: fixture, replayProvidersOnly: true })
  }
  await writeFile(join(replayDir, 'replay.override.json'), JSON.stringify(replayFor(scenario)))
  return launchWebScaffold({
    replayFixture: join(replayDir, 'override-only.jsonl'),
    replayOverride: join(replayDir, 'replay.override.json'),
    paceMs: 16,
    replayContextWindow: 10_000_000,
  })
}

/** Seed the case's Sessions, open the surface, and choose the display preferences. */
async function prepareWorld(browser: Browser, scenario: Case, scaffold: WebScaffold, page: Page): Promise<World> {
  await writeFile(join(scaffold.workspaceCwd, READ_FILE), 'fold matrix notes\n')
  const tripwire = watchConsole(page)
  await page.addInitScript(installMeasure)
  await page.setViewportSize(scenario.surface === 'main' ? { width: 1280, height: 720 } : { width: 1680, height: 900 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const sessionId = SessionId(sessionKey(scenario))
  if (scenario.surface === 'main') {
    const fixture = seededFixture(scenario.id, scenario.bodyParagraphs)
    await seedSession(scaffold, fixture.log, sessionId)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await openSessionBySearch(page, fixture.markers.user(1))
    await page.locator(MAIN_ROOT).getByText('FOLDMX_BODY', { exact: false }).last().waitFor({ timeout: 30_000 })
    const resolved = await scaffold.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    scaffold.ctx.permissionPresets.set(resolved.agent.session, 'danger-full-access')
    await choosePreferences(page, scenario)
    return { browser, scaffold, page, root: MAIN_ROOT, target: sessionId, tripwire, searchQuery: fixture.markers.user(1) }
  }
  const parentFixture = createChatScrollFixture({ markerPrefix: 'FOLDMXP', title: `FOLDMX parent ${scenario.id}`, turns: 2 })
  await seedSession(scaffold, parentFixture.log, sessionId)
  const resolved = await scaffold.ctx.sessionController.resolveAgent(sessionId)
  if ('error' in resolved) throw resolved.error
  scaffold.ctx.permissionPresets.set(resolved.agent.session, 'danger-full-access')
  const childId = await createChild(scaffold, sessionId, scenario)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await openSessionBySearch(page, parentFixture.markers.user(1))
  await choosePreferences(page, scenario)
  const trigger = page.getByRole('button', { name: '1 subagent', exact: true })
  await trigger.waitFor({ timeout: 15_000 })
  await trigger.hover()
  await page.getByRole('treeitem', { name: new RegExp(CHILD_LABEL) })
    .getByRole('button', { name: `Open ${CHILD_LABEL} in sidebar`, exact: true }).click()
  await page.locator(SIDE_ROOT).getByText('FOLDMX_BODY', { exact: false }).last().waitFor({ timeout: 30_000 })
  await page.mouse.move(0, 0)
  return {
    browser, scaffold, page, root: SIDE_ROOT, target: childId, parentId: sessionId, tripwire,
    searchQuery: parentFixture.markers.user(1),
  }
}

function composerOf(world: World): ReturnType<Page['locator']> {
  return world.page.locator(`${world.root} [data-composer-input][contenteditable="true"]`).last()
}

async function send(world: World, text: string): Promise<void> {
  await composerOf(world).fill(text)
  await world.page.locator(world.root).getByRole('button', { name: 'Send message', exact: true }).click()
}

/** Wait until a Session's Agent ends a Turn. */
function turnEnded(scaffold: WebScaffold, sessionId: SessionId, count = 1, timeoutMs = 60_000): Promise<void> {
  return new Promise<void>((resolveEnded, reject) => {
    let remaining = count
    const timer = setTimeout(() => { off(); reject(new Error(`no turn/end for ${sessionId} within ${timeoutMs}ms`)) }, timeoutMs)
    const off = scaffold.ctx.on('session/event', (session: { id: SessionId }, event: SessionEvent) => {
      if (session.id !== sessionId || event.type !== 'turn/end') return
      remaining -= 1
      if (remaining > 0) return
      clearTimeout(timer)
      off()
      resolveEnded()
    })
  })
}

async function settle(world: World): Promise<void> {
  await expect.poll(() => world.page.locator(`${world.root} [data-streaming="true"]`).count(), { timeout: 30_000 }).toBe(0)
  await stableScroll(world.page, world.root)
  await world.page.waitForTimeout(900)
  await stableScroll(world.page, world.root)
}

/** Drive one case from its prepared reader position through the folding message and its Turn. */
interface RunResult {
  readonly afterFold: Geometry
  readonly afterTurn: Geometry
  readonly samples: Geometry[]
  /** Reader anchor row positions when sending, after the fold, and after the Turn. */
  readonly anchors: { before: number | null; fold: number | null; turn: number | null }
}

async function run(world: World, scenario: Case): Promise<RunResult> {
  const { page, root, scaffold, target } = world
  const anchors: RunResult['anchors'] = { before: null, fold: null, turn: null }
  const readAnchor = (): Promise<number | null> => scenario.reader.kind === 'marker'
    ? anchorTop(page, root, scenario.reader.marker) : Promise.resolve(null)
  const begin = async (): Promise<void> => {
    anchors.before = await readAnchor()
    await startTrace(page, root)
  }
  const folded = async (): Promise<Geometry> => {
    await stableScroll(page, root)
    anchors.fold = await readAnchor()
    return measure(page, root)
  }
  let afterFold: Geometry
  switch (scenario.origin) {
    case 'composer':
    case 'error': {
      const disposeFailure = scenario.origin === 'error'
        ? scaffold.ctx.on('system-prompt/assemble', async () => { throw new Error('FOLDMX_TURN_FAILED') })
        : () => undefined
      // A subagent child's composer sends through the subagent continuation route.
      const promptRoute = scenario.surface === 'side' ? '**/api/subagents/prompt' : '**/api/session/prompt'
      const promptGate = Promise.withResolvers<undefined>()
      const promptHeld = Promise.withResolvers<undefined>()
      const holdPrompt = async (route: Route): Promise<void> => {
        promptHeld.resolve(undefined)
        await promptGate.promise
        await route.continue()
      }
      await page.route(promptRoute, holdPrompt)
      const ended = turnEnded(scaffold, target)
      try {
        await expandSeededSteps(page, root, scenario)
        await placeReader(page, root, scenario.reader)
        await begin()
        await send(world, NEXT_INPUT)
        await promptHeld.promise
        await page.locator(`${root} [data-submission-echo]`).waitFor()
        afterFold = await folded()
        promptGate.resolve(undefined)
        await ended
      } finally {
        promptGate.resolve(undefined)
        disposeFailure()
        await page.unroute(promptRoute, holdPrompt)
      }
      break
    }
    case 'other-tab': {
      await expandSeededSteps(page, root, scenario)
      const other = await newEnglishPage(world.browser, 720)
      await other.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await openSessionBySearch(other, world.searchQuery)
      await other.locator(MAIN_ROOT).getByText('FOLDMX_BODY', { exact: false }).last().waitFor({ timeout: 30_000 })
      await placeReader(page, root, scenario.reader)
      await begin()
      const ended = turnEnded(scaffold, target)
      await other.locator(`${MAIN_ROOT} [data-composer-input][contenteditable="true"]`).last().fill(NEXT_INPUT)
      await other.locator(MAIN_ROOT).getByRole('button', { name: 'Send message', exact: true }).click()
      await page.locator(`${root} [data-chat-flow-kind="user"]`, { hasText: NEXT_INPUT }).waitFor()
      afterFold = await folded()
      await ended
      await other.context().close()
      break
    }
    case 'queued':
    case 'steer': {
      // Queued: hold the long final body. Steer: hold the last replayed Step so the steering message lands in this Turn.
      const gate = holdFinishOf(scaffold, target, scenario.origin === 'queued' ? 'FOLDMX_LIVE_BODY' : `FOLDMX_LIVE_STEP_${String(STEER_STEPS)}`)
      const first = turnEnded(scaffold, target, scenario.origin === 'queued' ? 2 : 1)
      // A failed earlier step reports itself; the success path still awaits and rethrows this rejection.
      first.catch(() => undefined)
      try {
        await toBottom(page, root)
        await send(world, 'FOLDMX_START_LIVE_TURN')
        await gate.reached(60_000)
        await stableScroll(page, root)
        if (scenario.origin === 'queued' && scenario.reader.kind === 'marker') {
          await page.locator(root).getByText('FOLDMX_LIVE_BODY', { exact: false }).last().waitFor()
        }
        await placeReader(page, root, scenario.reader)
        await composerOf(world).fill(NEXT_INPUT)
        await composerOf(world).press('Enter')
        const steerButton = page.getByRole('button', { name: 'Steer queued message' })
        await steerButton.waitFor({ timeout: 15_000 })
        if (scenario.origin === 'steer') {
          await expect.poll(() => steerButton.isEnabled(), { timeout: 10_000 }).toBe(true)
          await steerButton.click()
        }
        await begin()
        gate.release()
        await page.locator(`${root} [data-chat-flow-kind="user"], ${root} [data-chat-flow-kind="steering"]`, { hasText: NEXT_INPUT })
          .first().waitFor({ timeout: 30_000 })
        afterFold = await folded()
        await first
      } catch (error) {
        throw new Error(`${scenario.id}: ${error instanceof Error ? error.message : String(error)}\n${gate.describe()}`, { cause: error })
      } finally {
        gate.dispose()
      }
      break
    }
    case 'parent-message': {
      await expandSeededSteps(page, root, scenario)
      await placeReader(page, root, scenario.reader)
      await begin()
      const parent = scaffold.ctx.agents.get(world.parentId!)
      if (parent === undefined) throw new Error('parent Agent is not live')
      const ended = turnEnded(scaffold, target)
      await scaffold.ctx.subagents.sendMessage(parent, target, [{ type: 'text', text: 'FOLDMX_PARENT_NOTE' }], { signal: new AbortController().signal })
      await page.locator(`${root} [data-chat-turn="${SEEDED_TURNS + 1}"]`).first().waitFor({ timeout: 30_000 })
      afterFold = await folded()
      await ended
      break
    }
    case 'big-exchange': {
      const parent = scaffold.ctx.agents.get(world.parentId!)
      if (parent === undefined) throw new Error('parent Agent is not live')
      for (const note of ['FOLDMX_WAKE_A_NOTE', 'FOLDMX_WAKE_B_NOTE']) {
        const woken = turnEnded(scaffold, target)
        await scaffold.ctx.subagents.sendMessage(parent, target, [{ type: 'text', text: note }], { signal: new AbortController().signal })
        await woken
      }
      await settle(world)
      await placeReader(page, root, scenario.reader)
      await begin()
      const ended = turnEnded(scaffold, target)
      await send(world, NEXT_INPUT)
      await page.locator(`${root} [data-chat-flow-kind="user"]`, { hasText: NEXT_INPUT }).waitFor({ timeout: 30_000 })
      afterFold = await folded()
      await ended
      break
    }
  }
  await settle(world)
  anchors.turn = await readAnchor()
  const afterTurn = await measure(page, root)
  const samples = await stopTrace(page)
  return { afterFold, afterTurn, samples, anchors }
}

function rounded(geometry: Geometry): Record<string, number | boolean> {
  return {
    top: Math.round(geometry.top), floor: Math.round(geometry.floor), spacer: Math.round(geometry.spacer),
    maxGap: Math.round(geometry.maxGap), gapAt: Math.round(geometry.gapAt), following: geometry.following,
  }
}

describe.skipIf(MODE === 'record')('web e2e: blank area after next-message folding', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
  })

  for (const scenario of CASES) {
    it(scenario.id, async () => {
      const replayDir = await mkdtemp(join(tmpdir(), 'dsh-fold-matrix-'))
      let world: World | undefined
      try {
        world = await openWorld(browser, scenario, replayDir)
        const { afterFold, afterTurn, samples, anchors } = await run(world, scenario)
        const transient = samples.filter(sample => sample.maxGap > BLANK_LIMIT)
        const summary = {
          id: scenario.id, landing: scenario.landing, before: samples[0] === undefined ? null : rounded(samples[0]),
          afterFold: rounded(afterFold), afterTurn: rounded(afterTurn), anchors,
          peakGap: Math.round(Math.max(0, ...samples.map(sample => sample.maxGap))),
          framesOverLimit: transient.length, frames: samples.length,
          peakSpacer: Math.round(Math.max(0, ...samples.map(sample => sample.spacer))),
        }
        const evidence = async (): Promise<void> => {
          await mkdir(EVIDENCE, { recursive: true })
          await writeFile(join(EVIDENCE, `${sessionKey(scenario)}.json`), JSON.stringify({ scenario, ...summary, samples }, null, 2))
          console.log(`FOLDMX ${JSON.stringify(summary)}`)
        }
        // Per-frame evidence is written for failures, or for every case with FOLDMX_EVIDENCE=1.
        if (process.env.FOLDMX_EVIDENCE === '1') await evidence()
        else onTestFailed(evidence)
        if (scenario.origin === 'parent-message' || scenario.origin === 'steer') {
          expect.soft(samples.some(sample => sample.collapsing), 'a control case folds nothing').toBe(false)
        }
        if (scenario.roomUntilReply !== true) {
          expect.soft(afterFold.maxGap, 'layout gap after the fold settles').toBeLessThanOrEqual(BLANK_LIMIT)
          expect.soft(transient.length, 'animation frames with a layout gap').toBeLessThanOrEqual(TRANSIENT_FRAMES)
        }
        expect.soft(afterTurn.maxGap, 'layout gap after the Turn settles').toBeLessThanOrEqual(BLANK_LIMIT)
        if (scenario.landing === 'tail') {
          expect.soft(afterFold.floor - afterFold.top, 'distance from the floor after the fold').toBeLessThanOrEqual(1)
          expect.soft(afterTurn.floor - afterTurn.top, 'distance from the floor after the Turn').toBeLessThanOrEqual(1)
          expect.soft(afterTurn.following, 'following after the Turn').toBe(true)
        } else if (scenario.anchorFolds !== true) {
          expect.soft(anchors.before).not.toBeNull()
          expect.soft(Math.abs((anchors.fold ?? Infinity) - (anchors.before ?? 0)), 'anchor movement after the fold').toBeLessThanOrEqual(2)
          expect.soft(Math.abs((anchors.turn ?? Infinity) - (anchors.before ?? 0)), 'anchor movement after the Turn').toBeLessThanOrEqual(2)
        }
        expect.soft(world.tripwire.pageErrors).toEqual([])
      } finally {
        // Scaffold close also asserts that every replay entry was consumed; its failures fail the case.
        const failures: unknown[] = []
        await world?.page.context().close().catch((error: unknown) => failures.push(error))
        await world?.scaffold.close().catch((error: unknown) => failures.push(error))
        await rm(replayDir, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, `${scenario.id}: cleanup failed`)
      }
    })
  }
})

export {}
