/**
 * One change request as a card: its one-line title links to the host and
 * crawls into view while the pointer rests on the card's head, a one-line
 * summary shows while collapsed, and while expanded one row per fact (checks,
 * review, merge state, the changed lines, which open its changes, and the
 * linked issues) above the merge action. Opening, copying, viewing changes,
 * marking a draft ready, and removing live in the card's actions menu.
 */

import { useId, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckCircleOutlineRegular, IconChevronDownOutlineRegular, IconCloseOutlineRegular, IconCopyOutlineRegular,
  IconEllipsisOutlineRegular, IconFilesDiffOutlineRegular, IconRightUpOutlineRegular, IconTriangleRightFillRegular, MarqueeText, Menu,
  MenuItemButton, StateDot, Tooltip, useHoverMarquee,
  type MenuEntry, type MenuItem,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ChangeRequestSnapshot, CheckState, ChecksRollup, ForgeFailure, MergeMethod, MergeRequest,
} from '@deepseek-ai/dsh-experimental-forge/types'
import type { ForgePanelChangeRequest } from '../types.ts'
import { ChecksRow, IssuesRow, MergeRow, ReviewRow, RowParts, ThreadGlyph, type OverviewActions } from './ChangeRequestOverview.tsx'
import { formatAgo } from './format.ts'
import { ChangeRequestGlyph, CheckGlyph } from './glyphs.tsx'
import type { ForgePanelKey, NS } from './locales.ts'
import type { ForgeChangeRequestCardActionsProps } from './slots.ts'
import { ciSummary, flagOf, numberOf, TONE_LABEL, toneOf } from './status.ts'
import css from './Forge.module.css'

type Translate = PropsLocale<typeof NS>['t']

/**
 * What a card can do; a surface without a Session binding omits `remove`, `markReady`, `merge`, `viewChanges`, and the
 * overview actions.
 */
export interface ChangeRequestActions extends OverviewActions {
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
  /** Draw the icon buttons plugins add to the card's head through `forge.change-request.card.actions`. */
  readonly renderActions?: ((owner: ForgeChangeRequestCardActionsProps) => ReactNode) | undefined
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
  'stale': 'change.failure.unavailable',
  'unsupported': 'change.failure.unavailable',
  'unavailable': 'change.failure.unavailable',
}

const ROLLUP: Record<ChecksRollup, CheckState> = {
  none: 'neutral',
  pending: 'pending',
  success: 'success',
  failure: 'failure',
}

/** The unresolved thread count, with `+` when the provider counted only some threads. */
function threadCount(snapshot: ChangeRequestSnapshot, locale: string): string {
  const count = snapshot.unresolvedThreads.toLocaleString(locale)
  return snapshot.threadsTruncated ? `${count}+` : count
}

function failureOf(entry: ForgePanelChangeRequest): ForgeFailure | undefined {
  return entry.update !== null && 'failure' in entry.update ? entry.update.failure : undefined
}

function DiffSize({ snapshot, locale }: { readonly snapshot: ChangeRequestSnapshot; readonly locale: string }): ReactNode {
  return (
    <span className={css.diff}>
      <span className={css.added}>{`+${snapshot.additions.toLocaleString(locale)}`}</span>
      <span className={css.deleted}>{`−${snapshot.deletions.toLocaleString(locale)}`}</span>
    </span>
  )
}

/**
 * The changed lines with the unresolved review thread count, as a row that opens the changes view when the provider
 * serves the change request.
 */
function ChangesRow({ entry, snapshot, name, actions, locale, t }: {
  readonly entry: ForgePanelChangeRequest
  readonly snapshot: ChangeRequestSnapshot
  readonly name: string
  readonly actions: ChangeRequestActions
  readonly locale: string
  readonly t: Translate
}): ReactNode {
  const { viewChanges } = actions
  const described = useId()
  const threads = snapshot.unresolvedThreads > 0 || snapshot.threadsTruncated ? threadCount(snapshot, locale) : undefined
  const threadsText = threads === undefined ? undefined : t('change.threads', { count: threads })
  const trailing = threadsText === undefined ? undefined : (
    <Tooltip label={threadsText} side="top" delayMs={500}>
      <span className={css.threads} data-forge-threads={threads} aria-hidden="true"><ThreadGlyph size={14} />{threads}</span>
    </Tooltip>
  )
  const opens = viewChanges !== undefined && entry.ref !== null
  // The count shows only a number, so the threads are named in full for assistive technology.
  const parts = (
    <>
      <RowParts label={t('change.row.changes')} icon={<IconFilesDiffOutlineRegular size={16} />}
        value={<DiffSize snapshot={snapshot} locale={locale} />} trailing={trailing} opens={opens} />
      {threadsText !== undefined && <span id={described} className={css.visuallyHidden}>{threadsText}</span>}
    </>
  )
  if (!opens) return <div className={css.row}>{parts}</div>
  return (
    <button
      type="button"
      className={clsx(css.row, css.rowButton)}
      aria-label={t('change.viewChangesAria', {
        name,
        added: snapshot.additions.toLocaleString(locale),
        deleted: snapshot.deletions.toLocaleString(locale),
      })}
      aria-describedby={threadsText === undefined ? undefined : described}
      onClick={() => { viewChanges(entry) }}
    >
      {parts}
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
          className={clsx(css.primaryAction, css.mergeAction)}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={busy}
          onClick={() => {
            if (!open) setConfirmedHead(snapshot.headSha)
            setOpen(!open)
          }}
        >
          {t('change.merge')}
          <IconTriangleRightFillRegular size={10} className={clsx(css.mergeCaret, open && css.mergeCaretOpen)} />
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

/** The footer with the merge action of an open change request the host would merge now. */
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
  const { merge } = actions
  if (snapshot.state !== 'open' || snapshot.draft) return null
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

/**
 * The card's actions menu: open on the host, copy the link, view the changes
 * of a served change request, mark an open draft ready, and remove the binding.
 */
function CardMenu({ entry, snapshot, name, url, actions, t }: {
  readonly entry: ForgePanelChangeRequest
  readonly snapshot: ChangeRequestSnapshot | null
  readonly name: string
  readonly url: string
  readonly actions: ChangeRequestActions
  readonly t: Translate
}): ReactNode {
  const [open, setOpen] = useState(false)
  // One ready request at a time: the item stays disabled until the previous one settles.
  const [busy, setBusy] = useState(false)
  const { remove, markReady, viewChanges } = actions
  const ready = markReady !== undefined && snapshot?.state === 'open' && snapshot.draft
    ? () => {
      setBusy(true)
      void markReady(entry).finally(() => { setBusy(false) })
    }
    : undefined
  // Each item carries the action it runs, so a selection never reaches another item's action.
  const choices: { readonly item: MenuItem; readonly run: () => void }[] = [
    { item: { id: 'open', label: t('change.view'), icon: <IconRightUpOutlineRegular size={14} /> }, run: () => { actions.openLink(url) } },
    { item: { id: 'copy', label: t('change.copy'), icon: <IconCopyOutlineRegular size={14} /> }, run: () => { actions.copyLink(url) } },
    ...viewChanges !== undefined && snapshot !== null && entry.ref !== null ? [{
      item: { id: 'changes', label: t('change.viewChanges'), icon: <IconFilesDiffOutlineRegular size={14} /> },
      run: () => { viewChanges(entry) },
    }] : [],
    ...ready === undefined ? [] : [{
      item: { id: 'ready', label: t('change.markReady'), icon: <IconCheckCircleOutlineRegular size={14} />, disabled: busy },
      run: ready,
    }],
    ...remove === undefined ? [] : [{
      item: { id: 'remove', label: t('change.remove'), icon: <IconCloseOutlineRegular size={14} />, danger: true },
      run: () => { remove(entry) },
    }],
  ]
  // Removing sits apart from the other actions.
  const items: MenuEntry[] = choices.flatMap(({ item }) => item.id === 'remove'
    ? [{ type: 'separator' as const, id: 'remove-separator' }, item] : [item])
  const select = (id: string): void => {
    setOpen(false)
    for (const choice of choices) if (choice.item.id === id) choice.run()
  }
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      portal
      align="end"
      anchor={(
        <button
          type="button"
          className={`${css.iconButton} ${css.moreButton}`}
          aria-label={t('change.actions', { name })}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => { setOpen(!open) }}
        >
          <IconEllipsisOutlineRegular size={14} />
        </button>
      )}
      items={items}
      onSelect={select}
    />
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
          <RowParts label={undefined} icon={<ChangeRequestGlyph tone={snapshot.state} tinted={false} size={16} />}
            value={finished(snapshot, now, t)} tone={snapshot.state} opens={false} />
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
      <ChecksRow key={snapshot.headSha} entry={entry} snapshot={snapshot} openLink={actions.openLink} readChecks={actions.readChecks}
        rerunChecks={actions.rerunChecks} t={t} />
      <ReviewRow entry={entry} snapshot={snapshot} tone={reviewTone} openLink={actions.openLink} value={review}
        requestReviews={actions.requestReviews} reviewerCandidates={actions.reviewerCandidates} t={t} />
      <MergeRow entry={entry} snapshot={snapshot} value={merge} updateBranch={actions.updateBranch}
        icon={<ChangeRequestGlyph tone="merged" tinted={false} size={16} />}
        tone={snapshot.mergeability === 'conflicting' ? 'error' : undefined} t={t} />
      {changes}
      <IssuesRow snapshot={snapshot} openLink={actions.openLink} t={t} />
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
  const titleRef = useRef<HTMLSpanElement>(null)
  const marquee = useHoverMarquee(titleRef)
  // A notice replaces the collapsed summary, so a failed read never shows its stale status beside it.
  const meta = expanded
    ? snapshot === null ? null : <Target snapshot={snapshot} t={t} />
    : notice === undefined ? <Summary snapshot={snapshot} now={now} t={t} /> : null
  return (
    <li className={css.change} data-forge-change={entry.url} data-expanded={expanded ? '' : undefined}>
      <div className={css.changeHead} {...marquee}>
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
            <MarqueeText ref={titleRef}>{snapshot?.title ?? url.replace(/^https?:\/\//i, '')}</MarqueeText>
          </a>
          {(number !== null || meta !== null) && (
            <div className={css.meta}>
              {number !== null && <span>{t('change.number', { number })}</span>}
              {number !== null && meta !== null && <span aria-hidden="true">·</span>}
              {meta}
            </div>
          )}
        </div>
        {actions.renderActions?.({ url: entry.url, ref: entry.ref, headSha: snapshot?.headSha ?? null, state: snapshot?.state ?? null })}
        <CardMenu entry={entry} snapshot={snapshot} name={name} url={url} actions={actions} t={t} />
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
