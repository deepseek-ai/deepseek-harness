/**
 * The thread list of a change request beside its changes: every thread grouped by file in file tree order, narrowed
 * by whether it is resolved, each opening the place it shows at. A wide changes view docks the list beside the files;
 * a narrower one floats it over them, and the narrowest gives it their whole width.
 */

import { useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { IconChevronLeftOutlineRegular, IconCloseOutlineRegular, IconRightUpOutlineRegular, Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ForgeReviewThread } from '@deepseek-ai/dsh-experimental-forge/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { FileLabel } from './FileLabel.tsx'
import { SegmentedChoice } from './ReviewControls.tsx'
import { Avatar } from './ReviewThreads.tsx'
import { anchorRange, passesFilter, THREAD_FILTERS, type ThreadFilter, type ThreadPlace } from './review-threads.ts'
import type { NS } from './locales.ts'
import type { PlacedThread } from './thread-state.ts'
import css from './ThreadList.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** Props of the thread list. */
export interface ThreadListProps extends PropsLocale<typeof NS> {
  /** Every thread read, in host order, with where the current changes show it. */
  readonly entries: readonly PlacedThread[]
  /** Changed file paths in file tree order; threads on other paths follow them. */
  readonly order: readonly string[]
  /** Whether the host has more threads than were read. */
  readonly truncated: boolean
  /** Web page of the change request. */
  readonly url: string
  /** The active filter. */
  readonly filter: ThreadFilter
  /** Choose a filter. */
  readonly choose: (filter: ThreadFilter) => void
  /** File whose group the list scrolls to when it changes, or null. */
  readonly file: string | null
  /** Whether the reader just opened the list, so a list that covers the files takes the focus. */
  readonly claim: boolean
  /** Report that the list handled `claim`. */
  readonly claimed: () => void
  /** Open the place of a thread; `covering` says the list covers the files, so the owner closes it first. */
  readonly open: (entry: PlacedThread, covering: boolean) => void
  /** Open a URL outside the app. */
  readonly openLink: (url: string) => void
  /** Close the list at the reader's request. */
  readonly close: () => void
}

/** Sort key of a thread inside its file: file threads first, then by first line, outdated and elsewhere last. */
function rank(place: ThreadPlace): number {
  switch (place.kind) {
    case 'file': return -1
    case 'line': return place.startLine
    case 'outdated':
    case 'elsewhere': return Number.MAX_SAFE_INTEGER
    /* v8 ignore next -- closed ThreadPlace union exhaustiveness guard */
    default: return assertNever(place, 'ThreadPlace')
  }
}

function meta(thread: ForgeReviewThread, place: ThreadPlace, t: Translate): string {
  const replies = thread.comments.length - 1
  const parts: string[] = []
  if (thread.subject === 'file') parts.push(t('thread.fileLevel'))
  else if (place.kind === 'line') parts.push(anchorRange(place.side, place))
  else if (thread.original !== null) {
    parts.push(t('thread.originally', { range: anchorRange(thread.side, thread.original) }), t('thread.onCommit', { commit: thread.original.commit.slice(0, 7) }))
  }
  if (replies > 0) parts.push(t('thread.replies', { count: replies }))
  return parts.join(' · ')
}

/** Whether the list floats over the files or takes their width, which its narrow-view styles decide. */
function covers(pane: HTMLElement | null): pane is HTMLElement {
  return pane !== null && getComputedStyle(pane).position === 'absolute'
}

/**
 * The first comment as one line of plain text: without raw HTML, strong, strikethrough, and code marks, quote or
 * heading marks, and link targets.
 */
function plainExcerpt(body: string): string {
  return body.replace(/<[^>]*>/g, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*(?:#{1,6}|>)\s*/gm, '')
    .replace(/\*\*|__|~~|`/g, '').replace(/\s+/g, ' ').trim()
}

function Item({ entry, open, t }: {
  readonly entry: PlacedThread
  readonly open: (entry: PlacedThread) => void
  readonly t: Translate
}): ReactNode {
  const { thread, place } = entry
  const first = thread.comments[0]
  return <button type="button" className={css.item} data-forge-thread-item={thread.id} onClick={() => { open(entry) }}>
    <Avatar author={first?.author ?? null} size={22} />
    <span className={css.itemMain}>
      <span className={css.meta}>{meta(thread, place, t)}</span>
      <span className={css.excerpt}>{plainExcerpt(first?.body ?? '')}</span>
      <span className={css.tags}>
        {place.kind === 'outdated' && <Tag tone="warning">{t('thread.outdatedTag')}</Tag>}
        {place.kind === 'elsewhere' && <Tag tone="neutral">{t('thread.elsewhereTag')}</Tag>}
        {thread.resolved && <Tag tone="success">{t('thread.filter.resolved')}</Tag>}
        {first?.author?.bot === true && <Tag tone="outline">{t('thread.bot')}</Tag>}
      </span>
    </span>
  </button>
}

/**
 * Render the thread list.
 * @param props - threads, their places, the file order, the filter, and the list's actions.
 * @returns the list pane and the scrim behind it where it floats over the files.
 */
export function ThreadList(props: ThreadListProps): ReactNode {
  const { entries, order, filter, t } = props
  const threads = useMemo(() => entries.map(entry => entry.thread), [entries])
  const counts = useMemo(() => Object.fromEntries(THREAD_FILTERS.map(item => [item,
    threads.filter(thread => passesFilter(thread, item)).length])) as Record<ThreadFilter, number>, [threads])
  const groups = useMemo(() => {
    const position = new Map(order.map((path, index) => [path, index]))
    const byPath = new Map<string, PlacedThread[]>()
    for (const entry of entries) {
      if (!passesFilter(entry.thread, filter)) continue
      const list = byPath.get(entry.thread.path)
      if (list === undefined) byPath.set(entry.thread.path, [entry])
      else list.push(entry)
    }
    return [...byPath].sort(([a], [b]) => (position.get(a) ?? order.length) - (position.get(b) ?? order.length) || a.localeCompare(b))
      .map(([path, list]) => [path, list.toSorted((a, b) => rank(a.place) - rank(b.place))] as const)
  }, [entries, order, filter])
  const pane = useRef<HTMLElement>(null)
  const rows = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const container = rows.current
    /* v8 ignore next -- the ref is attached before layout effects run. */
    if (props.file === null || container === null) return
    for (const group of container.querySelectorAll<HTMLElement>('[data-forge-thread-group]')) {
      if (group.dataset.forgeThreadGroup === props.file) group.scrollIntoView({ block: 'start' })
    }
  }, [props.file])
  useLayoutEffect(() => {
    if (!props.claim) return
    props.claimed()
    if (covers(pane.current)) pane.current.focus({ preventScroll: true })
  }, [props.claim])
  const escape = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    props.close()
  }
  const open = (entry: PlacedThread): void => { props.open(entry, covers(pane.current)) }
  return <>
    <div className={css.scrim} aria-hidden="true" onClick={props.close} />
    <aside ref={pane} className={css.pane} tabIndex={-1} aria-label={t('thread.listAria', { count: threads.length })} data-forge-thread-list=""
      onKeyDown={escape}>
      <div className={css.header}>
        <button type="button" className={css.back} onClick={props.close}><IconChevronLeftOutlineRegular size={14} />{t('thread.back')}</button>
        <span className={css.title}>{t('thread.list')}</span>
        <span className={css.total}>{threads.length}</span>
        <span className={css.spacer} />
        <Tooltip label={t('thread.close')} side="bottom">
          <button type="button" className={css.close} aria-label={t('thread.close')} onClick={props.close}><IconCloseOutlineRegular size={14} /></button>
        </Tooltip>
      </div>
      <div className={css.filters}>
        <SegmentedChoice label={t('thread.filterAria')} value={filter} choose={props.choose}
          segments={THREAD_FILTERS.map(item => ({ value: item, label: t(`thread.filter.${item}`), count: counts[item], disabledTip: null }))} />
      </div>
      <div ref={rows} className={css.rows}>
        {threads.length === 0 ? <div className={css.note}>{t('thread.empty')}</div>
          : groups.length === 0 ? <div className={css.note}>{t('thread.none')}</div>
            : groups.map(([path, list]) => <section key={path} className={css.group} data-forge-thread-group={path}>
              <h3 className={css.path}><FileLabel path={path} /></h3>
              {list.map(entry => <Item key={entry.thread.id} entry={entry} open={open} t={t} />)}
            </section>)}
      </div>
      <div className={css.footer}>
        {props.truncated && <>{t('thread.truncated', { count: threads.length })}{' · '}</>}
        <button type="button" className={css.link} onClick={() => { props.openLink(props.url) }}>
          <IconRightUpOutlineRegular size={14} />{t('thread.openAll')}
        </button>
      </div>
    </aside>
  </>
}
