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
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TIMED_WAIT_PARAMETER } from '@deepseek-ai/dsh-user-questions'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import {
  connectFreshWorkspace, expandTurnProcesses, newEnglishPage, saveFailureShot,
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

// The options carry long descriptions on purpose: the squeeze assertion below
// needs option copy that WRAPS, which is the only text layout that reproduces a
// collapsed row painting its copy outside its own box.
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
      // Keep the derived session's relative-time header stable as the source
      // fixture ages.
      event.createdAt = Date.now()
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
    await seedSession(scaffold, fixtureText, seedId)
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
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

  beforeAll(async () => {
    scaffold = await launchWebScaffold(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 15, compareReplaySession: true })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // Fresh world: connect a Workspace so the composer scenarios start live.
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
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

    const selectedRow = page.locator('[role="treeitem"][aria-selected="true"]')
    await expect.poll(() => selectedRow.locator('[data-state="warning"]').count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => selectedRow.getByText('Waiting for answer', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => selectedRow.getByText('Answer', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    expect(await selectedRow.getByText('now', { exact: true }).count()).toBe(0)

    if (MODE !== 'record') {
      // This golden owns the stable question surface; the answered-state
      // golden below owns the resulting transcript.
      const snapshot = await captureStableAria(page, '[data-question-key]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
      const sidebar = await captureStableAria(page, '[role="treeitem"][aria-selected="true"]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(SIDEBAR_EXPECTED, sidebar, MODE)
    }

    // Squeezed card: the option rows are the capped card's scroll content, so
    // shrinking the seat must push overflow into the option list, never
    // collapse a row below the height its own copy needs — a collapsed row
    // paints its centered copy outside the row box, over the title and the
    // neighbouring rows. Measured on the live composer at seat heights that
    // force the cap, then restored for the answer gesture below. Replay only:
    // record mode must reach the recording write below, not abort on layout.
    if (MODE !== 'record') {
      const original = page.viewportSize() ?? { width: 1680, height: 1000 }
      for (const height of [520, 440, 380]) {
        await page.setViewportSize({ width: 900, height })
        const squeeze = await composer.evaluate((card) => {
          // Role/ARIA selectors, not the CSS-module class names: the built
          // client hashes those.
          const rows = [...card.querySelectorAll<HTMLElement>(
            '[role="radio"], [role="checkbox"], [aria-expanded]',
          )]
          const spill = rows.map(row => Math.max(...[...row.children].map((child) => {
            const box = row.getBoundingClientRect()
            const inner = child.getBoundingClientRect()
            return Math.max(box.top - inner.top, inner.bottom - box.bottom)
          })))
          const list = card.querySelector<HTMLElement>('[data-question-scroll]')
          return {
            rows: rows.length,
            spill: Math.max(...spill),
            // Wrapped option text is what overflows a collapsed row, and a
            // scrolling list proves the seat is genuinely capped. Without both,
            // the spill assertion would hold vacuously.
            wrappedRows: rows.filter(row => row.getBoundingClientRect().height > 42).length,
            scrolls: list === null ? false : list.scrollHeight > list.clientHeight,
          }
        })
        expect(squeeze.rows).toBeGreaterThan(0)
        expect(squeeze.wrappedRows).toBeGreaterThan(0)
        expect(squeeze.scrolls).toBe(true)
        // Sub-pixel tolerance: every row's copy stays inside its border box.
        expect(squeeze.spill).toBeLessThan(0.6)
      }
      await page.setViewportSize(original)
    }

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

    const blue = composer.getByRole('checkbox', { name: 'Blue' })
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
    // The default golden pins Compact mode before process disclosure.
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(ANSWERED_EXPECTED, snapshot, MODE)
    // Keep the ask_user_question card's readable answer in the expanded golden
    // even though Compact mode hides the process by default.
    await expandTurnProcesses(page)
    // A legacy call's answered row carries no pill and no read-only panel; its
    // accessible name is the bare summary, as before timed questions existed.
    const answeredRow = page.getByRole('button', { name: 'Ask question 1/1 answered', exact: true })
    await answeredRow.click()
    await page.getByText('Which color do you prefer?', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await page.getByText('Blue', { exact: true }).count()).toBeGreaterThanOrEqual(1)
    expect(await page.getByText('Include accessibility notes', { exact: true }).count()).toBe(1)
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
    await reply.waitFor({ state: 'attached', timeout: 15_000 })
    expect(await reply.count()).toBe(1)
    expect(await latePage.locator('[data-chat-flow-kind="turn-trigger"]').count()).toBe(0)
    expect(await reply.isVisible()).toBe(false)
    // Whether the answer beat the timeout is the agent's pacing, not something
    // a reader of the row has to reason about.
    await expandTurnProcesses(latePage)
    await reply.waitFor({ state: 'visible', timeout: 15_000 })
    const row = latePage.locator('[data-tool="ask_user_question"]')
    await row.waitFor({ timeout: 15_000 })
    await row.getByRole('button', { name: 'Ask question', exact: true }).click()
    await latePage.getByText('Which color do you prefer?', { exact: true }).waitFor({ timeout: 10_000 })
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
