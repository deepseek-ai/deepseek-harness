/**
 * The preview's own state: the pages it has read, and how the reader views them.
 *
 * The `file` resource carries metadata only, so the text is this type's to fetch
 * and keep — page by page, keyed by the 1-based line each page starts at. The
 * view state (scroll offset, wrap, the navigation already answered) must outlive
 * the body: a tab switched away from unmounts its body and must come back where
 * it was rather than re-read or jump to its opening line again. Bucketed by tab
 * id because two tabs of one file scroll independently.
 *
 * A bucket lives as long as its tab record: the face's first read of a tab arms
 * one listener on the owner's `signal` that forgets the bucket when the record
 * ends, and a tab that never read has no bucket to forget.
 */
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { WorkspaceFileText } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { DocumentFileBytes } from './rpc.ts'
import type { DocumentLoadMode } from './document/registry.ts'

/**
 * One page as the store keeps it: its text and the Host's line count, which
 * tells a page past the file's last line (`lines: 0`) from a page holding one
 * empty line (`lines: 1`, `text: ''`).
 */
export interface TextPage {
  readonly text: string
  readonly lines: number
}

/** One tab's pages and view. */
export interface TextTabState {
  /** Explicit viewer choice for this tab; absence follows automatic matching. */
  rendererId?: string
  /** Current display-loading mode; absent before the first read. */
  mode?: DocumentLoadMode
  /** Full byte result used by complete-file renderers. */
  complete?: DocumentFileBytes
  /** The file version the loaded pages belong to; absent before the first page. */
  version: string | undefined
  /** Metadata version observed when this tab began its current read generation. */
  observedVersion: string | undefined
  /** Pages by the 1-based line each starts at. */
  pages: Record<number, TextPage>
  /** Whether the last loaded page reached the end of the file. */
  eof: boolean
  /** A page read is in flight. */
  loading: boolean
  /** Why the last page read failed; cleared by the next page. */
  failure: RemoteFailure | undefined
  /** Scroll offset of the body, in px. */
  scrollTop: number
  /** Whether long lines wrap instead of scrolling horizontally; on until the reader turns it off. */
  wrap: boolean
  /** The `navigation.revision` the body already answered; absent before the first. */
  revision: number | undefined
}

/** Every tab's state, keyed by tab id. */
export interface TextState {
  byTab: Record<TabId, TextTabState>
}

/**
 * A tab's state before it reads, scrolls, toggles, or answers anything.
 * @returns the empty bucket.
 */
export function fresh(): TextTabState {
  return {
    version: undefined,
    observedVersion: undefined,
    pages: {},
    eof: false,
    loading: false,
    failure: undefined,
    scrollTop: 0,
    wrap: true,
    revision: undefined,
  }
}

/** The bucket for one tab, created on first write. */
function bucket(state: TextState, tabId: TabId): TextTabState {
  return state.byTab[tabId] ??= fresh()
}

/** The preview store's write set; every action names the tab it writes. */
type TextActions = {
  selected: (draft: TextState, tabId: TabId, rendererId: string | undefined) => void
  loading: (draft: TextState, tabId: TabId, mode?: DocumentLoadMode, observedVersion?: string) => void
  complete: (draft: TextState, tabId: TabId, file: DocumentFileBytes) => void
  page: (draft: TextState, tabId: TabId, page: WorkspaceFileText) => void
  failed: (draft: TextState, tabId: TabId, failure: RemoteFailure) => void
  reset: (draft: TextState, tabId: TabId) => void
  scrolled: (draft: TextState, tabId: TabId, scrollTop: number) => void
  toggledWrap: (draft: TextState, tabId: TabId) => void
  navigated: (draft: TextState, tabId: TabId, revision: number) => void
  forget: (draft: TextState, tabId: TabId) => void
}

/**
 * Declare the preview's store.
 *
 * Constructed once in apply and shared by the body and the tools registrations,
 * which the slot runtime allows because both are session-scoped.
 * @returns the store handle to declare on both registrations.
 */
export function createTextStore(): EngineStoreHandle<TextState, TextActions> {
  return defineStore({
    init: (): TextState => ({ byTab: {} }),
    actions: {
      /** @param d - draft. @param tabId - owning tab. @param rendererId - manual choice, or automatic selection. */
      selected: (d, tabId: TabId, rendererId: string | undefined) => {
        if (rendererId === undefined) delete bucket(d, tabId).rendererId
        else bucket(d, tabId).rendererId = rendererId
      },
      /**
       * Mark a page read as in flight.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param mode - selected renderer's loading mode.
       * @param observedVersion - metadata version at read start; later pages retain the initial observation.
       */
      loading: (d, tabId: TabId, mode?: DocumentLoadMode, observedVersion?: string) => {
        const state = bucket(d, tabId)
        if (state.version === undefined && !state.loading) state.observedVersion = observedVersion
        state.loading = true
        state.failure = undefined
        if (mode !== undefined) state.mode = mode
      },
      /** @param d - draft. @param tabId - owning tab. @param file - complete byte result for this view. */
      complete: (d, tabId: TabId, file: DocumentFileBytes) => {
        const state = bucket(d, tabId)
        state.complete = file
        state.version = file.version
        state.eof = true
        state.loading = false
        state.failure = undefined
      },
      /**
       * Keep one page. A page from a newer file version invalidates the pages
       * of the older one, so the body never shows two versions at once.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param page - the page the Host returned.
       */
      page: (d, tabId: TabId, page: WorkspaceFileText) => {
        const state = bucket(d, tabId)
        if (state.version !== undefined && state.version !== page.version) state.pages = {}
        state.version = page.version
        state.pages[page.offset] = { text: page.text, lines: page.lines }
        state.eof = page.eof
        state.loading = false
        state.failure = undefined
      },
      /**
       * Record why a page read failed; the pages already held stay.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param failure - the settled Remote failure.
       */
      failed: (d, tabId: TabId, failure: RemoteFailure) => {
        const state = bucket(d, tabId)
        state.loading = false
        state.failure = failure
      },
      /**
       * Drop every page, keeping the view, for a re-read from the first line.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       */
      reset: (d, tabId: TabId) => {
        const state = bucket(d, tabId)
        state.pages = {}
        delete state.complete
        state.eof = false
        state.version = undefined
        state.observedVersion = undefined
        state.loading = false
        state.failure = undefined
      },
      /**
       * Record where one tab's body is scrolled to.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param scrollTop - the body's scroll offset, in px.
       */
      scrolled: (d, tabId: TabId, scrollTop: number) => {
        bucket(d, tabId).scrollTop = scrollTop
      },
      /**
       * Switch one tab between wrapped and unwrapped lines.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       */
      toggledWrap: (d, tabId: TabId) => {
        const state = bucket(d, tabId)
        state.wrap = !state.wrap
      },
      /**
       * Record that the body answered one navigation, so a remount restores the
       * reader's position instead of jumping again.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param revision - the `navigation.revision` answered.
       */
      navigated: (d, tabId: TabId, revision: number) => {
        bucket(d, tabId).revision = revision
      },
      /**
       * Drop one tab's state, for a tab record that is gone.
       * @param d - draft state.
       * @param tabId - the tab that went away.
       */
      forget: (d, tabId: TabId) => {
        const byTab: TextState['byTab'] = {}
        // Keys were written from tab ids; reading them back as ids is exact.
        for (const [id, state] of Object.entries(d.byTab) as [TabId, TextTabState][]) {
          if (id !== tabId) byTab[id] = state
        }
        d.byTab = byTab
      },
    },
  })
}

/** The store handle type both registrations declare. */
export type TextStore = ReturnType<typeof createTextStore>
