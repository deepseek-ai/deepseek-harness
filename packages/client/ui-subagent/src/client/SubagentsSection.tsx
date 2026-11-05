/** Session panel section listing the current Session's subagents. */
import { useMemo } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-session-panel/client'
import type {} from '@deepseek-ai/dsh-agent-team/client'
import { CatalogTree, deriveCatalogs, progressOf, type SubagentCatalogInjected, type SubagentCatalogSnapshot } from './SubagentCatalog.tsx'
import type {} from './slots.ts'
import css from './SubagentCatalog.module.css'

/** Catalog actions and availability of the section's optional footer. */
export type SubagentsSectionInjected = SubagentCatalogInjected & {
  hooks: {
    /** Whether the footer currently has a registered contributor. */
    footerAvailable: HostObservable<boolean>
  }
}

/** Full props of the subagents section. */
export type SubagentsSectionProps =
  PropsRuntime<'conversation.session.panel.section'>
  & Omit<PropsRenderSlots<'conversation.session.panel.subagents.footer'>, 'SessionProvider'>
  & InjectFace<SubagentsSectionInjected>
  & PropsLocale<typeof NS>

/** Full props of the section's progress title control. */
export type SubagentsProgressProps =
  PropsRuntime<'conversation.session.panel.section.actions'> & PropsLocale<typeof NS>

const LOADING: SubagentCatalogSnapshot = { entries: [], state: 'loading', error: null }

/**
 * Render the Session's subagent tree and, when a contributor registered one,
 * the footer such as the shared task board. The section renders nothing while
 * the Session has no subagents, no failed catalog read, and no board content.
 * Opening a subagent closes the panel's overlay.
 * @param props - Session hooks, panel owner values, catalog actions, footer renderer, and copy.
 * @returns the section body, or null with nothing to show.
 */
export function SubagentsSection({
  sessionId, dismissOverlay, useSessions, useSessionStatus, useProjection, useFooterAvailable,
  openChild, openChildAside, refreshProjection, renderSlot, t,
}: SubagentsSectionProps) {
  const projections = useSessions(state => state.projectionsBySession)
  const summaries = useSessions(state => state.byId)
  const statuses = useSessionStatus(value => value)
  const catalogs = useMemo(() => deriveCatalogs(projections, summaries, statuses), [projections, summaries, statuses])
  const footerAvailable = useFooterAvailable(value => value)
  const hasSharedTasks = useProjection('agentTeam', team => team?.enabled === true
    && team.tasks.some(task => task.status !== 'deleted'))
  const hasTaskFailure = useProjection('agentTeam', team => team?.enabled === true && team.failure !== undefined)
  const boardContent = footerAvailable && (hasSharedTasks || hasTaskFailure)
  const catalog = catalogs[sessionId]
  const listed = catalog !== undefined && (catalog.state === 'error' || catalog.entries.length > 0)
  if (!listed && !boardContent) return null
  const presented = catalog ?? LOADING
  return (
    <div className={css.sectionBody} data-subagents-section="">
      {presented.state === 'ready' && presented.entries.length === 0
        ? <p className={css.sectionEmpty}>{t('section.empty')}</p>
        : (
          <CatalogTree
            rootSessionId={sessionId}
            catalog={presented}
            catalogs={catalogs}
            summaries={summaries}
            openChild={openChild}
            openChildAside={openChildAside}
            refreshProjection={refreshProjection}
            onOpened={dismissOverlay}
            t={t}
          />
        )}
      {footerAvailable && renderSlot('conversation.session.panel.subagents.footer', {})}
    </div>
  )
}

/**
 * Render the direct subagents' progress beside the section title.
 * @param props - Session hooks and copy.
 * @returns the progress phrase, or null without subagents.
 */
export function SubagentsProgress({ sessionId, useSessions, useSessionStatus, t }: SubagentsProgressProps) {
  const projections = useSessions(state => state.projectionsBySession)
  const summaries = useSessions(state => state.byId)
  const statuses = useSessionStatus(value => value)
  const progress = useMemo(() => {
    const catalog = deriveCatalogs(projections, summaries, statuses)[sessionId]
    return catalog === undefined ? '' : progressOf(catalog, summaries, t)
  }, [projections, summaries, statuses, sessionId, t])
  if (progress === '') return null
  return <span className={css.sectionProgress}>{progress}</span>
}
