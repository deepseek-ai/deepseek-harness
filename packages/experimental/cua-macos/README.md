---
description: "Inspect and operate native macOS applications through scoped app and window objects."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-cua-macos

English | [中文](README.zh.md)

## Summary

Inspect macOS permissions, select running applications and windows, read accessibility trees, capture screenshots and send input. The object API can be retained by an external persistent execution environment. The Swift helper uses macOS frameworks directly and adapts selected MIT-licensed Cua Driver behavior. This package owns neither a PTC runtime nor variable persistence.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

The helper supplies bounded 64-pixel PNG application icons for permission prompts and saved-application lists. Icon reads do not launch an application or inspect its windows; executable and signing checks still determine authorization.

The shared helper queries the process macOS considers responsible for it and captures that application’s name and icon before announcing readiness. A Desktop app launched from Terminal can therefore identify Terminal even when another GUI application sits between it and the helper. Permission queries retain this metadata after the responsible application exits and across connections sharing the helper. If the system query or application metadata is unavailable, the field is omitted and the UI uses the system prompt for guidance.

-----

<a id="use-this-package"></a>
## Use this package

This package is an optional dependency restricted to macOS. Prepare the matching executable under `native/bin` before packing; that directory is included in the archive. Installed packages require the prepared helper and do not compile Swift.

For repository Web use, enable [Computer Use](../cua-bundle/README.md) in Plugins. This prepares the local executable on macOS 14 or later; Windows support is in development. Subsequent builds check it while the existing Web profile keeps the bundle selected. Disabled profiles do not prepare native components. Explicit source composition is also available:

```sh
swift build --package-path packages/experimental/cua-macos/native --configuration release
cua_native_root="$PWD/packages/experimental/cua-macos/native"
export DSH_CUA_HELPER="$cua_native_root/.build/release/dsh-cua-native"
pnpm dsh headless --patch packages/experimental/cua-macos/examples/macos.cordis.yml --dump-config
```

The dump command checks profile composition without a model request. For a real task, replace `--dump-config` with a prompt and configure the profile’s model credentials. The overlay mounts the computer-use registry and this provider; remove an existing competing provider before using it. The responsible host/helper needs Accessibility permission for AX/input and Screen Recording permission for capture. `getCapabilities` reports permissions and session lock state without opening a system dialog. Locked or unavailable desktop sessions reject UI observations and input before dispatch; the user must unlock macOS before resuming. `listApps` and `cua.getState` list running applications. `findApps(query)` searches standard macOS application directories by name, bundle ID or absolute path. `getApp` selects a unique name, bundle ID, path or running PID, obtains application consent, and launches a stopped app in the background when needed. A stopped executable is identified before approval and checked again before and after launch; unsigned code only receives session access for the selected instance. The helper waits for the launched application to finish launching before returning its PID. The returned object reads initial AX without activating the app. Launch cancellation may leave the application running. Model guidance starts with background observation and input, without activation during initialization or before each action. For hidden or minimized windows, try `app.show()` or `window.show()` and read fresh state. This requests unhide and unminimize without activation, raising or switching Spaces; app-level restoration selects the focused, main or sole AX window. The result names the selected `windowId`, or null when no window was selected, and reports `foregroundChanged` by comparing the front app and top window before and after the request. Null means foreground evidence was unavailable; later focus changes remain possible. If restoration fails or the window remains unusable, explain the needed foreground step, call `app.activate()` or an observed window’s `raise` action, then observe again. Necessary foreground access takes priority over preserving focus. Applications may change focus after input; background delivery does not guarantee an undisturbed user session.

| Field | Default | Meaning |
| --- | --- | --- |
| `agentPreset` | `ptc` | Register tools and guidance only for Agents bound to this preset; `false` registers globally. |
| `allowedApps` | `[]` | Live profile-local application consent, keyed by executable path and verified signing requirement. |
| `helperPath` | package-owned executable | Optional absolute native executable override. |
| `buildTimeoutMs` | `300000` | Maximum native preparation time. |
| `timeoutMs` | `30000` | Per-operation deadline; cancellation can leave partial input. |
| `connectTimeoutMs` | `5000` | Deadline for connecting to or starting the shared helper. |
| `screenshotTimeoutMs` | `5000` | Screenshot deadline including queue time, capped by `timeoutMs`. |
| `axTimeoutMs` | `3000` | Deadline per Accessibility system call, configured independently of the complete operation. |
| `maxRequestBytes` / `maxResponseBytes` | `1048576` / `33554432` | UTF-8 request and response limits. |
| `maxClipboardBytes` | `33554432` | Maximum original clipboard bytes preserved during a paste; oversized contents reject before replacement. |
| `pasteReadTimeoutMs` | `1000` | Clipboard read deadline after the Paste command returns; expiry reports `PASTE_NOT_CONSUMED`. |
| `maxAppMatches` | `20` | Maximum installed-app search matches; broader queries reject and require a narrower name. |
| `maxElements` / `maxDepth` | `2000` / `25` | Accessibility traversal limits. |
| `maxClickHoldMs` | `5000` | Maximum explicit click hold in milliseconds; accepts nonnegative integers. Zero only permits immediate release. |
| `dragDurationMs` / `dragSteps` | `400` / `20` | Duration and movement segments for a drag. |
| `textEventIntervalMs` | `0.25` | Delay after each Unicode down/up event, from 0 to 1000 ms. Chord timing is independent. |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-cua-macos) lists all fields. Native tool calls use `{method, params}`; the complete method-specific schema is exposed to the model. For example, `getApp` returns the `appHandle` needed by `listWindows`, `getState` and input operations.

Keypad names (`KP_0` through `KP_9`, `KP_Enter`, and keypad operators) retain their physical key codes. Key chords use `+` between modifiers and the key. Use `+` for the plus key, `cmd++` for Command-plus, or the key name `plus`; an unfinished chord such as `cmd+` is rejected.

Agent disposal and plugin unload cancel and await the complete tool call, including image admission and attachment storage. An image write already in progress must settle before disposal returns; a canceled call cannot return a successful screenshot.

Application consent is enforced before AX reads, window-title reads, screenshots, activation, and input through the CUA tool. The first selection asks the human for session access, denial, or saved access when the application has a verifiable signature. Session access is kept in memory by session and application identity, survives agent and helper replacement, and expires when DSH restarts or Computer Use is disabled. Signed application identities combine the canonical executable path and designated code-signing requirement; unverifiable applications remain bound to their process instance. Denial prevents repeated prompts in that session. Revocation reads and removes saved access in the same queue as grant creation, invalidates each affected Agent connection, and awaits its native cleanup without replaying input. Every app handle on those Agent connections becomes unusable; other applications need fresh selection, but their session and saved grants remain reusable. See the [application consent decision](../../../.agents/notes/implemented/architecture/2026-09-26-cua-application-consent.md). These checks govern CUA calls; persistent PTC and separately authorized shell tools are not an operating-system sandbox.

Raw `getState` exposes validated state fields and the complete text for the requested disclosure options. The native helper also returns structured element diagnostics for native checks; the tool projection omits that duplicate array from model text and structured tool values.

AX observations show menu-bar entries by default. Use `app.getAXState({ includeMenus: true })` to expand menu contents and `app.getAXState({ details: true })` for identifiers, global-point bounds and complete action names. These options also apply to raw `getState` and combined AX/screenshot observations. Every observation replaces that scope's indices; obtain fresh indices from the expanded output. Details do not bypass the configured node and depth limits. Truncation identifies the reached limit.

Values and placeholders are separate. Named, stateful or actionable groups and scroll areas retain their own rows. Repeated names, descriptions and help text on one node are shown once. Values, placeholders and URLs keep their distinct meanings even when their text matches; body text shared by distinct nodes remains intact. Writability is explicit on relevant controls, including `AXIncrementor`; `unknown` means the system did not report it. Missing optional state fields do not imply false. UTF-16 ranges outside the observed value are marked unavailable. Custom action aliases omit AppKit target/selector diagnostics; ambiguous aliases require a complete name from `details:true`.

Observations emit by default and also return their value. In persistent PTC, use `void await app.getAXState()` for one emitted copy, or `emit:false` and one explicit print. Capturing a screenshot after an emitted tree can fail independently; retain the successful AX output.

Screenshot diagnostics use `[cua-screenshot]` records keyed by the tool request ID. Native phase records return over the originating Agent connection and cover window/AX geometry checks, system capture, PNG/Base64 encoding and response writing. Host debug logs add dispatch, reply and cleanup timings. Each request retains at most 8192 bytes of complete diagnostic records, with explicit truncation; screenshot failures append these records to the error for Session export. Records contain stages, timings and error codes, not window titles, AX text or image bytes.

Native preparation serializes compiler checks and publication with the shared file lock. It updates the package payload and runs a content-addressed copy under native/.build/prepared, preserving executable files used by earlier source-runtime processes. Identical builds reuse the same file; corrupted retained copies fail validation. Cancellation and preparation failure finish managed process cleanup before releasing the lock.

### Connect an external execution environment

To run through persistent PTC, add `--patch packages/experimental/cua-macos/examples/persistent-ptc.cordis.yml` after the macOS overlay. This provider keeps variables for the live Agent and applies the selected file sandbox policy. The caller imports the bridge and supplies the current authorized `tools.cua` binding. Persistent PTC receives an installation-owned bridge file URL in its CUA instructions, so the project does not need to install this package. The example below is for an external host that resolves the package from its own installation and supplies `tools`; the package does not install a global object or keep variables alive:

```javascript
import { connectCua } from '@deepseek-ai/dsh-cua/bridge'
const cua = connectCua(() => tools.cua, text => console.log(text))
const app = await cua.getApp("com.apple.TextEdit")
void await app.getScreenshot()
```

Use app methods directly for single-window tasks. `getApp` reads initial AX state, so a screenshot needs no window enumeration or additional AX read. Use `app.getWindows()` and `app.getWindow(windowId)` when the task needs a particular window or default selection is ambiguous; choose by the observed title and bounds.

`getWindow` emits its initial AX tree. An owned window without an AX surface returns an empty snapshot and remains available for screenshots and coordinate input. Window objects retain separate snapshots, so reading one window does not invalidate another. Re-reading the same scope invalidates old indices. An AX node removed during observation rejects the read with `STALE_SNAPSHOT` and publishes no partial tree; read again without repeating the preceding input. App-scoped screenshots and coordinates reuse the latest AX observation: its focused on-screen, nonzero-size window, otherwise the sole such window. They do not query current focus again; read `app.getAXState()` to follow a focus change. Explicit window objects retain their selected target. Keyboard methods stay on `app` because input follows the app’s current focus.

`hover(target)` first reveals advertised AX alternate UI without moving the system cursor. Entering a revealed descendant preserves its parent UI, and leaving restores the default UI. When unavailable, hover moves the visible system cursor to an AX element center or window-local point without pressing a button, including over disabled controls. It requires the selected app to be foreground and the target point unobscured; otherwise `FOREGROUND_REQUIRED` requires explicit activation or raising and a fresh observation. Completion, AX reads and screenshots do not restore the previous point. Wait for the application’s hover delay, observe the revealed content, then hover into it and click; successive calls can visit intermediate points. Other input or application changes can interrupt the interaction. [Continuous-interaction rationale](../../../.agents/notes/implemented/architecture/2026-10-13-cua-continuous-hover.md).

`paste(text, { format: "text" | "html" })` temporarily publishes the requested clipboard format and invokes the application’s enabled standard Paste menu command. It keeps the temporary format until a pasteboard reader requests its data, then restores every captured original format while it still owns the clipboard, preserving a later copy. Paste operations share a cross-process lock and cancellation joins helper cleanup. A forced process exit can prevent restoration. Unsupported Paste commands fail without typing fallback; `typeText` remains separate key-event input.

`selectText` selects a unique literal occurrence or places the cursor before/after it through writable `AXSelectedTextRange`. Adjacent prefix/suffix disambiguate repeats. Selection preserves the remaining text and formatting, and verifies the resulting UTF-16 range; unsupported, missing, ambiguous or changed text fails without keyboard fallback. AX text includes `selectionWritable`, selection ranges and selected text when available.

Screenshot capture requires an attachment store and a resolved model route declaring image input. The shared attachment admission validates canonical Base64, the raster and its configured capacity, then stores the image once. Native data remains available to programmatic callers; model content carries coordinate metadata and the durable image reference. Response byte limits apply before parsing.

Absolute coordinates for hover, click, scroll and drag use pixels in the latest returned screenshot. Pass `relative: true` for integer thousandths of window width and height, from 0 to 999; omission or `false` uses pixels. Relative input can use a successful AX read or screenshot, while absolute input requires a screenshot. The Host maps the delivered image to native points, including attachment and model-request resizing. A value of 999 remains inside the window edge. Coordinate options do not apply to AX element indices. A width or height change since the latest observation returns `WINDOW_CHANGED` before input, including raw calls without a snapshot ID; read fresh AX or take a new screenshot before proceeding. Window movement alone preserves window-local coordinates. Capture and pointer input reject known disagreement between the selected window’s accessibility frame and displayed bounds with `WINDOW_CHANGED`, before posting pointer events. This includes Stage Manager transformations when AX retains the full window frame. Read fresh state; any activation or window raise remains explicit. Advertised AX actions remain available. Missing AX geometry retains the AXless path and does not establish that a transformed window can be operated.

Retained objects resolve the current tool binding on every call. The external runtime owns persistence, imports, cancellation and completion-value serialization. Screenshots return encoded bytes with their MIME type, pixel dimensions and window ID; the standard tool pipeline admits the image attachment exactly once. `emit: false` suppresses facade output only. A host that uses another dispatcher can build objects through `createCuaApi` from `./api`.

AppKit sheets are selectable by their window IDs and remain visible in their document window’s tree. Keyboard input follows a system Open/Save panel only when the application’s focused sheet identifies one Apple panel-service window and that service still focuses the same panel. Unrelated or ambiguous remote recipients fail before dispatch.

Indexed clicks support a single right/middle click or a single/double left click. Click and drag options accept a button and modifier keys; a modified click uses pointer input. Drags hold that button and carry its modifiers through every movement and release. AX text marks disabled controls, `valueWritable=true`, and available `selected` state. The helper uses an advertised accessibility action for unmodified clicks when available; pointer delivery resolves the element’s current bounds and verifies its owning window. Actions report dispatch, not application success. A visual pointer or click marker can be rendered independently of input; AX actions do not require moving the system cursor. Window-directed mouse input can still change application focus, selection or dialogs. Read state after input. `STALE_APP` requires acquiring the application again; `STALE_SNAPSHOT` requires a fresh AX read. Request timeout/cancellation waits for native acknowledgement and preserves usable handles. Missing cleanup acknowledgement closes that Agent’s connection. A screenshot RPC still awaiting its system callback occupies the single capture slot; further screenshots return `CAPTURE_BUSY`, while AX and input remain available. A late capture result is discarded, and its real completion releases that slot. Only an unresponsive operation or failed cleanup can invalidate the shared process and all its handles. Never retry uncertain input automatically. Closing an Agent releases its connection and AX references, without undoing changes to applications.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Dispatch and resource ownership</summary>

The object facade translates app/window methods into JSON operations. The bridge routes them through the normal tool pipeline, preserving authorization, nested logs and image admission. Agents and Hosts belonging to one user share a helper for the same native build. Each connection retains independent handles, snapshots, configuration and cancellation state; desktop operations use a global queue. The managed launcher transfers service lifetime to these connections, and the helper exits after the last connection finishes cleanup. Process locks cover both build identity and the real executable path, preventing duplicate startup and path collisions after a running executable is replaced. Native handles bind a process identity to its kernel start time, and snapshots retain native AX references only inside that helper. The same operation protocol can serve a future platform provider without adding platform logic to the object API.

[Zod operation definitions](../cua/src/protocol.ts) own model parameters and separately declare Host resource fields and private continuations. Public data types derive from those definitions. `pnpm exec tsx packages/experimental/cua-macos/native/generate-protocol.ts` generates the native JSON Schema and Swift field/enum admission tables; the package test lane checks freshness and rejects Host-only fields at model admission. Native target validation, resource limits and operation behavior remain enforced at execution.

[AX text formatting](native/Sources/CuaNative/AXTextFormatter.swift) consumes already-read node data. The AX walker alone assigns indices and retains native references, so formatting owns no second snapshot or target registry.

Native request IDs match the logged tool call IDs. Successful activation and window-raise results retain foreground request details and immediate before/after focus observations in the raw tool result. An already-frontmost app skips redundant activation; a window raise is skipped only when the exact window is also focused, main, unminimized and first among visible normal windows. Unknown observations retain the requested operation. These observations do not establish who caused an unrelated focus change or verify completion.

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
Use cua with method getCapabilities and params {} to inspect permissions and sessionLocked. If sessionLocked is true or an operation reports SESSION_LOCKED, stop UI attempts and ask the user to unlock macOS. A null sessionLocked means no usable console session was verified. After unlocking, read fresh state; screenshots from a locked desktop are not current observations. Use listApps or cua.getState to discover running applications, and findApps(query) to search installed applications by name, bundle ID or absolute path. getApp requests user consent before launching a stopped application in the background, or before observations and input on a running one. If access is denied or revoked, stop using that application until the user explicitly permits another authorization request. Never switch tools to bypass a refusal. Keep the returned appHandle; every app operation requires it. listWindows returns window IDs and point bounds. Raw getState returns AX text and snapshotId. Menu-bar entries are shown by default; includeMenus=true expands their contents. details=true adds identifiers, global-point bounds and complete action names. Both options also apply to getAXState. Each read replaces the indices for that app/window scope. Use its element indices only with that snapshotId. Raw screenshot and coordinate operations require a windowId. Coordinates are pixels in the latest returned screenshot, measured from its top-left. Set relative:true for integer thousandths from 0 to 999 instead. The Host converts both modes to native window points; AX detail bounds remain global macOS points. A verified window can expose no AX elements. Its empty snapshot permits screenshots and coordinate input; element-index actions require an element from a fresh AX observation.

Initialize the object API once in persistent PTC. Reuse its variables in later calls; put temporary declarations inside { ... } blocks to avoid redeclaration errors. All object methods are async. getAXState returns text, not a structured state object. Its text separates values and placeholders, and reports subroles, help, URLs, disabled/focused/selected/expanded state and UTF-16 selection ranges when available. Writability is true, false or unknown on relevant controls; omitted state fields do not assert false. selection=unavailable means the reported range exceeds the observed text. Compact output omits ordinary Press/Pick (click), ShowMenu (right click) and ScrollToVisible actions; details=true lists every available action. Use the displayed action name with performSecondaryAction; ambiguous aliases require the complete name from details=true. Truncation reports the reached provider limit. Narrow the window or increase that provider limit before reading again.

Use app methods directly for single-window tasks; getApp already reads initial AX state. Call app.getWindows() and await app.getWindow(windowId) only to target a particular window or resolve ambiguous window selection. App screenshots and coordinate actions use the latest AX observation: its focused on-screen, nonzero-size window, otherwise the sole such window. They do not refresh focus automatically. Read app.getAXState() to follow changed focus.

CuaScreenshot contains { bytes: Uint8Array, mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif", pixelWidth: number, pixelHeight: number, windowId: number }. Use mimeType to choose a file extension or declare an image; do not assume PNG.

Object API signatures (options default to { emit: true }):

- cua.getCapabilities(options?) -> { platform, permissions, sessionLocked, methods, coordinateSpace, browser }
- cua.listApps(options?) -> Array<{ id, displayName, isRunning: true, pid }>
- cua.findApps(query: string, options?) -> Array<{ id, displayName, path, isRunning, pid? }>
- cua.getState(options?) -> { apps, browsers: [] }
- cua.getApp(selector: string) -> App
- app.activate() -> { dispatched: true, verified: false }
- app.getWindows(options?) -> Array<{ windowId, pid, appName, title, bounds, isOnScreen, onCurrentSpace }>
- app.getWindow(windowId: number) -> Window
- app.typeText(text: string), app.pressKey(chord: string) -> action result
- app.paste(text: string, options?: { format?: "text" | "html" }) -> action result

App and Window methods:

- show() -> { dispatched: true, verified: false, windowId: number | null, foregroundChanged: boolean | null }
- getAXState(options?: { emit?: boolean, disableDiffing?: boolean, includeMenus?: boolean, details?: boolean }) -> string
- getScreenshot(options?: { emit?: boolean }) -> CuaScreenshot
- getAXStateAndScreenshot(options?) -> { state: string, screenshot: CuaScreenshot }
- hover(target: number | [x, y], options?: { relative?: boolean }) -> { dispatched, verified, hoverRoute, systemPointerMoved }
- click(target: number | [x, y], options?: { mouseButton?: "left" | "right" | "middle", clickCount?: 1 | 2, holdMs?: number, modifiers?: Array<"command" | "control" | "option" | "shift" | "fn">, relative?: boolean }) -> action result
- setValue(elementIndex: number, value: string) -> action result
- selectText(elementIndex: number, text: string, options?: { prefix?: string, suffix?: string, selectionType?: "text" | "cursor_before" | "cursor_after" }) -> action result
- performSecondaryAction(elementIndex: number, action: string) -> action result
- scroll({ x, y, deltaLinesX, deltaLinesY, relative? }) -> action result
- drag(from: [x, y], to: [x, y], options?: { mouseButton?: "left" | "right" | "middle", modifiers?: Array<"command" | "control" | "option" | "shift" | "fn">, relative?: boolean }) -> action result

Raw operation tools use { method, params }, including params: {} for parameterless methods. getApp selects without activating the app. Keep applications in the background for observation and routine input. Do not activate or raise an app during initialization, before each action, or merely because another app is foreground. Prefer advertised AX actions. If a window is hidden or minimized, try app.show() or window.show() and read fresh state. show requests unhide and unminimize without activation, raising or switching Spaces; it chooses the explicit, focused, main or sole AX window. A null windowId means no window was selected for restoration. foregroundChanged compares the front app and top window before and after the request; null means unavailable, and delayed focus changes remain possible. If restoration is unsupported or the window remains unusable, including another Space or Stage Manager, explain the needed foreground step, use app.activate() or an advertised raise action, and read fresh state. Completing the task takes priority when foreground access is necessary. Avoid repeated activation when the user switches away; continue background-capable steps and report what requires foreground access. Applications may still change focus in response to input.

Await operations sequentially. After input, read fresh state to verify the effect. A successful action means dispatched, not verified completion. Cancellation may leave partial effects; never retry uncertain input without observing. STALE_APP requires getApp again; STALE_SNAPSHOT requires getState again. Absolute coordinate input requires a fresh screenshot of that window. Relative input can use a successful AX observation or screenshot. SCREENSHOT_REQUIRED means capture a fresh screenshot before using pixel coordinates. For click and hover, coordinate targets must be [x, y], for example hover([650, 400], {relative:true}). A bare number such as hover(650) is always an AX element index. The relative option applies only to coordinate targets, not AX indices. Window resizing since the latest observation rejects coordinate input; movement alone preserves window-local coordinates. WINDOW_CHANGED requires fresh state before any retry; use an advertised AX action or explicitly restore the window before screenshot or coordinate input, then observe again. PERMISSION_DENIED requires the user to grant the required macOS system permissions for macOS Accessibility or Screen Recording. After granting access, observe fresh state before continuing; do not automatically replay prior input.

Hover first uses advertised AX alternate UI without moving the system cursor, preserving revealed descendants until the pointer target leaves their region. When unavailable, it moves the visible system cursor without pressing a button; that route requires the target point to be unobscured in the foreground app. FOREGROUND_REQUIRED requires explicit activation or raising and a fresh observation before retrying. Returning, AX reads and screenshots do not restore the previous point. Wait for the application's hover delay, observe, then hover into the revealed controls before clicking. Use successive hover calls for intermediate points. The result reports hoverRoute and systemPointerMoved. Other input or application changes can interrupt the interaction; app objects do not reserve applications between calls.

Use selectText only on controls advertising selectionWritable. It selects a unique literal occurrence, or places the cursor before/after it; prefix and suffix must be immediately adjacent. AMBIGUOUS_TEXT requires more context; TEXT_NOT_FOUND or SELECTION_CHANGED requires a fresh observation before deciding on input. Left clicks support single/double clicks; right and middle clicks support single clicks. Modified clicks use pointer input. Optional holdMs is a nonnegative integer in milliseconds for each press, including each press of a double-click. Zero releases without an additional hold. The configured maximum is stated below. It uses pointer input even for AX targets; omission preserves ordinary clicks. The operation deadline still applies, and cancellation or timeout releases the held button. Keypad names such as KP_0 and KP_Enter retain their physical key identity. Window objects expose observation and pointer/AX actions; keyboard input remains app-scoped and follows current focus. Scroll deltas are integer lines from -10 to 10; positive values reveal content above or left. Paste delivers plain text or HTML through the application's enabled standard Paste menu command. Paste follows the target app's focused text input. Foreground requirements vary by application; for example, ChatGPT/Codex was observed to accept background Paste without reading clipboard data. PASTE_NOT_CONSUMED means the command was dispatched but no clipboard read was observed before the configured deadline. Inspect the target contents, explicitly activate the app and focus the intended input, then observe again before deciding whether to retry; a delayed paste may still run. Original clipboard formats are restored if the clipboard still belongs to this paste; a later copy is preserved. Unsupported Paste commands fail without typing fallback. CLIPBOARD_CHANGED means another writer intervened; observe before deciding on further input. Browser applications can be controlled with getApp like other native apps; browser tabs are unavailable. Installed-app search covers standard macOS application directories; use an absolute application path for another location. Launch does not restore a window or document, and cancellation may leave an application already started. The execution host must install the object API and own variable persistence; this plugin does not preload a cua global. In persistent PTC, use the host-provided initialization snippet below once. Its installation-owned file URL works independently of the project directory. Retain app objects between calls. Observation methods emit by default and also return their value. Use void await app.getAXState() to avoid a duplicate REPL completion, or pass emit:false and print the returned text once. End screenshot calls with void await app.getScreenshot() or void await app.getAXStateAndScreenshot() so image bytes are not serialized as the program completion value.
```

#### Token effect

Enabling the plugin adds a fixed schema and guidance. AX observations, operation results and admitted images add model input. Retained objects are not serialized into prompts by this package.

#### KV Cache effect

Tool results append to Session history. Changing plugin configuration or tool presentation can change the request prefix; retaining an app object does not change existing history.

## Known Limitations and Deferred Work

The queue orders individual native requests. Holding an app object does not reserve its application across a Session; [continuous interaction](../../../.agents/notes/implemented/architecture/2026-10-13-cua-continuous-hover.md) grants no cross-call ownership. Capture RPCs that never return occupy the single capture slot; creating new app objects does not reset that system connection.

<a id="known-limitations-and-deferred-work"></a>

- Only the macOS native implementation is provided. Windows support is in development; this package remains in `experimental` until that support is complete, then moves to the `computer-use` group. Browser tabs, AX diffs, unassociated system panels and accessory-only apps are unsupported.
- Coordinates use the returned screenshot pixels, including the title bar; `relative: true` selects integers from 0 to 999. Native point conversion is Host-owned. Window movement, application changes and other desktop users can race observations and input.
- macOS Stage Manager can reduce background window bounds and screenshots to thumbnails. Full-window observation and coordinate input in this state are not guaranteed; model guidance requires explaining foreground needs and avoiding repeated focus reclamation.
- Background input depends on private SkyLight symbols; macOS updates can make them unavailable. Validate each target OS version.
- Observed failures include dispatched Unicode text not appearing in Blender and background Command+A not selecting all text in AppKit. Inspect application state after input; a successful tool result confirms dispatch only.
- Native binaries require a local build. Signing and Desktop distribution remain future work. The [permission page](../cua/README.md) offers macOS prompts and app revocation; packaged Desktop permission attribution remains deferred.
- Persistent PTC is an external dependency assumption, not an implementation in this package. Real-model task success requires separate evaluation beyond native and protocol fixtures.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
