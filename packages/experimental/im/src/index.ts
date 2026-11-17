/**
 * `@deepseek-ai/dsh-im` — platform-neutral IM host. The core stores admitted messages, runs the `im/message`
 * waterfall, hosts sessions, publishes outbound messages with durable receipts, tracks session turn activity, and
 * drives output renderers. It never renders platform output itself: routing strategies, session commands, and output
 * renderers are separate plugins; the optional default dispatcher (`config.defaultDispatch`) only receives what every
 * routing listener passed on.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { PlatformError, toText } from '@deepseek-ai/cordis-plugin-im-core'
import type { Bot, Fragment, MembersPage, MessageStream, SendResult, StreamOptions } from '@deepseek-ai/cordis-plugin-im-core'
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
import { ImIntake, admit, draftOf, hasUnreadForward, readWithin } from './intake.ts'
import { ImMediaStore } from './media.ts'
import { ImOutputRegistry } from './outputs.ts'
import { ImSender } from './send.ts'
import { ImSessionHost } from './sessions.ts'
import { ImStore, inputBytes } from './store.ts'
import { applyTools } from './tools.ts'

export type * from './api.ts'
export { ImError } from './error.ts'
export type { ImMediaFileItem, ImMediaItem, ImMediaKind, ImMediaRef } from './media.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable IM intake, the `im/message` waterfall, hosted sessions, outbound publication, and output renderers. */
    im: ImService
  }
}

/** What the IM host needs of the Loader that composed its context: the signal that every entry has settled. */
interface Composition {
  await(): Promise<void>
}

/**
 * The Loader of a context, when one composed it. `dsh-im` does not depend on the Loader package, so the service is
 * looked up by name and recognised by the one method it needs.
 * @param ctx - the context the IM host runs in.
 * @returns the Loader, or undefined for a context composed by hand.
 */
function composition(ctx: Context): Composition | undefined {
  const loader: unknown = ctx.get('loader')
  if (loader === null || typeof loader !== 'object') return undefined
  return typeof (loader as Partial<Composition>).await === 'function' ? loader as Composition : undefined
}

/** Single-process IM host; module wiring only — behaviour lives in the per-concern modules. */
export class ImService extends Service implements ImApi {
  static inject = ['satori', 'agents', 'sessions', 'sessionPersistence', 'storageDomain', 'attachments']
  static Config = Config

  /** Durable message store and the `ctx.im.history` read side. */
  readonly store: ImStore
  /** Media references and bounded download into attachments (`im_read_image`, `im_read_file`). */
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
  private closing = false

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
    // `announced` reads `this.intake`, which this constructor creates right after: the closure only runs once a
    // publication completes, long after both exist.
    this.sender = new ImSender(ctx, config, {
      store: this.store,
      sessions: this.sessions,
      announced: key => this.intake.announced(key),
      onResult: (bot, result) => { if (this.closing) this.recordOutbound(bot, result) },
    })
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
    // Nothing is dispatched or recovered until the composition settles: this service finishes loading before sibling
    // plugins (routing strategies, session commands, tools, prompt sections) finish starting, so an immediate pass
    // would settle a pending command through the default dispatcher or admit a persisted delivery before IM tools are
    // registered. Both holds are armed before `sessions.start()` opens the store.
    this.intake.hold()
    this.sessions.hold()
    // Arm the receive gate before awaiting storage open: an adapter that delivers a frame while the stores are still
    // opening waits on `ready` and withholds its platform ACK until the message is durably stored (or rejects when
    // startup fails).
    let openReceive!: () => void
    let failReceive!: (error: unknown) => void
    const receiveReady = new Promise<void>((resolve, reject) => {
      openReceive = resolve
      failReceive = reject
    })
    receiveReady.catch(() => {})
    const offReceive = ctx.on('satori/receive', async (session) => {
      await receiveReady
      await this.intake.receive(session)
    })
    let releaseTimer: ReturnType<typeof setTimeout> | undefined
    let warnTimer: ReturnType<typeof setTimeout> | undefined
    let offSend: (() => void) | undefined
    const checkActive = (): void => {
      if (this.closing || ctx.fiber.uid === null) {
        throw new Error('The IM service was disposed before startup finished.')
      }
    }
    const startup = (async () => {
      await this.store.start()
      checkActive()
      await this.sessions.start()
      checkActive()
      await this.sender.start()
      checkActive()
      offSend = ctx.on('send', (bot, result) => { this.recordOutbound(bot, result) }, { global: true })
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
      openReceive()
    })()
    let teardownTask: Promise<void> | undefined
    const teardown = (reason?: unknown): Promise<void> => {
      this.closing = true
      this.sessions.hold()
      offReceive()
      failReceive(reason)
      clearTimeout(releaseTimer)
      clearTimeout(warnTimer)
      clearInterval(this.timer)
      teardownTask ??= (async () => {
        await startup.catch(() => {})
        // Order matters: `intake` stops dispatching first, `sessions` drains any in-flight recovery or admission that
        // could still open an agent handle before `agentHost.disposeAll()` closes every live handle, and `outputs`
        // closes open turn streams before `sender` and `store` close their storage domains.
        const releases: [string, () => Promise<void>][] = [
          ['the intake', () => this.intake.dispose()],
          ['the session records', () => this.sessions.dispose()],
          ['the hosted agents', () => this.agentHost.disposeAll()],
          ['the turn outputs', () => this.outputs.dispose()],
          ['the sender', () => this.sender.dispose()],
          ['the outbound send listener', () => {
            offSend?.()
            return Promise.resolve()
          }],
          ['the outbound announcements', () => this.intake.drainAnnouncements()],
          ['the message store', () => this.store.dispose()],
        ]
        for (const [what, release] of releases) {
          try {
            await release()
          } catch (failure: unknown) {
            ctx.logger.warn('IM shutdown left %s open: %s', what, String(failure))
          }
        }
      })()
      return teardownTask
    }
    ctx.effect(() => () => teardown(new Error('The IM service was disposed before startup finished.')))
    try {
      await startup
    } catch (error) {
      await teardown(error)
      throw error
    }
    yield () => teardown()
    // Schedule release on a macrotask once the composition settles so nested `ctx.inject` registrations (such as
    // `im_read_file` inside `applyTools`) finish before any recovered turn or inbound dispatch runs.
    const release = (): void => {
      clearTimeout(warnTimer)
      if (this.closing) return
      releaseTimer = setTimeout(() => {
        this.intake.release()
        this.sessions.release()
      }, 0)
    }
    const loader = composition(ctx)
    if (loader === undefined) {
      release()
    } else {
      warnTimer = setTimeout(() => {
        ctx.logger.warn(
          'IM intake and session recovery are still waiting after %dms for the composition to settle; '
            + 'messages are stored and acknowledged until every plugin finishes starting.',
          this.config.compositionWarnMs,
        )
      }, this.config.compositionWarnMs)
      warnTimer.unref()
      void loader.await().then(
        () => { release() },
        (error: unknown) => {
          if (this.closing) return
          ctx.logger.warn('IM dispatch starts although the composition did not settle: %s', String(error))
          release()
        },
      )
    }
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
   * @param signal - optional cancellation signal from the caller.
   * @returns the message as the store holds it, with a merged forward's entries filled in when the platform has them.
   */
  async readMessage(chat: ImChatKey, id: string, signal?: AbortSignal): Promise<ImMessage> {
    const bot = this.bot(chat)
    const known = this.store.get(ImMessageKey(bot.id, id))
    if (known !== undefined) {
      // A message key is per bot, not per chat, and one bot serves every chat it was added to: a stored message must
      // belong to the chat the tool asked about, or a session bound to one chat could read another chat's message.
      if (known.chat.key !== chat) {
        throw new ImError('access', `Message ${id} belongs to chat ${known.chat.key}, not ${chat}.`)
      }
      return await this.expanded(bot, known, signal)
    }
    const record = this.chat(chat)
    if (record === undefined) throw new ImError('access', `Chat ${chat} was never admitted, so message ${id} cannot be read.`)
    if (bot.getMessage === undefined) throw new ImError('unavailable', `Bot ${bot.id} cannot read one message by id.`)
    const message = await readPlatform(bot, bot.getMessage(record.ref, id), this.config.platformTimeoutMs, signal)
    // The stored branch checks the chat because a message key is per bot; a platform read needs the same check, since
    // `getMessage` is handed the chat as a routing hint and one bot serves every chat it was added to.
    if (message.chat.id !== record.ref.id) {
      throw new ImError('access', `Message ${id} belongs to chat ${message.chat.id}, not ${record.ref.id}.`)
    }
    const source = admit([...this.sources.values()], bot.id, message)
    if (source === undefined) throw new ImError('access', `Message ${id} of chat ${chat} is admitted by no source.`)
    const draft = draftOf(bot, message, source, 'platform')
    if (inputBytes(draft) > this.config.maxInputBytes) {
      throw new ImError('capacity', `Message ${id} exceeds the configured byte limit (${this.config.maxInputBytes} bytes).`)
    }
    return await this.store.put(draft, 'none')
  }

  /**
   * One page of the people a chat lists as its members: the id a mention addresses and the name to show.
   * @param chat - chat whose members are listed; its bot answers the platform request.
   * @param cursor - `page_token` of the previous page.
   * @param limit - page-size hint; the platform bounds it.
   * @param signal - optional cancellation signal from the caller.
   * @returns the page the adapter read.
   */
  async members(chat: ImChatKey, cursor?: string, limit?: number, signal?: AbortSignal): Promise<MembersPage> {
    const bot = this.bot(chat)
    const record = this.chat(chat)
    if (record === undefined) throw new ImError('access', `Chat ${chat} was never admitted, so its members cannot be listed.`)
    if (bot.members === undefined) throw new ImError('unavailable', `Bot ${bot.id} cannot list the members of a chat.`)
    return await readPlatform(bot, bot.members(record.ref, cursor, limit), this.config.platformTimeoutMs, signal)
  }

  /**
   * One stored message with the part its event could not carry. The platform hands a merged forward as its container
   * alone and answers a read of it with the entries, so the read is where the reference gains its contents; the store
   * keeps the record as it arrived.
   * @param bot - the bot serving the chat.
   * @param message - the stored message.
   * @param signal - optional cancellation signal from the caller.
   * @returns the message itself, or a copy whose content carries the entries.
   */
  private async expanded(bot: Bot, message: ImMessage, signal?: AbortSignal): Promise<ImMessage> {
    if (!hasUnreadForward(message.content) || bot.getMessage === undefined) return message
    try {
      const read = await readWithin(
        bot.getMessage(message.chat.ref, splitKey(message.key).id),
        this.config.platformTimeoutMs,
        signal,
      )
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

  private recordOutbound(bot: Bot, result: SendResult): void {
    void this.intake.outbound(bot, result).catch((error: unknown) => {
      this.home.logger.warn('IM outbound message of bot %s was not stored: %s', bot.id, String(error))
    })
  }

  /** Waterfall argument of one admitted message (bound helpers; idempotent `deliver` keyed by the message). */
  private event(message: ImMessage, source: ImSourceConfig): ImMessageEvent {
    const chat = message.chat.key
    const bot = this.bot(chat)
    return {
      message, source, bot,
      reply: (content, options) => this.send(chat, content, {
        ...this.store.get(message.key) === undefined ? {} : { quote: message.key },
        ...message.thread && { thread: message.thread.id },
        ...options,
      }),
      send: (content, options) => this.send(chat, content, options),
      deliver: (target, options) => this.sessions.deliver(target, {
        ...options,
        id: options.id ?? message.key,
        content: options.content ?? [message],
      }),
    }
  }
}

/**
 * Run one bounded platform read and translate adapter/platform errors into structured {@link ImError}s with `cause`
 * preserved, so tool callers receive a declared error code instead of an unclassified adapter exception.
 */
async function readPlatform<T>(bot: Bot, read: Promise<T>, timeout: number, signal?: AbortSignal): Promise<T> {
  try {
    return await readWithin(read, timeout, signal)
  } catch (error: unknown) {
    if (error instanceof ImError) throw error
    const candidate = bot as { classify?: (error: unknown) => PlatformError }
    const classified = error instanceof PlatformError
      ? error
      : typeof candidate.classify === 'function'
        ? candidate.classify(error)
        : new PlatformError('fatal', error instanceof Error ? error.message : String(error), { cause: error })
    const code: ImError['code'] = classified.kind === 'permission' ? 'access' : 'unavailable'
    throw new ImError(code, classified.message, { cause: error })
  }
}

export default ImService
