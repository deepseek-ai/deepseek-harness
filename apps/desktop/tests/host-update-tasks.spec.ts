import { Context } from '@deepseek-ai/cordis'
import { JobId, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { JobStatus, JobView } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installDesktopUpdateTaskControl } from '../../desktop-host/src/update-tasks.ts'

type AgentState = { id: SessionId; status: 'idle' | 'running'; inbox: { nextTurn: object[]; nextStep: object[] } }

let ctx: Context
let inspect: ReturnType<typeof installDesktopUpdateTaskControl>
const agents: AgentState[] = []
const jobs = new Map<SessionId | undefined, JobStatus[]>()

/** A registry whose only served member is the per-owner roster the inspector reads. */
class RosterOnlyJobRegistry extends JobRegistry {
  readonly events = { subscribe: () => () => {} }
  start(): never { throw new Error('unsupported') }
  list(caller?: SessionId): JobView[] {
    return (jobs.get(caller) ?? []).map((status, index) => ({
      id: JobId(`bash-${index + 1}`),
      kind: 'bash',
      label: 'sleep 60',
      ...caller === undefined ? {} : { owner: caller },
      status,
      startedAt: 0,
      output: { total: 0, earliest: 0 },
    }))
  }
  get(): never { throw new Error('unsupported') }
  read(): never { throw new Error('unsupported') }
  readAt(): never { throw new Error('unsupported') }
  kill(): never { throw new Error('unsupported') }
  wait(): never { throw new Error('unsupported') }
  remove(): never { throw new Error('unsupported') }
  attachController(): () => void { return () => {} }
}

beforeEach(() => {
  agents.length = 0
  jobs.clear()
  ctx = new Context()
  // Narrow service doubles exercise the inspector against a real Cordis event lifecycle.
  ctx.provide('agents', { list: () => agents } as unknown as Context['agents'])
  new RosterOnlyJobRegistry(ctx)
  inspect = installDesktopUpdateTaskControl(ctx)
})

afterEach(async () => { await ctx.fiber.dispose() })

function idleAgent(): AgentState { return { id: SessionId('update-task-owner'), status: 'idle', inbox: { nextTurn: [], nextStep: [] } } }

function request(next: () => Promise<void>) {
  const incoming = Readable.from([]) as IncomingMessage
  const response = { writeHead: vi.fn(), end: vi.fn() }
  return { response, done: ctx.waterfall('connection/request', incoming, response as unknown as ServerResponse, next) }
}

describe('Desktop Host update task protection', () => {
  it.each(['running', 'nextTurn', 'nextStep'] as const)('counts %s agent work without stopping it', async (kind) => {
    const agent = idleAgent()
    if (kind === 'running') agent.status = 'running'
    else agent.inbox[kind].push({ queued: true })
    agents.push(agent)
    expect(await inspect('inspect')).toBe(true)
    agent.status = 'idle'
    agent.inbox.nextTurn.length = 0
    agent.inbox.nextStep.length = 0
    expect(await inspect('inspect')).toBe(false)
  })

  it.each(['running', 'stopping'] as const)('counts global and agent-owned %s jobs', async (status) => {
    const agent = idleAgent()
    agents.push(agent)
    for (const owner of [undefined, agent.id]) {
      jobs.set(owner, [status])
      expect(await inspect('inspect')).toBe(true)
      jobs.set(owner, ['completed'])
      expect(await inspect('inspect')).toBe(false)
    }
  })

  it('does not warn for reads but drains admitted requests before completing the lock', async () => {
    const entered = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    const next = vi.fn(async () => { entered.resolve(undefined); await finish.promise })
    const pending = request(next)
    try {
      await entered.promise
      expect(await inspect('inspect')).toBe(false)
      let drained = false
      const locking = inspect('lock').then((active) => { drained = true; return active })
      const refused = request(next)
      await refused.done
      expect(refused.response.writeHead).toHaveBeenCalledWith(503)
      expect(refused.response.end).toHaveBeenCalledOnce()
      expect(next).toHaveBeenCalledOnce()
      expect(drained).toBe(false)
      finish.resolve(undefined)
      expect(await locking).toBe(false)
      expect(await inspect('unlock')).toBe(false)
      const admitted = vi.fn(async () => {})
      await request(admitted).done
      expect(admitted).toHaveBeenCalledOnce()
    } finally {
      finish.resolve(undefined)
      await pending.done
    }
    expect(await inspect('inspect')).toBe(false)
  })

  it('detects task creation by an admitted write before handing off the lock', async () => {
    const entered = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    const pending = request(async () => {
      entered.resolve(undefined)
      await finish.promise
      const agent = idleAgent()
      agent.inbox.nextTurn.push({ queued: true })
      agents.push(agent)
    })
    try {
      await entered.promise
      expect(await inspect('inspect')).toBe(false)
      const locking = inspect('lock')
      finish.resolve(undefined)
      expect(await locking).toBe(true)
    } finally { finish.resolve(undefined); await pending.done }
  })

  it.each(['unlock', 'dispose'] as const)('rejects a draining lock invalidated by %s', async (action) => {
    const entered = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    const pending = request(async () => { entered.resolve(undefined); await finish.promise })
    try {
      await entered.promise
      const locking = inspect('lock')
      const rejected = expect(locking).rejects.toThrow(action === 'unlock' ? 'lock was superseded' : 'Host is stopping')
      if (action === 'unlock') await inspect('unlock')
      else await ctx.fiber.dispose()
      finish.resolve(undefined)
      await rejected
    } finally { finish.resolve(undefined); await pending.done }
  })

  it('releases request accounting when the bridge rejects', async () => {
    await expect(request(async () => { throw new Error('disconnected') }).done).rejects.toThrow('disconnected')
    expect(await inspect('inspect')).toBe(false)
  })

  it('removes admission on disposal and refuses further inspection', async () => {
    expect(await inspect('lock')).toBe(false)
    await ctx.fiber.dispose()
    const next = vi.fn(async () => {})
    await request(next).done
    expect(next).toHaveBeenCalledOnce()
    await expect(inspect('inspect')).rejects.toThrow('Host is stopping')
  })

  it('does not classify unavailable task services as idle', async () => {
    const empty = new Context()
    try {
      const unavailable = installDesktopUpdateTaskControl(empty)
      await expect(unavailable('lock')).rejects.toThrow('task services are unavailable')
    } finally { await empty.fiber.dispose() }
  })
})
