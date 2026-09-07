// Web e2e scenario (browserless): the subagents interrupt Remote against the real
// composition. A live continuable child holds its model turn open through a
// replay hang entry; plain HTTP queues a follow-up, interrupts the turn, and
// proves from the real session state that the turn aborted, the follow-up
// parked without auto-starting a new turn, and a later waking send resumed the
// preserved FIFO order. No browser: the RPC surface is the product surface
// under test, and subagent-interrupt-ui.e2e.ts owns the composer interaction.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId as sessionId, type SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import { launchWebScaffold, readPersistedEvents, webSnapshotMode, type WebScaffold } from './scaffold.ts'

const MODE = webSnapshotMode()
const INITIAL = 'Explain event sourcing in one sentence.'
const FOLLOWUP = 'Now give the same explanation to a human reader.'
const WAKING = 'And add one concrete example.'

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** POST one generated Remote unary through the API Gateway carrier. */
async function remote<T>(
  scaffold: WebScaffold,
  endpoint: string,
  args: Readonly<Record<string, unknown>>,
): Promise<RpcResult<T>> {
  const response = await scaffold.hostFetch(`/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `interrupt-e2e-${endpoint}-${randomUUID()}`,
      method: endpoint,
      payload: { args },
    }),
  })
  if (!response.ok) throw new Error(`${endpoint} failed over HTTP ${response.status}: ${await response.text()}`)
  return (await response.json() as { result: RpcResult<T> }).result
}

/** POST one generated Session Remote unary through the API Gateway carrier. */
function sessionRemote<T>(scaffold: WebScaffold, method: string, request: unknown): Promise<RpcResult<T>> {
  return remote<T>(scaffold, `session/${method}`, { request })
}

/** Poll a synchronous condition (hook-safe; expect.poll is test-body only). */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
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

describe.skipIf(MODE === 'record')('web e2e: subagents/interruptByParent over the real composition', () => {
  let scaffold: WebScaffold
  let sidecarRoot: string
  let readyFile: string
  let parentId: SessionId
  let childId: SessionId

  beforeAll(async () => {
    sidecarRoot = await mkdtemp(join(tmpdir(), 'dsh-web-subagent-interrupt-'))
    readyFile = join(sidecarRoot, 'hang-ready')
    // Whole-script replacement: the child's three model calls are the hang
    // (turn 1, interrupted), the parked follow-up's turn, and the waking turn.
    // The parent never runs a turn, so the child claims this primary script.
    await writeFile(join(sidecarRoot, 'replay.override.json'), JSON.stringify([
      { kind: 'hang', readyFile },
      textCompletion('resumed response one'),
      textCompletion('resumed response two'),
    ]))
    // Header-only primary fixture: the bare-array override replaces the
    // derived script entirely; the path only anchors replay installation.
    await writeFile(
      join(sidecarRoot, 'session.jsonl'),
      '{"type":"session","version":0,"id":"primary","createdAt":0}\n',
    )
    scaffold = await launchWebScaffold({
      replayFixture: join(sidecarRoot, 'session.jsonl'),
      replayOverride: join(sidecarRoot, 'replay.override.json'),
    })

    // A live parent Agent through the real API; no workspace or browser.
    const created = await sessionRemote<{ sessionId: string }>(scaffold, 'create', {
      cwd: scaffold.workspaceCwd,
    })
    if (!created.ok) throw new Error(`session.create failed: ${created.error.code}`)
    parentId = sessionId(created.value.sessionId)
    const parent = scaffold.ctx.agents.get(parentId)
    if (parent === undefined) throw new Error('created parent session did not publish a live Agent')

    const started = await scaffold.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'event-sourcing researcher',
      signal: new AbortController().signal,
      request: { prompt: [{ type: 'text', text: INITIAL }], parent },
    })
    childId = started.childId
    // The hang entry writes readyFile after its prefix chunks, immediately
    // before waiting for cancellation: the deterministic "turn is open" gate.
    await waitFor(() => existsSync(readyFile), 'the held child turn to open')
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    await rm(sidecarRoot, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'subagent interrupt teardown failed')
  })

  it('parks a queued follow-up on interrupt and resumes it FIFO on a waking send', async () => {
    // Queue the follow-up while the turn is still open, then interrupt.
    const queued = await remote<{ messageId: string }>(scaffold, 'subagents/prompt', {
      request: {
        requestId: randomUUID(),
        parentSessionId: parentId,
        childSessionId: childId,
        mode: 'continuable',
        delivery: 'queue',
        content: [{ type: 'text', text: FOLLOWUP }],
      },
    })
    expect(queued).toMatchObject({ ok: true })

    const settled = scaffold.whenTurnSettled()
    const interrupted = await remote<{ accepted: true }>(scaffold, 'subagents/interruptByParent', {
      childSessionId: childId,
      parentSessionId: parentId,
      mode: 'continuable',
    })
    expect(interrupted).toMatchObject({ ok: true, value: { accepted: true } })
    // accepted acknowledges the admitted cancel, not quiescence: wait for the
    // aborted turn/end (the composition's first turn/end) before asserting.
    expect(await settled).toBe(childId)

    // Parked, not resumed: the Activation stays resident with an idle driver,
    // the follow-up is retained, and no second turn opened.
    const child = scaffold.ctx.agents.get(childId)
    expect(child).toBeDefined()
    expect(child!.status).toBe('idle')
    expect(child!.inbox.nextTurn).toHaveLength(1)
    expect(child!.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    const lastEnd = child!.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)
    expect((lastEnd)?.data.reason.kind).toBe('aborted')

    // Only an explicit waking send resumes the parked queue, FIFO, then the
    // child runs both turns to completion and settles.
    const waking = await remote<{ messageId: string }>(scaffold, 'subagents/prompt', {
      request: {
        requestId: randomUUID(),
        parentSessionId: parentId,
        childSessionId: childId,
        mode: 'continuable',
        delivery: 'queue',
        content: [{ type: 'text', text: WAKING }],
      },
    })
    expect(waking).toMatchObject({ ok: true })
    await expect.poll(() => scaffold.ctx.agents.get(childId), { timeout: 60_000 }).toBeUndefined()

    // The settled child's loop appended every turn's closing events durably,
    // so the physical log carries the complete record asserted here.
    const events = await readPersistedEvents(scaffold, childId)
    // Human-origin messages only: the real composition also injects
    // runtime-context snapshots as non-user-source messages.
    const userTexts = events.flatMap(event => event.type === 'user/message'
      && event.data.source.kind === 'user'
      ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : [])
    expect(userTexts[0]).toBe(INITIAL)
    expect(userTexts[1]).toMatch(/^Your parent agent id is .+send_message\(\{ agent_id: /)
    expect(userTexts.slice(2)).toEqual([FOLLOWUP, WAKING])
    const turnEndKinds = events
      .filter(event => event.type === 'turn/end')
      .map(event => (event).data.reason.kind)
    expect(turnEndKinds).toEqual(['aborted', 'completed', 'completed'])
  }, 120_000)
})
