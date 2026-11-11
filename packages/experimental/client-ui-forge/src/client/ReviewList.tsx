/**
 * The review page's list column: the search box that also opens a pasted change request link, the repository filter,
 * and one foldable section per list with its items, empty state, and failure.
 */

import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconSearchOutlineRegular, IconSlidersTwoOutlineRegular, Input, Menu,
  MenuItemButton, Tooltip,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChecksRollup, ForgeViewerFilter } from '@deepseek-ai/dsh-experimental-forge/types'
import type { ForgeReviewFrame } from '../types.ts'
import { formatAgo } from './format.ts'
import { ChangeRequestGlyph } from './glyphs.tsx'
import type { ForgePanelKey, NS } from './locales.ts'
import { RefreshGlyph } from './RefreshGlyph.tsx'
import {
  pastedUrl, reviewHint, reviewRepositories, reviewSections, summaryTone, type ReviewItem, type ReviewRepository, type ReviewSection,
} from './review-lists.ts'
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
  /** Repository the lists are read in, or null for every repository. */
  readonly repository: ReviewRepository | null
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
  /** Read the lists in one repository, or in every repository. */
  readonly onScope: (repository: ReviewRepository | null) => void
  /** Toggle whether the review-requested list leaves out team requests. */
  readonly onToggleDirect: () => void
  /** Fold or unfold a section. */
  readonly onFold: (filter: ForgeViewerFilter) => void
  /** Read every list again. */
  readonly onRefresh: () => void
  /** Open the list stream again after it stopped. */
  readonly onRetry: () => void
  /** Copy text and report the outcome. */
  readonly copyText: (text: string) => void
  /** Forge panel copy. */
  readonly t: Translate
}

/** The filter menu: the repository the lists are read in, and whether team requests show. */
function FilterMenu({ frame, repository, directOnly, onScope, onToggleDirect, t }: Pick<ReviewListProps,
  'frame' | 'repository' | 'directOnly' | 'onScope' | 'onToggleDirect' | 't'>): ReactNode {
  const [open, setOpen] = useState(false)
  const repositories = reviewRepositories(frame)
  const chosen = repository === null ? null : `${repository.owner}/${repository.name}`
  // A chosen repository stays offered while its own lists are empty.
  const offered = repository !== null && !repositories.some(item => `${item.owner}/${item.name}` === chosen)
    ? [repository, ...repositories] : repositories
  const items: MenuEntry[] = [
    { type: 'label', id: 'repository', text: t('reviewPage.filter.repository') },
    { id: '', label: t('reviewPage.filter.allRepositories') },
    ...offered.map(item => ({ id: `${item.owner}/${item.name}`, label: `${item.owner}/${item.name}` })),
  ]
  const active = repository !== null || directOnly
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      portal
      align="end"
      anchor={(
        <Tooltip label={t('reviewPage.filter')} side="bottom">
          <button type="button" className={clsx(css.iconButton, active && css.iconButtonActive)} aria-label={t('reviewPage.filter')}
            aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open) }}>
            <IconSlidersTwoOutlineRegular size={16} />
          </button>
        </Tooltip>
      )}
      items={items}
      selectedId={chosen ?? ''}
      onSelect={(id) => {
        setOpen(false)
        const [owner = '', name = ''] = id.split('/')
        onScope(id === '' ? null : { owner, name })
      }}
    >
      <MenuItemButton separatorBefore icon={directOnly ? <IconCheckOutlineRegular size={16} /> : <span className={css.menuIconSpace} />}
        onSelect={() => { setOpen(false); onToggleDirect() }}>
        {t('reviewPage.filter.directOnly')}
      </MenuItemButton>
    </Menu>
  )
}

/** The closing issues of an item: the first issue's number, and how many more. */
function Issues({ item, t }: { readonly item: ReviewItem; readonly t: Translate }): ReactNode {
  const [first] = item.summary.closingIssues
  if (first === undefined) return null
  const more = item.summary.closingIssues.length - 1 + (item.summary.closingIssuesTruncated ? 1 : 0)
  return (
    <span className={css.itemIssues}>
      <span aria-hidden="true">⊙</span>
      {t('change.number', { number: first.number })}
      {more > 0 && <span>{t(item.summary.closingIssuesTruncated ? 'reviewPage.issuesMoreTruncated' : 'reviewPage.issuesMore', { count: more })}</span>}
    </span>
  )
}

/** One listed change request. */
function Item({ item, filter, selected, qualified, now, onSelect, t }: {
  readonly item: ReviewItem
  readonly filter: ForgeViewerFilter
  readonly selected: boolean
  /** Whether the item names its repository, because the lists span more than one. */
  readonly qualified: boolean
  readonly now: number
  readonly onSelect: (url: string) => void
  readonly t: Translate
}): ReactNode {
  const { summary } = item
  const { repository, number } = summary.ref
  const hint = reviewHint(summary, filter)
  const ago = formatAgo(summary.updatedAt, now, t)
  const checks: Exclude<ChecksRollup, 'none'> | undefined = summary.checksRollup === 'none' ? undefined : summary.checksRollup
  return (
    <li>
      <button type="button" className={css.item} aria-current={selected ? 'true' : undefined} data-forge-review-item={summary.url}
        onClick={() => { onSelect(summary.url) }}>
        <span className={css.itemGlyph}><ChangeRequestGlyph tone={summaryTone(summary)} checks={checks} size={16} /></span>
        <span className={css.itemText}>
          <span className={css.itemTitle}>{summary.title}</span>
          <span className={css.itemMeta}>
            <span>{qualified ? `${repository.name}#${number}` : t('change.number', { number })}</span>
            {summary.author !== null && <><span aria-hidden="true">·</span><span className={css.ellipsis}>{summary.author.login}</span></>}
            {ago !== undefined && <><span aria-hidden="true">·</span><span>{ago}</span></>}
            <Issues item={item} t={t} />
          </span>
          {hint !== undefined && <span className={css.itemHint} data-tone={hint.tone}>{t(hint.key, hint.params)}</span>}
        </span>
      </button>
    </li>
  )
}

/** A section's failure: the sign-in command for an unauthenticated GitHub host, otherwise the reason. */
function SectionFailure({ section, copyText, t }: {
  readonly section: ReviewSection
  readonly copyText: (text: string) => void
  readonly t: Translate
}): ReactNode {
  if (section.failure === null) return null
  const { host, forge, failure } = section.failure
  if (failure.code === 'unauthenticated') {
    const command = forge === 'github' ? `gh auth login --hostname ${host}` : undefined
    return (
      <div className={css.notice} role="status">
        <span>{t('reviewPage.signIn', { host })}</span>
        {command !== undefined && (
          <span className={css.noticeCommand}>
            <code>{command}</code>
            <Button size="sm" variant="outline" onClick={() => { copyText(command) }}>{t('signin.copy')}</Button>
          </span>
        )}
      </div>
    )
  }
  if (failure.code === 'rate-limited') return <div className={css.notice} role="status">{t('change.failure.rateLimited')}</div>
  return <div className={css.notice} role="status">{t('reviewPage.listFailed', { host, message: failure.message })}</div>
}

/**
 * Render the list column.
 * @param props - the latest frame, the reader's choices, and their handlers.
 * @returns the column.
 */
export function ReviewList(props: ReviewListProps): ReactNode {
  const { frame, stopped, selected, query, folded, refreshing, now, onSelect, onSearch, onFold, onRefresh, onRetry, copyText, t } = props
  const sections = reviewSections(frame, query, props.directOnly)
  const pasted = pastedUrl(query)
  const qualified = reviewRepositories(frame).length > 1
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
      <div className={css.skeleton} aria-busy="true" aria-label={t('reviewPage.loading')}>
        {[0, 1, 2, 3].map(index => <span key={index} className={css.skeletonRow} />)}
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
    body = sections.map((section) => {
      const title = t(SECTION[section.filter])
      const open = folded[section.filter] !== true
      const shown = section.items ?? []
      return (
        <section key={section.filter} className={css.section} data-forge-review-section={section.filter}>
          <button type="button" className={css.sectionHeader} aria-expanded={open} onClick={() => { onFold(section.filter) }}>
            <IconChevronDownOutlineRegular size={12} className={clsx(css.chevron, !open && css.chevronClosed)} />
            <span className={css.sectionTitle}>{title}</span>
            {section.items !== null && <span className={css.sectionCount}>{section.total.toLocaleString()}</span>}
          </button>
          {open && <>
            <SectionFailure section={section} copyText={copyText} t={t} />
            {section.items === null
              ? section.failure === null && <div className={css.skeleton} aria-busy="true"><span className={css.skeletonRow} /></div>
              : shown.length === 0
                ? <p className={css.sectionEmpty}>{t(query.trim() === '' ? 'reviewPage.empty.section' : 'reviewPage.empty.search')}</p>
                : (
                  <ul className={css.items}>
                    {shown.map(item => (
                      <Item key={item.summary.url} item={item} filter={section.filter} selected={item.summary.url === selected}
                        qualified={qualified} now={now} onSelect={onSelect} t={t} />
                    ))}
                  </ul>
                )}
            {section.truncated && query.trim() === '' && (
              <p className={css.sectionMore}>{t('reviewPage.truncated', { count: section.total - shown.length })}</p>
            )}
          </>}
        </section>
      )
    })
  }
  return (
    <div className={css.list} data-forge-review-list="">
      <div className={css.listHeader}>
        <h2 className={css.listTitle}>{t('reviewPage.title')}</h2>
        <Tooltip label={t('refresh')} side="bottom">
          <button type="button" className={css.iconButton} aria-label={t('refresh')} aria-disabled={refreshing} onClick={onRefresh}>
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
