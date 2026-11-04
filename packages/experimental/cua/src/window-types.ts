/** Window-directed facade types shared by providers with desktop-wide discovery. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { z } from 'zod'
import type { CuaActionResult, CuaCapabilities, CuaObservationOptions, CuaPasteOptions, CuaWindow, CuaWindowInfo } from './types.ts'
import type { LaunchEntriesResult, WindowRequest } from './window-protocol.ts'

/** Connection-owned grant for exactly one observed window lifetime. */
export type CuaWindowHandle = Branded<'CuaWindowHandle'>
/** One logged window operation. */
export type CuaWindowOperation = z.output<typeof WindowRequest>
/** Current execution's tool binding. */
export type CuaWindowDispatch = (operation: CuaWindowOperation) => Promise<JsonValue>
/** Discovered launch entry; its identifier is accepted by launch, not by window selection. */
export type CuaLaunchEntry = z.output<typeof LaunchEntriesResult>[number]
/** Selected window; keyboard and clipboard operations require this window in front. */
export interface CuaDesktopWindow extends CuaWindow {
  windowId: number
  windowHandle: CuaWindowHandle
  /** Bring this window forward. @returns Dispatch evidence, not application success. */
  activate(): Promise<CuaActionResult>
  /** Type into the focused control in this window. @param text Text to insert. @returns Dispatch evidence. */
  typeText(text: string): Promise<CuaActionResult>
  /** Paste into this window. @param text Clipboard payload. @param options Clipboard format. @returns Dispatch evidence. */
  paste(text: string, options?: CuaPasteOptions): Promise<CuaActionResult>
  /** Send a chord to this window. @param key Key or chord. @returns Dispatch evidence. */
  pressKey(key: string): Promise<CuaActionResult>
}
/** Provider-specific subset of CUA; discovery, launch and control are separate operations. */
export interface CuaWindowApi {
  /** Inspect access without requesting it. @param options Output options. @returns Native capabilities. */
  getCapabilities(options?: CuaObservationOptions): Promise<CuaCapabilities>
  /** Discover top-level windows without reading AX. @param options Output options. @returns Window metadata. */
  listWindows(options?: CuaObservationOptions): Promise<CuaWindowInfo[]>
  /** Authorize selected windows and read their initial accessibility trees silently. A failure may leave earlier grants in place.
   * @param ids IDs from listWindows; duplicates reject. @returns Windows in requested order.
   */
  getWindows(ids: readonly number[]): Promise<CuaDesktopWindow[]>
  /** Search launch entries without launching. @param query Name or entry identifier. @param options Output options. @returns Matches. */
  findApps(query: string, options?: CuaObservationOptions): Promise<CuaLaunchEntry[]>
  /** Authorize and dispatch one launch without claiming a window exists.
   * @param target Discovered entry ID or user-specified absolute executable path. @returns Dispatch acknowledgement.
   */
  launch(target: string): Promise<CuaActionResult>
}
