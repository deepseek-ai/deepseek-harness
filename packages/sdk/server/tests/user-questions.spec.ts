import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'

const questions = [{ id: 'format', question: 'Which format?', options: [{ label: 'CSV' }, { label: 'JSON' }] }]
const answer = { answers: [{ id: 'format', selected: ['CSV'], custom: 'include a header' }] }

async function fixture(request: JsonRpcTransportPeer['request'], hostQuestions = true) {
  const root = await mkdtemp(join(tmpdir(), 'sdk-user-questions-'))
  const ctx = new Context()
  const state: { server?: HarnessSdkJsonRpcServer } = {}
  onTestFinished(async () => {
    try { await state.server?.shutdown() } finally {
      try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(UserQuestions)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ready')]))
  const transport = { request: vi.fn(request), notify: vi.fn() }
  const server = state.server = new HarnessSdkJsonRpcServer(ctx, transport)
  await server.initialize({ cwd: root, provider: 'mock', model: 'mock', capabilities: { userQuestions: hostQuestions } })
  await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'start' }] })
  await server.wait({ sessionId: 'main' })
  const agent = ctx.agents.get(SessionId('main'))!
  return { ctx, server, transport, agent }
}

it('forwards the original questions and maps the host answer to the SDK-owned root', async () => {
  const f = await fixture(async () => answer)
  await expect(f.ctx.userQuestions.ask({ agent: f.agent, questions })).resolves.toEqual(answer)
  expect(f.transport.request).toHaveBeenCalledWith('user-question/ask', {
    requestId: expect.any(String) as string, sessionId: 'main', questions,
  }, expect.any(AbortSignal))
  expect(f.transport.notify).not.toHaveBeenCalledWith('user-question.cancelled', expect.anything())
})

it('keeps native answerers when the SDK host did not advertise question support', async () => {
  const f = await fixture(async () => { throw new Error('must not ask the host') }, false)
  await expect(f.ctx.userQuestions.ask({ agent: f.agent, questions })).rejects.toMatchObject({ code: 'NO_PROVIDER' })
  f.ctx.on('user-questions/request', async () => answer)
  await expect(f.ctx.userQuestions.ask({ agent: f.agent, questions })).resolves.toEqual(answer)
  expect(f.transport.request).not.toHaveBeenCalled()
})

it('does not forward questions belonging to another runtime root', async () => {
  const f = await fixture(async () => answer)
  const foreign = await f.ctx.agents.create({ sessionId: SessionId('foreign'), agentOptions: { provider: 'mock', model: 'mock' } })
  try {
    await expect(f.ctx.userQuestions.ask({ agent: foreign.agent, questions })).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    expect(f.transport.request).not.toHaveBeenCalled()
  } finally {
    await foreign.dispose()
  }
})

it.each([
  null,
  42,
  {},
  { answers: false },
  { answers: [null] },
  { answers: ['wrong'] },
  { answers: [{ selected: [] }] },
  { answers: [{ id: 42, selected: [] }] },
  { answers: [{ id: 'format' }] },
  { answers: [{ id: 'format', selected: false }] },
  { answers: [] },
  { answers: [{ id: 'wrong', selected: [] }] },
  { answers: [{ id: 'format', selected: [] }, { id: 'format', selected: [] }] },
  { answers: [{ id: 'format', selected: [1] }] },
  { answers: [{ id: 'format', selected: [], custom: false }] },
])('rejects an invalid host answer without treating it as approval: %j', async (value) => {
  const f = await fixture(async () => value)
  await expect(f.ctx.userQuestions.ask({ agent: f.agent, questions })).rejects.toMatchObject({ code: 'BAD_ANSWER' })
})

it.each(['tool', 'shutdown'] as const)('cancels an outstanding host request on %s cancellation', async (kind) => {
  const entered = Promise.withResolvers<AbortSignal>()
  const f = await fixture(async (_method, _params, signal) => {
    if (signal === undefined) throw new Error('question must have a cancellation signal')
    entered.resolve(signal)
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('question cancelled')) }, { once: true })
    })
  })
  const controller = new AbortController()
  const pending = f.ctx.userQuestions.ask({ agent: f.agent, questions, signal: controller.signal })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  const signal = await entered.promise
  if (kind === 'tool') controller.abort(new Error('user cancelled the tool'))
  else await f.server.shutdown()
  await rejected
  expect(signal.aborted).toBe(true)
  expect(f.transport.notify).toHaveBeenCalledWith('user-question.cancelled', {
    requestId: expect.any(String) as string, sessionId: 'main',
  })
})

it('reports a host or transport failure and does not synthesize an answer', async () => {
  const f = await fixture(async () => { throw new Error('host disconnected') })
  await expect(f.ctx.userQuestions.ask({ agent: f.agent, questions })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
})

it('contains cancellation-notification write failure while aborting the pending question', async () => {
  const entered = Promise.withResolvers<undefined>()
  const f = await fixture(async (_method, _params, signal) => {
    entered.resolve(undefined)
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
    })
  })
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  const notify = f.transport.notify.getMockImplementation()
  f.transport.notify.mockImplementation((method) => {
    if (method === 'user-question.cancelled') throw new Error('broken output')
  })
  const controller = new AbortController()
  const rejected = expect(f.ctx.userQuestions.ask({ agent: f.agent, questions, signal: controller.signal }))
    .rejects.toMatchObject({ code: 'ASK_ABORTED' })
  await entered.promise
  controller.abort(new Error('cancel'))
  await rejected
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('cancellation could not reach the host'))
  warn.mockRestore()
  if (notify !== undefined) f.transport.notify.mockImplementation(notify)
})
