/** Native application objects independent of evaluator ownership and persistence. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { z } from 'zod'
import type { ActionResult, CapabilitiesResult, FoundAppsResult, HoverResult, SystemPointerRequest, ShowResult, WindowsResult } from './protocol.ts'

/** Helper-issued application selection; public app objects hold only this opaque handle. */
export type CuaAppHandle = Branded<'CuaAppHandle'>
/** Helper-issued accessibility observation identity. */
export type CuaSnapshotId = Branded<'CuaSnapshotId'>
/** Opaque string defined by the platform provider, valid for at least the lifetime of one snapshot. */
export type CuaElementId = Branded<'CuaElementId'>
/** One operation sent through an authorized and logged host dispatcher. */
export type CuaOperation = z.output<typeof SystemPointerRequest>
type CuaParameters<M extends CuaOperation['method']> = Extract<CuaOperation, { method: M }>['params']
/** Dispatch exactly once; a failed action must not be retried implicitly. */
export type CuaDispatch = (operation: CuaOperation) => Promise<JsonValue>
/** Stored screenshot returned to a program for explicit inspection. */
export type CuaProgramImage = { readonly attachmentId: string; readonly path: string; readonly width: number; readonly height: number }
/** Full observations of the requested content; each read replaces the application's current snapshot. */
export interface CuaAxOptions {
  /** Expand menu contents. The default shows menu-bar entries only. */
  includeMenus?: boolean
  /** Include identifiers, global native bounds and complete action names. */
  details?: boolean
  /** Maximum nodes visited for this read. Omission uses the provider setting. */
  maxElements?: number
  /** Maximum traversal depth for this read. Omission uses the provider setting. */
  maxDepth?: number
}
/** Reported permissions and operations; null sessionLocked means no usable console session was verified. */
export type CuaCapabilities = z.output<typeof CapabilitiesResult>
/** Provider capabilities fixed when the provider is installed; runtime fields come from getCapabilities. */
export type CuaStartupCapabilities = Pick<
  CuaCapabilities,
  'platform' | 'methods' | 'appLevelAccessibility' | 'keyboard' | 'browser' | 'coordinateSpace'
> & { systemPointer?: boolean }
/** App discovery result accepted by getApp, including the provider-reported running state. */
export type CuaAppInfo = Pick<CuaFoundAppInfo, 'id' | 'displayName' | 'isRunning'> & {
  /** Running process selector on macOS. */
  pid?: number | undefined
}
/** An installed application match with its current running state. */
export type CuaFoundAppInfo = z.output<typeof FoundAppsResult>[number]
/** Window bounds in the provider's global native units. Local operations use an origin of [0,0]. */
export type CuaBounds = CuaWindowInfo['bounds']
/** Observed window metadata; identifiers are valid only while the window exists, and null Space membership is unknown. */
export type CuaWindowInfo = z.output<typeof WindowsResult>[number]
/** Reports whether the provider successfully executed the requested operation. */
export type CuaActionResult = z.output<typeof ActionResult>
/** Hover dispatch and the effect on the user's system pointer. */
export type CuaHoverResult = z.output<typeof HoverResult>
/** Select screenshot pixels by default or integer thousandths when explicitly requested. */
export interface CuaCoordinateOptions {
  /**
   * True uses integer thousandths from 0 to 999; omitted or false uses the latest screenshot's pixels.
   * Applies only to coordinate targets.
   */
  relative?: boolean
}
/** Restoration dispatch; foregroundChanged compares the front app and top window before and after the request. */
export type CuaShowResult = z.output<typeof ShowResult>
/** Modifiers attached to a window-directed pointer gesture. */
export type CuaPointerModifier = NonNullable<CuaParameters<'click'>['modifiers']>[number]
/** Buttons supported by window-directed clicks and drags. */
export type CuaMouseButton = NonNullable<CuaParameters<'click'>['mouseButton']>
/**
 * Left clicks support one or two presses; right and middle clicks support one.
 * holdMs is a nonnegative integer in milliseconds, limited by maxClickHoldMs; zero releases immediately.
 * Explicit holds use pointer input; omission preserves ordinary clicks.
 */
export type CuaClickOptions = Pick<CuaParameters<'click'>, 'mouseButton' | 'clickCount' | 'modifiers' | 'holdMs'> & CuaCoordinateOptions
/** One same-window drag; omitted button is left and omitted modifiers are empty. */
export type CuaDragOptions = Pick<CuaParameters<'drag'>, 'mouseButton' | 'modifiers' | 'useSystemPointer'> & CuaCoordinateOptions
/** Clipboard representation delivered through the application's Paste command. */
export type CuaPasteOptions = Pick<CuaParameters<'paste'>, 'format'>
/** Adjacent literal context disambiguates repeated text; cursor modes collapse the matched range. */
export type CuaSelectTextOptions = Pick<CuaParameters<'selectText'>, 'prefix' | 'suffix' | 'selectionType'>
/** Positive deltas reveal content above/left; each axis is an integer from -10 to 10. */
export type CuaScrollOptions = Pick<CuaParameters<'scroll'>, 'x' | 'y' | 'deltaLinesX' | 'deltaLinesY'> & CuaCoordinateOptions
/**
 * Common operations inherited by application and window objects; not a standalone object.
 * Advertised AX actions remain available; failed actions are not retried through pointer input.
 */
export interface CuaSurface {
  /**
   * Unhide the app and restore a minimized selected, focused, main or sole window without requesting activation.
   * @returns Dispatch evidence, the selected window when available, and sampled foreground change; read fresh state before input.
   */
  show(): Promise<CuaShowResult>
  /**
   * Read the accessibility tree, with menu contents collapsed by default.
   * The returned tree becomes the application's current snapshot; use element ids from its latest successful read.
   * Providers may mark unavailable branches whose contents are unknown and have no element ids.
   * @param options - Traversal limits, menu expansion and field detail options.
   * @returns Accessibility tree text with element ids, up to the limits for this read.
   */
  getAccessibilityTree(options?: CuaAxOptions): Promise<string>
  /**
   * List the actions currently advertised by an element, including attribute-setting operations.
   * @param elementId - Element id from the application's current snapshot.
   * @returns Provider-defined action names; empty when the element advertises none.
   */
  listActions(elementId: CuaElementId): Promise<string[]>
  /**
   * Perform an element action, including attribute-setting operations.
   * @param elementId - Element id from the application's current snapshot.
   * @param action - Exact action name from listActions.
   * @param argument - Direct action argument; omit or pass null for a no-argument action, or pass the value itself for attribute setting.
   * @returns Whether the provider successfully executed the requested operation.
   */
  performAction(elementId: CuaElementId, action: string, argument?: JsonValue): Promise<CuaActionResult>
  /**
   * Invoke the element's default action.
   * If the element's type does not support a default action, the result's dispatched field is false.
   * @param elementId - Element id from the application's current snapshot.
   * @returns Whether the provider successfully executed the requested operation.
   */
  invoke(elementId: CuaElementId): Promise<CuaActionResult>
  /**
   * Set an observed control value.
   * @param elementId - Element id from the application's current snapshot.
   * @param value - Replacement value as JSON; supported values are defined by the platform provider.
   * @returns dispatch evidence.
   */
  setValue(elementId: CuaElementId, value: JsonValue): Promise<CuaActionResult>
  /**
   * Select one literal text occurrence through writable AXSelectedTextRange and verify its range.
   * @param elementId - Element id from the application's current snapshot.
   * @param text - Nonempty literal text; multiple matches require adjacent context.
   * @param options - Adjacent prefix/suffix and selection or cursor placement.
   * @returns Dispatch evidence; rejects unsupported, ambiguous or changed text without keyboard fallback.
   */
  selectText(elementId: CuaElementId, text: string, options?: CuaSelectTextOptions): Promise<CuaActionResult>
  /**
   * Type text at the current input focus.
   * Rejects when the provider does not support keyboard input at this scope.
   * @param text - Literal text; cancellation may leave a prefix entered.
   * @returns Whether the provider successfully executed the requested operation.
   */
  typeText(text: string): Promise<CuaActionResult>
  /**
   * Paste text or HTML at the target's current input focus.
   * Rejects when the provider does not support keyboard input at this scope.
   * PASTE_NOT_CONSUMED means no clipboard read within the configured deadline after dispatch; inspect before retrying.
   * @param text - Clipboard contents in the selected format; defaults to plain text.
   * @param options - Clipboard format. Original contents are restored unless another writer changes them.
   * @returns Dispatch evidence; unsupported Paste commands fail without typing fallback.
   */
  paste(text: string, options?: CuaPasteOptions): Promise<CuaActionResult>
  /**
   * Press and release one key at the current input focus.
   * Rejects when the provider does not support keyboard input at this scope.
   * @param key - Provider-defined key name to press and release; not a chord.
   * @param modifiers - Modifier names held for this keystroke. The provider validates the names; omitted means none.
   * @returns Whether the provider successfully executed the requested operation.
   */
  pressKey(key: string, modifiers?: string[]): Promise<CuaActionResult>
  /**
   * Send one key-down or key-up event at the current input focus.
   * Does not send the opposite event.
   * Rejects when the provider does not support keyboard input at this scope.
   * @param key - Platform-defined key name; modifier keys may themselves be targets.
   * @param direction - Explicit event direction; the opposite event is never sent implicitly.
   * @returns Whether the provider successfully executed the requested operation.
   */
  sendKeyEvent(key: string, direction: 'down' | 'up'): Promise<CuaActionResult>
}
/**
 * An explicit window with screenshot and pointer input operations.
 * Capture and pointer delivery reject known AX/display frame conflicts with WINDOW_CHANGED.
 * Coordinate input requires a successful AX observation covering the window or a screenshot, and rejects resizing since that observation.
 */
export interface CuaWindow extends CuaSurface {
  /** Opaque window identifier issued by the platform provider. */
  readonly windowId: string
  /**
   * Capture the selected window.
   * @returns Stored Image with a readable path and pixel dimensions, ready for explicit inspection.
   */
  getScreenshot(): Promise<CuaProgramImage>
  /**
   * Request a mouse move to an element or a point without pressing a button.
   * The provider reports the route and whether the system pointer moved.
   * Returning and subsequent observations do not restore the previous pointer position.
   * Other input and application changes can interrupt the interaction; observe before continuing.
   * @param target - current element id or screenshot-local [x,y].
   * @param options - Coordinate mode for points. Only providers reporting systemPointer accept useSystemPointer.
   * True requests physical movement for this call only.
   * @returns dispatch evidence and the selected route; observe the resulting UI after any UI delay.
   */
  mouseMove(target: CuaElementId | readonly [number, number],
    options?: CuaCoordinateOptions & { useSystemPointer?: boolean }): Promise<CuaHoverResult>
  /**
   * Click a current element id or screenshot-local point.
   * Cancellation or timeout releases the held button; received input cannot be undone. The operation deadline includes holdMs.
   * @param target - element id or [x,y].
   * @param options - button, click count, modifiers, optional hold duration and coordinate mode.
   * @returns dispatch evidence.
   */
  click(target: CuaElementId | readonly [number, number], options?: CuaClickOptions): Promise<CuaActionResult>
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
   * @param options - button, modifiers and coordinate mode. Only providers reporting systemPointer accept useSystemPointer.
   * @returns dispatch evidence.
   */
  drag(from: readonly [number, number], to: readonly [number, number], options?: CuaDragOptions): Promise<CuaActionResult>
}
/** Application-level accessibility, window discovery and scope-dependent input operations. */
export interface CuaApp extends CuaSurface {
  readonly appHandle: CuaAppHandle
  /**
   * Activate this application explicitly, potentially changing the user's focused app and Space.
   * @returns Dispatch evidence; read fresh state before further interaction.
   */
  activate(): Promise<CuaActionResult>
  /**
   * Enumerate current windows.
   * @returns current window records.
   */
  getWindows(): Promise<CuaWindowInfo[]>
  /**
   * Select a specific window.
   * @param windowId - String ID obtained from getWindows, passed unchanged.
   * @returns A window object without a native request; selection leaves the accessibility snapshot unchanged.
   * Providers reject a closed or foreign window when operating on it.
   */
  getWindow(windowId: string): Promise<CuaWindow>
}
/** Native app API; its caller owns global bindings and variable persistence. */
export interface CuaApi {
  /**
   * Inspect permissions without requesting them.
   * @returns reported native capabilities.
   */
  getCapabilities(): Promise<CuaCapabilities>
  /**
   * List applications with their current running state. Providers may enumerate only running applications.
   * @returns identifiers accepted by getApp and each application's running state.
   */
  listApps(): Promise<CuaAppInfo[]>
  /**
   * Search the provider's installed application locations without launching an app.
   * @param query - Nonempty name, provider-specific application identifier or absolute application path.
   * @returns Matching installed applications; overly broad queries reject instead of silently truncating.
   */
  findApps(query: string): Promise<CuaFoundAppInfo[]>
  /**
   * Summarize provider application discovery.
   * @returns native apps with their running state and an empty browser list.
   */
  getState(): Promise<{ apps: CuaAppInfo[]; browsers: [] }>
  /**
   * Select an app, obtain consent, and launch it only where the provider supports launch, without reading AX; selection never activates it.
   * @param selector - Provider-issued ID, or a supported exact name, bundle ID or absolute path; ambiguous selectors reject.
   * @returns An application handle tied to this process lifetime; call getAccessibilityTree explicitly before element operations.
   */
  getApp(selector: string): Promise<CuaApp>
}
