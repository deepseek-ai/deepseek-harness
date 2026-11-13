import { executeTool } from './execute-tool.ts'
import { describe, expect, it, vi } from 'vitest'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { textOutput } from './fixture.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config } from '../src/config.ts'
import type { PluginConfig } from '../src/config.ts'
import { newId, taskId } from '../src/records.ts'
import { delegationContext } from '../src/delegation.ts'
import { setup } from './fixture.ts'

describe('manager-owned delegated planning', () => {
  it('limits guidance when restored worker ancestry is missing or cyclic', async () => {
    const f = await setup({ intervalMs: 86400000 })
    const create = async (id: SessionId, parentSession?: SessionId) => (
      await f.ctx.agents.create({
        sessionId: id,
        meta: { origin: 'subagent', ...(parentSession === undefined ? {} : { parentSession }) },
      })
    ).agent
    const guidance = (agent: typeof f.agent) => delegationContext(f.ctx, agent, f.ctx.timeline)
    try {
      const detached = await create(SessionId('worker-detached'))
      expect(guidance(detached)).toBe('Report assigned work to the delegating agent.')
      const child = await create(SessionId('worker-detached-child'), detached.session.id)
      expect(guidance(child)).toContain(`parent ${detached.session.id}`)
      expect(guidance(child)).not.toContain('plan owner')
      const left = SessionId('worker-left')
      const right = SessionId('worker-right')
      const worker = await create(left, right)
      await create(right, left)
      expect(guidance(worker)).toBe(`Report assigned work to parent ${right}.`)
    } finally {
      await f.close()
    }
  })
  it('hides worker planning, keeps user forks independent, and shares bounded assignment references', async () => {
    const f = await setup({ intervalMs: 86400000, language: 'zh-CN' })
    let sequence = 0
    const call = (name: string, args: object) =>
      executeTool(f.ctx, {
        name,
        arguments: args,
        callId: ToolCallId(`manager-${sequence++}`),
        agent: f.agent,
        signal: new AbortController().signal,
      })
    try {
      await call('timeline_tree', { action: 'start', title: 'Verify session recovery' })
      await call('timeline_tasks', {
        tasks: [{ id: 'restore', title: 'Restore saved work', status: 'active' }],
      })
      const firstTree = f.ctx.timeline.stateOf(f.agent.session).view.activeTreeId
      const worker = (
        await f.ctx.agents.create({
          sessionId: SessionId('timeline-worker'),
          meta: { origin: 'subagent', parentSession: f.agent.session.id },
          agentOptions: { provider: 'fixture', model: 'timeline' },
        })
      ).agent
      const nested = (
        await f.ctx.agents.create({
          sessionId: SessionId('timeline-nested-worker'),
          meta: { origin: 'subagent', parentSession: worker.session.id },
          agentOptions: { provider: 'fixture', model: 'timeline' },
        })
      ).agent
      const fork = (
        await f.ctx.agents.create({
          sessionId: SessionId('timeline-user-fork'),
          meta: { parentSession: f.agent.session.id },
          agentOptions: { provider: 'fixture', model: 'timeline' },
        })
      ).agent
      for (const agent of [worker, nested]) {
        expect(f.ctx.tools.schemas(agent).some(tool => tool.name.startsWith('timeline_'))).toBe(false)
        const prompt = await f.ctx.systemPrompt.assemble({ agent, scope: agent })
        const guidance = prompt.sections.find(section => section.name === 'timeline:planning')?.text
        expect(guidance).toContain('The manager owns the shared Timeline tree')
        expect(guidance).not.toContain('timeline_pull')
        expect(guidance).not.toContain('简体中文')
        expect(guidance).not.toContain('task-tree content only')
        const context = prompt.contexts.find(context => context.name === 'timeline:state')?.text
        expect(context).toContain(firstTree)
        expect(context).toContain(`plan owner ${f.agent.session.id}`)
        expect(context).toContain('latest assignment message')
        expect(context).not.toContain('Restore saved work')
        expect(f.ctx.timeline.stateOf(agent.session).view.trees).toHaveLength(0)
      }
      expect(f.ctx.tools.schemas(fork).some(tool => tool.name === 'timeline_tree')).toBe(true)
      const signal = new AbortController().signal
      const before = await f.ctx.systemPrompt.assemble({ agent: worker, scope: worker, signal })
      await call('timeline_tree', { action: 'start', title: 'Review the next release' })
      const secondTree = f.ctx.timeline.stateOf(f.agent.session).view.activeTreeId
      const sameTurn = await f.ctx.systemPrompt.assemble({ agent: worker, scope: worker, signal })
      expect(sameTurn.contexts).toEqual(before.contexts)
      const nextTurn = await f.ctx.systemPrompt.assemble({
        agent: worker,
        scope: worker,
        signal: new AbortController().signal,
      })
      expect(nextTurn.contexts.find(context => context.name === 'timeline:state')?.text).toContain(
        secondTree,
      )
      updateVolatile((f.plugin.effectiveConfig as PluginConfig).allowTodo, Config({ allowTodo: true }).allowTodo)
      expect(f.ctx.tools.get('timeline_tasks', worker)).toBeUndefined()
      await f.plugin.dispose()
      // An agent-local restriction must not survive the plugin that owns it.
      f.ctx.tools.register(
        defineTool({
          name: 'timeline_tasks',
          description: 'Replacement planning tool',
          parameters: {},
          output: textOutput,
          execute: () => Promise.resolve('Available'),
        }),
      )
      expect(f.ctx.tools.get('timeline_tasks', worker)).toBeDefined()
      expect(
        (
          await executeTool(f.ctx, {
            name: 'timeline_tasks',
            arguments: {},
            agent: worker,
            callId: ToolCallId('unloaded-worker-mask'),
            signal: new AbortController().signal,
          })
        ).isError,
      ).not.toBe(true)
    } finally {
      await f.close()
    }
  })

  it('denies stale and agent-local worker writes without changing manager tasks or discussions', async () => {
    const f = await setup({ intervalMs: 86400000 })
    let sequence = 0
    const call = (agent: typeof f.agent, name: string, args: object) =>
      executeTool(f.ctx, {
        name,
        arguments: args,
        callId: ToolCallId(`ownership-${sequence++}`),
        agent,
        signal: new AbortController().signal,
      })
    try {
      await call(f.agent, 'timeline_tree', { action: 'start', title: 'Recovery checks' })
      await call(f.agent, 'timeline_tasks', {
        tasks: [{ id: 'restore', title: 'Restore saved work', status: 'active', done: [1, 4] }],
      })
      const tree = f.ctx.timeline.stateOf(f.agent.session).view.activeTreeId
      if (tree === null) throw new Error('The manager tree must exist')
      const annotation = newId('note')
      await f.ctx.timeline.edit({
        action: 'annotate',
        sessionId: f.agent.session.id,
        id: annotation,
        target: { kind: 'task', tree, task: taskId.parse('restore') },
        text: 'Check whether restart preserves notes.',
      })
      f.ctx.tools.register(defineTool({
        name: 'todo_write', description: 'Inherited Todo', parameters: {}, output: textOutput,
        execute: () => Promise.resolve('Unexpected write'),
      }))
      const worker = (
        await f.ctx.agents.create({
          sessionId: SessionId('timeline-stale-worker'),
          meta: { origin: 'subagent', parentSession: f.agent.session.id },
          agentOptions: { provider: 'fixture', model: 'timeline' },
        })
      ).agent
      expect(f.ctx.tools.get('todo_write', worker)).toBeUndefined()
      let writes = 0
      worker.ctx.tools.register(
        defineTool({
          name: 'timeline_tasks',
          description: 'Agent-local override',
          parameters: {},
          output: textOutput,
          execute: () => {
            writes++
            return Promise.resolve('Unexpected write')
          },
        }),
      )
      for (const name of ['timeline_tree', 'todo_write']) {
        worker.ctx.tools.register(defineTool({
          name, description: 'Agent-local override', parameters: {}, output: textOutput,
          execute: () => Promise.resolve('Unexpected write'),
        }))
      }
      const todo = await call(worker, 'todo_write', {})
      expect(todo).toMatchObject({ isError: true, error: { info: { code: 'TIMELINE_TOOL_UNAVAILABLE' } } })
      expect(JSON.stringify(todo.content)).toContain('delegating agent owns the shared task tree')
      for (const name of ['timeline_tasks', 'timeline_read', 'timeline_reply', 'timeline_pull']) {
        const denied = await call(worker, name, { tree, id: annotation, tasks: [] })
        expect(denied.isError).toBe(true)
      }
      expect(writes).toBe(0)
      expect(f.ctx.timeline.stateOf(worker.session).view.trees).toHaveLength(0)
      expect(f.ctx.timeline.stateOf(f.agent.session).view.trees[0]?.tasks[0]).toMatchObject({
        status: 'active',
        done: [1, 4],
      })
      const id = f.ctx.timeline.stateOf(f.agent.session).view.annotations[0]?.id
      expect(id).toBeDefined()
      await call(f.agent, 'timeline_tasks', {
        tasks: [{ id: 'restore', status: 'blocked', note: 'The restart fixture is missing.' }],
      })
      await call(f.agent, 'timeline_tasks', {
        tasks: [{ id: 'restore', status: 'done', note: 'Restart preserves saved notes.' }],
      })
      const result = await call(f.agent, 'timeline_reply', { id, text: 'Saved notes survive restart.' })
      expect(result.isError).not.toBe(true)
      expect(f.ctx.timeline.stateOf(f.agent.session).view.annotations[0]?.reply?.text).toContain(
        'Saved notes survive restart',
      )
    } finally {
      await f.close()
    }
  })

  it('runs worker iterations without planning reminders or separate timed reports', async () => {
    const f = await setup({ reminderIterations: 2, intervalMs: 60000 })
    try {
      const worker = (
        await f.ctx.agents.create({
          sessionId: SessionId('timeline-long-worker'),
          meta: { origin: 'subagent', parentSession: f.agent.session.id },
          agentOptions: { provider: 'fixture', model: 'timeline' },
        })
      ).agent
      f.adapter.steps = 5
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
      worker.followup(
        createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'Check the assigned restart case and report evidence.' }],
        }),
      )
      await f.adapter.ready.promise
      await vi.advanceTimersByTimeAsync(5 * 60000)
      expect(JSON.stringify(f.adapter.main)).not.toContain('Task progress checkpoint')
      expect(f.adapter.checks).toHaveLength(0)
      expect(f.ctx.timeline.stateOf(worker.session).view.reports).toHaveLength(0)
      expect(f.ctx.timeline.stateOf(worker.session).view.trees).toHaveLength(0)
    } finally {
      vi.useRealTimers()
      await f.close()
    }
  })
})
