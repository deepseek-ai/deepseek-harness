// @vitest-environment jsdom
import { useState } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Schedule } from '../src/client/Schedule.tsx'
import { ReportDetails } from '../src/client/ReportDetails.tsx'
import type { ViewState } from '../src/client/store.ts'
import { en, zh } from '../src/client/locales.ts'
import { reportSchema } from '../src/records.ts'
import type { IntervalReport, TimelineView } from '../src/records.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  IconChevronLeftOutlineRegular: () => <span />,
  IconListPenOutlineRegular: () => <span />,
  Tag: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const now = Date.parse('2026-10-21T12:00:00Z')
const report = reportSchema.parse({
  id: 'base',
  level: 0,
  start: now - 60000,
  end: now,
  policy: '[60000,2,12,24]',
  children: [],
  source: 'model',
  toolCount: 1,
  covered: 1,
  contextSeq: 1,
  summary: {
    progress: ['Session recovery works.', 'Next, check restart.'],
    uncertainties: [],
    userActions: [],
  },
})
const rollup = reportSchema.parse({
  ...report,
  id: 'rollup',
  level: 1,
  start: now - 120000,
  children: [report.id],
  summary: { ...report.summary, progress: ['Longer reports retain recent work.'] },
})
const view: TimelineView = {
  annotations: [],
  trees: [],
  activeTreeId: null,
  error: null,
  reports: [report, rollup],
}
const reportCadence = { intervalMs: 60000, rollupFactors: [2, 12, 24] }
function Fixture({
  value = view,
  cadence = reportCadence,
  initial = {},
  onOpen = vi.fn(),
}: {
  value?: TimelineView
  cadence?: typeof reportCadence
  initial?: Partial<ViewState>
  onOpen?: (id: IntervalReport['id']) => void
}) {
  const [state, setState] = useState<ViewState>({
    tree: null,
    collapsed: {},
    drafts: {},
    zoom: 5,
    level: null,
    scrollMs: 0,
    scrollLeft: 0,
    anchor: null,
    historyReport: undefined,
    tab: 'timeline',
    historyOpen: false,
    details: { tasks: [], timeline: [] },

    ...initial,
  })
  return (
    <>
      <Schedule
        view={value}
        cadence={cadence}
        state={state}
        now={now}
        update={(patch) => { setState(current => ({ ...current, ...patch })) }}
        openReport={onOpen}
        t={key => en[key as keyof typeof en] ?? key}
      />
      <output aria-label="Scroll">{state.scrollMs}</output>
      <output aria-label="Anchor">{state.anchor === null ? 'live' : 'history'}</output>
      <output aria-label="Zoom">{state.zoom}</output>
      <output aria-label="Column">{state.level ?? 0}</output>
    </>
  )
}
describe('the column timeline', () => {
  it('jumps from an empty current window to the last retained report', () => {
    const end = now - 8 * 86400000
    render(<Fixture initial={{ level: 1 }} value={{ ...view, reports: [
      reportSchema.parse({ ...report, id: 'last-saved', start: end - 60000, end }),
      reportSchema.parse({ ...report, id: 'older-rollup', level: 1, start: end - 86400000 - 120000, end: end - 86400000 }),
    ] }} />)
    expect(screen.getByText(en.emptyReports).getAttribute('role')).toBe('status')
    fireEvent.click(screen.getByRole('button', { name: en.jumpToLastReport }))
    expect(screen.getByLabelText('Anchor').textContent).toBe('history')
    expect(screen.getByLabelText('Column').textContent).toBe('0')
    expect(document.querySelector('[data-report-id="last-saved"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.returnNow }))
    expect(screen.getByLabelText('Anchor').textContent).toBe('live')
    expect(screen.getByText(en.emptyReports).getAttribute('role')).toBe('status')
  })
  it('keeps Back available when a report ages out while its details are open', () => {
    const back = vi.fn()
    render(<ReportDetails
      view={{ ...view, reports: [] }}
      reportId={report.id}
      openReport={vi.fn()}
      back={back}
      annotate={vi.fn()}
      t={key => en[key as keyof typeof en] ?? key}
    />)
    expect(screen.getByText(en.selectReport)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.back }))
    expect(back).toHaveBeenCalledOnce()
  })
  it('recomputes the ruler when viewport and font measurements change', () => {
    const observe = vi.fn()
    const disconnect = vi.fn()
    let resize: () => void = () => undefined
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback }
      observe = observe
      disconnect = disconnect
    })
    const { container, unmount } = render(<Fixture initial={{ zoom: null, level: 'all' }} />)
    const history = screen.getByLabelText(en.history)
    const font = container.querySelector<HTMLElement>('.timeline-font-metric')
    if (font === null) throw new Error('Missing font measurement')
    Object.defineProperty(history, 'clientHeight', { value: 560 })
    vi.spyOn(font, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 0, 18))
    act(resize)
    expect(observe).toHaveBeenCalledWith(history)
    expect(observe).toHaveBeenCalledWith(font)
    const zoom = screen.getByLabelText('Zoom')
    const before = Number(zoom.textContent)
    fireEvent.wheel(history, { ctrlKey: true, deltaY: -1, deltaMode: 1 })
    expect(Number(zoom.textContent)).toBeGreaterThan(before)
    fireEvent.wheel(history, { metaKey: true, deltaY: 1, deltaMode: 2 })
    expect(Number(zoom.textContent)).toBeLessThan(before)
    fireEvent.keyDown(history, { key: 'Enter' })
    fireEvent.scroll(history, { target: { scrollTop: 25 } })
    expect(screen.getByLabelText('Anchor').textContent).toBe('history')
    fireEvent.scroll(history, { target: { scrollTop: 0 } })
    expect(screen.getByLabelText('Anchor').textContent).toBe('live')
    unmount()
    expect(disconnect).toHaveBeenCalledOnce()
  })
  it('keeps the first zoom stop and labels subsecond work on a tall display', () => {
    let resize: () => void = () => undefined
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback }
      observe() {}
      disconnect() {}
    })
    const short = reportSchema.parse({ ...report, start: now - 900 })
    const { unmount } = render(<Fixture value={{ ...view, reports: [short] }} initial={{ zoom: 6 }} />)
    const history = screen.getByLabelText(en.history)
    const height = vi.spyOn(history, 'clientHeight', 'get').mockReturnValue(4000)
    act(resize)
    expect(screen.getByText(new RegExp(en.underSecond))).toBeTruthy()
    height.mockRestore()
    unmount()
    const old = reportSchema.parse({ ...report, start: now - 24 * 3600000 })
    render(<Fixture value={{ ...view, reports: [old] }} />)
    vi.spyOn(screen.getByLabelText(en.history), 'clientHeight', 'get').mockReturnValue(32)
    act(resize)
    fireEvent.click(screen.getByRole('button', { name: '1m column' }))
    fireEvent.click(screen.getByRole('button', { name: '1m column' }))
    expect(screen.getByLabelText('Zoom').textContent).toBe('0')
  })
  it('keeps a report from an unknown saved policy visible and scrolls its column header', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const saved = reportSchema.parse({ ...report, id: 'old-policy', level: 4, policy: 'legacy' })
    const { container } = render(<Fixture value={{ ...view, reports: [saved] }} initial={{ zoom: null }} />)
    const frame = container.querySelector('.timeline-table-scroll')
    if (frame === null) throw new Error('Missing timeline frame')
    fireEvent.scroll(frame, { target: { scrollLeft: 12 } })
    fireEvent.scroll(frame, { target: { scrollLeft: 12 } })
    expect(frame.scrollLeft).toBe(12)
    expect(container.querySelector('[data-report-id="old-policy"]')).toBeTruthy()
  })
  it('renders each saved report once across separated work bursts without changing data', () => {
    const saved = {
      ...view,
      reports: [
        reportSchema.parse({
          ...report,
          start: now - 3660000,
          ranges: [
            [now - 3660000, now - 3636000],
            [now - 36000, now],
          ],
        }),
      ],
    }
    const original = JSON.stringify(saved)
    const { container } = render(<Fixture value={saved} />)
    const cards = container.querySelectorAll<HTMLElement>('[data-report-id="base"]')
    expect(cards).toHaveLength(1)
    expect(Number.parseFloat(cards[0]?.style.height ?? '')).toBeCloseTo(3660)
    expect(cards[0]?.dataset.reportStart).toBe(String(now - 3660000))
    expect(container.querySelector('.timeline-idle')).toBeNull()
    expect(JSON.stringify(saved)).toBe(original)
  })
  it('keeps durations and empty gaps proportional across every column and manual zoom', () => {
    const reports = [0, 1].flatMap(level =>
      [0, 1].map(index =>
        reportSchema.parse({
          ...report,
          id: `linear-${level}-${index}`,
          level,
          start: now - (index === 0 ? 60000 : 780000),
          end: now - (index === 0 ? 0 : 600000),
        }),
      ),
    )
    const { container } = render(<Fixture value={{ ...view, reports }} />)
    const check = () => {
      for (const level of [0, 1]) {
        const short = container.querySelector<HTMLElement>(`[data-report-id="linear-${level}-0"]`)
        const long = container.querySelector<HTMLElement>(`[data-report-id="linear-${level}-1"]`)
        const minute = Number.parseFloat(short?.style.height ?? '')
        expect(Number.parseFloat(long?.style.height ?? '') / minute).toBeCloseTo(3)
        expect(Number.parseFloat(long?.style.top ?? '') / minute).toBeCloseTo(10)
      }
    }
    check()
    fireEvent.keyDown(screen.getByLabelText('History'), { key: '-' })
    check()
  })
  it('shows a newly saved report within the current minute without waiting for a clock tick', () => {
    const fresh = reportSchema.parse({ ...report, start: now + 1000, end: now + 30000 })
    const { container, rerender } = render(<Fixture value={{ ...view, reports: [] }} />)
    rerender(<Fixture value={{ ...view, reports: [fresh] }} />)
    const card = container.querySelector<HTMLElement>('[data-report-id="base"]')
    expect(Number.parseFloat(card?.style.top ?? '')).toBe(0)
    expect(Number.parseFloat(card?.style.height ?? '')).toBeCloseTo(29)
    expect(card?.textContent).toContain('Session recovery works.')
  })
  it('zooms a subpixel report once and allows details at the minute zoom limit', () => {
    const tiny = reportSchema.parse({ ...report, start: now - 27 })
    const open = vi.fn()
    const { container } = render(<Fixture value={{ ...view, reports: [tiny] }} onOpen={open} />)
    const card = container.querySelector<HTMLElement>('[data-report-id="base"]') as HTMLElement
    expect(Number.parseFloat(card.style.height)).toBe(1)
    fireEvent.click(card)
    expect(screen.getByLabelText('Zoom').textContent).toBe('6')
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(card)
    expect(open).toHaveBeenCalledWith('base')
  })
  it('keeps the reviewed historical period when switching hierarchy columns', () => {
    const reports = [0, 1].flatMap(level =>
      [0, 1, 2, 120, 121, 122].map(minutes =>
        reportSchema.parse({
          ...report,
          id: `context-${level}-${minutes}`,
          level,
          start: now - (minutes + 1) * 60000,
          end: now - minutes * 60000,
        }),
      ),
    )
    const { container } = render(
      <Fixture value={{ ...view, reports }} initial={{ scrollMs: 120 * 60000, anchor: now }} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '2m column' }))
    expect(Number(screen.getByLabelText('Scroll').textContent)).toBeGreaterThan(115 * 60000)
    const card = container.querySelector<HTMLElement>('[data-report-id="context-1-121"]')
    expect(card).toBeTruthy()
    expect(Number.parseFloat(card?.style.height ?? '')).toBeGreaterThan(90)
  })
  it('keeps unreported running work blank and clips captured work at the seven-day boundary', () => {
    const start = now - 8 * 86400000
    const saved = reportSchema.parse({
      ...report,
      start,
      end: now - 6 * 86400000,
      ranges: [[start, now - 6 * 86400000]],
    })
    const { container } = render(
      <Fixture
        value={{
          ...view,
          reports: [
            saved,
            reportSchema.parse({ ...report, id: 'boundary', start, end: now - 7 * 86400000 }),
            reportSchema.parse({ ...report, id: 'future', start: now + 60000, end: now + 120000 }),
          ],
        }}
        initial={{ zoom: 0 }}
      />,
    )
    expect(container.querySelectorAll('.timeline-idle')).toHaveLength(0)
    const block = container.querySelector<HTMLElement>('.timeline-block')
    const canvas = container.querySelector<HTMLElement>('.timeline-canvas')
    expect(block).toBeTruthy()
    expect(container.querySelectorAll('.timeline-block')).toHaveLength(1)
    expect(
      Number.parseFloat(block?.style.top ?? '') + Number.parseFloat(block?.style.height ?? ''),
    ).toBeLessThanOrEqual(Number.parseFloat(canvas?.style.height ?? ''))
  })
  it('shows the latest saved reports on first open after a long idle period, including delayed loading', () => {
    const reports = Array.from({ length: 3 }, (_, index) =>
      reportSchema.parse({
        ...report,
        id: `idle-${index}`,
        end: now - 4 * 3600000 - index * 900000,
        start: now - 4 * 3600000 - (index + 1) * 900000,
      }),
    )
    const cadence = { intervalMs: 900000, rollupFactors: [4, 4] }
    const { container, rerender } = render(
      <Fixture value={{ ...view, reports: [] }} cadence={cadence} initial={{ zoom: null }} />,
    )
    expect(screen.getByText(en.emptyReports)).toBeTruthy()
    rerender(<Fixture value={{ ...view, reports }} cadence={cadence} initial={{ zoom: null }} />)
    expect(container.querySelectorAll('.timeline-block')).toHaveLength(3)
    expect(screen.getByLabelText('History').scrollTop).toBeGreaterThan(0)
    const height = Number.parseFloat(
      container.querySelector<HTMLElement>('.timeline-canvas')?.style.height ?? '',
    )
    expect((7 * 86400000 * 420) / height).toBeGreaterThan(3 * 900000)
    expect((7 * 86400000 * 420) / height).toBeLessThan(4 * 900000)
    fireEvent.click(screen.getByRole('button', { name: 'Back to now' }))
    const history = screen.getByLabelText('History')
    expect(history.scrollTop).toBe(0)
    expect(document.activeElement).toBe(history)
    expect(screen.queryByText(en.emptyReports)).toBeNull()
  })
  it('follows a fresh report after an automatic fit to old history', () => {
    const earlier = reportSchema.parse({ ...report, id: 'earlier', start: now - 5 * 3600000, end: now - 4 * 3600000 })
    const fresh = reportSchema.parse({ ...report, id: 'fresh', start: now + 1000, end: now + 30000 })
    const { container, rerender } = render(<Fixture value={{ ...view, reports: [earlier] }} initial={{ zoom: null }} />)
    const history = screen.getByLabelText('History')
    expect(screen.getByLabelText('Anchor').textContent).toBe('live')
    expect(history.scrollTop).toBeGreaterThan(0)
    const zoom = screen.getByLabelText('Zoom').textContent
    rerender(<Fixture value={{ ...view, reports: [earlier, fresh] }} initial={{ zoom: null }} />)
    expect(container.querySelector('[data-report-id="fresh"]')).not.toBeNull()
    expect(history.scrollTop).toBe(0)
    expect(screen.getByLabelText('Zoom').textContent).toBe(zoom)
    expect(screen.queryByRole('button', { name: en.returnNowNewReports })).toBeNull()
    rerender(<Fixture value={{ ...view, reports: [] }} initial={{ zoom: null }} />)
    expect(history.scrollTop).toBe(0)
    expect(screen.getByText(en.emptyReports)).toBeTruthy()
  })
  it('signals a newly received report while leaving a manually scrolled viewport in place', () => {
    const fresh = reportSchema.parse({ ...report, id: 'fresh', start: now + 1000, end: now + 30000 })
    const { container, rerender } = render(<Fixture />)
    const history = screen.getByLabelText('History')
    fireEvent.scroll(history, { target: { scrollTop: 120 } })
    expect(screen.getByLabelText('Anchor').textContent).toBe('history')
    expect(screen.getByRole('button', { name: en.returnNow })).toBeTruthy()
    rerender(<Fixture value={{ ...view, reports: [...view.reports, fresh] }} />)
    expect(history.scrollTop).toBe(120)
    expect(container.querySelector('[data-report-id="fresh"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.returnNowNewReports }))
    expect(history.scrollTop).toBe(0)
    expect(document.activeElement).toBe(history)
    expect(container.querySelector('[data-report-id="fresh"]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: en.returnNowNewReports })).toBeNull()
  })
  it('keeps the first fitted zoom when new reports arrive', () => {
    const { container, rerender } = render(<Fixture initial={{ zoom: null }} />)
    const height = container.querySelector<HTMLElement>('.timeline-canvas')?.style.height
    const fresh = reportSchema.parse({ ...report, id: 'fresh', start: now - 1000 })
    rerender(<Fixture initial={{ zoom: null }} value={{ ...view, reports: [fresh, ...view.reports] }} />)
    expect(container.querySelector<HTMLElement>('.timeline-canvas')?.style.height).toBe(height)
  })
  it('expands a folded report and fits its column before a second click opens the same report', () => {
    const open = vi.fn()
    const { container } = render(<Fixture onOpen={open} />)
    const card = container.querySelector<HTMLButtonElement>('[data-report-id="rollup"]')
    expect(card).toBeTruthy()
    fireEvent.click(card as HTMLButtonElement)
    expect(open).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Column').textContent).toBe('1')
    fireEvent.click(card as HTMLButtonElement)
    expect(open).toHaveBeenCalledWith('rollup')
  })
  it('fits newly saved reports beyond a frozen anchor when their column is selected', () => {
    const { container } = render(<Fixture initial={{ anchor: now - 60000, scrollMs: 60000, level: 0 }} />)
    fireEvent.click(screen.getByRole('button', { name: '2m column' }))
    const card = container.querySelector<HTMLElement>('[data-report-id="rollup"]')
    const canvas = container.querySelector<HTMLElement>('.timeline-canvas')
    const height = Number.parseFloat(canvas?.style.height ?? '')
    // The full two-minute span must be fitted, rather than clipped at the old anchor.
    expect((7 * 86400000 * 420) / height).toBeGreaterThan(120000)
    expect((7 * 86400000 * 420) / height).toBeLessThan(600000)
    expect(Number.parseFloat(card?.style.top ?? '')).toBe(0)
    expect(Number.parseFloat(card?.style.height ?? '')).toBeGreaterThan(90)
    expect(Number.parseFloat(card?.style.height ?? '')).toBeLessThan(336)
  })
  it('fits three configured periods when no saved reports are available', () => {
    const { container } = render(
      <Fixture
        value={{
          ...view,
          reports: [],
        }}
        cadence={{ intervalMs: 900000, rollupFactors: [4, 4] }}
        initial={{ zoom: null }}
      />,
    )
    const height = Number.parseFloat(
      container.querySelector<HTMLElement>('.timeline-canvas')?.style.height ?? '',
    )
    expect((7 * 86400000 * 420) / height).toBeCloseTo(3.5 * 900000)
    expect(screen.getByRole('button', { name: '15m column' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '1h column' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '4h column' })).toBeTruthy()
  })
  it('shows all interval columns with one copy of each summary and no range controls or hover details', () => {
    const { container } = render(<Fixture />)
    expect(screen.getByRole('button', { name: '1m column' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '2m column' })).toBeTruthy()
    expect(container.querySelectorAll('.timeline-column')).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: '1m column' }))
    expect(screen.getAllByText('Session recovery works.')).toHaveLength(1)
    expect(container.querySelector('.timeline-nearby')).toBeNull()
    expect(container.querySelector('.timeline-toolbar')).toBeNull()
    expect(screen.queryByRole('slider')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull()
    expect(
      screen.getByRole('button', { name: /Show report:.*Longer reports/ }).getAttribute('title'),
    ).toBeNull()
  })
  it('keeps an excerpt or open cue in folded columns and expands them before opening details', () => {
    const compact = reportSchema.parse({
      ...report,
      id: 'compact',
      level: 1,
      end: now - 60000,
      start: now - 100000,
    })
    const tiny = reportSchema.parse({
      ...report,
      id: 'tiny',
      level: 1,
      end: now - 120000,
      start: now - 130000,
    })
    const open = vi.fn()
    render(<Fixture value={{ ...view, reports: [compact, tiny] }} initial={{ level: 0 }} onOpen={open} />)
    const cards = screen.getAllByRole('button', { name: /(?:Open|Show) report:/ })
    expect(cards[0]?.getAttribute('data-density')).toBe('compact')
    expect(cards[0]?.querySelector('.timeline-block-time')).toBeNull()
    expect(cards[0]?.querySelector('.timeline-block-copy')?.textContent).toBe('Session recovery works.')
    expect(cards[1]?.getAttribute('data-density')).toBe('bar')
    expect(cards[1]?.querySelector('.timeline-block-mark')?.textContent).toBe('⋯')
    expect(
      cards.every(card => /Open|Show/.test(card.querySelector('.timeline-block-open')?.textContent ?? '')),
    ).toBe(true)
    fireEvent.click(cards[1] as HTMLElement)
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(cards[1] as HTMLElement)
    expect(open).toHaveBeenCalledWith('tiny')
  })
  it('pins tall-card content to the visible top and budgets complete text lines', () => {
    const tall = reportSchema.parse({ ...report, end: now - 60000, start: now - 600000 })
    render(<Fixture value={{ ...view, reports: [tall] }} />)
    const card = screen.getByRole('button', { name: /Open report:/ })
    const content = card.querySelector<HTMLElement>('.timeline-block-content')
    expect(content?.style.top).toBe('0px')
    fireEvent.scroll(screen.getByLabelText('History'), { target: { scrollTop: 300 } })
    expect(card.getAttribute('data-density')).toBe('full')
    expect(Number.parseFloat(content?.style.top ?? '')).toBeCloseTo(240)
    expect(card.querySelector<HTMLElement>('.timeline-block-copy')?.style.webkitLineClamp).toBe('4')
  })
  it('expands a header to its interval and opens the same report without switching to a lower level', () => {
    const open = vi.fn()
    render(<Fixture onOpen={open} />)
    fireEvent.click(screen.getByRole('button', { name: '2m column' }))
    expect(screen.getByRole('button', { name: '2m column' }).getAttribute('aria-pressed')).toBe('true')
    const zoom = Number(screen.getByLabelText('Zoom').textContent)
    expect(zoom).toBeGreaterThan(4)
    expect(zoom).toBeLessThan(6)
    fireEvent.click(screen.getByRole('button', { name: /Open report:.*Longer reports/ }))
    expect(open).toHaveBeenCalledWith('rollup')
    expect(screen.getByLabelText('Column').textContent).toBe('1')
    expect(Number(screen.getByLabelText('Zoom').textContent)).toBe(zoom)
  })
  it('collapses the focused column to equal widths without changing the time viewport', () => {
    const { container } = render(<Fixture />)
    const column = screen.getByRole('button', { name: '2m column' })
    const history = screen.getByLabelText('History')
    fireEvent.click(column)
    expect(column.getAttribute('aria-pressed')).toBe('true')
    fireEvent.scroll(history, { target: { scrollTop: 15 } })
    const viewport = ['Zoom', 'Scroll', 'Anchor'].map(key => screen.getByLabelText(key).textContent)
    fireEvent.click(column)
    expect(screen.queryByRole('button', { pressed: true })).toBeNull()
    expect(['Zoom', 'Scroll', 'Anchor'].map(key => screen.getByLabelText(key).textContent)).toEqual(
      viewport,
    )
    const layout = `52px ${Array(4).fill('minmax(48px, 1fr)').join(' ')}`
    expect(container.querySelector<HTMLElement>('.timeline-column-headers')?.style.gridTemplateColumns).toBe(
      layout,
    )
    expect(container.querySelector<HTMLElement>('.timeline-columns')?.style.gridTemplateColumns).toBe(layout)
    fireEvent.click(column)
    expect(column.getAttribute('aria-pressed')).toBe('true')
  })
  it.each([0, 86400000])('fits nearby reports without shrinking across an idle gap of %s ms', (gap) => {
    const reports = Array.from({ length: 3 }, (_, index) =>
      reportSchema.parse({
        ...report,
        id: `period-${index}`,
        start: now - (index + 1) * 60000 - (index === 0 ? 0 : gap),
        end: now - index * 60000 - (index === 0 ? 0 : gap),
      }),
    )
    const { container } = render(<Fixture value={{ ...view, reports }} initial={{ zoom: 0, level: 'all' }} />)
    fireEvent.click(screen.getByRole('button', { name: '1m column' }))
    const visibleSpan = () =>
      (7 * 86400000 * 420) /
      Number.parseFloat(container.querySelector<HTMLElement>('.timeline-canvas')?.style.height ?? '')
    expect(visibleSpan()).toBeGreaterThanOrEqual(3 * 60000)
    expect(
      [...container.querySelectorAll<HTMLElement>('[data-report-id^="period-"]')].some(
        card => Number.parseFloat(card.style.height) > 90,
      ),
    ).toBe(true)
  })
  it('provides major and minor grid lines at minute resolution', () => {
    const { container } = render(<Fixture />)
    expect(container.querySelectorAll('.timeline-tick-major').length).toBeGreaterThan(1)
    expect(container.querySelectorAll('.timeline-tick-minor').length).toBeGreaterThan(1)
    const positions = [...container.querySelectorAll<HTMLElement>('.timeline-tick')]
      .map(tick => Number.parseFloat(tick.style.top))
      .sort((a, b) => a - b)
    expect(positions.slice(1).every((position, index) => position - (positions[index] ?? 0) > 0)).toBe(true)
  })
  it.each(['ctrlKey', 'metaKey'] as const)(
    'zooms at the pointer with %s while ordinary scrolling stays native',
    (modifier) => {
      render(<Fixture />)
      const scroll = screen.getByLabelText('History')
      const ordinary = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })
      fireEvent(scroll, ordinary)
      expect(ordinary.defaultPrevented).toBe(false)
      fireEvent.scroll(scroll, { target: { scrollTop: 3600 } })
      const before = 3600000 + (210 / 3600) * 3600000
      const wheel = new WheelEvent('wheel', {
        deltaY: -120,
        clientY: 210,
        [modifier]: true,
        bubbles: true,
        cancelable: true,
      })
      fireEvent(scroll, wheel)
      expect(wheel.defaultPrevented).toBe(true)
      const zoom = Number(screen.getByLabelText('Zoom').textContent)
      expect(zoom).toBeCloseTo(5.4)
      const scale = 3600 * 7 ** (zoom - 5)
      expect(Number(screen.getByLabelText('Scroll').textContent) + (210 / scale) * 3600000).toBeCloseTo(
        before,
        3,
      )
      fireEvent.scroll(scroll)
      expect(screen.getByLabelText('Anchor').textContent).toBe('history')
      fireEvent.click(screen.getByRole('button', { name: 'Back to now' }))
      expect(screen.getByLabelText('Anchor').textContent).toBe('live')
      expect(scroll.scrollTop).toBe(0)
    },
  )
  it('keeps seven-day bounds, keyboard zoom and tiny reports reachable without changing their height', () => {
    const reports = Array.from({ length: 8 }, (_, index) =>
      reportSchema.parse({
        ...report,
        id: `tiny-${index}`,
        start: now - (index + 1) * 60000,
        end: now - index * 60000,
        summary: { ...report.summary, progress: [`Result ${index}`] },
      }),
    )
    const open = vi.fn()
    const { container } = render(
      <Fixture
        value={{ ...view, reports }}
        initial={{ zoom: 0 }}
        onOpen={open}
      />,
    )
    const cards = screen.getAllByRole('button', { name: /(?:Open|Show) report:/ })
    expect(cards).toHaveLength(8)
    expect(cards.every(card => card.tabIndex === 0)).toBe(true)
    expect(
      Number.parseFloat(container.querySelector<HTMLElement>('.timeline-canvas')?.style.height ?? ''),
    ).toBeLessThan(1000)
    expect(cards.every(card => Number.parseFloat(card.style.height) === 1)).toBe(true)
    fireEvent.click(cards[7] as HTMLElement)
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(cards[7] as HTMLElement)
    expect(open).toHaveBeenCalledWith('tiny-7')
    const scroll = screen.getByLabelText('History')
    for (let index = 0; index < 10; index++) fireEvent.keyDown(scroll, { key: '+' })
    expect(screen.getByLabelText('Zoom').textContent).toBe('6')
    for (let index = 0; index < 10; index++) fireEvent.keyDown(scroll, { key: '-' })
    expect(screen.getByLabelText('Zoom').textContent).toBe('0')
  })
  it('falls back to the first column when a hierarchy level is removed', () => {
    render(
      <Fixture cadence={{ ...reportCadence, rollupFactors: [] }} initial={{ level: 3 }} />,
    )
    expect(screen.getByRole('button', { name: '1m column' }).getAttribute('aria-pressed')).toBe('true')
  })
  it('keeps saved rollups visible when their configured level is removed', () => {
    render(<Fixture cadence={{ ...reportCadence, rollupFactors: [] }} />)
    expect(screen.getByRole('button', { name: '2m column' }).getAttribute('data-history')).toBe('true')
    expect(screen.getByRole('button', { name: /Show report:.*Longer reports/ })).toBeTruthy()
    cleanup()
    render(
      <ReportDetails
        view={view}
        reportId={rollup.id}
        openReport={vi.fn()}
        back={vi.fn()}
        annotate={vi.fn().mockResolvedValue({ notified: true })}
        t={key => en[key as keyof typeof en] ?? key}
      />,
    )
    expect(screen.getByText(/Interval at the time: 2m/)).toBeTruthy()
  })
  it('titles the first report section 进展 in Chinese and keeps the other section titles', () => {
    const detailed = reportSchema.parse({
      ...report,
      summary: {
        progress: ['Restart passed.'],
        uncertainties: ['Backup restore is still open.'],
        userActions: ['Send a backup sample.'],
      },
    })
    render(
      <ReportDetails
        view={{ ...view, reports: [detailed] }}
        reportId={detailed.id}
        openReport={vi.fn()}
        back={vi.fn()}
        annotate={vi.fn()}
        t={key => zh[key as keyof typeof zh] ?? key}
      />,
    )
    expect(screen.getAllByRole('heading', { level: 4 }).map(heading => heading.textContent)).toEqual([
      '进展', '待定事项', '你可以做的事',
    ])
  })
  it('titles report details by level and shows durations like the report blocks', () => {
    const uneven = reportSchema.parse({ ...rollup, start: now - 76200, workMs: 46200 })
    render(
      <ReportDetails
        view={{ ...view, reports: [report, uneven] }}
        reportId={uneven.id}
        openReport={vi.fn()}
        back={vi.fn()}
        annotate={vi.fn().mockResolvedValue({ notified: true })}
        t={key => en[key as keyof typeof en] ?? key}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Report · Level 2' })).toBeTruthy()
    expect(screen.getByText('1m 16s')).toBeTruthy()
    expect(screen.getByText(/Interval at the time: 2m · Agent work time: 46s/)).toBeTruthy()
    expect(screen.queryByText(/1\.27m/)).toBeNull()
  })
  it('preserves saved report language and opens child details without changing the timetable', () => {
    const quiet = reportSchema.parse({
      ...report,
      source: 'no-activity',
      summary: { progress: ['无活动。'], uncertainties: [], userActions: [] },
    })
    const parent = reportSchema.parse({ ...rollup, children: [quiet.id] })
    const saved = { ...view, reports: [quiet, parent] }
    const open = vi.fn()
    render(
      <>
        <Fixture value={saved} />
        <ReportDetails
          view={saved}
          reportId={parent.id}
          openReport={open}
          back={vi.fn()}
          annotate={vi.fn().mockResolvedValue({ notified: true })}
          t={key => en[key as keyof typeof en] ?? key}
        />
      </>,
    )
    expect(screen.getByRole('button', { name: /Open report:.*无活动。/ })).toBeTruthy()
    fireEvent.click(
      within(screen.getByLabelText('Details')).getByRole('button', { name: '无活动。', hidden: true }),
    )
    expect(open).toHaveBeenCalledWith('base')
  })
  it('renders model text as plain text', () => {
    const hostile = { ...report, summary: { ...report.summary, progress: ['<img src=x onerror=alert(1)>'] } }
    const { container } = render(<Fixture value={{ ...view, reports: [hostile] }} />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('button', { name: /<img/ })).toBeTruthy()
  })
})
