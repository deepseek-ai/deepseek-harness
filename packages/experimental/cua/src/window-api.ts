/** Window facade using the same observed surface operations as the application facade. */
import { z } from 'zod'
import { createCuaObjects, keyChord } from './api.ts'
import { ActionResult, CapabilitiesResult } from './protocol.ts'
import { LaunchEntriesResult, LaunchResult, SelectedWindowsResult, WindowDiscoveryResult, WindowRequest } from './window-protocol.ts'
import type { CuaAppHandle, CuaObservationOptions, CuaObservationSink } from './types.ts'
import type { CuaWindowApi, CuaWindowDispatch, CuaWindowHandle, CuaDesktopWindow } from './window-types.ts'

/** Create a window-only API.
 * @param dispatch Logged and authorized window dispatcher.
 * @param sink Optional text and image output.
 * @returns Window discovery, launch and explicitly scoped operations.
 */
export function createCuaWindowApi(dispatch: CuaWindowDispatch, sink?: CuaObservationSink): CuaWindowApi {
  const call = (method: string, params: object) => dispatch(WindowRequest.parse({ method, params }))
  async function emit(value: object, options?: CuaObservationOptions) {
    if (options?.emit !== false) await sink?.text(JSON.stringify(value))
  }
  return {
    async getCapabilities(options) {
      const result = CapabilitiesResult.parse(await call('getCapabilities', {}))
      await emit(result, options)
      return result
    },
    async listWindows(options) {
      const result = WindowDiscoveryResult.parse(await call('listWindows', {}))
      await emit(result, options)
      return result
    },
    async findApps(query, options) {
      const result = LaunchEntriesResult.parse(await call('findApps', { query }))
      await emit(result, options)
      return result
    },
    async launch(target) { return LaunchResult.parse(await call('launch', { target })) },
    async getWindows(ids) {
      const selected = SelectedWindowsResult.parse(await call('getWindows', { ids: [...ids] }))
      if (selected.length !== ids.length || selected.some((window, index) => window.windowId !== ids[index])) {
        throw new Error('Native selection does not match the requested windows')
      }
      const windows: CuaDesktopWindow[] = []
      for (const selectedWindow of selected) {
        const { windowId, pid } = selectedWindow
        const windowHandle = selectedWindow.windowHandle as CuaWindowHandle
        const appHandle = selectedWindow.windowHandle as CuaAppHandle
        const window: CuaDesktopWindow = {
          ...createCuaObjects(async (operation) => {
            const params = z.record(z.string(), z.json()).parse(operation.params)
            delete params.appHandle
            delete params.windowId
            const result = await call(operation.method, { ...params, windowHandle })
            if (operation.method !== 'getState') return result
            const state = z.record(z.string(), z.json()).parse(result)
            return { ...state, appHandle }
          }, sink).createWindow(appHandle, pid, windowId),
          windowHandle,
          async activate() { return ActionResult.parse(await call('activate', { windowHandle })) },
          async typeText(text) { return ActionResult.parse(await call('typeText', { windowHandle, text })) },
          async paste(text, options) { return ActionResult.parse(await call('paste', { windowHandle, text, ...options })) },
          async pressKey(key) { return ActionResult.parse(await call('pressKey', { windowHandle, ...keyChord(key) })) },
        }
        await window.getAccessibilityTree({ emit: false })
        windows.push(window)
      }
      return windows
    },
  }
}
