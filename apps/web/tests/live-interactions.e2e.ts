// Web e2e scenarios: live-turn interactions — running-draft submission,
// cancellation, error surfacing, transient-retry recovery, and retry
// exhaustion, all through the real composition and wire. The model adapter is
// dsh-llm-replay with override
// sidecars: `hang` (+ a readyFile marker) makes mid-stream cancel
// deterministic by construction, `throw` entries express provider failures by
// stable code, and `{ patches }` augmentation injects transient throws before
// (or instead of) the recorded success so llm-retry's recovery and exhaustion
// are proven end-to-end in the browser. Sidecar CONTENT is authored here
// (single-sourced against the fixture via deriveReplayScript — no committed
// copy of recorded chunks); the file is a per-run artifact in the temp
// workspace. One recorded base fixture serves every scenario.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type { ReplayEntry, ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureExpandedTurnProcessAria, captureStableAria,
  compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/live-interactions', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v2.jsonl')
// One golden pins the empty mid-turn loading state, one pins the sendable draft
// state, and the other four capture what remains after cancel, after a
// non-retryable failure, after retry recovery, and after retry exhaustion.
const CANCEL_EXPECTED = join(SNAPSHOT_DIR, 'cancel.expected.md')
const CANCEL_EXPANDED_EXPECTED = join(SNAPSHOT_DIR, 'cancel-expanded.expected.md')
const LOADING_EXPECTED = join(SNAPSHOT_DIR, 'loading.expected.md')
const RUNNING_DRAFT_EXPECTED = join(SNAPSHOT_DIR, 'running-draft.expected.md')
const ERROR_EXPECTED = join(SNAPSHOT_DIR, 'error-auth.expected.md')
const RETRY_EXPECTED = join(SNAPSHOT_DIR, 'retry.expected.md')
const RETRY_EXPANDED_EXPECTED = join(SNAPSHOT_DIR, 'retry-expanded.expected.md')
const RETRY_EXHAUSTED_EXPECTED = join(SNAPSHOT_DIR, 'retry-exhausted.expected.md')
const MODE = webSnapshotMode()
const AUTH_PROVIDER_MESSAGE = 'Authentication Fails, Your api key: sk-preview-secret is invalid'

// The recorded base: one text-only turn whose derived script the sidecars
// patch. Kept deliberately tool-free so the derived script is exactly one
// model call.
const PROMPT = 'Reply with a one-sentence description of event sourcing, then stop.'
const RUNNING_DRAFT = 'Queue this follow-up while the current turn is running.'

/** turn/end reasons observed, in order. */
function turnEndReasons(events: SessionEvent[]): string[] {
  return events
    .filter(e => e.type === 'turn/end')
    .map(e => (e as SessionEvent & { data: { reason: { kind: string } } }).data.reason.kind)
}

describe('web e2e: live-turn interactions (cancel / error / retry)', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let sessionEvents: SessionEvent[]
  let sidecarDir: string | undefined

  afterEach(async () => {
    // scaffold.close() failures MUST fail the scenario: assertConsumed() is
    // the fixture-drift tripwire and cleanup problems are real defects. Run
    // every teardown step regardless, then rethrow what failed.
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    browser = undefined
    const closing = scaffold
    scaffold = undefined
    await closing?.close().catch((error: unknown) => failures.push(error))
    if (sidecarDir !== undefined) await rm(sidecarDir, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    sidecarDir = undefined
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'live-interactions teardown failed')
  })

  /** Boot scaffold + page with an optional override doc materialized per run. */
  async function launch(
    buildOverride?: (sidecarHome: string) => ReplayOverrideDoc,
    retryPolicy?: RetryPolicyConfig,
  ): Promise<void> {
    sessionEvents = []
    let overridePath: string | undefined
    if (buildOverride !== undefined) {
      // The sidecar CONTENT is authored in this spec; the file is a per-run
      // artifact minted in a spec-owned temp dir. It must exist BEFORE the
      // scaffold boots — installLlmReplay resolves the script at install.
      sidecarDir = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-sidecar-'))
      overridePath = join(sidecarDir, 'replay.override.json')
      await writeFile(overridePath, JSON.stringify(buildOverride(sidecarDir)))
    }
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      ...(overridePath === undefined ? {} : { replayOverride: overridePath }),
      ...(overridePath === undefined ? {} : { compareReplaySession: false }),
      ...(retryPolicy === undefined ? {} : { replayRetryPolicy: retryPolicy }),
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // Fresh world: connect a Workspace so the composer scenarios start live.
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }

  /**
   * Type the recorded prompt and send, with the settled barrier pre-armed.
   * Returned WRAPPED ({ settled }) — a bare returned promise would be
   * flattened by the caller's await, blocking on turn/end before the caller
   * can act mid-turn (the cancel scenario's whole point).
   */
  async function sendPrompt(timeoutMs?: number): Promise<{ settled: ReturnType<WebScaffold['whenTurnSettled']> }> {
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold!.whenTurnSettled(timeoutMs)
    await input.fill(PROMPT)
    await input.press('Enter')
    return { settled }
  }

  it.skipIf(MODE !== 'record')('records the base fixture live through the composer', async () => {
    await launch()
    onTestFailed(() => saveFailureShot(page, 'web-e2e-interactions-record'))
    const { settled } = await sendPrompt(180_000)
    const sessionId = await settled
    await recordFixture(scaffold!, sessionId, FIXTURE)
  }, 200_000)

  it.skipIf(MODE === 'record')('matches the canonical persisted session', async () => {
    await launch()
    const { settled } = await sendPrompt(30_000)
    await settled
  })

  it.skipIf(MODE === 'record')('cancels a hung stream deterministically via the readyFile marker', async () => {
    expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    let marker = ''
    await launch((sidecarHome) => {
      marker = join(sidecarHome, '.hang-ready')
      return { patches: [{ at: 0, entry: { kind: 'hang', readyFile: marker } }] }
    })
    onTestFailed(() => saveFailureShot(page, 'web-e2e-cancel'))
    const { settled } = await sendPrompt()
    // The marker IS the synchronization: the stream is provably parked in the
    // hang (prefix chunks delivered to the loop) before the stop click.
    await expect.poll(() => existsSync(marker), { timeout: 15_000 }).toBe(true)
    await expect.poll(
      () => page.getByRole('status').filter({ hasText: 'Deep diving...' }).isVisible(),
      { timeout: 10_000 },
    ).toBe(true)
    await page.locator('[data-streaming="true"]')
      .getByText('partial', { exact: true })
      .waitFor({ timeout: 30_000 })
    const loadingSnapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold!.workspaceCwd)
    await compareOrRefreshGolden(LOADING_EXPECTED, loadingSnapshot, MODE)

    const input = page.locator('[data-composer-input]').first()
    await input.fill(RUNNING_DRAFT)
    const send = page.getByRole('button', { name: 'Send message', exact: true })
    await send.waitFor({ timeout: 10_000 })
    expect(await page.getByRole('button', { name: 'Stop generating', exact: true }).count()).toBe(0)
    const runningDraftSnapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold!.workspaceCwd)
    await compareOrRefreshGolden(RUNNING_DRAFT_EXPECTED, runningDraftSnapshot, MODE)
    await send.click()
    await expect.poll(() => input.textContent(), { timeout: 10_000 }).toBe('')
    const queuedRow = page.locator('[data-queue-dock]').getByRole('listitem').filter({ hasText: RUNNING_DRAFT })
    await queuedRow.waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Stop generating', exact: true }).waitFor({ timeout: 10_000 })
    await queuedRow.getByRole('button', { name: 'Remove queued message' }).click()
    await expect.poll(() => queuedRow.count(), { timeout: 10_000 }).toBe(0)

    await page.getByRole('button', { name: 'Stop generating' }).click()
    await settled
    expect(turnEndReasons(sessionEvents).at(-1)).toBe('aborted')
    // Composer recovered; no streaming node lingers. The host settled first
    // (awaited above), but the abort frame reaches the browser over SSE — the
    // frozen-partial swap is eventually consistent, so poll rather than count.
    await expect.poll(() => page.locator('[data-composer-input]').first().isEnabled(), { timeout: 10_000 }).toBe(true)
    await expect.poll(() => page.locator('[data-streaming="true"]').count(), { timeout: 10_000 }).toBe(0)
    // Golden of the aborted end-state: the prompt bubble plus the frozen
    // partial ('partial' is the hang entry's replayed prefix) and no more.
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold!.workspaceCwd)
    await compareOrRefreshGolden(CANCEL_EXPECTED, snapshot, MODE)
    const expanded = await captureExpandedTurnProcessAria(
      page,
      '[class*="centerCol"]',
      scaffold!.workspaceCwd,
    )
    await compareOrRefreshGolden(CANCEL_EXPANDED_EXPECTED, expanded, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it.skipIf(MODE === 'record')('surfaces a non-retryable AUTH failure without retrying', async () => {
    await launch(() => ({
      patches: [{ at: 0, entry: { kind: 'throw', chunks: [], message: AUTH_PROVIDER_MESSAGE, code: 'AUTH' } }],
    }))
    onTestFailed(() => saveFailureShot(page, 'web-e2e-error-auth'))
    const { settled } = await sendPrompt()
    await settled
    expect(turnEndReasons(sessionEvents).at(-1)).toBe('error')
    // AUTH is outside llm-retry's retryable set: no retry record.
    expect(sessionEvents.filter(e => e.type === 'llm/retry').length).toBe(0)
    await expect.poll(() => page.locator('[data-composer-input]').first().isEnabled(), { timeout: 10_000 }).toBe(true)
    expect(await page.locator('[data-streaming="true"]').count()).toBe(0)
    const errorStatus = page.getByRole('status').filter({ hasText: 'This turn failed' })
    await errorStatus.waitFor({ timeout: 10_000 })
    expect(await errorStatus.textContent()).toContain('API key is invalid')
    expect(await errorStatus.textContent()).toContain('AUTH')
    expect(await page.locator('body').textContent()).not.toContain('sk-preview-secret')
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold!.workspaceCwd)
    await compareOrRefreshGolden(ERROR_EXPECTED, snapshot, MODE)
    await page.getByRole('tab', { name: 'Trajectory' }).click()
    const requestMarker = page.locator('tr[data-request-only="true"]').last()
      .getByRole('button', { name: /Request #/ })
    await requestMarker.click()
    await page.getByText('API key is invalid', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await page.locator('body').textContent()).not.toContain('sk-preview-secret')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it.skipIf(MODE === 'record')('keeps a terminal request marker inside the trajectory table', async () => {
    await launch(() => ({
      patches: [{ at: 0, entry: { kind: 'throw', chunks: [], message: AUTH_PROVIDER_MESSAGE, code: 'AUTH' } }],
    }))
    const { settled } = await sendPrompt()
    await settled
    await page.getByRole('tab', { name: 'Trajectory' }).click()
    // The boundary marker row itself is a 0-height hairline except at the
    // table tail; the marker button is absolutely positioned and stays
    // visible, so wait on it directly.
    const tailRequest = page.locator('tr[data-request-only="true"]').last()
    const requestMarker = tailRequest.getByRole('button', { name: /Request #/ })
    await requestMarker.waitFor({ timeout: 10_000 })

    const markerWithinTable = await requestMarker.evaluate((element) => {
      const marker = element.getBoundingClientRect()
      const table = element.closest('table')?.getBoundingClientRect()
      if (table === undefined) throw new Error('request marker has no table')
      return marker.bottom <= table.bottom
    })

    expect(markerWithinTable).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it.skipIf(MODE === 'record')('recovers a transient SERVER failure through llm-retry and completes', async () => {
    const derived = deriveReplayScript(parseSessionLog(await readFile(FIXTURE, 'utf8')))
    expect(derived).toHaveLength(1)
    await launch(() => ({
      patches: [
        { at: 0, entry: { kind: 'throw', chunks: [], message: 'upstream 503', code: 'SERVER' } },
        // Append the fixture's own success as the retry attempt — single-
        // sourced from the recording, never copied into a committed sidecar.
        { at: 1, entry: derived[0]! },
      ],
    }))
    onTestFailed(() => saveFailureShot(page, 'web-e2e-retry'))
    // llm-retry backs off ~500ms before the second attempt.
    const { settled } = await sendPrompt(60_000)
    await settled
    expect(turnEndReasons(sessionEvents).at(-1)).toBe('completed')
    // The durable retry record proves the second attempt (request/header logs
    // only on change, so attempt count is invisible there).
    expect(sessionEvents.filter(e => e.type === 'llm/retry').length).toBeGreaterThanOrEqual(1)
    await expect.poll(() => page.getByText('event sourcing', { exact: false }).count(), { timeout: 10_000 }).toBeGreaterThan(0)
    // Golden of the recovered end-state: the discarded partial stays absent,
    // while the settled retry row remains as durable recovery context.
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold!.workspaceCwd)
    await compareOrRefreshGolden(RETRY_EXPECTED, snapshot, MODE)
    const expanded = await captureExpandedTurnProcessAria(
      page,
      '[class*="centerCol"]',
      scaffold!.workspaceCwd,
    )
    await compareOrRefreshGolden(RETRY_EXPANDED_EXPECTED, expanded, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it.skipIf(MODE === 'record')('surfaces the terminal turn error after transient retries exhaust', async () => {
    // A whole-script replacement: three throw entries cover the first request
    // plus both budgeted retries (patches cannot reach past the one-call
    // derived script). The scenario-owned policy keeps exhaustion fast and
    // jitter-free instead of walking the shared default's five backed-off
    // attempts.
    const failure: ReplayEntry = { kind: 'throw', chunks: [], message: 'upstream 503', code: 'SERVER' }
    await launch(
      () => [failure, failure, failure],
      { mode: 'normal', maxRetries: 2, retryableCodes: ['SERVER'], backoff: { initialDelayMs: 25, maxDelayMs: 50, jitterRatio: 0 } },
    )
    onTestFailed(() => saveFailureShot(page, 'web-e2e-retry-exhausted'))
    const { settled } = await sendPrompt(60_000)
    await settled
    expect(turnEndReasons(sessionEvents).at(-1)).toBe('error')
    expect(sessionEvents.filter(e => e.type === 'llm/retry').length).toBe(2)
    await expect.poll(() => page.locator('[data-composer-input]').first().isEnabled(), { timeout: 10_000 }).toBe(true)
    expect(await page.locator('[data-streaming="true"]').count()).toBe(0)
    // The terminal error row must render even though the turn owns a retry
    // chain: exhausted recovery shares the failing turn, so suppressing the
    // row by retry history would leave the failure invisible.
    const errorStatus = page.getByRole('status').filter({ hasText: 'This turn failed' })
    await errorStatus.waitFor({ timeout: 10_000 })
    expect(await errorStatus.textContent()).toContain('upstream 503')
    expect(await errorStatus.textContent()).toContain('SERVER')
    // The settled retry chain stays alongside the terminal row as recovery
    // context; the golden pins both.
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold!.workspaceCwd)
    await compareOrRefreshGolden(RETRY_EXHAUSTED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.v2.jsonl', 'cancel.expected.md', 'cancel-expanded.expected.md',
      'loading.expected.md', 'running-draft.expected.md', 'error-auth.expected.md',
      'retry.expected.md', 'retry-expanded.expected.md', 'retry-exhausted.expected.md',
    ])
  })
})
