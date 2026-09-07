# Agent Note: Client-Derived Presentation from Raw Session Tool Events

Status: implemented

English | [中文](2026-08-23-client-derived-tool-presentation.zh.md)

## Problem

Session history is a durable journal interface, while tool cards are Client presentation. Computing card views during `page` or `follow` would couple history reads to the Tools registry, Agent presets, restored scopes, presenter execution, and transient UI types.

A `tool/result` does not repeat the tool name or arguments. Host-side result presentation therefore requires either a call index or a backward scan by `callId`; repeated scans over a tool-dense page can approach quadratic work because `maxMessages` does not directly bound the event count.

Host projection would also duplicate structured data. Read, diff, search, and web results already persist bounded facts in `tool/result.data.meta`; another view object increases Remote payload size and Client decoding without adding durable meaning.

The Client already owns a complete tool-presentation entry point. `ui-chat` assembles `tool/call`, `tool/result`, and Code Dispatch events into stable `ToolCallBlock` values. `ui-tool` owns the recursive call tree, the `tool.call.toolview` keyed slot dispatched by tool name, the Generic fallback, card models, and details output. A business Client plugin can register a renderer for its own tool names.

Splitting presentation between Host presenters and Client keyed renderers creates two interpretations of the same event. The keyed renderer is the Web extension point, so an intermediate Host view provides no independent Web capability.

`ToolDefinition.presentCall` and `presentResult` remain useful Host APIs even though ACP is automation-only and the repository has no production TUI consumer. Removing their definitions is a separate decision from keeping Session reads independent of presentation.

The required result is one raw Session journal and one Client presentation owner without visual degradation or incidental enhancement. Specialized cards, interactions, and Code Dispatch topology remain stable while the transport stops carrying transient views.

## Decision

The visual-equivalence requirements below exclude the separately approved [nested terminal-card fix](../bug-fix/2026-09-05-nested-terminal-cards.md); all other presentation and ownership constraints remain.

The Session Remote journal sends only raw, validated, persistable Session events. `session.page` and `session.follow` do not parse tool arguments, query the Tools registry, restore a presenter scope, execute `presentCall` or `presentResult`, or construct or clone any tool view.

The Client Conversation layer continues to own tool call/result identity, pairing, lifecycle, Code Dispatch topology, and stable Chat Nodes. It does not interpret individual tool names or produce terminal, diff, read, search, or web component props.

Client `ui-tool` continues to own card models and concrete renderers. Each card model directly reads the tool name, raw arguments, result content, error, durable metadata, Session cwd, and Host home from `ToolCallBlock`, and produces the same component props as the current page.

The Client has no second presenter registry. Tool-name dispatch uses only the existing `tool.call.toolview` keyed slot. Pure Client card-model helpers are renderer implementation details, not a Cordis service, public registry, or wire DTO.

The Host `ToolDefinition.presentCall`, `ToolDefinition.presentResult`, `ToolCallView`, `ToolResultView`, and existing tool presenter implementations remain. The Session Controller does not invoke them, and the Client does not import or consume them. A future non-Client consumer is outside this decision.

`ToolOutputDefinition.presentationMeta` and durable `tool/result.data.meta` remain. They carry execution-result facts required by existing specialized cards that the model-visible result text cannot represent losslessly. The Client validates and consumes `meta` directly rather than requiring the Host to convert it into a view during history reads.

### Goals and non-goals

| Category | Decision |
|---|---|
| Absent | `SessionEventEntry.view`, `SessionToolView`, and `SessionToolCallView` |
| Absent | `viewFor`, `backscanArgs`, `parseToolCall`, `jsonView`, and presenter-scope lookup from `history.ts` |
| Absent | `openCalls` and fallback event scans used only for follow presentation |
| Absent | the Client Session's parallel `views` array, Conversation input `view`, and Tool block `callView`/`resultView` |
| Derived | terminal, diff, read, search, and web card models read raw blocks and metadata |
| Derived | Deliverables reads successful mutation names and arguments |
| Retained | Host `ToolDefinition.presentCall`/`presentResult` APIs, types, implementations, and direct tests |
| Retained | `output.presentationMeta` and durable `tool/result.data.meta` |
| Retained | the Session log format, Remote journal lifecycle, and Conversation identity/topology |
| Retained | the existing keyed slot, Generic fallback, and Chat, Details, and Trajectory structure |
| Forbidden | a new Client presenter service, parallel registry, or wire renderer id |
| Forbidden | new cards, visual redesign, interaction redesign, or Code Dispatch rich-card enhancements except the [nested terminal-card exception](../bug-fix/2026-09-05-nested-terminal-cards.md) |
| Forbidden | compatibility dual-writing, version negotiation, or retention of the old `view` field |

## Terminology

**Raw Session event** means a `SessionEvent` fact from the durable log, including the `name` and raw `arguments` string on `tool/call`, and the `content`, `isError`, structured error, and optional `meta` on `tool/result`.

**Durable metadata** means the JSON value produced by `ToolOutputDefinition.presentationMeta` after a tool succeeds and stored in `tool/result.data.meta`. It is part of the result facts, not a pre-laid-out React or card DTO.

**Host tool view** means the `ToolCallView` or `ToolResultView` returned by `ToolDefinition.presentCall` or `presentResult`. Session Remote does not transport it.

**Client card model** means the pure props data under `ui-tool/src/client/tool/models/` consumed directly by `TerminalBlock`, `DiffBlock`, `ReadBlock`, `SearchBlock`, `WebBlock`, or `ToolRow`.

**Specialized card** means the structured terminal, diff, read, search, or web body. Titles, summaries, status dots, and ordinary IN/OUT text remain part of the generic tool row.

**Equivalent** means that the same supported input produces the user-visible result and interaction pinned by the existing component, assembly, and browser evidence. It does not require the same intermediate TypeScript types or internal calls.

**No enhancement** means that this decision does not give an input pinned to Generic fallback a new specialized card or expand an existing card's data or interactions.

## Architecture and Ownership

### Tool execution and persistence

1. A tool registers `output.schema`, `output.render`, and optional `output.presentationMeta`.
2. Successful execution produces a canonical JSON value.
3. The Tools runtime snapshots, schema-validates, and freezes the value.
4. `output.render(args, value)` produces model-visible `ContentBlock[]`.
5. When a top-level call declares `output.presentationMeta`, the runtime also produces JSON-safe metadata.
6. The agent loop writes the model-visible result and metadata into a `tool/result` Session event.
7. The Session log does not store `ToolCallView` or `ToolResultView`.

### Host journal reads

1. `session.page` obtains attached or persisted events.
2. `paginate()` cuts pages on append-origin user/assistant message boundaries.
3. A tail page obtains its baseline from the registered projection snapshot/restore path.
4. Every page entry contains only `{event}`.
5. `session.follow` establishes its listener before catch-up reads, emits the opening cursor, and then streams contiguous `{event}` frames.
6. Neither path resolves a preset or Tools scope for presentation, parses tool arguments, invokes presenters, or indexes calls.

### Client data and presentation

1. The Client Session stores one contiguous raw event window.
2. `SessionEventSource` publishes `SessionEventEntry` values containing only events.
3. `ui-conversation` folds each event without a presentation companion.
4. The Chat and Trajectory Tool Definitions pair top-level calls and results by callId and assemble Code Dispatch subtrees.
5. `RunningToolCall` and `ToolResultNode` retain raw facts, metadata, and existing parent identity.
6. `ToolCallTree` dispatches `tool.call.toolview` by wire tool name.
7. `ui-tool` derives card component props from the block at the render site.

### Production consumer audit

| Object | Producer | Production consumer | Decision |
|---|---|---|---|
| `presentCall`/`presentResult` | Host tools | non-Client callers, if any | retained outside Session Remote |
| `SessionEventEntry.view` | none | none | absent from the wire |
| `callView`/`resultView` | none | none | absent from the Client model |
| `presentationMeta` | Tools runtime | `tool/result`, Client card models, and Host presenters | retained durable input |
| fixture presenter mirror | none | none | fixtures send raw metadata |

ACP does not consume a Session tool view or map Host render intent. The repository has no production TUI consumer. Host presenters remain available without making Session Remote their transport.

## Data Flow

```text
Tool execute
  -> canonical value
  -> output.render(args, value)
  -> model-visible result content
  -> output.presentationMeta(args, value), when declared
  -> durable tool/result event

Session page/follow
  -> raw Session event envelope
  -> no tool lookup
  -> no preset lookup for presentation
  -> no call backscan
  -> no render-intent serialization

Client SessionEventSource
  -> Conversation Tool Definition
  -> root call/result pairing + Code Dispatch topology
  -> ToolCallBlock(name, argsRaw, content, error, meta)
  -> tool.call.toolview keyed dispatch
  -> Client card model
  -> existing React component
```

This path retains one durable metadata projection because it runs while the canonical result is still in memory. It removes the second presentation projection performed while reading history.

### Layer responsibilities

| Layer | Owns | Does not own |
|---|---|---|
| Tools runtime | execution, canonical value, model text, replayable metadata | Web card selection and component props |
| Session log | durable facts, ordering, replay | transient card DTOs |
| Session Controller | addressing, authority, cold reads, pagination, follow, projection baseline | tool lookup, presenters, presentation scope |
| Client Session | Remote journal lifecycle and contiguous window | tool meaning and card types |
| Conversation Tool Definition | call/result pairing, lifecycle, root/subcall topology | mapping a tool name to a component |
| `ui-tool` | card models, Generic fallback, Chat/Details presentation | Session pagination and the Host registry |
| Business Client plugin | keyed renderer for its own tool name | root/subcall assembly and a global registry |
| `ui-deliverables` | produced paths for current first-party mutations | UI cards or Host render intent |

## Remote and Durable Data Contracts

### `SessionEventEntry`

`SessionEventEntry` remains the journal-entry envelope and contains only `event: SessionWireEvent`. This change does not also turn page entries into bare events or refactor the general `RemoteJournalStream` entry contract.

`SessionPage.events` remains `SessionEventEntry[]`.

`SessionFollowFrame` remains either an opening frame or an event frame containing `event`.

`SessionToolCallView`, `SessionToolView`, and `SessionEventEntry.view` are deleted.

The Client connection stops re-exporting `ToolCallView` and `ToolResultView` from `dsh-tools/presentation` for Session consumers.

Generated catalogs and graphs derive the narrowed Remote types and package dependencies from their owning sources.

### Durable log

- `tool/call.data.name` remains unchanged.
- `tool/call.data.arguments` remains the model-produced raw JSON string.
- `tool/result.data.message.content` remains the model-visible result.
- `tool/result.data.error` remains the structured failure identity.
- `tool/result.data.meta` remains a tool-private JSON value.
- Client card models do not write to the Session log.
- Renderer keys and Host tool implementation ids do not enter the Session log.
- Existing durable Sessions need no migration, and `SESSION_FORMAT_VERSION` does not change.

### `presentationMeta`

`presentationMeta` is not a Host tool view. It reads the canonical value when tool execution completes, and that value is not persisted. Removing it would make the following existing presentation impossible to reconstruct losslessly:

- read path, offset, lines, totalLines, and lang;
- applied contextual hunks for write/edit;
- grouped grep/glob results, truncation flag, and total;
- web_search source fields and provider answer;
- web_fetch final URL, HTTP status, and effective truncation flag.

The Client narrows `meta` locally at runtime. Renaming `presentationMeta` to more neutral result metadata is outside this decision.

## Host Design

After obtaining source events, `SessionHistoryController.page()` performs only pagination and the existing projection-baseline calculation. Attached Sessions use the projection registry snapshot; detached Sessions use its restore path over the inspected log. History does not mount a preset to change the registered projection set.

`SessionHistoryController.follow()` retains listener-first setup, opening cursors, gap-free replay, live buffering, cancellation, and teardown. It maintains no additional state for tool events.

The controller has no `presenterScopeFor()`, `viewFor()`, `backscanArgs()`, `parseToolCall()`, or `jsonView()` path. Page state contains no presenter scope or argument resolver; follow state contains no `openCalls`, `fallbackEvents`, or presentation argument resolver. Each page/follow event is wrapped only as `{event}` while addressing, ownership, cursor, sequence, and projection logic remains intact.

An immutable event-conversion helper may remain narrow or be inlined; its name is irrelevant as long as history performs no presentation work.

Session Controller dependencies remain only when another package responsibility requires them. Manifest and project references contain no presentation-only dependency.

### Performance constraints

- `page()` performs no tool-specific work.
- Adding tool results to a page does not cause repeated scans over existing page events.
- `follow()` maintains no presentation index.
- History does not trigger the Cordis `tools` service proxy.
- History does not wait for a presenter standing scope.
- History does not parse tool-argument JSON.
- History does not perform tool-view JSON clones.
- The Remote payload does not repeat structured data already expressed by `meta`.
- The Client does not scan the complete Session event window to build one card.
- The Client derives a card model again only when the corresponding immutable Tool block changes.

## Client Session and Conversation

The Client Session has no private `views` array parallel to the raw event window. `installWindow()`, `prependWindow()`, and `appendLive()` handle only event entries, cursor/hasMore state, queues, projection, and notifications.

`ConversationEventInput` contains only `event`. The Conversation assembler does not know `SessionToolView`; its replace/prepend/append behavior, Context identity, Location, and publication cadence remain unchanged.

The Chat and Trajectory Tool Definitions read no views. They derive the following data from events:

- callId;
- tool name;
- raw arguments;
- turn, step, seq, and time;
- result content;
- isError and structured error;
- result metadata;
- root/subcall parent-child topology;
- synthetic interruption results.

`RunningToolCall` has no `callView`.

`ToolResultNode` has no `callView` or `resultView`.

`ToolCallBlock` does not gain a generic `view`, `card`, `kind`, or `locations` field to replace the deleted fields. Concrete presentation remains the responsibility of `ui-tool` and keyed renderers.

### Root and Code Dispatch subcalls

Host presenter APIs describe top-level calls and results. Code Dispatch subcalls retain Generic, flattened presentation for the diff, read, search, and web models covered here; supported terminal calls use the same eligibility rules as roots.

Code Dispatch start and result events already carry `parentCallId`. Conversation preserves that existing fact on each child `ToolCallBlock`; root Session calls omit it. The diff, read, search, and web models accept only blocks without `parentCallId`; the terminal model and existing renderers that intentionally support nested calls accept child blocks.

The Details panel delegates the selected block unchanged. Shared card models apply the same terminal eligibility and nonterminal child restrictions in rows and Details, so the Details slot needs no placement field.

The keyed slot continues dispatching every subcall by its real tool name. `parentCallId` restricts only the diff, read, search, and web structured models covered by this decision. Existing specialized renderers such as Skill and Cordis, which already read raw blocks, remain unchanged.

### Missing call head

When a result node has no matching call in the current window, `ToolResultNode.call` remains `null`. The Client does not scan the window, issue another RPC, or infer a tool name from result text.

A specialized derivation that needs the name or arguments uses the current Generic fallback when `call === null`. A model that could use result metadata alone does not gain new presentation, because the current Host `presentResult` must first recover the matching call.

If a later older page supplies the call head, the Conversation Context rebuilds under existing replay rules and may then produce the already-supported specialized card.

### Argument and metadata narrowing

The Client parses JSON from `argsRaw`; a parse failure returns the Generic form instead of throwing a React render error.

Chat and Details reuse parsing for the same block through pure helpers. Any future cache must use immutable block identity and must not create cross-Session global state keyed by callId.

Each specialized model checks only the fields it needs. The Client does not copy complete Host tool schemas or invoke a Host `defineTool` validator.

Valid first-party events must be equivalent to current presenter output. Malformed, old-version, or manually edited logs promise only a crash-free Generic fallback.

## Client Card-Model Design

The existing `ui-tool/src/client/tool/models/` directory remains the single source of shared derivation for Chat and Details. Helpers return component props directly; they do not return `ToolCallView` or `ToolResultView`, and they do not create an isomorphic `ClientToolView` union.

Branches on tool name exist only in `ui-tool` card models, existing row-classification tables, or the Client plugin that owns a keyed renderer for that tool. They must not enter the Session Controller, Client Session, Conversation assembler, or generic Slot renderer.

Unknown tools continue to use `GenericToolCard` with the name, raw arguments, result content, and error.

### Generic tool row

`toolRowModel()` derives the generic row directly from `toolName`, `argsRaw`, result content, error, cwd, and home. It preserves:

- classification into `search`, `read`, `bash`, `write`, `edit`, `code`, and `others`;
- existing titles and tool-specific titles;
- summary-field priority and single-line truncation;
- comma joining of multiple queries;
- cwd-relative paths and home abbreviation;
- file-path clicks;
- pretty JSON arguments and non-JSON raw-text fallback;
- flattened result content and structured-error fallback;
- running, ok, error, and stopped states.

The title, kind, rawInput, content, and locations from Generic Host `presentCall` do not currently drive an ordinary Web row. Generic `presentResult.content` also does not drive Web output, so the Client need not copy these unconsumed values.

### Terminal card

The Client terminal model derives existing `TerminalBlock` props from the tool name, call arguments, result content, error, and Session cwd, independently of `parentCallId`.

| Input | Preserved result |
|---|---|
| running standard `bash`/`pwsh` foreground call | terminal prompt, description, cwd, and running state |
| successful standard foreground call | terminal output, exit code/signal, and success or failure status dot |
| `run_in_background:true` | Generic row and raw result |
| tool execution error | Generic IN/OUT and error summary |
| running persistent `bash`/`pwsh` | terminal prompt |
| settled persistent `bash`/`pwsh` | Generic flattened result, with no new exit card |
| foreground `terminal_send` | terminal prompt and output |
| background/error `terminal_send` | Generic result |
| Code Dispatch child | same terminal eligibility and fallback rules as a root call |

Standard shell results parse trailing `[exit code: N]` and `[killed by signal: X]` markers. A final recognized spill-policy notice selects Generic output instead: expandable in shell rows and raw in Details, because the exit marker may be displaced or omitted. A parsed marker is removed from the terminal body; timeout, sandbox denial, and markers without a pill remain in the body.

Call `description` remains above the card and overrides the collapsed summary. Workdir continues handling absolute, relative, and missing values. Relative paths resolve against the Session cwd while preserving normalization for `.`, `..`, drive letters, and UNC roots.

For `terminal_send`, non-empty input and the session id remain verbatim tool data; the empty-input fallback and session label resolve through the render site's conversation locale.

Standard and persistent providers sharing the same tool name are a special compatibility point. The Client uses currently valid argument and result features to preserve their delivered differences. Input that cannot be identified unambiguously uses a Generic settled result rather than gaining new presentation.

`TerminalBlock` ANSI handling, cursor replay, wide characters, line limits, expansion, copying, and assistive text remain unchanged.

### Diff card

| Input | Preserved result |
|---|---|
| running `write` | intended added-only diff from `file_path` and `content` |
| running `edit` | intended replacement diff from `file_path`, `old_string`, and `new_string` |
| running `str_replace_editor create` | intended added-only diff from `path` and `file_text` |
| running `str_replace_editor str_replace` | intended replacement diff from `path`, `old_str`, and `new_str` |
| successful settled `write`/`edit` | applied contextual hunks from `meta.diffs` |
| settled `str_replace_editor` | Generic, because the tool defines no result presenter |
| write create or missing/malformed/empty applied metadata | current argument fallback |
| error, malformed arguments, edit with malformed metadata, or Code Dispatch child | Generic |

Paths, `oldText:null`, `newText`, result-over-call diff precedence, the eight-line Chat limit, full-height Details presentation, and file-opening behavior remain unchanged.

### Read card

A running `read` continues to show only the summary row. A successful settled `read` reads path, offset, lines, totalLines, and lang from result metadata and confirms that the result is one text block matching the read envelope.

Missing metadata, malformed fields, a mismatched result envelope, an error, a missing call head, or a Code Dispatch child all use Generic. Cwd-relative path labels, home abbreviation, syntax language, total line count, the eight-line Chat limit, and full-height Details presentation remain unchanged.

The Client does not need to construct Host `ReadResultView.content`; Generic fallback can always read raw result content directly.

### Search card

A running `grep` or `glob` continues to show only the argument summary. Successful results produce grouped matches or a path list from `meta.shape:'matches'` and `meta.shape:'paths'`, respectively.

The Client validates path, lineNumber, line, truncated, and total. Empty matches or paths form a valid card. Missing or malformed metadata, an unknown shape, an error, a missing call head, or a Code Dispatch child uses Generic.

When `truncated:true`, the card continues to show a recovery locator from raw result content. It does not show one when untruncated. The eight-line Chat limit, full-height Details presentation, and expansion behavior remain unchanged.

### Web card

A running `web_search` or `web_fetch` continues to show only the summary row. A successful search builds the card from `meta.sources`, `meta.answer`, and `meta.truncated`; a successful fetch builds it from `meta.url`, `meta.statusCode`, and `meta.truncated`.

The Client validates every source's url, title, snippet, and publishedAt, and continues rendering only http/https URLs as links. Missing or malformed metadata, an error, a missing call head, or a Code Dispatch child uses Generic.

Search answer text, source ordering, label fallback, and truncation notice remain unchanged. The fetch final URL, status, truncation notice, and raw body below Details remain unchanged.

### Renderers already using raw blocks

- Todo rows continue deriving completed/active summaries from arguments.
- Question rows continue deriving waiting, answered, cancelled, and interrupted states from result content and errors.
- Skill rows continue deriving names and states from calls and results.
- Cordis define/run/action rows continue deriving from calls, results, and their own Client services.
- These renderers retain their props, slot keys, registration order, and visible results.

## Deliverables

`ui-deliverables` derives mutation business facts independently of presentation intent, so produced-file behavior is not coupled to card screenshots.

The Deliverables Definition observes root `tool/call` and successful `tool/result` events by callId and retains a minimal Client-owned mutation candidate without scanning the Session window or depending on a UI renderer.

| Tool | Mutation condition | Path source |
|---|---|---|
| `write` | any successful call | `file_path` |
| `edit` | any successful call | `file_path` |
| `str_replace_editor` | `create`, `str_replace`, or `insert` | `path` |
| `str_replace_editor` | `view` | produces no path |
| Other | no current first-party mutation semantics | produces no path |

Failures, interruptions, orphan results, missing paths, and malformed arguments produce no deliverable. Paths retain first-seen deduplication, and results settled after the closing Assistant seq remain excluded.

This change does not add a general tool-side-effect registry. The ability for a Host-only third-party presenter to join Deliverables automatically through `kind:'edit'` or `locations` is intentionally removed. A future real third-party mutation requirement must use a Client business contribution and cannot restore Session views.

## Fixtures and Test Data

The Client fixture deletes its handwritten `presentCall()`, `presentResult()`, `viewFor()`, and fixture tool-view types. It continues producing the same raw calls, result content, and result metadata as a real log.

| Fixture | Raw facts that must remain |
|---|---|
| terminal | arguments and real result status markers |
| diff | arguments and result `meta.diffs` |
| read | result metadata path/offset/lines/totalLines/lang |
| grep/glob | result metadata shape/files or paths/truncated/total |
| web | result metadata sources/answer or url/statusCode/truncated |
| generic/custom | name, argsRaw, content, and error |

The fixture does not import Host tool packages to compute page presentation and retains no presenter mirror. The same raw fixture continues to drive jsdom, built Web snapshots, and the `?fixture` browser path.

## Presentation-Equivalence Matrix

“Current presentation” is defined by committed component tests, assembly tests, and Web browser expected outputs. A transport or ownership refactor does not justify refreshing snapshots; an approved product change requires separate evidence.

| Scenario | Required presentation |
|---|---|
| unknown tool, running | Generic row with tool name and argument summary |
| unknown tool, settled | Generic row and raw output |
| malformed arguments | safe Generic fallback |
| orphan result | callId title and Generic output |
| interrupted call | warning/stopped state |
| foreground bash/pwsh | current terminal prompt, body, cwd, and state |
| background/error bash/pwsh | current Generic IN/OUT |
| persistent shell | current running terminal and settled Generic form |
| terminal_send | current foreground terminal and background/error Generic form |
| write/edit | current intended/applied diff and error fallback |
| read | current running summary, settled ReadBlock, and error fallback |
| grep/glob | current grouped/path card, truncation, and recovery |
| web_search/web_fetch | current source/summary card and raw body |
| Todo/Question/Skill/Cordis | current specialized rows |
| Code Dispatch subcall | terminal cards when eligible; diff/read/search/web remain Generic/flattened |
| Chat and Details | identical card fields for the same call |
| Trajectory | current identity, tree, selection, and details |
| Deliverables | current successful-mutation chips and links |

## Client Extension Contract

`tool.call.toolview` remains the sole tool UI registration mechanism. A tool that needs specialized Client presentation must have a Client plugin register its wire tool name.

The registrant receives the raw `ToolCallBlock`, Session path information, and host actions, and validates the argument and metadata fields it recognizes. It does not call the Host tool registry, depend on `presentCall` or `presentResult`, or require `SessionEventEntry.view`.

A tool with no Client renderer consistently degrades to Generic. Only one keyed registration for a tool name can be active, and duplicate keys continue to fail loudly.

A Session-scoped slot can express Client-side Session differences, but no renderer variant is inferred from a preset. A Host-only presenter does not grant a Web rich card automatically. This is the explicit boundary between “the Host describes presentation” and “the Client plugin owns presentation.”

## Failures and Fallback

- The Client treats arguments and metadata as wire JSON and narrows them at the consumption site.
- Argument JSON parse failure uses Generic.
- A known tool missing required fields uses Generic.
- Missing or malformed metadata uses Generic, except successful `write`, whose current presenter preserves its argument-derived whole-file diff.
- An error result does not show a success card merely because metadata is present.
- A missing call head does not trigger guesses about the tool name or arguments.
- Unknown metadata fields are ignored.
- A new metadata variant uses Generic in an older Client.
- Card-model helpers catch expected parse failures instead of relying on a React error boundary for ordinary fallback.
- Unexpected failures inside a keyed renderer remain isolated by existing Slot error handling.

## Same-Named Host Providers

The Host registry allows different scopes to provide different definitions under the same tool name. Through presenter scope, a Session view can theoretically select a different render intent by preset. After removing the view, the Client keyed slot observes only the wire name and cannot observe Host definition identity.

The notable current first-party examples are standard and persistent `bash` and `pwsh`. Client derivation uses valid argument and result features to preserve their delivered differences without a provider-id wire field. Malformed or custom same-name provider input that cannot be distinguished uses Generic.

This change does not promise to preserve differences expressed only through a Host presenter by third-party same-name providers. If the product later requires distinct Client presentation for same-name providers, it must define a stable, non-presentational Client identity and must not restore per-page Host view computation.

## Shipped Scope

### Session Controller

- `SessionEventEntry` contains only the raw event.
- Both Session tool-view types are absent.
- History has no presentation imports, helpers, or page/follow presentation state.
- Addressing, pagination, follow, and projection logic remain in the Session owner.
- Host tests assert the raw journal contract.

### Session Controller Client

- `Session.views` is absent.
- EventSource replace/prepend/append deltas remain unchanged.
- Transport, fixture, and test-support types carry raw entries.
- Event identity and reference stability remain unchanged.

### UI Conversation, Chat, and Trajectory

- Conversation input and Tool blocks contain no view fields.
- Chat and Trajectory Tool Definitions read raw events.
- Event pairing, Context replay, trees, and target snapshots remain unchanged.
- Child Tool blocks preserve the existing Code Dispatch `parentCallId`; row and Details slot owner props add no separate placement field.

### UI Tool and Deliverables

- Card models derive from raw blocks and metadata.
- Chat and Details share the same helpers.
- Generic fallback and keyed dispatch remain unchanged.
- Deliverables recognizes first-party mutation arguments.

### Fixtures, documentation, and generated artifacts

- Fixtures send only raw events and metadata.
- Session Controller and Client README/JSDoc contracts describe the raw journal and Client presentation owner.
- The tool cookbook documents the Web Client integration path.
- This Agent Note is the decision owner; retained Host presenter notes keep their independent decisions.
- Authored Remote types, dependencies, READMEs, pairing records, and generated references remain synchronized.

## Verification Matrix

### Host

- page returns contiguous raw event entries.
- follow returns an opening cursor and contiguous raw event entries.
- page/follow behave identically without the Tools service.
- A cold page does not resolve or mount a preset.
- A tail page computes its baseline through the standard projection registry; provider availability follows the projection composition rather than a history-side setup path.
- Addressing, ownership, message-aligned boundaries, and tail projection remain unchanged.
- Listener-before-read, reconnect catch-up, and gap repair remain unchanged.
- Many tool results do not trigger a backscan per result.
- Wire results contain no view.

`session-history-journal.host.spec.ts` owns pagination, continuity, and history error behavior without presenter assertions.

### Client Conversation

- replace, prepend, and append accept entries without views.
- Chat and Trajectory root call/result pairing remains unchanged.
- The Code Dispatch tree remains unchanged.
- Result-only fallback remains unchanged.
- A synthetic interruption result copies no view.
- Node identity across registry rebuild, older prepend, and live append remains unchanged.

### Client card model

- terminal produces the pinned props from raw arguments/content.
- diff produces the pinned diffs from arguments/metadata.
- read produces the pinned lines from metadata/content.
- search produces the pinned grouped/path card and recovery from metadata/content.
- web produces the pinned sources/fetch summary from metadata/content.
- unknown, malformed, error, missing-call, and missing-metadata cases remain Generic.
- absent and present `parentCallId` cases prove equal terminal eligibility and preserve Generic fallback for diff, read, search, and web descendants.
- Chat and Details produce identical card fields for the same block.

### Deliverables

- Successful write/edit calls produce `file_path`.
- str_replace_editor create/str_replace/insert calls produce `path`.
- str_replace_editor view produces no path.
- failure, interruption, malformed input, and orphan results produce no path.
- First-seen deduplication and the closing-seq cutoff remain unchanged.

### Assembly and browser

- terminal, diff, read, search, and web browser expected outputs all pass without refresh.
- Visible assertions for the tool tree, details, trajectory, and deliverables retain their expected values.
- The built Client still displays the same cards after obtaining raw events from real Remote page/follow operations.
- Fixtures and the real Host use the same Client derivation.
- A minimal preset independently pins persistent-shell behavior.

### Static and documentation

- Production code contains no `SessionToolView` or `SessionToolCallView`.
- Session history does not reference `dsh-tools/presentation`, `ctx.tools`, `presenterScopeFor`, or `backscanArgs`.
- Client Conversation does not reference `ToolCallView` or `ToolResultView`.
- Client models do not read `callView` or `resultView`.
- The fixture defines no presenter mirror.
- Host `presentCall`, `presentResult`, and `presentationMeta` remain.
- No new Client registry or Host-to-Client presentation hint exists.
- Affected authored types, READMEs, Agent Notes, catalogs, and graphs are synchronized.

## Verification Commands

Changes to this decision use `dsh-pre-push-checks` to select commands for the final diff. Required evidence includes:

- focused Session Controller history/transport tests;
- ui-chat and ui-trajectory Tool Definition tests;
- ui-tool terminal, diff, read, search, web, row, tree, and details tests;
- ui-deliverables produced-file tests;
- connection fixture and Client runtime tests;
- affected Host and Client TypeScript faces;
- lint and duplication;
- per-file 100% coverage for affected source files;
- `DSH_SNAPSHOT=replay pnpm run test:web`, without refreshing existing presentation goldens;
- authored Remote type and TypeScript checks;
- `pnpm run doc-sync`;
- `git diff --check`.

## Shipped Invariants

- Session page/follow does not read the Tools registry or a presenter scope.
- Session history has no callId backscan, presentation cache, or view clone.
- A Remote Session entry carries no view.
- The Session log and `SESSION_FORMAT_VERSION` remain unchanged.
- Result metadata passes byte-for-byte through the log and Remote to the Client.
- Conversation assembles `ToolCallBlock` only from raw events.
- `ToolCallBlock` contains no Host render-intent fields.
- The five structured card models read only raw blocks and Session path facts; only diff, read, search, and web use `parentCallId` to reject children.
- Generic, Todo, Question, Skill, and Cordis rows remain unchanged.
- Deliverables does not depend on render intent and preserves current paths.
- Text, components, expanded content, states, links, and ordering for all first-party top-level tools remain unchanged.
- Malformed, missing-metadata, error, orphan, and unknown-tool cases continue to fall back safely.
- Code Dispatch diff, read, search, and web subcalls remain Generic and flattened; terminal subcalls follow root eligibility.
- Chat, Details, and Trajectory behavior remains unchanged.
- Existing Web browser expected outputs pass without refresh.
- Host presenter APIs, implementations, and direct tests remain unchanged.
- ACP output remains unchanged.
- No new downstream presentation field or second Client registry is introduced.
- Pagination cost no longer grows as the number of results multiplied by page event count.
- Downstream payloads no longer duplicate result metadata in a card DTO.

## Alternatives considered

### Optimize only `backscanArgs` and retain views

Building one `callId → {name,args}` Map before processing a page would make backscan linear, and live follow already has an `openCalls` fast path. It would leave Host lookups, preset scopes, presenters, JSON clones, duplicate payloads, and dual ownership intact, so this alternative is rejected.

### Add a presenter registry to the Client

Copying the `presentCall` and `presentResult` interfaces into the browser would duplicate the registration, lifecycle, fallback, and override semantics of the `tool.call.toolview` slot. Renderers would still have to convert presenter DTOs into component props, so this alternative is rejected.

### Have the Conversation Tool Definition produce one unified view

This would put tool names and UI-card semantics into the target-neutral Conversation owner and recreate an intermediate DTO isomorphic to the Host view, so this alternative is rejected.

### Delete `presentationMeta`

Read line structure, applied diffs, search grouping, web sources, and effective truncation cannot be recovered losslessly from model text. Parsing free-form text would also bind the UI to output wording, so this alternative is rejected.

### Persist canonical tool results

This would enlarge the Session log, expose internal result structures, change the durable format, and potentially store objects far larger than presentation requires. Existing metadata is sufficient, so this alternative is rejected.

### Delete Host presenter APIs

Deleting them would shrink more code, but the decision preserves Host `presentCall` and `presentResult`. Their APIs, implementations, tests, and types remain independent of Session Remote.

### Import Host tool implementations into the Client

Tool packages include Node, filesystem, subprocess, or provider dependencies and cannot enter the browser bundle. The Client consumes only raw JSON and maintains narrow parsers inside its own renderers, so this alternative is rejected.

### Query presentation from the Host per result

An on-demand RPC would turn one page read into N network calls and would still require Host lookups, scope restoration, callId recovery, and error coordination, so this alternative is rejected.

### Allow presentation enhancements

Bundling richer Code Dispatch cards, missing-call-head inference, or other historical presentation enhancements with the ownership change would prevent snapshots from proving equivalence. This decision rejects that coupling; the [nested terminal-card exception](../bug-fix/2026-09-05-nested-terminal-cards.md) does not relax nonterminal child restrictions.

### Accept temporary Generic degradation

Stopping view delivery before completing Client cards would temporarily degrade terminal, diff, read, search, web, and Deliverables behavior. Client-equivalent derivation and Host removal must land in the same releasable change.

## Consequences

The decision removes presentation work, repeated scans, and duplicate view payloads from Session reads. Its cost is that the retained Host presenter and Client card derivation can evolve independently, so both sides require owner-specific tests and Web equivalence remains an explicit product constraint.

### Client and Host logic drift

Each tool may have one Host render intent and one Client card derivation. They serve different consumers and do not share a runtime path. Unrefreshed browser expected outputs pin visual equivalence for the first-party Web experience, while Host presenter tests constrain only the Host API.

### Same-named providers lack stable identity

A raw event records the tool name but not the specific ToolDefinition. The Client uses valid event fields to preserve differences between standard and persistent shells. Ambiguous custom or malformed input falls back to Generic; the wire has no extra hint for theoretical extensibility.

### Metadata is unknown JSON

Old Sessions may lack fields, and manually edited logs may contain malformed values. Each Client model must narrow locally and cannot pass unknown arrays or objects directly into UI primitives.

### Preset-owned projection availability

History does not compensate for projection units absent from the current composition. A preset-owned unit that must remain visible across a cold read requires the shared Session preparation/projection composition to make its definition available before restore; history must not regain a preset-mount or presenter setup branch.

### Two targets must stay synchronized

Chat and Trajectory have separate Tool Definitions and both carry the raw fields. Card derivation remains only in `ui-tool` and cannot be copied into either Definition.

### Deliverables has a hidden dependency

Deliverables is not a visual component, so its mutation parser must remain synchronized with supported first-party write tools. Dedicated tests pin file chips and Markdown links independently of card screenshots.

### Fixtures can create false confidence

Fixtures send raw events and metadata rather than handwritten views. Real-Host assembly coverage remains necessary because fixture-only snapshots cannot prove the transport path.

### Incorrectly refreshing snapshots

This change promises unchanged user-visible output. A snapshot difference must be fixed in Client derivation. Expected outputs must not be refreshed unless the owner separately approves a specific visual change.

### Documentation drift

The Agent Note, package READMEs, cookbook, root rules, and generated references must change together whenever the raw journal or Client presentation owner changes. Host API documentation remains separate.

### Remote protocol narrowing

The absence of optional `view` is a prerelease wire-type decision shared by all consumers. There is no compatibility shim, dual-writing, or version negotiation.

## Relationship to Existing Decisions

[Nested terminal cards](../bug-fix/2026-09-05-nested-terminal-cards.md) partially supersedes only the terminal child-card prohibition and its visual-equivalence requirement. This note remains active for raw-journal ownership, Client derivation, and the diff/read/search/web child restrictions.

This note partially supersedes the implementation fact in [Client tool presentation ownership](../../archived/architecture/2026-08-08-client-tool-presentation-ownership.md) that “card models receive Host views.” Its core decisions remain: `ui-tool` owns presentation, business plugins use keyed slots, and Conversation owns only lifecycle and topology.

This note preserves [toolview dissolution](../../archived/architecture/2026-07-23-toolview-dissolution.md): the Client still has one slot registration model and does not restore `ToolViewRegistry`.

This note narrows the consumer scope of the [render-intent union](2026-07-02-tool-render-intent-union.md). The Host APIs and types remain, while the Session Remote and Web Client do not consume them. This note owns the transport split without rewriting that presenter decision.

This note updates the entry contract from [Session history and Remote event transport](2026-08-18-session-history-and-event-transport.md): the journal transports only raw events plus an independent projection baseline, not transient tool views.

This note follows [Conversation Node assembly](2026-08-09-client-conversation-node-assembly.md): the Tool Definition owns event pairing and the call tree, while concrete card models remain in `ui-tool`.

This note preserves result metadata from the [canonical tool output contract](2026-07-20-canonical-tool-output-contract.md), because it is the lossless, replayable input to Client derivation.

## Deferred

- A separate explicit decision may evaluate deleting Host presenters if they remain without production consumers; this decision does not prejudge it.
- Specialized diff, read, search, and web cards for Code Dispatch subcalls require a separate design and visible-snapshot updates; terminal calls are covered by the linked partial supersession.
- A third-party mutation tool that joins Deliverables requires a new Client-owned contribution; this decision does not create a registry for an absent consumer.
- Distinct Client presentation for same-named providers first requires a stable, non-presentational identity; it must not restore per-page Host views.
- If Client card-model performance needs measurement, an immutable-block microbenchmark can be added; the shipped architecture already prohibits scanning the Session window.
