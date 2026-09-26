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

Tool calls appear in the conversation as cards: a root call tree with its nested subcalls, each atomic call rendered by its owning view. Every lifecycle state retains the tool's ordinary business glyph; failure and interruption remain explicit through the frozen call/result state, accessible status text, and failure summary. Users can open files or inspect calls through the Host callbacks. A collapsed `web_fetch` row links its http(s) URL, which opens in a new browser tab.

Shared Tool rows and Bash rows retain error and warning colors for failed and stopped summaries, including on hover. Hover darkens only summaries without those states.

Before dispatch, a named model call appears as one non-expandable row with its tool-owned icon and title. A generic row shows `Tool call · <tool name>`. Preparation exposes no complete arguments, file link, result, or parameter-dependent interaction. Write/edit show `Preparing content NKB` in the summary; N is `Math.ceil(raw.length / 1024)`, an integer estimate of the raw argument string length, not the file's byte size. `tool/call` enables the existing call presentation; completing an argument block alone does not start execution.

### Registering a business tool view

An owning business package registers its wire Tool name into `tool.call.toolview`:

```text
ctx.slots.inject('tool.call.toolview', () =>
  ctx.slots.register({
    name: 'tool.call.toolview',
    key: '<wire tool name>',
  }, BusinessToolRow))
```

The owner payload is `ToolCallOwnerProps`: `callId`, `toolName`, the `phase` discriminant and its frozen stage-specific `block`, optional `cwd` and `home`, the session-authorized `loadImage` loader (for a view whose result carries durable images), and plain `openFile`/`inspect` callbacks. A PTC dispatch block retains its event's `parentCallId`; a root Session call has no such field, so descendants route through the same keyed dispatch — a registered view such as `read_image` renders its card there, and unregistered descendants keep the generic flattened form. Path summaries relativize to the Session cwd first, then replace a leftover POSIX Host home with `~`; `filePath` and Host open keep the authored filesystem path. The registration receives the normal Session slot runtime share but no React node or Runtime service.

### Built-in views

Every registered view receives the explicit `preparing`, `start`, and `result` props declared in [the Tool slot types](src/client/contract/slots.ts). Shared rows use the same `ToolRow` in all stages. Their row model selects the title and combines any generic tool-name prefix with the available argument summary independently of lifecycle state. Tool-owned titles omit the English name. The shared argument parser returns no call during preparation and does not parse partial JSON. Write/edit use separate preparing and dispatched components, so only the preparing component invokes `useToolCallArgumentsPartial`; start and result share the dispatched component. Custom renderers such as Bash, Skill, and Cordis handle preparation separately; their argument-dependent components accept `StartedToolCallViewProps`.

This package owns the generic fallback and the built-in shell/pwsh, read, read_image, write/edit, running `str_replace_editor` `create`/`str_replace`, grep/glob, web, todo, question, and PTC dispatch presentations. Structured cards derive directly from first-party raw event fields; Host `presentCall` and `presentResult` values never enter the Client. Running and settled foreground standard `bash`/`pwsh` and `terminal_send` calls use terminal cards at the root and in PTC dispatch children, subject to the same argument, result, and error checks. Persistent `bash`/`pwsh` calls use terminal cards only while running. Shell output ending in a recognized spill-policy notice uses expandable generic output in shell rows and generic output in Details; a displaced or omitted exit marker cannot establish success. Settled persistent-shell results stay generic because reset and partial-output diagnostics do not always describe one process exit status; root persistent results are expandable, while background acknowledgements remain collapsed. A native or PTC dispatch failure carrying `AUTO_REVIEW_DENIED` shows the Auto review verdict in its collapsed row and one normalized not-executed reason when expanded; a missing or whitespace-only reason uses localized fallback text. A successful question row pairs call questions with result answers by their stable ids and shows readable question/answer lines when expanded. A cancelled or interrupted row shows its verdict and original questions without inventing answers. Unsupported, malformed, or ambiguous inputs fall back to flattened Tool input/result text. `ui-skill` demonstrates a business-owned registration for `skill`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package realizes one dispatch rule: atomic Tool views are keyed by wire Tool name and registered by their owning business packages; this package only renders the tree and the fallback.

### Rendering contract

`ToolCallTree` receives one Tool node, Session `cwd`, and navigation callbacks. Each branch receives a stable block and memoizes its explicit phase props, so changing one subcall leaves unchanged sibling branches unrendered. It dispatches each tool by name through `tool.call.toolview`. Dispatched roots retain their recursive `subCalls`; preparation has no children. Each root and child wrapper preserves the `data-chat-anchor-key="call:<id>"` and `data-chat-call-id` DOM contract used for paging and selection. The Tool node keeps the same callId across all three stages.

Tool owner props forward Chat's stable `useDisclosure` Hook through root and nested calls. Rows invoke it where they own their expanded bodies; intermediate renderers do not subscribe. Each invocation has independent open state that resets when the enclosing Turn collapses, without replacing React identity. Presentation-mode switches preserve it.


The slot-injected `useToolCallArgumentsPartial` Hook lazily subscribes to the owning Step's `assistant-step` source and selects this callId's raw argument prefix. Missing sources or calls return an empty string. Other calls in the same Step may trigger a snapshot check, but an unchanged selected string does not refresh the consumer. Tools that do not invoke the Hook add no subscription; dispatched calls have no argument-prefix source.

### Cards


Every card is read in place in the call tree; there is no second, full-height presentation of a selected call. Row renderers share one pure card model for each terminal, read, diff, search, and web card, and the image card's gallery renders through the tool-owned `tool.call.images` slot. These models validate raw call arguments, result content, failure state, persisted metadata, PTC dispatch `parentCallId`, and Session path facts. Unsupported or malformed inputs use flattened Tool result text. A file-path summary opens the file through the owner's `openFile`, which the chat view routes to the right Sidebar's text preview; `inspect` opens the trajectory view and is absent when that View is unavailable; cards then omit Inspect. Card-specific limits and fallback rules for the terminal, diff, read, search, and web cards remain in [the ui-primitives README](../ui-primitives/README.md); the image card's model in this package carries its own fallback rules.

Chat diff cards keep nine rows before folding, enough for a file header, one removed/added pair, and three context lines on either side. The tool row shows the primitive's exact or coarse-replacement counts; the expanded card contains the diff body without a totals footer.

An Auto denial takes precedence over keyed specialized views. Its generic row preserves the call identity, omits raw arguments, and normalizes the stored reason only for display: trim surrounding whitespace and collapse line separators to spaces, with localized fallback for an empty result. Session and SDK error details keep the original reason.

Recorded tool details cover goal and schedule tools, Cordis inspection, workflow and Ralph reports, Session event/search/trace queries, agent and teammate controls, background jobs, persistent terminals, and LSP navigation. These expanded bodies read successful logged results, preserve generic input/output for failures or unsupported data, and keep Inspect available. Dates include the viewer's time zone, and statuses reflect the call result rather than current session state. Session traces preserve descendant indentation. LSP results open filesystem paths through the Host callback and display other URIs as text. The browser adapter consumes recorded producer text and JSON; Host service objects and presenter callbacks do not cross into the Client. [Compact tool details](../../../.agents/notes/implemented/architecture/2026-09-10-compact-tool-details.md) records the presentation trade-offs.

Expanded status dots and labels use static semantic colors. Receipt and job-output headers keep neutral text and omit the status while expanded. An interruption receipt confirms only that interruption was requested.

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

None, as the package renders streamed tool identities and logged calls without changing model context.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the dispatch depth and the view ownership; they are current package constraints.

- **The Host excludes `run_code` from PTC mode program bindings** — production events produce one dispatch level; the recursive Runtime/UI contract supports nesting.
- **First-party Tool views are colocated here** — they can move to their owning business packages independently through the keyed slot.
- **Web tool links always open a new tab** — the collapsed `web_fetch` URL and the expanded web card links ignore the `ui-chat` link-opening setting because Tool views receive no external-link callback.
- **Tool copy reuses the `ui-conversation` locale namespace** — tool titles, row chrome, and Cordis-free primitive labels use that dictionary; presenter models retain locale keys or data rather than rendered wording.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Tool composition is browser-only and contributes no events or cross-plugin mutable state; slot ownership is checked by ui-slots.
