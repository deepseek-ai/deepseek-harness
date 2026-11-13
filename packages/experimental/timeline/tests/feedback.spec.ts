import { executeTool } from './execute-tool.ts'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as Timeline from '../src/index.ts'
import type {} from '../src/reminders.ts'
import { reportSchema, taskId } from '../src/records.ts'
import { prioritiesOf } from '../src/tasks.ts'
import { setup } from './fixture.ts'

async function fixture() {
  const f = await setup({ intervalMs: 86400000 })
  let count = 0
  const call = (name: string, args: object) =>
    executeTool(f.ctx, {
      name,
      arguments: args,
      agent: f.agent,
      callId: ToolCallId(`feedback-${count++}`),
      signal: new AbortController().signal,
    })
  await call('timeline_tree', { action: 'start', title: 'Review recovery' })
  await call('timeline_tasks', {
    tasks: [
      { id: 'group', title: 'Review' },
      { id: 'leaf', parent: 'group', title: 'Check restart', status: 'active', done: [1, 4] },
      {
        id: 'waiting',
        parent: 'group',
        title: 'Check permissions',
        status: 'blocked',
        note: 'Needs access.',
      },
    ],
  })
  const tree = f.ctx.timeline.stateOf(f.agent.session).view.activeTreeId
  if (tree === null) throw new Error('Missing plan')
  const base = { sessionId: f.agent.session.id, tree, task: taskId.parse('leaf') }
  const view = () => f.ctx.timeline.stateOf(f.agent.session).view
  return { ...f, call, base, view }
}

describe('user-owned Timeline feedback', () => {
  it('acknowledges a saved note retry after its task retires without admitting a new note', async () => {
    const f = await fixture()
    try {
      const request = {
        action: 'annotate' as const,
        sessionId: f.base.sessionId,
        id: randomUUID(),
        target: { kind: 'task' as const, tree: f.base.tree, task: f.base.task },
        text: 'Explain why this check was replaced.',
      }
      await f.ctx.timeline.edit(request)
      const saved = f.view().annotations
      expect(
        (
          await f.call('timeline_tasks', {
            tasks: [{ id: 'leaf', status: 'retired', note: 'Replaced by a broader restart check.' }],
          })
        ).isError,
      ).not.toBe(true)
      await expect(f.ctx.timeline.edit(request)).resolves.toMatchObject({
        action: 'annotate',
        context: { status: 'retired' },
      })
      await expect(f.ctx.timeline.edit({ ...request, id: randomUUID() })).rejects.toThrow(
        'Unknown available Timeline task',
      )
      expect(f.view().annotations).toEqual(saved)
    } finally {
      await f.close()
    }
  })
  it('preserves user priorities and immutable note pairs across model patches, retries, and reload', async () => {
    const f = await fixture()
    try {
      const request = {
        action: 'annotate' as const,
        sessionId: f.base.sessionId,
        id: randomUUID(),
        target: { kind: 'task' as const, tree: f.base.tree, task: f.base.task },
        text: 'Explain what remains after restart.',
      }
      const results = await Promise.all([
        f.ctx.timeline.edit(request),
        f.ctx.timeline.edit({ ...f.base, action: 'priority', priority: 'P0' }),
        f.call('timeline_tasks', {
          tasks: [{ id: 'leaf', done: [2, 4], note: 'Half of the checks passed.' }],
        }),
      ])
      expect(results[2].isError).not.toBe(true)
      expect(f.view().trees[0]?.tasks.find(task => task.id === 'leaf')).toMatchObject({
        priority: 'P0',
        done: [2, 4],
      })
      expect(f.view().annotations).toHaveLength(1)
      const saved = f.view().annotations[0]
      await f.ctx.timeline.edit(request)
      expect(f.view().annotations).toEqual([saved])
      await expect(f.ctx.timeline.edit({ ...request, text: 'Replacement text' })).rejects.toThrow('identity')
      for (const patch of [
        { id: 'leaf', priority: 'P3' },
        { id: 'leaf', annotations: [] },
      ])
        expect((await f.call('timeline_tasks', { tasks: [patch] })).isError).toBe(true)
      expect((await f.call('timeline_reply', { id: randomUUID(), text: 'Invented reply' })).isError).toBe(
        true,
      )
      expect(
        (await f.call('timeline_reply', { id: request.id, text: 'Two restart checks remain.' })).isError,
      ).not.toBe(true)
      const paired = f.view().annotations[0]
      expect(paired).toMatchObject({ text: request.text, reply: { text: 'Two restart checks remain.' } })
      await f.call('timeline_reply', { id: request.id, text: 'Two restart checks remain.' })
      expect(f.view().annotations[0]).toEqual(paired)
      expect((await f.call('timeline_reply', { id: request.id, text: 'Changed reply' })).isError).toBe(true)
      const result = await f.call('timeline_read', { task: 'leaf' })
      expect(JSON.stringify(result.content)).toContain('Two restart checks remain.')
      const savedView = f.view()
      await f.plugin.dispose()
      const loaded = await f.ctx.plugin(Timeline, { intervalMs: 86400000, rollupFactors: [] })
      try {
        expect(f.view()).toEqual(savedView)
      } finally {
        await loaded.dispose()
      }
    } finally {
      await f.close()
    }
  })
  it('links report discussion to exact historical content and retains drafts after failed writes', async () => {
    const f = await fixture()
    try {
      const report = reportSchema.parse({
        id: 'history',
        level: 0,
        start: 1000,
        end: 61000,
        policy: '[60000,5,3]',
        children: [],
        source: 'model',
        toolCount: 1,
        covered: 1,
        contextSeq: 1,
        summary: { progress: ['Restart checks passed.'], uncertainties: [], userActions: [] },
      })
      await f.ctx.timeline.append(f.agent.session, 'plugin:timeline/report', {
        version: 1,
        sessionId: f.base.sessionId,
        report,
      })
      const request = {
        action: 'annotate' as const,
        sessionId: f.base.sessionId,
        id: randomUUID(),
        target: { kind: 'report' as const, report: report.id },
        text: 'Which checks were still missing at that time?',
      }
      const put = vi.spyOn(f.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('Write failed'))
      await expect(f.ctx.timeline.edit(request)).rejects.toThrow('Write failed')
      expect(f.view().annotations).toEqual([])
      put.mockRestore()
      await f.plugin.dispose()
      await f.ctx.plugin(Timeline, { intervalMs: 86400000, rollupFactors: [] })
      const result = await f.ctx.timeline.edit(request)
      expect(result).toMatchObject({
        action: 'annotate',
        context: {
          report: 'history',
          start: new Date(1000).toISOString(),
          end: new Date(61000).toISOString(),
          summary: report.summary,
        },
      })
      await f.call('timeline_reply', {
        id: request.id,
        text: 'The permission checks still needed a test account.',
      })
      const read = await f.call('timeline_read', { report: 'history' })
      expect(JSON.stringify(read.content)).toContain('permission checks')
      expect(f.view().reports).toEqual([report])
      expect((await f.call('timeline_read', { annotation: request.id, task: 'leaf' })).isError).toBe(true)
      expect((await f.call('timeline_read', { annotation: request.id })).isError).not.toBe(true)
    } finally {
      await f.close()
    }
  })
  it('does not send an expired priority notice or fail a running turn when injection throws', async () => {
    const f = await fixture()
    try {
      f.start()
      await f.adapter.ready.promise
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const inject = vi.spyOn(f.agent, 'inject').mockImplementationOnce(() => { throw new Error('Inbox unavailable') })
      await f.ctx.timeline.edit({ ...f.base, action: 'priority', priority: 'P0' })
      await vi.advanceTimersByTimeAsync(750)
      expect(inject).toHaveBeenCalledOnce()
      expect(f.agent.status).toBe('running')
      await f.ctx.timeline.edit({ ...f.base, action: 'priority', priority: null })
      f.adapter.release.resolve(undefined)
      await f.agent.whenIdle()
      await vi.advanceTimersByTimeAsync(750)
      expect(inject).toHaveBeenCalledOnce()
      await f.plugin.dispose()
      inject.mockRestore()
    } finally {
      vi.useRealTimers()
      await f.close()
    }
  })
  it('inherits priority without changing completion and coalesces only P0 notices for running work', async () => {
    const f = await fixture()
    try {
      await f.ctx.timeline.edit({
        ...f.base,
        task: taskId.parse('group'),
        action: 'priority',
        priority: 'P1',
      })
      expect(prioritiesOf(f.view().trees[0]?.tasks ?? []).get(taskId.parse('leaf'))).toBe('P1')
      expect(f.agent.inbox.nextStep).toEqual([])
      f.start()
      await f.adapter.ready.promise
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await f.ctx.timeline.edit({ ...f.base, action: 'priority', priority: 'P2' })
      await vi.advanceTimersByTimeAsync(1000)
      expect(
        f.agent.inbox.nextStep.filter(message => message.source.kind === 'timeline-priority'),
      ).toHaveLength(0)
      for (const priority of ['P0', null, 'P0'] as const)
        await f.ctx.timeline.edit({ ...f.base, action: 'priority', priority })
      await vi.advanceTimersByTimeAsync(749)
      expect(
        f.agent.inbox.nextStep.filter(message => message.source.kind === 'timeline-priority'),
      ).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(
        f.agent.inbox.nextStep.filter(message => message.source.kind === 'timeline-priority'),
      ).toHaveLength(1)
      await f.ctx.timeline.edit({ ...f.base, action: 'priority', priority: null })
      await vi.advanceTimersByTimeAsync(750)
      const notices = f.agent.inbox.nextStep.filter(message => message.source.kind === 'timeline-priority')
      expect(notices).toHaveLength(1)
      const urgentText: unknown = expect.stringContaining('"priority":"P0"')
      expect(notices.flatMap(message => message.content)).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: urgentText }),
        ]),
      )
      await f.ctx.timeline.edit({
        ...f.base,
        task: taskId.parse('group'),
        action: 'priority',
        priority: 'P0',
      })
      await vi.advanceTimersByTimeAsync(750)
      expect(f.agent.inbox.nextStep.flatMap(message => message.content)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: urgentText }),
        ]),
      )
      await f.ctx.timeline.edit({ ...f.base, action: 'priority', priority: 'P3' })
      await vi.advanceTimersByTimeAsync(750)
      expect(f.agent.inbox.nextStep.flatMap(message => message.content)).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: urgentText }),
        ]),
      )
      expect(f.view().trees[0]?.tasks.find(task => task.id === 'leaf')?.done).toEqual([1, 4])
      await f.plugin.dispose()
      expect(
        f.agent.inbox.nextStep.filter(message => message.source.kind === 'timeline-priority'),
      ).toHaveLength(0)
    } finally {
      vi.useRealTimers()
      await f.close()
    }
  })
})
