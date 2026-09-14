/**
 * Archived-session Settings page: the registry-global archive set joined with
 * the loaded Session summaries, newest archive first, filtered by one search
 * box, with one Unarchive action per row. An archive entry whose Session is
 * gone has no row and no action; the set itself stays host-owned.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Button, IconSearchOutline16, relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import css from './ArchivedSessionsSection.module.css'

/** Registration-side face used by the page. */
export interface ArchivedSessionsSectionInjected {
  /**
   * Restore one archived Session.
   * @param sessionId - Session to unarchive.
   */
  unarchive: (sessionId: SessionId) => Promise<void>
}

/** Full component props assembled by the Settings slot renderer. */
export type ArchivedSessionsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.archivedSessions'>
  & InjectFace<ArchivedSessionsSectionInjected>

type Translate = ArchivedSessionsSectionProps['t']

/** One archived Session as the page renders it. */
interface ArchivedRow {
  id: SessionId
  title: string
  /** Owning Workspace title, or the ungrouped label for a Session outside every Workspace. */
  workspace: string
  updatedAt: number
}

/** Localized compact relative time of one row's last activity. */
function timeLabel(updatedAt: number, now: number, t: Translate): string {
  const { unit, n } = relativeTime(updatedAt, now)
  return unit === 'now' ? t('time.now') : t(`time.${unit}`, { n })
}

/** Whether one row matches the normalized query in its title or Workspace label. */
function matches(row: ArchivedRow, normalizedQuery: string): boolean {
  return normalizedQuery.length === 0
    || row.title.toLowerCase().includes(normalizedQuery)
    || row.workspace.toLowerCase().includes(normalizedQuery)
}

/**
 * Render the archived-session page.
 * @param props - composed slot props (see {@link ArchivedSessionsSectionProps}).
 * @returns the settings page element tree.
 */
export function ArchivedSessionsSection(props: ArchivedSessionsSectionProps): ReactNode {
  const { t, unarchive, useSessions, useWorkspaces } = props
  const sessions = useSessions(state => state)
  const workspaces = useWorkspaces(state => state.items)
  const archivedSessionIds = useWorkspaces(state => state.archivedSessionIds)
  const [query, setQuery] = useState('')
  const ungrouped = t('ungrouped')
  const summaries = sessions.byId

  // Archive order is oldest first; the page lists the most recently archived
  // Session first. A member with no loaded summary is not addressable here.
  const rows = useMemo<ArchivedRow[]>(() => {
    const owners = new Map<string, string>()
    for (const workspace of workspaces) {
      for (const id of workspace.sessionIds) owners.set(id, workspace.title)
    }
    return [...archivedSessionIds].reverse().flatMap((id) => {
      const summary = summaries[id]
      if (summary === undefined) return []
      return [{
        id,
        title: summary.displayTitle,
        workspace: owners.get(id) ?? ungrouped,
        updatedAt: summary.updatedAt,
      }]
    })
  }, [archivedSessionIds, workspaces, summaries, ungrouped])

  if (sessions.phase !== 'ready') return <p className={css.status}>{t('loading')}</p>

  const now = Date.now()
  const visible = rows.filter(row => matches(row, query.trim().toLowerCase()))
  const archived = archivedSessionIds.length > 0

  return (
    <div className={css.section}>
      <div className={css.search}>
        <IconSearchOutline16 aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder={t('search')}
          aria-label={t('search')}
          onChange={(event) => { setQuery(event.currentTarget.value) }}
        />
      </div>
      {!archived ? <p className={css.status}>{t('empty')}</p> : null}
      {archived && rows.length === 0 ? <p className={css.status}>{t('unavailable')}</p> : null}
      {rows.length > 0 && visible.length === 0 ? <p className={css.status}>{t('emptySearch')}</p> : null}
      {visible.length > 0 ? (
        <ul className={css.list}>
          {visible.map(row => (
            <li key={row.id} className={css.row}>
              <span className={css.identity}>
                <span className={css.title}>{row.title}</span>
                <span className={css.meta}>
                  {[row.workspace, timeLabel(row.updatedAt, now, t)].join(' · ')}
                </span>
              </span>
              <Button
                variant="outline"
                size="sm"
                aria-label={t('unarchiveNamed', { title: row.title })}
                onClick={() => {
                  unarchive(row.id).catch((reason: unknown) => {
                    console.warn('session unarchive rejected:', reason)
                  })
                }}
              >
                {t('unarchive')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
