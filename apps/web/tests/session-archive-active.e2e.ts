// Web e2e: archiving a Session whose turn is still running. The Host refuses
// the plain archive, the sidebar turns that refusal into the stop-and-archive
// confirmation, and confirming stops the turn the way the stop button does —
// the aborted Bash call settles with a tool/result and the turn ends as
// cancelled — before the row hides. Unarchiving restores a Session that
// continues the conversation. Keyless: the model is a replay override whose
// first stream calls Bash with a long-running command, and the second answers
// the continuation prompt after the restore.
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold, readPersistedEvents,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/session-archive-active', import.meta.url))
const DIALOG_EXPECTED = join(SNAPSHOT_DIR, 'dialog.expected.md')
const MODE = webSnapshotMode()
const PROMPT = 'ARCHIVE_ACTIVE run the long command'
const CONTINUE_PROMPT = 'ARCHIVE_ACTIVE continue after the restore'
const CONTINUED = 'ARCHIVE_ACTIVE_CONTINUED'
// Long enough for the archive to land mid-call under CI load; the stop must
// end the call well before it would finish on its own.
const WAIT_MS = 60_000
const HEARTBEAT_MS = 200
/** The child the Bash call runs: announce, heartbeat, and only finish long after the archive. */
const WAIT_COMMAND = `node -e "const fs=require('node:fs'); fs.writeFileSync('started.txt', 'started'); setInterval(() => { fs.appendFileSync('heartbeat.txt', '.') }, ${HEARTBEAT_MS}); setTimeout(() => { fs.writeFileSync('finished.txt', 'finished') }, ${WAIT_MS})"`

/**
 * First stream: one Bash call whose child announces itself, then beats on a
 * file until it finishes; second stream: the continuation answer. The
 * heartbeat file is the liveness evidence: a pid is not comparable across the
 * Linux sandbox's PID namespace, a growing file is.
 */
function script(): ReplayEntry[] {
  const args = JSON.stringify({ command: WAIT_COMMAND, description: 'Wait a long time' })
  const callId = ToolCallId('call_wait')
  const first: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name: 'bash', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'bash', arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const second: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: CONTINUED },
    { type: 'block-end', index: 0, block: { type: 'text', text: CONTINUED } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  return [{ kind: 'chunks', chunks: first }, { kind: 'chunks', chunks: second }]
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function heartbeats(cwd: string): Promise<number> {
  try {
    return (await stat(join(cwd, 'heartbeat.txt'))).size
  } catch {
    return 0
  }
}

/** Whether the Bash child is still beating: its file grows across one settle window. */
async function childAlive(cwd: string): Promise<boolean> {
  const before = await heartbeats(cwd)
  await new Promise((resolve) => { setTimeout(resolve, HEARTBEAT_MS * 6) })
  return (await heartbeats(cwd)) > before
}

describe.skipIf(MODE === 'record')('web e2e: archiving a running Session stops it first', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let replayDir: string
  let tripwire: ReturnType<typeof watchConsole>
  let sessionId: SessionId

  /**
   * Reveal and click a row action, re-hovering if a projection update replaces
   * the row before its hover-only button becomes visible.
   * @param row - the row owning the action.
   * @param name - accessible name of the action button.
   */
  async function clickHoverAction(row: Locator, name: string): Promise<void> {
    const button = row.getByRole('button', { name })
    await expect.poll(async () => {
      await row.hover()
      return await button.isVisible()
    }, { timeout: 10_000 }).toBe(true)
    await button.click()
  }

  /** The one Session row of the fresh workspace group (the group row carries no actions). */
  function sessionRow(): Locator {
    return page.locator('[role="treeitem"]').filter({ has: page.locator('button[aria-label^="Session actions for "]') })
  }

  beforeAll(async () => {
    replayDir = await mkdtemp(join(tmpdir(), 'dsh-session-archive-active-'))
    const replayOverride = join(replayDir, 'replay.override.json')
    await writeFile(replayOverride, JSON.stringify(script()))
    scaffold = await launchWebScaffold({
      replayFixture: join(replayDir, 'override-only.jsonl'),
      replayOverride,
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (replayDir !== undefined) {
      await rm(replayDir, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'session-archive-active e2e cleanup failed')
  })

  it('refuses the plain archive of a running Session and asks to stop it instead', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-archive-active-ask'))
    const cwd = join(scaffold.workspaceCwd, 'workspace')
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    sessionId = await page.evaluate(() => {
      const selected = JSON.parse(localStorage.getItem('dsh.sessions.current')!) as { sessionId: string }
      return selected.sessionId
    }) as SessionId
    await writeComposerDraft(page, input, PROMPT)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(() => exists(join(cwd, 'started.txt')), { timeout: 20_000 }).toBe(true)
    expect(await childAlive(cwd)).toBe(true)
    expect(scaffold.ctx.agents.get(sessionId)?.status).toBe('running')

    await clickHoverAction(sessionRow(), 'Session actions for ')
    await page.getByRole('menuitem', { name: 'Archive session' }).click()
    const dialog = page.getByRole('dialog', { name: 'Stop and archive this session?' })
    await dialog.waitFor({ timeout: 10_000 })
    // A foreground Bash command is a registered job from its start, so the
    // Host reports it beside the turn; stopping the turn kills it.
    await expect.poll(() => dialog.getByRole('list', { name: 'Work that will be stopped' }).locator('li').allTextContents())
      .toEqual(['The turn in progress', `1 background job: ${WAIT_COMMAND}`])
    // Asking is not archiving: the Host set is untouched, the turn and its
    // Bash child keep running, and the row stays in the sidebar.
    expect([...scaffold.ctx.workspaceRegistry.archivedSessionIds]).toEqual([])
    expect(scaffold.ctx.agents.get(sessionId)?.status).toBe('running')
    expect(await childAlive(cwd)).toBe(true)
    await expect.poll(() => sessionRow().count()).toBe(1)
    // The Bash command is a running job while the dialog is open, by design.
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd, { runningJobs: 'keep' })
    await compareOrRefreshGolden(DIALOG_EXPECTED, snapshot, MODE)

    // Cancel keeps everything as it was.
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0)
    expect(scaffold.ctx.agents.get(sessionId)?.status).toBe('running')
  }, 60_000)

  it('confirming stops the turn like the stop button, then hides the row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-archive-active-confirm'))
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('the running Session lost its Agent')
    const settled = scaffold.whenTurnSettled(30_000)
    await clickHoverAction(sessionRow(), 'Session actions for ')
    await page.getByRole('menuitem', { name: 'Archive session' }).click()
    const dialog = page.getByRole('dialog', { name: 'Stop and archive this session?' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Stop and archive', exact: true }).click()

    await expect.poll(() => [...scaffold.ctx.workspaceRegistry.archivedSessionIds].map(String), { timeout: 10_000 })
      .toEqual([String(sessionId)])
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0)
    await expect.poll(() => sessionRow().count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(() => page.getByText('Session stopped and archived.', { exact: false }).count(), { timeout: 10_000 })
      .toBe(1)

    // The stop is the user's cancel: the Bash child dies, the turn settles as
    // cancelled, and the log closes every open call before the turn ends.
    expect(await settled).toBe(sessionId)
    const cwd = join(scaffold.workspaceCwd, 'workspace')
    await expect.poll(() => childAlive(cwd), { timeout: 10_000, interval: 50 }).toBe(false)
    expect(agent.status).toBe('idle')
    const live = agent.session.snapshotEvents().filter(event => event.seq >= agent.session.firstLiveSeq)
    const calls = live.filter((event): event is SessionEvent<'tool/call'> => event.type === 'tool/call')
    const results = live.filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
    expect(calls.map(event => event.data.callId)).toEqual(['call_wait'])
    expect(results.map(event => event.data.message.toolCallId)).toEqual(['call_wait'])
    expect(results[0]?.data.error?.code).toBe('ABORTED')
    const turnEnd = live.at(-1)
    expect(turnEnd?.type).toBe('turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
    expect(await exists(join(scaffold.workspaceCwd, 'workspace', 'finished.txt'))).toBe(false)
  }, 60_000)

  it('the restored Session continues the conversation from a regular log', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-archive-active-restore'))
    await page.getByRole('button', { name: 'View options' }).click()
    await page.getByRole('menuitem', { name: 'All conversations (show archived)', exact: true }).click()
    await expect.poll(() => sessionRow().count(), { timeout: 10_000 }).toBe(1)
    await clickHoverAction(sessionRow(), 'Session actions for ')
    await page.getByRole('menuitem', { name: 'Unarchive session' }).click()
    await expect.poll(() => [...scaffold.ctx.workspaceRegistry.archivedSessionIds], { timeout: 10_000 }).toEqual([])
    await sessionRow().click()
    await expect.poll(() => sessionRow().getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true')

    const composer = page.locator('[data-composer-input]').last()
    await writeComposerDraft(page, composer, CONTINUE_PROMPT)
    const settled = scaffold.whenTurnSettled(30_000)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByText(CONTINUED, { exact: false }).last().waitFor({ timeout: 15_000 })
    expect(await settled).toBe(sessionId)

    // The persisted log is what a later cold resume would read: two turns,
    // each closed, with the cancelled call settled inside the first.
    const events = await readPersistedEvents(scaffold, sessionId)
    const turns = events.filter(event => event.type === 'turn/start').map(event => event.data.turn)
    expect(turns).toEqual([1, 2])
    const ends = events.filter((event): event is SessionEvent<'turn/end'> => event.type === 'turn/end')
    expect(ends.map(event => event.data.reason.kind)).toEqual(['aborted', 'completed'])
    const calls = events.filter(event => event.type === 'tool/call').length
    const results = events.filter(event => event.type === 'tool/result').length
    expect(results).toBe(calls)
  }, 60_000)

  it('kept the console clean and the fixture inventory closed', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['dialog.expected.md'])
  })
})
