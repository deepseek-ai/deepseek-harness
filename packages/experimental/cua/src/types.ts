/** Native application objects independent of evaluator ownership and persistence. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { z } from 'zod'
import type { ActionResult, CapabilitiesResult, FoundAppsResult, HoverResult, Request, ScreenshotResult, ShowResult, WindowsResult } from './protocol.ts'

/** Helper-issued application selection; public app objects bind it to one process lifetime. */
export type CuaAppHandle = Branded<'CuaAppHandle'>
/** Helper-issued accessibility observation identity. */
export type CuaSnapshotId = Branded<'CuaSnapshotId'>
/** One operation sent through an authorized and logged host dispatcher. */
export type CuaOperation = z.output<typeof Request>
type CuaParameters<M extends CuaOperation['method']> = Extract<CuaOperation, { method: M }>['params']
/** Dispatch exactly once; a failed action must not be retried implicitly. */
export type CuaDispatch = (operation: CuaOperation) => Promise<JsonValue>
/** Encoded model-request image with the format, pixel dimensions and window reported by the Host. */
export type CuaScreenshot = Pick<z.output<typeof ScreenshotResult>, 'mimeType' | 'pixelWidth' | 'pixelHeight' | 'windowId'> & {
  bytes: Uint8Array
}
/** Optional output owned by the caller; persistence and image admission are external. */
export interface CuaObservationSink {
  /**
   * Emit text.
   * @param value - observed application state.
   */
  text(value: string): void | Promise<void>
  /**
   * Emit an image.
   * @param screenshot - encoded image and its validated format, dimensions and window.
   */
  image(screenshot: CuaScreenshot): void | Promise<void>
}
/** Observations emit by default. Returned values are unaffected by this option. */
export interface CuaObservationOptions { emit?: boolean }
/** Full observations of the requested content; each read replaces this surface's indices. */
export interface CuaAxOptions extends CuaObservationOptions {
  /** Reserved compatibility option; observations are never diffs. */
  disableDiffing?: boolean
  /** Expand menu contents. The default shows menu-bar entries only. */
  includeMenus?: boolean
  /** Include identifiers, global-point bounds and complete action names. */
  details?: boolean
}
/** Reported permissions and operations; null sessionLocked means no usable console session was verified. */
export type CuaCapabilities = z.output<typeof CapabilitiesResult>
/** App discovery result accepted by getApp. */
export type CuaAppInfo = Pick<Extract<CuaFoundAppInfo, { isRunning: true }>, 'id' | 'displayName' | 'isRunning' | 'pid'>
/** An installed application match; running matches include a process identifier. */
export type CuaFoundAppInfo = z.output<typeof FoundAppsResult>[number]
/** Window bounds in global macOS points. Local operations use an origin of [0,0]. */
export type CuaBounds = CuaWindowInfo['bounds']
/** Observed window metadata; identifiers are valid only while the window exists, and null Space membership is unknown. */
export type CuaWindowInfo = z.output<typeof WindowsResult>[number]
/** Successful input dispatch; application outcome still requires observation. */
export type CuaActionResult = z.output<typeof ActionResult>
/** Hover dispatch and the effect on the user's system pointer. */
export type CuaHoverResult = z.output<typeof HoverResult>
/** Select screenshot pixels by default or integer thousandths when explicitly requested. */
export interface CuaCoordinateOptions {
  /** True uses integers from 0 to 1000; omitted or false uses the latest screenshot's pixels. Applies only to coordinate targets. */
  relative?: boolean
}
/** Restoration dispatch; foregroundChanged compares the front app and top window before and after the request. */
export type CuaShowResult = z.output<typeof ShowResult>
/** Modifiers attached to a window-directed pointer gesture. */
export type CuaPointerModifier = NonNullable<CuaParameters<'click'>['modifiers']>[number]
/** Buttons supported by window-directed clicks and drags. */
export type CuaMouseButton = NonNullable<CuaParameters<'click'>['mouseButton']>
/** Left clicks support one or two presses; right and middle clicks support one. */
export type CuaClickOptions = Pick<CuaParameters<'click'>, 'mouseButton' | 'clickCount' | 'modifiers'> & CuaCoordinateOptions
/** One same-window drag; omitted button is left and omitted modifiers are empty. */
export type CuaDragOptions = Pick<CuaParameters<'drag'>, 'mouseButton' | 'modifiers'> & CuaCoordinateOptions
/** Clipboard representation delivered through the application's Paste command. */
export type CuaPasteOptions = Pick<CuaParameters<'paste'>, 'format'>
/** Adjacent literal context disambiguates repeated text; cursor modes collapse the matched range. */
export type CuaSelectTextOptions = Pick<CuaParameters<'selectText'>, 'prefix' | 'suffix' | 'selectionType'>
/** Positive deltas reveal content above/left; each axis is an integer from -10 to 10. */
export type CuaScrollOptions = Pick<CuaParameters<'scroll'>, 'x' | 'y' | 'deltaLinesX' | 'deltaLinesY'> & CuaCoordinateOptions
/** An observed AX tree and independently captured image; capture is not atomic. */
export interface CuaObservation { state: string; screenshot: CuaScreenshot }
/**
 * App-wide or explicitly scoped window observations and actions.
 * Capture and pointer delivery reject known AX/display frame conflicts with WINDOW_CHANGED.
 * Coordinate input also rejects resizing since the latest successful AX read or screenshot.
 * Advertised AX actions remain available; failed actions are not retried through pointer input.
 */
export interface CuaSurface {
  /**
   * Unhide the app and restore a minimized selected, focused, main or sole window without requesting activation.
   * @returns Dispatch evidence, the selected window when available, and sampled foreground change; read fresh state before input.
   */
  show(): Promise<CuaShowResult>
  /**
   * Read fresh AX text, with menu contents collapsed by default.
   * @param options - emission, menu expansion and field detail options.
   * @returns AX text with element indices.
   */
  getAXState(options?: CuaAxOptions): Promise<string>
  /**
   * Capture the selected window.
   * @param options - emission options.
   * @returns encoded model-request image with its format, pixel dimensions and window; use mimeType when saving or declaring the image.
   */
  getScreenshot(options?: CuaObservationOptions): Promise<CuaScreenshot>
  /**
   * Read AX then capture.
   * @param options - observation options.
   * @returns both non-atomic observations.
   */
  getAXStateAndScreenshot(options?: CuaAxOptions): Promise<CuaObservation>
  /**
   * Reveal advertised AX alternate UI, otherwise move the system cursor without pressing a button.
   * The system-pointer route requires the app to be foreground and the point unobscured; never activates or raises it.
   * Returning and subsequent observations do not restore the previous pointer position.
   * Other input and application changes can interrupt hover; observe before continuing.
   * @param target - current AX index or screenshot-local [x,y].
   * @param options - coordinate mode; applies only to [x,y].
   * @returns dispatch evidence and the selected route; observe the resulting UI after its hover delay.
   */
  hover(target: number | readonly [number, number], options?: CuaCoordinateOptions): Promise<CuaHoverResult>
  /**
   * Click a current AX index or screenshot-local point.
   * @param target - index or [x,y].
   * @param options - button, click count, modifiers and coordinate mode.
   * @returns dispatch evidence.
   */
  click(target: number | readonly [number, number], options?: CuaClickOptions): Promise<CuaActionResult>
  /**
   * Set an observed control value.
   * @param index - index from this surface's latest tree.
   * @param value - replacement value.
   * @returns dispatch evidence.
   */
  setValue(index: number, value: string): Promise<CuaActionResult>
  /**
   * Select one literal text occurrence through writable AXSelectedTextRange and verify its range.
   * @param index - Text control index from this surface's latest tree.
   * @param text - Nonempty literal text; multiple matches require adjacent context.
   * @param options - Adjacent prefix/suffix and selection or cursor placement.
   * @returns Dispatch evidence; rejects unsupported, ambiguous or changed text without keyboard fallback.
   */
  selectText(index: number, text: string, options?: CuaSelectTextOptions): Promise<CuaActionResult>
  /**
   * Invoke an action advertised by an observed element; raising a window activates its app.
   * @param index - Index from this surface's latest AX tree.
   * @param action - Advertised action name, such as raise or zoomwindow.
   * @returns Dispatch evidence; menu and window actions can change focus.
   */
  performSecondaryAction(index: number, action: string): Promise<CuaActionResult>
  /**
   * Scroll at a screenshot-local point or integer ratio.
   * @param options - point, coordinate mode and line deltas; at least one delta must be nonzero.
   * @returns dispatch evidence.
   */
  scroll(options: CuaScrollOptions): Promise<CuaActionResult>
  /**
   * Drag between points in one window while holding the selected button and modifiers.
   * @param from - starting screenshot-local point or integer ratio.
   * @param to - destination in the same coordinate mode.
   * @param options - button, modifiers and coordinate mode for the complete gesture.
   * @returns dispatch evidence.
   */
  drag(from: readonly [number, number], to: readonly [number, number], options?: CuaDragOptions): Promise<CuaActionResult>
}
/** One explicit window; keyboard operations remain app-scoped because they follow focus. */
export interface CuaWindow extends CuaSurface { readonly windowId: number }
/**
 * Native app handle supporting direct observations and actions without window enumeration.
 * Screenshots and coordinates reuse the latest AX observation's focused on-screen,
 * nonzero-size window, or require exactly one such window. Read fresh AX to follow
 * focus changes; explicit window objects retain their selected target.
 */
export interface CuaApp extends CuaSurface {
  readonly pid: number
  readonly appHandle: CuaAppHandle
  /**
   * Activate this application explicitly, potentially changing the user's focused app and Space.
   * @returns Dispatch evidence; read fresh state before further interaction.
   */
  activate(): Promise<CuaActionResult>
  /**
   * Enumerate current windows.
   * @param options - output options.
   * @returns current window records.
   */
  getWindows(options?: CuaObservationOptions): Promise<CuaWindowInfo[]>
  /**
   * Observe a specific window.
   * @param windowId - ID obtained from getWindows.
   * @returns a reusable window object with its initial AX state emitted.
   */
  getWindow(windowId: number): Promise<CuaWindow>
  /**
   * Input at the application's current focus.
   * @param text - literal text; cancellation may leave a prefix entered.
   * @returns dispatch evidence.
   */
  typeText(text: string): Promise<CuaActionResult>
  /**
   * Paste text or HTML through the application's standard Paste menu command.
   * PASTE_NOT_CONSUMED means no clipboard read within the configured deadline after dispatch; inspect before retrying.
   * @param text - Clipboard contents in the selected format; defaults to plain text.
   * @param options - Clipboard format. Original contents are restored unless another writer changes them.
   * @returns Dispatch evidence; unsupported Paste commands fail without typing fallback.
   */
  paste(text: string, options?: CuaPasteOptions): Promise<CuaActionResult>
  /**
   * Send a key/chord at current focus.
   * @param key - xdotool-style chord such as super+c, shift+Tab, + or cmd++; plus is also a key name.
   * @returns dispatch evidence.
   */
  pressKey(key: string): Promise<CuaActionResult>
}
/** Native app API; its caller owns global bindings and variable persistence. */
export interface CuaApi {
  /**
   * Inspect permissions without requesting them.
   * @param options - output options.
   * @returns reported native capabilities.
   */
  getCapabilities(options?: CuaObservationOptions): Promise<CuaCapabilities>
  /**
   * Enumerate running applications.
   * @param options - output options.
   * @returns identifiers accepted by getApp.
   */
  listApps(options?: CuaObservationOptions): Promise<CuaAppInfo[]>
  /**
   * Search standard macOS application directories without launching an app.
   * @param query - Nonempty name, bundle identifier or absolute application path.
   * @param options - Output options.
   * @returns Matching installed applications; overly broad queries reject instead of silently truncating.
   */
  findApps(query: string, options?: CuaObservationOptions): Promise<CuaFoundAppInfo[]>
  /**
   * Discover apps.
   * @param options - output options.
   * @returns native apps and an empty browser list.
   */
  getState(options?: CuaObservationOptions): Promise<{ apps: CuaAppInfo[]; browsers: [] }>
  /**
   * Select an app, obtain consent, launch it in the background if necessary, and emit initial AX state.
   * @param selector - Exact name, bundle ID, absolute application path or running PID string; ambiguous names reject.
   * @returns a handle tied to this process lifetime.
   */
  getApp(selector: string): Promise<CuaApp>
}
