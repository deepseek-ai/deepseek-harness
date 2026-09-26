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
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed, Message, MessageSource } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage, SessionId } from '@deepseek-ai/dsh-session'
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
import { expandOwningTurnProcess, newEnglishPage, saveFailureShot } from './support.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'fixture': { kind: 'fixture' } & ContextFormed
  }
}

type CheckpointSource = Extract<MessageSource, { readonly kind: 'compact-checkpoint' }>
type CheckpointCommandId = NonNullable<CheckpointSource['sourceCommandId']>

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/seeded-history', import.meta.url))
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
// The pinned-header geometry golden: a pure-CSS, user-visible behavior that
// changes no DOM and no accessible name, so the aria goldens cannot capture it
// (docs/testing.md, "when a snapshot test is required", still requires a
// keyless snapshot). Following composer-draft-scroll's geometry golden, it
// records platform-independent semantic booleans about the pinned compaction
// header, no absolute pixels.
const STICKY_GEOMETRY_EXPECTED = join(SNAPSHOT_DIR, 'sticky-geometry.expected.md')
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
          // A fenced code block gives the summary body a sticky-bannered
          // descendant (CodeBlock pins its banner at z-index 6). The block is
          // long enough that its banner has room to hold below the pinned
          // header, which is where its Copy control must stay clickable; the
          // list makes the body overflow the shrunk viewport.
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

describe('web e2e: seeded history renders through cold resume', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let seededThroughSeq = -1
  let openingWindow: unknown

  beforeAll(async () => {
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
      await seedSession(scaffold, realizedWithCompaction, SEED_ID)
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
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
    expect(await page.locator('[data-chat-flow-kind="context"]').count()).toBe(0)
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

  it.skipIf(MODE === 'record')('omits ordinary instructions from Chat while retaining their logged content', async () => {
    const session = scaffold.ctx.sessions.get(SessionId(SEED_ID))
    if (session === undefined) throw new Error('seeded session is unavailable')
    const instructions = session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'agent-instructions')
    expect(instructions).toHaveLength(1)
    expect(instructions[0]?.data).toMatchObject({ source: { form: 'instructions', changes: [{ path: 'AGENTS.md' }] } })
    expect(JSON.stringify(instructions[0]?.data)).toContain('Instruction 24: preserve the logged context contract.')
    expect(await page.locator('[data-chat-flow-kind="context"], [data-context-injection-body]').count()).toBe(0)
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

  it.skipIf(MODE === 'record')('expands the cold-resumed compact summary and pins its header while scrolling', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-compaction'))
    const marker = page.getByRole('button', { name: /compact Compacted \d+ history items/ })
    await marker.waitFor({ timeout: 10_000 })
    expect(await marker.getAttribute('aria-expanded')).toBe('false')
    // Collapsed, the marker is not pinned: the sticky rule's `:has()` gate
    // needs the body sibling, which only exists while open. jsdom computes no
    // sticky layout, so this real-browser layer proves the CSS resolves.
    const collapsedPosition = await marker.evaluate(element => getComputedStyle(element).position)
    expect(collapsedPosition).not.toBe('sticky')
    const originalViewport = page.viewportSize() ?? { width: 1680, height: 1000 }
    // Captured so a failure in the cleanup below cannot replace the assertion
    // that actually failed.
    let bodyError: unknown
    try {
      await marker.click()
      await expect.poll(() => marker.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('true')
      await expect.poll(() => page.getByRole('heading', { name: 'Cold resume compact summary' }).count(), {
        timeout: 5_000,
      }).toBe(1)
      expect(await page.getByText('The exact summary remains available.', { exact: false }).count()).toBeGreaterThan(0)
      // Open, the toggle pins to the scroll container's top.
      const openStyle = await marker.evaluate((element) => {
        const style = getComputedStyle(element)
        return { position: style.position, top: style.top, zIndex: Number.parseInt(style.zIndex, 10) }
      })
      expect(openStyle.position).toBe('sticky')
      expect(openStyle.top).toBe('0px')
      // The summary body carries a fenced code block whose own banner pins at
      // z-index 6; the toggle must outrank it, or a code-block summary would
      // re-bury the toggle. Sample the banner inside THIS summary body, not a
      // code block elsewhere on the page.
      const bannerZ = await page.locator('[class*="compactionBody"] [class*="bannerWrap"]').first().evaluate(
        element => Number.parseInt(getComputedStyle(element).zIndex, 10),
      )
      expect(openStyle.zIndex).toBeGreaterThan(bannerZ)
      // Hovering the open toggle must keep an OPAQUE fill: the default hover
      // token is translucent and would let the scrolling prose bleed through
      // the moment the pointer lands to collapse it. The alpha token, if
      // present, is the fourth comma value (`rgba(r, g, b, a)`) or the value
      // after `/` in the space form; three channels mean opaque. A color that
      // parses to neither returns -1, which fails loud instead of passing as
      // opaque.
      await marker.hover()
      const hoverAlpha = await marker.evaluate((element) => {
        const bg = getComputedStyle(element).backgroundColor
        const inner = /^rgba?\((.+)\)$/.exec(bg.trim())?.[1]
        if (inner === undefined) return -1
        const slashAlpha = inner.split('/')[1]
        if (slashAlpha !== undefined) return Number.parseFloat(slashAlpha)
        const channels = inner.split(/[\s,]+/).filter(token => token.length > 0)
        const commaAlpha = channels[3]
        if (commaAlpha !== undefined) return Number.parseFloat(commaAlpha)
        if (channels.length === 3) return 1
        return -1
      })
      expect(hoverAlpha).toBe(1)
      // Scroll so the summary's code banner reaches its own stuck position.
      // The banner's sticky offset holds it below the pinned header's band, so
      // the point this case samples is the banner's Copy control: the header
      // must not cover it. Shrinking the viewport first forces overflow
      // regardless of summary length.
      await page.setViewportSize({ width: originalViewport.width, height: 360 })
      const geom = await marker.evaluate((button) => {
        const container = button.closest('[data-conversation-scroll]') as HTMLElement
        const banner = container.querySelector('[class*="compactionBody"] [class*="bannerWrap"]') as HTMLElement
        const copy = banner.querySelector('button') as HTMLElement
        // Both the toggle and the code banner are sticky, so a rect taken while
        // either is stuck reports the stuck position rather than its content
        // offset. Measure both unstuck, so the target below does not depend on
        // where the scrollport happened to be when this case started.
        const markerInline = button.style.position
        const bannerInline = banner.style.position
        const bannerTopInline = banner.style.top
        button.style.position = 'static'
        banner.style.position = 'static'
        banner.style.top = 'auto'
        const containerTop = container.getBoundingClientRect().top
        const markerStaticTop = button.getBoundingClientRect().top - containerTop + container.scrollTop
        const bannerStaticTop = banner.getBoundingClientRect().top - containerTop + container.scrollTop
        const headerHeight = button.getBoundingClientRect().height
        button.style.position = markerInline
        banner.style.position = bannerInline
        banner.style.top = bannerTopInline
        // The banner sticks once its static top passes the band the toggle
        // occupies. Land the static top 8px above the scrollport top: if the
        // banner still pinned at top 0, 8px of it would sit under the toggle,
        // so this position distinguishes the offset from the uncovered case.
        // The banner must hold at the band's bottom edge, and its Copy control
        // must stay the topmost element at its own center.
        container.scrollTop = Math.max(0, bannerStaticTop + 8)
        const markerRect = button.getBoundingClientRect()
        const bannerRect = banner.getBoundingClientRect()
        const copyRect = copy.getBoundingClientRect()
        const currentContainerTop = container.getBoundingClientRect().top
        const markerProbe = document.elementFromPoint(
          markerRect.left + markerRect.width / 2,
          markerRect.top + markerRect.height / 2,
        )
        const copyProbe = document.elementFromPoint(
          copyRect.left + copyRect.width / 2,
          copyRect.top + copyRect.height / 2,
        )
        return {
          scrollTop: container.scrollTop,
          // The header's own content offset now lies above the scrollport top,
          // so its rect top can equal the scrollport top only through stickiness
          // — this is the precondition that makes the pinning assertion mean
          // something.
          staticAboveViewport: container.scrollTop > markerStaticTop,
          markerTop: markerRect.top,
          containerTop: currentContainerTop,
          bannerTop: bannerRect.top,
          bannerStuck: Math.abs(bannerRect.top - (currentContainerTop + headerHeight)) <= 1,
          bannerBelowHeader: bannerRect.top >= markerRect.bottom - 1,
          markerOwnsCenter: button.contains(markerProbe),
          copyOwnsCenter: copy.contains(copyProbe),
        }
      })
      expect(geom.scrollTop).toBeGreaterThan(0)
      expect(geom.staticAboveViewport).toBe(true)
      expect(Math.abs(geom.markerTop - geom.containerTop)).toBeLessThanOrEqual(1)
      expect(geom.bannerStuck).toBe(true)
      expect(geom.bannerBelowHeader).toBe(true)
      expect(geom.markerOwnsCenter).toBe(true)
      expect(geom.copyOwnsCenter).toBe(true)
      // Keyless geometry golden for this user-visible, DOM-invariant CSS
      // behavior: platform-independent semantic facts, no absolute pixels.
      // Every line is a value asserted just above, so a regression reddens the
      // expect first; compareOrRefreshGolden writes the file in refresh mode
      // and byte-compares it in replay.
      const stickyGolden = [
        '# Compaction marker sticky header (pinned over a code-block summary)',
        '',
        '## Collapsed',
        '',
        `- header is not sticky: ${String(collapsedPosition !== 'sticky')}`,
        '',
        '## Open, pinned at the scroll container top',
        '',
        `- header position is sticky: ${String(openStyle.position === 'sticky')}`,
        `- header pins to the top edge: ${String(openStyle.top === '0px')}`,
        `- header outranks the summary code-block banner: ${String(openStyle.zIndex > bannerZ)}`,
        `- hover fill stays fully opaque: ${String(hoverAlpha === 1)}`,
        '',
        '## Scrolled so the summary code banner reaches its sticky offset',
        '',
        `- container is scrolled off its top: ${String(geom.scrollTop > 0)}`,
        `- header's static position sits above the scrollport: ${String(geom.staticAboveViewport)}`,
        `- header holds at the scrollport top: ${String(Math.abs(geom.markerTop - geom.containerTop) <= 1)}`,
        `- header owns the center point (toggle stays clickable): ${String(geom.markerOwnsCenter)}`,
        `- summary code banner holds below the header band: ${String(geom.bannerStuck)}`,
        `- summary code banner stays clear of the header: ${String(geom.bannerBelowHeader)}`,
        `- banner Copy control owns its own center: ${String(geom.copyOwnsCenter)}`,
      ].join('\n').trimEnd()
      await compareOrRefreshGolden(STICKY_GEOMETRY_EXPECTED, stickyGolden, MODE)
    } catch (error) {
      bodyError = error
    }
    // Restore the shared page state whether or not the body failed. Order
    // matters: collapse the marker, restore the viewport, then re-enter
    // follow-bottom. The control is what clears the off-floor ownership a
    // programmatic `scrollTop` assignment leaves in ChatView's reader-movement
    // ledger, so click it when it is there. It appears only after that ledger
    // settles (`scrollend` or the sampling interval), and it never renders at
    // all when the collapse's shrink clamp already re-entered follow, so the
    // assertion is the restored state — no control, and the scrollport on its
    // floor — rather than the control's presence.
    try {
      if (await marker.getAttribute('aria-expanded') === 'true') await marker.click()
      await expect.poll(() => marker.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('false')
      await page.setViewportSize(originalViewport)
      const scrollport = page.locator('[data-conversation-scroll]')
      const backToBottom = page.getByRole('button', { name: 'Back to bottom', exact: true })
      await expect.poll(async () => {
        if (await backToBottom.count() > 0) await backToBottom.click()
        const atFloor = await scrollport.evaluate((host: HTMLElement) =>
          Math.abs(host.scrollHeight - host.clientHeight - host.scrollTop) <= 1)
        return await backToBottom.count() === 0 && atFloor
      }, { timeout: 15_000 }).toBe(true)
    } catch (cleanupError) {
      // The body's own assertion is the diagnosis; a cleanup failure would
      // replace it, and the state it failed to restore shows up in the next
      // case's golden.
      if (bodyError === undefined) throw cleanupError
    }
    if (bodyError !== undefined) throw bodyError
  })

  it.skipIf(MODE === 'record')('an Access-chip switch persists its command without adding a Chat row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-command-row'))
    await page.getByRole('button', { name: 'Access mode, current: Workspace Write' }).click()
    await page.getByRole('menuitem', { name: 'Read Only' }).click()
    const access = page.getByRole('button', { name: 'Access mode, current: Read Only' })
    await expect.poll(() => access.isEnabled(), { timeout: 10_000 }).toBe(true)
    const row = page.locator('[data-variant="others"]').filter({ hasText: 'preset read-only' })
    expect(await row.count()).toBe(0)
    const agent = scaffold.ctx.agents.get(SessionId(SEED_ID))
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

  it.skipIf(MODE === 'record')('keeps short injected context out of Chat without dropping the event', async () => {
    const agent = scaffold.ctx.agents.get(SessionId(SEED_ID))
    if (agent === undefined) throw new Error('seeded session did not attach an agent')
    const injected = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Short injected context.' }],
      source: { kind: 'fixture' },
    }), { surfaceOp: 'append' })

    await scaffold.ctx.sessions.flush(agent.session)
    expect(agent.session.snapshotEvents()).toContainEqual(injected)
    await waitForContextInClient(page, injected.seq)
    expect(await page.locator('[data-chat-flow-kind="context"]').count()).toBe(0)
    expect(await page.getByText('Short injected context.', { exact: true }).count()).toBe(0)
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

  it.skipIf(MODE === 'record' || process.platform === 'win32')('offers explicit terminal replacement after restoring the recorded Session', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-terminal-unavailable'))
    await page.locator('[data-dockkit-add-tab]').click()
    await page.locator('[data-sidebar-right-guide-entry="terminal"]').getByRole('button', { name: /^New terminal/u }).click()
    const sessionId = SessionId(SEED_ID)
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
    await terminal.getByRole('textbox', { name: 'Terminal', exact: true }).waitFor()
  })

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', async () => {
    // No replay fixture was installed and the llm seam is open — any stray
    // stream would have failed the turn loudly. Cleanliness pins the wire.
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'command-row.expected.md', 'feedback-row.expected.md', 'file-preview.expected.md',
      'session.v3.jsonl', 'sticky-geometry.expected.md', 'thinking-expanded.expected.md',
      'ui.expected.md', 'ui-expanded.expected.md',
    ])
  })
})
