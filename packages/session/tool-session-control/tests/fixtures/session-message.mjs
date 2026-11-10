/** Exercise independent Session acceptance and restoration through the shipped profile. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { installModelSelection } from '@deepseek-ai/dsh-agent'

export const name = 'session-control-message-fixture'
export const inject = ['agents', 'sessions', 'sessionPersistence', 'workspaceRegistry', 'tools', 'systemPrompt']

/** Hold recipient execution until each tool has returned its acceptance receipt. */
export function apply(ctx) {
  const targetId = 'snapshot-independent-recipient'
  let targetHandle
  let root
  let gate = Promise.withResolvers()
  let entered = Promise.withResolvers()
  let accepted = 0
  const receipts = []
  ctx.effect(() => async () => {
    gate.resolve()
    await targetHandle?.dispose()
  })
  ctx.on('agent/created', async ({ agent }) => {
    agent.ctx.tools.restrict({ allow: ['session_send_message'] })
    if (agent.id === targetId) return
    root = agent
    const cwd = join(agent.session.header.cwd, '.agents', 'independent-recipient')
    await mkdir(cwd, { recursive: true })
    targetHandle = await ctx.agents.create({
      sessionId: targetId,
      meta: { cwd },
      agentOptions: agent.options,
      setup: agentCtx => { installModelSelection(agentCtx) },
    })
    assert.notEqual(targetHandle.agent.session.header.cwd, root.session.header.cwd)
    assert.equal(targetHandle.agent.session.header.parentSession, undefined)
    assert.equal(targetHandle.agent.session.header.origin, undefined)
  })
  ctx.systemPrompt.context({
    name: 'session-control-fixture:target',
    order: 999,
    required: true,
    interpolate: false,
    text: ({ agent }) => agent === root ? `Recipient Session: ${targetId}` : '',
  })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent.id === targetId) {
      entered.resolve()
      await gate.promise
    }
    return next()
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'session_send_message') return next()
    assert.equal(exec.agent, root)
    if (accepted === 1) assert.equal(ctx.agents.get(targetId), undefined)
    const result = await next()
    if (accepted === 2) {
      assert.equal(result.isError, true)
      assert.equal(result.error?.info?.code, 'SESSION_CONTROL_ARCHIVED')
      assert.equal(ctx.workspaceRegistry.archivedSessionIds.includes(targetId), true)
      await writeFile('session-control-result.json', JSON.stringify({
        acceptedBeforeReply: true, restored: true, archivedRejected: true, crossCwd: true, realSender: true,
      }) + '\n')
      return result
    }
    assert.equal(result.isError, false)
    const receipt = JSON.parse(result.content[0].text)
    const target = ctx.agents.get(targetId)
    assert(target)
    await entered.promise
    assert.equal(target.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, accepted)
    const acceptedInput = target.session.snapshotEvents()
      .filter(event => event.type === 'agent/inbox/spliced')
      .flatMap(event => event.data.inserted)
      .find(message => message.id === receipt.message_id)
    assert(acceptedInput)
    assert.equal(acceptedInput.source.kind, 'agent-message')
    assert.equal(acceptedInput.source.senderSessionId, root.id)
    receipts.push(receipt.message_id)
    assert.equal(new Set(receipts).size, receipts.length)
    gate.resolve()
    await target.whenIdle()
    await ctx.sessions.flush(target.session)
    accepted += 1
    if (accepted === 1) {
      await targetHandle.dispose()
      targetHandle = undefined
      assert.equal(ctx.agents.get(targetId), undefined)
      gate = Promise.withResolvers()
      entered = Promise.withResolvers()
    } else {
      await ctx.workspaceRegistry.archiveSession(targetId)
      assert.equal(target.session.snapshotEvents().filter(event => event.type === 'user/message'
        && event.data.source.kind === 'agent-message').length, 2)
    }
    return result
  })
}
