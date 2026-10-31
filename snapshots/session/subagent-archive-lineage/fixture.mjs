/** Coordinate real descendant lifetimes around archive operations. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

export const name = 'subagent-archive-lineage-fixture'
export const inject = ['tools', 'subagents', 'agents', 'sessions', 'sessionPersistence', 'workspaceRegistry']

/** Keep both creators offline before exercising archive admission and restoration. */
export function apply(ctx) {
  const creators = Promise.withResolvers()
  const leafEntered = Promise.withResolvers()
  const leafRelease = Promise.withResolvers()
  ctx.effect(() => () => {
    creators.resolve()
    leafEntered.resolve()
    leafRelease.resolve()
  })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent.id === 'archive-owner' || agent.id === 'archive-creator') await creators.promise
    if (agent.id === 'archive-leaf') {
      leafEntered.resolve()
      await leafRelease.promise
    }
    return next()
  })
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (exec.callId !== 'archive-lineage-trigger') return result
    const root = exec.agent
    assert(root)
    const signal = exec.signal
    const start = (parent, childId) => ctx.subagents.startActivation({
      provider: 'spawn', parent, childId, label: childId, delivery: 'caller', signal,
      prompt: [{ type: 'text', text: 'Reply with DONE.' }],
    })
    const owner = await start(root, 'archive-owner')
    const creator = await start(ctx.agents.get(owner.childId), 'archive-creator')
    const leaf = await start(ctx.agents.get(creator.childId), 'archive-leaf')
    try {
      await leafEntered.promise
      creators.resolve()
      await Promise.all([owner.result, creator.result])
      assert.equal(ctx.sessions.get(owner.childId), undefined)
      assert.equal(ctx.sessions.get(creator.childId), undefined)
      await assert.rejects(ctx.workspaceRegistry.archiveSession(owner.childId), error => {
        assert.equal(error.name, 'WorkspaceActiveSessionError')
        assert.deepEqual(error.activity.find(item => item.kind === 'subagent').items.map(item => item.id), [leaf.childId])
        return true
      })
      await ctx.workspaceRegistry.archiveSession(owner.childId, { stopActivity: true })
      leafRelease.resolve()
      assert.equal((await leaf.result).stopReason, 'aborted')
      await ctx.subagents.sendMessage(root, leaf.childId, [{ type: 'text', text: 'Continue.' }], { signal })
      await ctx.subagents.waitForTreeWork(root)
      assert.equal(ctx.agents.get(leaf.childId), undefined)
      const stored = await ctx.sessionPersistence.open(leaf.childId, 'read')
      try {
        const log = await stored.read()
        assert.deepEqual(log.events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind), ['aborted', 'blocked'])
        assert.equal(log.events.some(event => event.type === 'request/header'), false)
      } finally {
        await stored.close()
      }
      await writeFile('archive-result.json', JSON.stringify({ reported: true, cancelled: true, blocked: true }) + '\n')
      return result
    } finally {
      creators.resolve()
      leafRelease.resolve()
      await Promise.all([owner.dispose(), creator.dispose(), leaf.dispose()])
    }
  })
}
