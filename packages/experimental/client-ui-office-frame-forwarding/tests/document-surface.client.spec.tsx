// @vitest-environment jsdom
/** Production Office composition uses FF mounting, displayed state and one view through failure. */
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { officeViewFixture } from './helpers/office-view.client.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

test.each([
  ['text', false], ['text', true], ['spreadsheet', false], ['spreadsheet', true], ['presentation', false], ['presentation', true],
] as const)('%s paint requests only target background parts for presentations (docked=%s)', async (kind, docked) => {
  await using f = officeViewFixture(kind, docked)
  await f.flush()
  expect(f.paint).toHaveBeenCalled()
  for (const [, request] of f.paint.mock.calls) {
    if (kind === 'presentation') expect(request).toHaveProperty('part', 0)
    else expect(request).not.toHaveProperty('part')
  }
  expect(screen.queryByRole('alert')).toBeNull()
  expect(f.connection.frameForwardingSession(f.opened.documentId)!.rx.submittedWindow).toBeDefined()
})

test.each([
  ['spreadsheet', false], ['spreadsheet', true], ['presentation', false], ['presentation', true],
] as const)('%s switches the active part before repainting with Kit-compatible requests (docked=%s)', async (kind, docked) => {
  await using f = officeViewFixture(kind, docked)
  await f.flush()
  for (const [name, part] of [['Second', 1], ['First', 0]] as const) {
    f.paint.mockClear()
    fireEvent.click(screen.getByRole('tab', { name })); await f.flush()
    expect(f.remote.part).toHaveBeenLastCalledWith('doc', part)
    expect(f.paint).toHaveBeenCalled()
    expect(vi.mocked(f.remote.part!).mock.invocationCallOrder.at(-1)).toBeLessThan(f.paint.mock.invocationCallOrder[0]!)
    for (const [, request] of f.paint.mock.calls) {
      if (kind === 'presentation') expect(request).toHaveProperty('part', part)
      else expect(request).not.toHaveProperty('part')
    }
    expect(screen.getByRole('tab', { name }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(f.connection.frameForwardingSession(f.opened.documentId)!.rx.submittedWindow).toBeDefined()
  }
})

test('the first displayed generation gates selection until a video frame is submitted', async () => {
  await using f = officeViewFixture('text', true); f.display(false)
  await f.flush()
  expect(screen.queryByRole('alert')?.textContent).toBeUndefined()
  expect(f.view.baseElement.querySelector('[data-office-surface]')?.getAttribute('data-dsh-frame-mount')).toBe('video')
  await f.emit({ kind: 'callback', type: 2, payload: '150,300,900,450' })
  const overlay = f.view.baseElement.querySelector<HTMLElement>('[data-office-interaction-overlay]')!
  expect(overlay.style.opacity).toBe('0')
  await act(async () => { f.submit(f.paint.mock.lastCall![1]) })
  expect(overlay.style.opacity).toBe('1')
  expect(f.pagePreview).toHaveBeenCalled()
  expect(f.env.putImageData).toHaveBeenCalled()
  expect(f.paint.mock.calls[0]![1].frame).not.toHaveProperty('requestId')
})

test('same-size part changes detach the previous layer before a new generation becomes visible', async () => {
  await using f = officeViewFixture('presentation', true)
  await f.flush()
  const session = f.connection.frameForwardingSession(f.opened.documentId)!, previous = session.rx.viewport!.version
  const video = f.view.container.querySelector('video')!
  f.display(false)
  fireEvent.click(screen.getByRole('tab', { name: 'Second' })); await f.flush()
  expect(f.pagePreview).not.toHaveBeenCalled()
  expect(video.isConnected).toBe(false)
  const next = session.rx.viewport!.version
  expect(next).toBeGreaterThan(previous)
  expect(session.rx.submittedWindow).toBeUndefined()
  expect(f.view.baseElement.querySelector<HTMLElement>('[data-office-interaction-overlay]')!.style.opacity).toBe('0')
  await act(async () => { f.submit(f.paint.mock.lastCall![1]) })
  expect(session.rx.submittedWindow).toBeDefined()
  expect(f.view.baseElement.querySelector<HTMLElement>('[data-office-interaction-overlay]')!.style.opacity).toBe('1')
})

test('zoomed slides retain their static previews across part changes and reveal the selected slide until its frame arrives', async () => {
  await using f = officeViewFixture('presentation', true)
  await f.flush()
  fireEvent.click(screen.getByRole('button', { name: en.zoom }))
  fireEvent.click(screen.getByText('200%', { selector: '[role="menuitem"] *' }))
  await f.flush()
  const first = f.area().querySelector<HTMLCanvasElement>('[data-office-page-preview="0"]')!
  expect(first.hidden).toBe(false)
  fireEvent.click(screen.getByRole('tab', { name: 'Second' })); await f.flush()
  expect(first.hidden).toBe(true)
  const second = f.area().querySelector<HTMLCanvasElement>('[data-office-page-preview="1"]')!
  expect(second.hidden).toBe(false)
  f.display(false)
  fireEvent.click(screen.getByRole('tab', { name: 'First' })); await f.flush()
  expect(first.isConnected).toBe(true)
  expect(first.hidden).toBe(false)
  expect(first.style.clipPath).toBe('')
  expect(second.hidden).toBe(true)
  expect(f.area().querySelector('[data-office-page-loading]')).toBeNull()
  expect(f.pagePreview).toHaveBeenCalledTimes(2)
})

test('credit reclamation waits for the invisible acknowledgement before restoring visibility', async () => {
  await using f = officeViewFixture('text', true)
  await f.flush()
  const session = f.connection.frameForwardingSession(f.opened.documentId)!, gate = Promise.withResolvers<undefined>()
  f.wire.setViewport.mockImplementation(async (_rx, viewport) => viewport.visible ? undefined : gate.promise)
  const trim = session.trim()
  await f.flush()
  expect(f.wire.setViewport.mock.calls.at(-1)![1].visible).toBe(false)
  gate.resolve(undefined); await trim; await f.flush()
  expect(f.wire.setViewport.mock.calls.at(-1)![1].visible).toBe(true)
})

test.each([false, true])('Desktop presentation errors repaint the latest window without retiring its mount (docked=%s)', async (docked) => {
  await using f = officeViewFixture('text', docked)
  vi.spyOn(performance, 'now').mockReturnValue(0)
  await f.flush()
  const session = f.connection.frameForwardingSession(f.opened.documentId), mount = f.view.baseElement.querySelector('[data-office-surface]')
  if (session === undefined) throw new Error('Expected a mounted document.')
  const generation = session.rx.viewport?.version, painted = f.paint.mock.calls.length
  const writes = f.env.writer.write.mock.calls.length
  for (let i = 1; i <= 5; i++) {
    await act(async () => { f.wire.fail(session.rx.rx, 'Desktop dropped a frame during presentation', 'presentation') })
    await f.flush()
    expect(f.paint).toHaveBeenCalledTimes(painted + i)
    expect(f.paint.mock.lastCall?.[1].frame.generation).toBe(generation)
    expect(f.env.writer.write).toHaveBeenCalledTimes(writes + i)
  }
  expect(f.view.baseElement.querySelector('[data-office-surface]')).toBe(mount)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(session.rx.submittedWindow).toBeDefined()
  expect(f.onFailure).not.toHaveBeenCalled()
})

test('video presentation errors that never show a new image repaint with backoff, then fall back once', async () => {
  await using f = officeViewFixture('text')
  await f.flush()
  f.display(false)
  const session = f.connection.frameForwardingSession(f.opened.documentId)!, painted = f.paint.mock.calls.length
  expect(f.view.baseElement.querySelector('[data-office-surface]')?.getAttribute('data-dsh-frame-mount')).toBe('video')
  for (let failure = 0; failure < 8; failure++) {
    await act(async () => { f.wire.fail(session.rx.rx, 'Desktop dropped a frame during presentation', 'presentation') })
    // Longer than every backoff, so each repaint the renderer schedules runs before the next failure.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await f.flush()
  }
  expect(f.paint.mock.calls.length - painted).toBe(3)
  expect(f.onFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Desktop dropped a frame during presentation' }))
  expect(screen.getByRole('alert').textContent).toContain('Desktop dropped a frame during presentation')
  expect(screen.queryByRole('button', { name: en.reconnect })).toBeNull()
})

test('presentation errors of another connection neither repaint nor count toward the fallback', async () => {
  await using f = officeViewFixture('text')
  await f.flush()
  const rx = f.connection.frameForwardingSession(f.opened.documentId)!.rx.rx
  const other = (f.wire.connection(rx) + 1) as ReturnType<typeof f.wire.connection>
  const painted = f.paint.mock.calls.length
  for (let failure = 0; failure < 8; failure++) {
    await act(async () => { f.wire.fail(rx, 'Desktop dropped a frame during presentation', 'presentation', undefined, other) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await f.flush()
  }
  expect(f.paint).toHaveBeenCalledTimes(painted)
  expect(f.onFailure).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
  // An error of the connected producer still repaints.
  await act(async () => { f.wire.fail(rx, 'Desktop dropped a frame during presentation', 'presentation') }); await f.flush()
  expect(f.paint).toHaveBeenCalledTimes(painted + 1)
})

test('a rejected slideshow video playback leaves fullscreen and falls back instead of offering reconnection', async () => {
  await using f = officeViewFixture('presentation')
  await f.flush()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('play denied'))
  await f.play()
  expect(f.onFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'play denied' }))
  expect(f.fullscreen.exit).toHaveBeenCalledOnce()
  expect(document.fullscreenElement).toBeNull()
  expect(screen.getByRole('alert').textContent).toContain('play denied')
  expect(screen.queryByRole('button', { name: en.reconnect })).toBeNull()
  expect(screen.queryByRole('toolbar', { name: en.playbackControls })).toBeNull()
})

test('a failed frame channel falls back once instead of offering reconnection', async () => {
  await using f = officeViewFixture('text')
  await f.flush()
  const session = f.connection.frameForwardingSession(f.opened.documentId)!
  // Ending the frame-forwarding Client reports a failure to the mount and settles the channel as `failed`.
  await act(async () => { f.wire.dispose() }); await f.flush()
  expect(await session.rx.closed).toBe('failed')
  expect(f.onFailure).toHaveBeenCalledOnce()
  expect(screen.getByRole('alert')).toBeDefined()
  expect(screen.queryByRole('button', { name: en.reconnect })).toBeNull()
})

test('a lost frame channel reconnects automatically instead of falling back', async () => {
  await using f = officeViewFixture('text')
  await f.flush()
  const session = f.connection.frameForwardingSession(f.opened.documentId)!
  expect(session.rx.submittedWindow).toBeDefined()
  expect(f.wire.setViewport.mock.settledResults.map(result => result.type)).not.toContain('incomplete')
  await act(async () => { f.wire.lose(session.rx.rx) }); await f.flush()
  expect(f.onFailure).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(f.remote.reconnect).toHaveBeenCalledExactlyOnceWith('doc', 'automatic')
})

test('losing the slideshow before its first viewport returns to native document video on the replacement channel', async () => {
  await using f = officeViewFixture('presentation')
  await f.flush()
  const id = f.opened.documentId, old = f.connection.frameForwardingSession(id)!.rx
  expect(old.submittedWindow).toBeDefined()
  // Enter fullscreen and mount the video without running the next animation frame.
  await act(async () => { f.presentation()!.play() })
  const surface = () => f.view.baseElement.querySelector('[data-office-surface]')?.getAttribute('data-dsh-frame-mount')
  expect(surface()).toBe('video')
  expect(screen.getByRole('toolbar', { name: en.playbackControls })).toBeDefined()
  expect(old.viewport?.visible).toBe(false)
  expect(f.remote.presentation).not.toHaveBeenCalledWith(id, expect.objectContaining({ action: 'stream' }))

  await act(async () => { f.wire.lose(old.rx) })
  await f.flush()
  expect(f.onFailure).not.toHaveBeenCalled()
  expect(f.remote.reconnect).toHaveBeenCalledExactlyOnceWith(id, 'automatic')
  expect(document.fullscreenElement).toBeNull()
  expect(screen.queryByRole('toolbar', { name: en.playbackControls })).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  const recovered = f.connection.frameForwardingSession(id)!.rx
  expect(recovered.rx).toBe('rx-2')
  expect(recovered.submittedWindow).toBeDefined()
  expect(surface()).toBe('video')
})

test('a frame channel lost while a new window awaits its viewport acknowledgement reconnects instead of falling back', async () => {
  await using f = officeViewFixture('text')
  await f.flush()
  const session = f.connection.frameForwardingSession(f.opened.documentId)!, gate = Promise.withResolvers<undefined>()
  try {
    // Withholding the Host's acknowledgement of this channel's viewports keeps the next window request in flight.
    f.wire.setViewport.mockImplementation(async rx => rx === session.rx.rx ? gate.promise : undefined)
    const setContentWindow = vi.spyOn(session.rx, 'setContentWindow'), sent = f.wire.setViewport.mock.calls.length
    // Scrolling past the overscan margin re-anchors the render window on a new viewport.
    const scroll = f.area(); scroll.scrollTop = 1000; fireEvent.scroll(scroll); await f.flush()
    expect(setContentWindow).toHaveBeenCalledOnce()
    expect(setContentWindow.mock.settledResults[0]!.type).toBe('incomplete')
    expect(f.wire.setViewport).toHaveBeenCalledTimes(sent + 1)
    expect(f.wire.setViewport.mock.settledResults.at(-1)!.type).toBe('incomplete')
    await act(async () => { f.wire.lose(session.rx.rx) }); await f.flush()
    expect(f.onFailure).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(f.remote.reconnect).toHaveBeenCalledExactlyOnceWith('doc', 'automatic')
  } finally { gate.resolve(undefined) }
})

test.each(['presentation', 'producer'] as const)('current %s frame error exits the slideshow and reports failure', async (source) => {
  await using f = officeViewFixture('presentation')
  await f.flush(); await f.play()
  const rx = f.connection.frameForwardingSession(f.opened.documentId)!.rx.rx
  const other = (f.wire.connection(rx) + 1) as ReturnType<typeof f.wire.connection>
  await act(async () => { f.wire.fail(rx, 'Other producer', source, undefined, other) })
  await f.flush()
  expect(f.onFailure).not.toHaveBeenCalled()
  await act(async () => { f.wire.fail(rx, 'Slideshow frame failed', source) })
  await f.flush()
  expect(f.onFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Slideshow frame failed' }))
  expect(document.fullscreenElement).toBeNull()
})
