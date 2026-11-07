/**
 * One pane's workspace navigator: the search bar, the tree, and the edge that
 * resizes it. The `files` page draws it below its header; beside a preview the
 * preview's own header is the only one. Everything it shows lives in the store
 * and face, keyed by pane, so a remount on a tab switch or replacement draws it
 * unchanged, keyboard focus included when the tree held it. Its layout
 * follows `PUSH_FROM`, `FILL_BELOW`, and `FULLSCREEN_QUERY`; the package
 * README describes its behavior, search included.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import clsx from 'clsx'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TreeEntry } from './FileTree.tsx'
import type { FactoryComponentPropsOf, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, IconCloseOutlineRegular, IconEyeOffOutlineRegular, IconEyeOutlineRegular, IconInfoOutlineRegular, IconSearchOutlineRegular,
  StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import type { FilesInjected } from './face.ts'
import type { SidebarFilesKey } from './locales.ts'
import { SearchSettings } from './SearchSettings.tsx'
import { defaultSearchPreferences, type ExclusionRule, type WorkspaceSearchPreferences } from './search-rules.ts'
import { DEFAULT_NAVIGATOR_WIDTH, PUSH_FROM, locateFile, navigatorGeometry, relativeFileOf, type createFilesStore } from './store.ts'
import type { FilesSearchResult } from './store.ts'
import { failureLine, parentOf, searchDirectories, treeRootOf, workspaceDirectories, workspaceEntries } from './workspace-tree.ts'
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
 * Why an empty result may still hide matches.
 * @param result - a settled search with no entries.
 * @returns the hint's key, or `undefined` when the search left nothing out.
 */
function emptyHint(result: SearchFilters): SidebarFilesKey | undefined {
  const { hiddenLeftOut: hidden, excluded, ignored } = result
  if (hidden && excluded) return ignored ? 'search.emptyHint.all' : 'search.emptyHint.both'
  if (hidden) return ignored ? 'search.emptyHint.hiddenIgnored' : 'search.emptyHint.hidden'
  if (excluded) return ignored ? 'search.emptyHint.excludedIgnored' : 'search.emptyHint.excluded'
  return ignored ? 'search.emptyHint.ignored' : undefined
}

/**
 * Move keyboard focus one step along the search field and the drawn rows,
 * in document order: ↓ from the field enters the first row, and ↑ on the
 * first row returns to the field. A key that composes text in an input method,
 * or that something in the navigator already handled, stays where it is.
 * @param event - a key pressed in the navigator.
 */
function moveAlongRows(event: KeyboardEvent<HTMLElement>): void {
  if (event.defaultPrevented || event.nativeEvent.isComposing) return
  if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  const stops = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-files-search], [data-files-body] [data-files-path] > div > button')]
  const at = stops.findIndex(stop => stop === event.target)
  const next = at === -1 ? undefined : stops[at + (event.key === 'ArrowDown' ? 1 : -1)]
  if (next === undefined) return
  event.preventDefault()
  next.focus()
}

/** Which filters a search applied, and so which of them an empty result may owe its emptiness to. */
type SearchFilters = { readonly hiddenLeftOut: boolean; readonly excluded: boolean; readonly ignored: boolean }

/**
 * What the results area shows below a search's result tree: that nothing
 * matched, with an information button whose tooltip names the filters that
 * left entries out, that only the first matches are drawn, and that the
 * result may be incomplete.
 */
function SearchNotes({ result, t }: { result: Extract<FilesSearchResult, { kind: 'found' }>; t: TranslateNS<'sidebarFiles'> }): ReactNode {
  const hint = result.count > 0 ? undefined : emptyHint(result)
  return (
    <>
      {result.count === 0 && (
        <p className={clsx(css.note, css.emptyNote)} data-files-row="search-empty">
          <span>{t('search.empty')}</span>
          {hint !== undefined && (
            <Tooltip label={t(hint)} side="bottom" delayMs={300} maxWidth={300} portal openOnClick>
              <Button variant="ghost" size="sm" className={css.infoButton} aria-label={t('search.emptyHint.label')} data-files-search-hint>
                <IconInfoOutlineRegular size={11} aria-hidden="true" />
              </Button>
            </Tooltip>
          )}
        </p>
      )}
      {result.truncated && (
        <p className={css.note} data-files-row="search-truncated">{t('search.truncated', { count: String(result.count) })}</p>
      )}
      {result.incomplete && <p className={css.note} data-files-row="search-incomplete">{t('search.incomplete')}</p>}
    </>
  )
}

/**
 * What the results area shows for a search the Host could not run: why, and a control that runs it again.
 * @param props.failure - the failed search's Remote failure.
 * @param props.onRetry - runs the search again.
 * @param props.t - namespace-bound translate.
 * @returns the notice.
 */
function SearchFailure({ failure, onRetry, t }: {
  readonly failure: RemoteFailure
  readonly onRetry: () => void
  readonly t: TranslateNS<'sidebarFiles'>
}): ReactNode {
  return (
    <div className={css.searchFailure} data-files-row="search-failed">
      <p className={css.note} role="alert">{t('search.failed', { message: failureLine(t, failure) })}</p>
      <Button variant="outline" size="sm" className={css.searchRetry} data-files-search-retry onClick={onRetry}>{t('search.retry')}</Button>
    </div>
  )
}

/**
 * The navigator Factory's component.
 * @param props - the tab it is drawn for, the pane's store records, the tree's face, and copy.
 * @returns the navigator, or nothing while hidden or without a workspace.
 */
export function FileNavigator({
  useTabInfo, page, onOpen, sessionId, useSessions, useStore, actions, useRowWidth, useCanOpen, useSearchPreferences,
  attach, placeBeside, hold, toggle, scrolled, bodyDrawn, currentDrawn, navigatorDrawn,
  setQuery, toggleSearch, retrySearch, setSearchPreferences, searchDrawn, t, renderFactorySlot, useContextMenu,
}: FactoryComponentPropsOf<'sidebar.files.navigator'>): ReactNode {
  const { tab, panel } = useTabInfo()
  const { getTriggerProps } = useContextMenu()
  const paneId = panel.id
  // A Session's working directory comes from its header and never changes once
  // known, so every search result the pane's store holds is rooted at it.
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  const state = useStore(store => store.byPane[paneId])
  const rowWidth = useRowWidth(paneId)
  const canOpen = useCanOpen(check => check)
  const open = page || state?.open === true
  // Measured by the face; the viewport rule is CSS's, read again when a file opens.
  const mode = navigatorMode(rowWidth)
  const tree = state?.tree?.root === cwd ? state?.tree : undefined
  // The face resolves every key to a source, so the renderer never reports one unavailable.
  /* v8 ignore next -- the fallback only satisfies the keyed hook's optional snapshot type. */
  const preferences: WorkspaceSearchPreferences = useSearchPreferences(cwd ?? '') ?? defaultSearchPreferences()
  const { showHidden } = preferences
  const query = state?.query ?? ''
  const searchBarOpen = !page || state?.searchBarOpen === true
  const search = state?.search
  const pending = search?.pending === true
  const result = search?.result
  const found = result?.kind === 'found' ? result : undefined
  const [dragging, setDragging] = useState(false)
  const [draft, setDraft] = useState<readonly ExclusionRule[] | undefined>(undefined)
  const settings = draft !== undefined
  const drag = useRef<{ readonly x: number; readonly width: number } | undefined>(undefined)
  const input = useRef<HTMLInputElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  // Stable, so each element registers once per drawing rather than on every render.
  const navigatorRef = useCallback(
    (element: HTMLElement | null) => { navigatorDrawn(paneId, element, !page) },
    [navigatorDrawn, paneId, page],
  )
  // Also new when the container switches between the tree and the results, so
  // the face restores that view's scroll offset once its rows are drawn.
  const resultsShown = search !== undefined
  const bodyRef = useCallback(
    (body: HTMLDivElement | null) => { bodyDrawn(paneId, tab.contentId, body) },
    [bodyDrawn, paneId, tab.contentId, resultsShown],
  )
  const inputRef = useCallback((element: HTMLInputElement | null) => {
    input.current = element
    searchDrawn(paneId, element)
  }, [searchDrawn, paneId])
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
  const entries = useMemo(() => levels === undefined ? undefined : workspaceEntries(levels, showHidden), [levels, showHidden])
  const directories = useMemo(
    () => root === undefined || levels === undefined || expanded === undefined
      ? undefined
      : workspaceDirectories({ root, levels, expanded }, t, showHidden),
    [root, levels, expanded, t, showHidden],
  )
  const resultTree = found !== undefined && found.count > 0 ? found.tree : undefined
  const resultCurrent = useMemo(
    () => resultTree === undefined || relativePath === undefined ? undefined : locateFile(resultTree, relativePath).current,
    [resultTree, relativePath],
  )
  const resultEntries = useMemo(
    () => resultTree === undefined ? undefined : workspaceEntries(resultTree.levels, showHidden),
    [resultTree, showHidden],
  )
  const resultDirectories = useMemo(() => resultTree === undefined ? undefined : searchDirectories(resultTree), [resultTree])
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
  // The results keep their own expansion; every other gesture acts as on the tree.
  const resultView = useMemo(() => view === undefined || resultTree === undefined ? undefined : {
    ...view,
    expanded: resultTree.expanded,
    onToggle: (entry: TreeEntry) => { toggleSearch(paneId, entry.path) },
  }, [view, resultTree, toggleSearch, paneId])
  const closeSettings = useCallback((rules: readonly ExclusionRule[], refocus: boolean) => {
    setDraft(undefined)
    if (refocus) trigger.current?.focus()
    if (cwd !== undefined && rules !== preferences.rules) setSearchPreferences(cwd, { rules })
  }, [cwd, preferences.rules, setSearchPreferences])

  if (cwd === undefined || !open) return null
  const geometry = navigatorGeometry(rowWidth, state?.width ?? DEFAULT_NAVIGATOR_WIDTH)
  // The page's tree always fills the page; a preview's follows its row.
  const shown = page ? undefined : mode
  const clamp = (next: number): number => Math.min(Math.max(next, geometry.minimum), geometry.maximum)
  const clear = (): void => {
    setQuery(paneId, cwd, '')
    input.current?.focus()
  }
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
      onKeyDown={(event) => {
        moveAlongRows(event)
        // A settings panel keeps its own Escape; a menu or anything else that prevented it keeps it too.
        if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing || query === '') return
        event.preventDefault()
        event.stopPropagation()
        if (!searchBarOpen) event.currentTarget.querySelector<HTMLElement>('[data-files-body]')?.focus()
        clear()
      }}
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
      {searchBarOpen && <div className={css.searchBar}>
        <div className={css.searchField}>
          <Tooltip label={t('search.settings')} side="bottom" portal>
            <button ref={trigger} type="button" className={clsx(css.tool, css.searchTool)} aria-label={t('search.settings')}
              aria-haspopup="dialog" aria-expanded={settings} data-files-search-settings-toggle
              // Pressing it while the panel is open must not move focus out of the panel first, which would close it before the click.
              onMouseDown={(event) => { if (settings) event.preventDefault() }}
              onClick={() => {
                if (draft === undefined) setDraft(preferences.rules)
                else closeSettings(draft, true)
              }}>
              <IconSearchOutlineRegular />
            </button>
          </Tooltip>
          <input
            ref={inputRef}
            className={css.searchInput}
            type="search"
            value={query}
            placeholder={t('search.placeholder')}
            aria-label={t('search.placeholder')}
            autoComplete="off"
            spellCheck={false}
            data-files-search
            onChange={(event) => { setQuery(paneId, cwd, event.target.value) }}
          />
          <Tooltip label={t('search.showHidden')} side="bottom" portal>
            <button type="button" className={clsx(css.tool, css.searchTool)} aria-pressed={preferences.showHidden}
              aria-label={t('search.showHidden')} data-files-show-hidden
              onClick={() => { setSearchPreferences(cwd, { showHidden: !preferences.showHidden }) }}>
              {preferences.showHidden ? <IconEyeOutlineRegular /> : <IconEyeOffOutlineRegular />}
            </button>
          </Tooltip>
          {query !== '' && (
            <Tooltip label={t('search.clear')} side="bottom" portal>
              <button type="button" className={clsx(css.tool, css.searchTool)} aria-label={t('search.clear')} data-files-search-clear
                onClick={clear}>
                <IconCloseOutlineRegular />
              </button>
            </Tooltip>
          )}
        </div>
      </div>}
      {/* Always mounted, so a screen reader announces each new text; empty, it takes no room. */}
      <p className={clsx(css.searchStatus, search === undefined && css.searchStatusIdle)} aria-live="polite" data-files-search-status>
        {found !== undefined && <span className={css.searchStatusLine}>{t('search.results', { count: String(found.count) })}</span>}
        {pending && <StateDot state="ongoing" size={12} className={css.searchSpinner} />}
      </p>
      <div
        ref={bodyRef}
        className={css.body}
        tabIndex={-1}
        data-files-body
        data-files-view={resultsShown ? 'search' : 'tree'}
        aria-busy={pending}
        onScroll={(event) => { scrolled(paneId, event.currentTarget.scrollTop) }}
      >
        {view === undefined || entries === undefined || directories === undefined
          ? <p className={css.note} data-files-row="loading">{t('loading')}</p>
          : search !== undefined
            ? result?.kind === 'failed'
              ? <SearchFailure failure={result.failure} onRetry={() => { retrySearch(paneId) }} t={t} />
              : found !== undefined && (
                <>
                  {resultView !== undefined && resultEntries !== undefined && resultDirectories !== undefined
                    && renderFactorySlot('sidebar.files.tree', {
                      ...resultView, entries: resultEntries, directories: resultDirectories, highlight: found.query,
                      current: resultCurrent, currentRef,
                    })}
                  <SearchNotes result={found} t={t} />
                </>
              )
            : renderFactorySlot('sidebar.files.tree', { ...view, entries, directories, current: location?.current, currentRef })}
      </div>
      {searchBarOpen && draft !== undefined && (
        <SearchSettings rules={draft} trigger={trigger} onChange={setDraft}
          respectGitignore={preferences.respectGitignore}
          onRespectGitignore={(respectGitignore) => { setSearchPreferences(cwd, { respectGitignore }) }}
          onClose={(refocus) => { closeSettings(draft, refocus) }} t={t} />
      )}
    </aside>
  )
}
