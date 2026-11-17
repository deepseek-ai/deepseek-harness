import { executeTool } from './execute-tool.ts'
import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { taskId } from '../src/records.ts'
import { setup } from './fixture.ts'

const resultSchema = z.object({
  tree: z.object({ id: z.string(), title: z.string() }).nullable(),
  next: z.enum(['work', 'recheck-blocked', 'paused', 'done', 'plan']),
  counts: z.object({
    active: z.number(),
    pending: z.number(),
    blocked: z.number(),
    paused: z.number(),
    done: z.number(),
  }),
  tasks: z.array(
    z.object({
      id: z.string(),
      parent: z.string().nullable(),
      title: z.string(),
      status: z.string(),
      done: z.array(z.number()),
      note: z.string(),
      priority: z.string().nullable(),
    }),
  ),
  total: z.number(),
  hasMore: z.boolean(),
})

async function scenario() {
  const f = await setup({ intervalMs: 86400000 })
  let count = 0
  const call = (name: string, args: object = {}) =>
    executeTool(f.ctx, {
      name,
      arguments: args,
      agent: f.agent,
      callId: ToolCallId(`pull-${count++}`),
      signal: new AbortController().signal,
    })
  const pull = async (args: object = {}) => {
    const result = await call('timeline_pull', args)
    expect(result.isError).not.toBe(true)
    return resultSchema.parse(
      JSON.parse(result.content.find(block => block.type === 'text')?.text ?? 'null'),
    )
  }
  return { ...f, call, pull }
}

describe('next-work checkpoints', () => {
  it('does not create a plan on an empty session and rejects unknown or invalid queries', async () => {
    const f = await scenario()
    try {
      expect(await f.pull()).toMatchObject({ tree: null, next: 'plan', tasks: [], total: 0, hasMore: false })
      for (const args of [{ tree: 'tree-missing' }, { limit: 0 }, { limit: 501 }, { limit: 1.5 }])
        expect((await f.call('timeline_pull', args)).isError).toBe(true)
      expect(f.ctx.timeline.stateOf(f.agent.session).view.trees).toEqual([])
    } finally {
      await f.close()
    }
  })

  it('prefers inherited user priority, then active leaves, without editing or returning groups', async () => {
    const f = await scenario()
    try {
      await f.call('timeline_tree', { action: 'start', title: 'Deliver the requested work' })
      await f.call('timeline_tasks', {
        tasks: [
          { id: 'group', title: 'Implementation' },
          { id: 'active', parent: 'group', title: 'Finish active work', status: 'active', done: [1, 4] },
          { id: 'pending', parent: 'group', title: 'Next check' },
          { id: 'urgent', title: 'Urgent delivery' },
          { id: 'urgent-child', parent: 'urgent', title: 'Prepare the delivery' },
          { id: 'blocked', title: 'Check service', status: 'blocked', note: 'The service is unavailable.' },
          { id: 'paused', title: 'Deferred work', status: 'paused', note: 'The user paused this work.' },
        ],
      })
      const tree = f.ctx.timeline.stateOf(f.agent.session).view.activeTreeId
      if (tree === null) throw new Error('Missing tree')
      await f.ctx.timeline.edit({
        action: 'priority',
        sessionId: f.agent.session.id,
        tree,
        task: taskId.parse('urgent'),
        priority: 'P0',
      })
      const before = structuredClone(f.ctx.timeline.stateOf(f.agent.session).view)
      expect(await f.pull()).toMatchObject({
        next: 'work',
        tasks: [{ id: 'urgent-child', priority: 'P0' }, { id: 'active', done: [1, 4] }, { id: 'pending' }],
        counts: { active: 1, pending: 2, blocked: 1, paused: 1, done: 0 },
      })
      expect(f.ctx.timeline.stateOf(f.agent.session).view).toEqual(before)
    } finally {
      await f.close()
    }
  })

  it('rechecks blockers after runnable work ends and preserves deliberate pauses', async () => {
    const f = await scenario()
    try {
      await f.call('timeline_tree', { action: 'start', title: 'Check dependencies' })
      await f.call('timeline_tasks', {
        tasks: [
          { id: 'work', title: 'Prepare data', status: 'active' },
          {
            id: 'dependency',
            title: 'Use prepared data',
            status: 'blocked',
            note: 'Prepared data is missing.',
          },
          { id: 'paused', title: 'Optional follow-up', status: 'paused', note: 'The user deferred it.' },
          { id: 'retired', title: 'Obsolete work', status: 'retired', note: 'No longer requested.' },
        ],
      })
      await f.call('timeline_tasks', {
        tasks: [{ id: 'work', status: 'done', note: 'Prepared data is now saved.' }],
      })
      expect(await f.pull()).toMatchObject({
        next: 'recheck-blocked',
        tasks: [{ id: 'dependency', note: 'Prepared data is missing.' }],
        counts: { active: 0, pending: 0, blocked: 1, paused: 1, done: 1 },
      })
      await f.call('timeline_tasks', {
        tasks: [{ id: 'dependency', status: 'active', note: 'The saved data is now available.' }],
      })
      expect(await f.pull()).toMatchObject({ next: 'work', tasks: [{ id: 'dependency', status: 'active' }] })
      await f.call('timeline_tasks', {
        tasks: [{ id: 'dependency', status: 'done', note: 'The prepared data passed the check.' }],
      })
      expect(await f.pull()).toMatchObject({
        next: 'paused',
        tasks: [],
        counts: { blocked: 0, paused: 1, done: 2 },
      })
      await f.call('timeline_tasks', {
        tasks: [{ id: 'paused', status: 'done', note: 'The user resumed it and its result is verified.' }],
      })
      expect(await f.pull()).toMatchObject({ next: 'done', tasks: [], counts: { done: 3 } })
    } finally {
      await f.close()
    }
  })

  it('keeps persistent blockers visible after their reasons are reconfirmed', async () => {
    const f = await scenario()
    try {
      await f.call('timeline_tree', { action: 'start', title: 'Publish the result' })
      await f.call('timeline_tasks', {
        tasks: [
          {
            id: 'access',
            title: 'Verify publishing access',
            status: 'blocked',
            note: 'A test account is required.',
          },
        ],
      })
      await f.call('timeline_tasks', {
        tasks: [{ id: 'access', status: 'blocked', note: 'Rechecked: no test account is available.' }],
      })
      expect(await f.pull()).toMatchObject({
        next: 'recheck-blocked',
        tasks: [{ id: 'access', status: 'blocked', note: 'Rechecked: no test account is available.' }],
      })
    } finally {
      await f.close()
    }
  })

  it('bounds suggestions and permits a complete blocker check when the default is truncated', async () => {
    const f = await scenario()
    try {
      await f.call('timeline_tree', { action: 'start', title: 'Check remaining work' })
      await f.call('timeline_tasks', {
        tasks: Array.from({ length: 15 }, (_, index) => ({
          id: `check-${index}`,
          title: `Check access ${index}`,
          status: 'blocked',
          note: 'Needs access.',
        })),
      })
      const short = await f.pull()
      expect(short.tasks).toHaveLength(12)
      expect(short).toMatchObject({ total: 15, hasMore: true, counts: { blocked: 15 } })
      const full = await f.pull({ limit: 15 })
      expect(full.tasks).toHaveLength(15)
      expect(full.hasMore).toBe(false)
    } finally {
      await f.close()
    }
  })

  it('checks only the addressed goal and never selects or resumes a different tree', async () => {
    const f = await scenario()
    try {
      await f.call('timeline_tree', { action: 'start', title: 'Earlier goal' })
      await f.call('timeline_tasks', {
        tasks: [{ id: 'earlier', title: 'Earlier active work', status: 'active' }],
      })
      const earlier = f.ctx.timeline.stateOf(f.agent.session).view.activeTreeId
      await f.call('timeline_tree', { action: 'start', title: 'Current goal' })
      expect(await f.pull()).toMatchObject({ next: 'plan' })
      await f.call('timeline_tasks', { tasks: [{ id: 'current', title: 'Current result', status: 'done' }] })
      const selected = f.ctx.timeline.stateOf(f.agent.session).view.activeTreeId
      expect(await f.pull()).toMatchObject({ next: 'done', tasks: [] })
      expect(await f.pull({ tree: earlier })).toMatchObject({ next: 'work', tasks: [{ id: 'earlier' }] })
      expect(f.ctx.timeline.stateOf(f.agent.session).view.activeTreeId).toBe(selected)
    } finally {
      await f.close()
    }
  })
})
