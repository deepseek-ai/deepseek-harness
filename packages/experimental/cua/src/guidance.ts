/** Shared model instructions for native application and window operations. */
export const COMMON_GUIDANCE = `Use cua to observe and operate native applications. Always use cua.getCapabilities() to confirm whether a specific API is available on the current platform; its reported capabilities take precedence over availability statements in these instructions. All methods are async; observation options default to { emit: true }, and emit: false suppresses sink output only, leaving returned values unchanged. Actions report dispatch evidence, not verified completion. If sessionLocked is true or an operation reports SESSION_LOCKED, stop UI actions and ask the user to unlock the desktop session; null or unknown means verify a usable unlocked desktop session first. cua.getApp requests user consent; if access is denied or revoked, stop using that application until the user explicitly permits another request, and never bypass a refusal or switch tools to avoid it. Never replay uncertain input without a fresh observation.

In persistent PTC, use the host-provided bridge initialization once and retain the returned objects; cua comes from that bridge and is not a preinstalled global. Use void await for observations that emit, and never stringify screenshot image bytes.

Signatures show resolved return values after await. ActionResult = { dispatched: boolean, foregroundChanged?: boolean | null }; foregroundChanged is omitted when not sampled and null when the sample is unavailable. JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }; numbers must be finite. App is the application object with readonly app.appHandle: string (opaque) and the methods listed below for app level. Window is the window object with readonly window.windowId: number and the methods listed below for window level. Neither object carries pid.

Setup and discovery:
- cua.getCapabilities(options?: { emit?: boolean }) -> { platform: string, permissions: { accessibility: boolean, screenRecording: boolean }, appLevelAccessibility: boolean, keyboard: ('app' | 'window')[], sessionLocked: boolean | null, methods: string[], coordinateSpace: 'screenshot-pixels', browser: false } — inspect reported permissions, sessionLocked, methods, and keyboard scopes without requesting permissions.
- cua.listApps(options?: { emit?: boolean }) -> { id: string, displayName: string, isRunning: true, pid: number }[] — enumerate running applications.
- cua.findApps(query: string, options?: { emit?: boolean }) -> ({ id: string, displayName: string, path: string } & ({ isRunning: true, pid: number } | { isRunning: false }))[] — search for applications that match the query.
- cua.getState(options?: { emit?: boolean }) -> { apps: { id: string, displayName: string, isRunning: true, pid: number }[], browsers: [] } — summarize running applications; this is not an accessibility observation.
- cua.getApp(selector: string) -> App — select an application using a provider-supported selector and obtain consent. When app-level accessibility is available, selection reads the initial tree silently.
- app.getWindows(options?: { emit?: boolean }) -> { windowId: number, appName: string, title: string, bounds: { x: number, y: number, width: number, height: number }, isOnScreen: boolean, onCurrentSpace: boolean | null }[] — enumerate windows with global native bounds. A null onCurrentSpace means desktop membership is unknown.
- app.getWindow(windowId: number) -> Window — select one window and silently read its initial accessibility tree. Select a window before screenshots or pointer input.
- app.activate() -> ActionResult — request explicit foreground activation; use only when foreground access is required.
- app.show() -> { dispatched: boolean, windowId: number | null, foregroundChanged: boolean | null } — request that the application be shown.
- window.show() -> { dispatched: boolean, windowId: number | null, foregroundChanged: boolean | null } — request that the selected window be shown.

## Accessibility tree
Available at app or window level depending on the platform.

Element ids are opaque strings from the latest successful tree; the object facade keeps one current snapshot per app across its repeated app and window objects, a new read replaces it, and a failed read invalidates the previous one. Repeated strings can appear for different elements, so use IDs from the most recent observation.
- getAccessibilityTree(options?: { emit?: boolean, includeMenus?: boolean, details?: boolean }) -> string — read the full tree text. includeMenus requests menu contents and details requests additional element information.
- listActions(elementId: string) -> string[] — list the actions an element advertises.
- invoke(elementId: string) -> ActionResult — invoke the element's default action; dispatched is false when it has none.
- performAction(elementId: string, action: string, argument?: JsonValue) -> ActionResult — perform an observed action with an optional direct JSON argument.
- setValue(elementId: string, value: JsonValue) -> ActionResult — write a control value.
- selectText(elementId: string, text: string, options?: { prefix?: string, suffix?: string, selectionType?: 'text' | 'cursor_before' | 'cursor_after' }) -> ActionResult — select one literal occurrence or place the cursor beside it, using adjacent context to disambiguate.

## Simulated mouse
Use an explicit window for screenshots and pointer input.
- getScreenshot(options?: { emit?: boolean }) -> { bytes: Uint8Array, mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', pixelWidth: number, pixelHeight: number, windowId: number } — capture the selected window as one encoded image; bytes is a JavaScript byte array, and mimeType identifies its encoding, so do not assume PNG.
- mouseMove(target: string | [number, number], options?: { relative?: boolean }) -> { dispatched: boolean, foregroundChanged?: boolean | null, hoverRoute: 'accessibility' | 'system-pointer', systemPointerMoved: boolean } — request hover at an observed element or window point. Inspect hoverRoute and systemPointerMoved to see how the provider dispatched it.
- click(target: string | [number, number], options?: { mouseButton?: 'left' | 'right' | 'middle', clickCount?: 1 | 2, modifiers?: ('command' | 'control' | 'option' | 'shift' | 'fn')[], holdMs?: number, relative?: boolean }) -> ActionResult — click an observed element or a window point. Set clickCount to 2 to perform a left-button double-click. holdMs controls each press duration.
- scroll(options: { x: number, y: number, deltaLinesX: number, deltaLinesY: number, relative?: boolean }) -> ActionResult — scroll at a point; deltas are integers from -10 to 10 with at least one nonzero, and positive values reveal content above or left.
- drag(from: [number, number], to: [number, number], options?: { mouseButton?: 'left' | 'right' | 'middle', modifiers?: ('command' | 'control' | 'option' | 'shift' | 'fn')[], relative?: boolean }) -> ActionResult — drag between two points of one window.

A string target is an element id; coordinate targets are [x, y] and are pixels in the latest returned screenshot by default. With relative: true they are integer thousandths of the window width and height from 0 to 999, based on the current window observation or screenshot. Left clicks support one or two presses; right and middle clicks support one. Read fresh state after actions, and treat WINDOW_CHANGED, STALE_SNAPSHOT, and SCREENSHOT_REQUIRED as requiring the stated fresh observation or capture before any retry.

## Simulated keyboard
Available at app or window level depending on the platform.
- typeText(text: string) -> ActionResult — type text at the current input focus.
- paste(text: string, options?: { format?: 'text' | 'html' }) -> ActionResult — paste text or HTML at the current input focus.
- pressKey(key: string, modifiers?: string[]) -> ActionResult — press and release one complete keystroke. For example pressKey('Tab', ['shift']) or pressKey('+'). Key and modifier names are platform-defined strings. Pass key and modifiers separately; do not pack them into a chord string.

Raw tools use { method, params }: include appHandle for app calls and windowId for window calls, and use snapshotId with elementId for element routes. The emit option is facade-only: emit is local output control, so raw callers must follow the raw operation schema for admitted params. getAccessibilityTree and getWindow read through raw getState; getWindows maps to listWindows; getScreenshot maps to screenshot; cua.getState maps to listApps; every other named operation uses the same method name.`
