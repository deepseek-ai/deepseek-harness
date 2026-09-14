---
description: "Client Tool presentation plugin for the dsh web client: whole-call tree composition, the keyed per-tool view slot, and the built-in atomic tool cards."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-tool

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-tool` is the client Tool presentation plugin of the dsh web client: it renders every tool call in the conversation. `ui-conversation` dispatches each ordered `tool-call` Conversation Node through the matching key of `conversation.chat.node`; this package renders its root and PTC dispatch children, then dispatches every atomic call through the keyed `tool.call.toolview` slot. Unregistered Tool names use the generic card. Business UI packages register only their wire Tool names and atomic views — they do not pair Session events, rebuild the transcript, or own root/subcall topology, because the Runtime remains authoritative for call/result pairing, lifecycle, and recursive `subCalls` projection.

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

Tool calls appear in the conversation as cards: a root call tree with its nested subcalls, each atomic call rendered by its owning view. Users see running, successful, failed, and interrupted states that come only from the frozen call/result slice, and can open files or inspect calls through the Host callbacks.

### Registering a business tool view

An owning business package registers its wire Tool name into `tool.call.toolview`:

```text
ctx.slots.inject('tool.call.toolview', () =>
  ctx.slots.register({
    name: 'tool.call.toolview',
    key: '<wire tool name>',
  }, BusinessToolRow))
```

The owner payload is `ToolCallOwnerProps`: `callId`, `toolName`, the frozen `block`, optional `cwd` and `home`, the session-authorized `loadImage` loader (for a view whose result carries durable images), and plain `openFile`/`inspect` callbacks. A PTC dispatch block retains its event's `parentCallId`; a root Session call has no such field, so descendants route through the same keyed dispatch — a registered view such as `read_image` renders its card there, and unregistered descendants keep the generic flattened form. Path summaries relativize to the Session cwd first, then replace a leftover POSIX Host home with `~`; `filePath` and Host open keep the authored filesystem path. The registration receives the normal Session slot runtime share but no React node or Runtime service.

### Built-in views

This package owns the generic fallback and the built-in shell/pwsh, read, read_image, write/edit, running `str_replace_editor` `create`/`str_replace`, grep/glob, web, todo, question, and PTC dispatch presentations. Structured cards derive directly from first-party raw event fields; Host `presentCall` and `presentResult` values never enter the Client. Running and settled foreground standard `bash`/`pwsh` and `terminal_send` calls use terminal cards at the root and in PTC dispatch children, subject to the same argument, result, and error checks. Persistent `bash`/`pwsh` calls use terminal cards only while running. Shell output ending in a recognized spill-policy notice uses expandable generic output in shell rows and generic output in Details; a displaced or omitted exit marker cannot establish success. Settled persistent-shell results stay generic because reset and partial-output diagnostics do not always describe one process exit status; root persistent results are expandable, while background acknowledgements remain collapsed. A native or PTC dispatch failure carrying `AUTO_REVIEW_DENIED` shows the Auto review verdict in its collapsed row and one normalized not-executed reason when expanded; a missing or whitespace-only reason uses localized fallback text. A successful question row pairs call questions with result answers by their stable ids and shows readable question/answer lines when expanded. A cancelled or interrupted row shows its verdict and original questions without inventing answers. Unsupported, malformed, or ambiguous inputs fall back to flattened Tool input/result text. `ui-skill` demonstrates a business-owned registration for `skill`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package realizes one dispatch rule: atomic Tool views are keyed by wire Tool name and registered by their owning business packages; this package only renders the tree and the fallback.

### Rendering contract

`ToolCallTree` receives one root `ToolCallBlock` that already contains recursive `subCalls`, the session `cwd`, and the owner's callbacks for opening files and inspecting calls. It recursively walks the standard call blocks and sends the root and children at every depth through the same atomic dispatch path, without subscribing to a separate parent-to-children map. Each root and child wrapper preserves the `data-chat-anchor-key="call:<id>"` and `data-chat-call-id` DOM contract used for paging and selection.

### Cards


Every card is read in place in the call tree; there is no second, full-height presentation of a selected call. Row renderers share one pure card model for each terminal, read, diff, search, and web card, and the image card's gallery renders through the tool-owned `tool.call.images` slot. These models validate raw call arguments, result content, failure state, persisted metadata, PTC dispatch `parentCallId`, and Session path facts. Unsupported or malformed inputs use flattened Tool result text. A file-path summary opens the file through the owner's `openFile`, which the chat view routes to the right Sidebar's text preview; `inspect` opens the trajectory view. Card-specific limits and fallback rules for the terminal, diff, read, search, and web cards remain in [the ui-primitives README](../ui-primitives/README.md); the image card's model in this package carries its own fallback rules.

Chat diff cards keep nine rows before folding, enough for a file header, one removed/added pair, and three context lines on either side. The collapsed row and expanded footer share the primitive's exact or coarse-replacement counts.

An Auto denial takes precedence over keyed specialized views. Its generic row preserves the call identity, omits raw arguments, and normalizes the stored reason only for display: trim surrounding whitespace and collapse line separators to spaces, with localized fallback for an empty result. Session and SDK error details keep the original reason.

The terminal model uses `hasSpillNotice` from the browser-safe `@deepseek-ai/dsh-spill-policy/notice` entry, not an independent UI pattern. The [spill-policy README](../../spill/spill-policy/README.md#shared-notice-ownership) owns notice formatting and recognition. This check conservatively selects generic output; matching text cannot authenticate its source, and replay leaves recorded result bytes untouched.
</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the conversation host, the view slots, and the card models.

- [ui-conversation](../ui-conversation/README.md) — the chat surface dispatching `tool-call` nodes to this package.
- [ui-primitives](../ui-primitives/README.md) — the output card atoms the built-in views compose.
- [ui-skill](../ui-skill/README.md) — a business-owned registration for the `skill` tool.
- [Auto review](../../experimental/auto-review/README.md) — the structured denial identity and user-visible reason owner.
- [Conversation subsystem](../../../docs/subsystems/conversation.md) — how a business-owned feature registers a Conversation node.
- [Slot system standard](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) — the composition model behind the keyed slot.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side tool presentation layer that renders logged calls without changing model context.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the dispatch depth and the view ownership; they are current package constraints.

- **The Host excludes `run_code` from PTC mode program bindings** — production events produce one dispatch level; the recursive Runtime/UI contract supports nesting.
- **First-party Tool views are colocated here** — they can move to their owning business packages independently through the keyed slot.
- **Tool copy reuses the `ui-conversation` locale namespace** — tool titles, row chrome, and Cordis-free primitive labels use that dictionary; presenter models retain locale keys or data rather than rendered wording.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Tool composition is browser-only and contributes no events or cross-plugin mutable state; slot ownership is checked by ui-slots.
