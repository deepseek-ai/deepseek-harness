import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionLogOffset, SessionSeq, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, vi } from 'vitest'
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

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([header]),
    inspect: (sessionId: SessionId) => Promise.resolve(
      sessionId === PARENT ? { meta: header, events } : undefined,
    ),
  }) as never)
  installSessionReadTestServices(ctx)
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

  it('requests a stored parent catalog by id without loading an Agent', async () => {
    const { ctx, controller } = await bench()
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    const signal = new AbortController().signal

    await expect(controller.projections({ sessionId: PARENT }, signal)).resolves.toMatchObject({ values: { subagentCatalog: [{
      id: CHILD,
      mode: 'continuable',
      label: 'worker',
    }] } })
    expect(observe).toHaveBeenCalledOnce()
    expect(observe).toHaveBeenCalledWith(PARENT, {
      signal,
    })
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
    expect(result).toMatchObject({ values: { subagentCatalog: [{
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
    expect(result).toMatchObject({ asOfSeq: 0, values: { subagentCatalog: [{ id: CHILD, createdAt: 8, mode: 'one-shot' }] } })
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
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    installSessionReadTestServices(ctx)
    const controller = createSessionTestController(ctx, defaults)
    const session = ctx.sessions.create(PARENT, { meta: { cwd: '/workspace' } })
    const expected = ctx.sessionProjections.snapshot(session)
    expect(expected.values.subagentCatalog).toBeUndefined()
    await expect(controller.projections({ sessionId: PARENT }, new AbortController().signal)).resolves.toEqual(expected)
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

  it('maps query cancellation, missing projections, and unexpected failures', async () => {
    const { ctx, controller } = await bench()
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    observe.mockRejectedValueOnce(new SessionQueryError(
      'query cancelled',
      'SESSION_QUERY_ABORTED',
    ))
    await expect(controller.projections({ sessionId: PARENT }, new AbortController().signal)).rejects.toMatchObject({
      code: 'gateway/cancelled',
    })

    observe.mockRestore()
    // An observation without the catalog state means no registry served it.
    const stateless: SessionObservation = {
      source: 'prepared',
      header,
      inheritedEventCount: SessionLogOffset(0),
      events,
      cursor: SessionSeq(0),
      retain: () => stateless,
      [Symbol.dispose]: () => {},
    }
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockResolvedValueOnce(stateless)
    await expect(controller.projections({ sessionId: PARENT }, new AbortController().signal)).rejects.toMatchObject({
      code: 'session/projections-unavailable',
    })

    vi.spyOn(ctx.sessionQuery, 'observeSession').mockRejectedValueOnce(new Error('storage offline'))
    await expect(controller.projections({ sessionId: PARENT }, new AbortController().signal)).rejects.toMatchObject({
      code: 'gateway/internal',
    })
  })
})
