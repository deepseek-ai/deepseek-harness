import { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionSeq, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionTestController,
  installSessionReadTestServices,
  testSessionPersistence,
} from './test-remote.ts'

const defaults = {
  defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
  cwd: '/tmp',
}

const PARENT = SessionId('catalog-parent')
const CHILD = SessionId('catalog-child')
const header: SessionHeader = {
  version: SESSION_FORMAT_VERSION,
  id: PARENT,
  createdAt: 1,
  isSeeded: false,
  cwd: '/workspace',
}
const events: SessionEvent[] = [{
  type: 'subagent/catalog',
  seq: SessionSeq(0),
  time: 1,
  data: {
    version: 0,
    childId: CHILD,
    childCreatedAt: 2,
    mode: 'continuable',
    label: 'worker',
  },
}]

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function bench() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([header]),
    inspect: (sessionId: SessionId) => Promise.resolve(
      sessionId === PARENT ? { meta: header, events } : undefined,
    ),
  }) as never)
  installSessionReadTestServices(ctx)
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  const controller = createSessionTestController(ctx, defaults)
  return { ctx, controller }
}

describe('SessionController subagent catalog', () => {
  it('pushes complete catalog values through the shared control stream', async () => {
    const { ctx, controller } = await bench()
    const signal = new AbortController()
    const stream = controller.control(signal.signal)[Symbol.asyncIterator]()
    try {
      await stream.next()
      const parent = ctx.sessions.create(PARENT, { meta: { createdAt: 7, cwd: '/workspace' } })
      parent.append('subagent/catalog', {
        version: 0, childId: CHILD, childCreatedAt: 8, mode: 'continuable', label: 'worker',
      })
      let frame = await stream.next()
      while (!frame.done && !(frame.value.type === 'projection' && frame.value.key === 'subagentCatalog'
        && Array.isArray(frame.value.value) && frame.value.value.length === 1)) {
        frame = await stream.next()
      }
      expect(frame.value).toMatchObject({ type: 'projection', sessionId: PARENT, key: 'subagentCatalog',
        value: [{ id: CHILD, createdAt: 8, mode: 'continuable', label: 'worker' }] })
    } finally {
      signal.abort()
      await stream.return?.()
    }
  })

  it.each([false, true])('reads an uncached parent catalog without loading an Agent (explicit current format: %s)', async (withFormat) => {
    const { ctx, controller } = await bench()
    const stored = await ctx.sessionPersistence.stat(PARENT)
    if (stored === undefined) throw new Error('parent fixture is missing')
    const stat = vi.spyOn(ctx.sessionPersistence, 'stat').mockResolvedValueOnce(withFormat
      ? { ...stored, formatStatus: 'current' }
      : stored)
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    const open = vi.spyOn(ctx.sessionPersistence, 'open')
    const resume = vi.spyOn(ctx.agents, 'resume').mockRejectedValue(new Error('unexpected Agent resume'))
    const signal = new AbortController().signal

    await expect(controller.projections({ sessionId: PARENT }, signal)).resolves.toMatchObject({
      kind: 'sequenced', values: { subagentCatalog: [{ id: CHILD, mode: 'continuable', label: 'worker' }] },
    })
    expect(stat).toHaveBeenCalledWith(PARENT, { signal })
    expect(observe).toHaveBeenCalledWith(PARENT, { signal })
    expect(open).toHaveBeenCalledWith(PARENT, 'read', { signal })
    expect(resume).not.toHaveBeenCalled()
    expect(ctx.sessions.get(PARENT)).toBeUndefined()
    expect(ctx.agents.get(PARENT)).toBeUndefined()
  })

  it('uses disk migration status instead of the normalized header version to defer a cold catalog read', async () => {
    const { ctx, controller } = await bench()
    const stored = await ctx.sessionPersistence.stat(PARENT)
    if (stored === undefined) throw new Error('parent fixture is missing')
    vi.spyOn(ctx.sessionPersistence, 'stat').mockResolvedValueOnce({
      ...stored,
      formatStatus: 'migration-required',
    })
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    const open = vi.spyOn(ctx.sessionPersistence, 'open')

    expect(stored.header.version).toBe(SESSION_FORMAT_VERSION)
    await expect(controller.projections({ sessionId: PARENT }, new AbortController().signal))
      .resolves.toEqual({ kind: 'migration-required', values: {} })

    expect(observe).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(ctx.sessions.get(PARENT)).toBeUndefined()
    expect(ctx.agents.get(PARENT)).toBeUndefined()
  })

  it('serves a live parent from its maintained registry state without folding its log', async () => {
    const { ctx, controller } = await bench()
    const parent = ctx.sessions.create(PARENT, { meta: { createdAt: 7, cwd: '/workspace' } })
    parent.append('turn/start', { turn: 1 })
    parent.append('subagent/catalog', {
      version: 0,
      childId: CHILD,
      childCreatedAt: 8,
      mode: 'one-shot',
      label: 'live worker',
    })
    const snapshot = vi.spyOn(ctx.sessionProjections, 'snapshot')
    const hydrate = vi.spyOn(ctx.sessionProjections, 'hydrate')

    const result = await controller.projections({ sessionId: PARENT }, new AbortController().signal)
    expect(result).toMatchObject({ kind: 'sequenced', values: { subagentCatalog: [{
      id: CHILD,
      mode: 'one-shot',
      label: 'live worker',
    }] } })
    expect(snapshot).toHaveBeenCalledWith(parent)
    expect(hydrate).not.toHaveBeenCalled()
  })

  it('reports Agent availability through Session summaries independently of projections', async () => {
    const { ctx, controller } = await bench()
    const parent = ctx.sessions.create(PARENT, { meta: { createdAt: 1, cwd: '/workspace' } })
    parent.append('subagent/catalog', {
      version: 0, childId: CHILD, childCreatedAt: 8, mode: 'one-shot',
    })
    const summaries: boolean[] = []
    ctx.on('api-session/added', (summary) => { summaries.push(summary.agentAvailable) })
    const dispose = ctx.agents.register({ id: PARENT, session: parent, status: 'idle', ctx } as Agent)
    await dispose
    expect(summaries).toEqual([true])
    const available = await controller.list({}, new AbortController().signal)
    expect(available.items.find(item => item.sessionId === PARENT)?.agentAvailable).toBe(true)
    await dispose()
    expect(summaries).toEqual([true, false])
    const unavailable = await controller.list({}, new AbortController().signal)
    expect(unavailable.items.find(item => item.sessionId === PARENT)?.agentAvailable).toBe(false)
    const result = await controller.projections({ sessionId: PARENT }, new AbortController().signal)
    expect(result).toMatchObject({ kind: 'sequenced', asOfSeq: 0, values: { subagentCatalog: [{ id: CHILD, createdAt: 8, mode: 'one-shot' }] } })
  })

  it('does not republish a Session when its Agent outlives the Session registration', async () => {
    const { ctx } = await bench()
    const session = ctx.sessions.prepare(SessionId('detached'), { meta: { cwd: '/workspace' } })
    const detach = ctx.sessions.enter(session)
    const disposeAgent = ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
    await disposeAgent
    const added = vi.fn()
    ctx.on('api-session/added', added)
    detach()
    await disposeAgent()
    expect(added).not.toHaveBeenCalled()
  })

  it('reads registered projections without a subagent provider or catalog key', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    installSessionReadTestServices(ctx)
    const controller = createSessionTestController(ctx, defaults)
    const session = ctx.sessions.create(PARENT, { meta: { cwd: '/workspace' } })
    const expected = ctx.sessionProjections.snapshot(session)
    expect(expected.values.subagentCatalog).toBeUndefined()
    await expect(controller.projections({ sessionId: PARENT }, new AbortController().signal))
      .resolves.toEqual({ kind: 'sequenced', ...expected })
    expect(ctx.agents.get(PARENT)).toBeUndefined()
  })

  it('validates the parent id and keeps not-found distinct from cancellation', async () => {
    const { controller } = await bench()
    const signal = new AbortController().signal
    await expect(controller.projections({ sessionId: SessionId('') }, signal)).rejects.toMatchObject({
      code: 'gateway/bad-request',
    })
    await expect(controller.projections({ sessionId: SessionId('missing') }, signal)).resolves.toEqual(null)
    const aborted = new AbortController()
    aborted.abort()
    await expect(controller.projections({ sessionId: PARENT }, aborted.signal)).rejects.toMatchObject({
      code: 'gateway/cancelled',
    })
  })

  it('reports a live snapshot failure without falling back to stored metadata', async () => {
    const { ctx, controller } = await bench()
    const parent = ctx.sessions.create(PARENT, { meta: { cwd: '/workspace' } })
    const failure = new Error('projection snapshot failed')
    const snapshot = vi.spyOn(ctx.sessionProjections, 'snapshot').mockImplementationOnce(() => {
      throw failure
    })
    const stat = vi.spyOn(ctx.sessionPersistence, 'stat')
    await expect(controller.projections({ sessionId: PARENT }, new AbortController().signal)).rejects.toMatchObject({
      code: 'gateway/internal',
      cause: failure,
    })
    expect(snapshot).toHaveBeenCalledWith(parent)
    expect(stat).not.toHaveBeenCalled()
  })
})
