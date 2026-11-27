/** Session panel section listing the current Session's subagents. */
import { useCallback, useMemo } from 'react'
import { HoverCardGroup } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { NS } from './locales.ts'
import type { PanelDetailsProps } from '@deepseek-ai/dsh-client-ui-session-panel/client'
import {
  CatalogTree, deriveCatalogs, levelPreparer, progressOf, type Catalogs, type SubagentCatalogInjected, type SubagentCatalogSnapshot,
} from './SubagentCatalog.tsx'
import type { createSubagentsSectionStore } from './subagents-store.ts'
import css from './SubagentCatalog.module.css'

/** Full props of the subagents section. */
export type SubagentsSectionProps =
  PropsRuntime<'conversation.session.panel.section'>
  & PropsRenderFactories
  & InjectFace<SubagentCatalogInjected>
  & PropsStore<ReturnType<typeof createSubagentsSectionStore>>
  & PropsLocale<typeof NS>

/** Rows the list shows before its fold control holds the rest back. */
const FOLD_LIMIT = 5

const NO_ENTRIES: SubagentCatalogSnapshot['entries'] = []

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
 * Order the section's rows: running subagents first, the most recently started
 * first, then the others, the most recently active first. A running subagent
 * sorts by the start of its open turn and another one by its Session's last
 * update. A subagent the Client holds neither for sorts by when its parent
 * created it: its turn timing is not read yet, or its Session is not in the
 * Host list, whose stand-in row carries no update time. Rows that tie keep
 * their catalog order.
 * @param entries - the Session's direct subagents in catalog order.
 * @param summaries - Session list rows by id.
 * @returns the entries in display order.
 */
function sectionOrder(
  entries: SubagentCatalogSnapshot['entries'], summaries: ReturnType<typeof deriveSummaries>,
): SubagentCatalogSnapshot['entries'] {
  return entries
    .map((entry) => {
      const summary = summaries[entry.id]
      const running = entry.activity === 'running'
      // A Session is last updated after it is created, so the later of the two is the update time when the Client has one.
      const at = running
        ? summary?.projectionValues?.subagentTiming?.active?.since ?? entry.createdAt
        : Math.max(summary?.updatedAt ?? 0, entry.createdAt)
      return { entry, running, at }
    })
    .sort((left, right) => Number(right.running) - Number(left.running) || right.at - left.at)
    .map(row => row.entry)
}

/**
 * Render the Session's subagent tree, running subagents first and then the
 * most recently active ones. The list shows five rows and then a fold control
 * that shows the rest, once that holds back two rows or more; the choice is
 * kept per Session. The section renders nothing while the Session has no
 * subagents and no failed catalog read. Showing it reads nothing: rows offer
 * expansion from locally known catalogs, and expanding a branch or retrying a
 * failed read prepares that level. Opening a subagent closes the panel's
 * overlay.
 * @param props - Session hooks, panel owner values, the fold store, catalog actions, and copy.
 * @returns the section body, or null with nothing to show.
 */
export function SubagentsSection({
  sessionId, dismissOverlay, useSessions, useSessionStatus, useStore, actions, openChild, openChildAside, prepareCatalog,
  renderFactorySlot, t,
}: SubagentsSectionProps) {
  const { catalogs, summaries } = useCatalogs({ useSessions, useSessionStatus })
  const catalog = catalogs[sessionId]
  const unfolded = useStore(state => state.unfolded)
  const prepareLevel = useMemo(() => levelPreparer(prepareCatalog), [prepareCatalog])
  const panelDetails = useCallback(
    (details: PanelDetailsProps) => renderFactorySlot('conversation.session.panel.details', details), [renderFactorySlot],
  )
  const ordered = useMemo(() => catalog === undefined ? NO_ENTRIES : sectionOrder(catalog.entries, summaries), [catalog, summaries])
  // Folding holds back two rows or more, since the fold control takes a row itself.
  const foldable = ordered.length > FOLD_LIMIT + 1
  const shown = useMemo(
    () => catalog === undefined ? undefined : { ...catalog, entries: foldable && !unfolded ? ordered.slice(0, FOLD_LIMIT) : ordered },
    [catalog, ordered, foldable, unfolded],
  )
  if (shown === undefined || (shown.state !== 'error' && ordered.length === 0)) return null
  const label = unfolded ? t('list.less') : t('list.more', { count: ordered.length - FOLD_LIMIT })
  return (
    <div className={css.sectionBody} data-subagents-section="">
      {/* Moving between rows swaps their hover cards without another dwell. */}
      <HoverCardGroup>
        <CatalogTree
          rootSessionId={sessionId}
          catalog={shown}
          catalogs={catalogs}
          summaries={summaries}
          openChild={openChild}
          openChildAside={openChildAside}
          prepareLevel={prepareLevel}
          onOpened={dismissOverlay}
          panelDetails={panelDetails}
          t={t}
        />
      </HoverCardGroup>
      {foldable && renderFactorySlot('conversation.session.panel.fold', {
        expanded: unfolded,
        label,
        name: t('list.foldName', { label }),
        onToggle: () => { actions.unfoldedSet(!unfolded) },
      })}
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
