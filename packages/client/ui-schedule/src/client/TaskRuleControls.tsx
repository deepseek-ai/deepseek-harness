/** Shared rule controls taken from the existing task detail. */
import type { CSSProperties, ReactNode } from 'react'
import clsx from 'clsx'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './TaskManagerPage.module.css'

type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const
const WEEKDAY_LABELS = {
  1: 'frequency.weekday.1', 2: 'frequency.weekday.2', 3: 'frequency.weekday.3', 4: 'frequency.weekday.4',
  5: 'frequency.weekday.5', 6: 'frequency.weekday.6', 7: 'frequency.weekday.7',
} as const

/**
 * Render the weekly rule's Weekday row: one pill per weekday, named by the row's
 * label and toggled in the rule the caller is editing.
 * @param props.weekdays - weekdays the rule currently selects, as ISO weekday numbers (Monday is 1).
 * @param props.disabled - whether the rule's controls are read-only.
 * @param props.t - frequency translator owning the weekday labels.
 * @param props.rowId - id builder for the row's label, which names the pill group.
 * @param props.onToggle - toggle one weekday in the rule being edited.
 * @returns the labelled Weekday row.
 */
export function RuleWeekdayRow({ weekdays, disabled, t, rowId, onToggle }: {
  weekdays: readonly number[]
  disabled: boolean
  t: PropsLocale<'schedule.manager'>['t']
  rowId: (name: string) => string
  onToggle: (weekday: Weekday) => void
}): ReactNode {
  return <div className={css.ruleRow}>
    <span className={css.ruleLabel} id={rowId('weekday')}>{t('rule.weekday')}</span>
    <div className={clsx(css.ruleWeekdays, css.ruleControl)} role="group" aria-labelledby={rowId('weekday')}>
      {WEEKDAYS.map((weekday) => {
        const selected = weekdays.includes(weekday)
        return <Pill
          key={weekday}
          className={css.ruleControl}
          active={selected}
          disabled={disabled}
          aria-pressed={selected}
          aria-label={t('rule.weekdayOption', { weekday: t(WEEKDAY_LABELS[weekday]) })}
          onClick={() => { onToggle(weekday) }}
        >{t(WEEKDAY_LABELS[weekday])}</Pill>
      })}
    </div>
  </div>
}

/** Inputs of one whole-number stepper of the task rule form. */
interface RuleStepperProps {
  /** Id the row's label points at. */
  readonly id: string
  /** Smallest value the field accepts. */
  readonly min: number
  /** Largest value the field accepts. */
  readonly max: number
  /** Staged value. */
  readonly value: number
  /** Whether every edit is blocked. */
  readonly disabled: boolean
  /** Accessible name of the up arrow. */
  readonly increaseLabel: string
  /** Accessible name of the down arrow. */
  readonly decreaseLabel: string
  /** Stage one clamped whole value. */
  readonly onChange: (value: number) => void
}

/**
 * One whole-number stepper of the task rule form, such as the repeat interval or
 * the day of the month. Values clamp to the field's bounds, and an emptied or
 * fractional input stages nothing, so the staged rule stays valid on every edit.
 * @param props - bounds, staged value, blocking state, arrow labels, and callback.
 * @returns the stepper pill.
 */
export function RuleStepper({ id, min, max, value, disabled, increaseLabel, decreaseLabel, onChange }: RuleStepperProps): ReactNode {
  const clamp = (next: number): number => Math.min(max, Math.max(min, next))
  return <span
    className={css.ruleIntervalStepper}
    style={{ '--interval-digits': String(value).length } as CSSProperties}
  >
    <input
      id={id}
      className={clsx(css.ruleInput, css.ruleControl, css.ruleIntervalInput)}
      type="number"
      min={min}
      max={max}
      step={1}
      disabled={disabled}
      value={value}
      onChange={(event) => {
        const next = Number(event.target.value)
        if (event.target.value === '' || !Number.isSafeInteger(next)) return
        onChange(clamp(next))
      }}
    />
    <span className={css.ruleIntervalArrows}>
      <button
        type="button"
        className={css.ruleIntervalArrow}
        aria-label={increaseLabel}
        disabled={disabled || value >= max}
        onClick={() => { onChange(clamp(value + 1)) }}
      >
        <IconChevronUpOutlineRegular size={9} />
      </button>
      <button
        type="button"
        className={css.ruleIntervalArrow}
        aria-label={decreaseLabel}
        disabled={disabled || value <= min}
        onClick={() => { onChange(clamp(value - 1)) }}
      >
        <IconChevronDownOutlineRegular size={9} />
      </button>
    </span>
  </span>
}
