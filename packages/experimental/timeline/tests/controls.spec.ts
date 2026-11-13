import { executeTool } from './execute-tool.ts'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as Timeline from '../src/index.ts'
import { CONTROL_WAIT_MS, controlTargetsOverlap, reconcileControl } from '../src/controls.ts'
import { reportId, taskId, treeId } from '../src/records.ts'
import type { ControlTarget } from '../src/records.ts'
import type { UserEdit } from '../src/protocol.ts'
import { setup } from './fixture.ts'

async function fixture() {
  const f = await setup({ intervalMs: 86400000 })
  let count = 0
  const call = (name: string, args: object) =>
    executeTool(f.ctx, {
      name,
      arguments: args,
      agent: f.agent,
      callId: ToolCallId(`controls-${count++}`),
      signal: new AbortController().signal,
    })
  await call('timeline_tree', { action: 'start', title: 'Verify recovery' })
  await call('timeline_tasks', {
    tasks: [
      { id: 'group', title: 'Recovery checks' },
      { id: 'one', parent: 'group', title: 'Check restart', status: 'active', done: [1, 4] },
      { id: 'two', parent: 'group', title: 'Check permissions' },
      { id: 'other', title: 'Write user guide', status: 'active' },
    ],
  })
  const view = () => f.ctx.timeline.stateOf(f.agent.session).view
  const tree = view().activeTreeId
  if (tree === null) throw new Error('Missing tree')
  const target: ControlTarget = { kind: 'task', tree, task: taskId.parse('group') }
  const request = (intent: 'pause' | 'resume' = 'pause', scope: ControlTarget = target) => ({
    action: 'control' as const,
    sessionId: f.agent.session.id,
    id: randomUUID(),
    intent,
    target: scope,
    text: `${intent} the selected work.`,
  })
  const edit = (input: UserEdit) => f.ctx.timeline.edit(input)
  const update = async (tasks: object[]) => {
    expect((await call('timeline_tasks', { tasks })).isError).not.toBe(true) }
  return { ...f, view, tree, target, request, edit, call, update }
}

describe('durable asynchronous work requests', () => {
  it('keeps siblings independent and marks a request unavailable when its tree is removed', async () => {
    const f = await fixture()
    try {
      const left = { kind: 'task', tree: f.tree, task: taskId.parse('one') } as const
      const right = { ...left, task: taskId.parse('two') }
      const trees = f.view().trees
      expect(controlTargetsOverlap(left, right, trees)).toBe(false)
      expect(controlTargetsOverlap(left, { ...right, tree: treeId.parse('other-tree') }, trees)).toBe(false)
      expect(controlTargetsOverlap({ kind: 'report', report: reportId.parse('report-one') }, right, trees)).toBe(false)
      expect(controlTargetsOverlap(left, f.target, trees)).toBe(true)
      expect(controlTargetsOverlap(left, right, [])).toBe(false)
      const saved = await f.edit(f.request('pause', left))
      if (saved.action !== 'control') throw new Error('Expected control receipt')
      expect(reconcileControl(saved.annotation, [], saved.annotation.createdAt + 1).control?.outcome)
        .toEqual({ status: 'unavailable', at: saved.annotation.createdAt + 1 })
    } finally {
      await f.close()
    }
  })
  it('suppresses dispatch if another client removes the tree before the reply', async () => {
    const f = await fixture()
    const append = f.ctx.timeline.append.bind(f.ctx.timeline)
    const request = f.request()
    const write = vi.spyOn(f.ctx.timeline, 'append').mockImplementationOnce(async (...args) => {
      await append(...args)
      await f.edit({ action: 'remove', tree: f.tree, sessionId: request.sessionId })
    })
    try {
      const result = await f.edit(request)
      expect(result).toMatchObject({ action: 'control', annotation: { id: request.id }, dispatch: false })
      expect(f.view().trees).toEqual([])
      expect(f.view().annotations).toEqual([])
    } finally {
      write.mockRestore()
      await f.close()
    }
  })
  it('serializes duplicate and overlapping requests, preserves progress, and survives plugin reload', async () => {
    const f = await fixture()
    try {
      const request = f.request()
      const results = await Promise.all([f.edit(request), f.edit(request), f.edit(f.request())])
      expect(results.map(result => result.action === 'control' && result.dispatch)).toEqual([
        true,
        false,
        false,
      ])
      expect(f.view().annotations).toHaveLength(1)
      const saved = f.view().annotations[0]
      expect(f.view().trees[0]?.tasks.find(task => task.id === 'one')).toMatchObject({
        status: 'active',
        done: [1, 4],
      })
      expect(await f.edit(f.request('resume', { kind: 'tree', tree: f.tree }))).toMatchObject({
        dispatch: false,
        annotation: { id: request.id },
      })
      expect(
        await f.edit(f.request('resume', { kind: 'task', tree: f.tree, task: taskId.parse('one') })),
      ).toMatchObject({ dispatch: false })
      const read = await f.call('timeline_read', { annotation: request.id })
      expect(JSON.stringify(read.content)).toContain('Recovery checks')
      await expect(f.edit({ ...request, intent: 'resume' })).rejects.toThrow('identity')
      await f.plugin.dispose()
      const loaded = await f.ctx.plugin(Timeline, { intervalMs: 86400000, rollupFactors: [] })
      try {
        expect(f.view().annotations).toEqual([saved])
        expect(await f.edit(request)).toMatchObject({ dispatch: false })
      } finally {
        await loaded.dispose()
      }
    } finally {
      await f.close()
    }
  })

  it('confirms a pause only after every unfinished leaf in scope is paused or blocked', async () => {
    const f = await fixture()
    try {
      const request = f.request()
      await f.edit(request)
      await f.edit({ action: 'delivery', sessionId: request.sessionId, id: request.id, delivery: 'accepted' })
      await f.update([{ id: 'other', status: 'paused', note: 'Outside the selected branch.' }])
      expect(f.view().annotations[0]?.control?.outcome).toBeNull()
      await f.update([{ id: 'one', status: 'paused', note: 'Safe checkpoint.' }])
      // The group now derives Paused, but its second leaf is still Pending.
      expect(f.view().annotations[0]?.control?.outcome).toBeNull()
      await f.update([{ id: 'two', status: 'blocked', note: 'Test account unavailable.' }])
      const receipt = f.view().annotations[0]
      expect(receipt?.control).toMatchObject({ delivery: 'accepted', outcome: { status: 'applied' } })
      await f.update([{ id: 'one', status: 'active', note: 'User requested follow-up.' }])
      expect(f.view().annotations[0]).toEqual(receipt)
      expect(f.view().trees[0]?.tasks.find(task => task.id === 'one')?.done).toEqual([1, 4])
    } finally {
      await f.close()
    }
  })

  it('distinguishes an agent answer from a plan update and confirms continue only inside the selected scope', async () => {
    const f = await fixture()
    try {
      await f.update([
        { id: 'one', status: 'paused', note: 'Waiting for user.' },
        { id: 'two', status: 'blocked', note: 'Needs access.' },
      ])
      const request = f.request('resume')
      await f.edit(request)
      const reply = await f.call('timeline_reply', {
        id: request.id,
        text: 'The permission check still needs access.',
      })
      expect(reply.isError).not.toBe(true)
      expect(JSON.stringify(reply.content)).toContain('answered')
      expect(f.view().annotations[0]?.control?.outcome?.status).toBe('answered')
      await f.update([{ id: 'other', done: [1, 2], note: 'An unrelated guide section is ready.' }])
      expect(f.view().annotations[0]?.control?.outcome?.status).toBe('answered')
      await f.update([{ id: 'one', status: 'active', note: 'Restart check can continue.' }])
      expect(f.view().annotations[0]?.control?.outcome?.status).toBe('applied')
      const receipt = f.view().annotations[0]
      await f.call('timeline_reply', { id: request.id, text: 'The permission check still needs access.' })
      expect(f.view().annotations[0]).toEqual(receipt)
      const session = f.agent.session
      const current = f.ctx.timeline.stateOf(session)
      const read = vi.spyOn(f.ctx.timeline, 'stateOf')
      const append = f.ctx.timeline.append.bind(f.ctx.timeline)
      const write = vi.spyOn(f.ctx.timeline, 'append').mockImplementationOnce(async (...args) => {
        await append(...args)
        // A stale projection can know a request before it has caught up with the reply.
        read.mockReturnValueOnce({
          ...current, view: { ...current.view, annotations: current.view.annotations.map(item =>
            item.control === undefined ? item : { ...item, control: { ...item.control, outcome: null } },
          ) },
        })
      })
      try {
        const stale = await f.call('timeline_reply', { id: request.id, text: 'The permission check still needs access.' })
        expect(JSON.stringify(stale.content)).toContain('unconfirmed')
      } finally {
        read.mockRestore()
        write.mockRestore()
      }
      expect((await f.call('timeline_reply', { id: request.id, text: 'Replacement claim.' })).isError).toBe(
        true,
      )
    } finally {
      await f.close()
    }
  })

  it('keeps unknown delivery pending, permits only an explicit later retry, and cannot unsend an older request', async () => {
    const f = await fixture()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const first = f.request()
      await f.edit(first)
      await f.edit({ action: 'delivery', sessionId: first.sessionId, id: first.id, delivery: 'unknown' })
      // A late or duplicate admission acknowledgement cannot replace the saved delivery outcome.
      await f.edit({ action: 'delivery', sessionId: first.sessionId, id: first.id, delivery: 'accepted' })
      expect(f.view().annotations[0]?.control).toMatchObject({ delivery: 'unknown', outcome: null })
      vi.setSystemTime(Date.now() + CONTROL_WAIT_MS + 1)
      expect(f.view().annotations[0]?.control?.outcome).toBeNull()
      expect(f.view().annotations).toHaveLength(1)
      const second = f.request()
      expect(await f.edit(second)).toMatchObject({ dispatch: true })
      expect(f.view().annotations[0]?.control?.outcome?.status).toBe('superseded')
      expect(f.view().annotations[1]?.control?.outcome).toBeNull()
      await f.call('timeline_reply', { id: first.id, text: 'The first request was received.' })
      expect(f.view().annotations[1]?.control?.outcome).toBeNull()
      await f.update([
        { id: 'one', status: 'paused', note: 'Safe checkpoint.' },
        { id: 'two', status: 'paused', note: 'Deferred as requested.' },
      ])
      expect(f.view().annotations[0]?.control?.outcome?.status).toBe('superseded')
      expect(f.view().annotations[1]?.control?.outcome?.status).toBe('applied')
    } finally {
      vi.useRealTimers()
      await f.close()
    }
  })

  it('records completion and retirement without claiming the requested pause was applied', async () => {
    const f = await fixture()
    try {
      const request = f.request('pause', { kind: 'task', tree: f.tree, task: taskId.parse('one') })
      await f.edit(request)
      await f.update([{ id: 'one', status: 'done', note: 'All restart checks passed.' }])
      expect(f.view().annotations[0]?.control?.outcome?.status).toBe('completed')
      expect(await f.edit(f.request('pause', request.target))).toMatchObject({
        dispatch: false,
        annotation: { control: { outcome: { status: 'completed' } } },
      })
      const retire = f.request('pause', { kind: 'task', tree: f.tree, task: taskId.parse('other') })
      await f.edit(retire)
      await f.update([{ id: 'other', status: 'retired', note: 'Guide is out of scope.' }])
      expect(f.view().annotations.at(-1)?.control?.outcome?.status).toBe('unavailable')
      expect(await f.edit(retire)).toMatchObject({ dispatch: false })
      await expect(f.edit(f.request('pause', retire.target))).rejects.toThrow('Unknown available')
    } finally {
      await f.close()
    }
  })

  it('rejects failed saves and model-written requests, and exposes whole-plan requests to the model', async () => {
    const f = await fixture()
    try {
      const put = vi.spyOn(f.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('Write failed'))
      const request = f.request('pause', { kind: 'tree', tree: f.tree })
      await expect(f.edit(request)).rejects.toThrow('Write failed')
      expect(f.view().annotations).toHaveLength(0)
      put.mockRestore()
      await f.plugin.dispose()
      await f.ctx.plugin(Timeline, { intervalMs: 86400000, rollupFactors: [] })
      await f.edit(request)
      expect(JSON.stringify((await f.call('timeline_read', { annotation: request.id })).content)).toContain(
        'Verify recovery',
      )
      expect(JSON.stringify((await f.call('timeline_read', {})).content)).toContain(request.id)
      expect(
        (await f.call('timeline_tasks', { tasks: [{ id: 'one', control: { action: 'pause' } }] })).isError,
      ).toBe(true)
      f.start()
      await f.adapter.ready.promise
      expect(JSON.stringify(f.adapter.main)).toContain('requestedAction')
      expect(JSON.stringify(f.adapter.main)).toContain(request.id)
    } finally {
      await f.close()
    }
  })
})
