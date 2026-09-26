import { Context } from '@deepseek-ai/cordis'
import { JobId, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { JobStatus, JobView } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installDesktopQuitInspection } from '../src/quit-inspection.ts'

type AgentState = { id: SessionId; status: 'idle' | 'running'; inbox: { nextTurn: object[]; nextStep: object[] } }

let ctx: Context
let inspect: ReturnType<typeof installDesktopQuitInspection>
const agents: AgentState[] = []
const jobs = new Map<SessionId | undefined, JobStatus[]>()
/** Activity each provider family reports per session; the inspector must count only `schedule`. */
const activity = new Map<SessionId, SessionActivity[]>()

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

function agent(id: string, status: 'idle' | 'running' = 'idle'): AgentState {
  return { id: SessionId(id), status, inbox: { nextTurn: [], nextStep: [] } }
}

beforeEach(() => {
  agents.length = 0
  jobs.clear()
  activity.clear()
  ctx = new Context()
  // Narrow service doubles exercise the inspector against a real Cordis event lifecycle.
  ctx.provide('agents', { list: () => agents } as never)
  new RosterOnlyJobRegistry(ctx)
  ctx.on('workspace/session-activity', async ({ sessionId }, next) => [...activity.get(sessionId) ?? [], ...await next()])
  inspect = installDesktopQuitInspection(ctx)
})

afterEach(async () => { await ctx.fiber.dispose() })

describe('Desktop Host quit inspection', () => {
  it('reports neither active nor scheduled work for idle loaded sessions', async () => {
    agents.push(agent('quiet'))
    activity.set(SessionId('quiet'), [{ kind: 'turn' }])
    expect(await inspect()).toEqual({ activeTasks: false, scheduledTasks: false })
  })

  it.each(['running', 'nextTurn', 'nextStep', 'job'] as const)('counts %s work with the same rule as the update restart check', async (kind) => {
    const owner = agent('busy')
    if (kind === 'running') owner.status = 'running'
    else if (kind === 'job') jobs.set(owner.id, ['stopping'])
    else owner.inbox[kind].push({ queued: true })
    agents.push(owner)
    expect(await inspect()).toEqual({ activeTasks: true, scheduledTasks: false })
  })

  it('counts an armed schedule family in any loaded session and stops at the first one', async () => {
    const asked: SessionId[] = []
    ctx.on('workspace/session-activity', async ({ sessionId }, next) => { asked.push(sessionId); return next() })
    agents.push(agent('first'), agent('second'), agent('third'))
    activity.set(SessionId('second'), [{ kind: 'schedule', items: [{ id: 'reminder-1', label: 'stand-up' }] }])
    expect(await inspect()).toEqual({ activeTasks: false, scheduledTasks: true })
    expect(asked).toEqual([SessionId('first'), SessionId('second')])
  })

  it('reports both when a running session also holds a reminder', async () => {
    agents.push(agent('both', 'running'))
    activity.set(SessionId('both'), [{ kind: 'job', items: [{ id: 'bash-1' }] }, { kind: 'schedule', items: [{ id: 'reminder-2' }] }])
    expect(await inspect()).toEqual({ activeTasks: true, scheduledTasks: true })
  })

  it('does not classify unavailable task services as idle', async () => {
    const empty = new Context()
    try {
      await expect(installDesktopQuitInspection(empty)()).rejects.toThrow('task services are unavailable')
    } finally { await empty.fiber.dispose() }
  })

  it('refuses inspection after disposal', async () => {
    expect(await inspect()).toEqual({ activeTasks: false, scheduledTasks: false })
    await ctx.fiber.dispose()
    await expect(inspect()).rejects.toThrow('Host is stopping')
  })
})
