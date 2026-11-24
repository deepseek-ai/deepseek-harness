/**
 * Output renderer registry: drives the renderer named by `spec.output` for each `im/activity` turn of a session that
 * may publish (per-turn {@link ImOutputIO} with quote/thread from the trigger, attributed sends); re-emits
 * `interaction/button`, `interaction/select` and `interaction/check` in admitted chats as `im/button`, `im/select` and
 * `im/check`. What a control does is up to the plugin that rendered it (a renderer's stop button stops its session).
 *
 * Target chat per turn ({@link targetOf}): the trigger's chat when the session holds a writable binding for it (that
 * binding's thread), else the writable home binding. A trigger of another chat is not quoted.
 *
 * Lifecycle per turn: `begin` on the activity's `start` change, `update` on every later `delta`/`tool` change, `end`
 * on the `end` change (or at {@link ImOutputRegistry.dispose}). One session's steps are serialized, so a renderer
 * never sees an `update` before its `begin` or after its `end`. The activity passed to `begin` is the latest snapshot
 * at that moment: a change that arrived while `begin` resolved is not replayed, because a renderer renders the whole
 * activity anyway.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  ButtonEvent, CheckEvent, Fragment, MessageStream, SelectEvent, Session, StreamOptions,
} from '@deepseek-ai/cordis-plugin-im-core'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  ImChatKey, ImMessageKey,
  type ImActivity, type ImActivityChange, type ImBinding, type ImButtonEvent, type ImChat, type ImCheckEvent,
  type ImHistory, type ImMessage, type ImOutputIO, type ImOutputRenderer, type ImOutputs, type ImReactionEvent,
  type ImSelectEvent, type ImSendOptions, type ImSendResult, type ImSourceConfig, type ImTurnOutput,
} from './api.ts'
import { ImError } from './error.ts'
import { allows, admitsChat } from './intake.ts'
import type { ImSender } from './send.ts'

/** Reserved `spec.output` value that names no renderer: nothing is published unless the agent calls `im_send`. */
export const NO_OUTPUT = 'none'

/** Maximum recent reaction event ids kept for platform redelivery deduplication. */
const MAX_REACTION_EVENTS = 1000

/** The IM host slice one rendered turn reads: the chat of a session, its admitting source and its history tail. */
export interface ImOutputHost {
  chat(key: ImChatKey): ImChat | undefined
  /** The configured admission rule of a chat, whose `users` allowlist gates button clicks. */
  source(id: string): ImSourceConfig | undefined
  readonly history: Pick<ImHistory, 'get'>
}

/** What the registry needs: the host slice a rendered turn reads and the sender it publishes through. */
export interface ImOutputDeps {
  im: ImOutputHost
  /** The three publication and attribution calls a rendered turn makes. */
  sender: Pick<ImSender, 'sessionOf' | 'send' | 'stream'>
}

/** One turn whose output is being rendered. */
interface Open {
  turn: number
  /** Latest activity snapshot; the argument of the closing `end`. */
  activity: ImActivity
  /** Renderer output; absent when the session is ineligible or `begin` failed. */
  output: ImTurnOutput | undefined
}

/**
 * Registry and driver of the output renderers: subscribes `im/activity` to run the renderer a session names, keeps one
 * turn's begin/update/end in order, and re-emits platform button clicks in admitted chats as `im/button`.
 */
export class ImOutputRegistry implements ImOutputs {
  private readonly renderers = new Map<string, ImOutputRenderer>()
  /** Open turns by session id. */
  private readonly open = new Map<SessionId, Open>()
  /** Per session, the tail of the serialized begin/update/end chain. */
  private readonly chains = new Map<SessionId, Promise<void>>()
  /** Recent reaction event ids (`${botId}|${eventId}`) already re-emitted, bounded FIFO. */
  private readonly seenReactions = new Set<string>()

  constructor(readonly ctx: Context, readonly deps: ImOutputDeps) {}

  /** Subscribe `im/activity`, `interaction/*` and `reaction-*` (disposed with `ctx`). */
  start(): void {
    this.ctx.on('im/activity', (activity, change) => { this.activity(activity, change) })
    this.ctx.on('interaction/button', (session) => {
      try {
        this.button(session)
      } catch (error: unknown) {
        this.ctx.logger.warn('IM button click was not handled: %s', String(error))
      }
    })
    this.ctx.on('interaction/select', (session) => {
      this.guarded('select', () => { this.select(session) })
    })
    this.ctx.on('interaction/check', (session) => {
      this.guarded('checkbox toggle', () => { this.check(session) })
    })
    this.ctx.on('reaction-added', (session) => {
      this.guarded('reaction', () => { this.reaction(session, 'added') })
    })
    this.ctx.on('reaction-removed', (session) => {
      this.guarded('reaction', () => { this.reaction(session, 'removed') })
    })
  }

  /**
   * Run one synchronous interaction handler, reporting a thrown failure here instead of letting it escape the emit.
   * @param label - what the handler does, for the log line.
   * @param handle - the handler body.
   */
  private guarded(label: string, handle: () => void): void {
    try {
      handle()
    } catch (error: unknown) {
      this.ctx.logger.warn('IM %s was not handled: %s', label, String(error))
    }
  }

  register(renderer: ImOutputRenderer): () => void {
    const { id } = renderer
    if (!id.trim() || id === NO_OUTPUT || this.renderers.has(id)) {
      throw new ImError('configuration', `IM output renderer id ${JSON.stringify(id)} is reserved or already registered.`)
    }
    this.renderers.set(id, renderer)
    return () => {
      if (this.renderers.get(id) === renderer) this.renderers.delete(id)
    }
  }

  get(id: string): ImOutputRenderer | undefined {
    return this.renderers.get(id)
  }

  /**
   * `interaction/button` listener body (exposed for tests).
   * @param session - the core interaction session whose button was clicked.
   */
  button(session: Session): void {
    const button = session.button
    if (button === undefined) return
    const context = this.interaction(button)
    // A click outside the admitted chats is invisible to this host.
    if (context === undefined) return
    const event: ImButtonEvent = {
      id: button.id,
      chat: context.chat,
      user: button.user,
      bot: button.bot,
      time: button.time,
      raw: button,
      ...button.data === undefined ? {} : { data: button.data },
      ...button.values === undefined ? {} : { values: button.values },
      ...context.message === undefined ? {} : { message: context.message },
      ...context.session === undefined ? {} : { session: context.session },
    }
    this.ctx.emit('im/button', event)
  }

  /**
   * `interaction/select` listener body (exposed for tests).
   * @param session - the core interaction session whose control was picked.
   */
  select(session: Session): void {
    const select = session.select
    if (select === undefined) return
    const context = this.interaction(select)
    if (context === undefined) return
    const event: ImSelectEvent = {
      id: select.id,
      values: select.values,
      chat: context.chat,
      user: select.user,
      bot: select.bot,
      time: select.time,
      raw: select,
      ...select.data === undefined ? {} : { data: select.data },
      ...context.message === undefined ? {} : { message: context.message },
      ...context.session === undefined ? {} : { session: context.session },
    }
    this.ctx.emit('im/select', event)
  }

  /**
   * `interaction/check` listener body (exposed for tests).
   * @param session - the core interaction session whose checkbox was toggled.
   */
  check(session: Session): void {
    const check = session.check
    if (check === undefined) return
    const context = this.interaction(check)
    if (context === undefined) return
    const event: ImCheckEvent = {
      id: check.id,
      checked: check.checked,
      chat: context.chat,
      user: check.user,
      bot: check.bot,
      time: check.time,
      raw: check,
      ...check.data === undefined ? {} : { data: check.data },
      ...context.message === undefined ? {} : { message: context.message },
      ...context.session === undefined ? {} : { session: context.session },
    }
    this.ctx.emit('im/check', event)
  }

  /**
   * `reaction-added` / `reaction-removed` listener body (exposed for tests).
   *
   * Resolves the target message from the durable message store (because platforms such as Feishu omit `chat_id` on
   * reaction events), enforces chat/source/user admission, skips self-reactions, deduplicates by platform event id,
   * and re-emits `im/reaction` with the producing session when known.
   *
   * @param session - the core reaction session.
   * @param action - whether the reaction was added or removed.
   */
  reaction(session: Session, action: 'added' | 'removed'): void {
    const data = session.reaction
    if (data === undefined || !data.emoji) return
    const user = data.user
    if (user === undefined || !user.id) return
    // Never surface the bot's own working reactions back as external events.
    if (session.bot.selfId && user.id === session.bot.selfId) return
    const eventId = session.event.id
    if (eventId !== undefined && eventId !== '') {
      const dedupeKey = `${session.bot.id}|${eventId}`
      if (this.seenReactions.has(dedupeKey)) return
      if (this.seenReactions.size >= MAX_REACTION_EVENTS) {
        // A Set iterates in insertion order, so the first entry is the oldest event id.
        for (const oldest of this.seenReactions) {
          this.seenReactions.delete(oldest)
          break
        }
      }
      this.seenReactions.add(dedupeKey)
    }
    const message = this.deps.im.history.get(ImMessageKey(session.bot.id, data.message.id))
    if (message === undefined) return
    if (data.message.chat !== undefined && message.chat.ref.id !== data.message.chat.id) return
    const chat = this.deps.im.chat(message.chat.key)
    if (chat === undefined) return
    const source = this.deps.im.source(chat.source)
    if (source === undefined) return
    if (!admitsChat(source, session.bot.id, chat.ref)) return
    if (!allows(source.users, user.id)) return
    const owner = this.deps.sender.sessionOf(message.key)
    const event: ImReactionEvent = {
      action,
      emoji: data.emoji,
      chat,
      user,
      bot: session.bot,
      message,
      time: session.timestamp,
      ...owner === undefined ? {} : { session: owner },
      ...eventId === undefined || eventId === '' ? {} : { id: eventId },
    }
    this.ctx.emit('im/reaction', event)
  }

  /**
   * The admitted chat of one interaction, the own message that carried the control and the session that produced it.
   *
   * The interacting user is admitted like any sender: an interaction must not be a way around the source's user
   * allowlist.
   *
   * @param interaction - the core interaction event.
   * @returns the host context, or `undefined` when the chat is not admitted or the user is not allowed.
   */
  private interaction(interaction: ButtonEvent | SelectEvent | CheckEvent):
    { chat: ImChat; message?: ImMessage; session?: SessionId } | undefined {
    const chat = this.deps.im.chat(ImChatKey(interaction.bot.id, interaction.chat.id))
    if (chat === undefined) return
    const source = this.deps.im.source(chat.source)
    // The rule this chat was admitted by is gone (a config edit removed it), while its record survives in
    // `im_messages`. Refuse the interaction: skipping the allowlist there would let every member of the old chat press
    // a control the session still owns, `/stop` included.
    if (source === undefined) return
    // The rule may also still exist without this chat in its list, which is how an operator narrows one source. The
    // next inbound frame is re-admitted against the current rules, so the controls have to be as well.
    if (!admitsChat(source, interaction.bot.id, interaction.chat)) return
    if (!allows(source.users, interaction.user.id)) return
    const candidate = interaction.message === undefined
      ? undefined
      : this.deps.im.history.get(ImMessageKey(interaction.bot.id, interaction.message.id))
    const message = candidate?.chat.key === chat.key ? candidate : undefined
    const owner = message === undefined ? undefined : this.deps.sender.sessionOf(message.key)
    return { chat, ...message === undefined ? {} : { message }, ...owner === undefined ? {} : { session: owner } }
  }

  /** End every open turn output (service shutdown). */
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.chains.values()])
    const open = [...this.open.values()]
    this.open.clear()
    this.seenReactions.clear()
    await Promise.all(open.map(entry => this.close(entry)))
  }

  // -------------------------------------------------------------------------------------------------------------

  /** Queue one activity change on its session's chain, so a turn's steps keep the tracker's order. */
  private activity(activity: ImActivity, change: ImActivityChange): void {
    const sessionId = activity.session.sessionId
    const next = (this.chains.get(sessionId) ?? Promise.resolve()).then(() => this.apply(activity, change))
    const settled = next.catch((error: unknown) => {
      this.ctx.logger.warn('IM output of session %s failed: %s', sessionId, error)
    })
    this.chains.set(sessionId, settled)
    void settled.then(() => {
      if (this.chains.get(sessionId) === settled) this.chains.delete(sessionId)
    })
  }

  /** Begin, update or end the output of one turn. */
  private async apply(activity: ImActivity, change: ImActivityChange): Promise<void> {
    const sessionId = activity.session.sessionId
    let entry = this.open.get(sessionId)
    if (entry !== undefined && entry.turn !== activity.turn) {
      // The previous turn never reported its `end` (restart, crash): settle it before the next one begins.
      await this.close(entry)
      entry = undefined
    }
    if (entry === undefined) {
      // A change of a turn this process never started has nothing to drive.
      if (change !== 'start') return
      const id = activity.session.output
      if (id === undefined || id === NO_OUTPUT) return
      this.open.set(sessionId, { turn: activity.turn, activity, output: this.begin(activity, id) })
      return
    }
    entry.activity = activity
    if (change !== 'end') {
      entry.output?.update(activity, change)
      return
    }
    this.open.delete(sessionId)
    await this.close(entry)
  }

  /** Resolve the renderer and the home chat and start one turn; undefined when ineligible. */
  private begin(activity: ImActivity, id: string): ImTurnOutput | undefined {
    const record = activity.session
    const renderer = this.renderers.get(id)
    if (renderer === undefined) {
      this.ctx.logger.warn('IM session %s names the unknown output renderer %s', record.sessionId, id)
      return undefined
    }
    const target = targetOf(activity)
    if (target === undefined) return undefined
    try {
      return renderer.begin(activity, this.io(activity, target))
    } catch (error: unknown) {
      this.ctx.logger.warn('IM output %s failed to begin session %s: %s', id, record.sessionId, error)
      return undefined
    }
  }

  /** End one turn's renderer output; a failing renderer never breaks the session's other turns. */
  private async close(entry: Open): Promise<void> {
    const sessionId = entry.activity.session.sessionId
    if (entry.output === undefined) {
      this.ctx.logger.warn('IM output of session %s has no renderer for turn %d; nothing is published',
        sessionId, entry.turn)
      return
    }
    try {
      await entry.output.end(entry.activity)
    } catch (error: unknown) {
      this.ctx.logger.warn('IM output renderer failed to end the turn %d of %s: %s',
        entry.turn, sessionId, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * The per-turn sink: attribution to the session; the trigger is quoted (in its thread, else the binding's) only
   * when it belongs to the target chat and is still stored in `im_messages` (omitting `quote` otherwise).
   */
  private io(activity: ImActivity, target: ImBinding): ImOutputIO {
    const { chat } = target
    const trigger = activity.trigger?.chat.key === chat ? activity.trigger : undefined
    const thread = trigger?.thread?.id ?? target.thread
    // Quote the trigger only while it is still stored in `im_messages`: if retention or `maxRecords` evicted it
    // before or during the turn, `quoteId()` would reject the send with `access` and drop the turn output.
    const sendOptions = (): ImSendOptions => {
      const quote = trigger !== undefined && this.deps.im.history.get(trigger.key) !== undefined
        ? trigger.key
        : undefined
      return {
        session: activity.session.sessionId,
        ...quote === undefined ? {} : { quote },
        ...thread === undefined ? {} : { thread },
      }
    }
    return {
      chat,
      stream: (streamOptions?: StreamOptions): Promise<MessageStream> =>
        this.deps.sender.stream(chat, { ...sendOptions(), ...streamOptions }),
      send: (content: Fragment): Promise<ImSendResult> => this.deps.sender.send(chat, content, sendOptions()),
    }
  }
}

/**
 * The binding one turn renders into: the trigger's chat when the session holds a writable binding for it, else the
 * writable home binding; undefined when the session may publish into neither.
 * @param activity - the turn, with its session record and trigger.
 * @returns the writable binding (chat and thread) the turn's output targets.
 */
export function targetOf(activity: ImActivity): ImBinding | undefined {
  const { bindings } = activity.session
  const chat = activity.trigger?.chat.key
  // A trigger's chat decides where the turn renders: falling back to the home binding published one chat's work into
  // another chat, which that chat's readers never asked for and cannot attribute.
  if (chat !== undefined) return bindings.find(binding => binding.chat === chat && binding.writable)
  return bindings.find(binding => binding.home === true && binding.writable)
}
