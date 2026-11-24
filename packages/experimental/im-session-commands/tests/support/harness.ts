/**
 * Test harness of the session-commands plugin: the sessions host from `packages/experimental/im/tests/support/sessions-harness.ts`
 * (real AgentLoop, scripted model, JSONL persistence, memory storage) plus a FakeAdapter-fed intake, so a command
 * arrives through the production `im/message` waterfall — including the core's outcome recording that makes
 * redelivery a no-op — and the dsh command registry the passthrough executes against.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Satori, h } from '@deepseek-ai/cordis-plugin-im-core'
import { FakeAdapter, createTextMode } from '@deepseek-ai/cordis-plugin-im-core/src/testing.ts'
import type { ChatRef, Fragment, InboundMessage } from '@deepseek-ai/cordis-plugin-im-core'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import {
  ImMessageKey, type ImConfig, type ImMessage, type ImMessageEvent, type ImOutcome, type ImSendResult,
  type ImSourceConfig,
} from '@deepseek-ai/dsh-im/src/api.ts'
import { Config as ImConfigSchema } from '@deepseek-ai/dsh-im/src/config.ts'
import { ImError } from '@deepseek-ai/dsh-im/src/error.ts'
import { ImIntake } from '@deepseek-ai/dsh-im/src/intake.ts'
import { ImStore } from '@deepseek-ai/dsh-im/src/store.ts'
import {
  boot, cleanRoots, type BootOptions, type SessionsHarness,
} from '../../../im/tests/support/sessions-harness.ts'
import { Config, type SessionCommandsConfig } from '../../src/config.ts'
import * as plugin from '../../src/index.ts'

/** One reply the plugin published through `event.reply`. */
export interface Reply {
  content: Fragment
  options: unknown
}

export interface CommandsHarness {
  ctx: Context
  /** The sessions host and its observation points (model, agents, resets, created). */
  base: SessionsHarness
  bot: FakeAdapter
  store: ImStore
  intake: ImIntake
  /** Every reply of the plugin, in publish order. */
  replies: Reply[]
  /** Deliver one platform message the way an adapter does, then wait for its dispatch. */
  receive(message: InboundMessage, eventId?: string): Promise<void>
  /** The outcome the core recorded for one platform message id. */
  outcome(id: string): ImOutcome | undefined
  close(): Promise<void>
}

/** The chat every test delivers into. */
export const CHAT: ChatRef = { id: 'chat', type: 'group' }
/** A thread of {@link CHAT}. */
export const THREAD = 'th-1'

const harnesses: CommandsHarness[] = []

/** Boot one harness and remember it for teardown (a test may boot more than one). */
export async function bootCommands(
  options: BootOptions & { commands?: Partial<SessionCommandsConfig> } = {},
): Promise<CommandsHarness> {
  const base = await boot(options)
  const ctx = base.ctx
  const imConfig: ImConfig = ImConfigSchema({
    sources: [{ id: 'team', bot: 'fake:bot', writable: true, store: 'all' }], retryIntervalMs: 60_000,
  })
  // Mount the fake platform onto the agent context: `bot.send`/`receive` stay the real core implementation.
  await ctx.plugin(Satori)
  await ctx.plugin(FakeAdapter, { modes: { text: createTextMode() }, selfId: 'bot-user' })
  await ctx.plugin(CommandRuntime)
  const bot = ctx.bots.find(candidate => candidate instanceof FakeAdapter) as FakeAdapter
  const store = new ImStore(ctx, imConfig)
  await store.start()
  const replies: Reply[] = []
  const seenReplyOps = new Map<string, string>()
  const intake = new ImIntake(ctx, imConfig, store, {
    event: (message, source) => event(bot, message, source, replies, seenReplyOps),
  })
  ctx.on('satori/receive', session => intake.receive(session))
  // The plugin only reads `ctx.im.sessions`; the send funnel has its own package tests.
  ctx.provide('im', { sessions: base.host })
  await ctx.plugin(plugin, Config({ ...options.commands }))
  const harness: CommandsHarness = {
    ctx, base, bot, store, intake, replies,
    async receive(message, eventId = message.id) {
      await bot.receive(bot.session({ type: 'message', id: eventId, timestamp: message.time, message }))
      await intake.idle()
    },
    outcome: id => store.state(ImMessageKey('fake:bot', id))?.outcome,
    close: () => base.close(),
  }
  harnesses.push(harness)
  return harness
}

/** Build the waterfall argument the core would build (`ImService.event`). */
function event(
  bot: FakeAdapter,
  message: ImMessage,
  source: ImSourceConfig,
  replies: Reply[],
  seenReplyOps: Map<string, string>,
): ImMessageEvent {
  const reply = (content: Fragment, options?: unknown): Promise<ImSendResult> => {
    const operationId = (options as { operationId?: string } | undefined)?.operationId
    if (operationId !== undefined) {
      const digest = JSON.stringify(content)
      const previous = seenReplyOps.get(operationId)
      if (previous !== undefined) {
        if (previous !== digest) {
          return Promise.reject(
            new ImError('conflict', `IM operation ${operationId} was already used for a different publication.`),
          )
        }
        return Promise.resolve({ status: 'confirmed' } as ImSendResult)
      }
      seenReplyOps.set(operationId, digest)
    }
    replies.push({ content, options })
    return Promise.resolve({ status: 'confirmed' } as ImSendResult)
  }
  return {
    message, source, bot,
    reply,
    send: reply,
    deliver: async (): Promise<void> => {},
  }
}

let sequence = 0

/** One inbound platform message from a human sender. */
export function inbound(text: string, patch: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: `m-${++sequence}`,
    chat: CHAT,
    sender: { id: 'user-1', name: 'User' },
    content: h('message', h.text(text)),
    mentions: { self: true, all: false, users: [] },
    time: 1000,
    referrer: undefined,
    raw: null,
    ...patch,
  }
}

/** Drop every temp root and dispose every harness. */
export async function cleanAll(): Promise<void> {
  for (const harness of harnesses.splice(0)) await harness.close().catch(() => {})
  await cleanRoots()
}
