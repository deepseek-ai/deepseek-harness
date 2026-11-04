/**
 * One pane's workspace navigator: the tree and the edge that resizes it. The
 * `files` page draws it below its header; beside a preview the preview's own
 * header is the only one. Everything it shows lives in the store and face,
 * keyed by pane, so a remount on a tab switch or replacement draws it
 * unchanged, keyboard focus included when the tree held it. Its layout
 * follows `PUSH_FROM`, `FILL_BELOW`, and `FULLSCREEN_QUERY`; the package
 * README describes its behavior.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import clsx from 'clsx'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TreeEntry } from './FileTree.tsx'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import type { FilesInjected } from './face.ts'
import { DEFAULT_NAVIGATOR_WIDTH, PUSH_FROM, locateFile, navigatorGeometry, relativeFileOf, type createFilesStore } from './store.ts'
import { parentOf, treeRootOf, workspaceDirectories, workspaceEntries } from './workspace-tree.ts'
import { FILL_BELOW } from './navigator-layout.ts'
import css from './FilesBody.module.css'

/** What a navigator occurrence is drawn for. */
export interface FileNavigatorInput {
  /** The tab the navigator is drawn beside, and its pane. */
  readonly useTabInfo: UseSidebarRightTabInfo
  /** Drawn for the `files` page: always shown and filling the page. */
  readonly page: boolean
  /** Ask the containing plugin to open a file. @param address - the file's resource address. */
  readonly onOpen: (address: string) => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** One pane's workspace tree with its width and show/hide state. */
    'sidebar.files.navigator': {
      scope: 'session'
      props: FileNavigatorInput
      store: ReturnType<typeof createFilesStore>
      locale: 'sidebarFiles'
      inject: FilesInjected
    }
  }
}

/** One keyboard resize step. */
const RESIZE_STEP = 20

/**
 * How a preview's navigator shares its row with the body: beside it, taking
 * width from it (`push`); floating over its right part (`overlay`); or
 * covering the whole row (`fill`).
 */
type NavigatorMode = 'push' | 'overlay' | 'fill'

/**
 * The layout a preview's navigator takes in a row; `FULLSCREEN_QUERY` makes every layout fill in CSS.
 * @param rowWidth - the row's width measured by the face; `undefined` before it is measured.
 * @returns `overlay` until measured, then the layout for the width.
 */
function navigatorMode(rowWidth: number | undefined): NavigatorMode {
  if (rowWidth === undefined) return 'overlay'
  return rowWidth >= PUSH_FROM ? 'push' : rowWidth >= FILL_BELOW ? 'overlay' : 'fill'
}

/**
 * The navigator Factory's component.
 * @param props - the tab it is drawn for, the pane's store records, the tree's face, and copy.
 * @returns the navigator, or nothing while hidden or without a workspace.
 */
export function FileNavigator({
  useTabInfo, page, onOpen, sessionId, useSessions, useStore, actions, useRowWidth, useCanOpen,
  attach, placeBeside, hold, toggle, scrolled, bodyDrawn, currentDrawn, navigatorDrawn, t, renderFactorySlot, useContextMenu,
}: FactoryComponentPropsOf<'sidebar.files.navigator'>): ReactNode {
  const { tab, panel } = useTabInfo()
  const { getTriggerProps } = useContextMenu()
  const paneId = panel.id
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  const state = useStore(store => store.byPane[paneId])
  const rowWidth = useRowWidth(paneId)
  const canOpen = useCanOpen(check => check)
  const open = page || state?.open === true
  // Measured by the face; the viewport rule is CSS's, read again when a file opens.
  const mode = navigatorMode(rowWidth)
  const tree = state?.tree?.root === cwd ? state?.tree : undefined
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ readonly x: number; readonly width: number } | undefined>(undefined)
  // Stable, so each element registers once per drawing rather than on every render.
  const navigatorRef = useCallback(
    (element: HTMLElement | null) => { navigatorDrawn(paneId, element, !page) },
    [navigatorDrawn, paneId, page],
  )
  const bodyRef = useCallback(
    (body: HTMLDivElement | null) => { bodyDrawn(paneId, tab.contentId, body) },
    [bodyDrawn, paneId, tab.contentId],
  )
  const currentRef = useCallback((row: HTMLElement | null) => { currentDrawn(paneId, row) }, [currentDrawn, paneId])

  useEffect(() => attach(paneId, tab.id, tab.signal), [attach, paneId, tab.id, tab.signal])
  // Only a navigator that can draw a tree keeps the workspace command on its tab.
  useEffect(() => page || cwd === undefined ? undefined : placeBeside(tab.id), [page, cwd, placeBeside, tab.id])
  useEffect(() => cwd === undefined || !open ? undefined : hold(paneId, cwd), [cwd, open, paneId, hold])

  const relativePath = tree === undefined ? undefined : relativeFileOf(tab.contentId, sessionId, tree.root)
  const location = useMemo(
    () => tree === undefined || relativePath === undefined ? undefined : locateFile(tree, relativePath),
    [tree, relativePath],
  )
  const root = tree?.root
  const levels = tree?.levels
  const expanded = tree?.expanded
  const entries = useMemo(() => levels === undefined ? undefined : workspaceEntries(levels), [levels])
  const directories = useMemo(
    () => root === undefined || levels === undefined || expanded === undefined
      ? undefined
      : workspaceDirectories({ root, levels, expanded }, t),
    [root, levels, expanded, t],
  )
  // Kept between renders, so the tree redraws only when what it shows changes,
  // not on every measure of the row or render of the host.
  const view = useMemo(() => {
    if (tree === undefined) return undefined
    return {
      root: treeRootOf(tree.root),
      expanded: tree.expanded,
      onToggle: (entry: TreeEntry) => { toggle(paneId, parentOf(tree, entry.path), entry.path, tree.expanded) },
      onOpen: (entry: TreeEntry) => { onOpen(fileAddressFor(sessionId, tree.root, entry.path)) },
      canOpen: (entry: TreeEntry) => canOpen(fileAddressFor(sessionId, tree.root, entry.path)),
      rowTriggerProps: (entry: TreeEntry, kind: 'file' | 'directory') => getTriggerProps(kind === 'directory'
        ? { kind, value: { sessionId, path: entry.path } }
        : { kind, value: { sessionId, path: entry.path, paneId } }),
    }
  }, [tree, paneId, sessionId, toggle, canOpen, onOpen, getTriggerProps])

  if (cwd === undefined || !open) return null
  const geometry = navigatorGeometry(rowWidth, state?.width ?? DEFAULT_NAVIGATOR_WIDTH)
  // The page's tree always fills the page; a preview's follows its row.
  const shown = page ? undefined : mode
  const clamp = (next: number): number => Math.min(Math.max(next, geometry.minimum), geometry.maximum)
  return (
    <aside
      ref={navigatorRef}
      className={clsx(css.navigator, shown === undefined ? css.wholePage : css[shown], dragging && css.dragging)}
      style={page ? undefined : { '--files-navigator-width': `${geometry.width}px` } as CSSProperties}
      aria-label={t('guide.title')}
      data-files-navigator={paneId}
      data-files-navigator-mode={shown}
      data-files-state="tree"
      data-files-root={cwd}
    >
      {shown !== undefined && shown !== 'fill' && (
        <div
          className={css.separator}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('navigator.resize')}
          aria-valuemin={geometry.minimum}
          aria-valuemax={geometry.maximum}
          aria-valuenow={geometry.width}
          tabIndex={0}
          data-files-navigator-resize
          onKeyDown={(event) => {
            const next = event.key === 'ArrowLeft' ? geometry.width + RESIZE_STEP
              : event.key === 'ArrowRight' ? geometry.width - RESIZE_STEP
                : event.key === 'Home' ? geometry.minimum
                  : event.key === 'End' ? geometry.maximum
                    : undefined
            if (next === undefined) return
            event.preventDefault()
            actions.resized(paneId, clamp(next))
          }}
          onPointerDown={(event) => {
            // Only the primary button drags; a secondary press leaves the context menu to the browser.
            if (event.button !== 0) return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            drag.current = { x: event.clientX, width: geometry.width }
            setDragging(true)
          }}
          onPointerMove={(event) => {
            const origin = drag.current
            if (origin === undefined) return
            actions.resized(paneId, clamp(origin.width + origin.x - event.clientX))
          }}
          onPointerUp={(event) => {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onLostPointerCapture={() => {
            drag.current = undefined
            setDragging(false)
          }}
        />
      )}
      <div
        ref={bodyRef}
        className={css.body}
        tabIndex={-1}
        data-files-body
        onScroll={(event) => { scrolled(paneId, event.currentTarget.scrollTop) }}
      >
        {view === undefined || entries === undefined || directories === undefined
          ? <p className={css.note} data-files-row="loading">{t('loading')}</p>
          : renderFactorySlot('sidebar.files.tree', { ...view, entries, directories, current: location?.current, currentRef })}
      </div>
    </aside>
  )
}
