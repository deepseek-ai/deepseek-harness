/**
 * Overview rows of an expanded change request card, each one line: the checks outcome, the review decision with the
 * reviewers' avatars, the merge state, and the issues linked to the change request. Details and actions open in a menu
 * from the row: the checks grouped by outcome with the rerun of the failed ones, the reviewers with review requests,
 * and the branch update.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronRightOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular,
  IconUserOutlineRegular, Input, Menu, MenuItemButton, StateDot, Tooltip,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots/client'
import type {
  BranchUpdateMethod, BranchUpdateRequest, ChangeRequestCheck, ChangeRequestIssue, ChangeRequestReviewer, ChangeRequestSnapshot,
  ForgeRerunRequest, ForgeReviewerCandidate, ReviewVerdict,
} from '@deepseek-ai/dsh-experimental-forge/types'
import { formatDuration } from './format.ts'
import { CheckGlyph } from './glyphs.tsx'
import type { ForgePanelKey, NS } from './locales.ts'
import { checkCounts, checkDuration, type ChangeRequestEntry } from './status.ts'
import { searchFieldKeyDown } from './menu-search.ts'
import css from './Forge.module.css'
import overview from './ChangeRequestOverview.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** Milliseconds between the last keystroke of a reviewer search and the listing it reads. */
const SEARCH_DELAY_MS = 150

/** Avatars the review row shows before it counts the rest. */
const AVATARS = 3

/** Requests reviews of a change request from more reviewers; settles once the outcome is reported. */
type RequestReviews = (entry: ChangeRequestEntry, reviewers: readonly Pick<ChangeRequestReviewer, 'kind' | 'login'>[]) => Promise<void>

/** Lists the accounts a review of the change request at `url` can be requested from. */
type ListCandidates = (url: string, query: string, signal: AbortSignal) => Promise<readonly ForgeReviewerCandidate[]>

/** Overview actions of a card; a surface without a Session binding omits them. */
export interface OverviewActions {
  /** Rerun the failed checks; settles once the outcome is reported. */
  readonly rerunChecks?: ((entry: ChangeRequestEntry, request: ForgeRerunRequest) => Promise<void>) | undefined
  /** Request reviews from more reviewers; settles once the outcome is reported. */
  readonly requestReviews?: RequestReviews | undefined
  /** List accounts a review can be requested from; rejects with the host's reason. */
  readonly reviewerCandidates?: ListCandidates | undefined
  /** Bring the base branch's new commits into the head branch; settles once the outcome is reported. */
  readonly updateBranch?: ((entry: ChangeRequestEntry, request: BranchUpdateRequest) => Promise<void>) | undefined
}

/**
 * One action at a time per control: it stays disabled until the previous action settles.
 * @returns whether an action runs, and the function that runs one.
 */
export function useBusy(): readonly [boolean, (action: () => Promise<void>) => void] {
  const [busy, setBusy] = useState(false)
  return [busy, (action) => {
    setBusy(true)
    void action().finally(() => { setBusy(false) })
  }]
}

/**
 * The parts of one fact row: its glyph, its one-line value after the fact's name, which only assistive technology
 * reads unless the value names the fact itself, an optional trailing part, and the chevron of a row that opens something.
 * @param props - the fact's name for assistive technology, the glyph, the value with its tone, the trailing part, and
 * whether the row opens something.
 * @returns the row's cells.
 */
export function RowParts({ label, icon, value, tone, trailing, opens }: {
  readonly label: string | undefined
  readonly icon: ReactNode
  readonly value: ReactNode
  readonly tone?: string | undefined
  readonly trailing?: ReactNode
  readonly opens: boolean
}): ReactNode {
  return (
    <>
      <span className={css.rowIcon}>{icon}</span>
      <span className={css.rowValue} data-tone={tone}>
        {label !== undefined && <span className={css.visuallyHidden}>{label}</span>}
        <span className={css.ellipsis}>{value}</span>
      </span>
      {trailing !== undefined && <span className={css.rowTrailing}>{trailing}</span>}
      {opens && <IconChevronRightOutlineRegular size={12} className={css.rowChevron} />}
    </>
  )
}

type CheckGroup = 'failed' | 'running' | 'cancelled' | 'passed' | 'other'

/** Groups that need attention, listed whenever the menu opens. */
const ATTENTION: readonly CheckGroup[] = ['failed', 'running', 'cancelled']

/** Groups the menu lists only on request. */
const QUIET: readonly CheckGroup[] = ['passed', 'other']

const GROUP_LABEL: Record<CheckGroup, ForgePanelKey> = {
  failed: 'checks.group.failed',
  running: 'checks.group.running',
  cancelled: 'checks.group.cancelled',
  passed: 'checks.group.passed',
  other: 'checks.group.other',
}

/** Checks of one outcome group. */
export interface CheckGroupList {
  readonly group: CheckGroup
  /** Name of the group. */
  readonly label: ForgePanelKey
  readonly checks: readonly ChangeRequestCheck[]
}

/**
 * Group checks by outcome, leaving out empty groups.
 * @param checks - the checks of the head commit.
 * @param kind - the failed, running, and cancelled groups, which need attention, or the passed and skipped ones.
 * @returns the groups in display order.
 */
export function checkGroups(checks: readonly ChangeRequestCheck[], kind: 'attention' | 'quiet'): readonly CheckGroupList[] {
  return (kind === 'attention' ? ATTENTION : QUIET)
    .map(group => ({ group, label: GROUP_LABEL[group], checks: checks.filter(check => groupOf(check) === group) }))
    .filter(entry => entry.checks.length > 0)
}

function groupOf(check: ChangeRequestCheck): CheckGroup {
  switch (check.state) {
    case 'failure': return 'failed'
    case 'pending': return 'running'
    case 'success': return 'passed'
    case 'cancelled': return 'cancelled'
    case 'neutral':
    case 'skipped': return 'other'
  }
}

/**
 * How long a check took, or that it is queued or running.
 * @param check - the check.
 * @param t - forge panel copy.
 * @returns the text, empty for a finished check without times.
 */
export function checkTime(check: ChangeRequestCheck, t: Translate): string {
  if (check.state === 'pending') return t(check.startedAt === null ? 'change.check.queued' : 'change.check.running')
  const elapsed = checkDuration(check)
  return elapsed === undefined ? '' : formatDuration(elapsed, t)
}

/**
 * The checks outcome in a few words: what needs attention, else that all passed.
 * @param snapshot - the snapshot whose checks are summarized.
 * @param t - forge panel copy.
 * @returns the summary.
 */
export function checksValue(snapshot: ChangeRequestSnapshot, t: Translate): string {
  if (snapshot.checksTruncated) return t('change.checks.truncated', { count: snapshot.checks.length })
  const counts = checkCounts(snapshot.checks)
  const parts = [
    ...counts.failed > 0 ? [t('change.checks.failed', { count: counts.failed })] : [],
    ...counts.running > 0 ? [t('change.checks.running', { count: counts.running })] : [],
    ...counts.cancelled > 0 ? [t('change.checks.cancelled', { count: counts.cancelled })] : [],
  ]
  return parts.length > 0 ? parts.join(' · ') : t('checks.allPassed', { count: counts.passed + counts.other })
}

type CheckRead = { readonly kind: 'idle' | 'loading' }
  | { readonly kind: 'ready'; readonly snapshot: ChangeRequestSnapshot }
  | { readonly kind: 'failed'; readonly message: string }

type ReadChecks = ((url: string, headSha: string, signal: AbortSignal) => Promise<ChangeRequestSnapshot>) | undefined

/**
 * Complete a check list the poll read only in part: while `active`, read the complete list of the snapshot's head
 * independently of polling, and stop when `active` ends or the head moves.
 * @param snapshot - the polled snapshot.
 * @param active - whether the checks are shown in full.
 * @param readChecks - loads the complete checks, or undefined on a surface that cannot.
 * @returns the snapshot to display, the state of the read, and a function that reads again.
 */
export function useCompleteChecks(snapshot: ChangeRequestSnapshot, active: boolean, readChecks: ReadChecks): {
  readonly displayed: ChangeRequestSnapshot
  readonly read: CheckRead
  readonly retry: () => void
} {
  const [read, setRead] = useState<CheckRead>({ kind: 'idle' })
  const [attempt, setAttempt] = useState(0)
  const { url, headSha, checksTruncated } = snapshot
  useEffect(() => {
    if (!active || !checksTruncated || readChecks === undefined) { setRead({ kind: 'idle' }); return }
    const controller = new AbortController()
    setRead({ kind: 'loading' })
    void (async () => {
      try {
        const result = await readChecks(url, headSha, controller.signal)
        if (!controller.signal.aborted) setRead({ kind: 'ready', snapshot: result })
      } catch (error) {
        if (!controller.signal.aborted) setRead({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => { controller.abort() }
  }, [active, url, headSha, checksTruncated, readChecks, attempt])
  return {
    displayed: read.kind === 'ready' && read.snapshot.headSha === headSha ? read.snapshot : snapshot,
    read,
    retry: () => { setAttempt(value => value + 1) },
  }
}

/**
 * Render the state of a complete-checks read that has not finished: that it loads, or why it failed with a retry.
 * @param props - the read, the retry, and copy.
 * @returns the status line, or null when nothing is being read or the read finished.
 */
export function ChecksReadStatus({ read, retry, t }: {
  readonly read: CheckRead
  readonly retry: () => void
  readonly t: Translate
}): ReactNode {
  if (read.kind === 'loading') {
    return <div className={overview.menuStatus} role="status"><StateDot state="ongoing" size={12} />{t('change.checks.loading')}</div>
  }
  if (read.kind !== 'failed') return null
  return (
    <div className={overview.menuStatus} role="status">
      <span>{t('change.checks.loadFailed', { message: read.message })}</span>
      <Button size="sm" variant="outline" onClick={retry}>{t('change.checks.retry')}</Button>
    </div>
  )
}

/** Props of the checks row. */
export interface ChecksRowProps {
  readonly entry: ChangeRequestEntry
  readonly snapshot: ChangeRequestSnapshot
  readonly openLink: (url: string) => void
  /** Load complete check details independently of polling; cancellation follows the open menu. */
  readonly readChecks: ReadChecks
  readonly rerunChecks: OverviewActions['rerunChecks']
  readonly t: Translate
}

/**
 * Whether a failed check names a rerun that none of the checks sharing it still waits for, as a rerun of checks in
 * progress cannot start.
 * @param checks - the checks of the head commit.
 * @returns whether a rerun of failed checks can start.
 */
function rerunnable(checks: readonly ChangeRequestCheck[]): boolean {
  const running = new Set(checks.flatMap(check => check.state === 'pending' && check.rerun !== null ? [check.rerun] : []))
  return checks.some(check => check.state === 'failure' && check.rerun !== null && !running.has(check.rerun))
}

/**
 * The rerun of failed checks, when the change request is open, the signed-in user may rerun, and a rerun can start.
 * @param displayed - the snapshot whose checks are shown.
 * @param rerunChecks - the surface's rerun action.
 * @returns the action, or undefined when no rerun is offered.
 */
export function rerunOf(displayed: ChangeRequestSnapshot, rerunChecks: OverviewActions['rerunChecks']): OverviewActions['rerunChecks'] {
  return displayed.state === 'open' && displayed.canRerunChecks && rerunnable(displayed.checks) ? rerunChecks : undefined
}

/**
 * Render the checks outcome as a row whose menu lists the failed, running, and cancelled checks by group, offers to
 * rerun the failed ones, and lists the passed and skipped ones on request. A list the poll read only in part is
 * completed while the menu is open.
 * @param props - the change request, its snapshot, the link and read actions, the rerun action, and copy.
 * @returns the row with its menu.
 */
export function ChecksRow({ entry, snapshot, openLink, readChecks, rerunChecks, t }: ChecksRowProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [quiet, setQuiet] = useState(false)
  const [busy, run] = useBusy()
  const { headSha } = snapshot
  const { displayed, read, retry } = useCompleteChecks(snapshot, open, readChecks)
  if (displayed.checks.length === 0 && !displayed.checksTruncated) {
    return <div className={css.row}><RowParts label={t('change.row.checks')} icon={<CheckGlyph state="neutral" />} value={t('change.ci.none')} opens={false} /></div>
  }
  const counts = checkCounts(displayed.checks)
  const rerun = rerunOf(displayed, rerunChecks)
  const quietCount = counts.passed + counts.other
  const close = (): void => {
    setOpen(false)
    setQuiet(false)
  }
  const rows = (kind: 'attention' | 'quiet'): ReactNode => checkGroups(displayed.checks, kind).map(({ group, label, checks }) => (
    <div key={group} role="group" aria-label={t(label)} data-forge-check-group={group}>
      <div className={overview.menuLabel} role="presentation">{`${t(label)} · ${checks.length}`}</div>
      {checks.map((check, index) => {
        const link = check.url
        return (
          // The list is replaced as a whole with each snapshot, and check names can repeat.
          <MenuItemButton key={index} icon={<CheckGlyph state={check.state} size={14} />} disabled={link === null}
            onSelect={link === null ? close : () => {
              close()
              openLink(link)
            }}>
            <span className={overview.check} data-forge-check-item={check.state}>
              <span className={css.ellipsis}>{check.name}</span>
              <span className={overview.checkTime}>{checkTime(check, t)}</span>
            </span>
          </MenuItemButton>
        )
      })}
    </div>
  ))
  const rollup = displayed.checksRollup === 'none' ? 'neutral' : displayed.checksRollup
  return (
    <Menu open={open} onClose={close} portal dense align="end" className={overview.rowAnchor} listClassName={overview.menu}
      anchor={(
        <button type="button" className={clsx(css.row, css.rowButton)} aria-haspopup="menu" aria-expanded={open} data-forge-checks=""
          onClick={() => { if (open) close(); else setOpen(true) }}>
          <RowParts label={t('change.row.checks')} icon={<CheckGlyph state={rollup} />} value={checksValue(displayed, t)} opens
            tone={!displayed.checksTruncated && counts.failed > 0 ? 'error' : undefined} />
        </button>
      )}>
      {rerun !== undefined && (
        <MenuItemButton icon={<IconRefreshOutlineRegular size={14} />} disabled={busy} onSelect={() => {
          close()
          run(() => rerun(entry, { headSha }))
        }}>
          {t('checks.rerunFailed')}
        </MenuItemButton>
      )}
      {rows('attention')}
      {quiet ? rows('quiet') : quietCount > 0 && (
        <MenuItemButton separatorBefore={counts.failed + counts.running + counts.cancelled > 0}
          icon={<CheckGlyph state={counts.passed > 0 ? 'success' : 'skipped'} size={14} />}
          onSelect={() => { setQuiet(true) }}>
          {t('checks.showQuiet', { count: quietCount })}
        </MenuItemButton>
      )}
      <ChecksReadStatus read={read} retry={retry} t={t} />
    </Menu>
  )
}

const VERDICT: Record<ReviewVerdict, { readonly key: ForgePanelKey; readonly tone: string | undefined }> = {
  'approved': { key: 'reviewers.approved', tone: 'success' },
  'changes-requested': { key: 'reviewers.changesRequested', tone: 'error' },
  'commented': { key: 'reviewers.commented', tone: undefined },
  'dismissed': { key: 'reviewers.dismissed', tone: undefined },
}

function Avatar({ url, login, size = 20 }: { readonly url: string | null; readonly login: string; readonly size?: number }): ReactNode {
  const [broken, setBroken] = useState(false)
  const style = { width: size, height: size }
  if (url === null || broken) {
    return (
      <span className={overview.avatar} style={style} aria-hidden="true">
        {login.replace(/^[^a-z0-9]*/i, '').slice(0, 1).toUpperCase()}
      </span>
    )
  }
  // Lazy images inside the panel's scroller never load in Chromium, so avatars load eagerly.
  return <img className={overview.avatar} style={style} src={url} alt="" loading="eager" onError={() => { setBroken(true) }} />
}

/** Props of the review row. */
export interface ReviewRowProps {
  readonly entry: ChangeRequestEntry
  readonly snapshot: ChangeRequestSnapshot
  /** The aggregate review outcome. */
  readonly value: string
  /** Tone of the aggregate outcome. */
  readonly tone: string | undefined
  readonly requestReviews: OverviewActions['requestReviews']
  readonly reviewerCandidates: OverviewActions['reviewerCandidates']
  readonly openLink: (url: string) => void
  /** Whether the page's primary pointer is coarse, which keeps the reviewer search from focusing its field. */
  readonly coarsePointer: boolean
  readonly t: Translate
}

/**
 * Render the review decision as a row with the first reviewers' avatars. Its menu lists each reviewer with their
 * latest outcome or that their review is requested, and, when the signed-in user may request reviews, offers to ask a
 * reviewer again and to request a review from someone else through a search.
 * @param props - the change request, its snapshot, the aggregate outcome, the review request actions, the pointer
 * accuracy, and copy.
 * @returns the row with its menu.
 */
export function ReviewRow({
  entry, snapshot, value, tone, requestReviews, reviewerCandidates, openLink, coarsePointer, t,
}: ReviewRowProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [busy, run] = useBusy()
  const { reviewers } = snapshot
  const ask = snapshot.canRequestReviews && reviewerCandidates !== undefined ? requestReviews : undefined
  const canRequest = ask !== undefined
  const avatars = reviewers.length === 0 ? undefined : (
    <span className={overview.avatars} aria-hidden="true">
      {reviewers.slice(0, AVATARS).map(reviewer => (
        <Avatar key={`${reviewer.kind}:${reviewer.login}`} url={reviewer.avatarUrl} login={reviewer.login} size={18} />
      ))}
      {reviewers.length > AVATARS && <span className={overview.moreCount}>{`+${reviewers.length - AVATARS}`}</span>}
    </span>
  )
  const opens = reviewers.length > 0 || canRequest
  const parts = (
    <RowParts label={t('change.row.review')} icon={<IconUserOutlineRegular size={16} />} value={value} tone={tone} trailing={avatars}
      opens={opens} />
  )
  if (!opens) return <div className={css.row}>{parts}</div>
  const close = (): void => {
    setOpen(false)
    setSearching(false)
  }
  const request = ask === undefined ? undefined : (reviewer: Pick<ChangeRequestReviewer, 'kind' | 'login'>): void => {
    close()
    run(() => ask(entry, [reviewer]))
  }
  const again = reviewersToAskAgain(reviewers)
  return (
    <Menu open={open} onClose={close} portal dense align="end" className={overview.rowAnchor} listClassName={overview.menu}
      anchor={(
        <button type="button" className={clsx(css.row, css.rowButton)} aria-haspopup="menu" aria-expanded={open} data-forge-review=""
          disabled={busy} onClick={() => { if (open) close(); else setOpen(true) }}>
          {parts}
        </button>
      )}>
      {searching && request !== undefined && reviewerCandidates !== undefined
        ? (
          <ReviewerSearch url={snapshot.url} list={reviewerCandidates} choose={(login) => { request({ kind: 'user', login }) }}
            coarsePointer={coarsePointer} t={t} />
        )
        : (
          <>
            {reviewers.length === 0 && <div className={overview.menuStatus}>{t('reviewers.none')}</div>}
            {reviewers.map(reviewer => (
              <ReviewerLine key={`${reviewer.kind}:${reviewer.login}`} reviewer={reviewer} headSha={snapshot.headSha} t={t} />
            ))}
            {snapshot.reviewersTruncated && (
              <MenuItemButton onSelect={() => {
                close()
                openLink(snapshot.url)
              }}>
                {t('reviewers.truncated')}
              </MenuItemButton>
            )}
            {request !== undefined && (
              <ReviewRequestItems again={again} separated onRequest={request} onSearch={() => { setSearching(true) }} t={t} />
            )}
          </>
        )}
    </Menu>
  )
}

/**
 * The reviewers a review can be asked of again: people who reviewed and are not asked now. Bots review on their own
 * triggers.
 * @param reviewers - the change request's reviewers.
 * @returns the reviewers to offer.
 */
export function reviewersToAskAgain(reviewers: readonly ChangeRequestReviewer[]): readonly ChangeRequestReviewer[] {
  return reviewers.filter(reviewer => reviewer.kind !== 'bot' && !reviewer.requested && reviewer.verdict !== null)
}

/**
 * Render the menu items that request reviews: one per reviewer to ask again, then the search for someone else.
 * @param props - the reviewers to ask again, whether a separator precedes the first item, the request and search
 * handlers, and copy.
 * @returns the items.
 */
export function ReviewRequestItems({ again, separated, onRequest, onSearch, t }: {
  readonly again: readonly ChangeRequestReviewer[]
  readonly separated: boolean
  readonly onRequest: (reviewer: Pick<ChangeRequestReviewer, 'kind' | 'login'>) => void
  readonly onSearch: () => void
  readonly t: Translate
}): ReactNode {
  return (
    <>
      {again.map((reviewer, index) => (
        <MenuItemButton key={`${reviewer.kind}:${reviewer.login}`} separatorBefore={separated && index === 0}
          icon={<IconRefreshOutlineRegular size={14} />} onSelect={() => { onRequest(reviewer) }}>
          {t('reviewers.rerequestAria', { login: reviewer.login })}
        </MenuItemButton>
      ))}
      <MenuItemButton separatorBefore={separated && again.length === 0} icon={<IconPlusOutlineRegular size={14} />} onSelect={onSearch}>
        {t('reviewers.requestMore')}
      </MenuItemButton>
    </>
  )
}

/**
 * Render one reviewer: avatar, login, what kind of reviewer, and their latest outcome or pending request.
 * @param props - the reviewer, the head commit their outcome is compared with, and copy.
 * @returns the line.
 */
export function ReviewerLine({ reviewer, headSha, t }: {
  readonly reviewer: ChangeRequestReviewer
  readonly headSha: string
  readonly t: Translate
}): ReactNode {
  const verdict = reviewer.verdict === null ? undefined : VERDICT[reviewer.verdict]
  // A shown outcome older than the head; a requested review hides the outcome.
  const older = !reviewer.requested && reviewer.verdict !== null && reviewer.reviewedSha !== null
    && reviewer.reviewedSha.toLowerCase() !== headSha.toLowerCase()
  const kind = reviewer.codeOwner ? t('reviewers.codeOwner') : reviewer.kind === 'team' ? t('reviewers.team')
    : reviewer.kind === 'bot' ? t('reviewers.bot') : undefined
  return (
    <div className={overview.reviewer} role="presentation" data-forge-reviewer={reviewer.login}>
      <Avatar url={reviewer.avatarUrl} login={reviewer.login} />
      <span className={overview.who}>
        <span className={css.ellipsis}>{reviewer.login}</span>
        {kind !== undefined && <span className={overview.kind}>{kind}</span>}
      </span>
      <span className={overview.outcome}>
        {reviewer.requested
          ? <span data-tone="pending">{t('reviewers.pending')}</span>
          : verdict !== undefined && <span data-tone={verdict.tone}>{t(verdict.key)}</span>}
        {older && <span className={overview.older}>{t('reviewers.older')}</span>}
      </span>
    </div>
  )
}

/** The accounts a reviewer search listed for `query`, or that the listing failed. */
type Listing = { readonly query: string } & (
  { readonly ok: true; readonly value: readonly ForgeReviewerCandidate[] } | { readonly ok: false })

/**
 * Render the searchable account list of a review request: the host's suggestions first, then accounts matching the
 * search. The search field takes focus when the list opens, unless the primary pointer is coarse, where focus would
 * raise the soft keyboard.
 * @param props - the change request URL, the listing, the choice handler, whether the primary pointer is coarse when
 * the list opens, and copy.
 * @returns the search field and its list.
 */
export function ReviewerSearch({ url, list, choose, coarsePointer, t }: {
  readonly url: string
  readonly list: ListCandidates
  readonly choose: (login: string) => void
  readonly coarsePointer: boolean
  readonly t: Translate
}): ReactNode {
  const [query, setQuery] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [listing, setListing] = useState<Listing | null>(null)
  const search = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      list(url, query, controller.signal).then(
        (value) => { if (!controller.signal.aborted) setListing({ query, ok: true, value }) },
        () => { if (!controller.signal.aborted) setListing({ query, ok: false }) },
      )
    }, query === '' ? 0 : SEARCH_DELAY_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [url, query, attempt, list])
  useEffect(() => {
    // Decided once, with the pointer accuracy of the render that opened the list.
    if (coarsePointer) return
    const frame = requestAnimationFrame(() => { search.current?.focus() })
    return () => { cancelAnimationFrame(frame) }
  }, [])
  // A listing of an earlier query is never shown or chosen from, so Enter cannot request a review from an account the
  // current query no longer names.
  const current = listing !== null && listing.query === query ? listing : null
  const candidates = current !== null && current.ok ? current.value : []
  let body: ReactNode
  if (current === null) {
    body = <div className={overview.menuStatus} role="status"><StateDot state="ongoing" />{t('reviewers.loading')}</div>
  } else if (!current.ok) {
    body = (
      <div className={overview.menuStatus} role="status">
        <span>{t('reviewers.loadFailed')}</span>
        <Button size="sm" variant="outline" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button>
      </div>
    )
  } else if (candidates.length === 0) {
    body = <div className={overview.menuStatus}>{t('reviewers.empty')}</div>
  } else {
    body = candidates.map(candidate => (
      <MenuItemButton key={candidate.login} icon={<Avatar url={candidate.avatarUrl} login={candidate.login} size={16} />}
        onSelect={() => { choose(candidate.login) }}>
        <span className={overview.candidate}>
          <span className={css.ellipsis}>{candidate.login}</span>
          {candidate.name !== null && candidate.name !== candidate.login && <span className={overview.kind}>{candidate.name}</span>}
          {candidate.suggested && <span className={overview.badge}>{t('reviewers.suggested')}</span>}
        </span>
      </MenuItemButton>
    ))
  }
  const first = candidates[0]
  return (
    <>
      <div className={overview.menuSearch}>
        <Input ref={search} icon={<IconSearchOutlineRegular size={14} />} value={query} aria-label={t('reviewers.search')}
          placeholder={t('reviewers.search')} onChange={(event) => { setQuery(event.target.value) }}
          onKeyDown={(event) => { searchFieldKeyDown(event, first === undefined ? undefined : () => { choose(first.login) }) }} />
      </div>
      <div className={overview.menuRows}>{body}</div>
    </>
  )
}

/** Props of the merge row. */
export interface MergeRowProps {
  readonly entry: ChangeRequestEntry
  readonly snapshot: ChangeRequestSnapshot
  /** Glyph of the row. */
  readonly icon: ReactNode
  /** The merge conflict status. */
  readonly value: string
  /** Tone of the conflict status. */
  readonly tone: string | undefined
  readonly updateBranch: OverviewActions['updateBranch']
  readonly t: Translate
}

/**
 * Render the merge state as a row: the conflict status and whether the head is behind its base. While the signed-in
 * user can update the head branch, the row opens the update menu: a title, one row per method, and the confirmation,
 * which is refused once the head moved after the menu opened.
 * @param props - the change request, its snapshot, the row glyph and status, the update action, and copy.
 * @returns the row, with its menu when the branch can be updated.
 */
export function MergeRow({ entry, snapshot, icon, value, tone, updateBranch, t }: MergeRowProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [confirmedHead, setConfirmedHead] = useState(snapshot.headSha)
  const [usual = 'merge'] = snapshot.branchUpdates
  const [chosen, setChosen] = useState<string>(usual)
  const [busy, run] = useBusy()
  const behind = snapshot.branchUpdates.length > 0
  const text = behind ? `${value} · ${t('branch.behind', { base: snapshot.baseBranch })}` : value
  if (!behind || updateBranch === undefined) {
    return <div className={css.row}><RowParts label={t('change.row.merge')} icon={icon} value={text} tone={tone} opens={false} /></div>
  }
  const stale = confirmedHead !== snapshot.headSha
  const method: BranchUpdateMethod = snapshot.branchUpdates.find(entry => entry === chosen) ?? usual
  const base = snapshot.baseBranch
  const items: MenuEntry[] = [
    { type: 'label', id: 'title', text: t('branch.updateTitle', { head: snapshot.headBranch, base }) },
    ...snapshot.branchUpdates.map(entry => ({
      id: entry,
      label: (
        <span className={css.method}>
          <span>{t(`branch.method.${entry}`)}</span>
          <span className={css.methodNote}>{t(`branch.note.${entry}`, { base })}</span>
        </span>
      ),
    })),
  ]
  return (
    <Menu open={open} onClose={() => { setOpen(false) }} portal align="end" className={overview.rowAnchor} items={items}
      selectedId={method} onSelect={setChosen}
      anchor={(
        <button type="button" className={clsx(css.row, css.rowButton)} aria-haspopup="menu" aria-expanded={open} disabled={busy}
          data-forge-update-branch="" onClick={() => {
            if (!open) setConfirmedHead(snapshot.headSha)
            setOpen(!open)
          }}>
          <RowParts label={t('change.row.merge')} icon={icon} value={text} tone={tone} opens
            trailing={<span className={overview.action}>{t('branch.update')}</span>} />
        </button>
      )}>
      <MenuItemButton separatorBefore disabled={stale} onSelect={() => {
        setOpen(false)
        run(() => updateBranch(entry, { method, headSha: confirmedHead }))
      }}>
        {t(stale ? 'branch.changed' : 'branch.confirm')}
      </MenuItemButton>
    </Menu>
  )
}

/**
 * A speech bubble, the glyph of review threads.
 * @param props - glyph size in pixels.
 * @returns the decorative glyph.
 */
export function ThreadGlyph({ size = 14 }: { readonly size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 4.2C3 3.5 3.5 3 4.2 3h7.6c.7 0 1.2.5 1.2 1.2v5.4c0 .7-.5 1.2-1.2 1.2H7.3L4.6 13v-2.2h-.4C3.5 10.8 3 10.3 3 9.6z"
        stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round" />
    </svg>
  )
}

/** An issue: a ring around a dot. */
function IssueGlyph(): ReactNode {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth={1.3} />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
    </svg>
  )
}

/** The issue's label: `#n` within the change request's repository, else `owner/name#n`. */
function issueLabel(issue: ChangeRequestIssue, snapshot: ChangeRequestSnapshot): string {
  const { owner, name } = snapshot.ref.repository
  const same = issue.repository.owner.toLowerCase() === owner.toLowerCase()
    && issue.repository.name.toLowerCase() === name.toLowerCase()
  return same ? `#${issue.number}` : `${issue.repository.owner}/${issue.repository.name}#${issue.number}`
}

/**
 * Render the issues linked to the change request, which the host closes once it merges, as one row of links, each
 * named by its number with its title in a tooltip, or nothing without one. More issues than the provider read end the
 * row with a note.
 * @param props - the snapshot, the link action, and copy.
 * @returns the row, or null.
 */
export function IssuesRow({ snapshot, openLink, t }: {
  readonly snapshot: ChangeRequestSnapshot
  readonly openLink: (url: string) => void
  readonly t: Translate
}): ReactNode {
  if (snapshot.closingIssues.length === 0) return null
  const links = snapshot.closingIssues.map((issue, index) => {
    const label = issueLabel(issue, snapshot)
    return (
      <span key={issue.url}>
        {index > 0 && t('issues.separator')}
        <Tooltip label={issue.title} side="top" delayMs={500}>
          <a className={overview.issue} href={issue.url} target="_blank" rel="noreferrer" data-state={issue.state}
            aria-label={t('issues.aria', { label, title: issue.title })}
            onClick={(event) => {
              event.preventDefault()
              openLink(issue.url)
            }}>
            {label}
          </a>
        </Tooltip>
      </span>
    )
  })
  return (
    <div className={css.row} data-forge-closing-issues="">
      <RowParts label={undefined} icon={<IssueGlyph />} opens={false}
        value={<>{t('issues.label')}{' '}{links}{snapshot.closingIssuesTruncated && t('issues.more')}</>} />
    </div>
  )
}
