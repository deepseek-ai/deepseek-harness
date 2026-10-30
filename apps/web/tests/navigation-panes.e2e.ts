// Web e2e scenarios: navigation & panes — the Trajectory view and timing
// overview, its local details inspector, and sidebar search, all over ONE rich
// two-turn seeded fixture rendered purely from the log (the seeded-history
// pattern: zero model calls in replay, so every surface here is the client
// fold + host history RPC, not replay binding). The seed is recorded live
// under the standard discipline: turn 1 produces a bash call plus two
// parallel reads in one assistant message (tool-call density for the
// trajectory ledger/timing lanes), turn 2 a markdown-rich reply.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page, Response } from 'playwright'
import { chromium } from 'playwright'
import { strFromU8, unzipSync } from 'fflate'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type SessionToolResults from '@deepseek-ai/dsh-client-ui-trajectory'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { SESSION_FORMAT_VERSION, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, saveFailureShot } from './support.ts'
import { expectWrappedTerminalCommand } from './terminal-command-browser.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/navigation-panes', import.meta.url))
const SEED = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const TRAJECTORY_EXPECTED = join(SNAPSHOT_DIR, 'trajectory.expected.md')
const TIMING_EXPECTED = join(SNAPSHOT_DIR, 'timing.expected.md')
const SEARCH_EXPECTED = join(SNAPSHOT_DIR, 'search-results.expected.md')
const ID_SEARCH_EXPECTED = join(SNAPSHOT_DIR, 'search-id-results.expected.md')
const TERMINAL_EXPECTED = join(SNAPSHOT_DIR, 'terminal-card.expected.md')
const CODE_CARD_DIR = fileURLToPath(new URL('./expected/navigation-panes', import.meta.url))
const COMMAND_WRAP_EXPECTED = join(CODE_CARD_DIR, 'command-wrap.expected.md')
const CODE_CARD_EXPECTED = join(CODE_CARD_DIR, 'code-card.expected.md')
const COPY_MARKDOWN_EXPECTED = join(CODE_CARD_DIR, 'copy-markdown.expected.md')
const EVICTED_RESULT_EXPECTED = join(CODE_CARD_DIR, 'live-result-evicted.expected.md')
const LIVE_RESULT_EXPECTED = join(CODE_CARD_DIR, 'live-result.expected.md')
const RUNNING_RESULT_EXPECTED = join(CODE_CARD_DIR, 'live-result-running.expected.md')
const MODE = webSnapshotMode()
const SEED_ID = 'navigation-panes-web-e2e'
const EXPORTED_LOG_FILE = `session.v${SESSION_FORMAT_VERSION}.jsonl`

// Turn 1 leads with a distinctive word: the session-title fallback takes the
// first words of the first message, so the sidebar-search scenario has a
// known-matching query ('navscenario') without depending on a live title call.
const PROMPT_TURN1 = 'NavScenario: first run bash to print exactly NAVIGATION_OK, then read nav-a.md and nav-b.md using two read calls in ONE assistant message, then reply with the single word FIRST_DONE and stop.'
const PROMPT_TURN2 = 'Reply in markdown with: a level-2 heading "Navigation Summary", a bulleted list of exactly two items, and a fenced code block containing echo WATERFALL. Then stop.'

async function baselineResponse(
  page: Page,
): Promise<Response> {
  return page.waitForResponse(response => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/session/list'
  ), { timeout: 30_000 })
}

async function assertBaselineSucceeded(response: Response, method: string): Promise<void> {
  expect(response.ok(), `${method} baseline HTTP response`).toBe(true)
  const body = await response.json() as { result?: { ok?: unknown } }
  expect(body.result?.ok, `${method} baseline RPC result`).toBe(true)
}

async function ensureSeedOpen(page: Page): Promise<void> {
  const welcome = page.locator('[class*="onboardingOverlay"]')
  if (await welcome.count() > 0) {
    await welcome.getByRole('button').click()
    await welcome.waitFor({ state: 'detached', timeout: 15_000 })
  }
  const chat = page.getByRole('tab', { name: 'Chat', exact: true })
  // Search is a collapsed header action; expand it so the input is actionable.
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  const search = page.getByPlaceholder('Search session names', { exact: false })
  if (await chat.count() === 0) {
    await search.fill('WATERFALL')
    const result = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
    await expect.poll(() => result.count(), { timeout: 15_000 }).toBe(1)
    await result.click()
    await chat.waitFor({ timeout: 15_000 })
  }
  await chat.click()
  await page.getByText('FIRST_DONE', { exact: true }).waitFor({ timeout: 15_000 })
  if (await search.inputValue() !== '') {
    await search.fill('')
    await expect.poll(() => search.inputValue(), { timeout: 5_000 }).toBe('')
  }
}

describe('web e2e: navigation & panes over a rich seeded session', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole> = { warnings: [], pageErrors: [] }
  let slotErrors: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // The workspace-aware flow runs sessions in <workspaceCwd>/workspace;
    // the read targets must live in that session cwd (pre-creation is safe
    // because the picker adopts an existing directory by path).
    const sessionCwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(sessionCwd, { recursive: true })
    await writeFile(join(sessionCwd, 'nav-a.md'), '# alpha nav\n')
    await writeFile(join(sessionCwd, 'nav-b.md'), '# beta nav\n')
    if (MODE !== 'record') {
      const raw = await readFile(SEED, 'utf8')
      expect(fixtureUserPrompts(raw), 'seed fixture must carry exactly the two drive prompts')
        .toEqual([PROMPT_TURN1, PROMPT_TURN2])
      // The inspector's calendar date must not depend on the day the test runs.
      await seedSession(scaffold, raw, SEED_ID, undefined, { createdAt: Date.UTC(2026, 0, 1) })
    }
    browser = await chromium.launch()
  }, 120_000)

  beforeEach(async () => {
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    slotErrors = []
    page.on('console', (message) => {
      if (message.type() === 'error' && /slot entry crashed/i.test(message.text())) {
        slotErrors.push(message.text())
      }
    })
    // Arm before navigation so the Session response cannot be missed. The
    // Workspace stream settles through the user-visible Ungrouped barrier.
    const sessionBaseline = baselineResponse(page)
    const [, sessionResponse] = await Promise.all([
      page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' }),
      sessionBaseline,
    ])
    await assertBaselineSucceeded(sessionResponse, 'session.list')
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // The frame mounts before the asynchronous session-list baseline lands.
    // Search must target the settled seeded row, not the startup input that
    // the ready projection replaces (the compact layout dropped group session
    // counts; the Ungrouped bucket row is the barrier).
    await page.getByText('Ungrouped', { exact: true }).waitFor({ timeout: 30_000 })
  }, 120_000)

  afterEach(async () => {
    const failures: unknown[] = []
    try {
      expect({
        pageErrors: tripwire.pageErrors,
        slotErrors,
        warnings: tripwire.warnings,
      }).toEqual({
        pageErrors: [],
        slotErrors: [],
        warnings: [],
      })
    } catch (error) {
      failures.push(error)
    }
    await page?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'navigation case cleanup failed')
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'navigation e2e cleanup failed')
  })

  it.skipIf(MODE !== 'record')('records the two-turn seed live through the composer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-record'))
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    let sessionId: Awaited<ReturnType<WebScaffold['whenTurnSettled']>> | undefined
    for (const prompt of [PROMPT_TURN1, PROMPT_TURN2]) {
      const settled = scaffold.whenTurnSettled()
      // Turn 2 types into the same composer once turn 1 unlocks it.
      await expect.poll(() => input.isEnabled(), { timeout: 15_000 }).toBe(true)
      await input.fill(prompt)
      await input.press('Enter')
      sessionId = await settled
    }
    await recordFixture(scaffold, sessionId!, SEED)
    // Fixture honesty: the recording must contain the events the replay
    // scenarios assert on: three calls in turn 1 and two closed turns.
    const recorded = parseSessionLog(await readFile(SEED, 'utf8'))
    expect(recorded.filter(e => e.type === 'turn/end')).toHaveLength(2)
    const calls = recorded.filter((e): e is SessionEvent & { data: { name: string } } => e.type === 'tool/call')
    expect(calls.map(e => e.data.name).sort()).toEqual(['bash', 'read', 'read'])
  }, 400_000)

  it.skipIf(MODE === 'record')('finds an unopened seeded session by message content and opens it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-search'))
    // The API baselines can settle before React commits their projection. The
    // seeded Ungrouped bucket row is the final user-visible barrier before
    // editing search (the compact layout dropped group session counts).
    await page.getByText('Ungrouped', { exact: true }).waitFor({ timeout: 30_000 })
    // Search is a collapsed header action; expand it so the input is actionable.
    const searchButton = page.getByRole('button', { name: 'Search sessions' })
    if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
    const search = page.getByPlaceholder('Search session names', { exact: false })
    // The cold row has not been opened, so only the persisted log can satisfy
    // this query. First search lazily reconciles the SQLite content index.
    await search.fill('zzzqx-no-such-session')
    await page.getByText('No matching sessions').waitFor({ timeout: 30_000 })
    await expect.poll(
      () => page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem').count(),
      { timeout: 10_000 },
    ).toBe(0)

    const resultTree = page.getByRole('tree', { name: 'Search results' })
    const result = resultTree.getByRole('treeitem')
    // The seed log carries its id only in the header, so this mid-id,
    // differently cased fragment can match only through local id matching.
    await search.fill('PANES-WEB')
    await expect.poll(() => result.count(), { timeout: 10_000 }).toBe(1)
    await page.getByRole('status', { name: 'Searching session history…' }).waitFor({ state: 'detached', timeout: 30_000 })
    await compareOrRefreshGolden(
      ID_SEARCH_EXPECTED,
      await captureStableAria(page, '[class*="listArea"]', scaffold.workspaceCwd),
      MODE,
    )

    await search.fill('WATERFALL')
    await expect.poll(() => result.count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(() => result.getByText('WATERFALL', { exact: false }).count(), {
      timeout: 10_000,
    }).toBeGreaterThanOrEqual(1)
    const snapshot = (await captureStableAria(page, '[class*="listArea"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(SEARCH_EXPECTED, snapshot, MODE)

    await result.click()
    // Search navigation returns to the browser with the opened Session row exposed.
    await expect.poll(() => search.inputValue(), { timeout: 5_000 }).toBe('')
    const selectedRow = page.locator('[role="tree"][aria-label="Sessions"] [role="treeitem"][aria-selected="true"]')
    await expect.poll(() => selectedRow.count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => page.getByText('FIRST_DONE', { exact: true }).count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    await expect.poll(() => page.getByRole('heading', { name: 'Navigation Summary' }).count(), { timeout: 15_000 }).toBe(1)
  }, 90_000)

  it.skipIf(MODE === 'record')('renders recorded Markdown with icon tooltips and switchable wrapping', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-code-card'))
    await ensureSeedOpen(page)
    const selector = '.md-code-block:has-text("echo WATERFALL")'
    const block = page.locator(selector)
    await block.waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(CODE_CARD_EXPECTED, await captureStableAria(page, selector, scaffold.workspaceCwd), MODE)
    const code = block.locator('pre')
    const source = await code.textContent()
    const copy = block.getByRole('button', { name: 'Copy', exact: true })
    await copy.hover()
    await page.getByRole('tooltip', { name: 'Copy', exact: true }).waitFor()
    const unwrap = block.getByRole('button', { name: 'Wrap lines', exact: true })
    await unwrap.hover()
    await page.getByRole('tooltip', { name: 'Do not wrap lines', exact: true }).waitFor()
    await unwrap.click()
    await expect.poll(() => code.evaluate(element => getComputedStyle(element).whiteSpace)).toBe('pre')
    await block.getByRole('button', { name: 'Wrap lines', exact: true }).click()
    await expect.poll(() => code.evaluate(element => getComputedStyle(element).whiteSpace)).toBe('pre-wrap')
    expect(await code.textContent()).toBe(source)
  }, 60_000)

  it.skipIf(MODE === 'record')('renders the trajectory ledger and opens its local record inspector', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-trajectory'))
    await ensureSeedOpen(page)
    await page.getByRole('tab', { name: 'Trajectory' }).click()
    await page.waitForTimeout(100)
    const overlayLayout = await page.getByRole('table').evaluate((table) => {
      const host = table.closest('[data-conversation-scroll]')
      const seat = host?.querySelector('[data-composer-seat]') ?? null
      const pane = table.parentElement
      return {
        hostPosition: host === null ? null : getComputedStyle(host).position,
        paneOverflowX: pane === null ? null : getComputedStyle(pane).overflowX,
        paneScrollableWidth: pane === null ? null : pane.scrollWidth - pane.clientWidth,
        seatPosition: seat === null ? null : getComputedStyle(seat).position,
      }
    })
    expect(overlayLayout).toEqual({
      hostPosition: 'relative',
      paneOverflowX: 'hidden',
      paneScrollableWidth: 0,
      seatPosition: 'absolute',
    })
    expect({
      pageErrors: tripwire.pageErrors,
      slotErrors,
      warnings: tripwire.warnings,
    }).toEqual({
      pageErrors: [],
      slotErrors: [],
      warnings: [],
    })
    // Turn rules partition the ledger without restoring a separate header row.
    await expect.poll(() => page.locator('tr[data-turn-start="true"]').count(), { timeout: 15_000 }).toBe(2)
    await expect.poll(() => page.getByRole('columnheader').count(), { timeout: 10_000 }).toBe(0)
    await page.locator('tr[data-kind="tool"]').first().click()
    const details = page.getByRole('complementary', { name: 'Event details' })
    await expect.poll(() => details.count(), { timeout: 10_000 }).toBe(1)
    expect(await details.getByRole('tabpanel').evaluate(panel => getComputedStyle(panel).overflowX))
      .toBe('hidden')
    await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
    const darkSummarySurfaces = await details.getByRole('heading', { name: 'Payload' }).evaluate(heading => ({
      heading: getComputedStyle(heading).backgroundColor,
      panel: getComputedStyle(heading.closest('[aria-label="Event details"]')!).backgroundColor,
    }))
    expect(darkSummarySurfaces.heading).toBe(darkSummarySurfaces.panel)
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
    await page.getByRole('tab', { name: 'Result' }).click()
    await expect.poll(() => page.getByText('NAVIGATION_OK', { exact: false }).count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    expect(await page.locator('[data-timeline-span="message"][data-assistant-timing="true"]').count()).toBeGreaterThan(0)
    await page.getByText('Raw results are only available for live tool calls', { exact: true }).waitFor()
    const snapshot = (await captureStableAria(page, '[class*="viewArea"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(TRAJECTORY_EXPECTED, snapshot, MODE)
    await details.getByRole('button', { name: 'Close details' }).click()
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps trajectory folding and search usable at 390px in every locale', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-trajectory-toolbar-narrow'))
    await ensureSeedOpen(page)
    await page.getByRole('tab', { name: 'Trajectory' }).click()
    const toolbar = page.getByRole('toolbar')
    const search = toolbar.getByRole('searchbox')
    try {
      for (const locale of ['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt']) {
        await scaffold.ctx.settings.update('locale', { preference: locale })
        await expect.poll(() => page.evaluate(() => document.documentElement.lang))
          .toBe(locale === 'zh' ? 'zh-CN' : locale)
        await search.fill('NAVIGATION_OK')
        await page.setViewportSize({ width: 390, height: 844 })
        await expect.poll(() => toolbar.evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          return {
            fits: element.scrollWidth <= element.clientWidth + 1,
            controlsFit: [...element.querySelectorAll('button:not([hidden]), input')].every((control) => {
              const rect = control.getBoundingClientRect()
              return rect.width > 0 && rect.height > 0
                && rect.left >= bounds.left && rect.right <= bounds.right
                && rect.top >= bounds.top && rect.bottom <= bounds.bottom
            }),
          }
        }), { message: `${locale} toolbar at 390px` }).toEqual({ fits: true, controlsFit: true })
        expect(await search.evaluate(element => element === document.activeElement)).toBe(true)
        expect(await search.inputValue()).toBe('NAVIGATION_OK')
        await search.fill('')
        const subcalls = toolbar.getByRole('button').last()
        await subcalls.click()
        expect(await subcalls.isVisible()).toBe(true)
        await page.setViewportSize({ width: 1680, height: 1_000 })
      }
    } finally {
      await scaffold.ctx.settings.update('locale', { preference: 'en' })
    }
  }, 90_000)

  it.skipIf(MODE === 'record')('restores Assistant timing from recorded history', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-timing'))
    await ensureSeedOpen(page)
    await page.getByRole('tab', { name: 'Trajectory' }).click()
    await page.getByRole('button', { name: 'Request #1', exact: true }).click()
    const details = page.getByRole('complementary', { name: 'Event details' })
    await details.getByRole('tab', { name: 'Timing', exact: true }).click()
    const panel = details.getByRole('tabpanel', { name: 'Timing' })
    for (const metric of ['TTFT', 'Generation', 'Throughput']) {
      const value = panel.getByText(metric, { exact: true }).locator('..').locator('dd')
      await expect.poll(() => value.textContent()).toMatch(/^\d/)
    }
    expect(await panel.getByText('First token unavailable', { exact: true }).count()).toBe(0)
    const snapshot = await captureStableAria(page, '#trajectory-detail-panel', scaffold.workspaceCwd)
    await compareOrRefreshGolden(TIMING_EXPECTED, snapshot, MODE)
  }, 60_000)

  it.skipIf(MODE === 'record')('downloads through the Session Header and /export with one dialog', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-export'))
    await ensureSeedOpen(page)
    const exportButton = page.getByRole('button', { name: 'More actions' })
    expect(await exportButton.isDisabled()).toBe(false)
    const header = exportButton.locator('xpath=ancestor::header[1]')
    // The right Sidebar's expand button holds the header's corner; the export
    // control sits immediately to its left.
    const sidebarButton = page.getByRole('button', { name: 'Open right sidebar' })
    const [buttonBox, sidebarBox, headerBox] = await Promise.all([
      exportButton.boundingBox(), sidebarButton.boundingBox(), header.boundingBox(),
    ])
    if (buttonBox === null || sidebarBox === null || headerBox === null) {
      throw new Error('Session Header export geometry is unavailable')
    }
    expect(headerBox.x + headerBox.width - (sidebarBox.x + sidebarBox.width)).toBeLessThanOrEqual(32)
    expect(sidebarBox.x - (buttonBox.x + buttonBox.width)).toBeLessThanOrEqual(32)
    const responsePromise = page.waitForResponse(response =>
      response.request().method() === 'HEAD'
      && new URL(response.url()).pathname === '/api/session.export', { timeout: 30_000 })
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
    await exportButton.click()
    await page.getByRole('menuitem', { name: 'Download session log' }).click()
    const response = await responsePromise
    expect(response.status()).toBe(200)
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/^dsh-session-.+\.zip$/)
    const dialog = page.getByRole('dialog', { name: 'Session download started' })
    await dialog.waitFor({ timeout: 30_000 })
    // The real host streamed the ZIP; its root entry is the persisted log
    // text verbatim (the assembled seam: real route, real persistence read).
    const files = unzipSync(await readFile(await download.path()))
    expect(Object.keys(files)).toEqual([EXPORTED_LOG_FILE])
    const content = strFromU8(files[EXPORTED_LOG_FILE] as Uint8Array)
    expect(JSON.parse(content.split('\n')[0] ?? '')).toMatchObject({
      type: 'session', version: SESSION_FORMAT_VERSION,
    })
    expect(content.split('\n')[0]).toContain(SEED_ID)
    expect(content).toContain('FIRST_DONE')
    await dialog.getByText('Close', { exact: true }).click()

    const observer = await newEnglishPage(browser)
    const observerTripwire = watchConsole(observer)
    const observerSlotErrors: string[] = []
    let observerDownloads = 0
    observer.on('download', () => { observerDownloads += 1 })
    observer.on('console', (message) => {
      if (message.type() === 'error' && /slot entry crashed/i.test(message.text())) {
        observerSlotErrors.push(message.text())
      }
    })
    const observerSessionBaseline = baselineResponse(observer)
    const [, observerSessionResponse] = await Promise.all([
      observer.goto(scaffold.authenticatedUrl, { waitUntil: 'load' }),
      observerSessionBaseline,
    ])
    await assertBaselineSucceeded(observerSessionResponse, 'observer session.list')
    await observer.getByText('Ungrouped', { exact: true }).waitFor({ timeout: 30_000 })
    await ensureSeedOpen(observer)

    try {
      const input = page.locator('[data-composer-input]').first()
      const slashDownloadPromise = page.waitForEvent('download', { timeout: 30_000 })
      await input.fill('/export')
      await page.getByRole('option', { name: /^Export/u }).waitFor({ timeout: 10_000 })
      await input.press('Enter')
      const slashDownload = await slashDownloadPromise
      expect(slashDownload.suggestedFilename()).toBe(download.suggestedFilename())
      const slashFiles = unzipSync(await readFile(await slashDownload.path()))
      expect(Object.keys(slashFiles)).toEqual([EXPORTED_LOG_FILE])
      const slashContent = strFromU8(slashFiles[EXPORTED_LOG_FILE] as Uint8Array)
      expect(JSON.parse(slashContent.split('\n')[0] ?? '')).toMatchObject({
        type: 'session', version: SESSION_FORMAT_VERSION,
      })
      const slashEvents = parseSessionLog(slashContent)
      const exportRun = slashEvents.findLast(event => event.type === 'command/run' && event.data.name === 'export')
      if (exportRun?.type !== 'command/run') throw new Error('slash ZIP has no export command/run')
      const exportDone = slashEvents.find(event =>
        event.type === 'command/done' && event.data.commandId === exportRun.data.commandId)
      expect(exportDone?.type).toBe('command/done')
      await page.getByRole('dialog', { name: 'Session download started' }).waitFor({ timeout: 30_000 })
      await page.getByRole('dialog', { name: 'Session download started' })
        .getByText('Close', { exact: true }).click()
      await observer.getByText('Session log download requested.', { exact: true }).waitFor({ timeout: 30_000 })
      expect(observerDownloads).toBe(0)
      expect(await observer.getByRole('dialog', { name: 'Session download started' }).count()).toBe(0)
      expect({
        pageErrors: observerTripwire.pageErrors,
        slotErrors: observerSlotErrors,
        warnings: observerTripwire.warnings,
      }).toEqual({ pageErrors: [], slotErrors: [], warnings: [] })
    } finally {
      await observer.close()
    }
  }, 120_000)

  it.skipIf(MODE === 'record')('copies the complete Session as Markdown from the Session Header', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-copy-markdown'))
    await ensureSeedOpen(page)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    expect(await page.evaluate(() => typeof ClipboardItem)).toBe('function')
    expect(await page.evaluate(() => typeof navigator.clipboard.write)).toBe('function')
    await page.evaluate(() => {
      const clipboard = navigator.clipboard
      const originalWrite = clipboard.write.bind(clipboard)
      Reflect.set(globalThis, '__dshClipboardWrites', 0)
      Object.defineProperty(clipboard, 'write', {
        configurable: true,
        value: (...args: Parameters<typeof originalWrite>) => {
          Reflect.set(globalThis, '__dshClipboardWrites', Number(Reflect.get(globalThis, '__dshClipboardWrites')) + 1)
          return originalWrite(...args)
        },
      })
    })
    const markdownResponse = page.waitForResponse(response =>
      response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/session.markdown', { timeout: 30_000 })
    const copyButton = page.getByRole('button', { name: 'More actions' })
    await copyButton.click()
    await page.getByRole('menuitem', { name: 'Copy Session as Markdown' }).click()
    const response = await markdownResponse
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toBe('text/markdown; charset=utf-8')
    await page.getByText('Session copied as Markdown.', { exact: true }).waitFor({ timeout: 30_000 })
    expect(await page.evaluate(() => Number(Reflect.get(globalThis, '__dshClipboardWrites')))).toBe(1)

    const sourcePath = (await scaffold.ctx.sessionPersistence.stat(SessionId(SEED_ID)))?.location?.path
    if (sourcePath === undefined) throw new Error('seeded Session has no materialized artifact location')
    expect((await stat(sourcePath)).isFile()).toBe(true)
    expect(sourcePath.startsWith(`${scaffold.persistenceRoot}/`)).toBe(true)
    const markdown = await page.evaluate(() => navigator.clipboard.readText())
    expect(markdown).toContain(`Session file:\n\n\`\`\`text\n${sourcePath}\n\`\`\``)
    const normalized = markdown
      .split(sourcePath).join('{{sessionFile}}')
      .split(scaffold.workspaceCwd).join('{{cwd}}')
    // compareOrRefreshGolden appends its own newline; the clipboard text already ends with exactly one.
    await compareOrRefreshGolden(COPY_MARKDOWN_EXPECTED, normalized.replace(/\n$/u, ''), MODE)
    expect(normalized).toContain('Session file:\n\n```text\n{{sessionFile}}\n```')
    expect(normalized).toContain('# NavScenario: first run bash to')
    expect(normalized).toContain('> NavScenario: first run bash to print exactly NAVIGATION_OK')
    expect(normalized).toContain('<details><summary>3 previous messages</summary>')
    expect(normalized).toContain('**Tool: `bash`**')
    expect(normalized).toContain('NAVIGATION_OK')
    expect(normalized).toContain('FIRST_DONE')
    expect(normalized).toContain('Navigation Summary')
    expect(normalized).not.toContain('The user wants me to follow')
    expect(normalized).not.toContain('{{system}}')
    expect(normalized).not.toContain('request/header')
    expect(normalized.endsWith('\n')).toBe(true)
    expect(normalized.endsWith('\n\n')).toBe(false)

    await copyButton.click()
    expect(await page.getByRole('menuitem', { name: 'Copy Session as Markdown' }).isDisabled()).toBe(false)
    await page.keyboard.press('Escape')
  }, 60_000)

  it.skipIf(MODE === 'record')('focuses the ledger by dragging an overview interval', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-timeline'))
    await ensureSeedOpen(page)
    await page.getByRole('tab', { name: 'Trajectory' }).click()
    const plot = page.getByLabel('Timeline overview; drag horizontally to focus events')
    await plot.waitFor({ timeout: 15_000 })
    const before = await page.locator('tr[data-kind]').count()
    const box = await plot.boundingBox()
    if (box === null) throw new Error('trajectory timeline plot has no layout box')
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2)
    await page.mouse.up()
    await expect.poll(() => page.locator('tr[data-timeline-focus="outside"]').count(), { timeout: 10_000 })
      .toBeGreaterThan(0)
    await expect.poll(() => page.locator('tr[data-kind]').count(), { timeout: 10_000 }).toBe(before)
    await plot.click({ button: 'right' })
    await expect.poll(() => page.locator('tr[data-timeline-focus]').count(), { timeout: 10_000 }).toBe(0)
  }, 60_000)

  it.skipIf(MODE === 'record')('bash rows leave the right column at its rail; a file link opens the Sidebar', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-rightbar'))
    await ensureSeedOpen(page)
    const bashRow = page.locator('[data-sample="bash"]').first()
    await expandOwningTurnProcess(page, bashRow)
    await bashRow.waitFor({ timeout: 15_000 })
    const frame = page.locator('[style*="grid-template-columns"]').first()
    expect(await frame.getAttribute('data-rightbar-collapsed')).toBe('true')
    // The row click is the card's expand toggle (unified tool-row
    // interaction); it must not drive layout geometry either way.
    await bashRow.click()
    await expect.poll(() => frame.getAttribute('data-rightbar-collapsed'), { timeout: 5_000 }).toBe('true')
    // The card's own controls are outside the summary row and must not expand
    // the right column either — the expanded terminal card is read in place.
    await page.locator('[data-sample="bash"] ~ div [data-terminal] [class*="_copyButton_"]').first().click()
    await expect.poll(() => frame.getAttribute('data-rightbar-collapsed'), { timeout: 5_000 }).toBe('true')
    // Opening a file into the empty column creates only its preview tab.
    const fileLink = page.locator('[data-variant="read"] button').first()
    await fileLink.waitFor({ timeout: 10_000 })
    await fileLink.click()
    await expect.poll(() => frame.getAttribute('data-rightbar-collapsed'), { timeout: 5_000 }).toBe(null)
    const column = page.locator('[data-rightbar-col]')
    await expect.poll(() => column.locator('[data-dockkit-tab-title]').allTextContents(), { timeout: 5_000 }).toEqual(['nav-a.md'])
    // Put the column back so later cases start from the default frame.
    await column.locator('[data-sidebar-right-toggle]').click()
    await expect.poll(() => frame.getAttribute('data-rightbar-collapsed'), { timeout: 5_000 }).toBe('true')
  }, 60_000)

  it.skipIf(MODE === 'record')('renders the bash row as a terminal card in the real browser', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-terminal'))
    await ensureSeedOpen(page)
    // The card is expand-gated behind the whole-row toggle (the unified
    // tool-row interaction): open it if this fresh view leaves it collapsed.
    // Expanded, the recorded command's own output sits in the message flow,
    // derived from the logged call/result presentations alone.
    const bashRow = page.locator('[data-sample="bash"]').first()
    await expandOwningTurnProcess(page, bashRow)
    await bashRow.waitFor({ timeout: 15_000 })
    if (await bashRow.getAttribute('aria-expanded') !== 'true') await bashRow.click()
    const card = page.locator('[data-sample="bash"] ~ div [data-terminal]').first()
    await card.waitFor({ timeout: 15_000 })
    const commandWrap = await expectWrappedTerminalCommand(page, card, 'echo NAVIGATION_OK', 300)
    await compareOrRefreshGolden(COMMAND_WRAP_EXPECTED, JSON.stringify(commandWrap, null, 2), MODE)
    // Real layout, not jsdom's stub (which computes no geometry at all):
    // squeeze the output pane below its content width and the line must keep
    // its single row and overflow sideways instead of folding. Soft-wrapping
    // here shreds the column alignment this card exists to hold.
    const layout = await card.locator('[class*="_output_"]').first().evaluate((node) => {
      const pane = node as HTMLElement
      const row = pane.querySelector<HTMLElement>('[class*="_line_"]')
      if (row === null) throw new Error('output pane has no line')
      const before = row.offsetHeight
      const restore = pane.style.width
      pane.style.width = '8px'
      const squeezed = { wrapped: row.offsetHeight > before, scrollsSideways: pane.scrollWidth > pane.clientWidth }
      pane.style.width = restore
      return { whiteSpace: getComputedStyle(row).whiteSpace, overflowX: getComputedStyle(pane).overflowX, ...squeezed }
    })
    expect(layout).toEqual({ whiteSpace: 'pre', overflowX: 'auto', wrapped: false, scrollsSideways: true })
    // The run-state dot's color is the whole point of it and is the one thing
    // jsdom cannot report: --dsw-* tokens resolve only against the real theme
    // stylesheet. This command settled cleanly, so the dot must be the green
    // success token — a red one here would read as a failed command.
    const dot = await card.locator('[class*="_runState_"][data-state]').first().evaluate((node) => {
      // The token lives on body, so the probe must sit in the same cascade.
      const probe = document.createElement('span')
      probe.style.color = 'var(--dsw-alias-state-success-primary)'
      document.body.appendChild(probe)
      const success = getComputedStyle(probe).color
      probe.remove()
      return {
        state: node.getAttribute('data-state'),
        color: getComputedStyle(node as HTMLElement).color,
        success,
        // One label per card (the state is the call's), so it hangs off the
        // prompt column rather than the row the dot sits in.
        label: node.closest('[class*="_prompt_"]')?.querySelector('[class*="_runStateLabel_"]')?.textContent ?? null,
        // The dot precedes the prompt label in document order, which is what
        // puts it to the left of the `$`.
        beforePrompt: node.compareDocumentPosition(node.parentElement!.querySelector('[class*="_cwd_"]')!)
          === Node.DOCUMENT_POSITION_FOLLOWING,
        // The dot lives in the card's OWN left padding, so it sits inside the
        // card box yet left of the prompt text. Owning the reservation as padding
        // rather than margin is what keeps a consumer's own margin from
        // cancelling it and letting a container clip the dot — geometry jsdom
        // cannot compute.
        insideCard: (node as HTMLElement).getBoundingClientRect().left
          >= (node.closest('[data-terminal]')?.getBoundingClientRect().left ?? Infinity),
        leftOfPrompt: (node as HTMLElement).getBoundingClientRect().right
          <= (node.closest('[class*="_promptLine_"]')
            ?.querySelector('[class*="_cwd_"]')
            ?.getBoundingClientRect().left ?? -Infinity),
      }
    })
    expect(dot.state).toBe('done')
    expect(dot.label).toBe('Done')
    expect(dot.beforePrompt).toBe(true)
    expect(dot.insideCard).toBe(true)
    expect(dot.leftOfPrompt).toBe(true)
    // Resolved through the theme token, not a literal hex in the component.
    expect(dot.success).toMatch(/^rgb/)
    expect(dot.color).toBe(dot.success)
    // Golden of the card at rest — captured before the copy click, whose
    // confirmation label self-reverts on a timer and would not hold still.
    const snapshot = (await captureStableAria(page, '[data-terminal]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(TERMINAL_EXPECTED, snapshot, MODE)
    // Copy writes the raw output through the browser's own clipboard, which in
    // a real page is the async Clipboard API rather than the jsdom fallback.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await card.locator('[class*="_copyButton_"]').first().click()
    await expect.poll(() => card.locator('[class*="_copyButton_"]').first().textContent(), { timeout: 5_000 })
      .toBe('Copied')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('NAVIGATION_OK')
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the recorded fixture inventory exact', async () => {
    await assertFixtureInventory(CODE_CARD_DIR, [
      'code-card.expected.md', 'command-wrap.expected.md', 'copy-markdown.expected.md',
      'live-result-evicted.expected.md', 'live-result.expected.md', 'live-result-running.expected.md',
    ])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.v3.jsonl', 'search-id-results.expected.md', 'search-results.expected.md', 'trajectory.expected.md',
      'terminal-card.expected.md', 'timing.expected.md',
    ])
  })
  it.skipIf(MODE === 'record')('inspects a live tool value without adding it to the Session journal', async () => {
    await ensureSeedOpen(page)
    await expect.poll(() => scaffold.ctx.agents.get(SessionId(SEED_ID)) !== undefined).toBe(true)
    const agent = scaffold.ctx.agents.get(SessionId(SEED_ID))!
    const unregister = scaffold.ctx.tools.register(defineTool({
      name: 'live_result_probe', description: 'Live result inspection fixture.', parameters: {},
      output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'LIVE_RESULT_RENDERED' }] },
      execute: async () => ({ answer: 42 }),
    }))
    onTestFinished(unregister)
    const callId = ToolCallId('live-result-probe')
    let resultEvent: SessionEvent | undefined
    const off = scaffold.ctx.on('session/event', (_session, event) => {
      if (event.type === 'tool/result' && event.data.message.toolCallId === callId) resultEvent = event
    }, { global: true })
    onTestFinished(() => { off() })
    const batch = await scaffold.ctx.tools.execute({
      agent, signal: new AbortController().signal, log: { turn: 2, step: 1 },
      calls: [{ type: 'tool-call', id: callId, name: 'live_result_probe', arguments: '{}' }],
    })
    expect(batch.results[0]?.result.isError).toBe(false)
    expect(resultEvent).toBeDefined()
    expect(resultEvent?.data).not.toHaveProperty('value')
    const abort = new AbortController()
    const observed = (scaffold.ctx.get('sessionToolResults') as SessionToolResults).watch(
      { sessionId: agent.id, seq: resultEvent!.seq }, abort.signal,
    )[Symbol.asyncIterator]()
    try {
      expect((await observed.next()).value).toEqual({ available: true, value: { answer: 42 } })
    } finally { abort.abort(); await observed.return?.() }

    await page.getByRole('tab', { name: 'Trajectory' }).click()
    await page.locator('tr[data-kind="tool"]').filter({ hasText: 'live_result_probe' }).click()
    const details = page.getByRole('complementary', { name: 'Event details' })
    await details.getByRole('tab', { name: 'Result', exact: true }).click()
    await details.getByText('LIVE_RESULT_RENDERED', { exact: true }).waitFor()
    const rawSection = details.getByRole('region', { name: 'Raw result', exact: true })
    const renderedSection = details.getByRole('region', { name: 'Rendered result', exact: true })
    await expect.poll(() => rawSection.textContent()).toContain('answer:')
    expect(await renderedSection.textContent()).toContain('LIVE_RESULT_RENDERED')
    expect(await details.getByRole('button', { name: 'Raw result', exact: true }).count()).toBe(0)
    await compareOrRefreshGolden(
      LIVE_RESULT_EXPECTED, await captureStableAria(page, '#trajectory-detail-panel', scaffold.workspaceCwd), MODE,
    )
    const unregisterJson = scaffold.ctx.tools.register(defineTool({
      name: 'json_result_probe', description: 'JSON result inspection fixture.', parameters: {},
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      execute: async () => Array.from({ length: 80 }, (_, index) => index),
    }))
    onTestFinished(unregisterJson)
    const jsonBatch = await scaffold.ctx.tools.execute({
      agent, signal: new AbortController().signal, log: { turn: 2, step: 1 },
      calls: [{ type: 'tool-call', id: ToolCallId('json-result-probe'), name: 'json_result_probe', arguments: '{}' }],
    })
    expect(jsonBatch.results[0]?.result.isError).toBe(false)
    await page.locator('tr[data-kind="tool"]').filter({ hasText: 'json_result_probe' }).click()
    await rawSection.getByRole('tree').waitFor()
    await renderedSection.getByRole('tree').waitFor()
    const originalViewport = page.viewportSize()!
    try {
      for (const width of [originalViewport.width, 390]) {
        await page.setViewportSize({ width, height: 600 })
        const geometry = await details.getByRole('tabpanel').evaluate((panel) => {
          const sections = [...panel.querySelectorAll('section[aria-label]')]
          const first = sections[0]!.getBoundingClientRect()
          const second = sections[1]!.getBoundingClientRect()
          return {
            gap: second.top - first.bottom,
            headingFonts: sections.map(section => getComputedStyle(section.querySelector('h3')!).fontSize),
            overflowingDescendants: [...panel.querySelectorAll('*')].filter(node =>
              /auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1).length,
            scrolls: panel.scrollHeight > panel.clientHeight,
            horizontalOverflow: panel.scrollWidth > panel.clientWidth + 1,
            headingsAligned: first.left === second.left,
          }
        })
        expect(geometry).toEqual({
          gap: 2, headingFonts: ['13px', '13px'], overflowingDescendants: 0,
          scrolls: true, horizontalOverflow: false, headingsAligned: true,
        })
        await details.getByRole('tabpanel').evaluate((panel) => { panel.scrollTop = panel.scrollHeight })
        expect(await details.getByRole('tabpanel').evaluate(panel => panel.scrollTop)).toBeGreaterThan(0)
      }
    } finally {
      await page.setViewportSize(originalViewport)
    }
    await page.locator('tr[data-kind="tool"]').filter({ hasText: 'live_result_probe' }).click()
    await expect.poll(() => rawSection.textContent()).toContain('answer:')
    const newer = await scaffold.ctx.tools.execute({
      agent, signal: new AbortController().signal,
      calls: Array.from({ length: 1000 }, (_, index) => ({
        type: 'tool-call' as const, id: ToolCallId(`newer-result-${index}`), name: 'live_result_probe', arguments: '{}',
      })),
    })
    expect(newer.results).toHaveLength(1000)
    expect(newer.results.every(entry => !entry.result.isError)).toBe(true)
    await details.getByText('Raw results are only available for live tool calls', { exact: true }).waitFor()
    // Keep hover and focus tooltips out of the recorded result panel.
    await details.getByText('Raw results are only available for live tool calls', { exact: true }).click()
    await details.getByRole('tooltip').waitFor({ state: 'hidden' })
    await compareOrRefreshGolden(
      EVICTED_RESULT_EXPECTED, await captureStableAria(page, '#trajectory-detail-panel', scaffold.workspaceCwd), MODE,
    )
    await details.getByText('LIVE_RESULT_RENDERED', { exact: true }).waitFor()
  })

  it.skipIf(MODE === 'record')('keeps long raw strings and PTC output readable in one result scroller', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-long-tool-results'))
    await ensureSeedOpen(page)
    await expect.poll(() => scaffold.ctx.agents.get(SessionId(SEED_ID)) !== undefined).toBe(true)
    const agent = scaffold.ctx.agents.get(SessionId(SEED_ID))!
    agent.session.append('turn/start', { turn: 3 })
    onTestFinished(() => {
      agent.session.append('step/end', { turn: 3, step: 1 })
      agent.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    })
    agent.session.append('step/start', { turn: 3, step: 1 })
    const callId = ToolCallId('long-ptc-result')
    const call = agent.session.append('tool/call', {
      turn: 3, step: 1, callId, name: 'run_code',
      arguments: JSON.stringify({ code: 'console.log("PTC output")', description: 'Long program output' }),
    })
    await page.getByRole('tab', { name: 'Trajectory' }).click()
    await page.locator('tr[data-kind="tool"]').filter({ hasText: 'Long program output' }).click()
    const details = page.getByRole('complementary', { name: 'Event details' })
    await details.getByRole('tab', { name: 'Result', exact: true }).click()
    const raw = details.getByRole('region', { name: 'Raw result', exact: true })
    const rendered = details.getByRole('region', { name: 'Rendered result', exact: true })
    await raw.getByText('Running…', { exact: true }).waitFor()
    await compareOrRefreshGolden(
      RUNNING_RESULT_EXPECTED, await captureStableAria(page, '#trajectory-detail-panel', scaffold.workspaceCwd), MODE,
    )
    const ptcOutput = [...Array.from({ length: 100 }, (_, i) => `PTC_LINE_${i}`), 'PTC_END'].join('\n')
    agent.session.append('tool/result', {
      turn: 3, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: ptcOutput }], isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    await rendered.getByText(ptcOutput, { exact: true }).waitFor()
    const stringValue = 'raw_output_'.repeat(300) + 'RAW_END'
    const probes = [
      { name: 'long_string_probe', value: stringValue },
      { name: 'long_json_probe', value: { detail: 'json_output_'.repeat(120) } },
    ]
    for (const probe of probes) {
      const unregister = scaffold.ctx.tools.register(defineTool({
        name: probe.name, description: 'Long result layout fixture.', parameters: {},
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? 'STRING_RENDERED' : JSON.stringify(value) }],
        },
        execute: async () => probe.value,
      }))
      onTestFinished(unregister)
      const batch = await scaffold.ctx.tools.execute({
        agent, signal: new AbortController().signal, log: { turn: 3, step: 1 },
        calls: [{ type: 'tool-call', id: ToolCallId(probe.name), name: probe.name, arguments: '{}' }],
      })
      expect(batch.results[0]?.result.isError).toBe(false)
    }
    const viewport = page.viewportSize()!
    try {
      for (const width of [viewport.width, 390]) {
        await page.setViewportSize({ width, height: 600 })
        for (const name of ['Long program output', ...probes.map(probe => probe.name)]) {
          await details.getByRole('button', { name: 'Close details' }).click()
          await page.locator('tr[data-kind="tool"]').filter({ hasText: name }).click()
          await details.getByRole('tab', { name: 'Result', exact: true }).click()
          if (name === 'long_json_probe') {
            await raw.getByRole('treeitem').waitFor()
            const heights = await Promise.all([raw, rendered].map(section =>
              section.getByRole('treeitem').evaluate(row => row.getBoundingClientRect().height)))
            expect(heights[0]).toBeGreaterThan(3 * 16)
            expect(heights[0]).toBe(heights[1])
          } else {
            const body = name === 'Long program output' ? rendered : raw
            await expect.poll(() => body.locator('pre').textContent()).toBe(
              name === 'Long program output' ? ptcOutput : JSON.stringify(stringValue),
            )
          }
          const panel = details.getByRole('tabpanel')
          const geometry = await panel.evaluate((element) => {
            element.scrollTop = element.scrollHeight
            const bounds = element.getBoundingClientRect()
            const pre = element.querySelector('pre')
            let tailVisible = true
            if (pre?.lastChild !== null && pre?.lastChild !== undefined) {
              const range = document.createRange()
              range.selectNodeContents(pre)
              range.setStart(pre.lastChild, (pre.lastChild.textContent?.length ?? 1) - 1)
              const tail = range.getBoundingClientRect()
              tailVisible = tail.top >= bounds.top && tail.bottom <= bounds.bottom
            }
            return {
              scrolls: element.scrollTop > 0 && getComputedStyle(element).overflowY === 'auto',
              tailVisible,
              overflowingDescendants: [...element.querySelectorAll('*')].filter(node =>
                /auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1).length,
              horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
            }
          })
          expect(geometry).toEqual({ scrolls: true, tailVisible: true, overflowingDescendants: 0, horizontalOverflow: false })
        }
      }
    } finally {
      await page.setViewportSize(viewport)
    }
  })
})
