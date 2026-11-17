/**
 * Bot pipeline tests: `send`, `edit`, `delete`, `render`, `stream` and mode resolution against a local
 * in-memory adapter.
 *
 * The mode is deliberately minimal (`text`/`p`/`br`/`img`/`hr`/`button`): `<hr>` splits into a second platform
 * message, `<img>` becomes a `ResourceRef` that `prepare` resolves, and `button[type=action]` carries an `onClick`.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Http } from '@deepseek-ai/cordis-plugin-http'
import { type ButtonEvent, type Child, type Element, h, toText } from '@deepseek-ai/satori-element'
import {
  Adapter, defineMode, ElementRegistry, type MessageHandle, type Mode, PlatformError,
  PartialSendError, type Prepared, type PrepareContext, type ResolvedResource, type ResourceKind, type ResourceRef,
  Satori, type SendContext, type SendResult, type SentPart, type SerializeContext, Status, type StreamDriver,
  StrictRenderError, type Target,
} from '@deepseek-ai/cordis-plugin-im-core'

// ---- a tiny mode ---------------------------------------------------------------------------------------------------

type TestNode = { text: string } | { media: ResourceRef } | { split: true }

interface TestDraft {
  text: string
  media: ResourceRef[]
}

interface TestPayload {
  text: string
  media: string[]
  quote?: string
  index: number
  count: number
  key?: string
}

interface TestTypes {
  node: TestNode
  draft: TestDraft
  payload: TestPayload
}

const assemble = (nodes: TestNode[]): TestDraft[] => {
  const drafts: TestDraft[] = []
  let current: TestDraft = { text: '', media: [] }
  for (const node of nodes) {
    if ('split' in node) {
      drafts.push(current)
      current = { text: '', media: [] }
    } else if ('text' in node) {
      current.text += node.text
    } else {
      current.media.push(node.media)
    }
  }
  drafts.push(current)
  return drafts.filter(draft => draft.text !== '' || draft.media.length > 0)
}

const serialize = (msg: Prepared<TestDraft>, ctx: SerializeContext): TestPayload => ({
  text: msg.draft.text,
  media: msg.draft.media.map(ref => msg.resolved.get(ref)!.key),
  ...ctx.quote === undefined ? {} : { quote: ctx.quote },
  index: ctx.index,
  count: ctx.count,
  ...ctx.options.idempotencyKey === undefined ? {} : { key: ctx.options.idempotencyKey },
})

function registry(): ElementRegistry<TestTypes, 'text' | 'br' | 'p' | 'img' | 'hr' | 'button'> {
  return new ElementRegistry<TestTypes>()
    .register('text', el => ({ text: el.attrs.content }))
    .register('br', () => ({ text: '\n' }))
    // A paragraph is transparent: its nodes join the surrounding message, media included.
    .register('p', (el, ctx) => ctx.render(el.children))
    .register('img', (el, ctx) => ({
      media: ctx.resource('image', el.attrs.src, ...el.attrs.alt ? [{ name: el.attrs.alt }] : []),
    }))
    // `<hr>` starts a new platform message: the cheapest way to observe multi-part sends.
    .register('hr', () => ({ split: true }))
    .register('button', (el, ctx) => ({ text: `<${ctx.text(el.children)}>` }), {
      variants: ['action', 'link', 'input'],
    })
}

function makeMode(id: string, extra: Partial<Mode<TestTypes>> = {}): Mode<TestTypes> {
  return defineMode<TestTypes>()({
    id,
    elements: registry(),
    limits: {},
    assemble: nodes => assemble(nodes),
    serialize: (msg, ctx) => serialize(msg, ctx),
    ...extra,
  })
}

const plainMode = makeMode('plain')
const otherMode = makeMode('other')
/** One edit per message (`limit.update.count`), so the second `edit` has to replace. */
const limitedMode = makeMode('limited', { limits: { 'limit.update.count': 1 } })
/** QQ-like deletion window: `message.delete` carries its limit in milliseconds. */
const windowedMode = makeMode('windowed', { limits: { 'limit.delete.window': 1_000 } })
/** Registers `<b>`, so content using it is rendered without a degradation — which is what mode resolution ranks. */
const boldMode = makeMode('bold', {
  elements: registry().register('b', (el, ctx) => ({ text: `<b>${ctx.text(el.children)}</b>` })),
})

// ---- the local adapter ----------------------------------------------------------------------------------------------

type OperationKind = 'sendPayload' | 'editPayload' | 'deletePart' | 'upload'

interface Operation {
  op: OperationKind
  payload?: unknown
  ctx?: SendContext
  part?: SentPart
  handle?: MessageHandle
  ref?: ResourceRef
  scope?: string
  target?: Target
}

interface Failure {
  op: OperationKind
  error: unknown
  remaining: number
  match?: (operation: Operation) => boolean
}

interface TestConfig {
  /** Modes this adapter declares; default: the four reference modes. */
  modes?: Record<string, Mode<any>>
  /** Resolution order; default: the declaration order of `modes`. */
  modeOrder?: readonly string[]
  /** Stream driver per mode id (`undefined` ⇒ core `final`). */
  driver?: (mode: string) => StreamDriver | undefined
  /** Whether `sendPayload` retries are deduplicated by the adapter; default `true` in `TestAdapterBase`. */
  idempotentSend?: (target: Target, ctx: SendContext) => boolean
}

class TestAdapterBase extends Adapter<TestConfig, Record<string, Mode<any>>> {
  readonly modes: Record<string, Mode<any>>
  readonly modeOrder: readonly string[]
  /** Successful platform operations, in order. */
  readonly ops: Operation[] = []
  /** Every platform call, including the failed ones (retry counting). */
  readonly attempts: OperationKind[] = []

  private readonly failures: Failure[] = []
  private partSeq = 0

  constructor(ctx: Context, config: TestConfig = {}) {
    super(ctx, config, { id: 'fake:bot', platform: 'fake', adapter: 'fake' })
    this.modes = config.modes ?? {
      plain: plainMode,
      other: otherMode,
      limited: limitedMode,
      windowed: windowedMode,
    }
    this.modeOrder = config.modeOrder ?? Object.keys(this.modes)
  }


  async upload(ref: ResourceRef, scope: string, ctx: PrepareContext): Promise<ResolvedResource> {
    this.attempts.push('upload')
    if (ctx.signal.aborted) throw new Error('upload aborted')
    const operation: Operation = { op: 'upload', ref, scope, target: ctx.target }
    this.maybeFail(operation)
    this.ops.push(operation)
    return { key: `up:${scope}:${ref.kind}:${ref.src}` }
  }

  resourceScope(target: Target, kind: ResourceKind): string {
    void kind
    return target.chat.id
  }

  async sendPayload(payload: unknown, target: Target, ctx: SendContext): Promise<SentPart> {
    this.attempts.push('sendPayload')
    const part: SentPart = { id: `m${++this.partSeq}`, kind: 'message', time: 1_000 }
    const operation: Operation = { op: 'sendPayload', payload, ctx, target, part }
    this.maybeFail(operation)
    this.ops.push(operation)
    return part
  }

  override streamDriver(mode: string): StreamDriver | undefined {
    return this.config.driver?.(mode)
  }

  classify(error: unknown): PlatformError {
    if (PlatformError.is(error)) return error
    return new PlatformError('fatal', error instanceof Error ? error.message : String(error), { cause: error })
  }

  /** Make the next `times` calls of `op` (optionally matching `match`) fail with `error`. */
  fail(op: OperationKind, error: unknown, times = 1, match?: (operation: Operation) => boolean) {
    this.failures.push({ op, error, remaining: times, ...match ? { match } : {} })
  }

  protected maybeFail(operation: Operation) {
    const failure = this.failures.find(candidate => candidate.op === operation.op
      && candidate.remaining > 0
      && (!candidate.match || candidate.match(operation)))
    if (!failure) return
    failure.remaining -= 1
    throw failure.error
  }
}

/** Adds the two optional implementer hooks: a platform that can edit and delete. */
class TestAdapter extends TestAdapterBase {
  override async editPayload(part: SentPart, payload: unknown, handle: MessageHandle): Promise<void> {
    this.attempts.push('editPayload')
    const operation: Operation = { op: 'editPayload', part, payload, handle }
    this.maybeFail(operation)
    this.ops.push(operation)
  }

  override idempotentSend(target: Target, ctx: SendContext): boolean {
    return this.config.idempotentSend?.(target, ctx) ?? true
  }

  override async deletePart(part: SentPart, handle: MessageHandle): Promise<void> {
    this.attempts.push('deletePart')
    const operation: Operation = { op: 'deletePart', part, handle }
    this.maybeFail(operation)
    this.ops.push(operation)
  }
}

type AdapterClass = new (ctx: Context, config: TestConfig) => TestAdapterBase

const target: Target = { chat: { id: 'c1', type: 'group' } }
const message = (...children: Child[]) => h('message', ...children)

const settle = (ms = 5) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function setup(AdapterType: AdapterClass = TestAdapter, config: TestConfig = {}) {
  const ctx = new Context()
  await ctx.plugin(Satori)
  await ctx.plugin(Http)
  const adapter = new AdapterType(ctx, config)
  adapter.selfId = 'bot1'
  const sends: SendResult[] = []
  ctx.on('send', (_bot, result) => { sends.push(result) })
  return { ctx, adapter, bot: adapter, sends }
}

// ---- send -----------------------------------------------------------------------------------------------------------

describe('bot.send', () => {
  it('sends the parts in order with ctx.previous and the quote on the first part only', async () => {
    const { adapter, bot } = await setup()
    const content = message(h('quote', { id: 'q1' }), h('p', 'a'), h('hr'), h('p', 'b'))
    const result = await bot.send(target, content)

    const sends = adapter.ops.filter(op => op.op === 'sendPayload')
    expect(sends.map(op => (op.payload as TestPayload).text)).toEqual(['a', 'b'])
    expect(sends.map(op => (op.payload as TestPayload).index)).toEqual([0, 1])
    expect(sends.map(op => (op.payload as TestPayload).count)).toEqual([2, 2])
    // SerializeContext sees the reply target on every part (the adapter decides which body carries it) …
    expect(sends.map(op => (op.payload as TestPayload).quote)).toEqual(['q1', 'q1'])
    // … SendContext only on the first, where it belongs.
    expect(sends.map(op => op.ctx!.quote)).toEqual(['q1', undefined])
    expect(sends.map(op => op.ctx!.previous.length)).toEqual([0, 1])
    expect(sends[1]!.ctx!.previous[0]!.id).toBe(sends[0]!.part!.id)

    expect(result.handle.parts.map(part => part.id)).toEqual(['m1', 'm2'])
    expect(result.handle.bot).toBe('fake:bot')
    expect(result.handle.mode).toBe('plain')
    expect(result.handle.target).toBe(target)
    expect(result.handle.edits).toBe(0)
    expect(result.handle.createdAt).toBeGreaterThan(0)
    expect(toText(result.handle.content)).toBe('a\n---\nb')
  })

  it('refuses a draft its mode reports over a hard limit before any request, as an unpublished limit error', async () => {
    const strict = makeMode('strict', {
      check: draft => (draft.text.length > 3 ? [{ kind: 'size', limit: 3, actual: draft.text.length, message: 'too long' }] : []),
    })
    const { adapter, bot } = await setup(TestAdapter, { modes: { strict } })
    await expect(bot.send(target, message(h('p', 'abcdef')))).rejects.toMatchObject({
      kind: 'limit', published: 'no', message: expect.stringContaining('too long'),
    })
    expect(adapter.ops.filter(op => op.op === 'sendPayload')).toHaveLength(0)
    await bot.send(target, message(h('p', 'abc')))
    expect(adapter.ops.filter(op => op.op === 'sendPayload')).toHaveLength(1)
  })

  it('emits send once per logical message and registers onClick actions', async () => {
    const { bot, sends } = await setup()
    const clicked: string[] = []
    await bot.send(target, message(h('p', 'go'), h('button', { type: 'action', id: 'b1', onClick: () => { clicked.push('b1') } }, 'ok')))
    expect(sends.length).toBe(1)
    expect(sends[0]!.handle.parts.length).toBe(1)
    expect(bot.callbacks.getButton('b1')).toBeTypeOf('function')
    const event: ButtonEvent = { id: 'b1', referrer: undefined, time: 0, bot, user: { id: 'u1' }, chat: target.chat }
    await expect(bot.callbacks.dispatchButton(event)).resolves.toBe(true)
    expect(clicked).toEqual(['b1'])
  })

  it('retries a retryable failure of sendPayload', async () => {
    const { adapter, bot } = await setup()
    adapter.fail('sendPayload', new PlatformError('retryable', 'flaky', { retryAfterMs: 0 }))
    const result = await bot.send(target, message(h('p', 'hi')))
    expect(adapter.attempts.filter(attempt => attempt === 'sendPayload').length).toBe(2)
    expect(result.handle.parts.length).toBe(1)
  })

  it('gives up after three attempts', async () => {
    const { adapter, bot } = await setup()
    adapter.fail('sendPayload', new PlatformError('retryable', 'still down', { retryAfterMs: 0 }), 5)
    await expect(bot.send(target, message(h('p', 'hi')))).rejects.toMatchObject({ kind: 'retryable' })
    expect(adapter.attempts.filter(attempt => attempt === 'sendPayload').length).toBe(3)
  })

  it('does not retry other error kinds', async () => {
    const { adapter, bot } = await setup()
    adapter.fail('sendPayload', new PlatformError('invalid', 'rejected'), 1)
    await expect(bot.send(target, message(h('p', 'hi')))).rejects.toMatchObject({ kind: 'invalid' })
    expect(adapter.attempts.filter(attempt => attempt === 'sendPayload').length).toBe(1)
  })

  it('stops retrying unknown-outcome sends when the adapter cannot guarantee idempotency, but still retries published: no', async () => {
    const { adapter, bot } = await setup(TestAdapter, { idempotentSend: () => false })
    adapter.fail('sendPayload', new PlatformError('retryable', 'lost', { published: 'unknown', retryAfterMs: 0 }))
    await expect(bot.send(target, message(h('p', 'hi')))).rejects.toMatchObject({ kind: 'retryable', published: 'unknown' })
    expect(adapter.attempts.filter(attempt => attempt === 'sendPayload').length).toBe(1)

    adapter.fail('sendPayload', new PlatformError('retryable', 'not sent', { published: 'no', retryAfterMs: 0 }))
    const result = await bot.send(target, message(h('p', 'hi')))
    expect(result.handle.parts.length).toBe(1)
    expect(adapter.attempts.filter(attempt => attempt === 'sendPayload').length).toBe(3)
  })

  it('preserves published:unknown when an earlier idempotent attempt was uncertain and a later attempt fails with published:no', async () => {
    const { adapter, bot } = await setup(TestAdapter, { idempotentSend: () => true })
    adapter.fail('sendPayload', new PlatformError('retryable', 'lost response', { published: 'unknown', retryAfterMs: 0 }), 1)
    adapter.fail('sendPayload', new PlatformError('permission', 'rejected later', { published: 'no' }), 1)
    await expect(bot.send(target, message(h('p', 'hi')))).rejects.toMatchObject({
      kind: 'permission',
      published: 'unknown',
    })
    expect(adapter.attempts.filter(attempt => attempt === 'sendPayload').length).toBe(2)
  })

  it('re-evaluates idempotentSend before retrying so an expired deduplication window stops the retry', async () => {
    let windowOpen = true
    const { adapter, bot } = await setup(TestAdapter, { idempotentSend: () => windowOpen })
    adapter.fail('sendPayload', new PlatformError('retryable', 'lost response', { published: 'unknown', retryAfterMs: 0 }), 1)
    const originalSend = adapter.sendPayload.bind(adapter)
    adapter.sendPayload = async (payload, t, ctx) => {
      try {
        return await originalSend(payload, t, ctx)
      } finally {
        windowOpen = false
      }
    }
    await expect(bot.send(target, message(h('p', 'hi')))).rejects.toMatchObject({
      kind: 'retryable',
      published: 'unknown',
    })
    expect(adapter.attempts.filter(attempt => attempt === 'sendPayload').length).toBe(1)
  })

  it('aborts retry after backoff sleep if the deduplication window expires during sleep', async () => {
    let windowOpen = true
    const { adapter, bot } = await setup(TestAdapter, { idempotentSend: () => windowOpen })
    adapter.fail('sendPayload', new PlatformError('retryable', 'lost response', { published: 'unknown', retryAfterMs: 20 }), 1)
    setTimeout(() => { windowOpen = false }, 5)
    await expect(bot.send(target, message(h('p', 'hi')))).rejects.toMatchObject({
      kind: 'retryable',
      published: 'unknown',
    })
    expect(adapter.attempts.filter(attempt => attempt === 'sendPayload').length).toBe(1)
  })

  it('requires idempotentSend after an earlier unknown outcome even when a subsequent attempt fails with published:no', async () => {
    let windowOpen = true
    const { adapter, bot } = await setup(TestAdapter, { idempotentSend: () => windowOpen })
    adapter.fail('sendPayload', new PlatformError('retryable', 'lost response', { published: 'unknown', retryAfterMs: 0 }), 1)
    adapter.fail('sendPayload', new PlatformError('retryable', 'token fetch failed', { published: 'no', retryAfterMs: 20 }), 1)
    setTimeout(() => { windowOpen = false }, 5)
    await expect(bot.send(target, message(h('p', 'hi')))).rejects.toMatchObject({
      kind: 'retryable',
      published: 'unknown',
    })
    expect(adapter.attempts.filter(attempt => attempt === 'sendPayload').length).toBe(2)
  })

  it('rejects with PartialSendError when a later part fails', async () => {
    const { adapter, bot } = await setup()
    adapter.fail('sendPayload', new PlatformError('invalid', 'second part rejected'), 1,
      operation => (operation.payload as TestPayload).text === 'b')
    const content = message(h('p', 'a'), h('hr'), h('p', 'b'), h('hr'), h('p', 'c'))
    const error = await bot.send(target, content).then(() => undefined, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(PartialSendError)
    const partial = error as PartialSendError
    expect(partial.handle.parts.length).toBe(1)
    expect((partial.cause as PlatformError).kind).toBe('invalid')
    expect(partial.report).toBeDefined()
    // Only the published part is recorded; the third part was never attempted.
    expect(adapter.ops.filter(op => op.op === 'sendPayload').length).toBe(1)
  })

  it('uploads media once and reuses the cache for the next send', async () => {
    const { adapter, bot } = await setup()
    const content = message(h('img', { src: 'https://a.test/1.png' }))
    const first = await bot.send(target, content)
    const second = await bot.send(target, content)
    expect(adapter.ops.filter(op => op.op === 'upload').length).toBe(1)
    const keys = adapter.ops.filter(op => op.op === 'sendPayload').map(op => (op.payload as TestPayload).media[0])
    expect(keys).toEqual(['up:c1:image:https://a.test/1.png', 'up:c1:image:https://a.test/1.png'])
    expect((first.handle.parts[0]!.id)).not.toBe(second.handle.parts[0]!.id)
  })

  it('uploads a file: source again for every send, because the bytes behind the path may change', async () => {
    const { adapter, bot } = await setup()
    const content = message(h('img', { src: 'file:///work/1.png' }))
    await bot.send(target, content)
    await bot.send(target, content)
    expect(adapter.ops.filter(op => op.op === 'upload').length).toBe(2)
  })

  it('reports a failure of the prepare stage as unpublished, because no request was made', async () => {
    const { adapter, bot } = await setup()
    // The upload is part of the pipeline, before the first `sendPayload`: the platform published nothing.
    adapter.fail('upload', new Error('the upload was refused'))
    await expect(bot.send(target, message(h('img', { src: 'https://a.test/1.png' }))))
      .rejects.toMatchObject({ published: 'no', message: expect.stringContaining('the upload was refused') })
    expect(adapter.ops.filter(op => op.op === 'sendPayload')).toHaveLength(0)
  })

  it('rejects content that renders nothing', async () => {
    const { bot } = await setup()
    await expect(bot.send(target, message())).rejects.toMatchObject({ kind: 'invalid' })
  })
})

// ---- mode resolution ------------------------------------------------------------------------------------------------

/** A directive element: outside the v4 vocabulary by design, so it is built as a bare node. */
function directive(name = 'prefer-streamable-mode', value = 'true'): Element {
  return h('meta' as never, { name, value } as never)
}
describe('mode resolution', () => {
  const modes = { plain: plainMode, bold: boldMode }

  it('picks the mode that degrades the content least', async () => {
    const { bot } = await setup(TestAdapter, { modes, modeOrder: ['plain', 'bold'] })
    expect((await bot.send(target, message(h('p', h('b', 'hi'))))).handle.mode).toBe('bold')
    // A degradation-free message keeps the adapter's first preference.
    expect((await bot.send(target, message(h('p', 'hi')))).handle.mode).toBe('plain')
  })

  it('breaks a tie with the adapter order', async () => {
    const { bot } = await setup(TestAdapter, { modes, modeOrder: ['bold', 'plain'] })
    expect((await bot.send(target, message(h('p', 'hi')))).handle.mode).toBe('bold')
  })

  it('narrows to the streamable modes for the directive, and a stream implies it', async () => {
    const log: string[] = []
    const driver = (mode: string) => mode === 'bold' ? editDriver(log) : undefined
    const { bot } = await setup(TestAdapter, { modes, modeOrder: ['plain', 'bold'], driver })
    const directed = await bot.send(target, message(directive(), h('p', 'hi')))
    expect(directed.handle.mode).toBe('bold')
    expect((await bot.send(target, message(h('p', 'hi')))).handle.mode).toBe('plain')

    const stream = bot.stream(target, { firstDelayMs: 0 })
    stream.update(message(h('p', 'first')))
    stream.update(message(h('p', 'second')))
    expect(stream.strategy).toBe('edit')
    await settle()
    // Every state is rendered in the mode the stream opened with, never in one a later state would prefer.
    expect(stream.handle?.mode).toBe('bold')
    await stream.close()
  })

  it('opens a stream in the broadest streamable mode, not the first streamable one', async () => {
    const log: string[] = []
    const driver = () => editDriver(log)
    const { bot } = await setup(TestAdapter, { modes, modeOrder: ['plain', 'bold'], driver })
    const stream = bot.stream(target, { firstDelayMs: 0 })
    stream.update(message(h('p', 'hi')))
    await settle()
    // Both modes stream here. A stream cannot change its mode after the first state, so opening in the cheapest one
    // would render a later `<b>` state without it; `plain` is declared first and would otherwise win.
    expect(stream.handle?.mode).toBe('bold')
    await stream.close()
  })

  it('picks the broadest mode for <meta name="prefer-expressive-mode">', async () => {
    const { bot } = await setup(TestAdapter, { modes, modeOrder: ['plain', 'bold'] })
    // `bold` registers `<b>` on top of the same registry, so it supports one element key more.
    expect((await bot.send(target, message(h('p', 'hi')))).handle.mode).toBe('plain')
    expect((await bot.send(target, message(directive('prefer-expressive-mode'), h('p', 'hi')))).handle.mode).toBe('bold')
  })

  it('keeps a published message in its own mode and refuses a mode change', async () => {
    const driver = (mode: string) => mode === 'bold' ? editDriver([]) : undefined
    const { bot } = await setup(TestAdapter, { modes, modeOrder: ['plain', 'bold'], driver })
    const sent = await bot.send(target, message(h('p', 'one')))
    expect(sent.handle.mode).toBe('plain')
    await expect(bot.edit(sent.handle, message(directive(), h('p', 'two')))).rejects.toMatchObject({
      name: 'PlatformError',
      kind: 'invalid',
    })
    // The expressive directive is refused the same way: `bold` supports more elements than the message's mode.
    await expect(bot.edit(sent.handle, message(directive('prefer-expressive-mode'), h('p', 'three'))))
      .rejects.toMatchObject({ name: 'PlatformError', kind: 'invalid' })
    // Without the directive the same content is edited in the message's own mode.
    await expect(bot.edit(sent.handle, message(h('p', 'two')))).resolves.toMatchObject({ handle: sent.handle })
  })
})

// ---- render ---------------------------------------------------------------------------------------------------------

describe('bot.render', () => {
  it('produces exactly the payloads send publishes, without uploading or emitting', async () => {
    const { adapter, bot, sends } = await setup()
    const content = message(h('p', 'hello'), h('hr'), h('p', 'world'))
    const rendered = await bot.render(target, content)
    expect(adapter.ops.length).toBe(0)
    expect(sends.length).toBe(0)
    expect(rendered.report.degraded).toEqual([])

    await bot.send(target, content)
    expect(adapter.ops.filter(op => op.op === 'sendPayload').map(op => op.payload)).toEqual(rendered.payloads)
    expect(sends.length).toBe(1)
  })

  it('resolves media to dry-run keys and never uploads', async () => {
    const { adapter, bot } = await setup()
    const rendered = await bot.render(target, message(h('img', { src: 'https://a.test/1.png' })))
    expect((rendered.payloads[0] as TestPayload).media).toEqual(['dryrun:image:https://a.test/1.png'])
    expect(adapter.ops.length).toBe(0)
  })

  it('rejects degraded content with strict, but reports it otherwise', async () => {
    const { bot } = await setup()
    const content = message(h('ul', h('li', 'x')))
    const loose = await bot.render(target, content)
    expect(loose.report.degraded.map(entry => entry.tag)).toEqual(['ul'])
    await expect(bot.render(target, content, { strict: true })).rejects.toBeInstanceOf(StrictRenderError)
    await expect(bot.send(target, content, { strict: true })).rejects.toBeInstanceOf(StrictRenderError)
  })
})

// ---- edit -----------------------------------------------------------------------------------------------------------

describe('bot.edit', () => {
  it('edits in place when mode and part count allow it', async () => {
    const { adapter, bot, sends } = await setup()
    const sent = await bot.send(target, message(h('p', 'one')))
    const edited = await bot.edit(sent.handle, message(h('p', 'two')))

    expect(adapter.ops.filter(op => op.op === 'editPayload').map(op => (op.payload as TestPayload).text)).toEqual(['two'])
    expect(adapter.ops.filter(op => op.op === 'sendPayload').length).toBe(1)
    expect(adapter.ops.filter(op => op.op === 'deletePart').length).toBe(0)
    expect(edited.handle).toBe(sent.handle)
    expect(sent.handle.edits).toBe(1)
    expect(toText(sent.handle.content)).toBe('two')
    expect(sends.length).toBe(2)
    // The edited part is the one that was published, not a new message.
    expect(adapter.ops.find(op => op.op === 'editPayload')!.part!.id).toBe(sent.handle.parts[0]!.id)
  })

  it('edits every part of a multi-part message', async () => {
    const { adapter, bot } = await setup()
    const sent = await bot.send(target, message(h('p', 'a'), h('hr'), h('p', 'b')))
    await bot.edit(sent.handle, message(h('p', 'a2'), h('hr'), h('p', 'b2')))
    expect(adapter.ops.filter(op => op.op === 'editPayload').map(op => (op.payload as TestPayload).text)).toEqual(['a2', 'b2'])
    expect(sent.handle.edits).toBe(2)
  })

  it('replaces when the edit budget is exhausted', async () => {
    const { adapter, bot } = await setup(TestAdapter, { modeOrder: ['limited'] })
    const sent = await bot.send(target, message(h('p', 'one')))
    expect(sent.handle.mode).toBe('limited')
    const first = await bot.edit(sent.handle, message(h('p', 'two')))
    expect(first.handle).toBe(sent.handle)
    expect(adapter.ops.filter(op => op.op === 'editPayload').length).toBe(1)

    const replaced = await bot.edit(sent.handle, message(h('p', 'three')))
    expect(replaced.handle).not.toBe(sent.handle)
    expect(adapter.ops.filter(op => op.op === 'deletePart').length).toBe(1)
    expect(adapter.ops.filter(op => op.op === 'sendPayload').map(op => (op.payload as TestPayload).text)).toEqual(['one', 'three'])
    expect(replaced.handle.edits).toBe(0)
  })

  it('replaces on request', async () => {
    const { adapter, bot } = await setup()
    const sent = await bot.send(target, message(h('p', 'one')))
    const replaced = await bot.edit(sent.handle, message(h('p', 'two')), { strategy: 'replace' })
    expect(replaced.handle).not.toBe(sent.handle)
    expect(adapter.ops.filter(op => op.op === 'editPayload').length).toBe(0)
    expect(adapter.ops.filter(op => op.op === 'deletePart').length).toBe(1)
  })

  it('replaces when the new content needs another number of parts', async () => {
    const { adapter, bot } = await setup()
    const sent = await bot.send(target, message(h('p', 'a'), h('hr'), h('p', 'b')))
    const replaced = await bot.edit(sent.handle, message(h('p', 'one')))
    expect(replaced.handle.parts.length).toBe(1)
    expect(adapter.ops.filter(op => op.op === 'deletePart').length).toBe(2)
    expect(adapter.ops.filter(op => op.op === 'editPayload').length).toBe(0)
    expect(adapter.ops.filter(op => op.op === 'sendPayload').length).toBe(3)
  })

  it('rejects an explicit in-place edit that is impossible', async () => {
    const { bot } = await setup(TestAdapterBase)
    const sent = await bot.send(target, message(h('p', 'one')))
    await expect(bot.edit(sent.handle, message(h('p', 'two')), { strategy: 'in-place' })).rejects.toMatchObject({
      name: 'PlatformError',
      kind: 'invalid',
    })
    // Without edit and without delete there is nothing `auto` could do either.
    await expect(bot.edit(sent.handle, message(h('p', 'two')))).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('retries a retryable edit failure', async () => {
    const { adapter, bot } = await setup()
    const sent = await bot.send(target, message(h('p', 'one')))
    adapter.fail('editPayload', new PlatformError('rate-limit', 'slow down', { retryAfterMs: 0 }))
    await bot.edit(sent.handle, message(h('p', 'two')))
    expect(adapter.attempts.filter(attempt => attempt === 'editPayload').length).toBe(2)
  })
})

// ---- delete ---------------------------------------------------------------------------------------------------------

describe('bot.delete', () => {
  it('deletes every part of a handle', async () => {
    const { adapter, bot } = await setup()
    const sent = await bot.send(target, message(h('p', 'a'), h('hr'), h('p', 'b')))
    await bot.delete(sent.handle)
    expect(adapter.ops.filter(op => op.op === 'deletePart').map(op => op.part!.id)).toEqual(sent.handle.parts.map(part => part.id))
  })

  it('deletes a bare MessageRef through one synthetic part', async () => {
    const { adapter, bot } = await setup()
    await bot.delete({ id: 'x1', chat: target.chat })
    const deletes = adapter.ops.filter(op => op.op === 'deletePart')
    expect(deletes.length).toBe(1)
    expect(deletes[0]!.part!.id).toBe('x1')
    expect(deletes[0]!.handle!.mode).toBe('plain')
  })

  it('is a logged no-op when the adapter cannot delete', async () => {
    const { adapter, bot } = await setup(TestAdapterBase)
    await expect(bot.delete({ id: 'x1', chat: target.chat })).resolves.toBeUndefined()
    expect(adapter.ops.length).toBe(0)
  })

  it('honours the deletion window of the mode', async () => {
    const { adapter, bot } = await setup(TestAdapter, { modeOrder: ['windowed'] })
    const sent = await bot.send(target, message(h('p', 'x')))
    expect(sent.handle.mode).toBe('windowed')
    await bot.delete(sent.handle)
    expect(adapter.ops.filter(op => op.op === 'deletePart').length).toBe(1)

    const stale: MessageHandle = { ...sent.handle, createdAt: Date.now() - 5_000 }
    await bot.delete(stale)
    expect(adapter.ops.filter(op => op.op === 'deletePart').length).toBe(1)
  })
})

// ---- stream ---------------------------------------------------------------------------------------------------------

function editDriver(log: string[]): StreamDriver<any> {
  return {
    strategy: 'edit',
    async open(_first, payload, ctx) {
      log.push(`open:${(payload as TestPayload).text}`)
      return {
        bot: 'fake:bot',
        target: ctx.target,
        mode: ctx.mode,
        parts: [{ id: 'stream1', kind: 'message', time: 1 }],
        createdAt: 1,
        edits: 0,
        content: ctx.content,
      }
    },
    async tick(_handle, change) {
      log.push(`tick:${(change.payload as TestPayload).text}`)
    },
    async close(_handle, last) {
      log.push(`close:${(last.payload as TestPayload).text}`)
    },
    budget: () => ({}),
  }
}

describe('bot.stream', () => {
  it('uses the final strategy without a driver and announces the result once', async () => {
    const { adapter, bot, sends } = await setup()
    const stream = bot.stream(target)
    expect(stream.strategy).toBe('final')
    stream.update(message(h('p', 'a')))
    stream.update(message(h('p', 'b')))
    const result = await stream.close()
    expect(stream.state).toBe('closed')
    expect(result.handle.parts.length).toBe(1)
    expect(adapter.ops.filter(op => op.op === 'sendPayload').map(op => (op.payload as TestPayload).text)).toEqual(['b'])
    // `host.send` already emitted; the stream must not announce the same handle twice.
    expect(sends.length).toBe(1)
    expect(sends[0]!.handle).toBe(result.handle)
  })

  it('delegates to the adapter stream driver', async () => {
    const log: string[] = []
    const { bot, sends } = await setup(TestAdapter, { driver: () => editDriver(log) })
    const stream = bot.stream(target, { firstDelayMs: 0 })
    expect(stream.strategy).toBe('edit')
    stream.update(message(h('p', 'hello')))
    await settle()
    expect(stream.handle).toBeDefined()
    expect(stream.handle!.parts[0]!.id).toBe('stream1')
    const result = await stream.close(message(h('p', 'hello world')))
    expect(result.handle).toBe(stream.handle)
    expect(log).toEqual(['open:hello', 'close:hello world'])
    expect(sends.length).toBe(1)
    expect(sends[0]!.handle.parts[0]!.id).toBe('stream1')
  })

  it('aborts with recall through the driver handle', async () => {
    const log: string[] = []
    const { adapter, bot } = await setup(TestAdapter, { driver: () => editDriver(log) })
    const stream = bot.stream(target, { firstDelayMs: 0 })
    stream.update(message(h('p', 'hello')))
    await settle()
    await stream.abort({ recall: true, reason: 'cancelled' })
    expect(adapter.ops.filter(op => op.op === 'deletePart').map(op => op.part!.id)).toEqual(['stream1'])
    await expect(stream.done).rejects.toMatchObject({ name: 'AbortError' })
  })
})

// ---- status without the registry ------------------------------------------------------------------------------------

describe('bot status', () => {
  it('announces login-updated while the bots registry is readable', async () => {
    const { ctx, bot } = await setup()
    const events: Status[] = []
    ctx.on('login-updated', session => { events.push(session.event.login!.status) })
    bot.online()
    bot.offline()
    expect(events).toEqual([Status.ONLINE, Status.OFFLINE])
  })

  it('goes offline without throwing when the context can no longer read the bots registry', async () => {
    // A mounted adapter lives in its own plugin fiber (exactly like `ctx.plugin(LarkBot, config)`) which injects
    // `satori`, and `bots` is a mixin of that service. Once the service is torn down — a failed boot — the mixin is
    // gone and reading `ctx.bots` in the bot's own fiber throws `cannot get property "bots" without inject`, burying
    // the real startup error; going offline must survive that.
    const ctx = new Context()
    const satori = await ctx.plugin(Satori)
    let adapter!: TestAdapter
    const host = ctx.plugin({ inject: ['satori'], apply(context: Context) { adapter = new TestAdapter(context, {}) } })
    await host
    adapter.online()
    await satori.dispose()
    expect(() => adapter.ctx.bots).toThrow(/cannot get property "bots" without inject/)

    const failure = new Error('startup failed')
    expect(() => adapter.offline(failure)).not.toThrow()
    expect(adapter.status).toBe(Status.OFFLINE)
    expect(adapter.error).toBe(failure)
  })
})
