// Web e2e scenario: the resident question composer. The shipped composition
// already exposes ask_user_question (the ui-user-questions row's node half mounts
// the tool), so a recorded turn where the model asks blocks mid-turn on the
// real userInteraction seam: the composer renders in the browser, the test
// answers through it, and the turn completes with the answer in the log.
// Replay is fully deterministic — the question content arrives from replayed
// chunks, the composer wait is real, and the answer click is the test's own
// gesture (the ONE place a drive step legitimately reacts to model content:
// the turn cannot complete without it, in record and replay alike).
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TIMED_WAIT_PARAMETER } from '@deepseek-ai/dsh-user-questions'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import {
  connectFreshWorkspace, expandTurnProcesses, newEnglishPage, pinBrowserClock, pinHostClock, saveFailureShot, WEB_FIXTURE_TIME,
} from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/question-composer', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const SIDEBAR_EXPECTED = join(SNAPSHOT_DIR, 'sidebar.expected.md')
const COMPOSED_EXPECTED = join(SNAPSHOT_DIR, 'composed.expected.md')
// Final golden: the answered transcript — the question resolved into its tool
// round trip and the final reply, the state the composer goldens cannot see.
const ANSWERED_EXPECTED = join(SNAPSHOT_DIR, 'answered.expected.md')
const CANCELLED_EXPECTED = join(SNAPSHOT_DIR, 'cancelled.expected.md')
const ANSWERED_EXPANDED_EXPECTED = join(SNAPSHOT_DIR, 'answered-expanded.expected.md')
// The timed tool's second settlement: the wait expired, and the answer arrived
// afterwards. Its golden owns the state the reported symptom lands in.
const LATE_ANSWERED_EXPECTED = join(SNAPSHOT_DIR, 'late-answered.expected.md')
const QUEUED_EXPECTED = join(SNAPSHOT_DIR, 'queued.expected.md')
const MODE = webSnapshotMode()
const CANCELLED_SEED_ID = 'ask-question-cancelled-row-web-e2e'
const LATE_ANSWERED_SEED_ID = 'ask-question-late-answered-row-web-e2e'
const QUEUED_SEED_ID = 'ask-question-queued-row-web-e2e'

// The composer's own growth cap, in text lines (QuestionComposer.module.css
// .fieldMirror). Asserted as TEXT lines, not as a box height: the two variants
// carry different padding, and a cap measured in border-box pixels silently
// means a different line count in each — which is exactly how the optionless
// field came to stop two thirds of a line short.
const CAP_LINES = 6

/**
 * Measure a saturated answer field: how many whole text lines it grew to, and
 * whether it took over the scrolling once it stopped growing.
 * @param field - the composer's custom-answer textarea.
 * @returns whole text lines the content box holds, and whether the field scrolls.
 */
async function capMetrics(field: Locator): Promise<{ textLines: number; scrolls: boolean }> {
  await field.fill('x\n'.repeat(40))
  return field.evaluate((el: HTMLTextAreaElement) => {
    const style = getComputedStyle(el)
    const text = el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
    return {
      textLines: Math.round(text / parseFloat(style.lineHeight)),
      scrolls: el.scrollHeight > el.clientHeight,
    }
  })
}

/**
 * Read how the composer draws one long-copy element: the lines it shows,
 * whether CSS clipped it, whether its text overflows the line budget, and what
 * its toggle does while that toggle is visible.
 * @param element - a question heading or an option description.
 * @returns the drawn state of the copy.
 */
function readCopy(element: HTMLElement): { lines: number; clipped: boolean; overflows: boolean; toggle: 'expand' | 'collapse' | undefined } {
  const style = getComputedStyle(element)
  const toggle = element.tagName === 'H2'
    ? element.nextElementSibling
    : element.closest('[data-option-row]')?.querySelector(':scope > button:not([role])')
  return {
    // A clipped box keeps its full budget and gives the dropped line back through its bottom margin.
    lines: Math.round((element.getBoundingClientRect().height + parseFloat(style.marginBottom)) / parseFloat(style.lineHeight)),
    clipped: style.maskImage !== 'none',
    overflows: element.scrollHeight > element.clientHeight + 0.5,
    toggle: toggle instanceof HTMLElement && getComputedStyle(toggle).visibility === 'visible'
      ? toggle.getAttribute('aria-expanded') === 'true' ? 'collapse' : 'expand'
      : undefined,
  }
}

/**
 * Tell whether an expanded copy's toggle sits below the copy's last text line.
 * @param toggle - the copy's toggle button.
 * @param copy - the expanded question heading or option description.
 * @returns whether the toggle starts at or below the bottom of the text; false without the copy.
 */
function belowText(toggle: HTMLElement, copy: Element | null): boolean {
  if (copy === null) return false
  const textBottom = copy.getBoundingClientRect().bottom - parseFloat(getComputedStyle(copy).paddingBottom)
  return toggle.getBoundingClientRect().top >= textBottom - 0.5
}

// The options carry descriptions on purpose: the squeeze assertion below
// verifies that each description keeps to its two-line budget in the card scrollport.
const PROMPT = 'Use the ask_user_question tool to ask me exactly one multi-select question with id "color", question "Which color do you prefer?", header "Pick one", and two options: label "Blue" with description "A cool recessive hue that reads as calm and trustworthy in long reading sessions and dense dashboards.", and label "Green" with description "A restful mid-spectrum hue with the highest perceived brightness, easiest on the eye over long sessions." Set multi_select to true. After I answer, reply with the single word DONE and stop.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The batch the derived late reply submits, distinct from the in-time answer. */
const LATE_ANSWERS = [{ id: 'color', selected: ['Green'], custom: 'Answered after the timeout' }]

/**
 * The `ask_user_question` schema as the timed tool declares it, in the shape a
 * request header records. A late reply can only follow a timed call, and the
 * `userQuestions` projection tells a timed call from a legacy one by exactly
 * this schema in the header in effect; the recorded fixture's header carries
 * the placeholder token of a legacy recording, so the derived fixture must
 * carry the timed schema for its call to be tracked at all.
 */
const TIMED_ASK_USER_QUESTION_SCHEMA = {
  name: 'ask_user_question',
  description: 'Ask brief, direct, self-contained questions about missing information, preferences, or decisions.',
  parameters: {
    type: 'object',
    properties: {
      questions: { type: 'array', items: { type: 'object' } },
      [TIMED_WAIT_PARAMETER]: { type: 'integer' },
    },
    required: ['questions'],
  },
}

/**
 * What the timed tool records when its foreground wait expires. Both readers of
 * a recorded result take `pending` and `callId` out of this one JSON object —
 * the `userQuestions` projection to keep the call answerable, the question row
 * to tell a timeout from an answer batch; the `message` is the model's own
 * continuation instruction and no reader parses it.
 * @param callId - the call whose questions stay answerable.
 * @returns the recorded result text.
 */
function pendingResultText(callId: string): string {
  return JSON.stringify({
    pending: true,
    callId,
    message: 'No answer batch arrived before the timeout. This is pending, not a skipped answer.',
  })
}

/**
 * The message a late answer lands as: the timed question's `callId` names it,
 * and it carries both the questions it answers and the batch itself.
 * @param callId - the call the reply settles.
 * @param questions - the call's questions, echoed from its recorded arguments.
 * @returns the reply, as the inbox splice and the durable message both record it.
 */
function lateReplyMessage(callId: string, questions: unknown): Record<string, unknown> {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        kind: 'answer_to_pending_question', tool: 'ask_user_question', callId, questions, answers: LATE_ANSWERS,
      }),
    }],
    source: { kind: 'user-question-reply', callId, outcome: 'answered' },
    role: 'user',
    id: '{{message:7}}',
  }
}

/**
 * The turn a late reply opens: the reply enters the agent inbox, the next turn
 * claims it, and it lands as this Session's durable user message.
 * @param callId - the call the reply settles.
 * @param questions - the call's questions, echoed from its recorded arguments.
 * @returns the appended fixture lines, ending in the closing `turn/end`.
 */
function lateReplyTail(callId: string, questions: unknown): string[] {
  const message = lateReplyMessage(callId, questions)
  return [
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [message] } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'step/start', data: { turn: 2, step: 1 } },
    { type: 'user/message', data: message, surfaceOp: 'append' },
    { type: 'step/end', data: { turn: 2, step: 1 } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ].map(event => JSON.stringify(event))
}

/**
 * Derive one settlement other than the recorded answer batch. The model step
 * that follows the Tool settlement reads the answer, so every derivation drops
 * it and keeps the recorded turn closed.
 * @param fixture - the recorded round trip.
 * @param outcome - `cancelled` settles the call as the user's own dismissal;
 * `queued` and `late-answered` settle the expired wait and append its reply
 * before or after the next turn admits it.
 * @returns the derived fixture text.
 */
function resettledFixture(fixture: string, outcome: 'cancelled' | 'queued' | 'late-answered'): string {
  let asked: { callId: string; questions: unknown } | undefined
  let replaced = false
  const lines: string[] = []
  for (const line of fixture.trimEnd().split('\n')) {
    const event: unknown = JSON.parse(line)
    if (!isRecord(event)) throw new Error('question fixture event is invalid')
    if (event.type === 'session') {
      event.createdAt = WEB_FIXTURE_TIME
      lines.push(JSON.stringify(event))
      continue
    }
    if (replaced) {
      const data = event.data
      if ((event.type === 'step/end' && isRecord(data) && data.step === 1)
        || event.type === 'turn/end') lines.push(line)
      continue
    }
    if (event.type === 'request/header' && outcome !== 'cancelled') {
      // The recording was made under the blocking legacy tool; the derived
      // timed settlement needs the header that tool's timed sibling records.
      const data = event.data
      if (!isRecord(data) || !isRecord(data.header)) throw new Error('question fixture request/header is invalid')
      data.header.tools = [TIMED_ASK_USER_QUESTION_SCHEMA]
      lines.push(JSON.stringify(event))
      continue
    }
    if (event.type === 'tool/call') {
      const data = event.data
      if (!isRecord(data) || typeof data.callId !== 'string' || typeof data.arguments !== 'string') {
        throw new Error('question fixture tool/call is invalid')
      }
      const args: unknown = JSON.parse(data.arguments)
      if (!isRecord(args)) throw new Error('question fixture tool/call arguments are invalid')
      asked = { callId: data.callId, questions: args.questions }
      lines.push(line)
      continue
    }
    if (event.type !== 'tool/result') {
      lines.push(line)
      continue
    }
    const data = event.data
    if (!isRecord(data)) throw new Error('question fixture tool/result data is invalid')
    const message = data.message
    if (!isRecord(message) || !Array.isArray(message.content) || !isRecord(message.content[0])) {
      throw new Error('question fixture tool/result message is invalid')
    }
    if (asked === undefined) throw new Error('question fixture settles a call it never made')
    if (outcome === 'cancelled') {
      message.content[0].content = [{
        type: 'text',
        text: 'Error: the user cancelled ask_user_question',
      }]
      message.content[0].isError = true
      data.error = {
        name: 'UserQuestionError',
        code: 'ASK_CANCELLED',
      }
    } else {
      message.content[0].content = [{ type: 'text', text: pendingResultText(asked.callId) }]
    }
    replaced = true
    lines.push(JSON.stringify(event))
  }
  if (!replaced || asked === undefined) throw new Error('question fixture has no settled ask_user_question call')
  if (outcome === 'queued') {
    const end = lines.pop()
    const final: unknown = end === undefined ? undefined : JSON.parse(end)
    if (!isRecord(final) || final.type !== 'turn/end') throw new Error('question fixture does not end its first turn')
    return `${[...lines, lateReplyTail(asked.callId, asked.questions)[0], end].join('\n')}\n`
  }
  const tail = outcome === 'cancelled' ? [] : lateReplyTail(asked.callId, asked.questions)
  return `${[...lines, ...tail].join('\n')}\n`
}

/** One derived transcript, seeded into its own scaffold and opened in the browser. */
interface SeededTranscript {
  readonly scaffold: WebScaffold
  readonly browser: Browser
  readonly page: Page
  readonly tripwire: ReturnType<typeof watchConsole>
}

/**
 * Seed one derived fixture and open its Session in a fresh browser.
 * @param fixtureText - the derived fixture to persist.
 * @param seedId - the seeded Session id, which its golden tokenizes.
 * @returns the scaffold, browser, page, and console tripwire teardown closes.
 */
async function openSeededTranscript(fixtureText: string, seedId: string): Promise<SeededTranscript> {
  const scaffold = await launchWebScaffold({})
  let browser: Browser | undefined
  try {
    await seedSession(scaffold, fixtureText, seedId, undefined, { createdAt: WEB_FIXTURE_TIME })
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    await pinBrowserClock(page)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    return { scaffold, browser, page, tripwire }
  } catch (error) {
    await Promise.allSettled([browser?.close(), scaffold.close()])
    throw error
  }
}

describe('web e2e: resident question composer round trip', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []
  let answeredSession: SessionId | undefined
  let hostClock: ReturnType<typeof pinHostClock> | undefined

  beforeAll(async () => {
    if (MODE !== 'record') hostClock = pinHostClock()
    scaffold = await launchWebScaffold(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 15, compareReplaySession: true })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    if (MODE !== 'record') await pinBrowserClock(page)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // Fresh world: connect a Workspace so the composer scenarios start live.
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      try { await scaffold?.close() }
      finally { hostClock?.mockRestore() }
    }
  })

  it('asks through the composer, answers, and completes with the answer logged', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-question'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled(MODE === 'record' ? 180_000 : 30_000)
    await input.fill(PROMPT)
    await input.press('Enter')

    // The composer takes over the input area while the tool blocks. Its
    // presence is a STABLE waiting state (not a transient): it stays until
    // answered, so a plain waitFor is race-free.
    const composer = page.locator('[data-question-key]')
    await composer.waitFor({ timeout: MODE === 'record' ? 120_000 : 30_000 })
    await expect.poll(() => composer.getByText('Which color do you prefer?').count(), { timeout: 10_000 }).toBeGreaterThan(0)
    expect(await page.locator('[data-question-reply]').count()).toBe(0)

    const selectedRow = page.locator('[role="treeitem"][aria-selected="true"]')
    await expect.poll(() => selectedRow.locator('[data-state="warning"]').count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => selectedRow.getByText('Waiting for answer', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => selectedRow.getByText('Answer', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    expect(await selectedRow.getByText('now', { exact: true }).count()).toBe(0)

    if (MODE !== 'record') {
      // This golden owns the stable question surface; the answered-state
      // golden below owns the resulting transcript.
      const snapshot = await captureStableAria(page, '[data-question-key]', scaffold.workspaceCwd)
      const descriptions = await page.locator('[data-question-key] [role="checkbox"]').evaluateAll(nodes =>
        nodes.map(node => ({
          label: node.getAttribute('aria-label'),
          description: (node.getAttribute('aria-describedby') ?? '').split(/\s+/)
            .filter(Boolean).map(id => document.getElementById(id)?.textContent ?? '').join(' '),
        })))
      await compareOrRefreshGolden(UI_EXPECTED, `${snapshot}\nChoice descriptions: ${JSON.stringify(descriptions)}`, MODE)
      const sidebar = await captureStableAria(page, '[role="treeitem"][aria-selected="true"]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(SIDEBAR_EXPECTED, sidebar, MODE)
    }

    // Squeezed card: the question and compact option rows share one scrollport,
    // while navigation and submission stay outside it. Measured on the live
    // composer at seat heights that force the cap, then restored for the answer
    // gesture below. Replay only: record mode must reach the recording write
    // below, not abort on layout.
    const originalViewport = page.viewportSize() ?? { width: 1680, height: 1000 }
    if (MODE !== 'record') {
      const scrollStates: boolean[] = []
      for (const height of [520, 440, 380]) {
        await page.setViewportSize({ width: 640, height })
        const squeeze = await composer.evaluate((card) => {
          const rows = [...card.querySelectorAll<HTMLElement>('[data-option-row]')]
          const spill = rows.map(row => Math.max(...[...row.children].map((child) => {
            const box = row.getBoundingClientRect()
            const inner = child.getBoundingClientRect()
            return Math.max(box.top - inner.top, inner.bottom - box.bottom)
          })))
          const list = card.querySelector<HTMLElement>('[data-question-scroll]')
          const title = card.querySelector('h2')
          return {
            rows: rows.length,
            spill: Math.max(...spill),
            scrolls: list === null ? false : list.scrollHeight > list.clientHeight,
            titleInScrollport: list?.contains(title) === true,
          }
        })
        expect(squeeze.rows).toBeGreaterThan(0)
        for (const description of await composer.locator('[data-option-description]').all()) {
          await expect.poll(async () => {
            const copy = await description.evaluate(readCopy)
            return copy.lines <= 2 && copy.clipped === copy.overflows
              && copy.toggle === (copy.clipped ? 'expand' : undefined)
          }).toBe(true)
        }
        scrollStates.push(squeeze.scrolls)
        expect(squeeze.titleInScrollport).toBe(true)
        expect(await composer.getByRole('button', { name: 'Submit', exact: true }).isVisible()).toBe(true)
        // Sub-pixel tolerance: every row's copy stays inside its border box.
        expect(squeeze.spill).toBeLessThan(0.6)
      }
      expect(scrollStates).toContain(true)
      await page.setViewportSize(originalViewport)
    }

    // The narrowest supported card clips Blue's description to one line; its
    // toggle expands the text in place without choosing Blue.
    await page.setViewportSize({ width: 390, height: 700 })
    const blue = composer.getByRole('checkbox', { name: 'Blue' })
    const blueText = composer.locator('[data-option-description]').first()
    const blueToggle = composer.locator(`button[aria-controls=${JSON.stringify(await blueText.getAttribute('id'))}]`)
    await expect.poll(() => blueText.evaluate(readCopy)).toEqual({ lines: 1, clipped: true, overflows: true, toggle: 'expand' })
    // A clipped description's dropped line takes no clicks: the custom row's top edge belongs to it.
    expect(await composer.locator('[data-option-description]').last().evaluate(readCopy)).toMatchObject({ clipped: true })
    expect(await composer.locator('textarea').evaluate((field) => {
      const row = field.closest('[class*="customRow"]')
      if (!(row instanceof HTMLElement)) return false
      const box = row.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 2)
      return hit !== null && row.contains(hit)
    })).toBe(true)
    await blueToggle.click()
    expect(await blue.getAttribute('aria-checked')).toBe('false')
    expect(await blueToggle.getAttribute('aria-expanded')).toBe('true')
    expect(await blueText.evaluate(readCopy)).toMatchObject({ clipped: false, overflows: false, toggle: 'collapse' })
    await blueToggle.click()
    // A collapsed copy's scroll timeline reports the overflow from the next frame.
    await expect.poll(() => blueText.evaluate(readCopy)).toEqual({ lines: 1, clipped: true, overflows: true, toggle: 'expand' })
    await page.setViewportSize(originalViewport)

    // Multi-line custom answer: the field is a textarea whose hidden mirror
    // owns the box height, so a soft-wrapped or line-broken draft GROWS the
    // field instead of scrolling one line, and Shift+Enter breaks the line
    // rather than continuing the flow. Measured on the live composer because
    // only a real engine soft-wraps; growth stops at the mirror's cap, past
    // which the textarea is the one thing that scrolls. Replay only, same as
    // the squeeze above: record mode must reach the recording write.
    const custom = composer.getByRole('textbox')
    if (MODE !== 'record') {
      const oneLineHeight = await custom.evaluate(el => el.getBoundingClientRect().height)
      await custom.fill('a'.repeat(120))
      const wrapped = await custom.evaluate(el => ({
        height: el.getBoundingClientRect().height,
        scrolls: el.scrollHeight > el.clientHeight,
      }))
      expect(wrapped.height).toBeGreaterThan(oneLineHeight * 1.5)
      expect(wrapped.scrolls).toBe(false)

      await custom.fill('')
      await custom.press('Shift+Enter')
      await custom.press('Shift+Enter')
      expect(await custom.inputValue()).toBe('\n\n')
      expect(await composer.getByText('Which color do you prefer?').count()).toBeGreaterThan(0)
      expect(await custom.evaluate(el => el.getBoundingClientRect().height))
        .toBeGreaterThan(oneLineHeight * 2.5)

      expect(await capMetrics(custom)).toEqual({ textLines: CAP_LINES, scrolls: true })
      await custom.fill('')
    }

    await blue.click()
    await custom.fill('Include accessibility notes')
    expect(await blue.getAttribute('aria-checked')).toBe('true')
    expect(await custom.inputValue()).toBe('Include accessibility notes')
    if (MODE !== 'record') {
      // Replay only, like the measurements above: record mode must reach the
      // recording write. This fixture composes the shipped legacy tool, whose
      // request carries no call id and whose row offers no pill: the projection
      // never lists a legacy call, so the transcript reads exactly as it did
      // before timed questions existed. Reopening a hidden panel belongs to the
      // timed tool; the late-answered scenario below and the ui-user-questions
      // unit specs cover it.
      expect(await page.getByRole('button', { name: 'Answer', exact: true }).count()).toBe(0)

      // A strict Session-slot switch remounts the composer. Open a fresh blank
      // Session, then return to the still-waiting request and require its
      // Session-scoped store to restore both option and free-text drafts.
      const originalRow = page.locator('[role="treeitem"]')
        .filter({ hasText: 'Use the ask_user_question tool' }).first()
      await page.getByRole('button', { name: 'New session', exact: true }).last().click()
      // Scope to the tree: the wide sidebar's New Session button carries the
      // same visible label, and an unscoped match would either settle on the
      // button before the row exists or trip strict mode once it does.
      await page.getByRole('tree', { name: 'Sessions' })
        .getByText('New Session', { exact: true }).waitFor({ timeout: 15_000 })
      await expect.poll(() => composer.count(), { timeout: 10_000 }).toBe(0)
      await originalRow.click()
      await composer.waitFor({ timeout: 15_000 })
      expect(await blue.getAttribute('aria-checked')).toBe('true')
      expect(await custom.inputValue()).toBe('Include accessibility notes')

      // This golden now owns the composed state after a real A -> B -> A
      // Session cycle, not merely the state before the remount.
      const snapshot = await captureStableAria(page, '[data-question-key]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(COMPOSED_EXPECTED, snapshot, MODE)
    }
    await custom.press('Enter')

    const sessionId = await settled
    if (MODE === 'record') {
      await recordFixture(scaffold, sessionId, FIXTURE)
      return
    }
    answeredSession = sessionId
    // World state: the tool result carries the chosen answer, and DONE lands.
    const results = sessionEvents.filter(e => e.type === 'tool/result')
    const answerText = results.flatMap(event => event.data.message.content
      .filter(item => item.type === 'text')
      .map(item => item.text),
    ).at(-1)
    expect(JSON.parse(answerText ?? '')).toEqual({
      answers: [{ id: 'color', selected: ['Blue'], custom: 'Include accessibility notes' }],
    })
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    // Composer gone; regular input restored.
    expect(await page.locator('[data-question-key]').count()).toBe(0)
    expect(await selectedRow.locator('[data-state="warning"]').count()).toBe(0)
    await expect.poll(() => page.locator('[data-composer-input]').first().isEnabled(), { timeout: 10_000 }).toBe(true)
    const reply = page.locator('[data-question-reply]')
    await reply.waitFor({ state: 'visible', timeout: 15_000 })
    expect(await reply.count()).toBe(1)
    expect(await reply.getByText('Which color do you prefer?', { exact: true }).count()).toBe(1)
    expect(await reply.getByText('Blue, Include accessibility notes', { exact: true }).count()).toBe(1)
    expect(await reply.getByText('Green', { exact: true }).count()).toBe(0)
    expect(await reply.getByText('A cool recessive hue', { exact: false }).count()).toBe(0)
    expect(await reply.locator('[aria-expanded]').count()).toBe(0)
    const processControl = page.locator('[data-turn-process]').first()
    const processGroups = page.locator('[data-step-process]')
    await expect.poll(() => processControl.isEnabled(), { timeout: 10_000 }).toBe(true)
    await expect.poll(() => processControl.getAttribute('aria-expanded')).toBe('false')
    expect(await processGroups.count()).toBeGreaterThan(0)
    await expect.poll(async () => {
      for (const group of await processGroups.all()) if (await group.isVisible()) return false
      return true
    }).toBe(true)
    expect(await reply.isVisible()).toBe(true)
    expect(await page.getByText('DONE', { exact: true }).isVisible()).toBe(true)
    await processControl.click()
    await expect.poll(() => processControl.getAttribute('aria-expanded')).toBe('true')
    await expect.poll(() => processGroups.first().isVisible()).toBe(true)
    await processControl.click()
    await expect.poll(() => processControl.getAttribute('aria-expanded')).toBe('false')
    await expect.poll(() => processGroups.first().isVisible()).toBe(false)
    expect(await reply.isVisible()).toBe(true)
    expect(await reply.getByText('Blue, Include accessibility notes', { exact: true }).isVisible()).toBe(true)
    // Compact mode retains the answered batch outside the folded process.
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(ANSWERED_EXPECTED, snapshot, MODE)
    // Keep the ask_user_question card's readable answer in the expanded golden
    // even though Compact mode hides the process by default.
    await expandTurnProcesses(page)
    // A legacy call's answered row carries no pill and no read-only panel; its
    // accessible name is the bare summary, as before timed questions existed.
    const answeredRow = page.getByRole('button', { name: 'Ask question 1/1 answered', exact: true })
    await answeredRow.click()
    await page.locator('[data-tool="ask_user_question"]')
      .getByText('Which color do you prefer?', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await page.getByText('Blue', { exact: true }).count()).toBeGreaterThanOrEqual(1)
    expect(await page.locator('[data-tool="ask_user_question"]')
      .getByText('Include accessibility notes', { exact: true }).count()).toBe(1)
    expect(await page.getByText(/"answers"/).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'View answers', exact: true }).count()).toBe(0)
    const expanded = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(ANSWERED_EXPANDED_EXPECTED, expanded, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 200_000)

  // The fixture's question carries options, so the round trip above only ever
  // exercises the inline shape. The optionless shape is the one that carries
  // padding, which is where a cap measured in box pixels drifts off the line
  // count — so it is asked straight through the user-questions seam (the same
  // service the tool calls; no model round is involved in a layout metric).
  it.skipIf(MODE === 'record')('grows the optionless answer to the same cap', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-question-optionless'))
    const sessionId = answeredSession
    expect(sessionId).toBeDefined()
    const agent = scaffold.ctx.agents.get(sessionId as SessionId)
    expect(agent).toBeDefined()
    const asked = scaffold.ctx.userQuestions.ask({
      agent: agent as NonNullable<typeof agent>,
      questions: [{ id: 'free', header: 'More', question: 'Anything else?' }],
    })

    const composer = page.locator('[data-question-key]')
    await composer.waitFor({ timeout: 30_000 })
    const field = composer.getByRole('textbox')
    // The empty field reserves its two lines AND the textarea fills that frame:
    // a reserved box the control does not fill leaves a strip that looks like
    // the field but takes no click.
    expect(await field.evaluate((el) => {
      const frame = el.parentElement as HTMLElement
      const style = getComputedStyle(frame)
      const inner = frame.getBoundingClientRect().height
        - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth)
      return {
        reserved: Math.round(frame.getBoundingClientRect().height),
        fills: Math.abs(el.getBoundingClientRect().height - inner) < 0.5,
      }
    })).toEqual({ reserved: 64, fills: true })
    // The same cap the inline shape stops at — the assertion a border-box cap fails.
    expect(await capMetrics(field)).toEqual({ textLines: CAP_LINES, scrolls: true })

    // Settle the wait so teardown is not racing a pending question.
    await composer.getByRole('button', { name: 'Skip' }).click()
    expect(await asked).toEqual({ answers: [{ id: 'free', selected: [] }] })
    await expect.poll(() => page.locator('[data-question-key]').count(), { timeout: 10_000 }).toBe(0)
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps short option explanations beside their labels', async () => {
    const sessionId = answeredSession
    expect(sessionId).toBeDefined()
    const agent = scaffold.ctx.agents.get(sessionId as SessionId)
    expect(agent).toBeDefined()
    const controller = new AbortController()
    const asked = scaffold.ctx.userQuestions.ask({
      agent: agent as NonNullable<typeof agent>,
      signal: controller.signal,
      questions: [{
        id: 'reasoning',
        header: '确认思考等级',
        question: '选择 HF provider 的思考等级？',
        options: [
          { label: '高（high）', description: '倾向更充分的推理，通常更慢、消耗更多 token，需模型支持。' },
          { label: '中（medium）', description: '平衡推理深度与速度；需模型支持。' },
          { label: '低（low）', description: '优先速度与较低 token 消耗；需模型支持。' },
          { label: '先查看当前配置', description: '先确认 HF provider 的模型及其支持的思考参数，再决定。' },
        ],
      }],
    })
    const outcome = asked.then(value => ({ value }), (error: unknown) => ({ error }))
    const composer = page.locator('[data-question-key]')
    const original = page.viewportSize() ?? { width: 1680, height: 1000 }
    let completed = false
    try {
      await page.setViewportSize({ width: 1328, height: 720 })
      await composer.getByRole('heading', { name: '选择 HF provider 的思考等级？' }).waitFor()
      expect(await composer.getByRole('heading').evaluate(readCopy))
        .toEqual({ lines: 1, clipped: false, overflows: false, toggle: undefined })
      expect(await composer.getByRole('button', { name: 'Expand', exact: true }).count()).toBe(0)
      const rows = await composer.locator('[data-option-row]').evaluateAll(options => options.map((row) => {
        const label = row.querySelector<HTMLElement>('[data-option-line] > span:first-child')
        const description = row.querySelector<HTMLElement>('[data-option-description]')
        if (label === null || description === null) return null
        const style = getComputedStyle(description)
        return {
          sameLine: description.getBoundingClientRect().top < label.getBoundingClientRect().bottom,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          maskImage: style.maskImage,
        }
      }))
      expect(rows).toHaveLength(4)
      expect(rows).toEqual(Array.from({ length: 4 }, () => ({
        sameLine: true, fontSize: '13px', lineHeight: '20px', maskImage: 'none',
      })))
      await composer.getByRole('radio', { name: '中（medium）' }).click()
      await composer.getByRole('button', { name: 'Submit', exact: true }).click()
      expect(await outcome).toEqual({ value: { answers: [{ id: 'reasoning', selected: ['中（medium）'] }] } })
      completed = true
    } finally {
      controller.abort()
      const cleanup = await Promise.allSettled([outcome, page.setViewportSize(original)])
      if (completed) {
        const failure = cleanup.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failure !== undefined) throw failure.reason
      }
    }
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps long questions answerable in short and zoomed viewports', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-question-long-copy'))
    const sessionId = answeredSession
    expect(sessionId).toBeDefined()
    const agent = scaffold.ctx.agents.get(sessionId as SessionId)
    expect(agent).toBeDefined()
    const question = Array.from({ length: 8 }, () => 'The release gate reports that the installed application graph still contains an experimental package through a default dependency. Which approach should we use to preserve explicit installation while keeping the supported application graph valid?').join(' ')
    const detail = 'Review the shipped profile, package ownership, upgrade impact, and the path users follow before choosing. The answer must preserve the existing release invariant, avoid a hidden compatibility path, and remain understandable to people who did not participate in the implementation discussion.'
    const description = Array.from({ length: 48 }, (_, index) =>
      `Migration step ${String(index + 1)} removes the experimental client from shipped templates, requires an explicit profile install, names the affected users, and records the cross-platform validation before rollout.`).join(' ')
    const controller = new AbortController()
    const asked = scaffold.ctx.userQuestions.ask({
      agent: agent as NonNullable<typeof agent>,
      signal: controller.signal,
      questions: [{
        id: 'release',
        header: 'Release decision',
        question,
        detail,
        multiSelect: true,
        options: [
          { label: 'Explicit install', description },
          { label: 'Keep the default edge', description: 'Keep the current setup.' },
          { label: 'Move the package', description: 'Move it to a separately installed package with an explicit profile entry.' },
        ],
      }, { id: 'followup', question: 'Who should own the rollout?', options: [{ label: 'Release team' }] }],
    })
    const outcome = asked.then(value => ({ value }), (error: unknown) => ({ error }))

    const composer = page.locator('[data-question-key]')
    const original = page.viewportSize() ?? { width: 1680, height: 1000 }
    let bodyCompleted = false
    try {
      await composer.waitFor({ timeout: 30_000 })
      const heading = composer.getByRole('heading', { name: question })
      const descriptionOf = (label: string) => composer.locator('[data-option-row]', {
        has: page.getByRole('checkbox', { name: label, exact: true }),
      }).locator('[data-option-description]')
      const toggleFor = async (copy: Locator) =>
        composer.locator(`button[aria-controls=${JSON.stringify(await copy.getAttribute('id'))}]`)
      const readMetrics = () => composer.evaluate((card) => {
        const scroll = card.querySelector<HTMLElement>('[data-question-scroll]')
        const title = card.querySelector<HTMLElement>('h2')
        const submit = [...card.querySelectorAll<HTMLButtonElement>('button')]
          .find(button => button.textContent === 'Next')
        if (scroll === null || title === null || submit === undefined) return null
        const submitBox = submit.getBoundingClientRect()
        return {
          footerFits: submitBox.top >= -0.5 && submitBox.bottom <= window.innerHeight + 0.5,
          scrolls: scroll.scrollHeight > scroll.clientHeight,
          titleInScrollport: scroll.contains(title),
        }
      })
      // Cover common desktop sizes plus the CSS-pixel equivalents of a
      // progressively zoomed 640x420 window without changing browser-global zoom.
      const scrollStates: boolean[] = []
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 900, height: 600 },
        { width: 640, height: 420 },
        { width: 512, height: 336 },
        { width: 427, height: 280 },
        { width: 390, height: 700 },
      ]) {
        await page.setViewportSize(viewport)
        await expect.poll(readMetrics).not.toBeNull()
        const metrics = await readMetrics()
        expect(metrics?.footerFits).toBe(true)
        expect(metrics?.titleInScrollport).toBe(true)
        scrollStates.push(metrics?.scrolls ?? false)
        // Past its three-line budget the question keeps two lines; past its
        // two-line budget a description keeps one. Copy within budget shows in full.
        await expect.poll(() => heading.evaluate(readCopy))
          .toEqual({ lines: 2, clipped: true, overflows: true, toggle: 'expand' })
        expect(await descriptionOf('Explicit install').evaluate(readCopy))
          .toEqual({ lines: 1, clipped: true, overflows: true, toggle: 'expand' })
        expect(await descriptionOf('Keep the default edge').evaluate(readCopy))
          .toEqual({ lines: 1, clipped: false, overflows: false, toggle: undefined })
        for (const copy of await composer.locator('[data-option-description]').all()) {
          const drawn = await copy.evaluate(readCopy)
          expect(drawn.clipped).toBe(drawn.overflows)
          expect(drawn.toggle).toBe(drawn.clipped ? 'expand' : undefined)
          expect(drawn.lines).toBeLessThanOrEqual(drawn.clipped ? 1 : 2)
        }
        if (viewport.width === 512) {
          expect(await descriptionOf('Move the package').evaluate(readCopy))
            .toEqual({ lines: 2, clipped: false, overflows: false, toggle: undefined })
        }
        const textMetrics = await composer.locator('[data-option-description]').evaluateAll(nodes => nodes.map((node) => {
          const style = getComputedStyle(node)
          const rect = node.getBoundingClientRect()
          return { fontSize: style.fontSize, lineHeight: style.lineHeight,
            fitsViewport: rect.left >= 0 && rect.right <= innerWidth }
        }))
        expect(textMetrics).toEqual(Array.from({ length: 3 }, () => ({
          fontSize: '13px', lineHeight: '20px', fitsViewport: true,
        })))
      }
      expect(scrollStates).toContain(false)
      expect(scrollStates).toContain(true)

      // A clipped question's dropped line takes no clicks: the detail's first line belongs to the detail.
      expect(await composer.getByText(detail, { exact: true }).evaluate((text) => {
        const box = text.getBoundingClientRect()
        const hit = document.elementFromPoint(box.left + 8, box.top + 3)
        return hit !== null && text.contains(hit)
      })).toBe(true)

      // The question expands in place; its choices move down inside the
      // scrollport while navigation and submission stay reachable.
      const questionToggle = await toggleFor(heading)
      expect(await questionToggle.getAttribute('aria-expanded')).toBe('false')
      expect(await questionToggle.getAttribute('aria-label')).toBe('Expand')
      expect(await questionToggle.getAttribute('aria-describedby')).toBe(await heading.getAttribute('id'))
      await questionToggle.click()
      expect(await questionToggle.getAttribute('aria-expanded')).toBe('true')
      expect(await questionToggle.getAttribute('aria-label')).toBe('Collapse')
      const expandedQuestion = await heading.evaluate(readCopy)
      expect(expandedQuestion).toMatchObject({ clipped: false, overflows: false, toggle: 'collapse' })
      expect(expandedQuestion.lines).toBeGreaterThan(3)
      expect(await questionToggle.evaluate(belowText, await heading.elementHandle())).toBe(true)
      expect(await readMetrics()).toEqual({ footerFits: true, scrolls: true, titleInScrollport: true })
      await questionToggle.click()
      await expect.poll(() => heading.evaluate(readCopy)).toEqual({ lines: 2, clipped: true, overflows: true, toggle: 'expand' })

      const detailText = composer.getByText(detail, { exact: true })
      expect(await detailText.evaluate(node => node.closest('[data-question-scroll]') !== null)).toBe(true)
      await detailText.scrollIntoViewIfNeeded()
      expect(await detailText.isVisible()).toBe(true)
      expect(await composer.getByRole('button', { name: 'Next', exact: true }).isVisible()).toBe(true)

      // A description expands in place without choosing its option, and its
      // toggle stays described by the text it controls.
      const explicit = composer.getByRole('checkbox', { name: 'Explicit install' })
      const explicitText = descriptionOf('Explicit install')
      const descriptionToggle = await toggleFor(explicitText)
      const descriptionId = await explicitText.getAttribute('id')
      expect(await explicit.getAttribute('aria-describedby')).toBe(descriptionId)
      expect(await descriptionToggle.getAttribute('aria-describedby')).toBe(descriptionId)
      expect(await descriptionToggle.getAttribute('aria-label')).toBe('Expand')
      await descriptionToggle.click()
      expect(await explicit.getAttribute('aria-checked')).toBe('false')
      const expandedDescription = await explicitText.evaluate(readCopy)
      expect(expandedDescription).toMatchObject({ clipped: false, overflows: false, toggle: 'collapse' })
      expect(expandedDescription.lines).toBeGreaterThan(2)
      expect(await descriptionToggle.evaluate(belowText, await explicitText.elementHandle())).toBe(true)
      expect(await explicitText.evaluate((text) => {
        const row = text.closest('[data-option-row]') as HTMLElement
        return [...row.querySelectorAll<HTMLElement>('*')].every(child =>
          child.getBoundingClientRect().bottom <= row.getBoundingClientRect().bottom + 0.5)
      })).toBe(true)

      // The toggle's icon keeps non-text contrast on the card in both themes.
      const palette: string[] = []
      const originalDarkTheme = await page.locator('body').getAttribute('data-ds-dark-theme')
      try {
        for (const dark of [false, true]) {
          await page.evaluate((value) => { document.body.toggleAttribute('data-ds-dark-theme', value) }, dark)
          const colors = await descriptionToggle.evaluate((toggle) => {
            const card = toggle.closest('section')
            return card === null ? null : { text: getComputedStyle(toggle).color, surface: getComputedStyle(card).backgroundColor }
          })
          if (colors === null) throw new Error('The question card is unavailable')
          const channels = (color: string) => color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? []
          const luminance = (color: string) => channels(color).reduce((total, channel, index) => {
            const normalized = channel / 255
            const linear = normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
            return total + linear * [0.2126, 0.7152, 0.0722][index]!
          }, 0)
          const foreground = luminance(colors.text)
          const background = luminance(colors.surface)
          expect((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05))
            .toBeGreaterThanOrEqual(3)
          palette.push(colors.surface)
        }
        expect(palette[0]).not.toBe(palette[1])
      } finally {
        await page.evaluate((previous) => {
          if (previous === null) document.body.removeAttribute('data-ds-dark-theme')
          else document.body.setAttribute('data-ds-dark-theme', previous)
        }, originalDarkTheme)
      }
      await descriptionToggle.click()
      await expect.poll(() => explicitText.evaluate(readCopy))
        .toEqual({ lines: 1, clipped: true, overflows: true, toggle: 'expand' })

      await composer.getByRole('checkbox', { name: 'Explicit install' }).click()
      const answer = composer.getByRole('textbox')
      await answer.fill('Keep the migration steps explicit.')
      await answer.press('Enter')
      await composer.getByRole('heading', { name: 'Who should own the rollout?' }).waitFor()
      expect(await answer.evaluate(node => document.activeElement === node)).toBe(true)
      await page.keyboard.type('Release owner')
      expect(await answer.inputValue()).toBe('Release owner')
      await composer.getByRole('button', { name: 'Submit', exact: true }).click()
      expect(await outcome).toEqual({
        value: {
          answers: [{
            id: 'release',
            selected: ['Explicit install'],
            custom: 'Keep the migration steps explicit.',
          }, { id: 'followup', selected: [], custom: 'Release owner' }],
        },
      })
      await expect.poll(() => page.locator('[data-question-key]').count(), { timeout: 10_000 }).toBe(0)
      bodyCompleted = true
    } finally {
      controller.abort()
      const cleanup = await Promise.allSettled([outcome, page.setViewportSize(original)])
      if (bodyCompleted) {
        const failure = cleanup.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failure !== undefined) throw failure.reason
      }
    }
  }, 60_000)

  it.skipIf(MODE === 'record')('re-evaluates long copy when the chat column or the window changes width', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-question-chat-width'))
    const sessionId = answeredSession
    expect(sessionId).toBeDefined()
    const agent = scaffold.ctx.agents.get(sessionId as SessionId)
    expect(agent).toBeDefined()
    // Sized for the chat-width drag range: the question takes three lines or
    // fewer in the widest chat column and more in the narrowest, and the staged
    // description takes two lines or fewer and more.
    const question = `${Array.from({ length: 2 }, () => 'The rollout plan must name the release owner, the verification lanes that gate it, and the rollback path before the candidate is cut.').join(' ')} Which plan should we adopt?`
    const staged = 'Stage the rollout behind the release channel first, keep the experimental client out of every shipped template, ask plugin authors to declare the dependency explicitly, and publish the upgrade note together with the cross-platform validation results.'
    const explicit = Array.from({ length: 24 }, (_, index) =>
      `Step ${String(index + 1)} removes the experimental client from shipped templates and records the validation before rollout.`).join(' ')
    const controller = new AbortController()
    const asked = scaffold.ctx.userQuestions.ask({
      agent: agent as NonNullable<typeof agent>,
      signal: controller.signal,
      questions: [{
        id: 'rollout',
        header: 'Rollout decision',
        question,
        options: [
          { label: 'Explicit install', description: explicit },
          { label: 'Stage the rollout', description: staged },
          { label: 'Keep the default edge', description: 'Keep the current setup.' },
        ],
      }],
    })
    const outcome = asked.then(value => ({ value }), (error: unknown) => ({ error }))

    const composer = page.locator('[data-question-key]')
    const frame = page.locator('[style*="grid-template-columns"]').first()
    const original = page.viewportSize() ?? { width: 1680, height: 1000 }
    let bodyCompleted = false
    try {
      await page.setViewportSize({ width: 1680, height: 1000 })
      await composer.waitFor({ timeout: 30_000 })
      const heading = composer.getByRole('heading', { name: question })
      const descriptionOf = (label: string) => composer.locator('[data-option-row]', {
        has: page.getByRole('radio', { name: label, exact: true }),
      }).locator('[data-option-description]')
      const toggleFor = async (copy: Locator) =>
        composer.locator(`button[aria-controls=${JSON.stringify(await copy.getAttribute('id'))}]`)
      // Settled layout: no AppFrame column transition in flight, then every
      // collapsed copy drawn as its own overflow decides, the expanded copy
      // still expanded, and the actions reachable.
      const settle = async () => {
        await expect.poll(() => frame.evaluate(node => node.hasAttribute('data-animating'))).toBe(false)
        const read = async () => {
          const card = await composer.locator('section').evaluate((section) => {
            const scroll = section.querySelector<HTMLElement>('[data-question-scroll]')
            const submit = [...section.querySelectorAll<HTMLButtonElement>('button')]
              .find(button => button.textContent === 'Submit')
            const submitBox = submit?.getBoundingClientRect()
            return {
              width: Math.round(section.getBoundingClientRect().width),
              actionsReachable: submitBox !== undefined && submitBox.top >= -0.5 && submitBox.bottom <= window.innerHeight + 0.5,
              titleInScrollport: scroll?.contains(section.querySelector('h2')) === true,
            }
          })
          return {
            card,
            question: await heading.evaluate(readCopy),
            explicit: await descriptionOf('Explicit install').evaluate(readCopy),
            staged: await descriptionOf('Stage the rollout').evaluate(readCopy),
            short: await descriptionOf('Keep the default edge').evaluate(readCopy),
          }
        }
        await expect.poll(async () => {
          const state = await read()
          const decided = (copy: Awaited<ReturnType<typeof read>>['question'], budget: number) =>
            copy.clipped === copy.overflows && copy.toggle === (copy.clipped ? 'expand' : undefined)
            && copy.lines <= (copy.clipped ? budget - 1 : budget)
          return state.card.actionsReachable && state.card.titleInScrollport
            && decided(state.question, 3) && decided(state.staged, 2) && decided(state.short, 2)
            && !state.explicit.clipped && !state.explicit.overflows && state.explicit.toggle === 'collapse'
        }).toBe(true)
        return await read()
      }
      // The right transcript handle widens the content column by twice its
      // outward travel. The composer seat covers the handle's lower part, so
      // the gesture grabs it beside the transcript.
      const dragChatWidth = async (travel: number) => {
        const box = await page.locator('[data-width-handle="right"]').boundingBox()
        if (box === null) throw new Error('The chat width handle is not rendered')
        const x = box.x + box.width / 2
        const y = box.y + 120
        await page.mouse.move(x, y)
        await page.mouse.down()
        try {
          await page.mouse.move(x + travel, y, { steps: 8 })
        } finally {
          await page.mouse.up()
        }
      }

      // Expanded copy is the user's choice and survives every width change below.
      const explicitToggle = await toggleFor(descriptionOf('Explicit install'))
      await explicitToggle.click()
      expect(await explicitToggle.getAttribute('aria-expanded')).toBe('true')
      expect(await composer.getByRole('radio', { name: 'Explicit install', exact: true }).getAttribute('aria-checked')).toBe('false')

      await dragChatWidth(-400)
      const narrow = await settle()
      expect(narrow.question).toEqual({ lines: 2, clipped: true, overflows: true, toggle: 'expand' })
      expect(narrow.staged).toEqual({ lines: 1, clipped: true, overflows: true, toggle: 'expand' })

      await dragChatWidth(600)
      const wide = await settle()
      expect(wide.card.width).toBeGreaterThan(narrow.card.width)
      expect(wide.question).toMatchObject({ clipped: false, overflows: false, toggle: undefined })
      expect(wide.staged).toEqual({ lines: 2, clipped: false, overflows: false, toggle: undefined })
      expect(wide.short).toEqual({ lines: 1, clipped: false, overflows: false, toggle: undefined })

      // The right sidebar narrows the conversation column, and collapsing it restores the wide state.
      await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
      const withSidebar = await settle()
      expect(withSidebar.card.width).toBeLessThan(wide.card.width)
      await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()
      expect(await settle()).toEqual(wide)

      // A smaller window clamps the dragged width; restoring the window restores it.
      await page.setViewportSize({ width: 900, height: 700 })
      const smallWindow = await settle()
      expect(smallWindow.card.width).toBeLessThan(wide.card.width)
      expect(smallWindow.question).toEqual({ lines: 2, clipped: true, overflows: true, toggle: 'expand' })
      expect(smallWindow.staged).toEqual({ lines: 1, clipped: true, overflows: true, toggle: 'expand' })
      await page.setViewportSize({ width: 1680, height: 1000 })
      expect(await settle()).toEqual(wide)

      await explicitToggle.click()
      await expect.poll(() => descriptionOf('Explicit install').evaluate(readCopy))
        .toEqual({ lines: 1, clipped: true, overflows: true, toggle: 'expand' })
      await composer.getByRole('radio', { name: 'Stage the rollout', exact: true }).click()
      await composer.getByRole('button', { name: 'Submit', exact: true }).click()
      expect(await outcome).toEqual({ value: { answers: [{ id: 'rollout', selected: ['Stage the rollout'] }] } })
      await expect.poll(() => page.locator('[data-question-key]').count(), { timeout: 10_000 }).toBe(0)
      bodyCompleted = true
    } finally {
      controller.abort()
      // The dragged width is a persisted preference; dropping it and resizing republishes the default.
      const cleanup = await Promise.allSettled([
        outcome,
        page.evaluate(() => { localStorage.removeItem('dsh.conversation.contentWidth') })
          .then(() => page.setViewportSize(original)),
      ])
      if (bodyCompleted) {
        const failure = cleanup.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failure !== undefined) throw failure.reason
      }
    }
  }, 90_000)

})

describe.skipIf(MODE === 'record')('web e2e: cancelled question transcript', () => {
  let seeded: SeededTranscript

  beforeAll(async () => {
    seeded = await openSeededTranscript(
      resettledFixture(await readFile(FIXTURE, 'utf8'), 'cancelled'),
      CANCELLED_SEED_ID,
    )
  }, 120_000)

  afterAll(async () => {
    await seeded?.browser.close()
    await seeded?.scaffold.close()
  })

  it('expands to the cancellation verdict and original questions', async () => {
    const { page: cancelledPage, scaffold, tripwire } = seeded
    onTestFailed(() => saveFailureShot(cancelledPage, 'web-e2e-question-cancelled-row'))
    await expandTurnProcesses(cancelledPage)
    const row = cancelledPage.getByRole('button', { name: 'Ask question cancelled', exact: true })
    await row.waitFor({ timeout: 15_000 })
    await row.click()

    await cancelledPage
      .getByText('This question set was cancelled before answers were submitted.', { exact: true })
      .waitFor({ timeout: 10_000 })
    await cancelledPage.getByText('Which color do you prefer?', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await cancelledPage.getByText(/"questions"/).count()).toBe(0)
    expect(await cancelledPage
      .getByText('Error: the user cancelled ask_user_question', { exact: true }).count()).toBe(0)

    const snapshot = (await captureStableAria(
      cancelledPage,
      '[class*="centerCol"]',
      scaffold.workspaceCwd,
    )).split(CANCELLED_SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(CANCELLED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)
})

describe.skipIf(MODE === 'record')('web e2e: queued question reply', () => {
  let seeded: SeededTranscript

  beforeAll(async () => {
    seeded = await openSeededTranscript(
      resettledFixture(await readFile(FIXTURE, 'utf8'), 'queued'),
      QUEUED_SEED_ID,
    )
  }, 120_000)

  afterAll(async () => {
    await seeded?.browser.close()
    await seeded?.scaffold.close()
  })

  it('keeps a submitted reply read-only across a browser reload', async () => {
    const { page, scaffold, tripwire } = seeded
    onTestFailed(() => saveFailureShot(page, 'web-e2e-question-queued-row'))
    await expandTurnProcesses(page)
    const row = page.locator('[data-tool="ask_user_question"]')
    await row.waitFor()
    await page.getByRole('button', { name: 'View answers', exact: true }).waitFor()
    expect(await page.locator('[data-question-key]').count()).toBe(0)

    await page.reload({ waitUntil: 'load' })
    await expandTurnProcesses(page)
    await row.waitFor()
    await page.getByRole('button', { name: 'View answers', exact: true }).waitFor()
    expect(await page.locator('[data-question-key]').count()).toBe(0)
    await page.getByRole('button', { name: 'View answers', exact: true }).click()
    await page.getByText('Answered after the timeout', { exact: true }).waitFor()

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(QUEUED_SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(QUEUED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)
})

// The timed tool's own second settlement. The recorded result is the expired
// wait, so the answers live in the reply that landed a turn later and reach the
// row only through the `userQuestions` projection — the whole chain the reported
// symptom broke on, where an answered question kept no way back to its answers.
describe.skipIf(MODE === 'record')('web e2e: late-answered question transcript', () => {
  let seeded: SeededTranscript

  beforeAll(async () => {
    seeded = await openSeededTranscript(
      resettledFixture(await readFile(FIXTURE, 'utf8'), 'late-answered'),
      LATE_ANSWERED_SEED_ID,
    )
  }, 120_000)

  afterAll(async () => {
    await seeded?.browser.close()
    await seeded?.scaffold.close()
  })

  it('reads a late answer as an answered question and reopens its answers', async () => {
    const { page: latePage, scaffold, tripwire } = seeded
    onTestFailed(() => saveFailureShot(latePage, 'web-e2e-question-late-answered-row'))
    const reply = latePage.locator('[data-question-reply]')
    await reply.waitFor({ state: 'visible', timeout: 15_000 })
    expect(await reply.count()).toBe(1)
    expect(await latePage.locator('[data-chat-flow-kind="turn-trigger"]').count()).toBe(0)
    expect(await reply.getByText('Which color do you prefer?', { exact: true }).count()).toBe(1)
    expect(await reply.getByText('Green, Answered after the timeout', { exact: true }).count()).toBe(1)
    expect(await reply.getByText('Blue', { exact: true }).count()).toBe(0)
    expect(await reply.getByText('A restful mid-spectrum hue', { exact: false }).count()).toBe(0)
    expect(await reply.locator('[aria-expanded]').count()).toBe(0)
    await expandTurnProcesses(latePage)
    expect(await reply.isVisible()).toBe(true)
    const row = latePage.locator('[data-tool="ask_user_question"]')
    await row.waitFor({ timeout: 15_000 })
    await row.getByRole('button', { name: 'Ask question', exact: true }).click()
    await row.getByText('Which color do you prefer?', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await latePage.getByText('Green', { exact: true }).count()).toBeGreaterThanOrEqual(1)
    expect(await latePage.getByText('Answered after the timeout', { exact: true }).count()).toBeGreaterThanOrEqual(1)
    // The recorded timeout is the row's state, never its transcript copy.
    expect(await latePage.getByText(/"pending"/).count()).toBe(0)

    // The same read-only panel an in-time answer reopens, over the answers the
    // late reply carried.
    await latePage.getByRole('button', { name: 'View answers', exact: true }).click()
    const review = latePage.locator('[data-question-key]')
    await review.waitFor({ timeout: 10_000 })
    await review.getByText('Answered', { exact: true }).waitFor({ timeout: 10_000 })
    const recorded = review.getByRole('checkbox', { name: 'Green' })
    expect(await recorded.getAttribute('aria-checked')).toBe('true')
    expect(await recorded.isDisabled()).toBe(true)
    expect(await review.getByRole('checkbox', { name: 'Blue' }).getAttribute('aria-checked')).toBe('false')
    const recordedCustom = review.getByRole('textbox')
    expect(await recordedCustom.inputValue()).toBe('Answered after the timeout')
    expect(await recordedCustom.isDisabled()).toBe(true)
    expect(await review.getByRole('button', { name: 'Submit' }).count()).toBe(0)
    expect(await review.getByRole('button', { name: 'Skip' }).count()).toBe(0)

    const snapshot = (await captureStableAria(
      latePage,
      '[class*="centerCol"]',
      scaffold.workspaceCwd,
    )).split(LATE_ANSWERED_SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(LATE_ANSWERED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.v3.jsonl',
      'ui.expected.md',
      'sidebar.expected.md',
      'composed.expected.md',
      'answered.expected.md',
      'cancelled.expected.md',
      'answered-expanded.expected.md',
      'late-answered.expected.md',
      'queued.expected.md',
    ])
  })
})


it.each(['another-feature', 'cua-app-access'])('answers %s approval without a specialized composer', async (id) => {
  const resources: { scaffold?: WebScaffold; browser?: Browser; waiting?: Promise<unknown> } = {}
  const controller = new AbortController()
  onTestFinished(async () => {
    controller.abort()
    await resources.waiting
    await resources.browser?.close()
    await resources.scaffold?.close()
  })
  const scaffold = await launchWebScaffold()
  resources.scaffold = scaffold
  const browser = await chromium.launch()
  resources.browser = browser
  const page = await newEnglishPage(browser)
  const tripwire = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, `web-approval-fallback-${id}`))
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const agent = scaffold.ctx.agents.list()[0]!
  const result = scaffold.ctx.userQuestions.ask({ agent, signal: controller.signal, questions: [{
    id, question: 'Allow fixture access?', detail: 'Only this request.',
    options: [{ label: 'Allow' }, { label: 'Deny' }],
    intent: { kind: 'approval', approve: 'Allow', reject: 'Deny' },
  }] })
  resources.waiting = Promise.allSettled([result])
  const question = page.locator('[data-question-key]')
  await question.getByRole('radio', { name: 'Deny', exact: true }).click()
  await question.getByRole('button', { name: 'Submit', exact: true }).click()
  expect(await result).toEqual({ answers: [{ id, selected: ['Deny'] }] })
  await question.waitFor({ state: 'hidden' })
  expect(tripwire.pageErrors).toEqual([])
})
