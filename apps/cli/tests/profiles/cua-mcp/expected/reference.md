## cua API reference

Use cua to observe and operate native applications. Always use cua.getCapabilities() to confirm whether a specific API is available on the current platform; its reported capabilities take precedence over availability statements in these instructions. All methods are async. Actions report dispatch evidence, not verified completion. If sessionLocked is true or an operation reports SESSION_LOCKED, stop UI actions and ask the user to unlock the desktop session; null or unknown means verify a usable unlocked desktop session first. cua.getApp requests user consent; if access is denied or revoked, stop using that application until the user explicitly permits another request, and never bypass a refusal or switch tools to avoid it. Never replay uncertain input without a fresh observation.

Call inspect(...values) to display selected observation results.

Signatures show resolved return values after await. ActionResult = { dispatched: boolean, foregroundChanged?: boolean | null }; foregroundChanged is omitted when not sampled and null when the sample is unavailable. JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }; numbers must be finite. App is the application object with readonly app.appHandle: string (opaque) and the methods listed below for app level. Window is the window object with readonly window.windowId: string and the methods listed below for window level. Window IDs are opaque provider-issued strings; preserve them verbatim.

CuaAppInfo = { id: string, displayName: string, identity: string | null, isRunning: boolean, pid?: number }. Pass id unchanged to cua.getApp. For entries sharing the same id, pass identity unchanged or String(pid), when available, to select the intended entry.

Supported modifier names depend on the platform and the operation; see the platform guidance.

Setup and discovery:
- cua.getCapabilities() -> { platform: string, permissions: { accessibility: boolean, screenRecording: boolean }, appLevelAccessibility: boolean, systemInput: boolean, keyboard: ('app' | 'window')[], sessionLocked: boolean | null, methods: string[], coordinateSpace: 'screenshot-pixels', browser: false } — inspect reported permissions, sessionLocked, methods, and keyboard scopes without requesting permissions.
- cua.listApps() -> CuaAppInfo[] — list running applications exposed by the provider.
- cua.findApps(query: string | null) -> CuaAppInfo[] — query is a partial-match search string for discoverable applications, including stopped apps. Discovery does not launch applications. Pass an empty string or null to list all discoverable apps without a match-count limit. Excessive matches for a nonempty query reject instead of truncating. Whitespace-only queries reject; strings are not trimmed. Response-size and operation-time limits still apply.
- cua.getState() -> { apps: CuaAppInfo[], browsers: [] } — return the running application list from listApps(), together with an empty browser list.
- cua.getApp(selector: string) -> App — select an application by a returned id or non-null identity, or by an exact name, bundle ID or absolute path where supported; obtain consent, start a stopped application in the background where launch is supported, and return without reading the accessibility tree or requesting activation.
- app.getWindows() -> { windowId: string, appName: string, title: string, bounds: { x: number, y: number, width: number, height: number }, isOnScreen: boolean, onCurrentSpace: boolean | null }[] — enumerate windows with global native bounds; null onCurrentSpace means unknown Space membership.
- app.getWindow(windowId: string) -> Window — select a window by an ID from getWindows without reading the accessibility tree. Use IDs from the intended app; window validation follows platform rules.
- app.launch() -> ActionResult — request launch of a new application instance.
- app.activate() -> ActionResult — request explicit foreground activation; use only when foreground access is required.
- app.show() -> { dispatched: boolean, windowId: string | null, foregroundChanged: boolean | null } — show an application window. Use the returned windowId to select it.
- window.show() -> { dispatched: boolean, windowId: string | null, foregroundChanged: boolean | null } — show the specified window.

## Accessibility tree
Available at app or window level depending on the platform.

Read getAccessibilityTree explicitly before using element ids. Selection and screenshots do not read or replace the current accessibility snapshot. Element ids are opaque strings from the latest successful tree; the object facade keeps one current snapshot per app across its repeated app and window objects, a new read replaces it, and a failed read invalidates the previous one. Repeated strings can appear for different elements, so do not reuse an old id blindly, and element operations do not fall back to pointer input or typing.
- getAccessibilityTree(options?: { includeMenus?: boolean, details?: boolean, showDiff?: boolean, maxElements?: number, maxDepth?: number }) -> string — set the node count or depth for one read. Omitted limits use the provider settings. includeMenus expands menu contents and details adds identifiers, native bounds, and complete action names.
- listActions(elementId: string) -> string[] — list the actions an element advertises.
- getActionSchema(action: string) -> JSON Schema — query the parameter schema for an action.
- invoke(elementId: string) -> ActionResult — invoke the element's default action; dispatched is false when it has none.
- performAction(elementId: string, action: string, argument?: JsonValue) -> ActionResult — perform an observed action with an optional direct JSON argument.
- setValue(elementId: string, value: JsonValue) -> ActionResult — write a control value.
- selectText(elementId: string, text: string, options?: { prefix?: string, suffix?: string, selectionType?: 'text' | 'cursor_before' | 'cursor_after' }) -> ActionResult — select one literal occurrence or place the cursor beside it, using adjacent context to disambiguate.

## Screenshots
Use an explicit window for screenshots.
- getScreenshot() -> Image — capture the selected window as a stored image with readonly attachmentId, path, width, and height. Pass selected screenshots to inspect(...values) to display them; read the window ID from window.windowId.

## Simulated mouse
Use an explicit window for pointer input. Before coordinate input, including relative coordinates, obtain a successful getAccessibilityTree observation covering that window or take its screenshot. Absolute pixel coordinates require a returned screenshot.
- mouseMove(target: string | [number, number], options?: { relative?: boolean }) -> { dispatched: boolean, foregroundChanged?: boolean | null, hoverRoute: 'accessibility' | 'system-pointer', systemPointerMoved: boolean } — request a mouse move to the target without pressing a button; inspect hoverRoute and systemPointerMoved, and expect no automatic pointer restoration.
- toggleMouse(mouseButton: 'left' | 'right' | 'middle', direction: 'down' | 'up') -> ActionResult — press or release the specified mouse button at the current pointer position without moving it. No coordinates are accepted. Send 'up' to release a held button immediately.
- click(target: string | [number, number], options?: { mouseButton?: 'left' | 'right' | 'middle', clickCount?: 1 | 2, modifiers?: Modifier[], holdMs?: number, relative?: boolean }) -> ActionResult — click an element id or point, or perform a left-button double-click; holdMs controls the press duration of each press.
- scroll(options: { x: number, y: number, deltaLinesX: number, deltaLinesY: number, relative?: boolean }) -> ActionResult — scroll at a point; deltas are integers from -10 to 10 with at least one nonzero, and positive values reveal content above or left.
- drag(from: [number, number], to: [number, number], options?: { mouseButton?: 'left' | 'right' | 'middle', modifiers?: Modifier[], relative?: boolean }) -> ActionResult — drag between two points of one window.

A string target is an element id; coordinate targets are [x, y] and are pixels in the latest returned screenshot by default. With relative: true they are integer thousandths of the window width and height from 0 to 999, based on the current accessibility observation or screenshot. Left clicks support one or two presses; right and middle clicks support one. FOREGROUND_REQUIRED means explain the need, then explicitly activate the target and observe again; activation is never automatic. Read fresh state after actions, and treat WINDOW_CHANGED, STALE_SNAPSHOT, and SCREENSHOT_REQUIRED as requiring the stated fresh observation or capture before any retry.

## Simulated keyboard
Available at app or window level depending on the platform.
- typeText(text: string) -> ActionResult — type literal text at the app's current focus; line endings send Return and tabs send Tab.
- paste(text: string, options?: { format?: 'text' | 'html' }) -> ActionResult — deliver text or HTML through the app's Paste command, restoring prior clipboard contents unless another writer changes them; a Paste failure is surfaced without substituting typeText, and PASTE_NOT_CONSUMED means inspect before any retry.
- pressKey(key: string, modifiers?: Modifier[]) -> ActionResult — press and release one complete keystroke. For example pressKey('Tab', ['shift']) or pressKey('+'). Key names are platform-defined strings. Pass key and modifiers separately; do not pack them into a chord string.
- sendKeyEvent(key: string, direction: 'down' | 'up') -> ActionResult — send one key-down or key-up event; key accepts a single key name, including a modifier.

Explicit downs from sendKeyEvent and toggleMouse remain held across programs and turns until an explicit up releases them through the same target. After a successful run_code or cua_run_code, a system reminder lists any remaining keys and mouse buttons, their targets and input modes. No reminder is added when none remain. Program failure, a received cancellation, connection closure, and disposal release owned inputs together in reverse dispatch order. After a DSH stop, the next CUA operation waits for any pending cleanup. A client pause between completed MCP calls is not observable by the server, so held input can remain pressed. pressKey, typeText, click, and complete drag release their own inputs within the operation.

click, drag, and pressKey are convenience operations; sendKeyEvent, mouseMove, and toggleMouse are primitive operations. For complex action combinations, decompose convenience operations into sequences of primitive operations supported by the current platform.

Accessibility tree defaults: maxElements=2000, maxDepth=25.

Maximum click holdMs: 5000 ms.
