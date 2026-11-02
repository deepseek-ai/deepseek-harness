/** Live tool inspection shares the real Session's unload lifetime, never its replay data. */
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { expect, it, onTestFinished } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import SessionToolResults, { type Config } from '../src/index.ts'

async function setup(value: JsonValue = { answer: 42 }, config: Partial<Config> = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TypertRegistry)
  const feature = ctx.plugin(SessionToolResults, config)
  await feature
  const results = ctx.get('sessionToolResults') as SessionToolResults
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'value', description: 'Return a structured value.', parameters: {},
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'rendered' }] },
    execute: async () => value,
  })))
  await mountAgentLoopTestHarness(ctx)
  let agent!: Agent
  const owner = ctx.plugin({ inject: ['agentLoop'], async apply(inner: Context) {
    agent = await inner.agentLoop.create(SessionId('live-values'))
  } })
  await owner
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session === agent.session) events.push(event) }, { global: true })
  let call = 0
  async function execute() {
    await ctx.tools.execute({
      agent, signal: new AbortController().signal, log: { turn: 1, step: 1 },
      calls: [{ type: 'tool-call', id: ToolCallId(`value-call-${call++}`), name: 'value', arguments: '{}' }],
    })
    const event = events.findLast(event => event.type === 'tool/result')
    if (event === undefined) throw new Error('tool result missing')
    return event
  }
  function watch(seq: number, sessionId = agent.session.id) {
    const abort = new AbortController()
    const iterator = results.watch({ sessionId, seq }, abort.signal)[Symbol.asyncIterator]()
    onTestFinished(async () => { abort.abort(); await iterator.return?.() })
    return iterator
  }
  return { ctx, results, feature, agent, owner, execute, watch }
}

it.each([null, false, 0, '', { answer: 42 }])('retains final live value %j without adding it to the journal', async (value) => {
  const { execute, watch } = await setup(value)
  const event = await execute()
  expect(event.data).not.toHaveProperty('value')
  expect((await watch(event.seq).next()).value).toEqual({ available: true, value })
})

it('defaults to 1000 results and rejects invalid count limits', () => {
  expect(SessionToolResults.Config({}).maxResultsPerSession).toBe(1000)
  for (const maxResultsPerSession of [0, -1, 1.5, Infinity]) {
    expect(() => SessionToolResults.Config({ maxResultsPerSession })).toThrow()
  }
})

it('retains the latest 1000 results and invalidates an inspector when its result is evicted', async () => {
  const { execute, watch } = await setup()
  const first = await execute()
  const second = await execute()
  for (let i = 2; i < 1000; i++) await execute()
  const observer = watch(first.seq)
  expect((await observer.next()).value).toEqual({ available: true, value: { answer: 42 } })
  const evicted = observer.next()
  const latest = await execute()
  expect((await evicted).value).toEqual({ available: false })
  expect((await watch(first.seq).next()).value).toEqual({ available: false })
  expect((await watch(second.seq).next()).value).toEqual({ available: true, value: { answer: 42 } })
  expect((await watch(latest.seq).next()).value).toEqual({ available: true, value: { answer: 42 } })
})

it('keeps one result per Session with a limit of one, independently of other Sessions', async () => {
  const { ctx, execute, watch } = await setup(null, { maxResultsPerSession: 1 })
  const first = await execute()
  const other = await ctx.agentLoop.create(SessionId('other-values'))
  await ctx.tools.execute({
    agent: other, signal: new AbortController().signal, log: { turn: 1, step: 1 },
    calls: [{ type: 'tool-call', id: ToolCallId('other-call'), name: 'value', arguments: '{}' }],
  })
  expect((await watch(first.seq).next()).value).toEqual({ available: true, value: null })
  const latest = await execute()
  expect((await watch(first.seq).next()).value).toEqual({ available: false })
  expect((await watch(latest.seq).next()).value).toEqual({ available: true, value: null })
  expect((await watch(other.session.seq - 1, other.id).next()).value).toEqual({ available: true, value: null })
})

it('counts pending PTC results toward the same limit and cannot restore an evicted value on commit', async () => {
  const { ctx, agent, execute, watch } = await setup(false, { maxResultsPerSession: 2 })
  const first = await execute()
  const firstObserver = watch(first.seq)
  expect((await firstObserver.next()).value).toEqual({ available: true, value: false })
  const evicted = firstObserver.next()
  const callIds = ['pending-1', 'pending-2', 'pending-3'].map(ToolCallId)
  for (const id of callIds) {
    await ctx.tools.execute({
      agent, signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id, name: 'value', arguments: '{}' }],
    })
  }
  expect((await evicted).value).toEqual({ available: false })
  for (const [index, subCallId] of callIds.entries()) {
    const event = agent.session.append('tool/ptc-dispatch', {
      rootCallId: ToolCallId('pending'), parentCallId: ToolCallId('pending'), subCallId,
      name: 'value', arguments: {}, content: [{ type: 'text', text: 'rendered' }], isError: false,
    })
    expect((await watch(event.seq).next()).value).toEqual(index === 0
      ? { available: false } : { available: true, value: false })
  }
})

it('releases values on Session unload and never restores them for a same-id instance', async () => {
  const { ctx, agent, owner, execute, watch } = await setup()
  const event = await execute()
  const first = watch(event.seq)
  expect((await first.next()).value).toEqual({ available: true, value: { answer: 42 } })
  const removed = first.next()
  await owner.dispose()
  expect(ctx.sessions.get(agent.id)).toBeUndefined()
  expect((await removed).value).toEqual({ available: false })
  ctx.sessions.create(agent.id)
  expect((await watch(event.seq).next()).value).toEqual({ available: false })
})

it('observes the final post-policy value and keeps historical and failed results unavailable', async () => {
  const { ctx, execute, watch } = await setup()
  ctx.on('tools/post-execute', async () => ({ kind: 'accept', value: { replacement: true } }))
  const event = await execute()
  expect((await watch(event.seq).next()).value).toEqual({ available: true, value: { replacement: true } })
  expect((await watch(0).next()).value).toEqual({ available: false })
  ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'denied' }))
  const failed = await execute()
  expect((await watch(failed.seq).next()).value).toEqual({ available: false })
})

it('pairs PTC dispatch values with their committed event sequence', async () => {
  const { ctx, agent, watch } = await setup()
  const callId = ToolCallId('nested:ptc:1')
  await ctx.tools.execute({
    agent, signal: new AbortController().signal,
    calls: [{ type: 'tool-call', id: callId, name: 'value', arguments: '{}' }],
  })
  const event = agent.session.append('tool/ptc-dispatch', {
    rootCallId: ToolCallId('nested'), parentCallId: ToolCallId('nested'), subCallId: callId,
    name: 'value', arguments: {}, content: [{ type: 'text', text: 'rendered' }], isError: false,
  })
  expect(event.data).not.toHaveProperty('value')
  expect((await watch(event.seq).next()).value).toEqual({ available: true, value: { answer: 42 } })
})

it('does not let closing one inspector discard values used by another', async () => {
  const { execute, watch } = await setup()
  const event = await execute()
  const first = watch(event.seq)
  await first.next()
  await first.return?.()
  expect((await watch(event.seq).next()).value).toEqual({ available: true, value: { answer: 42 } })
})

it('publishes a committed value to concurrent observers and releases only the closed observer', async () => {
  const { ctx, agent, watch } = await setup()
  const callId = ToolCallId('observed:ptc:1')
  await ctx.tools.execute({
    agent, signal: new AbortController().signal,
    calls: [{ type: 'tool-call', id: callId, name: 'value', arguments: '{}' }],
  })
  const seq = agent.session.seq
  const first = watch(seq)
  const second = watch(seq)
  expect((await first.next()).value).toEqual({ available: false })
  expect((await second.next()).value).toEqual({ available: false })
  await first.return?.()
  const changed = second.next()
  agent.session.append('tool/ptc-dispatch', {
    rootCallId: ToolCallId('observed'), parentCallId: ToolCallId('observed'), subCallId: callId,
    name: 'value', arguments: {}, content: [{ type: 'text', text: 'rendered' }], isError: false,
  })
  expect((await changed).value).toEqual({ available: true, value: { answer: 42 } })
})

it('keeps cold reads unavailable after unloading a Session with no retained results', async () => {
  const { owner, watch } = await setup()
  await owner.dispose()
  expect((await watch(0).next()).value).toEqual({ available: false })
})

it('ends active observers when the service owner is disposed', async () => {
  const { ctx, execute, watch } = await setup()
  const event = await execute()
  const observer = watch(event.seq)
  await observer.next()
  const finished = observer.next()
  await ctx.fiber.dispose()
  expect((await finished).done).toBe(true)
})

it('unloads the Trajectory service without retaining values across a remount', async () => {
  const { ctx, feature, agent, execute, watch } = await setup()
  const event = await execute()
  const observer = watch(event.seq)
  expect((await observer.next()).value).toEqual({ available: true, value: { answer: 42 } })
  const finished = observer.next()
  await feature.dispose()
  expect((await finished).done).toBe(true)
  expect(ctx.get('sessionToolResults')).toBeUndefined()
  expect(ctx.sessions.get(agent.id)).toBe(agent.session)
  const missed = await execute()
  await ctx.plugin(SessionToolResults)
  const abort = new AbortController()
  const remounted = ctx.get('sessionToolResults') as SessionToolResults
  const restored = remounted.watch({ sessionId: agent.id, seq: event.seq }, abort.signal)[Symbol.asyncIterator]()
  const absent = remounted.watch({ sessionId: agent.id, seq: missed.seq }, abort.signal)[Symbol.asyncIterator]()
  onTestFinished(async () => { abort.abort(); await restored.return?.(); await absent.return?.() })
  expect((await restored.next()).value).toEqual({ available: false })
  expect((await absent.next()).value).toEqual({ available: false })
})

it('ends a subscription whose signal was aborted before opening', async () => {
  const { results, agent } = await setup()
  const abort = new AbortController()
  abort.abort()
  const observer = results.watch({ sessionId: agent.id, seq: 0 }, abort.signal)[Symbol.asyncIterator]()
  expect((await observer.next()).done).toBe(true)
})

it('discards pending PTC values if the Session unloads before its result is committed', async () => {
  const { ctx, agent, owner, watch } = await setup()
  const callId = ToolCallId('unloaded:ptc:1')
  await ctx.tools.execute({
    agent, signal: new AbortController().signal,
    calls: [{ type: 'tool-call', id: callId, name: 'value', arguments: '{}' }],
  })
  const observer = watch(agent.session.seq)
  expect((await observer.next()).value).toEqual({ available: false })
  const unloaded = observer.next()
  await owner.dispose()
  expect((await unloaded).value).toEqual({ available: false })
  const resumed = ctx.sessions.create(agent.id)
  const committed = resumed.append('tool/ptc-dispatch', {
    rootCallId: ToolCallId('unloaded'), parentCallId: ToolCallId('unloaded'), subCallId: callId,
    name: 'value', arguments: {}, content: [{ type: 'text', text: 'rendered' }], isError: false,
  })
  expect((await watch(committed.seq).next()).value).toEqual({ available: false })
})
