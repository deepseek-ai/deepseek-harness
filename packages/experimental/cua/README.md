---
description: "Reuse Computer Use application and window objects with authorized, logged platform operations."
kind: "package-reference"
---

# @deepseek-ai/dsh-cua

English | [中文](README.zh.md)

Providers install the app/window object API with `installCua`; callers connect through `connectCua`. The `cua` API discovers applications, and `CuaApp` objects activate the selected application and enumerate its windows. `CuaApp` and `CuaWindow` both extend `CuaSurface`; explicit window objects own screenshots and pointer input. The macOS provider supplies native execution for this interface.

## Summary

Inspect and operate applications through retained objects: select an application, read its accessibility tree, capture explicit windows, and dispatch authorized input. Standard, Creator, and other non-PTC presets use `cua_run_code` with an automatically available `cua` object. Persistent PTC uses explicit bridge initialization. Platform providers supply native execution; CUA owns consent and image admission.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

Application consent supplies English, Chinese, and Japanese display text from `src/locales.ts`. It uses the fixed approval presentation of User Questions and remains independent of the session tool-approval policy. Native icons accompany the prompt and permission-page observations, but remain outside saved identities and model results. System checks, saved grants and refusals, and icons use separate queries so each result can appear without waiting for the others.

-----

<a id="use-this-package"></a>
## Use this package

Mount the [macOS provider](../cua-macos/README.md) to enable native operations on macOS. External PTC hosts import `connectCua` from `@deepseek-ai/dsh-cua/bridge` and supply the current `tools.cua` binding. Source compositions and native preparation belong to the provider.

`cua_run_code` runs TypeScript in a separate persistent Node environment for each Agent. The global `cua` object is available before the program starts; `tools` contains only `cua`. Call ordinary tools directly outside the program. Use top-level `await` and a final expression for the result; top-level `return` is invalid. The tool accepts the same timeout and sandbox controls as `run_code`. A restarted runtime automatically recreates `cua`, but other variables and selected application objects must be created again.

Configure runtime resources and launch settings through the provider's `standaloneRunCode.runtime` and program call limits through `standaloneRunCode.executor`. Runtime execution is fixed to `persistent-in-memory`; setting `executionMode` or `scriptPersistence` there is rejected. These settings do not change the profile's shared PTC runtime.

Raw `cua` registration uses the base CUA services and preset selection, independently of the private Node runtime and program-only `workingDirectory` dependency. Other presets receive `cua_run_code` only while its program services are available. Only program-mode Agent creation awaits private startup and reports its failures. Correct invalid settings and explicitly reload a failed plugin; restoring a missing dependency resumes a pending plugin. `agentPreset: false` registers raw `cua` globally without creating the private runtime.

`cua` is installed once when its environment is created. Do not overwrite this global. To rebuild a damaged environment, run `process.exit(0)` in `cua_run_code`; that call reports a process-exit failure. The next call starts a fresh environment and restores `cua`. Recreate other variables and select applications and windows again.

Use `cua.getApp(selector)` to select an application; it obtains consent and optionally launches a stopped application in the background, without reading its accessibility tree. `cua.listApps` and `cua.getState` list running applications; `cua.findApps(query)` searches installed applications, including stopped ones. `app.activate()`, `app.getWindows()`, and `app.getWindow(windowId)` operate on the selected application; `getWindow` returns the object without a native request; window operations reject closed or foreign windows. Select an application and one of its windows before any capture or pointer input. Read `app.getAccessibilityTree()` or `window.getAccessibilityTree()` explicitly before element operations. Screenshots remain available when AX reading fails. App and window reads accept `maxElements` and `maxDepth` independently. Omitted limits use the provider configuration. Within one API instance, the facade keeps one current accessibility snapshot per application handle across app and window objects, including repeated selections; each new read invalidates the previous snapshot. Element operations use the latest snapshot ID, so callers use IDs from the latest tree and do not assume an older ID still identifies the same control. Element IDs are opaque strings.

Keyboard methods are available in the scopes a provider declares; the provider owns how input is delivered within each scope. A lost connection invalidates its handles and coordinates. Cleanup failures are reported and the connection is not reused; select the application again and inspect fresh state, because earlier input may have partially executed. Screenshot image errors retain the failing stage and attachment error code. Invalid request arguments reject before dispatch with a readable method, parameter and requirement.

Observation methods emit and return their result. Use `void await app.getAccessibilityTree()` for one visible copy, or use `emit:false` and print the returned text once. `window.getScreenshot()` returns `CuaScreenshot` with `bytes`, `mimeType`, `pixelWidth`, `pixelHeight`, and `windowId`. The image sink receives the same object. Use its MIME type when selecting a file extension or declaring an image; the format can be PNG, JPEG, WebP, or GIF. Each screenshot enters the attachment pipeline once; `emit:false` only suppresses the object sink.

`tools.cua` returns operation values directly. Screenshot values retain the encoded image Base64 and add a durable `attachment` reference for the tool renderer; model content contains coordinate metadata and one image, without the encoded bytes. Before capture, the tool requires an attachment store and a resolved model route declaring image input. Admission and storage failures reject the call. The object bridge preserves the screenshot bytes and validated metadata without uploading or emitting the same image again.

Application consent precedes launch, observation, capture, and input. Session access is stored by conversation and application identity and survives DSH restart and Computer Use disablement. Other conversations require their own consent. Saved grants require a platform-provided reusable application identity. Refusal and revocation close affected Agent connections, so their old objects require fresh selection. No input is replayed after cancellation, timeout, or reconnect.

Actions return a `dispatched` boolean; `mouseMove` also reports `hoverRoute` and `systemPointerMoved`, and `show()` adds `windowId` and `foregroundChanged`. Read fresh state to verify the result. Screenshots and pointer actions are available only on explicit window objects. Coordinate actions default to pixels in the latest returned screenshot; `relative: true` accepts integers from 0 to 999 after a successful AX observation covering the window or a screenshot. Selecting a window alone does not establish this observation. Values are divided by 1000 and scaled to the window dimensions, then clamped inside the window. The Host resolves attachment normalization and the selected model route’s image projection before returning the screenshot, then converts input to the provider’s native window coordinates. Resizing invalidates the screenshot mapping; `SCREENSHOT_REQUIRED` requires a new screenshot for absolute coordinates. Resizing rejects old coordinates with `WINDOW_CHANGED`; movement alone preserves window-local coordinates.

`click(target, { holdMs: 800 })` holds the mouse button for 800 milliseconds before release. `holdMs` applies only to `click`; it accepts nonnegative integers and applies to each press of a double-click; zero releases without an additional hold. The provider config `maxClickHoldMs` limits explicit holds and defaults to 5000 ms. Explicit holds use pointer input; omission preserves ordinary click behavior. The operation deadline includes the hold, and cancellation or timeout releases the button. Received input cannot be undone; forced helper termination cannot guarantee release.

### Permission controls

The application approval card includes a **Risks** tag. Hover over it, focus it with the keyboard, or tap it to read a formatted card about background access to approved apps, each app’s automation rules and possible account restrictions, and stopping through DeepSeek Harness. Moving the pointer onto the card keeps it readable and selectable.

On the Computer Use detail page, permission cards, component rows, and source facts use l3 borders, with 32px gaps between sections. Application badges retain their l1 borders.

The [Computer Use bundle](../cua-bundle/README.md) mounts this page with its native provider. **Authorize computer use** groups the new-session default, PTC execution mode, Accessibility, and Screen Recording inside one border. Each permission row shows the responsible application’s name and icon. **Request permission** delegates to the provider with the selected permission and current Client language; the [macOS provider](../cua-macos/README.md) owns the native drag guide. An outlined **Allowed** button opens settings for revocation; unknown status uses **Unknown**. Application grants remain in a separate group.

The page refreshes on entry, window focus, and completed actions. Query failures retain the last observation as unknown and offer **Retry**. Opening settings or requesting permission does not establish consent. The provider owns native guidance, its configuration, and localized recovery instructions.

System-permission operations affect the computer running DSH. When accessing DSH remotely, complete authorization on that computer.

Enabling from the plugin list or detail page shows setup guidance when system permissions need attention, with **Later** and **Open settings** actions. Computer Use works in Standard, Creator, and PTC modes. The detail page provides **Set to PTC** under **Default mode for new sessions**; only this action saves the default. Existing sessions keep their preset. **Use persistent mode** in the **PTC execution mode** row separately enables `ptc-runtime.scriptPersistence` when Script mode is selected; otherwise it saves `ptc-runtime.executionMode: persistent-in-memory`. Switching reloads the shared PTC runtime and may interrupt an active call; subsequent calls retain variables and application objects in memory. Already-persistent runtimes show a disabled **Persistent mode enabled** button. Other presets retain their CUA program state separately and do not depend on this setting.

The page lists always-allowed applications and refusals from any session. A refusal in one session does not cancel another session’s grant or prevent a new session from asking. Session-only grants remain effective within their sessions and are omitted from this page. **Revoke** removes the selected application's access and cancels affected work. Input already delivered to an application cannot be undone; observe the application before any further action. **Allow asking again** clears that application’s refusal records across all sessions; the next application selection still requires a new decision.

The Host marker has no configurable fields; platform providers own native configuration.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Providers declare `systemPointer: true` to support explicit physical pointer movement. CUA exposes the option in the tool schema and model instructions only for those providers. CUA owns the approval card, live-session decision and delegated-task restriction. A provider receives the per-call pointer mode after CUA checks application access and any required consent.

Permission responses identify their platform and report only the state that platform can observe. The shared page renders the controls those observations support. Before platform identification, it shows neutral observation and input rows without system actions. Native providers use the shared build lock and compiler cleanup. Standalone executables are retained by digest. The macOS provider reads its signed application receipt after compilation completes under the same lock.

<details>
<summary>Shared execution and platform ownership</summary>

The [permission store](src/permission-store.ts) uses `storageDomain` with the configured backend. The default JSON backend writes `$DSH_HOME/storages/cua_permissions_<sha256>.json`, where the digest identifies the canonical profile directory. Each authorization check opens fresh state under the profile's file lock and closes its domain afterward; native dispatch uses a separate application lock. Revocation waits for operations already admitted by another process; after it completes, every process rejects old handles. Files on different machines or PID namespaces must not share this lock.

Legacy `allowedApps` are imported on first store access and never reapplied after migration. The old configuration can be removed after checking the permission page. Grants, denials and the option to ask again are durable; the page still omits conversation-only grants. Standalone compositions without a profile retain only process-local decisions; a profile without domain storage refuses authorization operations.

Grant executable paths are optional display metadata. Missing paths omit the tooltip and icon query while retaining the application name and revoke action. Existing stored records remain valid; new records without paths require a reader that supports the optional field. Storage failures still reject authorization and dispatch without substituting temporary permission.

The permission Remote also exposes `ptcConfiguration()` and `enablePersistentPtc()` for the detail-page runtime setting. Reads inspect the existing runtime and editable profile entry. Explicit writes obtain execution settings from the Node provider's `resolvePersistentExecution` helper and use `configEditor.edit()` to preserve other fields and apply normal Loader reload; an already-persistent runtime is left intact. CUA declares the Node provider as a peer so these settings follow the installed provider version. This setting is separate from system and application authorization.

The provider calls [installCua](src/index.ts) with its prepared helper, connection factory, guidance callback, and startup capabilities. [NativeClient](src/native-client.ts) owns request correlation, byte limits, cancellation acknowledgement, and failure settlement. The platform connector owns startup and connection cleanup. Its typed startup failures preserve their code and diagnostic through request writes and connection shutdown. The shared executor retains one connection per Agent and joins in-flight image writes during disposal.

Providers implement `CuaBackend.getGuidance(kind)` with `kind: 'raw' | 'standalone'`. Return the operation instructions for raw `cua` calls or `cua_run_code` programs respectively; both kinds may return the same text. Shared CUA applies the same capability-specific permission guidance, configured AX read defaults, and maximum click hold to both results.

Providers register connection-owned resource cleanup with `NativeClient.registerCleanup(cleanup)`; the returned disposer unregisters it. While the connection can send requests, the callback receives `canRequest: true` and uses `requestCleanup()` for native cleanup, awaiting its acknowledgement before returning. After forced closure, `canRequest: false` allows local cleanup only. Each resource reuses one cached cleanup Promise when program settlement and connection shutdown both request cleanup.

Graceful connection closure waits for registered cleanup. Native cleanup refusal or expiry invalidates the connection and its handles; cleanup failures remain visible while connection disposal proceeds. Ordinary native-request timeouts still request cancellation and wait for acknowledgement within `graceMs`. Provider unload drains its owned CUA programs; PTC programs using raw `cua` may continue unrelated work after their held input is released.

`agentPreset` defaults to `ptc`: matching Agents receive the raw `cua` tool and PTC guidance; every other composed preset receives only `cua_run_code` and its guidance. This includes Standard, Creator, Minimal, and custom presets. A base owner uses `agent/created`, `agent-preset/selected`, and Agent-owned scopes, including Agents already present when the provider loads. It replaces each tool and prompt pair synchronously by definition identity; unavailable program services withdraw only the program definition, leaving raw registrations intact. Agent disposal removes its registrations and releases its retained environment. Provider unload also disposes the dedicated CUA runtime. Agents without a composed preset receive neither tool. Set `agentPreset: false` to register the raw `cua` tool globally in standalone compositions. The Host owns permissions, native connections, and cancellation; preset definitions remain unchanged.

`cua_run_code` reuses the PTC program-tool factory with one isolated Node runtime owned by the CUA provider. Each Agent has a separate retained process selected by its `stateOwner`. CUA registers an environment initializer on that runtime; it installs `cua` once per new process, including temporary escalated runs. Its owner depends only on the runtime and retains the registration while program-tool dependencies reload. Program tools are disposed and drained before the initializer unregisters and the runtime closes. The factory binds only the private `cua` operation tool and preserves nested policy checks, guards, logs, cancellation, and screenshot delivery. The private tool is absent from the model's direct tool list.

[The operation schema](src/protocol.ts) is the authority for model parameters and Host-supplied request fields. [Native observations](src/native-observation.ts) decode private window reply fields before updating coordinates and returning public results. Native implementations enforce target identity, window geometry, resource limits, and operating-system access at execution. The permission store owns durable consent separately from the native protocol.

One object facade ([src/api.ts](src/api.ts)) builds a shared `CuaSurface` and derives `CuaApp` and `CuaWindow` from it. The derived factories inject scope parameters and the accessibility and keyboard checks for their scope; the shared base does not branch on application-only capabilities. Within one API instance, the facade keeps one current accessibility snapshot per `appHandle` across every app and window object for that handle. Selection leaves the current accessibility snapshot unchanged. Each explicit `getAccessibilityTree()` invalidates the previous snapshot before dispatch, and element operations use the latest snapshot ID. Only a `CuaWindow` captures screenshots or sends pointer input.

Provider startup capabilities are fixed at installation: platform, methods, app-level accessibility, keyboard scopes, browser support, and coordinate space. The native `getCapabilities` RPC reports runtime permissions and session lock only; `installCua` merges both layers for the model-visible result. The raw RPC remains a common operation representation rather than a capability inventory, so provider guidance states the actions its platform supports.

Check `methods` and `keyboard` in the result of `await cua.getCapabilities()` for the supported operations and input scopes. `pressKey(key, modifiers?)` presses and releases one key while holding the listed modifiers; `sendKeyEvent(key, direction)` sends exactly one key-down or key-up. `typeText` and `paste` deliver literal text at the provider's declared keyboard scope. Keyboard modifier names are plain strings that the provider interprets.


Platform providers import `CuaConfigFields` from `@deepseek-ai/dsh-cua/config` to extend the shared configuration. The root Host entry exports `installCua`, `CuaConfig`, and the Typert-discovered `CuaAccess` service; its `apply()` only marks the optional Client contribution. `/client` loads the permission UI through the existing module loader. Separate Host and Client compiler projects keep React, CSS, and browser registrations out of headless imports. `/api` owns the app/window API and its types; `/bridge`, `/native-client`, and `/protocol` retain runtime and platform consumers. `/types` exports only the named types required by generated Remote declarations. The Client uses package-local types. `/typert` supplies Host reflection and `/remote` supplies generated browser descriptors and codecs; permission authority remains on the Host.

The optional browser contribution mounts the native provider's permission Remote and reuses the Plugins activation and configuration slots. The four setup rows remain visible while unknown fields use placeholders; platform-specific permission guidance remains visible during queries and after grants once the platform has been identified. The default-mode form, runtime configuration, system checks, application decisions, and application icons fill in as each query completes. Application names and actions do not wait for icons; icon positions retain their space. User actions run in order without waiting for pending observation queries. Disposal waits for both actions and queries to settle before releasing the separately owned Remote mount. Known query errors and read-only settings stay visible while management operations or retries run, with their actions disabled. Query errors stay with the affected section, and activation guidance depends only on system checks. The injection layer observes Plugin Manager operations independently of the page. Bundle and row changes pause all four queries and invalidate in-flight results; settlement refreshes observations even after the page closes. Last known errors remain until a successful read. Disposal discards late results. The controller consumes the generated `ctx.remote.cuaAccess` namespace directly and handles unsuccessful Remote results in its existing query and action paths. It projects queries into the page and setup dialog; reconnects refresh it. Page entry, focus and completed actions read the current permission store. Operation notices live in the shell overlay, so closing the page does not remove them. The provider owns permission checks, persisted decisions, and cancellation; the browser owns no authorization state.

The detail page reads the effective default (`selectedDefault ?? default`) from the existing `configForms` service. The default button writes only `selectedDefault` through the form's revision-checked settings path. The execution-mode row uses CUA's `ptcConfiguration()` and `enablePersistentPtc()` controls: persistence follows the loaded runtime's `retainsState`. Enabling persistence preserves an active Script evaluator and writes `executionMode` and `scriptPersistence` together through the configuration editor; other modes select the retained REPL with Script persistence disabled. The ordinary Loader reload lifecycle applies. Permission checks and runtime state settle independently. Loading, read-only and unavailable settings cannot submit a change; a failed write remains beside the setting for retry.
</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [macOS provider](../cua-macos/README.md)
- [Object interfaces](src/types.ts)
- [Scoped surfaces and keyboard input](../../../.agents/notes/implemented/architecture/2026-11-05-cua-scoped-surfaces-and-input.md)
- [Consent storage migration](../../../docs/upgrade-guide/v0.2.1-rc.2/cua-consent-storage/guide.md)

-----

<a id="model-experience"></a>
## Model Experience

### Authorized application operations

#### What the model sees

With the default preset selection, PTC receives `cua` through its existing `run_code` tool and other composed presets receive `cua_run_code`. Its description states: “The global cua object is ready to use; retain application and window objects across calls.” The program binds only `tools.cua`; ordinary tools remain directly callable. Calls and observations use the same app/window interface and enter normal Session history. The Web card shows the program, nested calls, and screenshots. Platform guidance is documented by the [macOS provider](../cua-macos/README.md#model-experience).

#### Token effect

The selected tool schema and CUA guidance add model input. Program output, operation results, and admitted images add history; only the CUA binding is described inside the program. Retained JavaScript objects are not serialized into prompts. Duplicate caller printing can repeat observation text.

#### KV Cache effect

Results append to history. Retaining objects does not rewrite previous messages; changing the mounted tools or guidance can change the request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Conversation decisions have no automatic retention limit or deletion when a conversation is removed. Revocation removes permission, while its generation remains to reject older handles and pending approvals.
- Native behavior and desktop validation are platform-owned; consult each provider for supported applications, input restrictions and measured coverage.
- `agentPreset` selects one preset ID and does not inspect executors. A custom PTC preset with a different ID receives `tools.cua_run_code` inside its outer `run_code`. The nested program uses the separate CUA environment and `standaloneRunCode` limits; the outer program’s deadline and cancellation still apply. Set `agentPreset` to the custom ID to expose raw `tools.cua` there. Only the matching ID receives the raw form.
- `cua_run_code` state is in memory only and is separate from PTC state. Process loss, Agent disposal, or provider unload discards it; application consent remains independently stored.
- Persistent variables do not reserve an application across a sequence of operations. Other Agents and the user can change its state. Pointer movement and observations do not restore the previous pointer position; [continuous interaction](../../../.agents/notes/implemented/architecture/2026-10-13-cua-continuous-hover.md) uses no cross-call ownership.
- Element IDs are opaque strings from the application's current accessibility snapshot. A later read on any window of the same application replaces the current snapshot, so callers must use IDs from the latest tree; an old string may be reused for a different control. Screenshots or pointer input require an explicitly selected window.

-----

<a id="dev-note"></a>
### Dev Note

None.
