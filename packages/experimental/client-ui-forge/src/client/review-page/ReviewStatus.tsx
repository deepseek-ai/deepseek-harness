/**
 * The status column of the review page's summary: the merge state, the checks that need attention, each reviewer with
 * their outcome, and the changed lines with the linked issues, each in a block of its own. A finished change request
 * shows how it ended, its changed lines, and its reviewers. The blocks read the facts and run the actions of the
 * Session panel's change request card.
 */

import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChangeRequestCheck, ChangeRequestReviewer, ChangeRequestSnapshot } from '@deepseek-ai/dsh-experimental-forge/types'
import type { ForgeReviewChangeRequest } from '../../types.ts'
import {
  ChangesRow, FinishedRow, MergeStateRow, reviewOutcome, type ChangeRequestActions,
} from '../ChangeRequestCard.tsx'
import {
  checkGroups, ChecksReadStatus, checksValue, checkTime, IssuesRow, rerunOf, ReviewerLine, ReviewerSearch, reviewersToAskAgain,
  ReviewRequestItems, useBusy, useCompleteChecks,
} from '../ChangeRequestOverview.tsx'
import { CheckGlyph } from '../glyphs.tsx'
import type { NS } from '../locales.ts'
import { checkCounts } from '../status.ts'
import overview from '../ChangeRequestOverview.module.css'
import forge from '../Forge.module.css'
import css from './ReviewPage.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** Checks or reviewers a block lists before it folds the rest. */
const LISTED = 5

/**
 * The control that lists everything a block holds, or folds it again. Its chevron points down to list and up to fold,
 * as the Session panel's fold does.
 */
function Fold({ expanded, total, onToggle, t }: {
  readonly expanded: boolean
  readonly total: number
  readonly onToggle: () => void
  readonly t: Translate
}): ReactNode {
  return (
    <button type="button" className={clsx(css.statusLine, css.statusLineButton, css.statusFold)} aria-expanded={expanded} onClick={onToggle}>
      <span className={css.statusIcon} data-forge-review-fold={expanded ? 'less' : 'more'}>
        {expanded ? <IconChevronUpOutlineRegular size={12} /> : <IconChevronDownOutlineRegular size={12} />}
      </span>
      {expanded ? t('fold.less') : t('reviewPage.showAll', { count: total })}
    </button>
  )
}

/** One check: its outcome glyph, its name, and how long it took; a check with a page opens it. */
function CheckLine({ check, openLink, t }: {
  readonly check: ChangeRequestCheck
  readonly openLink: (url: string) => void
  readonly t: Translate
}): ReactNode {
  const parts = (
    <>
      <span className={css.statusIcon}><CheckGlyph state={check.state} size={14} /></span>
      <span className={forge.ellipsis}>{check.name}</span>
      <span className={overview.checkTime}>{checkTime(check, t)}</span>
    </>
  )
  const link = check.url
  if (link === null) return <div className={css.statusLine} data-forge-check-item={check.state}>{parts}</div>
  return (
    <button type="button" className={clsx(css.statusLine, css.statusLineButton)} data-forge-check-item={check.state}
      onClick={() => { openLink(link) }}>
      {parts}
    </button>
  )
}

/**
 * The checks block: the outcome in its heading, then the failed, running, and cancelled checks. Listing everything
 * groups the checks by outcome and adds the passed and skipped ones. A list the poll read only in part is completed
 * while the block shows.
 */
function Checks({ frame, snapshot, actions, t }: StatusProps): ReactNode {
  const [all, setAll] = useState(false)
  const [busy, run] = useBusy()
  const { displayed, read, retry } = useCompleteChecks(snapshot, true, actions.readChecks)
  const label = t('change.row.checks')
  const none = displayed.checks.length === 0 && !displayed.checksTruncated
  const attention = checkGroups(displayed.checks, 'attention')
  const listed = attention.flatMap(group => group.checks).slice(0, LISTED)
  const rerun = rerunOf(displayed, actions.rerunChecks)
  const failed = !displayed.checksTruncated && checkCounts(displayed.checks).failed > 0
  // The list is replaced as a whole with each snapshot, and check names can repeat, so lines are keyed by position.
  const lines = (checks: readonly ChangeRequestCheck[]): ReactNode =>
    checks.map((check, index) => <CheckLine key={index} check={check} openLink={actions.openLink} t={t} />)
  return (
    <section className={css.statusSection} aria-label={label} data-forge-review-checks="">
      <h3 className={css.statusHead}>
        <span>{label}</span>
        <span className={css.statusSummary} data-tone={failed ? 'error' : undefined}>
          {none ? t('change.ci.none') : checksValue(displayed, t)}
        </span>
      </h3>
      {!none && (
        <div className={css.statusList}>
          {all
            ? [...attention, ...checkGroups(displayed.checks, 'quiet')].map(group => (
              <div key={group.group} role="group" aria-label={t(group.label)} data-forge-check-group={group.group}>
                <div className={overview.menuLabel} role="presentation">{`${t(group.label)} · ${group.checks.length}`}</div>
                {lines(group.checks)}
              </div>
            ))
            : lines(listed)}
          <ChecksReadStatus read={read} retry={retry} t={t} />
          {displayed.checks.length > listed.length && (
            <Fold expanded={all} total={displayed.checks.length} onToggle={() => { setAll(!all) }} t={t} />
          )}
          {rerun !== undefined && (
            <button type="button" className={clsx(css.statusLine, css.statusLineButton, css.statusAction)} disabled={busy}
              data-forge-review-rerun="" onClick={() => { run(() => rerun(frame, { headSha: snapshot.headSha })) }}>
              <span className={css.statusIcon}><IconRefreshOutlineRegular size={14} /></span>
              {t('checks.rerunFailed')}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * The reviewers block: the aggregate outcome of an open change request in its heading, then each reviewer with their
 * latest outcome or pending request. When the signed-in user may request reviews of an open change request, its last
 * line opens the menu that asks a reviewer again or searches for someone else.
 */
function Reviewers({ frame, snapshot, actions, t }: StatusProps): ReactNode {
  const [all, setAll] = useState(false)
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [busy, run] = useBusy()
  const { reviewers } = snapshot
  const label = t('change.row.review')
  const ongoing = snapshot.state === 'open'
  const outcome = reviewOutcome(snapshot, t)
  const { requestReviews, reviewerCandidates } = actions
  const requesting = ongoing && snapshot.canRequestReviews && requestReviews !== undefined && reviewerCandidates !== undefined
    ? { ask: requestReviews, list: reviewerCandidates }
    : undefined
  const again = reviewersToAskAgain(reviewers)
  const close = (): void => {
    setOpen(false)
    setSearching(false)
  }
  const lined = reviewers.length > 0 || snapshot.reviewersTruncated || requesting !== undefined
  return (
    <section className={css.statusSection} aria-label={label} data-forge-review-reviewers="">
      <h3 className={css.statusHead}>
        <span>{label}</span>
        {ongoing && <span className={css.statusSummary} data-tone={outcome.tone}>{outcome.value}</span>}
      </h3>
      {lined && (
        <div className={css.statusList}>
          {(all ? reviewers : reviewers.slice(0, LISTED)).map(reviewer => (
            <ReviewerLine key={`${reviewer.kind}:${reviewer.login}`} reviewer={reviewer} headSha={snapshot.headSha} t={t} />
          ))}
          {reviewers.length > LISTED && <Fold expanded={all} total={reviewers.length} onToggle={() => { setAll(!all) }} t={t} />}
          {snapshot.reviewersTruncated && (
            <button type="button" className={clsx(css.statusLine, css.statusLineButton, css.statusFold)}
              onClick={() => { actions.openLink(snapshot.url) }}>
              {t('reviewers.truncated')}
            </button>
          )}
          {requesting !== undefined && (
            <Menu open={open} onClose={close} portal dense align="start" listClassName={overview.menu}
              anchor={(
                <button type="button" className={clsx(css.statusLine, css.statusLineButton, css.statusAction)} aria-haspopup="menu"
                  aria-expanded={open} disabled={busy} data-forge-review-request="" onClick={() => { if (open) close(); else setOpen(true) }}>
                  <span className={css.statusIcon}><IconPlusOutlineRegular size={14} /></span>
                  {t('reviewPage.requestReview')}
                </button>
              )}>
              {searching || again.length === 0
                ? (
                  <ReviewerSearch url={snapshot.url} list={requesting.list} t={t} choose={(login) => {
                    close()
                    run(() => requesting.ask(frame, [{ kind: 'user', login }]))
                  }} />
                )
                : (
                  <ReviewRequestItems again={again} separated={false} onSearch={() => { setSearching(true) }} t={t}
                    onRequest={(reviewer: Pick<ChangeRequestReviewer, 'kind' | 'login'>) => {
                      close()
                      run(() => requesting.ask(frame, [reviewer]))
                    }} />
                )}
            </Menu>
          )}
        </div>
      )}
    </section>
  )
}

/** Props of the status column and of its blocks. */
export interface StatusProps {
  /** The change request. */
  readonly frame: ForgeReviewChangeRequest
  /** Its latest snapshot. */
  readonly snapshot: ChangeRequestSnapshot
  /** The actions the page offers on it. */
  readonly actions: ChangeRequestActions
  /** Forge panel copy. */
  readonly t: Translate
}

/**
 * Render the status column.
 * @param props - the change request, its snapshot, how rows name it, the current time, the actions, the number
 * locale, and copy.
 * @returns the blocks.
 */
export function ReviewStatus({ frame, snapshot, name, now, actions, locale, t }: StatusProps & {
  readonly name: string
  readonly now: number
  readonly locale: string
}): ReactNode {
  const changes = <ChangesRow entry={frame} snapshot={snapshot} name={name} actions={actions} locale={locale} t={t} />
  if (snapshot.state !== 'open') {
    return (
      <>
        <div className={css.statusCard} data-forge-review-finished="">
          <div className={css.statusRows}>
            <FinishedRow snapshot={snapshot} now={now} t={t} />
            {changes}
          </div>
        </div>
        {snapshot.reviewers.length > 0 && <Reviewers frame={frame} snapshot={snapshot} actions={actions} t={t} />}
      </>
    )
  }
  return (
    <>
      <div className={css.statusCard} data-tone={snapshot.mergeability === 'conflicting' ? 'error' : undefined} data-forge-review-merge="">
        <div className={css.statusRows}>
          <MergeStateRow entry={frame} snapshot={snapshot} updateBranch={actions.updateBranch} t={t} />
        </div>
      </div>
      {/* A new head starts both blocks afresh: their folds, and the checks read for the previous head. */}
      <Checks key={`checks:${snapshot.headSha}`} frame={frame} snapshot={snapshot} actions={actions} t={t} />
      <Reviewers key={`reviewers:${snapshot.headSha}`} frame={frame} snapshot={snapshot} actions={actions} t={t} />
      <div className={css.statusCard} data-forge-review-changes="">
        <div className={css.statusRows}>
          {changes}
          <IssuesRow snapshot={snapshot} openLink={actions.openLink} t={t} />
        </div>
      </div>
    </>
  )
}
