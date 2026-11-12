/** Object facade over logged native operations; its caller owns evaluator persistence. */
import type { z } from 'zod'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ActionNamesResult, ActionResult, AppResult, AppsResult, CapabilitiesResult, FoundAppsResult, HoverResult, MouseMoveTargets, Request, ShowResult, StateResult, WindowsResult } from './protocol.ts'
import type { CuaApi, CuaApp, CuaAppHandle, CuaCapabilities, CuaDispatch, CuaOperation, CuaProgramImage, CuaSurface, CuaWindow } from './types.ts'
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

function validatedCall(dispatch: CuaDispatch) {
  return (method: CuaOperation['method'], params: Record<string, JsonValue>, options?: object) => {
    const request = Request.safeParse({ method, params })
    if (!request.success) throw new Error(`${method} ${requestIssueMessage(request.error.issues)}`)
    if (options) {
      // The facade owns the target and coordinates. The Host validates additional options against its provider schema.
      const extra = Object.entries(options).filter(([key, value]) =>
        value !== undefined && !MouseMoveTargets.some(target => Object.hasOwn(target.shape, key)))
      Object.assign(request.data.params, Object.fromEntries(extra))
    }
    return dispatch(request.data)
  }
}

/**
 * Create app/window objects using the caller's authorized program dispatcher.
 * @param dispatch - Current tool authority; screenshots resolve to program Images and rejections propagate without retries.
 * @returns Objects independent of variable storage and evaluator lifecycle.
 */
export function createCuaApi(dispatch: CuaDispatch): CuaApi {
  const call = validatedCall(dispatch)
  let capabilities: CuaCapabilities | undefined
  const objects = createCuaObjects(call)

  const api: CuaApi = {
    async getCapabilities() {
      capabilities = CapabilitiesResult.parse(await call('getCapabilities', {}))
      return capabilities
    },
    async listApps() {
      return AppsResult.parse(await call('listApps', {})).map(({ id, name, bundleId, ...state }) => {
        const selector = id ?? (bundleId || (state.isRunning && state.pid !== undefined ? String(state.pid) : name))
        return { id: selector, displayName: name, ...state }
      })
    },
    async findApps(query) {
      return FoundAppsResult.parse(await call('findApps', { query }))
    },
    async getState() {
      return { apps: await api.listApps(), browsers: [] }
    },
    async getApp(selector) {
      const request = Request.safeParse({ method: 'getApp', params: { selector } })
      if (!request.success) throw new Error(`getApp ${requestIssueMessage(request.error.issues)}`)
      const current = capabilities ?? await api.getCapabilities()
      const { appHandle } = AppResult.parse(await call('getApp', { selector }))
      return objects.createCuaApp(appHandle, current)
    },
  }
  return api
}

type CuaScopeParams = (params: Record<string, JsonValue>) => Record<string, JsonValue>

function createCuaObjects(call: ReturnType<typeof validatedCall>): {
  createCuaApp(appHandle: CuaAppHandle, capabilities: CuaCapabilities): CuaApp
} {
  const observed = new Map<CuaAppHandle, { snapshotId: string; windowId: string | undefined }>()
  function currentSnapshot(appHandle: CuaAppHandle): string {
    const current = observed.get(appHandle)
    if (current === undefined) throw new Error('Read getAccessibilityTree before using this surface')
    return current.snapshotId
  }
  function coordinateParams(appHandle: CuaAppHandle, windowId: string): Record<string, JsonValue> {
    const current = observed.get(appHandle)
    return current !== undefined && (current.windowId === undefined || current.windowId === windowId)
      ? { snapshotId: current.snapshotId } : {}
  }
  function createCuaSurface(
    target: { appHandle: CuaAppHandle; windowId?: string },
    paramsFor: CuaScopeParams,
    requireAccessibility: () => void,
    requireKeyboard: () => void,
  ) {
    const scopedCall = (method: CuaOperation['method'], params: Record<string, JsonValue>, options?: object) =>
      call(method, paramsFor(params), options)
    const action = async (method: CuaOperation['method'], params: Record<string, JsonValue>) =>
      ActionResult.parse(await scopedCall(method, params))
    const elementParams = (): Record<string, JsonValue> => ({ snapshotId: currentSnapshot(target.appHandle) })
    const surface: CuaSurface = {
      async show() { return ShowResult.parse(await scopedCall('show', {})) },
      async getAccessibilityTree(options) {
        requireAccessibility()
        observed.delete(target.appHandle)
        const state = StateResult.parse(await scopedCall('getState', {
          ...options?.maxElements === undefined ? {} : { maxElements: options.maxElements },
          ...options?.maxDepth === undefined ? {} : { maxDepth: options.maxDepth },
          ...options?.includeMenus === undefined ? {} : { includeMenus: options.includeMenus },
          ...options?.details === undefined ? {} : { details: options.details },
        }))
        if (state.appHandle !== target.appHandle || state.windowId !== (target.windowId ?? null)) {
          throw new Error('Native observation belongs to another application or window')
        }
        observed.set(target.appHandle, { snapshotId: state.snapshotId, windowId: target.windowId })
        return state.tree
      },
      async listActions(elementId) {
        requireAccessibility()
        return ActionNamesResult.parse(await scopedCall('listActions', { ...elementParams(), elementId }))
      },
      async performAction(elementId, name, argument) {
        requireAccessibility()
        return action('performAction', { ...elementParams(), elementId, action: name,
          ...argument === undefined ? {} : { argument },
        })
      },
      async invoke(elementId) {
        requireAccessibility()
        return action('invoke', { ...elementParams(), elementId })
      },
      async setValue(elementId, value) {
        requireAccessibility()
        return action('setValue', { ...elementParams(), elementId, value })
      },
      async selectText(elementId, text, options) {
        requireAccessibility()
        return action('selectText', { ...elementParams(), elementId, text,
          ...options?.prefix === undefined ? {} : { prefix: options.prefix },
          ...options?.suffix === undefined ? {} : { suffix: options.suffix },
          ...options?.selectionType === undefined ? {} : { selectionType: options.selectionType },
        })
      },
      async typeText(text) {
        requireKeyboard()
        return action('typeText', { text })
      },
      async paste(text, options) {
        requireKeyboard()
        return action('paste', { text,
          ...options?.format === undefined ? {} : { format: options.format },
        })
      },
      async pressKey(key, modifiers = []) {
        requireKeyboard()
        return action('pressKey', { key, modifiers: [...modifiers] })
      },
      async sendKeyEvent(key, direction) {
        requireKeyboard()
        return action('sendKeyEvent', { key, direction })
      },
    }
    return { surface, call: scopedCall, action, elementParams }
  }
  function createCuaWindow(appHandle: CuaAppHandle, windowId: string, capabilities: CuaCapabilities): CuaWindow {
    const base = createCuaSurface({ appHandle, windowId },
      params => ({ ...params, appHandle, windowId }), () => undefined, () => {
        if (!capabilities.keyboard.includes('window')) {
          throw new Error('Window-scoped keyboard input is not supported on current platform.')
        }
      })
    return {
      ...base.surface, windowId,
      async getScreenshot() {
        const value = await base.call('screenshot', {})
        if (value === null || typeof value !== 'object' || Array.isArray(value)
          || typeof value.attachmentId !== 'string'
          || typeof value.path !== 'string' || typeof value.width !== 'number' || typeof value.height !== 'number') {
          throw new Error('The CUA program binding must return an Image for screenshots')
        }
        return value as CuaProgramImage
      },
      async mouseMove(targetPoint, options) {
        const relative = options?.relative === undefined ? {} : { relative: options.relative }
        if (typeof targetPoint === 'string') {
          return HoverResult.parse(await base.call('mouseMove', { ...base.elementParams(), elementId: targetPoint, ...relative }, options))
        }
        const [x, y] = targetPoint
        return HoverResult.parse(await base.call('mouseMove', { ...coordinateParams(appHandle, windowId), x, y, ...relative }, options))
      },
      async click(targetPoint, options) {
        const mouseButton = options?.mouseButton ?? 'left'
        const clickCount = options?.clickCount ?? 1
        if (mouseButton !== 'left' && clickCount !== 1) throw new Error('Only left double-click is supported')
        const modifiers = options?.modifiers === undefined ? {} : { modifiers: [...options.modifiers] }
        const hold = options?.holdMs === undefined ? {} : { holdMs: options.holdMs }
        const relative = options?.relative === undefined ? {} : { relative: options.relative }
        if (typeof targetPoint === 'string') {
          return base.action('click', { ...base.elementParams(), ...modifiers, ...hold, ...relative, elementId: targetPoint,
            ...mouseButton === 'left' ? {} : { mouseButton }, ...clickCount === 1 ? {} : { clickCount },
          })
        }
        const [x, y] = targetPoint
        return base.action('click', { ...coordinateParams(appHandle, windowId), x, y, mouseButton, clickCount, ...modifiers, ...hold, ...relative })
      },
      async scroll(options) {
        if (options.deltaLinesX === 0 && options.deltaLinesY === 0) throw new Error('At least one scroll delta must be nonzero')
        return base.action('scroll', {
          ...coordinateParams(appHandle, windowId),
          x: options.x, y: options.y, deltaLinesX: options.deltaLinesX, deltaLinesY: options.deltaLinesY,
          ...options.relative === undefined ? {} : { relative: options.relative },
        })
      },
      async drag(from, to, options) {
        return base.action('drag', { ...coordinateParams(appHandle, windowId),
          fromX: from[0], fromY: from[1], toX: to[0], toY: to[1],
          ...options?.relative === undefined ? {} : { relative: options.relative },
          ...options?.mouseButton === undefined ? {} : { mouseButton: options.mouseButton },
          ...options?.modifiers === undefined ? {} : { modifiers: [...options.modifiers] },
        })
      },
    }
  }
  function createCuaApp(appHandle: CuaAppHandle, capabilities: CuaCapabilities): CuaApp {
    const base = createCuaSurface({ appHandle }, params => ({ ...params, appHandle }), () => {
      if (!capabilities.appLevelAccessibility) {
        throw new Error('Application-level accessibility is not supported on current platform; observe a window instead.')
      }
    }, () => {
      if (!capabilities.keyboard.includes('app')) {
        throw new Error('App-scoped keyboard input is not supported on current platform.')
      }
    })
    return {
      ...base.surface, appHandle,
      async activate() { return base.action('activate', {}) },
      async getWindows() {
        return WindowsResult.parse(await base.call('listWindows', {}))
      },
      getWindow(windowId): Promise<CuaWindow> {
        const result = WindowsResult.element.shape.windowId.safeParse(windowId)
        if (!result.success) return Promise.reject(new Error(`getWindow ${requestIssueMessage(result.error.issues, ['params', 'windowId'])}`))
        return Promise.resolve(createCuaWindow(appHandle, result.data, capabilities))
      },
    }
  }
  return { createCuaApp }
}
