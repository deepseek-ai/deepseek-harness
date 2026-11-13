/**
 * Command dispatch of session-commands: one class over the IM session host, the dsh command registry, and the agent
 * registry. Replies go through `event.reply` only; the core records the returned outcome, so a redelivered message
 * cannot act twice.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Fragment } from '@deepseek-ai/cordis-plugin-im-core'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ImChatKey, ImMessage, ImMessageEvent, ImOutcome, ImSessionRecord } from '@deepseek-ai/dsh-im'
import type { SessionCommandsConfig } from './config.ts'
import {
  describeAge, fill, stringsOf, type BuiltinCommandName, type SessionCommandStrings,
} from './locale.ts'

/** Command names the plugin answers itself. */
export const BUILTIN_ORDER: readonly BuiltinCommandName[] = ['stop', 'clear', 'new', 'status', 'help']
/** Outcome attribution the core stores with a handled message. */
export const BY = 'session-commands'

const BUILTINS: ReadonlySet<string> = new Set<string>(BUILTIN_ORDER)

/** Whether one record binds the chat as its home. */
function homeOf(record: ImSessionRecord, chat: ImChatKey): boolean {
  return record.bindings.some(binding => binding.chat === chat && binding.home === true)
}

/** Whether one record is bound to the thread of a message. */
function inThread(record: ImSessionRecord, thread: string): boolean {
  return record.bindings.some(binding => binding.thread === thread)
}

/**
 * Answers the commands the plugin owns (`/stop`, `/clear`, `/new`, `/status`, `/help`) and forwards configured names
 * to the dsh command registry, all through `event.reply`.
 *
 * One instance per plugin row; `handle` is its `im/message` waterfall listener.
 */
export class SessionCommands {
  private readonly strings: SessionCommandStrings
  private readonly passthrough: ReadonlySet<string>
  private readonly resettable: ReadonlySet<string>
  /** Aborted on dispose so a passthrough command cannot outlive the plugin. */
  private readonly shutdown = new AbortController()

  constructor(readonly ctx: Context, readonly config: SessionCommandsConfig) {
    this.strings = stringsOf(config.locale)
    this.passthrough = new Set(config.passthrough)
    this.resettable = new Set(config.resettable)
  }

  /** Abort in-flight passthrough commands. */
  dispose(): void {
    this.shutdown.abort()
  }

  /**
   * Answer one admitted message, or pass it on.
   * @param event - the waterfall argument.
   * @param next - the remaining listeners (and the core's ignored default).
   * @returns the recorded outcome.
   */
  async handle(event: ImMessageEvent, next: () => Promise<ImOutcome>): Promise<ImOutcome> {
    const { message } = event
    const command = message.command
    // In groups the intake still parses a command out of an unaddressed message; only act when addressed.
    if (command === undefined || !message.addressed) return next()
    const { name } = command
    const builtin = BUILTINS.has(name)
    if (!builtin && !this.passthrough.has(name)) return next()
    const privileged = !builtin || (name !== 'status' && name !== 'help')
    if (privileged && !this.permitted(message)) {
      await this.reply(event, this.strings.denied)
      return this.outcome()
    }
    const chat = message.chat.key
    const records = this.ctx.im.sessions.forChat(chat)
    switch (name) {
      case 'stop': return this.stop(event, records)
      case 'clear':
      case 'new': return this.reset(event, records, chat, name)
      case 'status': return this.status(event, records, chat)
      case 'help': return this.help(event, records, chat)
      default: return this.forward(event, records, chat, name, command.rawInput, next)
    }
  }

  // -------------------------------------------------------------------------------------------------------------

  /** `/stop`: cancel every running session bound to the chat, thread-bound ones only when they exist. */
  private async stop(event: ImMessageEvent, records: ImSessionRecord[]): Promise<ImOutcome> {
    const stopped: SessionId[] = []
    for (const record of this.targets(records, event.message)) {
      if (await this.ctx.im.sessions.stop(record.key)) stopped.push(record.sessionId)
    }
    await this.reply(event, stopped.length === 0 ? this.strings.nothingToStop : fill(this.strings.stopped, stopped.length))
    return this.outcome(stopped)
  }

  /** `/clear`, `/new`: reset the home sessions of this chat whose owner is resettable, idempotent per message key. */
  private async reset(
    event: ImMessageEvent,
    records: ImSessionRecord[],
    chat: ImChatKey,
    name: BuiltinCommandName,
  ): Promise<ImOutcome> {
    const targets = records.filter(record => this.resettable.has(record.owner) && homeOf(record, chat))
    const replaced: SessionId[] = []
    const operationId = `${BY}:${event.message.key}`
    for (const record of targets) {
      const sessionId = await this.ctx.im.sessions.reset(record.key, `${BY}:/${name}`, {
        operationId,
        expectedGeneration: record.generation,
      })
      if (sessionId !== undefined) replaced.push(sessionId)
    }
    await this.reply(event, replaced.length === 0 ? this.strings.nothingToReset : fill(this.strings.reset, replaced.length))
    return this.outcome(replaced)
  }

  /** `/status`: identity, model, run state, queued input and the age of the last activity. */
  private async status(event: ImMessageEvent, records: ImSessionRecord[], chat: ImChatKey): Promise<ImOutcome> {
    const home = this.findHome(records, event.message, chat)
    if (home === undefined) return await this.noSession(event)
    const agent = this.ctx.agents.get(home.sessionId)
    const labels = this.strings.status
    const queued = agent === undefined ? 0 : agent.inbox.nextTurn.length + agent.inbox.nextStep.length
    const state = agent?.status === 'running' ? labels.running : labels.idle
    const line = (label: string, value: string): string => `${label}${this.strings.colon}${value}`
    await this.reply(event, [
      line(labels.session, home.sessionId),
      line(labels.model, home.composition.model),
      line(labels.state, state),
      line(labels.queued, String(queued)),
      line(labels.activity, describeAge(Date.now() - home.lastActiveAt, this.strings)),
    ])
    return this.outcome([home.sessionId])
  }

  /** `/help`: the built-in commands plus the registered passthrough commands. */
  private async help(event: ImMessageEvent, records: ImSessionRecord[], chat: ImChatKey): Promise<ImOutcome> {
    const lines = [this.strings.helpTitle]
    for (const name of BUILTIN_ORDER) lines.push(`/${name} — ${this.strings.describe[name]}`)
    const home = this.findHome(records, event.message, chat)
    if (home === undefined) {
      // Without a session the registry cannot be consulted, so advertise the configured names alone.
      for (const name of this.passthrough) if (!BUILTINS.has(name)) lines.push(`/${name}`)
    } else {
      const agent = await this.ctx.im.sessions.agent(home.sessionId)
      for (const descriptor of this.ctx.commands.list(agent)) {
        if (this.passthrough.has(descriptor.name)) lines.push(`/${descriptor.name} — ${descriptor.description}`)
      }
    }
    await this.reply(event, lines)
    return this.outcome(home === undefined ? undefined : [home.sessionId])
  }

  /** A passthrough name: run the registered dsh command against the chat's home session. */
  private async forward(
    event: ImMessageEvent,
    records: ImSessionRecord[],
    chat: ImChatKey,
    name: string,
    rawInput: string,
    next: () => Promise<ImOutcome>,
  ): Promise<ImOutcome> {
    const home = this.findHome(records, event.message, chat)
    if (home === undefined) return await this.noSession(event)
    // `agent()` opens (or resumes) the live agent the registry executes against.
    const agent: Agent = await this.ctx.im.sessions.agent(home.sessionId)
    // An unregistered name (or one that vanished between listing and execution) is not this plugin's command.
    const execution = await this.ctx.commands.execute(agent, `/${name}${rawInput}`, [], this.shutdown.signal)
    if (execution === undefined) return next()
    await this.reply(event, execution.result.text ?? this.strings.done)
    return this.outcome([home.sessionId])
  }

  // -------------------------------------------------------------------------------------------------------------

  /** The chat's home session within the message's target scope, if any. */
  private findHome(records: ImSessionRecord[], message: ImMessage, chat: ImChatKey): ImSessionRecord | undefined {
    return this.targets(records, message).find(record => homeOf(record, chat))
  }

  /** Reply that the chat has no home session yet and report the command handled. */
  private async noSession(event: ImMessageEvent): Promise<ImOutcome> {
    await this.reply(event, this.strings.noSession)
    return this.outcome()
  }

  /** Publish a command reply deduplicated by the triggering message's key. */
  private async reply(event: ImMessageEvent, content: Fragment): Promise<void> {
    await event.reply(content, { operationId: `${BY}:reply:${event.message.key}` })
  }

  /** Sessions bound to the chat, thread-bound ones only when the message is in a thread they own. */
  private targets(records: ImSessionRecord[], message: ImMessage): ImSessionRecord[] {
    const thread = message.thread?.id
    if (thread === undefined) return records
    const inside = records.filter(record => inThread(record, thread))
    return inside.length > 0 ? inside : records
  }

  /** Whether the sender may run a privileged command. */
  private permitted(message: ImMessage): boolean {
    if (this.config.allow === 'all') return true
    const sender = message.sender.id
    return this.config.admins.includes(sender) || this.config.admins.includes(`${message.chat.bot}|${sender}`)
  }

  /** Outcome of a message this plugin consumed. */
  private outcome(sessions?: readonly SessionId[]): ImOutcome {
    return sessions === undefined || sessions.length === 0
      ? { kind: 'handled', by: BY }
      : { kind: 'handled', by: BY, sessions: [...sessions] }
  }
}
