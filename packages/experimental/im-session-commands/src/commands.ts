/**
 * Command dispatch of session-commands: one class over the IM session host, the dsh command registry, the agent
 * registry, and durable command receipts (`im_session_commands`). Each handled command persists its first reply and
 * session list before calling `event.reply`, so a redelivery after a transient `store.settle` failure or restart
 * replays the original reply instead of recomputing against mutated session state.
 */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Fragment } from '@deepseek-ai/cordis-plugin-im-core'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import type { ImChatKey, ImMessage, ImMessageEvent, ImMessageKey, ImOutcome, ImSessionRecord } from '@deepseek-ai/dsh-im'
import type { SessionCommandsConfig } from './config.ts'
import {
  describeAge, fill, stringsOf, type BuiltinCommandName, type SessionCommandStrings,
} from './locale.ts'

/** Command names the plugin answers itself. */
export const BUILTIN_ORDER: readonly BuiltinCommandName[] = ['stop', 'clear', 'new', 'status', 'help']
/** Outcome attribution the core stores with a handled message. */
export const BY = 'session-commands'

const BUILTINS: ReadonlySet<string> = new Set<string>(BUILTIN_ORDER)

/** Durable receipt of one handled command message, keyed by `event.message.key`. */
export interface StoredCommandReceipt {
  /** `'pending'` while side effects are in flight; `'done'` (or omitted for legacy rows) once settled. */
  status?: 'pending' | 'done'
  /** Exact reply content recorded before the first `event.reply` call so redeliveries replay identical text. */
  reply: string
  /** Hosted session ids the command acted on, when any. */
  sessions?: SessionId[]
  createdAt: number
}

interface DecidedCommand {
  reply: string
  sessions?: readonly SessionId[]
}

const storedSessionId = z.string().transform((value): SessionId => value as SessionId)
const commandReceiptSchema = z.object({
  status: z.exactOptional(z.enum(['pending', 'done'])),
  reply: z.string(),
  sessions: z.exactOptional(z.array(storedSessionId)),
  createdAt: z.number(),
})

/** The `im_session_commands` storage domain: durable command outcomes and replies keyed by message key. */
export const imSessionCommandsDomain = defineDomain({
  name: 'im_session_commands',
  version: 1,
  tables: {
    commands: domainTable<ImMessageKey, StoredCommandReceipt>(commandReceiptSchema),
  },
})

/** The `im_session_commands` domain type: durable command outcomes and replies keyed by message key. */
export type ImSessionCommandsDomain = Domain<typeof imSessionCommandsDomain>

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
 * to the dsh command registry, persisting and replaying each handled message's first reply and outcome.
 *
 * One instance per plugin row; `handle` is its `im/message` waterfall listener.
 */
export class SessionCommands {
  private readonly strings: SessionCommandStrings
  private readonly passthrough: ReadonlySet<string>
  private readonly resettable: ReadonlySet<string>
  /** Aborted on dispose so a passthrough command cannot outlive the plugin. */
  private readonly shutdown = new AbortController()
  private readonly chains = new Map<ImMessageKey, Promise<unknown>>()
  private readonly ready: Promise<ImSessionCommandsDomain>
  private openReady!: (domain: ImSessionCommandsDomain) => void
  private failReady!: (error: unknown) => void
  private starting: Promise<void> | undefined
  private domain: ImSessionCommandsDomain | undefined

  constructor(readonly ctx: Context, readonly config: SessionCommandsConfig) {
    this.strings = stringsOf(config.locale)
    this.passthrough = new Set(config.passthrough)
    this.resettable = new Set(config.resettable)
    this.ready = new Promise<ImSessionCommandsDomain>((resolve, reject) => {
      this.openReady = resolve
      this.failReady = reject
    })
    this.ready.catch(() => {})
  }

  /** Open the durable receipt store and prune expired command receipts. */
  start(): Promise<void> {
    const task = this.open()
    this.starting = task
    return task
  }

  private async open(): Promise<void> {
    try {
      const domain = await this.ctx.storageDomain.open(imSessionCommandsDomain)
      this.domain = domain
      if (this.shutdown.signal.aborted || this.ctx.fiber.uid === null) {
        throw new Error('The IM session-commands plugin was disposed before startup finished.')
      }
      await this.prune(domain, Date.now())
      this.openReady(domain)
    } catch (error) {
      const domain = this.domain
      this.domain = undefined
      this.failReady(error)
      try {
        await domain?.close()
      } catch (closeError) {
        this.ctx.logger.warn('Failed to close IM session-commands domain after startup failure: %s', String(closeError))
      }
      throw error
    }
  }

  /** Abort in-flight passthrough commands, wait for startup and dispatches, and close the receipt store. */
  async dispose(): Promise<void> {
    this.shutdown.abort()
    await Promise.allSettled([this.starting, ...this.chains.values()])
    const domain = this.domain
    this.domain = undefined
    await domain?.close()
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
    const handled = await this.serial(message.key, async (): Promise<ImOutcome | undefined> => {
      const domain = await this.ready
      const table = domain.table('commands')
      const recorded = table.get(message.key)
      if (recorded !== undefined) {
        if (recorded.status === 'pending') {
          const settled: StoredCommandReceipt = {
            ...recorded,
            status: 'done',
            reply: this.strings.interrupted,
          }
          await table.put(message.key, settled)
          await this.reply(event, settled.reply)
          return this.outcome(settled.sessions)
        }
        await this.reply(event, recorded.reply)
        return this.outcome(recorded.sessions)
      }
      const persistPending = (sessions: readonly SessionId[]): Promise<void> => table.put(message.key, {
        status: 'pending',
        reply: '',
        ...sessions.length === 0 ? {} : { sessions: [...sessions] },
        createdAt: Date.now(),
      })
      const decided = await this.decide(event, name, builtin, command.rawInput, persistPending)
      if (decided === undefined) {
        if (table.get(message.key)?.status === 'pending') await table.delete(message.key)
        return undefined
      }
      const now = Date.now()
      const receipt: StoredCommandReceipt = {
        status: 'done',
        reply: decided.reply,
        ...decided.sessions === undefined || decided.sessions.length === 0 ? {} : { sessions: [...decided.sessions] },
        createdAt: now,
      }
      await table.put(message.key, receipt)
      await this.prune(domain, now)
      await this.reply(event, receipt.reply)
      return this.outcome(receipt.sessions)
    })
    return handled ?? next()
  }

  // -------------------------------------------------------------------------------------------------------------

  /** Compute the first-time reply and affected session list for one command, or undefined when passthrough declines. */
  private async decide(
    event: ImMessageEvent,
    name: string,
    builtin: boolean,
    rawInput: string,
    persistPending: (sessions: readonly SessionId[]) => Promise<void>,
  ): Promise<DecidedCommand | undefined> {
    const { message } = event
    const privileged = !builtin || (name !== 'status' && name !== 'help')
    if (privileged && !this.permitted(message)) return { reply: this.strings.denied }
    const chat = message.chat.key
    const records = this.ctx.im.sessions.forChat(chat)
    switch (name) {
      case 'stop': return this.stop(message, records, persistPending)
      case 'clear':
      case 'new': return this.reset(message, records, chat, name, persistPending)
      case 'status': return this.status(message, records, chat)
      case 'help': return this.help(message, records, chat)
      default: return this.forward(message, records, chat, name, rawInput, persistPending)
    }
  }

  /** `/stop`: cancel every running session bound to the chat, thread-bound ones only when they exist. */
  private async stop(
    message: ImMessage,
    records: ImSessionRecord[],
    persistPending: (sessions: readonly SessionId[]) => Promise<void>,
  ): Promise<DecidedCommand> {
    const targets = this.targets(records, message)
    await persistPending(targets.map(record => record.sessionId))
    const stopped: SessionId[] = []
    for (const record of targets) {
      if (await this.ctx.im.sessions.stop(record.key)) stopped.push(record.sessionId)
    }
    return {
      reply: stopped.length === 0 ? this.strings.nothingToStop : fill(this.strings.stopped, stopped.length),
      sessions: stopped,
    }
  }

  /** `/clear`, `/new`: reset the home sessions of this chat whose owner is resettable, idempotent per message key. */
  private async reset(
    message: ImMessage,
    records: ImSessionRecord[],
    chat: ImChatKey,
    name: BuiltinCommandName,
    persistPending: (sessions: readonly SessionId[]) => Promise<void>,
  ): Promise<DecidedCommand> {
    const targets = records.filter(record => this.resettable.has(record.owner) && homeOf(record, chat))
    await persistPending(targets.map(record => record.sessionId))
    const replaced: SessionId[] = []
    const operationId = `${BY}:${message.key}`
    for (const record of targets) {
      const sessionId = await this.ctx.im.sessions.reset(record.key, `${BY}:/${name}`, {
        operationId,
        expectedGeneration: record.generation,
      })
      if (sessionId !== undefined) replaced.push(sessionId)
    }
    return {
      reply: replaced.length === 0 ? this.strings.nothingToReset : fill(this.strings.reset, replaced.length),
      sessions: replaced,
    }
  }

  /** `/status`: identity, model, run state, queued input and the age of the last activity. */
  private status(message: ImMessage, records: ImSessionRecord[], chat: ImChatKey): DecidedCommand {
    const home = this.findHome(records, message, chat)
    if (home === undefined) return { reply: this.strings.noSession }
    const agent = this.ctx.agents.get(home.sessionId)
    const labels = this.strings.status
    const queued = agent === undefined ? 0 : agent.inbox.nextTurn.length + agent.inbox.nextStep.length
    const state = agent?.status === 'running' ? labels.running : labels.idle
    const line = (label: string, value: string): string => `${label}${this.strings.colon}${value}`
    return {
      reply: [
        line(labels.session, home.sessionId),
        line(labels.model, home.composition.model),
        line(labels.state, state),
        line(labels.queued, String(queued)),
        line(labels.activity, describeAge(Date.now() - home.lastActiveAt, this.strings)),
      ].join('\n'),
      sessions: [home.sessionId],
    }
  }

  /** `/help`: the built-in commands plus the registered passthrough commands. */
  private async help(message: ImMessage, records: ImSessionRecord[], chat: ImChatKey): Promise<DecidedCommand> {
    const lines = [this.strings.helpTitle]
    for (const name of BUILTIN_ORDER) lines.push(`/${name} — ${this.strings.describe[name]}`)
    const home = this.findHome(records, message, chat)
    if (home === undefined) {
      // Without a session the registry cannot be consulted, so advertise the configured names alone.
      for (const name of this.passthrough) if (!BUILTINS.has(name)) lines.push(`/${name}`)
      return { reply: lines.join('\n') }
    }
    const agent = await this.ctx.im.sessions.agent(home.sessionId)
    for (const descriptor of this.ctx.commands.list(agent)) {
      if (this.passthrough.has(descriptor.name)) lines.push(`/${descriptor.name} — ${descriptor.description}`)
    }
    return { reply: lines.join('\n'), sessions: [home.sessionId] }
  }

  /** A passthrough name: run the registered dsh command against the chat's home session. */
  private async forward(
    message: ImMessage,
    records: ImSessionRecord[],
    chat: ImChatKey,
    name: string,
    rawInput: string,
    persistPending: (sessions: readonly SessionId[]) => Promise<void>,
  ): Promise<DecidedCommand | undefined> {
    const home = this.findHome(records, message, chat)
    if (home === undefined) return { reply: this.strings.noSession }
    // `agent()` opens (or resumes) the live agent the registry executes against.
    const agent: Agent = await this.ctx.im.sessions.agent(home.sessionId)
    if (!this.ctx.commands.list(agent).some(descriptor => descriptor.name === name)) return undefined
    await persistPending([home.sessionId])
    // An unregistered name (or one that vanished between listing and execution) is not this plugin's command.
    const execution = await this.ctx.commands.execute(agent, `/${name}${rawInput}`, [], this.shutdown.signal)
    if (execution === undefined) return undefined
    return { reply: execution.result.text ?? this.strings.done, sessions: [home.sessionId] }
  }

  // -------------------------------------------------------------------------------------------------------------

  /** The chat's home session within the message's target scope, if any. */
  private findHome(records: ImSessionRecord[], message: ImMessage, chat: ImChatKey): ImSessionRecord | undefined {
    return this.targets(records, message).find(record => homeOf(record, chat))
  }

  /** Publish a command reply deduplicated by the triggering message's key. */
  private async reply(event: ImMessageEvent, content: Fragment): Promise<void> {
    await event.reply(content, { operationId: `${BY}:reply:${event.message.key}` })
  }

  /** Delete command receipts older than `config.retentionMs`. */
  private async prune(domain: ImSessionCommandsDomain, now: number): Promise<void> {
    const table = domain.table('commands')
    const cutoff = now - this.config.retentionMs
    const expired: ImMessageKey[] = []
    for (const [key, receipt] of table.entries()) {
      if (receipt.createdAt >= cutoff) continue
      expired.push(key)
    }
    if (expired.length > 0) await table.deleteMany(expired)
  }

  /** Run one message's command flow behind any earlier call for the same message key. */
  private serial<T>(key: ImMessageKey, task: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(key) ?? Promise.resolve()).then(task)
    const tail = run.catch(() => undefined)
    this.chains.set(key, tail)
    void tail.then(() => { if (this.chains.get(key) === tail) this.chains.delete(key) })
    return run
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
