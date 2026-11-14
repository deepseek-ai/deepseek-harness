import { executeTool } from './execute-tool.ts'
import { describe, expect, it, vi } from 'vitest'
import { textOutput } from './fixture.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import { Config } from '../src/config.ts'
import { newId, reportId, reportSchema, taskId, taskReceiptSchema, treeId } from '../src/records.ts'
import type { PluginConfig } from '../src/config.ts'
import { Adapter, setup } from './fixture.ts'
import * as tasksModule from '../src/tasks.ts'

function toolsOf(fixture: Awaited<ReturnType<typeof setup>>, prefix: string) {
  let next = 0
  return (name: string, args: object, id = `${prefix}-${next++}`) =>
    executeTool(fixture.ctx, {
      name,
      arguments: args,
      agent: fixture.agent,
      callId: ToolCallId(id),
      signal: new AbortController().signal,
    })
}

describe('agent tools in the production loop', () => {
  it('reports only open task discussions in status queries and exposes saved report failures', async () => {
    const f = await setup({ intervalMs: 86400000 })
    const call = toolsOf(f, 'discussion')
    const session = f.agent.session
    try {
      expect((await call('timeline_tasks', { tasks: [{ id: 'missing', title: 'Missing' }] })).isError).toBe(true)
      await call('timeline_tree', { action: 'start', title: 'Review plan' })
      await call('timeline_tasks', { tasks: [
        { id: 'one', title: 'Verify restore', status: 'active' },
        { id: 'two', title: 'Verify permissions' },
      ] })
      const tree = treeId.parse(f.ctx.timeline.stateOf(session).view.activeTreeId)
      for (const [id, target] of [
        ['note-0000000000000001', { kind: 'task', tree, task: taskId.parse('one') }],
        ['note-0000000000000002', { kind: 'task', tree, task: taskId.parse('two') }],
        ['note-0000000000000003', { kind: 'tree', tree }],
      ] as const) await f.ctx.timeline.edit({ action: 'annotate', sessionId: session.id, id, target, text: 'What remains?' })
      await call('timeline_reply', { id: 'note-0000000000000002', text: 'Needs a test account.' })
      const result = await call('timeline_read', { status: 'active' })
      expect(result.content.find(block => block.type === 'text')?.text).toContain('"openAnnotations":1')
      await f.ctx.timeline.append(session, 'plugin:timeline/failure', {
        version: 1, sessionId: session.id, id: reportId.parse('report-failed'), message: 'Report timed out.',
      })
      expect(JSON.stringify((await call('timeline_pull', {})).content)).toContain('Report timed out.')
    } finally {
      await f.close()
    }
  })
  it('keeps reads useful when a restored view lacks an annotation target or task parent', async () => {
    const f = await setup({ intervalMs: 86400000 })
    const call = toolsOf(f, 'incomplete-view')
    const session = f.agent.session
    try {
      await call('timeline_tree', { action: 'start', title: 'Review recovery' })
      await call('timeline_tasks', { tasks: [{ id: 'restore', title: 'Verify restore', status: 'done' }] })
      const current = f.ctx.timeline.stateOf(session)
      const tree = treeId.parse(current.view.activeTreeId)
      const id = 'note-0000000000000001'
      await f.ctx.timeline.edit({ action: 'annotate', sessionId: session.id, id, target: { kind: 'tree', tree }, text: 'What remains?' })
      const saved = f.ctx.timeline.stateOf(session)
      const read = vi.spyOn(f.ctx.timeline, 'stateOf')
      try {
        read.mockReturnValueOnce({ ...saved, view: { ...saved.view, trees: [] } })
        const annotation = await call('timeline_read', { annotation: id })
        expect(annotation.isError).not.toBe(true)
        expect(JSON.stringify(annotation.content)).toContain(id)
        read.mockReturnValueOnce({ ...saved, view: { ...saved.view, trees: saved.view.trees.map(tree => ({
          ...tree, tasks: tree.tasks.map(task => ({ ...task, parent: taskId.parse('missing-parent') })),
        })) } })
        const missingParent = await call('timeline_read', { tree })
        expect(missingParent.isError).not.toBe(true)
        expect(missingParent.content.find(block => block.type === 'text')?.text).toContain('"status":"done","progress":1')
      } finally {
        read.mockRestore()
      }
    } finally {
      await f.close()
    }
  })
  it('reports an unexpected task validation failure without saving the patch', async () => {
    const f = await setup({ intervalMs: 86400000 })
    const call = toolsOf(f, 'invalid-patch')
    try {
      await call('timeline_tree', { action: 'start', title: 'Review recovery' })
      const patch = vi.spyOn(tasksModule, 'patchTasks').mockImplementationOnce(() => { throw 'Unexpected patch failure' })
      try {
        const result = await call('timeline_tasks', { tasks: [{ id: 'restore', title: 'Verify restore' }] })
        expect(result.isError).toBe(true)
        expect(JSON.stringify(result.content)).toContain('Invalid task update')
        expect(f.ctx.timeline.stateOf(f.agent.session).view.trees[0]?.tasks).toEqual([])
      } finally {
        patch.mockRestore()
      }
    } finally {
      await f.close()
    }
  })
  it('requires an agent to use the planning tools and provides compact call labels', async () => {
    const f = await setup()
    try {
      for (const [name, args, title] of [
        ['timeline_tree', { action: 'start', title: 'Plan' }, 'Timeline task tree'],
        ['timeline_tasks', { tasks: [{ id: 'check', title: 'Check' }] }, 'Update Timeline tasks'],
        ['timeline_pull', {}, 'Check next work'],
        ['timeline_read', {}, 'Read Timeline'],
        ['timeline_reply', { id: 'note-0000000000000001', text: 'Checked.' }, 'Reply to Timeline annotation'],
      ] as const) {
        const tool = f.ctx.tools.get(name, f.agent)
        expect(tool?.presentCall?.(args)).toMatchObject({ title })
        const rejected = await executeTool(f.ctx, {
          name, arguments: args, callId: ToolCallId(`no-agent-${name}`), signal: new AbortController().signal,
        })
        expect(rejected.isError).toBe(true)
        expect(JSON.stringify(rejected.content)).toContain('requires an agent session')
      }
      expect(f.ctx.tools.get('timeline_tree', f.agent)?.presentCall?.({ action: 'select', id: 'plan' }))
        .toMatchObject({ rawInput: 'plan' })
    } finally {
      await f.close()
    }
  })
  it('selects existing trees, bounds new trees, and validates each read target', async () => {
    const f = await setup({ intervalMs: 86400000, maxTrees: 2 })
    const call = toolsOf(f, 'selection')
    const start = (title: string) => call('timeline_tree', { action: 'start', title })
    const view = () => f.ctx.timeline.stateOf(f.agent.session).view
    try {
      expect(JSON.stringify((await call('timeline_read', { limit: 1 })).content)).toContain('null')
      for (const limit of [0, 51]) {
        const invalid = await call('timeline_read', { limit })
        expect(invalid).toMatchObject({ isError: true, error: { info: { code: 'TIMELINE_INVALID_ARGUMENT' } } })
        expect(JSON.stringify(invalid.content)).toContain('limit')
      }
      expect((await start('First')).isError).not.toBe(true)
      const first = view().activeTreeId
      expect((await start('Second')).isError).not.toBe(true)
      expect(view().activeTreeId).not.toBe(first)
      expect((await start('Third')).isError).toBe(true)
      for (const args of [
        { action: 'start', id: 'custom', title: 'Forbidden' },
        { action: 'select', id: first, description: 'Forbidden' },
        { action: 'select', id: 'missing' },
      ]) expect((await call('timeline_tree', args)).isError).toBe(true)
      const selection = { action: 'select', id: first }
      expect((await call('timeline_tree', selection, 'select-first')).isError).not.toBe(true)
      expect((await call('timeline_tree', selection, 'select-first')).isError).not.toBe(true)
      expect(view().activeTreeId).toBe(first)
      for (const args of [{ annotation: 'missing' }, { report: 'missing' }, { tree: 'missing' }, { task: 'missing' }])
        expect((await call('timeline_read', args)).isError).toBe(true)
      const missing = await call('timeline_tasks', {
        tree: 'missing', tasks: [{ id: 'check', title: 'Check' }],
      })
      expect(missing.isError).toBe(true)
      expect(JSON.stringify(missing.content)).toContain('Unknown task tree')
      for (const [name, args] of [
        ['timeline_tree', { action: 'start', title: 'Unavailable' }],
        ['timeline_tasks', { tasks: [{ id: 'check', title: 'Check' }] }],
        ['timeline_reply', { id: 'missing', text: 'Answer' }],
      ] as const) {
        vi.spyOn(f.ctx.sessions, 'flush').mockResolvedValueOnce(false)
        const failure = await call(name, args)
        expect(failure.isError).toBe(true)
        expect(JSON.stringify(failure.content)).toContain('durable session persistence')
      }
    } finally {
      await f.close()
    }
  })
  it('saves stable card metadata without changing native text, and returns the original receipt on retry', async () => {
    const f = await setup({ intervalMs: 86400000 })
    const run = toolsOf(f, 'card')
    const call = (id: string, name: string, args: object) => run(name, args, id)
    const readReceipt = (result: Awaited<ReturnType<typeof call>>) =>
      z.object({ timeline: taskReceiptSchema.nullable() }).parse(result.meta).timeline
    try {
      await call('card-tree', 'timeline_tree', { action: 'start', title: 'Save and recover work' })
      const first = await call('card-first', 'timeline_tasks', {
        tasks: [
          { id: 'save', title: 'Save work' },
          { id: 'recover', title: 'Recover work' },
        ],
      })
      expect(readReceipt(first)?.previousAt).toBeNull()
      const args = { tasks: [{ id: 'save', status: 'done', note: 'Saved work survives reopening.' }] }
      const second = await call('card-second', 'timeline_tasks', args)
      expect(readReceipt(second)).toMatchObject({ before: 0, after: 0.5, previousAt: readReceipt(first)?.at })
      const modelText = second.content.find(block => block.type === 'text')?.text ?? '{}'
      expect(Object.keys(JSON.parse(modelText) as object).sort()).toEqual(['priorities', 'progress', 'tree'])
      expect(modelText).not.toContain('receipt')
      await call('card-third', 'timeline_tasks', {
        tasks: [{ id: 'recover', status: 'done', note: 'Recovery preserves the saved work.' }],
      })
      expect(readReceipt(await call('card-second', 'timeline_tasks', args))).toEqual(readReceipt(second))
      const before = f.ctx.timeline.stateOf(f.agent.session).view.trees[0]?.lastTaskUpdate
      expect(
        readReceipt(
          await call('card-no-op', 'timeline_tasks', { tasks: [{ id: 'save', title: 'Save work' }] }),
        ),
      ).toBeNull()
      expect(f.ctx.timeline.stateOf(f.agent.session).view.trees[0]?.lastTaskUpdate).toBe(before)
      const failed = await call('card-invalid', 'timeline_tasks', { tasks: [{ id: 'save', done: [9, 1] }] })
      expect(failed.isError).toBe(true)
      expect(failed.meta).toBeUndefined()
    } finally {
      await f.close()
    }
  })
  it('serializes concurrent card baselines with the acknowledged task writes', async () => {
    const f = await setup({ intervalMs: 86400000 })
    let id = 0
    const call = (name: string, args: object) =>
      executeTool(f.ctx, {
        name,
        arguments: args,
        agent: f.agent,
        callId: ToolCallId(`concurrent-card-${id++}`),
        signal: new AbortController().signal,
      })
    try {
      await call('timeline_tree', { action: 'start', title: 'Parallel save checks' })
      await call('timeline_tasks', {
        tasks: [
          { id: 'a', title: 'Save changes' },
          { id: 'b', title: 'Recover changes' },
        ],
      })
      const results = await Promise.all(
        ['a', 'b'].map(task =>
          call('timeline_tasks', {
            tasks: [{ id: task, status: 'done', note: `${task} passed its check.` }],
          }),
        ),
      )
      const receipts = results
        .map(result => z.object({ timeline: taskReceiptSchema }).parse(result.meta).timeline)
        .sort((a, b) => a.after - b.after)
      expect(receipts.map(receipt => [receipt.before, receipt.after])).toEqual([
        [0, 0.5],
        [0.5, 1],
      ])
      expect(receipts[1]?.previousAt).toBe(receipts[0]?.at)
    } finally {
      await f.close()
    }
  })
  it('supplies live task guidance once in the writing tool description without changing the system prefix', async () => {
    const f = await setup({ intervalMs: 86400000, taskPrompt: 'Explain what recovery checks prove.' })
    let count = 0
    const call = (name: string, args: object) =>
      executeTool(f.ctx, {
        name,
        arguments: args,
        agent: f.agent,
        callId: ToolCallId(`guidance-${count++}`),
        signal: new AbortController().signal,
      })
    const guidanceOf = (result: Awaited<ReturnType<typeof call>>) =>
      z
        .object({ guidance: z.string().optional() })
        .parse(JSON.parse(result.content.find(block => block.type === 'text')?.text ?? '{}')).guidance
    try {
      const system = (await f.ctx.systemPrompt.assemble({ scope: f.agent })).sections
      const schemas = f.ctx.tools.schemas(f.agent)
      expect(JSON.stringify(system)).not.toContain('Explain what recovery checks prove.')
      const writing = () => f.ctx.tools.schemas(f.agent).find(tool => tool.name === 'timeline_tasks')
      expect(writing()?.description).toContain('Explain what recovery checks prove.')
      expect(
        schemas.filter(tool => tool.description.includes('Explain what recovery checks prove.')),
      ).toHaveLength(1)
      expect(f.ctx.tools.get('timeline_tasks', f.agent)?.description).toContain(
        'Explain what recovery checks prove.',
      )
      expect(guidanceOf(await call('timeline_tree', { action: 'start', title: 'Recover saved plans' }))).toBe(
        undefined,
      )
      const changed = Config({ taskPrompt: 'Explain limits and decided next steps.' })
      updateVolatile((f.plugin.effectiveConfig as PluginConfig).taskPrompt, changed.taskPrompt)
      f.plugin.ctx.emit('loader/volatile-update', [['taskPrompt']])
      expect((await f.ctx.systemPrompt.assemble({ scope: f.agent })).sections).toEqual(system)
      expect(writing()?.description).toContain('Explain limits and decided next steps.')
      expect(writing()?.description).not.toContain('Explain what recovery checks prove.')
      expect(f.ctx.tools.schemas(f.agent).filter(tool => tool.name !== 'timeline_tasks')).toEqual(
        schemas.filter(tool => tool.name !== 'timeline_tasks'),
      )
      expect(guidanceOf(await call('timeline_read', {}))).toBeUndefined()
      expect(guidanceOf(await call('timeline_read', { status: 'unfinished' }))).toBeUndefined()
      updateVolatile((f.plugin.effectiveConfig as PluginConfig).taskPrompt, Config({ taskPrompt: '' }).taskPrompt)
      expect(writing()?.description).not.toContain('Task writing guidance:')
      expect(guidanceOf(await call('timeline_read', {}))).toBeUndefined()
    } finally {
      await f.close()
    }
  })
  it('rejects removed estimate arguments atomically instead of silently accepting an obsolete tool shape', async () => {
    const f = await setup({ intervalMs: 86400000 })
    let count = 0
    const call = (name: string, args: object) =>
      executeTool(f.ctx, {
        name,
        arguments: args,
        agent: f.agent,
        callId: ToolCallId(`removed-args-${count++}`),
        signal: new AbortController().signal,
      })
    try {
      await call('timeline_tree', { action: 'start', title: 'Check model contracts' })
      const schema = JSON.stringify(
        f.ctx.tools.schemas(f.agent).find(tool => tool.name === 'timeline_tasks'),
      )
      for (const [name, value] of [
        ['remaining', 5],
        ['mode', 'parallel'],
        ['timeShare', 2],
      ] as const) {
        expect(schema).not.toContain(`"${name}":`)
        const result = await call('timeline_tasks', {
          tasks: [
            { id: 'valid', title: 'Should remain unsaved' },
            { id: 'obsolete', title: 'Obsolete input', [name]: value },
          ],
        })
        expect(result.isError).toBe(true)
        expect(f.ctx.timeline.stateOf(f.agent.session).view.trees[0]?.tasks).toEqual([])
      }
    } finally {
      await f.close()
    }
  })
  it('distinguishes the complete report count from its bounded recent sample', async () => {
    const f = await setup({ intervalMs: 86400000 })
    try {
      for (let index = 0; index < 4; index++)
        await f.ctx.timeline.append(f.agent.session, 'plugin:timeline/report', {
          version: 1,
          sessionId: f.agent.session.id,
          report: reportSchema.parse({
            id: newId('report'),
            level: 0,
            start: f.agent.session.header.createdAt + index * 60000,
            end: f.agent.session.header.createdAt + (index + 1) * 60000,
            policy: '[60000]',
            children: [],
            source: 'no-activity',
            toolCount: 0,
            covered: 0,
            contextSeq: 0,
            summary: { progress: ['No activity.'], uncertainties: [], userActions: [] },
          }),
        })
      const result = await executeTool(f.ctx, {
        name: 'timeline_read',
        arguments: {},
        agent: f.agent,
        callId: ToolCallId('report-count'),
        signal: new AbortController().signal,
      })
      expect(result.isError).not.toBe(true)
      const text = result.content.find(block => block.type === 'text')?.text ?? 'null'
      const { reports } = z
        .object({ reports: z.object({ total: z.number(), recent: z.array(z.unknown()) }) })
        .parse(JSON.parse(text))
      expect(reports.total).toBe(4)
      expect(reports.recent).toHaveLength(3)
    } finally {
      await f.close()
    }
  })
  it('returns one short tree identity for repeated starts with the same tool call', async () => {
    const f = await setup({ intervalMs: 86400000 })
    try {
      const call = {
        name: 'timeline_tree',
        arguments: { action: 'start', title: 'Recovery checks' },
        agent: f.agent,
        callId: ToolCallId('retry-tree'),
        signal: new AbortController().signal,
      }
      const first = await executeTool(f.ctx, call)
      const second = await executeTool(f.ctx, call)
      expect(second).toEqual(first)
      const trees = f.ctx.timeline.stateOf(f.agent.session).view.trees
      expect(trees).toHaveLength(1)
      expect(trees[0]?.id).toMatch(/^tree-[0-9a-f]{16}$/u)
      const tree = treeId.parse(trees[0]?.id)
      const update = await toolsOf(f, 'legacy-call')('timeline_tasks', { tasks: [{ id: 'check', title: 'Check' }] }, 'retry-tree')
      expect(update.isError).not.toBe(true)
      expect(f.ctx.timeline.stateOf(f.agent.session).view.trees[0]?.tasks).toEqual([])
      for (let index = 0; index < 64; index++) {
        await f.ctx.timeline.append(f.agent.session, 'plugin:timeline/select', {
          version: 1, sessionId: f.agent.session.id, callId: `select-${index}`, treeId: tree,
        })
      }
      expect(await executeTool(f.ctx, call)).toEqual(first)
      expect(f.ctx.timeline.stateOf(f.agent.session).view.trees).toHaveLength(1)
      const edit = toolsOf(f, 'retry-removed-tree')
      const tasks = { tasks: [{ id: 'review', title: 'Review restart' }] }
      expect((await edit('timeline_tasks', tasks, 'edit-before-remove')).isError).not.toBe(true)
      await f.ctx.timeline.edit({ action: 'remove', sessionId: f.agent.session.id, tree })
      const retry = await edit('timeline_tasks', tasks, 'edit-before-remove')
      expect(retry.isError).not.toBe(true)
      expect(JSON.stringify(retry.content)).toContain('progress')
      expect(f.ctx.timeline.stateOf(f.agent.session).view.trees).toEqual([])
    } finally {
      await f.close()
    }
  })
  it('toggles only Timeline-owned Todo restrictions through live settings without changing presets', async () => {
    const f = await setup({ intervalMs: 86400000 })
    const parent = {}
    const preset = createScope(f.ctx, parent)
    let writes = 0
    try {
      bindScopeParent(f.agent, parent)
      await preset.ctx.inject(['tools'], (scope) => {
        scope.tools.register(
          defineTool({
            name: 'todo_write',
            description: 'Original Todo',
            parameters: {},
            output: textOutput,
            execute: () => {
              writes++
              return Promise.resolve('Updated')
            },
          }),
        )
      })
      const set = (allowTodo: boolean) => {
        updateVolatile((f.plugin.effectiveConfig as PluginConfig).allowTodo, Config({ allowTodo }).allowTodo)
        f.plugin.ctx.emit('loader/volatile-update', [['allowTodo']])
      }
      expect(f.ctx.tools.get('todo_write', f.agent)).toBeUndefined()
      set(true)
      expect(f.ctx.tools.get('todo_write', f.agent)).toBeDefined()
      expect(f.ctx.tools.schemas(f.agent).map(tool => tool.name)).toContain('todo_write')
      await executeTool(f.ctx, {
        name: 'todo_write',
        arguments: {},
        agent: f.agent,
        callId: ToolCallId('allowed-todo'),
        signal: new AbortController().signal,
      })
      expect(writes).toBe(1)
      const external = f.agent.ctx.tools.restrict({ deny: ['todo_write'] })
      set(false)
      set(true)
      expect(f.ctx.tools.get('todo_write', f.agent)).toBeUndefined()
      external()
      expect(f.ctx.tools.get('todo_write', f.agent)).toBeDefined()
      set(false)
      expect(f.ctx.tools.get('todo_write', f.agent)).toBeUndefined()
      expect(f.ctx.tools.get('todo_write', parent)).toBeDefined()
      await executeTool(f.ctx, {
        name: 'todo_write',
        arguments: {},
        agent: f.agent,
        callId: ToolCallId('disabled-todo'),
        signal: new AbortController().signal,
      })
      expect(writes).toBe(1)
    } finally {
      await preset.dispose()
      await f.close()
    }
  })
  it('advertises floating-point weights and accepts fractional values without rounding model data', async () => {
    const adapter = new Adapter()
    const f = await setup({ intervalMs: 86400000 }, adapter)
    try {
      expect(f.ctx.tools.schemas(f.agent).find(tool => tool.name === 'timeline_tasks')).toMatchObject({
        parameters: { properties: { tasks: { items: { properties: { weight: { type: 'number' } } } } } },
      })
      adapter.mainActions = [
        () => [
          { name: 'timeline_tree', arguments: JSON.stringify({ action: 'start', title: 'Fractional work' }) },
        ],
        () => [
          {
            name: 'timeline_tasks',
            arguments: JSON.stringify({
              tasks: [{ id: 'small', title: 'Check result', weight: 0.12345, status: 'active' }],
            }),
          },
        ],
      ]
      f.start()
      await adapter.ready.promise
      expect(f.ctx.timeline.stateOf(f.agent.session)?.view.trees[0]?.tasks[0]?.timeShare).toBe(0.12345)
      expect(
        f.events
          .filter(event => event.type === 'tool/result')
          .every(event => event.data.message.isError !== true),
      ).toBe(true)
    } finally {
      await f.close()
    }
  })
  it('updates the fixed language rule in the next prompt assembly', async () => {
    const f = await setup()
    try {
      const prompt = () => f.ctx.systemPrompt.assemble({ scope: f.agent })
      expect(
        (await prompt()).sections.find(section => section.name === 'timeline:planning')?.text,
      ).toContain(
        "discussion replies in English. Follow the user's language instructions for all other work and conversation.",
      )
      updateVolatile((f.plugin.effectiveConfig as PluginConfig).language, Config({ language: 'zh-CN' }).language)
      const text = (await prompt()).sections.find(section => section.name === 'timeline:planning')?.text
      expect(text).toContain('For Timeline task-tree content only')
      expect(text).toContain('discussion replies in 简体中文.')
      expect(text).not.toContain('All titles, descriptions, user-facing texts must')
      expect(text).toContain("reuse the goal's tree")
      expect(text).toContain('Group work by deliverable and split large steps into checkable child tasks.')
      expect(text).not.toContain('weight')
      expect(text).not.toContain('timeline_reply')
    } finally {
      await f.close()
    }
  })
  it('denies an explicit agent-local Todo override without breaking registration', async () => {
    const f = await setup({ intervalMs: 86400000 })
    let writes = 0
    try {
      await f.agent.ctx.inject(['tools'], (scope) => {
        scope.tools.register(
          defineTool({
            name: 'todo_write',
            description: 'Agent-local Todo',
            parameters: {},
            output: textOutput,
            execute: () => {
              writes++
              return Promise.resolve('Todo updated')
            },
          }),
        )
      })
      const input = {
        callId: ToolCallId('stale-todo'),
        name: 'todo_write',
        arguments: {},
        agent: f.agent,
        signal: new AbortController().signal,
      }
      const denied = await executeTool(f.ctx, input)
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('Timeline replaces Todo')
      expect(writes).toBe(0)
      await f.plugin.dispose()
      const restored = await executeTool(f.ctx, { ...input, callId: ToolCallId('restored-todo') })
      expect(restored.isError).not.toBe(true)
      expect(writes).toBe(1)
    } finally {
      await f.close()
    }
  })
  it('replaces inherited preset Todo tools and restores them when unloaded', async () => {
    const f = await setup({ intervalMs: 86400000 })
    const parent = {}
    const preset = createScope(f.ctx, parent)
    try {
      bindScopeParent(f.agent, parent)
      // Presets can finish mounting after Timeline, and their tools are inherited by agents.
      await preset.ctx.inject(['tools'], (scope) => {
        scope.tools.register(
          defineTool({
            name: 'todo_write',
            description: 'Original Todo',
            parameters: {},
            output: textOutput,
            execute: () => Promise.resolve('Todo updated'),
          }),
        )
      })
      expect(f.ctx.tools.get('todo_write', parent)).toBeDefined()
      expect(f.ctx.tools.get('todo_write', f.agent)).toBeUndefined()
      expect(f.ctx.tools.schemas(f.agent).map(tool => tool.name)).not.toContain('todo_write')
      const next = await f.ctx.agents.create({
        sessionId: SessionId('timeline-new-preset-agent'),
        agentOptions: { provider: 'fixture', model: 'timeline' },
        setup: (_scope, agent) => {
          bindScopeParent(agent, parent)
        },
      })
      expect(f.ctx.tools.get('todo_write', next.agent)).toBeUndefined()
      const available = vi.spyOn(f.ctx.timeline, 'available').mockReturnValue(false)
      f.plugin.ctx.emit('loader/volatile-update', [['allowTodo']])
      expect(f.ctx.tools.get('todo_write', f.agent)).toBeDefined()
      available.mockRestore()
      f.plugin.ctx.emit('loader/volatile-update', [['allowTodo']])
      expect(f.ctx.tools.get('todo_write', f.agent)).toBeUndefined()
      const prompt = await f.ctx.systemPrompt.assemble({ scope: f.agent })
      const guidance = prompt.sections.find(section => section.name === 'timeline:planning')?.text
      expect(guidance).toContain('Before substantive multi-step work')
      expect(guidance).not.toContain('Todo')
      await f.plugin.dispose()
      expect(f.ctx.tools.get('todo_write', f.agent)).toBeDefined()
      expect(f.ctx.tools.get('todo_write', next.agent)).toBeDefined()
      expect(
        (await f.ctx.systemPrompt.assemble({ scope: f.agent })).sections.some(
          section => section.name === 'timeline:planning',
        ),
      ).toBe(false)
    } finally {
      await preset.dispose()
      await f.close()
    }
  })
  it('creates and updates a named tree through real model tool calls', async () => {
    const adapter = new Adapter()
    const f = await setup({ intervalMs: 86400000 }, adapter)
    try {
      adapter.mainActions = [
        () => [
          {
            name: 'timeline_tree',
            arguments: JSON.stringify({ action: 'start', title: 'Recover sessions' }),
          },
        ],
        () => [
          {
            name: 'timeline_tasks',
            arguments: JSON.stringify({
              tasks: [
                { id: 'group', title: 'Verify recovery' },
                { id: 'read', parent: 'group', title: 'Read saved state', status: 'active', done: [1, 2] },
                { id: 'check', parent: 'group', title: 'Check restart', status: 'pending' },
              ],
            }),
          },
        ],
        () => [
          {
            name: 'timeline_tasks',
            arguments: JSON.stringify({
              tasks: [
                { id: 'read', status: 'done', note: 'Saved state restores correctly.' },
                { id: 'check', status: 'active', note: 'Checking restart next.' },
              ],
            }),
          },
        ],
        () => [{ name: 'timeline_read', arguments: '{}' }],
      ]
      f.start()
      await adapter.ready.promise
      const view = f.ctx.timeline.stateOf(f.agent.session)?.view
      expect(view?.trees[0]?.title).toBe('Recover sessions')
      expect(view?.trees[0]?.tasks.map(task => task.status)).toEqual(['active', 'done', 'active'])
      expect(view?.activeTreeId).toBe(view?.trees[0]?.id)
      expect(f.agent.status).toBe('running')
      // Inspect the actual result sent back to the model, rather than the stored leaf placeholders.
      const results = f.events.filter(event => event.type === 'tool/result')
      expect(results.every(event => event.data.message.isError !== true)).toBe(true)
      const text = results.at(-1)?.data.message.content.find(block => block.type === 'text')?.text ?? ''
      const result = z
        .object({
          tree: z.object({
            tasks: z.array(
              z.object({
                id: z.string(),
                kind: z.string(),
                status: z.string(),
                progress: z.number(),
                done: z.array(z.number()).optional(),
              }),
            ),
          }),
        })
        .parse(JSON.parse(text))
      const group = result.tree.tasks.find(task => task.id === 'group')
      expect(group).toMatchObject({ kind: 'group', status: 'active', progress: 0.5 })
      expect(group?.done).toBeUndefined()
      expect(text).not.toContain('"remaining":')
    } finally {
      await f.close()
    }
  })
  it('updates an addressed tree and returns weights without ETA inputs', async () => {
    const f = await setup({ intervalMs: 86400000 })
    const call = async (name: string, args: object) => {
      const result = await executeTool(f.ctx, {
        name,
        arguments: args,
        agent: f.agent,
        callId: ToolCallId(`${name}-${Math.random()}`),
        signal: new AbortController().signal,
      })
      expect(result.isError).not.toBe(true)
      const value: unknown = JSON.parse(result.content.find(block => block.type === 'text')?.text ?? 'null')
      return value
    }
    try {
      const first = z
        .object({ activeTree: z.string() })
        .parse(await call('timeline_tree', { action: 'start', title: 'Main goal' })).activeTree
      await call('timeline_tasks', {
        tasks: [
          { id: 'group', title: 'Implementation' },
          { id: 'read', parent: 'group', title: 'Read', status: 'done', weight: 2 },
          { id: 'verify', parent: 'group', title: 'Verify', done: [1, 4], weight: 8 },
        ],
      })
      await call('timeline_tree', { action: 'start', title: 'Independent follow-up' })
      await call('timeline_tasks', {
        tasks: [{ id: 'read', title: 'Different task with the same local ID' }],
      })
      const group = z
        .object({ task: z.object({ progress: z.number(), kind: z.string() }) })
        .parse(await call('timeline_read', { tree: first, task: 'group' }))
      expect(group.task).toMatchObject({ progress: 0.4, kind: 'group' })
      const leaf = z
        .object({
          task: z.object({ done: z.array(z.number()), weight: z.number() }),
        })
        .parse(await call('timeline_read', { tree: first, task: 'verify' }))
      expect(leaf.task).toMatchObject({ done: [1, 4], weight: 8 })
      await call('timeline_tasks', {
        tree: first,
        tasks: [{ id: 'verify', weight: 4, note: 'Verification requires less work than expected.' }],
      })
      const view = f.ctx.timeline.stateOf(f.agent.session)?.view
      expect(view?.trees).toHaveLength(2)
      expect(view?.trees[0]?.id).toBe(first)
      expect(view?.activeTreeId).toBe(first)
      expect(
        view?.trees.find(tree => tree.id === first)?.tasks.find(task => task.id === 'verify')?.timeShare,
      ).toBe(4)
    } finally {
      await f.close()
    }
  })
  it('returns bounded leaf-status queries without changing selection or including report history', async () => {
    const f = await setup({ intervalMs: 86400000 })
    let count = 0
    const call = (name: string, args: object) =>
      executeTool(f.ctx, {
        name,
        arguments: args,
        agent: f.agent,
        callId: ToolCallId(`status-query-${count++}`),
        signal: new AbortController().signal,
      })
    const query = z.object({
      tree: z.object({ id: z.string() }),
      tasks: z.array(z.object({ id: z.string(), status: z.string(), done: z.array(z.number()) })),
      total: z.number(),
      hasMore: z.boolean(),
    })
    const read = async (args: object) => {
      const result = await call('timeline_read', args)
      expect(result.isError).not.toBe(true)
      const text = result.content.find(block => block.type === 'text')?.text ?? 'null'
      expect(text).not.toContain('"reports"')
      return query.parse(JSON.parse(text))
    }
    try {
      await call('timeline_tree', { action: 'start', title: 'Status query' })
      await call('timeline_tasks', {
        tasks: [
          { id: 'group', title: 'Review' },
          { id: 'done', parent: 'group', title: 'Done', status: 'done' },
          { id: 'active', parent: 'group', title: 'Active', status: 'active', done: [1, 4] },
          { id: 'blocked', parent: 'group', title: 'Blocked', status: 'blocked', note: 'Needs access.' },
          { id: 'paused', parent: 'group', title: 'Paused', status: 'paused', note: 'Deferred by user.' },
          ...Array.from({ length: 14 }, (_, index) => ({ id: `pending-${index}`, title: `Check ${index}` })),
          { id: 'retired', title: 'Retired', status: 'retired', note: 'No longer needed.' },
        ],
      })
      const tree = f.ctx.timeline.stateOf(f.agent.session).view.activeTreeId
      expect(await read({ status: 'unfinished', limit: 2 })).toMatchObject({
        tasks: [
          { id: 'active', status: 'active', done: [1, 4] },
          { id: 'blocked', status: 'blocked' },
        ],
        total: 17,
        hasMore: true,
      })
      expect((await read({ status: 'unfinished' })).tasks).toHaveLength(12)
      expect(await read({ limit: 50 })).toMatchObject({ total: 17, hasMore: false })
      await call('timeline_tree', { action: 'start', title: 'Another plan' })
      const selected = f.ctx.timeline.stateOf(f.agent.session).view.activeTreeId
      expect(await read({ tree, status: 'blocked' })).toMatchObject({
        tree: { id: tree },
        tasks: [{ id: 'blocked' }],
        total: 1,
        hasMore: false,
      })
      expect(f.ctx.timeline.stateOf(f.agent.session).view.activeTreeId).toBe(selected)
      for (const args of [
        { tree, task: 'active', status: 'active' },
        { tree, limit: 0 },
        { tree, limit: 51 },
        { tree, limit: 1.5 },
      ])
        expect((await call('timeline_read', args)).isError).toBe(true)
    } finally {
      await f.close()
    }
  })
})
