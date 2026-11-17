/**
 * Default dispatcher: the innermost `im/message` listener when `config.defaultDispatch` is set.
 *
 * Contract:
 * - **Scope.** Only a message no other listener handled reaches it. An own message (`sender.self`) or a message that
 *   does not address the bot is ignored, matching the default when no dispatcher is configured.
 * - **One session.** Every dispatched message goes to one hosted session, key {@link DISPATCHER_KEY}, owner
 *   {@link DISPATCHER_OWNER}, composed from the config. Its bindings accumulate: each chat it hears is added (writable
 *   when the admitting source is), the first chat being its home; a known chat refreshes only its write grant. The
 *   bindings live in the session record, so no other storage holds them.
 * - **Delivery.** `event.deliver` keeps the host defaults (id = message key, content = the message, trigger = the
 *   message) with `mode: config.delivery`, `media: true`, and a `<im-chat …/>` header naming the chat, so the model
 *   knows which chat each message came from.
 * - **Prompt.** {@link ImDispatcher.guidance} is the text of the dispatcher's prompt section, rendered for that session
 *   only.
 */
import { isAbsolute } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  ImBinding, ImChat, ImDispatcherConfig, ImMessageEvent, ImOutcome, ImSessionRecord, ImSessions,
} from './api.ts'
import { ImError } from './error.ts'
import { escapeAttribute } from './format.ts'

/** Session key of the one dispatcher session. */
export const DISPATCHER_KEY = 'im:dispatcher'
/** Owner name of the dispatcher session (and the outcome attribution of a dispatched message). */
export const DISPATCHER_OWNER = 'dispatcher'

/**
 * The header placed before a dispatched message: `<im-chat key="…" source="…" type="…" />`.
 * @param chat - the chat the message arrived in.
 * @returns the header line naming the chat key, admitting source and chat type.
 */
export function chatHeader(chat: ImChat): string {
  return `<im-chat key="${escapeAttribute(chat.key)}" source="${escapeAttribute(String(chat.source))}" `
    + `type="${escapeAttribute(chat.ref.type)}" />`
}

/** The dispatcher body: decides, binds and delivers; owns no storage of its own. */
export class ImDispatcher {
  /** Tail of the serialized binding updates: chats dispatch in parallel, but bindings must not lose a chat. */
  private binding: Promise<unknown> = Promise.resolve()

  /**
   * @param config - the resolved dispatcher configuration.
   * @param sessions - the session host the dispatcher session lives in.
   * @throws ImError `configuration` when `cwd` is not absolute.
   */
  constructor(
    readonly config: ImDispatcherConfig,
    readonly sessions: Pick<ImSessions, 'ensure' | 'get' | 'of' | 'deliveredTo'>,
  ) {
    if (!isAbsolute(config.cwd)) {
      throw new ImError('configuration', `The IM dispatcher cwd ${JSON.stringify(config.cwd)} must be an absolute path.`)
    }
  }

  /**
   * Dispatch one message no other listener handled.
   * @param event - the waterfall argument of the message.
   * @returns `handled by dispatcher` with the dispatcher session, or `ignored` for an own or unaddressed message.
   */
  async handle(event: ImMessageEvent): Promise<ImOutcome> {
    const { message } = event
    if (message.sender.self || !message.addressed) return { kind: 'ignored' }
    const record = await this.ensure(event)
    const prior = this.sessions.deliveredTo(DISPATCHER_KEY, message.key)
    if (prior !== undefined) return { kind: 'handled', by: DISPATCHER_OWNER, sessions: [prior] }
    await event.deliver(record.sessionId, {
      mode: this.config.delivery, media: true, header: chatHeader(message.chat),
    })
    return { kind: 'handled', by: DISPATCHER_OWNER, sessions: [record.sessionId] }
  }

  /**
   * Text of the dispatcher prompt section for one agent.
   * @param agent - the agent of the assembly; absent on diagnostics.
   * @returns the configured guidance for the dispatcher session, '' for every other agent.
   */
  guidance(agent: Agent | undefined): string {
    const record = agent === undefined ? undefined : this.sessions.of(agent.session.id)
    return record?.key === DISPATCHER_KEY ? this.config.prompt.text : ''
  }

  /** Create or refresh the dispatcher session with the event's chat among its bindings. */
  private ensure(event: ImMessageEvent): Promise<ImSessionRecord> {
    const next = this.binding.then(() => {
      const known = this.sessions.get(DISPATCHER_KEY)
      return this.sessions.ensure({
        key: DISPATCHER_KEY,
        owner: DISPATCHER_OWNER,
        composition: {
          agentPreset: this.config.agentPreset, cwd: this.config.cwd,
          provider: this.config.provider, model: this.config.model,
          ...this.config.restrict === undefined ? {} : { restrict: this.config.restrict },
        },
        bindings: bindingsWith(known?.bindings ?? [], event),
        output: this.config.output,
      })
    })
    this.binding = next.catch(() => {})
    return next
  }
}

/** The known bindings with the event's chat added (or its write grant refreshed); the first chat is the home. */
function bindingsWith(bindings: readonly ImBinding[], event: ImMessageEvent): ImBinding[] {
  const chat = event.message.chat.key
  const writable = event.source.writable
  if (bindings.some(binding => binding.chat === chat)) {
    return bindings.map(binding => (binding.chat === chat ? { ...binding, writable } : binding))
  }
  return [...bindings, { chat, writable, ...bindings.length === 0 ? { home: true } : {} }]
}
