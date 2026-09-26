import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { JobsSnapshot, JobView, ObservedJob } from '@deepseek-ai/dsh-api-job-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  IconChevronDownOutlineRegular, IconStopFillRegular, StateDot, TerminalBlock, useDismissOnOutsidePointer,
  type StateDotState, type TerminalBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './JobListAction.module.css'

/** Registration-side business face for the job list. */
export interface JobListInjected {
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

/** Full props for the session-header job-list action. */
export type JobListActionProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<typeof NS>
  & InjectFace<JobListInjected>

/** Stable empty list so a session with no jobs keeps one array identity. */
const NO_JOBS: readonly JobView[] = []

/** Minimum gap kept between the popover and the viewport edges (the Menu primitive's portal margin). */
const VIEWPORT_MARGIN = 12

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
 */
function dotState(status: JobView['status']): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'stopping': return 'warning'
    case 'completed': return 'done'
    case 'killed': return 'warning'
    case 'failed': return 'error'
    /* v8 ignore next -- closed wire status union */
    default: return assertNever(status)
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
 * Live rows first in start order, then settled rows newest-first. Two rows
 * that settled in the same millisecond fall back to start order, so the sort
 * never depends on the host's map iteration.
 */
function ordered(jobs: readonly JobView[]): JobView[] {
  return [...jobs].sort((left, right) => {
    const liveLeft = isLive(left)
    if (liveLeft !== isLive(right)) return liveLeft ? -1 : 1
    if (liveLeft) return left.startedAt - right.startedAt
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
function JobItem({ job, view, expanded, now, onToggle, kill, t }: {
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
  const durationCell = (
    <span
      className={css.duration}
      title={t(live ? 'duration.title.live' : 'duration.title.done', { duration })}
    >
      {duration}
    </span>
  )
  const body = live
    ? (
      <>
        <StateDot state={dotState(job.status)} className={css.rowDot} />
        <span className={css.main}>
          <span className={css.primary}>
            <span className={css.label} title={job.label}>{job.label}</span>
          </span>
          <span className={css.secondary} title={detail ?? status}>
            <span className={css.kind}>{job.kind}</span>
            {detail !== undefined ? <span className={css.status}>{detail}</span> : null}
            {durationCell}
          </span>
        </span>
        {/* A live row is always observable: its output may still arrive. */}
        <span className={css.chevronBox}>
          <IconChevronDownOutlineRegular size={12} className={expanded ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
        </span>
      </>
    )
    : (
      <>
        <StateDot state={dotState(job.status)} className={css.rowDot} />
        <span className={css.kind}>{job.kind}</span>
        <span className={css.label} title={job.label}>{job.label}</span>
        <span className={css.status} title={detail ?? status}>{detail ?? status}</span>
        {durationCell}
        {observable
          ? (
            <span className={css.chevronBox}>
              <IconChevronDownOutlineRegular size={12} className={expanded ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
            </span>
          )
          : null}
      </>
    )
  const killTitle = kill === undefined
    ? undefined
    : kill.state === 'armed'
      ? t('kill.confirm')
      : kill.state === 'failed' ? t('kill.failed') : t('kill.stop', { label: job.label })
  return (
    <li className={css.item}>
      <div className={live ? `${css.rowLine} ${css.rowLineLive}` : css.rowLine}>
        {observable
          ? (
            <button
              type="button"
              className={live ? css.row : `${css.row} ${css.rowSettled}`}
              aria-expanded={expanded}
              aria-label={t(expanded ? 'row.collapseAria' : 'row.expandAria', { label: job.label })}
              onClick={onToggle}
            >
              {body}
            </button>
          )
          : (
            <span className={`${css.row} ${css.rowSettled} ${css.rowStatic}`}>
              {body}
            </span>
          )}
        {kill !== undefined
          ? (
            <button
              type="button"
              className={
                kill.state === 'armed'
                  ? `${css.stop} ${css.stopArmed}`
                  : kill.state === 'failed' ? `${css.stop} ${css.stopFailed}` : css.stop
              }
              data-kill-state={kill.state}
              disabled={kill.state === 'pending'}
              aria-label={killTitle}
              title={killTitle}
              onClick={kill.onPress}
            >
              <IconStopFillRegular size={10} />
              {/* The armed press must be legible without hover: the button
                  widens into a labeled confirm pill instead of a tint only. */}
              {kill.state === 'armed' ? <span className={css.stopLabel}>{t('kill.confirmAction')}</span> : null}
            </button>
          )
          : null}
      </div>
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
 * Session-header entry point for this session's background jobs. Mounting it
 * keeps the session's roster stream open; it renders nothing at all until the
 * session can see at least one job. Expanding an observable row (a live job,
 * or a settled one with retained output) starts its observation stream, and
 * collapsing (or closing the popover) stops it — output only flows while
 * someone is watching. A running row carries a two-press stop button that
 * requests a human kill through the job controller.
 * @param props - runtime slot currency, the jobs snapshot hook, the roster,
 *   observation, and kill controls, and the namespace translator.
 * @returns the trigger and its popover list, or null when there is nothing to show.
 */
export function JobListAction({ sessionId, useJobs, watchRows, observe, killJob, t }: JobListActionProps) {
  const jobs = useJobs(state => state.rows[sessionId]) ?? NO_JOBS
  const observedViews = useJobs(state => state.observed)
  const [open, setOpen] = useState(false)
  const [expandedKey, setExpandedKey] = useState<string | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  // Settled-section fold: an explicit user toggle wins; before one, the tail
  // folds only while live work exists (a settled-only list opens expanded).
  const [settledOpen, setSettledOpen] = useState<boolean | undefined>(undefined)
  // Rows the user cleared from the settled tail (client-side hide only; the
  // registry keeps its records and a later settlement reappears normally).
  const [clearedKeys, setClearedKeys] = useState<ReadonlySet<string>>(() => new Set())
  // One kill affordance advances at a time: arming a row disarms any other.
  const [killPhase, setKillPhase] = useState<{ key: string; state: Exclude<KillState, 'idle'> } | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  // Horizontal shift applied to the trigger-anchored popover so it stays
  // inside the viewport (the stylesheet alone cannot see the anchor offset).
  const [menuShift, setMenuShift] = useState(0)

  const rows = useMemo(() => ordered(jobs), [jobs])
  const liveRows = useMemo(() => rows.filter(isLive), [rows])
  const settledRows = useMemo(
    () => rows.filter(job => !isLive(job) && !clearedKeys.has(String(job.id))),
    [rows, clearedKeys],
  )
  const settledExpanded = settledOpen ?? liveRows.length === 0
  const visibleCount = liveRows.length + settledRows.length

  useDismissOnOutsidePointer(rootRef, open, setOpen)

  // The roster follows the mounted session: one stream while this control
  // lives, released with it.
  useEffect(() => watchRows(sessionId), [sessionId, watchRows])

  // The clock only runs while an open list is showing something that moves.
  useEffect(() => {
    if (!open || liveRows.length === 0) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [open, liveRows.length])

  // Fit the open popover to the viewport: shift left when the anchored width
  // would cross the right edge, never past the left margin.
  useLayoutEffect(() => {
    if (!open) {
      setMenuShift(0)
      return
    }
    const fit = (): void => {
      const root = rootRef.current
      const menu = menuRef.current
      /* v8 ignore next -- both refs are attached while the open popover renders. */
      if (root === null || menu === null) return
      const width = menu.offsetWidth
      // Unlaid-out nodes (and jsdom) measure 0: keep the pure CSS anchor.
      if (width === 0) return
      const anchorLeft = root.getBoundingClientRect().left
      setMenuShift(Math.max(
        VIEWPORT_MARGIN - anchorLeft,
        Math.min(0, window.innerWidth - VIEWPORT_MARGIN - width - anchorLeft),
      ))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => { window.removeEventListener('resize', fit) }
  }, [open])

  // Observation follows visibility: the stream opens when an observable panel
  // expands and closes when it collapses, unmounts, or the popover closes.
  const expandedRow = open && expandedKey !== undefined
    ? rows.find(job => String(job.id) === expandedKey)
    : undefined
  const activeJob = expandedRow !== undefined && isObservable(expandedRow) ? expandedRow.id : undefined
  useEffect(() => {
    if (activeJob === undefined) return
    return observe(sessionId, activeJob)
  }, [sessionId, activeJob, observe])

  // The last visible job disappearing removes this control; close first so
  // focus does not vanish from an unmounting node.
  useEffect(() => {
    if (visibleCount === 0 && open) setOpen(false)
  }, [visibleCount, open])

  // An expanded row that left the list (owner disposal) folds its panel.
  useEffect(() => {
    if (expandedKey !== undefined && !rows.some(job => String(job.id) === expandedKey)) {
      setExpandedKey(undefined)
    }
  }, [rows, expandedKey])

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
  useEffect(() => {
    if (killPhase !== undefined
      && !rows.some(job => String(job.id) === killPhase.key && job.status === 'running')) {
      setKillPhase(undefined)
    }
  }, [rows, killPhase])

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
      // the button and clears the phase through the killable-set effect above.
      setKillPhase(current => current?.key === key && !ok
        ? { key, state: 'failed' }
        : current)
    })
  }

  if (visibleCount === 0) return null

  const countKey = liveRows.length > 0
    ? (liveRows.length === 1 ? 'count.live.one' : 'count.live.other')
    : (visibleCount === 1 ? 'count.idle.one' : 'count.idle.other')
  const countLabel = t(countKey, { count: liveRows.length > 0 ? liveRows.length : visibleCount })

  const clearSettled = (): void => {
    setClearedKeys((current) => {
      const next = new Set(current)
      for (const job of settledRows) next.add(String(job.id))
      return next
    })
    if (expandedKey !== undefined && settledRows.some(job => String(job.id) === expandedKey)) {
      setExpandedKey(undefined)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    setOpen(false)
    triggerRef.current?.focus()
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
      {...job.status === 'running'
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

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-expanded={open}
        aria-label={countLabel}
        onClick={() => {
          // Sample the clock in the same commit that opens the list: the
          // mount-time value predates every job, so the first painted frame
          // would otherwise clamp a long-running row to zero until the
          // open effect corrects it a frame later.
          setNow(Date.now())
          setOpen(current => !current)
        }}
      >
        {liveRows.length > 0 ? <StateDot state="ongoing" className={css.triggerDot} /> : null}
        <span className={css.count}>{countLabel}</span>
        <IconChevronDownOutlineRegular size={12} className={open ? css.triggerOpen : undefined} />
      </button>
      {open
        ? (
          <ul ref={menuRef} className={css.menu} style={{ left: menuShift }} aria-label={t('list.aria')}>
            {liveRows.length > 0
              ? <li className={css.sectionHeader} aria-hidden="true">{t('section.live')}</li>
              : null}
            {liveRows.map(item)}
            {settledRows.length > 0
              ? (
                <li className={css.sectionHeader}>
                  <button
                    type="button"
                    className={css.sectionToggle}
                    aria-expanded={settledExpanded}
                    onClick={() => { setSettledOpen(!settledExpanded) }}
                  >
                    <IconChevronDownOutlineRegular size={12} className={settledExpanded ? `${css.sectionChevron} ${css.sectionChevronOpen}` : css.sectionChevron} />
                    {t('section.settledCount', { count: settledRows.length })}
                  </button>
                  <button type="button" className={css.sectionClear} onClick={clearSettled}>
                    {t('section.clear')}
                  </button>
                </li>
              )
              : null}
            {settledExpanded ? settledRows.map(item) : null}
          </ul>
        )
        : null}
    </div>
  )
}
