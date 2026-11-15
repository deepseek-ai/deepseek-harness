import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { JobsSnapshot, JobView, ObservedJob } from '@deepseek-ai/dsh-api-job-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  HoverCard, HoverCardGroup, IconChevronDownOutlineRegular, IconStopFillRegular, MarqueeText,
  StateDot, type StateDotState, TerminalBlock, type TerminalBlockLabels, Tooltip, useHoverMarquee,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime, PropsStore, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { createJobsSectionStore, JobGroup } from './jobs-store.ts'
import { NS } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-session-panel/client'
import css from './JobsSection.module.css'

/** Registration-side business face for the background-jobs section. */
export interface JobsSectionInjected {
  hooks: {
    /** Client jobs snapshot (rosters and observations) bound by the renderer as useJobs. */
    jobs: {
      getSnapshot(): JobsSnapshot
      subscribe(listener: () => void): () => void
    }
  }
  /**
   * Keep one session's roster current while the list is mounted; returns the
   * stop function. Reference-counted by the client service.
   */
  watchRows: (sessionId: SessionId) => () => void
  /**
   * Start observing one job's live output; returns the stop function.
   * Reference-counted by the client service, so panels can overlap safely.
   */
  observe: (sessionId: SessionId | undefined, id: JobView['id']) => () => void
  /**
   * Kill one background job on the human's behalf. Resolves `true` when the
   * registry admitted the request (`requested` or `already-finished`); row
   * state itself converges through the jobs control frames.
   */
  killJob: (sessionId: SessionId, jobId: string) => Promise<boolean>
}

/** Full props for the Session panel's background-jobs section. */
export type JobsSectionProps =
  PropsRuntime<'conversation.session.panel.section'>
  & PropsRenderFactories
  & PropsLocale<typeof NS>
  & InjectFace<JobsSectionInjected>
  & PropsStore<ReturnType<typeof createJobsSectionStore>>

/** Business face of the running dot on the Session panel toggle. */
export type JobsRunningIndicatorInjected = Pick<JobsSectionInjected, 'hooks' | 'watchRows'>

/** Full props of the running dot on the Session panel toggle. */
export type JobsRunningIndicatorProps =
  PropsRuntime<'conversation.session.panel.indicator'>
  & PropsLocale<typeof NS>
  & InjectFace<JobsRunningIndicatorInjected>

/** Stable empty list so a session with no jobs keeps one array identity. */
const NO_JOBS: readonly JobView[] = []

/** Rows a group shows before its fold control holds the rest back. */
const FOLD_LIMIT = 5

/** How long an armed kill waits for its confirming press before disarming. */
const KILL_ARM_MS = 3_000

/** How long a failed kill keeps its hint before the button resets. */
const KILL_FAILED_MS = 4_000


function isLive(job: JobView): boolean {
  return job.status === 'running' || job.status === 'stopping'
}

/**
 * Whether the row offers an output panel: every live job (its output may
 * still arrive) and a settled one that left retained output behind.
 */
function isObservable(job: JobView): boolean {
  return isLive(job) || job.output.total > 0
}

/** The one-line qualifier beside the status: live progress while running, the terminal reason once settled. */
function jobDetail(job: JobView): string | undefined {
  return job.progress ?? job.detail
}

/** Closed-union exhaustiveness fence for the wire status set. */
/* v8 ignore next 3 -- closed-union backstop; only reached if a status is forged */
function assertNever(value: never): never {
  throw new Error(`unhandled job status: ${JSON.stringify(value)}`)
}

/**
 * Status marker semantics. `stopping` and `killed` share the attention color:
 * both mean the work ended (or is ending) on request rather than on its own.
 * So does a job that finished with a nonzero exit code: the command reported a
 * failure, while `failed` means the job itself broke.
 */
function dotState(job: JobView): StateDotState {
  switch (job.status) {
    case 'running': return 'ongoing'
    case 'stopping': return 'warning'
    case 'completed': return job.exitCode === undefined || job.exitCode === 0 ? 'done' : 'warning'
    case 'killed': return 'warning'
    case 'failed': return 'error'
    /* v8 ignore next -- closed wire status union */
    default: return assertNever(job.status)
  }
}

function statusLabel(status: JobView['status'], t: TranslateNS<typeof NS>): string {
  switch (status) {
    case 'running': return t('status.running')
    case 'stopping': return t('status.stopping')
    case 'completed': return t('status.completed')
    case 'killed': return t('status.killed')
    case 'failed': return t('status.failed')
    /* v8 ignore next -- closed wire status union */
    default: return assertNever(status)
  }
}

/**
 * Elapsed time in at most two adjacent units. A job that outlives an hour is
 * already exceptional, so hours is the widest unit — beyond that the figure
 * stays in hours rather than growing a day/month vocabulary no producer
 * currently reaches.
 */
function formatDuration(elapsedMs: number, t: TranslateNS<typeof NS>): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1_000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3_600)
  if (hours > 0) return t('duration.hours', { hours, minutes })
  if (minutes > 0) return t('duration.minutes', { minutes, seconds })
  return t('duration.seconds', { seconds })
}

/** Localized display copy for the embedded terminal panel. */
function terminalLabels(t: TranslateNS<typeof NS>): TerminalBlockLabels {
  return {
    commandLine: line => t('terminal.commandLine', { n: line }),
    // The labels contract requires exit-fact formatters, but this panel never
    // passes exit facts, so TerminalBlock never invokes them.
    /* v8 ignore next */
    signal: signal => t('terminal.signal', { signal }),
    /* v8 ignore next */
    exitCode: code => t('terminal.exitCode', { code }),
    noExitCode: t('terminal.noExitCode'),
    running: t('terminal.running'),
    failed: t('terminal.failed'),
    done: t('terminal.done'),
    copy: t('terminal.copy'),
    copied: t('terminal.copied'),
    noOutput: t('terminal.noOutput'),
    collapseAria: t('terminal.collapseAria'),
    collapse: t('terminal.collapse'),
    // The panel never caps lines (it scrolls), so the fold controls that
    // would invoke these stay unrendered.
    /* v8 ignore next */
    expandAria: hidden => t('terminal.expandAria', { n: hidden }),
    /* v8 ignore next */
    expand: hidden => t('terminal.expand', { n: hidden }),
  }
}

/**
 * Live rows first, the most recently started first, then settled rows
 * newest-first, so the rows a group holds back past its limit are its oldest.
 * Two rows that settled in the same millisecond fall back to start order, so
 * the sort never depends on the host's map iteration.
 */
function ordered(jobs: readonly JobView[]): JobView[] {
  return [...jobs].sort((left, right) => {
    const liveLeft = isLive(left)
    if (liveLeft !== isLive(right)) return liveLeft ? -1 : 1
    if (liveLeft) return right.startedAt - left.startedAt
    const finished = (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt)
    return finished !== 0 ? finished : left.startedAt - right.startedAt
  })
}

/**
 * Two-press kill affordance state: `armed` waits for the confirming second
 * press (and disarms on a timer), `pending` covers the in-flight RPC until the
 * row's own status flip removes the button, `failed` shows briefly after a
 * rejected kill.
 */
type KillState = 'idle' | 'armed' | 'pending' | 'failed'

/** One job row plus, when observable and expanded, its live output panel. */
function JobItem({ job, view, expanded, now, onToggle, kill, renderFactorySlot, t }: Pick<JobsSectionProps, 'renderFactorySlot'> & {
  job: JobView
  view: ObservedJob | undefined
  expanded: boolean
  /** Clock sample live rows derive their running duration from. */
  now: number
  onToggle: () => void
  /** Present on running rows: the human-kill button state and press handler. */
  kill?: { state: KillState; onPress: () => void }
  t: TranslateNS<typeof NS>
}) {
  const live = isLive(job)
  const status = statusLabel(job.status, t)
  const detail = jobDetail(job)
  const observable = isObservable(job)
  const labels = useMemo(() => terminalLabels(t), [t])
  const elapsed = live ? now - job.startedAt : (job.finishedAt ?? job.startedAt) - job.startedAt
  const duration = formatDuration(elapsed, t)
  const labelRef = useRef<HTMLSpanElement>(null)
  const marquee = useHoverMarquee(labelRef)
  const summaryId = useId()
  // The stop control names its action in its own tooltip, so the row's hover card stays closed while the pointer is on it.
  const [onStop, setOnStop] = useState(false)
  const state = detail ?? status
  // The row shows the command alone; the kind and state reach assistive technology here and sighted users in the hover card.
  const body = (
    <>
      <span className={css.glyph}><StateDot state={dotState(job)} /></span>
      <MarqueeText ref={labelRef} className={css.label} data-job-label="">{job.label}</MarqueeText>
      <span id={summaryId} className={css.visuallyHidden}>{`${job.kind} · ${state}`}</span>
      <span className={css.duration}>{duration}</span>
    </>
  )
  // The tooltip names the action alone, since the command can run to many lines; the accessible name keeps the command
  // to tell the rows' buttons apart.
  const killTitle = kill?.state === 'armed' ? t('kill.confirm') : kill?.state === 'failed' ? t('kill.failed') : t('kill.stop')
  const killName = kill?.state === 'armed' || kill?.state === 'failed' ? killTitle : t('kill.stopAria', { label: job.label })
  return (
    <li className={css.item}>
      {/* The card leaves the command out: it can run to many lines, and the row's output panel shows it in full. */}
      <HoverCard
        grouped
        disabled={onStop && kill !== undefined}
        content={renderFactorySlot('conversation.session.panel.details', {
          lines: [job.kind],
          status: { state: dotState(job), label: state },
          facts: [{ kind: 'duration', label: duration }],
        })}
        anchor={(
          // A command its cell clips crawls into view while the pointer rests on the row.
          <div
            className={observable ? `${css.rowLine} ${css.rowInteractive}` : css.rowLine}
            data-job-row=""
            {...marquee}
          >
            {observable
              ? (
                <button
                  type="button"
                  className={css.row}
                  aria-expanded={expanded}
                  aria-label={t(expanded ? 'row.collapseAria' : 'row.expandAria', { label: job.label })}
                  aria-describedby={summaryId}
                  onClick={onToggle}
                >
                  {body}
                </button>
              )
              : <span className={css.row}>{body}</span>}
            {kill !== undefined
              ? (
                <Tooltip label={killTitle} side="bottom" align="end" delayMs={500} portal>
                  <button
                    type="button"
                    className={
                      kill.state === 'armed'
                        ? `${css.stop} ${css.stopArmed}`
                        : kill.state === 'failed' ? `${css.stop} ${css.stopFailed}` : css.stop
                    }
                    data-kill-state={kill.state}
                    disabled={kill.state === 'pending'}
                    aria-label={killName}
                    onPointerEnter={() => { setOnStop(true) }}
                    onPointerLeave={() => { setOnStop(false) }}
                    onClick={kill.onPress}
                  >
                    <IconStopFillRegular size={12} />
                    {/* The armed press must be legible without hover: the button
                        widens into a labeled confirm pill instead of a tint only. */}
                    {kill.state === 'armed' ? <span className={css.stopLabel}>{t('kill.confirmAction')}</span> : null}
                  </button>
                </Tooltip>
              )
              : null}
            {/* The row button's overlay takes presses here too; a row without output keeps the column empty. */}
            <span className={css.chevron} aria-hidden="true">
              {observable ? <IconChevronDownOutlineRegular size={14} className={expanded ? css.chevronOpen : undefined} /> : null}
            </span>
          </div>
        )}
      />
      {expanded && view !== undefined
        ? (
          <div className={css.panel}>
            {view.gapBefore ? <div className={css.notice}>{t('output.gap')}</div> : null}
            {view.error !== undefined
              ? <div className={`${css.notice} ${css.noticeError}`}>{t('output.error', { error: view.error })}</div>
              : null}
            <TerminalBlock
              command={job.label}
              output={view.text}
              running={live}
              copyText={job.label}
              // The row above the panel already carries the state dot.
              runStateDot={false}
              // The panel scrolls its output (a stylesheet height cap) instead
              // of collapsing the middle.
              maxLines={Number.POSITIVE_INFINITY}
              labels={labels}
            />
          </div>
        )
        : null}
    </li>
  )
}

/**
 * Session panel section for this session's background jobs. Mounting it keeps
 * the session's roster stream open; it renders nothing until the session can
 * see at least one job, so the panel hides the section with its title. Live
 * rows come first; settled rows fold under a count that expands and clears
 * client-side. Each of the two groups shows five rows and then a fold control
 * that shows the rest, once that holds back two rows or more; the choice is
 * kept per Session. Expanding an observable row (a live job, or a settled one
 * with retained output) starts its observation stream, and collapsing it or
 * folding it out of the list stops it — output only flows while someone is
 * watching. A running row carries a two-press stop button that requests a
 * human kill through the job controller.
 * @param props - runtime slot currency, the jobs snapshot hook, the roster,
 *   observation, and kill controls, the fold store, and the namespace translator.
 * @returns the job list, or null when there is nothing to show.
 */
export function JobsSection({
  sessionId, useJobs, watchRows, observe, killJob, useStore, actions, renderFactorySlot, t, useAccess,
}: JobsSectionProps) {
  // The stop control follows job/kill; a reader that may list a job but not stop it sees the row only.
  const mayKill = useAccess('job/kill')
  const jobs = useJobs(state => state.rows[sessionId]) ?? NO_JOBS
  const observedViews = useJobs(state => state.observed)
  const [expandedKey, setExpandedKey] = useState<string | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  // Settled-section fold: the user's choice, kept per Session, wins; before one,
  // the tail folds only while live work exists (a settled-only list opens expanded).
  const settledOpen = useStore(state => state.settledOpen)
  // Rows the user cleared from the settled tail (client-side hide only; the
  // registry keeps its records and a later settlement reappears normally).
  const cleared = useStore(state => state.cleared)
  const unfolded = useStore(state => state.unfolded)
  // One kill affordance advances at a time: arming a row disarms any other.
  const [killPhase, setKillPhase] = useState<{ key: string; state: Exclude<KillState, 'idle'> } | undefined>(undefined)

  const rows = useMemo(() => ordered(jobs), [jobs])
  const liveRows = useMemo(() => rows.filter(isLive), [rows])
  const settledRows = useMemo(
    () => rows.filter(job => !isLive(job) && cleared[String(job.id)] !== true),
    [rows, cleared],
  )
  const settledExpanded = settledOpen ?? liveRows.length === 0
  // Folding holds back two rows or more, since the fold control takes a row itself.
  const liveFoldable = liveRows.length > FOLD_LIMIT + 1
  const shownLive = liveFoldable && !unfolded.live ? liveRows.slice(0, FOLD_LIMIT) : liveRows
  const settledFoldable = settledRows.length > FOLD_LIMIT + 1
  const openSettled = settledExpanded ? settledRows : NO_JOBS
  const shownSettled = settledFoldable && !unfolded.settled ? openSettled.slice(0, FOLD_LIMIT) : openSettled

  // The roster follows the mounted section: one stream while it lives, released with it.
  useEffect(() => watchRows(sessionId), [sessionId, watchRows])

  // The clock only runs while the list shows something that moves.
  useEffect(() => {
    if (liveRows.length === 0) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [liveRows.length])

  // Observation follows visibility: the stream opens when an observable panel
  // expands and closes when it collapses, its row folds out of the list, or
  // the section unmounts.
  const expandedRow = expandedKey === undefined
    ? undefined
    : [...shownLive, ...shownSettled].find(job => String(job.id) === expandedKey)
  const activeJob = expandedRow !== undefined && isObservable(expandedRow) ? expandedRow.id : undefined
  useEffect(() => {
    if (activeJob === undefined) return
    return observe(sessionId, activeJob)
  }, [sessionId, activeJob, observe])

  // An armed kill disarms on a timer, and a failed one clears its hint; the
  // pending phase instead waits for the RPC (or the row's own status flip).
  // The cleanup clears the timer on every phase change, so a firing timer
  // always describes the current phase and may reset unconditionally.
  useEffect(() => {
    if (killPhase === undefined || killPhase.state === 'pending') return
    const timer = setTimeout(
      () => { setKillPhase(undefined) },
      killPhase.state === 'armed' ? KILL_ARM_MS : KILL_FAILED_MS,
    )
    return () => { clearTimeout(timer) }
  }, [killPhase])

  // A phase whose row stopped being killable (settled, stopping, removed)
  // has no button to describe any more.
  const killable = killPhase !== undefined
    && rows.some(job => String(job.id) === killPhase.key && job.status === 'running')
  if (killPhase !== undefined && !killable) setKillPhase(undefined)

  const pressKill = (job: JobView): void => {
    const key = String(job.id)
    if (killPhase?.key !== key || killPhase.state !== 'armed') {
      setKillPhase({ key, state: 'armed' })
      return
    }
    setKillPhase({ key, state: 'pending' })
    void killJob(sessionId, key).then((ok) => {
      // An admitted kill stays pending: the unary response (HTTP) and the jobs
      // frames (control stream) have no cross-carrier ordering, so re-enabling
      // here could offer a duplicate kill while the row still reads `running`.
      // The authoritative jobs frame flips the row to `stopping`, which removes
      // the button and clears the phase above.
      setKillPhase(current => current?.key === key && !ok
        ? { key, state: 'failed' }
        : current)
    })
  }

  if (liveRows.length + settledRows.length === 0) return null

  const clearSettled = (): void => {
    actions.cleared(settledRows.map(job => String(job.id)))
    if (expandedKey !== undefined && settledRows.some(job => String(job.id) === expandedKey)) {
      setExpandedKey(undefined)
    }
  }

  const item = (job: JobView) => (
    <JobItem
      key={String(job.id)}
      job={job}
      view={isObservable(job) ? observedViews[String(job.id)] : undefined}
      expanded={expandedKey === String(job.id)}
      now={now}
      onToggle={() => {
        setExpandedKey(current => current === String(job.id) ? undefined : String(job.id))
      }}
      renderFactorySlot={renderFactorySlot}
      {...job.status === 'running' && mayKill
        ? {
          kill: {
            state: killPhase?.key === String(job.id) ? killPhase.state : 'idle' as const,
            onPress: () => { pressKill(job) },
          },
        }
        : {}}
      t={t}
    />
  )

  /** The fold control of one group, as the group's last row. */
  const fold = (group: JobGroup, hidden: number) => {
    const label = unfolded[group] ? t('fold.less') : t(`${group}.more`, { count: hidden })
    return (
      <li key={`fold-${group}`} className={css.item}>
        {renderFactorySlot('conversation.session.panel.fold', {
          expanded: unfolded[group],
          label,
          name: t(`${group}.foldName`, { label }),
          onToggle: () => { actions.unfoldedSet(group, !unfolded[group]) },
        })}
      </li>
    )
  }

  return (
    // Moving between rows swaps their hover cards without another dwell.
    <HoverCardGroup>
      {/* The section's heading names the region; a list name would repeat it. */}
      <ul className={css.list} data-jobs-section="">
        {shownLive.map(item)}
        {liveFoldable ? fold('live', liveRows.length - FOLD_LIMIT) : null}
        {settledRows.length > 0
          ? (
            <li className={css.sectionHeader}>
              <button
                type="button"
                className={css.sectionToggle}
                aria-expanded={settledExpanded}
                onClick={() => { actions.settledOpened(!settledExpanded) }}
              >
                {t('section.settledCount', { count: settledRows.length })}
                <IconChevronDownOutlineRegular size={14} className={settledExpanded ? `${css.sectionChevron} ${css.sectionChevronOpen}` : css.sectionChevron} />
              </button>
              <button type="button" className={css.sectionClear} onClick={clearSettled}>
                {t('section.clear')}
              </button>
            </li>
          )
          : null}
        {shownSettled.map(item)}
        {settledExpanded && settledFoldable ? fold('settled', settledRows.length - FOLD_LIMIT) : null}
      </ul>
    </HoverCardGroup>
  )
}

/**
 * Show on the panel toggle that the Session's background jobs run while the
 * panel does not show them. The toggle stays mounted while the section does
 * not, so this keeps the Session's roster stream open itself; the client
 * service counts its watchers.
 * @param props - Session values, the jobs snapshot hook, the roster control, whether the panel shows, and copy.
 * @returns the dot with its name for assistive technology, or null with nothing to report.
 */
export function JobsRunningIndicator({ sessionId, panelShown, useJobs, watchRows, t }: JobsRunningIndicatorProps) {
  const running = useJobs(state => (state.rows[sessionId] ?? NO_JOBS).filter(isLive).length)
  useEffect(() => watchRows(sessionId), [sessionId, watchRows])
  if (panelShown || running === 0) return null
  return (
    <span className={css.runningIndicator} data-jobs-running="">
      <span className={css.visuallyHidden}>{t('indicator.running', { count: running })}</span>
    </span>
  )
}
