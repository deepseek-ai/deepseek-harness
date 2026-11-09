---
description: "Inspect and operate native macOS applications through scoped app and window objects."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-cua-macos

English | [中文](README.zh.md)

## Summary

Inspect macOS permissions, select running applications and windows, read accessibility trees, capture screenshots from a selected window, and send input. The object API can be retained by an external persistent execution environment. The Swift helper uses macOS frameworks directly and adapts selected MIT-licensed Cua Driver behavior. This package owns neither a PTC runtime nor variable persistence.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

The helper supplies bounded 64-pixel PNG application icons for permission prompts and saved-application lists. Icon reads do not launch an application or inspect its windows; icons do not determine reusable consent.

The helper runs through LaunchServices as an independent application: `DSH Computer Use.app` for release builds and `DSH Computer Use Dev.app` for source builds. Accessibility and Screen Recording permissions belong to this application. Permission guidance uses the responsible application’s bundle URL, identifier, filename, and system icon captured at startup; unavailable system attribution falls back to the independent helper’s own bundle. Dragging and Finder selection read the current on-disk bundle identifier and executable through the application-discovery reader. The page and guide both display the application’s `.app` filename. Existing connections retain their running application generation when another build updates `current.json`. When bundled inside another `.app`, it starts from a verified standalone copy; see [application storage](native/README.md#build-and-service).

Permission requests open the selected privacy pane and a native floating guide. The guide selects the largest settings window once and follows that window by ID. It uses the normal window level, ordered immediately above the selected window so authentication dialogs remain above it. Placement reads window bounds without requesting Accessibility access. The guide stays hidden until the settings window is identified; a failed settings-open request displays manual navigation instructions independently. A material alpha mask gives the panel and its shadow rounded corners. The latest request replaces the shared guide, and only its owning connection can close it during cleanup. Navigation is attempted even when the application is unavailable, and the page reports that failure. Already-granted permissions open settings without a guide; explicit settings navigation dismisses previous guidance. A rejected settings-open request reports `SETTINGS_UNAVAILABLE`; missing or replaced application targets report `APPLICATION_UNAVAILABLE`. System Settings owns drag acceptance and any relaunch requirement.

The provider resolves guide and recovery copy from the current Client language, with English for unsupported languages. Drag the guide’s application row into the permission list and enable its switch; enable the existing entry when already listed. The guide hides during dragging, closes when a drop is accepted, and returns after a canceled or rejected drag. The back button closes it and returns to the previous application. Right-click the row, or click it for keyboard focus and press Return or Space, to reveal the bundle in Finder. While open, the guide checks permission and window position every `permissionPollIntervalMs` (default 1000 ms), and closes after a confirmed grant, dismissal, disappearance of the settings window, or its owning connection’s cleanup. Dragging does not establish consent. Follow any macOS quit-and-reopen prompt; the shared helper is not automatically terminated.

-----

<a id="use-this-package"></a>
## Use this package

This package is an optional macOS dependency. For local development, run `pnpm --dir packages/experimental/cua-macos run build:native` to generate an ad-hoc-signed application and `current.json` under `native/bin`. Release packaging requires `--identity "Developer ID Application: <name> (<team>)"` and notarization; see [native build and service](native/README.md#build-and-service). Installed packages preserve the distributed signature. A package inside an Electron `app.asar` archive reads its application from the sibling `app.asar.unpacked` directory, which the Desktop installer populates; an installed package without the application fails preparation with an error naming the expected directory. Source preparation requires Swift and Python 3 from Apple Command Line Tools.

For repository Web use, enable [Computer Use](../cua-bundle/README.md) in Plugins. This prepares the local executable on macOS 14 or later. Subsequent builds check it while the existing Web profile keeps the bundle selected. Disabled profiles do not prepare native components. Explicit source composition is also available:

```sh
pnpm dsh headless --patch packages/experimental/cua-macos/examples/macos.cordis.yml --dump-config
```

The dump command checks profile composition without a model request. For a real task, replace `--dump-config` with a prompt and configure the profile’s model credentials. The overlay mounts the computer-use registry and this provider; remove an existing competing provider before using it. The helper needs Accessibility permission for AX/input and Screen Recording permission for capture; use the Computer Use permission page to open System Settings and add the helper. Source builds use the bundle filename `DSH Computer Use Dev.app` and declare `DSH Computer Use Dev` in Info.plist; select the development entry when granting access. `getCapabilities` returns the provider’s declared capabilities with observed permissions and session lock state. Locked or unavailable desktop sessions reject UI observations and input before dispatch; the user must unlock macOS before resuming. `listApps` and `cua.getState` list running applications. `findApps(query)` searches standard macOS application directories by name, bundle ID or absolute path. `getApp` selects a unique name, bundle ID, path or running PID, obtains application consent, and launches a stopped app in the background when needed. A stopped application’s bundle identifier and executable path are read from disk before approval and rechecked before and after launch; applications without a bundle identifier use their canonical executable path for reusable consent. Selecting a stopped installation requests a new instance of that copy. The helper waits for launch to complete before reporting the running state. A post-launch verification failure expires the pending handle but can leave the process running; inspect running applications before selecting a fresh handle. The returned object reads initial AX silently without activating the app. Launch cancellation may leave the application running. Model guidance starts with background observation and input, without activation during initialization or before each action. For hidden or minimized windows, try `app.show()` or `window.show()` and read fresh state. This requests unhide and unminimize without activation, raising or switching Spaces; app-level restoration selects the focused, main or sole AX window. The result names the selected `windowId`, or null when no window was selected, and reports `foregroundChanged` by comparing the front app and top window before and after the request. Null means foreground evidence was unavailable; later focus changes remain possible. If restoration fails or the window remains unusable, explain the needed foreground step, call `app.activate()` or an observed window’s advertised `AXRaise` action, then observe again. Necessary foreground access takes priority over preserving focus. Applications may change focus after input; background delivery does not guarantee an undisturbed user session.

Source builds default to `sourceSigning: ad-hoc`, without creating certificates or keychains. Changed binaries can require new permission grants. To reduce repeated grants during rebuilds and across worktrees, select an existing certificate and its absolute keychain path in the DSH home’s `cordis.patch.yml`; `cua` is the entry ID loading `@deepseek-ai/dsh-experimental-cua-macos`:

```yaml
- id: cua
  config:
    sourceSigning:
      identity: "<certificate SHA-1 fingerprint>"
      keychain: "/Users/<user>/.cua-macos-keys/dev/signing.keychain-db"
```

`identity` is an existing certificate name or SHA-1 fingerprint; `keychain` is a required absolute path. Developers own creating and unlocking the keychain; builds only use the selected certificate. Preserve the entry’s other configuration fields when merging this patch. The repository’s [developer signing skill](../../../.agents/skills/dsh-cua-macos-signing/SKILL.md) guides Agents through creating, reusing, and removing identities under `~/.cua-macos-keys/`, with only their selection stored in DSH home.

| Field | Default | Meaning |
| --- | --- | --- |
| `agentPreset` | `ptc` | Register tools and guidance only for Agents bound to this preset; `false` registers globally. |
| `allowedApps` | `[]` | Legacy path/signature grants, imported once for removal; they do not authorize new bundle-ID identities. |
| `helperPath` | package-owned executable | Absolute executable inside the signed helper `.app`; a bare binary fails with `NATIVE_APPLICATION_REQUIRED`. |
| `requireSystemPointerApproval` | `true` | Ask on the first explicit request to move the system pointer. With `false`, only explicitly requested moves use it. |
| `sourceSigning` | `ad-hoc` | Source signing: `ad-hoc`, or `{ identity, keychain }` for an existing certificate and keychain path. Ignored for installed packages and `helperPath`. |
| `buildTimeoutMs` | `300000` | Maximum native preparation time. |
| `timeoutMs` | `30000` | Per-operation deadline; cancellation can leave partial input. |
| `connectTimeoutMs` | `5000` | Deadline for connecting to or starting the shared helper. |
| `permissionPollIntervalMs` | `1000` | Interval in milliseconds between permission and position checks while the native guide is open. |
| `screenshotTimeoutMs` | `5000` | Screenshot deadline including queue time, capped by `timeoutMs`. |
| `axTimeoutMs` | `3000` | Deadline per Accessibility system call, configured independently of the complete operation. |
| `maxRequestBytes` / `maxResponseBytes` | `1048576` / `33554432` | UTF-8 request and response limits. |
| `maxClipboardBytes` | `33554432` | Maximum original clipboard bytes preserved during a paste; oversized contents reject before replacement. |
| `pasteReadTimeoutMs` | `1000` | Clipboard read deadline after the Paste command returns; expiry reports `PASTE_NOT_CONSUMED`. |
| `maxAppMatches` | `20` | Maximum installed-app search matches; broader queries reject and require a narrower name. |
| `maxElements` / `maxDepth` | `5000` / `50` | Defaults for tree reads. Each read can raise or lower either value. Paste menu discovery always uses the configured limits. [Rationale](../../../.agents/notes/implemented/architecture/2026-11-09-cua-ax-traversal-defaults.md) |
| `maxClickHoldMs` | `5000` | Maximum explicit click hold in milliseconds; accepts nonnegative integers. Zero only permits immediate release. |
| `dragDurationMs` / `dragSteps` | `400` / `20` | Duration and movement segments for a drag. |
| `textEventIntervalMs` | `0.25` | Delay after each Unicode down/up event, from 0 to 999 ms. Keystroke timing is independent. |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-cua-macos) lists all fields. Native tool calls use `{method, params}`; the complete method-specific schema is exposed to the model. `getApp` returns the `appHandle` used by every app-targeted operation, and `app.getWindow(windowId)` returns the object that owns screenshots and pointer input.

`pressKey(key, modifiers?)` presses and releases one key. For shortcuts, pass held modifiers separately, as in `pressKey('a', ['command'])`. Pressing a modifier itself, as in `pressKey('shift')`, sets its flag on press and clears it on release. A single `+` or `plus` sends Shift+=. The macOS helper accepts `command`/`cmd`, `shift`, `option`/`alt`, `control`/`ctrl`, and `fn`, and maps them to their physical keys. Key names are platform-defined; keypad names (`KP_0` through `KP_9`, `KP_Enter`, and keypad operators) retain their physical key codes. `typeText` sends literal text, including its line breaks and tabs. Use the App object's `pressKey` for a short press.

For a long press, call `app.sendKeyEvent('w', 'down')` inside `run_code`. The first down holds the key across subsequent tool calls. For an ordinary key already held by this execution, each additional down sends one key-down marked as a repeat to the original process. Choose the interval between calls. A control can filter synthetic repeats, so check its response. One up releases the key. Choose when to send each up: after W down, D down and D up, W stays down. When the program returns, exits with an error, or the user pauses it, the helper releases the remaining keys at the processes that received their downs. A later execution cannot release an earlier execution's keys.

Agent disposal and plugin unload cancel and await the complete tool call, including image admission and attachment storage. An image write already in progress must settle before disposal returns; a canceled call cannot return a successful screenshot.

Application consent is enforced before AX reads, window-title reads, screenshots, activation, and input through the CUA tool. The first selection asks the human for session access, denial, or saved access when profile persistence is available. Session access is stored by conversation and application identity and survives DSH restart and Computer Use disablement. Other conversations require their own consent. Application identities use the case-sensitive bundle identifier, so versions and copies at different paths share consent and revocation regardless of signing. A valid running bundle identifier remains sufficient when the operating system cannot supply an executable path. Available paths are still checked against the selected target; process-instance and window ownership checks remain mandatory. Without a bundle identifier, consent requires the canonical executable path. Restarting or updating at that path retains consent; moving or copying the executable to another path requires a new decision. This policy does not authenticate the publisher: another program declaring the same identifier, or replacing an approved executable at the same fallback path, inherits consent. Denial prevents repeated prompts in that session. Revocation reads and removes saved access in the same queue as grant creation, invalidates each affected Agent connection, and awaits its native cleanup without replaying input. Every app handle on those Agent connections becomes unusable; other applications need fresh selection, but their session and saved grants remain reusable. See the [application consent decision](../../../.agents/notes/implemented/architecture/2026-09-26-cua-application-consent.md). These checks govern CUA calls; persistent PTC and separately authorized shell tools are not an operating-system sandbox.

Raw `getState` exposes validated state fields and the complete text for the requested disclosure options. The native helper also returns structured element diagnostics with opaque string `elementId` values for native checks; the tool projection omits that duplicate array from model text and structured tool values.

AX observations show menu-bar entries by default. Use `app.getAccessibilityTree({ includeMenus: true })` to expand menu contents and `app.getAccessibilityTree({ details: true })` for identifiers, global-point bounds and complete action names. These options also apply to raw `getState`. Every read replaces the application's current snapshot; use element IDs from that read. Pass `maxElements` or `maxDepth` to override either configured limit for one read. Truncation identifies the reached limit.

Values and placeholders are separate. Named, stateful or actionable groups and scroll areas retain their own rows. Repeated names, descriptions and help text on one node are shown once. Values, placeholders and URLs keep their distinct meanings even when their text matches; body text shared by distinct nodes remains intact. Writability is explicit on relevant controls, including `AXIncrementor`; `unknown` means the system did not report it. Missing optional state fields do not imply false. UTF-16 ranges outside the observed value are marked unavailable. Compact tree labels can omit AppKit target and selector details. Pass the exact name returned by `listActions(elementId)` to `performAction`.

Observations emit by default and also return their value. In persistent PTC, use `void await app.getAccessibilityTree()` for one emitted copy, or `emit:false` and one explicit print. Capturing a screenshot after an emitted tree can fail independently; retain the successful AX output.

Screenshot diagnostics use `[cua-screenshot]` records keyed by the tool request ID. Native phase records return over the originating Agent connection and cover window/AX geometry checks, system capture, PNG/Base64 encoding and response writing. Host debug logs add dispatch, reply and cleanup timings. Each request retains at most 8192 bytes of complete diagnostic records, with explicit truncation; screenshot failures append these records to the error for Session export. Records contain stages, timings and error codes, not window titles, AX text or image bytes.

Native preparation serializes building and signing with a file lock. It retains complete applications under content-addressed `native/.build/prepared` directories and atomically selects a generation through `current.json`. Existing connections retain their application; identical builds reuse its files, and corrupted copies are rejected. Cancellation and failure finish managed process cleanup before releasing the lock.

### Connect an external execution environment

To run through persistent PTC, add `--patch packages/experimental/cua-macos/examples/persistent-ptc.cordis.yml` after the macOS overlay. This provider keeps variables for the live Agent and applies the selected file sandbox policy. The caller imports the bridge and supplies the current authorized `tools.cua` binding. Persistent PTC receives an installation-owned bridge file URL in its CUA instructions, so the project does not need to install this package. The example below is for an external host that resolves the package from its own installation and supplies `tools`; the package does not install a global object or keep variables alive:

```javascript
import { connectCua } from '@deepseek-ai/dsh-cua/bridge'
const cua = connectCua(() => tools.cua, text => console.log(text))
const app = await cua.getApp("com.apple.TextEdit")
const windows = await app.getWindows()
if (windows.length === 0) throw new Error("Open a TextEdit window first")
const window = await app.getWindow(windows[0].windowId)
void await window.getScreenshot()
```

Use the `cua` API to discover and select the application (`listApps`, `getState`, `findApps`, `getApp`); use the selected app to activate it, enumerate its windows, and select one. Window selection is required for screenshots and pointer input, not only when several windows exist. `getApp` and `app.getWindow(windowId)` read their initial trees silently; choose the window by its observed title and bounds.

`getWindow` reads its initial tree silently. An owned window without an AX surface returns an empty snapshot and remains available for screenshots and coordinate input. Within one API instance, the facade keeps one current accessibility snapshot per application handle, shared by every app and window object for that handle, including repeated selections. Reading any window replaces that snapshot; element operations use the latest snapshot ID, so use IDs from the latest tree and do not assume an older ID still identifies the same control. A failed read publishes no partial snapshot; read again without repeating the preceding input. Window objects own screenshots and pointer input. Keyboard methods stay on `app` because input follows the app’s current focus.

Ordinary `mouseMove(target)` defaults to AX hover. Without both `AXShowAlternateUI` and `AXShowDefaultUI` on an enabled target or ancestor, it returns `HOVER_UNAVAILABLE` without prompting. Only when the task requires physical movement should the main task call `win.mouseMove(target, { useSystemPointer: true })`. On approval the Host rechecks the window and point and dispatches this move. Pass `useSystemPointer: true` on every physical move. Later explicit moves reuse the decision until the session closes or DSH restarts. Omitting the option or passing `false` uses AX. Refusal sends no input.

`paste(text, { format: "text" | "html" })` temporarily publishes the requested clipboard format and invokes the application’s enabled standard Paste menu command. It keeps the temporary format until a pasteboard reader requests its data, then restores every captured original format while it still owns the clipboard, preserving a later copy. Paste operations share a cross-process lock and cancellation joins helper cleanup. A forced process exit can prevent restoration. Unsupported Paste commands fail without typing fallback; `typeText` remains separate key-event input.

`selectText` selects a unique literal occurrence or places the cursor before/after it through writable `AXSelectedTextRange`. Adjacent prefix/suffix disambiguate repeats. Selection preserves the remaining text and formatting, and verifies the resulting UTF-16 range; unsupported, missing, ambiguous or changed text fails without keyboard fallback. AX text includes `selectionWritable`, selection ranges and selected text when available.

Screenshot capture requires an attachment store and a resolved model route declaring image input. The shared attachment admission validates canonical Base64, the raster and its configured capacity, then stores the image once. Native data remains available to programmatic callers; model content carries coordinate metadata and the durable image reference. Response byte limits apply before parsing.

Use `win.click(id)` to send mouse events at the center of an element, or `win.click([x, y])` to click a point. For both `click(id)` and `mouseMove(id)`, the element must belong to the selected window. Prefer `invoke(id)` for a background control’s default action. For mouse input, activate the application and observe the target first. Mouse clicks on system Open and Save sheets are routed to their verified panel-service window. On macOS 14.2 and later, a window screenshot excludes its attached window group so the image uses the selected window’s bounds.

Absolute coordinates for `mouseMove`, `click`, and `drag` use `[x, y]` tuples; `scroll` uses named `x` and `y`. All use pixels in the latest returned screenshot. Pass `relative: true` for integer thousandths of window width and height, from 0 to 999; omission or `false` uses pixels. Relative input can use a successful AX read or screenshot, while absolute input requires a screenshot. The Host maps the delivered image to native points, including attachment and model-request resizing. A value of 999 remains inside the window edge. Coordinate options do not apply to element IDs. A width or height change since the latest observation returns `WINDOW_CHANGED` before input, including raw coordinate calls without a snapshot ID; read fresh AX or take a new screenshot before proceeding. Window movement alone preserves window-local coordinates. Capture and pointer input reject known disagreement between the selected window’s accessibility frame and displayed bounds with `WINDOW_CHANGED`, before posting pointer events. This includes Stage Manager transformations when AX retains the full window frame. Read fresh state; any activation or window raise remains explicit. Advertised AX actions remain available. Missing AX geometry retains the AXless path and does not establish that a transformed window can be operated.

Retained objects resolve the current tool binding on every call. The external runtime owns persistence, imports, cancellation and completion-value serialization. Screenshots return encoded bytes with their MIME type, pixel dimensions and window ID; the standard tool pipeline admits the image attachment exactly once. `emit: false` suppresses facade output only. A host that uses another dispatcher can build objects through `createCuaApi` from `./api`.

An AppKit sheet can appear in its document window’s tree with a separate window ID. For pointer input on the sheet, use `app.getWindow(sheetId)` and an element ID from that window’s tree. Keyboard input follows a system Open/Save panel only when the application’s focused sheet identifies one Apple panel-service window and that service still focuses the same panel. Unrelated or ambiguous remote recipients fail before dispatch.

Element clicks use opaque element IDs from the current snapshot. Left clicks support a single or double click; right and middle clicks support one. Click and drag options accept a button and modifier names. Drags hold that button and carry its modifiers through every movement and release. AX text marks disabled controls, `valueWritable=true`, and available `selected` state. Actions report dispatch, not application success. A visual pointer or click marker can be rendered independently of input; AX actions do not require moving the system cursor. Window-directed mouse input can still change application focus, selection or dialogs. Read state after input. `STALE_APP` requires acquiring the application again; `STALE_SNAPSHOT` requires a fresh AX read. Request timeout/cancellation waits for native acknowledgement and preserves usable handles. Missing cleanup acknowledgement closes that Agent’s connection. A screenshot RPC still awaiting its system callback occupies the single capture slot; further screenshots return `CAPTURE_BUSY`, while AX and input remain available. A late capture result is discarded, and its real completion releases that slot. Only an unresponsive operation or failed cleanup can invalidate the shared process and all its handles. Never retry uncertain input automatically. Closing an Agent releases its connection and AX references, without undoing changes to applications.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Dispatch and resource ownership</summary>

The object facade translates app/window methods into JSON operations. Within one API instance it keeps one current accessibility snapshot per application handle, while the native helper retains its own application and optional-window snapshots behind it. The bridge routes operations through the normal tool pipeline, preserving authorization, nested logs and image admission. Agents and Hosts belonging to one user share a helper for the same native build. Each connection retains independent handles, snapshots, configuration and cancellation state; desktop operations use a global queue. The managed launcher transfers service lifetime to these connections, and the helper exits after the last connection finishes cleanup. Process locks cover both build identity and the real executable path, preventing duplicate startup and path collisions after a running executable is replaced. Native handles bind a process identity to its kernel start time, and snapshots retain native AX references only inside that helper.

[Zod operation definitions](../cua/src/protocol.ts) own model parameters and separately declare Host resource fields and private continuations. Public data types derive from those definitions. `pnpm exec tsx packages/experimental/cua-macos/native/generate-protocol.ts` generates the native JSON Schema and Swift field/enum admission tables; the package test lane checks freshness and rejects Host-only fields at model admission. Native target validation, resource limits and operation behavior remain enforced at execution.

[AX text formatting](native/Sources/CuaNative/AXTextFormatter.swift) consumes already-read node data. The AX walker alone assigns opaque element IDs and retains native references, so formatting owns no second snapshot or target registry.

Native request IDs match the logged tool call IDs. Successful activation results retain foreground request details and immediate before/after focus observations in the raw tool result. An already-frontmost app skips redundant activation. Unknown observations retain the requested operation. These observations do not establish who caused an unrelated focus change or verify completion.

Node roles and metadata share one AX batch per observation. Group and scroll-area nodes contribute only children; unused metadata errors do not reject them. Unsupported batching retains individual attribute reads. AX traversal visits each native identity once, including proxy references that compare equal, so cyclic accessibility children cannot repeat whole subtrees. The [source manifest](native/upstream.json) records adapted upstream behavior and local Swift modules. AppKit runs on the main event loop; a separate serial executor owns AX references and synchronous input. A request retains exclusive execution through capture and response delivery. No invariant companion is published: there is no independently projected registry or durable evaluator state to reconcile. Protocol validation, target identity and resource cleanup are checked by their owning implementations.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Computer-use registration](../../computer-use/computer-use/README.md)
- [Native protocol](native/protocol.schema.json)
- [Object interfaces](../cua/src/types.ts)

-----

<a id="model-experience"></a>
## Model Experience

### Native application operations

#### What the model sees

The plugin contributes one `cua` operation tool with method-specific parameters. Standard PTC presentation exposes it as `tools.cua` through `run_code`. The following package-owned guidance is emitted verbatim:

##### Operation guidance (verbatim)

```markdown
macOS: accessibility tree operations are available at app or window level. Simulated keyboard input is available at app level. Simulated mouse input is available at window level. For pointer input on a sheet, select its window ID with app.getWindow(id). For menu items outside a window, use app.invoke(id). findApps searches /Applications, /System/Applications, and ~/Applications. Use the Computer Use permission page to grant the helper application Accessibility and Screen Recording permissions in System Settings. Native window and AX bounds use macOS points, while delivered screenshots carry their own pixel dimensions. show does not switch Spaces, and Stage Manager can present reduced window geometry; explain any required foreground step before calling app.activate() or performing an advertised AXRaise action.

Use cua to observe and operate native applications. Always use cua.getCapabilities() to confirm whether a specific API is available on the current platform; its reported capabilities take precedence over availability statements in these instructions. All methods are async; observation options default to { emit: true }, and emit: false suppresses sink output only, leaving returned values unchanged. Actions report dispatch evidence, not verified completion. If sessionLocked is true or an operation reports SESSION_LOCKED, stop UI actions and ask the user to unlock the desktop session; null or unknown means verify a usable unlocked desktop session first. cua.getApp requests user consent; if access is denied or revoked, stop using that application until the user explicitly permits another request, and never bypass a refusal or switch tools to avoid it. Never replay uncertain input without a fresh observation.

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
- getAccessibilityTree(options?: { emit?: boolean, includeMenus?: boolean, details?: boolean, maxElements?: number, maxDepth?: number }) -> string — set the node count or depth for one read. Omitted limits use the provider settings. includeMenus expands menu contents and details adds identifiers, native bounds, and complete action names. macOS accepts maxElements up to 100000 and maxDepth up to 512. If the tree is truncated, select a narrower window or raise the reported limit on the next read. In persistent PTC, capture a large tree with const tree = await win.getAccessibilityTree({ emit: false }). Filter its lines in memory, or save it with await tools.write({ file_path: path, content: tree }) to a new workspace file. Search its contents with tools.grep({ path, pattern }) and use tools.read around a matching line. Print only the matches you need. Use element ids from the file only while that observation is current.
- listActions(elementId: string) -> string[] — list the actions an element advertises.
- invoke(elementId: string) -> ActionResult — invoke the element's default action; dispatched is false when it has none.
- performAction(elementId: string, action: string, argument?: JsonValue) -> ActionResult — perform an observed action with an optional direct JSON argument.
- setValue(elementId: string, value: JsonValue) -> ActionResult — write a control value.
- selectText(elementId: string, text: string, options?: { prefix?: string, suffix?: string, selectionType?: 'text' | 'cursor_before' | 'cursor_after' }) -> ActionResult — select one literal occurrence or place the cursor beside it, using adjacent context to disambiguate.

## Simulated mouse
Use an explicit window for screenshots and pointer input.
- getScreenshot(options?: { emit?: boolean }) -> { bytes: Uint8Array, mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', pixelWidth: number, pixelHeight: number, windowId: number } — capture the selected window as one encoded image; bytes is a JavaScript byte array, and mimeType identifies its encoding, so do not assume PNG.
- mouseMove(target: string | [number, number], options?: { relative?: boolean, useSystemPointer?: boolean }) -> { dispatched: boolean, foregroundChanged?: boolean | null, hoverRoute: 'accessibility' | 'system-pointer', systemPointerMoved: boolean } — request a mouse move to the target without pressing a button; inspect hoverRoute and systemPointerMoved, and expect no automatic pointer restoration. Default hover requires both AXShowAlternateUI and AXShowDefaultUI on an enabled element or ancestor. Without that route, HOVER_UNAVAILABLE is returned before sending input. Physical movement requires an unobscured foreground target. Explain any necessary activation and observe the target again.
- click(target: string | [number, number], options?: { mouseButton?: 'left' | 'right' | 'middle', clickCount?: 1 | 2, modifiers?: ('command' | 'control' | 'option' | 'shift' | 'fn')[], holdMs?: number, relative?: boolean }) -> ActionResult — click an element id or point, or perform a left-button double-click; holdMs controls the press duration of each press. click is a Window method: select a window with const win = await app.getWindow(windowId), then call win.click(target). For a background control’s default action, use app.invoke(id). For a mouse click on a background app, call app.activate() first and re-read the target. Both target forms send mouse-down and mouse-up events. click(id) uses the center of the full element bounds. If that center is outside the window, take a fresh win.getScreenshot() and use click([x, y]) on a visible part of the control in screenshot pixels. A background app can ignore the events even when dispatched is true. Verify the expected effect, such as a changed selection, before typing or retrying.
- scroll(options: { x: number, y: number, deltaLinesX: number, deltaLinesY: number, relative?: boolean }) -> ActionResult — scroll at a point; deltas are integers from -10 to 10 with at least one nonzero, and positive values reveal content above or left.
- drag(from: [number, number], to: [number, number], options?: { mouseButton?: 'left' | 'right' | 'middle', modifiers?: ('command' | 'control' | 'option' | 'shift' | 'fn')[], relative?: boolean }) -> ActionResult — drag between two points of one window.

A string target is an element id; coordinate targets are [x, y] and are pixels in the latest returned screenshot by default. With relative: true they are integer thousandths of the window width and height from 0 to 999, based on the current AX observation or screenshot. Left clicks support one or two presses; right and middle clicks support one. FOREGROUND_REQUIRED means explain the need, then explicitly activate the target and observe again; activation is never automatic. Read fresh state after actions, and treat WINDOW_CHANGED, STALE_SNAPSHOT, and SCREENSHOT_REQUIRED as requiring the stated fresh observation or capture before any retry.

## Simulated keyboard
Available at app or window level depending on the platform.
- typeText(text: string) -> ActionResult — type literal text at the app's current focus; line endings send Return and tabs send Tab.
- paste(text: string, options?: { format?: 'text' | 'html' }) -> ActionResult — deliver text or HTML through the app's Paste command, restoring prior clipboard contents unless another writer changes them; a Paste failure is surfaced without substituting typeText, and PASTE_NOT_CONSUMED means inspect before any retry.
- pressKey(key: string, modifiers?: string[]) -> ActionResult — press and release one complete keystroke. For example pressKey('Tab', ['shift']) or pressKey('+'). Key and modifier names are platform-defined strings. Pass key and modifiers separately; do not pack them into a chord string.
- sendKeyEvent(key: string, direction: 'down' | 'up') -> ActionResult — send 'down' to hold a key across tool calls in one run_code, for example W down, D down, D up, W up. Holding a key on a physical keyboard can produce repeated key-down events after a delay. To send one such repeat for a non-modifier key this run already holds, send 'down' again. Each call posts one event. A control can filter repeats. Use the app's response to decide whether and when to repeat or release the key. When this run_code returns, throws, or the user pauses it, macOS releases only its remaining keys at their original recipients.

Raw tools use { method, params }: include appHandle for app calls and windowId for window calls, and use snapshotId with elementId for element routes. The emit option is facade-only: emit is local output control, so raw callers must follow the raw operation schema for admitted params. getAccessibilityTree and getWindow read through raw getState; getWindows maps to listWindows; getScreenshot maps to screenshot; cua.getState maps to listApps; every other named operation uses the same method name.

Only if the task cannot be completed without moving the user’s pointer, call await win.mouseMove(target, { useSystemPointer: true }). Prefer an advertised accessibility action, a click on a visible control, or browser tools when possible. The question interrupts the user. When approval is disabled an explicit move can act immediately. Pass true on every physical move, even after approval. Omitting the option or passing false uses the default hover route without prompting. Approval or refusal lasts until this session closes or DSH restarts. A refusal sends no input. If the user dismisses the request, ask again only if they request it. Wait for an outstanding request to finish. Subagents cannot request physical movement.
```

#### Token effect

Enabling the plugin adds a fixed schema and guidance. AX observations, operation results and admitted images add model input. Retained objects are not serialized into prompts by this package. A higher default or per-read override can include more AX text in model input when the window has more nodes to visit.

#### KV Cache effect

Tool results append to Session history. Changing plugin configuration or tool presentation can change the request prefix; retaining an app object does not change existing history.

## Known Limitations and Deferred Work

The native operation deadline (`timeoutMs`), per-AX-call timeout (`axTimeoutMs`), and response size limit (`maxResponseBytes`) still apply to larger tree reads.

The queue orders individual native requests. Holding an app object does not reserve its application across a Session; [continuous interaction](../../../.agents/notes/implemented/architecture/2026-10-13-cua-continuous-hover.md) grants no cross-call ownership. Capture RPCs that never return occupy the single capture slot; creating new app objects does not reset that system connection.

<a id="known-limitations-and-deferred-work"></a>

- macOS 14 is the minimum supported version; settings navigation, drag acceptance, and permission refresh require qualification on each supported release. If macOS requires quitting and reopening the helper after a Screen Recording change, its preflight check can remain denied until that restart. The guide can be dismissed without terminating other connections.
- The guide closes when its selected settings window leaves the visible-window list, including when a Space switch or minimization removes it. Request permission again after returning to reopen the guide.
- Only the macOS native implementation is provided. Windows support is in development; this package remains in `experimental` until that support is complete, then moves to the `computer-use` group. Browser tabs, AX diffs, unassociated system panels and accessory-only apps are unsupported.
- Element IDs belong to the application's current accessibility snapshot; a later read replaces them. Screenshots and pointer input require an explicit window object.
- Coordinates use the returned screenshot pixels, including the title bar; `relative: true` selects integers from 0 to 999. Native point conversion is Host-owned. Window movement, application changes and other desktop users can race observations and input.
- macOS Stage Manager can reduce background window bounds and screenshots to thumbnails. Full-window observation and coordinate input in this state are not guaranteed; model guidance requires explaining foreground needs and avoiding repeated focus reclamation.
- Background input depends on private SkyLight symbols; macOS updates can make them unavailable. Validate each target OS version.
- Observed failures include dispatched Unicode text not appearing in Blender and background Command+A not selecting all text in AppKit. Inspect application state after input; a successful tool result confirms dispatch only.
- Source builds default to `ad-hoc` and can require new grants after binary changes. The [developer’s fixed identity](../../../.agents/skills/dsh-cua-macos-signing/SKILL.md) lives outside DSH home; deleting DSH home removes its selection, not the certificate or private key. Release distribution needs a stable Developer ID signature and notarization; the build command accepts `--identity`, and installed packages preserve the distributed signature. The [permission page](../cua/README.md) offers helper authorization and target-application revocation.
- Release packaging does not automatically verify GUI startup, helper identity or exit cleanup. Release maintainers can run the [distribution smoke](native/README.md#build-and-service) on a logged-in Mac before publication; a successful package build does not establish those runtime results.
- Saved permission rows show the name, path and icon of one approved copy, not an inventory of every installation sharing its identity. Removing that copy can leave its icon unavailable. Revocation still applies to every copy with the same identity.
- If macOS does not expose a running application’s bundle identifier, the helper checks its reported bundle only when its executable matches the observed process path, then falls back to that path. Consent identity creation fails only when both the bundle identifier and actual executable path are unavailable; process-instance verification can still fail independently.
- Persistent PTC is an external dependency assumption, not an implementation in this package. Real-model task success requires separate evaluation beyond native and protocol fixtures.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
