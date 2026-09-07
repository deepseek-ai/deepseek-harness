/** Production JSONL restart evidence through the real Agent resume lifecycle. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as toolSchedule from '../src/index.ts'
import {
  ScheduleId,
  createAfterScheduleRecord,
  foldScheduleEvents,
} from '../src/domain.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Reminder acknowledged.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    for (const chunk of response) yield chunk
  }
}

async function mountPersistence(root: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return ctx
}

async function mountRuntime(root: string, adapter: RecordingAdapter): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(toolSchedule)
  return ctx
}

async function disposeContext(ctx: Context): Promise<void> {
  const index = contexts.indexOf(ctx)
  if (index >= 0) contexts.splice(index, 1)
  await ctx.fiber.dispose()
}

function waitForDispatch(ctx: Context, sessionId: SessionId): Promise<void> {
  return new Promise((resolve) => {
    const stop = ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId
        || event.type !== 'schedule/change'
        || event.data.operation !== 'dispatch') return
      stop()
      resolve()
    })
  })
}

async function settleCurrentTasks(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

/** Read one stored session's header and full event log through a read handle. */
async function readStored(ctx: Context, id: SessionId) {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    return {
      header: handle.header,
      inheritedEventCount: handle.inheritedEventCount,
      events: (await handle.read()).events,
    }
  } finally {
    await handle.close()
  }
}

describe('Schedule production JSONL restart', () => {
  it('resumes one overdue reminder exactly once across fresh runtime mounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-jsonl-'))
    roots.push(root)
    const sessionId = SessionId('schedule-jsonl-restart')
    const first = await mountPersistence(root)

    const pending = first.sessions.create(sessionId, { meta: { cwd: '/tmp' } })
    const pendingRecord = createAfterScheduleRecord(
      ScheduleId('schedule-1'), 'restart reminder', 1, Date.now() - 60_000,
    )
    pending.append('schedule/change', { version: 1, operation: 'create', schedule: pendingRecord })
    const seed = await first.sessionPersistence.create(pending.header)
    await seed.append(pending.snapshotEvents())
    await seed.close()
    await disposeContext(first)

    const dispatchingAdapter = new RecordingAdapter()
    const restarted = await mountRuntime(root, dispatchingAdapter)
    const dispatched = waitForDispatch(restarted, sessionId)
    const handle = await restarted.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await dispatched
    await handle.agent.whenIdle()
    await expect(restarted.sessions.flush(handle.agent.session)).resolves.toBe(true)
    const dispatchedStored = await readStored(restarted, sessionId)
    expect(foldScheduleEvents(dispatchedStored.events, dispatchedStored.inheritedEventCount).active)
      .toEqual([])
    const dispatches = dispatchedStored.events.filter(event =>
      event.type === 'schedule/change' && event.data.operation === 'dispatch')
    expect(dispatches).toHaveLength(1)
    expect(dispatchingAdapter.requests).toHaveLength(1)
    await handle.dispose()
    await disposeContext(restarted)

    const replayAdapter = new RecordingAdapter()
    const replayed = await mountRuntime(root, replayAdapter)
    const replayHandle = await replayed.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await replayed.sessions.flush(replayHandle.agent.session)
    await replayHandle.agent.whenIdle()
    await settleCurrentTasks()
    await replayed.sessions.flush(replayHandle.agent.session)

    expect(replayAdapter.requests).toEqual([])
    expect(replayHandle.agent.session.snapshotEvents().filter(event =>
      event.type === 'schedule/change' && event.data.operation === 'dispatch')).toHaveLength(1)
    const replayedStored = await readStored(replayed, sessionId)
    expect(replayedStored.events.filter(event =>
      event.type === 'schedule/change' && event.data.operation === 'dispatch')).toHaveLength(1)
    await replayHandle.dispose()
    await disposeContext(replayed)
  })
})
