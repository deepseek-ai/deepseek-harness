/** Local delivery through real AgentLoop, query observations, and JSONL storage. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import SessionControl from '@deepseek-ai/dsh-session-control'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SessionControlLocal from '../src/index.ts'

class PointQuery extends SessionQuery {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('search is not used by delivery'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('search is not used by delivery'))
  }
}

class ReplyAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    request.signal?.throwIfAborted()
    this.requests.push(request)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'received' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'received' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(() => { vi.restoreAllMocks() })

async function fixture(workspace = false) {
  const root = await mkdtemp(join(tmpdir(), 'session-control-delivery-'))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeRuntimeContext: false } })
    await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(PointQuery)
    await ctx.plugin(AgentDefaultModel, { provider: 'fixture', model: 'reply' })
    await mountAgentLoopTestHarness(ctx)
    const adapter = new ReplyAdapter()
    ctx.llm.registerAdapter(['fixture'], adapter)
    await ctx.plugin(SessionControl)
    const provider = await ctx.plugin(SessionControlLocal)
    const create = (name: string, meta: Partial<SessionHeader> = {}): Promise<AgentHandle> => ctx.agents.create({
      sessionId: SessionId(name),
      agentOptions: { provider: 'fixture', model: 'reply' },
      meta,
    })
    const callerHandle = await create('caller', { cwd: join(root, 'caller') })
    if (workspace) {
      await ctx.plugin(Storage)
      await ctx.plugin(StorageJson, { root: join(root, 'registry') })
      await ctx.plugin(StorageDomain, { backend: 'json' })
      await ctx.plugin(WorkspaceRegistry)
    }
    const caller = callerHandle.agent
    return {
      ctx, root, caller, callerHandle, provider, adapter, create,
      send(id: SessionId, message = 'hello', signal = new AbortController().signal) {
        return Promise.resolve().then(() => ctx.sessionControl.sendMessage({ id, message }, { caller, signal }))
      },
      async cold(name = 'target', meta: Partial<SessionHeader> = {}) {
        const handle = await create(name, meta)
        await ctx.sessions.flush(handle.agent.session)
        await handle.dispose()
        expect(ctx.agents.get(handle.agent.id)).toBeUndefined()
        return handle.agent.id
      },
      async [Symbol.asyncDispose]() {
        try {
          await ctx.fiber.dispose()
        } finally {
          await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        }
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    throw error
  }
}

function received(agent: Agent) {
  return agent.session.snapshotEvents().filter(event => event.type === 'user/message')
}

describe('local independent Session delivery', () => {
  it('starts an idle Session in another directory and records the real sender and receipt', async () => {
    await using f = await fixture()
    const target = (await f.create('target', { cwd: join(f.root, 'other-project') })).agent
    const receipt = await f.send(target.id, 'cross-project task')
    await target.whenIdle()

    expect(received(target)).toMatchObject([{
      data: {
        id: receipt.messageId,
        source: { kind: 'agent-message', form: 'relay', senderSessionId: f.caller.id },
        content: [{ type: 'text', text: 'Agent caller sent a message: ' }, { type: 'text', text: 'cross-project task' }],
      },
    }])
    expect(target.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(f.adapter.requests).toHaveLength(1)
  })

  it('steers a running Session at its next input opportunity without waiting for its answer', async () => {
    await using f = await fixture()
    const target = (await f.create('target')).agent
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let first = true
    f.ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent === target && first) {
        first = false
        entered.resolve(undefined)
        await release.promise
      }
      return next()
    })
    target.followup(createUserMessage({ content: [{ type: 'text', text: 'initial task' }], source: { kind: 'user' } }))
    try {
      await entered.promise
      expect(target.status).toBe('running')
      const receipt = await f.send(target.id, 'next-step instruction')
      expect(target.inbox.nextStep.some(message => message.id === receipt.messageId)).toBe(true)
      expect(f.adapter.requests).toHaveLength(0)
      release.resolve(undefined)
      await target.whenIdle()
      expect(received(target).map(event => event.data.id)).toContain(receipt.messageId)
      expect(target.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
      expect(f.adapter.requests).toHaveLength(2)
    } finally {
      release.resolve(undefined)
    }
  })

  it('restores a cold cwd-less Session only once for overlapping sends', async () => {
    await using f = await fixture()
    const id = await f.cold()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const resume = f.ctx.agents.resume.bind(f.ctx.agents)
    const spy = vi.spyOn(f.ctx.agents, 'resume').mockImplementation(async (request) => {
      entered.resolve(undefined)
      await release.promise
      return resume(request)
    })
    const one = f.send(id, 'first')
    try {
      await entered.promise
      const two = f.send(id, 'second')
      expect(spy).toHaveBeenCalledOnce()
      release.resolve(undefined)
      const receipts = await Promise.all([one, two])
      const target = f.ctx.agents.get(id)!
      await target.whenIdle()
      expect(spy).toHaveBeenCalledOnce()
      expect(received(target).map(event => event.data.id)).toEqual(receipts.map(receipt => receipt.messageId))
      expect(target.session.header.cwd).toBeUndefined()
      expect(target.id).toBe(id)
    } finally {
      release.resolve(undefined)
    }
  })

  it('rejects a missing Session without manufacturing a new identity', async () => {
    await using f = await fixture()
    await expect(f.send(SessionId('missing'))).rejects.toMatchObject({
      name: 'SessionControlError', code: 'SESSION_CONTROL_NOT_FOUND',
    })
    expect(f.ctx.agents.list().map(agent => agent.id)).toEqual([f.caller.id])
  })

  it.each([false, true])('rejects an archived target before delivery with cold=%s', async (cold) => {
    await using f = await fixture(true)
    const id = cold ? await f.cold() : (await f.create('target')).agent.id
    await f.ctx.workspaceRegistry.archiveSession(id)
    const resume = vi.spyOn(f.ctx.agents, 'resume')

    await expect(f.send(id)).rejects.toMatchObject({ code: 'SESSION_CONTROL_ARCHIVED' })
    expect(f.ctx.workspaceRegistry.archivedSessionIds).toContain(id)
    expect(resume).not.toHaveBeenCalled()
    expect(f.adapter.requests).toHaveLength(0)
  })

  it('rechecks archival after an asynchronous cold observation', async () => {
    await using f = await fixture(true)
    const id = await f.cold()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const observe = f.ctx.sessionQuery.observeSession.bind(f.ctx.sessionQuery)
    vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementation(async (...args) => {
      const observation = await observe(...args)
      entered.resolve(undefined)
      await release.promise
      return observation
    })
    const pending = f.send(id)
    try {
      await entered.promise
      await f.ctx.workspaceRegistry.archiveSession(id)
      release.resolve(undefined)
      await expect(pending).rejects.toMatchObject({ code: 'SESSION_CONTROL_ARCHIVED' })
      expect(f.ctx.agents.get(id)).toBeUndefined()
      expect(f.adapter.requests).toHaveLength(0)
    } finally {
      release.resolve(undefined)
    }
  })

  it.each([false, true])('leaves subagent-owned targets to their manager with cold=%s', async (cold) => {
    await using f = await fixture()
    const meta = { origin: 'subagent' as const, parentSession: f.caller.id }
    const id = cold ? await f.cold('child', meta) : (await f.create('child', meta)).agent.id
    await expect(f.send(id)).rejects.toMatchObject({ code: 'SESSION_CONTROL_SUBAGENT_OWNED' })
    expect(f.adapter.requests).toHaveLength(0)
  })

  it('rechecks the sending Agent after restoration waits', async () => {
    await using f = await fixture()
    const id = await f.cold()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const observe = f.ctx.sessionQuery.observeSession.bind(f.ctx.sessionQuery)
    vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementation(async (...args) => {
      const observation = await observe(...args)
      entered.resolve(undefined)
      await release.promise
      return observation
    })
    const pending = f.send(id)
    try {
      await entered.promise
      await f.callerHandle.dispose()
      release.resolve(undefined)
      await expect(pending).rejects.toMatchObject({ code: 'SESSION_CONTROL_CALLER_UNAVAILABLE' })
      expect(f.ctx.agents.get(id)).toBeUndefined()
    } finally {
      release.resolve(undefined)
    }
  })

  it('cancels cold restoration before inbox acceptance and does not retry', async () => {
    await using f = await fixture()
    const id = await f.cold()
    const cancellation = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const resume = f.ctx.agents.resume.bind(f.ctx.agents)
    const spy = vi.spyOn(f.ctx.agents, 'resume').mockImplementation(async (request) => {
      entered.resolve(undefined)
      await release.promise
      return resume(request)
    })
    const pending = f.send(id, 'cancelled', cancellation.signal)
    try {
      await entered.promise
      const failure = new DOMException('cancel delivery', 'AbortError')
      cancellation.abort(failure)
      release.resolve(undefined)
      await expect(pending).rejects.toBe(failure)
      expect(spy).toHaveBeenCalledOnce()
      expect(f.ctx.agents.get(id)).toBeUndefined()
      expect(f.adapter.requests).toHaveLength(0)
    } finally {
      release.resolve(undefined)
    }
  })

  it('preserves an accepted receipt when cancellation arrives from the inbox notification', async () => {
    await using f = await fixture()
    const target = (await f.create('target')).agent
    const cancellation = new AbortController()
    target.ctx.on('agent/inbox/inserted', () => { cancellation.abort(new DOMException('late cancellation', 'AbortError')) })
    const receipt = await f.send(target.id, 'accepted once', cancellation.signal)
    await target.whenIdle()
    expect(cancellation.signal.aborted).toBe(true)
    expect(received(target).map(event => event.data.id)).toEqual([receipt.messageId])
  })

  it('drains a pending restore on unload and releases only provider-owned Agents', async () => {
    await using f = await fixture()
    const live = (await f.create('live')).agent
    const restoredId = await f.cold('restored')
    await f.send(restoredId)
    await f.ctx.agents.get(restoredId)!.whenIdle()
    const pendingId = await f.cold('pending')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const resume = f.ctx.agents.resume.bind(f.ctx.agents)
    vi.spyOn(f.ctx.agents, 'resume').mockImplementation(async (request) => {
      entered.resolve(undefined)
      await release.promise
      return resume(request)
    })
    const pending = f.send(pendingId)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await entered.promise
      const dispose = f.provider.dispose()
      release.resolve(undefined)
      await rejected
      await dispose
      expect(f.ctx.agents.get(pendingId)).toBeUndefined()
      expect(f.ctx.agents.get(restoredId)).toBeUndefined()
      expect(f.ctx.agents.get(live.id)).toBe(live)
      expect(f.ctx.agents.get(f.caller.id)).toBe(f.caller)
      await expect(f.send(live.id)).rejects.toMatchObject({ code: 'SESSION_CONTROL_UNAVAILABLE' })
    } finally {
      release.resolve(undefined)
    }
  })

  it('reports an unavailable writer without retrying the restore', async () => {
    await using f = await fixture()
    const id = await f.cold()
    const resume = vi.spyOn(f.ctx.agents, 'resume').mockRejectedValue(new SessionAlreadyOwnedError(id))
    await expect(f.send(id)).rejects.toMatchObject({ code: 'SESSION_CONTROL_WRITER_HELD' })
    expect(resume).toHaveBeenCalledOnce()
    expect(f.ctx.agents.get(id)).toBeUndefined()
  })

  it('reuses an Agent published while its cold observation is pending', async () => {
    await using f = await fixture()
    const id = await f.cold()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const observe = f.ctx.sessionQuery.observeSession.bind(f.ctx.sessionQuery)
    vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementation(async (...args) => {
      const observation = await observe(...args)
      entered.resolve(undefined)
      await release.promise
      return observation
    })
    const resume = vi.spyOn(f.ctx.agents, 'resume')
    const pending = f.send(id)
    try {
      await entered.promise
      const existing = await f.ctx.agents.resume({
        resumeSessionId: id, agentOptions: { provider: 'fixture', model: 'reply' },
      })
      release.resolve(undefined)
      const receipt = await pending
      await existing.agent.whenIdle()
      expect(resume).toHaveBeenCalledOnce()
      expect(received(existing.agent).map(event => event.data.id)).toEqual([receipt.messageId])
      await f.provider.dispose()
      expect(f.ctx.agents.get(id)).toBe(existing.agent)
    } finally {
      release.resolve(undefined)
    }
  })

  it('rejects a target disposed before resumed-handle delivery reaches acceptance', async () => {
    await using f = await fixture()
    const id = await f.cold()
    const resume = f.ctx.agents.resume.bind(f.ctx.agents)
    vi.spyOn(f.ctx.agents, 'resume').mockImplementation(async (request) => {
      const handle = await resume(request)
      await handle.dispose()
      return handle
    })
    await expect(f.send(id)).rejects.toMatchObject({ code: 'SESSION_CONTROL_INPUT_CLOSED' })
    expect(f.ctx.agents.get(id)).toBeUndefined()
    expect(f.adapter.requests).toHaveLength(0)
  })

  it('rejects input after lifecycle disposal starts while the target remains registered', async () => {
    await using f = await fixture()
    const handle = await f.create('target')
    const target = handle.agent
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<undefined>()
    const maintenance = target.runMaintenance(async (signal) => {
      entered.resolve(signal)
      await release.promise
    })
    const signal = await entered.promise
    const disposing = handle.dispose()
    try {
      expect(signal.aborted).toBe(true)
      expect(signal.reason).toEqual({ kind: 'disposed' })
      expect(f.ctx.agents.get(target.id)).toBe(target)
      const cursor = target.session.seq

      await expect(f.send(target.id, 'must not be parked during disposal')).rejects.toMatchObject({
        code: 'SESSION_CONTROL_INPUT_CLOSED',
      })
      expect(target.session.snapshotEvents().filter(event => event.seq > cursor
        && event.type === 'agent/inbox/spliced' && event.data.inserted.length > 0)).toEqual([])
      expect(f.adapter.requests).toHaveLength(0)
    } finally {
      release.resolve(undefined)
      await maintenance
      await disposing
    }
  })

  it.each(['archive', 'cancel'] as const)('releases a newly restored Agent when %s prevents acceptance', async (reason) => {
    await using f = await fixture(true)
    const id = await f.cold()
    const cancellation = new AbortController()
    const resume = f.ctx.agents.resume.bind(f.ctx.agents)
    const failure = new DOMException('cancel after restoration', 'AbortError')
    vi.spyOn(f.ctx.agents, 'resume').mockImplementation(async (request) => {
      const handle = await resume(request)
      if (reason === 'archive') await f.ctx.workspaceRegistry.archiveSession(id)
      else cancellation.abort(failure)
      return handle
    })
    const pending = f.send(id, 'must not be accepted', cancellation.signal)
    if (reason === 'archive') await expect(pending).rejects.toMatchObject({ code: 'SESSION_CONTROL_ARCHIVED' })
    else await expect(pending).rejects.toBe(failure)
    expect(f.ctx.agents.get(id)?.id).toBeUndefined()
    expect(f.adapter.requests).toHaveLength(0)
  })

  it('retains both admission and cleanup failures when releasing a rejected restore fails', async () => {
    await using f = await fixture()
    const id = await f.cold()
    const cancellation = new AbortController()
    const rejected = new DOMException('cancel after restoration', 'AbortError')
    const cleanup = new Error('restored handle release failed')
    const resume = f.ctx.agents.resume.bind(f.ctx.agents)
    const release = vi.fn<(handle: AgentHandle) => Promise<void>>(async (handle) => {
      await handle.dispose()
      throw cleanup
    })
    vi.spyOn(f.ctx.agents, 'resume').mockImplementation(async (request) => {
      const handle = await resume(request)
      cancellation.abort(rejected)
      return { agent: handle.agent, dispose: () => release(handle) }
    })

    await expect(f.send(id, 'must not be accepted', cancellation.signal)).rejects.toMatchObject({
      name: 'SessionControlError',
      code: 'SESSION_CONTROL_RELEASE_FAILED',
      cause: { name: 'AggregateError', errors: [rejected, cleanup] },
    })
    expect(release).toHaveBeenCalledOnce()
    expect(f.ctx.agents.get(id)).toBeUndefined()
    expect(f.adapter.requests).toHaveLength(0)
    await f.provider.dispose()
    expect(release).toHaveBeenCalledOnce()
  })

  it('reports disposal failures after releasing the remaining restored Agents', async () => {
    await using f = await fixture()
    const first = await f.cold('first')
    const second = await f.cold('second')
    const resume = f.ctx.agents.resume.bind(f.ctx.agents)
    const failure = new Error('restored handle cleanup failed')
    vi.spyOn(f.ctx.agents, 'resume').mockImplementation(async (request) => {
      const handle = await resume(request)
      return request.resumeSessionId === first
        ? { agent: handle.agent, dispose: async () => { await handle.dispose(); throw failure } }
        : handle
    })
    await f.send(first)
    await f.send(second)
    await f.ctx.agents.get(first)!.whenIdle()
    await f.ctx.agents.get(second)!.whenIdle()
    const report = vi.spyOn(f.provider.ctx.logger, 'error').mockImplementation(() => {})
    await f.provider.dispose()
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Session control failed to release restored Agents', errors: [failure],
    }))
    expect(f.ctx.agents.get(first)).toBeUndefined()
    expect(f.ctx.agents.get(second)).toBeUndefined()
  })

  it('uses an ordinary Agent published by a concurrent restore without resending', async () => {
    await using f = await fixture()
    const id = await f.cold()
    const resume = f.ctx.agents.resume.bind(f.ctx.agents)
    let published: AgentHandle | undefined
    const spy = vi.spyOn(f.ctx.agents, 'resume').mockImplementation(async (request) => {
      published = await resume(request)
      throw new SessionAlreadyOwnedError(id)
    })
    const receipt = await f.send(id)
    const target = published!.agent
    await target.whenIdle()
    expect(spy).toHaveBeenCalledOnce()
    expect(received(target).map(event => event.data.id)).toEqual([receipt.messageId])
    await f.provider.dispose()
    expect(f.ctx.agents.get(id)).toBe(target)
  })

  it('preserves a restoration cause and leaves unknown failures unretried', async () => {
    await using f = await fixture()
    const id = await f.cold()
    const failure = new Error('storage reader failed')
    const observe = vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockRejectedValue(failure)
    await expect(f.send(id)).rejects.toMatchObject({
      name: 'SessionControlError', code: 'SESSION_CONTROL_RESTORE_FAILED', cause: failure,
    })
    expect(observe).toHaveBeenCalledOnce()
    expect(f.ctx.agents.get(id)).toBeUndefined()
  })
})
