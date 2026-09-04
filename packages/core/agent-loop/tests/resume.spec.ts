import { ToolCallId, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { appendFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionLogOffset, SessionSeq, Session, SessionId, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'

import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

async function persistentHarness(adapter: MockAdapter): Promise<{ ctx: Context; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-resume-'))
  dirs.push(root)
  return { ctx: await mountPersistentHarness(root, adapter), root }
}

async function mountPersistentHarness(root: string, adapter: MockAdapter, compression?: 'none'): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  // The backend mounts BEFORE the loop so root teardown unwinds the loop
  // first: live agents drain their writers into still-open handles.
  await ctx.plugin(JsonlSessionPersistence, { root, ...compression === undefined ? {} : { compression } })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/** Remove every `session.lock` under the root: the POSIX forfeit-by-unlink escape hatch, without importing backend internals. */
async function removeSessionLocks(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await removeSessionLocks(path)
    else if (entry.name === 'session.lock') await rm(path, { force: true })
  }
}

/** Seed one stored session through the persistence seam (header minted by the store). */
async function seedStoredSession(ctx: Context, sessionId: SessionId, events: readonly SessionEvent[]): Promise<void> {
  const detached = ctx.sessions.prepare(sessionId)
  const handle = await ctx.sessionPersistence.create(detached.header)
  await handle.append(events)
  await handle.close()
}

/** Read one stored session's physical validated log through a read handle. */
async function readStoredEvents(ctx: Context, sessionId: SessionId): Promise<readonly SessionEvent[]> {
  const handle = await ctx.sessionPersistence.open(sessionId, 'read')
  try {
    return await handle.read()
  } finally {
    await handle.close()
  }
}

async function persistSession(sessionId: SessionId): Promise<string> {
  const { ctx, root } = await persistentHarness(new MockAdapter([]))
  // Persistence deliberately has no artifact for a truly empty session. A
  // balanced completed turn is the smallest resumable log and avoids running
  // the model merely to construct this lifecycle fixture.
  const seed: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  await seedStoredSession(ctx, sessionId, seed)
  await ctx.fiber.dispose()
  return root
}

/** A handle stand-in for abandoned-open races; only `close()` is ever reachable. */
function abandonedHandleStub(): { handle: SessionHandle; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => {})
  return { handle: { close } as unknown as SessionHandle, close }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** Fail a lifecycle regression promptly instead of waiting for Vitest's suite timeout. */
async function promptly<T>(job: Promise<T>): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => { timeout.reject(new Error('lifecycle task did not settle promptly')) }, 1000)
  try {
    return await Promise.race([job, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

/** Throw an arbitrary callback value to exercise the public unknown-error boundary. */
function throwUnknown(value: unknown): never {
  throw value
}

describe('the session-persistence Agent Note: AgentLoop factory create/resume', () => {
  it('normalizes a non-Error resume publication failure for rollback and releases the write handle', async () => {
    const sessionId = SessionId('unknown-resume-failure-s')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const failure = { source: 'resume' }
    ctx.on('session/created', () => throwUnknown(failure))

    await expect(ctx.agents.resume({
      resumeSessionId: sessionId,
    })).rejects.toBe(failure)

    expect(ctx.agents.get(SessionId('unknown-resume-failure'))).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    // Rollback closed the write handle: write ownership is claimable again.
    const reopened = await ctx.sessionPersistence.open(sessionId, 'write')
    await reopened.close()
    await ctx.fiber.dispose()
  })

  it('createAgent uses the caller-supplied sessionId (not ${id}-session)', async () => {
    const adapter = new MockAdapter([textResponse('hi')])
    const { ctx } = await persistentHarness(adapter)
    const { agent } = await ctx.agents.create({ sessionId: SessionId('custom-session'), meta: { cwd: '/w' } })
    expect(agent.session.id).toBe('custom-session')
    expect(agent.session.header.cwd).toBe('/w')
    await ctx.fiber.dispose()
  })

  it('createAgent rejects a duplicate identity without orphaning a session', async () => {
    const adapter = new MockAdapter([textResponse('hi')])
    const { ctx } = await persistentHarness(adapter)
    const sessionId = SessionId('sess-a')
    await ctx.agents.create({ sessionId })
    await expect(ctx.agents.create({ sessionId })).rejects.toThrow(/already exists/)
    expect(ctx.sessions.list()).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('a created agent stores its seed and live turn durably through its handle', async () => {
    const seed: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const { ctx } = await persistentHarness(new MockAdapter([textResponse('stored')]))
    const sessionId = SessionId('durable-create')
    const handle = await ctx.agents.create({
      sessionId,
      seed,
      meta: { cwd: '/w' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, handle.agent)
    await handle.dispose()

    const stored = await readStoredEvents(ctx, sessionId)
    const seqs = stored.map(event => event.seq)
    expect(seqs).toEqual(seqs.map((_, index) => index))
    // The constructor seed (turn 1 + its end-seed marker) precedes the live turn 2.
    expect(stored.slice(0, 2).map(event => event.type)).toEqual(['turn/start', 'turn/end'])
    expect(stored[2]?.type).toBe('session/end-seed')
    const turnStarts = stored.filter(event => event.type === 'turn/start')
    expect(turnStarts.map(event => event.type === 'turn/start' && event.data.turn)).toEqual([1, 2])
    expect(stored.some(event => event.type === 'turn/end' && event.data.turn === 2)).toBe(true)
    expect(JSON.stringify(stored)).toContain('stored')
    await ctx.fiber.dispose()
  })

  it('a rejecting final writer close releases the registries, then rejects disposal', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([textResponse('hi')]))
    const sessionId = SessionId('drain-close-fails')
    const handle = await ctx.agents.create({ sessionId })
    const persisted = await ctx.sessionPersistence.open(sessionId, 'read')
    await persisted.close()
    const stored = [...(ctx.sessionPersistence as unknown as {
      tracker: { openHandles: Set<SessionHandle> }
    }).tracker.openHandles].find(open => open.id === sessionId && open.access === 'write')
    if (stored === undefined) throw new Error('missing owned write handle')
    // The real close still runs (releasing write ownership); the injected
    // failure models a drain that reports a durability error at close.
    const realClose = stored.close.bind(stored)
    vi.spyOn(stored, 'close').mockImplementation(async () => {
      await realClose()
      throw new Error('close exploded')
    })

    await expect(handle.dispose()).rejects.toThrow('close exploded')
    // Teardown reached quiescence before the rejection: the agent and session
    // are unregistered, and write ownership is released — the never-flushed
    // session reports absence, not an ownership conflict.
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    await expect(ctx.sessionPersistence.open(sessionId, 'write')).rejects.toThrow('not found')
    await ctx.fiber.dispose()
  })

  it('combines a machine-teardown failure with a close failure into one rejection', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([textResponse('hi')]))
    const sessionId = SessionId('drain-both-fail')
    const handle = await ctx.agents.create({ sessionId })
    const stored = [...(ctx.sessionPersistence as unknown as {
      tracker: { openHandles: Set<SessionHandle> }
    }).tracker.openHandles].find(open => open.id === sessionId && open.access === 'write')
    if (stored === undefined) throw new Error('missing owned write handle')
    const machine = handle.agent as Agent & { scope: { dispose: () => Promise<void> } }
    vi.spyOn(machine.scope, 'dispose').mockRejectedValue(new Error('scope exploded'))
    vi.spyOn(stored, 'close').mockRejectedValue(new Error('close exploded'))

    const failure = await handle.dispose().then(() => undefined, (error: unknown) => error)
    if (!(failure instanceof AggregateError)) throw new Error('expected an AggregateError rejection')
    expect(failure.message).toContain(`agent "${sessionId}" disposal failed`)
    expect(failure.errors.map(error => (error as Error).message)).toEqual(['scope exploded', 'close exploded'])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('agent dispose releases write ownership of its stored session', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([textResponse('hi')]))
    const sessionId = SessionId('ownership-release')
    const handle = await ctx.agents.create({ sessionId })

    await expect(ctx.sessionPersistence.open(sessionId, 'write'))
      .rejects.toThrow(/already owned by an active write handle/)

    // Materialize the log so the session outlives its creator handle.
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, handle.agent)
    await handle.dispose()
    const reopened = await ctx.sessionPersistence.open(sessionId, 'write')
    expect(reopened.access).toBe('write')
    await reopened.close()
    await ctx.fiber.dispose()
  })

  it('a stored-session create failure rolls the fresh identity back', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([]))
    const sessionId = SessionId('create-backend-fail')
    vi.spyOn(ctx.sessionPersistence, 'create').mockRejectedValueOnce(new Error('backend create failed'))

    await expect(ctx.agents.create({ sessionId })).rejects.toThrow('backend create failed')
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()

    // The identity was fully released: the same id creates cleanly afterwards.
    const retry = await ctx.agents.create({ sessionId })
    await retry.dispose()
    await ctx.fiber.dispose()
  })

  it('a seed append failure closes the fresh write handle and rethrows', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([]))
    const sessionId = SessionId('seed-append-fail')
    const seed: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const originalCreate = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
    let closeSpy: MockInstance<() => Promise<void>> | undefined
    ctx.sessionPersistence.create = async (header, options) => {
      const handle = await originalCreate(header, options)
      vi.spyOn(handle, 'append').mockRejectedValue(new Error('seed append failed'))
      closeSpy = vi.spyOn(handle, 'close')
      return handle
    }

    await expect(ctx.agents.create({ sessionId, seed })).rejects.toThrow('seed append failed')
    expect(closeSpy).toHaveBeenCalled()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    // The closed never-materialized creation left no stored session behind.
    await expect(ctx.sessionPersistence.open(sessionId, 'write'))
      .rejects.toThrow(/not found/)
    await ctx.fiber.dispose()
  })


  it('a setup failure before publication leaves no stored residue; the id creates again', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([]))
    const sessionId = SessionId('setup-fail-no-residue')
    const seed: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    await expect(ctx.agents.create({
      sessionId,
      seed,
      setup: () => { throw new Error('setup refused') },
    })).rejects.toThrow('setup refused')

    // The seed is stored only at the publication commit point, so the failed
    // attempt materialized nothing and released the identity completely.
    await expect(ctx.sessionPersistence.stat(sessionId)).resolves.toBeUndefined()
    const retry = await ctx.agents.create({ sessionId, seed })
    await expect(ctx.sessionPersistence.stat(sessionId)).resolves.toBeDefined()
    await retry.dispose()
    await ctx.fiber.dispose()
  })

  it('rollback swallows a rejecting handle close after a prepare failure (create and createAgent)', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([]))
    const originalCreate = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
    const closeSpies: Array<{ mockRestore: () => void }> = []
    ctx.sessionPersistence.create = async (header, options) => {
      const handle = await originalCreate(header, options)
      closeSpies.push(vi.spyOn(handle, 'close').mockRejectedValue(new Error('close failed')))
      return handle
    }

    // Config create path: prepare's option validation throws after the handle exists.
    await expect(ctx.agentLoop.create(SessionId('close-reject-config'), { maxTokens: -1 }))
      .rejects.toThrow('agent maxTokens must be a positive safe integer')
    expect(ctx.agents.get(SessionId('close-reject-config'))).toBeUndefined()

    // Owned createAgent path: the same validation failure after the handle exists.
    await expect(ctx.agents.create({
      sessionId: SessionId('close-reject-owned'),
      agentOptions: { maxTokens: -1 },
    })).rejects.toThrow('agent maxTokens must be a positive safe integer')
    expect(ctx.agents.get(SessionId('close-reject-owned'))).toBeUndefined()

    for (const spy of closeSpies.splice(0)) spy.mockRestore()
    await ctx.fiber.dispose()
  })

  it('a reentrant abort during preparation swallows a rejecting handle close', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([]))
    const sessionId = SessionId('prepare-abort-close-reject')
    const originalCreate = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
    const spies: Array<{ mockRestore: () => void }> = []
    let closed: Promise<void> | undefined
    ctx.sessionPersistence.create = async (header, options) => {
      const handle = await originalCreate(header, options)
      const realClose = handle.close.bind(handle)
      spies.push(vi.spyOn(handle, 'close').mockImplementation(async () => {
        closed = realClose()
        await closed
        throw new Error('close failed')
      }))
      return handle
    }
    const reason = new Error('cancelled while preparing')
    const controller = new AbortController()
    let aborted = false
    ctx.on('internal/plugin', (fiber) => {
      if (aborted || fiber.name !== 'scope') return
      aborted = true
      controller.abort(reason)
    })

    await expect(ctx.agents.create({ sessionId, signal: controller.signal })).rejects.toBe(reason)
    // The rejecting close stays swallowed by the rollback; wait for the
    // rollback's real close so factory teardown finds a quiescent lifecycle.
    await vi.waitFor(() => { if (closed === undefined) throw new Error('close not reached') })
    await closed
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    for (const spy of spies.splice(0)) spy.mockRestore()
    await ctx.fiber.dispose()
  })

  it('config create rollback swallows a rejecting close after a publish failure', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([]))
    const sessionId = SessionId('config-publish-close-reject')
    const originalCreate = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
    const spies: Array<{ mockRestore: () => void }> = []
    let closed: Promise<void> | undefined
    ctx.sessionPersistence.create = async (header, options) => {
      const handle = await originalCreate(header, options)
      const realClose = handle.close.bind(handle)
      spies.push(vi.spyOn(handle, 'close').mockImplementation(async () => {
        closed = realClose()
        await closed
        throw new Error('close failed')
      }))
      return handle
    }
    const announce = vi.spyOn(ctx.agents, 'announce').mockImplementation(() => {
      throw new Error('announce failed')
    })

    await expect(ctx.agentLoop.create(sessionId)).rejects.toThrow('announce failed')
    announce.mockRestore()
    await vi.waitFor(() => { if (closed === undefined) throw new Error('close not reached') })
    await closed
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    for (const spy of spies.splice(0)) spy.mockRestore()
    await ctx.fiber.dispose()
  })

  it('a seed append failure swallows a rejecting handle close', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([]))
    const sessionId = SessionId('seed-append-close-reject')
    const seed: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const originalCreate = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
    const spies: Array<{ mockRestore: () => void }> = []
    ctx.sessionPersistence.create = async (header, options) => {
      const handle = await originalCreate(header, options)
      spies.push(vi.spyOn(handle, 'append').mockRejectedValue(new Error('seed append failed')))
      spies.push(vi.spyOn(handle, 'close').mockRejectedValue(new Error('close failed')))
      return handle
    }

    await expect(ctx.agents.create({ sessionId, seed })).rejects.toThrow('seed append failed')
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()

    for (const spy of spies.splice(0)) spy.mockRestore()
    await ctx.fiber.dispose()
  })

  it('a resume read failure swallows a rejecting handle close during rollback', async () => {
    const sessionId = SessionId('resume-read-close-reject')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([]))
    const originalOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    const spies: Array<{ mockRestore: () => void }> = []
    ctx.sessionPersistence.open = async (id, access, options) => {
      const handle = await originalOpen(id, access, options)
      spies.push(vi.spyOn(handle, 'read').mockRejectedValue(new Error('stored read failed')))
      spies.push(vi.spyOn(handle, 'close').mockRejectedValue(new Error('close failed')))
      return handle
    }

    await expect(ctx.agents.resume({ resumeSessionId: sessionId }))
      .rejects.toThrow('stored read failed')
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()

    for (const spy of spies.splice(0)) spy.mockRestore()
    await ctx.fiber.dispose()
  })

  it('resume cannot crash-repair a turn owned by a live agent', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([textResponse('unused')]))
    const sessionId = SessionId('live-resume-race')
    const first = (await ctx.agents.create({ sessionId })).agent
    first.session.append('turn/start', { turn: 1 })
    await ctx.sessions.flush(first.session)

    await expect(ctx.agents.resume({ resumeSessionId: sessionId }))
      .rejects.toThrow(/already owned by an active write handle/)

    first.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(first.session)
    const stored = await readStoredEvents(ctx, sessionId)
    expect(stored.map(event => event.type)).toEqual(['turn/start', 'turn/end'])
    expect(stored.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
    await ctx.fiber.dispose()
  })

  it('resume appends interrupted-turn closers durably through the handle', async () => {
    // Lifecycle 1: store an interrupted log — an open turn with no turn/end.
    const sessionId = SessionId('interrupted-resume')
    const { ctx: ctx1, root } = await persistentHarness(new MockAdapter([]))
    await seedStoredSession(ctx1, sessionId, [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    ])
    // A read returns the PHYSICAL validated log: no synthetic closers.
    const raw = await readStoredEvents(ctx1, sessionId)
    expect(raw.map(event => event.type)).toEqual(['turn/start'])
    await ctx1.fiber.dispose()

    // Lifecycle 2: resume repairs the tail and stores the repair durably.
    const ctx2 = await mountPersistentHarness(root, new MockAdapter([]))
    const handle = await ctx2.agents.resume({ resumeSessionId: sessionId })
    expect(handle.agent.session.snapshotEvents().map(event => event.type))
      .toEqual(['turn/start', 'turn/end', 'session/end-seed'])
    await handle.dispose()

    const stored = await readStoredEvents(ctx2, sessionId)
    expect(stored.map(event => event.type)).toEqual(['turn/start', 'turn/end', 'session/end-seed'])
    expect(stored[1]).toMatchObject({ data: { reason: { kind: 'interrupted' } } })
    await ctx2.fiber.dispose()
  })

  it('resume closes an interrupted tool call durably: tool/result, step/end, turn/end', async () => {
    const sessionId = SessionId('interrupted-tool-resume')
    const { ctx: ctx1, root } = await persistentHarness(new MockAdapter([]))
    await seedStoredSession(ctx1, sessionId, [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: SessionSeq(1), time: 1, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: SessionSeq(2), time: 2, surfaceOp: 'append', data: {
        turn: 1, step: 1,
        stream: [],
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'bash', arguments: '{}' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        }),
      } },
      { type: 'tool/call', seq: SessionSeq(3), time: 2, data: { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'bash', arguments: '{}' } },
    ] as SessionEvent[])
    await ctx1.fiber.dispose()

    const ctx2 = await mountPersistentHarness(root, new MockAdapter([]))
    const handle = await ctx2.agents.resume({ resumeSessionId: sessionId })
    await handle.dispose()

    // The multi-closer set lands durably in one contiguous batch, and the
    // synthetic tool/result cites the recorded tool/call seq.
    const stored = await readStoredEvents(ctx2, sessionId)
    expect(stored.map(event => event.type)).toEqual([
      'turn/start', 'step/start', 'assistant/message', 'tool/call',
      'tool/result', 'step/end', 'turn/end', 'session/end-seed',
    ])
    expect(stored.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(stored[4]).toMatchObject({
      sourceEventSeqs: [3],
      data: { error: { code: TOOL_OUTCOME_UNKNOWN } },
    })
    expect(stored[6]).toMatchObject({ data: { reason: { kind: 'interrupted' } } })
    await ctx2.fiber.dispose()
  })

  it('resume over a torn physical tail continues from the committed prefix', async () => {
    const sessionId = SessionId('torn-tail-resume')
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-torn-'))
    dirs.push(root)
    const ctx1 = await mountPersistentHarness(root, new MockAdapter([]), 'none')
    await seedStoredSession(ctx1, sessionId, [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    ])
    await ctx1.fiber.dispose()

    // Crash artifact: a half-written record with no trailing newline.
    const logs = (await readdir(root, { recursive: true })).filter(name => name.endsWith('.jsonl'))
    expect(logs).toHaveLength(1)
    await appendFile(join(root, logs[0] as string), '{"type":"assistant/chunk","seq":1,"ti')

    // Resume truncates the torn tail under its write open, then appends the
    // closers immediately after the committed prefix — no gap, no fragment.
    const ctx2 = await mountPersistentHarness(root, new MockAdapter([]), 'none')
    const handle = await ctx2.agents.resume({ resumeSessionId: sessionId })
    expect(handle.agent.session.snapshotEvents().map(event => event.type))
      .toEqual(['turn/start', 'turn/end', 'session/end-seed'])
    await handle.dispose()

    const stored = await readStoredEvents(ctx2, sessionId)
    expect(stored.map(event => `${event.type}@${event.seq}`))
      .toEqual(['turn/start@0', 'turn/end@1', 'session/end-seed@2'])
    await ctx2.fiber.dispose()
  })

  it('createAgent works without meta (no cwd)', async () => {
    const adapter = new MockAdapter([textResponse('hi')])
    const { ctx } = await persistentHarness(adapter)
    const { agent } = await ctx.agents.create({ sessionId: SessionId('nometa-session') })
    expect(agent.session.id).toBe('nometa-session')
    expect(agent.session.header.cwd).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('resume of a session with no cwd carries an undefined cwd header', async () => {
    // Lifecycle 1: create a no-cwd session and run a turn.
    const adapter1 = new MockAdapter([textResponse('a')])
    const { ctx: ctx1, root } = await persistentHarness(adapter1)
    const h1 = await ctx1.agents.create({ sessionId: SessionId('nocwd-sess') })
    h1.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }))
    await waitForIdle(ctx1, h1.agent)
    // Agent disposal drains the writer through the still-open handle.
    await h1.dispose()
    await ctx1.fiber.dispose()

    // Lifecycle 2: resume it; the header cwd stays undefined (no-cwd branch).
    const ctx2 = await mountPersistentHarness(root, new MockAdapter([textResponse('b')]))
    const a2 = (await ctx2.agents.resume({ resumeSessionId: SessionId('nocwd-sess') })).agent
    expect(a2.session.header.cwd).toBeUndefined()
    await ctx2.fiber.dispose()
  })

  it('agent/session-start fires "startup" for createAgent and "resume" for resume()', async () => {
    // Lifecycle 1: a fresh createAgent emits session-start with source 'startup'.
    const adapter1 = new MockAdapter([textResponse('a')])
    const { ctx: ctx1, root } = await persistentHarness(adapter1)
    const sources1: string[] = []
    ctx1.on('agent/session-start', ({ source }) => void sources1.push(source))
    const h1 = await ctx1.agents.create({ sessionId: SessionId('start-sess') })
    expect(sources1).toEqual(['startup'])
    h1.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }))
    await waitForIdle(ctx1, h1.agent)
    await h1.dispose()
    await ctx1.fiber.dispose()

    // Lifecycle 2: resuming the persisted session emits session-start 'resume'.
    const ctx2 = await mountPersistentHarness(root, new MockAdapter([textResponse('b')]))
    const sources2: string[] = []
    ctx2.on('agent/session-start', ({ source }) => void sources2.push(source))
    await ctx2.agents.resume({ resumeSessionId: SessionId('start-sess') })
    expect(sources2).toEqual(['resume'])
    await ctx2.fiber.dispose()
  })

  it('resume awaits setup while unpublished, then publishes a fully composed world in order', async () => {
    const sessionId = SessionId('resume-setup-success')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const gate = Promise.withResolvers<undefined>()
    const setupStarted = Promise.withResolvers<undefined>()
    const order: string[] = []

    ctx.on('session/created', (session) => {
      expect(ctx.sessions.get(session.id)).toBe(session)
      expect(ctx.agents.get(sessionId)?.session).toBe(session)
      order.push('session/created')
    })
    ctx.on('agent/created', ({ agent }) => {
      expect(agent.status).toBe('idle')
      order.push('agent/created')
    })
    ctx.on('agent/session-start', ({ agent }) => {
      expect(() => { agent.cancel({ kind: 'user' }) }).not.toThrow()
      order.push('agent/session-start')
    })

    const resuming = ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: async (agentCtx) => {
        expect(agentCtx.agent?.id).toBe(sessionId)
        // The two persisted events plus the end-seed marker.
        expect(agentCtx.agent?.session.snapshotEvents()).toHaveLength(3)
        agentCtx.on('session/created', () => void order.push('setup-listener:session/created'))
        agentCtx.on('agent/created', () => void order.push('setup-listener:agent/created'))
        order.push('setup:start')
        setupStarted.resolve(undefined)
        await gate.promise
        order.push('setup:end')
        return {
          commit: () => {
            expect(ctx.agents.get(sessionId)).toBeUndefined()
            expect(ctx.sessions.get(sessionId)).toBeUndefined()
            order.push('setup:commit')
          },
        }
      },
    })

    await setupStarted.promise
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    expect(order).toEqual(['setup:start'])

    gate.resolve(undefined)
    const handle = await resuming
    expect(order).toEqual([
      'setup:start',
      'setup:end',
      'setup:commit',
      'session/created',
      'setup-listener:session/created',
      'agent/created',
      'setup-listener:agent/created',
      'agent/session-start',
    ])
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('a resumed session stores its repair suffix durably before publication', async () => {
    // The stored fixture (two events, no end-seed) gains the end-seed marker
    // through the resume handle: after one resume lifecycle the STORED log
    // carries it, so the next resume reads it back without re-marking.
    const sessionId = SessionId('resume-suffix-durable')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([]))
    const first = await ctx.agents.resume({ resumeSessionId: sessionId })
    await first.dispose()

    const stored = await readStoredEvents(ctx, sessionId)
    expect(stored.map(event => event.type)).toEqual(['turn/start', 'turn/end', 'session/end-seed'])

    const second = await ctx.agents.resume({ resumeSessionId: sessionId })
    expect(second.agent.session.snapshotEvents().map(event => event.type))
      .toEqual(['turn/start', 'turn/end', 'session/end-seed'])
    await second.dispose()
    const restored = await readStoredEvents(ctx, sessionId)
    expect(restored.map(event => event.type)).toEqual(['turn/start', 'turn/end', 'session/end-seed'])
    await ctx.fiber.dispose()
  })

  it('successful resume disposal retires its caller-owned transaction effects', async () => {
    const sessionId = SessionId('resume-retired-effects-s')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const transactionLabels = [`agentLoop.lifecycle(${sessionId})`]

    expect(ctx.fiber.getEffects().map(effect => effect.label)).toEqual(expect.arrayContaining(transactionLabels))
    await handle.dispose()
    expect(ctx.fiber.getEffects().filter(effect => transactionLabels.includes(effect.label))).toEqual([])
    await ctx.fiber.dispose()
  })

  it('resume setup rejection publishes nothing, unwinds, and releases the identity', async () => {
    const sessionId = SessionId('resume-setup-reject')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))
    ctx.on('agent/session-start', () => void published.push('agent/session-start'))

    await expect(ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: async () => {
        await Promise.resolve()
        throw new Error('resume setup failed')
      },
    })).rejects.toThrow('resume setup failed')

    expect(published).toEqual([])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    const retry = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await retry.dispose()
    await ctx.fiber.dispose()
  })

  it('resume setup commit rejection publishes nothing and releases the identity', async () => {
    const sessionId = SessionId('resume-setup-commit-reject')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))

    await expect(ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: () => ({
        commit: () => { throw new Error('resume setup commit failed') },
      }),
    })).rejects.toThrow('resume setup commit failed')

    expect(published).toEqual([])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    const retry = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await retry.dispose()
    await ctx.fiber.dispose()
  })

  it('owner unload aborts resume setup and cannot publish after the callback settles', async () => {
    const sessionId = SessionId('resume-setup-owner-unload')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const gate = Promise.withResolvers<undefined>()
    const setupStarted = Promise.withResolvers<undefined>()
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))

    let resuming!: ReturnType<typeof ctx.agents.resume>
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      resuming = inner.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { provider: 'mock', model: 'mock' },
        setup: async () => {
          setupStarted.resolve(undefined)
          await gate.promise
        },
      })
    }, { inject: ['agents'] }))
    await setupStarted.promise

    await owner.dispose()
    await expect(resuming).rejects.toThrow(/owner disposed during setup/)
    expect(published).toEqual([])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()

    gate.resolve(undefined)
    await Promise.resolve()
    expect(published).toEqual([])
    await ctx.fiber.dispose()
  })

  it('owner unload aborts a never-settling persistence open, releases the identity, and blocks late publication', async () => {
    const sessionId = SessionId('resume-load-owner-unload')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const lateOpen = Promise.withResolvers<SessionHandle>()
    const openStarted = Promise.withResolvers<undefined>()
    const originalOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    let opens = 0
    ctx.sessionPersistence.open = (id, access, options) => {
      expect(id).toBe(sessionId)
      opens += 1
      if (opens === 1) {
        openStarted.resolve(undefined)
        return lateOpen.promise
      }
      return originalOpen(id, access, options)
    }

    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))
    ctx.on('agent/session-start', () => void published.push('agent/session-start'))

    let resuming!: ReturnType<typeof ctx.agents.resume>
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      resuming = inner.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    }, { inject: ['agents'] }))
    await openStarted.promise

    const rejection = expect(promptly(resuming)).rejects.toThrow(/owner disposed during setup/)
    await promptly(owner.dispose())
    expect(published).toEqual([])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()

    // owner.dispose() awaited transaction settlement, so the same identities
    // can be reused before awaiting the public rejection.
    const retry = await promptly(ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' } }))
    await rejection
    expect(opens).toBe(2)
    expect(published).toEqual(['session/created', 'agent/created', 'agent/session-start'])

    // Settlement of the abandoned backend open cannot resume the old
    // transaction: the late handle is closed, and no second publication lands
    // after the retry owns the ids.
    const abandoned = abandonedHandleStub()
    lateOpen.resolve(abandoned.handle)
    await expect.poll(() => abandoned.close.mock.calls.length).toBe(1)
    expect(ctx.agents.get(sessionId)).toBe(retry.agent)
    expect(ctx.sessions.get(sessionId)).toBe(retry.agent.session)
    expect(published).toEqual(['session/created', 'agent/created', 'agent/session-start'])

    await retry.dispose()
    await ctx.fiber.dispose()
  })

  it('AgentLoop unload aborts a never-settling persistence open and awaits wrapper settlement', async () => {
    const sessionId = SessionId('resume-load-factory-unload')
    const root = await persistSession(sessionId)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(JsonlSessionPersistence, { root })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('next')]))

    const lateOpen = Promise.withResolvers<SessionHandle>()
    const openStarted = Promise.withResolvers<undefined>()
    ctx.sessionPersistence.open = (id) => {
      expect(id).toBe(sessionId)
      openStarted.resolve(undefined)
      return lateOpen.promise
    }
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))

    const resuming = ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    await openStarted.promise
    const rejection = expect(promptly(resuming)).rejects.toThrow(/agent loop is not active/)
    await promptly(loopFiber.dispose())
    await rejection

    expect(published).toEqual([])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    // The abandoned handle is closed once the hung open finally settles.
    const abandoned = abandonedHandleStub()
    lateOpen.resolve(abandoned.handle)
    await expect.poll(() => abandoned.close.mock.calls.length).toBe(1)
    expect(published).toEqual([])
    await ctx.fiber.dispose()
  })

  it('resume of a forked session preserves the lineage, seed boundary, and delegation depth in the header', async () => {
    // Lifecycle 1: persist a FORKED session (carries parentSession + seedLength
    // in its header) through createAgent with a complete-turn seed — the
    // factory stores the header and seed through its write handle.
    const seed: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const { ctx: ctx1, root } = await persistentHarness(new MockAdapter([]))
    const forked = await ctx1.agents.create({
      sessionId: SessionId('forked-sess'),
      seed,
      meta: { cwd: '/w', parentSession: SessionId('parent-sess'), isSeeded: true, delegationDepth: 1 },
      inheritedEventCount: SessionLogOffset(seed.length),
    })
    await forked.dispose()
    await ctx1.fiber.dispose()

    // Lifecycle 2: resume it; the parentSession + seedLength header survives the
    // round-trip (exercises resume's parentSession- and seedLength-present
    // branches). seedLength must come from the PERSISTED header, not from the
    // resume seed length (which is the whole stored log, not the original
    // boundary).
    const ctx2 = await mountPersistentHarness(root, new MockAdapter([textResponse('b')]))
    const a2 = (await ctx2.agents.resume({ resumeSessionId: SessionId('forked-sess') })).agent
    expect(a2.session.header.parentSession).toBe('parent-sess')
    expect(a2.session.header.cwd).toBe('/w')
    expect(a2.session.header.isSeeded).toBe(true)
    expect(a2.session.inheritedEventCount).toBe(seed.length)
    // The recursion budget survives resume — a dropped depth would let a
    // resumed child delegate as if it were top-level.
    expect(a2.session.header.delegationDepth).toBe(1)
    await ctx2.fiber.dispose()
  })

  // The crash simulation removes the wedged lifecycle's lock file, which only
  // POSIX's orphan-inode forfeit honors; Windows pins the name until the
  // process exits, and cross-process crash release is pinned by the jsonl
  // two-process e2e.
  it.skipIf(process.platform === 'win32')('a pending idle inject() survives persist + resume without a synthetic turn', async () => {
    const adapter1 = new MockAdapter([textResponse('answer')])
    const { ctx: ctx1, root } = await persistentHarness(adapter1)
    const a1 = (await ctx1.agents.create({ sessionId: SessionId('inject-sess'), meta: { cwd: '/w' } })).agent
    a1.followup(createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }))
    await waitForIdle(ctx1, a1)
    a1.inject(createUserMessage({ content: [{ type: 'text', text: 'background job 42 finished' }], source: { kind: 'plugin', plugin: 'tool-bash' } }))
    await a1.whenIdle()
    await ctx1.sessions.flush(a1.session)
    // Simulate a wedged first lifecycle: a graceful dispose would durably
    // discard the pending inject, and the still-open kernel write lock would
    // otherwise exclude the second lifecycle. Removing the lock file orphans
    // the held inode so the resumer locks a fresh one (the documented
    // forfeit-by-unlink escape hatch).
    await removeSessionLocks(root)

    // Lifecycle 2: resume; the injected context is still pending and becomes
    // model-visible when the next turn admits it.
    const ctx2 = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const stored = await readStoredEvents(ctx2, SessionId('inject-sess'))
    expect(stored.some(event => event.type === 'agent/inbox/spliced')).toBe(true)
    expect(JSON.stringify(stored)).toContain('background job 42 finished')
    const a2 = (await ctx2.agents.resume({ resumeSessionId: SessionId('inject-sess') })).agent
    expect(JSON.stringify(a2.inbox.nextStep)).toContain('background job 42 finished')
    a2.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await waitForIdle(ctx2, a2)
    const flat = JSON.stringify(a2.session.deriveMessages())
    expect(flat).toContain('background job 42 finished')
    await ctx2.fiber.dispose()
    await ctx1.fiber.dispose()
  })

  it('resume reloads a persisted session: history + turn numbering continue, no duplicate seqs', async () => {
    // Lifecycle 1: run one full turn, persisting it.
    const adapter1 = new MockAdapter([textResponse('first answer')])
    const { ctx: ctx1, root } = await persistentHarness(adapter1)
    const h1 = await ctx1.agents.create({ sessionId: SessionId('sess-resume'), meta: { cwd: '/w' } })
    const a1 = h1.agent
    a1.followup(createUserMessage({ content: [{ type: 'text', text: 'first question' }], source: { kind: 'user' } }))
    await waitForIdle(ctx1, a1)
    const events1 = a1.session.snapshotEvents()
    const seqs1 = events1.map(e => e.seq)
    expect(seqs1).toEqual([...seqs1].sort((x, y) => x - y)) // contiguous
    await h1.dispose()
    await ctx1.fiber.dispose()

    // Lifecycle 2: a brand-new context over the SAME root; resume the session.
    const ctx2 = await mountPersistentHarness(root, new MockAdapter([textResponse('second answer')]))

    const a2 = (await ctx2.agents.resume({ resumeSessionId: SessionId('sess-resume') })).agent
    // The resumed session carries the prior history…
    expect(a2.session.id).toBe('sess-resume')
    // …followed by one end-seed event marking the constructor seed.
    expect(a2.session.snapshotEvents().length).toBe(events1.length + 1)
    expect(a2.session.firstLiveSeq).toBe(events1.length)
    expect(a2.session.snapshotEvents().at(-1)?.type).toBe('session/end-seed')
    const replay = Session.create(SessionId('replay'), events1)
    expect(a2.session.deriveMessages()).toEqual(replay.deriveMessages())

    // …and a new turn continues numbering (turn 2) with contiguous seqs.
    a2.followup(createUserMessage({ content: [{ type: 'text', text: 'second question' }], source: { kind: 'user' } }))
    await waitForIdle(ctx2, a2)
    const allSeqs = a2.session.snapshotEvents().map(e => e.seq)
    expect(allSeqs).toEqual(allSeqs.map((_, i) => i)) // 0..N contiguous, no duplicates
    const turnStarts = a2.session.snapshotEvents().filter(e => e.type === 'turn/start')
    expect(turnStarts.map(e => e.type === 'turn/start' && e.data.turn)).toEqual([1, 2])
    await ctx2.fiber.dispose()
  })

  it('resume rejects when session persistence is not configured', async () => {
    // A harness WITHOUT the persistence plugin.
    const adapter = new MockAdapter([textResponse('x')])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    await expect(ctx.agents.resume({ resumeSessionId: SessionId('nope') }))
      .rejects.toThrow(/session persistence is not configured/)
    await ctx.fiber.dispose()
  })
})

describe('creation and resume cancellation edges', () => {
  it('rejects create() with a pre-aborted signal, including a non-Error reason', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([]))

    const errorReason = new AbortController()
    errorReason.abort(new Error('caller gave up'))
    await expect(promptly(ctx.agents.create({
      sessionId: SessionId('pre-aborted-error'),
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: errorReason.signal,
    }))).rejects.toThrow('caller gave up')

    // A non-Error reason is wrapped into the creation-aborted error.
    const stringReason = new AbortController()
    stringReason.abort('operator string reason')
    await expect(promptly(ctx.agents.create({
      sessionId: SessionId('pre-aborted-string'),
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: stringReason.signal,
    }))).rejects.toThrow(/creation aborted/)

    expect(ctx.agents.get(SessionId('pre-aborted-error'))).toBeUndefined()
    expect(ctx.agents.get(SessionId('pre-aborted-string'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('a non-Error abort reason arriving during setup is wrapped for the caller', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([]))
    const controller = new AbortController()
    const setupEntered = Promise.withResolvers<undefined>()
    const setupGate = Promise.withResolvers<undefined>()

    const creating = ctx.agents.create({
      sessionId: SessionId('setup-string-abort'),
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: controller.signal,
      async setup() {
        setupEntered.resolve(undefined)
        await setupGate.promise
      },
    })
    await setupEntered.promise
    controller.abort('mid-setup string reason')
    setupGate.resolve(undefined)

    await expect(promptly(creating)).rejects.toThrow(/creation aborted/)
    expect(ctx.agents.get(SessionId('setup-string-abort'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('rejects when setup synchronously aborts its caller signal', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([]))
    const controller = new AbortController()

    const creating = ctx.agents.create({
      sessionId: SessionId('setup-synchronous-abort'),
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: controller.signal,
      setup() {
        controller.abort(new Error('setup synchronously cancelled'))
      },
    })

    await expect(promptly(creating)).rejects.toThrow('setup synchronously cancelled')
    expect(ctx.agents.get(SessionId('setup-synchronous-abort'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('resume with a pre-aborted caller signal rejects out of the load race', async () => {
    const sessionId = SessionId('resume-pre-aborted')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([]))
    const controller = new AbortController()
    controller.abort(new Error('resume abandoned'))

    await expect(promptly(ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: controller.signal,
    }))).rejects.toThrow('resume abandoned')

    const stringReason = new AbortController()
    stringReason.abort('resume string reason')
    await expect(promptly(ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: stringReason.signal,
    }))).rejects.toThrow(/creation aborted/)

    expect(ctx.agents.get(sessionId)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('an abort landing between crash repair and publication refuses resume, normalized', async () => {
    // Cover the publication-time abort backstop: the signal fires AFTER the
    // raced open settled (during the closer append), so only the final
    // pre-publication check can refuse.
    const run = async (suffix: string, reason: unknown): Promise<unknown> => {
      const sessionId = SessionId(`late-abort-${suffix}`)
      const { ctx: seedCtx, root } = await persistentHarness(new MockAdapter([]))
      await seedStoredSession(seedCtx, sessionId, [
        { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      ])
      await seedCtx.fiber.dispose()

      const ctx = await mountPersistentHarness(root, new MockAdapter([]))
      const controller = new AbortController()
      const originalOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
      ctx.sessionPersistence.open = async (id, access, options) => {
        const handle = await originalOpen(id, access, options)
        const realAppend = handle.append.bind(handle)
        Object.defineProperty(handle, 'append', {
          value: (events: readonly SessionEvent[]) => {
            controller.abort(reason)
            return realAppend(events)
          },
        })
        return handle
      }
      const rejection = await ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { provider: 'mock', model: 'mock' },
        signal: controller.signal,
      }).then(() => undefined, (error: unknown) => error)
      expect(ctx.agents.get(sessionId)).toBeUndefined()
      await ctx.fiber.dispose()
      return rejection
    }

    expect(await run('error', new Error('late abort error'))).toMatchObject({ message: 'late abort error' })
    expect(await run('string', 'late abort string')).toMatchObject({ message: expect.stringMatching(/creation aborted/) as unknown })
  })

  it('an aborted create closes the write handle its abandoned backend create later resolves', async () => {
    const sessionId = SessionId('create-abandoned-handle')
    const { ctx } = await persistentHarness(new MockAdapter([]))
    const lateCreate = Promise.withResolvers<SessionHandle>()
    const createStarted = Promise.withResolvers<undefined>()
    ctx.sessionPersistence.create = () => {
      createStarted.resolve(undefined)
      return lateCreate.promise
    }

    const controller = new AbortController()
    const creating = ctx.agents.create({ sessionId, signal: controller.signal })
    await createStarted.promise
    controller.abort(new Error('caller aborted create'))
    await expect(creating).rejects.toThrow('caller aborted create')
    expect(ctx.sessions.get(sessionId)).toBeUndefined()

    // The abandoned backend create still resolves a real write handle later;
    // the loop closes it so ownership is not leaked, and a rejecting close is
    // swallowed — there is no owner left to observe it.
    const close = vi.fn(async () => { throw new Error('abandoned close failed') })
    lateCreate.resolve({ append: async () => {}, close } as unknown as SessionHandle)
    await expect.poll(() => close.mock.calls.length).toBe(1)
    await ctx.fiber.dispose()
  })

  it('closes the resume write handle when the loop becomes inactive before setup', async () => {
    const sessionId = SessionId('resume-loop-inactive-after-open')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([]))
    const loop = ctx.agentLoop as unknown as {
      ownership: { isActive: () => boolean }
    }
    vi.spyOn(loop.ownership, 'isActive').mockReturnValueOnce(false)

    await expect(ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })).rejects.toThrow('agent loop is not active')
    expect(ctx.agents.get(sessionId)).toBeUndefined()

    // The already-open handle was closed on the inactive path: a retry can
    // claim write ownership again.
    const retry = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await retry.dispose()
    await ctx.fiber.dispose()
  })

  it('factory teardown during a hung resume open rejects promptly and closes the late handle', async () => {
    const sessionId = SessionId('resume-loop-teardown')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([]))
    const gate = Promise.withResolvers<SessionHandle>()
    const openStarted = Promise.withResolvers<undefined>()
    ctx.sessionPersistence.open = () => {
      openStarted.resolve(undefined)
      return gate.promise
    }

    const resuming = ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await openStarted.promise
    // Resolve the open only after teardown began: the abandoned handle must
    // still be released even though the wrapper already rejected.
    const rejection = expect(promptly(resuming)).rejects.toThrow()
    const disposal = ctx.fiber.dispose()
    const abandoned = abandonedHandleStub()
    gate.resolve(abandoned.handle)
    await rejection
    await disposal
    await expect.poll(() => abandoned.close.mock.calls.length).toBe(1)
  })
})

describe('configured-start failure edges', () => {
  it('a non-Error mid-open abort reason is wrapped for the resume caller', async () => {
    const sessionId = SessionId('resume-string-mid-abort')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([]))
    const gate = Promise.withResolvers<never>()
    gate.promise.catch(() => undefined)
    const openStarted = Promise.withResolvers<undefined>()
    ctx.sessionPersistence.open = () => {
      openStarted.resolve(undefined)
      return gate.promise
    }
    const controller = new AbortController()

    const resuming = ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: controller.signal,
    })
    await openStarted.promise
    controller.abort('operator string reason')

    await expect(promptly(resuming)).rejects.toThrow(/creation aborted/)
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('a failing exact-id restore over an existing artifact stays loud', async () => {
    const sessionId = SessionId('config-existing-corrupt')
    const root = await persistSession(sessionId)
    const configured = new Context()
    await configured.plugin(LlmRuntime)
    await configured.plugin(SessionStore)
    await configured.plugin(SessionProjectionRegistry)
    await configured.plugin(SystemPrompt)
    await configured.plugin(ToolRuntime)
    await configured.plugin(AgentRegistry)
    await configured.plugin(JsonlSessionPersistence, { root })
    configured.llm.registerAdapter(['mock'], new MockAdapter([]))
    // The artifact exists but its open fails with a NON-NotFound error: this is
    // corruption, not first creation — the failure must be reported, and no
    // fresh same-id session may shadow the broken one.
    configured.sessionPersistence.open = () => Promise.reject(new Error('artifact corrupt'))
    const configFailures: unknown[] = []
    configured.on('agent-loop/config-start-failed', ({ error }) => { configFailures.push(error) })
    const warn = vi.spyOn(configured.logger, 'warn').mockImplementation(() => undefined)

    const loop = await configured.plugin(AgentLoop, {
      agents: [{ id: 'main', sessionId, provider: 'mock', model: 'mock' }],
    })
    await expect.poll(() => configFailures.length).toBe(1)
    expect(configFailures[0]).toBeInstanceOf(Error)
    expect((configFailures[0] as Error).message).toBe('artifact corrupt')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('config-driven restore'))
    expect(configured.agents.get(sessionId)).toBeUndefined()
    warn.mockRestore()

    await loop.dispose()
    await configured.fiber.dispose()
  })

  it('suppresses a configured-resume failure that lands after teardown', async () => {
    const sessionId = SessionId('config-late-resume-failure')
    const root = await persistSession(sessionId)
    const configured = new Context()
    await configured.plugin(LlmRuntime)
    await configured.plugin(SessionStore)
    await configured.plugin(SessionProjectionRegistry)
    await configured.plugin(SystemPrompt)
    await configured.plugin(ToolRuntime)
    await configured.plugin(AgentRegistry)
    await configured.plugin(JsonlSessionPersistence, { root })
    configured.llm.registerAdapter(['mock'], new MockAdapter([]))
    const gate = Promise.withResolvers<never>()
    gate.promise.catch(() => undefined)
    const openStarted = Promise.withResolvers<undefined>()
    configured.sessionPersistence.open = () => {
      openStarted.resolve(undefined)
      return gate.promise
    }
    const failures: unknown[] = []
    configured.on('agent-loop/config-start-failed', ({ error }) => { failures.push(error) })
    const loop = await configured.plugin(AgentLoop, {
      agents: [{ id: 'main', resumeSessionId: sessionId, provider: 'mock', model: 'mock' }],
    })
    await openStarted.promise
    const disposal = loop.dispose()
    gate.reject(new Error('late backend failure'))
    await disposal
    await new Promise(r => setTimeout(r, 20))

    // Ownership deactivated before the failure landed: the report is dropped.
    expect(failures).toEqual([])
    await configured.fiber.dispose()
  })
})
