// Web e2e scenario: seeded history. A recorded session seeded cold through
// the REAL persistence API renders purely from the log — the surface nothing
// else covers: sidebar cold listing, cold history paging without Agent
// activation, history-page tool views, and the client's log-ordered transcript
// events — with ZERO model calls in replay (no replay fixture; a stray stream
// fails loud on the open llm seam). The cold session also carries keyless
// command-row surfaces: the seeded manual `/compact` lifecycle folds into its
// checkpoint, an Access-chip pick later runs `/permission` on the host, and
// `/feedback` pins its expandable correlation ids. The seed is a recorded
// fixture under the same record discipline as every other: DSH_SNAPSHOT=record drives the turn
// live through the composer (real read tool against seeded workspace files)
// and harvests session.v2.jsonl; replay/refresh seed it cold and only render.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { join } from 'node:path'
import {
  assertFixtureInventory, captureExpandedTurnProcessAria, captureStableAria,
  compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, parseSeedFixture, realizeSeedFixture, recordFixture, renderSeedFixture, seedSession, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/seeded-history', import.meta.url))
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v2.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/ui.expected.md', import.meta.url))
const UI_EXPANDED_EXPECTED = fileURLToPath(
  new URL('../../../snapshots/web/seeded-history/ui-expanded.expected.md', import.meta.url),
)
// Command-row goldens over the same conversation after direct host commands.
const COMMAND_ROW_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/command-row.expected.md', import.meta.url))
const FEEDBACK_ROW_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/feedback-row.expected.md', import.meta.url))
const FILE_OPEN_FAILURE_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/file-open-failure.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'seeded-history-web-e2e'

const PROMPT = 'Use the read tool twice in one assistant message: read a.txt and b.txt. Then reply with the single word DONE and stop.'

/**
 * Append a complete manual `/compact` lifecycle and valid compaction transaction
 * over the recorded turn's own surface. The recording stays model-authentic and
 * reusable; replay adds this deterministic condition before seeding it cold, so
 * the scenario pins both the log-preserving marker and its single-card command
 * presentation through the real host and browser.
 * @param raw - the seed fixture text, already realized (placeholder-free) so
 * the shadow price below is computed from the exact strings the host folds.
 * @param meter - the composed token meter; the appended `compaction/summary`'s
 * shadow price must be the exact heuristic price of the shadowed nodes, the
 * way compaction-basic derives it, because the token-meter projections subtract
 * it verbatim.
 * @returns the fixture with a manual compaction lifecycle appended.
 */
function withCompaction(raw: string, meter: TokenMeter): string {
  const decoded = parseSeedFixture(raw)
  const events = decoded.events as unknown as Array<{
    type: string
    seq: number
    time: number
    surfaceOp?: unknown
    data?: { turn?: unknown; message?: unknown; content?: unknown; callId?: unknown; isError?: unknown }
  }>
  const surfaceSeqs = events
    .filter(event => event.surfaceOp === 'append'
      && (event.type === 'user/message'
        || event.type === 'assistant/message'
        || event.type === 'tool/result'))
    .map(event => event.seq)
  const first = surfaceSeqs[0]
  const last = surfaceSeqs.at(-1)
  const tail = events.at(-1)
  if (first === undefined || last === undefined || tail === undefined) {
    throw new Error('seeded-history compaction requires a non-empty closed surface')
  }
  const lastTurn = events.filter(event => event.type === 'turn/end').at(-1)?.data?.turn
  if (typeof lastTurn !== 'number') {
    throw new Error('seeded-history compaction requires a recording ending on a closed turn')
  }
  let seq = tail.seq + 1
  let time = tail.time + 1
  /**
   * Append one event at the next seq/time.
   * @param event - the event body, without seq/time.
   * @returns the assigned seq, so later `sourceEventSeqs` cite the pushed event directly.
   */
  const at = (event: { type: string } & Record<string, unknown>): number => {
    const taken = seq++
    events.push({ ...event, seq: taken, time: time++ })
    return taken
  }
  const commandId = 'cmd-seeded-manual-compact'
  const compactionId = 'compact-seeded-manual-compact'
  at({
    type: 'command/run',
    data: { commandId, name: 'compact', args: '', source: { kind: 'user' } },
  })
  const startSeq = at({
    type: 'compaction/start',
    data: { compactionId, sourceCommandId: commandId, turn: null },
  })
  // Load-bearing exactness: the projections subtract this count verbatim, so
  // it must equal what the host's fold prices for these nodes. The estimator
  // prices message CONTENT only, so a minimal wrapper for each stored event format is
  // exact — pre-identity rows carry bare `content` (the persistence read path
  // upgrades them), a current row carries the full `message` envelope.
  const priceRow = (row: (typeof events)[number]): number => {
    if (row.data?.message !== undefined) {
      const message = deriveEventMessage(row as unknown as SessionEvent)
      return message === null ? 0 : meter.estimateMessage(message)
    }
    const content = row.data?.content as ContentBlock[]
    if (row.type === 'tool/result') {
      return meter.estimateMessage({
        content: [{ type: 'tool-result', toolCallId: row.data?.callId, content, isError: row.data?.isError === true }],
      } as unknown as Message)
    }
    // An empty-content assistant message derives no transcript entry.
    if (row.type === 'assistant/message' && content.length === 0) return 0
    return meter.estimateMessage({ content } as unknown as Message)
  }
  const shadowedTokenCount = surfaceSeqs.reduce((total, surfaceSeq) => {
    const event = events.find(candidate => candidate.seq === surfaceSeq)
    if (event === undefined) throw new Error(`seeded-history compaction: shadowed seq ${surfaceSeq} is not in the seed`)
    return total + priceRow(event)
  }, 0)
  const summarySeq = at({
    type: 'compaction/summary',
    data: {
      compactionId,
      sourceCommandId: commandId,
      summary: [{
        type: 'text',
        text: '## Cold resume compact summary\n\n- The exact summary remains available.',
      }],
      shadowedRange: { start: first, end: last },
      shadowedSeqs: surfaceSeqs,
      shadowedTokenCount,
      provider: 'snapshot',
      model: 'snapshot-compactor',
    },
  })
  at({
    type: 'user/message',
    data: createUserMessage({
      content: [{
        type: 'text',
        text: '<context_checkpoint>Model-only compact checkpoint.</context_checkpoint>',
      }],
      source: {
        kind: 'plugin', plugin: 'compact', compactionId, sourceCommandId: commandId,
      },
    }),
    surfaceOp: { op: 'replace', start: first, end: last },
    sourceEventSeqs: [startSeq, summarySeq, ...surfaceSeqs],
  })
  at({
    type: 'compaction/end',
    data: { compactionId, sourceCommandId: commandId, turn: null },
  })
  at({
    type: 'command/done',
    data: {
      commandId,
      kind: 'success',
      text: `Compacted ${surfaceSeqs.length} history items (~${shadowedTokenCount} tokens).`,
      sourceEventSeq: summarySeq,
    },
  })
  // The persistence seed helper requires a terminal turn/end. Keep the manual
  // command standalone, then add a closed zero-step turn after it.
  const closureTurn = lastTurn + 1
  at({ type: 'turn/start', data: { turn: closureTurn } })
  at({ type: 'turn/end', data: { turn: closureTurn, reason: { kind: 'completed' } } })
  return renderSeedFixture(decoded.headerLine, events)
}

describe('web e2e: seeded history renders through cold resume', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let seededThroughSeq = -1

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // The workspace-aware flow runs sessions in <workspaceCwd>/workspace
    // (the composer's default draft name); the read-tool targets must live in
    // that session cwd. Pre-creating the directory is safe because the picker
    // adopts an existing directory by path.
    const sessionCwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(sessionCwd, { recursive: true })
    await writeFile(join(sessionCwd, 'a.txt'), 'alpha\n')
    await writeFile(join(sessionCwd, 'b.txt'), 'beta\n')
    if (MODE !== 'record') {
      const raw = await readFile(SEED, 'utf8')
      expect(fixtureUserPrompts(raw), 'seed fixture must carry exactly the drive prompt').toEqual([PROMPT])
      // The meter is host-plane — it takes no configuration and keys every
      // fold by Session — so pricing fixture content needs no agent at all.
      const meter = scaffold.ctx.get('tokenMeter')
      if (meter === undefined) throw new Error('seeded-history requires the host token meter')
      const realizedWithCompaction = withCompaction(realizeSeedFixture(scaffold, raw, SEED_ID), meter)
      seededThroughSeq = parseSeedFixture(realizedWithCompaction).events.at(-1)?.seq ?? -1
      await seedSession(scaffold, realizedWithCompaction, SEED_ID)
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE !== 'record')('records the seed turn live through the composer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-record'))
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled
    await recordFixture(scaffold, sessionId, SEED)
  }, 200_000)

  it.skipIf(MODE === 'record')('serves the projections baseline on the real composition opening snapshot', async () => {
    // Composition regression tripwire: the projection registry must be a row
    // in the SHIPPED cordis.yml — with it absent every domain unit's optional
    // injection stays silent and this block disappears (no titles/todos on
    // the web), while fixture-level suites stay green. Assert through the
    // production Session Controller against the booted real host.
    const controller = new AbortController()
    const stream = scaffold.ctx.sessionController.follow({
      address: { kind: 'session', sessionId: SessionId(SEED_ID) },
    }, controller.signal)[Symbol.asyncIterator]()
    const first = await stream.next()
    controller.abort()
    if (first.done || first.value.type !== 'snapshot') {
      throw new Error('session follow did not publish its opening snapshot')
    }
    expect(first.value.cursor).toBe(seededThroughSeq)
    const projections = first.value.projections
    expect(projections.asOfSeq).toBe(seededThroughSeq)
    // The seed carries a session/title event: the title unit is host-plane, so
    // it folds the detached log and serves the value with nothing composed.
    expect(typeof projections.values.title).toBe('string')
    // `todos` is absent because its unit belongs to the agent preset and this
    // directly seeded session never composed that preset. History computes
    // the baseline through the standard projection registry without mounting
    // an Agent composition as a read side effect.
    expect(projections.values).not.toHaveProperty('todos')
    // The session-stats unit is a shipped web-app bundle row: whole-log
    // turn/step counts ride the same tail block (the stats strip's source).
    const sessionStats = projections.values.sessionStats as { turns: number; steps: number } | undefined
    expect(sessionStats).toBeDefined()
    expect(sessionStats?.turns).toBeGreaterThanOrEqual(1)
    expect(sessionStats?.steps).toBeGreaterThanOrEqual(sessionStats?.turns ?? 0)
  })

  it.skipIf(MODE === 'record')('lists the seeded session cold and renders its history from the log', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-history'))
    // The sidebar tree collapses workspace groups by default: click the group
    // row (treeitem 0) to expand, then the revealed session row.
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    // Settled barrier for history: the recorded final assistant text renders.
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    await expect.poll(() => page.getByText('compact', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => page.getByText(/^Compacted \d+ history items \(~\d+ tokens\)$/).count(), {
      timeout: 10_000,
    }).toBe(1)
    const process = page.locator('[data-turn-process="1"]')
    await process.waitFor({ state: 'visible', timeout: 10_000 })
    expect(await process.getAttribute('aria-expanded')).toBe('false')
    const processBottom = await process.evaluate(element => element.getBoundingClientRect().bottom)
    const answerTop = await page.getByText('DONE', { exact: true }).evaluate(element =>
      element.getBoundingClientRect().top)
    // Collapsed control row keeps its own 8px margin plus the 8px flow gap.
    expect(answerTop).toBe(processBottom + 16)
    expect(await page.getByText('Context compacted', { exact: true }).count()).toBe(0)
    // Tool cards render from logged tool/call + tool/result alone (views are
    // host-recomputed per page; the generic card is the documented default).
    const toolRows = page.locator('[data-variant], [data-sample]')
    await expect.poll(() => toolRows.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    expect(await page.getByText('a.txt', { exact: false }).count()).toBeGreaterThan(0)
    // The pinned hazard: compaction shadows the surface on the model side
    // only — the prompt and full tool output must stay on screen.
    expect(await page.getByText(PROMPT, { exact: true }).count()).toBe(1)

    await expect.poll(
      () => scaffold.ctx.agents.get(SessionId(SEED_ID)) !== undefined,
      { timeout: 10_000 },
    ).toBe(true)
    const agent = scaffold.ctx.agents.get(SessionId(SEED_ID))
    if (agent === undefined) throw new Error('seeded session did not attach an agent')
    agent.session.append('user/message', createUserMessage({
      content: [{
        type: 'text',
        text: '<system-reminder>\n'
          + 'The following workspace instructions may be relevant to your work. '
          + 'Use them as guidance when applicable.\n\n'
          + Array.from({ length: 24 }, (_, index) => `Instruction ${index + 1}: preserve the logged context contract.`).join('\n')
          + '\n</system-reminder>',
      }],
      source: {
        kind: 'agent-instructions',
        form: 'instructions',
        baseline: true,
        changes: [{
          action: 'set',
          scope: '.\u0000AGENTS.md',
          path: 'AGENTS.md',
          digest: 'context-injection-browser-snapshot',
        }],
      },
    }), { surfaceOp: 'append' })
    // The header names the producer the durable source records, so the
    // reconciled instruction file is readable without expanding the row.
    await page.getByRole('button', { name: 'Context injection AGENTS.md', exact: true })
      .waitFor({ timeout: 10_000 })
  }, 60_000)

  it.skipIf(MODE === 'record')('matches the historical conversation aria golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-aria'))
    // This scenario issues zero model calls — the scaffold's route-only
    // adapter serves the catalog and refuses to stream — so history restores
    // the routed id and the seat resolves it against an advertised row.
    await page.getByRole('button', { name: /^Select model, current/ })
      .waitFor({ timeout: 10_000 })
    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    const expanded = (await captureExpandedTurnProcessAria(
      page,
      '[class*="centerCol"]',
      scaffold.workspaceCwd,
    )).split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPANDED_EXPECTED, expanded, MODE)
  })

  it.skipIf(MODE === 'record')('matches the Figma context disclosure geometry', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-context-injection'))
    const disclosure = page.getByRole('button', { name: 'Context injection AGENTS.md', exact: true })
    expect(await disclosure.getAttribute('aria-expanded')).toBe('false')
    const collapsedIcon = disclosure.locator('svg').first()
    const collapsedIconBox = await collapsedIcon.boundingBox()
    expect(collapsedIconBox?.width).toBe(14)
    expect(collapsedIconBox?.height).toBe(14)

    await disclosure.click()
    await expect.poll(() => disclosure.getAttribute('aria-expanded')).toBe('true')
    const body = page.locator('[data-context-injection-body]')
    await body.waitFor({ timeout: 5_000 })
    // The instructions form names the file it reconciled above the text, and
    // the text keeps the framing the model read rather than a cleaned excerpt.
    expect(await body.locator('[data-context-files] li').allInnerTexts()).toEqual(['AGENTS.md\nloaded'])
    expect(await body.locator('[data-context-text]').innerText()).toContain('<system-reminder>')
    const headerBox = await disclosure.boundingBox()
    const bodyBox = await body.boundingBox()
    if (headerBox === null || bodyBox === null) throw new Error('context disclosure geometry is not measurable')
    expect(headerBox.height).toBe(24)
    expect(bodyBox.x - headerBox.x).toBe(22)
    expect(bodyBox.y - headerBox.y - headerBox.height).toBe(4)
    expect(bodyBox.height).toBe(141)

    const style = await body.evaluate((element) => {
      const computed = getComputedStyle(element)
      return {
        backgroundColor: computed.backgroundColor,
        borderRadius: computed.borderRadius,
        color: computed.color,
        fontSize: computed.fontSize,
        lineHeight: computed.lineHeight,
        padding: [
          computed.paddingTop,
          computed.paddingRight,
          computed.paddingBottom,
          computed.paddingLeft,
        ],
        scrolls: element.scrollHeight > element.clientHeight,
      }
    })
    expect(style).toEqual({
      backgroundColor: 'rgb(249, 250, 251)',
      borderRadius: '8px',
      color: 'rgb(129, 133, 140)',
      fontSize: '11px',
      lineHeight: '16px',
      padding: ['10px', '16px', '12px', '12px'],
      scrolls: true,
    })

    await disclosure.click()
    await expect.poll(() => disclosure.getAttribute('aria-expanded')).toBe('false')
  })

  it.skipIf(MODE === 'record')('file-path tool rows rebuilt from the cold log stay details-inert', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-toolrow'))
    // Interaction over cold-resumed history: read summaries are host-open
    // file links (not expand-in-place / not details). Runs after the golden
    // capture; still zero model calls.
    const fileLink = page.locator('[data-variant="read"] button').first()
    await expandOwningTurnProcess(page, fileLink)
    await fileLink.waitFor({ timeout: 10_000 })
    const frame = page.locator('[style*="grid-template-columns"]').first()
    expect(await frame.getAttribute('data-details-collapsed')).toBe('true')
    const openPath = vi.spyOn(scaffold.ctx.sessionController, 'openWorkspacePath')
      .mockResolvedValue({ opened: true })
    try {
      await fileLink.click()
      await expect.poll(() => frame.getAttribute('data-details-collapsed'), { timeout: 5_000 }).toBe('true')
    } finally {
      openPath.mockRestore()
    }
    // Path label survives from the recorded args (a.txt).
    await expect.poll(() => page.getByText('a.txt', { exact: false }).count(), { timeout: 5_000 }).toBeGreaterThan(0)
  })

  it.skipIf(MODE === 'record')('a Host open refusal keeps the reason and retries the same path', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-file-open-failure'))
    const fileLink = page.locator('[data-variant="read"] button').first()
    await fileLink.waitFor({ timeout: 10_000 })
    const openPath = vi.spyOn(scaffold.ctx.sessionController, 'openWorkspacePath')
      .mockRejectedValue(new Error('xdg-open is not available'))
    try {
      await fileLink.click()
      const dialog = page.getByRole('dialog', { name: 'Couldn’t open file' })
      await dialog.waitFor({ timeout: 5_000 })
      const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(FILE_OPEN_FAILURE_EXPECTED, snapshot, MODE)
      await expect.poll(() => dialog.innerText(), { timeout: 5_000 })
        .toContain('path open failed: xdg-open is not available')
      await page.getByRole('button', { name: 'Retry' }).click()
      await expect.poll(() => openPath.mock.calls.length, { timeout: 5_000 }).toBe(2)
      expect(openPath.mock.calls[0]![0]).toEqual(openPath.mock.calls[1]![0])
      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect.poll(() => page.getByRole('dialog', { name: 'Couldn’t open file' }).count(), {
        timeout: 5_000,
      }).toBe(0)
    } finally {
      // Shared page: a leftover mask blocks later cases even when this one fails.
      if (await page.getByRole('dialog', { name: 'Couldn’t open file' }).count() > 0) {
        await page.keyboard.press('Escape')
      }
      openPath.mockRestore()
    }
  })

  it.skipIf(MODE === 'record')('expands the cold-resumed compact summary', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-compaction'))
    const marker = page.getByRole('button', { name: /compact Compacted \d+ history items/ })
    await marker.waitFor({ timeout: 10_000 })
    expect(await marker.getAttribute('aria-expanded')).toBe('false')
    await marker.click()
    await expect.poll(() => marker.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('true')
    await expect.poll(() => page.getByRole('heading', { name: 'Cold resume compact summary' }).count(), {
      timeout: 5_000,
    }).toBe(1)
    expect(await page.getByText('The exact summary remains available.', { exact: false }).count()).toBeGreaterThan(0)
    // Restore the shared page state for any later case.
    await marker.click()
    await expect.poll(() => marker.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('false')
  })

  it.skipIf(MODE === 'record')('an Access-chip switch lands one command row: bare name, non-repeating settlement text', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-command-row'))
    // The Access chip submits `/permission <preset>` — a host command with no
    // model call, so the settled row renders keylessly over this cold history.
    // The row copy is the assertion: `permission · preset read-only`,
    // where neither half repeats the other (the dispatched `/` and its
    // argument stay out of the title, and the settlement text never restates
    // the command's own name).
    await page.getByRole('button', { name: 'Access mode, current: Workspace Write' }).click()
    await page.getByRole('menuitem', { name: 'Read Only' }).click()
    await page.getByRole('button', { name: 'Access mode, current: Read Only' }).waitFor({ timeout: 10_000 })
    // Scoped to the row itself, so unrelated page text that happens to read
    // `permission` (a future resident slash menu) cannot satisfy or break it.
    const row = page.locator('[data-variant="others"]').filter({ hasText: 'preset read-only' })
    await expect.poll(() => row.count(), { timeout: 10_000 }).toBe(1)
    expect(await row.getByText('permission', { exact: true }).count()).toBe(1)
    expect(await row.getByText('/permission read-only', { exact: true }).count()).toBe(0)
    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(COMMAND_ROW_EXPECTED, snapshot, MODE)
  }, 60_000)

  it.skipIf(MODE === 'record')('reports full feedback correlation ids in an expandable two-line row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-feedback-row'))
    const previousDshHome = process.env.DSH_HOME
    process.env.DSH_HOME = scaffold.harnessHome
    try {
      const input = page.locator('[data-composer-input]').first()
      await input.fill('/feedback the diff view is unreadable')
      await input.press('Enter')
      const row = page.locator('[data-variant="others"]').filter({
        hasText: `Feedback recorded for session ${SEED_ID}`,
      })
      await row.waitFor({ timeout: 10_000 })
      const disclosure = row.locator('[data-expandable]')
      expect(await disclosure.getAttribute('aria-expanded')).toBe('false')
      await disclosure.click()
      await expect.poll(() => disclosure.getAttribute('aria-expanded')).toBe('true')

      const agent = scaffold.ctx.agents.get(SessionId(SEED_ID))
      if (agent === undefined) throw new Error('seeded session did not attach an agent')
      const done = agent.session.snapshotEvents().filter(event => event.type === 'command/done').at(-1)
      if (done?.type !== 'command/done') throw new Error('feedback command did not settle')
      const [sessionLine, userLine, extraLine] = done.data.text?.split('\n') ?? []
      expect(sessionLine).toBe(`Feedback recorded for session ${SEED_ID}`)
      expect(userLine).toMatch(/^Anonymous user: [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.$/i)
      expect(extraLine).toBeUndefined()
      const userId = userLine?.match(/^Anonymous user: ([0-9a-f-]+)/i)?.[1]
      if (userId === undefined) throw new Error('feedback command omitted the user id')

      const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
        .split(SEED_ID).join('{{seededId}}')
        .split(userId).join('{{userId}}')
      await compareOrRefreshGolden(FEEDBACK_ROW_EXPECTED, snapshot, MODE)
    } finally {
      if (previousDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousDshHome
    }
  }, 60_000)

  it.skipIf(MODE === 'record')('fits short logged context without a scrollport', async () => {
    const agent = scaffold.ctx.agents.get(SessionId(SEED_ID))
    if (agent === undefined) throw new Error('seeded session did not attach an agent')
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Short injected context.' }],
      source: { kind: 'plugin', plugin: 'fixture' },
    }), { surfaceOp: 'append' })

    const disclosure = page.getByRole('button', { name: 'Context injection fixture', exact: true })
    await disclosure.waitFor({ timeout: 10_000 })
    await disclosure.click()
    await expect.poll(() => disclosure.getAttribute('aria-expanded')).toBe('true')

    // The instructions row above stays expanded from the geometry case; the
    // opaque body is the one without a declared form.
    const body = page.locator('[data-context-injection-body]:not([data-context-form])')
    const bodyBox = await body.boundingBox()
    if (bodyBox === null) throw new Error('short context disclosure geometry is not measurable')
    expect(bodyBox.height).toBeLessThan(141)
    expect(await body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(false)
  })

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', async () => {
    // No replay fixture was installed and the llm seam is open — any stray
    // stream would have failed the turn loudly. Cleanliness pins the wire.
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'command-row.expected.md', 'feedback-row.expected.md', 'file-open-failure.expected.md',
      'session.v2.jsonl', 'ui.expected.md', 'ui-expanded.expected.md',
    ])
  })
})
