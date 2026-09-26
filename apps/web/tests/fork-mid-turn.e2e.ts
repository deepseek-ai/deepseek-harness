// Web e2e: fork a completed recording at its first tool/call over HTTP,
// verify both synthetic result texts, and continue the child through the composer.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, parseSeedFixture, seedSession,
  watchConsole, webSnapshotMode, selectedSessionFixture, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/fork-mid-turn', import.meta.url))
// Borrowed read-only from its recorded-session owner.
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()
const SEED_ID = 'fork-mid-turn-web-e2e'
const PROMPT = 'FORK_BRANCH_USER Summarize what this branch knows about the reads.'
const FIRST_MARKER = 'FORK_BRANCH_FIRST'
const DONE_MARKER = 'FORK_BRANCH_DONE'

// The exact model-visible branch wordings (`openTurnClosers`, forked cause).
const OUTCOME_UNKNOWN_TEXT = 'The history inherited by this branch records this tool call starting but does not include its result. The parent session may have completed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.'
const NOT_STARTED_TEXT = 'The history inherited by this branch has no record of this tool call starting. The parent session may have executed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.'

/** The child's one continuation stream, fully scripted (no recording). */
function continuationScript(): ReplayEntry[] {
  const deltas = [
    `${FIRST_MARKER} this branch has no read results, `,
    `so I would check what the parent completed before retrying. ${DONE_MARKER}.`,
  ]
  const response = deltas.join('')
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...deltas.map(text => ({ type: 'text-delta' as const, index: 0, text })),
    { type: 'block-end', index: 0, block: { type: 'text', text: response } },
    { type: 'usage', usage: { inputTokens: 512, outputTokens: 32 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  return [{ kind: 'chunks', chunks }]
}

function toolResultText(event: SessionEvent<'tool/result'>): string {
  return event.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

describe('web e2e: exact-boundary fork seeds branch closers and continues', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let replayDir: string
  let tripwire: ReturnType<typeof watchConsole>
  let childId: SessionId
  let forkAt: number

  beforeAll(async () => {
    replayDir = await mkdtemp(join(tmpdir(), 'dsh-fork-mid-turn-replay-'))
    const replayOverride = join(replayDir, 'replay.override.json')
    await writeFile(replayOverride, JSON.stringify(continuationScript()))
    scaffold = await launchWebScaffold({
      replayFixture: join(replayDir, 'override-only.jsonl'),
      replayOverride,
      // Use paced chunks for the child continuation's live-stream assertions.
      paceMs: 5,
    })
    const fixture = await readFile(await selectedSessionFixture(SEED), 'utf8')
    const firstCall = parseSeedFixture(fixture).events.find(event => event.type === 'tool/call')
    if (firstCall === undefined) throw new Error('fork-mid-turn seed lacks a tool/call')
    forkAt = firstCall.seq
    await seedSession(scaffold, fixture, SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (replayDir !== undefined) {
      await rm(replayDir, { recursive: true, force: true })
        .catch((error: unknown) => failures.push(error))
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'fork-mid-turn e2e cleanup failed')
  })

  it.skipIf(MODE === 'record')('forks the cold source at its first tool/call and seeds forked closers', async () => {
    const response = await scaffold.hostFetch('/api/session/fork', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'fork-mid-turn-exact', method: 'session/fork',
        payload: { args: { request: { sessionId: SEED_ID, atSeq: forkAt } } },
      }),
    })
    expect(response.ok).toBe(true)
    const body = await response.json() as { result: { ok: boolean; value?: { sessionId: string } } }
    expect(body.result.ok).toBe(true)
    childId = SessionId(body.result.value!.sessionId)

    const child = scaffold.ctx.sessions.get(childId)
    if (child === undefined) throw new Error('fork did not publish a live child session')
    expect(child.header.parentSession).toBe(SessionId(SEED_ID))
    // inheritedEventCount counts only the copied parent prefix; the closers are child work.
    expect(child.inheritedEventCount).toBe(forkAt + 1)
    expect(child.snapshotEvents()[forkAt]?.type).toBe('tool/call')

    const closers = child.snapshotEvents().slice(forkAt + 1, forkAt + 6)
    expect(closers.map(event => event.type)).toEqual([
      'session/end-seed', 'tool/result', 'tool/result', 'step/end', 'turn/end',
    ])
    const [, dispatched, notStarted, , turnEnd] = closers
    expect(dispatched?.type === 'tool/result' && dispatched.data.error?.code).toBe('TOOL_OUTCOME_UNKNOWN')
    expect(dispatched?.type === 'tool/result' && toolResultText(dispatched)).toBe(OUTCOME_UNKNOWN_TEXT)
    expect(notStarted?.type === 'tool/result' && notStarted.data.error?.code).toBe('TOOL_NOT_STARTED')
    expect(notStarted?.type === 'tool/result' && toolResultText(notStarted)).toBe(NOT_STARTED_TEXT)
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'forked' })
  }, 60_000)

  it.skipIf(MODE === 'record')('continues the child through the composer as a resume of the branched log', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-fork-mid-turn'))
    // The session-added frame published the child row; the list sorts by
    // recency, so the just-forked child is the first session row after the
    // group header (the seeded source stays last). The settled-turn assertion
    // below proves the prompt really ran on the child.
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    await expect.poll(() => page.locator('[role="treeitem"]').count(), { timeout: 15_000 }).toBe(3)
    await page.locator('[role="treeitem"]').nth(1).click()
    // The child renders the inherited prefix up to the cut.
    await expect.poll(() => page.getByText('Use the read tool twice', { exact: false }).count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1)

    const composer = page.locator('[data-composer-input]').last()
    await composer.waitFor({ timeout: 15_000 })
    await writeComposerDraft(page, composer, PROMPT)
    const settled = scaffold.whenTurnSettled(60_000)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByText(FIRST_MARKER, { exact: false }).last().waitFor({ timeout: 15_000 })
    expect(await settled).toBe(childId)
    await page.getByText(`${DONE_MARKER}.`, { exact: false }).last().waitFor({ timeout: 15_000 })
    await expect.poll(() => page.locator('[data-streaming="true"]').count(), { timeout: 15_000 }).toBe(0)

    // The branch continuation is a resume over the seeded log: the synthetic
    // closer ended turn 1, so the live turn is 2, and its first request logs
    // a resume header rather than a fresh conversation header.
    const child = scaffold.ctx.sessions.get(childId)
    if (child === undefined) throw new Error('child session disappeared after its turn')
    const live = child.snapshotEvents().filter(event => event.seq >= child.firstLiveSeq)
    expect(live.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([2])
    expect(live.filter(event => event.type === 'request/header').map(event => event.data.reason)).toEqual(['resume'])
    const reply = child.deriveMessages().at(-1)
    expect(reply?.role).toBe('assistant')
    expect(JSON.stringify(reply?.content)).toContain(DONE_MARKER)
  }, 60_000)

  it.skipIf(MODE === 'record')('matches the child conversation-flow aria golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-fork-mid-turn-aria'))
    await page.getByText(`${DONE_MARKER}.`, { exact: false }).last().waitFor({ timeout: 10_000 })
    const flow = page.locator('[data-chat-flow]')
    const branchAction = flow.locator('[data-turn-tail="2"]').getByRole('button', {
      name: 'Branch into a new conversation', exact: true,
    })
    await branchAction.waitFor({ timeout: 10_000 })
    expect(await branchAction.isEnabled()).toBe(true)
    const snapshot = (await captureStableAria(page, '[data-chat-flow]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  })

  it.skipIf(MODE === 'record')('kept the console clean and the fixture inventory closed', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
