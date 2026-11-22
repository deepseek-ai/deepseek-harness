/** Native application objects independent of evaluator ownership and persistence. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { z } from 'zod'
import type { ActionResult, AppsResult, CapabilitiesResult, HoverResult, SystemInputRequest, ShowResult, WindowsResult } from './protocol.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'cua-held-inputs': { kind: 'cua-held-inputs' } & Extract<ContextFormed, { form: 'notice' }>
    'cua-inputs-released': { kind: 'cua-inputs-released' } & Extract<ContextFormed, { form: 'notice' }>
  }
}

/** Helper-issued application selection; public app objects hold only this opaque handle. */
export type CuaAppHandle = Branded<'CuaAppHandle'>
/** Helper-issued accessibility observation identity. */
export type CuaSnapshotId = Branded<'CuaSnapshotId'>
/** Opaque string defined by the platform provider, valid for at least the lifetime of one snapshot. */
export type CuaElementId = Branded<'CuaElementId'>
/** One operation sent through an authorized and logged host dispatcher. */
export type CuaOperation = z.output<typeof SystemInputRequest>
type CuaParameters<M extends CuaOperation['method']> = Extract<CuaOperation, { method: M }>['params']
/** Dispatch exactly once; a failed action must not be retried implicitly. */
export type CuaDispatch = (operation: CuaOperation) => Promise<JsonValue>
/** Stored screenshot returned to a program for explicit inspection. */
export type CuaProgramImage = { readonly attachmentId: string; readonly path: string; readonly width: number; readonly height: number }
/** Accessibility observations of the requested content; each read replaces the application's current snapshot. */
export interface CuaAccessibilityOptions {
  /** Expand menu contents. The default shows menu-bar entries only. */
  includeMenus?: boolean
  /** Include identifiers, global native bounds and complete action names. */
  details?: boolean
  /** Request changes since the previous comparable tree. Omit or pass false to request the full tree. */
  showDiff?: boolean
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
> & { systemInput?: boolean }
/** App discovery result with its running state; identity is null when no distinguishing selector is provided. */
export type CuaAppInfo = Pick<z.output<typeof AppsResult>[number], 'id' | 'identity' | 'displayName' | 'isRunning'> & {
  /** Running process selector on macOS. */
  pid?: number | undefined
}
/** Window bounds in the provider's global native units. Local operations use an origin of [0,0]. */
export type CuaBounds = CuaWindowInfo['bounds']
/** Observed window metadata; identifiers are valid only while the window exists, and null Space membership is unknown. */
export type CuaWindowInfo = z.output<typeof WindowsResult>[number]
/** Reports whether the provider successfully executed the requested operation. */
export type CuaActionResult = z.output<typeof ActionResult>
/**
 * JSON Schema for an action's `{ argument }` parameters, excluding the action name and target identifiers.
 * Describes basic types and named object fields; `description` states value limits and allowed enum names
 * without numeric-bound, integer-type or enum constraints in the schema.
 * No-argument actions allow omission or null; required arguments appear in `required`.
 * The response is checked for its outer fields and JSON values, not full schema semantics.
 * performAction enforces the action's value constraints and element-specific requirements.
 */
export type CuaActionSchema = ObjectJsonSchema
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
/** Modifiers attached to a pointer gesture; system input also presses and releases their keyboard keys. */
export type CuaPointerModifier = NonNullable<CuaParameters<'click'>['modifiers']>[number]
/** Buttons supported by window-directed mouse input. */
export type CuaMouseButton = NonNullable<CuaParameters<'click'>['mouseButton']>
/**
 * Left clicks support one or two presses; right and middle clicks support one.
 * holdMs is a nonnegative integer in milliseconds, limited by maxClickHoldMs; zero releases immediately.
 * Explicit holds use pointer input; omission preserves ordinary clicks.
 */
export type CuaClickOptions = Pick<CuaParameters<'click'>, 'mouseButton' | 'clickCount' | 'modifiers' | 'holdMs'> & CuaCoordinateOptions & CuaSystemInputOptions
/** One same-window drag; omitted button is left and omitted modifiers are empty. */
export type CuaDragOptions = Pick<CuaParameters<'drag'>, 'mouseButton' | 'modifiers' | 'useSystemInput'> & CuaCoordinateOptions
/** Clipboard representation delivered through the application's Paste command. */
export type CuaPasteOptions = Pick<CuaParameters<'paste'>, 'format'>
/** System keyboard or mouse delivery for one supported input operation. */
export interface CuaSystemInputOptions {
  /** True requests system input, including keyboard modifiers, after approval; omitted or false uses the provider default. */
  useSystemInput?: boolean
}
/** Adjacent literal context disambiguates repeated text; cursor modes collapse the matched range. */
export type CuaSelectTextOptions = Pick<CuaParameters<'selectText'>, 'prefix' | 'suffix' | 'selectionType'>
/** Positive deltas reveal content above/left; each axis is an integer from -10 to 10. */
export type CuaScrollOptions = Pick<CuaParameters<'scroll'>, 'x' | 'y' | 'deltaLinesX' | 'deltaLinesY'> & CuaCoordinateOptions
/**
 * Common operations inherited by application and window objects; not a standalone object.
 * Advertised accessibility actions remain available; failed actions are not retried through pointer input.
 */
export interface CuaSurface {
  /**
   * Show an application window at app scope, or the selected window at window scope.
   * @returns Dispatch evidence, the selected window when available, and sampled foreground change; read fresh state before input.
   */
  show(): Promise<CuaShowResult>
  /**
   * Read the accessibility tree, with menu contents collapsed by default.
   * The returned tree becomes the application's current snapshot; use element ids from its latest successful read.
   * Providers may mark unavailable branches whose contents are unknown and have no element ids.
   * @param options - Traversal limits, menu expansion, field details and optional difference output.
   * @returns Full tree or difference text with current element ids, up to the limits for this read.
   */
  getAccessibilityTree(options?: CuaAccessibilityOptions): Promise<string>
  /**
   * List the actions currently advertised by an element, including attribute-setting operations.
   * @param elementId - Element id from the application's current snapshot.
   * @returns Provider-defined action names; empty when the element advertises none.
   */
  listActions(elementId: CuaElementId): Promise<string[]>
  /**
   * Describe an action's parameters without reading an element or requiring an accessibility snapshot.
   * The schema does not establish that an element supports the action. Attributes whose types depend on
   * live values expose the supported type alternatives; performAction still checks the element's actual type and state.
   * @param action - Nonempty, case-sensitive provider action name, as used by performAction.
   * @returns JSON Schema for the action-specific `{ argument }` parameters, not the complete performAction request.
   */
  getActionSchema(action: string): Promise<CuaActionSchema>
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
   * Select one literal text occurrence through the provider's accessibility interface and verify its range.
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
   * @param text - Clipboard contents in the selected format; defaults to plain text.
   * @param options - Clipboard format.
   * @returns Dispatch evidence; unsupported Paste commands fail without typing fallback.
   */
  paste(text: string, options?: CuaPasteOptions): Promise<CuaActionResult>
  /**
   * Press and release one key at the current input focus.
   * Rejects when the provider does not support keyboard input at this scope.
   * @param key - Provider-defined key name to press and release; not a chord.
   * @param modifiers - Modifier names held for this keystroke. The provider validates the names; omitted means none.
   * @param options - System input selection; omitted uses the provider default.
   * @returns Whether the provider successfully executed the requested operation.
   */
  pressKey(key: string, modifiers?: string[], options?: CuaSystemInputOptions): Promise<CuaActionResult>
  /**
   * Send one key-down or key-up event at the current input focus.
   * Explicit downs persist across programs and turns; successful programs remind about remaining holds.
   * MCP client pauses between completed calls do not notify the provider and leave held input unchanged.
   * Program failure, cancellation, connection closure and disposal release owned input on supported providers.
   * Rejects when the provider does not support keyboard input at this scope.
   * @param key - Platform-defined key name; modifier keys may themselves be targets.
   * @param direction - Down establishes a hold; up immediately releases owned input through its original input route.
   * @param options - Input selection, matching the corresponding down or up; omitted uses the provider default.
   * @returns Whether the provider successfully executed the requested operation.
   */
  sendKeyEvent(key: string, direction: 'down' | 'up', options?: CuaSystemInputOptions): Promise<CuaActionResult>
}
/**
 * An explicit window with screenshot and pointer input operations.
 * Capture and pointer delivery reject known conflicts between accessibility and displayed window bounds with WINDOW_CHANGED.
 * Coordinate input requires a successful accessibility observation covering the window or a screenshot,
 * and rejects resizing since that observation.
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
   * @param options - Coordinate mode for points. Only providers reporting systemInput accept useSystemInput.
   * True requests physical movement for this call only.
   * @returns dispatch evidence and the selected route; observe the resulting UI after any UI delay.
   */
  mouseMove(target: CuaElementId | readonly [number, number],
    options?: CuaCoordinateOptions & CuaSystemInputOptions): Promise<CuaHoverResult>
  /**
   * Send one mouse-button down or up event without moving the pointer.
   * Uses the same held-input lifecycle as {@link CuaSurface.sendKeyEvent}; up uses the saved window and input route.
   * Error and cancellation cleanup releases keys and buttons together in reverse dispatch order.
   * @param mouseButton - Mouse button to press or release.
   * @param direction - Explicit event direction.
   * @param options - Request a system button on a provider reporting systemInput.
   * @returns Whether the provider successfully executed the requested operation.
   */
  toggleMouse(mouseButton: CuaMouseButton, direction: 'down' | 'up', options?: CuaSystemInputOptions): Promise<CuaActionResult>
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
   * @param options - button, modifiers and coordinate mode. Only providers reporting systemInput accept useSystemInput.
   * @returns dispatch evidence.
   */
  drag(from: readonly [number, number], to: readonly [number, number], options?: CuaDragOptions): Promise<CuaActionResult>
}
/** Application-level accessibility, window discovery and scope-dependent input operations. */
export interface CuaApp extends CuaSurface {
  readonly appHandle: CuaAppHandle
  /**
   * Request launch of a new instance of this application; the current App object keeps its selected target.
   * @returns Dispatch evidence; discover applications and windows again to locate the resulting instance.
   */
  launch(): Promise<CuaActionResult>
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
   * Inspect permissions and the provider’s supported methods without requesting access.
   * @returns Reported native capabilities.
   */
  getCapabilities(): Promise<CuaCapabilities>
  /**
   * List applications with their current running state. Providers may enumerate only running applications.
   * @returns identifiers accepted by getApp and each application's running state.
   */
  listApps(): Promise<CuaAppInfo[]>
  /**
   * Search discoverable applications without launching an app.
   * @param query - Name, provider-specific application identifier or absolute application path;
   * an empty string or null lists all discoverable apps.
   * @returns Discovered applications; only nonempty queries enforce the configured match-count limit, rejecting rather than truncating.
   */
  findApps(query: string | null): Promise<CuaAppInfo[]>
  /**
   * Summarize running applications exposed by the provider.
   * @returns running applications from listApps and an empty browser list.
   */
  getState(): Promise<{ apps: CuaAppInfo[]; browsers: [] }>
  /**
   * Select an app, obtain consent, and launch it only where the provider supports launch, without reading the accessibility tree.
   * Selection never activates it.
   * @param selector - Provider-issued id or identity, or a supported exact name, bundle ID or absolute path; ambiguous selectors reject.
   * @returns An application handle tied to this process lifetime; call getAccessibilityTree explicitly before element operations.
   */
  getApp(selector: string): Promise<CuaApp>
}
