/** Session messages activate targets through the Web Session controller and attribute the real sender. */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ToolSessionControl from '../src/index.ts'

class ReplyAdapter extends LlmAdapter {
  async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    request.signal?.throwIfAborted()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'received' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

type ApiSessionAgentResult = Awaited<ReturnType<Context['sessionController']['resolveAgent']>>

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter(['fixture'], new ReplyAdapter())
  const options = { provider: 'fixture', model: 'reply' }
  const caller = await loop.create(brandString<SessionId>('sender'), options, { cwd: '/workspace/sender' })
  const target = await loop.create(brandString<SessionId>('recipient'), options, { cwd: '/elsewhere/recipient' })
  const archivedSessionIds: SessionId[] = []
  const resolveAgent = vi.fn(async (id: SessionId): Promise<ApiSessionAgentResult> => {
    const agent = ctx.agents.get(id)
    return agent === undefined
      ? { error: new RemoteError('session/not-found', `session "${id}" not found`, { sessionId: id }) }
      : { agent }
  })
  ctx.provide('sessionController', { resolveAgent } as never)
  ctx.provide('workspaceRegistry', { archivedSessionIds } as never)
  const fiber = await ctx.plugin(ToolSessionControl)
  return { ctx, caller, target, archivedSessionIds, resolveAgent, fiber }
}

function call(ctx: Context, args: unknown, caller?: Agent, signal = new AbortController().signal) {
  return executeToolFixture(ctx, {
    name: 'session_send_message',
    callId: ToolCallId('send-call'),
    arguments: args,
    signal,
    ...(caller === undefined ? {} : { agent: caller }),
  })
}

function agentMessages(agent: Agent) {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'user/message'
    && event.data.source.kind === 'agent-message' ? [event.data] : [])
}

describe('Session message tool', () => {
  it('delivers to an ordinary Session in another directory under the real sender', async () => {
    const { ctx, caller, target, resolveAgent } = await setup()
    const result = await call(ctx, { session_id: target.id, message: '  Please review.\nKeep the context.  ', sender: 'forged' }, caller)
    expect(resolveAgent).toHaveBeenCalledWith(target.id)
    await target.whenIdle()
    const [message] = agentMessages(target)
    expect(message).toMatchObject({
      source: { kind: 'agent-message', form: 'relay', senderSessionId: caller.id },
      content: [
        { type: 'text', text: `Session ${caller.id} sent a message: ` },
        { type: 'text', text: '  Please review.\nKeep the context.  ' },
      ],
    })
    expect(result).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: JSON.stringify({ message_id: message!.id }) }],
    })
    expect(agentMessages(caller)).toEqual([])
  })

  it.each(['', ' ', '\t\n'])('rejects a blank message before activation (%j)', async (message) => {
    const { ctx, caller, resolveAgent } = await setup()
    const result = await call(ctx, { session_id: 'recipient', message }, caller)
    expect(result).toMatchObject({ isError: true, error: { info: { name: 'ToolArgsError', code: 'INVALID_ARGS' } } })
    expect(resolveAgent).not.toHaveBeenCalled()
  })

  it('requires a calling Agent and refuses to message itself', async () => {
    const { ctx, caller, resolveAgent } = await setup()
    expect(await call(ctx, { session_id: 'recipient', message: 'Hello' })).toMatchObject({
      isError: true,
      error: { info: { name: 'ToolContextUnavailableError', code: 'TOOL_CONTEXT_UNAVAILABLE' } },
    })
    expect(await call(ctx, { session_id: caller.id, message: 'Hello' }, caller)).toMatchObject({
      isError: true,
      error: { info: { name: 'SessionMessageError', code: 'SESSION_MESSAGE_SELF' } },
    })
    expect(resolveAgent).not.toHaveBeenCalled()
  })

  it('rejects archived targets before activation and after an activation wait', async () => {
    const { ctx, caller, target, archivedSessionIds, resolveAgent } = await setup()
    archivedSessionIds.push(target.id)
    expect(await call(ctx, { session_id: target.id, message: 'Hello' }, caller)).toMatchObject({
      isError: true,
      error: { info: { name: 'SessionMessageError', code: 'SESSION_MESSAGE_ARCHIVED' } },
    })
    expect(resolveAgent).not.toHaveBeenCalled()

    archivedSessionIds.splice(0)
    resolveAgent.mockImplementationOnce(async () => {
      archivedSessionIds.push(target.id)
      return { agent: target }
    })
    expect(await call(ctx, { session_id: target.id, message: 'Hello' }, caller)).toMatchObject({
      isError: true,
      error: { info: { name: 'SessionMessageError', code: 'SESSION_MESSAGE_ARCHIVED' } },
    })
    expect(agentMessages(target)).toEqual([])
  })

  it('reports subagent targets as unavailable and keeps other controller failures', async () => {
    const { ctx, caller, resolveAgent } = await setup()
    const ownership = new RemoteError('session/agent-busy', 'session "child" is owned by subagent routing', {
      reason: 'use subagent delivery for this child session',
    })
    resolveAgent.mockResolvedValueOnce({ error: ownership })
    const subagent = await call(ctx, { session_id: 'child', message: 'Hello' }, caller)
    expect(subagent).toMatchObject({
      isError: true,
      error: { info: { name: 'SessionMessageError', code: 'SESSION_MESSAGE_SUBAGENT_OWNED' } },
    })
    expect(subagent.content).toEqual([{
      type: 'text', text: 'Error: session "child" is not available to session_send_message',
    }])
    expect(await call(ctx, { session_id: 'missing', message: 'Hello' }, caller)).toMatchObject({
      isError: true,
      error: { info: { code: 'session/not-found' } },
    })
  })

  it('stops waiting at cancellation and never delivers after the activation settles', async () => {
    const { ctx, caller, target, resolveAgent } = await setup()
    const activation = Promise.withResolvers<ApiSessionAgentResult>()
    resolveAgent.mockReturnValueOnce(activation.promise)
    const controller = new AbortController()
    const pending = call(ctx, { session_id: target.id, message: 'Hello' }, caller, controller.signal)
    await vi.waitFor(() => { expect(resolveAgent).toHaveBeenCalledTimes(1) })
    controller.abort(new DOMException('Cancelled', 'AbortError'))
    expect(await pending).toMatchObject({ isError: true, error: { info: { name: 'AbortError', code: 'ABORTED' } } })
    activation.resolve({ agent: target })
    await activation.promise
    await target.whenIdle()
    expect(agentMessages(target)).toEqual([])
  })

  it('reports an inbox write failure', async () => {
    const { ctx, caller, target, resolveAgent } = await setup()
    const failure = new Error('inbox write failed')
    vi.spyOn(target, 'steer').mockImplementation(() => { throw failure })
    resolveAgent.mockResolvedValueOnce({ agent: target })
    const result = await call(ctx, { session_id: target.id, message: 'Hello' }, caller)
    expect(result).toMatchObject({ isError: true, error: { message: 'inbox write failed' } })
  })

  it('reports cancellation after acceptance without retracting the delivered message', async () => {
    const { ctx, caller, target } = await setup()
    const controller = new AbortController()
    ctx.on('agent/inbox/inserted', ({ agent }) => {
      if (agent === target) controller.abort(new DOMException('Cancelled after acceptance', 'AbortError'))
    })
    const result = await call(ctx, { session_id: target.id, message: 'Hello' }, caller, controller.signal)
    await target.whenIdle()
    const [message] = agentMessages(target)
    expect(message).toMatchObject({
      source: { kind: 'agent-message', form: 'relay', senderSessionId: caller.id },
      content: [{ type: 'text', text: `Session ${caller.id} sent a message: ` }, { type: 'text', text: 'Hello' }],
    })
    expect(agentMessages(target)).toHaveLength(1)
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Error: tool call aborted' }],
      error: { info: { name: 'AbortError', code: 'ABORTED' } },
    })
    expect(result).not.toHaveProperty('value')
  })

  it('keeps the pure Host presentation and removes the tool on unload', async () => {
    const { ctx, fiber } = await setup()
    const tool = ctx.tools.get('session_send_message')!
    expect(tool.presentCall?.({ session_id: 'recipient', message: 'Review this' })).toEqual({
      card: 'generic', kind: 'other', title: 'Send message', rawInput: 'recipient',
      content: [{ type: 'text', text: 'Review this' }],
    })
    const schema = ctx.tools.schemas().find(item => item.name === 'session_send_message')!
    expect(Object.keys(schema.parameters.properties ?? {})).toEqual(['session_id', 'message'])
    expect(schema.parameters.required).toEqual(['session_id', 'message'])
    await fiber.dispose()
    expect(ctx.tools.get('session_send_message')).toBeUndefined()
  })
})
