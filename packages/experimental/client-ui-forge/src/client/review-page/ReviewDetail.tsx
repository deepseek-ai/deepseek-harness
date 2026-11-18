/**
 * The review page's detail of one change request: its header with state, repository, labels, title, author, times, and
 * branches; the ready-or-merge and more actions; and the summary, changes, and chat tabs. The summary shows the
 * description beside the status column.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronLeftOutlineRegular, IconEllipsisOutlineRegular, IconPanelLeftOutlineRegular, MarkdownText, Menu,
  StateDot, Tooltip, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChangeRequestDescription, ChangeRequestSnapshot, ForgeFailure } from '@deepseek-ai/dsh-experimental-forge/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ForgeReviewChangeRequest } from '../../types.ts'
import { ChangeRequestPrimary, type ChangeRequestActions } from '../ChangeRequestCard.tsx'
import { formatAgo } from '../format.ts'
import { ChangeRequestGlyph } from '../glyphs.tsx'
import type { StreamRead } from './host-stream.ts'
import type { ForgePanelKey, NS } from '../locales.ts'
import { descriptionMarkdown } from './review-lists.ts'
import type { ReviewTab } from './review-store.ts'
import { ReviewLabels } from './ReviewLabels.tsx'
import { ReviewStatus } from './ReviewStatus.tsx'
import { TONE_LABEL, toneOf } from '../status.ts'
import css from './ReviewPage.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** How long before signed image addresses expire the description is read again, in milliseconds. */
const IMAGE_RENEWAL_MS = 30_000

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

/** Props of the detail. */
export interface ReviewDetailProps {
  /** URL of the change request. */
  readonly url: string
  /** The change request stream. */
  readonly read: StreamRead<ForgeReviewChangeRequest>
  /** Shown tab. */
  readonly tab: ReviewTab
  /** Show a tab. */
  readonly onTab: (tab: ReviewTab) => void
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
  /** Read the description and labels. */
  readonly readDescription: (url: string, signal: AbortSignal) => Promise<RemoteResult<ChangeRequestDescription>>
  /** The changes tab's content, kept while the detail shows so pending review comments survive tab switches. */
  readonly renderChanges: (frame: ForgeReviewChangeRequest) => ReactNode
  /** The chat tab's content. */
  readonly renderChat: (frame: ForgeReviewChangeRequest) => ReactNode
  /** Quotes added to the conversation while the chat tab was not shown. */
  readonly unseenQuotes: number
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

/** The more-actions menu: open in the browser, copy the link, and read the status again. */
function MoreMenu({ url, actions, t }: { readonly url: string; readonly actions: ChangeRequestActions; readonly t: Translate }): ReactNode {
  const [open, setOpen] = useState(false)
  const items: MenuEntry[] = [
    { id: 'open', label: t('change.view') },
    { id: 'copy', label: t('change.copy') },
    { id: 'refresh', label: t('reviewPage.refresh') },
  ]
  return (
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
        else if (id === 'copy') actions.copyLink(url)
        else actions.retry()
      }}
    />
  )
}

/** The summary tab: the description beside the card rows. */
function Summary({ frame, snapshot, description, now, locale, actions, t }: {
  readonly frame: ForgeReviewChangeRequest
  readonly snapshot: ChangeRequestSnapshot
  readonly description: ReturnType<typeof useDescription>
  readonly now: number
  readonly locale: string
  readonly actions: ChangeRequestActions
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
      <section className={css.document} aria-label={t('reviewPage.description')}>
        <h3 className={css.caption}>{t('reviewPage.description')}</h3>
        {markdown === null
          ? description.failure === null
            ? <StateDot state="ongoing" />
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
      <aside className={css.facts} aria-label={t('reviewPage.status')}>
        <ReviewStatus frame={frame} snapshot={snapshot} name={name} now={now} actions={actions} locale={locale} t={t} />
      </aside>
    </div>
  )
}

/**
 * Render the detail of one change request.
 * @param props - the change request stream, the tab, actions, and copy.
 * @returns the detail.
 */
export function ReviewDetail({
  url, read, tab, onTab, listHidden, onToggleList, onBack, now, locale, actions, readDescription, renderChanges, renderChat, unseenQuotes,
  t,
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
  if (frame === undefined || snapshot === null) {
    const failure = frame?.update !== undefined && frame.update !== null && 'failure' in frame.update ? frame.update.failure : undefined
    let body: ReactNode = <StateDot state="ongoing" />
    if (read.stopped?.code === 'forgePanel/unrecognized-url') {
      body = <><p className={css.emptyTitle}>{t('reviewPage.unrecognized')}</p><p className={css.emptyHint}>{t('reviewPage.unrecognizedHint')}</p></>
    } else if (read.stopped !== null || failure !== undefined) {
      body = (
        <>
          <p className={css.emptyTitle}>{failure === undefined ? t('reviewPage.loadFailed') : t(FAILURE[failure.code])}</p>
          {failure !== undefined && failure.message !== '' && <p className={css.emptyHint}>{failure.message}</p>}
          <div className={css.actions}>
            <Button size="sm" variant="outline" onClick={read.stopped === null ? actions.retry : read.retry}>{t('retry')}</Button>
            <Button size="sm" variant="outline" onClick={() => { actions.openLink(url) }}>{t('change.view')}</Button>
          </div>
        </>
      )
    }
    return (
      <div className={css.detail} data-forge-review-detail={url}>
        <div className={css.detailBar}>{listToggle}</div>
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
            {`${repository.owner}/${repository.name}`}<span className={css.number}>{name}</span>
          </a>
          <span className={css.labelsSlot}>
            {description.description !== null && (
              <ReviewLabels labels={description.description.labels} truncated={description.description.labelsTruncated} t={t} />
            )}
          </span>
          <span className={css.headerActions}>
            {snapshot.state === 'open' && snapshot.draft
              ? <MarkReady frame={frame} actions={actions} t={t} />
              : <ChangeRequestPrimary entry={frame} snapshot={snapshot} name={name} actions={actions} className={css.primary} t={t} />}
            <MoreMenu url={snapshot.url} actions={actions} t={t} />
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
          <Summary frame={frame} snapshot={snapshot} description={description} now={now} locale={locale} actions={actions} t={t} />
        )}
        <div className={css.changes} hidden={tab !== 'changes'}>{renderChanges(frame)}</div>
        {tab === 'chat' && renderChat(frame)}
      </div>
    </div>
  )
}
