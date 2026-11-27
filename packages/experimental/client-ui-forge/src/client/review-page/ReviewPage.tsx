/**
 * The review page: the signed-in user's change requests beside the one the reader shows in full. The page reads its
 * lists and the shown change request through Host streams that run only while it is mounted, keeps the reader's choices
 * in its store, and shows one column at a time where the page is narrow.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import type {
  GlobalStandardProps, HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots/client'
// Type-only: the `useMediaQuery` standard prop merge.
import type {} from '@deepseek-ai/dsh-client-ui-responsive/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { ForgeReviewThread } from '@deepseek-ai/dsh-experimental-forge/types'
import type { ForgeReviewChangeRequest, ForgeReviewFrame } from '../../types.ts'
import type { ChangeRequestActions } from '../ChangeRequestCard.tsx'
import type { ForgeLensDescription } from '../changes-service.ts'
import { ChangesView, type ChangesTabInjected, type ChangesViewTab } from '../ChangesTab.tsx'
import { useHostStream, type StreamRead } from './host-stream.ts'
import type { NS } from '../locales.ts'
import { ReviewChat, useReviewConversation, type ReviewChatFace } from './ReviewChat.tsx'
import { ReviewDetail, type ReviewSummaryFace } from './ReviewDetail.tsx'
import { ReviewList } from './ReviewList.tsx'
import type { QuoteCopy, ReviewSelection } from '../review.ts'
import { reviewListsComplete, reviewRepositories, scopeRepository, type ReviewRepository } from './review-lists.ts'
import { changesTabOf, type createReviewStore, type ReviewTab } from './review-store.ts'
import type { HostStream, StreamSnapshot } from '../source.ts'
import type { ChangesPanelState } from '../status.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ForgeExtensionState } from '../../types.ts'
import css from './ReviewPage.module.css'

/**
 * What the changes view of the review page reads and does, each naming the change request by URL; the page quotes
 * comments and threads into its own conversation.
 */
export type ReviewChangesFace = Omit<ChangesTabInjected, 'keyedHooks' | 'hooks' | 'reconnect' | 'addReviewToInput' | 'addThreadToInput'>

/** The quote copy of the review page, which quotes into the change request's conversation. */
const CHAT_QUOTE_COPY: QuoteCopy = { add: 'reviewPage.addToChat', added: 'reviewPage.addedToChat', failed: 'reviewPage.addToChatFailed' }

/** Business face of the review page. */
export interface ReviewPageInjected extends ReviewSummaryFace {
  readonly hooks: {
    /** The UI language; the renderer binds it as `useLocale`. */
    readonly locale: HostObservable<string>
    /** Whether the Plugins page can be opened; the renderer binds it as `usePluginNavigation`. */
    readonly pluginNavigation: HostObservable<boolean>
  }
  /** Open the list stream of one repository on its host, or of every repository of every host for null. */
  readonly openLists: (repository: ReviewRepository | null, signal: AbortSignal) => HostStream<ForgeReviewFrame>
  /** Open the stream of one change request by URL. */
  readonly openChangeRequest: (url: string, signal: AbortSignal) => HostStream<ForgeReviewChangeRequest>
  /** Subscribe to transport resets, after which open streams no longer deliver. */
  readonly subscribeReset: (listener: () => void) => () => void
  /** Read every list again; settles once the Host accepted the request, after reporting a failure. */
  readonly refresh: () => Promise<void>
  /** Open the Plugins page where the providers' hosts are listed, while `pluginNavigation` holds. */
  readonly openHostSettings: () => void
  /** The card actions acting on one change request; `showChanges` opens the changes tab. */
  readonly actionsFor: (url: string, showChanges: () => void) => ChangeRequestActions
  /** Reads and writes of the changes view. */
  readonly changes: ReviewChangesFace
  /** Copy text and report the outcome. */
  readonly copyText: (text: string) => void
  /** What the chat tab asks of the forge panel. */
  readonly chat: ReviewChatFace
  /** Quote a comment in a retained Session's draft; returns whether the draft took it. */
  readonly quoteReview: (sessionId: SessionId, selection: ReviewSelection) => boolean
  /** Quote a whole thread in a retained Session's draft; returns whether the draft took it. */
  readonly quoteThread: (sessionId: SessionId, thread: ForgeReviewThread, url: string, range: string | null) => boolean
}

/** Full props of the review page. */
export type ReviewPageProps = InjectFace<ReviewPageInjected> & PropsStore<ReturnType<typeof createReviewStore>>
  & Pick<PropsRenderSlots<'forge.review.conversation'>, 'renderSlot' | 'SessionProvider'> & PropsLocale<typeof NS>
  & Pick<GlobalStandardProps, 'useMediaQuery'>

/** Selector hooks over a fixed value, for the parts of the changes view the review page does not offer. */
function fixedHook<T>(value: T): SnapshotSelectorHook<T> {
  return selector => selector(value)
}

const NO_LENSES = fixedHook<readonly ForgeLensDescription[]>([])
const NO_EXTENSIONS = fixedHook<StreamSnapshot<ForgeExtensionState | null>>({ state: null, disconnected: false })
const NO_BINDING = (): (() => void) => () => {}
/* v8 ignore next -- the changes view renders plugin slots only for a target, and the review page passes none */
const NO_SLOT = (): null => null

/** Refreshes relative times once a minute. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 60_000)
    return () => { clearInterval(timer) }
  }, [])
  return now
}

/** The changes view of one change request, kept while its URL stays shown. */
function ReviewChanges({ frame, visible, changes, useStore, actions, t }: {
  readonly frame: ForgeReviewChangeRequest
  readonly visible: boolean
  readonly changes: Omit<ChangesTabInjected, 'keyedHooks' | 'hooks' | 'reconnect'>
  readonly useStore: ReviewPageProps['useStore']
  readonly actions: ReviewPageProps['actions']
  readonly t: ReviewPageProps['t']
}): ReactNode {
  const { url } = frame
  // Pending review comments live as long as this signal: until the page shows another change request or unmounts.
  const [lifetime, setLifetime] = useState<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setLifetime(controller)
    return () => { controller.abort() }
  }, [url])
  const tab = useMemo((): ChangesViewTab | null => lifetime === null ? null : {
    id: changesTabOf(url), visible, navigation: { address: url, params: undefined, revision: 1 }, signal: lifetime.signal,
    actions: { bindCommands: NO_BINDING },
  }, [url, visible, lifetime])
  const source = useMemo(() => ({ kind: 'change' as const, url }), [url])
  const snapshot = useMemo((): { readonly state: ChangesPanelState; readonly disconnected: boolean } => ({
    state: { checkout: { state: 'none' }, repository: frame.ref.repository, local: null, changeRequests: [frame] }, disconnected: false,
  }), [frame])
  if (tab === null) return null
  return (
    <ChangesView {...changes} tab={tab} source={source} target={null} snapshot={snapshot} annotations={undefined} openFile={undefined}
      quoteCopy={CHAT_QUOTE_COPY}
      reconnect={NO_BINDING} useLenses={NO_LENSES} useExtensions={NO_EXTENSIONS} renderSlot={NO_SLOT}
      useStore={useStore} actions={actions} t={t} />
  )
}

/** Props of the detail pane, keyed by the shown change request. */
interface DetailPaneProps {
  readonly url: string
  readonly read: StreamRead<ForgeReviewChangeRequest>
  readonly tab: ReviewTab
  readonly listHidden: boolean
  readonly now: number
  readonly locale: string
  readonly cardActions: ChangeRequestActions
  readonly conversationId: SessionId | undefined
  readonly onConversation: (sessionId: SessionId | null) => void
  readonly unseenQuotes: number
  readonly coarsePointer: boolean
  readonly page: ReviewPageProps
}

/**
 * The detail of the shown change request with the conversation the page keeps for it: quotes from the changes tab go
 * into that conversation's draft, starting the conversation when there is none.
 * @param props - the change request stream, the tab, the conversation, and the page's face.
 * @returns the detail.
 */
function DetailPane({
  url, read, tab, listHidden, now, locale, cardActions, conversationId, onConversation, unseenQuotes, coarsePointer, page,
}: DetailPaneProps): ReactNode {
  const { actions, changes, chat, quoteReview, quoteThread, readDescription, readActivity, addComment, renderSlot } = page
  const { SessionProvider, useStore, t } = page
  const hostSettings = page.usePluginNavigation(value => value)
  const conversation = useReviewConversation(read.frame, conversationId, onConversation, chat)
  const { start } = conversation
  const quoteChanges = useMemo(() => {
    const quote = async (insert: (sessionId: SessionId) => boolean): Promise<boolean> => {
      const retained = await start()
      if (retained === undefined || !insert(retained.sessionId)) return false
      actions.quoted(url)
      return true
    }
    return {
      ...changes,
      addReviewToInput: async (selection: ReviewSelection) => await quote(sessionId => quoteReview(sessionId, selection)),
      addThreadToInput: async (thread: ForgeReviewThread, threadUrl: string, range: string | null) =>
        await quote(sessionId => quoteThread(sessionId, thread, threadUrl, range)),
    }
  }, [changes, start, quoteReview, quoteThread, actions, url])
  return (
    <ReviewDetail
      url={url}
      read={read}
      tab={tab}
      onTab={(value: ReviewTab) => { actions.tabbed(value) }}
      onOpenCommit={(sha: string) => { actions.openedCommit(url, sha) }}
      listHidden={listHidden}
      onToggleList={() => { actions.toggledList() }}
      onBack={() => { actions.select(null) }}
      now={now}
      locale={locale}
      actions={cardActions}
      readDescription={readDescription}
      readActivity={readActivity}
      addComment={addComment}
      onAddHost={hostSettings ? page.openHostSettings : undefined}
      renderChanges={frame => (
        <ReviewChanges frame={frame} visible={tab === 'changes'} changes={quoteChanges} useStore={useStore} actions={actions} t={t} />
      )}
      renderChat={frame => (
        <ReviewChat frame={frame} sessionId={conversationId} conversation={conversation} onConversation={onConversation} chat={chat}
          renderSlot={renderSlot} SessionProvider={SessionProvider} t={t} />
      )}
      unseenQuotes={unseenQuotes}
      coarsePointer={coarsePointer}
      t={t}
    />
  )
}

/**
 * Render the review page.
 * @param props - the Host streams and reads, the card actions, the page store, the media query hook, and copy.
 * @returns the page.
 */
export function ReviewPage(props: ReviewPageProps): ReactNode {
  const { useLocale, openLists, openChangeRequest, subscribeReset, refresh, actionsFor, copyText, useStore, actions, t } = props
  const locale = useLocale(value => value)
  const coarsePointer = props.useMediaQuery('(pointer: coarse)')
  const now = useMinuteClock()
  const selected = useStore(state => state.selected)
  const tab = useStore(state => state.tab)
  const listHidden = useStore(state => state.listHidden)
  const folded = useStore(state => state.folded)
  const scope = useStore(state => state.scope)
  const repository = scopeRepository(scope)
  const repositories = useStore(state => state.repositories)
  const query = useStore(state => state.query)
  const directOnly = useStore(state => state.directOnly)
  const view = useStore(state => state.view)
  const unseenQuotes = useStore(state => selected === null ? 0 : state.unseenQuotes[selected] ?? 0)
  const conversation = useStore(state => selected === null ? undefined : state.conversations[selected])
  const onConversation = useMemo(() => selected === null ? null : (sessionId: SessionId | null) => {
    actions.conversed(selected, sessionId)
  }, [actions, selected])
  // A scope that names a host only narrows the lists of every repository on the page; one repository is read on its host.
  const listsKey = repository === null ? '' : JSON.stringify([repository.host, repository.owner, repository.name])
  const openScoped = useCallback((_key: string, signal: AbortSignal) => openLists(repository, signal), [openLists, repository])
  const lists = useHostStream(openScoped, listsKey, subscribeReset)
  const hostSettings = props.usePluginNavigation(value => value)
  // Lists read in one repository name only that one, so the repository menu's offer is recorded while they are read in all.
  const listsFrame = lists.frame
  useEffect(() => {
    if (repository === null && listsFrame !== undefined) actions.listed(reviewRepositories(listsFrame), reviewListsComplete(listsFrame))
  }, [repository, listsFrame, actions])
  const detail = useHostStream(openChangeRequest, selected, subscribeReset)
  const [refreshing, setRefreshing] = useState(false)
  const startRefresh = (): void => {
    if (refreshing) return
    setRefreshing(true)
    void refresh().finally(() => { setRefreshing(false) })
  }
  const showChanges = useCallback(() => { actions.tabbed('changes') }, [actions])
  const cardActions = useMemo(() => selected === null ? null : actionsFor(selected, showChanges), [actionsFor, selected, showChanges])
  return (
    <div className={css.root} data-forge-review-page="">
      <div className={clsx(css.page, listHidden && css.pageListHidden, selected !== null && css.pageDetail)}>
        <ReviewList
          frame={lists.frame}
          stopped={lists.stopped}
          selected={selected}
          query={query}
          scope={scope}
          repositories={repositories}
          directOnly={directOnly}
          folded={folded}
          refreshing={refreshing}
          now={now}
          onSelect={(url) => { actions.select(url) }}
          onSearch={(value) => { actions.searched(value) }}
          onScope={(value) => { actions.scopedTo(value) }}
          onToggleDirect={() => { actions.toggledDirect() }}
          view={view}
          onView={(value) => { actions.viewed(value) }}
          onFold={(filter) => { actions.folded(filter) }}
          onRefresh={startRefresh}
          onRetry={lists.retry}
          copyText={copyText}
          onOpenSettings={hostSettings ? props.openHostSettings : undefined}
          t={t}
        />
        {selected === null || cardActions === null || onConversation === null
          ? (
            <div className={clsx(css.detail, css.placeholder)}>
              <div className={css.centered}>
                <p className={css.emptyTitle}>{t('reviewPage.select')}</p>
                <p className={css.emptyHint}>{t('reviewPage.selectHint')}</p>
              </div>
            </div>
          )
          : (
            <DetailPane
              key={selected}
              url={selected}
              read={detail}
              tab={tab}
              listHidden={listHidden}
              now={now}
              locale={locale}
              cardActions={cardActions}
              conversationId={conversation}
              onConversation={onConversation}
              unseenQuotes={unseenQuotes}
              coarsePointer={coarsePointer}
              page={props}
            />
          )}
      </div>
    </div>
  )
}
