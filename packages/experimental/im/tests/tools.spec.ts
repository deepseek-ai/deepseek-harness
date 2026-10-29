/**
 * `im_*` tools: registration (incl. `readOnly`), the prompt section, read/history/media behaviour, the publishing
 * tools' inputs (operation id, quote, thread), declared `ImError` results and the bounded render text.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createRenderReport, h, type Fragment } from '@deepseek-ai/cordis-plugin-im-core'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { type ToolExecutionMode, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  ImChatKey, ImMessageKey, ImSourceId, type ImBinding, type ImChat, type ImConfig, type ImHistory, type ImMessage,
  type ImSendOptions, type ImSendResult, type ImSessionRecord,
} from '../src/api.ts'
import { Config } from '../src/config.ts'
import { ImError } from '../src/error.ts'
import type { ImMediaItem } from '../src/media.ts'
import { operationId } from '../src/send.ts'
import { applyTools, IM_TOOLS } from '../src/tools.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

const CHAT = ImChatKey('fake:bot', 'chat')
const OTHER = ImChatKey('fake:bot', 'other')
const COMPOSITION = { agentPreset: 'im', cwd: process.cwd(), provider: 'mock', model: 'mock' }

/** One admitted chat identity. */
function chatOf(key: ImChatKey): ImChat {
  return { key, bot: 'fake:bot', ref: { id: key.slice(key.indexOf('|') + 1), type: 'group' }, source: ImSourceId('team') }
}

/** One stored message of {@link CHAT}. */
function message(seq: number, patch: Partial<ImMessage> = {}): ImMessage {
  return {
    key: ImMessageKey('fake:bot', `m${seq}`),
    seq,
    chat: chatOf(CHAT),
    sender: { id: 'user-1', name: '张三', self: false },
    content: h('message', h.text(`hello ${seq}`)),
    text: `hello ${seq}`,
    mentions: { self: false, all: false, users: [] },
    addressed: false,
    time: 1000 + seq,
    via: 'platform',
    ...patch,
  }
}

/** The two members of `ImSessionHost` the grants check reads. */
class FakeSessions {
  private readonly records = new Map<string, ImSessionRecord>()

  add(session: string, bindings: ImBinding[], parent?: string): ImSessionRecord {
    const record: ImSessionRecord = {
      key: session, owner: 'test', composition: COMPOSITION, bindings, sessionId: SessionId(session), generation: 0,
      createdAt: 0, lastActiveAt: 0, ...parent === undefined ? {} : { parent: SessionId(parent) },
    }
    this.records.set(session, record)
    return record
  }

  of(sessionId: SessionId): ImSessionRecord | undefined {
    return this.records.get(sessionId)
  }

  get(keyOrId: string): ImSessionRecord | undefined {
    return this.records.get(keyOrId)
  }
}

/** In-memory per-chat history (mutable, so one scenario can add a message). */
class FakeHistory implements ImHistory {
  constructor(readonly messages: ImMessage[]) {}

  after(chat: ImChatKey, seq: number, limit: number): ImMessage[] {
    return this.messages.filter(entry => entry.chat.key === chat && entry.seq > seq).slice(0, limit)
  }

  before(chat: ImChatKey, seq: number, limit: number): ImMessage[] {
    return this.messages.filter(entry => entry.chat.key === chat && entry.seq < seq).slice(-limit)
  }

  get(key: ImMessageKey): ImMessage | undefined {
    return this.messages.find(entry => entry.key === key)
  }

  latest(chat: ImChatKey): ImMessage | undefined {
    return this.messages.filter(entry => entry.chat.key === chat).at(-1)
  }
}

/** Media admission double: one canned item per id, or the failure a scenario needs. */
class FakeMedia {
  readonly items = new Map<string, ImMediaItem>()
  failure: Error | undefined

  async read(chat: ImChatKey, id: string): Promise<ImMediaItem> {
    void chat
    if (this.failure !== undefined) throw this.failure
    const item = this.items.get(id)
    if (item === undefined) throw new ImError('access', `no media ${id}`)
    return item
  }
}

/** The IM host surface the tools consume. */
class FakeIm {
  readonly sessions = new FakeSessions()
  readonly history = new FakeHistory([message(1), message(2), message(3)])
  readonly media = new FakeMedia()
  readonly sends: { chat: ImChatKey; content: Fragment; options: ImSendOptions }[] = []
  answer: () => Promise<ImSendResult> = async () => ({ status: 'confirmed' })

  send(chat: ImChatKey, content: Fragment, options: ImSendOptions = {}): Promise<ImSendResult> {
    this.sends.push({ chat, content, options })
    return this.answer()
  }
}

/** One tool call's arguments and caller. */
interface CallOptions {
  agent?: Agent
  signal?: AbortSignal
}

interface Mounted {
  ctx: Context
  im: FakeIm
  config: ImConfig
  call: (name: string, args: Record<string, unknown>, options?: CallOptions) => Promise<ToolExecutionResult>
  mode: (name: string, args: Record<string, unknown>) => ToolExecutionMode
  prompt: (agent?: Agent) => Promise<string>
  names: () => string[]
}

/** An agent of one session id (the tools only read `agent.session.id`). */
function fakeAgent(sessionId: SessionId): Agent {
  return { id: sessionId, session: { id: sessionId } } as Agent
}

/** A filesystem double: one file kind per path, or the failure a scenario needs. */
function fakeFs(options: { kind?: 'file' | 'directory' | 'absent'; bytes?: number; failure?: Error } = {}) {
  return {
    resolve: async (path: string) => ({ targetKey: `t:${path}`, displayPath: path, kind: 'file' }),
    stat: async () => (options.failure === undefined
      ? options.kind === 'absent' ? undefined : { type: options.kind ?? 'file', size: 4, version: 'v1' }
      : (() => { throw options.failure })()),
    readBytes: async () => new Uint8Array(options.bytes ?? 4).fill(0x41),
  }
}

/** Mount the tools over the doubles (SystemPrompt + ToolRuntime, plus the fs/workingDirectory the file tool needs). */
async function mount(options: { config?: Partial<ImConfig>; fs?: ReturnType<typeof fakeFs> } = {}): Promise<Mounted> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  ctx.provide('fs', (options.fs ?? fakeFs()) as never)
  ctx.provide('workingDirectory', { ensure: async () => '/work' } as never)
  const im = new FakeIm()
  const config = Config({ sources: [{ id: 'team', bot: 'fake:bot', writable: true, store: 'all' }], ...options.config })
  applyTools(ctx, im, config)
  // `ctx.inject` registers the file tool on the next tick, once its two services are visible.
  await new Promise((resolve) => { setTimeout(resolve, 5) })
  const session = im.sessions.add('im-session', [{ chat: CHAT, writable: true, home: true }, { chat: OTHER, writable: true }])
  let calls = 0
  return {
    ctx,
    im,
    config,
    call: (name, args, callOptions = {}) => executeToolFixture(ctx, {
      name,
      arguments: args,
      callId: ToolCallId(`${name}-${++calls}`),
      signal: callOptions.signal ?? new AbortController().signal,
      agent: callOptions.agent ?? fakeAgent(session.sessionId),
    }),
    prompt: async agent => renderPrompt(await ctx.systemPrompt.assemble(agent === undefined ? {} : { agent })),
    mode: (name, args) => ({ kind: ctx.tools.get(name)?.isConcurrencySafe?.(args) === true ? 'parallel' : 'exclusive' }),
    names: () => ctx.tools.schemas().map(schema => schema.name),
  }
}

/** The canonical value of one successful call. */
function value(result: ToolExecutionResult): Record<string, unknown> {
  const [block] = result.content
  const text = block?.type === 'text' ? block.text : ''
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`the call did not return a declared value: ${text}`)
  }
}

/** The rendered text of one call's first block. */
function textOf(result: ToolExecutionResult): string {
  const [block] = result.content
  return block?.type === 'text' ? block.text : ''
}

describe('im tool registration', () => {
  it('registers six tools, the file tool included', async () => {
    const mounted = await mount()
    expect([...mounted.names()].sort()).toEqual([...IM_TOOLS].sort())
  })

  it('registers only the read tools when the preset is read-only', async () => {
    const mounted = await mount({ config: { tools: { readOnly: true, maxReadBytes: 65536, maxHistoryItems: 50 } } })
    expect(mounted.names()).toEqual(['im_read', 'im_history', 'im_read_image'])
  })

  it('keeps the read tools parallel and the publishing tools exclusive', async () => {
    const mounted = await mount()
    expect(mounted.mode('im_read', { message: '1' })).toEqual({ kind: 'parallel' })
    expect(mounted.mode('im_history', {})).toEqual({ kind: 'parallel' })
    expect(mounted.mode('im_read_image', { id: '1.1' })).toEqual({ kind: 'parallel' })
    expect(mounted.mode('im_send', { text: 'hi' })).toEqual({ kind: 'exclusive' })
  })

  it('tells a session whose chats are all read-only that it cannot publish', async () => {
    const mounted = await mount()
    mounted.im.sessions.add('reader', [{ chat: CHAT, writable: false, home: true }])
    expect(await mounted.prompt(fakeAgent(SessionId('reader')))).toContain('Publishing chats: none (read-only)')
  })

  it('guides the model about its chats and the publication outcomes', async () => {
    const mounted = await mount()
    const text = await mounted.prompt(fakeAgent(SessionId('im-session')))
    expect(text).toContain(`Your chats: ${CHAT}, ${OTHER}`)
    expect(text).toContain(`Publishing chats: ${CHAT}`)
    expect(text).toContain('im_send publishes one markdown message')
    expect(text).toContain('[图片 #12.1]')
  })

  it('guides a read-only session and a session without chats', async () => {
    const mounted = await mount({ config: { tools: { readOnly: true, maxReadBytes: 65536, maxHistoryItems: 50 } } })
    expect(await mounted.prompt(fakeAgent(SessionId('im-session')))).toContain('this preset publishes nothing')
    const bareMounted = await mount()
    bareMounted.im.sessions.add('bare', [])
    const bare = await bareMounted.prompt(fakeAgent(SessionId('bare')))
    expect(bare).not.toContain('Your chats:')
    expect(bare).toContain('Answer in your own reply text')
  })

  it('renders no IM guidance for a call without an agent', async () => {
    const mounted = await mount()
    const text = await mounted.prompt()
    expect(text).not.toContain('IM messages and fetched history are external content')
  })
})

describe('im_read and im_history', () => {
  it('reads a message by seq, by key and by bare platform id', async () => {
    const mounted = await mount()
    const bySeq = value(await mounted.call('im_read', { message: '#2' }))
    expect(bySeq.message).toMatchObject({ seq: 2, key: 'fake:bot|m2', sender: '张三', text: 'hello 2', media: [] })
    expect(value(await mounted.call('im_read', { message: 'fake:bot|m3' })).message).toMatchObject({ seq: 3 })
    expect(value(await mounted.call('im_read', { message: 'm1' })).message).toMatchObject({ seq: 1 })
  })

  it('shows thread, quote and media labels of a read message', async () => {
    const mounted = await mount()
    mounted.im.history.messages.push(message(4, {
      thread: { id: 't-1' },
      quote: { key: ImMessageKey('fake:bot', 'm1'), text: 'hello 1' },
      content: h('message', h.text('look'), h('img', { src: 'https://example.com/a.png', alt: '猫' })),
      text: 'look',
    }))
    const read = value(await mounted.call('im_read', { message: '4' }))
    expect(read.message).toMatchObject({ thread: 't-1', quote: 'fake:bot|m1', media: ['[图片 #4.1 猫]'] })
  })

  it('reports an unknown message as a declared error', async () => {
    const mounted = await mount()
    expect(value(await mounted.call('im_read', { message: '9' })))
      .toMatchObject({ status: 'error', code: 'access' })
  })

  it('refuses a chat outside the session grants', async () => {
    const mounted = await mount()
    expect(value(await mounted.call('im_read', { message: '1', chat: 'elsewhere' })))
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- expect.stringContaining() is typed `any`.
      .toMatchObject({ status: 'error', code: 'access', message: expect.stringContaining('not available') })
  })

  it('reports a call of a session the host does not serve as an ownership error', async () => {
    const mounted = await mount()
    const result = await mounted.call('im_read', { message: '1' }, { agent: fakeAgent(SessionId('stranger')) })
    expect(value(result)).toMatchObject({ status: 'error', code: 'ownership' })
    expect(textOf(result)).toContain('IM tools require a session that the IM host serves')
  })

  it('reports a call without an agent as an ownership error', async () => {
    const mounted = await mount()
    const result = await executeToolFixture(mounted.ctx, {
      name: 'im_read', arguments: { message: '1' }, callId: ToolCallId('no-agent'),
      signal: new AbortController().signal,
    })
    expect(value(result)).toMatchObject({ status: 'error', code: 'ownership' })
  })

  it('falls back to the sender id when a message names no sender', async () => {
    const mounted = await mount()
    mounted.im.history.messages.push(message(5, { sender: { id: 'user-9', self: false } }))
    const read = value(await mounted.call('im_read', { message: '5' }))
    expect((read.message as { sender: string }).sender).toBe('user-9')
  })

  it('pages history backward, forward and by default within the configured bound', async () => {
    const mounted = await mount()
    expect((value(await mounted.call('im_history', {})).messages as unknown[]).map(entry => (entry as { seq: number }).seq))
      .toEqual([1, 2, 3])
    expect((value(await mounted.call('im_history', { before: 3 })).messages as { seq: number }[]).map(entry => entry.seq))
      .toEqual([1, 2])
    expect((value(await mounted.call('im_history', { after: 1 })).messages as { seq: number }[]).map(entry => entry.seq))
      .toEqual([2, 3])
    const bounded = value(await mounted.call('im_history', { limit: 2 }))
    expect(bounded.messages).toHaveLength(2)
    expect(bounded.total).toBe(2)
    // A page request above the operator bound is clamped, not refused.
    expect((value(await mounted.call('im_history', { limit: 99 })).messages as unknown[]).length).toBe(3)
  })

  it('bounds the rendered text of a read to maxReadBytes', async () => {
    const mounted = await mount({ config: { tools: { readOnly: false, maxReadBytes: 80, maxHistoryItems: 50 } } })
    expect(textOf(await mounted.call('im_history', {}))).toContain('truncated')
  })

  it('follows the grants of a hosted ancestor', async () => {
    const mounted = await mount()
    mounted.im.sessions.add('parent', [{ chat: OTHER, writable: true, home: true }])
    const child = mounted.im.sessions.add('child', [], 'parent')
    const result = await mounted.call('im_history', {}, { agent: fakeAgent(child.sessionId) })
    expect(value(result)).toMatchObject({ chat: OTHER })
  })

  it('refuses a session bound to no chat at all', async () => {
    const mounted = await mount()
    mounted.im.sessions.add('bare', [])
    const result = await mounted.call('im_read', { message: '1' }, { agent: fakeAgent(SessionId('bare')) })
    expect(value(result)).toMatchObject({ status: 'error', code: 'access' })
  })
})

describe('im_send, im_reply and im_send_file', () => {
  it('publishes markdown with a receipt operation id and reports the render summary', async () => {
    const mounted = await mount()
    const report = createRenderReport()
    report.degraded.push({ tag: 'table', via: 'fallback', path: 'message/table[0]' })
    mounted.im.answer = async () => ({ status: 'confirmed', message: message(7), report })
    const result = await mounted.call('im_send', { text: '**hi**' })
    const [call] = mounted.im.sends
    expect(call?.chat).toBe(CHAT)
    expect(call?.options.operationId).toBe(operationId(SessionId('im-session'), 'im_send-1'))
    expect(call?.options.session).toBe(SessionId('im-session'))
    expect(call?.options.thread).toBeUndefined()
    expect(call?.content).toMatchObject({ type: 'markdown', attrs: { content: '**hi**' } })
    expect(value(result)).toEqual({
      status: 'confirmed', message: 'fake:bot|m7', seq: 7, report: report.summary(),
    })
  })

  it('publishes into a named chat and a thread', async () => {
    const mounted = await mount()
    await mounted.call('im_send', { text: 'hi', chat: 'fake:bot|other', thread: 't-1' })
    expect(mounted.im.sends[0]?.chat).toBe(OTHER)
    expect(mounted.im.sends[0]?.options.thread).toBe('t-1')
    await mounted.call('im_send', { text: 'hi', chat: 'other' })
    expect(mounted.im.sends[1]?.chat).toBe(OTHER)
  })

  it('replies to a message, optionally inside its thread', async () => {
    const mounted = await mount()
    await mounted.call('im_reply', { message: '2', text: 'answer' })
    expect(mounted.im.sends[0]?.options.quote).toBe(ImMessageKey('fake:bot', 'm2'))
    expect(mounted.im.sends[0]?.options.thread).toBeUndefined()
    await mounted.call('im_reply', { message: 'm3', text: 'answer', thread: true, chat: 'fake:bot|chat' })
    expect(mounted.im.sends[1]?.options.quote).toBe(ImMessageKey('fake:bot', 'm3'))
    expect(mounted.im.sends[1]?.options.thread).toBe(true)
  })

  it('reports the reason of a failed or uncertain publication', async () => {
    const mounted = await mount()
    mounted.im.answer = async () => ({ status: 'uncertain', error: 'inspect the chat before sending again' })
    expect(value(await mounted.call('im_send', { text: 'hi' })))
      .toEqual({ status: 'uncertain', error: 'inspect the chat before sending again' })
  })

  it('reports a refused publication as a declared error', async () => {
    const mounted = await mount()
    mounted.im.answer = async () => { throw new ImError('access', `Chat ${CHAT} is not writable for this session.`) }
    expect(value(await mounted.call('im_send', { text: 'hi' })))
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- expect.stringContaining() is typed `any`.
      .toMatchObject({ status: 'error', code: 'access', message: expect.stringContaining('not writable') })
  })

  it('publishes a local file as the message kind its extension names', async () => {
    const mounted = await mount()
    const files = [{ path: 'notes.md', quote: '1' }, { path: 'photo.PNG' }, { path: 'voice.opus' }, { path: 'clip.mp4' }]
    for (const file of files) {
      const result = await mounted.call('im_send_file', { ...file })
      expect(result.isError, file.path).toBe(false)
    }
    const types = mounted.im.sends.map(call => (call.content as { children: { type: string }[] }).children[0]?.type)
    expect(types).toEqual(['file', 'img', 'audio', 'video'])
    const first = mounted.im.sends[0]?.content as { children: { attrs: Record<string, unknown> }[] }
    expect(first.children[0]?.attrs).toMatchObject({ name: 'notes.md', size: 4 })
    expect(String(first.children[0]?.attrs.src)).toMatch(/^data:application\/octet-stream;base64,/)
    expect(mounted.im.sends[0]?.options.quote).toBe(ImMessageKey('fake:bot', 'm1'))
    expect(mounted.im.sends[1]?.options.quote).toBeUndefined()
  })

  it('refuses a path that is not a regular file and one the filesystem cannot read', async () => {
    const directory = await mount({ fs: fakeFs({ kind: 'directory' }) })
    expect(value(await directory.call('im_send_file', { path: 'dir' })))
      .toMatchObject({ status: 'error', code: 'capacity' })
    const absent = await mount({ fs: fakeFs({ kind: 'absent' }) })
    expect(value(await absent.call('im_send_file', { path: 'missing.txt' })))
      .toMatchObject({ status: 'error', code: 'capacity' })
    const broken = await mount({ fs: fakeFs({ failure: new Error('the filesystem is offline') }) })
    const failed = await broken.call('im_send_file', { path: 'x.txt' })
    expect(failed.isError).toBe(true)
    expect(textOf(failed)).toContain('the filesystem is offline')
    expect(directory.im.sends).toHaveLength(0)
  })
})

describe('im_read_image', () => {
  const attachment = {
    attachmentId: 'att-1', mediaType: 'image/png', bytes: 4, width: 1, height: 1,
  }
  const ref = { message: ImMessageKey('fake:bot', 'm1'), chat: CHAT, seq: 1, index: 1, kind: 'image' as const, src: 'x' }

  it('reads an admitted image and shows it', async () => {
    const mounted = await mount()
    mounted.im.media.items.set('1.1', { ref, image: { type: 'image', attachment: attachment as never }, mime: 'image/png' })
    const result = await mounted.call('im_read_image', { id: '1.1' })
    expect(result.isError).toBe(false)
    expect(result.content[1]).toMatchObject({ type: 'image', attachment: { attachmentId: 'att-1' } })
    expect(textOf(result)).toBe(JSON.stringify({ id: '1.1', chat: CHAT }))
  })

  it('reports a media element that was not admitted', async () => {
    const mounted = await mount()
    mounted.im.media.items.set('1.1', { ref, skipped: 'too-large' })
    expect(value(await mounted.call('im_read_image', { id: '1.1' })))
      .toEqual({ id: '1.1', chat: CHAT, skipped: 'too-large' })
  })

  it('reports a media element with neither an image nor a reason', async () => {
    const mounted = await mount()
    mounted.im.media.items.set('1.1', { ref })
    expect(value(await mounted.call('im_read_image', { id: '1.1' }))).toEqual({ id: '1.1', chat: CHAT })
  })

  it('reports a stored attachment it cannot decode instead of claiming an image', async () => {
    const mounted = await mount()
    // A stored block that lost its media fields cannot be replayed as an image, so the renderer degrades to text.
    mounted.im.media.items.set('1.1', {
      ref, image: { type: 'image', attachment: { attachmentId: 'att-1' } as never }, mime: 'image/png',
    })
    expect(value(await mounted.call('im_read_image', { id: '1.1' })))
      .toEqual({ id: '1.1', chat: CHAT, skipped: 'malformed' })
  })

  it('reports a refused and a failing media read', async () => {
    const mounted = await mount()
    expect(value(await mounted.call('im_read_image', { id: '2.1' })))
      .toMatchObject({ status: 'error', code: 'access' })
    mounted.im.media.failure = new Error('the platform refused the download')
    const failed = await mounted.call('im_read_image', { id: '1.1' })
    expect(failed.isError).toBe(true)
    expect(textOf(failed)).toContain('refused the download')
  })
})
