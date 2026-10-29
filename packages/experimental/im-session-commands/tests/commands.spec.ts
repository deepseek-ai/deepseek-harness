/**
 * Behaviour of the session-commands plugin: the addressed gate, `/stop` thread selection, `/clear`+`/new` resets,
 * `/status`, `/help`, dsh command passthrough, permissions, locale and the redelivery contract of the core waterfall.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImSessionRecord, ImSessionSpec } from '@deepseek-ai/dsh-experimental-im/src/api.ts'
import { ImChatKey } from '@deepseek-ai/dsh-experimental-im/src/api.ts'
import { BY } from '../src/commands.ts'
import { COMPOSITION, delivery } from '../../im/tests/support/sessions-harness.ts'
import {
  bootCommands, cleanAll, inbound, CHAT, THREAD, type CommandsHarness,
} from './support/harness.ts'

afterEach(cleanAll)

const CHAT_KEY = ImChatKey('fake:bot', CHAT.id)
const OTHER_CHAT = ImChatKey('fake:bot', 'other')

/** The home session of the test chat, owned by the default dispatcher. */
function spec(patch: Partial<ImSessionSpec> = {}): ImSessionSpec {
  return {
    key: 'im:dispatcher',
    owner: 'dispatcher',
    composition: COMPOSITION,
    bindings: [{ chat: CHAT_KEY, writable: true, home: true }],
    ...patch,
  }
}

/** Ensure the dispatcher session of the test chat. */
async function ensureShared(harness: CommandsHarness, patch: Partial<ImSessionSpec> = {}): Promise<ImSessionRecord> {
  return harness.base.host.ensure(spec(patch))
}

/** Start a running turn on one session and resolve once its request reached the scripted model. */
async function running(harness: CommandsHarness, record: ImSessionRecord): Promise<Agent> {
  await harness.base.host.deliver(record.key, delivery('followup', 'work', record.key))
  const agent = await harness.base.host.agent(record.sessionId)
  await vi.waitFor(() => { expect(agent.status).toBe('running') })
  return agent
}

/** The content of the last reply, as lines. */
function lines(harness: CommandsHarness): string[] {
  const content = harness.replies.at(-1)?.content
  if (content === undefined) throw new Error('the plugin did not reply')
  return Array.isArray(content) ? content.map(String) : [String(content)]
}

/** The text of the last reply when it is one string. */
function text(harness: CommandsHarness): string {
  const [only, ...rest] = lines(harness)
  expect(rest).toEqual([])
  return only!
}

describe('routing', () => {
  it('ignores messages without a command, and commands in groups that do not address the bot', async () => {
    const harness = await bootCommands()
    const plain = inbound('hello there')
    await harness.receive(plain)
    expect(harness.outcome(plain.id)).toEqual({ kind: 'ignored' })

    const unaddressed = inbound('/stop', { mentions: { self: false, all: false, users: [] } })
    await harness.receive(unaddressed)
    expect(harness.outcome(unaddressed.id)).toEqual({ kind: 'ignored' })
    expect(harness.replies).toEqual([])
  })

  it('answers a direct-chat command without a mention', async () => {
    const harness = await bootCommands()
    const direct = inbound('/help', { chat: { id: 'dm', type: 'direct' }, mentions: { self: false, all: false, users: [] } })
    await harness.receive(direct)
    expect(harness.outcome(direct.id)).toMatchObject({ kind: 'handled', by: BY })
    expect(lines(harness)[0]).toBe('可用命令：')
  })

  it('passes unknown and unconfigured commands to the next listener', async () => {
    const harness = await bootCommands({ commands: { passthrough: ['compact'] } })
    const unknown = inbound('/deploy now')
    await harness.receive(unknown)
    expect(harness.outcome(unknown.id)).toEqual({ kind: 'ignored' })
    expect(harness.replies).toEqual([])
  })

  it('records its outcome so a redelivery of the same event does not run again', async () => {
    const harness = await bootCommands()
    await ensureShared(harness)
    const message = inbound('/status')
    await harness.receive(message)
    expect(harness.outcome(message.id)).toMatchObject({ kind: 'handled', by: BY })
    expect(harness.replies).toHaveLength(1)

    await harness.receive(message)
    expect(harness.replies).toHaveLength(1)
    expect(harness.store.after(CHAT_KEY, 0, 10)).toHaveLength(1)
  })
})

describe('/stop', () => {
  it('stops only the thread-bound session when the message is in that thread', async () => {
    const harness = await bootCommands()
    const shared = await ensureShared(harness)
    const task = await ensureShared(harness, {
      key: 'task:1', owner: 'tasks', bindings: [{ chat: CHAT_KEY, writable: true, home: true, thread: THREAD }],
    })
    const foreign = await harness.base.host.ensure(spec({
      key: 'conv:other', bindings: [{ chat: OTHER_CHAT, writable: true, home: true }],
    }))
    const keep = harness.base.model.gate()
    const sharedAgent = await running(harness, shared)
    const taskAgent = await running(harness, task)
    const foreignAgent = await running(harness, foreign)

    const message = inbound('/stop', { thread: { id: THREAD } })
    await harness.receive(message)

    await taskAgent.whenIdle()
    expect(taskAgent.status).toBe('idle')
    expect(sharedAgent.status).toBe('running')
    expect(foreignAgent.status).toBe('running')
    expect(text(harness)).toBe('已停止 1 个会话。')
    expect(harness.outcome(message.id)).toEqual({ kind: 'handled', by: BY, sessions: [task.sessionId] })

    keep()
    await sharedAgent.whenIdle()
    await foreignAgent.whenIdle()
  })

  it('stops every running session of the chat when no thread owns the message', async () => {
    const harness = await bootCommands()
    const shared = await ensureShared(harness)
    const idle = await ensureShared(harness, { key: 'task:idle', owner: 'tasks', bindings: [{ chat: CHAT_KEY, writable: true }] })
    const task = await ensureShared(harness, {
      key: 'task:2', owner: 'tasks', bindings: [{ chat: CHAT_KEY, writable: true, home: true }],
    })
    const keep = harness.base.model.gate()
    const agents = [await running(harness, shared), await running(harness, task)]

    const message = inbound('/stop')
    await harness.receive(message)

    await Promise.all(agents.map(agent => agent.whenIdle()))
    expect(text(harness)).toBe('已停止 2 个会话。')
    expect(harness.outcome(message.id)).toEqual({
      kind: 'handled', by: BY, sessions: [shared.sessionId, task.sessionId],
    })
    keep()
    void idle
  })

  it('reports nothing to stop when nothing is running', async () => {
    const harness = await bootCommands()
    await ensureShared(harness)
    const message = inbound('/stop')
    await harness.receive(message)
    expect(text(harness)).toBe('没有正在运行的会话。')
    expect(harness.outcome(message.id)).toEqual({ kind: 'handled', by: BY })
  })

  it('falls back to the chat sessions when the thread owns no session', async () => {
    const harness = await bootCommands()
    const shared = await ensureShared(harness)
    const keep = harness.base.model.gate()
    const agent = await running(harness, shared)

    const message = inbound('/stop', { thread: { id: 'th-unknown' } })
    await harness.receive(message)

    await agent.whenIdle()
    expect(text(harness)).toBe('已停止 1 个会话。')
    expect(harness.outcome(message.id)).toEqual({ kind: 'handled', by: BY, sessions: [shared.sessionId] })
    keep()
  })
})

describe('/clear and /new', () => {
  it('resets the resettable home sessions of the chat and leaves other owners alone', async () => {
    const harness = await bootCommands()
    const shared = await ensureShared(harness)
    const oneshot = await ensureShared(harness, {
      key: 'oneshot:1', owner: 'oneshot', bindings: [{ chat: CHAT_KEY, writable: true, home: true }],
    })
    const worker = await ensureShared(harness, {
      key: 'task:1', owner: 'dispatcher', bindings: [{ chat: CHAT_KEY, writable: true }],
    })
    const message = inbound('/clear')
    await harness.receive(message)

    expect(text(harness)).toBe('已重置 1 个会话，下一轮对话将使用新的上下文。')
    expect(harness.base.resets).toEqual([{ record: shared, reason: 'session-commands:/clear' }])
    expect(harness.base.host.get(shared.key)?.generation).toBe(1)
    expect(harness.base.host.get(oneshot.key)).toBe(oneshot)
    expect(harness.base.host.get(worker.key)).toBe(worker)
    expect(harness.outcome(message.id)).toEqual({ kind: 'handled', by: BY, sessions: [shared.sessionId] })
  })

  it('names the command in the reset reason and reports when nothing is resettable', async () => {
    const harness = await bootCommands({ commands: { resettable: [] } })
    await ensureShared(harness)
    const nothing = inbound('/new')
    await harness.receive(nothing)
    expect(text(harness)).toBe('没有可重置的会话。')
    expect(harness.base.resets).toEqual([])

    const other = await bootCommands()
    const record = await ensureShared(other)
    const reset = inbound('/new')
    await other.receive(reset)
    expect(other.base.resets).toEqual([{ record, reason: 'session-commands:/new' }])
  })
})

describe('/status', () => {
  it('reports an idle session, its age and its empty queue', async () => {
    const harness = await bootCommands()
    const record = await ensureShared(harness)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const base = Date.now()
      vi.setSystemTime(base + 5_000)
      const seconds = inbound('/status')
      await harness.receive(seconds)
      expect(lines(harness)).toEqual([
        `会话：${record.sessionId}`, '模型：mock', '状态：空闲', '排队消息：0', '最近活动：5 秒前',
      ])
      expect(harness.base.model.requests).toEqual([])

      vi.setSystemTime(base + 90_000)
      await harness.receive(inbound('/status'))
      expect(lines(harness).at(-1)).toBe('最近活动：1 分钟前')

      vi.setSystemTime(base + 3_700_000)
      await harness.receive(inbound('/status'))
      expect(lines(harness).at(-1)).toBe('最近活动：1 小时前')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a running session and the deliveries queued behind its turn', async () => {
    const harness = await bootCommands()
    const record = await ensureShared(harness)
    const keep = harness.base.model.gate()
    const agent = await running(harness, record)
    await harness.base.host.deliver(record.key, delivery('followup', 'later', 'later'))

    const message = inbound('/status')
    await harness.receive(message)
    expect(lines(harness).slice(2, 4)).toEqual(['状态：运行中', '排队消息：1'])
    expect(harness.outcome(message.id)).toEqual({ kind: 'handled', by: BY, sessions: [record.sessionId] })
    keep()
    await agent.whenIdle()
  })

  it('reports a chat without a session', async () => {
    const harness = await bootCommands()
    await harness.receive(inbound('/status'))
    expect(text(harness)).toBe('当前聊天还没有会话。')
  })
})

describe('/help', () => {
  it('lists the built-ins plus the registered passthrough commands', async () => {
    const harness = await bootCommands({ commands: { passthrough: ['compact'] } })
    await ensureShared(harness)
    harness.ctx.commands.register({ name: 'compact', description: 'Compact history', handler: () => ({ kind: 'success' }) })
    harness.ctx.commands.register({ name: 'other', description: 'Not exposed', handler: () => ({ kind: 'success' }) })

    const message = inbound('/help')
    await harness.receive(message)
    const listed = lines(harness)
    expect(listed[0]).toBe('可用命令：')
    expect(listed).toContain('/stop — 停止正在运行的会话')
    expect(listed).toContain('/help — 显示这个帮助')
    expect(listed).toContain('/compact — Compact history')
    expect(listed).not.toContain('/other — Not exposed')
    expect(harness.outcome(message.id)).toMatchObject({ kind: 'handled', by: BY })
  })

  it('lists configured passthrough names even without a session', async () => {
    const harness = await bootCommands({ commands: { passthrough: ['compact', 'ghost', 'status'] } })
    await harness.receive(inbound('/help'))
    const listed = lines(harness)
    expect(listed).toContain('/compact')
    expect(listed).toContain('/ghost')
    expect(listed.filter(line => line.includes(' — '))).toHaveLength(5)
    // A configured name that is also built in is described once, by the built-in entry.
    expect(listed.filter(line => line === '/status')).toHaveLength(0)
  })
})

describe('passthrough', () => {
  it('executes the registered command on the home session with the typed input', async () => {
    const harness = await bootCommands()
    const record = await ensureShared(harness)
    const seen: { agent: Agent; rawInput: string; signal: AbortSignal }[] = []
    harness.ctx.commands.register({
      name: 'compact',
      description: 'Compact history',
      handler: (invocation) => {
        seen.push({ agent: invocation.agent, rawInput: invocation.rawInput, signal: invocation.signal })
        return { kind: 'success', text: 'Compacted 3 items.' }
      },
    })

    const message = inbound('/compact  keep the summary')
    await harness.receive(message)

    expect(seen).toHaveLength(1)
    expect(seen[0]!.agent.id).toBe(record.sessionId)
    expect(seen[0]!.rawInput).toBe('  keep the summary')
    expect(seen[0]!.signal.aborted).toBe(false)
    expect(text(harness)).toBe('Compacted 3 items.')
    expect(harness.outcome(message.id)).toEqual({ kind: 'handled', by: BY, sessions: [record.sessionId] })
    expect(seen[0]!.agent.session.snapshotEvents().map(event => event.type))
      .toContain('command/run')
  })

  it('relays the failure text of a failing command', async () => {
    const harness = await bootCommands()
    await ensureShared(harness)
    harness.ctx.commands.register({
      name: 'compact', description: 'Compact history', handler: () => ({ kind: 'error', text: 'nothing to compact' }),
    })
    await harness.receive(inbound('/compact'))
    expect(text(harness)).toBe('nothing to compact')
  })

  it('reports a silent success', async () => {
    const harness = await bootCommands()
    await ensureShared(harness)
    harness.ctx.commands.register({ name: 'compact', description: 'Compact history', handler: () => ({ kind: 'success' }) })
    await harness.receive(inbound('/compact'))
    expect(text(harness)).toBe('已完成。')
  })

  it('passes a configured but unregistered name on to the next listener', async () => {
    const harness = await bootCommands({ commands: { passthrough: ['ghost'] } })
    await ensureShared(harness)
    const message = inbound('/ghost')
    await harness.receive(message)
    expect(harness.outcome(message.id)).toEqual({ kind: 'ignored' })
    expect(harness.replies).toEqual([])
  })

  it('reports when the chat has no session to run the command on', async () => {
    const harness = await bootCommands()
    await harness.receive(inbound('/compact'))
    expect(text(harness)).toBe('当前聊天还没有会话。')
  })
})

describe('permissions', () => {
  it('restricts privileged commands to the configured admins', async () => {
    const harness = await bootCommands({
      commands: { allow: 'admins', admins: ['admin-user', 'fake:bot|other-user'] },
    })
    await ensureShared(harness)

    const denied = inbound('/stop')
    await harness.receive(denied)
    expect(text(harness)).toBe('你没有权限执行这个命令。')
    expect(harness.outcome(denied.id)).toEqual({ kind: 'handled', by: BY })

    await harness.receive(inbound('/status'))
    expect(lines(harness)[2]).toBe('状态：空闲')

    await harness.receive(inbound('/stop', { sender: { id: 'admin-user', name: 'Admin' } }))
    expect(text(harness)).toBe('没有正在运行的会话。')

    await harness.receive(inbound('/clear', { sender: { id: 'other-user', name: 'Other' } }))
    expect(text(harness)).toBe('已重置 1 个会话，下一轮对话将使用新的上下文。')
  })

  it('lets every sender act by default', async () => {
    const harness = await bootCommands()
    await ensureShared(harness)
    await harness.receive(inbound('/clear'))
    expect(harness.base.resets).toHaveLength(1)
  })
})

describe('locale', () => {
  it('answers in English when configured', async () => {
    const harness = await bootCommands({ commands: { locale: 'en' } })
    await ensureShared(harness)
    await harness.receive(inbound('/stop'))
    expect(text(harness)).toBe('No session is running.')
    await harness.receive(inbound('/help'))
    expect(lines(harness)).toContain('/stop — Stop the running session')
    await harness.receive(inbound('/clear'))
    expect(text(harness)).toBe('Reset 1 session(s); the next turn starts from a fresh context.')
    await harness.receive(inbound('/status'))
    expect(lines(harness)[2]).toBe('State: idle')
  })
})

describe('lifecycle', () => {
  it('aborts in-flight passthrough commands when the plugin is disposed', async () => {
    const harness = await bootCommands()
    await ensureShared(harness)
    const signals: AbortSignal[] = []
    harness.ctx.commands.register({
      name: 'compact',
      description: 'Compact history',
      handler: (invocation) => {
        signals.push(invocation.signal)
        return { kind: 'success', text: 'done' }
      },
    })
    await harness.receive(inbound('/compact'))
    expect(signals[0]!.aborted).toBe(false)
    await harness.close()
    expect(signals[0]!.aborted).toBe(true)
  })
})
