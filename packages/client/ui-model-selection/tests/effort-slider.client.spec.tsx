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
    formatLabel: effort => `Effort: ${effort}`,
    defaultInfoLabel: en['effort.defaultInfoLabel'], defaultExplanation: en['effort.defaultExplanation'],
    onSelect: vi.fn(), ...overrides,
  }
}
function range(): HTMLInputElement {
  return screen.getByRole('slider') as HTMLInputElement
}
function effortLabel(): HTMLElement {
  return range().closest('[role="group"]')!.querySelector<HTMLElement>('[data-effort-label]')!
}

function tooltipLayout() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('hover: hover'), media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: () => true,
  }))
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
}

it.each(Object.entries({ zh, en, ja, es, fr, de, ru, pt }))('shows the full localized label and default explanation (%s)', (_locale, dictionary) => {
  tooltipLayout()
  const t = makeTranslate(dictionary)
  const high = dictionary['effort.high']
  const defaultLabel = dictionary['effort.providerDefault']
  const inputProps = props({
    choices: [{ key: 'default', effort: undefined, label: defaultLabel }, { key: 'high', effort: 'high', label: high }],
    formatLabel: effort => t('effort.tooltip', { effort }),
    defaultInfoLabel: dictionary['effort.defaultInfoLabel'], defaultExplanation: dictionary['effort.defaultExplanation'],
  })
  const view = render(<EffortSlider {...inputProps} />)
  expect(effortLabel().textContent).toBe(dictionary['effort.tooltip'].replace('{effort}', high))
  expect(effortLabel().tabIndex).toBe(-1)
  expect(effortLabel().querySelector('[data-effort-name]')!.textContent).toBe(high)
  expect(screen.queryByRole('button')).toBeNull()
  view.rerender(<EffortSlider {...inputProps} value={undefined} />)
  expect(effortLabel().textContent).toBe(dictionary['effort.tooltip'].replace('{effort}', defaultLabel))
  expect(effortLabel().querySelector('[data-effort-name]')!.textContent).toBe(defaultLabel)
  const info = screen.getByRole('button', { name: dictionary['effort.defaultInfoLabel'] })
  info.focus()
  fireEvent.click(info)
  expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe(dictionary['effort.defaultExplanation'])
  expect(document.activeElement).toBe(info)
  expect(inputProps.onSelect).not.toHaveBeenCalled()
  fireEvent.keyDown(info, { key: 'Escape' })
  expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
  expect(document.activeElement).toBe(info)
})

it.each([
  ['推理等级：高', zh], ['Effort: High', en], ['強度：高', ja], ['Esfuerzo: Alto', es],
  ['Effort : Élevé', fr], ['Aufwand: Hoch', de], ['Усилие: Высокий', ru], ['Esforço: Alto', pt],
] as const)('uses a compact localized caption: %s', (expected, dictionary) => {
  const t = makeTranslate(dictionary)
  render(<EffortSlider {...props({
    choices: [{ key: 'high', effort: 'high', label: dictionary['effort.high'] }],
    formatLabel: effort => t('effort.tooltip', { effort }),
  })} />)
  expect(effortLabel().textContent).toBe(expected)
})

it('protects the final effort name while preserving repeated text in the formatted prefix', () => {
  render(<EffortSlider {...props({ formatLabel: effort => `${effort} policy: ${effort}` })} />)
  const label = effortLabel()
  const name = label.querySelector('[data-effort-name]')!
  expect(label.textContent).toBe('high policy: high')
  expect(name.textContent).toBe('high')
  expect(name.previousElementSibling!.textContent).toBe('high policy: ')
  expect(range().getAttribute('aria-valuetext')).toBe('high')
})

it('only repeats the full label in a tooltip when the label is clipped', () => {
  tooltipLayout()
  vi.useFakeTimers()
  render(<EffortSlider {...props()} />)
  const label = effortLabel()
  fireEvent.pointerEnter(label, { pointerType: 'mouse' })
  act(() => { vi.advanceTimersByTime(500) })
  expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
  fireEvent.pointerLeave(label, { pointerType: 'mouse' })
  Object.defineProperty(label, 'scrollWidth', { configurable: true, value: 200 })
  Object.defineProperty(label, 'clientWidth', { configurable: true, value: 80 })
  fireEvent.pointerEnter(label, { pointerType: 'mouse' })
  act(() => { vi.advanceTimersByTime(500) })
  expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe('Effort: high')
})

it('closes default information on a second activation or Tab without selecting an effort', () => {
  tooltipLayout()
  const inputProps = props({ choices: [{ key: 'default', effort: undefined, label: 'Default' }, ...choices], value: undefined })
  render(<EffortSlider {...inputProps} />)
  const info = screen.getByRole('button', { name: en['effort.defaultInfoLabel'] })
  info.focus()
  fireEvent.click(info)
  expect(screen.getByRole('tooltip', { hidden: true })).toBeTruthy()
  fireEvent.click(info)
  expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
  fireEvent.click(info)
  fireEvent.keyDown(info, { key: 'Tab' })
  expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
  expect(inputProps.onSelect).not.toHaveBeenCalled()
  expect(range().value).toBe('0')
})

it('shows exact advertised stops and the selected value', () => {
  render(<EffortSlider {...props()} />)
  expect(range().max).toBe('3')
  expect(range().value).toBe('2')
  expect(range().getAttribute('aria-valuetext')).toBe('high')
  expect(range().min).toBe('0')
  expect(range().step).toBe('1')
  expect(effortLabel().textContent).toBe('Effort: high')
  expect(effortLabel().tabIndex).toBe(-1)
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
  expect(effortLabel().textContent).toBe('Effort: retired')
  expect(screen.queryByRole('button')).toBeNull()
})

it.each([{ levels: [] }, { levels: choices.slice(0, 1) }])('does not offer dragging with fewer than two choices', ({ levels }) => {
  render(<EffortSlider {...props({ choices: levels, value: 'off' })} />)
  expect(range().disabled).toBe(true)
  expect(range().max).toBe('0')
})

function motionSetup() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(hover: hover) and (pointer: fine)', media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: () => true,
  }))
  const inputProps = props({ value: 'off', currentLabel: 'off' })
  const view = render(<EffortSlider {...inputProps} />)
  const input = range()
  const thumb = view.container.querySelector<HTMLElement>('[data-effort-thumb]')!
  const scale = view.container.querySelector<HTMLElement>('[data-effort-thumb-scale]')!
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 220, 40))
  vi.spyOn(thumb, 'getBoundingClientRect').mockImplementation(() => new DOMRect(Number(input.value) / 3 * 200, 10, 20, 20))
  const pointer = (type: string, x: number, pointerType = 'mouse') => fireEvent(input,
    Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 20, button: 0 }),
      { pointerType, pointerId: 1, isPrimary: true }))
  return { ...view, input, inputProps, thumb, scale, pointer }
}

it('keeps the visual track and thumb inert while the native range owns interaction', () => {
  const view = motionSetup()
  expect(screen.getAllByRole('slider')).toHaveLength(1)
  expect(view.thumb.closest('[aria-hidden="true"]')).toBeTruthy()
  expect(view.container.querySelector('[data-effort-fill]')!.closest('[aria-hidden="true"]')).toBeTruthy()
  expect(view.thumb.tabIndex).toBe(-1)
  expect(view.scale.tabIndex).toBe(-1)
  expect(screen.queryByRole('button')).toBeNull()
})

it('hovers one tick in its 16px target without selecting and does not retain touch hover', () => {
  const view = motionSetup()
  view.pointer('pointermove', 10)
  expect(view.scale.hasAttribute('data-expanded')).toBe(true)
  view.pointer('pointermove', 10 + 200 / 3 + 7)
  expect(view.scale.hasAttribute('data-expanded')).toBe(false)
  expect(view.container.querySelectorAll('[data-effort-tick][data-hovered]')).toHaveLength(1)
  expect(view.container.querySelector('[data-effort-tick="1"]')!.hasAttribute('data-hovered')).toBe(true)
  view.pointer('pointermove', 10 + 200 / 3 + 9)
  expect(view.container.querySelector('[data-hovered]')).toBeNull()
  view.pointer('pointermove', 10)
  view.pointer('pointermove', 10, 'touch')
  expect(view.scale.hasAttribute('data-expanded')).toBe(false)
  expect(view.container.querySelector('[data-hovered]')).toBeNull()
  expect(view.input.value).toBe('0')
  expect(view.inputProps.onSelect).not.toHaveBeenCalled()
})

it.each(['pointercancel', 'blur', 'Escape'])('cancels motion decoration and the native preview on %s', (cancel) => {
  const view = motionSetup()
  view.pointer('pointerdown', 16)
  view.pointer('pointermove', 60)
  fireEvent.change(view.input, { target: { value: '1' } })
  expect(view.input.parentElement!.hasAttribute('data-dragging')).toBe(true)
  expect(view.container.querySelector('[data-hovered]')).toBeNull()
  if (cancel === 'Escape') fireEvent.keyDown(view.input, { key: 'Escape' })
  else if (cancel === 'blur') fireEvent.blur(view.input)
  else view.pointer(cancel, 60)
  view.pointer('pointerup', 60)
  expect(view.input.parentElement!.hasAttribute('data-dragging')).toBe(false)
  expect(view.input.value).toBe('0')
  expect(view.inputProps.onSelect).not.toHaveBeenCalled()
})

it('keeps a native pointer gesture when focus moves to an ancestor before the first move', () => {
  const view = motionSetup()
  act(() => {
    view.pointer('pointerdown', 16)
    fireEvent.blur(view.input, { relatedTarget: view.input.parentElement })
  })
  expect(view.scale.hasAttribute('data-expanded')).toBe(true)
  view.pointer('pointermove', 76)
  fireEvent.change(view.input, { target: { value: '1' } })
  expect(view.input.parentElement!.hasAttribute('data-dragging')).toBe(true)
  expect(view.inputProps.onSelect).not.toHaveBeenCalled()
  view.pointer('pointerup', 76)
  expect(view.inputProps.onSelect).toHaveBeenCalledExactlyOnceWith('low')
})

it('restores range focus before submitting a valid native pointer release', () => {
  const view = motionSetup()
  view.input.focus()
  view.pointer('pointerdown', 16)
  const ancestor = view.input.parentElement!
  ancestor.tabIndex = -1
  act(() => { ancestor.focus() })
  fireEvent.change(view.input, { target: { value: '1' } })
  vi.mocked(view.inputProps.onSelect).mockImplementation(() => { expect(document.activeElement).toBe(view.input) })
  view.pointer('pointerup', 76)
  expect(view.inputProps.onSelect).toHaveBeenCalledExactlyOnceWith('low')
})

it('does not steal outside focus when a cancelled pointer later releases', () => {
  const view = motionSetup()
  view.input.focus()
  view.pointer('pointerdown', 16)
  fireEvent.change(view.input, { target: { value: '1' } })
  const outside = document.createElement('button')
  view.container.append(outside)
  act(() => { outside.focus() })
  view.pointer('pointerup', 76)
  expect(document.activeElement).toBe(outside)
  expect(view.inputProps.onSelect).not.toHaveBeenCalled()
})

it.each(['null', 'outside', 'keyboard-ancestor'])('still cancels a preview on %s focus loss', (kind) => {
  const view = motionSetup()
  if (kind === 'keyboard-ancestor') fireEvent.keyDown(view.input, { key: 'End' })
  else view.pointer('pointerdown', 16)
  fireEvent.change(view.input, { target: { value: '1' } })
  const outside = document.createElement('button')
  view.container.append(outside)
  fireEvent.blur(view.input, {
    relatedTarget: kind === 'keyboard-ancestor' ? view.input.parentElement : kind === 'outside' ? outside : null,
  })
  if (kind === 'keyboard-ancestor') fireEvent.keyUp(view.input, { key: 'End' })
  else view.pointer('pointerup', 76)
  expect(view.input.value).toBe('0')
  expect(view.input.parentElement!.hasAttribute('data-dragging')).toBe(false)
  expect(view.inputProps.onSelect).not.toHaveBeenCalled()
})

it('retains thumb hover through a pending save without accepting more values', () => {
  const view = motionSetup()
  view.pointer('pointerdown', 10)
  fireEvent.change(view.input, { target: { value: '1' } })
  view.pointer('pointerup', 10 + 200 / 3)
  expect(view.inputProps.onSelect).toHaveBeenCalledExactlyOnceWith('low')
  expect(view.scale.hasAttribute('data-expanded')).toBe(true)
  view.rerender(<EffortSlider {...view.inputProps} value="low" pending />)
  expect(view.scale.hasAttribute('data-expanded')).toBe(true)
  view.pointer('pointermove', 10 + 200 / 3)
  expect(view.scale.hasAttribute('data-expanded')).toBe(true)
  fireEvent.change(view.input, { target: { value: '3' } })
  expect(view.input.value).toBe('1')
  expect(view.inputProps.onSelect).toHaveBeenCalledTimes(1)
  view.rerender(<EffortSlider {...view.inputProps} value="low" />)
  expect(view.scale.hasAttribute('data-expanded')).toBe(true)
})

it('clears hover and motion when locked or when the advertised catalog changes', () => {
  const view = motionSetup()
  view.pointer('pointermove', 10)
  expect(view.scale.hasAttribute('data-expanded')).toBe(true)
  view.rerender(<EffortSlider {...view.inputProps} disabled />)
  expect(view.scale.hasAttribute('data-expanded')).toBe(false)
  expect(view.input.disabled).toBe(true)
  view.pointer('pointermove', 10)
  expect(view.scale.hasAttribute('data-expanded')).toBe(false)
  view.rerender(<EffortSlider {...view.inputProps} />)
  view.pointer('pointermove', 10)
  view.rerender(<EffortSlider {...view.inputProps} choices={choices.slice(0, 2)} />)
  expect(view.scale.hasAttribute('data-expanded')).toBe(false)
  expect(view.inputProps.onSelect).not.toHaveBeenCalled()
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
