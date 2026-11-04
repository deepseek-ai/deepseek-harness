/** Object facade over logged native operations; its caller owns evaluator persistence. */
import { Buffer } from 'node:buffer'
import type { z } from 'zod'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ActionNamesResult, ActionResult, AppResult, AppsResult, CapabilitiesResult, FoundAppsResult, HoverResult, Request, ScreenshotResult, ShowResult, StateResult, WindowsResult } from './protocol.ts'
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

/** Parse a portable key chord.
 * @param chord Key or chord.
 * @returns Native key and modifier names.
 */
export function keyChord(chord: string): { key: string; modifiers: string[] } {
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

function validatedCall(dispatch: CuaDispatch) {
  return (method: CuaOperation['method'], params: Record<string, JsonValue>) => {
    const request = Request.safeParse({ method, params })
    if (!request.success) throw new Error(`${method} ${requestIssueMessage(request.error.issues)}`)
    return dispatch(request.data)
  }
}

async function unsupportedKeyboardInput(): Promise<never> {
  throw new Error('Keyboard input is not supported at this scope.')
}

async function emit(sink: CuaObservationSink | undefined, value: object, options?: CuaObservationOptions): Promise<void> {
  if (options?.emit !== false) await sink?.text(JSON.stringify(value))
}

/**
 * Create app/window objects using the caller's authorized dispatcher.
 * @param dispatch - Current tool authority; rejects propagate without retries.
 * @param sink - Optional text/image output; emit false suppresses this sink only.
 * @returns Objects independent of variable storage and evaluator lifecycle.
 */
export function createCuaApi(dispatch: CuaDispatch, sink?: CuaObservationSink): CuaApi {
  const call = validatedCall(dispatch)
  const objects = createCuaObjects(dispatch, sink)

  const api: CuaApi = {
    async getCapabilities(options) {
      const result = CapabilitiesResult.parse(await call('getCapabilities', {}))
      await emit(sink, result, options)
      return result
    },
    async listApps(options) {
      const result = AppsResult.parse(await call('listApps', {})).map(app => ({
        id: app.bundleId || String(app.pid), displayName: app.name, isRunning: true as const, pid: app.pid,
      }))
      await emit(sink, result, options)
      return result
    },
    async findApps(query, options) {
      const result = FoundAppsResult.parse(await call('findApps', { query }))
      await emit(sink, result, options)
      return result
    },
    async getState(options) {
      const result = { apps: await api.listApps({ emit: false }), browsers: [] as [] }
      await emit(sink, result, options)
      return result
    },
    async getApp(selector) {
      const { appHandle } = AppResult.parse(await call('getApp', { selector }))
      const app = objects.createApp(appHandle)
      await app.getAccessibilityTree({ emit: false })
      return app
    },
  }
  return api
}

function createCuaObjects(dispatch: CuaDispatch, sink: CuaObservationSink | undefined): {
  createApp(appHandle: CuaAppHandle): CuaApp
  createWindow(appHandle: CuaAppHandle, windowId: number): CuaWindow
} {
  const call = validatedCall(dispatch)
  const action = async (method: CuaOperation['method'], params: Record<string, JsonValue>) => ActionResult.parse(await call(method, params))
  const observed = new Map<CuaAppHandle, { snapshotId: string; windowId: number | undefined }>()
  function elementParams(appHandle: CuaAppHandle): Record<string, JsonValue> {
    const current = observed.get(appHandle)
    if (current === undefined) throw new Error('Read getAccessibilityTree before using this surface')
    return { appHandle, snapshotId: current.snapshotId }
  }
  function coordinateParams(appHandle: CuaAppHandle, windowId: number): Record<string, JsonValue> {
    const current = observed.get(appHandle)
    return {
      appHandle, windowId,
      ...current !== undefined && (current.windowId === undefined || current.windowId === windowId)
        ? { snapshotId: current.snapshotId } : {},
    }
  }
  function createSurface(appHandle: CuaAppHandle, selectedWindow?: number): CuaSurface {
    return {
      async show() {
        return ShowResult.parse(await call('show', { appHandle,
          ...selectedWindow === undefined ? {} : { windowId: selectedWindow },
        }))
      },
      async getAccessibilityTree(options) {
        observed.delete(appHandle)
        const state = StateResult.parse(await call('getState', { appHandle,
          ...selectedWindow === undefined ? {} : { windowId: selectedWindow },
          ...options?.includeMenus === undefined ? {} : { includeMenus: options.includeMenus },
          ...options?.details === undefined ? {} : { details: options.details },
        }))
        observed.set(appHandle, { snapshotId: state.snapshotId, windowId: selectedWindow })
        if (options?.emit !== false) await sink?.text(state.tree)
        return state.tree
      },
      async listActions(elementId) {
        return ActionNamesResult.parse(await call('listActions', { ...elementParams(appHandle), elementId }))
      },
      async performAction(elementId, name, argument) {
        return action('performAction', { ...elementParams(appHandle), elementId, action: name,
          ...argument === undefined ? {} : { argument },
        })
      },
      async invoke(elementId) {
        return ActionResult.parse(await call('invoke', { ...elementParams(appHandle), elementId }))
      },
      async setValue(elementId, value) { return action('setValue', { ...elementParams(appHandle), elementId, value }) },
      async selectText(elementId, text, options) {
        return action('selectText', { ...elementParams(appHandle), elementId, text,
          ...options?.prefix === undefined ? {} : { prefix: options.prefix },
          ...options?.suffix === undefined ? {} : { suffix: options.suffix },
          ...options?.selectionType === undefined ? {} : { selectionType: options.selectionType },
        })
      },
      typeText: unsupportedKeyboardInput,
      paste: unsupportedKeyboardInput,
      pressKey: unsupportedKeyboardInput,
    }
  }
  function createWindow(appHandle: CuaAppHandle, windowId: number): CuaWindow {
    return {
      ...createSurface(appHandle, windowId), windowId,
      async getScreenshot(options) {
        const image = ScreenshotResult.parse(await call('screenshot', { appHandle, windowId }))
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
      async hover(target, options) {
        const relative = options?.relative === undefined ? {} : { relative: options.relative }
        if (typeof target === 'string') return HoverResult.parse(await call('hover', { ...elementParams(appHandle), elementId: target, ...relative }))
        const [x, y] = target
        return HoverResult.parse(await call('hover', { ...coordinateParams(appHandle, windowId), x, y, ...relative }))
      },
      async click(target, options) {
        const mouseButton = options?.mouseButton ?? 'left'
        const clickCount = options?.clickCount ?? 1
        if (mouseButton !== 'left' && clickCount !== 1) throw new Error('Only left double-click is supported')
        const modifiers = options?.modifiers === undefined ? {} : { modifiers: [...options.modifiers] }
        const hold = options?.holdMs === undefined ? {} : { holdMs: options.holdMs }
        const relative = options?.relative === undefined ? {} : { relative: options.relative }
        if (typeof target === 'string') {
          return action('click', { ...elementParams(appHandle), ...modifiers, ...hold, ...relative, elementId: target,
            ...mouseButton === 'left' ? {} : { mouseButton }, ...clickCount === 1 ? {} : { clickCount },
          })
        }
        const [x, y] = target
        return action('click', { ...coordinateParams(appHandle, windowId), x, y, mouseButton, clickCount, ...modifiers, ...hold, ...relative })
      },
      async scroll(options) {
        if (options.deltaLinesX === 0 && options.deltaLinesY === 0) throw new Error('At least one scroll delta must be nonzero')
        return action('scroll', {
          ...coordinateParams(appHandle, windowId),
          x: options.x, y: options.y, deltaLinesX: options.deltaLinesX, deltaLinesY: options.deltaLinesY,
          ...options.relative === undefined ? {} : { relative: options.relative },
        })
      },
      async drag(from, to, options) {
        return action('drag', { ...coordinateParams(appHandle, windowId),
          fromX: from[0], fromY: from[1], toX: to[0], toY: to[1],
          ...options?.relative === undefined ? {} : { relative: options.relative },
          ...options?.mouseButton === undefined ? {} : { mouseButton: options.mouseButton },
          ...options?.modifiers === undefined ? {} : { modifiers: [...options.modifiers] },
        })
      },
    }
  }
  function createApp(appHandle: CuaAppHandle): CuaApp {
    return {
      ...createSurface(appHandle), appHandle,
      async activate() { return action('activate', { appHandle }) },
      async getWindows(options) {
        const windows = WindowsResult.parse(await call('listWindows', { appHandle }))
        await emit(sink, windows, options)
        return windows
      },
      async getWindow(windowId): Promise<CuaWindow> {
        const window = createWindow(appHandle, windowId)
        await window.getAccessibilityTree({ emit: false })
        return window
      },
      async typeText(text) { return action('typeText', { appHandle, text }) },
      async paste(text, options) { return action('paste', { appHandle, text,
        ...options?.format === undefined ? {} : { format: options.format },
      }) },
      async pressKey(key) { return action('pressKey', { appHandle, ...keyChord(key) }) },
    }
  }
  return { createApp, createWindow }
}
