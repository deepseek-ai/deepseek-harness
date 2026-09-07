// Web e2e scenarios: navigation & panes — the Trajectory view and timing
// overview, its local details inspector, and sidebar search, all over ONE rich
// two-turn seeded fixture rendered purely from the log (the seeded-history
// pattern: zero model calls in replay, so every surface here is the client
// fold + host history RPC, not replay binding). The seed is recorded live
// under the standard discipline: turn 1 produces a bash call plus two
// parallel reads in one assistant message (tool-call density for the
// trajectory ledger/timing lanes), turn 2 a markdown-rich reply.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page, Response } from 'playwright'
import { chromium } from 'playwright'
import { strFromU8, unzipSync } from 'fflate'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/navigation-panes', import.meta.url))
const SEED = join(SNAPSHOT_DIR, 'session.v2.jsonl')
const TRAJECTORY_EXPECTED = join(SNAPSHOT_DIR, 'trajectory.expected.md')
const SEARCH_EXPECTED = join(SNAPSHOT_DIR, 'search-results.expected.md')
const TERMINAL_EXPECTED = join(SNAPSHOT_DIR, 'terminal-card.expected.md')
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
  const search = page.getByPlaceholder('Search sessions', { exact: false })
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
      await seedSession(scaffold, raw, SEED_ID)
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
    const search = page.getByPlaceholder('Search sessions', { exact: false })
    // The cold row has not been opened, so only the persisted log can satisfy
    // this query. First search lazily reconciles the SQLite content index.
    await search.fill('zzzqx-no-such-session')
    await page.getByText('No matching sessions').waitFor({ timeout: 30_000 })
    await expect.poll(
      () => page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem').count(),
      { timeout: 10_000 },
    ).toBe(0)

    await search.fill('WATERFALL')
    const resultTree = page.getByRole('tree', { name: 'Search results' })
    const result = resultTree.getByRole('treeitem')
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
    expect(await page.locator('[data-timeline-span="message"][data-assistant-timing="true"]').count()).toBe(0)
    const snapshot = (await captureStableAria(page, '[class*="viewArea"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(TRAJECTORY_EXPECTED, snapshot, MODE)
    await details.getByRole('button', { name: 'Close details' }).click()
  }, 60_000)

  it.skipIf(MODE === 'record')('downloads through the Session Header and /export with one dialog', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-export'))
    await ensureSeedOpen(page)
    const exportButton = page.getByRole('button', { name: 'Session log' })
    expect(await exportButton.isDisabled()).toBe(false)
    const header = exportButton.locator('xpath=ancestor::header[1]')
    const [buttonBox, headerBox] = await Promise.all([
      exportButton.boundingBox(), header.boundingBox(),
    ])
    if (buttonBox === null || headerBox === null) {
      throw new Error('Session Header export geometry is unavailable')
    }
    expect(headerBox.x + headerBox.width - (buttonBox.x + buttonBox.width)).toBeLessThanOrEqual(32)
    const responsePromise = page.waitForResponse(response =>
      response.request().method() === 'HEAD'
      && new URL(response.url()).pathname === '/api/session.export', { timeout: 30_000 })
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
    await exportButton.click()
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
      await page.getByRole('option', { name: /export/u }).waitFor({ timeout: 10_000 })
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

  it.skipIf(MODE === 'record')('bash and file-path rows leave the default details column closed', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-details'))
    await ensureSeedOpen(page)
    const bashRow = page.locator('[data-sample="bash"]').first()
    await expandOwningTurnProcess(page, bashRow)
    await bashRow.waitFor({ timeout: 15_000 })
    const frame = page.locator('[style*="grid-template-columns"]').first()
    expect(await frame.getAttribute('data-details-collapsed')).toBe('true')
    // The row click is the card's expand toggle (unified tool-row
    // interaction); it must not drive layout geometry either way.
    await bashRow.click()
    await expect.poll(() => frame.getAttribute('data-details-collapsed'), { timeout: 5_000 }).toBe('true')
    // The card's own controls are outside the summary row and must not open
    // details either — the expanded terminal card is read in place.
    await page.locator('[data-sample="bash"] ~ div [data-terminal] [class*="_copyButton_"]').first().click()
    await expect.poll(() => frame.getAttribute('data-details-collapsed'), { timeout: 5_000 }).toBe('true')
    // Read summaries are host-open file links; they also must not open details.
    const fileLink = page.locator('[data-variant="read"] button').first()
    await fileLink.waitFor({ timeout: 10_000 })
    const openPath = vi.spyOn(scaffold.ctx.sessionController, 'openWorkspacePath')
      .mockResolvedValue({ opened: true })
    try {
      await fileLink.click()
      await expect.poll(() => frame.getAttribute('data-details-collapsed'), { timeout: 5_000 }).toBe('true')
    } finally {
      openPath.mockRestore()
    }
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
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.v2.jsonl', 'search-results.expected.md', 'trajectory.expected.md',
      'terminal-card.expected.md',
    ])
  })
})
