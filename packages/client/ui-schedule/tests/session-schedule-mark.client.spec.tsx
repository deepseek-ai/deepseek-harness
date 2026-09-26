// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { ScheduleCatalogEntry, ScheduleDeleteResult, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-ui-renderer/src/client/bind.ts'
import { createCatalogSource, type CatalogInjected } from '../src/client/catalog-source.ts'
import { SessionScheduleMark, type SessionScheduleMarkProps } from '../src/client/SessionScheduleMark.tsx'
import { en } from '../src/client/locales.ts'

const SESSION = 'mark-session' as SessionId
const OTHER_SESSION = 'other-session' as SessionId
const id = 'mark-task' as ScheduleId

afterEach(cleanup)

function entry(taskId: string, sessionId: SessionId, status: 'active' | 'inactive' = 'active'): ScheduleCatalogEntry {
  return {
    id: taskId as ScheduleId, sessionId, status, kind: 'at',
    title: 'Read status', prompt: 'Read status', scheduledAt: '2026-10-01T00:00:00.000Z',
  }
}

function sourceFor(
  list: () => Promise<RemoteResult<ScheduleCatalogEntry[]>>,
): CatalogInjected<ScheduleCatalogEntry> {
  return createCatalogSource<ScheduleCatalogEntry>({
    list,
    remove: async (): Promise<RemoteResult<ScheduleDeleteResult>> =>
      ({ ok: true, value: { id, deleted: true } }),
    subscribeChanged: () => () => {},
    subscribeReset: () => () => {},
  })
}

function renderMark(
  source: CatalogInjected<ScheduleCatalogEntry>,
  sessionId: SessionId = SESSION,
) {
  const props = {
    sessionId,
    useCatalog: bindSnapshotSelector(source.hooks.catalog),
    t: makeTranslate(en),
  } as SessionScheduleMarkProps
  return render(<SessionScheduleMark {...props} />)
}

/** Flush the source's initial read and its publication. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

describe('Session schedule sidebar mark', () => {
  it('shows no mark until a read settles, and none for an empty, ended-only, or failed read', async () => {
    const pending = renderMark(sourceFor(() => new Promise(() => {})))
    expect(pending.container.querySelector('[data-session-schedule-mark]')).toBeNull()
    pending.unmount()

    const empty = renderMark(sourceFor(async () => ({ ok: true, value: [] })))
    await settle()
    expect(empty.container.querySelector('[data-session-schedule-mark]')).toBeNull()

    const ended = renderMark(sourceFor(async () => ({ ok: true, value: [entry('ended', SESSION, 'inactive')] })))
    await settle()
    expect(ended.container.querySelector('[data-session-schedule-mark]')).toBeNull()

    const failed = renderMark(sourceFor(async () => ({
      ok: false, error: new RemoteError('gateway/internal', 'Unavailable', {}),
    })))
    await settle()
    expect(failed.container.querySelector('[data-session-schedule-mark]')).toBeNull()
  })

  it('marks a row whose Session has an active task and names the count', async () => {
    renderMark(sourceFor(async () => ({ ok: true, value: [entry('mark-task', SESSION)] })))
    await settle()
    const mark = screen.getByText(en['mark.aria'].replace('{count}', '1')).parentElement as HTMLElement
    expect(mark.getAttribute('data-session-schedule-mark')).toBe('')
    expect(mark.querySelectorAll('svg')).toHaveLength(1)
  })

  it('marks no row for a Session whose active tasks belong to another Session', async () => {
    const list = vi.fn(async (): Promise<RemoteResult<ScheduleCatalogEntry[]>> =>
      ({ ok: true, value: [entry('other-task', OTHER_SESSION)] }))
    renderMark(sourceFor(list), SESSION)
    await settle()
    expect(document.querySelector('[data-session-schedule-mark]')).toBeNull()
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('answers many rows from one shared catalog read', async () => {
    const list = vi.fn(async (): Promise<RemoteResult<ScheduleCatalogEntry[]>> => ({
      ok: true,
      value: [entry('first-task', SESSION), entry('second-task', OTHER_SESSION)],
    }))
    const source = sourceFor(list)
    render(
      <div>
        <SessionScheduleMark {...{
          sessionId: SESSION,
          useCatalog: bindSnapshotSelector(source.hooks.catalog),
          t: makeTranslate(en),
        } as SessionScheduleMarkProps} />
        <SessionScheduleMark {...{
          sessionId: OTHER_SESSION,
          useCatalog: bindSnapshotSelector(source.hooks.catalog),
          t: makeTranslate(en),
        } as SessionScheduleMarkProps} />
      </div>,
    )
    await settle()
    expect(document.querySelectorAll('[data-session-schedule-mark]')).toHaveLength(2)
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('does not activate the Session through the row click target', async () => {
    const onOpen = vi.fn()
    const source = sourceFor(async () => ({ ok: true, value: [entry('mark-task', SESSION)] }))
    const props = {
      sessionId: SESSION,
      useCatalog: bindSnapshotSelector(source.hooks.catalog),
      t: makeTranslate(en),
    } as SessionScheduleMarkProps
    render(<div onClick={onOpen}><SessionScheduleMark {...props} /></div>)
    await settle()
    fireEvent.click(screen.getByText(en['mark.aria'].replace('{count}', '1')))
    expect(onOpen).not.toHaveBeenCalled()
  })
})
