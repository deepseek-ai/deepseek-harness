// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ArchivedSessionsSection } from '../src/client/ArchivedSessionsSection.tsx'
import type { ArchivedSessionsSectionProps } from '../src/client/ArchivedSessionsSection.tsx'
import { en, type ArchivedSessionsLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const DAY = 86_400_000
const sid = (id: string): SessionId => id as SessionId

const t = ((key: ArchivedSessionsLocaleKey, params?: Record<string, string | number>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    en[key],
  )) as ArchivedSessionsSectionProps['t']

function summary(id: string, title: string, updatedAt: number): SessionSummary {
  return { id: sid(id), displayTitle: title, running: false, blank: false, updatedAt }
}

function sessionState(sessions: readonly SessionSummary[], phase: SessionListState['phase'] = 'ready'): SessionListState {
  return {
    ids: sessions.map(session => session.id),
    byId: Object.fromEntries(sessions.map(session => [session.id, session])),
    current: undefined,
    phase,
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function snapshot(archivedSessionIds: readonly string[], items: readonly WorkspaceView[] = []): WorkspaceSnapshot {
  return { items, archivedSessionIds: archivedSessionIds.map(sid), state: 'idle', phase: 'ready', error: null }
}

function workspace(title: string, sessionIds: readonly string[]): WorkspaceView {
  return {
    workspaceId: title as WorkspaceView['workspaceId'],
    path: `/work/${title}`,
    title,
    sessionIds: sessionIds.map(sid),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function props(options: {
  sessions: SessionListState
  workspaces: WorkspaceSnapshot
  unarchive?: (sessionId: SessionId) => Promise<void>
}): ArchivedSessionsSectionProps {
  return {
    t,
    unarchive: options.unarchive ?? (async () => {}),
    useSessions: ((select: (state: SessionListState) => unknown) => select(options.sessions)),
    useWorkspaces: ((select: (state: WorkspaceSnapshot) => unknown) => select(options.workspaces)),
  } as unknown as ArchivedSessionsSectionProps
}

/** Two archived sessions in one Workspace, archived oldest first. */
function twoRows(): ArchivedSessionsSectionProps {
  return props({
    sessions: sessionState([
      summary('older', 'Older session', Date.now() - 2 * DAY),
      summary('newer', 'Newer session', Date.now()),
    ]),
    workspaces: snapshot(['older', 'newer'], [workspace('Project', ['older', 'newer'])]),
  })
}

describe('ArchivedSessionsSection', () => {
  it('lists the newest archive first with its Workspace and last activity', () => {
    render(<ArchivedSessionsSection {...twoRows()} />)

    expect(screen.getAllByRole('listitem').map(row => row.textContent)).toEqual([
      'Newer sessionProject · nowUnarchive',
      'Older sessionProject · 2dUnarchive',
    ])
    expect(screen.getAllByRole('button', { name: /^Unarchive/ }).map(button => button.getAttribute('aria-label')))
      .toEqual(['Unarchive Newer session', 'Unarchive Older session'])
  })

  it('labels a session outside every Workspace and hides an entry whose session is gone', () => {
    render(<ArchivedSessionsSection {...props({
      sessions: sessionState([summary('loose', 'Loose session', Date.now())]),
      workspaces: snapshot(['gone', 'loose']),
    })} />)

    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('Loose session')).toBeTruthy()
    expect(screen.getByText('Ungrouped · now')).toBeTruthy()
  })

  it('reads sessions until the list arrives, then reports an empty archive', () => {
    const pending = render(<ArchivedSessionsSection {...props({
      sessions: sessionState([], 'pending'),
      workspaces: snapshot([]),
    })} />)
    expect(screen.getByText(en.loading)).toBeTruthy()
    expect(screen.queryByRole('searchbox')).toBeNull()
    pending.unmount()

    render(<ArchivedSessionsSection {...props({ sessions: sessionState([]), workspaces: snapshot([]) })} />)
    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  it('does not report an empty archive while every entry lacks a Session summary', () => {
    render(<ArchivedSessionsSection {...props({
      sessions: sessionState([]),
      workspaces: snapshot(['gone', 'vanished']),
    })} />)

    expect(screen.getByText(en.unavailable)).toBeTruthy()
    expect(screen.queryByText(en.empty)).toBeNull()
    expect(screen.queryByText(en.emptySearch)).toBeNull()
  })

  it('filters by title and Workspace and reports a query with no match', () => {
    render(<ArchivedSessionsSection {...twoRows()} />)
    const search = screen.getByRole('searchbox', { name: en.search })

    fireEvent.change(search, { target: { value: 'older' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('Older session')).toBeTruthy()

    fireEvent.change(search, { target: { value: 'project' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(2)

    fireEvent.change(search, { target: { value: 'absent' } })
    expect(screen.getByText(en.emptySearch)).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
    expect(screen.queryByText(en.empty)).toBeNull()
  })

  it('unarchives the clicked row and keeps a rejection as a console diagnostic', async () => {
    const unarchive = vi.fn(async () => {})
    render(<ArchivedSessionsSection {...twoRows()} unarchive={unarchive} />)
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive Newer session' }))
    expect(unarchive).toHaveBeenCalledWith('newer')

    cleanup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = new Error('transport down')
    render(<ArchivedSessionsSection {...props({
      sessions: sessionState([summary('older', 'Older session', Date.now())]),
      workspaces: snapshot(['older']),
      unarchive: async () => { throw failure },
    })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive Older session' }))
    await waitFor(() => { expect(warn).toHaveBeenCalledWith('session unarchive rejected:', failure) })
    warn.mockRestore()
  })
})
