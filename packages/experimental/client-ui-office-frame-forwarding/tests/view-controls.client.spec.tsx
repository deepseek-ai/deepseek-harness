// @vitest-environment jsdom
/** Pointer, keyboard and toolbar actions retain their document and playback ownership. */
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { officeViewFixture } from './helpers/office-view.client.tsx'
import { en } from '../src/client/locales.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { FrameRxId } from '@deepseek-ai/dsh-frame-forwarding/types'
import type { OfficeDocumentId, OfficePresentationControl, OfficeSelectionInput } from '../src/types.ts'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function pointer(target: Element, name: string, pointerType: string) {
  const event = new Event(name, { bubbles: true })
  Object.defineProperties(event, { pointerType: { value: pointerType }, pointerId: { value: 1 } })
  fireEvent(target, event)
}

test.each(['text', 'presentation'] as const)('%s pointer capture, fit selection and focus preserve the open document', async (kind) => {
  await using f = officeViewFixture(kind)
  await f.flush()
  const target = screen.getByLabelText(en.editor), scroll = f.area(), capture = vi.fn()
  Object.defineProperty(target, 'setPointerCapture', { configurable: true, value: capture })
  pointer(target, 'pointerdown', 'mouse')
  fireEvent.mouseDown(target, { clientX: 30, clientY: 50, buttons: 1, detail: 1 }); await f.flush()
  expect(document.activeElement).toBe(screen.getByLabelText(en.selection))
  pointer(target, 'pointercancel', 'mouse')
  pointer(target, 'lostpointercapture', 'mouse'); await f.flush()
  expect(f.remote.input).toHaveBeenCalledWith('doc', expect.objectContaining({ op: 'mouse', type: 0 }))
  expect(f.remote.input).toHaveBeenLastCalledWith('doc', expect.objectContaining({ op: 'mouse', type: 1 }))
  const inputs = vi.mocked(f.remote.input!).mock.calls.length
  pointer(target, 'pointerdown', 'touch')
  pointer(target, 'pointercancel', 'touch')
  pointer(target, 'lostpointercapture', 'touch'); await f.flush()
  expect(f.remote.input).toHaveBeenCalledTimes(inputs)
  expect(capture).toHaveBeenCalledExactlyOnceWith(1)
  pointer(scroll, 'pointerdown', 'mouse')
  expect(document.activeElement).toBe(kind === 'presentation' ? scroll : screen.getByLabelText(en.selection))
  fireEvent.pointerMove(scroll, { clientX: 30, clientY: 50 }); fireEvent.pointerLeave(scroll)
  const fittedZoom = screen.getByRole('button', { name: en.zoom }).textContent
  fireEvent.click(screen.getByRole('button', { name: en.zoomIn })); await f.flush()
  expect(screen.getByRole('button', { name: en.zoom }).textContent).not.toBe(fittedZoom)
  fireEvent.click(screen.getByRole('button', { name: en.zoom }))
  fireEvent.click(screen.getByText(kind === 'text' ? en.fitWidth : en.fitPage)); await f.flush()
  expect(screen.getByRole('button', { name: en.zoom }).textContent).toBe(fittedZoom)
  expect(screen.getByLabelText(en.editor)).toBe(target)
  expect(f.remote.release).not.toHaveBeenCalled()
  expect(f.remote.open).toHaveBeenCalledOnce()
  fireEvent.keyDown(target, { key: 'ArrowRight', isComposing: true })
  fireEvent.keyDown(screen.getByRole('button', { name: en.zoom }), { key: 'ArrowRight' })
  await f.flush()
  expect(screen.queryByRole('alert')).toBeNull()
})

test('slide keys and wheel move within bounds, coalesce fast wheel input, and ignore modifiers', async () => {
  await using f = officeViewFixture('presentation')
  await f.flush()
  const scroll = f.area()
  fireEvent.keyDown(scroll, { key: 'ArrowLeft' }); await f.flush()
  expect(f.remote.part).not.toHaveBeenCalled()
  fireEvent.keyDown(scroll, { key: 'ArrowRight' }); await f.flush()
  fireEvent.keyDown(scroll, { key: 'ArrowRight' }); await f.flush()
  fireEvent.keyDown(scroll, { key: 'ArrowLeft' }); await f.flush()
  expect(f.remote.part).toHaveBeenLastCalledWith('doc', 0)
  const selections = vi.mocked(f.remote.part!).mock.calls.length
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
    fireEvent.keyDown(scroll, { key: 'ArrowRight', [modifier]: true }); await f.flush()
    expect(f.remote.part).toHaveBeenCalledTimes(selections)
    expect(screen.getByRole('tab', { name: 'First' }).getAttribute('aria-selected')).toBe('true')
  }
  fireEvent.keyDown(scroll, { key: 'x' }); await f.flush()
  expect(f.remote.part).toHaveBeenCalledTimes(selections)
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
  fireEvent.wheel(scroll, { deltaY: 100 }); await f.flush()
  fireEvent.wheel(scroll, { deltaY: -100 }); await f.flush()
  expect(f.remote.part).toHaveBeenLastCalledWith('doc', 1)
  clock.mockReturnValue(2000)
  fireEvent.wheel(scroll, { deltaY: -100 }); await f.flush()
  expect(f.remote.part).toHaveBeenLastCalledWith('doc', 0)
  const beforeIgnoredWheel = vi.mocked(f.remote.part!).mock.calls.length
  clock.mockReturnValue(3000)
  for (const wheel of [{ deltaY: 100, metaKey: true }, { deltaY: 100, ctrlKey: true }]) {
    fireEvent.wheel(scroll, wheel); await f.flush()
    expect(f.remote.part).toHaveBeenCalledTimes(beforeIgnoredWheel)
    expect(screen.getByRole('tab', { name: 'First' }).getAttribute('aria-selected')).toBe('true')
  }
  fireEvent.click(screen.getByRole('tab', { name: 'Second' })); await f.flush()
  const beforeZeroWheel = vi.mocked(f.remote.part!).mock.calls.length
  clock.mockReturnValue(4000)
  fireEvent.wheel(scroll, { deltaY: 0 }); await f.flush()
  expect(f.remote.part).toHaveBeenCalledTimes(beforeZeroWheel)
  expect(screen.getByRole('tab', { name: 'Second' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.queryByRole('alert')).toBeNull()
})

test('slideshow buttons, keyboard, pointer and focus keep controls active until focus leaves', async () => {
  await using f = officeViewFixture('presentation')
  await f.flush(); await f.play()
  const toolbar = screen.getByRole('toolbar', { name: en.playbackControls }), target = screen.getByLabelText(en.editor)
  const next = screen.getByRole('button', { name: en.next }), previous = screen.getByRole('button', { name: en.previous })
  fireEvent.pointerEnter(toolbar)
  act(() => { next.focus() })
  fireEvent.pointerLeave(toolbar)
  fireEvent.pointerMove(next, { clientX: 10, clientY: 10 })
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(document.activeElement).toBe(next)
  expect(toolbar.getAttribute('data-visible')).toBe('true')
  expect(getComputedStyle(toolbar).opacity).not.toBe('0')
  expect(getComputedStyle(toolbar).pointerEvents).not.toBe('none')
  expect(next.hasAttribute('disabled')).toBe(false)
  fireEvent.click(next); await f.flush()
  expect(f.remote.presentation).toHaveBeenLastCalledWith('doc', { action: 'next' })
  act(() => { previous.focus() })
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(toolbar.getAttribute('data-visible')).toBe('true')
  expect(previous.hasAttribute('disabled')).toBe(false)
  fireEvent.click(previous); await f.flush()
  expect(f.remote.presentation).toHaveBeenLastCalledWith('doc', { action: 'previous' })
  // jsdom does not update :hover in response to synthetic pointer events.
  const matches = toolbar.matches.bind(toolbar)
  vi.spyOn(toolbar, 'matches').mockImplementation(selector => selector === ':hover' ? false : matches(selector))
  act(() => { target.focus() })
  await act(async () => { await vi.advanceTimersByTimeAsync(419) })
  expect(toolbar.getAttribute('data-visible')).toBe('true')
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(document.activeElement).toBe(target)
  expect(toolbar.getAttribute('data-visible')).toBe('false')
  expect(getComputedStyle(toolbar).opacity).toBe('0')
  expect(getComputedStyle(toolbar).pointerEvents).toBe('none')
  fireEvent.pointerEnter(toolbar)
  expect(toolbar.getAttribute('data-visible')).toBe('true')
  fireEvent.pointerLeave(toolbar)
  fireEvent.pointerMove(target, { clientX: 50, clientY: 50 })
  await act(async () => { await vi.advanceTimersByTimeAsync(420) })
  expect(toolbar.getAttribute('data-visible')).toBe('false')
  fireEvent.pointerEnter(toolbar)
  fireEvent.keyDown(target, { key: 'ArrowLeft' }); fireEvent.keyDown(target, { key: 'ArrowDown' })
  fireEvent.keyDown(target, { key: 'x' }); fireEvent.keyDown(target, { key: 'Tab' })
  fireEvent.mouseUp(target); await f.flush()
  expect(f.remote.presentation).toHaveBeenCalledWith('doc', { action: 'previous' })
  expect(f.remote.presentation).toHaveBeenCalledWith('doc', { action: 'next' })
  fireEvent.click(screen.getByRole('button', { name: en.pause })); await f.flush()
  fireEvent.click(screen.getByRole('button', { name: en.resume })); await f.flush()
  expect(f.remote.presentation).toHaveBeenCalledWith('doc', { action: 'pause', paused: false })
  fireEvent.keyDown(target, { key: 'Escape' }); await f.flush()
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('refreshing a presentation restores its selected slide, zoom and scroll', async () => {
  await using f = officeViewFixture('presentation')
  await f.flush(); fireEvent.click(screen.getByRole('tab', { name: 'Second' })); await f.flush()
  fireEvent.click(screen.getByRole('button', { name: en.zoomIn })); await f.flush()
  const zoom = screen.getByRole('button', { name: en.zoom }).textContent
  f.area().scrollTop = 42
  await f.refresh()
  expect(f.remote.part).toHaveBeenLastCalledWith('doc', 1)
  expect(screen.getByRole('button', { name: en.zoom }).textContent).toBe(zoom)
  expect(f.area().scrollTop).toBe(42)
})

test('channel recovery notices remount the document, while revision and empty channel events do not mutate it', async () => {
  await using f = officeViewFixture('spreadsheet')
  await f.flush()
  await f.emit({ kind: 'channel', state: 'recovering' })
  expect(screen.getByText(en.reconnecting)).toBeDefined()
  await f.emit({ kind: 'channel', state: 'reconnected' })
  expect(screen.queryByText(en.reconnecting)).toBeNull()
  const before = vi.mocked(f.remote.values!).mock.calls.length
  await f.emit({ kind: 'callback', type: 33, payload: '' })
  await f.emit({ kind: 'callback', type: 50, payload: '' })
  expect(vi.mocked(f.remote.values!).mock.calls.length).toBe(before + 2)
  const recover = vi.spyOn(f.connection, 'recover').mockRejectedValue(new Error('recovery refused'))
  await f.emit({ kind: 'channel', state: 'paused' })
  fireEvent.click(screen.getByRole('button', { name: en.reconnect })); await f.flush()
  expect(recover).toHaveBeenCalledOnce()
  fireEvent.keyDown(screen.getByLabelText(en.editor), { key: 'ArrowDown' })
  fireEvent.click(screen.getByRole('tab', { name: 'Second' })); await f.flush()
  expect(f.remote.part).not.toHaveBeenCalled()
})

test('engine failure reports its diagnostic and fullscreen exit errors', async () => {
  const error = new Error('fullscreen exit failed'), log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await using f = officeViewFixture('presentation')
  await f.flush(); await f.play()
  f.fullscreen.exit.mockRejectedValueOnce(error)
  await f.emit({ kind: 'failure', error: 'Office engine failed.' })
  expect(f.onFailure).toHaveBeenCalledExactlyOnceWith('Office engine failed.')
  expect(log).toHaveBeenCalledWith('Office fullscreen exit failed.', error)
})

test('hiding a slideshow exits its fullscreen and reports a rejected exit', async () => {
  await using f = officeViewFixture('presentation')
  const error = new Error('exit refused')
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await f.flush(); await f.play()
  f.fullscreen.exit.mockRejectedValueOnce(error)
  await f.visibility(false)
  expect(log).toHaveBeenCalledWith('Office fullscreen exit failed.', error)
})

test.each(['end', 'abort', 'unmount'] as const)('held touch selection stops at %s without leaking input', async (ending) => {
  await using f = officeViewFixture()
  await f.flush()
  const target = screen.getByLabelText(en.editor)
  const touches = [{ identifier: 1, clientX: 20, clientY: 30 }] as Touch[]
  fireEvent(target, new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches }))
  await act(async () => { await vi.advanceTimersByTimeAsync(450) }); await f.flush()
  expect(f.remote.input).toHaveBeenCalledWith('doc', expect.objectContaining({ op: 'mouse', type: 0 }))
  if (ending === 'end') fireEvent(target, new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [] }))
  else if (ending === 'abort') {
    act(() => { f.controller.abort() })
    fireEvent(target, new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches }))
  } else f.view.unmount()
  await f.flush()
  const mouseEvents = () => vi.mocked(f.remote.input!).mock.calls.filter(([, value]: [OfficeDocumentId, OfficeSelectionInput]) =>
    value.op === 'mouse' && (value.type === 0 || value.type === 1))
  expect(mouseEvents().map(([, value]: [OfficeDocumentId, OfficeSelectionInput]) => value.type)).toEqual(ending === 'end' ? [0, 1] : [0])
  const settled = mouseEvents()
  fireEvent(target, new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches }))
  fireEvent(target, new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [] }))
  await act(async () => { await vi.advanceTimersByTimeAsync(450) }); await f.flush()
  expect(mouseEvents()).toEqual(settled)
  expect(screen.queryByRole('alert')).toBeNull()
})

test.each(['escape', 'hidden', 'abort', 'unmount'] as const)('playback cancelled by %s before fullscreen resolves sends no start', async (ending) => {
  const f = officeViewFixture('presentation'), entered = Promise.withResolvers<undefined>()
  try {
    await f.flush()
    const fullscreen = vi.spyOn(Element.prototype, 'requestFullscreen').mockReturnValueOnce(entered.promise)
    const play = f.presentation()!.play
    act(() => { play(); play() })
    await f.flush()
    const target = screen.getByLabelText(en.editor)
    fireEvent.keyDown(target, { key: 'ArrowRight' })
    if (ending === 'escape') fireEvent.keyDown(target, { key: 'Escape' })
    else if (ending === 'hidden') await f.visibility(false)
    else if (ending === 'abort') act(() => { f.controller.abort() })
    else f.view.unmount()
    entered.resolve(undefined); await f.flush()
    expect(fullscreen).toHaveBeenCalledOnce()
    expect(f.remote.presentation).not.toHaveBeenCalledWith('doc', expect.objectContaining({ action: 'start' }))
  } finally { entered.resolve(undefined); await f.close() }
})

test.each(['stop-fails', 'exit-fails', 'hidden', 'abort'] as const)('playback start completing after %s never commits a slideshow', async (ending) => {
  const f = officeViewFixture('presentation'), started = Promise.withResolvers<undefined>()
  try {
    await f.flush()
    vi.mocked(f.remote.presentation!).mockImplementationOnce(async () => {
      await started.promise; return { ok: true, value: { documentId: f.opened.documentId } }
    })
    await f.play()
    if (ending === 'abort') act(() => { f.controller.abort() })
    else {
      fireEvent.keyDown(screen.getByLabelText(en.editor), { key: 'Escape' })
      if (ending === 'stop-fails') vi.mocked(f.remote.presentation!).mockRejectedValueOnce(new Error('stop failed'))
      if (ending === 'exit-fails') f.fullscreen.exit.mockRejectedValueOnce(new Error('exit failed'))
      if (ending === 'hidden') await f.visibility(false)
    }
    started.resolve(undefined); await f.flush()
    expect(screen.queryByRole('dialog')).toBeNull()
    if (ending === 'stop-fails' || ending === 'exit-fails') expect(f.onFailure).toHaveBeenCalledOnce()
  } finally { started.resolve(undefined); await f.close() }
})

test.each(['part', 'stop', 'unmount'] as const)('slideshow %s settlement keeps teardown ordered', async (failure) => {
  const f = officeViewFixture('presentation'), stopped = Promise.withResolvers<undefined>(), order: string[] = []
  try {
    await f.flush(); await f.play()
    if (failure === 'part') vi.mocked(f.remote.part!).mockRejectedValueOnce(new Error('part failed'))
    vi.mocked(f.remote.presentation!).mockImplementation(async (_id: OfficeDocumentId, control: OfficePresentationControl) => {
      if (control.action === 'stop') {
        order.push('stop')
        if (failure === 'unmount') await stopped.promise
        order.push(failure === 'stop' ? 'stop-rejected' : 'stop-settled')
        if (failure === 'stop') throw new Error('stop failed')
      }
      return { ok: true, value: { documentId: f.opened.documentId } }
    })
    vi.mocked(f.remote.release!).mockImplementationOnce(async () => { order.push('release'); return { ok: true, value: undefined } })
    fireEvent.click(screen.getByRole('button', { name: en.stop })); await f.flush()
    if (failure === 'unmount') {
      f.view.unmount(); await f.flush()
      expect(order).toEqual(['stop'])
      expect(f.remote.release).not.toHaveBeenCalled()
      stopped.resolve(undefined); await f.flush()
      expect(f.onFailure).not.toHaveBeenCalled()
    } else {
      if (failure === 'part') expect(f.onFailure).toHaveBeenCalledOnce()
      else expect(screen.getByRole('alert').textContent).toContain('stop failed')
      f.view.unmount(); await f.flush()
    }
    expect(order).toEqual(['stop', failure === 'stop' ? 'stop-rejected' : 'stop-settled', 'release'])
    expect(f.remote.release).toHaveBeenCalledExactlyOnceWith('doc')
    expect(screen.queryByRole('dialog')).toBeNull()
  } finally { stopped.resolve(undefined); await f.close() }
})

test('refresh blocks document input and navigation while keeping zoom and slide selection stable', async () => {
  const f = officeViewFixture('presentation'), release = Promise.withResolvers<undefined>()
  try {
    await f.flush()
    const play = f.presentation()!.play, target = screen.getByLabelText(en.editor)
    const zoom = screen.getByRole('button', { name: en.zoom }).textContent
    vi.mocked(f.remote.release!).mockImplementationOnce(async () => { await release.promise; return { ok: true, value: undefined } })
    fireEvent.click(screen.getByRole('button', { name: en.zoom }))
    act(() => {
      f.beginRefresh()
      fireEvent.wheel(f.area(), { deltaY: 10 })
      fireEvent.click(screen.getByText(en.fitPage))
      fireEvent.click(screen.getByRole('button', { name: en.zoomIn }))
      f.beginRefresh()
    })
    await f.flush()
    fireEvent.keyDown(target, { key: 'ArrowDown' })
    act(() => { play() }); await f.flush()
    expect(screen.queryByLabelText(en.editor)).toBeNull()
    expect(f.remote.part).not.toHaveBeenCalled()
    expect(f.remote.presentation).not.toHaveBeenCalled()
    expect(f.remote.release).toHaveBeenCalledOnce()
    release.resolve(undefined); await f.flush()
    expect(screen.getByRole('button', { name: en.zoom }).textContent).toBe(zoom)
    expect(f.remote.open).toHaveBeenCalledTimes(2)
  } finally { release.resolve(undefined); await f.close() }
})

test('rapid slide selections preserve order and a non-Error action failure remains visible', async () => {
  await using f = officeViewFixture('presentation')
  await f.flush()
  act(() => {
    screen.getByRole('tab', { name: 'Second' }).click()
    screen.getByRole('tab', { name: 'First' }).click()
  })
  await f.flush()
  expect(vi.mocked(f.remote.part!).mock.calls.map(([, part]: [OfficeDocumentId, number]) => part)).toEqual([1, 0])
  vi.mocked(f.remote.part!).mockRejectedValueOnce('navigation refused')
  fireEvent.click(screen.getByRole('tab', { name: 'Second' })); await f.flush()
  expect(screen.getByRole('alert').textContent).toContain('navigation refused')
  await f.emit({ kind: 'channel', state: 'paused', message: 'channel paused' })
  expect(screen.getByRole('alert').textContent).toContain('navigation refused')
})

test('repeated reconnect clicks share the admitted recovery', async () => {
  const f = officeViewFixture(), pending = Promise.withResolvers<{ outcome: 'limited' }>()
  try {
    await f.flush(); await f.emit({ kind: 'channel', state: 'paused', message: 'channel paused' })
    const recover = vi.spyOn(f.connection, 'recover').mockReturnValue(pending.promise)
    act(() => {
      screen.getByRole('button', { name: en.reconnect }).click()
      screen.getByRole('button', { name: en.reconnect }).click()
    })
    await f.flush()
    expect(recover).toHaveBeenCalledOnce()
    pending.resolve({ outcome: 'limited' }); await f.flush()
  } finally { pending.resolve({ outcome: 'limited' }); await f.close() }
})

test('a retained play callback cannot start a second slideshow', async () => {
  await using f = officeViewFixture('presentation')
  await f.flush(); const play = f.presentation()!.play
  await f.play(); act(() => { play() }); await f.flush()
  const starts = vi.mocked(f.remote.presentation!).mock.calls
    .filter(([, action]: [OfficeDocumentId, OfficePresentationControl]) => action.action === 'start')
  expect(starts).toHaveLength(1)
})

test('a queued slideshow start cancelled behind input never reaches the Host', async () => {
  const f = officeViewFixture('presentation'), input = Promise.withResolvers<undefined>()
  try {
    await f.flush()
    vi.mocked(f.remote.input!).mockImplementationOnce(async () => {
      await input.promise; return { ok: true, value: { documentId: f.opened.documentId } }
    })
    fireEvent.mouseDown(screen.getByLabelText(en.editor), { clientX: 10, clientY: 10, buttons: 1, detail: 1 }); await f.flush()
    await f.play()
    fireEvent.keyDown(screen.getByLabelText(en.editor), { key: 'Escape' })
    input.resolve(undefined); await f.flush()
    expect(f.remote.presentation).not.toHaveBeenCalledWith('doc', expect.objectContaining({ action: 'start' }))
  } finally { input.resolve(undefined); await f.close() }
})

test.each(['part', 'failure'] as const)('a queued paint superseded by %s does not send the obsolete window', async (change) => {
  const f = officeViewFixture('presentation'), input = Promise.withResolvers<undefined>()
  try {
    await f.flush(); const before = f.paint.mock.calls.length
    vi.mocked(f.remote.input!).mockImplementationOnce(async () => {
      await input.promise; return { ok: true, value: { documentId: f.opened.documentId } }
    })
    fireEvent.mouseDown(screen.getByLabelText(en.editor), { clientX: 10, clientY: 10, buttons: 1, detail: 1 }); await f.flush()
    await f.emit({ kind: 'callback', type: 0, payload: '' })
    if (change === 'part') f.setInfo({ ...f.opened.info, part: 1 })
    await f.emit(change === 'part' ? { kind: 'presentation', part: 1, ended: false } : { kind: 'failure', error: 'engine exited' })
    input.resolve(undefined); await f.flush()
    if (change === 'failure') expect(f.paint).toHaveBeenCalledTimes(before)
    else expect(f.paint.mock.calls.slice(before).every(([, request]) => request.part === 1)).toBe(true)
  } finally { input.resolve(undefined); await f.close() }
})

test('a string fullscreen rejection is shown as an action failure', async () => {
  await using f = officeViewFixture('presentation')
  await f.flush(); vi.spyOn(Element.prototype, 'requestFullscreen').mockRejectedValueOnce('fullscreen denied')
  await f.play()
  expect(screen.getByRole('alert').textContent).toContain('fullscreen denied')
})

test('tab close logs a rejected fullscreen exit and Escape during slideshow startup cancels cleanly', async () => {
  const error = new Error('tab close exit refused'), log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const gate = Promise.withResolvers<undefined>()
  await using f = officeViewFixture('presentation', false, ({ remote }) => {
    remote.presentation = vi.fn(async (_id: OfficeDocumentId, control: OfficePresentationControl) => {
      if (control.action === 'start') await gate.promise
      return { ok: true, value: { documentId: 'doc' as OfficeDocumentId } }
    })
  })
  await f.flush()
  const starting = f.play()
  await Promise.resolve(); await Promise.resolve()
  // Escape leaves fullscreen while native presentation start is still pending.
  act(() => { f.fullscreen.change(null) })
  gate.resolve(undefined)
  await starting
  expect(document.fullscreenElement).toBeNull()
  // Closing a playing tab whose fullscreen exit fails logs the error instead of aborting release.
  vi.mocked(f.remote.presentation!).mockResolvedValue({ ok: true, value: { documentId: 'doc' as OfficeDocumentId } })
  await f.play()
  f.fullscreen.exit.mockRejectedValueOnce(error)
  act(() => { f.controller.abort() })
  await f.flush()
  expect(log).toHaveBeenCalledWith('Office fullscreen exit failed.', error)
})

test('a rejected native slideshow stop leaves its failure visible and still exits fullscreen', async () => {
  await using f = officeViewFixture('presentation')
  await f.flush(); await f.play()
  vi.mocked(f.remote.presentation!).mockImplementation(async (_id: OfficeDocumentId, control: OfficePresentationControl) => {
    if (control.action === 'stop') throw new Error('native stop failed')
    return { ok: true, value: { documentId: f.opened.documentId } }
  })
  fireEvent.click(screen.getByRole('button', { name: en.stop })); await f.flush()
  expect(screen.getByRole('alert').textContent).toContain('native stop failed')
  expect(f.fullscreen.exit).toHaveBeenCalled()
})

test('waiting for the first slideshow image shows a notice until rendering fails', async () => {
  await using f = officeViewFixture('presentation')
  await f.flush(); await f.play()
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(screen.getByText(en.waitingForFrames)).toBeDefined()
  await f.emit({ kind: 'failure', error: 'engine exited' })
  expect(screen.queryByText(en.waitingForFrames)).toBeNull()
})

test.each(['text', 'presentation'] as const)('a fresh %s document identity restores the saved viewport after refresh', async (kind) => {
  await using f = officeViewFixture(kind)
  await f.flush()
  f.area().scrollTop = 240; f.area().scrollLeft = 30
  vi.mocked(f.remote.open!).mockImplementationOnce(async function* () {
    yield { kind: 'opened', document: { ...f.opened, documentId: brandString<typeof f.opened.documentId>('doc-next'),
      nativeView: { rx: brandString<FrameRxId>('rx-next'), frameTimeoutMs: 1000 } } } as const
  })
  await f.refresh()
  expect(f.area().scrollTop).toBe(240)
  expect(f.area().scrollLeft).toBe(30)
})

test.each(['preview', 'playing', 'starting'])('refresh during %s retires the old slideshow surface before release', async (phase) => {
  await using f = officeViewFixture('presentation')
  await f.flush()
  const id = brandString<OfficeDocumentId>('next'), rx = brandString<FrameRxId>('next-rx')
  const started = Promise.withResolvers<undefined>(), releasing = Promise.withResolvers<undefined>()
  if (phase === 'starting') vi.mocked(f.remote.presentation!).mockImplementationOnce(async () => {
    await started.promise
    return { ok: true, value: { documentId: f.opened.documentId } }
  })
  if (phase !== 'preview') await f.play()
  vi.mocked(f.remote.release!).mockImplementationOnce(async () => {
    await releasing.promise
    f.wire.released(f.opened.nativeView!.rx)
    return { ok: true, value: undefined }
  })
  vi.mocked(f.remote.open!).mockImplementationOnce(async function* () {
    yield { kind: 'opened', document: { ...f.opened, documentId: id, nativeView: { rx, frameTimeoutMs: 1000 } } } as const
  })
  f.paint.mockImplementation(async (_id, request) => {
    f.submit(request, rx)
    return { ok: true, value: { documentId: id, width: request.pixelWidth, height: request.pixelHeight } }
  })
  f.env.writer.write.mockClear()
  await f.refresh()
  started.resolve(undefined); await f.flush()
  expect(f.remote.release).toHaveBeenCalledWith(f.opened.documentId)
  expect(f.view.baseElement.querySelector('[data-office-surface]')).toBeNull()
  releasing.resolve(undefined); await f.flush()
  expect(f.onFailure).not.toHaveBeenCalled()
  expect(f.paint).toHaveBeenLastCalledWith(id, expect.objectContaining({ part: 0 }))
  expect(f.env.writer.write).toHaveBeenCalled()
})

test('a failed reopen after refresh reports the native failure to the fallback owner', async () => {
  await using f = officeViewFixture('presentation')
  await f.flush()
  vi.mocked(f.remote.open!).mockImplementationOnce(async function* () { throw new Error('reopen failed') })
  await f.refresh()
  expect(f.onFailure).toHaveBeenCalledOnce()
})

test('tab release reports stream shutdown rejection before completing Host release', async () => {
  await using f = officeViewFixture('presentation')
  const failure = new Error('stream disable failed')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await f.flush(); await f.play()
  vi.mocked(f.remote.presentation!).mockImplementation(async (_id: OfficeDocumentId, control: OfficePresentationControl) => {
    if (control.action === 'stream' && !control.enabled) throw failure
    return { ok: true, value: { documentId: f.opened.documentId } }
  })
  act(() => { f.controller.abort() }); await f.flush()
  expect(warn).toHaveBeenCalledWith('Office display cleanup failed.', failure)
  expect(f.remote.release).toHaveBeenCalledOnce()
})
