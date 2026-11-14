import { executeTool } from './execute-tool.ts'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { newId, reportSchema, taskId } from '../src/records.ts'
import { Adapter, setup } from './fixture.ts'

const fixtures: Awaited<ReturnType<typeof setup>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close()
})

async function fixture() {
  const f = await setup({ intervalMs: 86400000 })
  fixtures.push(f)
  return f
}

function call(f: Awaited<ReturnType<typeof setup>>, name: string, args: object) {
  return executeTool(f.ctx, {
    name,
    arguments: args,
    agent: f.agent,
    callId: ToolCallId(randomUUID()),
    signal: new AbortController().signal,
  })
}

async function seed(f: Awaited<ReturnType<typeof setup>>) {
  expect((await call(f, 'timeline_tree', { action: 'start', title: 'Recovery review' })).isError).not.toBe(
    true,
  )
  expect(
    (
      await call(f, 'timeline_tasks', {
        tasks: [{ id: 'check', title: 'Check recovery', status: 'active', done: [1, 3], weight: 2.5 }],
      })
    ).isError,
  ).not.toBe(true)
  const tree = f.ctx.timeline.stateOf(f.agent.session).view.activeTreeId
  if (tree === null) throw new Error('Missing tree')
  return tree
}

async function restart(f: Awaited<ReturnType<typeof setup>>, adapter = new Adapter()) {
  const restore = { root: f.root, sessionId: f.agent.session.id }
  await f.close({ preserve: true })
  fixtures.splice(fixtures.indexOf(f), 1)
  const next = await setup({ intervalMs: 86400000 }, adapter, restore)
  fixtures.push(next)
  return next
}

describe('session-scoped Timeline persistence', () => {
  it('reopens an ordinary saved Session without creating a plan or disrupting its next turn', async () => {
    const f = await fixture()
    await f.ctx.sessions.flush(f.agent.session)
    const adapter = new Adapter()
    adapter.calls = 0
    adapter.release.resolve(undefined)
    const next = await restart(f, adapter)
    expect(next.ctx.timeline.available(next.agent.session)).toBe(true)
    expect(next.ctx.timeline.stateOf(next.agent.session).view.trees).toEqual([])
    next.start()
    await adapter.ready.promise
    await next.agent.whenIdle()
    expect(JSON.stringify(next.agent.session.deriveMessages())).toContain('Main task finished.')
    expect(next.ctx.timeline.stateOf(next.agent.session).view.error).toBeNull()
    expect(next.ctx.timeline.stateOf(next.agent.session).view.annotations).toEqual([])
    expect(next.ctx.timeline.stateOf(next.agent.session).view.reports).toEqual([])
  })
  it('restores plans, user priority, discussion pairs and report coverage in a fresh host', async () => {
    const f = await fixture()
    const tree = await seed(f)
    await f.ctx.timeline.edit({
      action: 'priority',
      sessionId: f.agent.session.id,
      tree,
      task: taskId.parse('check'),
      priority: 'P0',
    })
    const id = newId('note')
    await f.ctx.timeline.edit({
      action: 'annotate',
      sessionId: f.agent.session.id,
      id,
      target: { kind: 'task', tree, task: taskId.parse('check') },
      text: 'Check the saved recovery result.',
    })
    expect((await call(f, 'timeline_reply', { id, text: 'The saved result is retained.' })).isError).not.toBe(
      true,
    )
    const end = Date.now()
    await f.ctx.timeline.append(f.agent.session, 'plugin:timeline/report', {
      version: 1,
      sessionId: f.agent.session.id,
      report: reportSchema.parse({
        id: newId('report'),
        level: 0,
        start: end - 60000,
        end,
        policy: '[60000,5,3]',
        children: [],
        source: 'model',
        toolCount: 0,
        covered: 0,
        contextSeq: 0,
        workMs: 60000,
        ranges: [[end - 60000, end]],
        summary: {
          progress: [
            'The saved recovery result is retained.',
            'The task keeps its completed units after restart.',
            'The user priority and discussion reply remain attached.',
            'No new report query ran during recovery.',
          ],
          uncertainties: [],
          userActions: [],
        },
      }),
    })
    const saved = f.ctx.timeline.stateOf(f.agent.session)
    const next = await restart(f)
    const current = next.ctx.timeline.stateOf(next.agent.session)
    expect(current.view.trees).toEqual(saved.view.trees)
    expect(current.calls).toEqual(saved.calls)
    expect(current.view.annotations).toEqual(saved.view.annotations)
    expect(current.view.reports).toEqual(saved.view.reports)
    expect(current.lastReportEnd).toBe(saved.lastReportEnd)
    expect(next.adapter.checks).toHaveLength(0)
  })

  it('does not reapply an older tool call after newer checkpoints, selection changes, or restart', async () => {
    const f = await fixture()
    const tree = await seed(f)
    const first = {
      name: 'timeline_tasks',
      arguments: { tasks: [{ id: 'check', done: [2, 3], note: 'The second check completed.' }] },
      callId: ToolCallId('retained-checkpoint'),
      signal: new AbortController().signal,
    }
    expect((await executeTool(f.ctx, { ...first, agent: f.agent })).isError).not.toBe(true)
    expect(
      (
        await call(f, 'timeline_tasks', {
          tasks: [{ id: 'check', status: 'done', note: 'All checks completed.' }],
        })
      ).isError,
    ).not.toBe(true)
    await call(f, 'timeline_tree', { action: 'start', title: 'Another goal' })
    const next = await restart(f)
    const selected = next.ctx.timeline.stateOf(next.agent.session).view.activeTreeId
    const result = await executeTool(next.ctx, { ...first, agent: next.agent })
    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result.content)).toContain(tree)
    const current = next.ctx.timeline.stateOf(next.agent.session).view
    expect(current.activeTreeId).toBe(selected)
    expect(current.trees.find(item => item.id === tree)?.tasks[0]?.done).toEqual([3, 3])
  })
})
