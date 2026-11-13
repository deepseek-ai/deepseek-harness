import { executeTool } from './execute-tool.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Checkpoint } from '../src/checkpoint.ts'
import { taskId, treeSchema } from '../src/records.ts'
import { setup } from './fixture.ts'

const fixtures: Awaited<ReturnType<typeof setup>>[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const f of fixtures.splice(0)) await f.close()
})
async function fixture() {
  const f = await setup()
  fixtures.push(f)
  let sequence = 0
  const call = (name: string, args: object, id = `history-${sequence++}`) =>
    executeTool(f.ctx, {
      name,
      arguments: args,
      callId: ToolCallId(id),
      agent: f.agent,
      signal: new AbortController().signal,
    })
  await call('timeline_tree', { action: 'start', title: 'Verify saved revisions' })
  return { f, call }
}

describe('internal task revision history', () => {
  it('records edits and derived group progress once, without recording no-ops or failed batches', async () => {
    const { f, call } = await fixture()
    expect(
      (
        await call('timeline_tasks', {
          tasks: [
            { id: 'group', title: 'Check recovery' },
            { id: 'check', parent: 'group', title: 'Verify restart', description: 'Original scope.' },
          ],
        })
      ).isError,
    ).not.toBe(true)
    const current = () => {
      const tree = f.ctx.timeline.stateOf(f.agent.session).view.trees[0]
      if (tree === undefined) throw new Error('Missing task tree')
      return tree
    }
    const old = current()
    const args = {
      tasks: [{ id: 'check', done: [1, 2], description: 'Revised scope.', note: 'Restart works.' }],
    }
    await call('timeline_tasks', args, 'repeatable-edit')
    await call('timeline_tasks', args, 'repeatable-edit')
    const tree = current()
    expect(tree.tasks.map(task => task.history.length)).toEqual([2, 2])
    expect(tree.tasks[0]?.history.at(-1)).toMatchObject({ previousProgress: 0, progress: 0.5 })
    expect(tree.tasks[1]?.history.at(-1)).toMatchObject({
      previousProgress: 0,
      progress: 0.5,
      description: 'Revised scope.',
      note: 'Restart works.',
    })
    expect(tree.tasks[1]?.history[0]?.description).toBe('Original scope.')
    expect(old.tasks[1]?.history).toHaveLength(1)
    await call('timeline_tasks', { tasks: [{ id: 'check', title: 'Verify restart' }] })
    expect(current().tasks[1]?.history).toHaveLength(2)
    expect(
      (await call('timeline_tasks', { tasks: [{ id: 'check', parent: 'missing', note: 'Invalid move.' }] }))
        .isError,
    ).toBe(true)
    expect(current().tasks[1]?.history).toEqual(tree.tasks[1]?.history)
    expect((await call('timeline_tasks', { tasks: [{ id: 'check', history: [] }] })).isError).toBe(true)
    await f.ctx.timeline.edit({
      action: 'priority',
      sessionId: f.agent.session.id,
      tree: tree.id,
      task: taskId.parse('check'),
      priority: 'P2',
    })
    expect(current().tasks[1]?.history.at(-1)?.priority).toBe('P2')
    await call('timeline_tasks', {
      tasks: [{ id: 'group', status: 'retired', subtree: true, note: 'Scope removed.' }],
    })
    expect(current().tasks.every(task => task.history.at(-1)?.status === 'retired')).toBe(true)
    expect(
      treeSchema
        .parse({
          ...tree,
          tasks: tree.tasks.map(task => ({ ...task, history: undefined })),
        })
        .tasks.every(task => task.history.length === 0),
    ).toBe(true)
  })

  it('retains each revision and its description without repeating full task details', async () => {
    const { f, call } = await fixture()
    const details = 'Evidence '.repeat(400)
    await call('timeline_tasks', { tasks: [{ id: 'check', title: 'Verify restart', description: 'Check recovery.', details }] })
    expect((await call('timeline_tasks', { tasks: [{ id: 'check', done: [1, 2], note: 'Restart check passed.' }] })).isError).not.toBe(true)
    await call('timeline_tasks', { tasks: [{ id: 'check', details: `${details}Updated.` }] })
    const task = f.ctx.timeline.stateOf(f.agent.session).view.trees[0]?.tasks[0]
    expect(task?.details).toBe(`${details}Updated.`)
    expect(task?.history.map(revision => [revision.description, revision.details.length])).toEqual([
      ['Check recovery.', 400], ['Check recovery.', 0], ['Check recovery.', 400],
    ])
  })
  it('keeps history through restart and checkpoints but excludes it from agent and report inputs', async () => {
    const { f, call } = await fixture()
    const archived = 'Archived text visible only in change history.'
    await call('timeline_tasks', { tasks: [{ id: 'check', title: 'Verify restart', description: archived }] })
    await call('timeline_tasks', {
      tasks: [{ id: 'check', description: 'Current scope.', details: 'The saved plan can reopen.' }],
    })
    for (const [name, args] of [
      ['timeline_read', {}],
      ['timeline_read', { task: 'check' }],
      ['timeline_pull', {}],
    ] as const) {
      const result = JSON.stringify((await call(name, args)).content)
      expect(result).not.toContain(archived)
      expect(result).not.toContain('history')
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    f.start()
    await f.adapter.ready.promise
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report')
    expect(f.adapter.checks).toHaveLength(1)
    expect(JSON.stringify([...f.adapter.main, ...f.adapter.checks])).not.toContain(archived)
    const tree = f.ctx.timeline.stateOf(f.agent.session).view.trees[0]
    if (tree === undefined) throw new Error('Missing task tree')
    const file = Checkpoint.fromTree(tree, [], Date.now(), f.agent.session.id).toString()
    const restored = Checkpoint.fromString(file).restore('copy', Date.now()).tree
    expect(restored.tasks[0]?.history).toEqual(tree.tasks[0]?.history)
    const root = f.root
    const sessionId = f.agent.session.id
    vi.useRealTimers()
    await f.close({ preserve: true })
    fixtures.splice(fixtures.indexOf(f), 1)
    const next = await setup({}, undefined, { root, sessionId })
    fixtures.push(next)
    expect(next.ctx.timeline.stateOf(next.agent.session).view.trees[0]?.tasks[0]?.history).toEqual(
      tree.tasks[0]?.history,
    )
  })

  it('does not publish a new revision when its durable write fails', async () => {
    const { f, call } = await fixture()
    await call('timeline_tasks', { tasks: [{ id: 'check', title: 'Verify restart' }] })
    const before = f.ctx.timeline.stateOf(f.agent.session).view.trees
    vi.spyOn(f.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('Write failed'))
    expect(
      (await call('timeline_tasks', { tasks: [{ id: 'check', details: 'This write fails.' }] })).isError,
    ).toBe(true)
    expect(f.ctx.timeline.stateOf(f.agent.session).view.trees).toEqual(before)
  })
})
