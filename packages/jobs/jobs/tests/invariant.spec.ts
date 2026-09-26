import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import JobRegistry, { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobEvent, JobEventFilter, JobEventListener, JobView } from '@deepseek-ai/dsh-jobs'
import * as JobsInvariant from '@deepseek-ai/dsh-jobs/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

const ID = JobId('bash-1')

const RUNNING: JobView = {
  id: ID,
  kind: 'bash',
  label: 'compile',
  status: 'running',
  startedAt: 10,
  output: { total: 0, earliest: 0 },
}

const DONE: JobView = { ...RUNNING, status: 'completed', finishedAt: 20 }

/**
 * A stub registry whose reads come from a map the test edits: the companion
 * compares every announced projection against these reads.
 */
async function setup() {
  const ctx = new Context()
  const reads = new Map<string, JobView>()
  let listener: JobEventListener | undefined
  /** A registry serving only the reads and the subscription the companion uses. */
  class ProbeRegistry extends JobRegistry {
    readonly events = {
      subscribe: (_filter: JobEventFilter, value: JobEventListener): (() => void) => {
        listener = value
        return () => { listener = undefined }
      },
    }
    get(id: JobId, caller?: SessionId): JobView {
      const view = reads.get(String(id))
      if (view === undefined || view.owner !== caller) throw new Error(`unknown job ${String(id)}`)
      return view
    }
    start(): never { throw new Error('unsupported') }
    list(): never { throw new Error('unsupported') }
    read(): never { throw new Error('unsupported') }
    readAt(): never { throw new Error('unsupported') }
    kill(): never { throw new Error('unsupported') }
    wait(): never { throw new Error('unsupported') }
    remove(): never { throw new Error('unsupported') }
    attachController(): never { throw new Error('unsupported') }
  }
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(ProbeRegistry)
  await ctx.plugin(JobsInvariant)
  if (listener === undefined) throw new Error('job invariant did not subscribe to the event stream')
  const emit = (event: JobEvent): void => { listener!(event) }
  const read = (view: JobView | undefined): void => {
    if (view === undefined) reads.delete(String(ID))
    else reads.set(String(view.id), view)
  }
  return { emit, read }
}

describe('job-registry invariants', () => {
  it('accepts one job announced from registration to removal, each event agreeing with the read', async () => {
    const { emit, read } = await setup()
    read(RUNNING)
    emit({ type: 'registered', job: RUNNING })
    read({ ...RUNNING, progress: '1/2' })
    emit({ type: 'progress', job: { ...RUNNING, progress: '1/2' } })
    read({ ...RUNNING, progress: '1/2', output: { total: 4, earliest: 0 } })
    emit({ type: 'output', id: ID, total: 4 })
    read({ ...RUNNING, status: 'stopping', output: { total: 4, earliest: 0 } })
    emit({ type: 'stopping', job: { ...RUNNING, status: 'stopping', output: { total: 4, earliest: 0 } } })
    read({ ...DONE, status: 'killed', output: { total: 4, earliest: 0 } })
    emit({ type: 'settled', job: { ...DONE, status: 'killed', output: { total: 4, earliest: 0 } }, cause: 'kill', awaited: false })
    emit({ type: 'output', id: ID, total: 4 })
    read(undefined)
    expect(() => { emit({ type: 'removed', job: { ...DONE, status: 'killed', output: { total: 4, earliest: 0 } } }) }).not.toThrow()
  })

  it('adopts a job first seen through a later event, so a companion mounted late raises nothing', async () => {
    const { emit, read } = await setup()
    read({ ...RUNNING, progress: '3/4' })
    expect(() => { emit({ type: 'progress', job: { ...RUNNING, progress: '3/4' } }) }).not.toThrow()
    read(DONE)
    expect(() => { emit({ type: 'settled', job: DONE, cause: 'producer', awaited: false }) }).not.toThrow()
    read(undefined)
    expect(() => { emit({ type: 'removed', job: DONE }) }).not.toThrow()
  })

  it('accepts an unowned job read through the unowned view and an owned job through its owner', async () => {
    const { emit, read } = await setup()
    const owner = SessionId('owner')
    const owned: JobView = { ...RUNNING, id: JobId('subagent-2'), kind: 'subagent', owner }
    read(RUNNING)
    read(owned)
    expect(() => { emit({ type: 'registered', job: RUNNING }) }).not.toThrow()
    expect(() => { emit({ type: 'registered', job: owned }) }).not.toThrow()
    expect(() => { emit({ type: 'output', id: owned.id, owner, total: 0 }) }).not.toThrow()
  })

  it.each([
    ['registered after an earlier event for the same id', ({ emit, read }) => {
      read(RUNNING)
      emit({ type: 'output', id: ID, total: 0 })
      emit({ type: 'registered', job: RUNNING })
    }, /registered announced for job bash-1 after earlier events/],
    ['registered twice', ({ emit, read }) => {
      read(RUNNING)
      emit({ type: 'registered', job: RUNNING })
      emit({ type: 'registered', job: RUNNING })
    }, /registered announced for job bash-1 after earlier events/],
    ['registered with a terminal status', ({ emit, read }) => {
      read(DONE)
      emit({ type: 'registered', job: DONE })
    }, /must announce a live status without finishedAt/],
    ['progress after settlement', ({ emit, read }) => {
      read(DONE)
      emit({ type: 'settled', job: DONE, cause: 'producer', awaited: false })
      emit({ type: 'progress', job: { ...DONE, progress: 'late' } })
    }, /progress announced for job bash-1 after its settlement/],
    ['stopping with a terminal status', ({ emit, read }) => {
      read(DONE)
      emit({ type: 'stopping', job: DONE })
    }, /stopping announced for job bash-1 with a terminal status/],
    ['settled twice', ({ emit, read }) => {
      read(DONE)
      emit({ type: 'settled', job: DONE, cause: 'producer', awaited: false })
      emit({ type: 'settled', job: DONE, cause: 'producer', awaited: false })
    }, /settled announced twice for job bash-1/],
    ['settled with a live status', ({ emit, read }) => {
      read(RUNNING)
      emit({ type: 'settled', job: { ...RUNNING, finishedAt: 20 }, cause: 'producer', awaited: false })
    }, /must announce a terminal status, got "running"/],
    ['settled without finishedAt', ({ emit, read }) => {
      read(DONE)
      emit({ type: 'settled', job: { ...RUNNING, status: 'completed' }, cause: 'producer', awaited: false })
    }, /finishedAt no earlier than startedAt/],
    ['settled before it started', ({ emit, read }) => {
      read(DONE)
      emit({ type: 'settled', job: { ...DONE, finishedAt: 9 }, cause: 'producer', awaited: false })
    }, /finishedAt no earlier than startedAt/],
    ['settled with a progress line', ({ emit, read }) => {
      read(DONE)
      emit({ type: 'settled', job: { ...DONE, progress: '9/10' }, cause: 'producer', awaited: false })
    }, /must announce a cleared progress line/],
    ['settled while the registry still reads it live', ({ emit, read }) => {
      read(RUNNING)
      emit({ type: 'settled', job: DONE, cause: 'producer', awaited: false })
    }, /announces completed at 20 while the registry reads running at undefined/],
    ['removed before settlement', ({ emit, read }) => {
      read(RUNNING)
      emit({ type: 'registered', job: RUNNING })
      read(undefined)
      emit({ type: 'removed', job: RUNNING })
    }, /removed announced for job bash-1 before its settlement/],
    ['removed while the registry still returns the job', ({ emit, read }) => {
      read(DONE)
      emit({ type: 'settled', job: DONE, cause: 'producer', awaited: false })
      emit({ type: 'removed', job: DONE })
    }, /removed announced for job bash-1 that the registry still returns/],
    ['output ahead of the read total', ({ emit, read }) => {
      read(RUNNING)
      emit({ type: 'output', id: ID, total: 8 })
    }, /output announced for job bash-1 at total 8 ahead of the registry's 0/],
    ['output for a job the registry no longer returns', ({ emit }) => {
      emit({ type: 'output', id: ID, total: 0 })
    }, /output announced for job bash-1 that the registry no longer returns/],
    ['a lifecycle event for a job the registry does not return', ({ emit }) => {
      emit({ type: 'registered', job: RUNNING })
    }, /registered announced for job bash-1 that the registry does not return/],
    ['an announced label the registry does not read', ({ emit, read }) => {
      read(RUNNING)
      emit({ type: 'registered', job: { ...RUNNING, label: 'link' } })
    }, /announces label "link" while the registry reads "compile"/],
    ['an announced owner the registry does not read', ({ emit, read }) => {
      read({ ...RUNNING, owner: SessionId('alice') })
      emit({ type: 'registered', job: { ...RUNNING, owner: SessionId('alice') } })
      read({ ...RUNNING, owner: SessionId('alice'), startedAt: 11 })
      emit({ type: 'progress', job: { ...RUNNING, owner: SessionId('alice'), progress: 'x' } })
    }, /announces startedAt 10 while the registry reads 11/],
    ['an announced output total ahead of the read', ({ emit, read }) => {
      read(RUNNING)
      emit({ type: 'registered', job: { ...RUNNING, output: { total: 2, earliest: 0 } } })
    }, /announces output total 2 ahead of the registry's 0/],
  ] as const satisfies readonly (readonly [string, (probe: Awaited<ReturnType<typeof setup>>) => void, RegExp])[])(
    'rejects %s',
    async (_name, script, message) => {
      const probe = await setup()
      expect(() => { script(probe) }).toThrow(message)
    },
  )
})
