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
// and harvests session.v3.jsonl; replay/refresh seed it cold and only render.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed, Message, MessageSource } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-api-terminal-controller'
import { join } from 'node:path'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureExpandedTurnProcessAria, captureStableAria,
  compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, parseSeedFixture, realizeSeedFixture, recordFixture, renderSeedFixture, seedSession, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, pinBrowserClock, pinHostClock, saveFailureShot, WEB_FIXTURE_TIME } from './support.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'fixture': { kind: 'fixture' } & ContextFormed
  }
}

type CheckpointSource = Extract<MessageSource, { readonly kind: 'compact-checkpoint' }>
type CheckpointCommandId = NonNullable<CheckpointSource['sourceCommandId']>

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/seeded-history', import.meta.url))
const REASONING_EXPECTED_DIR = fileURLToPath(new URL('./expected/seeded-history', import.meta.url))
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/ui.expected.md', import.meta.url))
const UI_EXPANDED_EXPECTED = fileURLToPath(
  new URL('../../../snapshots/web/seeded-history/ui-expanded.expected.md', import.meta.url),
)
const THINKING_EXPECTED = join(SNAPSHOT_DIR, 'thinking-expanded.expected.md')
// Command-row goldens over the same conversation after direct host commands.
const COMMAND_ROW_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/command-row.expected.md', import.meta.url))
const FEEDBACK_ROW_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/feedback-row.expected.md', import.meta.url))
const FILE_PREVIEW_EXPECTED = join(SNAPSHOT_DIR, 'file-preview.expected.md')
const CHECKPOINT_SIDEBAR_EXPECTED = join(SNAPSHOT_DIR, 'checkpoint-sidebar.expected.md')
const CHECKPOINT_TITLE = 'Context summary'
const MODE = webSnapshotMode()
const SEED_ID = 'seeded-history-web-e2e'

const PROMPT = 'Use the read tool twice in one assistant message: read a.txt and b.txt. Then reply with the single word DONE and stop.'

/** Trajectory visibility confirms Client receipt; Host persistence alone does not. */
async function waitForContextInClient(page: Page, seq: number): Promise<void> {
  await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
  try {
    await page.locator(`[data-trajectory-scroll] tr[data-trajectory-row-key="context%00seq%00${seq}"]`)
      .waitFor({ state: 'visible', timeout: 10_000 })
  } finally {
    await page.getByRole('tab', { name: 'Chat', exact: true }).click()
  }
  await page.locator('[data-conversation-scroll]').waitFor({ state: 'visible' })
}

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
  const commandId = 'cmd-seeded-manual-compact' as CheckpointCommandId
  const compactionId = 'compact-seeded-manual-compact' as CheckpointSource['compactionId']
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
        text: '## Cold resume compact summary\n\n- The exact summary remains available.\n\n'
          + '```ts\nfunction resume(): boolean {\n'
          + Array.from({ length: 26 }, (_, index) => `  const step${index + 1} = read(${index + 1})`).join('\n')
          + '\n  return true\n}\n```\n\n'
          + Array.from({ length: 40 }, (_, index) => `- Retained fact ${index + 1}: the reader still sees the pre-compaction surface.`).join('\n'),
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
        kind: 'compact-checkpoint', compactionId, sourceCommandId: commandId,
      },
    }),
    surfaceOp: { op: 'replace', startSeq: first, endSeq: last },
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

const SUMMARY_PREVIEW = '[data-compaction-preview]'

/** The manual compaction marker; its hidden label names the Sidebar action. */
function compactionMarker(page: Page): Locator {
  return page.getByRole('button', { name: /^compact Compacted \d+ history items .*View compaction summary in the sidebar$/ })
}

/** Close the checkpoint tab when present, leaving the other Sidebar tabs. */
async function closeCheckpointTab(column: Locator): Promise<void> {
  const tab = column.locator('[data-dockkit-tab]').filter({ hasText: CHECKPOINT_TITLE })
  if (await tab.count() > 0) await tab.locator('[data-dockkit-tab-close]').click()
  await expect.poll(() => tab.count(), { timeout: 5_000 }).toBe(0)
}

describe('web e2e: seeded history renders through cold resume', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let seededThroughSeq = -1
  let openingWindow: unknown
  let hostClock: ReturnType<typeof pinHostClock> | undefined

  beforeAll(async () => {
    // Seeded and later command timestamps share the renderer's fixture day across midnight.
    if (MODE !== 'record') hostClock = pinHostClock()
    // The POSIX terminal fixture stays off Windows; the pinned desktop applies
    // everywhere. The Open In rows carry the document header's file controls,
    // and the SSH marker keeps the application catalog empty so the
    // Session-header split button stays out of every golden.
    scaffold = await launchWebScaffold({
      extraOverlayPath: [
        ...process.platform === 'win32' ? [] : [fileURLToPath(new URL('./fixtures/sidebar-terminal.patch.yml', import.meta.url))],
        fileURLToPath(new URL('./fixtures/native-open-on.patch.yml', import.meta.url)),
      ],
      openInAppEnvironment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { SSH_CONNECTION: '10.0.0.2 55000 10.0.0.9 22' } }]),
    })
    // Application registrations belong to the host desktop, not to the recorded Session.
    const controller = scaffold.ctx.get('sessionController')
    if (controller === undefined) throw new Error('seeded-history requires Session Controller')
    const nativeQuery: unknown = Reflect.get(controller, 'fileApplications')
    if (typeof nativeQuery !== 'function') throw new Error('seeded-history requires the native file-association adapter')
    Reflect.set(controller, 'fileApplications', async () => [])
    scaffold.ctx.effect(() => () => { Reflect.set(controller, 'fileApplications', nativeQuery) }, 'seeded-history: native association fixture')
    // Composer recording uses a child workspace; seedSession owns the scaffold root.
    const sessionCwd = MODE === 'record' ? join(scaffold.workspaceCwd, 'workspace') : scaffold.workspaceCwd
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
      await seedSession(scaffold, realizedWithCompaction, SEED_ID, undefined, { createdAt: WEB_FIXTURE_TIME })
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    if (MODE !== 'record') await pinBrowserClock(page)
    tripwire = watchConsole(page)
    if (MODE !== 'record') {
      // A one-message tail makes this short recording exercise the real Load earlier path.
      let pagedOpening = false
      await page.routeWebSocket('**/api/remote.mux', (socket) => {
        const server = socket.connectToServer()
        socket.onMessage((message) => {
          const frame = JSON.parse(String(message)) as {
            type: string
            endpoint?: string
            payload: { args: { request: { maxMessages: number; turnWindow?: { minMessages: number; minTurns: number } } } }
          }
          if (!pagedOpening && frame.type === 'open' && frame.endpoint === 'session/follow') {
            pagedOpening = true
            openingWindow = { ...frame.payload.args.request }
            frame.payload.args.request.maxMessages = 1
            delete frame.payload.args.request.turnWindow
            server.send(JSON.stringify(frame))
          } else server.send(message)
        })
      })
    }
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
      await scaffold?.close()
    } finally {
      hostClock?.mockRestore()
    }
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
      address: { kind: 'session', sessionId: brandString<SessionId>(SEED_ID) },
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
    // Eager preset activation registers the todo projection before any Agent
    // opens this log. A log without todo events projects its empty value.
    expect(projections.values.todos).toBeNull()
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
    expect(openingWindow).toMatchObject({ maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } })
    expect(await page.getByText(PROMPT, { exact: true }).count()).toBe(0)
    const [paging] = await Promise.all([
      page.waitForRequest('**/api/session/page'),
      page.getByRole('button', { name: 'Load earlier', exact: true }).click(),
    ])
    expect(paging.postDataJSON()).toMatchObject({
      payload: { args: { request: { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } } } },
    })
    await expect.poll(() => page.getByText(PROMPT, { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    const history = page.locator('[data-chat-history]')
    await expect.poll(() => history.getAttribute('data-chat-history'), { timeout: 10_000 }).toBe('idle')
    await expect.poll(() => history.getByRole('button', { name: 'Start of conversation', exact: true }).isDisabled(), {
      timeout: 10_000,
    }).toBe(true)
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
    // Hidden process rows separate the folded control from the answer, so it keeps the 12px reply gap.
    expect(answerTop).toBe(processBottom + 12)
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
      () => scaffold.ctx.agents.get(brandString<SessionId>(SEED_ID)) !== undefined,
      { timeout: 10_000 },
    ).toBe(true)
    const agent = scaffold.ctx.agents.get(brandString<SessionId>(SEED_ID))
    if (agent === undefined) throw new Error('seeded session did not attach an agent')
    const injected = agent.session.append('user/message', createUserMessage({
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
    await scaffold.ctx.sessions.flush(agent.session)
    expect(agent.session.snapshotEvents()).toContainEqual(injected)
    await waitForContextInClient(page, injected.seq)
    const contextRows = page.locator('[data-chat-flow-kind="context"]')
    await expect.poll(() => contextRows.count()).toBe(1)
    expect(await contextRows.getByRole('button', { name: /^Context injection/ }).getAttribute('aria-expanded')).toBe('false')
    expect(await contextRows.locator('[data-context-injection-body]').count()).toBe(0)
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

  it.skipIf(MODE === 'record')('renders recorded reasoning as secondary Markdown when expanded', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-thinking'))
    const turnProcess = page.locator('[data-turn-process]').first()
    const wasExpanded = await turnProcess.getAttribute('aria-expanded') === 'true'
    if (!wasExpanded) await turnProcess.click()
    const thinking = page.locator('[data-variant="think"]').first()
    await expandOwningTurnProcess(page, thinking)
    const toggle = thinking.getByRole('button').first()
    const secondarySize = await thinking.locator('[class*="summaryText"]').evaluate(element => getComputedStyle(element).fontSize)
    await toggle.click()
    try {
      await thinking.locator('p').waitFor({ timeout: 10_000 })
      const snapshot = await captureStableAria(page, '[data-variant="think"][data-expanded]', scaffold.workspaceCwd)
      const typography = await thinking.locator('p').evaluate((paragraph, expectedSize) => {
        const style = getComputedStyle(paragraph)
        return {
          secondarySize: style.fontSize === expectedSize,
          wraps: style.whiteSpace === 'normal',
          contained: paragraph.scrollWidth <= paragraph.clientWidth + 1,
        }
      }, secondarySize)
      expect(typography).toEqual({ secondarySize: true, wraps: true, contained: true })
      await compareOrRefreshGolden(THINKING_EXPECTED, [
        snapshot,
        '',
        `- Secondary font size: ${String(typography.secondarySize)}`,
        `- Markdown paragraph wrapping: ${String(typography.wraps)}`,
        `- Content stays within the reasoning column: ${String(typography.contained)}`,
      ].join('\n'), MODE)
    } finally {
      await toggle.click()
      if (!wasExpanded) await turnProcess.click()
    }
  })

  it.skipIf(MODE === 'record')('shows ordinary instructions as one collapsed Context row that expands to their logged content', async () => {
    const session = scaffold.ctx.sessions.get(brandString<SessionId>(SEED_ID))
    if (session === undefined) throw new Error('seeded session is unavailable')
    const instructions = session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'agent-instructions')
    expect(instructions).toHaveLength(1)
    expect(instructions[0]?.data).toMatchObject({ source: { form: 'instructions', changes: [{ path: 'AGENTS.md' }] } })
    expect(JSON.stringify(instructions[0]?.data)).toContain('Instruction 24: preserve the logged context contract.')
    const row = page.locator('[data-chat-flow-kind="context"]')
    expect(await row.count()).toBe(1)
    const disclosure = row.getByRole('button', { name: /^Context injection/ })
    expect(await disclosure.getAttribute('aria-expanded')).toBe('false')
    await disclosure.click()
    try {
      await expect.poll(() => row.locator('[data-context-injection-body]').textContent())
        .toContain('Instruction 24: preserve the logged context contract.')
    } finally {
      await disclosure.click()
    }
    await expect.poll(() => row.locator('[data-context-injection-body]').count()).toBe(0)
  })

  it.skipIf(MODE === 'record')('restores the active turn rail mark across Chat and Trajectory', async () => {
    const rail = page.getByRole('navigation', { name: 'Turn navigation' })
    const current = rail.locator('[aria-current="true"]')
    await current.waitFor({ state: 'visible' })
    const active = await current.getAttribute('aria-label')
    const scroller = page.locator('[data-conversation-scroll]')
    const top = await scroller.evaluate(element => element.scrollTop)

    await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
    await page.getByLabel('Trajectory timeline', { exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('tab', { name: 'Chat', exact: true }).click()

    await expect.poll(() => current.getAttribute('aria-label')).toBe(active)
    await expect.poll(async () => Math.abs(await scroller.evaluate(element => element.scrollTop) - top)).toBeLessThanOrEqual(2)
    expect(tripwire.pageErrors).toEqual([])
  })

  it.skipIf(MODE === 'record')('file-path tool rows rebuilt from the cold log open the right Sidebar', async () => {
    onTestFailed(async () => {
      await mkdir(fileURLToPath(new URL('../../../.artifacts/screenshots/0907-2205-sidebar', import.meta.url)), { recursive: true })
      await saveFailureShot(page, `screenshots/0907-2205-sidebar/seeded-toolrow-${process.pid}`)
    })
    // Interaction over cold-resumed history: read summaries are file links
    // that open a text-preview tab in the right Sidebar (not expand-in-place).
    // Runs after the golden capture; still zero model calls.
    const fileLink = page.locator('[data-variant="read"] button').first()
    await expandOwningTurnProcess(page, fileLink)
    await fileLink.waitFor({ timeout: 10_000 })
    const frame = page.locator('[style*="grid-template-columns"]').first()
    expect(await frame.getAttribute('data-rightbar-collapsed')).toBe('true')
    const column = page.locator('[data-rightbar-col]')
    try {
      await fileLink.click()
      await expect.poll(() => frame.getAttribute('data-rightbar-collapsed'), { timeout: 5_000 }).toBe(null)
      await expect.poll(() => column.locator('[data-dockkit-tab-title]').allTextContents(), { timeout: 5_000 }).toEqual(['a.txt'])
      // Path label survives from the recorded args (a.txt).
      await expect.poll(() => page.getByText('a.txt', { exact: false }).count(), { timeout: 5_000 }).toBeGreaterThan(0)
      const path = column.locator('[data-textpreview-path]')
      const absolutePath = join(scaffold.workspaceCwd, 'a.txt')
      await expect.poll(() => path.textContent()).toBe(absolutePath)
      expect(await path.getAttribute('title')).toBe(absolutePath)
      await expect.poll(() => column.locator('[data-textpreview-line="1"]').textContent()).toBe('alpha\n')
      await column.getByRole('button', { name: 'Show file location', exact: true }).waitFor({ timeout: 5_000 })
      await expect.poll(() => column.locator('[data-open-path-open]').isEnabled()).toBe(true)
      const preview = await captureStableAria(page, '[data-textpreview-state="text"]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(FILE_PREVIEW_EXPECTED, preview, MODE)
    } finally {
      // Later cases share this page and require the sidebar closed even after a failed assertion.
      if (await frame.getAttribute('data-rightbar-collapsed') !== 'true') {
        await column.locator('[data-sidebar-right-toggle]').click()
        await expect.poll(() => frame.getAttribute('data-rightbar-collapsed'), { timeout: 5_000 }).toBe('true')
      }
      await page.getByRole('button', { name: 'Open right sidebar', exact: true }).waitFor({ state: 'visible' })
      await page.getByRole('navigation', { name: 'Turn navigation', exact: true }).waitFor({ state: 'visible' })
    }
  })

  it.skipIf(MODE === 'record')('opens the compaction checkpoint in a content tab without expanding Chat', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-compaction'))
    const marker = compactionMarker(page)
    await marker.waitFor({ timeout: 10_000 })
    expect(await marker.getAttribute('aria-expanded')).toBeNull()
    const frame = page.locator('[style*="grid-template-columns"]').first()
    expect(await frame.getAttribute('data-rightbar-collapsed')).toBe('true')
    const column = page.locator('[data-rightbar-col]')
    const preview = column.locator(SUMMARY_PREVIEW)
    try {
      await marker.click()
      await preview.locator('[data-document-markdown]').waitFor({ state: 'visible', timeout: 10_000 })
      await marker.click()
      await expect.poll(() => marker.isEnabled()).toBe(true)
      expect(await column.locator('[data-dockkit-tab-title]').allTextContents()).toEqual(['a.txt', CHECKPOINT_TITLE])
      await expect.poll(() => preview.locator('[data-document-markdown]').textContent())
        .toContain('Cold resume compact summary')
      // The checkpoint opens beside the transcript; Chat neither expands the
      // marker nor shows the replacement text or the backend summary inline.
      const transcript = page.locator('[data-conversation-scroll]')
      expect(await transcript.getByText('Model-only compact checkpoint.', { exact: false }).count()).toBe(0)
      expect(await transcript.getByRole('heading', { name: 'Cold resume compact summary' }).count()).toBe(0)
      expect(await marker.getAttribute('aria-expanded')).toBeNull()
      await compareOrRefreshGolden(CHECKPOINT_SIDEBAR_EXPECTED,
        await captureStableAria(page, SUMMARY_PREVIEW, scaffold.workspaceCwd), MODE)
    } finally {
      // Later cases share this page and require only the file tab, with the Sidebar closed.
      await closeCheckpointTab(column)
      if (await frame.getAttribute('data-rightbar-collapsed') !== 'true') {
        await column.locator('[data-sidebar-right-toggle]').click()
        await expect.poll(() => frame.getAttribute('data-rightbar-collapsed'), { timeout: 5_000 }).toBe('true')
      }
      await page.getByRole('button', { name: 'Open right sidebar', exact: true }).waitFor({ state: 'visible' })
      await page.getByRole('navigation', { name: 'Turn navigation', exact: true }).waitFor()
    }
  })

  it.skipIf(MODE === 'record')('an Access-chip switch persists its command without adding a Chat row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-command-row'))
    await page.getByRole('button', { name: 'Access mode, current: Workspace Write' }).click()
    await page.getByRole('menuitem', { name: 'Read Only' }).click()
    const access = page.getByRole('button', { name: 'Access mode, current: Read Only' })
    await expect.poll(() => access.isEnabled(), { timeout: 10_000 }).toBe(true)
    const row = page.locator('[data-variant="others"]').filter({ hasText: 'preset read-only' })
    expect(await row.count()).toBe(0)
    const agent = scaffold.ctx.agents.get(brandString<SessionId>(SEED_ID))
    if (agent === undefined) throw new Error('seeded session did not attach an agent')
    const events = agent.session.snapshotEvents()
    const run = events.findLast(event => event.type === 'command/run' && event.data.name === 'permission')
    if (run?.type !== 'command/run') throw new Error('permission command was not persisted')
    expect(events.find(event => event.type === 'command/done' && event.data.commandId === run.data.commandId)?.data)
      .toMatchObject({ kind: 'success', text: 'preset read-only' })
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

      const agent = scaffold.ctx.agents.get(brandString<SessionId>(SEED_ID))
      if (agent === undefined) throw new Error('seeded session did not attach an agent')
      const done = agent.session.snapshotEvents().filter(event => event.type === 'command/done').at(-1)
      if (done?.type !== 'command/done') throw new Error('feedback command did not settle')
      const [sessionLine, userLine, extraLine] = done.data.text?.split('\n') ?? []
      expect(sessionLine).toBe(`Feedback recorded for session ${SEED_ID}`)
      expect(userLine).toMatch(/^Anonymous user: [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.$/i)
      expect(extraLine).toBeUndefined()
      const userId = userLine?.match(/^Anonymous user: ([0-9a-f-]+)/i)?.[1]
      if (userId === undefined) throw new Error('feedback command omitted the user id')

      // command/done can arrive before the submit reply releases the composer.
      await expect.poll(() => input.textContent(), { timeout: 10_000 }).toBe('')
      await expect.poll(() => page.getByRole('button', { name: 'Add files or run commands' }).isEnabled(), { timeout: 10_000 }).toBe(true)
      const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
        .split(SEED_ID).join('{{seededId}}')
        .split(userId).join('{{userId}}')
      await compareOrRefreshGolden(FEEDBACK_ROW_EXPECTED, snapshot, MODE)
    } finally {
      if (previousDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousDshHome
    }
  }, 60_000)

  it.skipIf(MODE === 'record')('shows short injected context as a collapsed Context row without dropping the event', async () => {
    const agent = scaffold.ctx.agents.get(brandString<SessionId>(SEED_ID))
    if (agent === undefined) throw new Error('seeded session did not attach an agent')
    const contextRows = page.locator('[data-chat-flow-kind="context"]')
    const before = await contextRows.count()
    const injected = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Short injected context.' }],
      source: { kind: 'fixture' },
    }), { surfaceOp: 'append' })

    await scaffold.ctx.sessions.flush(agent.session)
    expect(agent.session.snapshotEvents()).toContainEqual(injected)
    await waitForContextInClient(page, injected.seq)
    await expect.poll(() => contextRows.count()).toBe(before + 1)
    const row = contextRows.last()
    const disclosure = row.getByRole('button', { name: /^Context injection/ })
    expect(await disclosure.getAttribute('aria-expanded')).toBe('false')
    await disclosure.click()
    try {
      await expect.poll(() => row.locator('[data-context-injection-body]').getByText('Short injected context.', { exact: true }).count()).toBe(1)
    } finally {
      await disclosure.click()
    }
  })

  it.skipIf(MODE === 'record')('restores the recorded file preview in its original tab after page reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-sidebar-reload'))
    await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
    const column = page.locator('[data-rightbar-col]')
    await expect.poll(() => column.locator('[data-textpreview-line="1"]').textContent()).toBe('alpha\n')
    const tabId = await column.locator('[data-dockkit-tab]').getAttribute('data-dockkit-tab')
    await column.locator('[data-open-path-open]').waitFor({ timeout: 5_000 })
    const preview = await captureStableAria(page, '[data-textpreview-state="text"]', scaffold.workspaceCwd)
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expect.poll(() => column.locator('[data-textpreview-line="1"]').textContent()).toBe('alpha\n')
    expect(await column.locator('[data-dockkit-tab]').getAttribute('data-dockkit-tab')).toBe(tabId)
    await column.locator('[data-open-path-open]').waitFor({ timeout: 5_000 })
    const restoredPreview = await captureStableAria(page, '[data-textpreview-state="text"]', scaffold.workspaceCwd)
    expect(restoredPreview).toBe(preview)
  })

  it.skipIf(MODE === 'record')('restores the file tab and reopens the summary from its chat row after reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-compaction-reload'))
    // Runs after the cases that capture Chat goldens: reloading resets their
    // expanded rows. The previous case left the Sidebar open on the file tab.
    const column = page.locator('[data-rightbar-col]')
    const rendered = column.locator(`${SUMMARY_PREVIEW} [data-document-markdown]`)
    try {
      await compactionMarker(page).click()
      await rendered.waitFor({ state: 'visible', timeout: 10_000 })
      const before = await captureStableAria(page, SUMMARY_PREVIEW, scaffold.workspaceCwd)
      const warningStart = tripwire.warnings.length
      await page.reload({ waitUntil: 'load' })
      acknowledgeReloadConnectionLoss(tripwire, warningStart)
      await column.locator('[data-textpreview-line="1"]').waitFor()
      expect(await column.locator('[data-dockkit-tab-title]').allTextContents()).toEqual(['a.txt'])
      expect(await rendered.count()).toBe(0)
      await compactionMarker(page).click()
      await rendered.waitFor({ state: 'visible', timeout: 15_000 })
      expect(await column.locator('[data-dockkit-tab-title]').allTextContents()).toEqual(['a.txt', CHECKPOINT_TITLE])
      expect(await captureStableAria(page, SUMMARY_PREVIEW, scaffold.workspaceCwd)).toBe(before)
    } finally {
      await closeCheckpointTab(column)
    }
  })

  it.skipIf(MODE === 'record' || process.platform === 'win32')('offers explicit terminal replacement after restoring the recorded Session', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-terminal-unavailable'))
    await page.locator('[data-dockkit-add-tab]').click()
    await page.locator('[data-sidebar-right-guide-entry="terminal"]').getByRole('button', { name: /^New terminal/u }).click()
    const sessionId = brandString<SessionId>(SEED_ID)
    const terminals = () => scaffold.ctx.terminalController.list(sessionId)
    await expect.poll(() => terminals().length).toBe(1)
    const previous = terminals()[0]!.id
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Recorded Session did not attach an Agent for its terminal')
    await scaffold.ctx.terminalController.close(agent, previous)
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    const terminal = page.locator('[data-sidebar-terminal]')
    await expect.poll(() => terminal.getByRole('alert').innerText()).toContain('no longer exists')
    expect(terminals()).toEqual([])
    const expected = fileURLToPath(new URL('./expected/sidebar-terminal/unavailable.expected.md', import.meta.url))
    await compareOrRefreshGolden(expected, await terminal.ariaSnapshot(), MODE)
    await terminal.getByRole('button', { name: 'New terminal', exact: true }).click()
    await expect.poll(() => terminals().length).toBe(1)
    expect(terminals()[0]!.id).not.toBe(previous)
    await terminal.getByRole('status').waitFor({ state: 'hidden' })
    await terminal.locator('.xterm-screen').waitFor({ state: 'visible' })
    // xterm's input proxy can remain zero-sized until its cursor moves.
    await terminal.getByRole('textbox', { name: 'Terminal', exact: true }).waitFor({ state: 'attached' })
  })

  it.skipIf(MODE === 'record')('omits blank reasoning rows around recorded text in an appended fixture turn', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-blank-reasoning'))
    const session = scaffold.ctx.sessions.get(brandString<SessionId>(SEED_ID))
    if (session === undefined) throw new Error('seeded session is unavailable')
    const events = session.snapshotEvents()
    const recorded = events.flatMap(event => event.type === 'assistant/message' ? event.data.message.content : [])
      .find(block => block.type === 'reasoning' && block.text.trim() !== '')
    if (recorded?.type !== 'reasoning') throw new Error('seeded history requires recorded reasoning text')
    const previousEnd = events.findLast(event => event.type === 'turn/end')
    if (previousEnd?.type !== 'turn/end') throw new Error('seeded history requires a closed turn')
    const turn = previousEnd.data.turn + 1
    const answer = 'BLANK_REASONING_FIXTURE_DONE'
    // The blank blocks are a test condition around authentic recorded text, not model output.
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Show recorded reasoning surrounded by blank blocks.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const message = session.append('assistant/message', {
      turn, step: 1, stream: [],
      message: createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
        content: [
          { type: 'reasoning', text: '' },
          { type: 'reasoning', text: recorded.text },
          { type: 'reasoning', text: ' \t\r\n' },
          { type: 'reasoning', text: '' },
          { type: 'text', text: answer },
        ],
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(session)
    await page.getByText(answer, { exact: true }).waitFor({ timeout: 10_000 })
    const selector = `[data-chat-turn="${turn}"][data-chat-group-part="reasoning"]`
    const rows = page.locator(selector).locator('[data-variant="think"]')
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBe(1)
    await expandOwningTurnProcess(page, rows.first())
    const toggle = rows.getByRole('button').first()
    expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    const body = rows.locator('[data-markdown-variant="compact"]')
    await body.waitFor({ state: 'visible' })
    expect(await body.innerText()).not.toBe('')
    expect(message.data.message.content[1]).toEqual({ type: 'reasoning', text: recorded.text })
    await compareOrRefreshGolden(join(REASONING_EXPECTED_DIR, 'blank-reasoning.expected.md'), [
      await captureStableAria(page, selector, scaffold.workspaceCwd),
      '',
      `- Reasoning rows: ${await rows.count()}`,
    ].join('\n'), MODE)
  })

  it.skipIf(MODE === 'record')('shows automatic compact progress and opens its recorded summary after completion', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-auto-compaction'))
    const session = scaffold.ctx.sessions.get(brandString<SessionId>(SEED_ID))
    if (session === undefined) throw new Error('seeded session is unavailable')
    const events = session.snapshotEvents()
    const recorded = events.find(event => event.type === 'compaction/summary')
    const previousEnd = events.findLast(event => event.type === 'turn/end')
    const previousCheckpoint = events.find(event => event.type === 'user/message'
      && event.data.source.kind === 'compact-checkpoint')
    if (recorded?.type !== 'compaction/summary' || previousEnd?.type !== 'turn/end' || previousCheckpoint === undefined) {
      throw new Error('seeded history requires a recorded compact summary and checkpoint')
    }
    const turn = previousEnd.data.turn + 1
    const compactionId = 'compact-seeded-automatic' as CheckpointSource['compactionId']
    session.append('turn/start', { turn })
    const started = session.append('compaction/start', { compactionId, turn })
    await scaffold.ctx.sessions.flush(session)
    const selector = `[data-chat-turn="${turn}"][data-chat-flow-kind="compaction"]`
    const row = page.locator(selector)
    await row.getByText('Compacting context…', { exact: true }).waitFor()
    expect(await row.locator('[data-shimmer="true"]').count()).toBe(1)
    expect(await row.getByRole('button').count()).toBe(0)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'automatic-compaction-running.expected.md'),
      await captureStableAria(page, selector, scaffold.workspaceCwd), MODE)
    const { sourceCommandId: _command, ...summary } = recorded.data
    const previousMessage = deriveEventMessage(previousCheckpoint)
    if (previousMessage === null) throw new Error('compact checkpoint requires model content')
    const committed = session.append('compaction/summary', {
      ...summary, compactionId,
      shadowedSeqs: [previousCheckpoint.seq],
      shadowedRange: { start: previousCheckpoint.seq, end: previousCheckpoint.seq },
      shadowedTokenCount: scaffold.ctx.tokenMeter.estimateMessage(previousMessage),
    })
    session.append('user/message', createUserMessage({
      content: summary.summary, source: { kind: 'compact-checkpoint', compactionId },
    }), {
      surfaceOp: { op: 'replace', startSeq: previousCheckpoint.seq, endSeq: previousCheckpoint.seq },
      sourceEventSeqs: [started.seq, committed.seq, previousCheckpoint.seq],
    })
    session.append('compaction/end', { compactionId, turn })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(session)
    const process = page.locator(`[data-turn-process="${turn}"]`)
    await process.waitFor()
    if (await process.getAttribute('aria-expanded') === 'false') await process.click()
    const activity = page.locator(`[data-chat-turn="${turn}"][data-chat-group-key] [data-process-activity]`)
    await activity.waitFor()
    if (await activity.getAttribute('aria-expanded') === 'false') await activity.click()
    const button = row.getByRole('button', { name: /Compacted/ })
    await button.waitFor()
    expect(await row.locator('[data-shimmer]').count()).toBe(0)
    expect(await row.getByText('Compacting context…', { exact: true }).count()).toBe(0)
    await button.click()
    await page.locator('[data-document-markdown]').getByRole('heading', { name: 'Cold resume compact summary' }).waitFor()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'automatic-compaction-completed.expected.md'),
      await captureStableAria(page, selector, scaffold.workspaceCwd), MODE)
  })

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', async () => {
    // No replay fixture was installed and the llm seam is open — any stray
    // stream would have failed the turn loudly. Cleanliness pins the wire.
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(REASONING_EXPECTED_DIR, ['blank-reasoning.expected.md'])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'command-row.expected.md', 'feedback-row.expected.md', 'file-preview.expected.md',
      'automatic-compaction-running.expected.md', 'automatic-compaction-completed.expected.md', 'checkpoint-sidebar.expected.md', 'session.v3.jsonl', 'thinking-expanded.expected.md',
      'ui.expected.md', 'ui-expanded.expected.md',
    ])
  })
})
