// Web e2e scenario: the composer's independent Stop interrupts a running
// continuable child. The child holds its model turn open through a replay
// hang entry; the browser proves Send and Stop coexist, the parent-offline
// disabled-Send-with-Stop composer, the subagents/interruptByParent
// (never session.cancel) transport, the parked follow-up, and the FIFO resume
// on a waking send.
//
// Replay-binding note: only the PRIMARY script can hang, and scripts bind by
// first-call order, so the child issues the composition's first model call
// (claiming the overridden primary) and the parent's one UI prompt — needed
// so the non-blank parent renders its header catalog — binds to a derived
// child fixture afterwards.
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const BASE_FIXTURE = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.jsonl', import.meta.url))

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/subagent-interrupt', import.meta.url))
const OFFLINE_COMPOSER_EXPECTED = join(SNAPSHOT_DIR, 'offline-composer.expected.md')
const MODE = webSnapshotMode()
const LABEL = 'event-sourcing researcher'
const INITIAL = 'Explain event sourcing in one sentence.'
const REARM = 'Keep working until I stop you again.'
const REARM_WAKE = 'Start that queued work now.'
const FOLLOWUP = 'Now give the same explanation to a human reader.'
const WAKING = 'And add one concrete example.'
const REARMED_ANSWER = 're-armed setup answer'
const PARKED_ANSWER = 'parked follow-up answer'
const WAKING_ANSWER = 'waking answer'

/** Poll a synchronous condition (hook-safe; expect.poll is test-body only). */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

/** Resolve on one exact child's next aborted turn end. */
function waitForAbortedTurn(scaffold: WebScaffold, childId: SessionId): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error('interrupt did not reach an aborted turn/end'))
    }, 30_000)
    const off = scaffold.ctx.on('session/event', (session: { id: SessionId }, event: SessionEvent) => {
      if (session.id !== childId || event.type !== 'turn/end') return
      clearTimeout(timer)
      off()
      if (event.data.reason.kind === 'aborted') resolve()
      else reject(new Error(`expected an aborted turn/end, got ${event.data.reason.kind}`))
    })
  })
}

/** One text-only scripted model completion (no tool calls: real tools are mounted). */
function textCompletion(text: string): object {
  return {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'usage', usage: { inputTokens: 20, outputTokens: 8 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  }
}

describe.skipIf(MODE === 'record')('web e2e: composer interrupt for a running continuable child', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let sidecarRoot: string
  let rearmedReadyFile: string
  let parent: Agent
  let childId: SessionId
  let tripwire: ReturnType<typeof watchConsole>
  const apiCalls: string[] = []

  beforeAll(async () => {
    sidecarRoot = await mkdtemp(join(tmpdir(), 'dsh-web-subagent-interrupt-ui-'))
    const readyFile = join(sidecarRoot, 'hang-ready')
    rearmedReadyFile = join(sidecarRoot, 'hang-rearmed-ready')
    // The child claims this whole-script replacement: the offline and online
    // interrupt paths each hold one turn, then the parked and waking turns settle.
    await writeFile(join(sidecarRoot, 'replay.override.json'), JSON.stringify([
      { kind: 'hang', readyFile },
      { kind: 'hang', readyFile: rearmedReadyFile },
      textCompletion(REARMED_ANSWER),
      textCompletion(PARKED_ANSWER),
      textCompletion(WAKING_ANSWER),
    ]))
    await writeFile(
      join(sidecarRoot, 'session.jsonl'),
      '{"type":"session","version":0,"id":"primary","createdAt":0}\n',
    )
    // The parent's one prompted turn replays this recorded single text-only
    // call (binding is positional, not lineage-aware).
    const parentTurnPath = join(sidecarRoot, 'parent-turn.jsonl')
    const base = await readFile(BASE_FIXTURE, 'utf8')
    const [header, ...events] = base.trimEnd().split('\n')
    if (header === undefined) throw new Error('base replay fixture has no header')
    await writeFile(parentTurnPath, [
      header
        .replace('"id":"{{sessionId}}"', '"id":"recorded-parent-turn"')
        .replace(/"createdAt":\d+/, '"createdAt":1784998084442'),
      ...events,
      '',
    ].join('\n'))
    scaffold = await launchWebScaffold({
      replayFixture: join(sidecarRoot, 'session.jsonl'),
      replayOverride: join(sidecarRoot, 'replay.override.json'),
      replayChildFixtures: [parentTurnPath],
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (path.startsWith('/api/')) apiCalls.push(path)
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)

    const root = scaffold.ctx.agents.roots()[0]
    if (root === undefined) throw new Error('fresh workspace did not publish its parent Agent')
    parent = root
    // The child's first model call claims the primary override and holds.
    const started = await scaffold.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: LABEL,
      signal: new AbortController().signal,
      request: { prompt: [{ type: 'text', text: INITIAL }], parent },
    })
    childId = started.childId
    await waitFor(() => existsSync(readyFile), 'the held child turn to open')

    // One prompted parent turn makes the parent non-blank so the session
    // header (and its subagent catalog action) renders.
    const parentSettled = scaffold.whenTurnSettled()
    const parentInput = page.locator('[data-composer-input][contenteditable="true"]').first()
    await parentInput.fill('Ask a research subagent to explain event sourcing.')
    await parentInput.press('Enter')
    expect(await parentSettled).toBe(parent.id)

    // Reload onto the restart baseline (the proven route to a freshly
    // discovered catalog), with the child still live and running host-side.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: /1 subagent/ }).waitFor({ timeout: 15_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(scaffold.ctx.agents.get(childId)?.status).toBe('running')
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (sidecarRoot !== undefined) {
      await rm(sidecarRoot, { recursive: true, force: true })
        .catch((error: unknown) => failures.push(error))
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'subagent interrupt UI teardown failed')
  })

  it('interrupts the live child through the parent-offline composer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-interrupt-offline'))
    // Simulate a parent that went offline: the catalog delivers
    // parentAvailable: false while the child Activation stays live (the
    // interrupt RPC itself needs no live parent — covered host-side by
    // subagent-interrupt.e2e.ts).
    const pattern = '**/api/subagents/list'
    await page.route(pattern, async (route) => {
      const response = await route.fetch()
      const body = await response.json() as {
        result: { ok: true; value: { parentAvailable: boolean } } | { ok: false }
      }
      if (body.result.ok) body.result.value.parentAvailable = false
      await route.fulfill({ response, json: body })
    })
    try {
      await page.getByRole('button', { name: /1 subagent/ }).click()
      await page.getByRole('treeitem', { name: new RegExp(LABEL) }).click()
      const input = page.getByRole('textbox', {
        name: 'Parent session offline; sending is unavailable but you can still stop the run',
      })
      await input.waitFor({ timeout: 15_000 })
      await page.getByText(/^Explain event sourcing in one sentence\.Your parent agent id is /)
        .waitFor({ timeout: 15_000 })
      expect(await input.isDisabled()).toBe(true)
      const stop = page.getByRole('button', { name: 'Stop generating' })
      expect(await stop.count()).toBe(1)
      expect(await stop.isEnabled()).toBe(true)
      const send = page.getByRole('button', { name: 'Send message' })
      expect(await send.count()).toBe(1)
      expect(await send.isDisabled()).toBe(true)
      await compareOrRefreshGolden(
        OFFLINE_COMPOSER_EXPECTED,
        await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd),
        MODE,
      )

      // Keep the continuable Activation resident after this first abort. The
      // direct setup queue does not change the parent-offline UI contract: its
      // input and Send remain disabled throughout the exercised browser path.
      await scaffold.ctx.subagents.prompt({
        requestId: 'interrupt-ui-rearm' as SubagentPromptRequestId,
        parentSessionId: parent.id,
        childSessionId: childId,
        mode: 'continuable',
        content: [{ type: 'text', text: REARM }],
      }, new AbortController().signal)
      const aborted = waitForAbortedTurn(scaffold, childId)
      const interruptResponse = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/subagents/interruptByParent')
      await stop.click()
      expect(((await (await interruptResponse).json()) as {
        result: { ok: boolean; value?: { accepted: boolean } }
      }).result).toMatchObject({ ok: true, value: { accepted: true } })
      expect(apiCalls.filter(path => path === '/api/session/cancel')).toEqual([])
      await aborted
      await expect.poll(() => scaffold.ctx.agents.get(childId)?.status, { timeout: 15_000 }).toBe('idle')

      // Wake the parked setup message only after cancellation converges. A
      // second hang keeps the parent-available case independent from this stop.
      await scaffold.ctx.subagents.prompt({
        requestId: 'interrupt-ui-rearm-wake' as SubagentPromptRequestId,
        parentSessionId: parent.id,
        childSessionId: childId,
        mode: 'continuable',
        content: [{ type: 'text', text: REARM_WAKE }],
      }, new AbortController().signal)
      await waitFor(() => existsSync(rearmedReadyFile), 'the re-armed child turn to open')
      expect(scaffold.ctx.agents.get(childId)?.status).toBe('running')
    } finally {
      await page.unrouteAll({ behavior: 'wait' })
    }
  }, 60_000)

  it('interrupts through subagents/interruptByParent, parks the follow-up, and resumes it FIFO', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-interrupt-flow'))
    // Reselect the child with the truthful catalog: parent available again.
    await page.getByRole('navigation', { name: 'Session hierarchy' })
      .getByRole('button').first().click()
    await page.getByRole('button', { name: /1 subagent/ }).click()
    await page.getByRole('treeitem', { name: new RegExp(LABEL) }).click()
    const input = page.getByRole('textbox', { name: 'Message or run a task... / commands, @ files or sessions' })
    await input.waitFor({ timeout: 15_000 })
    expect(await input.isDisabled()).toBe(false)

    // Queue a follow-up through Send while independent Stop remains available.
    const promptResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/subagents/prompt')
    await input.fill(FOLLOWUP)
    await page.getByRole('button', { name: 'Send message' }).click()
    expect(((await (await promptResponse).json()) as { result: { ok: boolean } }).result)
      .toMatchObject({ ok: true })

    const aborted = waitForAbortedTurn(scaffold, childId)
    const stop = page.getByRole('button', { name: 'Stop generating' })
    expect(await stop.count()).toBe(1)
    const interruptResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/subagents/interruptByParent')
    await stop.click()
    expect(((await (await interruptResponse).json()) as {
      result: { ok: boolean; value?: { accepted: boolean } }
    }).result).toMatchObject({ ok: true, value: { accepted: true } })
    // The addressed child stops through its own RPC, never the generic one.
    expect(apiCalls.filter(path => path === '/api/session/cancel')).toEqual([])
    await aborted

    // Parked: the Activation stays resident and idle with the retained
    // follow-up; the primary returns to Send without a new turn starting.
    await expect.poll(() => scaffold.ctx.agents.get(childId)?.status, { timeout: 15_000 }).toBe('idle')
    const child = scaffold.ctx.agents.get(childId)
    expect(child).toBeDefined()
    expect(child!.inbox.nextTurn).toHaveLength(2)
    expect(child!.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
    await page.getByRole('button', { name: 'Send message' }).waitFor({ timeout: 15_000 })

    // Only the waking send resumes the parked queue, FIFO, to settlement.
    await input.fill(WAKING)
    await input.press('Enter')
    await expect.poll(() => page.getByText(REARMED_ANSWER, { exact: true }).count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(() => page.getByText(PARKED_ANSWER, { exact: true }).count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(() => page.getByText(WAKING_ANSWER, { exact: true }).count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(() => scaffold.ctx.agents.get(childId), { timeout: 60_000 }).toBeUndefined()

    const loaded = await scaffold.ctx.sessionPersistence.load(childId)
    const userTexts = loaded.events.flatMap(event => event.type === 'user/message'
      && event.data.source.kind === 'user'
      ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : [])
    expect(userTexts[0]).toBe(INITIAL)
    expect(userTexts[1]).toMatch(/^Your parent agent id is .+send_message\(\{ agent_id: /)
    expect(userTexts.slice(2)).toEqual([REARM, REARM_WAKE, FOLLOWUP, WAKING])
    const turnEndKinds = loaded.events
      .filter(event => event.type === 'turn/end')
      .map(event => event.data.reason.kind)
    expect(turnEndKinds).toEqual(['aborted', 'aborted', 'completed', 'completed', 'completed'])
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['offline-composer.expected.md'])
  })
})
