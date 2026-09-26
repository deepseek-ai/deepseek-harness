import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScheduleDeleteResult, ScheduleId, ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'
import { createCatalogSource } from '../src/client/catalog-source.ts'

const id = 'reminder' as ScheduleId
const row: ScheduleRecord = {
  id, kind: 'at', title: 'Read status', prompt: 'Read status', scheduledAt: '2026-10-01T00:00:00.000Z',
}
const failure = { ok: false as const, error: new RemoteError('gateway/internal', 'Unavailable', {}) }
const ready = (records: ScheduleRecord[]): RemoteResult<ScheduleRecord[]> => ({ ok: true, value: records })

function harness() {
  let changed = () => {}
  let reset = () => {}
  const changedDisposed = vi.fn()
  const resetDisposed = vi.fn()
  const list = vi.fn<() => Promise<RemoteResult<ScheduleRecord[]>>>().mockResolvedValue(ready([row]))
  const remove = vi.fn<(value: ScheduleId) => Promise<RemoteResult<ScheduleDeleteResult>>>()
    .mockResolvedValue({ ok: true, value: { id, deleted: true } })
  const entry = createCatalogSource({
    list, remove,
    subscribeChanged: (listener) => { changed = listener; return changedDisposed },
    subscribeReset: (listener) => { reset = listener; return resetDisposed },
  })
  const source = entry.hooks.catalog
  return { entry, source, list, remove, changed: () => { changed() }, reset: () => { reset() }, changedDisposed, resetDisposed }
}

/**
 * Let the source publish the read it has in flight.
 *
 * `refresh` queues the batch-clear microtask before it calls `read`, and `read`
 * publishes only once its `deps.list()` settles, so the marker is already clear by
 * the time the snapshot changes. A case that asserts the published snapshot
 * therefore waits a macrotask rather than a single microtask.
 * @returns resolution after the in-flight read has published.
 */
async function flushed(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

describe('Schedule catalog Remote source', () => {
  it('queries on subscription and refreshes on changes and reconnection', async () => {
    const h = harness()
    const dispose = h.source.subscribe(vi.fn())
    expect(h.source.getSnapshot().status).toBe('loading')
    await flushed()
    expect(h.source.getSnapshot()).toMatchObject({ status: 'ready', records: [row] })
    h.list.mockResolvedValue(ready([]))
    h.changed()
    await flushed()
    expect(h.source.getSnapshot().records).toEqual([])
    h.list.mockResolvedValue(ready([row]))
    h.reset()
    await flushed()
    expect(h.source.getSnapshot().records).toEqual([row])
    dispose()
    expect(h.changedDisposed).toHaveBeenCalledOnce()
    expect(h.resetDisposed).toHaveBeenCalledOnce()
  })

  it('states settled only once an authoritative read has settled', async () => {
    const h = harness()
    const dispose = h.source.subscribe(vi.fn())
    // A read still in flight cannot answer for a missing row.
    expect(h.source.getSnapshot()).toMatchObject({ status: 'loading', records: [], settled: false })
    await flushed()
    expect(h.source.getSnapshot()).toMatchObject({ status: 'ready', settled: true })
    // A later refresh republishes loading over the records of the last successful
    // read, so the records and the fact both survive it.
    h.list.mockResolvedValue(ready([]))
    h.changed()
    expect(h.source.getSnapshot()).toMatchObject({ status: 'loading', records: [row], settled: true })
    await flushed()
    expect(h.source.getSnapshot()).toMatchObject({ status: 'ready', records: [], settled: true })
    // A failed read changes only the status, so the settled answer stands.
    h.list.mockRejectedValueOnce(new Error('disconnected'))
    void h.entry.onRetry()
    await flushed()
    expect(h.source.getSnapshot()).toMatchObject({ status: 'error', records: [], settled: true })
    dispose()
  })

  it('does not state settled when the first read fails', async () => {
    const h = harness()
    h.list.mockResolvedValueOnce(failure)
    const dispose = h.source.subscribe(vi.fn())
    await flushed()
    // An error is not an authoritative answer, so a consumer may not read absence
    // from it as a deletion.
    expect(h.source.getSnapshot()).toMatchObject({ status: 'error', records: [], settled: false })
    dispose()
  })

  it('counts requested reads and the read that settled the records separately', async () => {
    const h = harness()
    // The first frame carries no read at all, so a consumer that appears with its
    // own record cannot read an absence yet.
    expect(h.source.getSnapshot()).toMatchObject({ status: 'loading', readRequest: 0, readSettled: 0 })
    const dispose = h.source.subscribe(vi.fn())
    await flushed()
    expect(h.source.getSnapshot()).toMatchObject({ status: 'ready', readRequest: 1, readSettled: 1 })

    // A refresh publishes the request it issues over the retained records, so the
    // request count moves while the settled ordinal still names the older read.
    h.list.mockResolvedValue(ready([]))
    h.changed()
    expect(h.source.getSnapshot()).toMatchObject({ status: 'loading', records: [row], readRequest: 2, readSettled: 1 })
    await flushed()
    expect(h.source.getSnapshot()).toMatchObject({ status: 'ready', records: [], readRequest: 2, readSettled: 2 })

    // A failed read was still issued: the request count advances and the settled
    // ordinal keeps naming the read the records came from.
    h.list.mockRejectedValueOnce(new Error('disconnected'))
    void h.entry.onRetry()
    await flushed()
    expect(h.source.getSnapshot()).toMatchObject({ status: 'error', records: [], readRequest: 3, readSettled: 2 })
    h.list.mockResolvedValueOnce(failure)
    void h.entry.onRetry()
    await flushed()
    expect(h.source.getSnapshot()).toMatchObject({ status: 'error', records: [], readRequest: 4, readSettled: 2 })
    dispose()
  })

  it('issues one read for the mount requests of one task', async () => {
    const h = harness()
    const dispose = h.source.subscribe(vi.fn())
    await flushed()
    expect(h.source.getSnapshot()).toMatchObject({ status: 'ready', readRequest: 1, readSettled: 1 })

    // Two consumers of one commit ask in the same task, as the created-task cards
    // of a Turn do: they share a single list() call.
    const issued = h.list.mock.calls.length
    const first = h.entry.onRetry()
    const second = h.entry.onRetry()
    expect(h.list.mock.calls.length).toBe(issued + 1)

    // Each request still publishes the ordinal it was issued under, and only the
    // read the shared call belongs to supplies the settled one.
    expect(h.source.getSnapshot()).toMatchObject({ status: 'loading', readRequest: 3, readSettled: 1 })
    await Promise.all([first, second])
    expect(h.source.getSnapshot()).toMatchObject({ status: 'ready', readRequest: 3, readSettled: 2 })
    dispose()
  })

  it('supersedes the read in flight when the connection moves', async () => {
    const h = harness()
    const inFlight = Promise.withResolvers<RemoteResult<ScheduleRecord[]>>()
    h.list.mockReturnValueOnce(inFlight.promise)
    const dispose = h.source.subscribe(vi.fn())
    // A reset states the connection moved, so it issues its own read instead of
    // joining the one in flight, and the older read's late result is dropped.
    h.reset()
    expect(h.list).toHaveBeenCalledTimes(2)
    inFlight.resolve(ready([]))
    await flushed()
    expect(h.source.getSnapshot())
      .toMatchObject({ status: 'ready', records: [row], readRequest: 2, readSettled: 2 })
    dispose()
  })

  it('reports Remote and transport failures without presenting an empty success', async () => {
    const h = harness()
    h.list.mockResolvedValueOnce(failure)
    const dispose = h.source.subscribe(vi.fn())
    await flushed()
    expect(h.source.getSnapshot().status).toBe('error')
    h.list.mockRejectedValueOnce(new Error('disconnected'))
    void h.entry.onRetry()
    await flushed()
    expect(h.source.getSnapshot().status).toBe('error')
    void h.entry.onRetry()
    await flushed()
    expect(h.source.getSnapshot()).toMatchObject({ status: 'ready', records: [row] })
    dispose()
  })

  it('does not accept a read from before reconnect or after unsubscribe', async () => {
    const h = harness()
    const old = Promise.withResolvers<RemoteResult<ScheduleRecord[]>>()
    h.list.mockReturnValueOnce(old.promise)
    const dispose = h.source.subscribe(vi.fn())
    h.reset()
    await flushed()
    old.resolve(ready([]))
    await flushed()
    expect(h.source.getSnapshot().records).toEqual([row])
    const late = Promise.withResolvers<RemoteResult<ScheduleRecord[]>>()
    h.list.mockReturnValueOnce(late.promise)
    h.changed()
    dispose()
    late.resolve(ready([]))
    await flushed()
    expect(h.source.getSnapshot().records).toEqual([row])
  })

  it('retains the row while deletion is pending and refreshes after acknowledgement', async () => {
    const h = harness()
    const dispose = h.source.subscribe(vi.fn())
    await flushed()
    const deleted = Promise.withResolvers<RemoteResult<ScheduleDeleteResult>>()
    h.remove.mockReturnValueOnce(deleted.promise)
    const removing = h.entry.onDelete(id)
    // A second request for the same row joins nothing: it reports the deletion
    // already in flight instead of a settled outcome.
    await expect(h.entry.onDelete(id)).resolves.toBe('pending')
    expect(h.remove).toHaveBeenCalledTimes(1)
    expect(h.source.getSnapshot()).toMatchObject({ records: [row], deleting: [id] })
    h.list.mockResolvedValue(ready([]))
    deleted.resolve({ ok: true, value: { id, deleted: true } })
    await expect(removing).resolves.toBe('deleted')
    expect(h.source.getSnapshot()).toMatchObject({ status: 'ready', records: [], deleting: [] })
    expect(h.list).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('does not reuse a read issued before the caller’s ordinal', async () => {
    const h = harness()
    const dispose = h.source.subscribe(vi.fn())
    await flushed()
    expect(h.source.getSnapshot()).toMatchObject({ readRequest: 1, readSettled: 1 })

    // A read is in flight under ordinal 2.
    const slow = Promise.withResolvers<RemoteResult<ScheduleRecord[]>>()
    h.list.mockReturnValueOnce(slow.promise)
    void h.entry.onRetry()
    expect(h.source.getSnapshot()).toMatchObject({ status: 'loading', readRequest: 2 })

    // A caller that has already observed ordinal 2 cannot be served by a read sent
    // before its request, so the source reads again.
    h.list.mockResolvedValueOnce(ready([]))
    await h.entry.onRetry(2)
    expect(h.list).toHaveBeenCalledTimes(3)
    expect(h.source.getSnapshot())
      .toMatchObject({ status: 'ready', records: [], readRequest: 3, readSettled: 3 })

    // The older read was superseded, so its late row cannot come back either.
    slow.resolve(ready([row]))
    await flushed()
    expect(h.source.getSnapshot()).toMatchObject({ status: 'ready', records: [], readSettled: 3 })
    dispose()
  })

  it('reuses the read in flight for a caller that has not seen it', async () => {
    const h = harness()
    const dispose = h.source.subscribe(vi.fn())
    await flushed()

    const slow = Promise.withResolvers<RemoteResult<ScheduleRecord[]>>()
    h.list.mockReturnValueOnce(slow.promise)
    const shared = h.entry.onRetry()
    const issued = h.list.mock.calls.length
    // The same task's second caller has observed no request later than ordinal 1,
    // so the read in flight under ordinal 2 can still answer for it.
    const joined = h.entry.onRetry(1)
    expect(h.list.mock.calls.length).toBe(issued)
    expect(h.source.getSnapshot()).toMatchObject({ status: 'loading', readRequest: 3 })

    slow.resolve(ready([row]))
    await Promise.all([shared, joined])
    expect(h.source.getSnapshot())
      .toMatchObject({ status: 'ready', records: [row], readRequest: 3, readSettled: 2 })
    dispose()
  })

  it('keeps the newer read in flight when an older one settles', async () => {
    const h = harness()
    const dispose = h.source.subscribe(vi.fn())
    await flushed()

    // Read A hangs under ordinal 2.
    const slowA = Promise.withResolvers<RemoteResult<ScheduleRecord[]>>()
    h.list.mockReturnValueOnce(slowA.promise)
    void h.entry.onRetry()
    // A caller that has already observed ordinal 2 cannot share A, so it starts C
    // under ordinal 3 while A is still in flight.
    const slowC = Promise.withResolvers<RemoteResult<ScheduleRecord[]>>()
    h.list.mockReturnValueOnce(slowC.promise)
    const readsC = h.entry.onRetry(2)
    expect(h.list).toHaveBeenCalledTimes(3)

    // A settles after C started: its handler must leave C as the read in flight,
    // so the snapshot the source publishes is C's, not A's stale answer.
    slowA.resolve(ready([]))
    await flushed()
    expect(h.source.getSnapshot()).toMatchObject({ status: 'loading', records: [row] })

    slowC.resolve(ready([row]))
    await readsC
    await flushed()
    expect(h.source.getSnapshot())
      .toMatchObject({ status: 'ready', records: [row], readRequest: 3, readSettled: 3 })
    dispose()
  })

  it('reads again after an acknowledged deletion instead of joining the in-flight read', async () => {
    const h = harness()
    const dispose = h.source.subscribe(vi.fn())
    await flushed()
    expect(h.source.getSnapshot()).toMatchObject({ status: 'ready', records: [row] })

    const removed = Promise.withResolvers<RemoteResult<ScheduleDeleteResult>>()
    h.remove.mockReturnValueOnce(removed.promise)
    const deleting = h.entry.onDelete(id)

    // A read issued before the acknowledgement still holds the deleted row, and the
    // acknowledgement lands inside that request's window: the refresh it performs
    // must supersede the read rather than join it.
    const stale = Promise.withResolvers<RemoteResult<ScheduleRecord[]>>()
    h.list.mockReturnValueOnce(stale.promise)
    h.list.mockResolvedValueOnce(ready([]))
    removed.resolve({ ok: true, value: { id, deleted: true } })
    void h.entry.onRetry()
    await flushed()

    // The acknowledgement's own read is the third call: the subscription's, the
    // stale one, and this one.
    expect(h.list).toHaveBeenCalledTimes(3)
    expect(h.source.getSnapshot())
      .toMatchObject({ status: 'ready', records: [], deleting: [], readRequest: 3, readSettled: 3 })

    // The stale read's late result cannot put the deleted row back.
    stale.resolve(ready([row]))
    await deleting
    await flushed()
    expect(h.source.getSnapshot()).toMatchObject({ status: 'ready', records: [], readSettled: 3 })
    dispose()
  })

  it('retains records on delete failures and refreshes an already-deleted id', async () => {
    const h = harness()
    const dispose = h.source.subscribe(vi.fn())
    await flushed()
    h.remove.mockResolvedValueOnce(failure)
    await expect(h.entry.onDelete(id)).resolves.toBe('failed')
    expect(h.source.getSnapshot()).toMatchObject({ records: [row], deleting: [] })
    h.remove.mockRejectedValueOnce(new Error('disconnected'))
    await expect(h.entry.onDelete(id)).resolves.toBe('failed')
    expect(h.source.getSnapshot()).toMatchObject({ records: [row], deleting: [] })
    // An already-deleted id is an acknowledged deletion: the outcome is settled
    // even when the refresh it triggers fails, which the status reports.
    h.remove.mockResolvedValueOnce({ ok: true, value: { id, deleted: false, code: 'schedule_not_found' } })
    h.list.mockResolvedValueOnce(failure)
    await expect(h.entry.onDelete(id)).resolves.toBe('deleted')
    expect(h.source.getSnapshot()).toMatchObject({ records: [row], status: 'error' })
    dispose()
  })

  it.each(['remote', 'transport'] as const)('settles another deletion as deleted while a %s failure retains its own row', async (mode) => {
    const h = harness()
    const otherId = 'later-reminder' as ScheduleId
    const rows = [row, { ...row, id: otherId }]
    h.list.mockResolvedValueOnce(ready(rows))
    const dispose = h.source.subscribe(vi.fn())
    let removing: Promise<unknown> | undefined
    try {
      await flushed()
      if (mode === 'remote') h.remove.mockResolvedValueOnce(failure)
      else h.remove.mockRejectedValueOnce(new Error('lost deletion response'))
      await expect(h.entry.onDelete(id)).resolves.toBe('failed')
      h.remove.mockResolvedValueOnce({ ok: true, value: { id: otherId, deleted: true } })
      h.list.mockResolvedValueOnce(failure)
      removing = h.entry.onDelete(otherId)
      expect(h.source.getSnapshot()).toMatchObject({ deleting: [otherId] })
      await expect(removing).resolves.toBe('deleted')
      expect(h.source.getSnapshot()).toMatchObject({ records: rows, status: 'error', deleting: [] })
      void h.entry.onRetry()
      await flushed()
      expect(h.source.getSnapshot()).toMatchObject({ records: [row], status: 'ready' })
    } finally {
      dispose()
      await removing
    }
  })

  describe.each(['remote', 'transport'] as const)('overlapping deletions with a %s failure', (mode) => {
    it.each(['before acknowledgement', 'during refresh', 'after refresh'] as const)(
      'settles each deletion with its own outcome when the failure lands %s of the successful one', async (order) => {
        const h = harness()
        const otherId = 'other-reminder' as ScheduleId
        const otherRow = { ...row, id: otherId }
        const failed = Promise.withResolvers<RemoteResult<ScheduleDeleteResult>>()
        const succeeded = Promise.withResolvers<RemoteResult<ScheduleDeleteResult>>()
        const refreshed = Promise.withResolvers<RemoteResult<ScheduleRecord[]>>()
        const refreshStarted = Promise.withResolvers<undefined>()
        h.list.mockResolvedValueOnce(ready([row, otherRow]))
        const dispose = h.source.subscribe(vi.fn())
        await flushed()
        h.remove.mockReturnValueOnce(failed.promise).mockReturnValueOnce(succeeded.promise)
        h.list.mockImplementationOnce(() => {
          refreshStarted.resolve(undefined)
          return refreshed.promise
        })
        const removingA = h.entry.onDelete(id)
        const removingB = h.entry.onDelete(otherId)
        const failA = async () => {
          if (mode === 'remote') failed.resolve(failure)
          else failed.reject(new Error('deletion response disconnected'))
          await expect(removingA).resolves.toBe('failed')
        }
        try {
          expect(h.remove.mock.calls).toEqual([[id], [otherId]])
          expect(h.source.getSnapshot()).toMatchObject({
            records: [row, otherRow], deleting: [id, otherId],
          })
          if (order === 'before acknowledgement') {
            await failA()
            expect(h.source.getSnapshot().deleting).toEqual([otherId])
          }
          succeeded.resolve({ ok: true, value: { id: otherId, deleted: true } })
          await refreshStarted.promise
          expect(h.source.getSnapshot()).toMatchObject({
            records: [row, otherRow], status: 'loading',
            deleting: order === 'before acknowledgement' ? [] : [id],
          })
          if (order === 'during refresh') await failA()
          refreshed.resolve(ready([row]))
          await expect(removingB).resolves.toBe('deleted')
          expect(h.source.getSnapshot()).toMatchObject({
            records: [row], status: 'ready',
            deleting: order === 'after refresh' ? [id] : [],
          })
          if (order === 'after refresh') await failA()
          expect(h.source.getSnapshot()).toMatchObject({ records: [row], deleting: [] })
          expect(h.list).toHaveBeenCalledTimes(2)
        } finally {
          dispose()
          failed.resolve(failure)
          succeeded.resolve({ ok: true, value: { id: otherId, deleted: true } })
          refreshed.resolve(ready([row]))
          await Promise.all([removingA, removingB])
        }
      },
    )
  })

  it('retains the records when a deletion fails and subsequent reads fail or reject', async () => {
    const h = harness()
    const dispose = h.source.subscribe(vi.fn())
    try {
      await flushed()
      h.remove.mockResolvedValueOnce(failure)
      await expect(h.entry.onDelete(id)).resolves.toBe('failed')
      h.list.mockResolvedValueOnce(failure)
      h.changed()
      await flushed()
      expect(h.source.getSnapshot()).toMatchObject({ records: [row], status: 'error' })
      h.list.mockRejectedValueOnce(new Error('query response disconnected'))
      void h.entry.onRetry()
      await flushed()
      expect(h.source.getSnapshot()).toMatchObject({ records: [row], status: 'error' })
    } finally {
      dispose()
    }
  })

  it('ignores a deletion result after its entry unsubscribed', async () => {
    const h = harness()
    const dispose = h.source.subscribe(vi.fn())
    await flushed()
    const pending = Promise.withResolvers<RemoteResult<ScheduleDeleteResult>>()
    h.remove.mockReturnValueOnce(pending.promise)
    const deleting = h.entry.onDelete(id)
    dispose()
    pending.resolve(failure)
    await expect(deleting).resolves.toBe('failed')
    expect(h.source.getSnapshot()).toMatchObject({ records: [row] })
    expect(h.list).toHaveBeenCalledTimes(1)
  })

  it('settles an acknowledged deletion as deleted after its entry unsubscribed', async () => {
    const h = harness()
    const dispose = h.source.subscribe(vi.fn())
    await flushed()
    const pending = Promise.withResolvers<RemoteResult<ScheduleDeleteResult>>()
    h.remove.mockReturnValueOnce(pending.promise)
    const deleting = h.entry.onDelete(id)
    dispose()
    pending.resolve({ ok: true, value: { id, deleted: true } })
    // The acknowledgement arrived after the entry unsubscribed: its outcome is
    // settled, and the source issues no readback for a deletion it no longer shows.
    await expect(deleting).resolves.toBe('deleted')
    expect(h.list).toHaveBeenCalledTimes(1)
    expect(h.source.getSnapshot()).toMatchObject({ records: [row], deleting: [] })
  })

  it('ignores a stale query rejection after a newer query succeeded', async () => {
    const h = harness()
    const old = Promise.withResolvers<RemoteResult<ScheduleRecord[]>>()
    h.list.mockReturnValueOnce(old.promise)
    const dispose = h.source.subscribe(vi.fn())
    h.reset()
    await flushed()
    expect(h.source.getSnapshot()).toMatchObject({ status: 'ready', records: [row] })
    old.reject(new Error('old connection failed'))
    await flushed()
    expect(h.source.getSnapshot()).toMatchObject({ status: 'ready', records: [row] })
    dispose()
  })

  it('does not publish an old deletion rejection into a remounted catalog', async () => {
    const h = harness()
    const dispose = h.source.subscribe(vi.fn())
    await flushed()
    const pending = Promise.withResolvers<RemoteResult<ScheduleDeleteResult>>()
    h.remove.mockReturnValueOnce(pending.promise)
    const deleting = h.entry.onDelete(id)
    dispose()
    const remounted = h.source.subscribe(vi.fn())
    await flushed()
    pending.reject(new Error('old deletion disconnected'))
    await expect(deleting).resolves.toBe('failed')
    expect(h.source.getSnapshot()).toMatchObject({ status: 'ready', records: [row], deleting: [] })
    remounted()
  })

  it('retains shared event subscriptions until the final observer leaves', async () => {
    const h = harness()
    const first = vi.fn()
    const second = vi.fn()
    const stopFirst = h.source.subscribe(first)
    const stopSecond = h.source.subscribe(second)
    await flushed()
    expect(h.list).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalled()
    expect(second).toHaveBeenCalled()
    stopFirst()
    expect(h.changedDisposed).not.toHaveBeenCalled()
    expect(h.resetDisposed).not.toHaveBeenCalled()
    first.mockClear()
    second.mockClear()
    h.list.mockResolvedValue(ready([]))
    h.changed()
    await flushed()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalled()
    expect(h.source.getSnapshot().records).toEqual([])
    stopSecond()
    expect(h.changedDisposed).toHaveBeenCalledOnce()
    expect(h.resetDisposed).toHaveBeenCalledOnce()
  })
})
