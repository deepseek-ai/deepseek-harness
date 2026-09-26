/**
 * Month calendar for one staged one-shot date.
 *
 * The picker owns only the panel: the row renders the read-only trigger, whose
 * text exposes the date as `YYYY/MM/DD` while the draft it stages keeps the ISO
 * text this panel writes back and the Host receives. The row's Escape guard
 * closes the panel and hands focus back.
 */
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode, RefObject } from 'react'
import clsx from 'clsx'
import {
  IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { PickerPopover } from './PickerPopover.tsx'
import type { TaskManagerKey } from './task-manager-locales.ts'
import css from './DatePicker.module.css'

/** Row copy of the task manager namespace, as the pickers receive it. */
type Translate = PropsLocale<'schedule.manager'>['t']

/** ISO calendar date, the only text this row stores. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Weekday column headings, Monday first as the weekly choice orders them. */
const WEEKDAY_KEYS = [
  'frequency.weekday.1', 'frequency.weekday.2', 'frequency.weekday.3', 'frequency.weekday.4',
  'frequency.weekday.5', 'frequency.weekday.6', 'frequency.weekday.7',
] as const satisfies readonly TaskManagerKey[]

/** Arrow key to the number of days it moves the focused cell. */
const STEP_BY_KEY: Readonly<Record<string, number>> = {
  ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7,
}

/** One month and the day the keyboard is on, as the panel shows them. */
interface MonthView {
  /** Four-digit year. */
  readonly year: number
  /** Zero-based month. */
  readonly month: number
  /** Day of that month, 1 through its last day. */
  readonly day: number
}

/**
 * The month and day one stored date opens on.
 * @param date - staged ISO date text.
 * @returns its own year, month, and day, or today when it is not an ISO calendar date.
 */
function viewOf(date: string): MonthView {
  const match = ISO_DATE.exec(date)
  if (match === null) {
    const today = new Date()
    return { year: today.getFullYear(), month: today.getMonth(), day: today.getDate() }
  }
  return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) }
}

/** Zero-padded two-digit field. */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Last day of one month.
 * @param view - year and zero-based month.
 * @returns that month's length in days.
 */
function daysIn(view: Pick<MonthView, 'year' | 'month'>): number {
  return new Date(Date.UTC(view.year, view.month + 1, 0)).getUTCDate()
}

/**
 * The same day in another month, clamped to that month's length.
 * @param view - current month and day.
 * @param step - months to move, negative for earlier.
 * @returns the moved view.
 */
function shiftMonth(view: MonthView, step: number): MonthView {
  const months = view.year * 12 + view.month + step
  const moved = { year: Math.floor(months / 12), month: months % 12 }
  return { ...moved, day: Math.min(view.day, daysIn(moved)) }
}

/**
 * ISO text of one day in a shown month.
 * @param view - shown year and month.
 * @param day - day of that month.
 * @returns `YYYY-MM-DD`.
 */
function isoOf(view: Pick<MonthView, 'year' | 'month'>, day: number): string {
  return `${view.year}-${pad(view.month + 1)}-${pad(day)}`
}

/** Inputs of the date picker. */
export interface DatePickerProps {
  /** Whether the panel is showing. */
  readonly open: boolean
  /** The row's trigger button, which anchors the panel. */
  readonly anchorRef: RefObject<HTMLButtonElement | null>
  /** The staged ISO date. */
  readonly value: string
  /** Stage one picked ISO date. */
  readonly onPick: (date: string) => void
  /** Dismiss the panel. */
  readonly onClose: () => void
  /** Row copy. */
  readonly t: Translate
}

/**
 * Render the month panel: one localized heading row over weeks of day cells.
 * @param props - open state, the trigger, the staged date, the pick and close callbacks, and row copy.
 * @returns the anchored panel while open, and nothing while closed.
 */
export function DatePicker({ open, anchorRef, value, onPick, onClose, t }: DatePickerProps): ReactNode {
  const refs = useRef(new Map<string, HTMLDivElement>())
  const valueRef = useRef(value)
  valueRef.current = value
  const [view, setView] = useState<MonthView>(() => viewOf(value))
  const today = new Date()
  const todayIso = isoOf({ year: today.getFullYear(), month: today.getMonth() }, today.getDate())

  // Opening returns to the stored day, so the grid starts where the row does.
  useEffect(() => {
    if (!open) return
    setView(viewOf(valueRef.current))
  }, [open])

  // The focused day owns the keyboard, and a pick leaves it on that day.
  useEffect(() => {
    if (!open) return
    refs.current.get(String(view.day))?.focus()
  }, [open, view])

  /**
   * Stage one day of the shown month and leave the keyboard on it.
   * @param day - day of the shown month.
   */
  const pick = (day: number): void => {
    setView(current => ({ ...current, day }))
    onPick(isoOf(view, day))
  }

  /**
   * Move the focused cell inside the month, or stage the day it is on.
   * @param event - keydown from that cell.
   * @param day - day of the shown month the cell holds.
   */
  const onCellKeyDown = (event: KeyboardEvent<HTMLDivElement>, day: number): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      pick(day)
      return
    }
    const step = STEP_BY_KEY[event.key] ?? 0
    if (step === 0) return
    event.preventDefault()
    const last = daysIn(view)
    setView(current => ({ ...current, day: Math.min(Math.max(day + step, 1), last) }))
  }

  const first = new Date(Date.UTC(view.year, view.month, 1)).getUTCDay()
  const offset = (first + 6) % 7
  const total = daysIn(view)
  const cellCount = Math.ceil((offset + total) / 7) * 7
  const weeks = Array.from({ length: cellCount / 7 }, (_value, week) => week)
  const monthTitle = new Intl.DateTimeFormat(t('time.locale'), {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(Date.UTC(view.year, view.month, 1))

  return <PickerPopover
    open={open}
    anchorRef={anchorRef}
    label={t('timing.date')}
    className={css.calendar}
    onClose={onClose}
  >
    <div className={css.head}>
      <button
        type="button"
        className={css.nav}
        aria-label={t('timing.prevMonth')}
        onClick={() => { setView(current => shiftMonth(current, -1)) }}
      ><IconChevronLeftOutlineRegular /></button>
      <span className={css.title} aria-live="polite">{monthTitle}</span>
      <button
        type="button"
        className={css.nav}
        aria-label={t('timing.nextMonth')}
        onClick={() => { setView(current => shiftMonth(current, 1)) }}
      ><IconChevronRightOutlineRegular /></button>
    </div>
    <div className={css.grid} role="grid" aria-label={monthTitle}>
      <div role="row" className={css.week}>
        {WEEKDAY_KEYS.map(key => (
          <div key={key} role="columnheader" className={css.weekday}>{t(key)}</div>
        ))}
      </div>
      {weeks.map(week => (
        <div key={week} role="row" className={css.week}>
          {Array.from({ length: 7 }, (_value, column) => week * 7 + column - offset + 1).map(day => (
            day < 1 || day > total
              ? <div key={day} role="gridcell" aria-hidden="true" className={css.blank} />
              : <div
                key={day}
                ref={(element) => {
                  if (element === null) refs.current.delete(String(day))
                  else refs.current.set(String(day), element)
                }}
                role="gridcell"
                aria-selected={isoOf(view, day) === value}
                aria-current={isoOf(view, day) === todayIso ? 'date' : undefined}
                tabIndex={day === view.day ? 0 : -1}
                className={clsx(css.cell, isoOf(view, day) === value && css.selected)}
                onClick={() => { pick(day) }}
                onKeyDown={(event) => { onCellKeyDown(event, day) }}
              >{day}</div>
          ))}
        </div>
      ))}
    </div>
  </PickerPopover>
}
