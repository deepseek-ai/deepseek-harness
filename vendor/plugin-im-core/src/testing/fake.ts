/**
 * `FakeAdapter`: an in-memory platform implementing the whole `Adapter` contract, so core and dsh-im tests can drive
 * the real pipeline (`bot.send`, `bot.edit`, `bot.stream`, `bot.render`, `prepare`) without a network.
 *
 * What it records: every platform operation in {@link FakeAdapter.operations} — `send`, `edit`, `delete`, `upload`,
 * `stream.open|tick|close` — with the payload, the target and the `SendContext` fields a dependency chain needs
 * (`index`, `quote`, `previous`).
 *
 * What it simulates: `editPayload`/`deletePart` are installed only when the config allows them (absent ⇒ the adapter
 * cannot edit or delete), uploads can be disabled, failures are scripted per operation (`failNext`), and
 * `streamDriver()` returns a driver for every stream strategy (`patch` / `edit` / `append`) built on the mode's
 * payloads.
 *
 * Mount it like any adapter: `await ctx.plugin(Satori)` then `await ctx.plugin(FakeAdapter, config)` (or
 * {@link mountFakeAdapter}); `bot.send` and friends are core code, so a fake test exercises the real pipeline.
 */

import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { Adapter, type MessageHandle, type SendContext, type SentPart } from '../bot.ts'
import { PlatformError, StreamLimitError } from '../errors.ts'
import { Satori } from '../index.ts'
import type { Mode } from '../mode.ts'
import type { Target } from '../protocol.ts'
import type { PrepareContext, ResolvedResource, ResourceKind, ResourceRef } from '../resource.ts'
import { createEditDriver, type EditDriverAdapter, type StreamDriver, type StreamTickContext } from '../stream.ts'

export interface FakeAdapterConfig {
  /** Default `fake:bot`. */
  id?: string
  /** Default `fake`. */
  platform?: string
  selfId?: string
  modes: Record<string, Mode<any>>
  /** Candidate order of the content-based mode resolution; default: the declaration order of `modes`. */
  modeOrder?: readonly string[]
  /** Install `editPayload` / `deletePart` (absent ⇒ the adapter cannot edit or delete). Default true. */
  edit?: boolean
  delete?: boolean
  /** Stream driver strategy per mode id; absent ⇒ core `final`. */
  stream?: Partial<Record<string, 'patch' | 'edit' | 'append'>>
  /** Edits one streamed message accepts (`limit.update.count`); `undefined` ⇒ unbounded. */
  streamLimit?: number
  /** Simulate a platform without upload (`upload.image` / `upload.file` = none). Default true. */
  upload?: boolean
  /** Clock used for `SentPart.time` and operation records; default `Date.now`. */
  now?: () => number
  /** Payload → text; the `append` driver needs it for the prefix check. Default: the payload itself when it is a string, else its JSON. */
  text?: (payload: unknown) => string
  /** Error taxonomy mapping; default: `PlatformError` passes through, anything else becomes `retryable`. */
  classify?: (error: unknown) => PlatformError
  /** Resource scope; default: the chat id (`target.chat.id`). */
  scope?: string | ((target: Target, kind: ResourceKind) => string)
}

export type FakeOperationKind = 'send' | 'edit' | 'delete' | 'upload' | 'stream.open' | 'stream.tick' | 'stream.close'

/** One recorded platform operation. */
export interface FakeOperation {
  op: FakeOperationKind
  target?: Target
  payload?: unknown
  part?: SentPart
  ref?: ResourceRef
  time: number
  /** `send`: part index of the logical message. */
  index?: number
  /** `send`: reply target the adapter was given (first part only by convention). */
  quote?: string
  /** `send`: parts published before this one. */
  previous?: readonly SentPart[]
  /** `upload`: the cache scope. */
  scope?: string
  /** `stream.*`: the mode whose driver ran, and the patches the scheduler computed. */
  mode?: string
  patches?: unknown
  /** `stream.*`: the append driver's computed suffix (`{ append }`). */
  patch?: unknown
  /** The scripted error of a failed operation. */
  error?: unknown
}

interface ScriptedFailure {
  op: FakeOperationKind
  error: unknown
  times: number
  when?: (operation: FakeOperation) => boolean
}

/** What `failNext` keeps failing (one operation unless `times` says otherwise). */
export interface FakeFailureOptions {
  /** How many matching operations fail; default `1`. */
  times?: number
  /** Only fail operations matching this predicate (e.g. part index 1 of a multi-part send). */
  when?: (operation: FakeOperation) => boolean
}

/** In-memory platform: records payloads, simulates edits/deletes/errors/stream drivers. */
export class FakeAdapter extends Adapter<FakeAdapterConfig, Record<string, Mode<any>>> {
  readonly modes: Record<string, Mode<any>>
  readonly modeOrder: readonly string[]
  /** Every platform operation, in order (failed ones carry `error`). */
  readonly operations: FakeOperation[] = []

  private readonly failures: ScriptedFailure[] = []
  private readonly clock: () => number
  private sequence = 0

  constructor(ctx: Context, config: FakeAdapterConfig) {
    super(ctx, config, { id: config.id ?? 'fake:bot', platform: config.platform ?? 'fake', adapter: 'fake' })
    this.modes = config.modes
    this.modeOrder = config.modeOrder ?? Object.keys(config.modes)
    this.clock = config.now ?? Date.now
    if (config.selfId) this.selfId = config.selfId
    if (config.edit !== false) this.editPayload = async (part, payload, handle) => {
      this.fail('edit', { part, payload, target: handle.target, mode: handle.mode })
      this.operations.push({ op: 'edit', part, payload, target: handle.target, mode: handle.mode, time: this.now() })
    }
    if (config.delete !== false) this.deletePart = async (part, handle) => {
      this.fail('delete', { part, target: handle.target, mode: handle.mode })
      this.operations.push({ op: 'delete', part, target: handle.target, mode: handle.mode, time: this.now() })
    }
  }

  /** The adapter's clock. */
  now(): number {
    return this.clock()
  }

  /** Make platform operations fail with `error`, run through `classify()` first. */
  failNext(op: FakeOperationKind, error: unknown, options: FakeFailureOptions = {}): void {
    this.failures.push({ op, error, times: options.times ?? 1, when: options.when })
  }

  /** Forget recorded operations and scripted failures (keeps counters and installed hooks). */
  reset(): void {
    this.operations.length = 0
    this.failures.length = 0
  }

  /** Recorded operations of a kind, in order. */
  calls(op: FakeOperationKind): FakeOperation[] {
    return this.operations.filter(operation => operation.op === op)
  }

  /** The payloads of every successful `send`, in order. */
  sentPayloads(): unknown[] {
    return this.calls('send').filter(operation => !operation.error).map(operation => operation.payload)
  }

  /** The last recorded operation of a kind. */
  last(op: FakeOperationKind): FakeOperation | undefined {
    const calls = this.calls(op)
    return calls[calls.length - 1]
  }

  /** Text projection of a payload, used by the `append` driver and by tests. */
  payloadText(payload: unknown): string {
    if (this.config.text) return this.config.text(payload)
    if (typeof payload === 'string') return payload
    if (payload && typeof payload === 'object') {
      const text = (payload as { text?: unknown }).text
      if (typeof text === 'string') return text
    }
    return JSON.stringify(payload) ?? ''
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Adapter contract


  resourceScope(target: Target, kind: ResourceKind): string {
    const { scope } = this.config
    if (typeof scope === 'function') return scope(target, kind)
    return scope ?? target.chat.id
  }

  async upload(ref: ResourceRef, scope: string, ctx: PrepareContext): Promise<ResolvedResource> {
    if (ctx.signal.aborted) throw ctx.signal.reason
    const detail: Partial<FakeOperation> = { ref, scope, target: ctx.target }
    if (this.config.upload === false) {
      throw this.classify(new PlatformError('permission', `upload of ${ref.kind} is not permitted here`, { published: 'no' }))
    }
    this.fail('upload', detail)
    this.operations.push({ ...detail, op: 'upload', time: this.now() })
    const digest = createHash('sha256').update(ref.src).digest('hex').slice(0, 12)
    return { key: `fake:${scope}:${ref.kind}:${digest}`, extra: { name: ref.meta.name ?? null } }
  }

  async sendPayload(payload: unknown, target: Target, ctx: SendContext): Promise<SentPart> {
    const detail: Partial<FakeOperation> = {
      target,
      payload,
      index: ctx.index,
      previous: [...ctx.previous],
      ...ctx.quote === undefined ? {} : { quote: ctx.quote },
    }
    this.fail('send', detail)
    const part: SentPart = { id: `fake-msg-${++this.sequence}`, kind: 'fake', time: this.now(), raw: { payload } }
    this.operations.push({ ...detail, op: 'send', part, time: this.now() })
    return part
  }

  /**
   * A stream driver for the modes named in `config.stream`, wrapped so that every driver call is recorded as
   * `stream.open` / `stream.tick` / `stream.close` (and can be made to fail with `failNext`).
   * `patch` and `edit` both edit the whole message (the fake stores payloads verbatim); `append` enforces the
   * append-only prefix rule and throws `StreamLimitError('shape')` otherwise.
   */
  streamDriver(mode: string, target: Target): StreamDriver<any> | undefined {
    const self = this
    const strategy = this.config.stream?.[mode]
    if (!strategy) return undefined
    const base = strategy === 'append' ? this.appendDriver(mode) : this.editDriver(strategy)
    return {
      strategy: base.strategy,
      async open(first, payload, ctx) {
        self.fail('stream.open', { target: ctx.target, payload, mode })
        self.operations.push({ op: 'stream.open', target: ctx.target, payload, mode, time: self.now() })
        return base.open(first, payload, ctx)
      },
      async tick(handle, change, ctx) {
        self.fail('stream.tick', { target: ctx.target, payload: change.payload, mode, patches: change.patches })
        self.operations.push({
          op: 'stream.tick', target: ctx.target, payload: change.payload, mode, patches: change.patches, time: self.now(),
        })
        await base.tick(handle, change, ctx)
      },
      async close(handle, last, ctx) {
        self.fail('stream.close', { target: ctx.target, payload: last.payload, mode })
        self.operations.push({ op: 'stream.close', target: ctx.target, payload: last.payload, mode, time: self.now() })
        await base.close(handle, last, ctx)
      },
      budget: handle => base.budget(handle),
    }
  }

  classify(error: unknown): PlatformError {
    if (this.config.classify) return this.config.classify(error)
    if (PlatformError.is(error)) return error
    // A plain error simulates a transport hiccup: the interesting retry path of `bot.send` and the stream scheduler.
    return new PlatformError('retryable', error instanceof Error ? error.message : String(error), { cause: error })
  }

  override async connect(): Promise<void> {
    this.online()
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Drivers

  /** Whole-message driver (`patch` / `edit`): generic edit driver, so the fake exercises real driver code. */
  private editDriver(strategy: 'patch' | 'edit'): StreamDriver<any> {
    const adapter: EditDriverAdapter = {
      id: this.id,
      sendPayload: (payload, target, ctx) => this.sendPayload(payload, target, ctx),
      editPayload: async (part, payload, handle) => {
        if (typeof this.editPayload !== 'function') {
          throw new PlatformError('invalid', 'the fake adapter has no editPayload hook (config.edit === false)')
        }
        await this.editPayload(part, payload, handle)
      },
    }
    const driver = createEditDriver<any>(adapter, {
      ...this.config.streamLimit === undefined ? {} : { limit: this.config.streamLimit },
      state: () => ({ strategy }),
      now: () => this.now(),
    })
    return strategy === 'edit' ? driver : { ...driver, strategy }
  }

  /** Append-only driver (QQ C2C `stream_messages`): every tick appends the new suffix of the payload text. */
  private appendDriver(mode: string): StreamDriver<any> {
    const self = this
    const published = new WeakMap<MessageHandle, string>()
    const edit = async (handle: MessageHandle, payload: unknown) => {
      const part = handle.parts[0]
      if (!part) throw new PlatformError('invalid', 'append stream: handle has no part')
      if (typeof self.editPayload !== 'function') {
        throw new PlatformError('invalid', `append stream: mode "${mode}" has no editPayload hook`)
      }
      const next = self.payloadText(payload)
      const previous = published.get(handle) ?? ''
      if (!next.startsWith(previous)) {
        throw new StreamLimitError({
          kind: 'shape',
          message: 'append stream: the state is not a prefix extension of the published one',
        }, handle)
      }
      const suffix = next.slice(previous.length)
      handle.edits += 1
      await self.editPayload(part, { append: suffix }, handle)
      published.set(handle, next)
    }
    return {
      strategy: 'append',
      async open(_first, payload, ctx) {
        const part = await self.sendPayload(payload, ctx.target, {
          index: 0,
          options: ctx.options,
          previous: [],
          ...ctx.quote === undefined ? {} : { quote: ctx.quote },
        })
        const handle: MessageHandle = {
          bot: self.id,
          target: ctx.target,
          mode: ctx.mode,
          parts: [part],
          createdAt: self.now(),
          edits: 0,
          content: ctx.content,
          state: { strategy: 'append' },
        }
        published.set(handle, self.payloadText(payload))
        return handle
      },
      tick(handle, change) {
        return edit(handle, change.payload)
      },
      async close(handle, last) {
        if (self.payloadText(last.payload) === published.get(handle)) return
        await edit(handle, last.payload)
      },
      budget(handle) {
        const limit = self.config.streamLimit
        if (limit === undefined) return {}
        return { updatesLeft: Math.max(0, limit - handle.edits) }
      },
    }
  }

  /** Throw the scripted error of an operation, if one matches (and record the failure). */
  private fail(op: FakeOperationKind, detail: Partial<FakeOperation>): void {
    const probe: FakeOperation = { ...detail, op, time: this.now() }
    const index = this.failures.findIndex(failure => failure.op === op && failure.times > 0 && (!failure.when || failure.when(probe)))
    if (index < 0) return
    const failure = this.failures[index]!
    if (--failure.times <= 0) this.failures.splice(index, 1)
    this.operations.push({ ...probe, error: failure.error })
    throw this.classify(failure.error)
  }
}

export interface MountedFakeAdapter {
  ctx: Context
  bot: FakeAdapter
}

/**
 * Mount a `FakeAdapter` on a fresh context with the `satori` service: the shortest path to a bot whose
 * `send`/`edit`/`render`/`stream` are the real core implementation.
 *
 * The caller owns the context and should dispose it (`await ctx.fiber.dispose()`).
 */
export async function mountFakeAdapter(config: FakeAdapterConfig): Promise<MountedFakeAdapter> {
  const ctx = new Context()
  await ctx.plugin(Satori)
  await ctx.plugin(FakeAdapter, config)
  const bot = ctx.bots.find(candidate => candidate instanceof FakeAdapter) as FakeAdapter | undefined
  if (!bot) throw new Error('mountFakeAdapter: the adapter did not register itself')
  return { ctx, bot }
}
