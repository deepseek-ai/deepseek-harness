/** Shared model instructions for native application and window operations. */
const hoverSignature = 'mouseMove(target: string | [number, number], options?: { relative?: boolean })'

/** Async method catalog with consent and observation rules, grouped by observation, mouse, and keyboard. */
export const COMMON_GUIDANCE = `Use cua to observe and operate native applications. Always use cua.getCapabilities() to confirm whether a specific API is available on the current platform; its reported capabilities take precedence over availability statements in these instructions. All methods are async; observation options default to { emit: true }, and emit: false suppresses sink output only, leaving returned values unchanged. Actions report dispatch evidence, not verified completion. If sessionLocked is true or an operation reports SESSION_LOCKED, stop UI actions and ask the user to unlock the desktop session; null or unknown means verify a usable unlocked desktop session first. cua.getApp requests user consent; if access is denied or revoked, stop using that application until the user explicitly permits another request, and never bypass a refusal or switch tools to avoid it. Never replay uncertain input without a fresh observation.

In persistent PTC, use the host-provided bridge initialization once and retain the returned objects; cua comes from that bridge and is not a preinstalled global. Use void await for observations that emit, and never stringify screenshot image bytes.

Signatures show resolved return values after await. ActionResult = { dispatched: boolean, foregroundChanged?: boolean | null }; foregroundChanged is omitted when not sampled and null when the sample is unavailable. JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }; numbers must be finite. App is the application object with readonly app.appHandle: string (opaque) and the methods listed below for app level. Window is the window object with readonly window.windowId: number and the methods listed below for window level. Neither object carries pid.

Setup and discovery:
- cua.getCapabilities(options?: { emit?: boolean }) -> { platform: string, permissions: { accessibility: boolean, screenRecording: boolean }, appLevelAccessibility: boolean, systemPointer: boolean, keyboard: ('app' | 'window')[], sessionLocked: boolean | null, methods: string[], coordinateSpace: 'screenshot-pixels', browser: false } — inspect reported permissions, sessionLocked, methods, and keyboard scopes without requesting permissions.
- cua.listApps(options?: { emit?: boolean }) -> { id: string, displayName: string, isRunning: true, pid: number }[] — enumerate running applications.
- cua.findApps(query: string, options?: { emit?: boolean }) -> ({ id: string, displayName: string, path: string } & ({ isRunning: true, pid: number } | { isRunning: false }))[] — search installed applications, including stopped matches; only running matches carry pid.
- cua.getState(options?: { emit?: boolean }) -> { apps: { id: string, displayName: string, isRunning: true, pid: number }[], browsers: [] } — summarize running applications; this is not an accessibility observation.
- cua.getApp(selector: string) -> App — select an application by name, bundle ID, absolute path, or running PID string, obtain consent, launch in the background if needed, and read initial AX state silently; it does not activate the app.
- app.getWindows(options?: { emit?: boolean }) -> { windowId: number, appName: string, title: string, bounds: { x: number, y: number, width: number, height: number }, isOnScreen: boolean, onCurrentSpace: boolean | null }[] — enumerate windows with global native bounds; null onCurrentSpace means unknown Space membership.
- app.getWindow(windowId: number) -> Window — select one window and read its initial AX state silently; do this before any window screenshot or coordinate input.
- app.activate() -> ActionResult — request explicit foreground activation; use only when foreground access is required.
- app.show() -> { dispatched: boolean, windowId: number | null, foregroundChanged: boolean | null } — unhide the app and restore its selected, focused, main, or sole window without activation.
- window.show() -> { dispatched: boolean, windowId: number | null, foregroundChanged: boolean | null } — unhide and restore that explicit window without activation.

## Accessibility tree
Available at app or window level depending on the platform.

Element ids are opaque strings from the latest successful tree; the object facade keeps one current snapshot per app across its repeated app and window objects, a new read replaces it, and a failed read invalidates the previous one. Repeated strings can appear for different elements, so do not reuse an old id blindly, and element operations do not fall back to pointer input or typing.
- getAccessibilityTree(options?: { emit?: boolean, includeMenus?: boolean, details?: boolean, maxElements?: number, maxDepth?: number }) -> string — set the node count or depth for one read. Omitted limits use the provider settings. includeMenus expands menu contents and details adds identifiers, native bounds, and complete action names.
- listActions(elementId: string) -> string[] — list the actions an element advertises.
- invoke(elementId: string) -> ActionResult — invoke the element's default action; dispatched is false when it has none.
- performAction(elementId: string, action: string, argument?: JsonValue) -> ActionResult — perform an observed action with an optional direct JSON argument.
- setValue(elementId: string, value: JsonValue) -> ActionResult — write a control value.
- selectText(elementId: string, text: string, options?: { prefix?: string, suffix?: string, selectionType?: 'text' | 'cursor_before' | 'cursor_after' }) -> ActionResult — select one literal occurrence or place the cursor beside it, using adjacent context to disambiguate.

## Simulated mouse
Use an explicit window for screenshots and pointer input.
- getScreenshot(options?: { emit?: boolean }) -> { bytes: Uint8Array, mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', pixelWidth: number, pixelHeight: number, windowId: number } — capture the selected window as one encoded image; bytes is a JavaScript byte array, and mimeType identifies its encoding, so do not assume PNG.
- ${hoverSignature} -> { dispatched: boolean, foregroundChanged?: boolean | null, hoverRoute: 'accessibility' | 'system-pointer', systemPointerMoved: boolean } — request a mouse move to the target without pressing a button; inspect hoverRoute and systemPointerMoved, and expect no automatic pointer restoration.
- click(target: string | [number, number], options?: { mouseButton?: 'left' | 'right' | 'middle', clickCount?: 1 | 2, modifiers?: ('command' | 'control' | 'option' | 'shift' | 'fn')[], holdMs?: number, relative?: boolean }) -> ActionResult — click an element id or point, or perform a left-button double-click; holdMs controls the press duration of each press.
- scroll(options: { x: number, y: number, deltaLinesX: number, deltaLinesY: number, relative?: boolean }) -> ActionResult — scroll at a point; deltas are integers from -10 to 10 with at least one nonzero, and positive values reveal content above or left.
- drag(from: [number, number], to: [number, number], options?: { mouseButton?: 'left' | 'right' | 'middle', modifiers?: ('command' | 'control' | 'option' | 'shift' | 'fn')[], relative?: boolean }) -> ActionResult — drag between two points of one window.

A string target is an element id; coordinate targets are [x, y] and are pixels in the latest returned screenshot by default. With relative: true they are integer thousandths of the window width and height from 0 to 999, based on the current AX observation or screenshot. Left clicks support one or two presses; right and middle clicks support one. FOREGROUND_REQUIRED means explain the need, then explicitly activate the target and observe again; activation is never automatic. Read fresh state after actions, and treat WINDOW_CHANGED, STALE_SNAPSHOT, and SCREENSHOT_REQUIRED as requiring the stated fresh observation or capture before any retry.

## Simulated keyboard
Available at app or window level depending on the platform.
- typeText(text: string) -> ActionResult — type literal text at the app's current focus; line endings send Return and tabs send Tab.
- paste(text: string, options?: { format?: 'text' | 'html' }) -> ActionResult — deliver text or HTML through the app's Paste command, restoring prior clipboard contents unless another writer changes them; a Paste failure is surfaced without substituting typeText, and PASTE_NOT_CONSUMED means inspect before any retry.
- pressKey(key: string, modifiers?: string[]) -> ActionResult — press and release one complete keystroke. For example pressKey('Tab', ['shift']) or pressKey('+'). Key and modifier names are platform-defined strings. Pass key and modifiers separately; do not pack them into a chord string.

Raw tools use { method, params }: include appHandle for app calls and windowId for window calls, and use snapshotId with elementId for element routes. The emit option is facade-only: emit is local output control, so raw callers must follow the raw operation schema for admitted params. getAccessibilityTree and getWindow read through raw getState; getWindows maps to listWindows; getScreenshot maps to screenshot; cua.getState maps to listApps; every other named operation uses the same method name.`

/**
 * Describe the system-pointer option for a provider that declares the capability.
 * @param guidance Provider instructions including the shared operation catalog.
 * @returns The capability-specific signature and permission instructions.
 */
export function withSystemPointerGuidance(guidance: string): string {
  const signature = 'mouseMove(target: string | [number, number], options?: { relative?: boolean, useSystemPointer?: boolean })'
  return `${guidance.replace(hoverSignature, signature)}

Only if the task cannot be completed without moving the user’s pointer, call await win.mouseMove(target, { useSystemPointer: true }). Prefer an advertised accessibility action, a click on a visible control, or browser tools when possible. The question interrupts the user. When approval is disabled an explicit move can act immediately. Pass true on every physical move, even after approval. Omitting the option or passing false uses the default hover route without prompting. Approval or refusal lasts until this session closes or DSH restarts. A refusal sends no input. If the user dismisses the request, ask again only if they request it. Wait for an outstanding request to finish. Subagents cannot request physical movement.`
}
