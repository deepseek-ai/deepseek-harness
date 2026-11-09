/** Session panel section listing the current Session's subagents. */
import { useMemo } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-session-panel/client'
import {
  CatalogTree, deriveCatalogs, levelPreparer, progressOf, type Catalogs, type SubagentCatalogInjected,
} from './SubagentCatalog.tsx'
import css from './SubagentCatalog.module.css'

/** Full props of the subagents section. */
export type SubagentsSectionProps =
  PropsRuntime<'conversation.session.panel.section'>
  & InjectFace<SubagentCatalogInjected>
  & PropsLocale<typeof NS>

/** Full props of the section's progress title control. */
export type SubagentsProgressProps =
  PropsRuntime<'conversation.session.panel.section.actions'> & PropsLocale<typeof NS>

/** Full props of the running dot on the Session panel toggle. */
export type SubagentsRunningIndicatorProps =
  PropsRuntime<'conversation.session.panel.indicator'> & PropsLocale<typeof NS>

function deriveSummaries(state: Parameters<Parameters<SubagentsSectionProps['useSessions']>[0]>[0]) {
  return state.byId
}

/**
 * Read every held Session's catalog from the standard Session hooks.
 * @param props - Session list and status hooks.
 * @returns catalogs keyed by parent Session, and the Session list rows.
 */
function useCatalogs({ useSessions, useSessionStatus }: Pick<SubagentsSectionProps, 'useSessions' | 'useSessionStatus'>): {
  readonly catalogs: Catalogs
  readonly summaries: ReturnType<typeof deriveSummaries>
} {
  const projections = useSessions(state => state.projectionsBySession)
  const summaries = useSessions(deriveSummaries)
  const statuses = useSessionStatus(value => value)
  const catalogs = useMemo(() => deriveCatalogs(projections, summaries, statuses), [projections, summaries, statuses])
  return { catalogs, summaries }
}

/**
 * Render the Session's subagent tree. The section renders nothing while the
 * Session has no subagents and no failed catalog read. Showing it reads
 * nothing: rows offer expansion from locally known catalogs, and expanding a
 * branch or retrying a failed read prepares that level. Opening a subagent
 * closes the panel's overlay.
 * @param props - Session hooks, panel owner values, catalog actions, and copy.
 * @returns the section body, or null with nothing to show.
 */
export function SubagentsSection({
  sessionId, dismissOverlay, useSessions, useSessionStatus, openChild, openChildAside, prepareCatalog, t,
}: SubagentsSectionProps) {
  const { catalogs, summaries } = useCatalogs({ useSessions, useSessionStatus })
  const catalog = catalogs[sessionId]
  const prepareLevel = useMemo(() => levelPreparer(prepareCatalog), [prepareCatalog])
  if (catalog === undefined || (catalog.state !== 'error' && catalog.entries.length === 0)) return null
  return (
    <div className={css.sectionBody} data-subagents-section="">
      <CatalogTree
        rootSessionId={sessionId}
        catalog={catalog}
        catalogs={catalogs}
        summaries={summaries}
        openChild={openChild}
        openChildAside={openChildAside}
        prepareLevel={prepareLevel}
        onOpened={dismissOverlay}
        t={t}
      />
    </div>
  )
}

/**
 * Render the direct subagents' progress beside the section title.
 * @param props - Session hooks and copy.
 * @returns the progress phrase, or null without subagents.
 */
export function SubagentsProgress({ sessionId, useSessions, useSessionStatus, t }: SubagentsProgressProps) {
  const { catalogs, summaries } = useCatalogs({ useSessions, useSessionStatus })
  const catalog = catalogs[sessionId]
  const progress = catalog === undefined ? '' : progressOf(catalog, summaries, t)
  if (progress === '') return null
  return <span className={css.sectionProgress}>{progress}</span>
}

/**
 * Show on the panel toggle that direct subagents run while the panel does not
 * show them. External tasks do not count, as in the section's progress.
 * @param props - Session hooks, whether the panel shows, and copy.
 * @returns the dot with its name for assistive technology, or null with nothing to report.
 */
export function SubagentsRunningIndicator({ sessionId, panelShown, useSessions, useSessionStatus, t }: SubagentsRunningIndicatorProps) {
  const { catalogs } = useCatalogs({ useSessions, useSessionStatus })
  const running = catalogs[sessionId]?.entries.filter(entry => entry.mode !== 'external' && entry.activity === 'running').length ?? 0
  if (panelShown || running === 0) return null
  return (
    <span className={css.runningIndicator} data-subagents-running="">
      <span className={css.visuallyHidden}>{t('indicator.running', { count: running })}</span>
    </span>
  )
}
