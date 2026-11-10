/** Tool arguments and receipts preserve runtime caller identity through the shared service. */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionControlService, { SessionControlError } from '@deepseek-ai/dsh-session-control'
import type { SessionControlProvider } from '@deepseek-ai/dsh-session-control'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ToolSessionControl from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  const caller = await loop.create(SessionId('sender'))
  await ctx.plugin(SessionControlService)
  const deliver = vi.fn<SessionControlProvider['deliver']>(async request => ({ messageId: request.message.id }))
  ctx.sessionControl.register({ deliver })
  const fiber = await ctx.plugin(ToolSessionControl)
  return { ctx, caller, deliver, fiber }
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

describe('Session message tool', () => {
  it('returns the accepted message id and uses the exact calling Agent', async () => {
    const { ctx, caller, deliver } = await setup()
    const result = await call(ctx, { session_id: 'recipient', message: '  Please review.\nKeep the context.  ' }, caller)
    expect(deliver).toHaveBeenCalledTimes(1)
    const [request, runtime] = deliver.mock.calls[0]!
    expect(runtime.caller).toBe(caller)
    expect(request.id).toBe('recipient')
    expect(request.message.source).toEqual({ kind: 'agent-message', form: 'relay', senderSessionId: caller.id })
    expect(request.message.content).toContainEqual({ type: 'text', text: '  Please review.\nKeep the context.  ' })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ message_id: request.message.id }) }])
  })

  it.each(['', ' ', '\t\n'])('rejects a blank message before delivery (%j)', async (message) => {
    const { ctx, caller, deliver } = await setup()
    const result = await call(ctx, { session_id: 'recipient', message }, caller)
    expect(result).toMatchObject({ isError: true, error: { info: { name: 'ToolArgsError', code: 'INVALID_ARGS' } } })
    expect(deliver).not.toHaveBeenCalled()
  })

  it('requires a runtime caller and ignores model-supplied sender or authority', async () => {
    const { ctx, caller, deliver } = await setup()
    const absent = await call(ctx, { session_id: 'recipient', message: 'Hello' })
    expect(absent).toMatchObject({
      isError: true,
      error: { info: { name: 'ToolContextUnavailableError', code: 'TOOL_CONTEXT_UNAVAILABLE' } },
    })
    const forged = await call(ctx, { session_id: 'recipient', message: 'Hello', sender: 'another', authorized: true }, caller)
    expect(forged.isError).toBe(false)
    expect(deliver).toHaveBeenCalledTimes(1)
    const [request, runtime] = deliver.mock.calls[0]!
    expect(request.message.source).toMatchObject({ senderSessionId: caller.id })
    expect(runtime.caller).toBe(caller)
  })

  it('propagates provider failures without converting them into receipts or retrying', async () => {
    const { ctx, caller, deliver } = await setup()
    deliver.mockRejectedValue(new SessionControlError('Target is archived', 'SESSION_CONTROL_ARCHIVED'))
    const result = await call(ctx, { session_id: 'recipient', message: 'Hello' }, caller)
    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'SessionControlError', code: 'SESSION_CONTROL_ARCHIVED' } },
    })
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('forwards cancellation while waiting for acceptance', async () => {
    const { ctx, caller, deliver } = await setup()
    const entered = Promise.withResolvers<undefined>()
    const controller = new AbortController()
    deliver.mockImplementation(async (_request, runtime) => {
      entered.resolve(undefined)
      await new Promise<void>((_resolve, reject) => {
        runtime.signal.addEventListener('abort', () => { reject(new DOMException('Cancelled', 'AbortError')) }, { once: true })
      })
      throw new Error('cancelled delivery unexpectedly continued')
    })
    const pending = call(ctx, { session_id: 'recipient', message: 'Hello' }, caller, controller.signal)
    await entered.promise
    controller.abort(new DOMException('Cancelled', 'AbortError'))
    expect(await pending).toMatchObject({ isError: true, error: { info: { name: 'AbortError', code: 'ABORTED' } } })
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('retains an accepted receipt when cancellation arrives before the tool returns', async () => {
    const { ctx, caller, deliver } = await setup()
    const controller = new AbortController()
    deliver.mockImplementation(async (request) => {
      controller.abort(new DOMException('Cancelled after acceptance', 'AbortError'))
      return { messageId: request.message.id }
    })
    const result = await call(ctx, { session_id: 'recipient', message: 'Hello' }, caller, controller.signal)
    expect(deliver).toHaveBeenCalledTimes(1)
    const [request] = deliver.mock.calls[0]!
    expect(result).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: JSON.stringify({ message_id: request.message.id }) }],
    })
  })

  it('keeps the pure Host presentation and removes the tool on unload', async () => {
    const { ctx, fiber } = await setup()
    const tool = ctx.tools.get('session_send_message')!
    expect(tool.presentCall?.({ session_id: 'recipient', message: 'Review this' })).toEqual({
      card: 'generic', kind: 'other', title: 'Send message', rawInput: 'recipient',
      content: [{ type: 'text', text: 'Review this' }],
    })
    const schema = ctx.tools.schemas().find(item => item.name === 'session_send_message')!
    expect(schema.parameters).toMatchObject({
      properties: { session_id: { type: 'string' }, message: { type: 'string' } },
      required: ['session_id', 'message'],
    })
    expect(Object.keys(schema.parameters.properties ?? {})).toEqual(['session_id', 'message'])
    await fiber.dispose()
    expect(ctx.tools.get('session_send_message')).toBeUndefined()
  })
})
