/** SDK approvals use the real bidirectional wire and the internal audit service. */
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SubagentRuntime, { NO_START_CAPABILITIES, SubagentError } from '@deepseek-ai/dsh-subagent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { bindSubagentActivation } from '../../../subagent/subagent/tests/manager-internals.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'

async function setup(enabled?: boolean, subagents = false) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ApprovalService)
  if (subagents) await ctx.plugin(SubagentRuntime)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 2 }, () => textResponse('done'))))
  const input = new PassThrough()
  const output = new PassThrough()
  const serverWire = new JsonRpcLineTransport(input, output)
  const client = new JsonRpcLineTransport(output, input)
  const server = new HarnessSdkJsonRpcServer(ctx, serverWire)
  onTestFinished(async () => {
    await server.shutdown()
    serverWire.close()
    client.close()
    input.destroy()
    output.destroy()
  })
  serverWire.onRequest((method, params) => server.handleRequest(method, params))
  serverWire.start()
  client.start()
  await client.request('initialize', {
    cwd: process.cwd(), provider: 'mock', model: 'mock',
    ...(enabled === undefined ? {} : { approvalRequests: enabled }),
  })
  await client.request('session/working-directory/get', { sessionId: 'main' })
  const agent = ctx.agents.get(brandString<SessionId>('main'))!
  agent.session.append('turn/start', { turn: 1 })
  return { ctx, server, serverWire, client, agent, input }
}

describe('SDK approval bridge', () => {
  it.each(['allowed-once', 'rejected', 'cancelled'] as const)('applies and audits %s', async (outcome) => {
    const h = await setup(true)
    h.client.onRequest(async (method, params) => {
      expect(method).toBe('approval/request')
      expect(params).toEqual({ sessionId: 'main', toolName: 'bash', callId: 'call-1', reason: 'write outside workspace' })
      return { outcome }
    })
    await expect(h.ctx.approval.request({
      agent: h.agent, toolName: 'bash', callId: brandString<ToolCallId>('call-1'), reason: 'write outside workspace',
    })).resolves.toBe(outcome)
    expect(h.agent.session.snapshotEvents().slice(-2).map(e => [e.type, e.data])).toEqual([
      ['approval/asked', expect.objectContaining({ toolName: 'bash', reason: 'write outside workspace' })],
      ['approval/decided', expect.objectContaining({ outcome })],
    ])
  })

  it.each([undefined, false])('delegates when approvalRequests is %s', async (enabled) => {
    const h = await setup(enabled)
    h.ctx.on('approval/request', () => Promise.resolve('rejected'))
    await expect(h.ctx.approval.request({ agent: h.agent, toolName: 'bash' })).resolves.toBe('rejected')
  })

  it.each([null, {}, { outcome: 'allow-always' }, { outcome: true }])('fails closed for invalid response %j', async (result) => {
    const h = await setup(true)
    h.client.onRequest(() => Promise.resolve(result))
    await expect(h.ctx.approval.request({ agent: h.agent, toolName: 'bash' })).resolves.toBe('unavailable')
  })

  it('fails closed on client errors and a disconnected transport', async () => {
    const h = await setup(true)
    h.client.onRequest(() => Promise.reject(new Error('no decision')))
    await expect(h.ctx.approval.request({ agent: h.agent, toolName: 'bash' })).resolves.toBe('unavailable')
    h.serverWire.close()
    await expect(h.ctx.approval.request({ agent: h.agent, toolName: 'bash' })).resolves.toBe('unavailable')
  })

  it('correlates concurrent requests while another client request is in flight', async () => {
    const h = await setup(true)
    const first = Promise.withResolvers<object>()
    const entered = Promise.withResolvers<undefined>()
    h.client.onRequest(async (_method, params) => {
      if (params.toolName === 'first') {
        entered.resolve(undefined)
        return first.promise
      }
      return { outcome: 'rejected' }
    })
    onTestFinished(() => { first.resolve({ outcome: 'cancelled' }) })
    const pending = h.ctx.approval.request({ agent: h.agent, toolName: 'first' })
    await entered.promise
    await expect(h.ctx.approval.request({ agent: h.agent, toolName: 'second' })).resolves.toBe('rejected')
    await expect(h.client.request('session/working-directory/get', { sessionId: 'main' })).resolves.toHaveProperty('cwd')
    first.resolve({ outcome: 'allowed-once' })
    await expect(pending).resolves.toBe('allowed-once')
  })

  it.each(['cancel', 'shutdown', 'disconnect'] as const)('settles a pending approval on %s and ignores a late grant', async (action) => {
    const h = await setup(true)
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<object>()
    h.client.onRequest(() => { entered.resolve(undefined); return answer.promise })
    onTestFinished(() => { answer.resolve({ outcome: 'cancelled' }) })
    const cancellation = new AbortController()
    const pending = h.ctx.approval.request({ agent: h.agent, toolName: 'bash', signal: cancellation.signal })
    await entered.promise
    if (action === 'cancel') cancellation.abort()
    else if (action === 'shutdown') await h.server.shutdown()
    else h.serverWire.close()
    await expect(pending).resolves.toBe(action === 'cancel' ? 'cancelled' : 'unavailable')
    const delivered = Promise.withResolvers<Buffer>()
    h.input.once('data', delivered.resolve)
    onTestFinished(() => { h.input.off('data', delivered.resolve) })
    answer.resolve({ outcome: 'allowed-once' })
    expect(JSON.parse(String(await delivered.promise))).toMatchObject({ result: { outcome: 'allowed-once' } })
    expect(h.agent.session.snapshotEvents().filter(e => e.type === 'approval/decided').map(e => e.data.outcome))
      .toEqual([action === 'cancel' ? 'cancelled' : 'unavailable'])
  })

  it.each([
    { subagents: false, hasLineage: false }, { subagents: false, hasLineage: true },
    { subagents: true, hasLineage: false }, { subagents: true, hasLineage: true },
  ])('does not claim an unrelated live Agent (subagents=$subagents, SDK lineage=$hasLineage)', async ({ subagents, hasLineage }) => {
    const h = await setup(true, subagents)
    const foreign = await h.ctx.agents.create({
      sessionId: brandString<SessionId>('foreign'),
      meta: { cwd: process.cwd(), ...(hasLineage ? { parentSession: h.agent.session.id, origin: 'subagent' as const } : {}) },
    })
    onTestFinished(() => foreign.dispose())
    foreign.agent.session.append('turn/start', { turn: 1 })
    const clientDecision = vi.fn(async () => ({ outcome: 'allowed-once' }))
    h.client.onRequest(clientDecision)
    h.ctx.on('approval/request', () => Promise.resolve('rejected'))
    await expect(h.ctx.approval.request({ agent: foreign.agent, toolName: 'bash' })).resolves.toBe('rejected')
    expect(clientDecision).not.toHaveBeenCalled()
  })

  it.each([false, true])('serves runtime descendants with SDK session lineage: %s and preserves never policy', async (hasLineage) => {
    const h = await setup(true, true)
    const child = await h.ctx.agents.create({
      sessionId: brandString<SessionId>('child'),
      meta: { cwd: process.cwd(), ...(hasLineage ? { parentSession: h.agent.session.id } : {}) },
    })
    onTestFinished(() => child.dispose())
    bindSubagentActivation(h.ctx, child.agent, h.agent)
    const grandchild = await h.ctx.agents.create({
      sessionId: brandString<SessionId>('grandchild'), meta: { cwd: process.cwd() },
    })
    onTestFinished(() => grandchild.dispose())
    bindSubagentActivation(h.ctx, grandchild.agent, h.agent, [h.agent.id, child.agent.id])
    child.agent.session.append('turn/start', { turn: 1 })
    grandchild.agent.session.append('turn/start', { turn: 1 })
    const clientDecision = vi.fn(async () => ({ outcome: 'allowed-once' }))
    h.client.onRequest(clientDecision)
    for (const agent of [child.agent, grandchild.agent]) {
      await expect(h.ctx.approval.request({ agent, toolName: 'bash' })).resolves.toBe('allowed-once')
      expect(clientDecision).toHaveBeenLastCalledWith('approval/request', { sessionId: agent.session.id, toolName: 'bash' })
    }
    h.ctx.approval.setPolicy(child.agent, 'never')
    await expect(h.ctx.approval.request({ agent: child.agent, toolName: 'bash' })).resolves.toBe('rejected')
    expect(clientDecision).toHaveBeenCalledTimes(2)
  })

  it('routes approval from a managed descendant after its creator leaves', async () => {
    const h = await setup(true, true)
    h.ctx.subagents.registerProvider({
      name: 'local-test', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
      prepareContinuable: () => Promise.resolve({}),
    })
    const clientDecision = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({ outcome: 'allowed-once' }))
    h.client.onRequest(clientDecision)
    type Gate = ReturnType<typeof Promise.withResolvers<undefined>>
    const gates = new Map<Agent, { entered: Gate; release: Gate }>()
    h.ctx.on('agent/created', ({ agent }) => {
      gates.set(agent, { entered: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>() })
    })
    h.ctx.on('agent/pre-step', async ({ agent }, next) => {
      const gate = gates.get(agent)!
      gate.entered.resolve(undefined)
      await gate.release.promise
      return next()
    })
    const start = (parent: Agent) => h.ctx.subagents.startActivation({
      parent, provider: 'local-test', label: 'approval child', delivery: 'caller',
      prompt: [{ type: 'text', text: 'work' }], signal: new AbortController().signal,
    })
    const children: Awaited<ReturnType<typeof start>>[] = []
    try {
      const child = await start(h.agent)
      children.push(child)
      const childAgent = h.ctx.agents.get(child.childId)!
      await gates.get(childAgent)!.entered.promise
      const grandchild = await start(childAgent)
      children.push(grandchild)
      const grandchildAgent = h.ctx.agents.get(grandchild.childId)!
      await gates.get(grandchildAgent)!.entered.promise
      gates.get(childAgent)!.release.resolve(undefined)
      await child.result
      expect(h.ctx.agents.get(child.childId)).toBeUndefined()
      h.ctx.approval.setPolicy(grandchildAgent, 'ask')
      await expect(h.ctx.approval.request({ agent: grandchildAgent, toolName: 'bash' })).resolves.toBe('allowed-once')
      expect(clientDecision.mock.calls.map(call => call[1])).toEqual([
        { sessionId: grandchild.childId, toolName: 'bash' },
      ])
    } finally {
      for (const gate of gates.values()) gate.release.resolve(undefined)
      await Promise.all(children.map(child => child.dispose()))
    }
  })

  it('does not claim another runtime owner\'s child despite SDK session lineage', async () => {
    const h = await setup(true, true)
    const owner = await h.ctx.agents.create({ sessionId: brandString<SessionId>('foreign-owner') })
    onTestFinished(() => owner.dispose())
    const child = await h.ctx.agents.create({
      sessionId: brandString<SessionId>('foreign-child'),
      meta: { parentSession: h.agent.session.id },
    })
    onTestFinished(() => child.dispose())
    bindSubagentActivation(h.ctx, child.agent, owner.agent)
    child.agent.session.append('turn/start', { turn: 1 })
    const clientDecision = vi.fn(async () => ({ outcome: 'allowed-once' }))
    h.client.onRequest(clientDecision)
    h.ctx.on('approval/request', () => Promise.resolve('rejected'))
    await expect(h.ctx.approval.request({ agent: child.agent, toolName: 'bash' })).resolves.toBe('rejected')
    expect(clientDecision).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'SubagentError', code: 'UNAUTHORIZED' },
    Object.assign(new Error('not a managed subagent'), { name: 'SubagentError', code: 'UNAUTHORIZED' }),
  ])('delegates approval for an unauthorized ownership lookup by error fields: %s', async (error) => {
    const h = await setup(true, true)
    const foreign = await h.ctx.agents.create({ sessionId: brandString<SessionId>('foreign') })
    onTestFinished(() => foreign.dispose())
    foreign.agent.session.append('turn/start', { turn: 1 })
    vi.spyOn(h.ctx.subagents, 'rootOf').mockImplementationOnce(() => { throw error })
    const clientDecision = vi.fn(async () => ({ outcome: 'allowed-once' }))
    h.client.onRequest(clientDecision)
    const fallback = vi.fn(() => Promise.resolve('rejected' as const))
    h.ctx.on('approval/request', fallback)
    await expect(h.ctx.approval.request({ agent: foreign.agent, toolName: 'bash' })).resolves.toBe('rejected')
    expect(fallback).toHaveBeenCalledOnce()
    expect(clientDecision).not.toHaveBeenCalled()
  })

  it.each([
    new Error('root lookup failed'), new SubagentError('root lookup failed', 'NOT_RESUMABLE'),
    null, undefined, 'root lookup failed', {},
    { name: 'SubagentError' }, { code: 'UNAUTHORIZED' },
    { name: 'OtherError', code: 'UNAUTHORIZED' },
    { name: 'SubagentError', code: 'NOT_RESUMABLE' },
  ])('does not pass a failed ownership lookup to another approval answerer: %s', async (error) => {
    const h = await setup(true, true)
    const foreign = await h.ctx.agents.create({ sessionId: brandString<SessionId>('foreign') })
    onTestFinished(() => foreign.dispose())
    foreign.agent.session.append('turn/start', { turn: 1 })
    vi.spyOn(h.ctx.subagents, 'rootOf').mockImplementationOnce(() => { throw error })
    const fallback = vi.fn(() => Promise.resolve('rejected' as const))
    h.ctx.on('approval/request', fallback)
    await expect(h.ctx.approval.request({ agent: foreign.agent, toolName: 'bash' })).resolves.toBe('unavailable')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('does not claim a disposed Agent when an owned replacement reuses its id', async () => {
    const h = await setup(true, true)
    const old = await h.ctx.agents.create({ sessionId: brandString<SessionId>('reused') })
    bindSubagentActivation(h.ctx, old.agent, h.agent)
    await old.dispose()
    const replacement = await h.ctx.agents.create({ sessionId: old.agent.id })
    onTestFinished(() => replacement.dispose())
    bindSubagentActivation(h.ctx, replacement.agent, h.agent)
    const clientDecision = vi.fn(async () => ({ outcome: 'allowed-once' }))
    h.client.onRequest(clientDecision)
    // Dispatch at the answerer seam: disposal has already closed the old Agent's turn.
    await expect(h.ctx.waterfall('approval/request', { agent: old.agent, toolName: 'bash' },
      () => Promise.resolve('rejected' as const))).resolves.toBe('rejected')
    expect(clientDecision).not.toHaveBeenCalled()
  })

  it('rejects an invalid wire capability flag', async () => {
    const h = await setup()
    await expect(h.client.request('initialize', { cwd: '.', provider: 'mock', model: 'mock', approvalRequests: 'true' }))
      .rejects.toThrow('approvalRequests must be a boolean')
  })
})
