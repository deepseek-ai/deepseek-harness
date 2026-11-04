/** App and window behavior over a fixture operation dispatcher, without desktop access. */
import { Buffer } from 'node:buffer'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { createCuaApi } from '../src/api.ts'
import type { CuaApp, CuaElementId, CuaOperation, CuaScreenshot, CuaWindow } from '../src/types.ts'

/** Element ids are opaque strings; these fixtures use the macOS decimal form. */
const element = (id: string): CuaElementId => brandString<CuaElementId>(id)

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
const bounds = { x: -640, y: 100, width: 640, height: 480 }
const selected = { appHandle: 'app-17', pid: 17, name: 'Editor', bundleId: 'test.editor', running: true }
const delivered = { dispatched: true }
const capabilities = { platform: 'macos', sessionLocked: false, permissions: { accessibility: true, screenRecording: false }, appLevelAccessibility: true, keyboard: ['app'], methods: ['getState', 'click'], coordinateSpace: 'screenshot-pixels', browser: false }

function windowInfo(windowId: number) {
  return { windowId, appName: 'Editor', title: `Document ${windowId}`, bounds, isOnScreen: true, onCurrentSpace: null }
}

function fixture(withSink = true) {
  let windows = [windowInfo(23)]
  let generation = 0
  const sink = { text: vi.fn<(value: string) => void>(), image: vi.fn<(screenshot: CuaScreenshot) => void>() }
  const dispatch = vi.fn(async ({ method, params }: CuaOperation): Promise<JsonValue> => {
    switch (method) {
      case 'getCapabilities': return capabilities
      case 'listApps': return [selected, { pid: 18, name: 'Utility' }]
      case 'getApp': return selected
      case 'listWindows': return windows
      case 'hover': return { ...delivered, hoverRoute: 'accessibility', systemPointerMoved: false }
      case 'show': return { ...delivered, windowId: params.windowId ?? 23, foregroundChanged: false }
      case 'getState': return {
        appHandle: selected.appHandle, windowId: params.windowId ?? null,
        snapshotId: `snapshot-${++generation}`, tree: `Tree ${generation}`, truncated: false,
        windows: params.windowId === undefined ? windows : windows.filter(window => window.windowId === params.windowId),
      }
      case 'screenshot': return { mimeType: 'image/png', data: PNG, pixelWidth: 1, pixelHeight: 1, windowId: params.windowId, bounds, coordinateSpace: 'screenshot-pixels' }
      case 'listActions': return ['AXPress', 'AXShowMenu', 'AXTextArea.AXValue.Set']
      default: return delivered
    }
  })
  return {
    dispatch, sink, api: createCuaApi(dispatch, withSink ? sink : undefined),
    setWindows: (ids: number[]) => { windows = ids.map(windowInfo) },
    setWindowRecords: (records: ReturnType<typeof windowInfo>[]) => { windows = records },
  }
}

function state(overrides: Record<string, JsonValue> = {}): JsonValue {
  return { appHandle: selected.appHandle, windowId: null, snapshotId: 'changed', tree: 'Changed tree', windows: [windowInfo(23)], truncated: false, ...overrides }
}

function screenshot(overrides: Record<string, JsonValue> = {}): JsonValue {
  return { mimeType: 'image/png', data: PNG, pixelWidth: 1, pixelHeight: 1, windowId: 23, bounds, coordinateSpace: 'screenshot-pixels', ...overrides }
}

describe('application discovery', () => {
  it('reports permissions and discovers both bundle and PID selectors without activating an app', async () => {
    const f = fixture()
    expect(await f.api.getCapabilities()).toEqual(capabilities)
    expect(await f.api.getState()).toEqual({ apps: [
      { id: 'test.editor', displayName: 'Editor', isRunning: true, pid: 17 },
      { id: '18', displayName: 'Utility', isRunning: true, pid: 18 },
    ], browsers: [] })
    expect(f.dispatch.mock.calls.map(([operation]) => operation.method)).toEqual(['getCapabilities', 'listApps'])
    const emitted = f.sink.text.mock.calls.map(([text]): unknown => JSON.parse(text))
    expect(emitted).toEqual([capabilities, await f.api.getState({ emit: false })])
    expect(f.sink.text).toHaveBeenCalledTimes(2)
  })

  it('returns observations without requiring an output sink', async () => {
    const f = fixture(false)
    expect(await f.api.getCapabilities({ emit: false })).toEqual(capabilities)
    expect(await f.api.listApps()).toHaveLength(2)
    const app = await f.api.getApp('Editor')
    expect(app).not.toHaveProperty('pid')
    expectTypeOf<CuaApp>().not.toHaveProperty('pid')
    expect(app.appHandle).toBe('app-17')
    const window = await app.getWindow(23)
    expect(await window.getScreenshot()).toEqual({ bytes: Uint8Array.from(Buffer.from(PNG, 'base64')), mimeType: 'image/png', pixelWidth: 1, pixelHeight: 1, windowId: 23 })
    expect(f.dispatch.mock.calls.map(([operation]) => operation.method)).toEqual([
      'getCapabilities', 'listApps', 'getApp', 'getState', 'getState', 'screenshot',
    ])
    expect(await app.getWindows()).toEqual([windowInfo(23)])
    expect(f.sink.text).not.toHaveBeenCalled()
    expect(f.sink.image).not.toHaveBeenCalled()
  })

  it('searches installed applications without turning ordinary discovery into an installed-app inventory', async () => {
    const f = fixture()
    const matches = [
      { id: 'test.stopped', displayName: 'Stopped', path: '/Applications/Stopped.app', isRunning: false },
      { id: 'test.running', displayName: 'Running', path: '/Applications/Running.app', isRunning: true, pid: 17 },
    ]
    f.dispatch.mockResolvedValueOnce(matches)
    expect(await f.api.findApps('Editor')).toEqual(matches)
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'findApps', params: { query: 'Editor' } })
    expect(f.sink.text).toHaveBeenLastCalledWith(JSON.stringify(matches))
    await expect(f.api.findApps('   ')).rejects.toThrow()
  })

  it.each(['', '   '])('names the invalid search parameter without exposing schema internals: %j', async (query) => {
    const f = fixture()
    await expect(f.api.findApps(query)).rejects.toMatchObject({ name: 'Error', message: 'findApps query: Expected a non-empty search string' })
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it('rejects malformed discovery and capability results', async () => {
    const f = fixture()
    f.dispatch.mockResolvedValueOnce({ platform: 'macos' })
    await expect(f.api.getCapabilities()).rejects.toThrow()
    f.dispatch.mockResolvedValueOnce([{ pid: 0, name: 'Invalid' }])
    await expect(f.api.listApps()).rejects.toThrow()
    f.dispatch.mockResolvedValueOnce({ ...selected, appHandle: '' })
    await expect(f.api.getApp('Editor')).rejects.toThrow()
    expect(f.sink.text).not.toHaveBeenCalled()
  })
})

describe('background window restoration', () => {
  it('shows an app or selected window without dispatching activation or AXRaise', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(24)
    f.dispatch.mockClear()
    expect(await app.show()).toEqual({ ...delivered, windowId: 23, foregroundChanged: false })
    expect(await window.show()).toEqual({ ...delivered, windowId: 24, foregroundChanged: false })
    expect(f.dispatch.mock.calls.map(([operation]) => operation)).toEqual([
      { method: 'show', params: { appHandle: 'app-17' } },
      { method: 'show', params: { appHandle: 'app-17', windowId: 24 } },
    ])
  })

  it.each([true, null])('preserves foreground change evidence %j without switching focus back', async (foregroundChanged) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockClear()
    f.dispatch.mockResolvedValueOnce({ ...delivered, windowId: null, foregroundChanged })
    expect(await app.show()).toEqual({ ...delivered, windowId: null, foregroundChanged })
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })

  it('leaves foreground fallback to the caller after restoration fails', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockClear()
    f.dispatch.mockRejectedValueOnce(new Error('UNSUPPORTED: Window cannot be restored'))
    await expect(app.show()).rejects.toThrow('UNSUPPORTED')
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
})

describe('hover across observations', () => {
  it('moves to an AX element then into a popup without inserting clicks or restoring a point', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(23)
    f.dispatch.mockClear()
    expect(await window.hover(element('0'))).toEqual({ ...delivered, hoverRoute: 'accessibility', systemPointerMoved: false })
    await window.getAccessibilityTree({ emit: false })
    await window.getScreenshot({ emit: false })
    expect(await window.hover([30, 40])).toEqual({ ...delivered, hoverRoute: 'accessibility', systemPointerMoved: false })
    expect(f.dispatch.mock.calls.map(([operation]) => operation)).toEqual([
      { method: 'hover', params: { appHandle: 'app-17', snapshotId: 'snapshot-2', elementId: '0' } },
      { method: 'getState', params: { appHandle: 'app-17', windowId: 23 } },
      { method: 'screenshot', params: { appHandle: 'app-17', windowId: 23 } },
      { method: 'hover', params: { appHandle: 'app-17', snapshotId: 'snapshot-3', windowId: 23, x: 30, y: 40 } },
    ])
    const other = await app.getWindow(24)
    await other.hover([5, 6])
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'hover', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-4', windowId: 24, x: 5, y: 6,
    } })
    f.dispatch.mockRejectedValueOnce(new Error('WINDOW_CHANGED'))
    await expect(other.hover([5, 6])).rejects.toThrow('WINDOW_CHANGED')
    expect(f.dispatch).toHaveBeenCalledTimes(7)
  })
})

describe('pointer buttons and modifiers', () => {
  it.each([0, 800])('preserves %d ms for window clicks at elements and coordinates', async (holdMs) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(23)
    for (const target of [element('0'), [10, 20] as const]) {
      await window.click(target, { holdMs, mouseButton: 'right' })
      expect(f.dispatch.mock.calls.at(-1)?.[0]).toMatchObject({ method: 'click', params: { holdMs, mouseButton: 'right' } })
      f.dispatch.mockClear()
      await expect(window.click(target, { holdMs: -1 })).rejects.toThrow('holdMs')
      expect(f.dispatch).not.toHaveBeenCalled()
    }
  })

  it('retains middle-button and modifier intent through click and drag dispatch', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(23)
    await window.click(element('0'), { mouseButton: 'middle', modifiers: ['shift'] })
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-2', elementId: '0', mouseButton: 'middle', modifiers: ['shift'],
    } })
    await window.click([10, 20], { modifiers: ['command'] })
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', windowId: 23, snapshotId: 'snapshot-2', x: 10, y: 20,
      mouseButton: 'left', clickCount: 1, modifiers: ['command'],
    } })
    await window.drag([10, 20], [30, 40], { mouseButton: 'middle', modifiers: ['shift', 'option'] })
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'drag', params: {
      appHandle: 'app-17', windowId: 23, snapshotId: 'snapshot-2', fromX: 10, fromY: 20, toX: 30, toY: 40,
      mouseButton: 'middle', modifiers: ['shift', 'option'],
    } })
    const count = f.dispatch.mock.calls.length
    await expect(window.click(element('0'), { mouseButton: 'middle', clickCount: 2 })).rejects.toThrow('Only left double-click')
    expect(f.dispatch).toHaveBeenCalledTimes(count)
  })
})

describe('text selections', () => {
  it('binds literal text and optional disambiguation to the latest observed control', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.selectText(element('1'), 'target')
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'selectText', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-1', elementId: '1', text: 'target',
    } })
    await app.selectText(element('1'), 'target', { prefix: 'second ', suffix: '.', selectionType: 'cursor_after' })
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'selectText', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-1', elementId: '1', text: 'target',
      prefix: 'second ', suffix: '.', selectionType: 'cursor_after',
    } })
    const calls = f.dispatch.mock.calls.length
    await expect(app.selectText(element('1'), '')).rejects.toThrow()
    expect(f.dispatch).toHaveBeenCalledTimes(calls)
  })
})

describe('element action queries', () => {
  it('returns raw provider action names including attribute-setting operations without reading new state', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockClear()
    expect(await app.listActions(element('42.12345'))).toEqual(['AXPress', 'AXShowMenu', 'AXTextArea.AXValue.Set'])
    expect(f.dispatch.mock.calls.map(([operation]) => operation)).toEqual([
      { method: 'listActions', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', elementId: '42.12345' } },
    ])
    await expect(app.listActions(element(''))).rejects.toThrow()
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.sink.text).not.toHaveBeenCalled()
  })
})

describe('element actions', () => {
  it('dispatches advertised actions with omitted, null or direct values without wrapping the value', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockClear()
    expect(await app.performAction(element('42.12345'), 'AXPress')).toEqual(delivered)
    expect(await app.performAction(element('42.12345'), 'AXPress', null)).toEqual(delivered)
    expect(await app.performAction(element('42.12345'), 'AXTextArea.AXValue.Set', 'hello')).toEqual(delivered)
    expect(await app.performAction(element('42.12345'), 'AXWindow.AXPosition.Set', { x: 10, y: 20 })).toEqual(delivered)
    expect(f.dispatch.mock.calls.map(([operation]) => operation)).toEqual([
      { method: 'performAction', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', elementId: '42.12345', action: 'AXPress' } },
      { method: 'performAction', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', elementId: '42.12345', action: 'AXPress', argument: null } },
      { method: 'performAction', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', elementId: '42.12345', action: 'AXTextArea.AXValue.Set', argument: 'hello' } },
      { method: 'performAction', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', elementId: '42.12345', action: 'AXWindow.AXPosition.Set', argument: { x: 10, y: 20 } } },
    ])
    expect(f.sink.text).not.toHaveBeenCalled()
  })

  it('rejects an empty action before dispatch', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockClear()
    await expect(app.performAction(element('0'), '')).rejects.toThrow('performAction action')
    expect(f.dispatch).not.toHaveBeenCalled()
  })
})

describe('element default invocation', () => {
  it('uses the latest snapshot and opaque element id without reading fresh state', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockClear()
    expect(await app.invoke(element('42.12345'))).toEqual(delivered)
    expect(f.dispatch.mock.calls.map(([operation]) => operation)).toEqual([
      { method: 'invoke', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', elementId: '42.12345' } },
    ])
    expect(f.sink.text).not.toHaveBeenCalled()
  })

  it('returns confirmed absence of a default action as un-dispatched evidence', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockResolvedValueOnce({ dispatched: false })
    await expect(app.invoke(element('9'))).resolves.toEqual({ dispatched: false })
  })

  it('rejects provider failures and malformed dispatch evidence', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const failure = new Error('PERMISSION_DENIED')
    f.dispatch.mockRejectedValueOnce(failure)
    await expect(app.invoke(element('0'))).rejects.toBe(failure)
    f.dispatch.mockResolvedValueOnce({ dispatched: 'yes' })
    await expect(app.invoke(element('0'))).rejects.toThrow()
    await expect(app.invoke(element(''))).rejects.toThrow('invoke elementId')
  })
})

describe('application and window observations', () => {
  it('shares the latest tree read across an application and each selected window', async () => {
    const f = fixture()
    f.setWindows([23, 24])
    const app = await f.api.getApp('Editor')
    expect(await app.getWindows({ emit: false })).toEqual([windowInfo(23), windowInfo(24)])
    const first = await app.getWindow(23)
    const second = await app.getWindow(24)
    await app.setValue(element('1'), 'First document')
    await first.click(element('2'))
    await second.click(element('3'))
    expect(f.dispatch.mock.calls.slice(-3).map(([operation]) => operation)).toEqual([
      { method: 'setValue', params: { appHandle: 'app-17', snapshotId: 'snapshot-3', elementId: '1', value: 'First document' } },
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-3', elementId: '2' } },
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-3', elementId: '3' } },
    ])
    expect(first.windowId).toBe(23)
    expect(second.windowId).toBe(24)
    expect(f.sink.text.mock.calls.map(([text]) => text)).toEqual([])
    await expect(second.getAccessibilityTree({ emit: false, disableDiffing: true })).resolves.toBe('Tree 4')
    await second.click(element('3'))
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-4', elementId: '3' } })
    await app.getAccessibilityTree({ emit: false })
    await first.invoke(element('4'))
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'invoke', params: { appHandle: 'app-17', snapshotId: 'snapshot-5', elementId: '4' } })
    expect(f.sink.text).not.toHaveBeenCalled()
  })

  it('keeps separate snapshots for different application handles', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockResolvedValueOnce({ appHandle: 'app-18', name: 'Utility', running: true })
    f.dispatch.mockResolvedValueOnce(state({ appHandle: 'app-18', snapshotId: 'other', windows: [] }))
    const other = await f.api.getApp('Utility')
    await app.setValue(element('0'), 'Editor')
    await other.setValue(element('0'), 'Utility')
    expect(f.dispatch.mock.calls.slice(-2).map(([operation]) => operation)).toEqual([
      { method: 'setValue', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', elementId: '0', value: 'Editor' } },
      { method: 'setValue', params: { appHandle: 'app-18', snapshotId: 'other', elementId: '0', value: 'Utility' } },
    ])
  })

  it('shares one current snapshot between repeated handles for the same application', async () => {
    const f = fixture()
    const first = await f.api.getApp('Editor')
    const second = await f.api.getApp('Editor')
    expect(second.appHandle).toBe(first.appHandle)
    await first.setValue(element('1'), 'Shared')
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'setValue', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-2', elementId: '1', value: 'Shared',
    } })
  })

  it('exposes screenshots and pointer input only on explicit windows', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    expect(app).toHaveProperty('getAccessibilityTree')
    for (const method of ['getScreenshot', 'click', 'hover', 'scroll', 'drag']) expect(app).not.toHaveProperty(method)
    const window = await app.getWindow(23)
    for (const method of ['getScreenshot', 'click', 'hover', 'scroll', 'drag']) expect(window).toHaveProperty(method)
  })

  it('attaches the shared snapshot to coordinates only within its window scope', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const first = await app.getWindow(23)
    await first.click([10, 20])
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', windowId: 23, snapshotId: 'snapshot-2', x: 10, y: 20, mouseButton: 'left', clickCount: 1,
    } })
    const second = await app.getWindow(24)
    await first.click([10, 20])
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', windowId: 23, x: 10, y: 20, mouseButton: 'left', clickCount: 1,
    } })
    await second.click([10, 20])
    expect(f.dispatch.mock.calls.at(-1)?.[0]).toMatchObject({ params: { snapshotId: 'snapshot-3', windowId: 24 } })
    await app.getAccessibilityTree({ emit: false })
    await first.click([10, 20])
    expect(f.dispatch.mock.calls.at(-1)?.[0]).toMatchObject({ params: { snapshotId: 'snapshot-4', windowId: 23 } })
  })

  it('keeps a validated AXless window usable for screenshots and coordinate input', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockResolvedValueOnce(state({ windowId: 23, snapshotId: 'axless', tree: '', elements: [] }))
    const window = await app.getWindow(23)
    expect(f.sink.text).not.toHaveBeenCalled()
    await expect(window.getScreenshot()).resolves.toEqual({ bytes: Uint8Array.from(Buffer.from(PNG, 'base64')), mimeType: 'image/png', pixelWidth: 1, pixelHeight: 1, windowId: 23 })
    await window.click([10, 20])
    await window.scroll({ x: 10, y: 20, deltaLinesX: 0, deltaLinesY: -1 })
    await window.drag([10, 20], [30, 40])
    expect(f.dispatch.mock.calls.slice(-4).map(([operation]) => operation.method)).toEqual(['screenshot', 'click', 'scroll', 'drag'])
    for (const [operation] of f.dispatch.mock.calls.slice(-3)) {
      expect(operation.params).toMatchObject({ appHandle: 'app-17', windowId: 23, snapshotId: 'axless' })
    }
  })

  it.each(['WINDOW_UNAVAILABLE', 'PERMISSION_DENIED', 'STALE_APP', 'SESSION_LOCKED'])('propagates %s while selecting a window without attempting image or input fallback', async (code) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const failure = new Error(code)
    f.dispatch.mockRejectedValueOnce(failure)
    const calls = f.dispatch.mock.calls.length
    await expect(app.getWindow(23)).rejects.toBe(failure)
    expect(f.dispatch.mock.calls.slice(calls).map(([operation]) => operation.method)).toEqual(['getState'])
  })

  it('captures and clicks the explicitly selected window among several', async () => {
    const f = fixture()
    const windows = [
      windowInfo(23),
      { ...windowInfo(24), title: 'Menu helper', bounds: { ...bounds, width: 0, height: 0 } },
      { ...windowInfo(25), isOnScreen: false },
      { ...windowInfo(26), bounds: { ...bounds, height: 0 } },
    ]
    f.setWindowRecords(windows)
    const app = await f.api.getApp('Editor')
    expect(await app.getWindows({ emit: false })).toEqual(windows)
    const window = await app.getWindow(23)
    await window.getScreenshot()
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'screenshot', params: { appHandle: 'app-17', windowId: 23 } })
    await window.click([10, 20])
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', windowId: 23, snapshotId: 'snapshot-2', x: 10, y: 20, mouseButton: 'left', clickCount: 1,
    } })
    const hidden = await app.getWindow(25)
    await hidden.click([10, 20])
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', windowId: 25, snapshotId: 'snapshot-3', x: 10, y: 20, mouseButton: 'left', clickCount: 1,
    } })
  })

  it('captures a window without reading its accessibility tree', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(23)
    const calls = f.dispatch.mock.calls.length
    await window.getScreenshot()
    expect(f.dispatch).toHaveBeenCalledTimes(calls + 1)
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'screenshot', params: { appHandle: 'app-17', windowId: 23 } })
  })

  const providerIdentities: Record<string, JsonValue>[] = [
    { appHandle: 'another-app' }, { windowId: 24 },
  ]
  it.each(providerIdentities)('accepts provider state without revalidating identity: %j', async (identity) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockResolvedValueOnce(state(identity))
    await expect(app.getAccessibilityTree()).resolves.toBe('Changed tree')
    await app.setValue(element('0'), 'stale')
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'setValue', params: {
      appHandle: 'app-17', snapshotId: 'changed', elementId: '0', value: 'stale',
    } })
  })

  it('returns provider window records without process filtering', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const observed = windowInfo(24)
    f.dispatch.mockResolvedValueOnce(state({ windows: [observed] }))
    await expect(app.getAccessibilityTree()).resolves.toBe('Changed tree')
    f.dispatch.mockResolvedValueOnce([observed])
    await expect(app.getWindows()).resolves.toEqual([observed])
  })

  it('accepts coordinate input without a current snapshot', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(23)
    f.dispatch.mockRejectedValueOnce(new Error('Native app is busy'))
    await expect(window.getAccessibilityTree()).rejects.toThrow('Native app is busy')
    await window.click([10, 20])
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', windowId: 23, x: 10, y: 20, mouseButton: 'left', clickCount: 1,
    } })
  })

  it('clears a failed refresh and requires a new read before element operations', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(23)
    const failure = new Error('Native app is busy')
    f.dispatch.mockRejectedValueOnce(failure)
    await expect(app.getAccessibilityTree()).rejects.toBe(failure)
    await expect(window.setValue(element('0'), 'stale')).rejects.toThrow('Read getAccessibilityTree')
    await window.getAccessibilityTree({ emit: false })
    f.dispatch.mockRejectedValueOnce(failure)
    await expect(window.getAccessibilityTree()).rejects.toBe(failure)
    await expect(app.invoke(element('0'))).rejects.toThrow('Read getAccessibilityTree')
    f.sink.text.mockClear()
    const calls = f.dispatch.mock.calls.length
    await window.getScreenshot()
    expect(f.dispatch.mock.calls.slice(calls).map(([operation]) => operation.method)).toEqual(['screenshot'])
    expect(f.sink.text).not.toHaveBeenCalled()
    expect(f.sink.image).toHaveBeenCalledTimes(1)
  })
})

describe('screenshots', () => {
  it('returns screenshot metadata independently of input point bounds and supports selective output', async () => {
    const f = fixture()
    f.setWindows([23, 24])
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(24)
    f.sink.text.mockClear()
    const tree = await window.getAccessibilityTree()
    const image = await window.getScreenshot()
    expect(tree).toBe('Tree 3')
    expect(image).toEqual({ bytes: Uint8Array.from(Buffer.from(PNG, 'base64')), mimeType: 'image/png', pixelWidth: 1, pixelHeight: 1, windowId: 24 })
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'screenshot', params: { appHandle: 'app-17', windowId: 24 } })
    expect(f.sink.text).toHaveBeenCalledWith('Tree 3')
    expect(f.sink.image).toHaveBeenCalledWith(image)
    await window.getAccessibilityTree({ emit: false })
    await window.getScreenshot({ emit: false })
    expect(f.sink.text).toHaveBeenCalledTimes(1)
    expect(f.sink.image).toHaveBeenCalledTimes(1)
  })

  it('returns a screenshot captured from another window without rejecting it', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(23)
    f.dispatch.mockResolvedValueOnce(screenshot({ windowId: 24 }))
    await expect(window.getScreenshot()).resolves.toMatchObject({ windowId: 24 })
    expect(f.sink.image).toHaveBeenCalledWith(expect.objectContaining({ windowId: 24 }))
  })

  it.each(['image/jpeg', 'image/webp', 'image/gif'])('preserves Host-admitted %s bytes and metadata in the return value and image sink', async (mimeType) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(23)
    const data = Buffer.from('admitted request image').toString('base64')
    f.dispatch.mockResolvedValueOnce(screenshot({ mimeType, data, pixelWidth: 320, pixelHeight: 240 }))
    const image = await window.getScreenshot()
    expect(image).toEqual({ bytes: Uint8Array.from(Buffer.from(data, 'base64')), mimeType, pixelWidth: 320, pixelHeight: 240, windowId: 23 })
    expect(f.sink.image).toHaveBeenCalledExactlyOnceWith(image)
  })

})

describe('input actions', () => {
  it('passes explicit relative mode to every coordinate gesture and rejects it on element ids', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(23)
    await window.click([500, 250], { relative: true })
    await window.hover([500, 250], { relative: true })
    await window.drag([0, 0], [999, 999], { relative: true })
    await window.scroll({ x: 500, y: 250, relative: true, deltaLinesX: 0, deltaLinesY: -1 })
    expect(f.dispatch.mock.calls.slice(-4).map(([request]) => request.params)).toEqual([
      expect.objectContaining({ x: 500, y: 250, relative: true }),
      expect.objectContaining({ x: 500, y: 250, relative: true }),
      expect.objectContaining({ fromX: 0, toX: 999, relative: true }),
      expect.objectContaining({ x: 500, y: 250, relative: true }),
    ])
    await expect(window.click(element('1'), { relative: true })).rejects.toThrow()
    await expect(window.hover(element('1'), { relative: true })).rejects.toThrow()
  })

  it('keeps the selected window when scroll options include another target identity', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(23)
    const options = {
      x: 10, y: 20, deltaLinesX: 0, deltaLinesY: 1,
      appHandle: 'another-app', snapshotId: 'another-snapshot', windowId: 24,
    }

    await window.scroll(options)

    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'scroll', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-2', windowId: 23, x: 10, y: 20, deltaLinesX: 0, deltaLinesY: 1,
    } })
  })

  it('dispatches window-point gestures and reports delivery without claiming the action succeeded', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(23)
    expect(await window.click([10, 20], { mouseButton: 'right' })).toEqual(delivered)
    expect(await window.click([11, 21], { clickCount: 2 })).toEqual(delivered)
    expect(await window.scroll({ x: 10, y: 20, deltaLinesX: -2, deltaLinesY: 3 })).toEqual(delivered)
    expect(await window.drag([1, 2], [30, 40])).toEqual(delivered)
    expect(f.dispatch.mock.calls.slice(-4).map(([operation]) => operation)).toEqual([
      { method: 'click', params: { appHandle: 'app-17', windowId: 23, snapshotId: 'snapshot-2', x: 10, y: 20, mouseButton: 'right', clickCount: 1 } },
      { method: 'click', params: { appHandle: 'app-17', windowId: 23, snapshotId: 'snapshot-2', x: 11, y: 21, mouseButton: 'left', clickCount: 2 } },
      { method: 'scroll', params: { appHandle: 'app-17', windowId: 23, snapshotId: 'snapshot-2', x: 10, y: 20, deltaLinesX: -2, deltaLinesY: 3 } },
      { method: 'drag', params: { appHandle: 'app-17', windowId: 23, snapshotId: 'snapshot-2', fromX: 1, fromY: 2, toX: 30, toY: 40 } },
    ])
  })

  type Surfaces = { app: CuaApp; window: CuaWindow }
  const invalidActions: Array<[string, (surfaces: Surfaces) => Promise<unknown>]> = [
    ['right double click', ({ window }) => window.click([1, 2], { mouseButton: 'right', clickCount: 2 })],
    ['right AX double click', ({ window }) => window.click(element('0'), { mouseButton: 'right', clickCount: 2 })],
    ['empty hover element id', ({ window }) => window.hover(element(''))],
    ['negative hover point', ({ window }) => window.hover([-1, 0])],
    ['nonfinite hover point', ({ window }) => window.hover([NaN, 0])],
    ['empty click element id', ({ window }) => window.click(element(''))],
    ['nonfinite coordinate', ({ window }) => window.click([NaN, 0])],
    ['negative coordinate', ({ window }) => window.click([-1, 0])],
    ['empty value element id', ({ window }) => window.setValue(element(''), 'value')],
    ['zero scroll', ({ window }) => window.scroll({ x: 0, y: 0, deltaLinesX: 0, deltaLinesY: 0 })],
    ['oversized scroll', ({ window }) => window.scroll({ x: 0, y: 0, deltaLinesX: 11, deltaLinesY: 0 })],
    ['fractional scroll', ({ window }) => window.scroll({ x: 0, y: 0, deltaLinesX: 0.5, deltaLinesY: 0 })],
    ['negative drag point', ({ window }) => window.drag([0, 0], [-1, 3])],
    ['empty chord', ({ app }) => app.pressKey('')],
    ['missing key', ({ app }) => app.pressKey('super+')],
    ['empty plus modifier', ({ app }) => app.pressKey('++')],
    ['extra plus delimiter', ({ app }) => app.pressKey('cmd+++')],
    ['unknown modifier', ({ app }) => app.pressKey('unknown+a')],
  ]
  it.each<[string, (surfaces: Surfaces) => Promise<unknown>]>([
    ['getState windowId: Too small: expected number to be >0', ({ app }) => app.getWindow(0)],
    ['selectText text: Too small: expected string to have >=1 characters', ({ app }) => app.selectText(element('0'), '')],
    ['hover x: Invalid input: expected number, received NaN', ({ window }) => window.hover([NaN, 0])],
    ['hover x: Too big: expected number to be <=999', ({ window }) => window.hover([1000, 0], { relative: true })],
    ['click relative: not accepted for these arguments', ({ window }) => window.click(element('650'), { relative: true })],
  ])('reports a readable validation failure: %s', async (message, run) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(23)
    f.dispatch.mockClear()
    await expect(run({ app, window })).rejects.toMatchObject({ name: 'Error', message })
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it.each(invalidActions)('rejects %s without invoking native input', async (_label, run) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(23)
    const calls = f.dispatch.mock.calls.length
    await expect(run({ app, window })).rejects.toThrow()
    expect(f.dispatch).toHaveBeenCalledTimes(calls)
  })

  it.each<[string, string, string[]]>([
    ['+', '+', []],
    ['cmd++', '+', ['command']],
    ['ctrl+shift++', '+', ['control', 'shift']],
    ['cmd+plus', 'plus', ['command']],
    ['plus', 'plus', []],
  ])('dispatches the plus-key chord %s', async (chord, key, modifiers) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.pressKey(chord)
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'pressKey', params: { appHandle: 'app-17', key, modifiers } })
  })

  it('passes literal text and keys to the selected app identity', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.typeText('中文\nline two')
    await app.paste('粘贴\nplain text')
    await app.paste('<b>bold</b>', { format: 'html' })
    await app.pressKey('Control_L+shift+a')
    await app.pressKey('Return')
    expect(f.dispatch.mock.calls.slice(-5).map(([operation]) => operation)).toEqual([
      { method: 'typeText', params: { appHandle: 'app-17', text: '中文\nline two' } },
      { method: 'paste', params: { appHandle: 'app-17', text: '粘贴\nplain text' } },
      { method: 'paste', params: { appHandle: 'app-17', text: '<b>bold</b>', format: 'html' } },
      { method: 'pressKey', params: { appHandle: 'app-17', key: 'a', modifiers: ['control', 'shift'] } },
      { method: 'pressKey', params: { appHandle: 'app-17', key: 'Return', modifiers: [] } },
    ])
  })

  it('rejects keyboard input on a window surface without dispatching an app-level fallback', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(23)
    f.dispatch.mockClear()
    for (const run of [
      () => window.typeText('hello'),
      () => window.paste('hello'),
      () => window.pressKey('Return'),
    ]) {
      await expect(run()).rejects.toThrow('Keyboard input is not supported at this scope.')
    }
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it('retains the snapshot identity for element right and double clicks', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(23)
    await window.click(element('12'), { mouseButton: 'right' })
    await window.click(element('13'), { clickCount: 2 })
    expect(f.dispatch.mock.calls.slice(-2).map(([operation]) => operation)).toEqual([
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-2', elementId: '12', mouseButton: 'right' } },
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-2', elementId: '13', clickCount: 2 } },
    ])
  })

  it('dispatches an opaque provider element id unchanged', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(23)
    await window.click(element('42.12345'))
    await window.hover(element('42.12345'))
    expect(f.dispatch.mock.calls.slice(-2).map(([operation]) => operation)).toEqual([
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-2', elementId: '42.12345' } },
      { method: 'hover', params: { appHandle: 'app-17', snapshotId: 'snapshot-2', elementId: '42.12345' } },
    ])
  })

  it('does not activate on selection and dispatches only an explicit activation request', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    expect(f.dispatch.mock.calls.map(([call]) => call.method)).toEqual(['getApp', 'getState'])
    await app.activate()
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'activate', params: { appHandle: 'app-17' } })
  })

  it('propagates native failures once and rejects malformed delivery claims', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(23)
    const failure = new Error('Application was restarted; select it again')
    f.dispatch.mockRejectedValueOnce(failure)
    await expect(app.typeText('hello')).rejects.toBe(failure)
    expect(f.dispatch).toHaveBeenCalledTimes(4)
    f.dispatch.mockResolvedValueOnce({ dispatched: 'yes' })
    await expect(window.click(element('0'))).rejects.toThrow()
    expect(f.dispatch).toHaveBeenCalledTimes(5)
  })

  it('rejects invalid selection inputs before dispatch', async () => {
    const f = fixture()
    await expect(f.api.getApp('')).rejects.toThrow()
    expect(f.dispatch).not.toHaveBeenCalled()
    const app = await f.api.getApp('Editor')
    const calls = f.dispatch.mock.calls.length
    await expect(app.getWindow(0)).rejects.toThrow()
    expect(f.dispatch).toHaveBeenCalledTimes(calls)
  })
})

it('expands menu contents and details only for the requested observation', async () => {
  const f = fixture()
  const app = await f.api.getApp('Editor')
  await app.getAccessibilityTree({ includeMenus: true, details: true, emit: false })
  expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'getState', params: { appHandle: selected.appHandle, includeMenus: true, details: true } })
  await app.getAccessibilityTree({ includeMenus: false, details: false })
  expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'getState', params: { appHandle: selected.appHandle, includeMenus: false, details: false } })
})
