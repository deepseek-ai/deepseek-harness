// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EffortSlider, type EffortSliderProps } from '../src/client/EffortSlider.tsx'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const choices = ['off', 'low', 'high', 'max'].map(effort => ({ key: effort, effort, label: effort }))
function props(overrides: Partial<EffortSliderProps> = {}): EffortSliderProps {
  return {
    choices, value: 'high', label: 'Effort', currentLabel: 'high', disabled: false, pending: false,
    formatTooltip: effort => `Reasoning effort: ${effort}`, onSelect: vi.fn(), ...overrides,
  }
}
function range(): HTMLInputElement {
  return screen.getByRole('slider') as HTMLInputElement
}

it.each(Object.entries({ zh, en, ja, es, fr, de, ru, pt }))('localizes the tag tooltip (%s)', (_locale, dictionary) => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(hover: hover)' || query === '(any-hover: hover)', media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: () => true,
  }))
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  const t = makeTranslate(dictionary)
  const inputProps = props({
    choices: [{ key: 'default', effort: undefined, label: 'Default' }, { key: 'high', effort: 'high', label: 'High' }],
    formatTooltip: effort => t('effort.tooltip', { effort }),
  })
  const view = render(<EffortSlider {...inputProps} />)
  const tag = screen.getByText('High')
  expect(tag.tabIndex).toBe(-1)
  fireEvent.pointerEnter(tag, { pointerType: 'mouse' })
  act(() => { vi.advanceTimersByTime(500) })
  const tooltip = screen.getByRole('tooltip', { hidden: true })
  expect(tooltip.textContent).toBe(dictionary['effort.tooltip'].replace('{effort}', 'High'))
  view.rerender(<EffortSlider {...inputProps} value={undefined} />)
  expect(tooltip.textContent).toBe(dictionary['effort.tooltip'].replace('{effort}', 'Default'))
  expect(inputProps.onSelect).not.toHaveBeenCalled()
})

it('shows exact advertised stops and the selected value', () => {
  render(<EffortSlider {...props()} />)
  expect(range().max).toBe('3')
  expect(range().value).toBe('2')
  expect(range().getAttribute('aria-valuetext')).toBe('high')
  expect(range().min).toBe('0')
  expect(range().step).toBe('1')
  expect(screen.getByText('high').tabIndex).toBe(-1)
  expect(screen.queryByRole('button')).toBeNull()
})

it('previews a drag but submits only its final stop on release', () => {
  const inputProps = props()
  render(<EffortSlider {...inputProps} />)
  const input = range()
  fireEvent.pointerDown(input, { pointerId: 1 })
  fireEvent.change(input, { target: { value: '1' } })
  fireEvent.change(input, { target: { value: '3' } })
  expect(input.getAttribute('aria-valuetext')).toBe('max')
  expect(inputProps.onSelect).not.toHaveBeenCalled()
  fireEvent.pointerUp(input, { pointerId: 1 })
  expect(inputProps.onSelect).toHaveBeenCalledExactlyOnceWith('max')
})

it.each(['pointerCancel', 'lostPointerCapture', 'blur'] as const)('cancels a drag on %s', (event) => {
  const inputProps = props()
  render(<EffortSlider {...inputProps} />)
  const input = range()
  fireEvent.pointerDown(input)
  fireEvent.change(input, { target: { value: '3' } })
  fireEvent[event](input)
  fireEvent.pointerUp(input)
  expect(inputProps.onSelect).not.toHaveBeenCalled()
  expect(input.value).toBe('2')
})

it('Escape discards the drag and ignores further movement until release', () => {
  const inputProps = props()
  const parentKey = vi.fn()
  render(<div onKeyDown={parentKey}><EffortSlider {...inputProps} /></div>)
  const input = range()
  fireEvent.pointerDown(input)
  fireEvent.change(input, { target: { value: '3' } })
  fireEvent.keyDown(input, { key: 'Escape' })
  fireEvent.change(input, { target: { value: '0' } })
  fireEvent.pointerUp(input)
  expect(inputProps.onSelect).not.toHaveBeenCalled()
  expect(parentKey).not.toHaveBeenCalled()
  expect(input.value).toBe('2')
})

it('commits keyboard changes on key release without forwarding adjustment keys', () => {
  const inputProps = props()
  const parentKey = vi.fn()
  render(<div onKeyDown={parentKey}><EffortSlider {...inputProps} /></div>)
  const input = range()
  fireEvent.keyDown(input, { key: 'ArrowLeft' })
  fireEvent.change(input, { target: { value: '1' } })
  fireEvent.keyDown(input, { key: 'ArrowLeft', repeat: true })
  fireEvent.change(input, { target: { value: '0' } })
  expect(inputProps.onSelect).not.toHaveBeenCalled()
  fireEvent.keyUp(input, { key: 'ArrowLeft' })
  expect(inputProps.onSelect).toHaveBeenCalledExactlyOnceWith('off')
  expect(parentKey).not.toHaveBeenCalled()
})

it('lets Tab and an idle Escape reach the owning menu', () => {
  const parentKey = vi.fn()
  render(<div onKeyDown={parentKey}><EffortSlider {...props()} /></div>)
  fireEvent.keyDown(range(), { key: 'Tab' })
  fireEvent.keyDown(range(), { key: 'Escape' })
  fireEvent.keyUp(range(), { key: 'Tab' })
  expect(parentKey).toHaveBeenCalledTimes(2)
})

it('handles a direct assistive-technology change without a preceding pointer or keyboard gesture', () => {
  const inputProps = props()
  render(<EffortSlider {...inputProps} />)
  fireEvent.change(range(), { target: { value: '1' } })
  expect(inputProps.onSelect).toHaveBeenCalledExactlyOnceWith('low')
})

it('keeps Default distinct from Off and submits an absent effort', () => {
  const inputProps = props({ choices: [{ key: 'default', effort: undefined, label: 'Default' }, ...choices] })
  render(<EffortSlider {...inputProps} />)
  expect(range().max).toBe('4')
  fireEvent.change(range(), { target: { value: '0' } })
  expect(inputProps.onSelect).toHaveBeenCalledExactlyOnceWith(undefined)
})

it('does not submit a gesture started before the persisted selection changes', () => {
  const inputProps = props()
  const view = render(<EffortSlider {...inputProps} />)
  const input = range()
  fireEvent.pointerDown(input)
  fireEvent.change(input, { target: { value: '3' } })
  view.rerender(<EffortSlider {...inputProps} value="low" />)
  fireEvent.pointerUp(input)
  expect(inputProps.onSelect).not.toHaveBeenCalled()
  expect(input.value).toBe('1')
})

it('blocks selection while locked', () => {
  const inputProps = props({ disabled: true })
  render(<EffortSlider {...inputProps} />)
  expect(range().disabled).toBe(true)
  fireEvent.change(range(), { target: { value: '3' } })
  expect(inputProps.onSelect).not.toHaveBeenCalled()
})

it('does not commit when another selection locks the control during a gesture', () => {
  const inputProps = props()
  const view = render(<EffortSlider {...inputProps} />)
  const input = range()
  fireEvent.pointerDown(input)
  fireEvent.change(input, { target: { value: '3' } })
  view.rerender(<EffortSlider {...inputProps} disabled />)
  fireEvent.pointerUp(input)
  expect(inputProps.onSelect).not.toHaveBeenCalled()
})

it('leaves IME composition keys untouched', () => {
  const inputProps = props()
  const key = vi.fn()
  render(<div onKeyDown={key}><EffortSlider {...inputProps} /></div>)
  fireEvent.keyDown(range(), { key: 'ArrowRight', isComposing: true })
  expect(key).toHaveBeenCalledOnce()
  expect(inputProps.onSelect).not.toHaveBeenCalled()
})

it('does not pretend an unknown stored effort matches the first supported stop', () => {
  render(<EffortSlider {...props({ value: 'retired', currentLabel: 'retired' })} />)
  expect(range().disabled).toBe(true)
  expect(range().getAttribute('aria-valuetext')).toBe('retired')
  expect(screen.getByText('retired')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
})

it.each([{ levels: [] }, { levels: choices.slice(0, 1) }])('does not offer dragging with fewer than two choices', ({ levels }) => {
  render(<EffortSlider {...props({ choices: levels, value: 'off' })} />)
  expect(range().disabled).toBe(true)
  expect(range().max).toBe('0')
})

it('keeps the pending target focusable while blocking pointer, keyboard and direct changes', () => {
  const inputProps = props({ value: 'max', pending: true })
  render(<EffortSlider {...inputProps} />)
  const input = range()
  input.focus()
  expect(input.disabled).toBe(false)
  expect(input.getAttribute('aria-disabled')).toBe('true')
  expect(input.getAttribute('aria-busy')).toBe('true')
  expect(input.value).toBe('3')
  expect(input.getAttribute('aria-valuetext')).toBe('max')
  expect(fireEvent.pointerDown(input)).toBe(false)
  expect(fireEvent.keyDown(input, { key: 'ArrowLeft' })).toBe(false)
  fireEvent.change(input, { target: { value: '0' } })
  fireEvent.keyUp(input, { key: 'ArrowLeft' })
  fireEvent.pointerUp(input)
  expect(inputProps.onSelect).not.toHaveBeenCalled()
  expect(input.value).toBe('3')
  expect(document.activeElement).toBe(input)
})
