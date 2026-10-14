// Web e2e scenario: the plan-review takeover. The shipped composition mounts
// plan mode and its client seat, so `/plan <task>` enters plan mode for real
// and the recorded turn ends on exit_plan_mode blocking against the live
// userInteraction seam. The composer is then occupied by the plan decision
// card — not the generic question flow — and approving it through the card
// completes the turn with the approval in the log.
// Replay is deterministic: the plan content arrives from replayed chunks, the
// review wait is real, and the approve click is the test's own gesture (the
// turn cannot complete without it, in record and replay alike).
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, ConsoleMessage, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureExpandedTurnProcessAria, captureStableAria,
  compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/plan-review', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
// The waiting golden owns the decision card; the approved golden owns the
// transcript the approval leaves behind — the state the card cannot see.
const REVIEW_EXPECTED = join(SNAPSHOT_DIR, 'review.expected.md')
const SIDEBAR_EXPECTED = join(SNAPSHOT_DIR, 'sidebar.expected.md')
const PREVIEW_EXPECTED = join(SNAPSHOT_DIR, 'preview.expected.md')
const APPROVED_EXPECTED = join(SNAPSHOT_DIR, 'approved.expected.md')
const APPROVED_EXPANDED_EXPECTED = join(SNAPSHOT_DIR, 'approved-expanded.expected.md')
const TEMPORARY_EXPECTED = fileURLToPath(new URL('./expected/plan-review/temporary.expected.md', import.meta.url))
const MODE = webSnapshotMode()

// One command line: /plan enters plan mode and submits the rest as the turn's
// message. The task is deliberately self-contained (nothing to explore in a
// fresh workspace) so the recorded turn is a plan and its review, and the
// approved continuation is one word.
const TASK = 'Plan a small change: add a --greeting flag to a CLI. Do not read or write any files. '
  + 'Call exit_plan_mode with a short plan of at most five bullet points. '
  + 'Once the plan is approved, reply with the single word DONE and stop.'
const LINE = `/plan ${TASK}`

describe('web e2e: plan review takeover round trip', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []
  let reviewedSession: SessionId

  beforeAll(async () => {
    scaffold = await launchWebScaffold(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 15, compareReplaySession: true })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    // English page: the decision copy is the surface under test, and the
    // golden pins one language.
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

  it('reviews the plan on a decision card and approves through it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plan-review'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([TASK])
    }
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled(MODE === 'record' ? 180_000 : 30_000)
    await input.fill(LINE)
    await input.press('Enter')

    // The card takes over the input area while exit_plan_mode blocks. Its
    // presence is a STABLE waiting state (it stays until answered), so a plain
    // waitFor is race-free.
    const card = page.locator('[data-plan-review-key]')
    await card.waitFor({ timeout: MODE === 'record' ? 120_000 : 30_000 })
    // The plan-review request must NOT land on the generic question flow.
    expect(await page.locator('[data-question-key]').count()).toBe(0)
    await expect.poll(() => card.getByText('Plan review').count(), { timeout: 10_000 }).toBeGreaterThan(0)
    expect(await card.getByRole('heading').count()).toBe(1)
    expect(await card.getByRole('heading').textContent()).toContain('--greeting')
    expect(await card.getByText('View full plan', { exact: true }).isVisible()).toBe(true)
    expect(await card.getByRole('list').count()).toBe(0)

    const selectedRow = page.locator('[role="treeitem"][aria-selected="true"]')
    await expect.poll(() => selectedRow.locator('[data-state="warning"]').count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => selectedRow.getByText('Plan awaiting review', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => selectedRow.getByText('Plan review', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    expect(await selectedRow.getByText('now', { exact: true }).count()).toBe(0)

    if (MODE !== 'record') {
      const snapshot = await captureStableAria(page, '[data-plan-review-key]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(REVIEW_EXPECTED, snapshot, MODE)
      const sidebar = await captureStableAria(page, '[role="treeitem"][aria-selected="true"]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(SIDEBAR_EXPECTED, sidebar, MODE)
    }

    const planCard = page.locator('[data-plan-card]')
    expect(await planCard.count()).toBe(0)
    const preview = page.locator('[data-plan-preview]')
    await preview.waitFor({ state: 'visible' })
    expect(await card.getByRole('button', { name: 'Approve' }).isVisible()).toBe(true)
    expect(await preview.getByRole('heading', { level: 1 }).textContent()).toContain('--greeting')
    await card.getByRole('button', { name: 'Open plan in sidebar' }).click()
    expect(await page.locator('[data-plan-preview]').count()).toBe(1)
    if (MODE !== 'record') {
      await compareOrRefreshGolden(PREVIEW_EXPECTED, await captureStableAria(page, '[data-plan-preview]', scaffold.workspaceCwd), MODE)
    }
    await page.locator('[data-sidebar-right-toggle]').click()
    await preview.waitFor({ state: 'hidden' })
    await card.getByRole('button', { name: 'Open plan in sidebar' }).click()
    await preview.waitFor({ state: 'visible' })

    await card.getByRole('button', { name: 'Approve' }).click()
    // Park the pointer: the card unmounts and the ContextMeter ring lands
    // under the click position, whose 200ms hover delay would arm a tooltip
    // into the aria captures below.
    await page.mouse.move(0, 0)

    const sessionId = await settled
    reviewedSession = sessionId
    if (MODE === 'record') {
      await recordFixture(scaffold, sessionId, FIXTURE)
      return
    }
    // World state: the approval reached the tool, and plan mode is left behind.
    const results = sessionEvents.filter(e => e.type === 'tool/result')
    expect(JSON.stringify(results.at(-1))).toContain('Plan approved')
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    // Card gone; regular input restored.
    expect(await page.locator('[data-plan-review-key]').count()).toBe(0)
    expect(await selectedRow.locator('[data-state="warning"]').count()).toBe(0)
    await expect.poll(() => page.locator('[data-composer-input]').first().isEnabled(), { timeout: 10_000 }).toBe(true)
    // Completed plans join the final artifacts after the Turn's closing reply.
    await planCard.waitFor({ state: 'visible' })
    expect(await planCard.locator('xpath=ancestor::*[@data-turn-tail]').count()).toBe(1)
    await page.locator('[data-sidebar-right-toggle]').click()
    await planCard.click()
    await preview.waitFor({ state: 'visible' })
    await page.reload({ waitUntil: 'load' })
    await page.locator('[data-plan-card]').waitFor({ state: 'visible' })
    await page.locator('[data-plan-preview]').waitFor({ state: 'visible' })
    expect(await page.locator('[data-plan-preview]').getByRole('heading', { level: 1 }).textContent()).toContain('--greeting')
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(APPROVED_EXPECTED, snapshot, MODE)
    const expanded = await captureExpandedTurnProcessAria(
      page,
      '[class*="centerCol"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(APPROVED_EXPANDED_EXPECTED, expanded, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 200_000)

  it.skipIf(MODE === 'record')('previews an unlogged review automatically and reopens it without deciding', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plan-review-temporary'))
    const agent = scaffold.ctx.agents.get(reviewedSession)
    if (agent === undefined) throw new Error('The reviewed Session has no active agent')
    const controller = new AbortController()
    // This public question request has no tool invocation; its detail is the only complete document.
    const asked = scaffold.ctx.userQuestions.ask({
      agent, signal: controller.signal,
      questions: [{ id: 'temporary', question: 'Approve this temporary plan?',
        detail: '# Temporary review\n\nReview without a tool invocation.\n\n## Implementation\n\n- Keep the complete document readable.\n- Ask before implementation.',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }], intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    })
    let answered = false
    const outcome = asked.then((value) => { answered = true; return value }, (error: unknown) => ({ error }))
    try {
      const card = page.locator('[data-plan-review-key]')
      const preview = page.locator('[data-plan-preview^="dsh-resource://plan-review/"]')
      await preview.waitFor({ state: 'visible' })
      expect(await preview.getByText('Ask before implementation.').isVisible()).toBe(true)
      await compareOrRefreshGolden(TEMPORARY_EXPECTED, await captureStableAria(page, '[data-plan-preview^="dsh-resource://plan-review/"]', scaffold.workspaceCwd), MODE)
      const tab = page.locator('[data-dockkit-tab]').filter({ hasText: 'Temporary review' })
      await card.getByRole('button', { name: 'Open plan in sidebar' }).click()
      expect(await tab.count()).toBe(1)
      await tab.locator('[data-dockkit-tab-close]').click()
      await preview.waitFor({ state: 'detached' })
      await card.getByRole('button', { name: 'Open plan in sidebar' }).click()
      await preview.waitFor({ state: 'visible' })
      expect(answered).toBe(false)
      const saved = await page.evaluate(() => Object.keys(localStorage)
        .filter(key => key.startsWith('dsh.sidebar-right.v1.')).map(key => localStorage.getItem(key)).join('\n'))
      expect(saved).toContain('dsh-resource://plan-review/')
      expect(saved).not.toContain('Ask before implementation.')
      await card.getByRole('button', { name: 'Approve', exact: true }).click()
      expect(await outcome).toEqual({ answers: [{ id: 'temporary', selected: ['Approve'] }] })
      await card.waitFor({ state: 'detached' })
      expect(await preview.getByText('Ask before implementation.').isVisible()).toBe(true)
      await page.reload({ waitUntil: 'load' })
      await page.getByText('This temporary plan preview has expired. Reopen it from the pending review card.', { exact: true }).waitFor()
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally {
      controller.abort()
      await outcome
    }
  }, 60_000)

  it.skipIf(MODE === 'record')('opens a review that arrives while a global panel is active', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plan-review-panel-return'))
    const agent = scaffold.ctx.agents.get(reviewedSession)
    if (agent === undefined) throw new Error('The reviewed Session has no active agent')
    // The Plugins panel replaces the Conversation and its right Sidebar. The
    // review arrives while neither is mounted; returning mounts both in one
    // commit, and the review's automatic open runs before the Sidebar's own
    // effects. A crash there retires the opener for the rest of the page.
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    await expect.poll(() => page.locator('[data-composer-input]').count()).toBe(0)
    const crashes: string[] = []
    const onConsole = (message: ConsoleMessage): void => {
      if (message.type() === 'error' && /slot entry crashed/i.test(message.text())) crashes.push(message.text())
    }
    page.on('console', onConsole)
    const controller = new AbortController()
    const asked = scaffold.ctx.userQuestions.ask({
      agent, signal: controller.signal,
      questions: [{ id: 'off-screen', question: 'Approve this plan?',
        detail: '# Off-screen review\n\nSubmitted while the Plugins panel was open.',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }], intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    })
    const outcome = asked.then(value => value, (error: unknown) => ({ error }))
    try {
      const row = page.locator('[role="treeitem"]').filter({ has: page.locator('[data-state="warning"]') }).first()
      await row.waitFor({ timeout: 10_000 })
      await row.click()
      const card = page.locator('[data-plan-review-key]')
      await card.waitFor({ timeout: 10_000 })
      const preview = page.locator('[data-plan-preview^="dsh-resource://plan-review/"]')
      await preview.waitFor({ state: 'visible', timeout: 10_000 })
      expect(await preview.getByText('Submitted while the Plugins panel was open.').isVisible()).toBe(true)
      expect(await card.getByRole('button', { name: 'Open plan in sidebar' }).count()).toBe(1)
      expect(await page.locator('[data-slot-error]').count()).toBe(0)
      expect(crashes).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally {
      page.off('console', onConsole)
      controller.abort()
      await outcome
    }
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.v3.jsonl', 'review.expected.md', 'sidebar.expected.md', 'preview.expected.md',
      'approved.expected.md', 'approved-expanded.expected.md',
    ])
  })
})

describe.skipIf(MODE === 'record')('web e2e: pending plan review across Sidebar seat changes', () => {
  // Two recorded Sessions seeded side by side; opening one in the page gives it
  // a live Agent, so a review can be delivered to it while it is off screen.
  const OTHER_FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v3.jsonl', import.meta.url))
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let planned: SessionId
  let other: SessionId
  const crashes: string[] = []
  const row = (session: SessionId) => page.locator(`[data-row-key="session:${session}"]`)

  async function showSessions(): Promise<void> {
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // Expand the Workspace group by its state, not by whether its rows have rendered yet.
    const group = page.locator('[data-row-key^="workspace:"]').first()
    await group.waitFor({ timeout: 15_000 })
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    await row(planned).waitFor({ timeout: 15_000 })
  }

  async function open(session: SessionId): Promise<void> {
    await row(session).click()
    await page.locator(`[data-conversation-session="${session}"]`).waitFor({ timeout: 15_000 })
    await page.locator(`[data-sidebar-right-session="${session}"]:not([hidden])`).first().waitFor({ state: 'attached', timeout: 15_000 })
    // `expect.poll` is test-scoped and this also runs from beforeAll, so poll by hand.
    const deadline = Date.now() + 15_000
    while (scaffold.ctx.agents.get(session) === undefined) {
      if (Date.now() > deadline) throw new Error(`opening Session ${session} published no live Agent`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  async function showPlugins(): Promise<void> {
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    await expect.poll(() => page.locator('[data-composer-input]').count(), { timeout: 10_000 }).toBe(0)
  }

  /** Deliver a plan review to one Session, run the scenario, and withdraw the review. */
  async function whileReviewing(session: SessionId, detail: string, scenario: () => Promise<void>): Promise<void> {
    const agent = scaffold.ctx.agents.get(session)
    if (agent === undefined) throw new Error(`Session ${session} has no live Agent`)
    const controller = new AbortController()
    const asked = scaffold.ctx.userQuestions.ask({
      agent, signal: controller.signal,
      questions: [{ id: 'seat-change', question: 'Approve this plan?', detail,
        options: [{ label: 'Approve' }, { label: 'Keep planning' }], intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    })
    const outcome = asked.then(value => value, (error: unknown) => ({ error }))
    try {
      await row(session).locator('[data-state="warning"]').waitFor({ timeout: 10_000 })
      await scenario()
    } finally {
      controller.abort()
      await outcome
    }
  }

  /** The review opened itself in the Sidebar and kept its manual opener. */
  async function expectOpened(text: string): Promise<void> {
    const card = page.locator('[data-plan-review-key]')
    await card.waitFor({ timeout: 10_000 })
    const preview = page.locator('[data-plan-preview^="dsh-resource://plan-review/"]')
    await preview.waitFor({ state: 'visible', timeout: 10_000 })
    expect(await preview.getByText(text).isVisible()).toBe(true)
    expect(await card.getByRole('button', { name: 'Open plan in sidebar' }).count()).toBe(1)
    expect(await page.locator('[data-slot-error]').count()).toBe(0)
    expect(crashes).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    planned = await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), 'plan-review-seat-planned')
    other = await seedSession(scaffold, await readFile(OTHER_FIXTURE, 'utf8'), 'plan-review-seat-other')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error' && /slot entry crashed/i.test(message.text())) crashes.push(message.text())
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await showSessions()
    await open(planned)
    await open(other)
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens a review that arrives while another Session is on screen', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plan-review-session-return'))
    // Returning mounts the review in the commit that brings its Session back on
    // screen and swaps the Sidebar seats; the review's automatic open runs
    // before either seat's effects.
    await whileReviewing(planned, '# Session review\n\nSubmitted while another Session was on screen.', async () => {
      await row(planned).click()
      await expectOpened('Submitted while another Session was on screen.')
    })
  })

  it('opens a review for a Session whose Sidebar layout was never saved', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plan-review-first-layout'))
    // The layout is stored per browser. Without it the arriving seat creates
    // one, and that store commit lands in the commit where the review opens.
    await open(other)
    const warningStart = tripwire.warnings.length
    await page.evaluate((session) => { localStorage.removeItem(`dsh.sidebar-right.v1.${session}`) }, planned)
    await page.reload({ waitUntil: 'load' })
    await showSessions()
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await showPlugins()
    await whileReviewing(planned, '# Layout review\n\nSubmitted to a Session without a saved Sidebar layout.', async () => {
      await row(planned).click()
      await expectOpened('Submitted to a Session without a saved Sidebar layout.')
    })
  })
})

describe('web e2e: dismissed plan history', () => {
  it.skipIf(MODE === 'record')('reopens the permanent plan card after dismissing its review', async () => {
    // A dismissed review concludes the turn, so only the call presenting the plan replays.
    const replayRoot = await mkdtemp(join(tmpdir(), 'dsh-plan-review-dismiss-replay-'))
    const replayOverride = join(replayRoot, 'replay.override.json')
    const script = deriveReplayScript(parseSessionLog(await readFile(FIXTURE, 'utf8')))
    await writeFile(replayOverride, JSON.stringify(script.slice(0, 1)))
    const scaffold = await launchWebScaffold({ replayFixture: FIXTURE, replayOverride, compareReplaySession: false, paceMs: 15 })
    let browser: Browser | undefined
    const events: SessionEvent[] = []
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
    try {
      browser = await chromium.launch()
      const page = await newEnglishPage(browser)
      await page.setViewportSize({ width: 620, height: 900 })
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      const input = page.locator('[data-composer-input]').first()
      const settled = scaffold.whenTurnSettled(30_000)
      await input.fill(LINE)
      await input.press('Enter')
      const review = page.locator('[data-plan-review-key]')
      await review.waitFor({ state: 'visible' })
      await page.locator('[data-plan-preview]').waitFor({ state: 'visible' })
      await page.locator('[data-sidebar-right-toggle]').click()
      await review.getByRole('button', { name: 'Request changes', exact: true }).click()
      await settled
      const call = events.find((event): event is SessionEvent<'tool/call'> =>
        event.type === 'tool/call' && event.data.name === 'exit_plan_mode')
      expect(call).toBeDefined()
      const results = events.filter(event => event.type === 'tool/result')
      const result = results.find(event => event.data.message.source.callId === call?.data.callId)
      expect(result?.data.message).toMatchObject({ role: 'tool', toolCallId: call?.data.callId, isError: false })
      expect(JSON.stringify(result)).toContain('dismissed the plan review')
      expect(results.some(event => JSON.stringify(event).includes('Plan approved'))).toBe(false)
      expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
      const modes = events.filter(event => event.type === 'plan/mode')
      expect(modes).toHaveLength(1)
      expect(modes[0]).toMatchObject({ data: { active: true } })
      expect(await review.count()).toBe(0)
      const card = page.locator('[data-plan-card]')
      await card.waitFor({ state: 'visible' })
      await card.click()
      await page.locator('[data-plan-preview]').waitFor({ state: 'visible' })
      await page.locator('[data-sidebar-right-toggle]').click()
      await card.click()
      await page.reload({ waitUntil: 'load' })
      await page.locator('[data-plan-card]').waitFor({ state: 'visible' })
      await page.locator('[data-plan-preview]').waitFor({ state: 'visible' })
      expect(await page.locator('[data-plan-preview]').getByRole('heading', { level: 1 }).textContent()).toContain('--greeting')
      await page.locator('[data-sidebar-right-toggle]').click()
      await page.reload({ waitUntil: 'load' })
      await page.locator('[data-plan-card]').waitFor({ state: 'visible' })
      expect(await page.locator('[data-plan-preview]').isVisible()).toBe(false)
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally {
      await browser?.close()
      await scaffold.close()
      await rm(replayRoot, { recursive: true, force: true })
    }
  })
})
