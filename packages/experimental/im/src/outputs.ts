/**
 * Output renderer registry: drives the renderer named by `spec.output` for each `im/activity` turn of a session that
 * may publish (per-turn {@link ImOutputIO} with quote/thread from the trigger, attributed sends); re-emits
 * `interaction/button` in admitted chats as `im/button`, routing `dsh:stop:<id>` to `sessions.stop`.
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
import type { Fragment, MessageStream, Session, StreamOptions } from '@deepseek-ai/cordis-plugin-im-core'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  ImChatKey, ImMessageKey,
  type ImActivity, type ImActivityChange, type ImBinding, type ImButtonEvent, type ImChat, type ImHistory,
  type ImOutputIO, type ImOutputRenderer, type ImOutputs, type ImSendOptions, type ImSendResult, type ImSessions,
  type ImTurnOutput,
} from './api.ts'
import { ImError } from './error.ts'
import type { ImSender } from './send.ts'

/** Button id prefix the core routes to `sessions.stop`. */
export const STOP_BUTTON_PREFIX = 'dsh:stop:'

/** Reserved `spec.output` value that names no renderer: nothing is published unless the agent calls `im_send`. */
export const NO_OUTPUT = 'none'

/** The IM host slice one rendered turn reads: the chat of a session and its history tail. */
export interface ImOutputHost {
  chat(key: ImChatKey): ImChat | undefined
  readonly history: Pick<ImHistory, 'get'>
  readonly sessions: Pick<ImSessions, 'get' | 'stop'>
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

  constructor(readonly ctx: Context, readonly deps: ImOutputDeps) {}

  /** Subscribe `im/activity` and `interaction/button` (disposed with `ctx`). */
  start(): void {
    this.ctx.on('im/activity', (activity, change) => { this.activity(activity, change) })
    this.ctx.on('interaction/button', (session) => { void this.button(session) })
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
  async button(session: Session): Promise<void> {
    const button = session.button
    if (button === undefined) return
    const bot = session.bot
    const chat = this.deps.im.chat(ImChatKey(bot.id, button.chat.id))
    // A click outside the admitted chats is invisible to this host.
    if (chat === undefined) return
    const message = button.message === undefined
      ? undefined
      : this.deps.im.history.get(ImMessageKey(bot.id, button.message.id))
    const owner = message === undefined ? undefined : this.deps.sender.sessionOf(message.key)
    const event: ImButtonEvent = {
      id: button.id,
      chat,
      user: button.user,
      bot,
      time: button.time,
      raw: button,
      ...button.data === undefined ? {} : { data: button.data },
      ...message === undefined ? {} : { message },
      ...owner === undefined ? {} : { session: owner },
    }
    this.ctx.emit('im/button', event)
    if (!button.id.startsWith(STOP_BUTTON_PREFIX)) return
    await this.stop(chat, button.id.slice(STOP_BUTTON_PREFIX.length))
  }

  /** End every open turn output (service shutdown). */
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.chains.values()])
    const open = [...this.open.values()]
    this.open.clear()
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
      this.open.set(sessionId, { turn: activity.turn, activity, output: this.begin(activity) })
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
  private begin(activity: ImActivity): ImTurnOutput | undefined {
    const record = activity.session
    const id = record.output
    if (id === undefined || id === NO_OUTPUT) return undefined
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
   * when it belongs to the target chat.
   */
  private io(activity: ImActivity, target: ImBinding): ImOutputIO {
    const { chat } = target
    const trigger = activity.trigger?.chat.key === chat ? activity.trigger : undefined
    const thread = trigger?.thread?.id ?? target.thread
    const options: ImSendOptions = {
      session: activity.session.sessionId,
      ...trigger === undefined ? {} : { quote: trigger.key },
      ...thread === undefined ? {} : { thread },
    }
    return {
      chat,
      stream: (streamOptions?: StreamOptions): Promise<MessageStream> =>
        this.deps.sender.stream(chat, { ...options, ...streamOptions }),
      send: (content: Fragment): Promise<ImSendResult> => this.deps.sender.send(chat, content, options),
    }
  }

  /** `dsh:stop:<sessionId>`: cancel the running turn of a session bound to the chat the button lives in. */
  private async stop(chat: ImChat, target: string): Promise<void> {
    const record = this.deps.im.sessions.get(target)
    if (record === undefined || !record.bindings.some(binding => binding.chat === chat.key)) return
    try {
      await this.deps.im.sessions.stop(record.sessionId)
    } catch (error: unknown) {
      this.ctx.logger.warn('IM stop button could not stop session %s: %s', record.sessionId, error)
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
  return (chat === undefined ? undefined : bindings.find(binding => binding.chat === chat && binding.writable))
    ?? bindings.find(binding => binding.home === true && binding.writable)
}
