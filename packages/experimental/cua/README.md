---
description: "Reuse Computer Use application and window objects with authorized, logged platform operations."
kind: "package-reference"
---

# @deepseek-ai/dsh-cua

English | [中文](README.zh.md)

## Summary

Inspect applications, retain window objects across PTC calls, and send actions through the normal tool pipeline. Platform providers supply native execution; this library owns the object API, request validation, application consent, and image admission. The external PTC runtime owns variable persistence.

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

Mount the [macOS provider](../cua-macos/README.md) to enable native operations. External PTC hosts import `connectCua` from `@deepseek-ai/dsh-cua/bridge` and supply the current `tools.cua` binding. Source compositions and native preparation belong to the provider.

Use App methods for a single-window task. `getApp` reads initial accessibility state; `getWindows` and `getWindow` select an explicit window when needed. Re-reading one app/window scope replaces its element indices without invalidating another window's snapshot. Keyboard input follows the application's focus. Invalid request arguments reject before dispatch with a readable method, parameter and requirement.

Observation methods emit and return their result. Use `void await app.getAXState()` for one visible copy, or use `emit:false` and print the returned text once. Screenshots return `CuaScreenshot` with `bytes`, `mimeType`, `pixelWidth`, `pixelHeight`, and `windowId`. The image sink receives the same object. Use its MIME type when selecting a file extension or declaring an image; the format can be PNG, JPEG, WebP, or GIF. Each screenshot enters the attachment pipeline once; `emit:false` only suppresses the object sink.

`tools.cua` returns operation values directly. Screenshot values retain the encoded image Base64 and add a durable `attachment` reference for the tool renderer; model content contains coordinate metadata and one image, without the encoded bytes. Before capture, the tool requires an attachment store and a resolved model route declaring image input. Admission and storage failures reject the call. The object bridge preserves the screenshot bytes and validated metadata without uploading or emitting the same image again.

Application consent precedes launch, observation, capture, and input. Session access is kept in memory by session and application identity, survives agent and helper replacement, and expires when DSH restarts or Computer Use is disabled. Saved grants require platform-verified executable identity. Refusal and revocation close affected Agent connections, so their old objects require fresh selection. No input is replayed after cancellation, timeout, or reconnect.

Actions return `dispatched:true, verified:false`; read fresh state to verify the result. Coordinate actions default to pixels in the latest returned screenshot; `relative: true` accepts integers from 0 to 999 after a successful window observation. Values are divided by 1000 and scaled to the window dimensions, then clamped inside the window. The Host resolves attachment normalization and the selected model route’s image projection before returning the screenshot, then converts input to native window points. Resizing invalidates the screenshot mapping; `SCREENSHOT_REQUIRED` requires a new screenshot for absolute coordinates. Resizing rejects old coordinates with `WINDOW_CHANGED`; movement alone preserves window-local coordinates.

`click(target, { holdMs: 800 })` holds the mouse button for 800 milliseconds before release. `holdMs` accepts nonnegative integers and applies to each press of a double-click; zero releases without an additional hold. The provider config `maxClickHoldMs` limits explicit holds and defaults to 5000 ms. Explicit holds use pointer input for both AX indices and coordinates; omission preserves ordinary click behavior. The operation deadline includes the hold, and cancellation or timeout releases the button. Received input cannot be undone; forced helper termination cannot guarantee release.

### Permission controls

The [Computer Use bundle](../cua-bundle/README.md) mounts this page with its native provider. **Authorize computer use** groups the new-session default, PTC execution mode, Accessibility, and Screen Recording inside one border, with dividers between the rows. Each system-permission row shows the system-reported responsible application’s `.app` bundle filename and icon together in a bordered label. **Manage applications computer use can access** places the application lists inside a separate bordered group. Choose **Request permission**, find that application in the macOS permission list, and enable its switch; if macOS names another application, follow that prompt. With no detected source, the page directs the user to the application named by macOS. Each system-permission row has one control: **Request permission** when access is missing, or an outlined **Allowed** button with a settings icon after authorization. Clicking it opens the corresponding privacy pane, where the user can revoke access; hovering shows **Open System Settings**. Unknown status uses the same button with an **Unknown** label; pending initial observations retain a single placeholder. The page refreshes on entry, when the window regains focus, and after permission actions. A failed query offers **Retry**. Follow any macOS quit-and-reopen prompt and restart DSH as needed.

System-permission operations affect the computer running DSH. When accessing DSH remotely, complete authorization on that computer.

Enabling from the plugin list shows setup guidance when system permissions need attention, with **Later** and **Open settings** actions. Enabling from the detail page displays the permission controls directly. The detail page provides **Set to PTC** under **Default mode for new sessions**; only this action saves the default. Existing sessions keep their preset. **Use persistent mode** in the **PTC execution mode** row separately saves `ptc-runtime.executionMode: persistent-in-memory`. Switching reloads the shared PTC runtime and may interrupt an active call; subsequent calls retain variables and application objects in memory. Already-persistent runtimes show a disabled **Persistent mode enabled** button.

The page lists always-allowed applications and refusals from any session. A refusal in one session does not cancel another session’s grant or prevent a new session from asking. Session-only grants remain effective within their sessions and are omitted from this page. **Revoke** removes the selected application's access and cancels affected work. Input already delivered to an application cannot be undone; observe the application before any further action. **Allow asking again** clears that application’s refusal records across all sessions; the next application selection still requires a new decision.

The Host marker has no configurable fields; platform providers own native configuration.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Shared execution and platform ownership</summary>

The permission Remote also exposes `ptcConfiguration()` and `enablePersistentPtc()` for the detail-page runtime setting. Reads inspect the existing runtime and editable profile entry. Explicit writes use `configEditor.edit()` to preserve other fields and apply normal Loader reload; an already-persistent runtime is left intact. This setting is separate from system and application authorization.

The provider calls [installCua](src/index.ts) with its prepared helper, connection factory, and guidance. [NativeClient](src/native-client.ts) owns request correlation, byte limits, cancellation acknowledgement, and failure settlement. The platform connector owns startup and connection cleanup. The shared executor retains one connection per Agent and joins in-flight image writes during disposal.

`agentPreset` defaults to `ptc`, restricting tools and guidance to Agents bound to that preset. The provider uses the existing `agent/created` and `agent-preset/selected` events and Agent-owned scopes, including Agents already present when it loads. Provider unload and Agent disposal release those registrations. Preset definitions may register after the provider; a preset name filters bound Agents and supplies no tools until a matching Agent exists. Set `agentPreset: false` for global registration in standalone compositions without presets. The Host continues to own permissions, native connections and cancellation; preset definitions remain unchanged.

[The operation schema](src/protocol.ts) is the authority for model parameters and separately declared Host-only fields. Native implementations enforce target identity, window geometry, resource limits, and operating-system access at execution. No invariant companion is published because this library has no separately projected registry or durable state.


The root Host entry exports `installCua`, `CuaConfig`, and the Typert-discovered `CuaAccess` service; its `apply()` only marks the optional Client contribution. `/client` loads the permission UI through the existing module loader. Separate Host and Client compiler projects keep React, CSS, and browser registrations out of headless imports. `/api` owns the app/window API and its types; `/bridge`, `/native-client`, and `/protocol` retain runtime and platform consumers. `/types` exports only the four named boundary types required by generated Remote declarations. The Client uses package-local types. `/typert` supplies Host reflection and `/remote` supplies generated browser descriptors and codecs; permission authority remains on the Host.

The optional browser contribution mounts the native provider's permission Remote and reuses the Plugins activation and configuration slots. The four setup rows remain visible while unknown fields use placeholders; the same permission-management guidance remains visible while queries settle and after access is granted, including when the text wraps. The default-mode form, runtime configuration, system checks, application decisions, and application icons fill in as each query completes. Application names and actions do not wait for icons; icon positions retain their space. User actions run in order without waiting for pending observation queries. Disposal waits for both actions and queries to settle before releasing the separately owned Remote mount. Known query errors and read-only settings stay visible while management operations or retries run, with their actions disabled. Query errors stay with the affected section, and activation guidance depends only on system checks. The injection layer observes Plugin Manager operations independently of the page. Bundle and row changes pause all four queries and invalidate in-flight results; settlement refreshes observations even after the page closes. Last known errors remain until a successful read. Disposal discards late results. The controller consumes the generated `ctx.remote.cuaAccess` namespace directly and handles unsuccessful Remote results in its existing query and action paths. It projects queries into the page and setup dialog; reconnects and updates to the Host-reported settings namespace refresh it. Operation notices live in the shell overlay, so closing the page does not remove them. The provider owns permission checks, persisted decisions, and cancellation; the browser owns no authorization state.

The detail page reads the effective default (`selectedDefault ?? default`) from the existing `configForms` service. The default button writes only `selectedDefault` through the form's revision-checked settings path. The execution-mode row uses CUA's `ptcConfiguration()` and `enablePersistentPtc()` controls: the Host edits only `ptc-runtime.executionMode` through the existing configuration editor, preserving its ordinary Loader reload lifecycle. Permission checks and runtime state settle independently. Loading, read-only and unavailable settings cannot submit a change; a failed write remains beside the setting for retry.
</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [macOS provider](../cua-macos/README.md)
- [Object interfaces](src/types.ts)

-----

<a id="model-experience"></a>
## Model Experience

### Authorized application operations

#### What the model sees

Platform providers mount the shared `cua` tool and supply operating instructions. Calls and observations use the same app/window interface and enter normal Session history. Platform guidance is documented by the [macOS provider](../cua-macos/README.md#model-experience).

#### Token effect

Operation results and admitted images add model input. Retained JavaScript objects are not serialized into prompts. Duplicate caller printing can repeat observation text.

#### KV Cache effect

Results append to history. Retaining objects does not rewrite previous messages; changing the mounted tools or guidance can change the request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- In-memory session decisions have no capacity limit or eviction. They remain until the provider unloads, so a long-running Host retains entries for every session/application pair that requested access.
- Native execution currently uses the macOS provider. Windows support is planned as a separate provider package with a C# helper, retaining the shared app/window API, authorization, snapshot validity, and action-result semantics. Its implementation must document system-specific limitations and distinguish cross-compilation evidence from Windows desktop validation.
- Persistent variables do not reserve an application across a sequence of operations. Other Agents and the user can change its state. Hover and observations do not restore the previous pointer position; [continuous interaction](../../../.agents/notes/implemented/architecture/2026-10-13-cua-continuous-hover.md) uses no cross-call ownership.
- The package stays in `experimental` until Windows support and platform validation permit promotion to the `computer-use` group.

-----

<a id="dev-note"></a>
### Dev Note

None.
