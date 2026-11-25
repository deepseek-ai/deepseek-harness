/** Exercise local child initialization and model maintenance between activations. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export const name = 'subagent-durable-model-selection'
export const inject = ['tools', 'subagents', 'agents', 'sessions', 'sessionPersistence']

/**
 * Switch the persisted child's model after its initial activation has closed.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Scenario host context.
 */
export function apply(ctx) {
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (exec.callId !== 'model-selection-trigger') return result
    const root = exec.agent
    assert(root)
    const signal = exec.signal
    const initial = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
    const selected = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    const child = await ctx.subagents.startActivation({
      provider: 'spawn', parent: root, label: 'Selected child', delivery: 'caller', signal,
      agentOptions: initial,
      prompt: [{ type: 'text', text: 'Reply with exactly the word CHILD_OK and nothing else.' }],
    })
    try {
      assert.equal((await child.result).stopReason, 'completed')
    } finally {
      await child.dispose()
    }
    assert.equal(ctx.agents.get(child.childId), undefined)
    assert.equal(ctx.sessions.get(child.childId), undefined)
    await ctx.subagents.selectModel(child.childId, selected, { kind: 'ancestor', agent: root }, signal)
    assert.equal(ctx.agents.get(child.childId), undefined)
    assert.equal(ctx.sessions.get(child.childId), undefined)
    await ctx.subagents.sendMessage(root, child.childId, [{ type: 'text', text: 'Reply with exactly the word CHILD_OK again.' }], { signal })
    await ctx.subagents.waitForTreeWork(root)
    assert.equal(ctx.agents.get(child.childId), undefined)
    const stored = await ctx.sessionPersistence.open(child.childId, 'read')
    try {
      const { events } = await stored.read()
      assert.deepEqual(events.filter(event => event.type === 'subagent/descriptor').map(event => event.data), [{
        version: 3, mode: 'continuable', provider: 'spawn', label: 'Selected child',
      }])
      assert.deepEqual(events.filter(event => event.type === 'model/selection').map(event => event.data), [initial, selected])
      const models = events.filter(event => event.type === 'request/header').map(event => event.data.header.config.model)
      assert.deepEqual(models, [initial.model, selected.model])
      const legacyId = randomUUID()
      const legacyHeader = {
        ...root.session.header, id: legacyId, createdAt: Date.now(),
        parentSession: root.id, origin: 'subagent', delegationDepth: 1, isSeeded: false,
      }
      const legacyWriter = await ctx.sessionPersistence.create(legacyHeader)
      try {
        await legacyWriter.append([{
          type: 'subagent/descriptor', seq: 0, time: Date.now(),
          data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'Legacy child' },
        }])
      } finally {
        await legacyWriter.close()
      }
      root.session.append('subagent/catalog', {
        version: 0, childId: legacyId, childCreatedAt: legacyHeader.createdAt, mode: 'continuable', label: 'Legacy child',
      })
      await ctx.subagents.selectModel(legacyId, selected, { kind: 'ancestor', agent: root }, signal)
      assert.equal(ctx.agents.get(legacyId), undefined)
      const legacyReader = await ctx.sessionPersistence.open(legacyId, 'read')
      try {
        const { events: repaired } = await legacyReader.read()
        assert.equal(repaired[0].data.version, 3)
        assert.deepEqual(repaired.at(-1).data, selected)
        assert.equal(repaired.some(event => event.type === 'turn/start' || event.type === 'request/header'), false)
      } finally {
        await legacyReader.close()
      }
      await writeFile('model-selection-result.json', JSON.stringify({
        initial: models[0], selectedWhileCold: selected.model, resumed: models[1],
        repairedLegacy: selected.model,
      }) + '\n')
    } finally {
      await stored.close()
    }
    return result
  })
}
