/** Window discovery stays separate from launch and authorized window input. */
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { createCuaWindowApi } from '../src/window-api.ts'
import { WindowRequest } from '../src/window-protocol.ts'
import type { CuaElementId } from '../src/types.ts'
import type { CuaWindowOperation } from '../src/window-types.ts'

/** Element ids are opaque strings; these fixtures use the macOS decimal form. */
const element = (id: string): CuaElementId => brandString<CuaElementId>(id)

const metadata = { windowId: 7, pid: 10, appName: 'Editor', title: 'Document', bounds: { x: -100, y: 0, width: 800, height: 600 }, isOnScreen: true, onCurrentSpace: null }
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
function fixture() {
  const text = vi.fn()
  const dispatch = vi.fn(async (request: CuaWindowOperation): Promise<JsonValue> => {
    switch (request.method) {
      case 'listWindows': return [metadata]
      case 'getWindows': return request.params.ids.map(windowId => ({ windowId, pid: 10, windowHandle: 'window-7' }))
      case 'getState': return { windowHandle: 'window-7', windowId: 7, pid: 10, snapshotId: 'state-1', tree: 'AX window', windows: [metadata], truncated: false }
      case 'findApps': return [{ id: 'shell-entry', displayName: 'Settings', kind: 'shell' }]
      case 'listActions': return ['AXPress']
      case 'hover': return { dispatched: true, hoverRoute: 'accessibility', systemPointerMoved: false }
      case 'screenshot': return { mimeType: 'image/png', data: PNG, pixelWidth: 1, pixelHeight: 1, windowId: 7, bounds: metadata.bounds, coordinateSpace: 'screenshot-pixels' }
      default: return { dispatched: true }
    }
  })
  return { dispatch, text, api: createCuaWindowApi(dispatch, { text, image: vi.fn() }) }
}
it('discovers windows and Shell launch entries without selecting or launching them', async () => {
  const f = fixture()
  expect(await f.api.listWindows()).toEqual([metadata])
  expect(await f.api.findApps('Settings')).toEqual([{ id: 'shell-entry', displayName: 'Settings', kind: 'shell' }])
  expect(f.dispatch.mock.calls.map(([r]) => r.method)).toEqual(['listWindows', 'findApps'])
  expect(f.api).not.toHaveProperty('getApp')
  expect(f.api).not.toHaveProperty('listApps')
})
it('binds all observation and keyboard operations to a selected window and suppresses initial AX output', async () => {
  const f = fixture()
  const [window] = await f.api.getWindows([7])
  expect(window).toBeDefined()
  if (!window) throw new Error('Missing selected window')
  expect(f.text).not.toHaveBeenCalled()
  expect(f.dispatch.mock.calls[1]?.[0]).toEqual({ method: 'getState', params: { windowHandle: 'window-7' } })
  await window.getAccessibilityTree()
  expect(f.text).toHaveBeenCalledWith('AX window')
  await window.click(element('0'))
  await window.click([1, 2])
  await window.hover(element('42.12345'))
  await window.scroll({ x: 1, y: 2, deltaLinesX: 0, deltaLinesY: 1 })
  await window.drag([1, 2], [3, 4])
  expect(await window.getScreenshot()).toMatchObject({ mimeType: 'image/png', pixelWidth: 1, pixelHeight: 1, windowId: 7 })
  await window.activate()
  await window.typeText('hello')
  await window.paste('world')
  await window.pressKey('ctrl+a')
  expect(f.dispatch.mock.calls.slice(2).every(([r]) => 'windowHandle' in r.params && r.params.windowHandle === 'window-7')).toBe(true)
  expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'pressKey', params: { windowHandle: 'window-7', key: 'a', modifiers: ['control'] } })
  expect(await window.listActions(element('42.12345'))).toEqual(['AXPress'])
  expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'listActions', params: {
    windowHandle: 'window-7', snapshotId: 'state-1', elementId: '42.12345',
  } })
  await window.performAction(element('42.12345'), 'AXTextArea.AXValue.Set', 'hello')
  expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'performAction', params: {
    windowHandle: 'window-7', snapshotId: 'state-1', elementId: '42.12345',
    action: 'AXTextArea.AXValue.Set', argument: 'hello',
  } })
  await window.setValue(element('42.12345'), { x: 10, y: 20 })
  expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'setValue', params: {
    windowHandle: 'window-7', snapshotId: 'state-1', elementId: '42.12345', value: { x: 10, y: 20 },
  } })
})
it('accepts an element action query or execution only for a selected window snapshot', () => {
  const params = { windowHandle: 'window-7', snapshotId: 'state-1', elementId: '42.12345' }
  expect(WindowRequest.parse({ method: 'listActions', params })).toEqual({ method: 'listActions', params })
  expect(WindowRequest.safeParse({ method: 'listActions', params: {
    windowHandle: 'window-7', elementId: '42.12345',
  } }).success).toBe(false)
  const action = { ...params, action: 'AXTextArea.AXValue.Set', argument: 'hello' }
  expect(WindowRequest.parse({ method: 'performAction', params: action })).toEqual({ method: 'performAction', params: action })
  expect(WindowRequest.safeParse({ method: 'performAction', params: { ...params, action: '' } }).success).toBe(false)
  expect(WindowRequest.parse({ method: 'invoke', params })).toEqual({ method: 'invoke', params })
  for (const invalid of [
    { windowHandle: 'window-7', elementId: '42.12345' },
    { windowHandle: 'window-7', snapshotId: 'state-1', elementId: '' },
    { ...params, action: 'AXPress' },
    { ...params, argument: null },
    { ...params, mouseButton: 'left' },
  ]) expect(WindowRequest.safeParse({ method: 'invoke', params: invalid }).success).toBe(false)
})
it('launches a discovered entry without inventing a selected window or waiting for one', async () => {
  const f = fixture()
  expect(await f.api.launch('shell-entry')).toEqual({ dispatched: true })
  expect(f.dispatch).toHaveBeenCalledExactlyOnceWith({ method: 'launch', params: { target: 'shell-entry' } })
})
it('invokes a selected window with its latest snapshot and preserves confirmed absence', async () => {
  const f = fixture()
  const [window] = await f.api.getWindows([7])
  if (!window) throw new Error('Missing selected window')
  expect(await window.invoke(element('42.12345'))).toEqual({ dispatched: true })
  expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'invoke', params: {
    windowHandle: 'window-7', snapshotId: 'state-1', elementId: '42.12345',
  } })
  f.dispatch.mockResolvedValueOnce({ dispatched: false })
  await expect(window.invoke(element('42.12345'))).resolves.toEqual({ dispatched: false })
})
it('rejects application operations, caller-selected native windows and malformed relative coordinates', () => {
  for (const request of [
    { method: 'getApp', params: { selector: 'Editor' } },
    { method: 'getState', params: { appHandle: 'application' } },
    { method: 'click', params: { windowHandle: 'selected', windowId: 99, x: 1, y: 2 } },
    { method: 'click', params: { windowHandle: 'selected', relative: true, x: 1000, y: 0 } },
  ]) expect(WindowRequest.safeParse(request).success).toBe(false)
})
it('rejects mismatched selections before reading another window', async () => {
  const f = fixture()
  f.dispatch.mockResolvedValueOnce([{ windowHandle: 'other', windowId: 8, pid: 10 }])
  await expect(f.api.getWindows([7])).rejects.toThrow('does not match')
  expect(f.dispatch).toHaveBeenCalledTimes(1)
})

it('supports discovery without a sink and suppresses requested emissions', async () => {
  const f = fixture()
  await f.api.listWindows({ emit: false })
  expect(f.text).not.toHaveBeenCalled()
  await createCuaWindowApi(f.dispatch).listWindows()
  const capabilities = { platform: 'windows', permissions: { accessibility: true, screenRecording: true }, appLevelAccessibility: false, sessionLocked: false, methods: [], coordinateSpace: 'screenshot-pixels', browser: false }
  f.dispatch.mockResolvedValueOnce(capabilities)
  expect(await f.api.getCapabilities()).toEqual(capabilities)
})
it('rejects incomplete native selections without observing any window', async () => {
  const f = fixture()
  f.dispatch.mockResolvedValueOnce([])
  await expect(f.api.getWindows([7])).rejects.toThrow('does not match')
  expect(f.dispatch).toHaveBeenCalledTimes(1)
})
