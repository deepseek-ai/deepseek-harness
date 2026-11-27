/**
 * The review page's detail of one change request: its header with state, repository, labels, title, author, times, and
 * branches; the merge action beside the actions that open the change request on its code host, copy its link, and read
 * it again; and the summary, changes, and chat tabs. The summary shows the description and the activity beside the
 * status column. While the change request is read, a skeleton of the same layout stands in for it.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutlineRegular, IconChevronLeftOutlineRegular, IconCopyOutlineRegular, IconEllipsisOutlineRegular,
  IconPanelLeftOutlineRegular, MarkdownText, Menu, Tooltip, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots/client'
import type {
  ChangeRequestActivity, ChangeRequestDescription, ChangeRequestSnapshot, ForgeDescription, ForgeFailure,
} from '@deepseek-ai/dsh-experimental-forge/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ForgeReviewChangeRequest } from '../../types.ts'
import loading from '../ChangesLoading.module.css'
import { ChangeRequestPrimary, type ChangeRequestActions } from '../ChangeRequestCard.tsx'
import { openOnLabel } from '../forge-copy.ts'
import { formatAgo } from '../format.ts'
import { ChangeRequestGlyph, ForgeGlyph } from '../glyphs.tsx'
import { RefreshGlyph } from '../RefreshGlyph.tsx'
import type { StreamRead } from './host-stream.ts'
import type { ForgePanelKey, NS } from '../locales.ts'
import { descriptionMarkdown } from './review-lists.ts'
import type { ReviewTab } from './review-store.ts'
import { ReviewActivity } from './ReviewActivity.tsx'
import { ReviewLabels } from './ReviewLabels.tsx'
import { ActivitySkeleton, DescriptionSkeleton, HeaderSkeleton, StatusSkeleton } from './ReviewSkeleton.tsx'
import { ReviewStatus } from './ReviewStatus.tsx'
import { TONE_LABEL, toneOf } from '../status.ts'
import css from './ReviewPage.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** How long before signed image addresses expire the description is read again, in milliseconds. */
const IMAGE_RENEWAL_MS = 30_000

/** How long the copy action shows that it copied, in milliseconds. */
const COPIED_MS = 1500

const FAILURE: Record<ForgeFailure['code'], ForgePanelKey> = {
  'not-found': 'reviewPage.notFound',
  'unauthenticated': 'change.failure.unauthenticated',
  'rate-limited': 'change.failure.rateLimited',
  'too-large': 'change.failure.unavailable',
  'stale': 'change.failure.unavailable',
  'unsupported': 'change.failure.unavailable',
  'unavailable': 'change.failure.unavailable',
}

const TAB_ORDER: readonly ReviewTab[] = ['summary', 'changes', 'chat']

/** What the summary tab reads and writes on the code host. */
export interface ReviewSummaryFace {
  /** Read the description and labels of a change request. */
  readonly readDescription: (url: string, signal: AbortSignal) => Promise<RemoteResult<ChangeRequestDescription>>
  /** Read the activity of a change request; null for a provider that reads none. */
  readonly readActivity: (url: string, signal: AbortSignal) => Promise<RemoteResult<ChangeRequestActivity | null>>
  /** Add a comment to a change request's conversation. */
  readonly addComment: (url: string, body: string) => Promise<RemoteResult<void>>
}

/** Props of the detail. */
export interface ReviewDetailProps extends ReviewSummaryFace {
  /** URL of the change request. */
  readonly url: string
  /** The change request stream. */
  readonly read: StreamRead<ForgeReviewChangeRequest>
  /** Shown tab. */
  readonly tab: ReviewTab
  /** Show a tab. */
  readonly onTab: (tab: ReviewTab) => void
  /** Show the changes tab with one commit chosen, named as the activity names it. */
  readonly onOpenCommit: (sha: string) => void
  /** Whether the list column hides. */
  readonly listHidden: boolean
  /** Hide or show the list column. */
  readonly onToggleList: () => void
  /** Leave the detail for the list, where the page shows one column. */
  readonly onBack: () => void
  /** Current epoch milliseconds for relative times. */
  readonly now: number
  /** Active UI language for numeric formatting. */
  readonly locale: string
  /** The card actions, acting on this change request. */
  readonly actions: ChangeRequestActions
  /** Open the providers' host lists, offered for a URL no provider serves; undefined while they cannot be opened. */
  readonly onAddHost: (() => void) | undefined
  /** The changes tab's content, kept while the detail shows so pending review comments survive tab switches. */
  readonly renderChanges: (frame: ForgeReviewChangeRequest) => ReactNode
  /** The chat tab's content. */
  readonly renderChat: (frame: ForgeReviewChangeRequest) => ReactNode
  /** Quotes added to the conversation while the chat tab was not shown. */
  readonly unseenQuotes: number
  /** Whether the page's primary pointer is coarse, which keeps the reviewer search from focusing its field. */
  readonly coarsePointer: boolean
  /** Forge panel copy. */
  readonly t: Translate
}

/** One description read, keyed by URL, update time, and attempt. */
interface DescriptionRead {
  readonly key: string
  readonly description: ChangeRequestDescription | null
  readonly failure: string | null
}

/** The description read for one change request, read again when it changes and before its signed images expire. */
function useDescription(url: string, updatedAt: string | null, read: ReviewDetailProps['readDescription']): {
  readonly description: ChangeRequestDescription | null
  readonly failure: string | null
  readonly retry: () => void
} {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<DescriptionRead | null>(null)
  const key = `${url}\n${updatedAt ?? ''}\n${attempt}`
  useEffect(() => {
    const controller = new AbortController()
    void read(url, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setState(previous => result.ok
        ? { key, description: result.value, failure: null }
        : { key, description: previous?.key.startsWith(`${url}\n`) === true ? previous.description : null, failure: result.error.message })
    })
    return () => { controller.abort() }
  }, [url, key, read])
  const expireAt = state?.description?.imagesExpireAt ?? null
  useEffect(() => {
    if (expireAt === null) return
    const delay = Math.max(0, Date.parse(expireAt) - Date.now() - IMAGE_RENEWAL_MS)
    if (!Number.isFinite(delay)) return
    const timer = setTimeout(() => { setAttempt(value => value + 1) }, delay)
    return () => { clearTimeout(timer) }
  }, [expireAt])
  const current = state !== null && state.key.startsWith(`${url}\n`) ? state : null
  return { description: current?.description ?? null, failure: current?.failure ?? null, retry: () => { setAttempt(value => value + 1) } }
}

/** The ready-for-review action of an open draft, when the surface offers it. */
function MarkReady({ frame, actions, t }: {
  readonly frame: ForgeReviewChangeRequest
  readonly actions: ChangeRequestActions
  readonly t: Translate
}): ReactNode {
  // One request at a time: the action stays disabled until the previous one settles.
  const [busy, setBusy] = useState(false)
  const { markReady } = actions
  if (markReady === undefined) return null
  return (
    <div className={css.primary}>
      <Button size="sm" variant="outline" className={css.readyAction} disabled={busy} onClick={() => {
        setBusy(true)
        void markReady(frame).finally(() => { setBusy(false) })
      }}>
        {t('change.markReady')}
      </Button>
    </div>
  )
}

/**
 * The actions that leave the page or read again: open the change request on its code host, copy its link, and read its
 * status again. They show as three icon buttons; where the header is narrow its style shows them folded into one menu
 * instead, so both forms render.
 */
function LinkActions({ url, forge, actions, onRefresh, t }: {
  readonly url: string
  readonly forge: ForgeDescription | null
  readonly actions: ChangeRequestActions
  /** Read the status again; a promise it returns settles when the read ends. */
  readonly onRefresh: () => void | Promise<void>
  readonly t: Translate
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => { setCopied(false) }, COPIED_MS)
    return () => { clearTimeout(timer) }
  }, [copied])
  const openLabel = openOnLabel(t, forge?.label ?? null)
  const copy = (): void => {
    actions.copyLink(url)
    setCopied(true)
  }
  const refresh = (): void => {
    setRefreshing(true)
    void Promise.resolve(onRefresh()).finally(() => { setRefreshing(false) })
  }
  const items: MenuEntry[] = [
    { id: 'open', label: openLabel },
    { id: 'copy', label: t('change.copy') },
    { id: 'refresh', label: t('reviewPage.refresh') },
  ]
  return (
    <>
      <span className={css.linkActions} data-forge-review-actions="">
        <Tooltip label={openLabel} side="bottom">
          <button type="button" className={css.iconButton} aria-label={openLabel} onClick={() => { actions.openLink(url) }}>
            <ForgeGlyph forge={forge?.forge ?? null} size={16} />
          </button>
        </Tooltip>
        <Tooltip label={t(copied ? 'reviewPage.copied' : 'reviewPage.copyLink')} side="bottom">
          <button type="button" className={css.iconButton} aria-label={t('reviewPage.copyLink')} onClick={copy}>
            {copied ? <IconCheckOutlineRegular size={16} className={css.copied} /> : <IconCopyOutlineRegular size={16} />}
          </button>
        </Tooltip>
        <Tooltip label={t('reviewPage.refresh')} side="bottom" align="end">
          <button type="button" className={css.iconButton} aria-label={t('reviewPage.refresh')} onClick={refresh}>
            <RefreshGlyph busy={refreshing} size={16} />
          </button>
        </Tooltip>
      </span>
      <span className={css.moreAction}>
        <Menu
          open={open}
          onClose={() => { setOpen(false) }}
          portal
          align="end"
          anchor={(
            <Tooltip label={t('reviewPage.more')} side="bottom">
              <button type="button" className={css.iconButton} aria-label={t('reviewPage.more')} aria-haspopup="menu" aria-expanded={open}
                onClick={() => { setOpen(!open) }}>
                <IconEllipsisOutlineRegular size={16} />
              </button>
            </Tooltip>
          )}
          items={items}
          onSelect={(id) => {
            setOpen(false)
            if (id === 'open') actions.openLink(url)
            else if (id === 'copy') copy()
            else refresh()
          }}
        />
      </span>
    </>
  )
}

/** The summary tab: the description and the activity beside the card rows. */
function Summary({
  frame, snapshot, description, readActivity, addComment, onOpenChanges, onOpenCommit, now, locale, actions, coarsePointer, t,
}: {
  readonly frame: ForgeReviewChangeRequest
  readonly snapshot: ChangeRequestSnapshot
  readonly description: ReturnType<typeof useDescription>
  readonly readActivity: ReviewDetailProps['readActivity']
  readonly addComment: ReviewDetailProps['addComment']
  readonly onOpenChanges: () => void
  readonly onOpenCommit: ReviewDetailProps['onOpenCommit']
  readonly now: number
  readonly locale: string
  readonly actions: ChangeRequestActions
  readonly coarsePointer: boolean
  readonly t: Translate
}): ReactNode {
  const labels = useMemo(() => ({
    code: {
      copyLabel: t('reviewPage.markdown.copy'),
      copiedLabel: t('reviewPage.markdown.copied'),
      toolbarLabels: { codeLabel: t('reviewPage.markdown.code'), wrapLabel: t('reviewPage.markdown.wrap'), unwrapLabel: t('reviewPage.markdown.unwrap') },
    },
    footnotes: t('reviewPage.markdown.footnotes'),
  }), [t])
  const read = description.description
  const markdown = useMemo(() => read === null ? null : descriptionMarkdown(read.body, read.images), [read])
  const name = t('change.number', { number: frame.ref.number })
  return (
    <div className={css.summary}>
      <div className={css.document}>
        <section aria-label={t('reviewPage.description')}>
          <h3 className={css.caption}>{t('reviewPage.description')}</h3>
          {markdown === null
            ? description.failure === null
              ? <DescriptionSkeleton />
              : (
                <div className={css.notice} role="status">
                  <span>{t('reviewPage.descriptionFailed', { message: description.failure })}</span>
                  <Button size="sm" variant="outline" onClick={description.retry}>{t('retry')}</Button>
                </div>
              )
            : markdown.trim() === ''
              ? <p className={css.muted}>{t('reviewPage.descriptionEmpty')}</p>
              : <MarkdownText text={markdown} labels={labels} omitHtml />}
        </section>
        {/* A submitted review or a new comment changes the activity, and each moves one of the two values. */}
        <ReviewActivity url={frame.url} revision={`${snapshot.updatedAt}\n${frame.reviewRevision}`} forge={frame.forge?.label ?? null}
          read={readActivity} comment={addComment} onOpenChanges={onOpenChanges} onOpenCommit={onOpenCommit} openLink={actions.openLink}
          now={now} markdown={labels} t={t} />
      </div>
      <aside className={css.facts} aria-label={t('reviewPage.status')}>
        <ReviewStatus frame={frame} snapshot={snapshot} name={name} now={now} actions={actions} locale={locale}
          coarsePointer={coarsePointer} t={t} />
      </aside>
    </div>
  )
}

/**
 * Render the detail of one change request.
 * @param props - the change request stream, the tab, actions, the pointer accuracy, and copy.
 * @returns the detail.
 */
export function ReviewDetail({
  url, read, tab, onTab, onOpenCommit, listHidden, onToggleList, onBack, now, locale, actions, readDescription, readActivity, addComment,
  onAddHost, renderChanges, renderChat, unseenQuotes, coarsePointer, t,
}: ReviewDetailProps): ReactNode {
  const frame = read.frame
  const snapshot = frame?.snapshot ?? null
  const description = useDescription(url, snapshot?.updatedAt ?? null, readDescription)
  const listToggle = (
    <>
      <button type="button" className={clsx(css.iconButton, css.backButton)} aria-label={t('reviewPage.back')} onClick={onBack}>
        <IconChevronLeftOutlineRegular size={16} />
      </button>
      <Tooltip label={t(listHidden ? 'reviewPage.showList' : 'reviewPage.hideList')} side="bottom">
        <button type="button" className={clsx(css.iconButton, css.listToggle)} aria-pressed={!listHidden}
          aria-label={t(listHidden ? 'reviewPage.showList' : 'reviewPage.hideList')} onClick={onToggleList}>
          <IconPanelLeftOutlineRegular size={16} />
        </button>
      </Tooltip>
    </>
  )
  const forge = frame?.forge ?? null
  if (frame === undefined || snapshot === null) {
    const failure = frame?.update !== undefined && frame.update !== null && 'failure' in frame.update ? frame.update.failure : undefined
    const stopped = read.stopped !== null
    const links = <LinkActions url={url} forge={forge} actions={actions} onRefresh={stopped ? read.retry : actions.retry} t={t} />
    if (!stopped && failure === undefined) {
      // Nothing is read yet: the layout of the detail in skeleton rows, with the actions that need only the URL.
      return (
        <div className={css.detail} data-forge-review-detail={url} aria-busy="true">
          <span className={css.visuallyHidden} role="status">{t('reviewPage.detailLoading')}</span>
          <header className={css.detailHeader}>
            <div className={css.detailBar}>
              {listToggle}
              <span className={clsx(loading.fill, css.skeletonChip)} aria-hidden="true" />
              <span className={clsx(loading.fill, css.skeletonRepository)} aria-hidden="true" />
              <span className={css.labelsSlot} />
              <span className={css.headerActions}>{links}</span>
            </div>
            <HeaderSkeleton />
          </header>
          <div className={css.panel}>
            <div className={css.summary}>
              <div className={css.document}>
                <section aria-label={t('reviewPage.description')}>
                  <h3 className={css.caption}>{t('reviewPage.description')}</h3>
                  <DescriptionSkeleton />
                </section>
                <section className={css.activity} aria-label={t('reviewPage.activity')}>
                  <h3 className={css.caption}>{t('reviewPage.activity')}</h3>
                  <ActivitySkeleton />
                </section>
              </div>
              <StatusSkeleton />
            </div>
          </div>
        </div>
      )
    }
    let body: ReactNode
    if (read.stopped?.code === 'forgePanel/unrecognized-url') {
      body = (
        <>
          <p className={css.emptyTitle}>{t('reviewPage.unrecognized')}</p>
          <p className={css.emptyHint}>{t('reviewPage.unrecognizedHint')}</p>
          {onAddHost !== undefined && (
            <div className={css.actions}><Button size="sm" variant="outline" onClick={onAddHost}>{t('reviewPage.addHost')}</Button></div>
          )}
        </>
      )
    } else {
      body = (
        <>
          <p className={css.emptyTitle}>{failure === undefined ? t('reviewPage.loadFailed') : t(FAILURE[failure.code])}</p>
          {failure !== undefined && failure.message !== '' && <p className={css.emptyHint}>{failure.message}</p>}
          <div className={css.actions}>
            <Button size="sm" variant="outline" onClick={() => { void (stopped ? read.retry : actions.retry)() }}>{t('retry')}</Button>
            <Button size="sm" variant="outline" onClick={() => { actions.openLink(url) }}>{openOnLabel(t, forge?.label ?? null)}</Button>
          </div>
        </>
      )
    }
    return (
      <div className={css.detail} data-forge-review-detail={url}>
        <div className={css.detailBar}>{listToggle}<span className={css.headerActions}>{links}</span></div>
        <div className={css.centered} role="status">{body}</div>
      </div>
    )
  }
  const tone = toneOf(snapshot)
  const { repository, number } = frame.ref
  const name = t('change.number', { number })
  const created = description.description === null ? undefined : formatAgo(description.description.createdAt, now, t)
  const updated = formatAgo(snapshot.updatedAt, now, t)
  const tabLabel = (value: ReviewTab): ReactNode => value === 'changes'
    ? <>{t('reviewPage.tab.changes')}<span className={css.added}>{`+${snapshot.additions.toLocaleString(locale)}`}</span>
      <span className={css.deleted}>{`−${snapshot.deletions.toLocaleString(locale)}`}</span></>
    : value === 'summary' ? t('reviewPage.tab.summary')
      : <>{t('reviewPage.tab.chat')}{unseenQuotes > 0 && (
        <span className={css.tabBadge} aria-label={t('reviewPage.chatQuotes', { count: unseenQuotes })}>{unseenQuotes}</span>
      )}</>
  return (
    <div className={css.detail} data-forge-review-detail={url}>
      <header className={css.detailHeader}>
        <div className={css.detailBar}>
          {listToggle}
          <span className={css.stateChip} data-tone={tone}>
            <ChangeRequestGlyph tone={tone} size={14} />
            {t(TONE_LABEL[tone])}
          </span>
          <a className={css.repository} href={snapshot.url} target="_blank" rel="noreferrer"
            onClick={(event) => { event.preventDefault(); actions.openLink(snapshot.url) }}>
            <span className={css.repositoryName}>{`${repository.owner}/${repository.name}`}</span>
            <span className={css.number}>{name}</span>
          </a>
          <span className={css.labelsSlot}>
            {description.description !== null && (
              <ReviewLabels labels={description.description.labels} truncated={description.description.labelsTruncated} t={t} />
            )}
          </span>
          <span className={css.headerActions}>
            {snapshot.state === 'open' && snapshot.draft
              ? <MarkReady frame={frame} actions={actions} t={t} />
              : (
                <ChangeRequestPrimary entry={frame} snapshot={snapshot} name={name} actions={actions} className={css.primary} blocked
                  t={t} />
              )}
            <LinkActions url={snapshot.url} forge={forge} actions={actions} onRefresh={actions.retry} t={t} />
          </span>
        </div>
        <h1 className={css.detailTitle}>{snapshot.title}</h1>
        <div className={css.detailMeta}>
          {snapshot.author !== null && <span>{snapshot.author}</span>}
          {created !== undefined && <><span aria-hidden="true">·</span><span>{t('reviewPage.created', { time: created })}</span></>}
          {updated !== undefined && <><span aria-hidden="true">·</span><span>{t('reviewPage.updated', { time: updated })}</span></>}
          <span aria-hidden="true">·</span>
          <span className={css.branches}>{`${snapshot.headBranch} → ${snapshot.baseBranch}`}</span>
        </div>
        <div className={css.tabs} role="tablist" aria-label={t('reviewPage.tabs')}>
          {TAB_ORDER.map(value => (
            <button key={value} type="button" role="tab" className={css.tab} aria-selected={tab === value} id={`forge-review-tab-${value}`}
              aria-controls="forge-review-panel" onClick={() => { onTab(value) }}>
              {tabLabel(value)}
            </button>
          ))}
        </div>
      </header>
      <div className={clsx(css.panel, tab !== 'summary' && css.panelFill)} role="tabpanel" id="forge-review-panel"
        aria-labelledby={`forge-review-tab-${tab}`}>
        {tab === 'summary' && (
          <Summary frame={frame} snapshot={snapshot} description={description} readActivity={readActivity} addComment={addComment}
            onOpenChanges={() => { onTab('changes') }} onOpenCommit={onOpenCommit} now={now} locale={locale} actions={actions}
            coarsePointer={coarsePointer} t={t} />
        )}
        <div className={css.changes} hidden={tab !== 'changes'}>{renderChanges(frame)}</div>
        {tab === 'chat' && renderChat(frame)}
      </div>
    </div>
  )
}
