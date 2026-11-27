/**
 * One change request as a compact card of the Session panel: one line with
 * the state glyph, the title, the number, and the checks outcome, which opens
 * the changes view, and, while expanded, one row per fact (checks, review,
 * merge state, the changed lines, which open its changes too, and the linked
 * issues) above the merge action, which merges now, turns the host's automatic
 * merge on, or shows that it is on. Opening on the host, copying, viewing
 * changes, marking a draft ready, and removing live in the card's actions
 * menu, which shows on hover or focus as on the panel's other rows.
 */

import { useId, useState, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, HoverCard, IconCheckCircleOutlineRegular, IconChevronDownOutlineRegular, IconClockOutlineRegular, IconCloseOutlineRegular,
  IconCopyOutlineRegular, IconEllipsisOutlineRegular, IconFilesDiffOutlineRegular, IconTriangleRightFillRegular, Menu,
  MenuItemButton, StateDot, Tooltip,
  type MenuEntry, type MenuItem, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { PanelDetailsProps } from '@deepseek-ai/dsh-client-ui-session-panel/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots/client'
import type {
  AutoMergeRequest, ChangeRequestAutoMerge, ChangeRequestSnapshot, CheckState, ChecksRollup, ForgeFailure, MergeMethod, MergeRequest,
} from '@deepseek-ai/dsh-experimental-forge/types'
import type { ForgePanelChangeRequest } from '../types.ts'
import { ChecksRow, IssuesRow, MergeRow, ReviewRow, RowParts, ThreadGlyph, type OverviewActions } from './ChangeRequestOverview.tsx'
import { openOnLabel } from './forge-copy.ts'
import { formatAgo } from './format.ts'
import { ChangeRequestGlyph, CheckGlyph, ForgeGlyph } from './glyphs.tsx'
import type { ForgePanelKey, NS } from './locales.ts'
import type { ForgeChangeRequestCardActionsProps } from './slots.ts'
import {
  ciSummary, flagOf, mergeBlockers, numberOf, TONE_LABEL, toneOf, type ChangeRequestEntry, type ChangeRequestTone,
} from './status.ts'
import css from './Forge.module.css'

type Translate = PropsLocale<typeof NS>['t']

/**
 * What a card can do; a surface without a Session binding omits `remove`, `markReady`, `merge`, `autoMerge`,
 * `viewChanges`, and the overview actions.
 */
export interface ChangeRequestActions extends OverviewActions {
  /** Open a URL outside the app. */
  readonly openLink: (url: string) => void
  /** Copy a URL to the clipboard. */
  readonly copyLink: (url: string) => void
  /** Read the status again; a surface that knows when the read ends returns a promise that settles then. */
  readonly retry: () => void | Promise<void>
  /** Remove the change request from its Session. */
  readonly remove?: ((entry: ChangeRequestEntry) => void) | undefined
  /** Mark a draft ready for review; settles once the outcome is reported. */
  readonly markReady?: ((entry: ChangeRequestEntry) => Promise<void>) | undefined
  /** Merge the change request as `request` describes; settles once the outcome is reported. */
  readonly merge?: ((entry: ChangeRequestEntry, request: MergeRequest) => Promise<void>) | undefined
  /** Turn the code host's automatic merge on or off as `request` describes; settles once the outcome is reported. */
  readonly autoMerge?: ((entry: ChangeRequestEntry, request: AutoMergeRequest) => Promise<void>) | undefined
  /** Load complete check details independently of polling; cancellation follows the open list. */
  readonly readChecks?: ((url: string, headSha: string, signal: AbortSignal) => Promise<ChangeRequestSnapshot>) | undefined
  /** Open the changes view of the change request. */
  readonly viewChanges?: ((entry: ChangeRequestEntry) => void) | undefined
  /** Draw the icon buttons plugins add to the card's head through `forge.change-request.card.actions`. */
  readonly renderActions?: ((owner: ForgeChangeRequestCardActionsProps) => ReactNode) | undefined
  /**
   * Draw the content of the card's hover card, as the Session panel's rows do. A surface without it shows none.
   */
  readonly renderDetails?: ((details: PanelDetailsProps) => ReactNode) | undefined
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
  /** Whether the page's primary pointer is coarse, which keeps the reviewer search from focusing its field. */
  readonly coarsePointer: boolean
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
  'rate-limited': 'change.failure.rateLimited',
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
 * Render the changed lines with the unresolved review thread count, as a row that opens the changes view when the
 * provider serves the change request.
 * @param props - the change request, its snapshot, how the row names it, the actions, the number locale, and copy.
 * @returns the row.
 */
export function ChangesRow({ entry, snapshot, name, actions, locale, t }: {
  readonly entry: ChangeRequestEntry
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

/**
 * The checks outcome after the number: a spinner before the first read, the combined outcome of an open change
 * request that has checks, and nothing for a finished one, whose glyph already says how it ended.
 */
function Mark({ snapshot }: { readonly snapshot: ChangeRequestSnapshot | null }): ReactNode {
  if (snapshot === null) return <StateDot state="ongoing" size={12} />
  if (snapshot.state !== 'open') return null
  const ci = ciSummary(snapshot)
  if (ci.kind === 'none') return null
  return <CheckGlyph state={ci.kind === 'cancelled' ? 'cancelled' : ROLLUP[snapshot.checksRollup]} size={12} />
}

/**
 * The status in words: the checks and the most urgent flag of an open change request, or the merge or close time.
 * The card's line shows it as glyphs, so assistive technology and the hover card read it here.
 * @param snapshot - change request status.
 * @param now - current epoch milliseconds for the relative time.
 * @param t - copy.
 * @returns the status text.
 */
function statusText(snapshot: ChangeRequestSnapshot, now: number, t: Translate): string {
  if (snapshot.state !== 'open') return finished(snapshot, now, t)
  const ci = ciSummary(snapshot)
  const checks = ci.kind === 'failed'
    ? ci.count > 0 ? t('change.ci.failed', { count: ci.count }) : t('change.ci.failedUnlisted')
    : ci.kind === 'cancelled' ? t('change.ci.cancelled', { count: ci.count }) : t(`change.ci.${ci.kind}`)
  const flag = flagOf(snapshot)
  return flag === undefined ? checks : `${checks} · ${t(`change.flag.${flag}`)}`
}

/** The state dot of the hover card: red for what needs the user, and a spinner while the checks run. */
function dotOf(tone: ChangeRequestTone, snapshot: ChangeRequestSnapshot): StateDotState {
  if (tone === 'blocked') return 'error'
  if (snapshot.state !== 'open') return snapshot.state === 'merged' ? 'done' : 'idle'
  return snapshot.checksRollup === 'pending' ? 'ongoing' : snapshot.checksRollup === 'success' ? 'done' : 'idle'
}

/** The hover card's line under the title: the number, draft state, and the head and base branches. */
function identity(number: number | null, snapshot: ChangeRequestSnapshot | null, t: Translate): string[] {
  const parts = [
    ...number === null ? [] : [t('change.number', { number })],
    ...snapshot?.state === 'open' && snapshot.draft ? [t('change.state.draft')] : [],
    ...snapshot === null ? [] : [`${snapshot.headBranch} → ${snapshot.baseBranch}`],
  ]
  return parts.length === 0 ? [] : [parts.join(' · ')]
}

/**
 * The merge button and its menu: a title row, one row per method with the chosen one checked, and the confirmation.
 * With `auto` it is the button that turns the host's automatic merge on instead, which asks for the same two things.
 */
function MergeMenu({ snapshot, name, usual, busy, auto = false, onMerge, t }: {
  readonly snapshot: ChangeRequestSnapshot
  readonly name: string
  readonly usual: MergeMethod
  readonly busy: boolean
  readonly auto?: boolean
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
    { type: 'label', id: 'title', text: t(auto ? 'change.autoMergeTitle' : 'change.mergeTitle', { name, base }) },
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
          variant={auto ? 'outline' : 'primary'}
          className={clsx(css.primaryAction, auto ? css.autoMergeAction : css.mergeAction)}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={busy}
          onClick={() => {
            if (!open) setConfirmedHead(snapshot.headSha)
            setOpen(!open)
          }}
        >
          {auto && <IconClockOutlineRegular size={14} />}
          {t(auto ? 'change.autoMerge' : 'change.merge')}
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
        {t(stale ? 'change.mergeChanged' : auto ? 'change.autoMergeConfirm' : 'change.mergeConfirm')}
      </MenuItemButton>
    </Menu>
  )
}

/**
 * The button of a change request whose automatic merge is on, and its menu: where it merges, how and by whom when the
 * host names them, and the cancellation when the signed-in user may cancel.
 */
function AutoMergeStatus({ snapshot, autoMerge, busy, onCancel, t }: {
  readonly snapshot: ChangeRequestSnapshot
  readonly autoMerge: ChangeRequestAutoMerge
  readonly busy: boolean
  readonly onCancel: (() => void) | undefined
  readonly t: Translate
}): ReactNode {
  const [open, setOpen] = useState(false)
  const facts = [
    ...autoMerge.method === null ? [] : [t('change.autoMergeMethod', { method: t(`change.mergeMethod.${autoMerge.method}`) })],
    ...autoMerge.enabledBy === null ? [] : [t('change.autoMergeBy', { login: autoMerge.enabledBy })],
  ]
  const items: MenuEntry[] = [
    { type: 'label', id: 'title', text: t('change.autoMergeOnTitle', { base: snapshot.baseBranch }) },
    ...facts.length === 0 ? [] : [{ type: 'label' as const, id: 'facts', text: facts.join(' · ') }],
  ]
  const close = (): void => { setOpen(false) }
  return (
    <Menu
      open={open}
      onClose={close}
      portal
      align="end"
      anchor={(
        <Button size="sm" variant="outline" className={clsx(css.primaryAction, css.autoMergeAction)} data-forge-auto-merge="on"
          aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => { setOpen(!open) }}>
          <IconClockOutlineRegular size={14} />
          {t('change.autoMergeOn')}
          <IconTriangleRightFillRegular size={10} className={clsx(css.mergeCaret, open && css.mergeCaretOpen)} />
        </Button>
      )}
      items={items}
      onSelect={close}
    >
      {onCancel !== undefined && (
        <MenuItemButton separatorBefore onSelect={() => { close(); onCancel() }}>{t('change.autoMergeCancel')}</MenuItemButton>
      )}
    </Menu>
  )
}

/** The merge button of a change request its host would not merge now: it names why on hover and focus, and does nothing. */
function BlockedMerge({ snapshot, t }: { readonly snapshot: ChangeRequestSnapshot; readonly t: Translate }): ReactNode {
  const reason = mergeBlockers(snapshot).map(key => t(key)).join(t('issues.separator'))
  return (
    <Tooltip label={reason} side="bottom" align="end">
      <Button size="sm" variant="primary" className={clsx(css.primaryAction, css.mergeAction, css.unavailable)} aria-disabled="true"
        data-forge-merge-blocked="">
        {t('change.merge')}
      </Button>
    </Tooltip>
  )
}

/**
 * Render the merge action of an open change request that is not a draft: the merge when the host would merge now; the
 * state of its automatic merge with the cancellation when that is on; the button that turns the automatic merge on
 * when the signed-in user can; and, with `blocked`, a merge button that names why the host would not merge.
 * @param props.entry - the change request.
 * @param props.snapshot - its latest snapshot.
 * @param props.name - how menus name it.
 * @param props.actions - the actions the surface offers.
 * @param props.className - class of the wrapper, the card footer's by default.
 * @param props.blocked - whether a change request with none of the other actions shows the merge it cannot run.
 * @param props.t - forge panel copy.
 * @returns the action, or null for a change request with none.
 */
export function ChangeRequestPrimary({ entry, snapshot, name, actions, className = css.footer, blocked = false, t }: {
  readonly entry: ChangeRequestEntry
  readonly snapshot: ChangeRequestSnapshot
  readonly name: string
  readonly actions: ChangeRequestActions
  readonly className?: string | undefined
  readonly blocked?: boolean | undefined
  readonly t: Translate
}): ReactNode {
  // One request at a time: the action stays disabled until the previous one settles.
  const [busy, setBusy] = useState(false)
  const run = (action: () => Promise<void>): void => {
    setBusy(true)
    void action().finally(() => { setBusy(false) })
  }
  const { merge, autoMerge: setAutoMerge } = actions
  if (snapshot.state !== 'open' || snapshot.draft) return null
  const [usual] = snapshot.mergeMethods
  const auto = snapshot.autoMerge
  let action: ReactNode
  if (snapshot.mergeReady && usual !== undefined && merge !== undefined) {
    action = (
      <MergeMenu snapshot={snapshot} name={name} usual={usual} busy={busy} t={t}
        onMerge={(method, headSha) => { run(() => merge(entry, { method, headSha })) }} />
    )
  } else if (auto?.enabled === true) {
    const cancel = auto.canDisable && setAutoMerge !== undefined ? () => { run(() => setAutoMerge(entry, { enabled: false })) } : undefined
    action = <AutoMergeStatus snapshot={snapshot} autoMerge={auto} busy={busy} onCancel={cancel} t={t} />
  } else if (auto?.canEnable === true && usual !== undefined && setAutoMerge !== undefined) {
    action = (
      <MergeMenu auto snapshot={snapshot} name={name} usual={usual} busy={busy} t={t}
        onMerge={(method, headSha) => { run(() => setAutoMerge(entry, { enabled: true, method, headSha })) }} />
    )
  } else if (blocked) {
    action = <BlockedMerge snapshot={snapshot} t={t} />
  } else {
    return null
  }
  return <div className={className}>{action}</div>
}

/**
 * The card's actions menu: view the changes of a served change request, open
 * on the host, copy the link, mark an open draft ready, and remove the binding.
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
    ...viewChanges !== undefined && snapshot !== null && entry.ref !== null ? [{
      item: { id: 'changes', label: t('change.viewChanges'), icon: <IconFilesDiffOutlineRegular size={14} /> },
      run: () => { viewChanges(entry) },
    }] : [],
    {
      item: { id: 'open', label: openOnLabel(t, entry.forge?.label ?? null), icon: <ForgeGlyph forge={entry.forge?.forge ?? null} /> },
      run: () => { actions.openLink(url) },
    },
    { item: { id: 'copy', label: t('change.copy'), icon: <IconCopyOutlineRegular size={14} /> }, run: () => { actions.copyLink(url) } },
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
          aria-label={t('change.actions', { name })}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => { setOpen(!open) }}
        >
          <IconEllipsisOutlineRegular size={16} />
        </button>
      )}
      items={items}
      onSelect={select}
    />
  )
}

/**
 * Render the merged or closed fact of a finished change request with its time.
 * @param props - the snapshot, current epoch milliseconds for the relative time, and copy.
 * @returns the row.
 */
export function FinishedRow({ snapshot, now, t }: {
  readonly snapshot: ChangeRequestSnapshot
  readonly now: number
  readonly t: Translate
}): ReactNode {
  return (
    <div className={css.row}>
      <RowParts label={undefined} icon={<ChangeRequestGlyph tone={snapshot.state} tinted={false} size={16} />}
        value={finished(snapshot, now, t)} tone={snapshot.state} opens={false} />
    </div>
  )
}

/**
 * The aggregate review outcome of an open change request in words, with its tone.
 * @param snapshot - the snapshot.
 * @param t - forge panel copy.
 * @returns the outcome and its tone.
 */
export function reviewOutcome(
  snapshot: ChangeRequestSnapshot, t: Translate,
): { readonly value: string; readonly tone: string | undefined } {
  return {
    value: t(REVIEW[snapshot.reviewDecision]),
    tone: snapshot.reviewDecision === 'changes-requested' ? 'error' : snapshot.reviewDecision === 'approved' ? 'success' : undefined,
  }
}

/**
 * Render the merge state of an open change request: whether it conflicts with its base, and the branch update.
 * @param props - the change request, its snapshot, the update action, and copy.
 * @returns the row.
 */
export function MergeStateRow({ entry, snapshot, updateBranch, t }: {
  readonly entry: ChangeRequestEntry
  readonly snapshot: ChangeRequestSnapshot
  readonly updateBranch: ChangeRequestActions['updateBranch']
  readonly t: Translate
}): ReactNode {
  const merge = snapshot.mergeability === 'mergeable'
    ? t('change.merge.mergeable')
    : snapshot.mergeability === 'conflicting' ? t('change.merge.conflicting', { base: snapshot.baseBranch }) : t('change.merge.unknown')
  return (
    <MergeRow entry={entry} snapshot={snapshot} value={merge} updateBranch={updateBranch}
      icon={<ChangeRequestGlyph tone="merged" tinted={false} size={16} />}
      tone={snapshot.mergeability === 'conflicting' ? 'error' : undefined} t={t} />
  )
}

/**
 * The facts of a change request one row each: the merged or closed state, or the checks, review, and merge state;
 * the changed lines; and the linked issues.
 */
function Details({ entry, snapshot, name, now, actions, locale, coarsePointer, t }: {
  readonly entry: ChangeRequestEntry
  readonly snapshot: ChangeRequestSnapshot
  readonly name: string
  readonly now: number
  readonly actions: ChangeRequestActions
  readonly locale: string
  readonly coarsePointer: boolean
  readonly t: Translate
}): ReactNode {
  const changes = <ChangesRow entry={entry} snapshot={snapshot} name={name} actions={actions} locale={locale} t={t} />
  if (snapshot.state !== 'open') {
    return (
      <div className={css.rows}>
        <FinishedRow snapshot={snapshot} now={now} t={t} />
        {changes}
      </div>
    )
  }
  const review = reviewOutcome(snapshot, t)
  return (
    <div className={css.rows}>
      <ChecksRow key={snapshot.headSha} entry={entry} snapshot={snapshot} openLink={actions.openLink} readChecks={actions.readChecks}
        rerunChecks={actions.rerunChecks} t={t} />
      <ReviewRow entry={entry} snapshot={snapshot} tone={review.tone} openLink={actions.openLink} value={review.value}
        requestReviews={actions.requestReviews} reviewerCandidates={actions.reviewerCandidates} coarsePointer={coarsePointer} t={t} />
      <MergeStateRow entry={entry} snapshot={snapshot} updateBranch={actions.updateBranch} t={t} />
      {changes}
      <IssuesRow snapshot={snapshot} openLink={actions.openLink} t={t} />
    </div>
  )
}

/**
 * Render one change request. A press on the card's line opens the changes view of a change request a provider serves
 * and has read; with the platform's modifier key or the middle button, and for any other change request, it opens
 * the host's page. The line shows its status as glyphs and, while collapsed, reads it in words to assistive
 * technology, which the expanded rows do otherwise; the hover card names the full title, the branches, and that status.
 * @param props - change request, expansion, current time, actions, number locale, pointer accuracy, and copy.
 * @returns the card.
 */
export function ChangeRequestCard({
  entry, expanded, onToggle, now, actions, locale, coarsePointer, t,
}: ChangeRequestCardProps): ReactNode {
  const snapshot = entry.snapshot
  const number = numberOf(entry)
  const url = snapshot?.url ?? entry.url
  const failure = failureOf(entry)
  const notice = entry.ref === null ? 'change.unserved' : failure === undefined ? undefined : FAILURE[failure.code]
  const tone = toneOf(snapshot)
  const name = number === null ? snapshot?.title ?? url : t('change.number', { number })
  const title = snapshot?.title ?? url.replace(/^https?:\/\//i, '')
  // A notice replaces the status, so a failed read never reads its stale status beside it.
  const status: PanelDetailsProps['status'] = notice !== undefined
    ? { state: 'warning', label: t(notice) }
    : snapshot === null ? undefined : { state: dotOf(tone, snapshot), label: statusText(snapshot, now, t) }
  const viewChanges = snapshot !== null && entry.ref !== null ? actions.viewChanges : undefined
  const open = (event: MouseEvent): void => {
    if (viewChanges === undefined || event.metaKey || event.ctrlKey) actions.openLink(url)
    else viewChanges(entry)
  }
  const head = (
    <div className={css.changeHead} data-session-panel-row="">
      <button
        type="button"
        data-row-part="body"
        data-forge-opens={viewChanges === undefined ? 'link' : 'changes'}
        onClick={open}
        onAuxClick={(event) => { if (event.button === 1) actions.openLink(url) }}
      >
        <span data-row-part="icon">
          <ChangeRequestGlyph tone={tone} size={16} label={t('change.stateAria', { state: t(TONE_LABEL[tone]) })} />
        </span>
        <span data-row-part="content">{title}</span>
      </button>
      <span data-row-part="trailing" className={css.status}>
        {number !== null && <span className={css.number}>{t('change.number', { number })}</span>}
        {notice === undefined && <Mark snapshot={snapshot} />}
        {!expanded && notice === undefined && status !== undefined && <span className={css.visuallyHidden}>{status.label}</span>}
        {actions.renderActions?.({ url: entry.url, ref: entry.ref, headSha: snapshot?.headSha ?? null, state: snapshot?.state ?? null })}
      </span>
      <span data-row-part="menu">
        <CardMenu entry={entry} snapshot={snapshot} name={name} url={url} actions={actions} t={t} />
      </span>
      <span data-row-part="trailing" className={css.end}>
        <button
          type="button"
          className={css.expand}
          aria-expanded={expanded}
          aria-label={t(expanded ? 'change.collapse' : 'change.expand', { name })}
          onClick={onToggle}
        >
          <IconChevronDownOutlineRegular size={14} className={clsx(css.chevron, expanded && css.chevronOpen)} />
        </button>
      </span>
    </div>
  )
  const details = actions.renderDetails?.({
    title,
    lines: identity(number, snapshot, t),
    ...status === undefined ? {} : { status },
  })
  return (
    <li className={css.change} data-forge-change={entry.url} data-expanded={expanded ? '' : undefined}>
      {details === undefined ? head : <HoverCard grouped anchor={head} content={details} />}
      {notice !== undefined && (
        <div className={css.notice}>
          <span>{t(notice)}</span>
          {entry.ref === null
            ? (
              <Button size="sm" variant="outline" onClick={() => { actions.openLink(url) }}>
                {openOnLabel(t, entry.forge?.label ?? null)}
              </Button>
            )
            : <Button size="sm" variant="outline" onClick={() => { void actions.retry() }}>{t('retry')}</Button>}
        </div>
      )}
      {expanded && snapshot !== null && (
        <Details entry={entry} snapshot={snapshot} name={name} now={now} actions={actions} locale={locale}
          coarsePointer={coarsePointer} t={t} />
      )}
      {expanded && snapshot !== null && <ChangeRequestPrimary entry={entry} snapshot={snapshot} name={name} actions={actions} t={t} />}
    </li>
  )
}
