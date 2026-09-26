// @vitest-environment jsdom
/** Measured microphone levels drive geometry; quiet audio never creates a synthetic signal. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { Waveform } from '../src/client/Waveform.tsx'
import { Recording } from '../src/client/audio.ts'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('samples real levels, throttles drawing, and cancels animation on unmount', () => {
  let frame: FrameRequestCallback = () => {}
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frame = callback; return 7 }))
  const cancel = vi.fn(); vi.stubGlobal('cancelAnimationFrame', cancel)
  const recording = new Recording(() => {})
  const amplitude = vi.spyOn(recording, 'amplitude').mockReturnValue(0.1)
  const view = render(<Waveform recording={recording} label="Recording" />)
  const lines = view.container.querySelectorAll('line')
  act(() => { frame(0) })
  expect(Number(lines[79]!.getAttribute('y2'))).toBeGreaterThan(21)
  act(() => { frame(20) })
  expect(amplitude).toHaveBeenCalledOnce()
  act(() => { frame(50) })
  expect(amplitude).toHaveBeenCalledTimes(2)
  view.rerender(<Waveform recording={undefined} label="Recording" />)
  act(() => { frame(100) })
  expect(lines[79]!.getAttribute('y2')).toBe('21')
  view.unmount(); expect(cancel).toHaveBeenCalledWith(7)
})
