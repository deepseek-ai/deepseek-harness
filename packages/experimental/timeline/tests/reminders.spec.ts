import { executeTool } from './execute-tool.ts'
import { describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import { Config } from '../src/config.ts'
import type { PluginConfig } from '../src/config.ts'
import { newId, taskId } from '../src/records.ts'
import { Adapter, setup } from './fixture.ts'

const reminders = (options: Adapter['main'][number] | undefined) =>
  options?.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .match(/Task progress checkpoint/g)?.length ?? 0
const checkpoint = (options: Adapter['main'][number] | undefined) =>
  options?.messages
    .findLast(message => message.role === 'user' && String(message.source?.kind) === 'runtime-context')
    ?.content.some(block => block.type === 'text' && block.text.includes('Task progress checkpoint')) ??
  false

describe('stale task-tree reminders', () => {
  it('reports unavailable persistence and keeps that context stable within the turn', async () => {
    const f = await setup({ intervalMs: 86400000 })
    const available = vi.spyOn(f.ctx.timeline, 'available').mockReturnValue(false)
    try {
      const context = async (signal?: AbortSignal) => {
        const prompt = await f.ctx.systemPrompt.assemble({
          agent: f.agent, scope: f.agent, ...(signal === undefined ? {} : { signal }),
        })
        return prompt.contexts.find(item => item.name === 'timeline:state')?.text
      }
      expect(await context()).toContain('Timeline storage is unavailable')
      const signal = new AbortController().signal
      const before = await context(signal)
      expect(before).toContain('preserve saved plans')
      available.mockRestore()
      expect(await context(signal)).toBe(before)
      expect(await context()).not.toContain('storage is unavailable')
    } finally {
      available.mockRestore()
      await f.close()
    }
  })
  it('keeps one saved-plan snapshot per turn and refreshes it on the next turn, preserving progress', async () => {
    const f = await setup({ intervalMs: 86400000 })
    let count = 0
    const call = (name: string, args: object) =>
      executeTool(f.ctx, {
        name,
        arguments: args,
        callId: ToolCallId(`resume-context-${count++}`),
        agent: f.agent,
        signal: new AbortController().signal,
      })
    try {
      await call('timeline_tree', { action: 'start', title: 'Previous release' })
      await call('timeline_tasks', { tasks: [{ id: 'archive', title: 'Archive the previous release' }] })
      await call('timeline_tree', { action: 'start', title: 'Recover the study planner' })
      await call('timeline_tasks', {
        tasks: [
          { id: 'goal', title: 'Release acceptance' },
          { id: 'group', parent: 'goal', title: 'Application review' },
          {
            id: 'review',
            parent: 'group',
            title: 'Review timer recovery',
            status: 'paused',
            done: [1, 4],
            note: 'User requested a checkpoint.',
          },
          {
            id: 'permission',
            parent: 'group',
            title: 'Verify permissions',
            status: 'blocked',
            note: 'Waiting for a test account.',
          },
        ],
      })
      f.start()
      await f.adapter.ready.promise
      const captured = JSON.stringify(f.adapter.main[0]?.messages)
      expect(captured).toContain('Current Timeline plan (turn-start state, not a new request)')
      expect(captured).toContain('Review timer recovery')
      expect(captured).toContain('Application review')
      expect(captured).toContain('Release acceptance')
      expect(captured).toContain('Previous release')
      expect(captured).not.toContain('Archive the previous release')
      expect(captured).toContain('groups')
      expect(captured).toContain('Waiting for a test account.')
      const view = f.ctx.timeline.stateOf(f.agent.session).view
      expect(
        view.trees.find(tree => tree.id === view.activeTreeId)?.tasks.find(task => task.id === 'review'),
      ).toMatchObject({ status: 'paused', done: [1, 4] })
      await call('timeline_tasks', {
        tasks: [{ id: 'review', status: 'active', note: 'The user asked to continue timer recovery.' }],
      })
      const signal = f.adapter.main[0]?.signal
      if (signal === undefined) throw new Error('The main request must carry its turn signal')
      const assembly = await f.ctx.systemPrompt.assemble({
        scope: f.agent,
        agent: f.agent,
        signal,
      })
      const text = assembly.contexts.find(context => context.name === 'timeline:state')?.text ?? ''
      expect(text).toContain('"status":"paused","done":[1,4]')
      expect(text).not.toContain('"status":"active","done":[1,4]')
      expect(text).toContain('"status":"blocked"')
      f.adapter.release.resolve(undefined)
      await f.agent.whenIdle()
      f.start()
      await f.agent.whenIdle()
      const contexts = f.events.filter(
        event =>
          event.type === 'user/message' && JSON.stringify(event.data).includes('Current Timeline plan'),
      )
      expect(contexts).toHaveLength(2)
      expect(JSON.stringify(contexts.at(-1))).toContain('The user asked to continue timer recovery.')
      await f.plugin.dispose()
      const disposed = await f.ctx.systemPrompt.assemble({ scope: f.agent, agent: f.agent })
      expect(disposed.contexts.some(context => context.name === 'timeline:state')).toBe(false)
    } finally {
      await f.close()
    }
  })
  it('shows an empty saved plan as pending', async () => {
    const f = await setup({ intervalMs: 86400000 })
    try {
      await executeTool(f.ctx, {
        name: 'timeline_tree', arguments: { action: 'start', title: 'Plan the release' },
        callId: ToolCallId('empty-plan'), agent: f.agent, signal: new AbortController().signal,
      })
      const prompt = await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent })
      const state = prompt.contexts.find(context => context.name === 'timeline:state')?.text
      expect(state).toContain('"title":"Plan the release","status":"pending","tasks":[]')
    } finally {
      await f.close()
    }
  })
  it('adds discussion handling only while a saved user annotation is open', async () => {
    const f = await setup({ intervalMs: 86400000 })
    const call = (name: string, args: object) =>
      executeTool(f.ctx, {
        name,
        arguments: args,
        callId: ToolCallId(newId('note')),
        agent: f.agent,
        signal: new AbortController().signal,
      })
    const context = async () =>
      (
        await f.ctx.systemPrompt.assemble({
          scope: f.agent,
          agent: f.agent,
          signal: new AbortController().signal,
        })
      ).contexts.find(item => item.name === 'timeline:state')?.text ?? ''
    try {
      await call('timeline_tree', { action: 'start', title: 'Verify recovery' })
      await call('timeline_tasks', { tasks: [{ id: 'check', title: 'Verify saved work' }] })
      expect(await context()).not.toContain('timeline_reply')
      const tree = f.ctx.timeline.stateOf(f.agent.session).view.activeTreeId
      if (tree === null) throw new Error('Missing task tree')
      const id = newId('note')
      await f.ctx.timeline.edit({
        action: 'annotate',
        sessionId: f.agent.session.id,
        id,
        target: { kind: 'task', tree, task: taskId.parse('check') },
        text: 'Explain which recovery cases were checked.',
      })
      const pending = await context()
      expect(pending).toContain('Address open discussions at a safe checkpoint')
      expect(pending).toContain('Use timeline_read with annotation set to the ID')
      expect(pending).toContain(id)
      expect(pending).not.toContain('Explain which recovery cases were checked.')
      await call('timeline_reply', { id, text: 'Both save and restore cases were checked.' })
      expect(await context()).not.toContain('timeline_reply')
      expect(await context()).not.toContain('openAnnotations')
    } finally {
      await f.close()
    }
  })
  it('counts repeated admission for the same agent step once', async () => {
    const f = await setup({ intervalMs: 86400000, reminderIterations: 2 })
    const signal = new AbortController().signal
    const requests = agentEvents(f.agent.ctx, f.agent)
    const admit = (step: number) => requests.waterfall('agent/request', { turn: 1, step, signal },
      () => Promise.resolve({ provider: 'fixture', model: 'timeline' }))
    const checkpointText = async () => (await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent }))
      .contexts.find(context => context.name === 'timeline:maintenance')?.text
    try {
      await admit(0)
      await admit(0)
      expect(await checkpointText()).toBe('')
      await admit(1)
      expect(await checkpointText()).toContain('Task progress checkpoint')
    } finally {
      await f.close()
    }
  })
  it('uses live reminder settings and restarts the count after a successful update', async () => {
    const adapter = new Adapter()
    adapter.steps = 8
    const f = await setup({ intervalMs: 86400000, reminderIterations: 7 }, adapter)
    adapter.mainActions[0] = () => {
      updateVolatile(
        (f.plugin.effectiveConfig as PluginConfig).reminderIterations,
        Config({ reminderIterations: 3 }).reminderIterations,
      )
      f.plugin.ctx.emit('loader/volatile-update', [['reminderIterations']])
      return [{ name: 'timeline_tree', arguments: JSON.stringify({ action: 'start', title: 'Review' }) }]
    }
    adapter.mainActions[3] = () => [
      {
        name: 'timeline_tasks',
        arguments: JSON.stringify({ tasks: [{ id: 'work', title: 'Review code', status: 'active' }] }),
      },
    ]
    try {
      f.start()
      await adapter.ready.promise
      expect(reminders(adapter.main[1])).toBe(0)
      expect(reminders(adapter.main[2])).toBe(1)
      expect(checkpoint(adapter.main[4])).toBe(false)
      expect(reminders(adapter.main[5])).toBe(1)
      expect(reminders(adapter.main[6])).toBe(2)
    } finally {
      await f.close()
    }
  })
  it.each(['active', 'pending', 'paused', 'blocked'] as const)(
    'does not reopen a response when saved work is %s',
    async (status) => {
      const adapter = new Adapter()
      adapter.steps = 0
      const f = await setup({ intervalMs: 86400000 }, adapter)
      try {
        for (const [name, args] of [
          ['timeline_tree', { action: 'start', title: 'Saved goal' }],
          [
            'timeline_tasks',
            { tasks: [{ id: 'work', title: 'Review code', status, note: 'Saved work state.' }] },
          ],
        ] as const)
          await executeTool(f.ctx, {
            name,
            arguments: args,
            agent: f.agent,
            callId: ToolCallId(name),
            signal: new AbortController().signal,
          })
        f.start()
        await adapter.ready.promise
        adapter.release.resolve(undefined)
        await f.agent.whenIdle()
        expect(JSON.stringify(f.events)).not.toContain('Timeline finish reminder')
        expect(f.agent.status).toBe('idle')
        expect(f.ctx.timeline.stateOf(f.agent.session)?.view.trees[0]?.tasks[0]?.status).toBe(status)
        expect(adapter.main).toHaveLength(1)
        expect(f.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
        expect([...f.agent.inbox.nextTurn, ...f.agent.inbox.nextStep]).toHaveLength(0)
      } finally {
        await f.close()
      }
    },
  )
  it('keeps one checkpoint after 24 iterations until an update; reads do not reset it', async () => {
    const adapter = new Adapter()
    adapter.steps = 49
    adapter.mainActions[23] = () => [{ name: 'timeline_read', arguments: '{}' }]
    const f = await setup({ intervalMs: 86400000 }, adapter)
    try {
      f.start()
      await adapter.ready.promise
      expect(reminders(adapter.main[22])).toBe(0)
      expect(reminders(adapter.main[23])).toBe(1)
      expect(reminders(adapter.main[24])).toBe(1)
      expect(reminders(adapter.main[47])).toBe(1)
      expect(reminders(adapter.main[48])).toBe(1)
      expect([...f.agent.inbox.nextTurn, ...f.agent.inbox.nextStep]).toHaveLength(0)
      expect(f.ctx.agents.list()).toHaveLength(1)
    } finally {
      await f.close()
    }
  })
  it('clears the checkpoint after a successful update and removes its provider on unload', async () => {
    const adapter = new Adapter()
    adapter.steps = 47
    adapter.mainActions[0] = () => [
      { name: 'timeline_tree', arguments: JSON.stringify({ action: 'start', title: 'Plan' }) },
    ]
    adapter.mainActions[23] = () => [
      {
        name: 'timeline_tasks',
        arguments: JSON.stringify({ tasks: [{ id: 'work', title: 'Ongoing work', status: 'active' }] }),
      },
    ]
    const f = await setup({ intervalMs: 86400000 }, adapter)
    try {
      f.start()
      await adapter.ready.promise
      expect(checkpoint(adapter.main[23])).toBe(true)
      expect(checkpoint(adapter.main[24])).toBe(false)
      expect(checkpoint(adapter.main[46])).toBe(false)
      expect(checkpoint(adapter.main[47])).toBe(true)
      expect([...f.agent.inbox.nextTurn, ...f.agent.inbox.nextStep]).toHaveLength(0)
      await f.plugin.dispose()
      const assembly = await f.ctx.systemPrompt.assemble({ scope: f.agent, agent: f.agent })
      expect(assembly.contexts.some(context => context.name === 'timeline:maintenance')).toBe(false)
    } finally {
      await f.close()
    }
  })
  it('does not extend a closing response that reaches the reminder threshold', async () => {
    const adapter = new Adapter()
    adapter.steps = 23
    const f = await setup({ intervalMs: 86400000 }, adapter)
    try {
      f.start()
      await adapter.ready.promise
      expect(checkpoint(adapter.main[23])).toBe(true)
      adapter.release.resolve(undefined)
      await f.agent.whenIdle()
      expect(adapter.main).toHaveLength(24)
      f.start()
      await f.agent.whenIdle()
      expect(adapter.main).toHaveLength(25)
      expect(checkpoint(adapter.main[24])).toBe(false)
      expect(
        f.events
          .filter(event => event.type === 'assistant/message')
          .filter(event => event.data.message.content.some(block => block.type === 'text')),
      ).toHaveLength(2)
      expect([...f.agent.inbox.nextTurn, ...f.agent.inbox.nextStep]).toHaveLength(0)
    } finally {
      await f.close()
    }
  })
  it('does not reset on failed updates or overlook new work when older trees are complete', async () => {
    for (const completed of [false, true]) {
      const adapter = new Adapter()
      adapter.steps = 26
      adapter.mainActions[23] = () => [
        { name: 'timeline_tasks', arguments: JSON.stringify({ tasks: [{ id: 'missing' }] }) },
      ]
      const f = await setup({ intervalMs: 86400000 }, adapter)
      const call = (name: string, args: object) =>
        executeTool(f.ctx, {
          name,
          arguments: args,
          callId: ToolCallId(`${name}-${completed}`),
          agent: f.agent,
          signal: new AbortController().signal,
        })
      try {
        if (completed) {
          await call('timeline_tree', { action: 'start', title: 'Completed work' })
          await call('timeline_tasks', { tasks: [{ id: 'done', title: 'Finished', status: 'done' }] })
        }
        f.start()
        await adapter.ready.promise
        expect(reminders(adapter.main[24])).toBe(1)
      } finally {
        await f.close()
      }
    }
  })
})
