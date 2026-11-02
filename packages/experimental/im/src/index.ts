/**
 * `@deepseek-ai/dsh-experimental-im` — platform-neutral IM host. The core stores admitted messages, runs the `im/message`
 * waterfall, hosts sessions, publishes outbound messages with durable receipts, tracks session turn activity, and
 * drives output renderers. It never renders platform output itself: routing strategies, session commands, and output
 * renderers are separate plugins; the optional default dispatcher (`config.defaultDispatch`) only receives what every
 * routing listener passed on.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { toText } from '@deepseek-ai/cordis-plugin-im-core'
import type { Bot, Fragment, MessageStream, StreamOptions } from '@deepseek-ai/cordis-plugin-im-core'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {
  ImApi, ImChat, ImChatKey, ImConfig, ImFormatOptions, ImHistory, ImMessage, ImMessageEvent, ImSendOptions,
  ImSendResult, ImSourceConfig, ImStatus,
} from './api.ts'
import { ImMessageKey, splitKey } from './api.ts'
import { Config } from './config.ts'
import { ImError } from './error.ts'
import { ImActivityTracker } from './activity.ts'
import { ImFormatter } from './format.ts'
import { ImAgentHost } from './hosting.ts'
import { ImDispatcher } from './dispatcher.ts'
import { ImIntake, admit, draftOf, hasUnreadForward } from './intake.ts'
import { ImMediaStore } from './media.ts'
import { ImOutputRegistry } from './outputs.ts'
import { ImSender } from './send.ts'
import { ImSessionHost } from './sessions.ts'
import { ImStore } from './store.ts'
import { applyTools } from './tools.ts'

export * from './api.ts'
export { Config, DEFAULT_DISPATCHER_PROMPT } from './config.ts'
export { chatHeader, DISPATCHER_KEY, DISPATCHER_OWNER, ImDispatcher } from './dispatcher.ts'
export { ImError } from './error.ts'
export { STOP_BUTTON_PREFIX } from './outputs.ts'
export { sessionIdOf } from './hosting.ts'
export { operationId } from './send.ts'
export { mediaLabel, mediaRefs, parseMediaId } from './media.ts'
export type { ImMediaItem, ImMediaKind, ImMediaRef } from './media.ts'
export { formatText } from './format.ts'
export { IM_TOOLS } from './tools.ts'
export type { ImToolName } from './tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable IM intake, the `im/message` waterfall, hosted sessions, outbound publication, and output renderers. */
    im: ImService
  }
}

/** Single-process IM host; module wiring only — behaviour lives in the per-concern modules. */
export class ImService extends Service implements ImApi {
  static inject = ['satori', 'agents', 'sessions', 'sessionPersistence', 'storageDomain', 'attachments']
  static Config = Config

  /** Durable message store and the `ctx.im.history` read side. */
  readonly store: ImStore
  /** Media references and bounded download into attachments (`im_read_image`). */
  readonly media: ImMediaStore
  /** `ctx.im.format` renderer of stored messages. */
  readonly formatter: ImFormatter
  /** Live agents of hosted sessions, created/resumed from their stored composition. */
  readonly agentHost: ImAgentHost
  /** `ctx.im.sessions` records, bindings and durable deliveries. */
  readonly sessions: ImSessionHost
  /** `ctx.im.send`/`stream` outbound sender with durable receipts and own-message attribution. */
  readonly sender: ImSender
  /** `satori/receive` intake and the `im/message` dispatch loop. */
  readonly intake: ImIntake
  /** The default dispatcher behind every other `im/message` listener; undefined when `config.defaultDispatch` is absent. */
  readonly dispatcher: ImDispatcher | undefined
  /** Per-turn activity of hosted sessions, emitted as `im/activity`. */
  readonly activity: ImActivityTracker
  readonly outputs: ImOutputRegistry
  readonly history: ImHistory
  /**
   * The service's own context. Service methods run with `this.ctx` bound to the caller, so modules and agents
   * are owned by this one (a session opened from a tool call must not belong to the calling agent's scope).
   */
  private readonly home: Context
  private readonly sources = new Map<string, ImSourceConfig>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(ctx: Context, readonly config: ImConfig) {
    super(ctx, 'im')
    this.home = ctx
    for (const source of config.sources) {
      if (!source.id.trim() || !source.bot.trim() || this.sources.has(source.id)) {
        throw new ImError('configuration', 'IM sources require unique nonempty ids and a nonempty bot id.')
      }
      this.sources.set(source.id, source)
    }
    this.store = new ImStore(ctx, config)
    this.history = this.store
    this.media = new ImMediaStore(ctx, config)
    this.formatter = new ImFormatter(ctx, config, this.store, this.media)
    this.agentHost = new ImAgentHost(ctx)
    this.sessions = new ImSessionHost(ctx, config, { agents: this.agentHost, formatter: this.formatter })
    this.sender = new ImSender(ctx, config, { store: this.store, sessions: this.sessions })
    const dispatcher = config.defaultDispatch === undefined ? undefined : new ImDispatcher(config.defaultDispatch, this.sessions)
    this.dispatcher = dispatcher
    this.intake = new ImIntake(ctx, config, this.store, {
      event: (message, source) => this.event(message, source),
      ...dispatcher === undefined ? {} : { unhandled: (event: ImMessageEvent) => dispatcher.handle(event) },
    })
    this.activity = new ImActivityTracker(ctx, {
      hosted: id => this.sessions.hosted(id),
      trigger: id => this.sessions.trigger(id),
    })
    this.outputs = new ImOutputRegistry(ctx, { im: this, sender: this.sender })
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void> {
    const ctx = this.home
    await this.store.start()
    await this.sessions.start()
    await this.sender.start()
    yield async () => {
      clearInterval(this.timer)
      await this.intake.dispose()
      await this.outputs.dispose()
      await this.agentHost.disposeAll()
      await this.sender.dispose()
      await this.sessions.dispose()
      await this.store.dispose()
    }
    ctx.on('satori/receive', session => this.intake.receive(session))
    ctx.on('send', (bot, result) => {
      void this.intake.outbound(bot, result).catch((error: unknown) => {
        ctx.logger.warn('IM outbound message of bot %s was not stored: %s', bot.id, String(error))
      })
    })
    this.activity.start()
    this.outputs.start()
    ctx.inject(['tools', 'systemPrompt'], (scoped) => { applyTools(scoped, this, this.config) })
    const dispatcher = this.dispatcher
    if (dispatcher !== undefined) {
      ctx.inject(['systemPrompt'], (scoped) => {
        const { prompt } = dispatcher.config
        scoped.systemPrompt.section({
          name: prompt.name, order: prompt.order, interpolate: false, text: ({ agent }) => dispatcher.guidance(agent),
        })
      })
    }
    this.intake.pump()
    this.timer = setInterval(() => {
      this.intake.pump()
      this.sessions.retry()
      void this.store.sweep(Date.now()).catch((error: unknown) => {
        ctx.logger.warn('IM store sweep failed: %s', String(error))
      })
    }, this.config.retryIntervalMs)
  }

  /**
   * Configured admission rule by id.
   * @param id - the operator id of the source.
   * @returns the source, or undefined when no source carries that id.
   */
  source(id: string): ImSourceConfig | undefined {
    return this.sources.get(id)
  }

  /**
   * Publish content into one admitted chat, recording a durable receipt when `operationId` is provided.
   * @param chat - the target chat key.
   * @param content - the message content, normalized by the adapter's mode.
   * @param options - quote, thread, operation id and delivery overrides.
   * @returns the published handle and the render report of every part.
   */
  send(chat: ImChatKey, content: Fragment, options?: ImSendOptions): Promise<ImSendResult> {
    return this.sender.send(chat, content, options)
  }

  /**
   * Open a streaming publication into one admitted chat.
   * @param chat - the target chat key.
   * @param options - quote, thread and the stream strategy options.
   * @returns the message stream the caller drives with updates.
   */
  stream(chat: ImChatKey, options?: ImSendOptions & StreamOptions): Promise<MessageStream> {
    return this.sender.stream(chat, options)
  }

  /**
   * Format stored messages as model-facing user-message content.
   * @param messages - the messages to format, in chat order.
   * @param options - style, media admission and header options.
   * @returns the text (and admitted images) the model receives.
   */
  format(messages: readonly ImMessage[], options?: ImFormatOptions): Promise<UserMessage['content']> {
    return this.formatter.format(messages, options)
  }

  /**
   * The mounted bot that serves one chat.
   * @param chat - the chat key, whose bot segment names the bot.
   * @returns the bot serving that chat.
   */
  bot(chat: ImChatKey): Bot {
    const { bot: id } = splitKey(chat)
    const bot = this.home.bots.find(bot => bot.id === id)
    if (!bot) throw new ImError('unavailable', `No bot ${id} is mounted for chat ${chat}.`)
    return bot
  }

  /**
   * The retained record of one admitted chat.
   * @param key - the chat key.
   * @returns the chat record, or undefined when the chat was never admitted.
   */
  chat(key: ImChatKey): ImChat | undefined {
    return this.store.chat(key)
  }

  /**
   * One message of one chat: the stored message when this deployment received it, and a platform read otherwise, so a
   * reference to a message that never reached this deployment still resolves. A platform read is admitted and stored
   * like any other message, which gives it a sequence number and keeps later reads of it local.
   * @param chat - chat to read in; its bot serves the platform request.
   * @param id - platform message id.
   * @returns the message as the store holds it, with a merged forward's entries filled in when the platform has them.
   */
  async readMessage(chat: ImChatKey, id: string): Promise<ImMessage> {
    const bot = this.bot(chat)
    const known = this.store.get(ImMessageKey(bot.id, id))
    if (known !== undefined) {
      // A message key is per bot, not per chat, and one bot serves every chat it was added to: a stored message must
      // belong to the chat the tool asked about, or a session bound to one chat could read another chat's message.
      if (known.chat.key !== chat) {
        throw new ImError('access', `Message ${id} belongs to chat ${known.chat.key}, not ${chat}.`)
      }
      return await this.expanded(bot, known)
    }
    const record = this.chat(chat)
    if (record === undefined) throw new ImError('access', `Chat ${chat} was never admitted, so message ${id} cannot be read.`)
    if (bot.getMessage === undefined) throw new ImError('unavailable', `Bot ${bot.id} cannot read one message by id.`)
    const message = await bot.getMessage(record.ref, id)
    const source = admit([...this.sources.values()], bot.id, message)
    if (source === undefined) throw new ImError('access', `Message ${id} of chat ${chat} is admitted by no source.`)
    return await this.store.put(draftOf(bot, message, source, 'platform'), 'none')
  }

  /**
   * One stored message with the part its event could not carry. The platform hands a merged forward as its container
   * alone and answers a read of it with the entries, so the read is where the reference gains its contents; the store
   * keeps the record as it arrived.
   * @param bot - the bot serving the chat.
   * @param message - the stored message.
   * @returns the message itself, or a copy whose content carries the entries.
   */
  private async expanded(bot: Bot, message: ImMessage): Promise<ImMessage> {
    if (!hasUnreadForward(message.content) || bot.getMessage === undefined) return message
    try {
      const read = await bot.getMessage(message.chat.ref, splitKey(message.key).id)
      if (hasUnreadForward(read.content)) return message
      return { ...message, content: read.content, text: toText(read.content) }
    } catch (error: unknown) {
      // The reference is still readable: what the platform will not hand back stays a placeholder.
      this.home.logger.warn('IM message %s could not be expanded: %s', message.key,
        error instanceof Error ? error.message : String(error))
      return message
    }
  }

  /**
   * A snapshot of the deployment: bots, sources, sessions, pending work and recent messages.
   * @returns the current status.
   */
  status(): ImStatus {
    return {
      bots: this.home.bots.map(bot => ({ id: bot.id, platform: bot.platform, sid: bot.sid, status: bot.status })),
      sources: [...this.sources.values()],
      sessions: this.sessions.list(),
      pendingDeliveries: this.sessions.pendingDeliveries(),
      pendingMessages: this.store.pending().length,
      recent: this.store.recent(20),
    }
  }

  /** Waterfall argument of one admitted message (bound helpers; idempotent `deliver` keyed by the message). */
  private event(message: ImMessage, source: ImSourceConfig): ImMessageEvent {
    const chat = message.chat.key
    const bot = this.bot(chat)
    return {
      message, source, bot,
      reply: (content, options) => this.send(chat, content, {
        quote: message.key, ...message.thread && { thread: message.thread.id }, ...options,
      }),
      send: (content, options) => this.send(chat, content, options),
      deliver: (target, options) => this.sessions.deliver(target, {
        ...options,
        id: options.id ?? message.key,
        content: options.content ?? [message],
        trigger: options.trigger ?? message,
      }),
    }
  }
}

export default ImService
