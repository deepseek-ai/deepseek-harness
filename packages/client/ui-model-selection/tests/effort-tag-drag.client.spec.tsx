// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { EffortSlider, type EffortSliderProps } from '../src/client/EffortSlider.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function setup(value: string | null = 'off', includeDefault = false, parentKey?: ComponentProps<'div'>['onKeyDown']) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('hover: hover'), media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: () => true,
  }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const levels = ['off', 'low', 'high', 'max'].map(effort => ({ key: effort, effort, label: effort }))
  const props: EffortSliderProps = {
    choices: includeDefault ? [{ key: 'default', effort: undefined, label: 'Default' }, ...levels] : levels,
    value: value ?? undefined, label: 'Effort', currentLabel: value ?? 'Default', formatLabel: label => `Effort: ${label}`,
    defaultInfoLabel: 'About default effort', defaultExplanation: 'Uses the model defaults, not reasoning off.',
    disabled: false, pending: false, onSelect: vi.fn(),
  }
  const slider = <EffortSlider {...props} />
  const view = render(parentKey === undefined ? slider : <div onKeyDown={parentKey}>{slider}</div>)
  const input = screen.getByRole<HTMLInputElement>('slider')
  const tag = screen.getByRole<HTMLButtonElement>('button', { name: /^Effort:/ })
  const thumb = view.container.querySelector<HTMLElement>('[data-effort-thumb]')!
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 40, 220, 40))
  vi.spyOn(thumb, 'getBoundingClientRect').mockImplementation(() => new DOMRect(Number(input.value) / Number(input.max) * 200, 50, 20, 20))
  vi.spyOn(tag, 'getBoundingClientRect').mockImplementation(() => {
    const center = 10 + Number(input.value) / Number(input.max) * 200
    return new DOMRect(Math.max(0, Math.min(120, center - 50)), 0, 100, 28)
  })
  const captured = new Set<number>()
  const tagCapture = vi.fn((id: number) => { captured.add(id) })
  tag.setPointerCapture = tagCapture
  tag.hasPointerCapture = vi.fn((id: number) => captured.has(id))
  const tagRelease = vi.fn((id: number) => { captured.delete(id) })
  tag.releasePointerCapture = tagRelease
  const inputCapture = vi.fn()
  input.setPointerCapture = inputCapture
  const pointer = (target: HTMLElement, type: string, x: number, y = 14, pointerType = 'mouse') => fireEvent(target,
    Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }),
      { pointerId: 1, pointerType, isPrimary: true }))
  return { ...view, props, input, tag, thumb, pointer, tagCapture, tagRelease, inputCapture }
}

it('focuses the range on a tag click without selecting or opening an effort menu', () => {
  const view = setup()
  fireEvent.click(view.tag)
  expect(document.activeElement).toBe(view.input)
  expect(view.props.onSelect).not.toHaveBeenCalled()
  expect(screen.queryByRole('menuitemradio')).toBeNull()
})

it.each(['mouse', 'touch'])('does not turn a sub-threshold %s movement into a selection', (pointerType) => {
  const view = setup()
  view.pointer(view.tag, 'pointerdown', 80, 14, pointerType)
  view.pointer(view.tag, 'pointermove', 82, 14, pointerType)
  view.pointer(view.tag, 'pointerup', 82, 14, pointerType)
  fireEvent.click(view.tag)
  expect(view.input.value).toBe('0')
  expect(view.props.onSelect).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(view.input)
  expect(view.inputCapture).not.toHaveBeenCalled()
})

it.each([
  { start: 'off', down: 80, move: 120, expected: 'low', index: '1' },
  { start: 'max', down: 130, move: 90, expected: 'high', index: '2' },
])('preserves the thumb-relative offset when the $start tag is clamped to an edge', ({ start, down, move, expected, index }) => {
  const view = setup(start)
  view.pointer(view.tag, 'pointerdown', down)
  view.pointer(view.tag, 'pointermove', move)
  expect(view.input.value).toBe(index)
  expect(view.props.onSelect).not.toHaveBeenCalled()
  expect(view.tagCapture).toHaveBeenCalledWith(1)
  view.pointer(view.tag, 'pointerup', move)
  fireEvent.click(view.tag)
  expect(view.props.onSelect).toHaveBeenCalledExactlyOnceWith(expected)
  expect(view.inputCapture).not.toHaveBeenCalled()
})

it.each(['pointercancel', 'lostpointercapture', 'Escape', 'blur'])('discards a tag drag on %s and ignores its late release', (cancel) => {
  const view = setup()
  view.pointer(view.tag, 'pointerdown', 80)
  view.pointer(view.tag, 'pointermove', 160)
  expect(view.props.onSelect).not.toHaveBeenCalled()
  if (cancel === 'Escape') fireEvent.keyDown(view.input, { key: 'Escape' })
  else if (cancel === 'blur') fireEvent.blur(view.input)
  else view.pointer(view.tag, cancel, 160)
  expect(view.tag.hasPointerCapture(1)).toBe(false)
  expect(view.tagRelease).toHaveBeenCalledExactlyOnceWith(1)
  view.pointer(view.tag, 'pointerup', 160)
  expect(view.input.value).toBe('0')
  expect(view.props.onSelect).not.toHaveBeenCalled()
})

it('lets the second Escape reach the menu after cancelling a caption drag and releasing the pointer', () => {
  const parentKey = vi.fn()
  const view = setup('off', false, parentKey)
  view.pointer(view.tag, 'pointerdown', 80)
  view.pointer(view.tag, 'pointermove', 160)
  expect(view.input.value).not.toBe('0')
  const cancel = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  fireEvent(view.input, cancel)
  expect(cancel.defaultPrevented).toBe(true)
  expect(parentKey).not.toHaveBeenCalled()
  expect(view.input.value).toBe('0')
  view.pointer(view.tag, 'pointerup', 160)
  expect(view.props.onSelect).not.toHaveBeenCalled()
  const close = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  fireEvent(view.input, close)
  expect(close.defaultPrevented).toBe(false)
  expect(parentKey).toHaveBeenCalledOnce()
  expect(view.input.value).toBe('0')
  expect(view.props.onSelect).not.toHaveBeenCalled()
})

it('discards a tag gesture when a different selection arrives', () => {
  const view = setup()
  view.pointer(view.tag, 'pointerdown', 80)
  view.pointer(view.tag, 'pointermove', 160)
  view.rerender(<EffortSlider {...view.props} value="low" />)
  view.pointer(view.tag, 'pointerup', 160)
  expect(view.input.value).toBe('1')
  expect(view.props.onSelect).not.toHaveBeenCalled()
})

it.each(['pending', 'disabled'] as const)('prevents tag selection while %s', (state) => {
  const view = setup()
  view.rerender(<EffortSlider {...view.props} {...{ [state]: true }} />)
  view.pointer(view.tag, 'pointerdown', 80)
  view.pointer(view.tag, 'pointermove', 160)
  view.pointer(view.tag, 'pointerup', 160)
  expect(view.props.onSelect).not.toHaveBeenCalled()
  expect(view.tagCapture).not.toHaveBeenCalled()
})

it.each(['source', 'catalog', 'pending', 'disabled', 'unmount'] as const)('releases caption capture when %s invalidates the drag', (change) => {
  const view = setup()
  view.pointer(view.tag, 'pointerdown', 80)
  view.pointer(view.tag, 'pointermove', 160)
  expect(view.tag.hasPointerCapture(1)).toBe(true)
  if (change === 'unmount') view.unmount()
  else view.rerender(<EffortSlider {...view.props}
    {...change === 'source' ? { value: 'low' }
      : change === 'catalog' ? { choices: view.props.choices.slice(0, 3) }
        : { [change]: true }} />)
  expect(view.tag.hasPointerCapture(1)).toBe(false)
  expect(view.tagRelease).toHaveBeenCalledExactlyOnceWith(1)
  view.pointer(view.tag, 'pointerup', 160)
  expect(view.props.onSelect).not.toHaveBeenCalled()
})

it.each(['range', 'caption'] as const)('snaps %s motion within 10px of a stop but follows beyond it', (surface) => {
  const view = setup(null, true)
  const target = surface === 'range' ? view.input : view.tag
  const start = surface === 'range' ? 10 : 80
  const y = surface === 'range' ? 60 : 14
  view.pointer(target, 'pointerdown', start, y)
  // Five stops over a measured 200px travel put the first advertised level at 50px.
  for (const offset of [-11, -10, -9, 9, 10, 11]) {
    view.pointer(target, 'pointermove', start + 50 + offset, y)
    if (surface === 'range') fireEvent.change(view.input, { target: { value: '1' } })
    const position = Number(view.input.closest<HTMLElement>('[role="group"]')!.style.getPropertyValue('--effort-visual-position'))
    expect(position * 200).toBeCloseTo(Math.abs(offset) <= 10 ? 50 : 50 + offset, 5)
    expect(view.input.value).toBe('1')
    expect(view.props.onSelect).not.toHaveBeenCalled()
  }
  view.pointer(target, 'pointerup', start + 61, y)
  expect(view.props.onSelect).toHaveBeenCalledExactlyOnceWith('off')
  expect(view.inputCapture).not.toHaveBeenCalled()
  expect(view.tag.hasPointerCapture(1)).toBe(false)
})

it('keeps default information independent from the draggable caption', () => {
  const view = setup(null, true)
  const info = screen.getByRole('button', { name: 'About default effort' })
  expect(view.tag.contains(info)).toBe(false)
  view.pointer(info, 'pointerdown', 100)
  view.pointer(info, 'pointerup', 100)
  fireEvent.click(info)
  expect(screen.getByRole('tooltip', { hidden: true }).textContent).toContain('model defaults')
  expect(view.props.onSelect).not.toHaveBeenCalled()
  expect(view.tagCapture).not.toHaveBeenCalled()
})

it('keeps the draggable caption free of SVG and tail decoration', () => {
  const view = setup()
  const tag = view.container.querySelector('[data-effort-tag]')!
  expect(tag.querySelector('svg')).toBeNull()
  expect(view.container.querySelector('[data-effort-tail-frame], [data-effort-tail], [data-effort-tail-edge]')).toBeNull()
  fireEvent.click(view.tag)
  expect(document.activeElement).toBe(view.input)
  expect(view.props.onSelect).not.toHaveBeenCalled()
})

it('keeps native range gestures free of explicit pointer capture', () => {
  const view = setup()
  view.pointer(view.input, 'pointerdown', 10, 60)
  fireEvent.change(view.input, { target: { value: '1' } })
  view.pointer(view.input, 'pointerup', 76, 60)
  expect(view.inputCapture).not.toHaveBeenCalled()
  expect(view.tagCapture).not.toHaveBeenCalled()
  expect(view.props.onSelect).toHaveBeenCalledExactlyOnceWith('low')
})
