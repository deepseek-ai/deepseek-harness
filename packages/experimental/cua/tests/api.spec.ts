/** App and window behavior over a fixture operation dispatcher, without desktop access. */
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { createCuaApi } from '../src/api.ts'
import { NativeError } from '../src/native-client.ts'
import type { CuaApp, CuaCapabilities, CuaCoordinateOptions, CuaElementId, CuaOperation, CuaWindow } from '../src/types.ts'

/** Element ids are opaque strings; these fixtures use the macOS decimal form. */
const element = (id: string): CuaElementId => brandString<CuaElementId>(id)

const IMAGE = Object.freeze({ attachmentId: 'sha256:screenshot', path: '/images/screenshot.png', width: 1, height: 1 })
const bounds = { x: -640, y: 100, width: 640, height: 480 }
const selected = { appHandle: 'app-17', pid: 17, name: 'Editor', bundleId: 'test.editor', isRunning: true, running: true }
const delivered = { dispatched: true }
const capabilities: CuaCapabilities = { platform: 'macos', systemPointer: true, sessionLocked: false, permissions: { accessibility: true, screenRecording: false }, appLevelAccessibility: true, keyboard: ['app'], methods: ['getState', 'click'], coordinateSpace: 'screenshot-pixels', browser: false }

function windowInfo(windowId: string) {
  return { windowId, appName: 'Editor', title: `Document ${windowId}`, bounds, isOnScreen: true, onCurrentSpace: null }
}

function fixture() {
  let windows = [windowInfo('23')]
  let currentCapabilities: CuaCapabilities = capabilities
  let generation = 0
  const dispatch = vi.fn(async ({ method, params }: CuaOperation): Promise<JsonValue> => {
    switch (method) {
      case 'getCapabilities': return currentCapabilities
      case 'listApps': return [selected, { id: 'utility-selector', name: 'Utility', isRunning: true }]
      case 'getApp': return selected
      case 'listWindows': return windows
      case 'mouseMove': return { ...delivered, hoverRoute: 'accessibility', systemPointerMoved: false }
      case 'show': return { ...delivered, windowId: params.windowId ?? '23', foregroundChanged: false }
      case 'getState': return {
        appHandle: selected.appHandle, windowId: params.windowId ?? null,
        snapshotId: `snapshot-${++generation}`, tree: `Tree ${generation}`, truncated: false,
        windows: params.windowId === undefined ? windows : windows.filter(window => window.windowId === params.windowId),
      }
      case 'screenshot': return IMAGE
      case 'listActions': return ['AXPress', 'AXShowMenu', 'AXTextArea.AXValue.Set']
      default: return delivered
    }
  })
  return {
    dispatch, api: createCuaApi(dispatch),
    setWindows: (ids: string[]) => { windows = ids.map(windowInfo) },
    setWindowRecords: (records: ReturnType<typeof windowInfo>[]) => { windows = records },
    setCapabilities: (value: CuaCapabilities) => { currentCapabilities = value },
  }
}

function state(overrides: Record<string, JsonValue> = {}): JsonValue {
  return { appHandle: selected.appHandle, windowId: null, snapshotId: 'changed', tree: 'Changed tree', windows: [windowInfo('23')], truncated: false, ...overrides }
}

describe('application discovery', () => {
  it('reports permissions and discovers provider-issued selectors without activating an app', async () => {
    const f = fixture()
    expect(await f.api.getCapabilities()).toEqual(capabilities)
    expect(await f.api.getState()).toEqual({ apps: [
      { id: 'test.editor', displayName: 'Editor', isRunning: true, pid: 17 },
      { id: 'utility-selector', displayName: 'Utility', isRunning: true },
    ], browsers: [] })
    expect(f.dispatch.mock.calls.map(([operation]) => operation.method)).toEqual(['getCapabilities', 'listApps'])
  })

  it.each([undefined, 'test.utility'])('selects either same-name macOS process with bundle ID %s', async (bundleId) => {
    const f = fixture()
    const pids = [101, 202]
    f.dispatch.mockResolvedValueOnce(pids.map(pid => bundleId ? { name: 'Utility', isRunning: true, pid, bundleId } : { name: 'Utility', pid }))
    const apps = await f.api.listApps()
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(apps).toEqual(pids.map(pid => ({ id: bundleId ?? String(pid), displayName: 'Utility', isRunning: true, pid })))
    for (const app of apps) await f.api.getApp(String(app.pid))
    expect(f.dispatch.mock.calls.flatMap(([call]) => call.method === 'getApp' ? [call.params.selector] : []))
      .toEqual(['101', '202'])
  })

  it('passes a discovered selector unchanged to application selection', async () => {
    const f = fixture()
    const apps = await f.api.listApps()
    await f.api.getApp(apps[1]!.id)
    expect(f.dispatch).toHaveBeenCalledWith({ method: 'getApp', params: { selector: 'utility-selector' } })
  })

  it('uses the application name when discovery has no identifier', async () => {
    const f = fixture()
    f.dispatch.mockResolvedValueOnce([{ pid: 18, name: 'Utility', isRunning: false }])
    expect(await f.api.listApps()).toEqual([{ id: 'Utility', displayName: 'Utility', isRunning: false }])
  })

  it('returns app handles and window records for the selected application', async () => {
    const f = fixture()
    expect(await f.api.getCapabilities()).toEqual(capabilities)
    expect(await f.api.listApps()).toHaveLength(2)
    const app = await f.api.getApp('Editor')
    expect(app).not.toHaveProperty('pid')
    expectTypeOf<CuaApp>().not.toHaveProperty('pid')
    expect(app.appHandle).toBe('app-17')
    const window = await app.getWindow('23')
    expect(await window.getScreenshot()).toEqual(IMAGE)
    expect(f.dispatch.mock.calls.map(([operation]) => operation.method)).toEqual([
      'getCapabilities', 'listApps', 'getApp', 'screenshot',
    ])
    expect(await app.getWindows()).toEqual([windowInfo('23')])
  })

  it('searches installed applications without turning ordinary discovery into an installed-app inventory', async () => {
    const f = fixture()
    const matches = [
      { id: 'test.stopped', displayName: 'Stopped', path: '/Applications/Stopped.app', isRunning: false },
      ...[101, 202].map(pid => ({ id: 'test.running', displayName: 'Running', path: `/fixture/${pid}/Running.app`, isRunning: true, pid })),
    ]
    f.dispatch.mockResolvedValueOnce(matches)
    expect(await f.api.findApps('Editor')).toEqual(matches)
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'findApps', params: { query: 'Editor' } })
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
    f.dispatch.mockResolvedValueOnce([{ id: '', name: 'Invalid' }])
    await expect(f.api.listApps()).rejects.toThrow()
    f.dispatch.mockResolvedValueOnce({ ...selected, appHandle: '' })
    await expect(f.api.getApp('Editor')).rejects.toThrow()
  })
})

describe('background window restoration', () => {
  it('shows an app or selected window without dispatching activation or AXRaise', async () => {
    const f = fixture()
    f.setWindows(['23', '24'])
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow('24')
    f.dispatch.mockClear()
    expect(await app.show()).toEqual({ ...delivered, windowId: '23', foregroundChanged: false })
    expect(await window.show()).toEqual({ ...delivered, windowId: '24', foregroundChanged: false })
    expect(f.dispatch.mock.calls.map(([operation]) => operation)).toEqual([
      { method: 'show', params: { appHandle: 'app-17' } },
      { method: 'show', params: { appHandle: 'app-17', windowId: '24' } },
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

describe('mouseMove across observations', () => {
  it('moves to an AX element then into a popup without inserting clicks or restoring a point', async () => {
    const f = fixture()
    f.setWindows(['23', '24'])
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const window = await app.getWindow('23')
    await window.getAccessibilityTree()
    f.dispatch.mockClear()
    expect(await window.mouseMove(element('0'))).toEqual({ ...delivered, hoverRoute: 'accessibility', systemPointerMoved: false })
    await window.getAccessibilityTree()
    await window.getScreenshot()
    expect(await window.mouseMove([30, 40])).toEqual({ ...delivered, hoverRoute: 'accessibility', systemPointerMoved: false })
    expect(f.dispatch.mock.calls.map(([operation]) => operation)).toEqual([
      { method: 'mouseMove', params: { appHandle: 'app-17', snapshotId: 'snapshot-2', elementId: '0', windowId: '23' } },
      { method: 'getState', params: { appHandle: 'app-17', windowId: '23' } },
      { method: 'screenshot', params: { appHandle: 'app-17', windowId: '23' } },
      { method: 'mouseMove', params: { appHandle: 'app-17', snapshotId: 'snapshot-3', windowId: '23', x: 30, y: 40 } },
    ])
    const other = await app.getWindow('24')
    await other.getAccessibilityTree()
    await other.mouseMove([5, 6])
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'mouseMove', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-4', windowId: '24', x: 5, y: 6,
    } })
    f.dispatch.mockRejectedValueOnce(new Error('WINDOW_CHANGED'))
    await expect(other.mouseMove([5, 6])).rejects.toThrow('WINDOW_CHANGED')
    expect(f.dispatch).toHaveBeenCalledTimes(7)
  })
})

describe('pointer buttons and modifiers', () => {
  it.each([0, 800])('preserves %d ms for window clicks at elements and coordinates', async (holdMs) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const window = await app.getWindow('23')
    await window.getAccessibilityTree()
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
    await app.getAccessibilityTree()
    const window = await app.getWindow('23')
    await window.getAccessibilityTree()
    await window.click(element('0'), { mouseButton: 'middle', modifiers: ['shift'] })
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-2', elementId: '0', windowId: '23', mouseButton: 'middle', modifiers: ['shift'],
    } })
    await window.click([10, 20], { modifiers: ['command'] })
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', windowId: '23', snapshotId: 'snapshot-2', x: 10, y: 20,
      mouseButton: 'left', clickCount: 1, modifiers: ['command'],
    } })
    await window.drag([10, 20], [30, 40], { mouseButton: 'middle', modifiers: ['shift', 'option'], useSystemPointer: true })
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'drag', params: {
      appHandle: 'app-17', windowId: '23', snapshotId: 'snapshot-2', fromX: 10, fromY: 20, toX: 30, toY: 40,
      useSystemPointer: true, mouseButton: 'middle', modifiers: ['shift', 'option'],
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
    await app.getAccessibilityTree()
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
    await app.getAccessibilityTree()
    f.dispatch.mockClear()
    expect(await app.listActions(element('42.12345'))).toEqual(['AXPress', 'AXShowMenu', 'AXTextArea.AXValue.Set'])
    expect(f.dispatch.mock.calls.map(([operation]) => operation)).toEqual([
      { method: 'listActions', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', elementId: '42.12345' } },
    ])
    await expect(app.listActions(element(''))).rejects.toThrow()
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
})

describe('element actions', () => {
  it('dispatches advertised actions with omitted, null or direct values without wrapping the value', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
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
  })

  it('rejects an empty action before dispatch', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    f.dispatch.mockClear()
    await expect(app.performAction(element('0'), '')).rejects.toThrow('performAction action')
    expect(f.dispatch).not.toHaveBeenCalled()
  })
})

describe('element default invocation', () => {
  it('uses the latest snapshot and opaque element id without reading fresh state', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    f.dispatch.mockClear()
    expect(await app.invoke(element('42.12345'))).toEqual(delivered)
    expect(f.dispatch.mock.calls.map(([operation]) => operation)).toEqual([
      { method: 'invoke', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', elementId: '42.12345' } },
    ])
  })

  it('returns confirmed absence of a default action as un-dispatched evidence', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    f.dispatch.mockResolvedValueOnce({ dispatched: false })
    await expect(app.invoke(element('9'))).resolves.toEqual({ dispatched: false })
  })

  it('rejects provider failures and malformed dispatch evidence', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const failure = new Error('PERMISSION_DENIED')
    f.dispatch.mockRejectedValueOnce(failure)
    await expect(app.invoke(element('0'))).rejects.toBe(failure)
    f.dispatch.mockResolvedValueOnce({ dispatched: 'yes' })
    await expect(app.invoke(element('0'))).rejects.toThrow()
    await expect(app.invoke(element(''))).rejects.toThrow('invoke elementId')
  })
})

describe('application and window observations', () => {
  it('preserves an opaque window ID through discovery, observation and screenshot', async () => {
    const windowId = 'window-main'
    const f = fixture()
    f.setWindows([windowId])
    const app = await f.api.getApp('Editor')
    expect((await app.getWindows())[0]!.windowId).toBe(windowId)
    const window = await app.getWindow(windowId)
    expectTypeOf(window.windowId).toEqualTypeOf<string>()
    expect(window.windowId).toBe(windowId)
    expect(await window.getScreenshot()).toBe(IMAGE)
    await window.click([10, 20])
    for (const [operation] of f.dispatch.mock.calls) {
      if ('windowId' in operation.params) expect(operation.params.windowId).toBe(windowId)
    }
  })

  it('shares the latest tree read across an application and each selected window', async () => {
    const f = fixture()
    f.setWindows(['23', '24'])
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    expect(await app.getWindows()).toEqual([windowInfo('23'), windowInfo('24')])
    const first = await app.getWindow('23')
    await first.getAccessibilityTree()
    const second = await app.getWindow('24')
    await second.getAccessibilityTree()
    await app.setValue(element('1'), 'First document')
    await first.click(element('2'))
    await second.click(element('3'))
    expect(f.dispatch.mock.calls.slice(-3).map(([operation]) => operation)).toEqual([
      { method: 'setValue', params: { appHandle: 'app-17', snapshotId: 'snapshot-3', elementId: '1', value: 'First document' } },
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-3', elementId: '2', windowId: '23' } },
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-3', elementId: '3', windowId: '24' } },
    ])
    expect(first.windowId).toBe('23')
    expect(second.windowId).toBe('24')
    await expect(second.getAccessibilityTree()).resolves.toBe('Tree 4')
    await second.click(element('3'))
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-4', elementId: '3', windowId: '24' } })
    await app.getAccessibilityTree()
    await first.invoke(element('4'))
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'invoke', params: { appHandle: 'app-17', snapshotId: 'snapshot-5', elementId: '4', windowId: '23' } })
  })

  it('keeps separate snapshots for different application handles', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    f.dispatch.mockResolvedValueOnce({ appHandle: 'app-18', name: 'Utility', running: true })
    f.dispatch.mockResolvedValueOnce(state({ appHandle: 'app-18', snapshotId: 'other', windows: [] }))
    const other = await f.api.getApp('Utility')
    await other.getAccessibilityTree()
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
    await first.getAccessibilityTree()
    const second = await f.api.getApp('Editor')
    const window = await second.getWindow('23')
    await window.getScreenshot()
    await first.setValue(element('1'), 'Preserved')
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'setValue', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-1', elementId: '1', value: 'Preserved',
    } })
    await second.getAccessibilityTree()
    expect(second.appHandle).toBe(first.appHandle)
    await first.setValue(element('1'), 'Shared')
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'setValue', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-2', elementId: '1', value: 'Shared',
    } })
  })

  it('exposes screenshots and pointer input only on explicit windows', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    expect(app).toHaveProperty('getAccessibilityTree')
    for (const method of ['getScreenshot', 'click', 'mouseMove', 'scroll', 'drag']) expect(app).not.toHaveProperty(method)
    const window = await app.getWindow('23')
    await window.getAccessibilityTree()
    for (const method of ['getScreenshot', 'click', 'mouseMove', 'scroll', 'drag']) expect(window).toHaveProperty(method)
    expect(window).not.toHaveProperty('hover')
    expect(window).toHaveProperty('mouseMove')
  })

  it('attaches the shared snapshot to coordinates only within its window scope', async () => {
    const f = fixture()
    f.setWindows(['23', '24'])
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const first = await app.getWindow('23')
    await first.getAccessibilityTree()
    await first.click([10, 20])
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', windowId: '23', snapshotId: 'snapshot-2', x: 10, y: 20, mouseButton: 'left', clickCount: 1,
    } })
    const second = await app.getWindow('24')
    await second.getAccessibilityTree()
    await first.click([10, 20])
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', windowId: '23', x: 10, y: 20, mouseButton: 'left', clickCount: 1,
    } })
    await second.click([10, 20])
    expect(f.dispatch.mock.calls.at(-1)?.[0]).toMatchObject({ params: { snapshotId: 'snapshot-3', windowId: '24' } })
    await app.getAccessibilityTree()
    await first.click([10, 20])
    expect(f.dispatch.mock.calls.at(-1)?.[0]).toMatchObject({ params: { snapshotId: 'snapshot-4', windowId: '23' } })
  })

  it('keeps a validated AXless window usable for screenshots and coordinate input', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const window = await app.getWindow('23')
    f.dispatch.mockResolvedValueOnce(state({ windowId: '23', snapshotId: 'axless', tree: '', elements: [] }))
    await window.getAccessibilityTree()
    await expect(window.getScreenshot()).resolves.toEqual(IMAGE)
    await window.click([10, 20])
    await window.scroll({ x: 10, y: 20, deltaLinesX: 0, deltaLinesY: -1 })
    await window.drag([10, 20], [30, 40])
    expect(f.dispatch.mock.calls.slice(-4).map(([operation]) => operation.method)).toEqual(['screenshot', 'click', 'scroll', 'drag'])
    for (const [operation] of f.dispatch.mock.calls.slice(-3)) {
      expect(operation.params).toMatchObject({ appHandle: 'app-17', windowId: '23', snapshotId: 'axless' })
    }
  })

  it.each(['WINDOW_UNAVAILABLE', 'PERMISSION_DENIED', 'STALE_APP', 'SESSION_LOCKED'])('propagates %s from coordinate input on a selected window without image or input fallback', async (code) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow('23')
    const failure = new Error(code)
    f.dispatch.mockRejectedValueOnce(failure)
    const calls = f.dispatch.mock.calls.length
    await expect(window.click([1, 2])).rejects.toBe(failure)
    expect(f.dispatch.mock.calls.slice(calls).map(([operation]) => operation.method)).toEqual(['click'])
  })

  it('captures and clicks the explicitly selected window among several', async () => {
    const f = fixture()
    const windows = [
      windowInfo('23'),
      { ...windowInfo('24'), title: 'Menu helper', bounds: { ...bounds, width: 0, height: 0 } },
      { ...windowInfo('25'), isOnScreen: false },
      { ...windowInfo('26'), bounds: { ...bounds, height: 0 } },
    ]
    f.setWindowRecords(windows)
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    expect(await app.getWindows()).toEqual(windows)
    const window = await app.getWindow('23')
    await window.getAccessibilityTree()
    await window.getScreenshot()
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'screenshot', params: { appHandle: 'app-17', windowId: '23' } })
    await window.click([10, 20])
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', windowId: '23', snapshotId: 'snapshot-2', x: 10, y: 20, mouseButton: 'left', clickCount: 1,
    } })
    const hidden = await app.getWindow('25')
    await hidden.getAccessibilityTree()
    await hidden.click([10, 20])
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', windowId: '25', snapshotId: 'snapshot-3', x: 10, y: 20, mouseButton: 'left', clickCount: 1,
    } })
  })

  it('captures a window without reading its accessibility tree', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow('23')
    const calls = f.dispatch.mock.calls.length
    await window.getScreenshot()
    expect(f.dispatch).toHaveBeenCalledTimes(calls + 1)
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'screenshot', params: { appHandle: 'app-17', windowId: '23' } })
  })

  const providerIdentities: Record<string, JsonValue>[] = [
    { appHandle: 'another-app' }, { windowId: '24' },
  ]
  it.each(providerIdentities)('rejects provider state from another target and discards the old snapshot: %j', async (identity) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockResolvedValueOnce(state(identity))
    await expect(app.getAccessibilityTree()).rejects.toThrow('belongs to another application or window')
    await expect(app.setValue(element('0'), 'stale')).rejects.toThrow('Read getAccessibilityTree')
  })

  it('returns provider window records without process filtering', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const observed = windowInfo('24')
    f.dispatch.mockResolvedValueOnce(state({ windows: [observed] }))
    await expect(app.getAccessibilityTree()).resolves.toBe('Changed tree')
    f.dispatch.mockResolvedValueOnce([observed])
    await expect(app.getWindows()).resolves.toEqual([observed])
  })

  it('skips app-level accessibility while keeping window observation available', async () => {
    const f = fixture()
    f.setCapabilities({ ...capabilities, appLevelAccessibility: false })
    const app = await f.api.getApp('Editor')
    expect(f.dispatch.mock.calls.map(([call]) => call.method)).toEqual(['getCapabilities', 'getApp'])
    await expect(app.getAccessibilityTree()).rejects.toThrow('Application-level accessibility is not supported on current platform; observe a window instead.')
    await expect(app.listActions(element('0'))).rejects.toThrow('Application-level accessibility is not supported on current platform; observe a window instead.')
    await expect(app.performAction(element('0'), 'AXPress')).rejects.toThrow('Application-level accessibility is not supported on current platform; observe a window instead.')
    await expect(app.invoke(element('0'))).rejects.toThrow('Application-level accessibility is not supported on current platform; observe a window instead.')
    await expect(app.setValue(element('0'), 'value')).rejects.toThrow('Application-level accessibility is not supported on current platform; observe a window instead.')
    await expect(app.selectText(element('0'), 'text')).rejects.toThrow('Application-level accessibility is not supported on current platform; observe a window instead.')
    expect(f.dispatch).toHaveBeenCalledTimes(2)
    f.dispatch.mockClear()
    await expect(app.typeText('keyboard without accessibility')).resolves.toEqual(delivered)
    expect(f.dispatch.mock.calls.map(([operation]) => operation)).toEqual([
      { method: 'typeText', params: { appHandle: 'app-17', text: 'keyboard without accessibility' } },
    ])
    const window = await app.getWindow('23')
    await expect(window.getAccessibilityTree()).resolves.toBe('Tree 1')
    await expect(app.getAccessibilityTree()).rejects.toThrow('Application-level accessibility is not supported on current platform; observe a window instead.')
    await expect(window.invoke(element('0'))).resolves.toEqual(delivered)
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'invoke', params: {
      appHandle: 'app-17', windowId: '23', snapshotId: 'snapshot-1', elementId: '0',
    } })
  })

  it('honors window keyboard support and keeps app keyboard available', async () => {
    const f = fixture()
    f.setCapabilities({ ...capabilities, keyboard: ['app', 'window'] })
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const window = await app.getWindow('23')
    await window.getAccessibilityTree()
    f.dispatch.mockClear()
    await window.typeText('hello')
    await window.paste('<b>bold</b>', { format: 'html' })
    await window.pressKey('a', ['command'])
    await app.typeText('app text')
    await app.paste('app paste')
    await app.pressKey('Tab', ['shift'])
    expect(f.dispatch.mock.calls.map(([operation]) => operation)).toEqual([
      { method: 'typeText', params: { appHandle: 'app-17', windowId: '23', text: 'hello' } },
      { method: 'paste', params: { appHandle: 'app-17', windowId: '23', text: '<b>bold</b>', format: 'html' } },
      { method: 'pressKey', params: { appHandle: 'app-17', windowId: '23', key: 'a', modifiers: ['command'] } },
      { method: 'typeText', params: { appHandle: 'app-17', text: 'app text' } },
      { method: 'paste', params: { appHandle: 'app-17', text: 'app paste' } },
      { method: 'pressKey', params: { appHandle: 'app-17', key: 'Tab', modifiers: ['shift'] } },
    ])
  })

  it('rejects app keyboard when only window scope is supported', async () => {
    const f = fixture()
    f.setCapabilities({ ...capabilities, keyboard: ['window'] })
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const window = await app.getWindow('23')
    await window.getAccessibilityTree()
    f.dispatch.mockClear()
    await expect(app.typeText('app text')).rejects.toThrow('App-scoped keyboard input is not supported on current platform.')
    await expect(app.paste('app text')).rejects.toThrow('App-scoped keyboard input is not supported on current platform.')
    await expect(app.pressKey('Return')).rejects.toThrow('App-scoped keyboard input is not supported on current platform.')
    await expect(app.pressKey('', ['command'])).rejects.toThrow('App-scoped keyboard input is not supported on current platform.')
    expect(f.dispatch).not.toHaveBeenCalled()
    await expect(window.typeText('window text')).resolves.toEqual(delivered)
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'typeText', params: { appHandle: 'app-17', windowId: '23', text: 'window text' } })
  })

  it('accepts coordinate input without a current snapshot', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const window = await app.getWindow('23')
    await window.getAccessibilityTree()
    f.dispatch.mockRejectedValueOnce(new Error('Native app is busy'))
    await expect(window.getAccessibilityTree()).rejects.toThrow('Native app is busy')
    await window.click([10, 20])
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', windowId: '23', x: 10, y: 20, mouseButton: 'left', clickCount: 1,
    } })
  })

  it('keeps marked partial trees usable through the latest snapshot without retrying input', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    await app.pressKey('Return')
    const tree = '- [0] AXButton "Save"\n[One child could not be read.]'
    f.dispatch.mockResolvedValueOnce(state({ tree, hasUnreadableElements: true }))
    await expect(app.getAccessibilityTree()).resolves.toBe(tree)
    await app.invoke(element('0'))
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'invoke', params: {
      appHandle: 'app-17', snapshotId: 'changed', elementId: '0',
    } })
    expect(f.dispatch.mock.calls.filter(([operation]) => operation.method === 'pressKey')).toHaveLength(1)
    expect(f.dispatch.mock.calls.filter(([operation]) => operation.method === 'getState')).toHaveLength(2)
  })

  it.each(['AX_OBSERVATION_UNAVAILABLE', 'PERMISSION_DENIED'])('preserves %s and requires a new read before element operations', async (code) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const window = await app.getWindow('23')
    await window.getAccessibilityTree()
    const failure = new NativeError(code, 'Observation failed')
    f.dispatch.mockRejectedValueOnce(failure)
    await expect(app.getAccessibilityTree()).rejects.toBe(failure)
    await expect(window.setValue(element('0'), 'stale')).rejects.toThrow('Read getAccessibilityTree')
    await window.getAccessibilityTree()
    f.dispatch.mockRejectedValueOnce(failure)
    await expect(window.getAccessibilityTree()).rejects.toBe(failure)
    await expect(app.invoke(element('0'))).rejects.toThrow('Read getAccessibilityTree')
    const calls = f.dispatch.mock.calls.length
    await window.getScreenshot()
    expect(f.dispatch.mock.calls.slice(calls).map(([operation]) => operation.method)).toEqual(['screenshot'])
  })
})

describe('screenshots', () => {
  it('selects windows without a native request and rejects invalid IDs locally', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    expect((await app.getWindow('24')).windowId).toBe('24')
    await expect(app.getWindow('')).rejects.toThrow('getWindow windowId:')
    expect(f.dispatch.mock.calls.map(([request]) => request.method)).toEqual(['getCapabilities', 'getApp'])
  })

  it.each(['APP_ACCESS_REVOKED', 'WINDOW_UNAVAILABLE', 'STALE_APP'])('preserves %s when capturing a previously selected window', async (code) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow('23')
    f.dispatch.mockRejectedValueOnce(new Error(code))
    await expect(window.getScreenshot()).rejects.toThrow(code)
  })

  it.each(['application', 'window'])('captures the first screenshot when %s AX reads fail', async (scope) => {
    const f = fixture()
    const dispatch = f.dispatch.getMockImplementation()!
    const failure = new Error('AX read failed')
    f.dispatch.mockImplementation(async (request) => {
      if (request.method === 'getState' && (scope === 'application' ? request.params.windowId === undefined : request.params.windowId !== undefined)) throw failure
      return dispatch(request)
    })
    const app = await f.api.getApp('Editor')
    expect(await app.getWindows()).toEqual([windowInfo('23')])
    const window = await app.getWindow('23')
    const target = scope === 'application' ? app : window
    await expect(target.getAccessibilityTree()).rejects.toBe(failure)
    await expect(window.getScreenshot()).resolves.toBe(IMAGE)
    await expect(window.invoke(element('0'))).rejects.toThrow('Read getAccessibilityTree')
    await window.click([0, 0])
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', windowId: '23', x: 0, y: 0, mouseButton: 'left', clickCount: 1,
    } })
  })

  it('returns the accessibility text and the stored screenshot Image', async () => {
    const f = fixture()
    f.setWindows(['23', '24'])
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow('24')
    const tree = await window.getAccessibilityTree()
    const image = await window.getScreenshot()
    expect(tree).toBe('Tree 1')
    expect(image).toBe(IMAGE)
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'screenshot', params: { appHandle: 'app-17', windowId: '24' } })
  })

  it.each([null, 'text only', {}, { path: '/image.png', width: 1 }, { path: '/image.png', width: 1, height: 1 }])('rejects an invalid screenshot result %j', async (value) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const window = await app.getWindow('23')
    f.dispatch.mockResolvedValueOnce(value)
    await expect(window.getScreenshot()).rejects.toThrow('must return an Image')
  })

  it.each(['jpeg', 'webp', 'gif'])('retains the Host Image for a %s screenshot', async (format) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow('23')
    const image = Object.freeze({ ...IMAGE, path: '/images/screenshot.' + format, width: 320, height: 240 })
    f.dispatch.mockResolvedValueOnce(image)
    expect(await window.getScreenshot()).toBe(image)
  })

})

describe('input actions', () => {
  it('passes explicit relative mode to every coordinate gesture and rejects it on element ids', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const window = await app.getWindow('23')
    await window.getAccessibilityTree()
    await window.click([500, 250], { relative: true })
    await window.mouseMove([500, 250], { relative: true })
    await window.drag([0, 0], [999, 999], { relative: true })
    await window.scroll({ x: 500, y: 250, relative: true, deltaLinesX: 0, deltaLinesY: -1 })
    expect(f.dispatch.mock.calls.slice(-4).map(([request]) => request.params)).toEqual([
      expect.objectContaining({ x: 500, y: 250, relative: true }),
      expect.objectContaining({ x: 500, y: 250, relative: true }),
      expect.objectContaining({ fromX: 0, toX: 999, relative: true }),
      expect.objectContaining({ x: 500, y: 250, relative: true }),
    ])
    await expect(window.click(element('1'), { relative: true })).rejects.toThrow()
    await expect(window.mouseMove(element('1'), { relative: true })).rejects.toThrow()
  })

  it('keeps the selected window when scroll options include another target identity', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const window = await app.getWindow('23')
    await window.getAccessibilityTree()
    const options = {
      x: 10, y: 20, deltaLinesX: 0, deltaLinesY: 1,
      appHandle: 'another-app', snapshotId: 'another-snapshot', windowId: '24',
    }

    await window.scroll(options)

    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'scroll', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-2', windowId: '23', x: 10, y: 20, deltaLinesX: 0, deltaLinesY: 1,
    } })
  })

  it('dispatches window-point gestures and reports delivery without claiming the action succeeded', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const window = await app.getWindow('23')
    await window.getAccessibilityTree()
    expect(await window.click([10, 20], { mouseButton: 'right' })).toEqual(delivered)
    expect(await window.click([11, 21], { clickCount: 2 })).toEqual(delivered)
    expect(await window.scroll({ x: 10, y: 20, deltaLinesX: -2, deltaLinesY: 3 })).toEqual(delivered)
    expect(await window.drag([1, 2], [30, 40])).toEqual(delivered)
    expect(f.dispatch.mock.calls.slice(-4).map(([operation]) => operation)).toEqual([
      { method: 'click', params: { appHandle: 'app-17', windowId: '23', snapshotId: 'snapshot-2', x: 10, y: 20, mouseButton: 'right', clickCount: 1 } },
      { method: 'click', params: { appHandle: 'app-17', windowId: '23', snapshotId: 'snapshot-2', x: 11, y: 21, mouseButton: 'left', clickCount: 2 } },
      { method: 'scroll', params: { appHandle: 'app-17', windowId: '23', snapshotId: 'snapshot-2', x: 10, y: 20, deltaLinesX: -2, deltaLinesY: 3 } },
      { method: 'drag', params: { appHandle: 'app-17', windowId: '23', snapshotId: 'snapshot-2', fromX: 1, fromY: 2, toX: 30, toY: 40 } },
    ])
  })

  type Surfaces = { app: CuaApp; window: CuaWindow }
  const invalidActions: Array<[string, (surfaces: Surfaces) => Promise<unknown>]> = [
    ['right double click', ({ window }) => window.click([1, 2], { mouseButton: 'right', clickCount: 2 })],
    ['right AX double click', ({ window }) => window.click(element('0'), { mouseButton: 'right', clickCount: 2 })],
    ['empty hover element id', ({ window }) => window.mouseMove(element(''))],
    ['negative hover point', ({ window }) => window.mouseMove([-1, 0])],
    ['nonfinite hover point', ({ window }) => window.mouseMove([NaN, 0])],
    ['empty click element id', ({ window }) => window.click(element(''))],
    ['nonfinite coordinate', ({ window }) => window.click([NaN, 0])],
    ['negative coordinate', ({ window }) => window.click([-1, 0])],
    ['empty value element id', ({ window }) => window.setValue(element(''), 'value')],
    ['zero scroll', ({ window }) => window.scroll({ x: 0, y: 0, deltaLinesX: 0, deltaLinesY: 0 })],
    ['oversized scroll', ({ window }) => window.scroll({ x: 0, y: 0, deltaLinesX: 11, deltaLinesY: 0 })],
    ['fractional scroll', ({ window }) => window.scroll({ x: 0, y: 0, deltaLinesX: 0.5, deltaLinesY: 0 })],
    ['negative drag point', ({ window }) => window.drag([0, 0], [-1, 3])],
    ['empty key', ({ app }) => app.pressKey('')],
  ]
  it.each<[string, (surfaces: Surfaces) => Promise<unknown>]>([
    ['selectText text: Too small: expected string to have >=1 characters', ({ app }) => app.selectText(element('0'), '')],
    ['mouseMove x: Invalid input: expected number, received NaN', ({ window }) => window.mouseMove([NaN, 0])],
    ['mouseMove x: Too big: expected number to be <=999', ({ window }) => window.mouseMove([1000, 0], { relative: true })],
    ['click relative: not accepted for these arguments', ({ window }) => window.click(element('650'), { relative: true })],
  ])('reports a readable validation failure: %s', async (message, run) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const window = await app.getWindow('23')
    await window.getAccessibilityTree()
    f.dispatch.mockClear()
    await expect(run({ app, window })).rejects.toMatchObject({ name: 'Error', message })
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it.each(invalidActions)('rejects %s without invoking native input', async (_label, run) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const window = await app.getWindow('23')
    await window.getAccessibilityTree()
    const calls = f.dispatch.mock.calls.length
    await expect(run({ app, window })).rejects.toThrow()
    expect(f.dispatch).toHaveBeenCalledTimes(calls)
  })

  it.each<[string, string[] | undefined, string[]]>([
    ['+', undefined, []],
    ['plus', [], []],
    ['+', ['command'], ['command']],
    ['Tab', ['shift'], ['shift']],
  ])('forwards literal key %s with modifiers %j without splitting', async (key, modifiers, expected) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    if (modifiers === undefined) await app.pressKey(key)
    else await app.pressKey(key, modifiers)
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'pressKey', params: { appHandle: 'app-17', key, modifiers: expected } })
  })

  it('forwards the literal key unsplit in one RPC without mutating modifiers', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const modifiers: string[] = ['control', 'shift']
    f.dispatch.mockClear()
    await app.pressKey('+', modifiers)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'pressKey', params: {
      appHandle: 'app-17', key: '+', modifiers: ['control', 'shift'],
    } })
    expect(modifiers).toEqual(['control', 'shift'])
  })

  it('forwards arbitrary provider-defined key and modifier names in one RPC', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockClear()
    await app.pressKey('PlatformKey', ['platform-modifier'])
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'pressKey', params: {
      appHandle: 'app-17', key: 'PlatformKey', modifiers: ['platform-modifier'],
    } })
  })

  it('passes literal text and keys to the selected app identity', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    await app.typeText('中文\nline two')
    await app.paste('粘贴\nplain text')
    await app.paste('<b>bold</b>', { format: 'html' })
    await app.pressKey('a', ['control', 'shift'])
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
    await app.getAccessibilityTree()
    const window = await app.getWindow('23')
    await window.getAccessibilityTree()
    f.dispatch.mockClear()
    for (const run of [
      () => window.typeText('hello'),
      () => window.paste('hello'),
      () => window.pressKey('Return'),
      () => window.pressKey('', ['command']),
    ]) {
      await expect(run()).rejects.toThrow('Window-scoped keyboard input is not supported on current platform.')
    }
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it.each<[string, 'down' | 'up']>([
    ['app', 'down'],
    ['app', 'up'],
    ['window', 'down'],
    ['window', 'up'],
  ])('sends one explicit %s-scoped key event (%s) with exactly one RPC', async (scope, direction) => {
    const f = fixture()
    f.setCapabilities({ ...capabilities, keyboard: ['app', 'window'] })
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const surface = scope === 'window' ? await app.getWindow('23') : app
    f.dispatch.mockClear()
    f.dispatch.mockResolvedValueOnce(delivered)
    await expect(surface.sendKeyEvent('Shift', direction)).resolves.toEqual(delivered)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'sendKeyEvent', params: {
      appHandle: 'app-17', ...scope === 'window' ? { windowId: '23' } : {}, key: 'Shift', direction,
    } })
  })

  it('returns an un-dispatched key-event result from one RPC without retrying', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    f.dispatch.mockClear()
    f.dispatch.mockResolvedValueOnce({ dispatched: false })
    await expect(app.sendKeyEvent('Command', 'down')).resolves.toEqual({ dispatched: false })
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'sendKeyEvent', params: {
      appHandle: 'app-17', key: 'Command', direction: 'down',
    } })
  })

  it('rejects key events without keyboard support before validating them', async () => {
    const appFixture = fixture()
    appFixture.setCapabilities({ ...capabilities, keyboard: ['window'] })
    const app = await appFixture.api.getApp('Editor')
    appFixture.dispatch.mockClear()
    await expect(app.sendKeyEvent('', 'down')).rejects.toThrow('App-scoped keyboard input is not supported on current platform.')
    expect(appFixture.dispatch).not.toHaveBeenCalled()

    const windowFixture = fixture()
    windowFixture.setCapabilities({ ...capabilities, keyboard: ['app'] })
    const windowApp = await windowFixture.api.getApp('Editor')
    const window = await windowApp.getWindow('23')
    windowFixture.dispatch.mockClear()
    await expect(window.sendKeyEvent('', 'up')).rejects.toThrow('Window-scoped keyboard input is not supported on current platform.')
    expect(windowFixture.dispatch).not.toHaveBeenCalled()
  })

  it('retains the snapshot identity for element right and double clicks', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const window = await app.getWindow('23')
    await window.getAccessibilityTree()
    await window.click(element('12'), { mouseButton: 'right' })
    await window.click(element('13'), { clickCount: 2 })
    expect(f.dispatch.mock.calls.slice(-2).map(([operation]) => operation)).toEqual([
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-2', elementId: '12', windowId: '23', mouseButton: 'right' } },
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-2', elementId: '13', windowId: '23', clickCount: 2 } },
    ])
  })

  it('dispatches an opaque provider element id unchanged', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const window = await app.getWindow('23')
    await window.getAccessibilityTree()
    await window.click(element('42.12345'))
    await window.mouseMove(element('42.12345'))
    expect(f.dispatch.mock.calls.slice(-2).map(([operation]) => operation)).toEqual([
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-2', elementId: '42.12345', windowId: '23' } },
      { method: 'mouseMove', params: { appHandle: 'app-17', snapshotId: 'snapshot-2', elementId: '42.12345', windowId: '23' } },
    ])
  })

  it('does not activate on selection and dispatches only an explicit activation request', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    expect(f.dispatch.mock.calls.map(([call]) => call.method)).toEqual(['getCapabilities', 'getApp'])
    await app.activate()
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'activate', params: { appHandle: 'app-17' } })
  })

  it('propagates native failures once and rejects malformed delivery claims', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const window = await app.getWindow('23')
    await window.getAccessibilityTree()
    const failure = new Error('Application was restarted; select it again')
    f.dispatch.mockRejectedValueOnce(failure)
    await expect(app.typeText('hello')).rejects.toBe(failure)
    expect(f.dispatch).toHaveBeenCalledTimes(5)
    f.dispatch.mockResolvedValueOnce({ dispatched: 'yes' })
    await expect(window.click(element('0'))).rejects.toThrow()
    expect(f.dispatch).toHaveBeenCalledTimes(6)
  })

  it('rejects invalid selection inputs before dispatch', async () => {
    const f = fixture()
    await expect(f.api.getApp('')).rejects.toThrow()
    expect(f.dispatch).not.toHaveBeenCalled()
    const app = await f.api.getApp('Editor')
    await app.getAccessibilityTree()
    const calls = f.dispatch.mock.calls.length
    await expect(app.getWindow('')).rejects.toThrow()
    expect(f.dispatch).toHaveBeenCalledTimes(calls)
  })
})

it('expands menu contents and details only for the requested observation', async () => {
  const f = fixture()
  const app = await f.api.getApp('Editor')
  await app.getAccessibilityTree({ includeMenus: true, details: true })
  expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'getState', params: { appHandle: selected.appHandle, includeMenus: true, details: true } })
  await app.getAccessibilityTree({ includeMenus: false, details: false })
  expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'getState', params: { appHandle: selected.appHandle, includeMenus: false, details: false } })
})

it('forwards provider options while retaining the selected target and coordinate mode', async () => {
  const f = fixture()
  const win = await (await f.api.getApp('Editor')).getWindow('23')
  await win.getAccessibilityTree()
  const defaultCoordinates: CuaCoordinateOptions = {}
  const elementOptions = { ...defaultCoordinates, trackingMode: 'precise', appHandle: 'another-app', windowId: '99', unused: undefined }
  await win.mouseMove(element('0'), elementOptions)
  expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'mouseMove', params: {
    appHandle: 'app-17', windowId: '23', snapshotId: 'snapshot-1', elementId: '0', trackingMode: 'precise',
  } })
  await win.getScreenshot()
  const pixelOptions = { relative: false, useSystemPointer: true, trackingMode: 'precise', x: 222 }
  await win.mouseMove([30, 40], pixelOptions)
  expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'mouseMove', params: {
    appHandle: 'app-17', snapshotId: 'snapshot-1', windowId: '23', x: 30, y: 40, relative: false, useSystemPointer: true, trackingMode: 'precise',
  } })
  const relativeOptions = { relative: true, trackingMode: 'coarse' }
  await win.mouseMove([250, 750], relativeOptions)
  expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'mouseMove', params: {
    appHandle: 'app-17', snapshotId: 'snapshot-1', windowId: '23', x: 250, y: 750, relative: true, trackingMode: 'coarse',
  } })
})

it('keeps ordinary Windows drags portable and rejects explicit system-pointer options before dispatch', async () => {
  const f = fixture()
  f.setCapabilities({ ...capabilities, platform: 'windows', systemPointer: false, appLevelAccessibility: false, keyboard: ['window'] })
  const win = await (await f.api.getApp('Editor')).getWindow('23')
  await win.getAccessibilityTree()
  f.dispatch.mockClear()
  for (const useSystemPointer of [true, false]) {
    await expect(win.drag([10, 20], [30, 40], { useSystemPointer })).rejects.toThrow('drag useSystemPointer: not accepted')
  }
  expect(f.dispatch).not.toHaveBeenCalled()
  await win.drag([10, 20], [30, 40], { mouseButton: 'right', modifiers: ['win'] })
  expect(f.dispatch.mock.calls).toEqual([[{ method: 'drag', params: {
    appHandle: 'app-17', windowId: '23', snapshotId: 'snapshot-1', fromX: 10, fromY: 20, toX: 30, toY: 40,
    mouseButton: 'right', modifiers: ['win'],
  } }]])
})

it('forwards bounded traversal limits on a window-only provider', async () => {
  const f = fixture()
  f.setCapabilities({ ...capabilities, platform: 'windows', appLevelAccessibility: false })
  const app = await f.api.getApp('Editor')
  const win = await app.getWindow('23')
  const before = f.dispatch.mock.calls.length
  await expect(win.getAccessibilityTree({ maxDepth: 0 })).rejects.toThrow('maxDepth')
  await expect(win.getAccessibilityTree({ maxElements: 1.5 })).rejects.toThrow('maxElements')
  expect(f.dispatch).toHaveBeenCalledTimes(before)
  await win.getAccessibilityTree({ maxDepth: 1, maxElements: 1 })
  expect(f.dispatch).toHaveBeenLastCalledWith({
    method: 'getState', params: { appHandle: app.appHandle, windowId: '23', maxDepth: 1, maxElements: 1 },
  })
})
