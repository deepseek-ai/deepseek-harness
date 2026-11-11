/** Host-only decoding of native window observations before tool results reach a caller. */
import { z } from 'zod'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CuaCoordinates } from './coordinates.ts'
import { NativeError } from './native-client.ts'
import { StateResult, WindowsResult } from './protocol.ts'
import type { CuaAppHandle, CuaOperation } from './types.ts'

const NativeWindows = WindowsResult.element.extend({ cacheOnly: z.literal(true).optional() }).array()
const NativeState = StateResult.extend({ windows: NativeWindows })

/**
 * Keep geometry for every live window but return only discovered or explicitly selected windows.
 * @param request - Authorized observation and its expected app/window identity.
 * @param result - Untrusted native reply, including any cache-only records.
 * @param coordinates - The calling Agent's screenshot and coordinate cache.
 * @returns Public observation with private fields removed.
 */
export function observeNativeWindows(
  request: Extract<CuaOperation, { method: 'getState' | 'listWindows' }>, result: JsonValue, coordinates: CuaCoordinates,
): z.output<typeof WindowsResult> | z.output<typeof StateResult> {
  const appHandle = request.params.appHandle as CuaAppHandle
  function observe(windows: z.output<typeof NativeWindows>, selected?: string) {
    coordinates.observe(appHandle, windows, selected)
    return windows.flatMap(({ cacheOnly, ...window }) => !cacheOnly || window.windowId === selected ? [window] : [])
  }
  if (request.method === 'listWindows') return observe(NativeWindows.parse(result))
  const state = NativeState.parse(result)
  if (state.appHandle !== appHandle || state.windowId !== (request.params.windowId ?? null)) {
    throw new NativeError('NATIVE_PROTOCOL', 'Native observation belongs to another application or window')
  }
  return { ...state, windows: observe(state.windows, request.params.windowId) }
}
