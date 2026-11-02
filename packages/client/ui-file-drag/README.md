---
description: "Application-scoped file transfers and localized drag failure feedback."
kind: package-reference
---

# @deepseek-ai/dsh-client-ui-file-drag

English | [中文](README.zh.md)

## Summary

Users can drag original images from conversations or the sidebar into the composer, or into other applications through Desktop. Drag failures remain visible after the originating image or panel closes. Transfers between browser windows remain subject to browser capabilities.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The Web profile includes this plugin alongside locale, the slot renderer, and a shell declaring `shell.overlay`. Consumers inject `fileDrag` and pass `ctx.fileDrag.actions` through their entry’s inject face. `prepare(source, signal)` accepts Blob or URL content with an export name and optional Session resource address, returning synchronous start and release operations. `reportFailure()` uses the plugin dictionary; failure feedback and plugin metadata are available in Chinese, English, and Japanese. Composer drop targets receive `ctx.fileDrag.read`; components do not read a service or React context.

The service retains one original `File` for a browser drag. The random `application/x-dsh-file` token resolves only in its application instance. A native listener stays on the source node after React unmount, and drag end, drop completion, or plugin disposal clears the transfer. Internal tokens are accepted only over the composer. External files keep the existing full-page drop overlay. Desktop native drags return as ordinary files and use that overlay, including within the source window.

The desktop bridge is resolved once at activation for protocol version 1. File naming is shared with Desktop through [dsh-util-file-drag](../../util/file-drag/README.md): explicit output suffix wins, compatible suffixes survive, known conflicts use the declared MIME suffix, and unknown types retain the caller name. The plugin owns failure copy and its overlay, which survives source-panel closure.

Managed browser transfers carry an application-local token and `DownloadURL` pointing to a plugin-owned Blob URL containing the prepared bytes. They do not expose the source workspace URL, filename, or alt text through `text/plain`. A drag started before preparation completes is cancelled quietly; a settled failure reports the localized retry message on the next attempt. Resource-backed images prepare on primary pointer down; other sources may prepare on hover. Releasing inside the source preserves preparation for a subsequent drag. Pointer leave without a pressed drag, release outside the source, blur, or unmount retires unused preparation. Cancellation reaches pending native requests, including Host reads and icon waits. Optional resource borrowing failures fall back to the supplied Blob or the authorized URL read; cancellation never starts that fallback.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

The Cordis plugin owns file preparation, transport choice, retained browser bytes, and transient feedback. [DraggableImage](../ui-primitives/README.md) handles image gestures; [Desktop](../../../apps/desktop/README.md) authorizes borrowed resources and owns temporary native exports. Images are the first consumer; the same callbacks accept PDF and other file content without an image MIME gate.

</details>

<a id="model-experience"></a>
## Model Experience

None, as this plugin changes browser interaction without adding model-visible messages or tools.

#### KV Cache effect

None; this plugin neither constructs nor sends model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Browser tokens do not transfer between applications, windows, or tabs. External browser file delivery depends on Chromium `DownloadURL` and the receiving application; Desktop supplies native file delivery. Unreadable cross-origin images retain browser-native dragging.
- The Blob `DownloadURL` path has no verified external-application delivery result. Receivers that read after the transfer ends may find its URL revoked; use Desktop native dragging when original-file delivery is required.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
