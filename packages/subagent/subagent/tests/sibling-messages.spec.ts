import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { loadStoredSession } from './persistence-helpers.ts'
import { TestSessionQuery } from './test-session-query.ts'

/** A model reply, or a turn that stays open until its Agent is cancelled. */
type Reply = StreamChunk[] | 'hang'

/** Routes each request to the reply queue of the task marker found in its history. */
class RoutedAdapter extends MockAdapter {
  readonly routed: GenerateOptions[] = []

  constructor(private readonly replies: Map<string, Reply[]>) {
    super([])
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.routed.push(options)
    const text = JSON.stringify(options.messages)
    const marker = [...this.replies.keys()].find(key => text.includes(`TASK:${key}`))
    const reply = marker === undefined ? undefined : this.replies.get(marker)?.shift()
    if (reply === undefined) throw new Error(`RoutedAdapter: no reply for ${marker ?? 'unknown agent'}`)
    if (reply !== 'hang') {
      yield* reply
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'working' }
    await new Promise<void>((_resolve, reject) => {
      if (options.signal?.aborted) { reject(new Error('aborted')); return }
      options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })
  }
}

const roots: string[] = []
const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Boot persistence, the Agent loop, one spawn provider, and the routed model. */
async function setup(replies: Record<string, Reply[]>) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-siblings-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  const adapter = new RoutedAdapter(new Map(Object.entries(replies)))
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  disposers.push(() => ctx.fiber.dispose())
  return { ctx, parent, adapter }
}

const signal = new AbortController().signal

/** Start one caller-delivery child whose history carries `TASK:<marker>`. */
async function start(ctx: Context, parent: Agent, marker: string, description = 'shared responsibility'): Promise<SessionId> {
  const started = await ctx.subagents.startActivation({ name: marker,
    provider: 'spawn',
    label: description,
    request: { prompt: [{ type: 'text', text: `TASK:${marker}` }], parent },
    signal,
    delivery: 'caller',
  })
  return started.childId
}

/** Wait until a child's first model request is open. */
async function running(ctx: Context, id: SessionId): Promise<Agent> {
  await vi.waitFor(() => { expect(ctx.agents.get(id)?.status).toBe('running') })
  return ctx.agents.get(id)!
}

/** Wait until a child released its Activation. */
async function settled(ctx: Context, id: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(ctx.agents.get(id)).toBeUndefined() }, { timeout: 5_000 })
}

/** Read a child's stored user messages after its Activation settles. */
async function storedUserMessages(ctx: Context, id: SessionId): Promise<SessionEvent<'user/message'>[]> {
  await settled(ctx, id)
  const stored = await loadStoredSession(ctx.sessionPersistence, id)
  return stored.events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
}

/** Concatenate the text blocks of one message. */
function textOf(event: SessionEvent<'user/message'>): string {
  return event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

describe('subagent sibling messages', () => {
  it('keeps duplicate descriptions as display text and addresses siblings by Session id', async () => {
    const { ctx, parent } = await setup({ a: ['hang'], b: [textResponse('done'), textResponse('resumed')] })
    const a = await start(ctx, parent, 'a')
    const sender = await running(ctx, a)
    const b = await start(ctx, parent, 'b')
    await settled(ctx, b)
    expect(a).not.toBe(b)
    expect(await ctx.subagents.listChildren(parent.id)).toEqual([
      expect.objectContaining({ id: a, mode: 'continuable', label: 'shared responsibility' }),
      expect.objectContaining({ id: b, mode: 'continuable', label: 'shared responsibility' }),
    ])
    expect(parent.session.snapshotEvents().filter(event => event.type === 'subagent/catalog').map(event => event.data.version))
      .toEqual([0, 0])

    await ctx.subagents.sendMessage(sender, b, [{ type: 'text', text: 'hello' }], { signal })
    const delivered = (await storedUserMessages(ctx, b)).find(event => event.data.source.kind === 'agent-message')!
    expect(textOf(delivered)).toBe('Agent a sent a message: hello')
    expect(delivered.data.source).toEqual({ kind: 'agent-message', form: 'relay', senderSessionId: a })
    ctx.subagents.interrupt(a, { kind: 'ancestor', agent: parent })
    await settled(ctx, a)
  })

  it('keeps unrelated parents outside sibling delivery even when descriptions match', async () => {
    const { ctx, parent } = await setup({ a: ['hang'], b: ['hang'] })
    const other = await ctx.agentLoop.create(SessionId('other-parent'), { provider: 'mock', model: 'mock' })
    const a = await start(ctx, parent, 'a')
    const sender = await running(ctx, a)
    const b = await start(ctx, other, 'b')
    await running(ctx, b)
    await expect(ctx.subagents.sendMessage(sender, b, [{ type: 'text', text: 'denied' }], { signal }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    ctx.subagents.interrupt(a, { kind: 'ancestor', agent: parent })
    ctx.subagents.interrupt(b, { kind: 'ancestor', agent: other })
    await Promise.all([settled(ctx, a), settled(ctx, b)])
  })
})
