/**
 * Sessions-host test harness: a real AgentLoop with only the model scripted, real JSONL session persistence and a
 * memory storage domain, so `ImSessionHost` runs against the production agent machinery — inbox insertion, session log
 * reads (delivery dedupe) and resume after "restart".
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolRegistry from '@deepseek-ai/dsh-tool-registry-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import type { ImConfig, ImDelivery, ImFormatOptions, ImMessage, ImSessionRecord } from '../../src/api.ts'
import { Config } from '../../src/config.ts'
import { ImAgentHost } from '../../src/hosting.ts'
import { ImSessionHost, type ImSessionHostDeps, type StoredDelivery } from '../../src/sessions.ts'

/**
 * Model adapter scripting every request. `reply` is the visible answer; `hold` keeps a request open between its
 * arrival and its first chunk so a test can deliver while a turn runs.
 */
export class ScriptedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  reply = 'ack'
  hold: { entered: PromiseWithResolvers<undefined>; release: PromiseWithResolvers<undefined> } | undefined

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const hold = this.hold
    this.requests.push(options)
    if (hold) {
      hold.entered.resolve(undefined)
      const aborted = new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve()
        options.signal?.addEventListener('abort', () => { resolve() }, { once: true })
      })
      await Promise.race([hold.release.promise, aborted])
      options.signal?.throwIfAborted()
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /** Hold every request until the returned function is called. */
  gate(): () => void {
    const hold = { entered: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>() }
    this.hold = hold
    return () => {
      this.hold = undefined
      hold.release.resolve(undefined)
    }
  }

  /** Text of every request, joined per message block. */
  promptText(index: number): string {
    return (this.requests[index]?.messages ?? [])
      .flatMap(message => message.content)
      .flatMap(block => (block.type === 'text' ? [block.text] : []))
      .join('\n')
  }
}

/** One `ctx.im.format` call the host made while admitting a delivery. */
export interface FormatCall {
  messages: readonly ImMessage[]
  options: ImFormatOptions | undefined
}

/** Everything one booted host exposes to a test, including how to restart it. */
export interface SessionsHarness {
  ctx: Context
  host: ImSessionHost
  agents: ImAgentHost
  model: ScriptedModel
  /** Storage media shared by every boot of one scenario: a second boot is a restart. */
  pool: MemoryMediaPool
  root: string
  created: ImSessionRecord[]
  resets: { record: ImSessionRecord; reason: string }[]
  formats: FormatCall[]
  /** Make the next `ctx.im.format` call reject (a delivery that cannot be admitted yet). */
  failFormat(error?: Error): void
  /** Let `ctx.im.format` work again. */
  healFormat(): void
  /** Hold the next `ctx.im.format` call until the returned `release` runs, so a test can interleave a write. */
  holdFormat(): { entered: Promise<void>; release: () => void }
  /** Unmount session persistence (its flush listener) after an agent is already open. */
  dropPersistence(): Promise<void>
  close(): Promise<void>
}

/** Options of one boot: the same `pool` and `root` across boots replay a restart. */
export interface BootOptions {
  pool?: MemoryMediaPool
  root?: string
  config?: Partial<ImConfig>
  /** Leave the domain closed until the test calls `start()` itself. */
  withoutStart?: boolean
  /** Omit the agent-preset registry (the host must refuse to open an agent). */
  withoutPresets?: boolean
}

export const COMPOSITION = { agentPreset: 'im', cwd: process.cwd(), provider: 'mock', model: 'mock' }

const roots: string[] = []

/** Remove every temporary session root a harness created. */
export async function cleanRoots(): Promise<void> {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
}

/**
 * Boot one sessions host over a real agent stack.
 * @param options - shared media/root for a restart, config overrides and service omissions.
 * @returns the host plus its observation points.
 */
export async function boot(options: BootOptions = {}): Promise<SessionsHarness> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-im-sessions-'))
  if (options.root === undefined) roots.push(root)
  const pool = options.pool ?? new MemoryMediaPool()
  const ctx = new Context()
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolRegistry)
  await ctx.plugin(AgentRegistry)
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  if (!options.withoutPresets) ctx.provide('agentPresets', { mount: () => Promise.resolve() } as never)
  const model = new ScriptedModel()
  ctx.llm.registerAdapter(['mock'], model)

  const created: ImSessionRecord[] = []
  const resets: { record: ImSessionRecord; reason: string }[] = []
  ctx.on('im/session/created', (record) => { created.push(record) })
  ctx.on('im/session/reset', (record, reason) => { resets.push({ record, reason }) })

  const formats: FormatCall[] = []
  let formatFailure: Error | undefined
  let formatHold: { entered: PromiseWithResolvers<undefined>; release: PromiseWithResolvers<undefined> } | undefined
  const formatter: ImSessionHostDeps['formatter'] = {
    format: async (messages: readonly ImMessage[], formatOptions?: ImFormatOptions) => {
      formats.push({ messages, options: formatOptions })
      if (formatFailure) throw formatFailure
      const hold = formatHold
      if (hold !== undefined) {
        formatHold = undefined
        hold.entered.resolve(undefined)
        await hold.release.promise
      }
      const text = messages.map(message => message.text).join('\n')
      return [{ type: 'text', text }] satisfies UserMessage['content']
    },
  }

  const config = Config({ sources: [{ id: 'team', bot: 'fake:bot', writable: true, store: 'all' }], retryIntervalMs: 60_000, ...options.config })
  const agents = new ImAgentHost(ctx)
  const host = new ImSessionHost(ctx, config, { agents, formatter })
  if (!options.withoutStart) await host.start()
  return {
    ctx, host, agents, model, pool, root, created, resets, formats,
    failFormat(error = new Error('format offline')): void { formatFailure = error },
    healFormat(): void { formatFailure = undefined },
    holdFormat(): { entered: Promise<void>; release: () => void } {
      const hold = { entered: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>() }
      formatHold = hold
      return { entered: hold.entered.promise, release: () => { hold.release.resolve(undefined) } }
    },
    dropPersistence: () => persistence.dispose(),
    async close(): Promise<void> {
      await host.dispose()
      await agents.disposeAll()
      await ctx.fiber.dispose()
    },
  }
}

/**
 * Await the running recovery pass of one host.
 * @param harness - booted host.
 */
export async function recovered(harness: SessionsHarness): Promise<void> {
  await harness.host.whenRecovered()
}

/**
 * Rewrite the durable delivery records of one pool, the way a crash (a lost `admitted` flag) or old age leaves
 * them on disk.
 * @param pool - media shared by the boots of one scenario.
 * @param edit - replacement for each record.
 */
export function tamperDeliveries(pool: MemoryMediaPool, edit: (stored: StoredDelivery) => StoredDelivery): void {
  const table = pool.media.get('im_sessions')?.tables.get('deliveries')
  if (table === undefined) throw new Error('no delivery records were persisted')
  for (const [id, stored] of table) table.set(id, edit(stored as StoredDelivery))
}

/** Keys of the delivery records one pool holds on disk. */
export function storedDeliveryIds(pool: MemoryMediaPool): string[] {
  return [...(pool.media.get('im_sessions')?.tables.get('deliveries')?.keys() ?? [])]
}

/** Inbox insertions recorded in a session's durable log, in order. */
export async function insertions(harness: SessionsHarness, sessionId: SessionId): Promise<UserMessage[]> {
  const reader = await harness.ctx.sessionPersistence.open(sessionId, 'read')
  try {
    const { events } = await reader.read()
    return events.flatMap(event => (event.type === 'agent/inbox/spliced' ? [...event.data.inserted] : []))
  } finally {
    await reader.close()
  }
}

/** A delivery whose content is one plain text block (already in model-facing form). */
export function delivery(mode: ImDelivery['mode'], text: string, id = text): ImDelivery {
  return { id, mode, content: [{ type: 'text', text }] }
}

/** A delivery whose content is IM messages the host must format itself. */
export function messagesDelivery(mode: ImDelivery['mode'], messages: readonly ImMessage[]): ImDelivery {
  return { id: messages.map(message => message.key).join(','), mode, content: messages }
}
