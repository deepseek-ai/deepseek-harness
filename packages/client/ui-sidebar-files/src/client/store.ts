/**
 * The file tree's view state, one record per right-Sidebar pane: which
 * directories are expanded, what each loaded level contains, how the
 * navigator is shown, and the pane's search. A Slot-standard exclusive store
 * (one instance per Session) keyed by pane, so every file tab of a pane draws
 * the same tree; the face decides when a pane's record is forgotten
 * (`FilesInjected.attach`). Beside it live pure reads shared by the face and
 * the drawings: path keys, where a tab's file sits in the listed tree, and the
 * navigator's geometry.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { PaneId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { isAbsoluteWorkspacePath, parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'

/** The navigator's width before a pane has a preference, in CSS pixels. */
export const DEFAULT_NAVIGATOR_WIDTH = 260

/** The narrowest navigator, when the row has room for it. */
const NAVIGATOR_MINIMUM = 180
/** What a navigator floating over the row leaves of it uncovered. */
const ROW_REMAINDER = 120
/**
 * The row width from which a preview's navigator takes its width from the
 * body instead of floating over it. Fixed, so resizing the tree never moves
 * the navigator between the two layouts.
 */
export const PUSH_FROM = 560
/** The body width a navigator that takes its width from the body leaves. */
const PREVIEW_MINIMUM = 320
/** The navigator card's left plus right margin in that layout (FilesBody.module.css `.push`). */
const PUSH_MARGINS = 16

/**
 * Fit the navigator to the row it shares with the preview. In a row at least
 * `PUSH_FROM` wide the navigator sits beside the body, so it is at most the
 * row less its card's margins and `PREVIEW_MINIMUM`; in a narrower row it
 * floats over the body and is at most the row less `ROW_REMAINDER`.
 * @param available - the row's width in CSS pixels; `undefined` before it is measured.
 * @param width - the pane's width preference.
 * @returns the resize bounds and the width drawn.
 */
export function navigatorGeometry(available: number | undefined, width: number): {
  readonly minimum: number
  readonly maximum: number
  readonly width: number
} {
  // Unmeasured, the preference is drawn as asked until the row reports its width.
  if (available === undefined) {
    const drawn = Math.max(NAVIGATOR_MINIMUM, width)
    return { minimum: NAVIGATOR_MINIMUM, maximum: drawn, width: drawn }
  }
  const maximum = Math.max(0, available - (available >= PUSH_FROM ? PUSH_MARGINS + PREVIEW_MINIMUM : ROW_REMAINDER))
  const minimum = Math.min(NAVIGATOR_MINIMUM, maximum)
  return { minimum, maximum, width: Math.min(Math.max(minimum, width), maximum) }
}

/**
 * One directory's contents, as one expanded level of the tree.
 *
 * The endpoint's listing also names the directory as a workspace-relative path;
 * the tree keys every level by absolute path instead, so the adapter drops it.
 */
export interface DirLevel {
  /** The directory's entries, in the endpoint's order. */
  readonly entries: readonly WorkspaceDirectoryEntry[]
  /** The listing hit the endpoint's entry cap, so entries are missing. */
  readonly truncated: boolean
}

/**
 * What one directory level is doing right now. A `ready` level marked
 * `refreshing` keeps its last listing until the next one settles: the listing
 * in flight, or, once its directory opens again, the first listing there. An
 * entry missing from it is not yet known to be absent. A directory whose
 * listing fails also clears the mark on every level below it, which it does
 * not list.
 */
export type LevelState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly level: DirLevel; readonly failure?: RemoteFailure; readonly refreshing?: true }
  | { readonly kind: 'failed'; readonly failure: RemoteFailure }

/**
 * One pane's tree: its root, the levels it has asked for, and what is open.
 *
 * Every path here is absolute: the root is the session's working directory as
 * the Host reports it, and a child is the parent joined with the entry name.
 */
export interface FilesTreeState {
  autoRefresh: boolean
  /** Absolute path of the workspace root this tree is rooted at. */
  root: string
  /** Level state by absolute directory path; a path absent here was never asked for. */
  levels: Record<string, LevelState>
  /** Expanded absolute directory paths, root included. */
  expanded: string[]
}

/**
 * One settled search, as the pane draws it instead of the tree: the matches,
 * or why the Host could not search.
 */
export type FilesSearchResult =
  | {
    readonly kind: 'found'
    /** The trimmed query the search answered, which the rows highlight. */
    readonly query: string
    /** The matches as a tree; its `expanded` is the search's own and starts with every level. */
    readonly tree: FilesTreeState
    /** How many entries the search returned. */
    readonly count: number
    /** More entries matched than the Host returns, so only its first `count` are drawn. */
    readonly truncated: boolean
    /**
     * Part of the workspace was not searched: the Host's search passed its file
     * limit, or a directory could not be read.
     */
    readonly incomplete: boolean
    /** Whether the search was asked to leave out hidden entries; it does not say that any were. */
    readonly hiddenLeftOut: boolean
    /** Whether the search was given at least one enabled exclusion rule; it does not say that a rule matched. */
    readonly excluded: boolean
    /** Whether the search was asked to respect ignore files; it does not say that one ignored anything. */
    readonly ignored: boolean
  }
  | {
    readonly kind: 'failed'
    /** The trimmed query the failed search asked for. */
    readonly query: string
    /** Why the Host could not search. */
    readonly failure: RemoteFailure
  }

/** One pane's search while its query is not blank. */
export interface FilesSearchState {
  /** A search is running; the last settled result stays drawn until its answer replaces it. */
  readonly pending: boolean
  /** The last settled search; `undefined` until the pane's first search settles. */
  readonly result: FilesSearchResult | undefined
}

/** One pane's navigator: whether and how wide it is shown, its tree once started, and its search. */
export interface FilesPaneState {
  /**
   * Whether a preview's navigator is shown; `undefined`, hidden, until the
   * pane's first choice. The `files` page shows its tree regardless.
   */
  open: boolean | undefined
  /** The reader's width preference in CSS pixels; the navigator clamps it to the room it has. */
  width: number
  /** The tree, listed once the navigator is first shown. */
  tree: FilesTreeState | undefined
  /** The search field's text, as typed; not persisted. */
  query: string
  /** Whether the files page draws its search bar; hiding it retains the query and results. */
  searchBarOpen: boolean
  /** The pane's search, which the navigator draws instead of the tree; `undefined` while the query is blank. */
  search: FilesSearchState | undefined
}

/** Every pane's navigator, keyed by pane id. */
export interface FilesState {
  byPane: Record<PaneId, FilesPaneState>
}

/**
 * The absolute path of one child entry.
 *
 * Joined with `/` whatever the parent's separators: the Host resolves mixed
 * separators, and the tree only needs a stable key.
 * @param parent - absolute path of the listed directory.
 * @param name - the entry's basename.
 * @returns the child's absolute path.
 */
export function childPath(parent: string, name: string): string {
  return `${parent.replace(/[/\\]+$/, '')}/${name}`
}

/** Where a file sits in the listed tree. */
export interface TreeFileLocation {
  /** Listed ancestor directories, outermost first, with the parent each is listed under. */
  readonly ancestors: readonly { readonly parent: string; readonly path: string }[]
  /** The file's tree key, once every level on the way is listed and holds it. */
  readonly current: string | undefined
  /** A level on the way is still being listed, or is listed again and lacks the next name. */
  readonly pending: boolean
}

/**
 * Whether a root is a Windows drive or UNC path, in either separator spelling,
 * where names compare regardless of case.
 * @param root - the tree's root, or a prefix built from it.
 * @returns `true` for a drive letter followed by a separator, or a leading double separator.
 */
function windowsRoot(root: string): boolean {
  const path = root.replace(/\\/g, '/')
  return /^[A-Za-z]:\//.test(path) || path.startsWith('//')
}

/**
 * Walk the listed levels to a workspace-relative file, keeping the listing's
 * spelling of each name; a Windows root also matches names regardless of case.
 * @param tree - the pane's tree.
 * @param relativePath - the file's path under the tree's root, `/`-separated.
 * @returns the ancestors found so far, the file's tree key, and whether a level is pending.
 */
export function locateFile(tree: FilesTreeState, relativePath: string): TreeFileLocation {
  const caseless = windowsRoot(tree.root)
  const parts = relativePath.split('/')
  const ancestors: { parent: string; path: string }[] = []
  let parent = tree.root
  for (const [index, part] of parts.entries()) {
    const level = tree.levels[parent]
    if (level?.kind !== 'ready') return { ancestors, current: undefined, pending: level === undefined || level.kind === 'loading' }
    const type = index === parts.length - 1 ? 'file' : 'directory'
    const candidates = level.level.entries.filter(entry => entry.type === type)
    const entry = candidates.find(candidate => candidate.name === part)
      ?? (caseless ? candidates.find(candidate => candidate.name.toLowerCase() === part.toLowerCase()) : undefined)
    if (entry === undefined) return { ancestors, current: undefined, pending: level.refreshing === true }
    const path = childPath(parent, entry.name)
    if (type === 'directory') ancestors.push({ parent, path })
    parent = path
  }
  return { ancestors, current: parent, pending: false }
}

/**
 * The workspace-relative path of the file a tab shows, when it is a file of
 * this Session under the tree's root; dot segments are not resolved here. An
 * absolute path is under a Windows drive or UNC root regardless of case and
 * separator spelling, and under a POSIX root only with the root's exact case.
 * @param address - the tab's content address.
 * @param sessionId - the Session the tree lists.
 * @param root - the tree's root.
 * @returns the `/`-separated relative path, or `undefined` for anything else.
 */
export function relativeFileOf(address: string, sessionId: SessionId, root: string): string | undefined {
  const file = parseFileAddress(address)
  if (file?.scope !== 'session' || file.sessionId !== sessionId) return undefined
  const path = file.path.replace(/\\/g, '/')
  const normalized = isAbsoluteWorkspacePath(path) ? underRoot(path, root) : path
  if (normalized === undefined || normalized === '' || isAbsoluteWorkspacePath(normalized)) return undefined
  return normalized.split('/').some(part => part === '' || part === '.' || part === '..') ? undefined : normalized
}

/**
 * An absolute `/`-separated path relative to a tree's root.
 * @param path - the absolute path, `/`-separated.
 * @param root - the tree's root, in either separator spelling.
 * @returns the path under the root, or `undefined` outside it.
 */
function underRoot(path: string, root: string): string | undefined {
  const prefix = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/`
  const head = path.slice(0, prefix.length)
  const caseless = windowsRoot(prefix)
  return (caseless ? head.toLowerCase() === prefix.toLowerCase() : head === prefix) ? path.slice(prefix.length) : undefined
}

/**
 * One pane's record, created by its first write.
 * @param state - the draft.
 * @param paneId - the pane being written.
 * @returns the pane's record.
 */
function pane(state: FilesState, paneId: PaneId): FilesPaneState {
  state.byPane[paneId] ??= { open: undefined, width: DEFAULT_NAVIGATOR_WIDTH, tree: undefined, query: '', searchBarOpen: false, search: undefined }
  return state.byPane[paneId]
}

/**
 * One pane's tree, which every writer after `start` relies on: the face only
 * dispatches while it holds the pane's records, and `forget` runs as it drops them.
 * @param state - the draft.
 * @param paneId - the pane being written.
 * @returns the pane's tree.
 */
function tree(state: FilesState, paneId: PaneId): FilesTreeState {
  const started = state.byPane[paneId]?.tree
  if (started === undefined) throw new Error(`ui-sidebar-files: no tree for pane "${paneId}"`)
  return started
}

/** The tree store's write set; every action names the pane it writes. */
type FilesActions = {
  autoRefresh: (draft: FilesState, paneId: PaneId, enabled: boolean) => void
  start: (draft: FilesState, paneId: PaneId, root: string) => void
  loading: (draft: FilesState, paneId: PaneId, path: string) => void
  loaded: (draft: FilesState, paneId: PaneId, path: string, level: DirLevel) => void
  failed: (draft: FilesState, paneId: PaneId, path: string, failure: RemoteFailure) => void
  toggled: (draft: FilesState, paneId: PaneId, path: string) => void
  shown: (draft: FilesState, paneId: PaneId, open: boolean) => void
  searchBarShown: (draft: FilesState, paneId: PaneId, open: boolean) => void
  resized: (draft: FilesState, paneId: PaneId, width: number) => void
  forget: (draft: FilesState, paneId: PaneId) => void
  queried: (draft: FilesState, paneId: PaneId, query: string) => void
  searching: (draft: FilesState, paneId: PaneId) => void
  searched: (draft: FilesState, paneId: PaneId, result: FilesSearchResult) => void
  searchToggled: (draft: FilesState, paneId: PaneId, path: string) => void
}

/**
 * Declare the file tree's store.
 *
 * A factory rather than a shared handle: the registration declares it as an
 * exclusive store, so the framework mints one instance per session.
 * @returns the store handle to declare on the registration.
 */
export function createFilesStore(): EngineStoreHandle<FilesState, FilesActions> {
  return defineStore({
    init: (): FilesState => ({ byPane: {} }),
    actions: {
      autoRefresh: (d, paneId: PaneId, enabled: boolean) => { tree(d, paneId).autoRefresh = enabled },
      /**
       * Seed one pane's tree at its workspace root, with the root expanded.
       * @param d - draft state.
       * @param paneId - the pane being drawn.
       * @param root - absolute path of the workspace root.
       */
      start: (d, paneId: PaneId, root: string) => {
        pane(d, paneId).tree = { root, levels: {}, expanded: [root], autoRefresh: true }
      },
      /**
       * Mark one directory as being listed; a listed level keeps its entries and is marked refreshing.
       * @param d - draft state.
       * @param paneId - the pane being drawn.
       * @param path - absolute directory path.
       */
      loading: (d, paneId: PaneId, path: string) => {
        const state = tree(d, paneId)
        const level = state.levels[path]
        if (level?.kind !== 'ready') state.levels[path] = { kind: 'loading' }
        else if (level.refreshing !== true) state.levels[path] = { ...level, refreshing: true }
      },
      /**
       * Record one directory's contents.
       * @param d - draft state.
       * @param paneId - the pane being drawn.
       * @param path - absolute directory path.
       * @param level - the listing to show under it.
       */
      loaded: (d, paneId: PaneId, path: string, level: DirLevel) => {
        const state = tree(d, paneId)
        const previous = state.levels[path]
        if (previous?.kind === 'ready') {
          const directories = new Set(level.entries.filter(entry => entry.type === 'directory').map(entry => entry.name))
          for (const entry of previous.level.entries) {
            if (entry.type !== 'directory' || directories.has(entry.name)) continue
            const removed = childPath(path, entry.name)
            state.expanded = state.expanded.filter(value => value !== removed && !value.startsWith(`${removed}/`))
            state.levels = Object.fromEntries(Object.entries(state.levels)
              .filter(([key]) => key !== removed && !key.startsWith(`${removed}/`)))
          }
        }
        state.levels[path] = { kind: 'ready', level }
      },
      /**
       * Record why one directory could not be listed, and end the refresh of the levels below it.
       * @param d - draft state.
       * @param paneId - the pane being drawn.
       * @param path - absolute directory path.
       * @param failure - the settled Remote failure.
       */
      failed: (d, paneId: PaneId, path: string, failure: RemoteFailure) => {
        const state = tree(d, paneId)
        const level = state.levels[path]
        state.levels[path] = level?.kind === 'ready'
          ? { kind: 'ready', level: level.level, failure }
          : { kind: 'failed', failure }
        // A directory that failed to list lists none below it, so their kept listings are the latest known.
        const below = `${path.replace(/[/\\]+$/, '')}/`
        for (const [key, kept] of Object.entries(state.levels)) {
          if (!key.startsWith(below) || kept.kind !== 'ready' || kept.refreshing !== true) continue
          state.levels[key] = kept.failure === undefined
            ? { kind: 'ready', level: kept.level }
            : { kind: 'ready', level: kept.level, failure: kept.failure }
        }
      },
      /**
       * Open a collapsed directory, or collapse an open one.
       *
       * A collapsed level keeps what it loaded, so reopening it draws at once.
       * @param d - draft state.
       * @param paneId - the pane being drawn.
       * @param path - absolute directory path.
       */
      toggled: (d, paneId: PaneId, path: string) => {
        const state = tree(d, paneId)
        const at = state.expanded.indexOf(path)
        if (at >= 0) state.expanded.splice(at, 1)
        else state.expanded.push(path)
      },
      /**
       * Show or hide one pane's navigator.
       * @param d - draft state.
       * @param paneId - the pane being drawn.
       * @param open - whether the navigator is shown.
       */
      shown: (d, paneId: PaneId, open: boolean) => { pane(d, paneId).open = open },
      /**
       * Show or hide the files page's search bar without changing its search.
       * @param d - draft state.
       * @param paneId - the pane being drawn.
       * @param open - whether the search bar is shown.
       */
      searchBarShown: (d, paneId: PaneId, open: boolean) => { pane(d, paneId).searchBarOpen = open },
      /**
       * Record one pane's navigator width preference.
       * @param d - draft state.
       * @param paneId - the pane being drawn.
       * @param width - the preferred width, in CSS pixels.
       */
      resized: (d, paneId: PaneId, width: number) => { pane(d, paneId).width = width },
      /**
       * Forget one pane's navigator and tree.
       * @param d - draft state.
       * @param paneId - the pane whose records go.
       */
      forget: (d, paneId: PaneId) => {
        d.byPane = Object.fromEntries(Object.entries(d.byPane).filter(([id]) => id !== paneId))
      },
      /**
       * Record the search field's text. A blank query ends the search, and the
       * pane draws its tree again; otherwise the last result stays drawn until
       * the next is recorded.
       * @param d - draft state.
       * @param paneId - the pane being drawn.
       * @param query - the text as typed.
       */
      queried: (d, paneId: PaneId, query: string) => {
        const state = pane(d, paneId)
        state.query = query
        if (query.trim() === '') state.search = undefined
      },
      /**
       * Record that a search started, keeping the last result drawn; ignored while the query is blank.
       * @param d - draft state.
       * @param paneId - the pane being drawn.
       */
      searching: (d, paneId: PaneId) => {
        const state = d.byPane[paneId]
        const result = state?.search?.result
        if (state !== undefined && state.query.trim() !== '') {
          state.search = { pending: true, result: result?.kind === 'failed' ? undefined : result }
        }
      },
      /**
       * Record a search's result, ending the pending search; ignored while the query is blank.
       * @param d - draft state.
       * @param paneId - the pane being drawn.
       * @param result - what the search found, or why it failed.
       */
      searched: (d, paneId: PaneId, result: FilesSearchResult) => {
        const state = d.byPane[paneId]
        if (state !== undefined && state.query.trim() !== '') state.search = { pending: false, result }
      },
      /**
       * Open a collapsed directory of the search's tree, or collapse an open
       * one; the listed tree's expansion stays as it was.
       * @param d - draft state.
       * @param paneId - the pane being drawn.
       * @param path - absolute directory path.
       */
      searchToggled: (d, paneId: PaneId, path: string) => {
        const result = d.byPane[paneId]?.search?.result
        if (result?.kind !== 'found') return
        const at = result.tree.expanded.indexOf(path)
        if (at >= 0) result.tree.expanded.splice(at, 1)
        else result.tree.expanded.push(path)
      },
    },
  })
}

/** One Session's live instance of the tree's store, as the face reads and writes it. */
export type FilesStoreInstance = ReturnType<ReturnType<typeof createFilesStore>['create']>
