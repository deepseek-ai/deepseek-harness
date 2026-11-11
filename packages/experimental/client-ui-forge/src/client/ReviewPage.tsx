/**
 * The review page: the signed-in user's change requests beside the one the reader shows in full. The page reads its
 * lists and the shown change request through Host streams that run only while it is mounted, keeps the reader's choices
 * in its store, and shows one column at a time where the page is narrow.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import type { HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { ChangeRequestDescription } from '@deepseek-ai/dsh-experimental-forge/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ForgeReviewChangeRequest, ForgeReviewFrame } from '../types.ts'
import type { ChangeRequestActions } from './ChangeRequestCard.tsx'
import type { ForgeLensDescription } from './changes-service.ts'
import { ChangesView, type ChangesTabInjected, type ChangesViewTab } from './ChangesTab.tsx'
import { useHostStream } from './host-stream.ts'
import type { NS } from './locales.ts'
import { ReviewChat, type ReviewChatFace } from './ReviewChat.tsx'
import { ReviewDetail } from './ReviewDetail.tsx'
import { ReviewList } from './ReviewList.tsx'
import type { createReviewStore, ReviewTab } from './review-store.ts'
import type { HostStream, StreamSnapshot } from './source.ts'
import type { ChangesPanelState } from './status.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ForgeExtensionState } from '../types.ts'
import css from './ReviewPage.module.css'

/** What the changes view of the review page reads and does, each naming the change request by URL. */
export type ReviewChangesFace = Omit<ChangesTabInjected, 'keyedHooks' | 'hooks' | 'reconnect'>

/** Business face of the review page. */
export interface ReviewPageInjected {
  /** The UI language; the renderer binds it as `useLocale`. */
  readonly hooks: { readonly locale: HostObservable<string> }
  /** Open the list stream of one repository, named `owner/name`, or of every repository for the empty string. */
  readonly openLists: (scope: string, signal: AbortSignal) => HostStream<ForgeReviewFrame>
  /** Open the stream of one change request by URL. */
  readonly openChangeRequest: (url: string, signal: AbortSignal) => HostStream<ForgeReviewChangeRequest>
  /** Subscribe to transport resets, after which open streams no longer deliver. */
  readonly subscribeReset: (listener: () => void) => () => void
  /** Read every list again; settles once the Host accepted the request, after reporting a failure. */
  readonly refresh: () => Promise<void>
  /** Read the description and labels of a change request. */
  readonly readDescription: (url: string, signal: AbortSignal) => Promise<RemoteResult<ChangeRequestDescription>>
  /** The card actions acting on one change request; `showChanges` opens the changes tab. */
  readonly actionsFor: (url: string, showChanges: () => void) => ChangeRequestActions
  /** Reads and writes of the changes view. */
  readonly changes: ReviewChangesFace
  /** Copy text and report the outcome. */
  readonly copyText: (text: string) => void
  /** What the chat tab asks of the forge panel. */
  readonly chat: ReviewChatFace
}

/** Full props of the review page. */
export type ReviewPageProps = InjectFace<ReviewPageInjected> & PropsStore<ReturnType<typeof createReviewStore>>
  & Pick<PropsRenderSlots<'forge.review.conversation'>, 'renderSlot' | 'SessionProvider'> & PropsLocale<typeof NS>

/** Selector hooks over a fixed value, for the parts of the changes view the review page does not offer. */
function fixedHook<T>(value: T): SnapshotSelectorHook<T> {
  return selector => selector(value)
}

const NO_LENSES = fixedHook<readonly ForgeLensDescription[]>([])
const NO_EXTENSIONS = fixedHook<StreamSnapshot<ForgeExtensionState | null>>({ state: null, disconnected: false })
const NO_BINDING = (): (() => void) => () => {}
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
  readonly changes: ReviewChangesFace
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
    id: `review:${url}`, visible, navigation: { address: url, params: undefined, revision: 1 }, signal: lifetime.signal,
    actions: { bindCommands: NO_BINDING },
  }, [url, visible, lifetime])
  const source = useMemo(() => ({ kind: 'change' as const, url }), [url])
  const snapshot = useMemo((): { readonly state: ChangesPanelState; readonly disconnected: boolean } => ({
    state: { checkout: { state: 'none' }, repository: frame.ref.repository, local: null, changeRequests: [frame] }, disconnected: false,
  }), [frame])
  if (tab === null) return null
  return (
    <ChangesView {...changes} tab={tab} source={source} target={null} snapshot={snapshot} annotations={undefined} openFile={undefined}
      reconnect={NO_BINDING} useLenses={NO_LENSES} useExtensions={NO_EXTENSIONS} renderSlot={NO_SLOT}
      useStore={useStore} actions={actions} t={t} />
  )
}

/**
 * Render the review page.
 * @param props - the Host streams and reads, the card actions, the page store, and copy.
 * @returns the page.
 */
export function ReviewPage({
  useLocale, openLists, openChangeRequest, subscribeReset, refresh, readDescription, actionsFor, changes, copyText, chat, useStore, actions,
  renderSlot, SessionProvider, t,
}: ReviewPageProps): ReactNode {
  const locale = useLocale(value => value)
  const now = useMinuteClock()
  const selected = useStore(state => state.selected)
  const tab = useStore(state => state.tab)
  const listHidden = useStore(state => state.listHidden)
  const folded = useStore(state => state.folded)
  const repository = useStore(state => state.repository)
  const query = useStore(state => state.query)
  const directOnly = useStore(state => state.directOnly)
  const conversation = useStore(state => selected === null ? undefined : state.conversations[selected])
  const onConversation = useCallback((sessionId: SessionId | null) => {
    if (selected !== null) actions.conversed(selected, sessionId)
  }, [actions, selected])
  const scope = repository === null ? '' : `${repository.owner}/${repository.name}`
  const lists = useHostStream(openLists, scope, subscribeReset)
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
          repository={repository}
          directOnly={directOnly}
          folded={folded}
          refreshing={refreshing}
          now={now}
          onSelect={(url) => { actions.select(url) }}
          onSearch={(value) => { actions.searched(value) }}
          onScope={(value) => { actions.scopedTo(value) }}
          onToggleDirect={() => { actions.toggledDirect() }}
          onFold={(filter) => { actions.folded(filter) }}
          onRefresh={startRefresh}
          onRetry={lists.retry}
          copyText={copyText}
          t={t}
        />
        {selected === null || cardActions === null
          ? (
            <div className={clsx(css.detail, css.placeholder)}>
              <div className={css.centered}>
                <p className={css.emptyTitle}>{t('reviewPage.select')}</p>
                <p className={css.emptyHint}>{t('reviewPage.selectHint')}</p>
              </div>
            </div>
          )
          : (
            <ReviewDetail
              key={selected}
              url={selected}
              read={detail}
              tab={tab}
              onTab={(value: ReviewTab) => { actions.tabbed(value) }}
              listHidden={listHidden}
              onToggleList={() => { actions.toggledList() }}
              onBack={() => { actions.select(null) }}
              now={now}
              locale={locale}
              actions={cardActions}
              readDescription={readDescription}
              renderChanges={frame => (
                <ReviewChanges frame={frame} visible={tab === 'changes'} changes={changes} useStore={useStore} actions={actions} t={t} />
              )}
              renderChat={frame => (
                <ReviewChat frame={frame} sessionId={conversation} onConversation={onConversation} chat={chat} renderSlot={renderSlot}
                  SessionProvider={SessionProvider} t={t} />
              )}
              askAgent={() => { actions.tabbed('chat') }}
              t={t}
            />
          )}
      </div>
    </div>
  )
}
