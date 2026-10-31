/**
 * The navigator's half outside React. The injected face (`filesFace`) lists
 * directories into the store through its own actions, reveals the tab's file,
 * carries scroll and keyboard focus between drawings of a pane's tree, and
 * measures the navigator's row. The component never awaits or observes
 * anything: it registers what it draws and calls the face. The per-pane
 * lifetimes are stated on `attach` and `hold`. Beside the face live its
 * inputs: the Remote listing and watch bindings and `canOpenOf`.
 */
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SidebarRightTabDefinition, SidebarRightTabNavigation } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { childPath, locateFile, relativeFileOf, type DirLevel, type FilesStoreInstance } from './store.ts'
import type { WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-api-workspace-files/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { DirectoryNode } from './directory-node.ts'
import { FILL_BELOW, FULLSCREEN_QUERY } from './navigator-layout.ts'

/**
 * The box an element is laid out in: its nearest ancestor that generates one,
 * passing over wrappers drawn with `display: contents`.
 * @param element - the laid-out element.
 * @returns that ancestor, or `null` for a detached element.
 */
function layoutParent(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement
  while (parent !== null && getComputedStyle(parent).display === 'contents') parent = parent.parentElement
  return parent
}

/**
 * Observe one directory without recursively watching its descendants.
 * @param sessionId - Session owning the directory tree.
 * @param path - absolute directory path.
 * @param signal - node lifetime.
 * @returns readiness and invalidation notifications.
 */
export type WatchWorkspaceDirectory = (sessionId: SessionId, path: string, signal: AbortSignal) => AsyncIterable<'ready' | 'change'>

/**
 * Bind directory observation to the Remote stream supervisor.
 * @param remote - Client Remote with workspace file streams.
 * @returns a watcher that awaits stream disposal when its node ends.
 */
export function createWatch(remote: ClientRemote): WatchWorkspaceDirectory {
  return async function* (sessionId, path, signal) {
    const aborted = (): boolean => signal.aborted
    if (aborted()) return
    const stream = remote.$stream<WorkspaceFileWatchFrame>({
      name: `directory ${path}`,
      open: lifetime => remote.workspaceFiles.changes(sessionId, path, lifetime),
      ended: () => new Error(`Directory watch ended: ${path}`),
    })
    const abort = (): void => { void stream.dispose() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      for await (const item of stream) {
        if (aborted()) return
        if (item.value.kind === 'ready') item.accept()
        yield item.value.kind
      }
    } finally {
      signal.removeEventListener('abort', abort)
      await stream.dispose()
    }
  }
}

/**
 * One directory listing, bound to a Remote face.
 *
 * The session travels with the call because the endpoint resolves the workspace
 * root from it: the same path means different directories in different sessions.
 * A Remote call does not reject — the result carries the failure.
 */
export type ListWorkspaceDirectory = (
  sessionId: SessionId,
  path: string,
  signal: AbortSignal,
) => Promise<RemoteResult<DirLevel>>

/**
 * The slice of the Client Remote face this package calls: the `workspaceFiles`
 * namespace's `list`, exactly as the Host's generated client declares it.
 */
export type WorkspaceFilesListRemote = {
  readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'list'>
}

/**
 * Bind the listing to one Remote face.
 * @param remote - the Client Remote face carrying the `workspaceFiles` namespace.
 * @returns the listing the tree's face performs.
 */
export function createList(remote: WorkspaceFilesListRemote): ListWorkspaceDirectory {
  return async (sessionId, path, signal) => {
    const result = await remote.workspaceFiles.list(sessionId, path, signal)
    if (!result.ok) return result
    return { ok: true, value: { entries: result.value.entries, truncated: result.value.truncated } }
  }
}

/** The tree's injected business face, as the navigator receives it. */
export interface FilesInjected {
  /**
   * Register a navigator mounted for one tab in one pane, until the returned
   * release. A pane's records — the store's tree, the scroll offset, the file
   * revealed last — last while a navigator is registered there or an open tab,
   * judged by its `tabSignal`, whose latest navigator was there. Once neither
   * holds when the task ends, they are forgotten, the listing closes, and a
   * listing that settles afterwards writes nothing. A tab replaced in place
   * keeps them because its successor registers in the same task; floating or
   * docking a tab never ends them by itself.
   * @param paneId - the pane being drawn.
   * @param tabId - the tab the navigator is drawn for.
   * @param tabSignal - that tab's lifetime.
   * @returns the release.
   */
  readonly attach: (paneId: PaneId, tabId: TabId, tabSignal: AbortSignal) => () => void
  /**
   * Place this face beside a tab's content for the workspace command, while a
   * navigator that can draw a tree is mounted there, until the returned
   * release; the pane's records do not depend on it.
   * @param tabId - the tab whose content the navigator sits beside.
   * @returns the release.
   */
  readonly placeBeside: (tabId: TabId) => () => void
  /**
   * List an attached pane's tree at a workspace directory, with its watches,
   * while a navigator draws it. A tree the store keeps at that root is listed
   * again in place, its kept rows still drawn; one at another root, or none, is
   * replaced, resetting the scroll offset and the revealed file. A hold taken
   * in the same task as the last release, as a tab switch's next drawing does,
   * keeps the listing open and lists nothing.
   * @param paneId - the pane being drawn.
   * @param root - absolute path of the workspace root.
   * @returns the release; the listing closes once no hold remains when the current task ends.
   */
  readonly hold: (paneId: PaneId, root: string) => () => void
  /** Refresh the open directory tree. @param paneId - owning pane. */
  readonly refresh: (paneId: PaneId) => void
  /** Control automatic rereads without closing watches. @param paneId - owning pane. @param enabled - automatic-refresh setting. */
  readonly setAutoRefresh: (paneId: PaneId, enabled: boolean) => void
  /**
   * Open or collapse one directory, retaining intent during ancestor restoration.
   * @param paneId - the pane being drawn.
   * @param parentPath - the listed parent directory's exact tree key.
   * @param path - absolute directory path.
   * @param expanded - current expansion preferences, including descendants to restore.
   */
  readonly toggle: (paneId: PaneId, parentPath: string, path: string, expanded: readonly string[]) => void
  /**
   * Record where a pane's tree is scrolled to, without rendering anything.
   * @param paneId - the pane being drawn.
   * @param scrollTop - the scroll offset in px.
   */
  readonly scrolled: (paneId: PaneId, scrollTop: number) => void
  /**
   * Hide a pane's navigator; when its drawing held keyboard focus, the pane's
   * toggle takes it once the commit ends, as on Escape.
   * @param paneId - the pane to hide it in.
   */
  readonly hide: (paneId: PaneId) => void
  /**
   * Show a pane's navigator and give its tree keyboard focus now, or when it
   * is next drawn; a pane drawn but not yet attached shows it once attached.
   * A pane with no drawing recorded is left alone.
   * @param paneId - the pane whose tree takes focus.
   */
  readonly focus: (paneId: PaneId) => void
  /**
   * Register the tree's scroll container as drawn for one tab, or with `null`
   * as gone. Drawing restores the pane's scroll offset, takes keyboard focus
   * that the previous drawing held when it went or that `focus` asked for, and
   * reveals the tab's file unless the pane revealed it last.
   * @param paneId - the pane being drawn.
   * @param address - the tab's content address.
   * @param body - the scroll container, or `null` once it is removed.
   */
  readonly bodyDrawn: (paneId: PaneId, address: string, body: HTMLElement | null) => void
  /**
   * Register the drawn row of the tab's file, or with `null` as gone; a reveal
   * that completed before the row was drawn scrolls it into view then.
   * @param paneId - the pane being drawn.
   * @param row - the row, or `null` once it is removed or no longer current.
   */
  readonly currentDrawn: (paneId: PaneId, row: HTMLElement | null) => void
  /**
   * Register a navigator's element, or with `null` as gone. While it is
   * drawn, the face measures the row it is laid out in and, when `closable`,
   * closes the navigator on Escape in that row. When a new width leaves the
   * focused resize edge removed or hidden, the tree takes keyboard focus.
   * When a closable navigator starts filling the row, including its first
   * drawing, focus in the covered content moves to the tree without closing it;
   * so does focus that hiding the covered content left on the document body,
   * unless the reader moved the keyboard or pointer or the window lost focus
   * before the width was reported.
   * @param paneId - the pane being drawn.
   * @param navigator - the navigator element, or `null` once it is removed.
   * @param closable - whether Escape closes this drawing; the `files` page's tree stays shown.
   */
  readonly navigatorDrawn: (paneId: PaneId, navigator: HTMLElement | null, closable: boolean) => void
  /**
   * Register the drawn show/hide control of a pane's navigator, or with `null` as gone.
   * @param paneId - the pane the control is drawn in.
   * @param toggle - the control, or `null` once it is removed.
   */
  readonly toggleDrawn: (paneId: PaneId, toggle: HTMLElement | null) => void
  readonly hooks: {
    /** Whether some registered tab type can open an address; a new predicate whenever the tab types change. */
    readonly canOpen: HostObservable<(address: string) => boolean>
  }
  readonly keyedHooks: {
    /** The measured width of the row a pane's navigator is laid out in, in CSS pixels, keyed by pane id; `undefined` until measured. */
    readonly rowWidth: (paneId: string) => HostObservable<number | undefined>
  }
}

/** The slice of the right Sidebar's tab type registry that tells whether an address can be opened. */
export interface TabTypeRegistry {
  /** @returns the registered types; a new array whenever registrations change. */
  entries(): readonly SidebarRightTabDefinition[]
  /** @param address - a resource address. @returns the types that would open it, best first. */
  candidates(address: string): readonly SidebarRightTabDefinition[]
  /** @param listener - called after registrations change. @returns the unsubscribe. */
  subscribe(listener: () => void): () => void
}

/**
 * Observe whether any registered tab type can open an address.
 * @param registry - the right Sidebar's tab type registry.
 * @returns a source whose snapshot is a predicate, replaced whenever registrations change.
 */
export function canOpenOf(registry: TabTypeRegistry): HostObservable<(address: string) => boolean> {
  let seen = registry.entries()
  let check = (address: string): boolean => registry.candidates(address).length > 0
  return {
    getSnapshot: () => {
      const entries = registry.entries()
      if (entries !== seen) {
        seen = entries
        check = address => registry.candidates(address).length > 0
      }
      return check
    },
    subscribe: listener => registry.subscribe(listener),
  }
}

/** One pane's listing and drawings, outside React. */
interface PaneRecord {
  /** Ends when the records are forgotten; set once a navigator attached the pane. */
  lifetime: AbortController | undefined
  /** Navigators registered in the pane. */
  mounts: number
  /** Open tabs whose latest navigator was in the pane. */
  readonly tabs: Set<TabId>
  /** Navigators drawing the tree. */
  holds: number
  /** The listing and its watches, while the tree is held. */
  root: DirectoryNode | undefined
  /** Where the tree was last scrolled to, in px. */
  scrollTop: number
  /** The file whose row was revealed last, so a remount does not reveal it again. */
  revealed: string | undefined
  /** The file whose row a reveal is walking to. */
  revealing: string | undefined
  /** The drawn tree's scroll container and the address of the tab it is drawn for. */
  drawn: { readonly body: HTMLElement; readonly address: string } | undefined
  /** The drawn row of the tab's file. */
  current: HTMLElement | undefined
  /** A completed reveal waits for its row to be drawn. */
  scrollToCurrent: boolean
  /** Who asked for keyboard focus at the tree's next drawing. */
  focus: object | undefined
  /** `focus` asked to show the navigator before the pane attached; attaching shows it. */
  show: boolean
  /** The measured width of the row the navigator shares with the preview or the page's line. */
  readonly width: SnapshotStore<number | undefined>
  /** The drawn navigator element. */
  navigator: HTMLElement | undefined
  /** Whether the drawn navigator may close to expose its content. */
  closable: boolean
  /** Stop measuring the row and listening for Escape in it. */
  unobserve: (() => void) | undefined
  /** The drawn show/hide control. */
  toggle: HTMLElement | undefined
}

/** One tab's navigation consumption and latest drawing, retained until the tab closes. */
interface TabHome {
  paneId: PaneId
  pane: PaneRecord
  mounts: number
  revision: number
  readonly navigation: HostObservable<SidebarRightTabNavigation>
}

/** `focus` asked for the tree's keyboard focus. */
const REQUESTED = {}

/**
 * Place a face beside a tab's content, where the workspace command finds it,
 * until the returned release.
 * @param tabId - the tab whose content a navigator sits beside.
 * @param face - the face that navigator draws through.
 * @returns the release.
 */
export type PlaceFace = (tabId: TabId, face: FilesInjected) => () => void

/**
 * Bind the tree's face to one directory listing.
 * @param list - the bound `workspaceFiles.list` call.
 * @param watch - target-scoped directory observation.
 * @param canOpen - whether some tab type can open an address.
 * @param navigationOf - the attached tab's navigation; subscriptions end with this plugin or their disposer.
 * @returns the face factory: session, its store instance, and where to place the face beside tabs in, face out.
 */
export function filesFace(
  list: ListWorkspaceDirectory,
  watch: WatchWorkspaceDirectory,
  canOpen: HostObservable<(address: string) => boolean>,
  navigationOf: (sessionId: SessionId, tabId: TabId) => HostObservable<SidebarRightTabNavigation>,
): (
  sessionId: SessionId,
  store: Pick<FilesStoreInstance, 'actions' | 'getSnapshot' | 'subscribe'>,
  place: PlaceFace,
) => FilesInjected {
  return (sessionId, store, place): FilesInjected => {
    const { actions } = store
    const panes = new Map<PaneId, PaneRecord>()
    const record = (paneId: PaneId): PaneRecord => {
      let pane = panes.get(paneId)
      if (pane === undefined) {
        pane = {
          lifetime: undefined, mounts: 0, tabs: new Set(), holds: 0, root: undefined, scrollTop: 0,
          revealed: undefined, revealing: undefined, drawn: undefined, current: undefined, scrollToCurrent: false,
          focus: undefined, show: false,
          width: createSnapshotStore<number | undefined>(undefined),
          navigator: undefined, closable: false, unobserve: undefined, toggle: undefined,
        }
        panes.set(paneId, pane)
      }
      return pane
    }
    /** Each open tab's latest pane. */
    const homes = new Map<TabId, TabHome>()
    const forget = (paneId: PaneId, pane: PaneRecord): void => {
      pane.lifetime?.abort()
      void pane.root?.close()
      pane.root = undefined
      pane.unobserve?.()
      panes.delete(paneId)
      actions.forget(paneId)
    }
    // A tab replaced in place goes before its successor mounts, in the same task.
    const settle = (paneId: PaneId, pane: PaneRecord): void => {
      if (pane.mounts > 0 || pane.tabs.size > 0) return
      queueMicrotask(() => {
        if (pane.mounts === 0 && pane.tabs.size === 0 && panes.get(paneId) === pane) forget(paneId, pane)
      })
    }
    const leave = (tabId: TabId, home: { readonly paneId: PaneId; readonly pane: PaneRecord }): void => {
      home.pane.tabs.delete(tabId)
      settle(home.paneId, home.pane)
    }
    const load = async (paneId: PaneId, path: string, signal: AbortSignal): Promise<DirLevel | undefined> => {
      const aborted = (): boolean => signal.aborted
      // A closed node has nothing left to write, and its pane's tree may be gone.
      if (aborted()) return undefined
      actions.loading(paneId, path)
      const result = await list(sessionId, path, signal)
      if (aborted()) return undefined
      if (result.ok) actions.loaded(paneId, path, result.value)
      else actions.failed(paneId, path, result.error)
      return result.ok ? result.value : undefined
    }
    // Store writes after which a reveal takes one step, rather than one per write.
    let batching = false
    const batch = (write: () => void): void => {
      batching = true
      try {
        write()
      } finally {
        batching = false
      }
    }
    // A kept level is listed again only once its directory's watch is ready;
    // until that listing settles, a reveal must not take its entries as current.
    const relisting = (paneId: PaneId, paths: readonly string[]): void => {
      for (const path of paths) {
        if (store.getSnapshot().byPane[paneId]?.tree?.levels[path]?.kind === 'ready') actions.loading(paneId, path)
      }
    }
    // A record made by a drawing whose navigator never attached, because its
    // tab had closed, has nothing else to end it.
    const drop = (paneId: PaneId): void => {
      const pane = panes.get(paneId)
      if (pane !== undefined && pane.lifetime === undefined) settle(paneId, pane)
    }
    // `manual` is the reader's toggle; a reveal's own expansions pass `false`.
    const expand = (paneId: PaneId, parentPath: string, path: string, expanded: readonly string[], manual: boolean): void => {
      const pane = panes.get(paneId)
      const root = pane?.root
      if (pane === undefined || root === undefined) return
      const parent = root.find(parentPath)
      if (parent === undefined && !expanded.includes(parentPath)) return
      const collapsing = expanded.includes(path)
      // A reader who collapses a directory ends the pane's reveal, so it neither
      // expands that directory again nor replays when the tree is drawn again.
      if (manual && collapsing && pane.revealing !== undefined) {
        pane.revealed = pane.revealing
        pane.revealing = undefined
      }
      const next = collapsing ? expanded.filter(value => value !== path) : [...expanded, path]
      root.setExpanded(next)
      if (collapsing) void parent?.collapse(path)
      else parent?.expand(path, next)
      batch(() => {
        actions.toggled(paneId, path)
        if (!collapsing) relisting(paneId, next.filter(value => value === path || value.startsWith(childPath(path, ''))))
      })
      reveal()
    }
    const focusTree = (pane: PaneRecord): void => {
      const handoff = {}
      pane.focus = handoff
      // The dock keeps a newly shown tab's host inert until its own layout
      // effect, later in this drawing's commit, and the tab's body may draw the
      // tree again before the task ends; focus moves once the commit ends, to
      // the drawing in place then.
      queueMicrotask(() => {
        if (pane.focus !== handoff) return
        pane.focus = undefined
        const target = pane.current ?? pane.drawn?.body
        target?.focus()
      })
    }
    // One step of a reveal: expand the next collapsed ancestor, wait while a
    // level on the way lists, or finish. Every store change takes the next step;
    // a kept tree without its listing waits for the hold that lists it again.
    const step = (paneId: PaneId, pane: PaneRecord): void => {
      const address = pane.revealing
      const tree = store.getSnapshot().byPane[paneId]?.tree
      if (address === undefined || tree === undefined || pane.root === undefined) return
      const path = relativeFileOf(address, sessionId, tree.root)
      const location = path === undefined ? undefined : locateFile(tree, path)
      const next = location?.ancestors.find(ancestor => !tree.expanded.includes(ancestor.path))
      if (next !== undefined) {
        expand(paneId, next.parent, next.path, tree.expanded, false)
        return
      }
      if (location?.pending === true) return
      pane.revealing = undefined
      pane.revealed = address
      if (location?.current === undefined) return
      if (pane.current === undefined) pane.scrollToCurrent = true
      else pane.current.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
    const reveal = (): void => {
      for (const [paneId, pane] of panes) if (pane.revealing !== undefined) step(paneId, pane)
    }
    store.subscribe(() => { if (!batching) reveal() })
    const open = (paneId: PaneId, pane: PaneRecord, signal: AbortSignal, root: string): void => {
      if (pane.root?.path === root) return
      void pane.root?.close()
      const tree = store.getSnapshot().byPane[paneId]?.tree
      const kept = tree?.root === root ? tree : undefined
      if (kept === undefined) {
        actions.start(paneId, root)
        pane.scrollTop = 0
        pane.revealed = undefined
        pane.revealing = pane.drawn?.address
      }
      // The node's own lifetime ends with the pane, the last hold, or a later root replacing it.
      const node = new DirectoryNode(root,
        (path, lifetime) => load(paneId, path, lifetime),
        (path, lifetime) => watch(sessionId, path, lifetime),
        (path, error) => {
          if (pane.root === node) actions.failed(paneId, path, new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}))
        }, signal, kept?.expanded,
      )
      if (kept !== undefined) node.setAutomatic(kept.autoRefresh)
      pane.root = node
      node.open()
      if (kept !== undefined) batch(() => { relisting(paneId, kept.expanded) })
      step(paneId, pane)
    }
    // A navigation belongs to its target tab, not the tree that initiated it.
    const answerNavigation = (home: TabHome): void => {
      if (home.mounts === 0) return
      const navigation = home.navigation.getSnapshot()
      if (navigation.revision <= home.revision) return
      const { pane, paneId } = home
      if (store.getSnapshot().byPane[paneId]?.open !== true) {
        home.revision = navigation.revision
        return
      }
      const navigator = pane.navigator
      if (navigator === undefined || pane.drawn?.address !== navigation.address) return
      const row = layoutParent(navigator)
      if (row === null) return
      home.revision = navigation.revision
      const window = row.ownerDocument.defaultView
      if (pane.closable && (row.getBoundingClientRect().width < FILL_BELOW
        || (typeof window?.matchMedia === 'function' && window.matchMedia(FULLSCREEN_QUERY).matches))) face.hide(paneId)
    }
    const answerDrawn = (pane: PaneRecord): void => {
      for (const home of homes.values()) if (home.pane === pane) answerNavigation(home)
    }
    const face: FilesInjected = {
      attach(paneId, tabId, tabSignal) {
        if (tabSignal.aborted) {
          drop(paneId)
          return () => {}
        }
        const pane = record(paneId)
        pane.lifetime ??= new AbortController()
        if (pane.show) {
          pane.show = false
          actions.shown(paneId, true)
        }
        pane.mounts += 1
        let home = homes.get(tabId)
        if (home === undefined) {
          const first: TabHome = { paneId, pane, mounts: 0, revision: 0, navigation: navigationOf(sessionId, tabId) }
          home = first
          homes.set(tabId, first)
          const unsubscribe = first.navigation.subscribe(() => { answerNavigation(first) })
          tabSignal.addEventListener('abort', () => {
            unsubscribe()
            homes.delete(tabId)
            leave(tabId, first)
          }, { once: true })
        } else if (home.pane !== pane) {
          leave(tabId, home)
          home.paneId = paneId
          home.pane = pane
        }
        home.mounts += 1
        pane.tabs.add(tabId)
        answerNavigation(home)
        let attached = true
        return () => {
          if (!attached) return
          attached = false
          pane.mounts -= 1
          home.mounts -= 1
          settle(paneId, pane)
        }
      },
      placeBeside: tabId => place(tabId, face),
      hold(paneId, root) {
        const pane = panes.get(paneId)
        if (pane?.lifetime === undefined) return () => {}
        pane.holds += 1
        open(paneId, pane, pane.lifetime.signal, root)
        let held = true
        return () => {
          if (!held) return
          held = false
          pane.holds -= 1
          // A tab switch draws the next tree in the same commit, which holds it again first.
          queueMicrotask(() => {
            if (pane.holds > 0) return
            void pane.root?.close()
            pane.root = undefined
          })
        }
      },
      refresh: (paneId) => { void panes.get(paneId)?.root?.refreshTree() },
      setAutoRefresh: (paneId, enabled) => {
        actions.autoRefresh(paneId, enabled)
        panes.get(paneId)?.root?.setAutomatic(enabled)
      },
      toggle: (paneId, parentPath, path, expanded) => { expand(paneId, parentPath, path, expanded, true) },
      scrolled: (paneId, scrollTop) => {
        const pane = panes.get(paneId)
        if (pane?.lifetime !== undefined) pane.scrollTop = scrollTop
      },
      hide(paneId) {
        const pane = panes.get(paneId)
        // The store keeps records only for attached panes.
        if (pane?.lifetime === undefined) return
        const navigator = pane.navigator
        const held = pane.focus !== undefined || navigator?.contains(navigator.ownerDocument.activeElement) === true
        pane.focus = undefined
        actions.shown(paneId, false)
        // The tab an open lands on draws its own toggle in the commit React
        // flushes in a microtask queued before this one, so this focus finds it.
        if (held) queueMicrotask(() => { panes.get(paneId)?.toggle?.focus() })
      },
      focus(paneId) {
        // A tab that just moved draws in its new pane before that drawing's
        // effects attach it, so its record, made by the drawing, is enough; the
        // store records the navigator shown once the pane attaches.
        const pane = panes.get(paneId)
        if (pane === undefined) return
        if (pane.lifetime === undefined) pane.show = true
        else actions.shown(paneId, true)
        if (pane.drawn === undefined) pane.focus = REQUESTED
        else focusTree(pane)
      },
      bodyDrawn(paneId, address, body) {
        if (body === null) {
          // A drawing goes after its pane may have been forgotten; that leaves nothing to record.
          const pane = panes.get(paneId)
          if (pane === undefined) return
          const gone = pane.drawn?.body
          pane.drawn = undefined
          pane.revealing = undefined
          pane.scrollToCurrent = false
          drop(paneId)
          if (gone?.contains(gone.ownerDocument.activeElement) !== true) return
          // Only a drawing in the same commit, the next tab's, takes the keyboard over.
          const handoff = {}
          pane.focus = handoff
          queueMicrotask(() => { if (pane.focus === handoff) pane.focus = undefined })
          return
        }
        const pane = record(paneId)
        pane.drawn = { body, address }
        body.scrollTop = pane.scrollTop
        if (pane.focus !== undefined) focusTree(pane)
        pane.revealing = pane.revealed === address ? undefined : address
        step(paneId, pane)
      },
      currentDrawn(paneId, row) {
        if (row === null) {
          const pane = panes.get(paneId)
          if (pane !== undefined) pane.current = undefined
          drop(paneId)
          return
        }
        const pane = record(paneId)
        pane.current = row
        if (!pane.scrollToCurrent) return
        pane.scrollToCurrent = false
        row.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      },
      navigatorDrawn(paneId, navigator, closable) {
        const pane = navigator === null ? panes.get(paneId) : record(paneId)
        if (pane === undefined) return
        pane.unobserve?.()
        pane.unobserve = undefined
        pane.navigator = navigator ?? undefined
        pane.closable = closable
        if (navigator === null) {
          drop(paneId)
          return
        }
        const row = layoutParent(navigator)
        if (row === null) return
        const document = row.ownerDocument
        // The resize edge while it holds the keyboard. A width at which the
        // tree fills the row removes it, and the fullscreen viewport hides it,
        // which blurs it before the row reports its new width; either way the
        // keyboard moves to the tree.
        let edge: Element | undefined
        const handOff = (): void => {
          const held = edge
          if (held === undefined) return
          const active = document.activeElement
          if (active !== held && active !== document.body && active !== null) {
            edge = undefined
            return
          }
          // An edge still drawn keeps the mark only while it still holds the keyboard.
          if (held.isConnected && getComputedStyle(held).display !== 'none') {
            if (active !== held) edge = undefined
            return
          }
          edge = undefined
          focusTree(pane)
        }
        const focusin = (event: FocusEvent): void => {
          edge = event.target instanceof Element && event.target.hasAttribute('data-files-navigator-resize') ? event.target : undefined
        }
        const focusout = (event: FocusEvent): void => {
          if (event.relatedTarget === null) queueMicrotask(handOff)
          else edge = undefined
        }
        const viewport = closable && typeof matchMedia === 'function' ? matchMedia(FULLSCREEN_QUERY) : undefined
        let filling = false
        const hidden = (element: Element): boolean => getComputedStyle(element).visibility === 'hidden'
        // Covered content that a fill's `visibility: hidden` blurred to nowhere,
        // until the next measurement or until the reader moves the keyboard or
        // the pointer, or the window loses focus. The browser may blur it in a
        // task before the observer or the media query reports the fill.
        let covered: Element | undefined
        const release = (event: FocusEvent): void => {
          const target = event.target
          covered = event.relatedTarget === null && target instanceof Element && !navigator.contains(target) && hidden(target)
            ? target
            : undefined
        }
        const forget = (): void => { covered = undefined }
        const measure = (): void => {
          // Layout can blur content that the fullscreen stylesheet hides.
          const active = document.activeElement
          const blurred = covered
          covered = undefined
          const width = row.getBoundingClientRect().width
          const fills = closable && (width < FILL_BELOW || viewport?.matches === true)
          const entering = fills && !filling
          filling = fills
          pane.width.set(width)
          answerDrawn(pane)
          const inContent = active !== null && row.contains(active) && !navigator.contains(active)
          const blurredByFill = blurred !== undefined && (active === null || active === document.body)
            && row.contains(blurred) && hidden(blurred)
          if (entering && store.getSnapshot().byPane[paneId]?.open === true
            && (inContent || blurredByFill) && pane.focus === undefined) focusTree(pane)
          // React removes the edge in the commit it flushes in a microtask
          // queued before this one, so the check sees the new drawing.
          if (edge !== undefined) queueMicrotask(handOff)
        }
        // On the document, so the row's own handlers see the key first and can keep it.
        const close = (event: KeyboardEvent): void => {
          if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing
            || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          if (!(event.target instanceof Node) || !row.contains(event.target)) return
          event.preventDefault()
          pane.toggle?.focus()
          actions.shown(paneId, false)
        }
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(row)
        viewport?.addEventListener('change', measure)
        if (closable) {
          document.addEventListener('keydown', close)
          row.addEventListener('focusout', release)
          document.addEventListener('focusin', forget, true)
          document.addEventListener('pointerdown', forget, true)
          window.addEventListener('blur', forget)
        }
        navigator.addEventListener('focusin', focusin)
        navigator.addEventListener('focusout', focusout)
        pane.unobserve = () => {
          observer.disconnect()
          viewport?.removeEventListener('change', measure)
          document.removeEventListener('keydown', close)
          row.removeEventListener('focusout', release)
          document.removeEventListener('focusin', forget, true)
          document.removeEventListener('pointerdown', forget, true)
          window.removeEventListener('blur', forget)
          navigator.removeEventListener('focusin', focusin)
          navigator.removeEventListener('focusout', focusout)
        }
      },
      toggleDrawn(paneId, toggle) {
        if (toggle !== null) {
          record(paneId).toggle = toggle
          return
        }
        const pane = panes.get(paneId)
        if (pane !== undefined) pane.toggle = undefined
        drop(paneId)
      },
      hooks: { canOpen },
      keyedHooks: { rowWidth: paneId => record(paneId as PaneId).width },
    }
    return face
  }
}
