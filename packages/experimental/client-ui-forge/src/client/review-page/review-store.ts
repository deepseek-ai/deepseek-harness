/**
 * Choices of the review page that outlive its mount: the change request shown in full, its tab, whether the list column
 * hides, which list sections fold, the host or repository the lists are narrowed to, the search text, the conversation the page
 * started for each change request, and the changes view's choices for each change request.
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { ForgeViewerFilter } from '@deepseek-ai/dsh-experimental-forge/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { changesActions, type ChangesState } from '../changes-store.ts'
import { mergeRepositories, type ReviewRepository, type ReviewScope } from './review-lists.ts'

/** A tab of the review page's detail. */
export type ReviewTab = 'summary' | 'changes' | 'chat'

/** How the list column shows its items: two lines each, or one line each with the rest in a hover card. */
export type ReviewView = 'detailed' | 'compact'

/**
 * Name the changes view of a change request in the store's `byTab`.
 * @param url - web URL of the change request.
 * @returns the tab id the view keeps its choices under.
 */
export function changesTabOf(url: string): string {
  return `review:${url}`
}

/** The review page's choices, and those of its changes view by change request URL. */
export interface ReviewPageState extends ChangesState {
  /** Web URL of the change request shown in full, or null. */
  selected: string | null
  /** Tab of the detail. */
  tab: ReviewTab
  /** Whether the list column hides. */
  listHidden: boolean
  /** List sections the reader folded. */
  folded: Partial<Record<ForgeViewerFilter, boolean>>
  /** What the lists are narrowed to: one host, one repository, or null for every repository of every host. */
  scope: ReviewScope | null
  /**
   * Repositories the lists named while they were read in every repository, which the repository menu keeps offering
   * while the lists are read in one.
   */
  repositories: readonly ReviewRepository[]
  /** Text the lists are searched for. */
  query: string
  /** Whether the review-requested list leaves out requests that ask only one of the user's teams. */
  directOnly: boolean
  /** The conversation the page's chat started for a change request, by its URL, until the page reloads. */
  conversations: Record<string, SessionId>
  /** How the list column shows its items. */
  view: ReviewView
  /** Quotes added to each change request's conversation while its chat tab was not shown, by URL. */
  unseenQuotes: Record<string, number>
}

const reviewActions = {
  ...changesActions,
  select: (state: ReviewPageState, url: string | null) => {
    state.selected = url
    state.tab = 'summary'
  },
  tabbed: (state: ReviewPageState, tab: ReviewTab) => {
    state.tab = tab
    if (tab === 'chat' && state.selected !== null) state.unseenQuotes[state.selected] = 0
  },
  /**
   * Show the changes tab with one commit chosen in the changes view of a change request, which keeps its choices from
   * the time the detail first shows.
   */
  openedCommit: (state: ReviewPageState, url: string, sha: string) => {
    changesActions.committed(state, changesTabOf(url), { from: sha, to: sha })
    state.tab = 'changes'
  },
  viewed: (state: ReviewPageState, view: ReviewView) => { state.view = view },
  quoted: (state: ReviewPageState, url: string) => {
    if (state.selected === url && state.tab === 'chat') return
    state.unseenQuotes[url] = (state.unseenQuotes[url] ?? 0) + 1
  },
  toggledList: (state: ReviewPageState) => { state.listHidden = !state.listHidden },
  folded: (state: ReviewPageState, filter: ForgeViewerFilter) => { state.folded[filter] = state.folded[filter] !== true },
  scopedTo: (state: ReviewPageState, scope: ReviewScope | null) => { state.scope = scope },
  /**
   * Record the repositories the lists read in every repository name: a complete read replaces the record, and a read
   * still under way or failed in part adds to it.
   */
  listed: (state: ReviewPageState, repositories: ReviewPageState['repositories'], complete: boolean) => {
    const next = complete ? mergeRepositories(repositories) : mergeRepositories(state.repositories, repositories)
    const names = (list: ReviewPageState['repositories']): string => list.map(item => `${item.host} ${item.owner}/${item.name}`).join('\n')
    if (names(next) !== names(state.repositories)) state.repositories = [...next]
  },
  searched: (state: ReviewPageState, query: string) => { state.query = query },
  toggledDirect: (state: ReviewPageState) => { state.directOnly = !state.directOnly },
  conversed: (state: ReviewPageState, url: string, session: SessionId | null) => {
    if (session === null) state.conversations = Object.fromEntries(Object.entries(state.conversations).filter(([key]) => key !== url))
    else state.conversations[url] = session
  },
}

/**
 * Declare the review page's choices, kept by the framework for the page entry's lifetime.
 * @returns the entry's store handle.
 */
export function createReviewStore(): EngineStoreHandle<ReviewPageState, typeof reviewActions> {
  return defineStore({
    init: (): ReviewPageState => ({
      selected: null, tab: 'summary', listHidden: false, folded: {}, scope: null, repositories: [], query: '', directOnly: false, conversations: {}, view: 'detailed', unseenQuotes: {}, byTab: {},
    }),
    actions: reviewActions,
  })
}
