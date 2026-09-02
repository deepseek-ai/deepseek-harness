import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import * as CompactionInvariant from '@deepseek-ai/dsh-compaction/invariant'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { CompactionId, isCompactCheckpointSource, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import {
  createAssistantMessage,
  createUserMessage,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  SummarizationInput,
  SummaryResult,
} from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'

const MODEL = 'mock'
const SIGNAL = new AbortController().signal
const PROMPT = 'older conversation history '.repeat(60)

/** A summarizer under test control: it can block, fail, or mutate mid-call. */
class GatedCompactionEngine extends BasicCompactionEngine {
  summary: ContentBlock[] = [{ type: 'text', text: 'checkpoint' }]
  rawOutput: ContentBlock[] | undefined
  usage: TokenUsage | undefined
  error: unknown
  gate: Promise<undefined> | undefined
  duringSummary: (() => void) | undefined
  calls: SummarizationInput[] = []

  override async summarize(
    input: SummarizationInput,
    _agent: Agent,
    _signal?: AbortSignal,
  ): Promise<SummaryResult> {
    this.calls.push(input)
    this.duringSummary?.()
    if (this.gate !== undefined) await this.gate
    if (this.error !== undefined) throw this.error
    return {
      summary: this.summary,
      ...this.rawOutput === undefined ? {} : { rawOutput: this.rawOutput },
      provider: 'summary-provider',
      model: 'summary-model',
      ...this.usage === undefined ? {} : { usage: this.usage },
    }
  }
}

/** One text answer per request, with a context window large enough to avoid pressure. */
class TextAdapter extends LlmAdapter {
  readonly requests: Message[][] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 100_000 },
    })
  }

  override async * stream(options: { messages: readonly Message[] }): AsyncIterable<StreamChunk> {
    this.requests.push([...options.messages])
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface LoopHarness {
  readonly ctx: Context
  readonly agent: Agent
  readonly compact: GatedCompactionEngine
  readonly adapter: TextAdapter
  readonly log: string[]
}

/** Real loop, session store, and invariant companions around manual compaction. */
async function loopHarness(): Promise<LoopHarness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
  await ctx.plugin(CompactionInvariant)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  const adapter = new TextAdapter()
  ctx.llm.registerAdapter([MODEL], adapter)
  const compact = new GatedCompactionEngine(ctx, { auto: false })
  const agent = await ctx.agentLoop.create(SessionId('manual-compact'), { provider: MODEL, model: MODEL })
  const log: string[] = []
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/start') log.push('turn/start')
    if (event.type === 'turn/end') log.push('turn/end')
    if (event.type === 'compaction/start') log.push(`compaction/start:${String(event.data.turn)}`)
    if (event.type === 'compaction/summary') log.push('compaction/summary')
    if (event.type === 'compaction/end') log.push(`compaction/end:${String(event.data.turn)}`)
    if (event.type === 'user/message') log.push('user/message')
  })
  ctx.on('session/flush', () => { log.push('flush') })
  return { ctx, agent, compact, adapter, log }
}

/** Drive one real turn so the closed history holds a compactable older span. */
async function seedHistory(harness: LoopHarness): Promise<void> {
  harness.agent.followup(createUserMessage({
    content: [{ type: 'text', text: PROMPT }],
    source: { kind: 'user' },
  }))
  await harness.agent.whenIdle()
  harness.log.length = 0
}

/** Text of every derived model-visible message, in request order. */
function derivedText(session: Session): string[] {
  return session.deriveMessages().map((message: Message) => message.content
    .map(block => block.type === 'text' ? block.text : '')
    .join(''))
}

/** Await one classified manual-compaction rejection. */
async function rejection(operation: Promise<unknown> | (() => Promise<unknown>)): Promise<ManualCompactionError> {
  let caught: unknown
  try {
    const value = await (typeof operation === 'function' ? operation() : operation)
    throw new Error(`expected a rejection, resolved with ${String(value)}`)
  } catch (error: unknown) {
    caught = error
  }
  if (!(caught instanceof ManualCompactionError)) {
    throw new Error(`expected a ManualCompactionError, got ${String(caught)}`)
  }
  return caught
}

/** The Error a classified failure wraps. */
function causeOf(error: ManualCompactionError): Error {
  const { cause } = error
  if (!(cause instanceof Error)) throw new Error(`expected an Error cause, got ${String(cause)}`)
  return cause
}

function deferred(): { promise: Promise<undefined>; resolve: () => void } {
  const { promise, resolve } = Promise.withResolvers<undefined>()
  return { promise, resolve: () => { resolve(undefined) } }
}

/** A closed-tail session with compactable exchanges and no live agent. */
function closedConversation(turns = 2, lastTurnNumber = turns): Session {
  const session = Session.create(SessionId(`closed-${turns}-${lastTurnNumber}`))
  for (let index = 1; index <= turns; index += 1) {
    const turn = index === turns ? lastTurnNumber : index
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${PROMPT} ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (index === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `answer ${turn}` }],
        source: { provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session
}

/** A fake idle agent whose maintenance claim is scripted per test. */
function fakeAgent(
  session: Session,
  reserve: () => (() => void) | undefined,
  maintenanceSignal = new AbortController().signal,
): Agent {
  return {
    session,
    options: { provider: MODEL, model: MODEL },
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const release = reserve()
      if (release === undefined) throw new Error('agent already has active work')
      return task(maintenanceSignal).finally(release)
    },
  } as unknown as Agent
}

/** Service over a store-detached session for failure classification. */
function detachedService(): { ctx: Context; compact: GatedCompactionEngine; flushes: () => number } {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  void new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], new TextAdapter())
  let flushes = 0
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(() => {
    flushes += 1
    return Promise.resolve(false)
  })
  return { ctx, compact: new GatedCompactionEngine(ctx, { auto: false }), flushes: () => flushes }
}

function compactEvents(session: Session): SessionEvent[] {
  return session.snapshotEvents().filter(event => event.type.startsWith('compaction/'))
}

describe('compactNow through the real loop', () => {
  it('holds a prompt accepted during summarization until the standalone bracket is flushed', async () => {
    const harness = await loopHarness()
    const { agent, compact, adapter, log } = harness
    await seedHistory(harness)
    const gate = deferred()
    compact.gate = gate.promise

    const running = compact.compactNow(agent, SIGNAL)
    await Promise.resolve()
    expect(log).toEqual(['compaction/start:null'])
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'after compaction' }],
      source: { kind: 'user' },
    }))
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })

    expect(agent.status).toBe('idle')
    expect(adapter.requests).toHaveLength(1)
    expect(log).toEqual(['compaction/start:null'])

    gate.resolve()
    const result = await running
    expect(result).not.toBeNull()
    await agent.whenIdle()

    const start = log.indexOf('compaction/start:null')
    const summary = log.indexOf('compaction/summary')
    const end = log.indexOf('compaction/end:null')
    const flush = log.indexOf('flush')
    const nextTurn = log.indexOf('turn/start')
    expect(start).toBeLessThan(summary)
    expect(summary).toBeLessThan(end)
    expect(end).toBeLessThan(flush)
    expect(flush).toBeLessThan(nextTurn)
    expect(adapter.requests).toHaveLength(2)
    const second = (adapter.requests[1] ?? []).map(message => message.content
      .map(block => block.type === 'text' ? block.text : '')
      .join(''))
    expect(second[0]).toContain('checkpoint')
    expect(second.at(-1)).toBe('after compaction')
    expect(second.some(text => text.includes(PROMPT))).toBe(false)
  })

  it('keeps context injected during summarization pending for the next step', async () => {
    const harness = await loopHarness()
    const { agent, compact } = harness
    await seedHistory(harness)
    compact.duringSummary = () => {
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: 'INJECTED CONTEXT' }],
        source: { kind: 'plugin', plugin: 'test' },
      }))
    }

    const result = await compact.compactNow(agent, SIGNAL)

    expect(result).not.toBeNull()
    const start = agent.session.snapshotEvents().findLast(event => event.type === 'compaction/start')
    const injected = agent.inbox.nextStep.find(message =>
      message.source.kind === 'plugin' && message.source.plugin === 'test')
    const end = agent.session.snapshotEvents().findLast(event => event.type === 'compaction/end')
    expect(start).toBeDefined()
    expect(injected).toBeDefined()
    expect(end).toBeDefined()
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message'
      && event.data.id === injected?.id)).toBe(false)

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'after compaction' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    const messages = derivedText(agent.session)
    expect(messages[0]).toContain('checkpoint')
    expect(messages.filter(text => text.includes('INJECTED CONTEXT'))).toHaveLength(1)
  })

  it('keeps the marker order when listeners attempt a re-entrant injection', async () => {
    const harness = await loopHarness()
    const { ctx, agent, compact } = harness
    await seedHistory(harness)
    const attempts: string[] = []
    ctx.on('session/event', (_session, event) => {
      if (event.type !== 'compaction/start' && event.type !== 'compaction/summary') return
      attempts.push(event.type)
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: `from ${event.type}` }],
        source: { kind: 'plugin', plugin: 'listener' },
      }))
    })

    const result = await compact.compactNow(agent, SIGNAL)

    expect(attempts).toEqual(['compaction/start', 'compaction/summary'])
    expect(result).not.toBeNull()
    expect(derivedText(agent.session)[0]).toContain('checkpoint')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin' && event.data.source.plugin === 'listener')).toHaveLength(0)
    const types = compactEvents(agent.session).map(event => event.type)
    expect(types).toEqual(['compaction/start', 'compaction/summary', 'compaction/end'])
  })

  it('reports busy without summarizing when a prompt already owns the next turn', async () => {
    const harness = await loopHarness()
    const { agent, compact, adapter } = harness
    await seedHistory(harness)

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'first in line' }],
      source: { kind: 'user' },
    }))
    expect((await rejection(() => compact.compactNow(agent, SIGNAL))).code).toBe('busy')
    expect(compact.calls).toHaveLength(0)

    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
  })

  it('releases turn admission after a summarizer failure and records the failed attempt', async () => {
    const harness = await loopHarness()
    const { agent, compact, adapter } = harness
    await seedHistory(harness)
    compact.error = new Error('summarizer unavailable')
    const before = [...agent.session.surface.nodes]

    expect((await rejection(compact.compactNow(agent, SIGNAL))).code).toBe('summary')
    expect(agent.session.surface.nodes).toEqual(before)
    const markers = compactEvents(agent.session)
    expect(markers.map(event => event.type)).toEqual(['compaction/start', 'compaction/end'])
    expect(markers[1]?.type === 'compaction/end' && markers[1].data.error)
      .toContain('summarizer unavailable')

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'runs after the failure' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
  })
})

describe('compactNow transaction and failure classification', () => {
  it('returns null without writing a bracket for history that cannot be compacted', async () => {
    const { compact } = detachedService()
    const session = Session.create(SessionId('empty'))
    let released = 0
    const agent = fakeAgent(session, () => () => { released += 1 })

    expect(await compact.compactNow(agent, SIGNAL)).toBeNull()
    expect(released).toBe(1)
    expect(compact.calls).toHaveLength(0)
    expect(compactEvents(session)).toEqual([])
  })

  it('commits a standalone bracket without consuming a turn number and checkpoints durability', async () => {
    const { compact, flushes } = detachedService()
    const session = closedConversation(2, 7)
    const agent = fakeAgent(session, () => () => undefined)
    const commandId = CommandId('manual-compact-command')

    const result = await compact.compactNow(agent, SIGNAL, commandId)

    expect(result).not.toBeNull()
    expect(result?.sourceCommandId).toBe(commandId)
    expect(flushes()).toBe(1)
    expect(session.snapshotEvents().filter(event => event.type === 'turn/start').at(-1)?.data.turn).toBe(7)
    const start = session.snapshotEvents().findLast(event => event.type === 'compaction/start')
    const summaryEvent = session.snapshotEvents().findLast(event => event.type === 'compaction/summary')
    const checkpoint = session.snapshotEvents().findLast(
      (event): event is SessionEvent<'user/message'> => event.type === 'user/message'
        && isCompactCheckpointSource(event.data.source),
    )
    const end = session.snapshotEvents().findLast(event => event.type === 'compaction/end')
    const correlated = { compactionId: result?.compactionId, sourceCommandId: commandId }
    expect(start?.data).toEqual({ ...correlated, turn: null })
    expect(summaryEvent?.data.sourceCommandId).toBe(commandId)
    expect(checkpoint?.data.source).toMatchObject(correlated)
    expect(end?.data).toEqual({ ...correlated, turn: null })
  })

  it('reports a live unmatched bracket as busy without summarizing', async () => {
    const { compact } = detachedService()
    const session = closedConversation(2)
    session.append('compaction/start', {
      compactionId: CompactionId('live-manual-compaction'),
      turn: null,
    })
    const agent = fakeAgent(session, () => () => undefined)

    const error = await rejection(() => compact.compactNow(agent, SIGNAL))
    expect(error.code).toBe('busy')
    expect(error.message).toContain('compaction lock is already active')
    expect(compact.calls).toHaveLength(0)
  })

  it('ignores an unmatched bracket inherited before a later end-seed marker', async () => {
    const { compact } = detachedService()
    const original = closedConversation(2)
    original.append('compaction/start', {
      compactionId: CompactionId('stale-manual-compaction'),
      turn: null,
    })
    const reloaded = Session.create(SessionId('stale-orphan'), original.snapshotEvents())
    const boundary = reloaded.snapshotEvents().findLast(event => event.type === 'session/end-seed')
    const orphan = reloaded.snapshotEvents().find(event => event.type === 'compaction/start')
    const agent = fakeAgent(reloaded, () => () => undefined)

    expect(boundary?.seq).toBeGreaterThan(orphan?.seq ?? Number.MAX_SAFE_INTEGER)
    await expect(compact.compactNow(agent, SIGNAL)).resolves.not.toBeNull()
    expect(compact.calls).toHaveLength(1)
  })

  it('scans a stale orphan independently of later repaired turn state', async () => {
    const { compact } = detachedService()
    const original = closedConversation(2)
    original.append('compaction/start', {
      compactionId: CompactionId('reloaded-manual-compaction'),
      turn: null,
    })
    original.append('turn/start', { turn: 3 })
    original.append('turn/end', { turn: 3, reason: { kind: 'interrupted' } })
    const reloaded = Session.create(SessionId('reloaded-orphan'), original.snapshotEvents())
    const agent = fakeAgent(reloaded, () => () => undefined)

    await expect(compact.compactNow(agent, SIGNAL)).resolves.not.toBeNull()
    expect(compact.calls).toHaveLength(1)
  })

  it('refuses an open turn in the log', async () => {
    const { compact } = detachedService()
    const session = closedConversation(2)
    session.append('turn/start', { turn: 3 })
    const agent = fakeAgent(session, () => () => undefined)

    const error = await rejection(compact.compactNow(agent, SIGNAL))
    expect(error.code).toBe('busy')
    expect(error.message).toContain('already has an open turn')
  })

  it('reports busy and skips summarization when admission is unavailable', async () => {
    const { compact } = detachedService()
    const agent = fakeAgent(closedConversation(2), () => undefined)

    expect((await rejection(() => compact.compactNow(agent, SIGNAL))).code).toBe('busy')
    expect(compact.calls).toHaveLength(0)
  })

  it('rejects a selected span replaced during summarization and records an error close', async () => {
    const { compact, flushes } = detachedService()
    const session = closedConversation(2)
    let released = 0
    const agent = fakeAgent(session, () => () => { released += 1 })
    compact.duringSummary = () => {
      const [head] = session.surface.nodes
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'competing replacement' }],
        source: { kind: 'plugin', plugin: 'rival' },
      }), {
        surfaceOp: { op: 'replace', start: head!, end: head! },
        sourceEventSeqs: [head!],
      })
    }

    expect((await rejection(compact.compactNow(agent, SIGNAL))).code).toBe('changed')
    expect(released).toBe(1)
    expect(flushes()).toBe(1)
    expect(compactEvents(session).map(event => event.type)).toEqual(['compaction/start', 'compaction/end'])
  })

  it('rejects a selected span whose middle node was replaced during summarization', async () => {
    const { compact } = detachedService()
    const session = closedConversation(3)
    const agent = fakeAgent(session, () => () => undefined)
    compact.duringSummary = () => {
      const middle = session.surface.nodes[1]
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'rewritten middle node' }],
        source: { kind: 'plugin', plugin: 'rival' },
      }), {
        surfaceOp: { op: 'replace', start: middle!, end: middle! },
        sourceEventSeqs: [middle!],
      })
    }

    const error = await rejection(compact.compactNow(agent, SIGNAL))
    expect(error.code).toBe('changed')
    expect(causeOf(error).message).toContain('span changed during summarization')
  })

  it('revalidates the selected span after the summarizer continuation settles', async () => {
    const { compact, flushes } = detachedService()
    const session = closedConversation(2)
    const gate = deferred()
    compact.gate = gate.promise
    let released = 0
    const agent = fakeAgent(session, () => () => { released += 1 })
    const head = session.surface.nodes[0]!
    const generation = session.surface.replaceGeneration

    const running = compact.compactNow(agent, SIGNAL)
    await Promise.resolve()
    expect(compact.calls).toHaveLength(1)

    gate.resolve()
    queueMicrotask(() => {
      queueMicrotask(() => {
        session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'late competing replacement' }],
          source: { kind: 'plugin', plugin: 'rival' },
        }), {
          surfaceOp: { op: 'replace', start: head, end: head },
          sourceEventSeqs: [head],
        })
      })
    })

    const error = await rejection(running)
    expect(error.code).toBe('changed')
    expect(causeOf(error).message).toContain('selected span')
    expect(released).toBe(1)
    expect(flushes()).toBe(1)
    expect(session.surface.replaceGeneration).toBe(generation + 1)
    expect(session.surface.nodes).not.toContain(head)
    expect(compactEvents(session).map(event => event.type)).toEqual(['compaction/start', 'compaction/end'])
    expect(session.snapshotEvents().some(event => event.type === 'user/message'
      && isCompactCheckpointSource(event.data.source))).toBe(false)
  })

  it('classifies a failing compaction/end as commit failure and leaves one orphan', async () => {
    const { compact, flushes } = detachedService()
    const session = closedConversation(2)
    const agent = fakeAgent(session, () => () => undefined)
    const append = session.append.bind(session)
    vi.spyOn(session, 'append').mockImplementation(((type: string, ...rest: never[]) => {
      if (type === 'compaction/end') throw new Error('boundary rejected')
      return (append as (...args: never[]) => unknown)(type as never, ...rest)
    }) as never)

    const error = await rejection(compact.compactNow(agent, SIGNAL))
    expect(error.code).toBe('commit')
    expect(causeOf(error).message).toBe('boundary rejected')
    vi.restoreAllMocks()
    expect(flushes()).toBe(0)
    expect(session.snapshotEvents().findLast(event => event.type.startsWith('compaction/'))?.type)
      .toBe('compaction/summary')
    expect(compactEvents(session).filter(event => event.type === 'compaction/start')).toHaveLength(1)

    const calls = compact.calls.length
    expect((await rejection(compact.compactNow(agent, SIGNAL))).code).toBe('busy')
    expect(compact.calls).toHaveLength(calls)
  })

  it('keeps a failed error-close as the commit failure and does not flush', async () => {
    const { compact, flushes } = detachedService()
    const session = closedConversation(2)
    let released = 0
    const agent = fakeAgent(session, () => () => { released += 1 })
    compact.error = new Error('summary rejected')
    const append = session.append.bind(session)
    vi.spyOn(session, 'append').mockImplementation(((type: string, ...rest: never[]) => {
      if (type === 'compaction/end') throw new Error('error boundary rejected')
      return (append as (...args: never[]) => unknown)(type as never, ...rest)
    }) as never)

    const error = await rejection(compact.compactNow(agent, SIGNAL))
    vi.restoreAllMocks()
    expect(error.code).toBe('commit')
    expect(causeOf(error).message).toBe('error boundary rejected')
    expect(released).toBe(1)
    expect(flushes()).toBe(0)
    expect(compactEvents(session).map(event => event.type)).toEqual(['compaction/start'])
  })

  it('rejects a selected span whose pricing changed during summarization', async () => {
    const { ctx, compact } = detachedService()
    const session = closedConversation(2)
    const agent = fakeAgent(session, () => () => undefined)
    const meter = ctx.tokenMeter
    const original = meter.measure.bind(meter)
    compact.duringSummary = () => {
      vi.spyOn(meter, 'measure').mockImplementationOnce((target) => {
        const measurement = original(target)
        return {
          ...measurement,
          nodes: measurement.nodes.map((node, index) =>
            index === 0 ? { ...node, tokens: node.tokens + 1 } : node),
        }
      })
    }

    expect((await rejection(compact.compactNow(agent, SIGNAL))).code).toBe('changed')
    vi.restoreAllMocks()
  })

  it('classifies a commit-body failure and still releases admission', async () => {
    const { compact } = detachedService()
    const session = closedConversation(2)
    let released = 0
    const agent = fakeAgent(session, () => () => { released += 1 })
    const append = session.append.bind(session)
    vi.spyOn(session, 'append').mockImplementation(((type: string, ...rest: never[]) => {
      if (type === 'compaction/summary') throw new Error('summary record rejected')
      return (append as (...args: never[]) => unknown)(type as never, ...rest)
    }) as never)

    const error = await rejection(compact.compactNow(agent, SIGNAL))
    vi.restoreAllMocks()
    expect(error.code).toBe('commit')
    expect(released).toBe(1)
    const end = session.snapshotEvents().findLast(event => event.type === 'compaction/end')
    expect(end?.type === 'compaction/end' && end.data.error).toContain('summary record rejected')
    expect(end?.type === 'compaction/end' && end.data.turn).toBeNull()
  })

  it('keeps a commit failure when the durability checkpoint also fails', async () => {
    const { ctx, compact } = detachedService()
    const session = closedConversation(2)
    const agent = fakeAgent(session, () => () => undefined)
    const append = session.append.bind(session)
    vi.spyOn(session, 'append').mockImplementation(((type: string, ...rest: never[]) => {
      if (type === 'compaction/summary') throw new Error('summary record rejected')
      return (append as (...args: never[]) => unknown)(type as never, ...rest)
    }) as never)
    vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('disk full'))

    const error = await rejection(compact.compactNow(agent, SIGNAL))
    expect(error.code).toBe('commit')
    expect(causeOf(error).message).toBe('summary record rejected')
    vi.restoreAllMocks()
  })

  it('compacts a session with no durable turn boundary without creating one', async () => {
    const { compact } = detachedService()
    const session = Session.create(SessionId('turnless'))
    for (const text of [PROMPT, 'recent tail']) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }
    const agent = fakeAgent(session, () => () => undefined)

    const result = await compact.compactNow(agent, SIGNAL)

    expect(result).not.toBeNull()
    expect(session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    expect(session.snapshotEvents().find(event => event.type === 'compaction/start')?.data)
      .toEqual({ compactionId: result?.compactionId, turn: null })
  })

  it('classifies a durability failure after the standalone bracket committed', async () => {
    const { ctx, compact } = detachedService()
    const session = closedConversation(2)
    const agent = fakeAgent(session, () => () => undefined)
    vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('disk full'))

    expect((await rejection(compact.compactNow(agent, SIGNAL))).code).toBe('persistence')
    vi.restoreAllMocks()
    expect(session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
    const start = session.snapshotEvents().findLast(event => event.type === 'compaction/start')
    const end = session.snapshotEvents().findLast(event => event.type === 'compaction/end')
    expect(end?.data).toEqual({ compactionId: start?.data.compactionId, turn: null })
  })

  it('lets a pre-aborted signal win before reservation, measurement, or summarization', async () => {
    const cases = [
      { name: 'busy', session: closedConversation(2), release: undefined },
      { name: 'empty', session: Session.create(SessionId('pre-aborted-empty')), release: () => undefined },
      { name: 'compactable', session: closedConversation(2, 9), release: () => undefined },
    ] as const

    for (const testCase of cases) {
      const { ctx, compact } = detachedService()
      const reserve = vi.fn(() => testCase.release)
      const measure = vi.spyOn(ctx.tokenMeter, 'measure')
      const agent = fakeAgent(testCase.session, reserve)
      const before = testCase.session.snapshotEvents()
      const reason = Object.freeze({ kind: 'cancelled', case: testCase.name })
      const controller = new AbortController()
      controller.abort(reason)

      let thrown: unknown
      try {
        void compact.compactNow(agent, controller.signal)
      } catch (error: unknown) {
        thrown = error
      }
      expect(thrown).toBe(reason)
      expect(reserve).not.toHaveBeenCalled()
      expect(measure).not.toHaveBeenCalled()
      expect(compact.calls).toHaveLength(0)
      expect(testCase.session.snapshotEvents()).toEqual(before)
      vi.restoreAllMocks()
    }
  })

  it('preserves the exact cancellation reason when the summarizer also rejects', async () => {
    const { compact, flushes } = detachedService()
    const controller = new AbortController()
    const reason = new Error('cancelled by the caller')
    let released = 0
    const session = closedConversation(2)
    const agent = fakeAgent(session, () => () => { released += 1 })
    compact.duringSummary = () => { controller.abort(reason) }
    compact.error = new Error('summarizer aborted')

    await expect(compact.compactNow(agent, controller.signal)).rejects.toBe(reason)
    expect(released).toBe(1)
    expect(flushes()).toBe(1)
    const events = compactEvents(session)
    expect(events.map(event => event.type)).toEqual(['compaction/start', 'compaction/end'])
    expect(events[1]?.type === 'compaction/end' && events[1].data.error)
      .toContain('summarizer aborted')
  })

  it('classifies agent cancellation during maintenance as an expected cancellation', async () => {
    const { compact } = detachedService()
    const controller = new AbortController()
    const reason = new Error('agent cancelled maintenance')
    const session = closedConversation(2)
    const agent = fakeAgent(session, () => () => undefined, controller.signal)
    compact.duringSummary = () => { controller.abort(reason) }
    compact.error = new Error('summarizer observed cancellation')

    const error = await rejection(compact.compactNow(agent, SIGNAL))

    expect(error.code).toBe('cancelled')
    expect(error.cause).toBe(reason)
  })

  it('aborts before committing when cancellation lands after summarization', async () => {
    const { compact } = detachedService()
    const controller = new AbortController()
    const reason = new Error('cancelled by the caller')
    const session = closedConversation(2)
    const agent = fakeAgent(session, () => () => undefined)
    compact.duringSummary = () => { controller.abort(reason) }

    await expect(compact.compactNow(agent, controller.signal)).rejects.toBe(reason)
    expect(compactEvents(session).map(event => event.type)).toEqual(['compaction/start', 'compaction/end'])
    expect(session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
  })

  it('waits for the durability checkpoint before cancellation wins and admission releases', async () => {
    const { ctx, compact } = detachedService()
    const controller = new AbortController()
    const reason = new Error('cancelled during flush')
    const flushGate = Promise.withResolvers<boolean>()
    const flush = vi.spyOn(ctx.sessions, 'flush').mockReturnValueOnce(flushGate.promise)
    const session = closedConversation(2)
    let released = 0
    const agent = fakeAgent(session, () => () => { released += 1 })

    const running = compact.compactNow(agent, controller.signal)
    let settled = false
    void running.then(
      () => { settled = true },
      () => { settled = true },
    )
    await vi.waitFor(() => {
      expect(flush).toHaveBeenCalledWith(session)
    })
    controller.abort(reason)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(released).toBe(0)

    flushGate.resolve(false)
    await expect(running).rejects.toBe(reason)
    expect(released).toBe(1)
  })

  it('preserves raw output and usage in the manual summary event', async () => {
    const { compact } = detachedService()
    const session = closedConversation(2)
    const agent = fakeAgent(session, () => () => undefined)
    compact.rawOutput = [
      { type: 'text', text: 'checkpoint' },
      { type: 'reasoning', text: 'hidden reasoning' },
    ]
    compact.usage = { inputTokens: 40, outputTokens: 5 }

    await compact.compactNow(agent, SIGNAL)

    const summary = session.snapshotEvents().find(event => event.type === 'compaction/summary')
    expect(summary?.type === 'compaction/summary' && summary.data.rawOutput).toEqual(compact.rawOutput)
    expect(summary?.type === 'compaction/summary' && summary.data.usage).toEqual(compact.usage)
  })

  it('makes duration derivable from the opening and closing marker times', async () => {
    const { compact } = detachedService()
    const session = closedConversation(2)
    const agent = fakeAgent(session, () => () => undefined)
    compact.gate = new Promise<undefined>((resolve) => {
      setTimeout(() => { resolve(undefined) }, 5)
    })

    await compact.compactNow(agent, SIGNAL)

    const start = session.snapshotEvents().findLast(event => event.type === 'compaction/start')
    const end = session.snapshotEvents().findLast(event => event.type === 'compaction/end')
    expect(start).toBeDefined()
    expect(end).toBeDefined()
    expect(end!.time - start!.time).toBeGreaterThan(0)
  })

  it('excludes concurrent automatic and manual compaction of one session', async () => {
    const { compact } = detachedService()
    const session = closedConversation(3)
    const agent = fakeAgent(session, () => () => undefined)
    const gate = deferred()
    compact.gate = gate.promise

    const manual = compact.compactNow(agent, SIGNAL)
    await Promise.resolve()
    const nodes = session.surface.nodes
    await expect(compact.compactRegion(
      nodes[0]!,
      nodes[1]!,
      agent,
    )).rejects.toThrow('compaction lock is already active')

    gate.resolve()
    compact.gate = undefined
    const result: CompactionResult | null = await manual
    expect(result).not.toBeNull()
  })

  it('excludes a manual request while an explicit region compaction runs', async () => {
    const { compact } = detachedService()
    const session = closedConversation(3)
    session.append('turn/start', { turn: 4 })
    const agent = fakeAgent(session, () => () => undefined)
    const gate = deferred()
    compact.gate = gate.promise
    const nodes = session.surface.nodes
    const region = compact.compactRegion(nodes[0]!, nodes[1]!, agent)
    await Promise.resolve()

    expect((await rejection(compact.compactNow(agent, SIGNAL))).code).toBe('busy')

    gate.resolve()
    compact.gate = undefined
    await expect(region).resolves.toMatchObject({ shadowedSeqs: nodes.slice(0, 2) })
  })
})
