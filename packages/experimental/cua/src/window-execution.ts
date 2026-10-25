/** Connection-owned window grants and launch continuations; no implicit application selection. */
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ApplicationAuthorizationResult } from './application-access.ts'
import type { ApplicationAccess } from './application-access.ts'
import { NativeError, type NativeClient } from './native-client.ts'
import { Request } from './protocol.ts'
import { LaunchEntriesResult, LaunchResult, WindowDiscoveryResult } from './window-protocol.ts'
import type { CuaAppHandle, CuaOperation } from './types.ts'
import type { CuaWindowOperation } from './window-types.ts'

const preparedWindow = z.object({
  appHandle: z.string().min(1), windowId: z.number().int().positive(), pid: z.number().int().positive(),
  authorization: ApplicationAuthorizationResult,
})
const preparedLaunch = z.object({ appHandle: z.string().min(1), authorization: ApplicationAuthorizationResult })

/** Binds public handles to a single native window on one connection. */
export class CuaWindowExecution {
  private readonly windows = new Map<string, { appHandle: CuaAppHandle; windowId: number; pid: number }>()
  /** Execute an admitted window request.
   * @param request Provider-specific model request.
   * @param agent Calling agent.
   * @param client Current connection.
   * @param access Live authorization owner.
   * @param signal Current tool lifetime.
   * @param callId Logged invocation identifier.
   * @param maxAppMatches Discovery response bound.
   * @param dispatch Shared observation, screenshot and coordinate pipeline.
   * @returns Logged result without native-only authorization fields.
   */
  async run(request: CuaWindowOperation, agent: Agent, client: NativeClient, access: Pick<ApplicationAccess, 'select' | 'run'>,
    signal: AbortSignal, callId: Parameters<NativeClient['request']>[3], maxAppMatches: number,
    dispatch: (request: CuaOperation, signal: AbortSignal) => Promise<unknown>): Promise<JsonValue> {
    const { method, params } = request
    if (method === 'getCapabilities') return z.json().parse(await dispatch(Request.parse(request), signal))
    if (method === 'listWindows') return WindowDiscoveryResult.parse(await client.request('discoverWindows', {}, signal, callId))
    if (method === 'findApps') return LaunchEntriesResult.parse(await client.request('findApps', { ...params, maxAppMatches }, signal, callId)).map(({ path, ...entry }) => ({ ...entry, ...(path === undefined ? {} : { path }) }))
    if (method === 'launch') {
      const prepared = preparedLaunch.parse(await client.request('prepareLaunch', params, signal, callId))
      const handle = prepared.appHandle as CuaAppHandle
      await access.select(agent, client, handle, prepared.authorization, signal, undefined, 'launch')
      return LaunchResult.parse(await access.run(client, handle, signal,
        signal => client.request('dispatchLaunch', { appHandle: handle }, signal, callId)))
    }
    if (method === 'getWindows') {
      if (new Set(params.ids).size !== params.ids.length) throw new NativeError('INVALID_ARGUMENT', 'Window IDs must be unique')
      const selected = z.array(preparedWindow).parse(await client.request('prepareWindows', params, signal, callId))
      if (new Set(selected.map(window => window.appHandle)).size !== selected.length
        || selected.length !== params.ids.length
        || selected.some((window, index) => window.windowId !== params.ids[index])) {
        throw new NativeError('NATIVE_PROTOCOL', 'Native window selection does not match the requested IDs')
      }
      const result = []
      for (const window of selected) {
        const handle = window.appHandle as CuaAppHandle
        await access.select(agent, client, handle, window.authorization, signal, undefined, 'window')
        signal.throwIfAborted()
        this.windows.set(handle, { appHandle: handle, windowId: window.windowId, pid: window.pid })
        result.push({ windowHandle: handle, windowId: window.windowId, pid: window.pid })
      }
      return result
    }
    const selected = this.windows.get(params.windowHandle)
    if (!selected) throw new NativeError('WINDOW_ACCESS_REQUIRED', 'Select a current window with getWindows before observing or controlling it')
    const nativeParams = z.record(z.string(), z.json()).parse(params)
    delete nativeParams.windowHandle
    nativeParams.appHandle = selected.appHandle
    if (method === 'getState' || method === 'show' || method === 'screenshot' || 'x' in params || 'fromX' in params) {
      nativeParams.windowId = selected.windowId
    }
    const result = await access.run(client, selected.appHandle, signal,
      signal => dispatch(Request.parse({ method, params: nativeParams }), signal))
    if (method !== 'getState') return z.json().parse(result)
    const state = z.record(z.string(), z.json()).parse(result)
    if (state.appHandle !== selected.appHandle || state.pid !== selected.pid || state.windowId !== selected.windowId) {
      throw new NativeError('NATIVE_PROTOCOL', 'Observation belongs to a different window')
    }
    delete state.appHandle
    return { ...state, windowHandle: params.windowHandle }
  }
}
