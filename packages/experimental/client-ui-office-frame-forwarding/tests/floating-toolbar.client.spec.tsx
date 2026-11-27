// @vitest-environment jsdom
/** Preview controls remain visible while hovered or active and cancel dismissal on teardown. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useFloatingToolbar } from '../src/client/primitives/use-floating-toolbar.ts'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
test('pointer reveal, leave, active controls and unmount own their hide timer', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('PointerEvent', class extends MouseEvent { readonly pointerType: string; constructor(type: string,
    options: PointerEventInit) { super(type, options); this.pointerType = options.pointerType ?? '' } })
  let toolbar: ReturnType<typeof useFloatingToolbar>
  function Harness() { toolbar = useFloatingToolbar(); return <div data-visible={toolbar.visible} onPointerMove={
    toolbar.onPointerMove} onPointerLeave={toolbar.onPointerLeave} /> }
  const view = render(<Harness />), region = view.container.firstElementChild!
  const visible = () => region.getAttribute('data-visible')
  fireEvent.pointerMove(region, { pointerType: 'mouse', clientY: 0 })
  expect(visible()).toBe('true')
  await act(async () => { await vi.advanceTimersByTimeAsync(500) }); expect(visible()).toBe('true')
  fireEvent.pointerLeave(region)
  await act(async () => { await vi.advanceTimersByTimeAsync(419) }); expect(visible()).toBe('true')
  await act(async () => { await vi.advanceTimersByTimeAsync(1) }); expect(visible()).toBe('false')
  act(() => { toolbar.onActiveChange(true); toolbar.scheduleHide() })
  await act(async () => { await vi.advanceTimersByTimeAsync(500) }); expect(visible()).toBe('true')
  act(() => { toolbar.onActiveChange(false) })
  fireEvent.pointerMove(region, { pointerType: 'touch', clientY: 0 })
  await act(async () => { await vi.advanceTimersByTimeAsync(420) }); expect(visible()).toBe('false')
  fireEvent.pointerMove(region, { pointerType: 'mouse', clientY: -100 })
  act(() => { toolbar.show(); toolbar.scheduleHide(); toolbar.clearHide() })
  expect(vi.getTimerCount()).toBe(0)
  act(() => { toolbar.scheduleHide() }); expect(vi.getTimerCount()).toBe(1)
  view.unmount(); expect(vi.getTimerCount()).toBe(0)
})
