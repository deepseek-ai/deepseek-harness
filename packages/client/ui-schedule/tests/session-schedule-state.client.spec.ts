import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  ScheduleCatalogEntry, ScheduleDeleteResult, ScheduleId, ScheduleRecord,
} from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CatalogSnapshot } from '../src/client/catalog-source.ts'
import {
  createSessionScheduleSource, selectSessionScheduleFacts,
} from '../src/client/session-schedule-state.ts'

const SESSION = 'ambient-session' as SessionId
const id = 'ambient-task' as ScheduleId
const row: ScheduleRecord = {
  id, kind: 'at', title: 'Read status', prompt: 'Read status', scheduledAt: '2026-10-01T00:00:00.000Z',
}
const failure = { ok: false as const, error: new RemoteError('gateway/internal', 'Unavailable', {}) }

function catalogEntry(taskId: string, sessionId: string, status: 'active' | 'inactive'): ScheduleCatalogEntry {
  return {
    id: taskId as ScheduleId, sessionId: sessionId as SessionId, status, kind: 'at',
    title: 'Read status', prompt: 'Read status', scheduledAt: '2026-10-01T00:00:00.000Z',
  }
}

function hostSnapshot(
  status: CatalogSnapshot['status'],
  records: readonly ScheduleCatalogEntry[],
  settled = status === 'ready',
): CatalogSnapshot<ScheduleCatalogEntry> {
  return { records, status, deleting: [], settled, readRequest: 0, readSettled: 0 }
}

describe('Session schedule state', () => {
  it('addresses the Remote face by Session and follows its invalidations', async () => {
    let changed = (): void => {}
    let reset = (): void => {}
    const changedDisposed = vi.fn()
    const resetDisposed = vi.fn()
    const list = vi.fn<() => Promise<RemoteResult<ScheduleRecord[]>>>()
      .mockResolvedValue({ ok: true, value: [row] })
    const remove = vi.fn<(value: ScheduleId) => Promise<RemoteResult<ScheduleDeleteResult>>>()
      .mockResolvedValue({ ok: true, value: { id, deleted: true } })
    const ctx = {
      remote: {
        schedule: { list, delete: remove },
        $on: vi.fn((_event: 'schedule/changed', listener: () => void) => {
          changed = listener
          return changedDisposed
        }),
      },
      on: vi.fn((_event: 'connection/reset', listener: () => void) => {
        reset = listener
        return resetDisposed
      }),
    }
    const entry = createSessionScheduleSource(ctx as never, SESSION)
    const dispose = entry.hooks.catalog.subscribe(vi.fn())
    expect(list).toHaveBeenCalledWith({ sessionId: SESSION })
    await Promise.resolve()
    expect(entry.hooks.catalog.getSnapshot()).toMatchObject({ status: 'ready', records: [row] })

    list.mockResolvedValueOnce({ ok: true, value: [] })
    changed()
    await Promise.resolve()
    expect(entry.hooks.catalog.getSnapshot().records).toEqual([])

    list.mockResolvedValueOnce(failure)
    reset()
    await Promise.resolve()
    expect(entry.hooks.catalog.getSnapshot().status).toBe('error')

    list.mockResolvedValueOnce({ ok: true, value: [row] })
    await entry.onDelete(id)
    expect(remove).toHaveBeenCalledWith({ sessionId: SESSION, id })
    expect(entry.hooks.catalog.getSnapshot().records).toEqual([row])

    dispose()
    expect(changedDisposed).toHaveBeenCalledOnce()
    expect(resetDisposed).toHaveBeenCalledOnce()
  })
})

describe('shared Host catalog projection', () => {
  it('selects only the given Session active tasks from active and ended rows', () => {
    const mine = catalogEntry('mine', SESSION, 'active')
    const other = catalogEntry('other', 'other-session', 'active')
    const ended = catalogEntry('ended', SESSION, 'inactive')
    const catalog = hostSnapshot('ready', [mine, other, ended])

    expect(selectSessionScheduleFacts(catalog, SESSION)).toEqual({ hasActive: true, records: [mine] })
    expect(selectSessionScheduleFacts(catalog, 'other-session' as SessionId))
      .toEqual({ hasActive: true, records: [other] })
    expect(selectSessionScheduleFacts(catalog, 'empty-session' as SessionId))
      .toEqual({ hasActive: false, records: [] })
  })

  it('answers no active task for an ended-only Session', () => {
    const catalog = hostSnapshot('ready', [catalogEntry('ended', SESSION, 'inactive')])
    expect(selectSessionScheduleFacts(catalog, SESSION)).toEqual({ hasActive: false, records: [] })
  })

  it('answers no active task while the shared read is unresolved or failed', () => {
    const records = [catalogEntry('mine', SESSION, 'active')]
    expect(selectSessionScheduleFacts(hostSnapshot('loading', records), SESSION))
      .toEqual({ hasActive: false, records: [] })
    expect(selectSessionScheduleFacts(hostSnapshot('error', records), SESSION))
      .toEqual({ hasActive: false, records: [] })
  })

  it('keeps a Session’s active tasks through a refresh and a failed refresh', () => {
    const mine = catalogEntry('mine', SESSION, 'active')
    const other = catalogEntry('other', 'other-session', 'active')

    // A refresh republishes loading over the records of the last successful read,
    // and a failed refresh only changes the status: both keep stating that the
    // Session still has an active task, so no row disappears while they move.
    for (const status of ['loading', 'error'] as const) {
      const facts = selectSessionScheduleFacts(hostSnapshot(status, [mine, other], true), SESSION)
      expect([status, facts.hasActive]).toEqual([status, true])
      expect([status, facts.records]).toEqual([status, [mine]])
    }

    // A read that never succeeded states nothing, however many records it carries.
    expect(selectSessionScheduleFacts(hostSnapshot('loading', [mine, other], false), SESSION))
      .toEqual({ hasActive: false, records: [] })
  })
})
