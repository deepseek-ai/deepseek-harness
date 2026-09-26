import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { JobId, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { JobEvents, JobOutputRead, JobRead, JobSpec, JobStatus, JobView } from '@deepseek-ai/dsh-jobs'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace'

interface Row {
  readonly id: string
  readonly label: string
  readonly owner?: SessionId
  status: JobStatus
}

/**
 * A registry whose listing the test scripts: the seam's archive-admission
 * listeners are driven through the abstract `list` and `kill` alone.
 */
class ScriptedJobRegistry extends JobRegistry {
  readonly rows: Row[] = []
  readonly kills: [JobId, SessionId | undefined, string | undefined][] = []
  refusing: string | undefined

  readonly events: JobEvents = { subscribe: () => () => {} }

  start(_spec: JobSpec): JobId {
    throw new Error('not scripted')
  }

  list(caller?: SessionId): JobView[] {
    return this.rows
      .filter(row => row.owner === undefined || row.owner === caller)
      .map(row => this.view(row))
  }

  get(id: JobId): JobView {
    const row = this.rows.find(candidate => candidate.id === id)
    if (row === undefined) throw new Error(`unknown job ${id}`)
    return this.view(row)
  }

  read(id: JobId): JobRead {
    return { chunks: [], lossy: false, job: this.get(id) }
  }

  readAt(_id: JobId, from: number): JobOutputRead {
    return { chunks: [], next: from, lossy: false }
  }

  kill(id: JobId, caller?: SessionId, reason?: string): 'requested' | 'already-finished' {
    if (id === this.refusing) throw new Error('producer refuses cancel')
    this.kills.push([id, caller, reason])
    const row = this.rows.find(candidate => candidate.id === id)
    if (row !== undefined) row.status = 'stopping'
    return 'requested'
  }

  wait(id: JobId): Promise<JobView> {
    return Promise.resolve(this.get(id))
  }

  remove(): void {}

  attachController(): () => void {
    return () => {}
  }

  private view(row: Row): JobView {
    return {
      id: JobId(row.id),
      kind: 'bash',
      label: row.label,
      ...row.owner === undefined ? {} : { owner: row.owner },
      status: row.status,
      startedAt: 0,
      output: { total: 0, earliest: 0 },
    }
  }
}

async function harness(): Promise<{ ctx: Context; jobs: ScriptedJobRegistry }> {
  const ctx = new Context()
  await ctx.plugin(ScriptedJobRegistry)
  return { ctx, jobs: ctx.jobs as ScriptedJobRegistry }
}

function ask(ctx: Context, sessionId: SessionId): Promise<readonly SessionActivity[]> {
  return ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
}

function stop(ctx: Context, sessionId: SessionId): Promise<void> {
  return ctx.parallel('workspace/session-stop', { sessionId })
}

const owner = SessionId('owner')
const other = SessionId('other')

describe('Job archive admission', () => {
  it('reports the running or stopping jobs the session owns, never unowned, foreign, or settled ones', async () => {
    const { ctx, jobs } = await harness()
    jobs.rows.push(
      { id: 'bash-1', label: 'pnpm run build', owner, status: 'running' },
      { id: 'bash-2', label: 'pnpm test', owner, status: 'stopping' },
      { id: 'bash-3', label: 'done', owner, status: 'completed' },
      { id: 'bash-4', label: 'theirs', owner: other, status: 'running' },
      { id: 'bash-5', label: 'unowned', status: 'running' },
    )
    ctx.on('workspace/session-activity', async (_request, next) => [...(await next()), { kind: 'turn' }])
    expect(await ask(ctx, owner)).toEqual([
      { kind: 'job', items: [{ id: 'bash-1', label: 'pnpm run build' }, { id: 'bash-2', label: 'pnpm test' }] },
      { kind: 'turn' },
    ])
    expect(await ask(ctx, SessionId('nobody'))).toEqual([{ kind: 'turn' }])
  })

  it('kills each owned live job with the archive reason and keeps going when one producer refuses', async () => {
    const { ctx, jobs } = await harness()
    jobs.rows.push(
      { id: 'bash-1', label: 'stubborn', owner, status: 'running' },
      { id: 'bash-2', label: 'quiet', owner, status: 'running' },
      { id: 'bash-3', label: 'theirs', owner: other, status: 'running' },
    )
    jobs.refusing = 'bash-1'
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await stop(ctx, owner)
    expect(jobs.kills).toEqual([[JobId('bash-2'), owner, 'session archived']])
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([expect.stringContaining('killing "bash-1"')])
    expect(jobs.get(JobId('bash-3')).status).toBe('running')
    // A second stop finds the survivor already stopping and asks it again; the refusal is logged again.
    await stop(ctx, owner)
    expect(jobs.kills).toHaveLength(2)
  })

  it('stops answering once the registry fiber is disposed', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(ScriptedJobRegistry)
    const jobs = ctx.jobs as ScriptedJobRegistry
    jobs.rows.push({ id: 'bash-1', label: 'pnpm run build', owner, status: 'running' })
    expect(await ask(ctx, owner)).toEqual([{ kind: 'job', items: [{ id: 'bash-1', label: 'pnpm run build' }] }])
    await fiber.dispose()
    expect(await ask(ctx, owner)).toEqual([])
    await stop(ctx, owner)
    expect(jobs.kills).toEqual([])
  })
})
