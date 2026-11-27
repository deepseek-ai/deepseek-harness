/**
 * The review page's list column: the search box that also opens a pasted change request link, the filter of hosts and
 * repositories, one foldable section per list with its items and empty state, and one notice per host that could not be read.
 */

import { useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, HoverCard, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconFlatListOutlineRegular, IconFolderCloseRegular,
  IconLayersOutlineRegular, IconSearchOutlineRegular, IconSlidersTwoOutlineRegular, IconUserOutlineRegular, IconUsersOutlineRegular,
  Input, MarqueeText, Menu, Tooltip, useHoverMarquee, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots/client'
import { TextSearchIndex } from '@deepseek-ai/dsh-util-text-search'
import type { ChecksRollup, ForgeViewerFilter } from '@deepseek-ai/dsh-experimental-forge/types'
import type { ForgeReviewFrame } from '../../types.ts'
import { formatAgo, formatShortAgo } from '../format.ts'
import { ChangeRequestGlyph } from '../glyphs.tsx'
import type { ForgePanelKey, NS } from '../locales.ts'
import { RefreshGlyph } from '../RefreshGlyph.tsx'
import {
  mergeRepositories, pastedUrl, reviewFailures, reviewHint, reviewRepositories, reviewSearchKeys, reviewSections, sameScope,
  scopeRepository, summaryTone, type ReviewHostFailure, type ReviewItem, type ReviewRepository, type ReviewScope, type ReviewSection,
} from './review-lists.ts'
import type { ReviewView } from './review-store.ts'
import loading from '../ChangesLoading.module.css'
import css from './ReviewPage.module.css'

type Translate = PropsLocale<typeof NS>['t']

const SECTION: Record<ForgeViewerFilter, ForgePanelKey> = {
  'review-requested': 'reviewPage.section.reviewRequested',
  'authored': 'reviewPage.section.authored',
  'involved': 'reviewPage.section.involved',
}

/** Props of the list column. */
export interface ReviewListProps {
  /** The latest list frame, or undefined before the first. */
  readonly frame: ForgeReviewFrame | undefined
  /** Why the list stream stopped, or null while it runs. */
  readonly stopped: { readonly code: string; readonly message: string } | null
  /** URL of the change request shown in full, or null. */
  readonly selected: string | null
  /** Search text. */
  readonly query: string
  /** The host or repository the lists are narrowed to, or null for every repository of every host. */
  readonly scope: ReviewScope | null
  /** Whether the review-requested list leaves out requests made only of the user's teams. */
  readonly directOnly: boolean
  /** Folded sections. */
  readonly folded: Partial<Record<ForgeViewerFilter, boolean>>
  /** Whether a refresh the reader asked for is in flight. */
  readonly refreshing: boolean
  /** Current epoch milliseconds for relative times. */
  readonly now: number
  /** Show a change request in full. */
  readonly onSelect: (url: string) => void
  /** Change the search text. */
  readonly onSearch: (query: string) => void
  /** Repositories the lists named while read in every repository, offered whatever repository the lists are read in now. */
  readonly repositories: readonly ReviewRepository[]
  /** Narrow the lists to one host or one repository, or to nothing. */
  readonly onScope: (scope: ReviewScope | null) => void
  /** Toggle whether the review-requested list leaves out team requests. */
  readonly onToggleDirect: () => void
  /** How list items show: two lines each, or one line each with the rest on hover. */
  readonly view: ReviewView
  /** Choose how list items show. */
  readonly onView: (view: ReviewView) => void
  /** Fold or unfold a section. */
  readonly onFold: (filter: ForgeViewerFilter) => void
  /** Read every list again. */
  readonly onRefresh: () => void
  /** Open the list stream again after it stopped. */
  readonly onRetry: () => void
  /** Copy text and report the outcome. */
  readonly copyText: (text: string) => void
  /** Open the page where the providers' hosts and sign-in states are, or undefined while it cannot be opened. */
  readonly onOpenSettings: (() => void) | undefined
  /** Forge panel copy. */
  readonly t: Translate
}

/**
 * A submenu row's label with the tick a chosen row shows, since a submenu does not mark its own choice.
 * @param text - the row's text.
 * @param chosen - whether the row is the current choice.
 * @param nested - whether the row is a repository below the row of its host.
 * @returns the label.
 */
function chosenLabel(text: string, chosen: boolean, nested = false): ReactNode {
  return (
    <span className={css.menuRow} data-chosen={chosen ? '' : undefined}>
      <span className={nested ? css.menuNested : undefined}>{text}</span>
      {chosen && <IconCheckOutlineRegular size={14} className={css.menuCheck} />}
    </span>
  )
}

/**
 * The view menu, laid out like the Session list's: the list view, the host or repository the lists are narrowed to, and
 * whether team requests show. Once the lists name repositories on more than one host, each host is a choice with its
 * repositories below it.
 */
function FilterMenu({ frame, scope, repositories, directOnly, view, onScope, onToggleDirect, onView, t }: Pick<ReviewListProps,
  'frame' | 'scope' | 'repositories' | 'directOnly' | 'view' | 'onScope' | 'onToggleDirect' | 'onView' | 't'>): ReactNode {
  const [open, setOpen] = useState(false)
  const repository = scopeRepository(scope)
  // Lists read in one repository name only that one, so the menu offers the repositories remembered from the lists of
  // every repository, with those the shown lists name and the chosen one, which stays offered while its lists are empty.
  const offered = mergeRepositories(repositories, reviewRepositories(frame), repository === null ? [] : [repository])
  const hosts = [...new Set(offered.map(item => item.host))]
  // Before any list of every repository was read, the offer is still growing.
  const reading = repositories.length === 0 && (frame === undefined || frame.reading)
  // A row's id is its place among the choices, which the selection reads back.
  const choices: ReviewScope[] = []
  const choice = (value: ReviewScope, text: string, nested: boolean): MenuEntry =>
    ({ id: `scope:${choices.push(value) - 1}`, label: chosenLabel(text, sameScope(value, scope), nested) })
  const all = t('reviewPage.filter.allRepositories')
  const items: MenuEntry[] = [
    { type: 'label', id: 'view', text: t('reviewPage.filter.view') },
    { id: 'view:detailed', label: t('reviewPage.filter.detailed'), icon: <IconLayersOutlineRegular /> },
    { id: 'view:compact', label: t('reviewPage.filter.compact'), icon: <IconFlatListOutlineRegular /> },
    { type: 'separator', id: 'repository-separator' },
    { type: 'label', id: 'repository-label', text: t('reviewPage.filter.repository') },
    {
      id: 'repository',
      icon: <IconFolderCloseRegular />,
      label: (
        <span className={css.menuRow}>
          <span>{t('reviewPage.filter.repository')}</span>
          <span className={css.menuValue}>{scope === null ? all : repository === null ? scope.host : `${repository.owner}/${repository.name}`}</span>
        </span>
      ),
      submenu: [
        { id: 'scope:', label: chosenLabel(all, scope === null) },
        { type: 'separator', id: 'repo-separator' },
        ...hosts.flatMap(host => [
          ...hosts.length > 1 ? [choice({ host }, host, false)] : [],
          ...offered.filter(item => item.host === host).map(item => choice(item, `${item.owner}/${item.name}`, hosts.length > 1)),
        ]),
        ...reading ? [{ type: 'label' as const, id: 'repo-reading', text: t('reviewPage.loading') }] : [],
      ],
    },
    { type: 'separator', id: 'requests-separator' },
    { type: 'label', id: 'requests', text: t('reviewPage.filter.requests') },
    { id: 'requests:all', label: t('reviewPage.filter.teamRequests'), icon: <IconUsersOutlineRegular /> },
    { id: 'requests:direct', label: t('reviewPage.filter.directOnly'), icon: <IconUserOutlineRegular /> },
  ]
  const active = scope !== null || directOnly
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      portal
      dense
      align="end"
      submenuBackLabel={t('reviewPage.filter.back')}
      anchor={(
        <Tooltip label={t('reviewPage.filter')} side="bottom">
          <button type="button" className={clsx(css.iconButton, active && css.iconButtonActive)} aria-label={t('reviewPage.filter')}
            aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open) }}>
            <IconSlidersTwoOutlineRegular size={16} />
          </button>
        </Tooltip>
      )}
      items={items}
      selectedIds={[`view:${view}`, directOnly ? 'requests:direct' : 'requests:all']}
      onSelect={(id) => {
        setOpen(false)
        if (id === 'view:detailed' || id === 'view:compact') onView(id === 'view:compact' ? 'compact' : 'detailed')
        else if (id === 'requests:all' || id === 'requests:direct') {
          if ((id === 'requests:direct') !== directOnly) onToggleDirect()
        } else {
          // Menu never selects a submenu parent, so every remaining row is a `scope:` row.
          onScope(choices[Number(id.slice('scope:'.length) || NaN)] ?? null)
        }
      }}
    />
  )
}

/** Props of one list item, in either view. */
interface ItemProps {
  readonly item: ReviewItem
  /** The list the item shows in, which picks its hint. */
  readonly filter: ForgeViewerFilter
  readonly selected: boolean
  /** Whether the item names its repository, because the lists span more than one. */
  readonly qualified: boolean
  /** Whether the item's hover card names its host, because the lists span more than one. */
  readonly hosted: boolean
  readonly now: number
  readonly onSelect: (url: string) => void
  readonly t: Translate
}

/**
 * What the hover card of a compact item shows: the full title, the host where the lists span several, and every fact the
 * detailed item names.
 */
function CompactDetails({ item, filter, qualified, hosted, now, t }: Pick<ItemProps, 'item' | 'filter' | 'qualified' | 'hosted' | 'now' | 't'>): ReactNode {
  const { summary } = item
  const { repository, number } = summary.ref
  const hint = reviewHint(summary, filter)
  const ago = formatAgo(summary.updatedAt, now, t)
  return (
    <span className={css.compactCard}>
      <span className={css.compactCardTitle}>{summary.title}</span>
      <span className={css.cardMeta}>
        {hosted && <><span>{item.host}</span><span aria-hidden="true">·</span></>}
        <span>{qualified ? `${repository.owner}/${repository.name}#${number}` : t('change.number', { number })}</span>
        {summary.author !== null && <><span aria-hidden="true">·</span><span className={css.ellipsis}>{summary.author.login}</span></>}
        {ago !== undefined && <><span aria-hidden="true">·</span><span>{ago}</span></>}
      </span>
      {hint !== undefined && <span className={css.itemHint} data-tone={hint.tone}>{t(hint.key, hint.params)}</span>}
    </span>
  )
}

/** One listed change request on one line: its glyph, its title, which marquees while hovered, and its update time. */
function CompactItem({ item, filter, selected, qualified, hosted, now, onSelect, t }: ItemProps): ReactNode {
  const { summary } = item
  const title = useRef<HTMLSpanElement>(null)
  const marquee = useHoverMarquee(title)
  const checks: Exclude<ChecksRollup, 'none'> | undefined = summary.checksRollup === 'none' ? undefined : summary.checksRollup
  const time = formatShortAgo(summary.updatedAt, now, t)
  return (
    <li>
      <HoverCard
        grouped
        openDelayMs={800}
        copyText={summary.title}
        copyLabel={t('reviewPage.copyTitle')}
        copiedLabel={t('toast.copied')}
        content={<CompactDetails item={item} filter={filter} qualified={qualified} hosted={hosted} now={now} t={t} />}
        anchor={(
          <button type="button" className={css.compactItem} aria-current={selected ? 'true' : undefined} data-forge-review-item={summary.url}
            onPointerEnter={marquee.onPointerEnter} onPointerLeave={marquee.onPointerLeave} onClick={() => { onSelect(summary.url) }}>
            <span className={css.compactGlyph}><ChangeRequestGlyph tone={summaryTone(summary)} checks={checks} size={16} /></span>
            <MarqueeText ref={title} className={css.compactTitle}>{summary.title}</MarqueeText>
            {time !== undefined && <span className={css.compactTime}>{time}</span>}
          </button>
        )}
      />
    </li>
  )
}

/**
 * One listed change request: its title on at most two lines, then its small text on at most two. The small text names
 * the repository where the lists span several, the number, and the author, with the update time at the end of that
 * line; the hint follows the author where both fit, and takes the second line where they do not.
 */
function Item({ item, filter, selected, qualified, now, onSelect, t }: ItemProps): ReactNode {
  const { summary } = item
  const { repository, number } = summary.ref
  const hint = reviewHint(summary, filter)
  const time = formatShortAgo(summary.updatedAt, now, t)
  const checks: Exclude<ChecksRollup, 'none'> | undefined = summary.checksRollup === 'none' ? undefined : summary.checksRollup
  return (
    <li>
      <button type="button" className={css.item} aria-current={selected ? 'true' : undefined} data-forge-review-item={summary.url}
        onClick={() => { onSelect(summary.url) }}>
        <span className={css.itemGlyph}><ChangeRequestGlyph tone={summaryTone(summary)} checks={checks} size={16} /></span>
        <span className={css.itemText}>
          <span className={css.itemTitle}>{summary.title}</span>
          <span className={css.itemMeta}>
            <span className={css.itemFacts}>
              <span className={css.itemLine}>
                <span className={css.itemName}>
                  {qualified && <span className={css.itemRepository}>{repository.name}</span>}
                  <span className={css.itemNumber}>{t('change.number', { number })}</span>
                </span>
                {summary.author !== null && <><span aria-hidden="true">·</span><span className={css.itemAuthor}>{summary.author.login}</span></>}
              </span>
              {hint !== undefined && <span className={css.itemHint} data-tone={hint.tone}>{t(hint.key, hint.params)}</span>}
            </span>
            {time !== undefined && <span className={css.itemTime}>{time}</span>}
          </span>
        </span>
      </button>
    </li>
  )
}

/**
 * One notice per host whose lists could not be read: what failed, the sign-in command for a host that needs sign-in
 * when its provider names one, and the way to the providers' settings while that page can be opened.
 */
function HostFailures({ failures, copyText, onOpenSettings, t }: {
  readonly failures: readonly ReviewHostFailure[]
  readonly copyText: (text: string) => void
  readonly onOpenSettings: (() => void) | undefined
  readonly t: Translate
}): ReactNode {
  if (failures.length === 0) return null
  return (
    <div className={css.notices}>
      {failures.map(({ forge, host, failure, signIn }) => {
        const command = failure.code === 'unauthenticated' ? signIn : null
        return (
          <div key={`${forge} ${host}`} className={css.notice} role="status" data-forge-review-failure={host}>
            <span>
              {failure.code === 'unauthenticated' ? t('reviewPage.signIn', { host })
                : t('reviewPage.listFailed', { host, message: failure.code === 'rate-limited' ? t('change.failure.rateLimited') : failure.message })}
            </span>
            {command !== null && <span className={css.noticeCommand}><code>{command}</code></span>}
            {(command !== null || onOpenSettings !== undefined) && (
              <span className={css.noticeActions}>
                {command !== null && <Button size="sm" variant="outline" onClick={() => { copyText(command) }}>{t('signin.copy')}</Button>}
                {onOpenSettings !== undefined && <Button size="sm" variant="outline" onClick={onOpenSettings}>{t('reviewPage.hostSettings')}</Button>}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Bar widths of the skeleton rows, in percent of a row's text column: the title's first line, its second line or 0
 * for a one-line title, and the meta line.
 */
const SKELETON_ROWS = [
  { title: 94, wrapped: 46, meta: 38 },
  { title: 82, wrapped: 0, meta: 45 },
  { title: 97, wrapped: 63, meta: 33 },
  { title: 71, wrapped: 0, meta: 41 },
  { title: 90, wrapped: 35, meta: 48 },
  { title: 86, wrapped: 57, meta: 36 },
] as const

/**
 * Listed change requests drawn as skeletons while a list is read, laid out as the rows of the reader's view. They
 * carry no text and are hidden from assistive technology; the caller marks the busy region.
 */
function SkeletonItems({ view, count }: { readonly view: ReviewView; readonly count: number }): ReactNode {
  return (
    <div aria-hidden="true" data-forge-review-skeleton={view}>
      {SKELETON_ROWS.slice(0, count).map((row, index) => view === 'compact'
        ? (
          <div key={index} className={css.skeletonCompact}>
            <span className={clsx(loading.fill, css.skeletonGlyph)} />
            <span className={css.skeletonText}>
              <span className={clsx(loading.fill, css.skeletonBar)} style={{ width: `${row.title}%` }} />
            </span>
            <span className={clsx(loading.fill, css.skeletonTime)} />
          </div>
        )
        : (
          <div key={index} className={css.skeletonItem}>
            <span className={clsx(loading.fill, css.skeletonGlyph)} />
            <span className={css.skeletonText}>
              <span className={clsx(loading.fill, css.skeletonBar)} style={{ width: `${row.title}%` }} />
              {row.wrapped > 0 && <span className={clsx(loading.fill, css.skeletonBar)} style={{ width: `${row.wrapped}%` }} />}
              <span className={clsx(loading.fill, css.skeletonBar, css.skeletonMeta)} style={{ width: `${row.meta}%` }} />
            </span>
          </div>
        ))}
    </div>
  )
}

/**
 * Render the list column.
 * @param props - the latest frame, the reader's choices, and their handlers.
 * @returns the column.
 */
export function ReviewList(props: ReviewListProps): ReactNode {
  const { frame, stopped, selected, query, folded, refreshing, now, view, scope } = props
  const { onSelect, onSearch, onFold, onRefresh, onRetry, copyText, onOpenSettings, t } = props
  const { directOnly } = props
  const host = scope?.host ?? null
  // Each section with its search index, rebuilt when the lists change; a blank search returns a list as built.
  const sections = useMemo(() => reviewSections(frame, directOnly, host).map(section =>
    ({ section, index: new TextSearchIndex(section.items ?? [], reviewSearchKeys) })), [frame, directOnly, host])
  const failures = useMemo(() => reviewFailures(frame, host), [frame, host])
  const pasted = pastedUrl(query)
  const named = reviewRepositories(frame).filter(item => host === null || item.host === host)
  const qualified = named.length > 1
  const hosted = new Set(named.map(item => item.host)).size > 1
  let body: ReactNode
  if (stopped !== null && frame === undefined) {
    body = (
      <div className={css.centered} role="status">
        <span>{t('reviewPage.streamFailed')}</span>
        <Button size="sm" variant="outline" onClick={onRetry}>{t('retry')}</Button>
      </div>
    )
  } else if (frame === undefined) {
    body = (
      <div aria-busy="true" aria-label={t('reviewPage.loading')}>
        <div className={css.skeletonHeader} aria-hidden="true"><span className={clsx(loading.fill, css.skeletonHeading)} /></div>
        <SkeletonItems view={view} count={SKELETON_ROWS.length} />
      </div>
    )
  } else if (sections.length === 0) {
    body = (
      <div className={css.empty}>
        <p className={css.emptyTitle}>{t('reviewPage.noHosts')}</p>
        <p className={css.emptyHint}>{t('reviewPage.noHostsHint')}</p>
      </div>
    )
  } else {
    // A host whose first read of a list is still running: its rows are to come, so the count and the empty text wait.
    const awaits = (section: ReviewSection): boolean => section.pending && frame.reading
    // Where no host listed anything and none is still to answer, the notices of the hosts that failed are all there is to show.
    const unread = failures.length > 0 && sections.every(({ section }) => section.items === null && !awaits(section))
    body = (
      <>
        {!unread && sections.map(({ section, index }) => {
          const title = t(SECTION[section.filter])
          const open = folded[section.filter] !== true
          const shown = index.search(query)
          const awaited = awaits(section)
          return (
            <section key={section.filter} className={css.section} data-forge-review-section={section.filter}>
              <button type="button" className={css.sectionHeader} aria-expanded={open} onClick={() => { onFold(section.filter) }}>
                <IconChevronDownOutlineRegular size={12} className={clsx(css.chevron, !open && css.chevronClosed)} />
                <span className={css.sectionTitle}>{title}</span>
                {section.items !== null && !awaited && <span className={css.sectionCount}>{section.total.toLocaleString()}</span>}
              </button>
              {open && <>
                {shown.length > 0
                  ? (
                    <ul className={css.items} data-view={view}>
                      {shown.map((item) => {
                        const Row = view === 'compact' ? CompactItem : Item
                        return <Row key={item.summary.url} item={item} filter={section.filter} selected={item.summary.url === selected}
                          qualified={qualified} hosted={hosted} now={now} onSelect={onSelect} t={t} />
                      })}
                    </ul>
                  )
                  : section.items !== null && !awaited
                    && <p className={css.sectionEmpty}>{t(query.trim() === '' ? 'reviewPage.empty.section' : 'reviewPage.empty.search')}</p>}
                {awaited && <div aria-busy="true"><SkeletonItems view={view} count={shown.length > 0 ? 1 : 3} /></div>}
                {section.truncated && query.trim() === '' && (
                  <p className={css.sectionMore}>{t('reviewPage.truncated', { count: section.total - shown.length })}</p>
                )}
              </>}
            </section>
          )
        })}
        <HostFailures failures={failures} copyText={copyText} onOpenSettings={onOpenSettings} t={t} />
      </>
    )
  }
  return (
    <div className={css.list} data-forge-review-list="">
      <div className={css.listHeader}>
        <h2 className={css.listTitle}>{t('reviewPage.title')}</h2>
        <Tooltip label={t('reviewPage.refresh')} side="bottom">
          <button type="button" className={css.iconButton} aria-label={t('reviewPage.refresh')} aria-disabled={refreshing} onClick={onRefresh}>
            <RefreshGlyph busy={refreshing || frame?.reading === true} size={16} />
          </button>
        </Tooltip>
        <FilterMenu {...props} />
      </div>
      <div className={css.search}>
        <Input icon={<IconSearchOutlineRegular size={16} />} value={query} placeholder={t('reviewPage.search')} aria-label={t('reviewPage.search')}
          onChange={(event) => { onSearch(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && pasted !== undefined) onSelect(pasted)
            if (event.key === 'Escape' && query !== '') onSearch('')
          }} />
      </div>
      <div className={css.listBody}>
        {pasted !== undefined && (
          <button type="button" className={css.openUrl} onClick={() => { onSelect(pasted) }}>{t('reviewPage.openUrl', { url: pasted })}</button>
        )}
        {body}
      </div>
    </div>
  )
}
