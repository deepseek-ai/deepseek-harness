/**
 * Behaviour of the session-commands plugin: the addressed gate, `/stop` thread selection, `/clear`+`/new` resets,
 * `/status`, `/help`, dsh command passthrough, permissions, locale and the redelivery contract of the core waterfall.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { h, normalize } from '@deepseek-ai/cordis-plugin-im-core'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImMessageEvent, ImSessionRecord, ImSessionSpec } from '@deepseek-ai/dsh-im/src/api.ts'
import { ImChatKey, ImMessageKey, ImSourceId } from '@deepseek-ai/dsh-im/src/api.ts'
import { BY } from '../src/commands.ts'
import { Config } from '../src/config.ts'
import * as sessionCommandsPlugin from '../src/index.ts'
import { boot, COMPOSITION, delivery } from '../../im/tests/support/sessions-harness.ts'
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
  return String(content).split('\n')
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
    expect(normalize(harness.replies.at(-1)!.content).children.map(String).join('')).toContain('可用命令：\n/')
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

  it('replays the original /stop reply and outcome when store.settle fails after stopping the session', async () => {
    const harness = await bootCommands()
    const shared = await ensureShared(harness)
    const keep = harness.base.model.gate()
    const agent = await running(harness, shared)

    const settle = harness.store.settle.bind(harness.store)
    let failOnce = true
    vi.spyOn(harness.store, 'settle').mockImplementation(async (key, outcome) => {
      if (failOnce) {
        failOnce = false
        throw new Error('settle blip')
      }
      return settle(key, outcome)
    })

    const stopMsg = inbound('/stop')
    await harness.receive(stopMsg)
    await agent.whenIdle()
    expect(harness.outcome(stopMsg.id)).toBeUndefined()
    expect(harness.replies).toHaveLength(1)
    expect(text(harness)).toBe('已停止 1 个会话。')

    // The session is now idle; pumping the pending `/stop` replays the persisted reply instead of recomputing
    // `'没有正在运行的会话。'` (which would fail `ImSender` with an `operationId` conflict and wedge the chat).
    harness.intake.pump()
    await harness.intake.idle()
    expect(harness.replies).toHaveLength(1)
    expect(harness.outcome(stopMsg.id)).toEqual({ kind: 'handled', by: BY, sessions: [shared.sessionId] })

    // Subsequent messages in the chat drain normally behind the settled command.
    const followUp = inbound('/status')
    await harness.receive(followUp)
    expect(harness.outcome(followUp.id)).toEqual({ kind: 'handled', by: BY, sessions: [shared.sessionId] })
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

  it('retries an unsettled /clear without resetting a newer generation or publishing a second reply', async () => {
    const harness = await bootCommands()
    const shared = await ensureShared(harness)

    // The reset and reply succeed on the first attempt, then `store.settle` fails so the command stays pending.
    const settle = harness.store.settle.bind(harness.store)
    let failOnce = true
    vi.spyOn(harness.store, 'settle').mockImplementation(async (key, outcome) => {
      if (failOnce) {
        failOnce = false
        throw new Error('storage blip')
      }
      return settle(key, outcome)
    })

    const clear = inbound('/clear')
    await harness.receive(clear)
    expect(harness.outcome(clear.id)).toBeUndefined()
    const gen1 = harness.base.host.get(shared.key)!
    expect(gen1.generation).toBe(1)
    expect(harness.replies).toHaveLength(1)
    expect(harness.replies[0]?.options).toEqual({ operationId: `${BY}:reply:fake:bot|${clear.id}` })

    // Another chat bound to the shared session starts a turn on generation 1 before the intake retries `/clear`.
    const keep = harness.base.model.gate()
    const gen1Agent = await running(harness, gen1)

    harness.intake.pump()
    await harness.intake.idle()

    expect(harness.base.host.get(shared.key)?.generation).toBe(1)
    expect(gen1Agent.status).toBe('running')
    expect(harness.replies).toHaveLength(1)
    expect(harness.outcome(clear.id)).toEqual({ kind: 'handled', by: BY, sessions: [shared.sessionId] })

    keep()
    await gen1Agent.whenIdle()
  })

  it('leaves a newly advanced generation alone when an in-flight reset finishes ahead of /clear', async () => {
    const harness = await bootCommands()
    const shared = await ensureShared(harness)
    const dispose = harness.base.agents.dispose.bind(harness.base.agents)
    let releaseDispose = (): void => {}
    const held = new Promise<void>((resolve) => { releaseDispose = resolve })
    const slow = vi.spyOn(harness.base.agents, 'dispose').mockImplementationOnce(async (sessionId) => {
      await held
      await dispose(sessionId)
    })

    // Start an earlier reset and hold it inside `dispose` so `forChat` still sees generation 0 when `/clear` arrives.
    const earlier = harness.base.host.reset(shared.key, 'earlier')
    await vi.waitFor(() => { expect(slow).toHaveBeenCalled() })

    const clear = inbound('/clear')
    const receiving = harness.receive(clear)
    await new Promise(resolve => setTimeout(resolve, 10))
    releaseDispose()
    await Promise.all([earlier, receiving])

    expect(harness.base.host.get(shared.key)?.generation).toBe(1)
    expect(harness.base.resets).toHaveLength(1)
    expect(text(harness)).toBe('没有可重置的会话。')
    expect(harness.outcome(clear.id)).toEqual({ kind: 'handled', by: BY })
    slow.mockRestore()
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

  it('replays persisted command receipts across restarts and prunes receipts older than retentionMs', async () => {
    const first = await bootCommands({ commands: { retentionMs: 60_000 } })
    const shared = await ensureShared(first)
    const expiredHelp = inbound('/help')
    await first.receive(expiredHelp)

    const keep = first.base.model.gate()
    const agent = await running(first, shared)
    const settle = first.store.settle.bind(first.store)
    let failOnce = true
    vi.spyOn(first.store, 'settle').mockImplementation(async (key, outcome) => {
      if (failOnce) {
        failOnce = false
        throw new Error('crash before settle')
      }
      return settle(key, outcome)
    })

    const pendingStop = inbound('/stop')
    await first.receive(pendingStop)
    await agent.whenIdle()
    keep()
    expect(first.outcome(pendingStop.id)).toBeUndefined()

    const commandsTable = first.base.pool.media.get('im_session_commands')?.tables.get('commands')
    const expiredKey = ImMessageKey('fake:bot', expiredHelp.id)
    const stopKey = ImMessageKey('fake:bot', pendingStop.id)
    expect(commandsTable?.has(expiredKey)).toBe(true)
    expect(commandsTable?.has(stopKey)).toBe(true)
    commandsTable?.set(expiredKey, {
      ...(commandsTable.get(expiredKey) as Record<string, unknown>),
      createdAt: 0,
    })
    await first.close()

    const second = await bootCommands({
      pool: first.base.pool,
      root: first.base.root,
      commands: { retentionMs: 60_000 },
    })
    second.intake.pump()
    await second.intake.idle()

    const reopenedTable = second.base.pool.media.get('im_session_commands')?.tables.get('commands')
    expect(reopenedTable?.has(expiredKey)).toBe(false)
    expect(reopenedTable?.has(stopKey)).toBe(true)
    expect(second.outcome(pendingStop.id)).toEqual({ kind: 'handled', by: BY, sessions: [shared.sessionId] })
    expect(text(second)).toBe('已停止 1 个会话。')
  })

  it('settles a pending command receipt as unknown on replay without re-running /stop on a newer turn', async () => {
    const first = await bootCommands()
    const shared = await ensureShared(first)
    const stopFrame = inbound('/stop')
    const stopKey = ImMessageKey('fake:bot', stopFrame.id)

    // Fail `store.settle` so the message stays pending in `im_messages`, and leave the command receipt `pending`
    // (as if the process crashed after persisting intent and running `/stop`, before `done` could be written).
    vi.spyOn(first.store, 'settle').mockRejectedValueOnce(new Error('crash before settle'))
    await first.receive(stopFrame)
    await first.intake.idle()
    first.base.pool.media.get('im_session_commands')?.tables.get('commands')?.set(stopKey, {
      status: 'pending',
      reply: '',
      sessions: [shared.sessionId],
      createdAt: Date.now(),
    })
    await first.close()

    const second = await bootCommands({
      pool: first.base.pool,
      root: first.base.root,
      commands: { retentionMs: 60_000 },
    })
    const stopSpy = vi.spyOn(second.base.ctx.im.sessions, 'stop')
    second.intake.pump()
    await second.intake.idle()

    expect(stopSpy).not.toHaveBeenCalled()
    expect(second.outcome(stopFrame.id)).toEqual({ kind: 'handled', by: BY, sessions: [shared.sessionId] })
    expect(text(second)).toContain('结果未知')
    expect(second.base.pool.media.get('im_session_commands')?.tables.get('commands')?.get(stopKey)).toMatchObject({
      status: 'done',
    })
  })

  it('prunes expired pending receipts on reopen so they are not settled as interrupted', async () => {
    const first = await bootCommands()
    const shared = await ensureShared(first)
    const stopFrame = inbound('/stop')
    const stopKey = ImMessageKey('fake:bot', stopFrame.id)

    vi.spyOn(first.store, 'settle').mockRejectedValueOnce(new Error('crash before settle'))
    await first.receive(stopFrame)
    await first.intake.idle()
    first.base.pool.media.get('im_session_commands')?.tables.get('commands')?.set(stopKey, {
      status: 'pending',
      reply: '',
      sessions: [shared.sessionId],
      createdAt: 0,
    })
    await first.close()

    const second = await bootCommands({
      pool: first.base.pool,
      root: first.base.root,
      commands: { retentionMs: 60_000 },
    })
    // Reopening pruned the expired `pending` row; re-running `/stop` executes cleanly instead of replying interrupted.
    second.intake.pump()
    await second.intake.idle()
    expect(text(second)).toBe('没有正在运行的会话。')
  })

  it('rolls back the pending receipt when passthrough execute() returns undefined so retries pass through', async () => {
    const harness = await bootCommands({
      commands: { passthrough: ['compact'] },
    })
    harness.ctx.commands.register({ name: 'compact', description: 'Compact context', handler: () => ({ kind: 'success' }) })
    await ensureShared(harness)
    // Simulate a command disappearing between `list(agent)` and `execute(...)`.
    vi.spyOn(harness.base.ctx.commands, 'execute').mockResolvedValue(undefined)

    const msg = inbound('/compact')
    await harness.receive(msg)
    const key = ImMessageKey('fake:bot', msg.id)
    expect(harness.base.pool.media.get('im_session_commands')?.tables.get('commands')?.get(key)).toBeUndefined()
    expect(harness.outcome(msg.id)).toEqual({ kind: 'ignored' })
  })

  it('serializes concurrent dispatches of one message key and recovers after a reply failure', async () => {
    const harness = await bootCommands()
    await ensureShared(harness)
    const seenReplies: unknown[] = []
    let releaseFirstReply!: () => void
    const firstReplyGate = new Promise<void>((resolve) => { releaseFirstReply = resolve })
    let calls = 0

    const makeEvent = (
      key: string,
      commandName: string,
      replyImpl: (content: unknown) => Promise<{ status: 'confirmed' }>,
    ): ImMessageEvent => ({
      message: {
        key: ImMessageKey('fake:bot', key),
        seq: 1,
        chat: { key: CHAT_KEY, bot: 'fake:bot', ref: CHAT, source: ImSourceId('team') },
        sender: { id: 'user-1', name: 'User', self: false },
        content: h('message', h.text(`/${commandName}`)),
        text: `/${commandName}`,
        mentions: { self: true, all: false, users: [] },
        addressed: true,
        command: { name: commandName, rawInput: '' },
        time: 1000,
        via: 'platform',
      },
      source: { id: 'team', bot: 'fake:bot', writable: true, store: 'all' },
      bot: harness.bot,
      reply: replyImpl,
      send: replyImpl,
      deliver: async () => {},
    })

    const concurrentEvent = makeEvent('m-concurrent', 'status', async (content) => {
      calls++
      if (calls === 1) await firstReplyGate
      seenReplies.push(content)
      return { status: 'confirmed' }
    })
    const firstRun = harness.ctx.waterfall('im/message', concurrentEvent, async () => ({ kind: 'ignored' }))
    const secondRun = harness.ctx.waterfall('im/message', concurrentEvent, async () => ({ kind: 'ignored' }))
    await vi.waitFor(() => { expect(calls).toBe(1) })
    releaseFirstReply()
    const [out1, out2] = await Promise.all([firstRun, secondRun])
    expect(out1.kind).toBe('handled')
    expect(out2.kind).toBe('handled')
    expect(seenReplies).toHaveLength(2)
    expect(seenReplies[0]).toEqual(seenReplies[1])

    // A transient reply rejection releases the message chain cleanly so the next attempt replays the saved receipt.
    let failReply = true
    const flakyEvent = makeEvent('m-flaky-reply', 'status', async () => {
      if (failReply) {
        failReply = false
        throw new Error('network down')
      }
      return { status: 'confirmed' }
    })
    await expect(harness.ctx.waterfall('im/message', flakyEvent, async () => ({ kind: 'ignored' })))
      .rejects.toThrow(/network down/)
    await expect(harness.ctx.waterfall('im/message', flakyEvent, async () => ({ kind: 'ignored' })))
      .resolves.toMatchObject({ kind: 'handled', by: BY })
  })

  it('propagates receipt-store open failures to both plugin startup and waiting dispatches', async () => {
    const base = await bootCommands()
    const ctx = new Context()
    let enteredOpen!: () => void
    const openEntered = new Promise<void>((resolve) => { enteredOpen = resolve })
    let rejectOpen!: (error: Error) => void
    const openGate = new Promise<never>((_resolve, reject) => { rejectOpen = reject })
    ctx.provide('im', { sessions: { forChat: () => [] } })
    ctx.provide('commands', { list: () => [] })
    ctx.provide('agents', {} as Context['agents'])
    ctx.provide('storageDomain', {
      open: async () => {
        enteredOpen()
        return openGate
      },
    })

    const mounting = ctx.plugin(sessionCommandsPlugin, Config({}))
    await openEntered
    const earlyEvent: ImMessageEvent = {
      message: {
        key: ImMessageKey('fake:bot', 'm-early-fail'),
        seq: 1,
        chat: { key: CHAT_KEY, bot: 'fake:bot', ref: CHAT, source: ImSourceId('team') },
        sender: { id: 'user-1', name: 'User', self: false },
        content: h('message', h.text('/help')),
        text: '/help',
        mentions: { self: true, all: false, users: [] },
        addressed: true,
        command: { name: 'help', rawInput: '' },
        time: 1000,
        via: 'platform',
      },
      source: { id: 'team', bot: 'fake:bot', writable: true, store: 'all' },
      bot: base.bot,
      reply: async () => ({ status: 'confirmed' }),
      send: async () => ({ status: 'confirmed' }),
      deliver: async () => {},
    }
    const earlyDispatch = ctx.waterfall('im/message', earlyEvent, async () => ({ kind: 'ignored' }))

    rejectOpen(new Error('receipt db offline'))
    await expect(mounting).rejects.toThrow(/receipt db offline/)
    await expect(earlyDispatch).rejects.toThrow(/receipt db offline/)
    await ctx.fiber.dispose()
  })

  it('closes the receipt domain and allows clean remount when unloaded while storageDomain.open is pending', async () => {
    const base = await boot({ withoutStart: true })
    const ctx = base.ctx
    ctx.provide('im', { sessions: { forChat: () => [] } })
    ctx.provide('commands', { list: () => [] })

    const realOpen = ctx.storageDomain.open.bind(ctx.storageDomain)
    let enteredOpen!: () => void
    const openEntered = new Promise<void>((resolve) => { enteredOpen = resolve })
    let releaseOpen!: () => void
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve })
    let pauseFirstOpen = true
    vi.spyOn(ctx.storageDomain, 'open').mockImplementation(async (spec) => {
      const opened = await realOpen(spec)
      if (pauseFirstOpen) {
        pauseFirstOpen = false
        enteredOpen()
        await openGate
      }
      return opened
    })

    const sub = ctx.plugin(sessionCommandsPlugin, Config({}))
    await openEntered
    const disposing = sub.dispose()
    releaseOpen()
    await disposing

    // The domain opened during the cancelled startup was closed, so mounting again succeeds without `already-open`.
    const remounted = await ctx.plugin(sessionCommandsPlugin, Config({}))
    await remounted.dispose()
    await ctx.fiber.dispose()
  })

  it('settles ready and unblocks in-flight handle calls even when domain.close() throws during startup failure', async () => {
    const base = await boot({ withoutStart: true })
    const ctx = base.ctx
    ctx.provide('im', { sessions: { forChat: () => [] } })
    ctx.provide('commands', { list: () => [] })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    const realOpen = ctx.storageDomain.open.bind(ctx.storageDomain)
    let releasePrune!: () => void
    const pruneGate = new Promise<void>((resolve) => { releasePrune = resolve })
    let enteredPrune!: () => void
    const pruneEntered = new Promise<void>((resolve) => { enteredPrune = resolve })
    vi.spyOn(ctx.storageDomain, 'open').mockImplementation(async (spec) => {
      const domain = await realOpen(spec)
      vi.spyOn(domain, 'table').mockImplementation(() => ({
        entries: () => {
          enteredPrune()
          throw new Error('corrupt receipts table')
        },
        delete: async () => {
          await pruneGate
        },
      }) as never)
      vi.spyOn(domain, 'close').mockRejectedValue(new Error('close failed'))
      return domain
    })

    const sub = ctx.plugin(sessionCommandsPlugin, Config({}))
    await pruneEntered
    const earlyEvent: ImMessageEvent = {
      message: {
        key: ImMessageKey('fake:bot', 'early-close-err'),
        seq: 1,
        chat: { key: CHAT_KEY, bot: 'fake:bot', ref: CHAT, source: ImSourceId('team') },
        sender: { id: 'user-1', name: 'User', self: false },
        content: h('message', h.text('/help')),
        text: '/help',
        mentions: { self: true, all: false, users: [] },
        addressed: true,
        command: { name: 'help', rawInput: '' },
        time: 1000,
        via: 'platform',
      },
      source: { id: 'team', bot: 'fake:bot', writable: true, store: 'all' },
      bot: {} as ImMessageEvent['bot'],
      reply: async () => ({ status: 'confirmed' }),
      send: async () => ({ status: 'confirmed' }),
      deliver: async () => {},
    }
    const earlyDispatch = ctx.waterfall('im/message', earlyEvent, async () => ({ kind: 'ignored' }))
    releasePrune()

    await expect(sub).rejects.toThrow(/corrupt receipts table/)
    await expect(earlyDispatch).rejects.toThrow(/corrupt receipts table/)
    expect(warn).toHaveBeenCalledWith(
      'Failed to close IM session-commands domain after startup failure: %s',
      expect.stringContaining('close failed'),
    )
    warn.mockRestore()
    await ctx.fiber.dispose()
  })
})
