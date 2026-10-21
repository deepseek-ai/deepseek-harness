/**
 * Scroll continuity when "On next message" folds a process group the reader opened. The latest Turn has
 * one Step; the reader opened its group and expanded the reasoning inside, so the group body is capped and
 * scrollable, then sends the next message from the floor. A held prompt keeps the new Turn from starting
 * until the fold settles, so only the fold moves the view while the scrollport is sampled on every
 * animation frame.
 *
 * - A long answer leaves the folded group above the viewport. The scroll position changes in one direction
 *   only: the fold never scrolls the view away and then snaps it back.
 * - A short answer leaves fold room below the tail. Growth fills that room without scrolling, so the running
 *   status keeps its entrance slide when the new Step's first row appears instead of moving in one frame.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page, Route } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import { launchWebScaffold, parseSeedFixture, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, openSettings } from './support.ts'

declare global {
  interface Window {
    openFoldTrace?: { readonly frames: TraceFrame[]; readonly slides: number[]; stop(): void }
  }
}

const MODE = webSnapshotMode()
const ROOT = '[data-conversation-scroll]:not([data-sidebar-chat] [data-conversation-scroll])'
/** Settled Turns before the latest one, so the transcript overflows the scrollport. */
const TURNS = 7
const NEXT_INPUT = 'OPENFOLD_NEXT_INPUT'
const REPLY = 'OPENFOLD_REPLY'

/** One painted frame of the main scrollport. */
interface TraceFrame {
  readonly top: number
  readonly floor: number
  /** Height of the fold room below the transcript. */
  readonly spacer: number
  /** The column marks the tail as pinned, which runs the status slide at zero duration. */
  readonly pinned: boolean
  /** The running status's top relative to the scrollport, when it is mounted. */
  readonly status: number | null
  readonly folding: boolean
}

function paragraphs(marker: string, count: number, text: string): string {
  return `${marker}\n\n${Array.from({ length: count }, (_, line) => `${text} ${line}.`).join('\n\n')}`
}

/** Settled history whose latest Turn is one Step: long reasoning, then an answer of `answerParagraphs`. */
function seededLog(id: string, answerParagraphs: number): { log: string; search: string } {
  const base = createChatScrollFixture({ markerPrefix: `OPENFOLD${id.toUpperCase()}`, title: `OPENFOLD ${id}`, turns: TURNS })
  const parsed = parseSeedFixture(base.log)
  const boundary = parsed.events.findIndex(event => event.type === 'turn/start' && event.data.turn === TURNS)
  const drafts: (SessionEvent | { type: string; data: object; surfaceOp?: 'append' })[] = parsed.events.slice(0, boundary)
  drafts.push(
    { type: 'turn/start', data: { turn: TURNS } },
    { type: 'step/start', data: { turn: TURNS, step: 1 } },
    { type: 'user/message', data: createUserMessage({
      content: [{ type: 'text', text: 'OPENFOLD_LAST_USER' }], source: { kind: 'user' },
    }), surfaceOp: 'append' },
    { type: 'assistant/message', surfaceOp: 'append', data: {
      turn: TURNS, step: 1, stream: [], message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: paragraphs('OPENFOLD_REASONING', 30, 'Reasoning weighs one more consideration, paragraph') },
          { type: 'text', text: paragraphs('OPENFOLD_ANSWER', answerParagraphs, 'Final answer paragraph of the single Step') },
        ],
        source: { provider: 'fixture', model: 'fixture' },
      }),
    } },
    { type: 'step/end', data: { turn: TURNS, step: 1 } },
    { type: 'turn/end', data: { turn: TURNS, reason: { kind: 'completed' } } },
  )
  return {
    log: [parsed.headerLine, ...drafts.map((event, seq) => JSON.stringify({ ...event, seq, time: seq + 1 })), ''].join('\n'),
    search: base.markers.user(1),
  }
}

function reply(): ReplayEntry {
  const text = `${REPLY} short answer.`
  const finish: StreamChunk[] = [
    { type: 'usage', usage: { inputTokens: 512, outputTokens: 64 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  return { kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    ...finish,
  ] }
}

async function stableScroll(page: Page): Promise<void> {
  await page.evaluate(async (selector) => {
    const host = document.querySelector<HTMLElement>(selector)!
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
        else if (now - started >= 20_000) reject(new Error(`scroll did not settle: top ${String(host.scrollTop)}`))
        else requestAnimationFrame(check)
      }
      requestAnimationFrame(check)
    })
  }, ROOT)
}

async function toBottom(page: Page): Promise<void> {
  const button = page.locator(ROOT).getByRole('button', { name: 'Back to bottom', exact: true })
  if (await button.count() > 0) await button.click()
  await stableScroll(page)
  await expect.poll(() => page.locator(`${ROOT} [data-chat-following-tail]`).count()).toBe(1)
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

async function choosePreferences(page: Page): Promise<void> {
  await openSettings(page, 'en')
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  const timing = dialog.getByText('When to Collapse Work Details', { exact: true }).locator('../..')
  await timing.getByRole('button').click()
  await page.getByRole('menuitem', { name: 'On next message', exact: true }).click()
  const details = dialog.getByText('Work details', { exact: true }).locator('../..')
  await details.getByRole('button').click()
  await page.getByRole('menuitem', { name: 'Standard', exact: true }).click()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
}

/** Open the latest Turn's process group and expand its reasoning until the group body caps its height. */
async function openLatestGroup(page: Page): Promise<void> {
  const group = page.locator(`${ROOT} [data-chat-group-key][data-chat-turn="${String(TURNS)}"]`).last()
  const header = group.locator('button[aria-expanded]').first()
  if (await header.getAttribute('aria-expanded') !== 'true') await header.click()
  const thought = group.locator('[data-variant="think"]').getByRole('button').first()
  if (await thought.getAttribute('aria-expanded') !== 'true') await thought.click()
  const body = group.locator('[data-step-process-body]')
  await expect.poll(() => body.evaluate(element => element.scrollHeight > element.clientHeight + 100)).toBe(true)
  // Focus left inside a folding row keeps that row open; a reader who moved on has focused nothing there.
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  await page.mouse.move(0, 0)
}

/**
 * Sample the scrollport on every animation frame, and record the duration of every status entrance slide
 * that a flow change starts.
 */
async function startTrace(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const host = document.querySelector<HTMLElement>(selector)!
    const column = host.querySelector<HTMLElement>('[data-chat-flow]')!
    const spacer = host.querySelector<HTMLElement>('[data-chat-turn-spacer]')!
    const frames: TraceFrame[] = []
    const slides: number[] = []
    let frame = 0
    const tick = (): void => {
      const status = host.querySelector<HTMLElement>('[data-chat-running]')
      frames.push({
        top: host.scrollTop,
        floor: Math.max(0, host.scrollHeight - host.clientHeight),
        spacer: spacer.getBoundingClientRect().height,
        pinned: column.hasAttribute('data-chat-tail-pinned'),
        status: status === null ? null : status.getBoundingClientRect().top - host.getBoundingClientRect().top,
        folding: column.hasAttribute('data-input-fold') || host.querySelector('[data-chat-motion="collapse"]') !== null,
      })
      frame = requestAnimationFrame(tick)
    }
    // The slide starts at the style update after the flow change; reading animations there sees its duration.
    const observer = new MutationObserver(() => {
      const status = host.querySelector<HTMLElement>('[data-chat-running]')
      for (const animation of status?.getAnimations() ?? []) {
        if (animation instanceof CSSAnimation && animation.animationName.includes('running-follows-output')) {
          slides.push(Number(animation.effect?.getComputedTiming().duration ?? 0))
        }
      }
    })
    observer.observe(column, { childList: true, subtree: true })
    window.openFoldTrace = { frames, slides, stop: () => { cancelAnimationFrame(frame); observer.disconnect() } }
    frame = requestAnimationFrame(tick)
  }, ROOT)
}

async function readTrace(page: Page): Promise<{ frames: TraceFrame[]; slides: number[] }> {
  return page.evaluate(() => {
    const trace = window.openFoldTrace!
    return { frames: [...trace.frames], slides: [...trace.slides] }
  })
}

/** Per-frame scroll movements larger than subpixel rounding. */
function movements(frames: readonly TraceFrame[]): number[] {
  const steps: number[] = []
  for (let index = 1; index < frames.length; index++) {
    const step = frames[index]!.top - frames[index - 1]!.top
    if (Math.abs(step) > 1) steps.push(Math.round(step))
  }
  return steps
}

interface World {
  readonly scaffold: WebScaffold
  readonly page: Page
  readonly session: SessionId
  readonly tripwire: ReturnType<typeof watchConsole>
  /** Releases the held prompt; the new Turn starts after this. */
  readonly releasePrompt: () => void
  /** Releases the held model stream; the new Step's output arrives after this. */
  readonly releaseModel: () => void
  readonly ended: Promise<void>
  readonly close: () => Promise<void>
}

/**
 * Seed and open the case, open the latest group, and send the next message from the floor with the prompt
 * and the model stream held.
 */
async function sendFromOpenedGroup(browser: Browser, id: string, answerParagraphs: number): Promise<World> {
  const replayDir = await mkdtemp(join(tmpdir(), 'dsh-open-fold-'))
  await writeFile(join(replayDir, 'replay.override.json'), JSON.stringify([reply()]))
  const scaffold = await launchWebScaffold({
    replayFixture: join(replayDir, 'override-only.jsonl'),
    replayOverride: join(replayDir, 'replay.override.json'),
    paceMs: 16,
    replayContextWindow: 10_000_000,
  })
  const model = Promise.withResolvers<undefined>()
  const disposeHold = scaffold.ctx.on('llm/stream', async function* (_options, next) {
    await model.promise
    for await (const chunk of next()) yield chunk
  })
  const prompt = Promise.withResolvers<undefined>()
  const holdPrompt = async (route: Route): Promise<void> => {
    await prompt.promise
    await route.continue()
  }
  const page = await newEnglishPage(browser, 826)
  const close = async (): Promise<void> => {
    prompt.resolve(undefined)
    model.resolve(undefined)
    disposeHold()
    const failures: unknown[] = []
    await page.context().close().catch((error: unknown) => failures.push(error))
    await scaffold.close().catch((error: unknown) => failures.push(error))
    await rm(replayDir, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, `${id}: cleanup failed`)
  }
  try {
    const tripwire = watchConsole(page)
    await page.setViewportSize({ width: 1170, height: 826 })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const session = SessionId(`open-fold-${id}`)
    const { log, search } = seededLog(id, answerParagraphs)
    await seedSession(scaffold, log, session)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await openSessionBySearch(page, search)
    await page.locator(ROOT).getByText('OPENFOLD_ANSWER', { exact: false }).last().waitFor({ timeout: 30_000 })
    await choosePreferences(page)
    await toBottom(page)
    await openLatestGroup(page)
    await toBottom(page)
    await page.route('**/api/session/prompt', holdPrompt)
    const ended = new Promise<void>((resolveEnded, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`${id}: no turn/end within 60000ms`)) }, 60_000)
      const off = scaffold.ctx.on('session/event', (owner: { id: SessionId }, event: SessionEvent) => {
        if (owner.id !== session || event.type !== 'turn/end') return
        clearTimeout(timer)
        off()
        resolveEnded()
      })
    })
    // A failure before the release awaits nothing; the success path awaits and rethrows this rejection.
    ended.catch(() => undefined)
    await startTrace(page)
    await page.locator(`${ROOT} [data-composer-input][contenteditable="true"]`).last().fill(NEXT_INPUT)
    await page.locator(ROOT).getByRole('button', { name: 'Send message', exact: true }).click()
    await page.locator(`${ROOT} [data-submission-echo]`).waitFor()
    await stableScroll(page)
    return {
      scaffold, page, session, tripwire, ended, close,
      releasePrompt: () => { prompt.resolve(undefined) },
      releaseModel: () => { model.resolve(undefined) },
    }
  } catch (error) {
    await close().catch(() => undefined)
    throw error
  }
}

describe.skipIf(MODE === 'record')('web e2e: next-message fold of an opened process group', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('folds the opened group above a long answer without scrolling away and back', async () => {
    const world = await sendFromOpenedGroup(browser, 'long', 30)
    try {
      const { frames } = await readTrace(world.page)
      const steps = movements(frames)
      const reversals = steps.filter((step, index) => index > 0 && Math.sign(step) !== Math.sign(steps[index - 1]!)).length
      // Soft assertions let the held Turn finish, so a failure reports the curve instead of replay leftovers.
      expect.soft(frames.some(frame => frame.folding), 'the message folds the opened group').toBe(true)
      expect.soft(reversals, `scroll direction changes; per-frame movements ${JSON.stringify(steps)}`).toBe(0)
      const settled = frames.at(-1)!
      expect.soft(settled.floor - settled.top, 'distance from the floor after the fold').toBeLessThanOrEqual(1)
      world.releasePrompt()
      world.releaseModel()
      await world.ended
      expect(world.tripwire.pageErrors).toEqual([])
    } finally {
      await world.close()
    }
  })

  it('keeps the running status slide while fold room below a short answer takes the new Step', async () => {
    const world = await sendFromOpenedGroup(browser, 'short', 2)
    try {
      const folded = (await readTrace(world.page)).frames.at(-1)!
      expect.soft(folded.spacer, 'fold room below the short answer').toBeGreaterThan(0)
      expect.soft(folded.pinned, 'tail pin while fold room remains').toBe(false)
      world.releasePrompt()
      // The running Step's group row is the first row after the user message; output stays held until then.
      await world.page.locator(`${ROOT} [data-chat-group-key][data-chat-turn="${String(TURNS + 1)}"]`).waitFor({ timeout: 30_000 })
      await world.page.locator(`${ROOT} [data-chat-running]`).waitFor()
      await world.page.waitForTimeout(300)
      const { frames, slides } = await readTrace(world.page)
      const statusSteps = movements(frames.map(frame => ({ ...frame, top: frame.status ?? Number.NaN })))
        .filter(step => Number.isFinite(step))
      // The fold runs status moves at zero duration on its own, so only settled frames show the pin's effect.
      const pinnedOverRoom = frames.filter(frame => !frame.folding && frame.pinned && frame.spacer > 0)
      expect.soft(pinnedOverRoom, 'settled frames pinned over fold room').toEqual([])
      expect.soft(slides.some(duration => duration > 0), `status slide durations ${JSON.stringify(slides)}; status movements ${JSON.stringify(statusSteps)}`).toBe(true)
      world.releaseModel()
      await world.ended
      expect(world.tripwire.pageErrors).toEqual([])
    } finally {
      await world.close()
    }
  })
})
