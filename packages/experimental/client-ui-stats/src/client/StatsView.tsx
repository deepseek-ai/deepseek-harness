/** Statistics view entry: scrolling table, paging state, and footer controls. */

import {
  useEffect, useLayoutEffect, useRef, useState,
  type ReactElement, type UIEvent,
} from 'react'
import { SegmentedControl, Switch } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { LoadOlderResult } from './stats-contract.ts'
import { aggregateTotals, turnContext } from './stats-aggregate.ts'
import { isNumber } from './stats-usage.ts'
import { totalsFromProjections } from './stats-totals.ts'
import type { StatsPreferences } from './stats-preferences-contract.ts'
import css from './stats.module.css'
import {
  COLUMNS, EMPTY_STEP_VIEW, LOAD_OLDER_THRESHOLD, TableButton, TotalsRow, createViewState, defaultTurnOpen,
  isTimeRunning, totalSpan, turnRows,
  type StatsViewProps, type StatsViewInjected, type StepViewState, type ViewState,
} from './StatsTable.tsx'

export type { StatsViewInjected, StatsViewProps }

/** Scroll metrics captured before an older page loads, applied once its turns commit. */
interface PendingPrepend {
  readonly height: number
  readonly top: number
  readonly firstTurn: number | null
  /** The first published turn's row, held at the reading line while the page prepends. */
  readonly anchor: PrependAnchor | null
}

/** One published turn's row, kept where the reading line meets it while a page prepends. */
interface PrependAnchor {
  /** The turn's number, which a page never rewrites. */
  readonly turn: number
  /** Distance from the reading line down to the row's top, before the page loads. */
  readonly offset: number
}

/**
 * The first published turn's row. The page renders above every published turn,
 * so holding this row still holds the whole published table still; anchoring on
 * the first row avoids reaching for a row the scroll range cannot show.
 * @param element - the scrollport holding the table.
 * @returns the anchored row, or null while no laid-out row exists yet.
 */
function prependAnchor(element: HTMLElement): PrependAnchor | null {
  const row = element.querySelector<HTMLElement>('tr[data-turn]')
  /* v8 ignore next -- a mounted table always renders at least one turn row. */
  if (row === null) return null
  const line = element.getBoundingClientRect().top
  return { turn: Number(row.dataset.turn), offset: row.getBoundingClientRect().top - line }
}

/**
 * Restore the reading position in the commit that rendered the older page's turns.
 * @param element - the scrollport holding the table.
 * @param pending - the capture taken before the page loaded.
 */
function keepReadingPosition(element: HTMLElement, pending: PendingPrepend): void {
  // The page renders entirely above what the reader is looking at, so the content
  // in view now sits lower by exactly what the scrollport gained. Applying that to
  // the offset keeps the reader on the same rows and lets the new page come in from
  // above, which reads as paging rather than as a row appearing underneath.
  const added = Math.max(0, element.scrollHeight - pending.height)
  const target = element.scrollTop + added
  element.scrollTop = Math.min(element.scrollHeight - element.clientHeight, target)
}

/**
 * Adopt remembered choices stored after this view mounted, such as one another
 * tab made. Choices this view made itself are already adopted, so they do not
 * feed back.
 * @param adopted - the choices this view last applied.
 * @param view - the view state a render reads.
 * @param setView - the view state setter.
 * @param preferences - the browser-wide footer choices.
 */
function adoptRemembered(
  adopted: { current: StatsPreferences },
  view: ViewState,
  setView: (update: (current: ViewState) => ViewState) => void,
  preferences: StatsPreferences,
): void {
  const shown = pickPreferences(view)
  if (samePreferences(preferences, adopted.current)) {
    // This view made the change, or the render carries what is already stored.
    adopted.current = shown
    return
  }
  adopted.current = preferences
  setView(current => ({ ...current, ...pickPreferences(preferences) }))
}

/**
 * Compare the footer choices of two snapshots.
 * @param left - one set of choices.
 * @param right - the other set.
 * @returns whether every choice agrees.
 */
function samePreferences(left: StatsPreferences, right: StatsPreferences): boolean {
  const keys = Object.keys(left) as (keyof StatsPreferences)[]
  return keys.every(key => left[key] === right[key])
}

/**
 * The remembered subset of the table's view state.
 * @param preferences - browser-wide footer choices.
 * @returns the view-state fields those choices own.
 */
function pickPreferences(preferences: StatsPreferences): Pick<ViewState, keyof StatsPreferences> {
  return {
    mode: preferences.mode,
    showTotals: preferences.showTotals,
    showEvents: preferences.showEvents,
    showContextDelta: preferences.showContextDelta,
    contextMode: preferences.contextMode,
  }
}

/**
 * Render the Statistics table of the current conversation view target. The
 * table owns the viewport scroll: reaching the top asks the injected loader
 * for one older page while the already published turns stay in place.
 * @param props - composed conversation View props: the stats snapshot hook, the older-page loader, and the locale seat.
 * @returns the scrolling table, its empty state, and the expand/collapse footer.
 */
export function StatsView(props: StatsViewProps): ReactElement {
  const {
    useStats, usePreferences, setPreferences, t, loadOlder, consumeOlder, loadImage, useProjection, cancel,
  } = props
  const snapshot = useStats(value => value)
  const preferences = usePreferences(value => value)
  // Every mount opens with the remembered footer choices, and a later change on
  // the stored side (another tab, a profile load) reaches this view too.
  const [view, setView] = useState<ViewState>(() => ({
    ...createViewState(), ...pickPreferences(preferences),
  }))
  const adopted = useRef<StatsPreferences>(preferences)
  adoptRemembered(adopted, view, setView, preferences)
  const [now, setNow] = useState(() => Date.now())
  const [exhausted, setExhausted] = useState(false)
  /** Table height reached while filling a short table, so an empty page ends the fill. */
  const filled = useRef(0)
  /** A landing page may be followed while the reader's own input is still arriving. */
  const followOlder = useRef(false)
  /** Reader input seen since the last page landed. */
  const readerInput = useRef(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [visibleTurns, setVisibleTurns] = useState<ReadonlySet<number>>(() => new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)
  const pendingPrepend = useRef<PendingPrepend | null>(null)
  const initialized = useRef(false)
  const turns = snapshot.turns
  const firstTurn = turns[0]?.turn ?? null
  const latestTurn = turns.at(-1)?.turn ?? null
  const isTurnOpen = (turnNumber: number): boolean =>
    view.openTurns[turnNumber] ?? defaultTurnOpen(view.mode, turnNumber, latestTurn)
  const allOpen = turns.length > 0 && turns.every(turn => isTurnOpen(turn.turn))
  const hasRunning = turns.some(turn =>
    isTimeRunning(turn) || turn.steps.some(step => isTimeRunning(step)))
  useEffect(() => {
    if (!hasRunning) return undefined
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [hasRunning])
  useEffect(() => () => { cancel() }, [cancel])
  // Turns compare only with the other turns in the window.
  const projectionStats = useProjection('sessionStats')
  const projectionUsage = useProjection('tokenUsage')
  const fullTotals = view.showTotals ? totalsFromProjections(projectionStats, projectionUsage) : null
  const totals = fullTotals ?? (view.showTotals && turns.length > 0 ? aggregateTotals(turns) : null)
  const turnDeltas = new Map<number, number>()
  if (view.showContextDelta) {
    let previous: number | null = null
    for (const turn of turns) {
      const value = turnContext(turn, view.contextMode)
      if (isNumber(previous) && isNumber(value) && value !== previous) turnDeltas.set(turn.turn, value - previous)
      if (isNumber(value)) previous = value
    }
  }
  const scaleTurns = visibleTurns.size === 0 ? turns : turns.filter(turn => visibleTurns.has(turn.turn))
  const turnScale = scaleTurns.reduce((max, turn) => {
    const span = totalSpan(turn, now)
    return span !== null && span > max ? span : max
  }, 0)
  const toggleTurn = (turnNumber: number): void => {
    setView((current) => {
      const open = current.openTurns[turnNumber]
        ?? defaultTurnOpen(current.mode, turnNumber, latestTurn)
      return { ...current, openTurns: { ...current.openTurns, [turnNumber]: !open } }
    })
  }
  const toggleAllTurns = (): void => {
    const mode: ViewState['mode'] = allOpen ? 'none' : 'all'
    adopted.current = { ...adopted.current, mode }
    setPreferences({ mode })
    setView(current => ({ ...current, openTurns: {}, mode }))
  }
  /**
   * Apply one footer choice to this view and remember it for every other view.
   * @param patch - the preferences this control changed.
   */
  const choose = (patch: Partial<StatsPreferences>): void => {
    adopted.current = { ...adopted.current, ...patch }
    setPreferences(patch)
    setView(current => ({ ...current, ...patch }))
  }
  const toggleStepDetail = (turnNumber: number, stepNumber: number): void => {
    setView((current) => {
      const state = current.stepViews[turnNumber] ?? EMPTY_STEP_VIEW
      const open = { ...(state.open ?? {}) }
      open[stepNumber] = open[stepNumber] !== true
      return {
        ...current,
        stepViews: { ...current.stepViews, [turnNumber]: { ...state, open } },
      }
    })
  }
  const patchStepView = (turnNumber: number, patch: Partial<StepViewState>): void => {
    setView((current) => {
      const state = current.stepViews[turnNumber] ?? EMPTY_STEP_VIEW
      return {
        ...current,
        stepViews: { ...current.stepViews, [turnNumber]: { ...state, ...patch } },
      }
    })
  }
  const requestOlder = async (): Promise<void> => {
    if (loadingRef.current || exhausted || turns.length === 0) return
    const element = scrollRef.current
    /* v8 ignore next -- the scrollport mounts with the first render, so a request never runs without it. */
    if (element === null) return
    loadingRef.current = true
    setLoadFailed(false)
    const before: PendingPrepend = {
      height: element.scrollHeight,
      top: element.scrollTop,
      firstTurn,
      anchor: prependAnchor(element),
    }
    let result: LoadOlderResult
    try {
      result = await loadOlder()
    } catch {
      // Surface the failed page instead of looking like a silent no-op.
      loadingRef.current = false
      setLoadFailed(true)
      return
    }
    if (result === 'prepared') {
      // Publish first, then hold the capture only while rows are actually owed: a
      // refused publish renders nothing, so nothing may wait for it.
      const published = consumeOlder()
      pendingPrepend.current = published ? before : null
      // The reader may still be flicking upward: a flick ends at the top and stops
      // emitting scroll events, so the page landing there follows with the next one
      // while that input lasts. Without new input the view stays where it is.
      followOlder.current = published

    } else if (result === 'exhausted') {
      pendingPrepend.current = null
      setExhausted(true)
    } else {
      // Another view owns the in-flight page, or this page added no stats row.
      // Keep the gesture retryable without claiming exhaustion.
      pendingPrepend.current = null
    }
    loadingRef.current = false
  }
  // After every commit: open at the newest turn, then restore the reading
  // position once an older page has prepended its turns above the viewport.
  useLayoutEffect(() => {
    const element = scrollRef.current
    /* v8 ignore next -- the scrollport mounts with the first render. */
    if (element === null) return
    // Only real layout opens at the newest turn; a jsdom test has none to follow.
    if (!initialized.current && turns.length > 0 && element.clientHeight > 0) {
      initialized.current = true
      element.scrollTop = element.scrollHeight
    }
    const pending = pendingPrepend.current
    if (pending === null) {
      // A table shorter than its viewport cannot be scrolled at all, so no gesture
      // can ask for more history. Keep pulling until the table is scrollable: one
      // page may not be enough, and stopping there leaves the reader stuck. The
      // loop ends when the table fills, history ends, or a page adds nothing.
      const short = element.clientHeight > 0 && element.scrollHeight <= element.clientHeight
      if (!exhausted && turns.length > 0 && short && element.scrollHeight > filled.current) {
        filled.current = element.scrollHeight
        void requestOlder()
        return
      }
      // A flick stops emitting events once it reaches the top, so the page that
      // landed there is followed only while the reader's own input keeps arriving.
      const follow = followOlder.current && readerInput.current
      readerInput.current = false
      /* v8 ignore next -- a flick at the top arrives with the previous page still in flight, which jsdom cannot order. */
      if (!exhausted && follow && element.scrollTop <= LOAD_OLDER_THRESHOLD) void requestOlder()
      else followOlder.current = false
      return
    }
    // A page lands between two commits: the one that renders its turns, then the
    // repaint its request settling schedules. Only the first keeps the position.
    // v8 ignore next -- a repaint between the page's commit and its settling leaves the turns alone.
    if (firstTurn === pending.firstTurn) return
    pendingPrepend.current = null
    keepReadingPosition(element, pending)
  })
  // Turn bars compare against the largest duration currently on screen, so an
  // oversized turn that scrolled away does not flatten the visible comparison.
  useEffect(() => {
    const element = scrollRef.current
    /* v8 ignore next -- the scrollport mounts with the first render. */
    if (element === null || typeof IntersectionObserver === 'undefined') return undefined
    const visible = new Set<number>()
    const observer = new IntersectionObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        const turn = Number((entry.target as HTMLElement).dataset.turn)
        const had = visible.has(turn)
        if (entry.isIntersecting) visible.add(turn)
        else visible.delete(turn)
        if (had !== visible.has(turn)) changed = true
      }
      if (changed) setVisibleTurns(new Set(visible))
    }, { root: element })
    for (const row of element.querySelectorAll<HTMLElement>('tr[data-turn]')) observer.observe(row)
    return () => { observer.disconnect() }
  }, [turns.length])

  // A page loads once the reader has actually scrolled to the top, the same
  // gesture the Trajectory table waits for, so opening never pulls history.
  const handleScroll = (event: UIEvent<HTMLDivElement>): void => {
    readerInput.current = true
    if (event.currentTarget.scrollTop > LOAD_OLDER_THRESHOLD) return
    void requestOlder()
  }
  // At the top a further wheel moves nothing, so no scroll event follows it;
  // the wheel itself is what proves the reader is still asking for history.
  const handleWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    if (event.deltaY >= 0) return
    if (event.currentTarget.scrollTop > LOAD_OLDER_THRESHOLD) return
    readerInput.current = true
    void requestOlder()
  }
  return (
    <div className={css.root} data-conversation-composer-overlay="">
      <div
        ref={scrollRef}
        className={css.scroll}
        role="region"
        aria-label={t('view.stats')}
        tabIndex={0}
        onScroll={handleScroll}
        onWheel={handleWheel}
      >
        {loadFailed && turns.length > 0 ? (
          // Paging is a gesture, so progress and the end of history need no report.
          // A failed page is the one case the reader cannot discover by scrolling.
          <div className={css.older} role="group" aria-label={t('loadOlder.failed')}>
            <button type="button" className={css.button} onClick={() => { void requestOlder() }}>
              {t('loadOlder.failed')}
            </button>
          </div>
        ) : null}
        {turns.length === 0 ? (
          <div className={css.empty}>{t('empty')}</div>
        ) : (
          <table className={css.table} aria-label={t('view.stats')}>
            <colgroup>
              <col /><col /><col />
              {COLUMNS.map(name => <col key={name} />)}
              <col />
            </colgroup>
            <thead>
              <tr>
                <th className={css.thLeft} title={t('column.scope.title')}>{t('column.scope')}</th>
                <th className={css.thLeft} title={t('column.prompt.title')}>{t('column.prompt')}</th>
                <th className={css.thLeft} title={t('column.did.title')}>{t('column.did')}</th>
                {COLUMNS.map(name => (
                  <th key={name} className={css.th} title={t(`column.${name}.title`)}>
                    {t(`column.${name}`)}
                  </th>
                ))}
                <th className={css.th} title={t('column.time.title')}>{t('column.time')}</th>
              </tr>
            </thead>
            <tbody>
              {turns.flatMap(turn => turnRows({
                turn,
                t,
                loadImage,
                now,
                open: isTurnOpen(turn.turn),
                state: view.stepViews[turn.turn] ?? EMPTY_STEP_VIEW,
                turnScale,
                contextMode: view.contextMode,
                showEvents: view.showEvents,
                showContextDelta: view.showContextDelta,
                contextDelta: view.showContextDelta ? turnDeltas.get(turn.turn) ?? null : null,
                onToggle: () => { toggleTurn(turn.turn) },
                onToggleDetail: (stepNumber) => { toggleStepDetail(turn.turn, stepNumber) },
                onControl: (patch) => { patchStepView(turn.turn, patch) },
              }))}
            </tbody>
            {totals === null ? null : (
              <tfoot>
                <TotalsRow totals={totals} full={fullTotals !== null} t={t} now={now} />
              </tfoot>
            )}
          </table>
        )}
      </div>
      <div className={css.toolbar}>
        <div className={css.controls}>
          <span className={css.controlLabel}>{t('table.showTotals')}</span>
          <Switch
            checked={view.showTotals}
            onChange={(next) => { choose({ showTotals: next }) }}
            label={t('table.showTotals')}
          />
          <span className={css.controlLabel}>{t('event.show')}</span>
          <Switch
            checked={view.showEvents}
            onChange={(next) => { choose({ showEvents: next }) }}
            label={t('event.show')}
          />
          <span className={css.controlLabel}>{t('context.delta.show')}</span>
          <Switch
            checked={view.showContextDelta}
            onChange={(next) => { choose({ showContextDelta: next }) }}
            label={t('context.delta.show')}
            title={t('context.delta.title')}
          />
          <span className={css.controlLabel}>{t('contextMode.label')}</span>
          <SegmentedControl
            id="stats-context-mode"
            value={view.contextMode}
            options={[
              { value: 'latest', label: t('contextMode.latest'), title: t('contextMode.latest.title') },
              { value: 'cumulative', label: t('contextMode.cumulative'), title: t('contextMode.cumulative.title') },
            ]}
            onChange={(next) => { choose({ contextMode: next }) }}
            label={t('contextMode.label')}
            className={css.contextMode}
          />
        </div>
        <TableButton
          caption={allOpen ? t('collapse.all') : t('expand.all')}
          enabled={turns.length > 0}
          onClick={toggleAllTurns}
        />
      </div>
    </div>
  )
}
