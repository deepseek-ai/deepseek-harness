// Real AgentLoop fixture adapted from kermanx/dsh-progress-check (MIT).
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, isAgentLoopRequest, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type {} from '@deepseek-ai/dsh-session-persistence'
import * as Timeline from '../src/index.ts'

export const textOutput = {
  schema: { type: 'string' },
  render: (_args: unknown, text: string) => [{ type: 'text' as const, text }],
} as const

export const summary = {
  progress: ['The session recovery fix is in place.', 'Next, check recovery after restart.'],
  uncertainties: [],
  userActions: [],
}
export function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}
export async function untilReleased(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return
  const abort = Promise.withResolvers<undefined>()
  const done = () => { abort.resolve(undefined) }
  signal?.addEventListener('abort', done, { once: true })
  try {
    await Promise.race([promise, abort.promise])
  } finally {
    signal?.removeEventListener('abort', done)
  }
}
export class Adapter extends LlmAdapter {
  main: GenerateOptions[] = []
  checks: GenerateOptions[] = []
  ready = Promise.withResolvers<undefined>()
  checkStarted = Promise.withResolvers<undefined>()
  release = Promise.withResolvers<undefined>()
  checkRelease: ReturnType<typeof Promise.withResolvers<undefined>> | undefined
  answer = JSON.stringify(summary)
  answers: string[] = []
  tinyDeltas = false
  calls = 1
  steps = 1
  fail = false
  active = 0
  peak = 0
  reasoning: LlmModelReasoningInfo | undefined
  mainActions: ((request: GenerateOptions) => { name: string; arguments: string }[])[] = []
  private counts = new Map<string, number>()
  private waiters: { count: number; resolve(): void }[] = []
  waitForMain(count: number): Promise<void> {
    if (this.main.length >= count) return Promise.resolve()
    return new Promise((resolve) => {
      this.waiters.push({ count, resolve })
    })
  }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...(this.reasoning === undefined ? {} : { reasoning: this.reasoning }),
    })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!isAgentLoopRequest(options)) {
      this.checks.push(options)
      this.active++
      this.peak = Math.max(this.peak, this.active)
      this.checkStarted.resolve(undefined)
      try {
        if (this.checkRelease !== undefined) await untilReleased(this.checkRelease.promise, options.signal)
        options.signal?.throwIfAborted()
        if (this.fail) throw new Error('Fixture summary failure')
        const answer = this.answers.shift() ?? this.answer
        if (this.tinyDeltas) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          for (const text of answer) yield { type: 'text-delta', index: 0, text }
        }
        yield* textChunks(answer)
      } finally {
        this.active--
      }
      return
    }
    this.main.push(options)
    for (const waiter of this.waiters) if (this.main.length >= waiter.count) waiter.resolve()
    const id = options.sessionId ?? ''
    const step = this.counts.get(id) ?? 0
    this.counts.set(id, step + 1)
    const action = this.mainActions[step]
    if (action !== undefined || (step < this.steps && this.calls > 0)) {
      const calls =
        action?.(options) ?? Array.from({ length: this.calls }, () => ({ name: 'echo', arguments: '{}' }))
      for (const [index, call] of calls.entries())
        yield {
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: ToolCallId(`${id}-${step}-${index}`), ...call },
        }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    this.ready.resolve(undefined)
    await untilReleased(this.release.promise, options.signal)
    if (!options.signal?.aborted) yield* textChunks('Main task finished.')
  }
}
export async function setup(
  config: Partial<Timeline.Config> = {},
  adapter = new Adapter(),
  restore?: { root: string; sessionId: SessionId },
) {
  const root = restore?.root ?? (await mkdtemp(join(tmpdir(), 'dsh-timeline-test-')))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Jsonl, { root, compression: 'none' })
  ctx.llm.registerAdapter(['fixture'], adapter)
  ctx.tools.register(
    defineTool({
      name: 'echo',
      description: 'Read a fixture',
      parameters: {},
      output: textOutput,
      execute: () => Promise.resolve('Fixture read complete'),
    }),
  )
  // Scheduler tests deliberately use the minimum interval; production defaults are tested separately.
  const rollupFactors = config.intervalMs === 86400000 ? [] : [5, 12, 24]
  const plugin = await ctx.plugin(Timeline, { intervalMs: 60000, rollupFactors, ...config })
  const harness = await mountAgentLoopTestHarness(ctx)
  let lifecycle
  try {
    lifecycle =
      restore === undefined
        ? await ctx.agents.create({
          sessionId: SessionId(`timeline-${Math.random()}`),
          meta: { cwd: process.cwd() },
          agentOptions: { provider: 'fixture', model: 'timeline' },
        })
        : await ctx.agents.resume({
          resumeSessionId: restore.sessionId,
          agentOptions: { provider: 'fixture', model: 'timeline' },
        })
  } catch (error: unknown) {
    await ctx.fiber.dispose()
    if (restore === undefined) await rm(root, { recursive: true, force: true })
    throw error
  }
  const agent = lifecycle.agent
  const handle = await ctx.sessionPersistence.open(agent.session.id, 'read')
  const events: SessionEvent[] = []
  const records = agent.session.snapshotEvents().flatMap((event) => {
    const record = pluginRecordOf(event)
    return record?.type.startsWith('plugin:timeline/') === true ? [record] : []
  })
  ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    events.push(event)
    const record = pluginRecordOf(event)
    if (record?.type.startsWith('plugin:timeline/') === true) records.push(record)
  })
  const start = () => {
    agent.followup(
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Fix session recovery.' }],
      }),
    ) }
  const reports = () => ctx.timeline.stateOf(agent.session).view.reports
  const waitRecords = async (type: string, count = 1, sessionId = agent.session.id) => {
    const present = () => {
      if (sessionId === agent.session.id) return records.filter(record => record.type === type).length
      const session = ctx.sessions.get(sessionId)
      return session === undefined ? 0 : ctx.timeline.stateOf(session).view.reports.length
    }
    if (present() < count)
      await new Promise<void>((resolve) => {
        const off = ctx.on('session/event', () => {
          // Wait for Session observers before reading the projection.
          setImmediate(() => {
            if (present() >= count) {
              off()
              resolve()
            }
          })
        })
      })
    await ctx.sessions.flush(agent.session)
    await settle()
  }
  const close = async (options: { preserve?: boolean } = {}) => {
    for (const current of ctx.agents.list()) current.cancel({ kind: 'disposed' })
    await Promise.all(ctx.agents.list().map(current => current.whenIdle()))
    await ctx.fiber.dispose()
    await handle.close()
    if (!options.preserve) await rm(root, { recursive: true, force: true })
  }
  return {
    ctx,
    root,
    agent,
    handle,
    adapter,
    events,
    records,
    plugin,
    start,
    close,
    reports,
    harness,
    waitRecords,
    disposeAgent: () => lifecycle.dispose(),
  }
}
export async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) await new Promise<void>(resolve => setImmediate(resolve))
}
