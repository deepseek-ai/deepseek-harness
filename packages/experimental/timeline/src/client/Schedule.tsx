import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TimelineView, IntervalReport } from '../records.ts'
import type { ViewState } from './store.ts'
import { formatDuration, formatPeriod, reportPeriods, savedPeriod } from '../periods.ts'
import { HISTORY_MS, MINUTE_MS, minuteAt } from '../policy.ts'
import { TimeScale } from './TimeScale.ts'

const hour = 3600000

function scaleAt(zoom: number, scales: readonly number[]): number {
  const position = Math.max(0, Math.min(scales.length - 1, zoom))
  const lower = Math.floor(position)
  // The nonempty zoom ladder clamps both indexes to its bounds.
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const start = scales[lower]!
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const end = scales[Math.ceil(position)]!
  return start * (end / start) ** (position - lower)
}
function zoomFor(pixels: number, scales: readonly number[]): number {
  const upper = scales.findIndex(value => value >= pixels)
  if (upper <= 0) return upper === 0 ? 0 : scales.length - 1
  // findIndex found an upper bound after the first stop.
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const low = scales[upper - 1]!
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const high = scales[upper]!
  return upper - 1 + Math.log(pixels / low) / Math.log(high / low)
}
interface ScheduleProps extends PropsLocale<'timeline'> {
  locale?: string
  cadence: Parameters<typeof reportPeriods>[0]
  view: TimelineView
  state: ViewState
  now: number
  update: (patch: Partial<ViewState>) => void
  openReport: (id: IntervalReport['id']) => void
}

/** All hierarchy levels share one reverse time ruler; focus changes width and scale, never report identity. */
export function Schedule({ view, cadence, state, now, update, openReport, t, locale = 'en' }: ScheduleProps): ReactNode {
  const scroll = useRef<HTMLDivElement>(null)
  const horizontal = useRef<HTMLDivElement>(null)
  const fontMetric = useRef<HTMLSpanElement>(null)
  const [viewport, setViewport] = useState(420)
  const [fontSize, setFontSize] = useState(13)
  const [frameInset, setFrameInset] = useState<number | null>(null)
  const clock = minuteAt(now)
  // Newly saved reports may end after the last minute tick; show them without a faster clock.
  const liveAnchor = view.reports.reduce(
    (latest, report) => (report.end < clock + MINUTE_MS ? Math.max(latest, report.end) : latest),
    clock,
  )
  const anchor = state.anchor ?? liveAnchor
  const pastLiveWindow = anchor <= liveAnchor - HISTORY_MS
  const scales = useMemo(() => [2, 24, 120, 360, 1200, 3600, viewport * 60], [viewport])
  const configured = reportPeriods(cadence)
  const spans = Array.from(
    { length: view.reports.reduce((count, report) => Math.max(count, report.level + 1), configured.length) },
    (_, index) => {
      const saved = view.reports.findLast(report => report.level === index)
      return configured[index] ?? (saved && savedPeriod(saved)) ?? MINUTE_MS
    },
  )
  const blocks = useMemo(() => [...view.reports].sort((a, b) => b.end - a.end), [view.reports])
  const available = blocks.filter(report => report.end > anchor - HISTORY_MS && report.start < anchor)
  const latest = blocks.find(report => report.end <= liveAnchor)
  const lastReceived = view.reports.at(-1)?.id ?? null
  const newReports = state.historyReport !== undefined && state.historyReport !== lastReceived && lastReceived !== null
  const historyReport = state.anchor === null ? lastReceived : state.historyReport
  const firstLevel = Math.max(
    0,
    spans.findIndex((_, index) => available.some(report => report.level === index)),
  )
  const canCollapse = spans.length > 1
  const level =
    state.level === 'all' && canCollapse
      ? null
      : typeof state.level === 'number' && state.level >= 0 && state.level < spans.length
        ? state.level
        : firstLevel
  const windowFor = (index: number, target?: IntervalReport, at = anchor, near = at - state.scrollMs) => {
    const candidates = blocks.filter(
      report => report.level === index && report.end > at - HISTORY_MS && report.start < at,
    )
    const distance = (report: IntervalReport) => Math.max(report.start - near, near - report.end, 0)
    const nearest =
      target ??
      candidates.reduce<IntervalReport | undefined>(
        (best, report) => (best === undefined || distance(report) < distance(best) ? report : best),
        undefined,
      )
    const position = candidates.findIndex(report => report === nearest)
    const first = Math.max(0, Math.min(position - 1, candidates.length - 3))
    const durations = candidates
      .slice(first, first + 3)
      .map(report => report.end - report.start)
      .sort((a, b) => a - b)
    // Focus only addresses a rendered column or its report.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const span = spans[index]!
    const typical = Math.max(MINUTE_MS, target === undefined
      ? durations[Math.floor(durations.length / 2)] ?? span
      : target.end - target.start)
    const fitted =
      (viewport * hour) / (typical * (target === undefined ? (durations.length || 3) + 0.5 : 1.25))
    const readable = target === undefined ? 0 : (fontSize * 8 * hour) / Math.max(1, target.end - target.start)
    const density = Math.max(
      viewport / (HISTORY_MS / hour),
      Math.min(viewport * 60, Math.max(fitted, readable)),
    )
    const next = new TimeScale(at, density)
    const offset = Math.max(
      0,
      Math.min(next.height - viewport, next.position(nearest?.end ?? at) - viewport * 0.08),
    )
    return { zoom: zoomFor(density, scales), scrollMs: at - next.time(offset) }
  }
  const initial = state.zoom === null ? windowFor(level ?? firstLevel) : { zoom: state.zoom, scrollMs: state.scrollMs }
  const { zoom, scrollMs } = initial
  const pixelsPerHour = Math.max(scaleAt(zoom, scales), viewport / (HISTORY_MS / hour))
  const scale = useMemo(() => new TimeScale(anchor, pixelsPerHour), [anchor, pixelsPerHour])
  const height = Math.max(viewport, scale.height)
  const followLatest = state.anchor === null && state.zoom !== null && state.scrollMs > 0
  const position = followLatest
    ? scale.position(available[0]?.end ?? anchor) - viewport * 0.08
    : scale.position(anchor - scrollMs)
  const offset = Math.max(0, Math.min(height - viewport, position))
  const columns = `52px ${spans.map((_, index) => `minmax(48px, ${index === level ? 12 : 1}fr)`).join(' ')}`
  const upper = scale.time(Math.max(0, offset - viewport))
  const lower = scale.time(offset + viewport * 2)
  const reports = available.filter(
    report => report.level < spans.length && report.end >= lower && report.start <= upper,
  )
  const major = scale.ticks(Math.max(0, offset - viewport), viewport * 3, fontSize * 8)
  const majorTimes = new Set(major.map(Number))
  const minor = scale
    .ticks(Math.max(0, offset - viewport), viewport * 3, fontSize * 3)
    .filter(
      tick =>
        !majorTimes.has(Number(tick)) &&
        major.every(
          value => Math.abs(scale.position(Number(value)) - scale.position(Number(tick))) > fontSize * 1.6,
        ),
    )
  const time = (value: number, precise = false) =>
    new Date(value).toLocaleString(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      ...(precise ? { second: '2-digit' as const } : {}),
    })
  const tickLabel = (value: number) =>
    new Date(value).toLocaleString(locale, {
      ...(new Date(value).toDateString() !== new Date(anchor).toDateString() ||
      (viewport / pixelsPerHour) * hour >= 86400000
        ? { month: 'short' as const, day: 'numeric' as const }
        : {}),
      ...((viewport / pixelsPerHour) * hour >= 86400000
        ? {}
        : { hour: '2-digit' as const, minute: '2-digit' as const }),
    })
  useLayoutEffect(() => {
    // Both refs are attached by the layout commit before measurement.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const element = scroll.current!
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const metric = fontMetric.current!
    const measure = () => {
      if (element.clientHeight > 0) setViewport(element.clientHeight)
      setFrameInset(element.offsetWidth - element.clientWidth)
      const size = metric.getBoundingClientRect().height
      if (size > 0) setFontSize(size)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    observer?.observe(metric)
    return () => observer?.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (horizontal.current !== null && frameInset !== null) horizontal.current.scrollLeft = state.scrollLeft
  }, [frameInset, state.scrollLeft, spans.length])
  useLayoutEffect(() => {
    if (scroll.current !== null && Math.abs(scroll.current.scrollTop - offset) > 0.5)
      scroll.current.scrollTop = offset
  }, [offset])
  // Fit once when reports arrive. Only user navigation freezes the live anchor.
  useEffect(() => {
    if (state.zoom === null && available.length > 0) update({ zoom, scrollMs })
  }, [state.zoom, available.length, zoom, scrollMs, update])
  const zoomAt = (value: number, pointer: number, scrollTop: number) => {
    const zoom = Math.max(0, Math.min(scales.length - 1, value))
    const nextScale = Math.max(scaleAt(zoom, scales), viewport / (HISTORY_MS / hour))
    const atPointer = scale.time(scrollTop + pointer)
    const next = new TimeScale(anchor, nextScale)
    const nextOffset = Math.max(
      0,
      Math.min(Math.max(0, next.height - viewport), next.position(atPointer) - pointer),
    )
    const pinned = state.anchor !== null || nextOffset > 0
    update({
      zoom,
      anchor: pinned ? anchor : null,
      historyReport: pinned ? historyReport : undefined,
      scrollMs: anchor - next.time(nextOffset),
    })
  }
  const focus = (index: number, target?: IntervalReport) => {
    const nextAnchor = target === undefined && !pastLiveWindow ? liveAnchor : anchor
    const fitted = windowFor(index, target, nextAnchor, scale.time(offset + viewport * 0.35))
    const pinned = state.anchor !== null || fitted.scrollMs > 0
    // Apply the ruler and cards together; only the column widths animate.
    update({
      level: index,
      ...fitted,
      anchor: pinned ? nextAnchor : null,
      historyReport: pinned ? historyReport : undefined,
    })
  }
  // Own only modifier gestures. Ordinary wheel events retain native scrolling.
  useEffect(() => {
    // The scroll element is present whenever Schedule is mounted.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const element = scroll.current!
    const wheel = (event: WheelEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.deltaY === 0) return
      event.preventDefault()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport : 1)
      zoomAt(
        zoom - Math.max(-240, Math.min(240, delta)) / 300,
        Math.max(0, Math.min(viewport, event.clientY - element.getBoundingClientRect().top)),
        element.scrollTop,
      )
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => { element.removeEventListener('wheel', wheel) }
  })
  const ticks = (values: Date[], kind: 'major' | 'minor') =>
    values.map(tick => (
      <div
        className={`timeline-tick timeline-tick-${kind}`}
        key={`${kind}-${Number(tick)}`}
        data-tick={Number(tick)}
        style={{ top: scale.position(Number(tick)) }}
      >
        <time>{tickLabel(Number(tick))}</time>
      </div>
    ))
  return (
    <section className="timeline-schedule" aria-label={t('reports')}>
      <p className="timeline-muted timeline-scroll-hint">{t('scrollHint')}</p>
      <div className="timeline-viewport">
        <span ref={fontMetric} className="timeline-font-metric" aria-hidden="true" />
        <div
          ref={horizontal}
          className="timeline-table-scroll"
          onScroll={(event) => {
            const scrollLeft = event.currentTarget.scrollLeft
            if (scrollLeft !== state.scrollLeft) update({ scrollLeft })
          }}
        >
          <div style={{ minWidth: 52 + spans.length * 48 + (frameInset ?? 0) }}>
            <div
              className="timeline-column-headers"
              style={{ gridTemplateColumns: columns }}
              role="group"
              aria-label={t('hierarchy')}
            >
              <span className="timeline-ruler-heading">{t('time')}</span>
              {spans.map((span, index) => (
                <button
                  key={index}
                  data-level={index}
                  data-history={index >= configured.length}
                  aria-description={index >= configured.length ? t('savedPeriod') : undefined}
                  aria-pressed={level === index}
                  aria-label={`${formatPeriod(span)} ${t('column')}`}
                  title={canCollapse && level === index ? t('equalColumns') : undefined}
                  onClick={() => {
                    if (canCollapse && level === index) update({ level: 'all' })
                    else focus(index)
                  }}
                >
                  <span className="timeline-level-dot" aria-hidden="true" />
                  <strong>{formatPeriod(span)}</strong>
                </button>
              ))}
            </div>
            <div
              ref={scroll}
              className="timeline-scroll"
              aria-label={t('history')}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === '+' || event.key === '=' || event.key === '-') {
                  event.preventDefault()
                  zoomAt(zoom + (event.key === '-' ? -1 : 1), viewport / 2, event.currentTarget.scrollTop)
                }
              }}
              onScroll={(event) => {
                if (Math.abs(event.currentTarget.scrollTop - offset) < 1) return
                const scrollMs = anchor - scale.time(event.currentTarget.scrollTop)
                const pinned = scrollMs > 0 || pastLiveWindow
                update({ zoom, scrollMs, anchor: pinned ? anchor : null, historyReport: pinned ? historyReport : undefined })
              }}
            >
              <div className="timeline-canvas" style={{ height }}>
                <div className="timeline-now">
                  {state.anchor === null ? t('now') : t('history')} · {time(anchor)}
                </div>
                {ticks(minor, 'minor')}
                {ticks(major, 'major')}
                <div className="timeline-columns" style={{ gridTemplateColumns: columns }}>
                  <span />
                  {spans.map((_, index) => (
                    <div
                      className="timeline-column"
                      key={index}
                      data-level={index}
                      data-focused={level === index}
                    >
                      {reports
                        .filter(report => report.level === index)
                        .map((report) => {
                          const { start, end } = report
                          // Validated reports have at least one progress line.
                          const [excerpt] = report.summary.progress
                          const top = scale.position(Math.min(anchor, end))
                          const size = Math.max(1, Math.min(height, scale.position(start)) - top)
                          const contentTop = Math.max(0, offset - top)
                          const visibleSize = Math.max(
                            0,
                            Math.min(top + size, offset + viewport) - Math.max(top, offset),
                          )
                          // Budget whole text lines and pin long-card labels to the visible viewport.
                          const timeHeight = fontSize * 0.8 * 1.4
                          const lines = Math.min(
                            4,
                            Math.floor((visibleSize - 14 - timeHeight - 4) / (fontSize * 1.5)),
                          )
                          const density =
                            lines > 0 ? 'full' : visibleSize >= fontSize * 1.5 + 4 ? 'compact' : 'bar'
                          const needsFocus =
                            report.level !== level ||
                            (density === 'bar' &&
                              zoom <
                                zoomFor((fontSize * 8 * hour) / Math.max(1, end - start), scales) - 0.001)
                          return (
                            <button
                              key={report.id}
                              className="timeline-block"
                              data-report-id={report.id}
                              data-report-start={start}
                              data-source={report.source}
                              data-level={report.level}
                              data-density={density}
                              data-needs-focus={needsFocus || undefined}
                              aria-label={`${t(needsFocus ? 'showReport' : 'openReport')}: ${time(start, end - start < MINUTE_MS)} – ${time(end, end - start < MINUTE_MS)}: ${excerpt}`}
                              style={{ top, height: size }}
                              onClick={() => {
                                if (needsFocus) focus(report.level, report)
                                else openReport(report.id)
                              }}
                            >
                              <span
                                className="timeline-block-content"
                                style={{
                                  top: contentTop,
                                  height: density === 'bar' ? Math.max(1, visibleSize) : undefined,
                                }}
                              >
                                <span className="timeline-block-open" aria-hidden="true">
                                  {t(needsFocus ? 'showShort' : 'openShort')} ↗
                                </span>
                                <span className="timeline-block-mark" aria-hidden="true">
                                  ⋯
                                </span>
                                {density !== 'full' ? null : (
                                  <span className="timeline-block-time">
                                    {new Date(end).toLocaleTimeString(locale, {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                    })}{' '}
                                    · {end - start < 1000 ? t('underSecond') : formatDuration(end - start)}
                                  </span>
                                )}
                                {density === 'bar' ? null : (
                                  <span
                                    className="timeline-block-copy"
                                    style={{ WebkitLineClamp: Math.max(1, lines) }}
                                  >
                                    {excerpt}
                                  </span>
                                )}
                              </span>
                            </button>
                          )
                        })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
        {state.anchor === null && offset <= 0 ? null : (
          <Button
            className="timeline-return-now"
            onClick={() => {
              scroll.current?.focus({ preventScroll: true })
              update({ anchor: null, historyReport: undefined, scrollMs: 0, zoom })
            }}
          >
            <span aria-hidden="true">↑</span>
            {t(newReports ? 'returnNowNewReports' : 'returnNow')}
          </Button>
        )}
      </div>
      {available.length === 0 ? (
        <div className="timeline-empty">
          <p className="timeline-muted" role="status">{t('emptyReports')}</p>
          {latest === undefined ? null : (
            <Button onClick={() => {
              update({
                level: latest.level,
                anchor: Math.max(latest.end, latest.start + 1),
                historyReport,
                scrollMs: 0,
                zoom: null,
              })
              scroll.current?.focus({ preventScroll: true })
            }}>
              {t('jumpToLastReport')}
            </Button>
          )}
        </div>
      ) : null}
    </section>
  )
}
