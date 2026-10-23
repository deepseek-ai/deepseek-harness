/** Strict per-session header/body content inserted into the resident conversation layout. */

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button, IconEllipsisOutlineRegular, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ConversationSessionHeaderSlotProps, ConversationSessionSlotProps, ConversationViewActionsOwnerProps,
} from '../contract/slots.ts'
import { resolveActiveView } from '../view-selection.ts'
import { FIXED_VIEW_ID } from '../view-pins.ts'
import { DefaultConversationViews } from './DefaultConversationViews.tsx'
import css from './ConversationRoot.module.css'

/** Full props composed from the strict session body contract. */
export type ConversationSessionProps = ConversationSessionSlotProps

/** Full props composed from the strict session header contract. */
export type ConversationSessionHeaderProps = ConversationSessionHeaderSlotProps

type ViewsMoreMenuProps =
  Omit<ConversationViewActionsOwnerProps, 'onDismiss'>
  & Pick<ConversationSessionHeaderSlotProps, 'renderSlot'>
  & { readonly label: string; readonly current: boolean }

/** The View tab row's More launcher; its menu rows come from `conversation.session.header.views.actions`. */
function ViewsMoreMenu({ label, current, entries, onOpen, onPinnedChange, renderSlot }: ViewsMoreMenuProps) {
  const [open, setOpen] = useState(false)
  const onDismiss = (): void => { setOpen(false) }
  return (
    <Menu open={open} onClose={onDismiss} portal autoFocus className={css.viewsMoreAnchor} listClassName={css.viewsMoreMenu}
      anchor={(
        <Tooltip label={label} portal>
          <Button size="sm" className={clsx(css.viewsMore, current && css.viewsMoreActive)} aria-label={label} aria-haspopup="menu" aria-expanded={open}
            onClick={() => { setOpen(value => !value) }}>
            <IconEllipsisOutlineRegular size={13} />
          </Button>
        </Tooltip>
      )}>
      {renderSlot('conversation.session.header.views.actions', { entries, onOpen, onPinnedChange, onDismiss })}
    </Menu>
  )
}

interface Breadcrumb {
  readonly id: SessionId
  readonly displayTitle: string
  readonly subagent: boolean
}

function deriveAncestry(list: SessionListState, id: SessionId): readonly Breadcrumb[] {
  const chain: Breadcrumb[] = []
  const seen = new Set<SessionId>()
  let cursor: SessionId | undefined = id
  while (cursor !== undefined) {
    if (seen.has(cursor)) break
    seen.add(cursor)
    const summary: SessionSummary | undefined = list.byId[cursor]
    if (summary === undefined) break
    chain.unshift({
      id: summary.id,
      displayTitle: summary.displayTitle,
      subagent: summary.origin === 'subagent',
    })
    if (summary.origin !== 'subagent') break
    cursor = summary.parentId
  }
  return chain
}

function equalBreadcrumbs(left: readonly Breadcrumb[], right: readonly Breadcrumb[]): boolean {
  return left.length === right.length
    && left.every((item, index) => {
      const other = right.at(index)
      return other !== undefined && item.id === other.id && item.displayTitle === other.displayTitle
    })
}

/**
 * Renders Session header chrome above the resident conversation scrollport.
 * @param props - Strict Session store, view ledger, navigation, render, and locale shares.
 * @returns Session navigation controls, with title and tabs after conversation starts.
 */
export function ConversationSessionHeader({
  sessionId, hideChrome, useSessions, useConversationViews, useStore,
  renderSlot, open, selectView, setPinned, t, useEntryPins, useEntryActions,
}: ConversationSessionHeaderProps) {
  const tabs = useConversationViews(value => value)
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const ancestry = useSessions(s => deriveAncestry(s, sessionId), equalBreadcrumbs)
  const unpinned = useEntryPins(ids => ids)
  const hasEntryActions = useEntryActions(registered => registered)
  const showTabs = !hideChrome && tabs.length > 1
  const tabRow = useRef<HTMLDivElement>(null)
  const [visibleViewLimit, setVisibleViewLimit] = useState(1)
  // Observe only the available row width; individual tabs are not measured.
  useLayoutEffect(() => {
    const row = tabRow.current
    if (row === null || !hasEntryActions) return
    const updateLimit = (): void => {
      setVisibleViewLimit(Math.max(1, Math.floor((row.clientWidth - 48) / 120)))
    }
    updateLimit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateLimit)
    observer.observe(row)
    return () => { observer.disconnect() }
  }, [showTabs, hasEntryActions])
  const { visibleTabs, moreTabs } = useMemo(() => {
    const preferred = [
      ...tabs.filter(tab => tab.id === FIXED_VIEW_ID),
      ...tabs.filter(tab => tab.id !== FIXED_VIEW_ID && !unpinned.includes(tab.id)),
    ]
    const visibleTabs = hasEntryActions ? preferred.slice(0, visibleViewLimit) : preferred
    const visibleIds = new Set(visibleTabs.map(tab => tab.id))
    return { visibleTabs, moreTabs: tabs.filter(tab => !visibleIds.has(tab.id)) }
  }, [tabs, unpinned, hasEntryActions, visibleViewLimit])
  const currentInMore = moreTabs.some(tab => tab.id === active?.id)
  return (
    <>
      <div className={css.titleRow}>
        {!hideChrome && (
          <>
            <div className={css.titleCluster}>
              <nav className={css.crumbs} aria-label={t('session.hierarchy')}>
                {ancestry.map((summary, index) => {
                  const last = index === ancestry.length - 1
                  // The current crumb has no navigation, so it is plain text
                  // rather than a disabled button: on darwin desktop a button
                  // would subtract itself from the header's drag row (ui-web
                  // base.css) and leave the title inert for dragging too.
                  const title = last
                    ? (
                      <span className={clsx(css.crumb, summary.subagent && css.crumbSubagent, css.crumbCurrent)}>
                        {summary.displayTitle}
                      </span>
                    )
                    : (
                      <button
                        type="button"
                        className={clsx(css.crumb, summary.subagent && css.crumbSubagent)}
                        onClick={() => { open(summary.id) }}
                      >
                        {summary.displayTitle}
                      </button>
                    )
                  const lineage = last || summary.subagent
                  const lineageOwner = {
                    lineageSessionId: summary.id,
                    displayTitle: summary.displayTitle,
                    ...last ? {} : { openTitle: () => { open(summary.id) } },
                  }
                  return (
                    <span key={summary.id} className={css.crumbSeg}>
                      {index > 0 && <span className={css.crumbSep}>/</span>}
                      {lineage
                        ? summary.subagent
                          ? renderSlot(
                            'conversation.session.header.lineage',
                            lineageOwner,
                            { fallback: title },
                          )
                          : (
                            <>
                              {title}
                              {renderSlot(
                                'conversation.session.header.lineage',
                                lineageOwner,
                                { fallback: null },
                              )}
                            </>
                          )
                        : title}
                    </span>
                  )
                })}
                {ancestry.length === 0 && <span className={css.crumbCurrent}>{sessionId}</span>}
              </nav>
              <div className={css.headerActions}>
                {renderSlot('conversation.session.header.actions', {})}
              </div>
            </div>
            <div className={css.headerUtilities}>
              {renderSlot('conversation.session.header.utilities', {})}
            </div>
          </>
        )}
        <div className={css.headerCorner} data-conversation-header-corner="">
          {renderSlot('conversation.session.header.corner', {})}
        </div>
      </div>
      {showTabs && (
        // data-conversation-tabs: marks the tab strip, which the window-chrome
        // geometry and the browser coverage lane anchor on.
        <div ref={tabRow} className={css.tabs}>
          <div className={css.viewTabs} role="tablist" data-conversation-tabs="">
            {visibleTabs.map(viewTab => (
              <button
                key={viewTab.id}
                type="button"
                role="tab"
                aria-selected={viewTab.id === active?.id}
                className={clsx(css.tab, viewTab.id === active?.id && css.tabActive)}
                onClick={() => { selectView(viewTab.id) }}
              >
                <Tooltip label={viewTab.label} portal><span className={css.tabLabel}>{viewTab.label}</span></Tooltip>
              </button>
            ))}
          </div>
          {hasEntryActions && (
            <ViewsMoreMenu
              label={currentInMore && active !== undefined ? t('session.moreViewsCurrent', { name: active.label }) : t('session.moreViews')}
              current={currentInMore}
              entries={moreTabs.map(viewTab => ({
                id: viewTab.id, label: viewTab.label,
                pinned: !unpinned.includes(viewTab.id), active: viewTab.id === active?.id,
              }))}
              onOpen={selectView}
              onPinnedChange={setPinned}
              renderSlot={renderSlot}
            />
          )}
        </div>
      )}
    </>
  )
}

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft mirrored while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function ConversationSession(props: ConversationSessionProps) {
  return <DefaultConversationViews {...props} />
}
