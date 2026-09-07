// Web e2e scenarios for both steering entry points: QueueDock strictly
// transfers one queued occurrence, while the complementary composer gestures
// choose Queue or Steer. The question tool supplies a deterministic pending-
// steering snapshot before the step can drain.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm'
import {
  assertFixtureInventory, captureExpandedTurnProcessAria, captureStableAria,
  compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/steering', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v2.jsonl')
// Two goldens pin the transient Host projection and its durable handoff: the
// mid-turn state renders accepted steering from the Session control queue while the
// question blocks admission, then the settled state renders the same message
// from user/message beside the reply that obeys it.
const MID_EXPECTED = join(SNAPSHOT_DIR, 'mid-steer.expected.md')
const SETTLED_EXPECTED = join(SNAPSHOT_DIR, 'settled.expected.md')
const SETTLED_EXPANDED_EXPECTED = join(SNAPSHOT_DIR, 'settled-expanded.expected.md')
const MODE = webSnapshotMode()
// The question composer replaces the textarea, so fill → Queue row → Steer
// starts only after request/context and must finish before the first replay
// chunk. The compact canonical call plus 500 ms pacing gives loaded CI enough
// time without stretching a long provider-authored chunk sequence.
const REPLAY_PACE_MS = 500

const PROMPT = 'Use the ask_user_question tool to ask me exactly one question with id "checkpoint", question "Ready to continue?", header "Checkpoint", and options labeled "Yes" and "No". After I answer, reply with one short sentence acknowledging my answer and stop.'
const STEER = 'Interjection: include the word BANANA in your final reply.'

// Empty-draft flush scenario: an override-only fixture. The whole-script
// replacement answers both model calls of a FRESH session (no recorded
// session.jsonl exists — call 0 keeps the turn open with a question-tool
// call, call 1 is the reply after both steerings drain).
const STEER_ALL_DIR = fileURLToPath(new URL('./expected/steer-all', import.meta.url))
const STEER_ALL_FIXTURE = join(STEER_ALL_DIR, 'session.jsonl')
const STEER_ALL_OVERRIDE = join(STEER_ALL_DIR, 'replay.override.json')
const STEER_ALL_MID = join(STEER_ALL_DIR, 'mid-steer.expected.md')
const STEER_ALL_SETTLED = join(STEER_ALL_DIR, 'settled.expected.md')
const STEER_ALL_SETTLED_EXPANDED = join(STEER_ALL_DIR, 'settled-expanded.expected.md')
const STEER_ONE = 'Interjection: include the word BANANA in your final reply.'
const STEER_TWO = 'Interjection: include the word ORANGE in your final reply.'

/** Concatenated assistant text deltas — the model-visible reply body. */
function assistantText(events: SessionEvent[]): string {
  return events
    .flatMap(e => e.type === 'assistant/message' || e.type === 'assistant/attempt'
      ? expandAssistantStream(e.data.stream)
      : [])
    .map(({ chunk }) => chunk.type === 'text-delta' ? chunk.text : '')
    .join('')
}

/** Claimed user messages whose payload contains the exact scenario text. */
function claimedMessages(events: readonly SessionEvent[], text: string): SessionEvent<'user/message'>[] {
  return events.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && JSON.stringify(event.data.content).includes(text))
}

describe('web e2e: mid-turn steering lands durably and visibly', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold(MODE === 'record'
      ? {}
      : { replayFixture: FIXTURE, paceMs: REPLAY_PACE_MS, compareReplaySession: true })
    scaffold.ctx.on('session/event', (_session, event) => { sessionEvents.push(event) })
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

  it('strictly steers one queued row; the interjection is logged, rendered, and obeyed', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-steering'))
    if (MODE !== 'record') {
      // The steer lands as a durable user/message, so the inventory holds
      // both the opening prompt and the later same-turn steer.
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT, STEER])
    }
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled(MODE === 'record' ? 180_000 : 30_000)
    await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 10_000 })
    await input.fill(PROMPT)
    await input.press('Enter')
    await expect.poll(
      () => sessionEvents.some(event => event.type === 'request/context'),
      { timeout: 10_000 },
    ).toBe(true)

    // Enter remains the Queue gesture. In this live window the row action
    // atomically moves this exact occurrence into the current turn's steering outbox.
    await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 10_000 })
    await input.fill(STEER)
    await input.press('Enter')
    const queuedRow = page.getByRole('listitem').filter({ hasText: STEER })
    await queuedRow.waitFor({ timeout: 10_000 })
    const steerButton = queuedRow.getByRole('button', { name: 'Steer queued message' })
    await expect.poll(() => steerButton.isEnabled(), { timeout: 10_000 }).toBe(true)
    await steerButton.click({ timeout: 10_000 })
    const pendingSteering = page.locator('[data-pending-steering]').filter({ hasText: STEER })
    // A timeout while the Queue row remains means the command observed a
    // stopped Agent (`steer-unavailable`); inspect replay pacing first.
    await pendingSteering.waitFor({ timeout: 10_000 })

    // The blocked composer keeps steering pending long enough to observe the
    // Host-authoritative mirror before the loop admits it durably.
    const composer = page.locator('[data-question-key]')
    await composer.waitFor({ timeout: MODE === 'record' ? 120_000 : 30_000 })

    if (MODE !== 'record') {
      expect(await page.getByText(STEER, { exact: true }).count()).toBe(1)
      expect(await pendingSteering.count()).toBe(1)
      expect(await page.getByRole('button', { name: 'Edit queued message' }).count()).toBe(0)
      const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(MID_EXPECTED, snapshot, MODE)
    }

    // Answer the composer; the tool result closes the step, the loop drains
    // the steer as user/message, and the steered continuation runs the
    // final model call.
    await composer.getByRole('radio', { name: 'Yes' }).click()
    await composer.getByRole('radio', { name: 'Yes' }).press('Enter')
    await settled

    if (MODE === 'record') {
      const sessionId = await settled
      await recordFixture(scaffold, sessionId, FIXTURE)
      // Fixture honesty: a recording where the live model ignored the steer
      // would replay as a vacuous scenario — reject it and re-record instead.
      const recorded = parseSessionLog(await readFile(FIXTURE, 'utf8'))
      expect(claimedMessages(recorded, STEER)).toHaveLength(1)
      expect(assistantText(recorded)).toContain('BANANA')
      return
    }

    // Durable: exactly one claimed user/message carrying the steering text.
    const steerEvents = claimedMessages(sessionEvents, STEER)
    expect(steerEvents).toHaveLength(1)
    expect(JSON.stringify(steerEvents[0])).toContain('BANANA')
    const turnEnds = sessionEvents.filter(e => e.type === 'turn/end')
    expect(turnEnds).toHaveLength(1)
    expect((turnEnds[0] as SessionEvent & { data: { reason: { kind: string } } }).data.reason.kind).toBe('completed')

    // Visible: the plain steering bubble plus the reply that obeys it
    // (steer text + final reply each contain the marker word).
    await expect.poll(() => page.getByText(STEER, { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    expect(await pendingSteering.count()).toBe(0)
    await expect.poll(() => page.getByText('BANANA', { exact: false }).count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    expect(await page.locator('[data-question-key]').count()).toBe(0)
    // Settled golden: steer text between the question round trip and the
    // obeying reply, composer takeover gone.
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(SETTLED_EXPECTED, snapshot, MODE)
    const expanded = await captureExpandedTurnProcessAria(
      page,
      '[class*="centerCol"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(SETTLED_EXPANDED_EXPECTED, expanded, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 200_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.v2.jsonl', 'mid-steer.expected.md', 'settled.expected.md', 'settled-expanded.expected.md',
    ])
  })
})

describe('web e2e: composer shortcut steers directly', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, paceMs: REPLAY_PACE_MS, compareReplaySession: false })
    scaffold.ctx.on('session/event', (_session, event) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('uses Cmd+Enter without creating a Queue row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-steering'))
    expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT, STEER])
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled(30_000)
    await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 10_000 })
    await input.fill(PROMPT)
    await input.press('Enter')
    await page.getByRole('button', { name: 'Stop generating' }).waitFor({ timeout: 10_000 })

    await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 10_000 })
    await input.fill(STEER)
    await input.press('Meta+Enter')
    await expect.poll(() => input.textContent(), { timeout: 5_000 }).toBe('')
    expect(await page.locator('[data-queue-dock]').count()).toBe(0)

    const composer = page.locator('[data-question-key]')
    await composer.waitFor({ timeout: 30_000 })
    const pendingSteering = page.locator('[data-pending-steering]').filter({ hasText: STEER })
    await pendingSteering.waitFor({ timeout: 10_000 })
    await composer.getByRole('radio', { name: 'Yes' }).click()
    await composer.getByRole('radio', { name: 'Yes' }).press('Enter')
    await settled

    const steerEvents = claimedMessages(sessionEvents, STEER)
    expect(steerEvents).toHaveLength(1)
    await expect.poll(() => page.getByText(STEER, { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    expect(await pendingSteering.count()).toBe(0)
    await expect.poll(() => page.getByText('BANANA', { exact: false }).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(2)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})

describe('web e2e: composer shortcut follows the swapped busy behavior', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, paceMs: REPLAY_PACE_MS, compareReplaySession: false })
    scaffold.ctx.on('session/event', (_session, event) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('queues Cmd+Enter when plain Enter is configured to Steer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-swapped-shortcut'))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Queue' }).click()
    await page.getByRole('menuitem', { name: 'Steer' }).click()
    await dialog.getByRole('button', { name: 'Steer' }).waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')

    const input = page.locator('[data-composer-input]').first()
    const settled = scaffold.whenTurnSettled(30_000)
    await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 10_000 })
    await input.fill(PROMPT)
    await input.press('Enter')
    await page.getByRole('button', { name: 'Stop generating' }).waitFor({ timeout: 10_000 })

    const queuedText = 'Queued by the complementary Cmd+Enter shortcut.'
    await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 10_000 })
    await input.fill(queuedText)
    await input.press('Meta+Enter')
    const queuedRow = page.locator('[data-queue-dock]').getByRole('listitem').filter({ hasText: queuedText })
    await queuedRow.getByText(queuedText, { exact: true }).waitFor({ timeout: 10_000 })
    expect(await page.locator('[data-pending-steering]').filter({ hasText: queuedText }).count()).toBe(0)
    expect(claimedMessages(sessionEvents, queuedText)).toHaveLength(0)

    // Remove the asserted Queue row, then finish the recorded question turn
    // so replay teardown still proves that every fixture call was consumed.
    await queuedRow.getByRole('button', { name: 'Remove queued message' }).click()
    const composer = page.locator('[data-question-key]')
    await composer.waitFor({ timeout: 30_000 })
    await composer.getByRole('radio', { name: 'Yes' }).click()
    await composer.getByRole('radio', { name: 'Yes' }).press('Enter')
    await settled
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})

describe('web e2e: empty-draft Cmd+Enter steers the whole queue', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    // The scenario boots a fresh session against the override-only fixture;
    // the replay.override.json sidecar replaces the derived script, so the
    // (deliberately absent) session.jsonl is never read.
    scaffold = await launchWebScaffold({
      replayFixture: STEER_ALL_FIXTURE,
      replayOverride: STEER_ALL_OVERRIDE,
      paceMs: REPLAY_PACE_MS,
    })
    scaffold.ctx.on('session/event', (_session, event) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await page.getByText('Standard mode', { exact: true }).waitFor({ timeout: 10_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('queues two messages, then flushes both with an empty-draft Cmd+Enter', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-steer-all'))
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled(30_000)

    // Call 0 streams a question-tool call; the fills must land inside the
    // first replay window, before the question composer replaces the textarea.
    await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 10_000 })
    await input.fill(PROMPT)
    await input.press('Enter')
    await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 10_000 })
    await input.fill(STEER_ONE)
    await input.press('Enter')
    await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 10_000 })
    await input.fill(STEER_TWO)
    await input.press('Enter')
    const dock = page.locator('[data-queue-dock]')
    // Both messages queued: the two-row dock shows a collapsed count header,
    // and Playwright text matching skips the hidden rows — expand the list,
    // then assert each row's content.
    await dock.getByText('2 queued messages').waitFor({ timeout: 10_000 })
    await dock.getByRole('button').click()
    await dock.getByText(STEER_ONE, { exact: true }).waitFor({ timeout: 10_000 })
    await dock.getByText(STEER_TWO, { exact: true }).waitFor({ timeout: 10_000 })
    expect(await page.locator('[data-pending-steering]').count()).toBe(0)

    // Empty draft + Cmd+Enter: both queued rows steer in FIFO order, the dock
    // empties, and the pending steering renders at the conversation tail.
    await input.press('Meta+Enter')
    await expect.poll(
      () => page.locator('[data-pending-steering]').filter({ hasText: /BANANA|ORANGE/ }).count(),
      { timeout: 10_000 },
    ).toBe(2)
    expect(await page.locator('[data-queue-dock]').count()).toBe(0)
    // The reasoning row streams independently of the steering handoff. Wait
    // for the block to settle so the mid snapshot does not race its transient
    // visually-hidden Running label while the question keeps the turn open.
    await page.locator('[data-variant="think"][data-state="ok"]').first().waitFor({ timeout: 10_000 })
    const mid = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(STEER_ALL_MID, mid, MODE)

    // Answer the question; the step closes, the loop drains both steerings
    // into one next-step request, and the final reply obeys both markers.
    const composer = page.locator('[data-question-key]')
    await composer.waitFor({ timeout: 30_000 })
    await composer.getByRole('radio', { name: 'Yes' }).click()
    await composer.getByRole('radio', { name: 'Yes' }).press('Enter')
    await settled

    const first = claimedMessages(sessionEvents, STEER_ONE)
    const second = claimedMessages(sessionEvents, STEER_TWO)
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(assistantText(sessionEvents)).toContain('BANANA')
    expect(assistantText(sessionEvents)).toContain('ORANGE')
    await expect.poll(() => page.getByText(STEER_ONE, { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    await expect.poll(() => page.getByText(STEER_TWO, { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    expect(await page.locator('[data-pending-steering]').count()).toBe(0)
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(STEER_ALL_SETTLED, snapshot, MODE)
    const expanded = await captureExpandedTurnProcessAria(
      page,
      '[class*="centerCol"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(STEER_ALL_SETTLED_EXPANDED, expanded, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 200_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(STEER_ALL_DIR, [
      'replay.override.json', 'mid-steer.expected.md',
      'settled.expected.md', 'settled-expanded.expected.md',
    ])
  })
})
