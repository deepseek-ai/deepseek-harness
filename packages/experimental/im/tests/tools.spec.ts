/**
 * `im_*` tools: registration (incl. `readOnly`), the prompt section, read/history/media behaviour, the publishing
 * tools' inputs (operation id, quote, thread), declared `ImError` results and the bounded render text.
 */
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createRenderReport, h, type Fragment, type MembersPage } from '@deepseek-ai/cordis-plugin-im-core'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FsError } from '@deepseek-ai/dsh-fs'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolRegistry from '@deepseek-ai/dsh-tool-registry-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { projectToolSchema, type ToolExecutionMode, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { outsideTempWorkspaceParent } from '../../../../scripts/snapshot-workspace-parent.ts'
import {
  ImChatKey, ImMessageKey, ImSourceId, type ImBinding, type ImChat, type ImConfig, type ImHistory, type ImMessage,
  type ImOutputRenderer, type ImSendOptions, type ImSendResult, type ImSessionRecord,
} from '../src/api.ts'
import { Config } from '../src/config.ts'
import { ImError } from '../src/error.ts'
import type { ImMediaFileItem, ImMediaItem } from '../src/media.ts'
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

  after(chat: ImChatKey, seq: number, limit: number, keep?: (message: ImMessage) => boolean): ImMessage[] {
    return this.messages
      .filter(entry => entry.chat.key === chat && entry.seq > seq && (keep === undefined || keep(entry)))
      .slice(0, limit)
  }

  before(chat: ImChatKey, seq: number, limit: number, keep?: (message: ImMessage) => boolean): ImMessage[] {
    return this.messages
      .filter(entry => entry.chat.key === chat && entry.seq < seq && (keep === undefined || keep(entry)))
      .slice(-limit)
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
  readonly items = new Map<string, ImMediaFileItem>()
  failure: Error | undefined
  constructor(private readonly history?: FakeHistory) {}

  async read(
    chat: ImChatKey,
    id: string,
    _signal?: AbortSignal,
    allow?: (message: ImMessage) => boolean,
  ): Promise<ImMediaItem> {
    if (this.failure !== undefined) throw this.failure
    const item = this.items.get(id)
    if (item === undefined) throw new ImError('access', `no media ${id}`)
    const owner = this.history?.messages.find(msg => msg.chat.key === chat && msg.seq === item.ref.seq)
    if (allow !== undefined && owner !== undefined && !allow(owner)) {
      throw new ImError('access', `Message #${item.ref.seq} is outside the threads granted to this session.`)
    }
    return item
  }

  async readFile(
    chat: ImChatKey,
    id: string,
    signal?: AbortSignal,
    allow?: (message: ImMessage) => boolean,
  ): Promise<ImMediaFileItem> {
    return await this.read(chat, id, signal, allow)
  }
}

/** The IM host surface the tools consume. */
class FakeIm {
  readonly sessions = new FakeSessions()
  readonly history = new FakeHistory([message(1), message(2), message(3)])
  readonly media = new FakeMedia(this.history)
  /** Output renderer ids this host has registered; a session naming one renders its turn text into the chat. */
  readonly renderers = new Set<string>()
  readonly outputs = {
    get: (id: string): ImOutputRenderer | undefined =>
      (this.renderers.has(id) ? {} as ImOutputRenderer : undefined),
  }
  /** Messages the platform holds but this deployment never received, by platform id. */
  readonly platform = new Map<string, ImMessage>()
  /** What the host read answers for a message the platform fills in (a merged forward's entries), by platform id. */
  readonly expansions = new Map<string, ImMessage>()
  readonly sends: { chat: ImChatKey; content: Fragment; options: ImSendOptions }[] = []
  botSelfId: string | undefined = 'fake:bot'
  answer: () => Promise<ImSendResult> = async () => ({ status: 'confirmed' })

  bot(chat: ImChatKey): { selfId: string } {
    if (this.botSelfId === undefined) throw new ImError('unavailable', `No bot for ${chat}`)
    return { selfId: this.botSelfId }
  }

  send(chat: ImChatKey, content: Fragment, options: ImSendOptions = {}): Promise<ImSendResult> {
    this.sends.push({ chat, content, options })
    return this.answer()
  }

  /** The store's read: a message it never received comes from the platform stand-in, or stays unreadable. */
  async readMessage(chat: ImChatKey, id: string): Promise<ImMessage> {
    const stored = this.history.get(ImMessageKey('fake:bot', id))
    if (stored !== undefined) return this.expansions.get(id) ?? stored
    const fetched = this.platform.get(id)
    if (fetched === undefined) throw new ImError('access', `Chat ${chat} holds no message ${id}.`)
    return fetched
  }

  /** Members the platform lists, by chat; a chat it cannot list reports the platform's own refusal. */
  readonly membersByChat = new Map<ImChatKey, { id: string; name?: string }[]>()

  async members(chat: ImChatKey, _cursor?: string, _limit?: number): Promise<MembersPage> {
    const data = this.membersByChat.get(chat)
    if (data === undefined) throw new ImError('unavailable', `Bot fake:bot cannot list the members of ${chat}.`)
    return { data }
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
  fs: ReturnType<typeof fakeFs>
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
function fakeFs(
  options: {
    kind?: 'file' | 'directory' | 'absent'
    bytes?: number
    omitSize?: boolean
    failure?: Error
    remote?: boolean
  } = {},
) {
  const writes: { key: string; data: Uint8Array }[] = []
  return {
    writes,
    resolve: async (path: string, opts?: { cwd?: string }) => ({
      targetKey: opts?.cwd === undefined ? `t:${path}` : `${opts.cwd}/${path}`,
      displayPath: path,
      kind: 'file',
    }),
    processPath: (target: { targetKey: string }) => target.targetKey,
    // A host-backed world maps its own process path back to itself; a remote one (an SSH workspace) cannot.
    processPathFromHostPath: (hostPath: string) => options.remote === true ? undefined : hostPath,
    fileUrl: (target: { targetKey: string }) => `file://${target.targetKey}`,
    stat: async () => (options.failure === undefined
      ? options.kind === 'absent'
        ? undefined
        : { type: options.kind ?? 'file', ...options.omitSize === true ? {} : { size: 4 }, version: 'v1' }
      : (() => { throw options.failure })()),
    readBytes: async () => new Uint8Array(options.bytes ?? 4).fill(0x41),
    writeBytes: async (target: { targetKey: string }, data: Uint8Array) => {
      writes.push({ key: target.targetKey, data })
      return { operation: 'create' as const, version: 'v1' }
    },
  }
}

/** Mount the tools over the doubles (SystemPrompt + ToolRuntime, plus the fs/workingDirectory the file tool needs). */
async function mount(options: { config?: Partial<ImConfig>; fs?: ReturnType<typeof fakeFs> } = {}): Promise<Mounted> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolRegistry)
  const fs = options.fs ?? fakeFs()
  ctx.provide('fs', fs as never)
  ctx.provide('workingDirectory', { get: () => '/work', ensure: async () => '/work' } as never)
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
    fs,
    call: (name, args, callOptions = {}) => executeToolFixture(ctx, {
      name,
      arguments: args,
      callId: ToolCallId(`${name}-${++calls}`),
      signal: callOptions.signal ?? new AbortController().signal,
      agent: callOptions.agent ?? fakeAgent(session.sessionId),
    }),
    prompt: async agent => renderPrompt(await ctx.systemPrompt.assemble(agent === undefined ? {} : { agent })),
    mode: (name, args) => ({ kind: ctx.tools.get(name)?.isConcurrencySafe?.(args) === true ? 'parallel' : 'exclusive' }),
    names: () => ctx.tools.getAll().map(tool => tool.name),
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
  it('registers seven tools, the file tools included', async () => {
    const mounted = await mount()
    expect([...mounted.names()].sort()).toEqual([...IM_TOOLS].sort())
  })

  it('registers only the read tools when the preset is read-only', async () => {
    const mounted = await mount({
      config: {
        tools: {
          readOnly: true, maxReadBytes: 65536, maxHistoryItems: 50, maxMembers: 200, maxMemberPages: 10, fileDir: '.dsh/im',
        },
      },
    })
    expect(mounted.names()).toEqual(['im_read', 'im_history', 'im_members', 'im_read_image', 'im_read_file'])
  })

  it('keeps the read tools parallel and the publishing tools exclusive', async () => {
    const mounted = await mount()
    expect(mounted.mode('im_read', { message: '1' })).toEqual({ kind: 'parallel' })
    expect(mounted.mode('im_history', {})).toEqual({ kind: 'parallel' })
    expect(mounted.mode('im_members', {})).toEqual({ kind: 'parallel' })
    expect(mounted.mode('im_read_image', { id: '1.1' })).toEqual({ kind: 'parallel' })
    expect(mounted.mode('im_read_file', { id: '1.2' })).toEqual({ kind: 'parallel' })
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
    expect(text).toContain('Only im_send, im_reply and im_send_file reach the chat')
    expect(text).not.toContain('Answer in your own reply text')
    expect(text).toContain('[图片 #12.1]')
  })

  it('tells a session with a registered renderer to answer in its reply text', async () => {
    const mounted = await mount()
    const rendered = mounted.im.sessions.add('rendered', [{ chat: CHAT, writable: true, home: true }])
    rendered.output = 'probe'
    mounted.im.renderers.add('probe')
    const text = await mounted.prompt(fakeAgent(SessionId('rendered')))
    expect(text).toContain('Answer in your own reply text')
    expect(text).not.toContain('Only im_send, im_reply and im_send_file reach the chat')

    // An id nobody registered renders nothing, so the session publishes through its tools again.
    mounted.im.renderers.delete('probe')
    expect(await mounted.prompt(fakeAgent(SessionId('rendered'))))
      .toContain('Only im_send, im_reply and im_send_file reach the chat')
  })

  it('guides a read-only session and a session without chats', async () => {
    const mounted = await mount({
      config: {
        tools: {
          readOnly: true, maxReadBytes: 65536, maxHistoryItems: 50, maxMembers: 200, maxMemberPages: 10, fileDir: '.dsh/im',
        },
      },
    })
    expect(await mounted.prompt(fakeAgent(SessionId('im-session')))).toContain('this preset publishes nothing')
    const bareMounted = await mount()
    bareMounted.im.sessions.add('bare', [])
    const bare = await bareMounted.prompt(fakeAgent(SessionId('bare')))
    expect(bare).not.toContain('Your chats:')
    expect(bare).toContain('Only im_send, im_reply and im_send_file reach the chat')
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

  it('reads a seq through the same read as a key, so a merged forward reaches its entries', async () => {
    const mounted = await mount()
    const bare = message(6, { content: h('message', h('forward', { id: 'm6' })), text: '[forward]' })
    mounted.im.history.messages.push(bare)
    // The host read is where a stored reference gains the entries the platform returns; a seq must not shortcut it.
    mounted.im.expansions.set('m6', {
      ...bare,
      content: h('message', h('forward', { id: 'm6' }, h.text('user-1: 原文'))),
      text: 'user-1: 原文',
    })
    const read = value(await mounted.call('im_read', { message: '6' }))
    expect((read.message as { text: string }).text).toBe('user-1: 原文')
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

  it('reports the people a read message mentioned, without the bot itself', async () => {
    const mounted = await mount()
    mounted.im.history.messages.push(message(4, {
      mentions: { self: true, all: false, users: [{ id: 'fake:bot', name: 'bot' }, { id: 'ou_a', name: '张三' }] },
    }))
    const read = value(await mounted.call('im_read', { message: '4' }))
    expect(read.message).toMatchObject({ mentions: [{ id: 'ou_a', name: '张三' }] })
  })

  it('lists a chat\'s members with the markdown that mentions each of them', async () => {
    const mounted = await mount()
    mounted.im.membersByChat.set(CHAT, [{ id: 'ou_a', name: '张三' }, { id: 'ou_b' }])
    expect(value(await mounted.call('im_members', {}))).toMatchObject({
      chat: CHAT,
      total: 2,
      more: false,
      members: [
        { id: 'ou_a', name: '张三', mention: '<at user_id="ou_a">张三</at>' },
        { id: 'ou_b', mention: '<at user_id="ou_b"></at>' },
      ],
    })
    // The query narrows the answer to the members a session is looking for, in the platform's own order.
    expect((value(await mounted.call('im_members', { query: '张' })).members as unknown[])).toHaveLength(1)
  })

  it('reports a platform that cannot list the members of a chat', async () => {
    const mounted = await mount()
    expect(value(await mounted.call('im_members', {}))).toMatchObject({ status: 'error', code: 'unavailable' })
  })

  it('stops paging a roster no member of which matches the query, honouring tools.maxMemberPages', async () => {
    const mounted = await mount()
    let reads = 0
    // A roster that never ends: without a page limit one unmatched query would read it for ever.
    mounted.im.members = async (_chat: ImChatKey, cursor?: string): Promise<MembersPage> => {
      reads++
      return { data: [{ id: `ou_${cursor ?? 0}`, name: '李四' }], next: String(Number(cursor ?? 0) + 1) }
    }
    expect(value(await mounted.call('im_members', { query: '张' }))).toMatchObject({ members: [], total: 0, more: true })
    expect(reads).toBe(10)

    const custom = await mount({
      config: {
        tools: {
          readOnly: false, maxReadBytes: 65536, maxHistoryItems: 50, maxMembers: 200, maxMemberPages: 3, fileDir: '.dsh/im',
        },
      },
    })
    let customReads = 0
    custom.im.members = async (_chat: ImChatKey, cursor?: string): Promise<MembersPage> => {
      customReads++
      return { data: [{ id: `ou_${cursor ?? 0}`, name: '李四' }], next: String(Number(cursor ?? 0) + 1) }
    }
    expect(value(await custom.call('im_members', { query: '张' }))).toMatchObject({ members: [], total: 0, more: true })
    expect(customReads).toBe(3)
  })

  it('reaches maxMembers above 100 across 100-entry pages and stops once the member bound is full', async () => {
    const large = await mount({
      config: {
        tools: {
          readOnly: false, maxReadBytes: 65536, maxHistoryItems: 50, maxMembers: 600, maxMemberPages: 10, fileDir: '.dsh/im',
        },
      },
    })
    const limits: (number | undefined)[] = []
    large.im.members = async (_chat: ImChatKey, cursor?: string, limit?: number): Promise<MembersPage> => {
      limits.push(limit)
      const pageIndex = Number(cursor ?? 0)
      const size = limit ?? 20
      const data = Array.from({ length: size }, (_, offset) => ({ id: `ou_${pageIndex}_${offset}`, name: '王五' }))
      return { data, ...pageIndex < 9 ? { next: String(pageIndex + 1) } : {} }
    }
    expect(value(await large.call('im_members', {}))).toMatchObject({ total: 600, more: true })
    expect(limits).toEqual([100, 100, 100, 100, 100, 100])

    // A single page that carries more matching entries than maxMembers stops mid-page with `more: true`.
    const small = await mount({
      config: {
        tools: {
          readOnly: false, maxReadBytes: 65536, maxHistoryItems: 50, maxMembers: 2, maxMemberPages: 10, fileDir: '.dsh/im',
        },
      },
    })
    small.im.members = async (): Promise<MembersPage> => ({
      data: [{ id: 'ou_1', name: '张一' }, { id: 'ou_2', name: '张二' }, { id: 'ou_3', name: '张三' }],
    })
    expect(value(await small.call('im_members', { query: '张' }))).toMatchObject({ total: 2, more: true })
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
    mounted.im.history.messages.push(message(5, {
      sender: { id: 'user-9', self: false },
      mentions: { self: false, all: false, users: [{ id: 'user-nameless' }, { id: 'user-named', name: '李四' }] },
    }))
    const read = value(await mounted.call('im_read', { message: '5' }))
    expect((read.message as { sender: string }).sender).toBe('user-9')
    expect((read.message as { mentions: unknown[] }).mentions)
      .toEqual([{ id: 'user-nameless' }, { id: 'user-named', name: '李四' }])
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
    const mounted = await mount({
      config: {
        tools: {
          readOnly: false, maxReadBytes: 80, maxHistoryItems: 50, maxMembers: 200, maxMemberPages: 10, fileDir: '.dsh/im',
        },
      },
    })
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
    expect(first.children[0]?.attrs.src).toBe('file:///work/notes.md')
    expect(mounted.im.sends[0]?.options.quote).toBe(ImMessageKey('fake:bot', 'm1'))
    expect(mounted.im.sends[1]?.options.quote).toBeUndefined()

    const sizeless = await mount({ fs: fakeFs({ omitSize: true }) })
    expect((await sizeless.call('im_send_file', { path: 'notes.md' })).isError).toBe(false)
    const sizelessAttrs = (sizeless.im.sends[0]?.content as { children: { attrs: Record<string, unknown> }[] }).children[0]?.attrs
    expect(sizelessAttrs).toEqual({ src: 'file:///work/notes.md', name: 'notes.md' })
  })

  it('inlines the bytes of a file another execution world holds', async () => {
    const mounted = await mount({ fs: fakeFs({ remote: true, bytes: 3 }) })
    const result = await mounted.call('im_send_file', { path: 'notes.md' })
    expect(result.isError).toBe(false)
    const content = mounted.im.sends[0]?.content as { children: { attrs: Record<string, unknown> }[] }
    expect(content.children[0]?.attrs).toMatchObject({ name: 'notes.md', size: 3 })
    expect(content.children[0]?.attrs.src).toBe('data:application/octet-stream;base64,QUFB')

    // Prototype property names like `constructor` must not match IMAGE_TYPES/AUDIO_TYPES/VIDEO_TYPES.
    const protoResult = await mounted.call('im_send_file', { path: 'report.constructor' })
    expect(protoResult.isError).toBe(false)
    const protoContent = mounted.im.sends[1]?.content as { children: { type: string; attrs: Record<string, unknown> }[] }
    expect(protoContent.children[0]?.type).toBe('file')
    expect(protoContent.children[0]?.attrs.src).toBe('data:application/octet-stream;base64,QUFB')
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

  it('converts FS_TOO_LARGE from another execution world into a capacity error and rethrows other read failures', async () => {
    const tooLargeFs = fakeFs({ remote: true })
    tooLargeFs.readBytes = () => Promise.reject(new FsError('file exceeds maxMediaBytes', 'FS_TOO_LARGE'))
    const oversized = await mount({ fs: tooLargeFs })
    expect(value(await oversized.call('im_send_file', { path: 'big.bin' })))
      .toMatchObject({ status: 'error', code: 'capacity', message: 'file exceeds maxMediaBytes' })

    const ioFs = fakeFs({ remote: true })
    ioFs.readBytes = () => Promise.reject(new FsError('ssh channel closed', 'FS_IO_ERROR'))
    const broken = await mount({ fs: ioFs })
    const failed = await broken.call('im_send_file', { path: 'bad.bin' })
    expect(failed.isError).toBe(true)
    expect(textOf(failed)).toContain('ssh channel closed')
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

describe('im_read_file', () => {
  const attachment = { attachmentId: 'sha256:aa', name: 'report.pdf', bytes: 3 }
  const ref = { message: ImMessageKey('fake:bot', 'm1'), chat: CHAT, seq: 1, index: 2, kind: 'file' as const, src: 'x' }
  const data = new Uint8Array([7, 8, 9])

  it('saves the file of one label into the workspace and reports its path', async () => {
    const mounted = await mount()
    mounted.im.media.items.set('1.2', {
      ref, file: { type: 'file', attachment: attachment as never }, mime: 'application/pdf', bytes: 3, data,
    })
    const result = value(await mounted.call('im_read_file', { id: '1.2' }))
    expect(result).toMatchObject({ id: '1.2', chat: CHAT, file: attachment })
    const path = result.path as string
    expect(path).toMatch(/^\/work\/\.dsh\/im\/[0-9a-f]{8}\/1\.2-report\.pdf$/)
    expect(mounted.fs.writes).toEqual([{ key: path, data }])
  })

  it('stages the same media label of two chats into separate files', async () => {
    const mounted = await mount()
    mounted.im.media.items.set('1.2', {
      ref, file: { type: 'file', attachment: attachment as never }, mime: 'application/pdf', bytes: 3, data,
    })
    const first = value(await mounted.call('im_read_file', { id: '1.2', chat: CHAT }))
    const second = value(await mounted.call('im_read_file', { id: '1.2', chat: OTHER }))
    expect(first.path).not.toBe(second.path)
    expect(mounted.fs.writes).toHaveLength(2)
  })

  it('reports a stored file whose bytes the store did not hand back', async () => {
    const mounted = await mount()
    mounted.im.media.items.set('1.2', { ref, file: { type: 'file', attachment: attachment as never }, bytes: 3 })
    expect(value(await mounted.call('im_read_file', { id: '1.2' }))).toEqual({ id: '1.2', chat: CHAT })
    expect(mounted.fs.writes).toEqual([])
  })

  it('reports a media element that was not admitted, with and without a reason', async () => {
    const mounted = await mount()
    mounted.im.media.items.set('1.2', { ref, skipped: 'too-large' })
    expect(value(await mounted.call('im_read_file', { id: '1.2' })))
      .toEqual({ id: '1.2', chat: CHAT, skipped: 'too-large' })
    mounted.im.media.items.set('1.2', { ref })
    expect(value(await mounted.call('im_read_file', { id: '1.2' }))).toEqual({ id: '1.2', chat: CHAT })
  })

  it('reports a refused and a failing file read', async () => {
    const mounted = await mount()
    expect(value(await mounted.call('im_read_file', { id: '2.1' })))
      .toMatchObject({ status: 'error', code: 'access' })
    mounted.im.media.failure = new Error('the platform refused the download')
    const failed = await mounted.call('im_read_file', { id: '1.2' })
    expect(failed.isError).toBe(true)
    expect(textOf(failed)).toContain('refused the download')
  })

  it('converts FS_TOO_LARGE when staging a file to another execution world into a capacity error', async () => {
    const remoteFs = fakeFs({ remote: true })
    remoteFs.writeBytes = () => Promise.reject(new FsError('payload exceeds transport frame', 'FS_TOO_LARGE'))
    const mounted = await mount({ fs: remoteFs })
    mounted.im.media.items.set('1.2', {
      ref, file: { type: 'file', attachment: attachment as never }, mime: 'application/pdf', bytes: 3, data,
    })
    expect(value(await mounted.call('im_read_file', { id: '1.2' })))
      .toMatchObject({ status: 'error', code: 'capacity', message: 'payload exceeds transport frame' })
  })

  it('enforces a session read-only sandbox override even when the deployment default is danger-full-access', async () => {
    const directory = await mkdtemp(join(outsideTempWorkspaceParent(), '.dsh-im-tools-'))
    try {
      const workspace = join(realpathSync.native(directory), 'ws')
      await mkdir(workspace)
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SessionStore)
      await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: workspace })
      await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(NativeToolRegistry)
      ctx.provide('workingDirectory', { get: () => workspace, ensure: async () => workspace } as never)
      const im = new FakeIm()
      const config = Config({ sources: [{ id: 'team', bot: 'fake:bot', writable: true, store: 'all' }] })
      applyTools(ctx, im, config)
      await new Promise((resolve) => { setTimeout(resolve, 5) })

      im.sessions.add('im-session', [{ chat: CHAT, writable: true, home: true }])
      im.media.items.set('1.2', {
        ref, file: { type: 'file', attachment: attachment as never }, mime: 'application/pdf', bytes: 3, data,
      })
      const session = ctx.sessions.create(SessionId('im-session'), { meta: { cwd: workspace } })
      setSandboxMode(session, 'read-only')

      const denied = await executeToolFixture(ctx, {
        name: 'im_read_file',
        arguments: { id: '1.2' },
        callId: ToolCallId('im_read_file-ro'),
        signal: new AbortController().signal,
        agent: { id: session.id, session } as Agent,
      })
      expect(denied.isError).toBe(true)
      expect(textOf(denied)).toContain('read-only')
      expect(existsSync(join(workspace, '.dsh'))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('uses the calling session cwd as the workspace-write boundary instead of the deployment fallback', async () => {
    const directory = await mkdtemp(join(outsideTempWorkspaceParent(), '.dsh-im-tools-'))
    try {
      const root = realpathSync.native(directory)
      const fallbackDir = join(root, 'fallback')
      const sessionDir = join(root, 'session-ws')
      await mkdir(fallbackDir)
      await mkdir(sessionDir)

      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SessionStore)
      await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fallbackDir })
      await ctx.plugin(SandboxedFileSystem, { cwd: fallbackDir })
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(NativeToolRegistry)
      ctx.provide('workingDirectory', { get: () => sessionDir, ensure: async () => sessionDir } as never)
      const im = new FakeIm()
      const config = Config({ sources: [{ id: 'team', bot: 'fake:bot', writable: true, store: 'all' }] })
      applyTools(ctx, im, config)
      await new Promise((resolve) => { setTimeout(resolve, 5) })

      im.sessions.add('im-session', [{ chat: CHAT, writable: true, home: true }])
      im.media.items.set('1.2', {
        ref, file: { type: 'file', attachment: attachment as never }, mime: 'application/pdf', bytes: 3, data,
      })
      const session = ctx.sessions.create(SessionId('im-session'), { meta: { cwd: sessionDir } })
      const agent = { id: session.id, session } as Agent

      // Staging inside the session's own workspace succeeds even though the deployment fallback points elsewhere.
      const allowed = await executeToolFixture(ctx, {
        name: 'im_read_file',
        arguments: { id: '1.2' },
        callId: ToolCallId('im_read_file-ws-ok'),
        signal: new AbortController().signal,
        agent,
      })
      expect(allowed.isError).toBe(false)
      const stagedPath = value(allowed).path as string
      expect(new Uint8Array(await readFile(stagedPath))).toEqual(data)

      // Staging outside the session's workspace (even under the deployment fallback) is refused by the session policy.
      config.tools.fileDir = '../fallback/.dsh/im'
      const escaped = await executeToolFixture(ctx, {
        name: 'im_read_file',
        arguments: { id: '1.2' },
        callId: ToolCallId('im_read_file-ws-deny'),
        signal: new AbortController().signal,
        agent,
      })
      expect(escaped.isError).toBe(true)
      expect(existsSync(join(fallbackDir, '.dsh'))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refuses to register im_read_file over a confining filesystem when ctx.sandboxPolicy is absent', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolRegistry)
    ctx.provide('fs', { ...fakeFs(), sandboxMode: 'workspace-write' } as never)
    ctx.provide('workingDirectory', { get: () => '/work', ensure: async () => '/work' } as never)
    const im = new FakeIm()
    const config = Config({ sources: [{ id: 'team', bot: 'fake:bot', writable: true, store: 'all' }] })
    applyTools(ctx, im, config)
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(ctx.tools.get('im_read_file')).toBeUndefined()
    expect(logged.mock.calls.some(([err]) => String(err).includes('ctx.sandboxPolicy is required'))).toBe(true)
  })
})

describe('model-visible surface', () => {
  // What the model reads is a contract, not a byproduct: the tool schemas and the `tool:im` section are pinned
  // verbatim so a change to a description, a parameter or a guidance sentence shows up as a diff someone reviews.
  it('pins the schema of every registered IM tool', async () => {
    const mounted = await mount()
    const schemas = mounted.ctx.tools.getAll().map(tool => projectToolSchema(tool, true))
      .map(({ name, description, parameters }) => ({ name, description, parameters }))
    expect(schemas).toMatchSnapshot()
  })

  it('pins the guidance of every session shape', async () => {
    const mounted = await mount()
    const writable = await mounted.prompt(fakeAgent(SessionId('im-session')))

    // A session whose `output` names a registered renderer has its turn text rendered into the chat.
    const rendered = mounted.im.sessions.add('rendered-pin', [{ chat: CHAT, writable: true, home: true }])
    rendered.output = 'probe'
    mounted.im.renderers.add('probe')
    const withRenderer = await mounted.prompt(fakeAgent(SessionId('rendered-pin')))

    const readOnlyMount = await mount({
      config: {
        tools: {
          readOnly: true, maxReadBytes: 65536, maxHistoryItems: 50, maxMembers: 200, maxMemberPages: 10, fileDir: '.dsh/im',
        },
      },
    })
    const readOnly = await readOnlyMount.prompt(fakeAgent(SessionId('im-session')))

    const bareMount = await mount()
    bareMount.im.sessions.add('bare-pin', [])
    const bare = await bareMount.prompt(fakeAgent(SessionId('bare-pin')))

    expect({ writable, withRenderer, readOnly, bare }).toMatchSnapshot()
  })
})

describe('thread confinement, subagent idempotency, and tiny maxReadBytes', () => {
  it('enforces binding.thread on im_read, im_history, and im_reply', async () => {
    const mounted = await mount()
    const confined = mounted.im.sessions.add('confined', [{ chat: CHAT, writable: true, home: true, thread: 't1' }])
    mounted.im.history.messages.push(
      message(4, { key: ImMessageKey('fake:bot', 'm-t1'), thread: { id: 't1' }, text: 'in t1' }),
      message(5, { key: ImMessageKey('fake:bot', 'm-t2'), thread: { id: 't2' }, text: 'in t2' }),
    )

    const hist = value(await mounted.call('im_history', {}, { agent: fakeAgent(confined.sessionId) })) as { messages: Array<{ key: string }> }
    expect(hist.messages.map(m => m.key)).toEqual(['fake:bot|m-t1'])

    const deniedRead = value(await mounted.call('im_read', { message: 'm-t2' }, { agent: fakeAgent(confined.sessionId) }))
    expect(deniedRead).toMatchObject({ status: 'error', code: 'access' })

    const deniedReply = value(await mounted.call('im_reply', { message: 'm-t2', text: 'hi' }, { agent: fakeAgent(confined.sessionId) }))
    expect(deniedReply).toMatchObject({ status: 'error', code: 'access' })

    const okRead = value(await mounted.call('im_read', { message: 'm-t1' }, { agent: fakeAgent(confined.sessionId) })) as { message: { key: string } }
    expect(okRead.message.key).toBe('fake:bot|m-t1')
    expect(await mounted.prompt(fakeAgent(confined.sessionId))).toContain('Thread-confined publishing chats')

    const mixed = mounted.im.sessions.add('mixed', [
      { chat: CHAT, writable: true, home: true, thread: 't1' },
      { chat: CHAT, writable: true },
    ])
    expect(await mounted.prompt(fakeAgent(mixed.sessionId))).not.toContain('Thread-confined publishing chats')

    const refT2 = { message: ImMessageKey('fake:bot', 'm-t2'), chat: CHAT, seq: 5, index: 1, kind: 'image' as const, src: 'x' }
    mounted.im.media.items.set('5.1', {
      ref: refT2,
      image: { type: 'image', attachment: { attachmentId: 'att-t2', mediaType: 'image/png', bytes: 4, width: 1, height: 1 } as never },
      file: { type: 'file', attachment: { attachmentId: 'att-t2', name: 'secret.png', bytes: 4 } as never },
      data: new Uint8Array([1, 2, 3, 4]),
    })
    expect(value(await mounted.call('im_read_image', { id: '5.1' }, { agent: fakeAgent(confined.sessionId) })))
      .toMatchObject({ status: 'error', code: 'access' })
    expect(value(await mounted.call('im_read_file', { id: '5.1' }, { agent: fakeAgent(confined.sessionId) })))
      .toMatchObject({ status: 'error', code: 'access' })

    const rootConfined = mounted.im.sessions.add('root-confined', [{ chat: CHAT, writable: true, home: true, thread: 'om_root' }])
    mounted.im.history.messages.push(
      message(6, { key: ImMessageKey('fake:bot', 'om_root'), text: 'root' }),
      message(7, { key: ImMessageKey('fake:bot', 'm-in-root'), thread: { id: 'omt_x', root: 'om_root' }, text: 'in root' }),
    )
    const rootHist = value(await mounted.call('im_history', {}, { agent: fakeAgent(rootConfined.sessionId) })) as { messages: Array<{ key: string }> }
    expect(rootHist.messages.map(m => m.key)).toEqual(['fake:bot|om_root', 'fake:bot|m-in-root'])
  })

  it('derives distinct operationIds for sibling subagents sharing one hosted ancestor', async () => {
    const mounted = await mount()
    mounted.im.sessions.add('sub-a', [], 'im-session')
    mounted.im.sessions.add('sub-b', [], 'im-session')
    const subA = { ...fakeAgent(SessionId('sub-a')), parentSession: SessionId('im-session') }
    const subB = { ...fakeAgent(SessionId('sub-b')), parentSession: SessionId('im-session') }
    await executeToolFixture(mounted.ctx, {
      name: 'im_send',
      arguments: { text: 'from A' },
      callId: ToolCallId('call-1'),
      signal: new AbortController().signal,
      agent: subA,
    })
    await executeToolFixture(mounted.ctx, {
      name: 'im_send',
      arguments: { text: 'from B' },
      callId: ToolCallId('call-1'),
      signal: new AbortController().signal,
      agent: subB,
    })
    expect(mounted.im.sends).toHaveLength(2)
    expect(mounted.im.sends[0]!.options.operationId).not.toBe(mounted.im.sends[1]!.options.operationId)
  })

  it('never exceeds tiny maxReadBytes even when smaller than the truncation notice', async () => {
    const mounted = await mount({
      config: {
        tools: {
          readOnly: false, maxReadBytes: 10, maxHistoryItems: 50, maxMembers: 200, maxMemberPages: 10, fileDir: '.dsh/im',
        },
      },
    })
    mounted.im.history.messages.push(
      message(4, { key: ImMessageKey('fake:bot', 'm-long'), text: 'x'.repeat(100) }),
    )
    const result = await mounted.call('im_read', { message: 'm-long' })
    expect(Buffer.byteLength(textOf(result))).toBeLessThanOrEqual(10)
  })

  it('bounds staged filenames under tools.fileDir so long attachment names do not trigger ENAMETOOLONG', async () => {
    const mounted = await mount()
    const refLong = { message: ImMessageKey('fake:bot', 'm1'), chat: CHAT, seq: 1, index: 1, kind: 'file' as const, src: 'x' }
    mounted.im.media.items.set('1.1', {
      ref: refLong,
      file: { type: 'file', attachment: { attachmentId: 'att-long-ext', name: `${'a'.repeat(245)}.pdf`, bytes: 3 } as never },
      data: new Uint8Array([1, 2, 3]),
    })
    mounted.im.media.items.set('1.2', {
      ref: { ...refLong, index: 2 },
      file: { type: 'file', attachment: { attachmentId: 'att-long-noext', name: 'b'.repeat(250), bytes: 3 } as never },
      data: new Uint8Array([1, 2, 3]),
    })
    mounted.im.media.items.set('1.3', {
      ref: { ...refLong, index: 3 },
      file: { type: 'file', attachment: { attachmentId: 'att-long-ext2', name: `c.${'d'.repeat(200)}`, bytes: 3 } as never },
      data: new Uint8Array([1, 2, 3]),
    })
    const withExt = value(await mounted.call('im_read_file', { id: '1.1' })) as { path: string }
    const noExt = value(await mounted.call('im_read_file', { id: '1.2' })) as { path: string }
    const hugeExt = value(await mounted.call('im_read_file', { id: '1.3' })) as { path: string }
    expect(Buffer.byteLength(withExt.path.split('/').at(-1)!)).toBeLessThanOrEqual(160)
    expect(withExt.path.endsWith('.pdf')).toBe(true)
    expect(Buffer.byteLength(noExt.path.split('/').at(-1)!)).toBeLessThanOrEqual(160)
    expect(Buffer.byteLength(hugeExt.path.split('/').at(-1)!)).toBeLessThanOrEqual(160)
  })

  it('filters bot selfId mentions in im_read and im_history using im.bot(chat).selfId', async () => {
    const mounted = await mount()
    mounted.im.botSelfId = 'ou_bot'
    mounted.im.history.messages.push(message(4, {
      key: ImMessageKey('fake:bot', 'm-self-mention'),
      mentions: { self: true, all: false, users: [{ id: 'ou_bot', name: 'Bot' }, { id: 'ou_alice', name: 'Alice' }] },
    }))
    const read = value(await mounted.call('im_read', { message: 'm-self-mention' })) as { message: { mentions: Array<{ id: string }> } }
    expect(read.message.mentions).toEqual([{ id: 'ou_alice', name: 'Alice' }])
    const hist = value(await mounted.call('im_history', { after: 3 })) as { messages: Array<{ mentions: Array<{ id: string }> }> }
    expect(hist.messages[0]?.mentions).toEqual([{ id: 'ou_alice', name: 'Alice' }])

    mounted.im.botSelfId = undefined
    const readNoBot = value(await mounted.call('im_read', { message: 'm-self-mention' })) as { message: { mentions: Array<{ id: string }> } }
    expect(readNoBot.message.mentions).toEqual([{ id: 'ou_bot', name: 'Bot' }, { id: 'ou_alice', name: 'Alice' }])

    vi.spyOn(mounted.im, 'bot').mockImplementationOnce(() => { throw new TypeError('unexpected bot failure') })
    expect(await mounted.call('im_read', { message: 'm-self-mention' })).toMatchObject({
      isError: true,
      error: { message: 'unexpected bot failure' },
    })
  })
})
