import { pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
import { executeTool } from './execute-tool.ts'
import { cp, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Commands from '@deepseek-ai/dsh-commands'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Checkpoint } from '../src/checkpoint.ts'
import { Adapter, setup } from './fixture.ts'
import checkpoint from './checkpoint.timeline.json' with { type: 'json' }

const fixtures: Awaited<ReturnType<typeof setup>>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
})
async function fixture() {
  const f = await setup({ intervalMs: 86400000 })
  f.adapter.calls = 0
  f.adapter.release.resolve(undefined)
  fixtures.push(f)
  return f
}
const content = () => JSON.stringify(checkpoint)
const imported = (
  f: Awaited<ReturnType<typeof setup>>,
  id = 'checkpoint-one',
  copy = false,
  proceed = false,
) =>
  f.ctx.timeline.edit({
    action: 'import',
    sessionId: f.agent.session.id,
    id,
    content: content(),
    copy,
    continue: proceed,
  })

describe('task-tree transfer through public storage', () => {
  it('rejects import conflicts and configured tree and task limits', async () => {
    const f = await setup({ maxTrees: 1 })
    fixtures.push(f)
    await imported(f)
    await expect(imported(f, 'checkpoint-one', true)).rejects.toThrow('identity was already used')
    await expect(imported(f, 'new-copy', true)).rejects.toThrow('At most 1 task trees')
    const bounded = await setup({ maxTasks: 1 })
    fixtures.push(bounded)
    await expect(imported(bounded)).rejects.toThrow('At most 1 tasks')
    expect(bounded.ctx.timeline.stateOf(bounded.agent.session).view.trees).toEqual([])
  })
  it('cancels a draft import without an agent turn and refuses stale draft cancellation after a turn starts', async () => {
    const f = await fixture()
    const first = await imported(f)
    if (first.action !== 'import') throw new Error('Missing import result')
    expect(
      await f.ctx.timeline.edit({
        action: 'remove',
        sessionId: f.agent.session.id,
        tree: first.tree,
        draft: true,
      }),
    ).toMatchObject({ removed: true, notified: false, draft: true })
    expect(f.adapter.main).toHaveLength(0)
    expect(f.agent.inbox.nextTurn).toHaveLength(0)
    expect(f.ctx.timeline.stateOf(f.agent.session).view.trees).toHaveLength(0)
    const restored = await imported(f, 'restored', true)
    if (restored.action !== 'import') throw new Error('Missing import result')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    try {
      f.start()
      await f.agent.whenIdle()
    } finally {
      clock.mockRestore()
    }
    expect(f.ctx.timeline.stateOf(f.agent.session).activity.ranges).toEqual([])
    await expect(
      f.ctx.timeline.edit({
        action: 'remove',
        sessionId: f.agent.session.id,
        tree: restored.tree,
        draft: true,
      }),
    ).rejects.toThrow('conversation has started')
    expect(f.ctx.timeline.stateOf(f.agent.session).view.trees).toHaveLength(1)
  })
  it('activates a cold conversation through its public controller and preserves activation errors', async () => {
    const f = await fixture()
    let denied = false
    const resolveAgent = vi.fn(() =>
      Promise.resolve(denied ? { error: new Error('Session writer is held elsewhere') } : { agent: f.agent }),
    )
    f.ctx.provide('sessionController', { resolveAgent })
    vi.spyOn(f.ctx.agents, 'get').mockReturnValueOnce(undefined)
    await imported(f)
    expect(resolveAgent).toHaveBeenCalledWith(f.agent.session.id)
    expect(f.adapter.main).toHaveLength(0)
    denied = true
    vi.spyOn(f.ctx.agents, 'get').mockReturnValueOnce(undefined)
    await expect(imported(f, 'denied', true)).rejects.toThrow('Session writer is held elsewhere')
    expect(f.ctx.timeline.stateOf(f.agent.session).view.trees).toHaveLength(1)
  })
  it('copies a plan atomically, retains discussions and priorities, and reuses a modified copy without reverting it', async () => {
    const f = await fixture()
    const first = await imported(f)
    if (first.action !== 'import') throw new Error('Missing import result')
    const view = () => f.ctx.timeline.stateOf(f.agent.session).view
    expect(view().trees).toHaveLength(1)
    expect(view().annotations).toHaveLength(1)
    expect(view().trees[0]?.tasks.find(task => task.id === 'verify')).toMatchObject({
      status: 'paused',
      done: [2, 5],
      timeShare: 1.75,
      priority: 'P0',
    })
    expect(f.adapter.main).toHaveLength(0)
    await executeTool(f.ctx, {
      name: 'timeline_tasks',
      arguments: {
        tasks: [
          { id: 'verify', done: [4, 5], note: 'Interrupted-write recovery now passes; final checks remain.' },
        ],
      },
      callId: ToolCallId('new-checkpoint'),
      agent: f.agent,
      signal: new AbortController().signal,
    })
    const repeated = await imported(f, 'checkpoint-two')
    expect(repeated).toMatchObject({ action: 'import', tree: first.tree, reused: true })
    expect(view().trees[0]?.tasks.find(task => task.id === 'verify')?.done).toEqual([4, 5])
    const copy = await imported(f, 'another-copy', true)
    expect(copy).toMatchObject({ action: 'import', reused: false })
    expect(view().trees).toHaveLength(2)
    expect(view().annotations).toHaveLength(2)
    expect(new Set(view().annotations.map(note => note.id)).size).toBe(2)
    await imported(f, 'another-copy', true)
    expect(view().trees).toHaveLength(2)
  })
  it('removes only the selected tree, immediately notifies the conversation, and keeps stale import retries removed after restart decoding', async () => {
    const f = await fixture()
    f.start()
    await f.agent.whenIdle()
    f.adapter.main = []
    const first = await imported(f)
    if (first.action !== 'import') throw new Error('Missing import result')
    await imported(f, 'copy', true)
    await f.ctx.timeline.edit({ action: 'remove', sessionId: f.agent.session.id, tree: first.tree })
    await f.adapter.waitForMain(1)
    await f.agent.whenIdle()
    expect(JSON.stringify(f.agent.session.deriveMessages())).toContain('User removed task tree')
    const state = f.ctx.timeline.stateOf(f.agent.session)
    expect(state.view.trees).toHaveLength(1)
    expect(state.view.annotations).toHaveLength(1)
    expect(state.view.trees.some(tree => tree.id === first.tree)).toBe(false)
    expect(state.calls.some(call => call.tree === first.tree)).toBe(true)
    expect((await f.handle.read()).events.some(event => pluginRecordOf(event)?.type === 'plugin:timeline/remove')).toBe(true)
    await expect(imported(f)).rejects.toThrow('removed')
    expect(
      await f.ctx.timeline.edit({ action: 'remove', sessionId: f.agent.session.id, tree: first.tree }),
    ).toMatchObject({ removed: false, notified: false })
    expect(f.adapter.main).toHaveLength(1)
  })
  it('rejects damaged imports and uncertain saves without publishing a partial tree', async () => {
    const f = await fixture()
    await expect(
      f.ctx.timeline.edit({
        action: 'import',
        sessionId: f.agent.session.id,
        id: 'bad',
        content: JSON.stringify({ ...checkpoint, version: 2 }),
        copy: false,
        continue: false,
      }),
    ).rejects.toThrow()
    expect(f.ctx.timeline.stateOf(f.agent.session).view.trees).toHaveLength(0)
    vi.spyOn(f.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('Interrupted save'))
    await expect(imported(f, 'failed', false, true)).rejects.toThrow('Interrupted save')
    expect(f.ctx.timeline.stateOf(f.agent.session).view.trees).toHaveLength(0)
    expect(f.adapter.main).toHaveLength(0)
  })
  it('recovers a prepared import after a failed flush and delivers continuation only once', async () => {
    const f = await fixture()
    const { root, agent: { session } } = f
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    vi.spyOn(f.ctx.sessions, 'flush')
      .mockImplementationOnce(flush)
      .mockRejectedValueOnce(new Error('Interrupted after appending the import'))
    await expect(imported(f, 'retry-save', false, true)).rejects.toThrow('could not save')
    expect(f.ctx.timeline.stateOf(session).view.trees).toEqual([])
    expect(f.adapter.main).toEqual([])

    await f.close({ preserve: true })
    fixtures.splice(fixtures.indexOf(f), 1)
    const adapter = new Adapter()
    adapter.calls = 0
    adapter.release.resolve(undefined)
    const recovered = await setup({ intervalMs: 86400000 }, adapter, { root, sessionId: session.id })
    fixtures.push(recovered)
    expect(recovered.ctx.timeline.stateOf(recovered.agent.session).view.trees).toEqual([])
    await expect(imported(recovered, 'retry-save', true, true)).rejects.toThrow('identity was already used')
    const result = await imported(recovered, 'retry-save', false, true)
    expect(result).toMatchObject({ action: 'import', reused: true, notified: true })
    await recovered.agent.whenIdle()
    expect(await imported(recovered, 'retry-save', false, true)).toEqual(result)
    expect(recovered.adapter.main).toHaveLength(1)
    const [tree] = recovered.ctx.timeline.stateOf(recovered.agent.session).view.trees
    const verify = tree?.tasks.find(task => task.id === 'verify')
    expect(verify?.history.filter(revision => revision.status === 'paused')).toHaveLength(1)
    expect(verify?.history.at(-1)).toMatchObject({ status: 'paused', previousProgress: 0.4, progress: 0.4 })
  })
  it('acknowledges a buffered continuation once when the inbox flush recovers', async () => {
    const f = await fixture()
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    const flushes = vi.spyOn(f.ctx.sessions, 'flush')
      .mockImplementationOnce(flush)
      .mockImplementationOnce(flush)
      .mockImplementationOnce(flush)
      .mockResolvedValueOnce(false)
    try {
      expect(await imported(f, 'retry-notice', false, true)).toMatchObject({ notified: false })
      await f.agent.whenIdle()
      expect(await imported(f, 'retry-notice', false, true)).toMatchObject({ reused: true, notified: true })
      expect(f.adapter.main).toHaveLength(1)
    } finally {
      flushes.mockRestore()
    }
  })
  it('recovers an unacknowledged ready marker without a second tree or continuation', async () => {
    const f = await fixture()
    const session = f.agent.session
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    vi.spyOn(f.ctx.sessions, 'flush')
      .mockImplementationOnce(flush)
      .mockImplementationOnce(flush)
      .mockRejectedValueOnce(new Error('Interrupted while saving the ready marker'))
    await expect(imported(f, 'retry-ready', false, true)).rejects.toThrow('could not save')
    expect(f.adapter.main).toEqual([])
    expect(await imported(f, 'retry-ready', false, true)).toMatchObject({ reused: true, notified: true })
    await f.agent.whenIdle()
    expect(f.ctx.timeline.stateOf(session).view.trees).toHaveLength(1)
    expect(f.adapter.main).toHaveLength(1)
  })
  it('keeps a parked continuation across restart and never queues it twice', async () => {
    const f = await fixture()
    const { root, agent: { session } } = f
    // Model a restart after the inbox record commits and before the driver claims the message.
    vi.spyOn(f.agent, 'followup').mockImplementation((message) => {
      f.agent.send(message, 'next-turn', false)
    })
    expect(await imported(f, 'parked-notice', false, true)).toMatchObject({ notified: true })
    const id = f.agent.inbox.nextTurn[0]?.id
    expect(id).toBeDefined()
    const crashStore = await mkdtemp(join(tmpdir(), 'timeline-parked-'))
    await cp(root, crashStore, { recursive: true })
    const adapter = new Adapter()
    adapter.calls = 0
    adapter.release.resolve(undefined)
    const recovered = await setup({ intervalMs: 86400000 }, adapter, { root: crashStore, sessionId: session.id })
    fixtures.push(recovered)
    expect(await imported(recovered, 'parked-notice', false, true)).toMatchObject({ reused: true, notified: false })
    expect(recovered.agent.inbox.nextTurn.map(message => message.id)).toEqual([id])
    recovered.start()
    await recovered.agent.whenIdle()
    expect(recovered.agent.inbox.nextTurn).toEqual([])
    await recovered.ctx.sessions.flush(recovered.agent.session)
    const log = await recovered.handle.read()
    expect(log.events.filter(event => event.type === 'user/message' && event.data.id === id)).toHaveLength(1)
    expect(JSON.stringify(adapter.main[0]?.messages)).toContain('Continue task tree')
  })
  it('rejects excessive units even when the checkpoint declares the task complete', async () => {
    const f = await fixture()
    await expect(f.ctx.timeline.edit({
      action: 'import',
      sessionId: f.agent.session.id,
      id: 'excess-units',
      content: JSON.stringify({ ...checkpoint, discussions: undefined, tasks: [
        { id: 'verify', title: 'Verify recovery', status: 'done', done: [5, 4] },
      ] }),
      copy: false,
      continue: false,
    })).rejects.toThrow('Completed units cannot exceed total units')
    expect(f.ctx.timeline.stateOf(f.agent.session).view.trees).toEqual([])
  })
  it('reserves idle maintenance while a save is pending, then releases queued work with the imported plan', async () => {
    const f = await fixture()
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    const admitted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(f.ctx.sessions, 'flush').mockImplementationOnce(flush).mockImplementationOnce(async (session) => {
      admitted.resolve(undefined)
      await release.promise
      return flush(session)
    })
    const saving = imported(f)
    await admitted.promise
    f.start()
    expect(f.adapter.main).toHaveLength(0)
    release.resolve(undefined)
    await saving
    await f.agent.whenIdle()
    expect(JSON.stringify(f.adapter.main[0]?.messages)).toContain('Restore saved plans')
    const hold = Promise.withResolvers<undefined>()
    f.adapter.release = hold
    f.start()
    await f.adapter.waitForMain(2)
    await expect(imported(f, 'while-running')).rejects.toThrow()
    hold.resolve(undefined)
    await f.agent.whenIdle()
  })
})

describe('human Timeline command', () => {
  it('imports without a session working directory and reports filesystem and result failures', async () => {
    const f = await fixture()
    await f.ctx.plugin(Commands)
    await f.ctx.plugin(FsLocal, { cwd: f.root })
    const { agent } = await f.ctx.agents.create({
      sessionId: SessionId('no-working-directory'),
      agentOptions: { provider: 'fixture', model: 'timeline' },
    })
    const file = join(f.root, 'plan.timeline.json')
    await writeFile(file, content())
    const run = () => f.ctx.commands.execute(agent, `/timeline @"${file}" --copy`, [], new AbortController().signal)
    expect((await run())?.result.kind).toBe('success')
    const fs = agent.ctx.get('fs')
    if (fs === undefined) throw new Error('Missing fixture filesystem')
    vi.spyOn(fs, 'readBytes').mockRejectedValueOnce('Read failed')
    expect((await run())?.result).toMatchObject({ kind: 'error', text: 'Timeline import failed' })
    vi.spyOn(f.ctx.timeline, 'edit').mockResolvedValueOnce({ action: 'remove', removed: false, draft: false, notified: false })
    expect((await run())?.result).toMatchObject({ kind: 'error', text: 'Invalid Timeline import response' })
  })
  it('explains duplicate flags, unavailable filesystems and failed reads', async () => {
    const f = await fixture()
    await f.ctx.plugin(Commands)
    const run = (text: string) => f.ctx.commands.execute(f.agent, text, [], new AbortController().signal)
    expect((await run('/timeline plan.timeline.json'))?.result.kind).toBe('error')
    const duplicate = (await run('/timeline @plan.timeline.json --copy --copy'))?.result
    expect(duplicate?.kind).toBe('error')
    expect(duplicate?.kind === 'error' && duplicate.text).toContain('Use /timeline @plan.timeline.json')
    const unavailable = (await run('/timeline @plan.timeline.json'))?.result
    expect(unavailable?.kind).toBe('error')
    expect(unavailable?.kind === 'error' && unavailable.text).toContain('filesystem is unavailable')
    await f.ctx.plugin(FsLocal, { cwd: f.root })
    expect((await run(`/timeline @${join(f.root, 'absent.timeline.json')}`))?.result.kind).toBe('error')
    expect(f.ctx.timeline.stateOf(f.agent.session).view.trees).toEqual([])
  })
  it('reports a saved continuation even when admission cannot be confirmed', async () => {
    const f = await fixture()
    await f.ctx.plugin(Commands)
    await f.ctx.plugin(FsLocal, { cwd: f.root })
    const path = join(f.root, 'plan.timeline.json')
    await writeFile(path, Checkpoint.fromJson({ ...checkpoint, tasks: [], discussions: [] }).toString())
    const run = () => f.ctx.commands.execute(f.agent, `/timeline @"${path}" --continue`, [], new AbortController().signal)
    const hold = Promise.withResolvers<undefined>()
    f.adapter.release = hold
    f.start()
    await f.adapter.waitForMain(1)
    try {
      const busy = (await run())?.result
      expect(busy?.kind === 'error' && busy.text).toContain('finish')
    } finally {
      hold.resolve(undefined)
      await f.agent.whenIdle()
    }
    const followup = vi.spyOn(f.agent, 'followup').mockImplementationOnce(() => { throw new Error('Admission unavailable') })
    const saved = (await run())?.result
    expect(saved?.kind === 'success' && saved.text).toContain('Check the conversation')
    const block = followup.mock.calls[0]?.[0].content[0]
    expect(block?.type === 'text' && block.text).toContain('checkpoint: none')
    expect(f.ctx.timeline.stateOf(f.agent.session).view.trees).toHaveLength(1)
  })
  it('imports a quoted @file into a blank session before any model request, then supports an explicit continuation', async () => {
    const f = await fixture()
    await f.ctx.plugin(Commands)
    await f.ctx.plugin(FsLocal, { cwd: f.root })
    const path = join(f.root, 'my plan.timeline.json')
    await writeFile(path, Checkpoint.fromJson(checkpoint).toString())
    const signal = new AbortController().signal
    const usage = await f.ctx.commands.execute(f.agent, '/timeline', [], signal)
    expect(usage?.result.kind).toBe('success')
    const result = await f.ctx.commands.execute(f.agent, `/timeline @"${path}"`, [], signal)
    expect(result?.result).toMatchObject({ kind: 'success' })
    expect(f.ctx.timeline.stateOf(f.agent.session).view.trees).toHaveLength(1)
    expect(f.adapter.main).toHaveLength(0)
    const continued = await f.ctx.commands.execute(f.agent, `/timeline @"${path}" --continue`, [], signal)
    expect(continued?.result).toMatchObject({ kind: 'success' })
    await f.agent.whenIdle()
    expect(f.adapter.main).toHaveLength(1)
    expect(JSON.stringify(f.adapter.main[0]?.messages)).toContain('Continue task tree')
    expect(f.ctx.timeline.stateOf(f.agent.session).view.trees).toHaveLength(1)
    const invalid = await f.ctx.commands.execute(f.agent, `/timeline @"${path}" --unknown`, [], signal)
    expect(invalid?.result.kind).toBe('error')
  })
})
