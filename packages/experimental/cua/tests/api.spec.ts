/** App and window behavior over a fixture operation dispatcher, without desktop access. */
import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { createCuaApi } from '../src/api.ts'
import type { CuaApp, CuaOperation, CuaScreenshot } from '../src/types.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
const bounds = { x: -640, y: 100, width: 640, height: 480 }
const selected = { appHandle: 'app-17', pid: 17, name: 'Editor', bundleId: 'test.editor' }
const delivered = { dispatched: true, verified: false }
const capabilities = { platform: 'macos', sessionLocked: false, permissions: { accessibility: true, screenRecording: false }, methods: ['getState', 'click'], coordinateSpace: 'screenshot-pixels', browser: false }

function windowInfo(windowId: number) {
  return { windowId, pid: 17, appName: 'Editor', title: `Document ${windowId}`, bounds, isOnScreen: true, onCurrentSpace: null }
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
        appHandle: selected.appHandle, pid: 17, windowId: params.windowId ?? null,
        snapshotId: `snapshot-${++generation}`, tree: `Tree ${generation}`, truncated: false,
        windows: params.windowId === undefined ? windows : windows.filter(window => window.windowId === params.windowId),
      }
      case 'screenshot': return { mimeType: 'image/png', data: PNG, pixelWidth: 1, pixelHeight: 1, windowId: params.windowId, bounds, coordinateSpace: 'screenshot-pixels' }
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
  return { appHandle: selected.appHandle, pid: 17, windowId: null, snapshotId: 'changed', tree: 'Changed tree', windows: [windowInfo(23)], truncated: false, ...overrides }
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
    expect(app.pid).toBe(17)
    expect(app.appHandle).toBe('app-17')
    expect(await app.getScreenshot()).toEqual({ bytes: Uint8Array.from(Buffer.from(PNG, 'base64')), mimeType: 'image/png', pixelWidth: 1, pixelHeight: 1, windowId: 23 })
    expect(f.dispatch.mock.calls.map(([operation]) => operation.method)).toEqual([
      'getCapabilities', 'listApps', 'getApp', 'getState', 'screenshot',
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
    f.dispatch.mockClear()
    expect(await app.hover(0)).toEqual({ ...delivered, hoverRoute: 'accessibility', systemPointerMoved: false })
    await app.getAXStateAndScreenshot({ emit: false })
    expect(await app.hover([30, 40])).toEqual({ ...delivered, hoverRoute: 'accessibility', systemPointerMoved: false })
    expect(f.dispatch.mock.calls.map(([operation]) => operation)).toEqual([
      { method: 'hover', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', elementIndex: 0 } },
      { method: 'getState', params: { appHandle: 'app-17' } },
      { method: 'screenshot', params: { appHandle: 'app-17', windowId: 23 } },
      { method: 'hover', params: { appHandle: 'app-17', snapshotId: 'snapshot-2', windowId: 23, x: 30, y: 40 } },
    ])
    const window = await app.getWindow(24)
    await window.hover([5, 6])
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'hover', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-3', windowId: 24, x: 5, y: 6,
    } })
    f.dispatch.mockRejectedValueOnce(new Error('WINDOW_CHANGED'))
    await expect(window.hover([5, 6])).rejects.toThrow('WINDOW_CHANGED')
    expect(f.dispatch).toHaveBeenCalledTimes(7)
  })
})

describe('pointer buttons and modifiers', () => {
  it('retains middle-button and modifier intent through click and drag dispatch', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.click(0, { mouseButton: 'middle', modifiers: ['shift'] })
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-1', elementIndex: 0, mouseButton: 'middle', modifiers: ['shift'],
    } })
    await app.click([10, 20], { modifiers: ['command'] })
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-1', windowId: 23, x: 10, y: 20,
      mouseButton: 'left', clickCount: 1, modifiers: ['command'],
    } })
    await app.drag([10, 20], [30, 40], { mouseButton: 'middle', modifiers: ['shift', 'option'] })
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'drag', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-1', windowId: 23, fromX: 10, fromY: 20, toX: 30, toY: 40,
      mouseButton: 'middle', modifiers: ['shift', 'option'],
    } })
    const count = f.dispatch.mock.calls.length
    await expect(app.click(0, { mouseButton: 'middle', clickCount: 2 })).rejects.toThrow('Only left double-click')
    expect(f.dispatch).toHaveBeenCalledTimes(count)
  })
})

describe('text selections', () => {
  it('binds literal text and optional disambiguation to the latest observed control', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.selectText(1, 'target')
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'selectText', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-1', elementIndex: 1, text: 'target',
    } })
    await app.selectText(1, 'target', { prefix: 'second ', suffix: '.', selectionType: 'cursor_after' })
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'selectText', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-1', elementIndex: 1, text: 'target',
      prefix: 'second ', suffix: '.', selectionType: 'cursor_after',
    } })
    const calls = f.dispatch.mock.calls.length
    await expect(app.selectText(1, '')).rejects.toThrow()
    expect(f.dispatch).toHaveBeenCalledTimes(calls)
  })
})

describe('application and window observations', () => {
  it('keeps the latest AX index scope separate for an app and each selected window', async () => {
    const f = fixture()
    f.setWindows([23, 24])
    const app = await f.api.getApp('Editor')
    expect(await app.getWindows({ emit: false })).toEqual([windowInfo(23), windowInfo(24)])
    const first = await app.getWindow(23)
    const second = await app.getWindow(24)
    await app.click(0)
    await first.setValue(1, 'First document')
    await second.click(2)
    expect(f.dispatch.mock.calls.slice(-3).map(([operation]) => operation)).toEqual([
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', elementIndex: 0 } },
      { method: 'setValue', params: { appHandle: 'app-17', snapshotId: 'snapshot-2', elementIndex: 1, value: 'First document' } },
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-3', elementIndex: 2 } },
    ])
    expect(first.windowId).toBe(23)
    expect(second.windowId).toBe(24)
    expect(f.sink.text.mock.calls.map(([text]) => text)).toEqual(['Tree 1', 'Tree 2', 'Tree 3'])
    await expect(second.getAXState({ emit: false, disableDiffing: true })).resolves.toBe('Tree 4')
    await second.click(3)
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-4', elementIndex: 3 } })
    expect(f.sink.text).toHaveBeenCalledTimes(3)
  })

  it('keeps a validated AXless window usable for screenshots and coordinate input', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockResolvedValueOnce(state({ windowId: 23, snapshotId: 'axless', tree: '', elements: [] }))
    const window = await app.getWindow(23)
    expect(f.sink.text).toHaveBeenLastCalledWith('')
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

  it.each([{ ids: [] }, { ids: [23, 24] }])('requires an explicit window when discovery yields $ids', async ({ ids }) => {
    const f = fixture()
    f.setWindows(ids)
    const app = await f.api.getApp('Editor')
    const calls = f.dispatch.mock.calls.length
    await expect(app.click([1, 2])).rejects.toThrow('Select a window')
    await expect(app.getScreenshot()).rejects.toThrow('Select a window')
    expect(f.dispatch).toHaveBeenCalledTimes(calls)
  })

  it('selects the one visible nonzero window while preserving menu and hidden windows in discovery', async () => {
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
    await app.getScreenshot()
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'screenshot', params: { appHandle: 'app-17', windowId: 23 } })
    await app.click([10, 20])
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-1', windowId: 23, x: 10, y: 20, mouseButton: 'left', clickCount: 1,
    } })
    const hidden = await app.getWindow(25)
    await hidden.click([10, 20])
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-2', windowId: 25, x: 10, y: 20, mouseButton: 'left', clickCount: 1,
    } })
  })

  it('requires explicit selection when every window is hidden or has zero size', async () => {
    const f = fixture()
    f.setWindowRecords([
      { ...windowInfo(24), bounds: { ...bounds, width: 0, height: 0 } },
      { ...windowInfo(25), isOnScreen: false },
    ])
    const app = await f.api.getApp('Editor')
    const calls = f.dispatch.mock.calls.length
    await expect(app.getScreenshot()).rejects.toThrow('Select a window')
    expect(f.dispatch).toHaveBeenCalledTimes(calls)
  })

  it('captures the focused application window when several visible windows exist', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockResolvedValueOnce(state({ focusedWindowId: 24, windows: [windowInfo(23), windowInfo(24)] }))
    await app.getAXState()
    await app.getScreenshot()
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'screenshot', params: { appHandle: 'app-17', windowId: 24 } })
  })

  it('does not select a focused window absent from the application observation', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockResolvedValueOnce(state({ focusedWindowId: 99, windows: [windowInfo(23), windowInfo(24)] }))
    await app.getAXState()
    await expect(app.getScreenshot()).rejects.toThrow('Select a window')
  })

  const identityMismatches: Record<string, JsonValue>[] = [
    { appHandle: 'another-app' }, { pid: 18 }, { windowId: 24 },
  ]
  it.each(identityMismatches)('rejects a snapshot belonging to another identity: %j', async (identity) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockResolvedValueOnce(state(identity))
    await expect(app.getAXState()).rejects.toThrow('another application or window')
    const calls = f.dispatch.mock.calls.length
    await expect(app.click(0)).rejects.toThrow('Read getAXState')
    expect(f.dispatch).toHaveBeenCalledTimes(calls)
  })

  it('rejects wrong-process windows in both snapshot and standalone window discovery', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const otherWindow = { ...windowInfo(23), pid: 18 }
    f.dispatch.mockResolvedValueOnce(state({ windows: [otherWindow] }))
    await expect(app.getAXState()).rejects.toThrow('windows belong to another application')
    f.dispatch.mockResolvedValueOnce([otherWindow])
    await expect(app.getWindows()).rejects.toThrow('windows belong to another application')
    expect(f.sink.text).toHaveBeenCalledTimes(1)
  })

  it('clears a failed refresh and obtains new state before a later screenshot', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const failure = new Error('Native app is busy')
    f.dispatch.mockRejectedValueOnce(failure)
    await expect(app.getAXState()).rejects.toBe(failure)
    await expect(app.setValue(0, 'stale')).rejects.toThrow('Read getAXState')
    f.sink.text.mockClear()
    await app.getScreenshot()
    expect(f.dispatch.mock.calls.slice(-2).map(([operation]) => operation.method)).toEqual(['getState', 'screenshot'])
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
    const observation = await window.getAXStateAndScreenshot()
    expect(observation.state).toBe('Tree 3')
    expect(observation.screenshot).toEqual({ bytes: Uint8Array.from(Buffer.from(PNG, 'base64')), mimeType: 'image/png', pixelWidth: 1, pixelHeight: 1, windowId: 24 })
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'screenshot', params: { appHandle: 'app-17', windowId: 24 } })
    expect(f.sink.text).toHaveBeenCalledWith('Tree 3')
    expect(f.sink.image).toHaveBeenCalledWith(observation.screenshot)
    await window.getAXStateAndScreenshot({ emit: false })
    expect(f.sink.text).toHaveBeenCalledTimes(1)
    expect(f.sink.image).toHaveBeenCalledTimes(1)
  })

  it('rejects a screenshot captured from another window before emitting it', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockResolvedValueOnce(screenshot({ windowId: 24 }))
    await expect(app.getScreenshot()).rejects.toThrow('another window')
    expect(f.sink.image).not.toHaveBeenCalled()
  })

  it.each(['image/jpeg', 'image/webp', 'image/gif'])('preserves Host-admitted %s bytes and metadata in the return value and image sink', async (mimeType) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const data = Buffer.from('admitted request image').toString('base64')
    f.dispatch.mockResolvedValueOnce(screenshot({ mimeType, data, pixelWidth: 320, pixelHeight: 240 }))
    const image = await app.getScreenshot()
    expect(image).toEqual({ bytes: Uint8Array.from(Buffer.from(data, 'base64')), mimeType, pixelWidth: 320, pixelHeight: 240, windowId: 23 })
    expect(f.sink.image).toHaveBeenCalledExactlyOnceWith(image)
  })

})

describe('input actions', () => {
  it('passes explicit relative mode to every coordinate gesture and rejects it on element indices', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.click([500, 250], { relative: true })
    await app.hover([500, 250], { relative: true })
    await app.drag([0, 0], [1000, 1000], { relative: true })
    await app.scroll({ x: 500, y: 250, relative: true, deltaLinesX: 0, deltaLinesY: -1 })
    expect(f.dispatch.mock.calls.slice(-4).map(([request]) => request.params)).toEqual([
      expect.objectContaining({ x: 500, y: 250, relative: true }),
      expect.objectContaining({ x: 500, y: 250, relative: true }),
      expect.objectContaining({ fromX: 0, toX: 1000, relative: true }),
      expect.objectContaining({ x: 500, y: 250, relative: true }),
    ])
    await expect(app.click(1, { relative: true })).rejects.toThrow()
    await expect(app.hover(1, { relative: true })).rejects.toThrow()
  })

  it('keeps the selected app and window when scroll options include another target identity', async () => {
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
    expect(await app.click([10, 20], { mouseButton: 'right' })).toEqual(delivered)
    expect(await app.click([11, 21], { clickCount: 2 })).toEqual(delivered)
    expect(await app.scroll({ x: 10, y: 20, deltaLinesX: -2, deltaLinesY: 3 })).toEqual(delivered)
    expect(await app.drag([1, 2], [30, 40])).toEqual(delivered)
    expect(f.dispatch.mock.calls.slice(-4).map(([operation]) => operation)).toEqual([
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', windowId: 23, x: 10, y: 20, mouseButton: 'right', clickCount: 1 } },
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', windowId: 23, x: 11, y: 21, mouseButton: 'left', clickCount: 2 } },
      { method: 'scroll', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', windowId: 23, x: 10, y: 20, deltaLinesX: -2, deltaLinesY: 3 } },
      { method: 'drag', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', windowId: 23, fromX: 1, fromY: 2, toX: 30, toY: 40 } },
    ])
  })

  const invalidActions: Array<[string, (app: CuaApp) => Promise<unknown>]> = [
    ['right double click', app => app.click([1, 2], { mouseButton: 'right', clickCount: 2 })],
    ['right AX double click', app => app.click(0, { mouseButton: 'right', clickCount: 2 })],
    ['negative hover index', app => app.hover(-1)],
    ['negative hover point', app => app.hover([-1, 0])],
    ['nonfinite hover point', app => app.hover([NaN, 0])],
    ['negative AX index', app => app.click(-1)],
    ['nonfinite coordinate', app => app.click([NaN, 0])],
    ['negative coordinate', app => app.click([-1, 0])],
    ['negative value index', app => app.setValue(-1, 'value')],
    ['zero scroll', app => app.scroll({ x: 0, y: 0, deltaLinesX: 0, deltaLinesY: 0 })],
    ['oversized scroll', app => app.scroll({ x: 0, y: 0, deltaLinesX: 11, deltaLinesY: 0 })],
    ['fractional scroll', app => app.scroll({ x: 0, y: 0, deltaLinesX: 0.5, deltaLinesY: 0 })],
    ['negative drag point', app => app.drag([0, 0], [-1, 3])],
    ['empty chord', app => app.pressKey('')],
    ['missing key', app => app.pressKey('super+')],
    ['empty plus modifier', app => app.pressKey('++')],
    ['extra plus delimiter', app => app.pressKey('cmd+++')],
    ['unknown modifier', app => app.pressKey('unknown+a')],
  ]
  it.each<[string, (app: CuaApp) => Promise<unknown>]>([
    ['getState windowId: Too small: expected number to be >0', app => app.getWindow(0)],
    ['selectText text: Too small: expected string to have >=1 characters', app => app.selectText(0, '')],
    ['hover x: Invalid input: expected number, received NaN', app => app.hover([NaN, 0])],
    ['hover x: Too big: expected number to be <=1000', app => app.hover([1001, 0], { relative: true })],
    ['click relative: not accepted for these arguments', app => app.click(650, { relative: true })],
  ])('reports a readable validation failure: %s', async (message, run) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockClear()
    await expect(run(app)).rejects.toMatchObject({ name: 'Error', message })
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it.each(invalidActions)('rejects %s without invoking native input', async (_label, run) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const calls = f.dispatch.mock.calls.length
    await expect(run(app)).rejects.toThrow()
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

  it('retains the snapshot identity for indexed right and double clicks', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.click(12, { mouseButton: 'right' })
    await app.click(13, { clickCount: 2 })
    expect(f.dispatch.mock.calls.slice(-2).map(([operation]) => operation)).toEqual([
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', elementIndex: 12, mouseButton: 'right' } },
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', elementIndex: 13, clickCount: 2 } },
    ])
  })

  it('routes an explicit secondary action through the selected window snapshot', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(23)
    await window.performSecondaryAction(2, 'raise')
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'performSecondaryAction', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-2', elementIndex: 2, action: 'raise',
    } })
    await expect(window.performSecondaryAction(2, '')).rejects.toThrow()
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
    const failure = new Error('Application was restarted; select it again')
    f.dispatch.mockRejectedValueOnce(failure)
    await expect(app.typeText('hello')).rejects.toBe(failure)
    expect(f.dispatch).toHaveBeenCalledTimes(3)
    f.dispatch.mockResolvedValueOnce({ dispatched: true, verified: true })
    await expect(app.click(0)).rejects.toThrow()
    expect(f.dispatch).toHaveBeenCalledTimes(4)
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
  await app.getAXState({ includeMenus: true, details: true, emit: false })
  expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'getState', params: { appHandle: selected.appHandle, includeMenus: true, details: true } })
  await app.getAXState({ includeMenus: false, details: false })
  expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'getState', params: { appHandle: selected.appHandle, includeMenus: false, details: false } })
})
