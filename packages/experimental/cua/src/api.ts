/** Object facade over logged native operations; its caller owns evaluator persistence. */
import { Buffer } from 'node:buffer'
import type { z } from 'zod'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ActionResult, AppResult, AppsResult, CapabilitiesResult, FoundAppsResult, HoverResult, Request, ScreenshotResult, ShowResult, StateResult, WindowsResult } from './protocol.ts'
import type { CuaApi, CuaApp, CuaAppHandle, CuaDispatch, CuaObservationOptions, CuaObservationSink, CuaOperation, CuaScreenshot, CuaSurface, CuaWindow } from './types.ts'
export type * from './types.ts'

function requestIssueMessage(issues: readonly z.core.$ZodIssue[], parent: readonly PropertyKey[] = []): string {
  return [...new Set(issues.map((issue) => {
    const path = [...parent, ...issue.path]
    if (issue.code === 'invalid_union') {
      const fewest = Math.min(...issue.errors.map(branch => branch.length))
      return [...new Set(issue.errors.filter(branch => branch.length === fewest)
        .map(branch => requestIssueMessage(branch, path)))].join(' or ')
    }
    // The facade supplies the method and wrapper; failures belong to params.
    const fields = path.slice(1)
    if (issue.code === 'unrecognized_keys') {
      return `${issue.keys.map(key => [...fields, key].join('.')).join(', ')}: not accepted for these arguments`
    }
    return `${fields.join('.')}: ${issue.message}`
  }))].join('; ')
}

function keyChord(chord: string): { key: string; modifiers: string[] } {
  const parts = chord.split('+')
  let key = parts.pop()
  if (key === '' && parts.at(-1) === '') {
    key = '+'
    parts.pop()
  }
  if (!key) throw new Error('A key chord must end with a key name')
  const names: Record<string, string> = {
    cmd: 'command', command: 'command', super: 'command', Super_L: 'command', Super_R: 'command',
    ctrl: 'control', control: 'control', Control_L: 'control', Control_R: 'control',
    alt: 'option', option: 'option', Alt_L: 'option', Alt_R: 'option',
    shift: 'shift', Shift_L: 'shift', Shift_R: 'shift', fn: 'fn',
  }
  return { key, modifiers: parts.map((part) => {
    const modifier = names[part]
    if (modifier === undefined) throw new Error(`Unsupported key modifier: ${part}`)
    return modifier
  }) }
}

/**
 * Create app/window objects using the caller's authorized dispatcher.
 * @param dispatch - Current tool authority; rejects propagate without retries.
 * @param sink - Optional text/image output; emit false suppresses this sink only.
 * @returns Objects independent of variable storage and evaluator lifecycle.
 */
export function createCuaApi(dispatch: CuaDispatch, sink?: CuaObservationSink): CuaApi {
  const call = (method: CuaOperation['method'], params: Record<string, JsonValue>) => {
    const request = Request.safeParse({ method, params })
    if (!request.success) throw new Error(`${method} ${requestIssueMessage(request.error.issues)}`)
    return dispatch(request.data)
  }
  const action = async (method: CuaOperation['method'], params: Record<string, JsonValue>) => ActionResult.parse(await call(method, params))
  async function emit(value: object, options?: CuaObservationOptions): Promise<void> {
    if (options?.emit !== false) await sink?.text(JSON.stringify(value))
  }

  function surface(appHandle: CuaAppHandle, pid: number, selectedWindow?: number): CuaSurface {
    let observed: ReturnType<typeof StateResult.parse> | undefined
    function snapshotParams(): Record<string, JsonValue> {
      if (!observed) throw new Error('Read getAXState before using this surface')
      return { appHandle, snapshotId: observed.snapshotId }
    }
    function windowId(): number {
      if (selectedWindow !== undefined) return selectedWindow
      const windows = observed?.windows.filter(window => window.isOnScreen && window.bounds.width > 0 && window.bounds.height > 0)
      const focused = windows?.find(window => window.windowId === observed?.focusedWindowId)
      if (focused) return focused.windowId
      const first = windows?.[0]
      if (!first || windows.length !== 1) throw new Error('Select a window with app.getWindows() and app.getWindow(windowId) before this operation')
      return first.windowId
    }
    const result: CuaSurface = {
      async show() {
        return ShowResult.parse(await call('show', { appHandle,
          ...selectedWindow === undefined ? {} : { windowId: selectedWindow },
        }))
      },
      async getAXState(options) {
        observed = undefined
        const state = StateResult.parse(await call('getState', { appHandle,
          ...selectedWindow === undefined ? {} : { windowId: selectedWindow },
          ...options?.includeMenus === undefined ? {} : { includeMenus: options.includeMenus },
          ...options?.details === undefined ? {} : { details: options.details },
        }))
        if (state.appHandle !== appHandle || state.pid !== pid || state.windowId !== (selectedWindow ?? null)) {
          throw new Error('Native observation belongs to another application or window')
        }
        if (state.windows.some(window => window.pid !== pid)) throw new Error('Native windows belong to another application')
        observed = state
        if (options?.emit !== false) await sink?.text(state.tree)
        return state.tree
      },
      async getScreenshot(options) {
        if (!observed) await result.getAXState({ emit: false })
        const target = windowId()
        const image = ScreenshotResult.parse(await call('screenshot', { appHandle, windowId: target }))
        if (image.windowId !== target) throw new Error('Native screenshot belongs to another window')
        const screenshot: CuaScreenshot = {
          bytes: Uint8Array.from(Buffer.from(image.data, 'base64')),
          mimeType: image.mimeType,
          pixelWidth: image.pixelWidth,
          pixelHeight: image.pixelHeight,
          windowId: image.windowId,
        }
        if (options?.emit !== false) await sink?.image(screenshot)
        return screenshot
      },
      async getAXStateAndScreenshot(options) {
        const state = await result.getAXState(options)
        return { state, screenshot: await result.getScreenshot(options) }
      },
      async hover(target, options) {
        const relative = options?.relative === undefined ? {} : { relative: options.relative }
        if (typeof target === 'number') return HoverResult.parse(await call('hover', { ...snapshotParams(), elementIndex: target, ...relative }))
        const [x, y] = target
        return HoverResult.parse(await call('hover', { ...snapshotParams(), windowId: windowId(), x, y, ...relative }))
      },
      async click(target, options) {
        const mouseButton = options?.mouseButton ?? 'left'
        const clickCount = options?.clickCount ?? 1
        if (mouseButton !== 'left' && clickCount !== 1) throw new Error('Only left double-click is supported')
        const modifiers = options?.modifiers === undefined ? {} : { modifiers: [...options.modifiers] }
        const relative = options?.relative === undefined ? {} : { relative: options.relative }
        if (typeof target === 'number') {
          return action('click', { ...snapshotParams(), ...modifiers, ...relative, elementIndex: target,
            ...mouseButton === 'left' ? {} : { mouseButton }, ...clickCount === 1 ? {} : { clickCount },
          })
        }
        const [x, y] = target
        return action('click', { ...snapshotParams(), windowId: windowId(), x, y, mouseButton, clickCount, ...modifiers, ...relative })
      },
      async setValue(index, value) { return action('setValue', { ...snapshotParams(), elementIndex: index, value }) },
      async selectText(index, text, options) {
        return action('selectText', { ...snapshotParams(), elementIndex: index, text,
          ...options?.prefix === undefined ? {} : { prefix: options.prefix },
          ...options?.suffix === undefined ? {} : { suffix: options.suffix },
          ...options?.selectionType === undefined ? {} : { selectionType: options.selectionType },
        })
      },
      async performSecondaryAction(index, name) { return action('performSecondaryAction', { ...snapshotParams(), elementIndex: index, action: name }) },
      async scroll(options) {
        if (options.deltaLinesX === 0 && options.deltaLinesY === 0) throw new Error('At least one scroll delta must be nonzero')
        return action('scroll', {
          ...snapshotParams(), windowId: windowId(),
          x: options.x, y: options.y, deltaLinesX: options.deltaLinesX, deltaLinesY: options.deltaLinesY,
          ...options.relative === undefined ? {} : { relative: options.relative },
        })
      },
      async drag(from, to, options) {
        return action('drag', { ...snapshotParams(), windowId: windowId(), fromX: from[0], fromY: from[1], toX: to[0], toY: to[1],
          ...options?.relative === undefined ? {} : { relative: options.relative },
          ...options?.mouseButton === undefined ? {} : { mouseButton: options.mouseButton },
          ...options?.modifiers === undefined ? {} : { modifiers: [...options.modifiers] },
        })
      },
    }
    return result
  }

  const api: CuaApi = {
    async getCapabilities(options) {
      const result = CapabilitiesResult.parse(await call('getCapabilities', {}))
      await emit(result, options)
      return result
    },
    async listApps(options) {
      const result = AppsResult.parse(await call('listApps', {})).map(app => ({
        id: app.bundleId || String(app.pid), displayName: app.name, isRunning: true as const, pid: app.pid,
      }))
      await emit(result, options)
      return result
    },
    async findApps(query, options) {
      const result = FoundAppsResult.parse(await call('findApps', { query }))
      await emit(result, options)
      return result
    },
    async getState(options) {
      const result = { apps: await api.listApps({ emit: false }), browsers: [] as [] }
      await emit(result, options)
      return result
    },
    async getApp(selector) {
      const { appHandle, pid } = AppResult.parse(await call('getApp', { selector }))
      const app: CuaApp = {
        ...surface(appHandle, pid), pid, appHandle,
        async activate() { return action('activate', { appHandle }) },
        async getWindows(options) {
          const windows = WindowsResult.parse(await call('listWindows', { appHandle }))
          if (windows.some(window => window.pid !== pid)) throw new Error('Native windows belong to another application')
          await emit(windows, options)
          return windows
        },
        async getWindow(windowId): Promise<CuaWindow> {
          const window = { ...surface(appHandle, pid, windowId), windowId }
          await window.getAXState()
          return window
        },
        async typeText(text) { return action('typeText', { appHandle, text }) },
        async paste(text, options) { return action('paste', { appHandle, text,
          ...options?.format === undefined ? {} : { format: options.format },
        }) },
        async pressKey(key) { return action('pressKey', { appHandle, ...keyChord(key) }) },
      }
      await app.getAXState()
      return app
    },
  }
  return api
}
