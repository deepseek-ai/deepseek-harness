// @vitest-environment jsdom
/** Office navigation and recovery remain independent of the image presenter. */
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { officeViewFixture } from './helpers/office-view.client.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

test.each(['text', 'spreadsheet', 'presentation'] as const)('%s opens once, forwards callbacks and releases on close', async (kind) => {
  const f = officeViewFixture(kind)
  try {
    await f.flush()
    expect(f.remote.open).toHaveBeenCalledOnce()
    expect(f.paint).toHaveBeenCalled()
    await f.emit({ kind: 'callback', type: 0, payload: '' })
    expect(f.paint.mock.calls.length).toBeGreaterThan(1)
    await f.emit({ kind: 'callback', type: 2, payload: '1500,3000,900,450' })
    expect(f.view.baseElement.querySelector('[data-office-selection]')).not.toBeNull()
    await f.emit({ kind: 'callback', type: 13, payload: '' })
    expect(f.remote.info).toHaveBeenCalled()
    if (kind !== 'text') {
      fireEvent.click(screen.getByRole('tab', { name: 'Second' })); await f.flush()
      expect(f.remote.part).toHaveBeenCalledWith('doc', 1)
    }
  } finally { await f.close() }
  expect(f.remote.release).toHaveBeenCalledOnce()
})

test('DOM scroll and zoom preserve the document while pointer and keyboard input use twips', async () => {
  await using f = officeViewFixture('text')
  await f.flush()
  const scroll = f.area(), target = screen.getByLabelText(en.editor)
  scroll.scrollTop = 120
  fireEvent.scroll(scroll); await f.flush()
  fireEvent.mouseDown(target, { clientX: 20, clientY: 30, buttons: 1, detail: 1 })
  fireEvent.mouseMove(target, { clientX: 40, clientY: 50, buttons: 1, detail: 1 })
  fireEvent.mouseUp(target, { clientX: 40, clientY: 50, buttons: 0, detail: 1 }); await f.flush()
  expect(f.remote.input).toHaveBeenCalledWith('doc', expect.objectContaining({ op: 'mouse', type: 0, x: 300, y: 2250 }))
  const selection = screen.getByLabelText(en.selection)
  fireEvent.keyDown(selection, { key: 'a', ctrlKey: true }); fireEvent.keyDown(selection, { key: 'ArrowDown' }); await f.flush()
  expect(f.remote.command).toHaveBeenCalledWith('doc', { command: 'SelectAll', arguments: {} })
  expect(f.remote.input).toHaveBeenCalledWith('doc', { op: 'key', type: 0, character: 0, key: 1024 })
  fireEvent.click(screen.getByRole('button', { name: en.zoomIn })); await f.flush()
  expect(screen.getByRole('button', { name: en.zoom }).textContent).toBe('125%')
  expect(f.remote.open).toHaveBeenCalledOnce()
})

test('hidden views pause painting while their DOM navigation and session stay retained', async () => {
  await using f = officeViewFixture('text')
  await f.flush()
  const scroll = f.area(); scroll.scrollTop = 120; fireEvent.scroll(scroll); await f.flush()
  await f.visibility(false)
  const paints = f.paint.mock.calls.length
  scroll.scrollTop = 500; fireEvent.scroll(scroll); await f.flush()
  expect(f.paint).toHaveBeenCalledTimes(paints)
  await f.visibility(true)
  expect(f.area()).toBe(scroll)
  expect(scroll.scrollTop).toBe(500)
  expect(f.remote.open).toHaveBeenCalledOnce()
})

test('refresh releases and reopens the document while preserving navigation', async () => {
  await using f = officeViewFixture('text')
  await f.flush(); f.area().scrollTop = 120
  await f.refresh()
  expect(f.remote.release).toHaveBeenCalledOnce()
  expect(f.remote.open).toHaveBeenCalledTimes(2)
  expect(f.area().scrollTop).toBe(120)
})

test('slide wheel navigation ignores modifiers and horizontal input; sheet headers forward selection', async () => {
  const f = officeViewFixture('presentation')
  try {
    await f.flush()
    fireEvent.wheel(f.area(), { deltaX: 100, deltaY: 1 })
    fireEvent.wheel(f.area(), { deltaY: 100, ctrlKey: true }); await f.flush()
    expect(f.remote.part).not.toHaveBeenCalled()
    fireEvent.wheel(f.area(), { deltaY: 100 }); await f.flush()
    expect(f.remote.part).toHaveBeenCalledWith('doc', 1)
  } finally { await f.close() }
  await using sheet = officeViewFixture('spreadsheet')
  await sheet.flush()
  fireEvent.click(screen.getByRole('button', { name: en.selectSheet })); await sheet.flush()
  expect(sheet.remote.command).toHaveBeenCalledTimes(2)
})

test('another fullscreen view pauses painting and tab abort releases exactly once', async () => {
  const f = officeViewFixture('text')
  try {
    await f.flush()
    act(() => { f.fullscreen.change(document.createElement('div')) }); await f.flush()
    const painted = f.paint.mock.calls.length
    f.area().scrollTop = 500; fireEvent.scroll(f.area()); await f.flush()
    expect(f.paint).toHaveBeenCalledTimes(painted)
    act(() => { f.fullscreen.change(null) }); await f.flush()
    await act(async () => { f.controller.abort() }); await f.flush()
    expect(f.remote.release).toHaveBeenCalledOnce()
  } finally { await f.close() }
  expect(f.remote.release).toHaveBeenCalledOnce()
})


test.each(['crash', 'render', 'unavailable'] as const)('%s calls the fallback callback once after opening', async (fault) => {
  await using f = officeViewFixture('text')
  await f.flush()
  if (fault === 'render') {
    f.paint.mockRejectedValueOnce(new Error('GPU render failed'))
    await f.emit({ kind: 'callback', type: 0, payload: '' })
  } else await f.emit(fault === 'crash' ? { kind: 'failure', error: 'engine exited' }
    : { kind: 'channel', state: 'unavailable', message: 'GPU unavailable' })
  await f.emit({ kind: 'failure', error: 'another error' })
  expect(f.onFailure).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: en.reconnect })).toBeNull()
})

test('a paused channel keeps its reconnect action without invoking the fallback', async () => {
  await using f = officeViewFixture('text')
  await f.flush()
  const recover = vi.spyOn(f.connection, 'recover').mockResolvedValue({ outcome: 'limited' })
  await f.emit({ kind: 'channel', state: 'paused', message: 'reconnect limit reached' })
  fireEvent.click(screen.getByRole('button', { name: en.reconnect })); await f.flush()
  expect(recover).toHaveBeenCalledExactlyOnceWith('doc', 'user')
  expect(f.onFailure).not.toHaveBeenCalled()
})
