/**
 * Activity harness: the sessions harness (real AgentLoop, JSONL session persistence, memory storage) plus what one
 * scripted turn needs to stream reasoning, request real tool calls and answer: two registered tools, a model that
 * yields whole scripted steps, and an {@link ImActivityTracker} recording every `im/activity` emission.
 */
import { Context } from '@deepseek-ai/cordis'
import { h } from '@deepseek-ai/cordis-plugin-im-core'
import type { Agent, AgentStatus, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import {
  ImChatKey, ImMessageKey, ImSourceId,
  type ImActivity, type ImActivityChange, type ImChat, type ImMessage, type ImSessionRecord, type ImSessionSpec,
} from '../../src/api.ts'
import { ImActivityTracker } from '../../src/activity.ts'
import { sessionIdOf } from '../../src/hosting.ts'
import { boot, COMPOSITION, type SessionsHarness } from './sessions-harness.ts'

/** The chat, trigger and record every activity test drives. */
export const CHAT: ImChat = {
  key: ImChatKey('fake:bot', 'chat'), bot: 'fake:bot', ref: { id: 'chat', type: 'group' }, source: ImSourceId('team'),
}

/** One model call: the chunks it yields, or a body that streams (and may wait or throw) itself. */
export type ModelStep = readonly StreamChunk[] | ((options: GenerateOptions) => AsyncIterable<StreamChunk>)

/** Replace the harness model by a sequence of steps; the last step repeats. */
export function script(harness: SessionsHarness, steps: readonly ModelStep[]): void {
  const { model } = harness
  let index = 0
  model.stream = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    const step = steps[Math.min(index, steps.length - 1)]
    index += 1
    model.requests.push(options)
    if (typeof step === 'function') {
      yield* step(options)
      return
    }
    yield* step ?? []
  }
}

/** Chunks of one reasoning block at `index`. */
export function reasoning(index: number, text: string): StreamChunk[] {
  return parts(index, 'reasoning', [text])
}

/** Chunks of one text block at `index`. */
export function text(index: number, value: string): StreamChunk[] {
  return parts(index, 'text', [value])
}

/** Chunks of one text or reasoning block, delivered as one delta per part (the model streams in pieces). */
export function parts(index: number, blockType: 'text' | 'reasoning', values: readonly string[]): StreamChunk[] {
  const whole = values.join('')
  const deltas: StreamChunk[] = values.map(value => (blockType === 'text'
    ? { type: 'text-delta', index, text: value }
    : { type: 'reasoning-delta', index, text: value }))
  return [
    { type: 'block-start', index, blockType },
    ...deltas,
    { type: 'block-end', index, block: blockType === 'text' ? { type: 'text', text: whole } : { type: 'reasoning', text: whole } },
  ]
}

/** Chunks of one tool call block at `index` (`name` is the registered tool). */
export function call(index: number, id: string, name: string, args: string): StreamChunk[] {
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id: ToolCallId(id), name, argumentsDelta: args },
    { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: args } },
  ]
}

/** The terminal chunk of one step. */
export function finish(kind: 'stop' | 'tool-calls'): StreamChunk {
  return { type: 'finish', reason: { kind } }
}

/** One step that never settles until its request is aborted (a turn cancelled mid-request). */
export function blocked(entered: PromiseWithResolvers<undefined>): ModelStep {
  return async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    entered.resolve(undefined)
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) {
        resolve()
        return
      }
      options.signal?.addEventListener('abort', () => { resolve() }, { once: true })
    })
    options.signal?.throwIfAborted()
    yield finish('stop')
  }
}

/** One step that fails the model request (a turn that errors). */
export function failing(message: string): ModelStep {
  return async function* (): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    throw new Error(message)
  }
}

/** Register the `echo` tool (returns its `text` argument) and the `boom` tool (always fails). */
export function tools(ctx: Context): void {
  ctx.tools.register({
    name: 'echo',
    description: 'Echo the given text back.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
    },
    execute: async args => ({ text: (args as { text: string }).text }),
  })
  ctx.tools.register({
    name: 'boom',
    description: 'Fail every call.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: {} },
      render: () => [{ type: 'text', text: 'boom' }],
    },
    execute: async () => {
      throw new Error('boom failed')
    },
  })
}

/** Everything one activity test needs. */
export interface ActivityHarness extends SessionsHarness {
  tracker: ImActivityTracker
  /** Every `im/activity` emission, in order. */
  emitted: { activity: ImActivity; change: ImActivityChange }[]
  /** The one hosted session of {@link CHAT}. */
  record: ImSessionRecord
  /** The message the delivered turn replies to. */
  trigger: ImMessage
  /** Deliver one text message as a follow-up turn, then wait until the agent is idle again. */
  turn(text?: string): Promise<void>
}

/** One stored inbound message of the test chat. */
export function inbound(text: string): ImMessage {
  return {
    key: ImMessageKey('fake:bot', 'm1'),
    seq: 1,
    chat: CHAT,
    sender: { id: 'user-1', name: 'User', self: false },
    content: h('message', h.text(text)),
    text,
    mentions: { self: false, all: false, users: [] },
    addressed: true,
    time: 1000,
    via: 'platform',
  }
}

/**
 * Boot one sessions host with the activity tracker attached.
 * @param options.spec - overrides of the hosted session spec (`output`, extra bindings …).
 * @returns the harness, its tracker and every recorded emission.
 */
export async function bootActivity(options: { spec?: Partial<ImSessionSpec> } = {}): Promise<ActivityHarness> {
  const harness = await boot()
  tools(harness.ctx)
  const tracker = new ImActivityTracker(harness.ctx, {
    hosted: id => harness.host.hosted(id),
    trigger: id => harness.host.trigger(id),
  })
  const emitted: { activity: ImActivity; change: ImActivityChange }[] = []
  harness.ctx.on('im/activity', (activity, change) => { emitted.push({ activity, change }) })
  const record = await harness.host.ensure({
    key: `conv:${CHAT.key}`,
    owner: 'conversation',
    composition: COMPOSITION,
    bindings: [{ chat: CHAT.key, writable: true, home: true }],
    ...options.spec,
  })
  const trigger = inbound('please look into it')
  tracker.start()
  let turns = 0
  return {
    ...harness,
    tracker,
    emitted,
    record,
    trigger,
    async turn(text = 'please'): Promise<void> {
      turns += 1
      await harness.host.deliver(record.sessionId, {
        id: `turn-${turns}`, mode: 'followup', content: [{ type: 'text', text }], trigger,
      })
      await (await harness.host.agent(record.sessionId)).whenIdle()
    },
  }
}

/** A hosted record of {@link CHAT}, for tests that drive the tracker without a session host. */
export function hostedRecord(patch: Partial<ImSessionRecord> = {}): ImSessionRecord {
  return {
    key: `conv:${CHAT.key}`,
    owner: 'conversation',
    composition: COMPOSITION,
    bindings: [{ chat: CHAT.key, writable: true, home: true }],
    sessionId: sessionIdOf(`conv:${CHAT.key}`, 0),
    generation: 0,
    createdAt: 1,
    lastActiveAt: 2,
    ...patch,
  }
}

/**
 * The tracker over a bare context: no agent loop, so a test emits the agent and session-log events itself. Every
 * event is emitted with a stand-in envelope that only carries the session id the tracker reads.
 */
export class BareActivity {
  readonly ctx = new Context()
  readonly tracker: ImActivityTracker
  readonly emitted: { activity: ImActivity; change: ImActivityChange }[] = []
  readonly record: ImSessionRecord
  /** Answer of {@link ImActivityDeps.trigger}. */
  trigger: ImMessage | undefined = inbound('please look into it')

  constructor(record: ImSessionRecord = hostedRecord(), hosted = true) {
    this.record = record
    this.tracker = new ImActivityTracker(this.ctx, {
      hosted: id => (hosted && id === record.sessionId ? record : undefined),
      trigger: () => this.trigger,
    })
    this.ctx.on('im/activity', (activity, change) => { this.emitted.push({ activity, change }) })
    this.tracker.start()
  }

  /** A stand-in agent of one session (the tracker only reads `agent.session.id`). */
  agent(sessionId: SessionId = this.record.sessionId): Agent {
    return { session: { id: sessionId } } as Agent
  }

  /** Emit one session-log event. */
  log(event: SessionEvent, sessionId: SessionId = this.record.sessionId): void {
    this.ctx.emit('session/event', { id: sessionId } as Session, event)
  }

  /** Emit one assistant frame. */
  frame(frame: AssistantStreamFrame, sessionId: SessionId = this.record.sessionId): void {
    this.ctx.emit('agent/assistant-stream', { agent: this.agent(sessionId), frame })
  }

  /** Emit one `agent/status` transition. */
  status(status: AgentStatus, sessionId: SessionId = this.record.sessionId): void {
    this.ctx.emit('agent/status', { agent: this.agent(sessionId), status })
  }

  /** Emit one `agent/error`. */
  error(turn: number, error: unknown, sessionId: SessionId = this.record.sessionId): void {
    this.ctx.emit('agent/error', { agent: this.agent(sessionId), turn, step: 1, error })
  }

  /** Emit `agent/disposed`. */
  disposed(sessionId: SessionId = this.record.sessionId): void {
    this.ctx.emit('agent/disposed', { agent: this.agent(sessionId) })
  }

  async close(): Promise<void> {
    await this.ctx.fiber.dispose()
  }
}
