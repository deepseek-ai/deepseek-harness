import { describe, expect, it } from 'vitest'
import type { ScheduleId, ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CatalogSnapshot } from '../src/client/catalog-source.ts'
import { selectSessionScheduleFacts } from '../src/client/session-schedule-state.ts'

type Entry = ScheduleCatalogEntry

const SESSION = 'ambient-session' as SessionId
const CREATOR = 'creator-session' as SessionId

function catalogEntry(taskId: string, sessionId: string, status: Entry['status']): Entry {
  return { kind: 'rrule',
    id: taskId as ScheduleId, title: 'Read status', prompt: 'Read status',
    rrule: 'DTSTART;TZID=UTC:20261001T000000\nRRULE:FREQ=DAILY;COUNT=1', scheduledAt: '2026-10-01T00:00:00.000Z',
    target: { kind: 'session', sessionId: sessionId as SessionId }, involvedSessionIds: [sessionId as SessionId],
    status, createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z',
  }
}

/**
 * A task whose every delivery creates a fresh Session; the Host leaves created Sessions out of `involvedSessionIds`.
 * @param taskId - task identity.
 * @param latestRun - Session that the latest delivery created, if one ran.
 * @returns an active per-run task created from {@link CREATOR}.
 */
function perRunEntry(taskId: string, latestRun?: SessionId): Entry {
  const base: Entry = { ...catalogEntry(taskId, CREATOR, 'active'), target: { kind: 'new', create: {} } }
  return latestRun === undefined ? base : {
    ...base,
    lastDelivery: {
      scheduledAt: base.scheduledAt, deliveredAt: '2026-10-01T00:00:01.000Z',
      messageId: 'latest-run-message' as NonNullable<Entry['lastDelivery']>['messageId'], targetSessionId: latestRun,
    },
  }
}

function hostSnapshot(
  status: CatalogSnapshot['status'],
  records: readonly Entry[],
  settled = status === 'ready',
): CatalogSnapshot<Entry> {
  return { records, status, deleting: [], settled, readRequest: 0, readSettled: 0 }
}

describe('shared Host catalog projection', () => {
  it('selects only the given Session’s active tasks from every lifecycle state', () => {
    const mine = catalogEntry('mine', SESSION, 'active')
    const other = catalogEntry('other', 'other-session', 'active')
    const paused = catalogEntry('paused', SESSION, 'paused')
    const ended = catalogEntry('ended', SESSION, 'ended')
    const catalog = hostSnapshot('ready', [mine, other, paused, ended])

    expect(selectSessionScheduleFacts(catalog, SESSION)).toEqual({ hasActive: true, records: [mine] })
    expect(selectSessionScheduleFacts(catalog, 'other-session' as SessionId))
      .toEqual({ hasActive: true, records: [other] })
    expect(selectSessionScheduleFacts(catalog, 'empty-session' as SessionId))
      .toEqual({ hasActive: false, records: [] })
  })

  it('lists a per-run task under its creator and under the Session its latest delivery created', () => {
    const ran = perRunEntry('ran', SESSION)
    const waiting = perRunEntry('waiting')
    const catalog = hostSnapshot('ready', [ran, waiting])

    expect(selectSessionScheduleFacts(catalog, SESSION)).toEqual({ hasActive: true, records: [ran] })
    expect(selectSessionScheduleFacts(catalog, CREATOR)).toEqual({ hasActive: true, records: [ran, waiting] })
    expect(selectSessionScheduleFacts(catalog, 'other-session' as SessionId))
      .toEqual({ hasActive: false, records: [] })
  })

  it('answers no active task for a Session whose tasks are all paused or ended', () => {
    const catalog = hostSnapshot('ready', [catalogEntry('paused', SESSION, 'paused'), catalogEntry('ended', SESSION, 'ended')])
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
