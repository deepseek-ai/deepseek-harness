---
description: "Reuse Computer Use application and window objects with authorized, logged platform operations."
kind: "package-library"
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

-----

<a id="use-this-package"></a>
## Use this package

Mount the [macOS provider](../cua-macos/README.md) to enable native operations. External PTC hosts import `connectCua` from `@deepseek-ai/dsh-cua/bridge` and supply the current `tools.cua` binding. Source compositions and native preparation belong to the provider.

Use App methods for a single-window task. `getApp` reads initial accessibility state; `getWindows` and `getWindow` select an explicit window when needed. Re-reading one app/window scope replaces its element indices without invalidating another window's snapshot. Keyboard input follows the application's focus. Invalid request arguments reject before dispatch with a readable method, parameter and requirement.

Observation methods emit and return their result. Use `void await app.getAXState()` for one visible copy, or use `emit:false` and print the returned text once. Screenshots return `CuaScreenshot` with `bytes`, `mimeType`, `pixelWidth`, `pixelHeight`, and `windowId`. The image sink receives the same object. Use its MIME type when selecting a file extension or declaring an image; the format can be PNG, JPEG, WebP, or GIF. Each screenshot enters the attachment pipeline once; `emit:false` only suppresses the object sink.

`tools.cua` returns operation values directly. Screenshot values retain the encoded image Base64 and add a durable `attachment` reference for the tool renderer; model content contains coordinate metadata and one image, without the encoded bytes. Before capture, the tool requires an attachment store and a resolved model route declaring image input. Admission and storage failures reject the call. The object bridge preserves the screenshot bytes and validated metadata without uploading or emitting the same image again.

Application consent precedes launch, observation, capture, and input. Task access belongs to the selected instance; saved grants require platform-verified executable identity. Revocation closes affected Agent connections, so their old objects require fresh selection. No input is replayed after cancellation, timeout, or reconnect.

Actions return `dispatched:true, verified:false`; read fresh state to verify the result. Coordinate actions default to pixels in the latest returned screenshot; `relative: true` accepts integers from 0 to 1000 after a successful window observation. The Host resolves attachment normalization and the selected model route’s image projection before returning the screenshot, then converts input to native window points. Resizing invalidates the screenshot mapping; `SCREENSHOT_REQUIRED` requires a new screenshot for absolute coordinates. Resizing rejects old coordinates with `WINDOW_CHANGED`; movement alone preserves window-local coordinates.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Shared execution and platform ownership</summary>

The provider calls [installCua](src/index.ts) with its prepared helper, connection factory, and guidance. [NativeClient](src/native-client.ts) owns request correlation, byte limits, cancellation acknowledgement, and failure settlement. The platform connector owns startup and connection cleanup. The shared executor retains one connection per Agent and joins in-flight image writes during disposal.

[The operation schema](src/protocol.ts) is the authority for model parameters and separately declared Host-only fields. Native implementations enforce target identity, window geometry, resource limits, and operating-system access at execution. No invariant companion is published because this library has no separately projected registry or durable state.

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

- Native execution currently uses the macOS provider. Windows support is planned as a separate provider package with a C# helper, retaining the shared app/window API, authorization, snapshot validity, and action-result semantics. Its implementation must document system-specific limitations and distinguish cross-compilation evidence from Windows desktop validation.
- Persistent variables do not reserve an application across a sequence of operations. Other Agents and the user can change its state. Hover and observations do not restore the previous pointer position; [continuous interaction](../../../.agents/notes/implemented/architecture/2026-10-13-cua-continuous-hover.md) uses no cross-call ownership.
- The package stays in `experimental` until Windows support and platform validation permit promotion to the `computer-use` group.

-----

<a id="dev-note"></a>
### Dev Note

None.
