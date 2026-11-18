/** Breadcrumb switcher for subagent Sessions: the current title opens its siblings' tree. */
import { useMemo, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { MenuSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  CatalogTree, deriveCatalogs, entryName, levelPreparer, treeItems, type SubagentCatalogInjected, type SubagentCatalogSnapshot,
} from './SubagentCatalog.tsx'
import css from './SubagentCatalog.module.css'

export type { SubagentCatalogInjected } from './SubagentCatalog.tsx'

/** Full props for the session-header lineage renderer. */
export type SubagentHeaderLineageProps =
  PropsRuntime<'conversation.session.header.lineage'> & InjectFace<SubagentCatalogInjected> & PropsLocale<typeof NS>

function SubagentSwitcherIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5.99951 12.7L8.95546 14.9478C9.40011 15.2859 9.62244 15.455 9.87526 15.488C9.95774 15.4988 10.0413 15.4988 10.1238 15.488C10.3766 15.455 10.5989 15.2859 11.0436 14.9478L13.9995 12.7"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M13.9995 7.7417L11.0436 5.49387C10.5989 5.15574 10.3766 4.98668 10.1238 4.95362C10.0413 4.94283 9.95775 4.94283 9.87527 4.95362C9.62245 4.98668 9.40012 5.15574 8.95547 5.49387L5.99952 7.7417"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  )
}


interface SwitcherProps extends InjectFace<SubagentCatalogInjected> {
  /** Parent Session whose direct catalog roots the tree. */
  rootSessionId: SessionId
  /** Selected descendant highlighted in the tree. */
  currentSessionId: SessionId
  /** Visible title included in the switcher's hover target. */
  displayTitle: string
  /** Optional ancestor navigation when the combined title is clicked. */
  openTitle?: () => void
  useSessions: SubagentHeaderLineageProps['useSessions']
  useSessionStatus: SubagentHeaderLineageProps['useSessionStatus']
  t: TranslateNS<typeof NS>
}

/**
 * Title-and-chevron dropdown over the parent's subagent tree. Hover opens it
 * after 150ms and leaving both surfaces closes it after 120ms; a click pins it
 * until an outside press or Escape. With `openTitle`, a click navigates to the
 * ancestor instead. Hovering reads nothing; a pinning click or ArrowDown
 * prepares the parent's level.
 * @param props - tree root, current Session, title, Session hooks, actions, and copy.
 * @returns the switcher.
 */
function Switcher({
  rootSessionId, currentSessionId, displayTitle, openTitle,
  useSessions, useSessionStatus, openChild, openChildAside, prepareCatalog, t,
}: SwitcherProps) {
  const projections = useSessions(state => state.projectionsBySession)
  const summaries = useSessions(state => state.byId)
  const statuses = useSessionStatus(value => value)
  const catalogs = useMemo(() => deriveCatalogs(projections, summaries, statuses), [projections, summaries, statuses])
  const catalog: SubagentCatalogSnapshot = catalogs[rootSessionId] ?? { entries: [], state: 'idle', error: null }
  const prepareLevel = levelPreparer(prepareCatalog)
  const [open, setOpen] = useState<'closed' | 'hover' | 'pinned' | 'keyboard'>('closed')
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const anchorName = `--dsh-subagents-${useId().replaceAll(':', '')}`
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const currentEntry = catalog.entries.find(entry => entry.id === currentSessionId)
  const title = currentEntry !== undefined ? currentEntry.label || entryName(currentEntry) : displayTitle
  const shown = open !== 'closed'

  const cancelHover = (): void => {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = undefined
  }
  const close = (restoreFocus = false): void => {
    cancelHover()
    setOpen('closed')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  useEffect(() => {
    if (!shown) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) close()
    }
    const dismiss = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close(menuRef.current?.contains(document.activeElement) === true)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', dismiss)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', dismiss)
    }
  }, [shown])
  useEffect(() => cancelHover, [])

  const hoverIn = (pointerType: string): void => {
    if (pointerType === 'touch') return
    cancelHover()
    if (shown) return
    hoverTimer.current = setTimeout(() => { setOpen('hover') }, 150)
  }
  const hoverOut = (): void => {
    cancelHover()
    if (open !== 'hover') return
    hoverTimer.current = setTimeout(() => { setOpen('closed') }, 120)
  }

  return (
    <div className={`${css.root} ${css.switcherRoot}`} ref={rootRef} data-subagent-action onPointerLeave={hoverOut}>
      <button
        ref={triggerRef}
        style={{ anchorName }}
        type="button"
        className={`${css.switcherTrigger} ${openTitle !== undefined ? css.ancestorSwitcherTrigger : ''}`}
        aria-haspopup="dialog"
        aria-expanded={shown}
        aria-label={t('switcher.aria', { title })}
        onPointerEnter={(event) => { hoverIn(event.pointerType) }}
        onClick={() => {
          cancelHover()
          if (openTitle !== undefined) {
            close()
            openTitle()
            return
          }
          setOpen('pinned')
          prepareLevel(rootSessionId)
          queueMicrotask(() => { menuRef.current?.focus() })
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return
          event.preventDefault()
          // The menu may have opened before its rows loaded, leaving focus here; the key then moves it into the menu.
          const menu = menuRef.current
          if (shown && menu !== null) {
            (treeItems(menu)[0] ?? menu).focus()
            return
          }
          setOpen('keyboard')
          prepareLevel(rootSessionId)
        }}
      >
        <span className={css.switcherTitle}>{title}</span>
        <SubagentSwitcherIcon />
      </button>
      {shown && createPortal((
        <MenuSurface
          ref={menuRef}
          className={css.menu}
          style={{ positionAnchor: anchorName }}
          role="dialog"
          tabIndex={-1}
          aria-label={t('tree.aria')}
          data-subagent-panel
          onKeyDown={(event) => {
            // A pinned menu takes focus itself; the tree handles keys once a row has focus.
            if (event.target !== event.currentTarget) return
            const items = treeItems(event.currentTarget)
            const row = event.key === 'ArrowDown' || event.key === 'Home' ? items[0]
              : event.key === 'ArrowUp' || event.key === 'End' ? items.at(-1) : undefined
            if (row === undefined) return
            event.preventDefault()
            row.focus()
          }}
          onPointerEnter={(event) => { if (event.pointerType !== 'touch') cancelHover() }}
          onPointerLeave={hoverOut}
        >
          <div className={css.menuBody}>
            <CatalogTree
              rootSessionId={rootSessionId}
              currentSessionId={currentSessionId}
              catalog={catalog}
              catalogs={catalogs}
              summaries={summaries}
              openChild={openChild}
              openChildAside={openChildAside}
              prepareLevel={prepareLevel}
              onOpened={() => { close() }}
              focusFirst={open === 'keyboard'}
              t={t}
            />
          </div>
        </MenuSurface>
      ), document.body)}
    </div>
  )
}

/**
 * Render one breadcrumb title together with its sibling switcher. The
 * Session's own subagents are listed by the Session panel section.
 * @param props - Breadcrumb title, session standard props, and catalog actions.
 * @returns A title-and-chevron sibling switcher, or nothing on a root session.
 */
export function SubagentHeaderLineage({
  lineageSessionId, displayTitle, openTitle,
  useSessions, useSession, useSessionStatus, openChild, openChildAside, refreshProjection, prepareCatalog, t,
}: SubagentHeaderLineageProps) {
  const address = useSession(session => session.subagent?.address)
  const parentId = useSessions((state) => {
    if (address?.childSessionId === lineageSessionId) return address.parentSessionId
    for (const [parentId, snapshot] of Object.entries(state.projectionsBySession)) {
      if (snapshot.values.subagentCatalog?.some(entry => entry.id === lineageSessionId)) return parentId as SessionId
    }
    const summary = state.byId[lineageSessionId]
    return summary?.origin === 'subagent' ? summary.parentId : undefined
  })
  if (parentId === undefined) return null
  return (
    <Switcher
      key={`switcher:${lineageSessionId}`}
      rootSessionId={parentId}
      currentSessionId={lineageSessionId}
      displayTitle={displayTitle}
      {...openTitle === undefined ? {} : { openTitle }}
      useSessions={useSessions}
      useSessionStatus={useSessionStatus}
      openChild={openChild}
      openChildAside={openChildAside}
      refreshProjection={refreshProjection}
      prepareCatalog={prepareCatalog}
      t={t}
    />
  )
}
