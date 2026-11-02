/**
 * One change request as a card: its title links to the host, a one-line
 * summary shows while collapsed, and while expanded one row per fact (checks,
 * review, merge state, and the changed lines, which open its changes) above
 * the ready-for-review or merge action.
 */

import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular, IconCopyOutlineRegular,
  IconListPenOutlineRegular, IconRightUpOutlineRegular, IconUserOutlineRegular, Menu, MenuItemButton, StateDot, Tooltip,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ChangeRequestCheck, ChangeRequestSnapshot, CheckState, ChecksRollup, ForgeFailure, MergeMethod, MergeRequest,
} from '@deepseek-ai/dsh-experimental-forge/types'
import type { ForgePanelChangeRequest } from '../types.ts'
import { formatAgo, formatDuration } from './format.ts'
import { ChangeRequestGlyph, CheckGlyph } from './glyphs.tsx'
import type { ForgePanelKey, NS } from './locales.ts'
import { checkCounts, checkDuration, ciSummary, flagOf, numberOf, TONE_LABEL, toneOf } from './status.ts'
import css from './ForgeTab.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** What a card can do; a surface without a Session binding omits `remove`, `markReady`, `merge`, and `viewChanges`. */
export interface ChangeRequestActions {
  /** Open a URL outside the app. */
  readonly openLink: (url: string) => void
  /** Copy a URL to the clipboard. */
  readonly copyLink: (url: string) => void
  /** Read the status again after a failed read. */
  readonly retry: () => void
  /** Remove the change request from its Session. */
  readonly remove?: ((entry: ForgePanelChangeRequest) => void) | undefined
  /** Mark a draft ready for review; settles once the outcome is reported. */
  readonly markReady?: ((entry: ForgePanelChangeRequest) => Promise<void>) | undefined
  /** Merge the change request as `request` describes; settles once the outcome is reported. */
  readonly merge?: ((entry: ForgePanelChangeRequest, request: MergeRequest) => Promise<void>) | undefined
  /** Load complete check details independently of polling; cancellation follows the open list. */
  readonly readChecks?: ((url: string, headSha: string, signal: AbortSignal) => Promise<ChangeRequestSnapshot>) | undefined
  /** Open the changes view of the change request. */
  readonly viewChanges?: ((entry: ForgePanelChangeRequest) => void) | undefined
}

/** Props of one change request card. */
export interface ChangeRequestCardProps {
  /** Change request with its latest snapshot and polling result. */
  readonly entry: ForgePanelChangeRequest
  /** Whether the details show. */
  readonly expanded: boolean
  /** Show or hide the details. */
  readonly onToggle: () => void
  /** Current epoch milliseconds for relative times. */
  readonly now: number
  /** Card actions. */
  readonly actions: ChangeRequestActions
  /** Active UI language for numeric formatting. */
  readonly locale: string
  /** Forge panel copy. */
  readonly t: Translate
}

const REVIEW: Record<ChangeRequestSnapshot['reviewDecision'], ForgePanelKey> = {
  'approved': 'change.review.approved',
  'changes-requested': 'change.review.changesRequested',
  'review-required': 'change.review.required',
  'none': 'change.review.none',
}

const FAILURE: Record<ForgeFailure['code'], ForgePanelKey> = {
  'not-found': 'change.failure.notFound',
  'unauthenticated': 'change.failure.unauthenticated',
  'too-large': 'change.failure.unavailable',
  'unavailable': 'change.failure.unavailable',
}

const ROLLUP: Record<ChecksRollup, CheckState> = {
  none: 'neutral',
  pending: 'pending',
  success: 'success',
  failure: 'failure',
}

const CHECK_RANK: Record<CheckState, number> = {
  failure: 0, pending: 1, success: 2, neutral: 3, skipped: 3, cancelled: 3,
}

function failureOf(entry: ForgePanelChangeRequest): ForgeFailure | undefined {
  return entry.update !== null && 'failure' in entry.update ? entry.update.failure : undefined
}

/** Failed checks first, then running ones, then the rest, each group in host order. */
function orderedChecks(checks: readonly ChangeRequestCheck[]): ChangeRequestCheck[] {
  return checks.toSorted((left, right) => CHECK_RANK[left.state] - CHECK_RANK[right.state])
}

function checkTime(check: ChangeRequestCheck, t: Translate): string {
  if (check.state === 'pending') return t(check.startedAt === null ? 'change.check.queued' : 'change.check.running')
  const elapsed = checkDuration(check)
  return elapsed === undefined ? '' : formatDuration(elapsed, t)
}

function DiffSize({ snapshot, locale }: { readonly snapshot: ChangeRequestSnapshot; readonly locale: string }): ReactNode {
  return (
    <span className={css.diff}>
      <span className={css.added}>{`+${snapshot.additions.toLocaleString(locale)}`}</span>
      <span className={css.deleted}>{`−${snapshot.deletions.toLocaleString(locale)}`}</span>
    </span>
  )
}

/** The changed lines, as a row that opens the changes view when the provider serves the change request. */
function ChangesRow({ entry, snapshot, name, actions, locale, t }: {
  readonly entry: ForgePanelChangeRequest
  readonly snapshot: ChangeRequestSnapshot
  readonly name: string
  readonly actions: ChangeRequestActions
  readonly locale: string
  readonly t: Translate
}): ReactNode {
  const { viewChanges } = actions
  const parts = (
    <>
      <span className={css.rowIcon}><IconListPenOutlineRegular size={16} /></span>
      <span className={css.rowLabel}>{t('change.row.changes')}</span>
      <span className={css.rowValue}><DiffSize snapshot={snapshot} locale={locale} /></span>
    </>
  )
  if (viewChanges === undefined || entry.ref === null) return <div className={css.row}>{parts}</div>
  return (
    <button
      type="button"
      className={clsx(css.row, css.rowButton)}
      aria-label={t('change.viewChangesAria', {
        name,
        added: snapshot.additions.toLocaleString(locale),
        deleted: snapshot.deletions.toLocaleString(locale),
      })}
      onClick={() => { viewChanges(entry) }}
    >
      {parts}
      <IconChevronRightOutlineRegular size={12} className={css.rowChevron} />
    </button>
  )
}

/** The merged or closed fact with its time, such as 已合并到 main · 2 小时前. */
function finished(snapshot: ChangeRequestSnapshot, now: number, t: Translate): string {
  const state = snapshot.state === 'merged' ? t('change.mergedTo', { base: snapshot.baseBranch }) : t('change.state.closed')
  const ago = snapshot.closedAt === null ? undefined : formatAgo(snapshot.closedAt, now, t)
  return ago === undefined ? state : t('time.finished', { state, time: ago })
}

/** Collapsed status after the number: checks and the most urgent flag, the merge or close time, or a read in progress. */
function Summary({ snapshot, now, t }: {
  readonly snapshot: ChangeRequestSnapshot | null
  readonly now: number
  readonly t: Translate
}): ReactNode {
  if (snapshot === null) return <StateDot state="ongoing" size={11} />
  if (snapshot.state !== 'open') {
    return <span className={css.finished} data-tone={snapshot.state}>{finished(snapshot, now, t)}</span>
  }
  const ci = ciSummary(snapshot)
  const flag = flagOf(snapshot)
  return (
    <>
      <span className={css.ci} data-tone={ci.kind === 'failed' ? 'error' : undefined}>
        {ci.kind !== 'none' && <CheckGlyph state={ci.kind === 'cancelled' ? 'cancelled' : ROLLUP[snapshot.checksRollup]} size={12} />}
        {ci.kind === 'failed'
          ? ci.count > 0 ? t('change.ci.failed', { count: ci.count }) : t('change.ci.failedUnlisted')
          : ci.kind === 'cancelled' ? t('change.ci.cancelled', { count: ci.count }) : t(`change.ci.${ci.kind}`)}
      </span>
      {flag !== undefined && <span className={css.flag} data-flag={flag}>{t(`change.flag.${flag}`)}</span>}
    </>
  )
}

/** Expanded identity after the number: draft state and the head and base branches. */
function Target({ snapshot, t }: { readonly snapshot: ChangeRequestSnapshot; readonly t: Translate }): ReactNode {
  return (
    <>
      {snapshot.state === 'open' && snapshot.draft && <span>{t('change.state.draft')}</span>}
      <span className={css.ellipsis}>{`${snapshot.headBranch} → ${snapshot.baseBranch}`}</span>
    </>
  )
}

type CheckRead = { readonly kind: 'idle' | 'loading' }
  | { readonly kind: 'ready'; readonly snapshot: ChangeRequestSnapshot }
  | { readonly kind: 'failed'; readonly message: string }

function ChecksRow({ snapshot, openLink, readChecks, t }: {
  readonly snapshot: ChangeRequestSnapshot
  readonly openLink: (url: string) => void
  readonly readChecks: ChangeRequestActions['readChecks']
  readonly t: Translate
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [read, setRead] = useState<CheckRead>({ kind: 'idle' })
  const [attempt, setAttempt] = useState(0)
  const { url, headSha, checksTruncated } = snapshot
  useEffect(() => {
    if (!open || !checksTruncated || readChecks === undefined) { setRead({ kind: 'idle' }); return }
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
  }, [open, url, headSha, checksTruncated, readChecks, attempt])
  const displayed = read.kind === 'ready' && read.snapshot.headSha === headSha ? read.snapshot : snapshot
  if (displayed.checks.length === 0 && !displayed.checksTruncated) {
    return (
      <div className={css.row}>
        <span className={css.rowIcon}><CheckGlyph state="neutral" /></span>
        <span className={css.rowLabel}>{t('change.row.checks')}</span>
        <span className={css.rowValue}>{t('change.ci.none')}</span>
      </div>
    )
  }
  const counts = checkCounts(displayed.checks)
  const summary = displayed.checksTruncated ? t('change.checks.truncated', { count: displayed.checks.length }) : [
    ...counts.failed > 0 ? [t('change.checks.failed', { count: counts.failed })] : [],
    ...counts.running > 0 ? [t('change.checks.running', { count: counts.running })] : [],
    ...counts.passed > 0 ? [t('change.checks.passed', { count: counts.passed })] : [],
    ...counts.cancelled > 0 ? [t('change.checks.cancelled', { count: counts.cancelled })] : [],
    ...counts.other > 0 ? [t('change.checks.other', { count: counts.other })] : [],
  ].join(' · ')
  const close = (): void => { setOpen(false) }
  const footer: MenuEntry[] = displayed.checksTruncated
    ? [{ type: 'label', id: 'truncated', text: t('change.checks.truncated', { count: displayed.checks.length }) }] : []
  if (read.kind === 'loading') footer.push({ id: 'loading', label: t('change.checks.loading'), disabled: true, icon: <StateDot state="ongoing" size={14} /> })
  if (read.kind === 'failed') {
    footer.push({ type: 'label', id: 'failed', text: t('change.checks.loadFailed', { message: read.message }) },
      { id: 'retry', label: t('change.checks.retry') })
  }
  return (
    <Menu
      open={open}
      onClose={close}
      portal
      dense
      className={css.checksAnchor}
      listClassName={css.checksList}
      anchor={(
        <button type="button" className={clsx(css.row, css.rowButton)} aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open) }}>
          <span className={css.rowIcon}><CheckGlyph state={ROLLUP[displayed.checksRollup]} /></span>
          <span className={css.rowLabel}>{t('change.row.checks')}</span>
          <span className={css.rowValue} data-tone={!displayed.checksTruncated && counts.failed > 0 ? 'error' : undefined}>
            <span className={css.ellipsis}>{summary}</span>
          </span>
          <IconChevronRightOutlineRegular size={12} className={css.rowChevron} />
        </button>
      )}
      footer={footer}
      onSelect={() => { setAttempt(value => value + 1) }}
    >
      {orderedChecks(displayed.checks).map((check, index) => {
        const { url } = check
        return (
          <MenuItemButton
            // The list is replaced as a whole with each snapshot, and check names can repeat.
            key={index}
            icon={<CheckGlyph state={check.state} />}
            disabled={url === null}
            onSelect={url === null ? close : () => {
              close()
              openLink(url)
            }}
          >
            <span className={css.checkItem}>
              <span className={css.ellipsis}>{check.name}</span>
              <span className={css.checkTime}>{checkTime(check, t)}</span>
            </span>
          </MenuItemButton>
        )
      })}
    </Menu>
  )
}

/** The merge button and its menu: a title row, one row per method with the chosen one checked, and the confirmation. */
function MergeMenu({ snapshot, name, usual, busy, onMerge, t }: {
  readonly snapshot: ChangeRequestSnapshot
  readonly name: string
  readonly usual: MergeMethod
  readonly busy: boolean
  readonly onMerge: (method: MergeMethod, headSha: string) => void
  readonly t: Translate
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [confirmedHead, setConfirmedHead] = useState(snapshot.headSha)
  const [chosen, setChosen] = useState<string>(usual)
  const stale = confirmedHead !== snapshot.headSha
  // The methods can change between polls; a choice the repository no longer allows falls back to the usual one.
  const method = snapshot.mergeMethods.find(entry => entry === chosen) ?? usual
  const close = (): void => { setOpen(false) }
  const base = snapshot.baseBranch
  const items: MenuEntry[] = [
    { type: 'label', id: 'title', text: t('change.mergeTitle', { name, base }) },
    ...snapshot.mergeMethods.map(entry => ({
      id: entry,
      label: (
        <span className={css.method}>
          <span>{t(`change.mergeMethod.${entry}`)}</span>
          <span className={css.methodNote}>{t(`change.mergeNote.${entry}`, { base })}</span>
        </span>
      ),
    })),
  ]
  return (
    <Menu
      open={open}
      onClose={close}
      portal
      align="end"
      anchor={(
        <Button
          size="sm"
          variant="primary"
          className={css.primaryAction}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={busy}
          onClick={() => {
            if (!open) setConfirmedHead(snapshot.headSha)
            setOpen(!open)
          }}
        >
          {t('change.merge')}
          <IconChevronDownOutlineRegular size={12} className={clsx(css.chevron, open && css.chevronOpen)} />
        </Button>
      )}
      items={items}
      selectedId={method}
      onSelect={setChosen}
    >
      <MenuItemButton
        separatorBefore
        disabled={stale}
        onSelect={() => {
          close()
          onMerge(method, confirmedHead)
        }}
      >
        {t(stale ? 'change.mergeChanged' : 'change.mergeConfirm')}
      </MenuItemButton>
    </Menu>
  )
}

/** The footer with the action of an open change request: mark a draft ready, or merge one the host would merge now. */
function Primary({ entry, snapshot, name, actions, t }: {
  readonly entry: ForgePanelChangeRequest
  readonly snapshot: ChangeRequestSnapshot
  readonly name: string
  readonly actions: ChangeRequestActions
  readonly t: Translate
}): ReactNode {
  // One request at a time: the action stays disabled until the previous one settles.
  const [busy, setBusy] = useState(false)
  const run = (action: () => Promise<void>): void => {
    setBusy(true)
    void action().finally(() => { setBusy(false) })
  }
  const { markReady, merge } = actions
  if (snapshot.state !== 'open') return null
  if (snapshot.draft) {
    if (markReady === undefined) return null
    return (
      <div className={css.footer}>
        <Button size="sm" variant="outline" className={css.primaryAction} disabled={busy} onClick={() => { run(() => markReady(entry)) }}>
          {t('change.markReady')}
        </Button>
      </div>
    )
  }
  const [usual] = snapshot.mergeMethods
  if (!snapshot.mergeReady || usual === undefined || merge === undefined) return null
  return (
    <div className={css.footer}>
      <MergeMenu
        snapshot={snapshot}
        name={name}
        usual={usual}
        busy={busy}
        onMerge={(method, headSha) => { run(() => merge(entry, { method, headSha })) }}
        t={t}
      />
    </div>
  )
}

function Details({ entry, snapshot, name, now, actions, locale, t }: {
  readonly entry: ForgePanelChangeRequest
  readonly snapshot: ChangeRequestSnapshot
  readonly name: string
  readonly now: number
  readonly actions: ChangeRequestActions
  readonly locale: string
  readonly t: Translate
}): ReactNode {
  const changes = <ChangesRow entry={entry} snapshot={snapshot} name={name} actions={actions} locale={locale} t={t} />
  if (snapshot.state !== 'open') {
    return (
      <div className={css.rows}>
        <div className={css.row}>
          <span className={css.rowIcon}><ChangeRequestGlyph tone={snapshot.state} tinted={false} size={16} /></span>
          <span className={clsx(css.rowValue, css.rowWide)} data-tone={snapshot.state}>{finished(snapshot, now, t)}</span>
        </div>
        {changes}
      </div>
    )
  }
  const review = t(REVIEW[snapshot.reviewDecision])
  const reviewTone = snapshot.reviewDecision === 'changes-requested' ? 'error' : snapshot.reviewDecision === 'approved' ? 'success' : undefined
  const merge = snapshot.mergeability === 'mergeable'
    ? t('change.merge.mergeable')
    : snapshot.mergeability === 'conflicting' ? t('change.merge.conflicting', { base: snapshot.baseBranch }) : t('change.merge.unknown')
  return (
    <div className={css.rows}>
      <ChecksRow key={snapshot.headSha} snapshot={snapshot} openLink={actions.openLink} readChecks={actions.readChecks} t={t} />
      <div className={css.row}>
        <span className={css.rowIcon}><IconUserOutlineRegular size={16} /></span>
        <span className={css.rowLabel}>{t('change.row.review')}</span>
        <span className={css.rowValue} data-tone={reviewTone}>
          {snapshot.unresolvedThreads > 0 ? t('change.review.threads', { review, count: snapshot.unresolvedThreads }) : review}
        </span>
      </div>
      <div className={css.row}>
        <span className={css.rowIcon}><ChangeRequestGlyph tone="merged" tinted={false} size={16} /></span>
        <span className={css.rowLabel}>{t('change.row.merge')}</span>
        <span className={css.rowValue} data-tone={snapshot.mergeability === 'conflicting' ? 'error' : undefined}>{merge}</span>
      </div>
      {changes}
    </div>
  )
}

/**
 * Render one change request.
 * @param props - change request, expansion, current time, actions, and copy.
 * @returns the card.
 */
export function ChangeRequestCard({ entry, expanded, onToggle, now, actions, locale, t }: ChangeRequestCardProps): ReactNode {
  const snapshot = entry.snapshot
  const number = numberOf(entry)
  const url = snapshot?.url ?? entry.url
  const failure = failureOf(entry)
  const notice = entry.ref === null ? 'change.unserved' : failure === undefined ? undefined : FAILURE[failure.code]
  const tone = toneOf(snapshot)
  const name = number === null ? snapshot?.title ?? url : t('change.number', { number })
  // A notice replaces the collapsed summary, so a failed read never shows its stale status beside it.
  const meta = expanded
    ? snapshot === null ? null : <Target snapshot={snapshot} t={t} />
    : notice === undefined ? <Summary snapshot={snapshot} now={now} t={t} /> : null
  const { remove } = actions
  return (
    <li className={css.change} data-forge-change={entry.url} data-expanded={expanded ? '' : undefined}>
      <div className={css.changeHead}>
        <ChangeRequestGlyph tone={tone} size={16} label={t('change.stateAria', { state: t(TONE_LABEL[tone]) })} />
        <div className={css.headText}>
          <a
            className={css.changeTitle}
            href={url}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              event.preventDefault()
              actions.openLink(url)
            }}
          >
            {snapshot?.title ?? url.replace(/^https?:\/\//i, '')}
          </a>
          {(number !== null || meta !== null) && (
            <div className={css.meta}>
              {number !== null && <span>{t('change.number', { number })}</span>}
              {number !== null && meta !== null && <span aria-hidden="true">·</span>}
              {meta}
            </div>
          )}
        </div>
        <Tooltip label={t('change.view')} side="top">
          <button type="button" className={css.iconButton} aria-label={t('change.view')} onClick={() => { actions.openLink(url) }}>
            <IconRightUpOutlineRegular size={14} />
          </button>
        </Tooltip>
        <Tooltip label={t('change.copy')} side="top">
          <button type="button" className={css.iconButton} aria-label={t('change.copy')} onClick={() => { actions.copyLink(url) }}>
            <IconCopyOutlineRegular size={14} />
          </button>
        </Tooltip>
        {remove !== undefined && (
          <Tooltip label={t('change.remove')} side="top">
            <button type="button" className={css.iconButton} aria-label={t('change.removeAria', { name })} onClick={() => { remove(entry) }}>
              <IconCloseOutlineRegular size={14} />
            </button>
          </Tooltip>
        )}
        <button
          type="button"
          className={css.iconButton}
          aria-expanded={expanded}
          aria-label={t(expanded ? 'change.collapse' : 'change.expand', { name })}
          onClick={onToggle}
        >
          <IconChevronDownOutlineRegular size={12} className={clsx(css.chevron, expanded && css.chevronOpen)} />
        </button>
      </div>
      {notice !== undefined && (
        <div className={css.notice}>
          <span>{t(notice)}</span>
          {entry.ref === null
            ? <Button size="sm" variant="outline" onClick={() => { actions.openLink(url) }}>{t('change.view')}</Button>
            : <Button size="sm" variant="outline" onClick={actions.retry}>{t('retry')}</Button>}
        </div>
      )}
      {expanded && snapshot !== null && (
        <Details entry={entry} snapshot={snapshot} name={name} now={now} actions={actions} locale={locale} t={t} />
      )}
      {expanded && snapshot !== null && <Primary entry={entry} snapshot={snapshot} name={name} actions={actions} t={t} />}
    </li>
  )
}
