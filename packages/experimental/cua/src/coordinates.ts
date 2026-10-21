/** Agent-owned mapping from observed screenshot pixels or integer ratios to native window points. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import type { CuaAppHandle, CuaOperation, CuaWindowInfo } from './types.ts'
import { NativeError } from './native-client.ts'

interface Frame {
  width: number
  height: number
  image?: { width: number; height: number }
}

/** Tracks only the current window geometry and last successfully prepared screenshot. */
export class CuaCoordinates {
  private readonly applications = new Map<CuaAppHandle, Map<number, Frame>>()

  /**
   * Invalidate screenshot mappings when a window closes or changes size.
   * @param appHandle - native application selection.
   * @param windows - freshly observed windows.
   * @param windowId - selected window for a scoped observation; omission means a complete application inventory.
   */
  observe(appHandle: CuaAppHandle, windows: readonly CuaWindowInfo[], windowId?: number): void {
    const previous = this.applications.get(appHandle)
    const current = new Map<number, Frame>(windowId === undefined ? [] : previous)
    if (windowId !== undefined && !windows.some(window => window.windowId === windowId)) current.delete(windowId)
    for (const window of windows) {
      const { width, height } = window.bounds
      const old = previous?.get(window.windowId)
      current.set(window.windowId, old?.width === width && old.height === height ? old : { width, height })
    }
    this.applications.set(appHandle, current)
  }

  /**
   * Bind the exact image delivered to the model to its native window size.
   * @param appHandle - native application selection.
   * @param windowId - selected native window.
   * @param bounds - capture-time window size in points.
   * @param image - encoded model-request image dimensions.
   */
  screenshot(
    appHandle: CuaAppHandle, windowId: number, bounds: { width: number; height: number }, image: { width: number; height: number },
  ): void {
    let frames = this.applications.get(appHandle)
    if (!frames) { frames = new Map(); this.applications.set(appHandle, frames) }
    frames.set(windowId, { width: bounds.width, height: bounds.height, image: { width: image.width, height: image.height } })
  }

  /**
   * Convert admitted coordinate arguments once, before native dispatch.
   * @param request - model request already checked by the operation schema.
   * @returns native parameters with Host-only coordinate options removed.
   */
  parameters(request: CuaOperation): Record<string, JsonValue> {
    const params = request.params
    const native = z.record(z.string(), z.json()).parse(params)
    if (!('x' in params) && !('fromX' in params)) return native
    const frame = this.applications.get(params.appHandle as CuaAppHandle)?.get(params.windowId)
    if (!frame || frame.width <= 0 || frame.height <= 0) throw new NativeError('STALE_SNAPSHOT', 'Read fresh window state before coordinate input')
    const relative = params.relative === true
    if (!relative && !frame.image) throw new NativeError('SCREENSHOT_REQUIRED', 'Take a fresh screenshot before using absolute pixel coordinates')
    const convert = (value: number, axis: 'width' | 'height'): number => {
      const pixels = frame.image?.[axis] ?? frame[axis]
      if (relative) return Math.min(value / 1000 * frame[axis], Math.max(0, frame[axis] - 1))
      if (value >= pixels) throw new NativeError('INVALID_ARGUMENT', 'Coordinate is outside the latest screenshot')
      return value * frame[axis] / pixels
    }
    delete native.relative
    if ('x' in params) { native.x = convert(params.x, 'width'); native.y = convert(params.y, 'height') }
    else {
      native.fromX = convert(params.fromX, 'width'); native.fromY = convert(params.fromY, 'height')
      native.toX = convert(params.toX, 'width'); native.toY = convert(params.toY, 'height')
    }
    return native
  }
}
