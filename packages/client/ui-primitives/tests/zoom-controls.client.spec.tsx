// @vitest-environment jsdom
/** Document controls share fitting, preset selection, gesture display, and focus-safe activation. */
import { createRef } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ZoomControls, type ZoomControlsHandle } from '../src/ZoomControls.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const labels = { controls: 'Document zoom', menu: 'Choose zoom', into: 'Zoom in', out: 'Zoom out', value: (percent: number) => `${String(percent)}%` }

test('shows owner-specific fitting, changes scale, and follows gesture updates without a document rerender', () => {
  const zoom = vi.fn(), fit = vi.fn(), active = vi.fn(), ref = createRef<ZoomControlsHandle>()
  const props = { zoom: 1.13, visible: true, labels, onZoom: zoom, onActiveChange: active,
    fit: { label: 'Fit page', selected: true, onSelect: fit } }
  const view = render(<ZoomControls {...props} ref={ref} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose zoom' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Fit page' }))
  expect(fit).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Choose zoom' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '150%' }))
  expect(zoom).toHaveBeenLastCalledWith(1.5)
  act(() => { ref.current!.showZoom(0.8) })
  expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain('80%')
  fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
  expect(zoom).toHaveBeenLastCalledWith(0.75)
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  expect(zoom).toHaveBeenLastCalledWith(1)
  view.rerender(<ZoomControls {...props} zoom={4} ref={ref} />)
  expect(screen.getByRole('button', { name: 'Zoom in' }).hasAttribute('disabled')).toBe(true)
  view.rerender(<ZoomControls {...props} zoom={0.25} ref={ref} />)
  expect(screen.getByRole('button', { name: 'Zoom out' }).hasAttribute('disabled')).toBe(true)
})

test('without fit, lists only presets and keeps the toolbar active during pointer, focus, and menu interaction', () => {
  const active = vi.fn(), zoom = vi.fn()
  const view = render(<ZoomControls zoom={1} visible={false} labels={labels} onZoom={zoom} onActiveChange={active} />)
  const panel = screen.getByRole('toolbar'), button = screen.getByRole('button', { name: 'Choose zoom' })
  expect(panel.hasAttribute('data-document-zoom-visible')).toBe(false)
  fireEvent.pointerEnter(panel)
  expect(active).toHaveBeenLastCalledWith(true)
  fireEvent.pointerLeave(panel)
  expect(active).toHaveBeenLastCalledWith(false)
  fireEvent.focus(button)
  expect(active).toHaveBeenLastCalledWith(true)
  fireEvent.blur(button, { relatedTarget: screen.getByRole('button', { name: 'Zoom in' }) })
  expect(active).toHaveBeenLastCalledWith(true)
  fireEvent.blur(button, { relatedTarget: document.body })
  expect(active).toHaveBeenLastCalledWith(false)
  expect(fireEvent.mouseDown(button)).toBe(false)
  expect(fireEvent.mouseDown(screen.getByRole('button', { name: 'Zoom in' }))).toBe(false)
  expect(fireEvent.mouseDown(screen.getByRole('button', { name: 'Zoom out' }))).toBe(false)
  fireEvent.click(button)
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['25%', '50%', '100%', '150%', '200%'])
  expect(active).toHaveBeenLastCalledWith(true)
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  view.unmount()
})

test('without fit, marks the matching preset and no row for an unlisted scale', () => {
  const props = { visible: true, labels, onZoom: vi.fn(), onActiveChange: vi.fn() }
  const view = render(<ZoomControls {...props} zoom={1} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose zoom' }))
  expect(screen.getAllByRole('menuitem').filter(item => item.querySelector('svg') !== null).map(item => item.textContent))
    .toEqual(['100%'])
  view.rerender(<ZoomControls {...props} zoom={1.13} />)
  expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain('113%')
  expect(screen.getAllByRole('menuitem').filter(item => item.querySelector('svg') !== null)).toEqual([])
})

test('drops a shown scale once the committed zoom changes, even when it later returns', () => {
  const zoom = vi.fn(), ref = createRef<ZoomControlsHandle>()
  const props = { visible: true, labels, onZoom: zoom, onActiveChange: vi.fn() }
  const view = render(<ZoomControls {...props} zoom={1} ref={ref} />)
  act(() => { ref.current!.showZoom(0.8) })
  view.rerender(<ZoomControls {...props} zoom={2} ref={ref} />)
  view.rerender(<ZoomControls {...props} zoom={1} ref={ref} />)
  expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain('100%')
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  expect(zoom).toHaveBeenLastCalledWith(1.25)
})
