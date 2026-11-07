/**
 * The thread list of a change request beside its changes: every thread grouped by file in file tree order, narrowed
 * by one filter, each opening the place it shows at.
 */

import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { IconCloseOutlineRegular, Pill, Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ForgeReviewThread } from '@deepseek-ai/dsh-experimental-forge/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { Avatar } from './ReviewThreads.tsx'
import { anchorRange, awaitsViewer, passesFilter, THREAD_FILTERS, type ThreadFilter, type ThreadPlace } from './review-threads.ts'
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
  /** Login of the signed-in user. */
  readonly viewer: string | null
  /** Whether the host has more threads than were read. */
  readonly truncated: boolean
  /** Host name the threads were read from, such as `github.com`. */
  readonly host: string
  /** Web page of the change request. */
  readonly url: string
  /** The active filter, or null for every thread. */
  readonly filter: ThreadFilter | null
  /** Choose a filter, or null for every thread. */
  readonly choose: (filter: ThreadFilter | null) => void
  /** File whose group the list scrolls to when it changes, or null. */
  readonly file: string | null
  /** Open the place of a thread. */
  readonly open: (entry: PlacedThread) => void
  /** Open a URL outside the app. */
  readonly openLink: (url: string) => void
  /** Close the list. */
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

/**
 * The first comment as one line of plain text: without raw HTML, strong, strikethrough, and code marks, quote or
 * heading marks, and link targets.
 */
function plainExcerpt(body: string): string {
  return body.replace(/<[^>]*>/g, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*(?:#{1,6}|>)\s*/gm, '')
    .replace(/\*\*|__|~~|`/g, '').replace(/\s+/g, ' ').trim()
}

function Item({ entry, viewer, open, t }: {
  readonly entry: PlacedThread
  readonly viewer: string | null
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
        {awaitsViewer(thread, viewer) && <Tag tone="info">{t('thread.filter.mine')}</Tag>}
        {first?.author?.bot === true && <Tag tone="outline">{t('thread.bot')}</Tag>}
      </span>
    </span>
  </button>
}

/**
 * Render the thread list.
 * @param props - threads, their places, the file order, the filter, and the list's actions.
 * @returns the list pane.
 */
export function ThreadList(props: ThreadListProps): ReactNode {
  const { entries, order, viewer, filter, t } = props
  const threads = useMemo(() => entries.map(entry => entry.thread), [entries])
  const counts = useMemo(() => Object.fromEntries(THREAD_FILTERS.map(item => [item,
    threads.filter(thread => passesFilter(thread, item, viewer)).length])) as Record<ThreadFilter, number>, [threads, viewer])
  const groups = useMemo(() => {
    const position = new Map(order.map((path, index) => [path, index]))
    const byPath = new Map<string, PlacedThread[]>()
    for (const entry of entries) {
      if (!passesFilter(entry.thread, filter, viewer)) continue
      const list = byPath.get(entry.thread.path)
      if (list === undefined) byPath.set(entry.thread.path, [entry])
      else list.push(entry)
    }
    return [...byPath].sort(([a], [b]) => (position.get(a) ?? order.length) - (position.get(b) ?? order.length) || a.localeCompare(b))
      .map(([path, list]) => [path, list.toSorted((a, b) => rank(a.place) - rank(b.place))] as const)
  }, [entries, order, filter, viewer])
  const rows = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const container = rows.current
    /* v8 ignore next -- the ref is attached before layout effects run. */
    if (props.file === null || container === null) return
    for (const group of container.querySelectorAll<HTMLElement>('[data-forge-thread-group]')) {
      if (group.dataset.forgeThreadGroup === props.file) group.scrollIntoView({ block: 'start' })
    }
  }, [props.file])
  return <aside className={css.pane} aria-label={t('thread.listAria', { count: threads.length })} data-forge-thread-list="">
    <div className={css.header}>
      <span className={css.title}>{t('thread.list')}</span>
      <span className={css.total}>{threads.length}</span>
      <span className={css.spacer} />
      <Tooltip label={t('thread.close')} side="bottom">
        <button type="button" className={css.close} aria-label={t('thread.close')} onClick={props.close}><IconCloseOutlineRegular size={14} /></button>
      </Tooltip>
    </div>
    <div className={css.filters} role="group" aria-label={t('thread.filterAria')}>
      {THREAD_FILTERS.map(item => <Pill key={item} active={filter === item} aria-pressed={filter === item}
        onClick={() => { props.choose(filter === item ? null : item) }}>
        {t(`thread.filter.${item}`)} {counts[item]}
      </Pill>)}
    </div>
    <div ref={rows} className={css.rows}>
      {threads.length === 0 ? <div className={css.note}>{t('thread.empty')}</div>
        : groups.length === 0 ? <div className={css.note}>{t('thread.none')}</div>
          : groups.map(([path, list]) => <section key={path} className={css.group} data-forge-thread-group={path}>
            <h3 className={css.path} title={path}>{path.slice(path.lastIndexOf('/') + 1)}</h3>
            {list.map(entry => <Item key={entry.thread.id} entry={entry} viewer={viewer} open={props.open} t={t} />)}
          </section>)}
    </div>
    <div className={css.footer}>
      {props.truncated ? t('thread.truncated', { count: threads.length }) : t('thread.total', { count: threads.length, host: props.host })}
      {' · '}<button type="button" className={css.link} onClick={() => { props.openLink(props.url) }}>{t('thread.openAll')}</button>
    </div>
  </aside>
}
