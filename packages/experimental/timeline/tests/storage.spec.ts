import { executeTool } from './execute-tool.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginRecordOf, Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Peer, type ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { reportId, taskId, treeId, treeSchema } from '../src/records.ts'
import { patchTasks } from '../src/tasks.ts'
import { MAX_ANNOTATIONS } from '../src/policy.ts'
import { TIMELINE_CHANNEL, TIMELINE_EDIT, TIMELINE_LOCALE } from '../src/protocol.ts'
import type { TimelineRecordMap } from '../src/records.ts'
import { setup } from './fixture.ts'

const fixtures: Awaited<ReturnType<typeof setup>>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
})
async function fixture() {
  const value = await setup({ intervalMs: 86400000 })
  fixtures.push(value)
  return value
}
function tree(session: Session, id = 'work'): TimelineRecordMap['plugin:timeline/tree'] {
  return {
    version: 1,
    sessionId: session.id,
    callId: id,
    tree: treeSchema.parse({ id, title: 'Check session recovery', description: '', tasks: [], createdAt: 1 }),
  }
}

describe('public Timeline storage', () => {
  it('flushes a buffered priority before a queued retry returns and sends one notice', async () => {
    const f = await fixture()
    const session = f.agent.session
    const change = tree(session)
    const task = taskId.parse('check')
    change.tree.tasks = patchTasks([], [{ id: task, title: 'Check' }], 1, 5)
    await f.ctx.timeline.append(session, 'plugin:timeline/tree', change)
    const notice = vi.fn()
    f.ctx.on('timeline/priority', notice)
    const persist = f.ctx.sessions.flush.bind(f.ctx.sessions)
    let failed = false
    const flush = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (owner) => {
      if (owner === session && !failed && f.records.some(record => record.type === 'plugin:timeline/priority')) {
        failed = true
        throw new Error('Temporary write failure')
      }
      return persist(owner)
    })
    const request = { action: 'priority', sessionId: session.id, tree: change.tree.id, task, priority: 'P0' } as const
    try {
      const outcomes = await Promise.allSettled([f.ctx.timeline.edit(request), f.ctx.timeline.edit(request)])
      expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'fulfilled'])
      const saved = (await f.handle.read()).events.filter(event => pluginRecordOf(event)?.type === 'plugin:timeline/priority')
      expect(saved).toHaveLength(1)
      expect(notice).toHaveBeenCalledExactlyOnceWith(session)
      await f.ctx.timeline.edit(request)
      expect(notice).toHaveBeenCalledOnce()
    } finally {
      flush.mockRestore()
    }
  })
  it('keeps whole-tree discussion context and treats an unchanged priority as a no-op', async () => {
    const f = await fixture()
    const session = f.agent.session
    const change = tree(session)
    const task = taskId.parse('check')
    change.tree.tasks = patchTasks([], [{ id: task, title: 'Check' }], 1, 5)
    await f.ctx.timeline.append(session, 'plugin:timeline/tree', change)
    const priority = { action: 'priority', sessionId: session.id, tree: change.tree.id, task, priority: null } as const
    await f.ctx.timeline.edit(priority)
    expect(f.records.some(record => record.type === 'plugin:timeline/priority')).toBe(false)
    const input = {
      action: 'annotate', sessionId: session.id, id: 'note-0000000000000001',
      target: { kind: 'tree', tree: change.tree.id }, text: 'Check the plan.',
    } as const
    const saved = await f.ctx.timeline.edit(input)
    expect(saved).toMatchObject({ context: { kind: 'tree', tree: change.tree.id, task: null, progress: null } })
    expect(await f.ctx.timeline.edit(input)).toEqual(saved)
    await expect(f.ctx.timeline.edit({ ...input, target: { kind: 'report', report: reportId.parse('missing') } }))
      .rejects.toThrow('cannot be reused')
    await expect(f.ctx.timeline.edit({ ...input, id: 'note-0000000000000002', target: { kind: 'report', report: reportId.parse('missing') } }))
      .rejects.toThrow('Unknown Timeline report')
    const state = f.ctx.timeline.stateOf(session)
    const full = Array.from({ length: MAX_ANNOTATIONS }, (_, index) => ({
      id: `note-${index.toString(16).padStart(16, '0')}`, target: input.target, text: input.text, createdAt: 1, reply: null,
    }))
    vi.spyOn(f.ctx.timeline, 'stateOf').mockReturnValueOnce({ ...state, view: { ...state.view, annotations: full } })
    await expect(f.ctx.timeline.edit({ ...input, id: 'note-000000000000ffff' })).rejects.toThrow('discussions per Session')
  })
  it('accepts authenticated edit RPCs and contains invalid requests and cancellation', async () => {
    const f = await fixture()
    const owner = new Peer(f.ctx, { principal: { kind: 'owner' } })
    const viewer = new Peer(f.ctx, {
      principal: {
        kind: 'share-viewer',
        shareId: 'test-share',
        actor: { providerId: 'test', tenantId: 'test', subjectId: 'reader' },
      },
    })
    const handle = vi.fn<(_channel: string, _rpc: ConnectionRpcHandler) => void>()
    f.ctx.provide('connection', { rpc: { handle } } as never)
    f.ctx.provide('webServer', {} as never)
    try {
      await vi.waitFor(() => { expect(handle).toHaveBeenCalledOnce() })
      const registration = handle.mock.calls[0]
      if (registration === undefined) throw new Error('Missing edit RPC')
      expect(registration[0]).toBe(TIMELINE_CHANNEL)
      const rpc = registration[1]
      const input = { action: 'remove', sessionId: f.agent.session.id, tree: 'missing' }
      const { signal } = new AbortController()
      const planning = async () => (await f.ctx.systemPrompt.assemble({ scope: f.agent }))
        .sections.find(section => section.name === 'timeline:planning')?.text
      expect(await rpc(TIMELINE_LOCALE, 'zh-CN', signal, owner)).toEqual({ ok: true, value: null })
      expect(await planning()).toContain('discussion replies in 简体中文')
      expect(await rpc(TIMELINE_LOCALE, 'fr', signal, viewer)).toMatchObject({ ok: false, error: { code: 'timeline/forbidden' } })
      expect(await rpc(TIMELINE_LOCALE, 'invalid', signal, owner)).toMatchObject({ ok: false, error: { code: 'timeline/request-failed' } })
      expect(await planning()).toContain('discussion replies in 简体中文')
      f.ctx.provide('settings', { describe: () => [{ ns: 'locale', value: { preference: 'fr' } }] } as never)
      expect(await planning()).toContain('discussion replies in Français')
      expect(await rpc(TIMELINE_EDIT, input, signal, owner)).toMatchObject({ ok: true, value: { removed: false } })
      for (const [method, peer] of [['unknown', owner], [TIMELINE_EDIT, viewer]] as const)
        expect(await rpc(method, input, signal, peer)).toMatchObject({ ok: false, error: { code: 'timeline/forbidden' } })
      expect(await rpc(TIMELINE_EDIT, {}, signal, owner)).toMatchObject({ ok: false, error: { code: 'timeline/request-failed' } })
      await expect(rpc(TIMELINE_EDIT, input, AbortSignal.abort(new Error('Edit canceled')), owner)).rejects.toThrow('Edit canceled')
      vi.spyOn(f.ctx.timeline, 'edit').mockRejectedValueOnce('Unknown transport failure')
      expect(await rpc(TIMELINE_EDIT, input, signal, owner))
        .toMatchObject({ ok: false, error: { message: 'Timeline request failed' } })
    } finally {
      await owner.dispose()
      await viewer.dispose()
    }
  })
  it('rejects edits against unavailable targets and unacknowledged sessions', async () => {
    const f = await fixture()
    const sessionId = f.agent.session.id
    const missing = treeId.parse('missing')
    await expect(f.ctx.timeline.edit({ action: 'remove', sessionId: SessionId('unknown'), tree: missing }))
      .rejects.toThrow('Open the conversation')
    await expect(f.ctx.timeline.edit({ action: 'delivery', sessionId, id: 'note-0000000000000001', delivery: 'accepted' }))
      .rejects.toThrow('Unknown Timeline control request')
    await expect(f.ctx.timeline.edit({ action: 'priority', sessionId, tree: missing, task: taskId.parse('absent'), priority: 'P1' }))
      .rejects.toThrow('Unknown available Timeline task')
    const change = tree(f.agent.session)
    const storage = f.ctx.timeline
    const flush = vi.spyOn(f.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    await expect(storage.edit({ action: 'remove', sessionId, tree: missing })).rejects.toThrow('durable session persistence')
    await expect(storage.append(Session.create(SessionId('offline')), 'plugin:timeline/tree', change)).rejects.toThrow('live session')
    flush.mockResolvedValueOnce(false)
    await expect(storage.append(f.agent.session, 'plugin:timeline/tree', change)).rejects.toThrow('could not save')
    await f.plugin.dispose()
    await expect(storage.append(f.agent.session, 'plugin:timeline/tree', change)).rejects.toThrow('storage is closed')
  })
  it('preserves concurrent task patches and rejects invalid edits without changing the stored view', async () => {
    const f = await fixture()
    let count = 0
    const call = (name: string, args: object) =>
      executeTool(f.ctx, {
        name,
        arguments: args,
        callId: ToolCallId(`concurrent-${count++}`),
        agent: f.agent,
        signal: new AbortController().signal,
      })
    expect((await call('timeline_tree', { action: 'start', title: 'Release checks' })).isError).not.toBe(true)
    const results = await Promise.all(
      ['first', 'second'].map(id =>
        call('timeline_tasks', {
          tasks: [{ id, title: `Check ${id}`, status: 'active' }],
        }),
      ),
    )
    expect(results.every(result => ! result.isError)).toBe(true)
    const before = f.ctx.timeline.stateOf(f.agent.session).view
    expect(before.trees[0]?.tasks.map(task => task.id)).toEqual(['first', 'second'])
    expect(
      (await call('timeline_tasks', { tasks: [{ id: 'first', parent: 'missing', note: 'Move task.' }] }))
        .isError,
    ).toBe(true)
    expect(f.ctx.timeline.stateOf(f.agent.session).view).toEqual(before)
  })
  it('rejects an oversized tree write before it reaches the session log', async () => {
    const f = await fixture()
    const session = f.agent.session
    const change = tree(session)
    change.tree.tasks = patchTasks([], Array.from({ length: 180 }, (_, index) => ({
      id: taskId.parse(`task-${index}`), title: `Task ${index}`, details: '测'.repeat(4000),
    })), 1, 180)
    await expect(f.ctx.timeline.append(session, 'plugin:timeline/tree', change))
      .rejects.toMatchObject({ code: 'TIMELINE_INVALID_ARGUMENT' })
    expect(f.records).toEqual([])
    expect(f.ctx.timeline.stateOf(session).view.trees).toEqual([])
  })
  it('drains an acknowledged log write before plugin unload finishes', async () => {
    const f = await fixture()
    const change = tree(f.agent.session)
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    const admitted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(f.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      admitted.resolve(undefined)
      await release.promise
      return flush(session)
    })
    const save = f.ctx.timeline.append(f.agent.session, 'plugin:timeline/tree', change)
    await admitted.promise
    const unload = f.plugin.dispose()
    release.resolve(undefined)
    await save
    await unload
    expect((await f.handle.read()).events.some(event => pluginRecordOf(event)?.type === 'plugin:timeline/tree')).toBe(true)
  })
  it('starts each Session independently and rejects mismatched or invalid storage writes', async () => {
    const f = await fixture()
    const { session: other } = await f.ctx.agents.create({ sessionId: SessionId('other'), meta: { cwd: process.cwd() } }).then(result => result.agent)
    await f.ctx.timeline.append(f.agent.session, 'plugin:timeline/tree', tree(f.agent.session))
    expect(f.ctx.timeline.stateOf(other).view.trees).toEqual([])
    await expect(f.ctx.timeline.append(other, 'plugin:timeline/tree', tree(f.agent.session))).rejects.toThrow(
      'another session',
    )
    await expect(
      f.ctx.timeline.append(other, 'plugin:timeline/tree', {
        ...tree(other),
        tree: { ...tree(other).tree, title: '' },
      }),
    ).rejects.toThrow('Invalid Timeline update')
    expect(f.ctx.timeline.stateOf(other).view.trees).toEqual([])
  })
})
