// @vitest-environment jsdom
/**
 * Clock and date picker panels for values the task form never stages, and
 * keys that neither move nor pick.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ClockPicker } from '../src/client/ClockPicker.tsx'
import { DatePicker } from '../src/client/DatePicker.tsx'
import { en } from '../src/client/task-manager-locales.ts'

const t = makeTranslate(en)
let anchor: HTMLButtonElement

beforeEach(() => {
  // jsdom has no `scrollIntoView`, which the open clock panel calls.
  Element.prototype.scrollIntoView = vi.fn()
  anchor = document.createElement('button')
  document.body.append(anchor)
})
afterEach(() => { cleanup(); vi.useRealTimers(); anchor.remove() })

/**
 * Props of one open panel under the shared trigger.
 * @param value - staged clock or date text.
 * @returns the props both pickers take, with spied pick and close callbacks.
 */
function panel(value: string) {
  return { open: true, anchorRef: { current: anchor }, value, onPick: vi.fn(), onClose: vi.fn(), t }
}

describe('ClockPicker', () => {
  it('starts a value without a clock at midnight', () => {
    const props = panel('')
    render(<ClockPicker {...props} />)
    const clock = screen.getByRole('dialog', { name: en['timing.time'] })
    for (const name of [en['timing.hour'], en['timing.minute'], en['timing.second']]) {
      const selected = within(within(clock).getByRole('listbox', { name })).getAllByRole('option', { selected: true })
      expect(selected.map(option => option.textContent)).toEqual(['00'])
    }
    fireEvent.click(within(within(clock).getByRole('listbox', { name: en['timing.hour'] })).getByRole('option', { name: '07' }))
    expect(props.onPick).toHaveBeenCalledExactlyOnceWith('07:00:00')
  })

  it('adds zero seconds to a minute clock without a seconds column', () => {
    const props = panel('09:30')
    render(<ClockPicker {...props} seconds={false} />)
    expect(screen.queryByRole('listbox', { name: en['timing.second'] })).toBeNull()
    fireEvent.click(within(screen.getByRole('listbox', { name: en['timing.minute'] })).getByRole('option', { name: '05' }))
    expect(props.onPick).toHaveBeenCalledExactlyOnceWith('09:05:00')
  })

  it('keeps the focused option on a key that neither moves nor picks', () => {
    const props = panel('09:30:00')
    render(<ClockPicker {...props} />)
    const hour = within(screen.getByRole('listbox', { name: en['timing.hour'] })).getByRole('option', { name: '09' })
    expect(document.activeElement).toBe(hour)
    fireEvent.keyDown(hour, { key: 'a' })
    expect(document.activeElement).toBe(hour)
    expect(props.onPick).not.toHaveBeenCalled()
  })
})

describe('DatePicker', () => {
  it('opens a value without a date on today', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 15, 12))
    const props = panel('')
    render(<DatePicker {...props} />)
    const grid = screen.getByRole('grid', { name: 'October 2026' })
    const today = within(grid).getByRole('gridcell', { name: '15' })
    expect(today.getAttribute('aria-current')).toBe('date')
    expect(document.activeElement).toBe(today)
    fireEvent.click(within(grid).getByRole('gridcell', { name: '20' }))
    expect(props.onPick).toHaveBeenCalledExactlyOnceWith('2026-10-20')
  })

  it('keeps the focused day on a key that neither moves nor picks', () => {
    const props = panel('2026-10-15')
    render(<DatePicker {...props} />)
    const day = within(screen.getByRole('grid', { name: 'October 2026' })).getByRole('gridcell', { name: '15' })
    expect(document.activeElement).toBe(day)
    fireEvent.keyDown(day, { key: 'a' })
    expect(document.activeElement).toBe(day)
    expect(props.onPick).not.toHaveBeenCalled()
  })
})
