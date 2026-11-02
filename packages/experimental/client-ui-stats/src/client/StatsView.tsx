/** Statistics view entry: scrolling table, paging state, and footer controls. */

import {
  useEffect, useLayoutEffect, useRef, useState,
  type ReactElement, type UIEvent,
} from 'react'
import { SegmentedControl, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LoadOlderResult } from './stats-contract.ts'
import { aggregateTotals, turnContext } from './stats-aggregate.ts'
import { isNumber } from './stats-usage.ts'
import { totalsFromProjections } from './stats-totals.ts'
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
}

/**
 * Render the Statistics table of the current conversation view target. The
 * table owns the viewport scroll: reaching the top asks the injected loader
 * for one older page while the already published turns stay in place.
 * @param props - composed conversation View props: the stats snapshot hook, the older-page loader, and the locale seat.
 * @returns the scrolling table, its empty state, and the expand/collapse footer.
 */
export function StatsView(props: StatsViewProps): ReactElement {
  const { useStats, t, loadOlder, loadImage, useProjection, cancel } = props
  const snapshot = useStats(value => value)
  const [view, setView] = useState<ViewState>(createViewState)
  const [now, setNow] = useState(() => Date.now())
  const [loading, setLoading] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [visibleTurns, setVisibleTurns] = useState<ReadonlySet<number>>(() => new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)
  const pendingPrepend = useRef<PendingPrepend | null>(null)
  const initialized = useRef(false)
  const autoLoaded = useRef(false)
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
    setView(current => ({ ...current, openTurns: {}, mode: allOpen ? 'none' : 'all' }))
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
    setLoading(true)
    setLoadFailed(false)
    const before: PendingPrepend = {
      height: element.scrollHeight,
      top: element.scrollTop,
      firstTurn,
    }
    let result: LoadOlderResult
    try {
      result = await loadOlder()
    } catch {
      // Surface the failed page instead of looking like a silent no-op.
      loadingRef.current = false
      setLoading(false)
      setLoadFailed(true)
      return
    }
    if (result === 'grew') {
      pendingPrepend.current = before
    } else if (result === 'exhausted') {
      pendingPrepend.current = null
      setExhausted(true)
    } else {
      // Another view owns the in-flight page, or this page added no stats row.
      // Keep the trigger retryable without claiming exhaustion.
      pendingPrepend.current = null
    }
    loadingRef.current = false
    setLoading(false)
  }
  // After every commit: open at the newest turn, then restore the reading
  // position once an older page has prepended its turns above the viewport.
  useLayoutEffect(() => {
    const element = scrollRef.current
    /* v8 ignore next -- the scrollport mounts with the first render. */
    if (element === null) return
    if (!initialized.current && turns.length > 0) {
      initialized.current = true
      element.scrollTop = element.scrollHeight
      // First open has no scroll gesture to trigger a page: pull one older page
      // when the scrollport has real layout (a jsdom test has none).
      if (!autoLoaded.current && element.clientHeight > 0) {
        autoLoaded.current = true
        void requestOlder()
      }
      return
    }
    const pending = pendingPrepend.current
    if (pending === null || firstTurn === pending.firstTurn) return
    pendingPrepend.current = null
    element.scrollTop = pending.top + Math.max(0, element.scrollHeight - pending.height)
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

  const handleScroll = (event: UIEvent<HTMLDivElement>): void => {
    if (event.currentTarget.scrollTop > LOAD_OLDER_THRESHOLD) return
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
      >
        {turns.length === 0 ? null : (
          <div className={css.older}>
            {loading ? (
              <span className={css.olderStatus} role="status">{t('loadOlder.loading')}</span>
            ) : exhausted ? (
              <span className={css.olderStatus}>{t('loadOlder.done')}</span>
            ) : loadFailed ? (
              <button type="button" className={css.button} onClick={() => { void requestOlder() }}>
                {t('loadOlder.failed')}
              </button>
            ) : (
              <button type="button" className={css.button} onClick={() => { void requestOlder() }}>
                {t('loadOlder')}
              </button>
            )}
          </div>
        )}
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
        <span className={css.summary}>
          {t('summary', { turns: turns.length, steps: snapshot.stepCount })}
        </span>
        <div className={css.controls}>
          <span className={css.controlLabel}>{t('table.showTotals')}</span>
          <Switch
            checked={view.showTotals}
            onChange={(next) => { setView(previous => ({ ...previous, showTotals: next })) }}
            label={t('table.showTotals')}
          />
          <span className={css.controlLabel}>{t('event.show')}</span>
          <Switch
            checked={view.showEvents}
            onChange={(next) => { setView(previous => ({ ...previous, showEvents: next })) }}
            label={t('event.show')}
          />
          <span className={css.controlLabel}>{t('context.delta.show')}</span>
          <Switch
            checked={view.showContextDelta}
            onChange={(next) => { setView(previous => ({ ...previous, showContextDelta: next })) }}
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
            onChange={(next) => { setView(previous => ({ ...previous, contextMode: next })) }}
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
