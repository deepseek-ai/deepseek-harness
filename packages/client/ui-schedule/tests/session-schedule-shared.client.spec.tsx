// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScheduleCatalogEntry, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-ui-renderer/src/client/bind.ts'
import type { CatalogSnapshot } from '../src/client/catalog-source.ts'
import { useSessionScheduleFacts } from '../src/client/session-schedule-state.ts'

const SESSION = 'shared-session' as SessionId
const OTHER_SESSION = 'shared-other-session' as SessionId

afterEach(cleanup)

function entry(
  taskId: string,
  sessionId: SessionId,
  status: 'active' | 'inactive' = 'active',
): ScheduleCatalogEntry {
  return {
    id: taskId as ScheduleId, sessionId, status, kind: 'at',
    title: 'Read status', prompt: 'Read status', scheduledAt: '2026-10-01T00:00:00.000Z',
  }
}

function ready(records: readonly ScheduleCatalogEntry[]): CatalogSnapshot<ScheduleCatalogEntry> {
  return { records, status: 'ready', deleting: [], settled: true, readRequest: 0, readSettled: 0 }
}

/** Publish controlled catalog snapshots without a Remote read. */
function catalogObservable(initial: CatalogSnapshot<ScheduleCatalogEntry>): {
  readonly source: HostObservable<CatalogSnapshot<ScheduleCatalogEntry>>
  readonly publish: (next: CatalogSnapshot<ScheduleCatalogEntry>) => void
} {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    publish: (next) => {
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

describe('shared catalog facts selection', () => {
  it('keeps a row unchanged while another Session active tasks move', () => {
    const mine = entry('mine', SESSION)
    const other = entry('other', OTHER_SESSION)
    const catalog = catalogObservable(ready([mine]))
    const useCatalog = bindSnapshotSelector(catalog.source)
    const renders = vi.fn()
    function Row() {
      const facts = useSessionScheduleFacts(useCatalog, SESSION)
      renders()
      return <span data-has-active={String(facts.hasActive)} />
    }
    const view = render(<Row />)
    expect(renders).toHaveBeenCalledTimes(1)
    expect(view.container.querySelector('[data-has-active]')?.getAttribute('data-has-active')).toBe('true')

    // Another Session gaining an active task leaves this row's facts equal, so
    // the selector keeps the previous selection and React skips the render.
    act(() => { catalog.publish(ready([mine, other])) })
    expect(renders).toHaveBeenCalledTimes(1)

    act(() => { catalog.publish(ready([other])) })
    expect(renders).toHaveBeenCalledTimes(2)
    expect(view.container.querySelector('[data-has-active]')?.getAttribute('data-has-active')).toBe('false')
  })

  it('re-renders when this Session active tasks change', () => {
    const first = entry('mine', SESSION)
    const replacement = entry('mine', SESSION)
    const added = entry('added', SESSION)
    const catalog = catalogObservable(ready([first]))
    const useCatalog = bindSnapshotSelector(catalog.source)
    const renders = vi.fn()
    function Row() {
      const facts = useSessionScheduleFacts(useCatalog, SESSION)
      renders()
      return <span data-count={facts.records.length} />
    }
    const view = render(<Row />)
    expect(renders).toHaveBeenCalledTimes(1)

    // Same active count but different task records: the projection changed.
    act(() => { catalog.publish(ready([replacement])) })
    expect(renders).toHaveBeenCalledTimes(2)

    act(() => { catalog.publish(ready([added])) })
    expect(renders).toHaveBeenCalledTimes(3)

    // A growing task list changes the projection length.
    act(() => { catalog.publish(ready([added, entry('added-2', SESSION)])) })
    expect(renders).toHaveBeenCalledTimes(4)
    expect(view.container.querySelector('[data-count]')?.getAttribute('data-count')).toBe('2')
  })
})
