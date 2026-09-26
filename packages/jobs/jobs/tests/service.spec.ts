import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { JobId, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type {
  JobEvent, JobEventFilter, JobEventListener, JobHooks, JobOutputSource, JobOutputRead, JobRead, JobSpec, JobView,
} from '@deepseek-ai/dsh-jobs'

/** Compile-time probe: does `Shape` carry a `Key` member? */
type HasKey<Shape, Key extends string> = Key extends keyof Shape ? true : false

/**
 * Minimal concrete registry: one canned row. The Service Definition owns the
 * contract only (ids, caller-scoped operations, the event stream); the registry
 * behavior suite lives with `@deepseek-ai/dsh-jobs-local`.
 */
class StubJobRegistry extends JobRegistry {
  readonly subscriptions: { filter: JobEventFilter; listener: JobEventListener }[] = []
  readonly started: JobSpec[] = []

  readonly events = {
    subscribe: (filter: JobEventFilter, listener: JobEventListener): (() => void) => {
      const entry = { filter, listener }
      this.subscriptions.push(entry)
      return () => { this.subscriptions.splice(this.subscriptions.indexOf(entry), 1) }
    },
  }

  private view(id: JobId, owner: SessionId | undefined): JobView {
    return {
      id,
      kind: 'bash',
      label: 'sleep 60',
      ...owner !== undefined ? { owner } : {},
      status: 'running',
      startedAt: 0,
      output: { total: 0, earliest: 0 },
    }
  }

  start(spec: JobSpec): JobId {
    this.started.push(spec)
    const id = JobId(`${spec.kind}-1`)
    spec.run({ id, append() {}, updateProgress() {} })
    return id
  }

  list(caller?: SessionId): JobView[] {
    return [this.view(JobId('bash-1'), caller)]
  }

  get(id: JobId, caller?: SessionId): JobView {
    return this.view(id, caller)
  }

  read(id: JobId, caller?: SessionId): JobRead {
    return { chunks: [], lossy: false, job: this.view(id, caller) }
  }

  readAt(_id: JobId, from: number): JobOutputRead {
    return { chunks: [], next: from, lossy: false }
  }

  kill(): 'requested' {
    return 'requested'
  }

  wait(id: JobId, _timeoutMs: number, caller?: SessionId): Promise<JobView> {
    return Promise.resolve(this.view(id, caller))
  }

  remove(_id: JobId, _caller?: SessionId): void {}

  attachController(_name: string): () => void {
    return () => {}
  }
}

describe('JobRegistry seam', () => {
  it('a concrete subclass registers as ctx.jobs and serves the abstract API', async () => {
    const ctx = new Context()
    await ctx.plugin(StubJobRegistry)
    const caller = SessionId('session-1')
    const hooks: JobHooks = { cancel() {}, done: new Promise(() => {}) }

    const detachController = ctx.jobs.attachController('seam-test')
    const id = ctx.jobs.start({ kind: 'bash', label: 'sleep 60', owner: caller, run: () => hooks })
    expect(id).toBe('bash-1')

    const jobs = ctx.jobs
    expect(jobs.list(caller)).toHaveLength(1)
    expect(jobs.get(id, caller).status).toBe('running')
    expect(jobs.get(id, caller).owner).toBe(caller)
    expect(jobs.read(id, caller)).toMatchObject({ chunks: [], lossy: false, job: { id } })
    expect(jobs.readAt(id, 7, caller)).toEqual({ chunks: [], next: 7, lossy: false })
    expect(jobs.kill(id, caller, 'seam test')).toBe('requested')
    await expect(jobs.wait(id, 5, caller)).resolves.toMatchObject({ id })
    // Omission selects unowned jobs.
    expect(ctx.jobs.get(id).owner).toBeUndefined()

    const events: JobEvent[] = []
    const unsubscribe = ctx.jobs.events.subscribe({ owners: 'all' }, (event) => { events.push(event) })
    unsubscribe()
    detachController()
  })

  it('types every start the same way: one handle, pull sources optional', () => {
    const hooks: JobHooks = { cancel() {}, done: new Promise(() => {}) }
    const source: JobOutputSource = {
      channel: 'stdout',
      read: fromByte => ({ text: '', nextOffset: fromByte, lossy: false }),
    }
    const spec: JobSpec = {
      kind: 'bash',
      label: 'x',
      output: [source],
      run: (job) => {
        job.append('lands in the ring', { channel: 'log' })
        job.updateProgress('1/2')
        return hooks
      },
    }
    expect(spec.output).toHaveLength(1)
    // Bookkeeping never reaches the public view, and the record declaration is gone.
    const viewHasReported: HasKey<JobView, 'reported'> = false
    const specHasRecord: HasKey<JobSpec, 'record'> = false
    const hooksHaveReadOutput: HasKey<JobHooks, 'readOutput'> = false
    expect([viewHasReported, specHasRecord, hooksHaveReadOutput]).toEqual([false, false, false])
  })

  it('keeps the projection kind an open string, so a program compiling fewer JobKindMap merges accepts every Host kind', () => {
    // A browser bundle or a generated Remote codec sees only the merges its
    // own program compiles; a literal union here would reject `pwsh`,
    // `pty-send`, and every kind another package registers.
    type KindIsOpenString = string extends JobView['kind'] ? true : false
    const viewKindOpen: KindIsOpenString = true
    expect(viewKindOpen).toBe(true)
  })

  it('loading a second implementation throws (one jobs service per context — cordis standard)', async () => {
    const ctx = new Context()
    await ctx.plugin(StubJobRegistry)
    class SecondJobRegistry extends StubJobRegistry {}
    await expect(ctx.plugin(SecondJobRegistry)).rejects.toThrow(/service "jobs" has been registered/)
  })

  it('mounting the abstract seam directly fails loudly at load (stale-composition fence)', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(JobRegistry as typeof StubJobRegistry))
      .rejects.toThrow(/abstract job registry seam; load an implementation such as @deepseek-ai\/dsh-jobs-local/)
  })
})
