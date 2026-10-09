# Agent Note: Pi extensions bridge

Status: proposed

English | [中文](2026-10-03-pi-extensions-bridge.zh.md)

## Problem

Pi 1.0.0 extensions are in-process TypeScript factories `(pi: ExtensionAPI) => void`. A factory subscribes to about forty lifecycle, context, tool, and provider events, registers model tools, slash commands, model providers, and MCP servers, and talks to the user through `ctx.ui` ([extensions guide](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/extensions.md), [API types](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/core/extensions/types.ts)). The API is published and widely used: about 11,000 npm packages carried the `pi-package` keyword in October 2026.

DSH has bridges for two other ecosystems: shell hooks written for Claude Code and Codex ([hooks group](../../../../packages/experimental/README.md)) and Claude Code mods ([compatibility page](../../../../docs/subsystems/claude-code-mods.md)). Pi's extension API is broader than either. It lets one in-process module rewrite the messages of a single request, edit tool arguments, append its own durable records, and continue a finished run. Serving that API from DSH extension points answers two questions: how much of an extension written for another harness runs unchanged, and which DSH core mechanisms are narrower than Pi's.

## Proposal

Add an experimental bridge that loads unmodified Pi extension sources and serves Pi's `ExtensionAPI` from existing DSH extension points. The bridge is a capability demonstration: it runs extensions as written where an existing DSH mechanism carries the behavior, leaves the rest unserved, and lists every difference on a compatibility page. Apart from the restricted plugin records that extension state needs (row 9 of the gap table), each core gap is closed by a separate change.

### Packages and composition

- `@deepseek-ai/dsh-experimental-pi-extensions` is the Host package and provides `ctx.piExtensions`. `@deepseek-ai/dsh-experimental-client-ui-pi-extensions` is the Web package. Neither is an optional bundle; an opt-in overlay composes them, as for the Claude Code mods bridge.
- One cordis.yml row names one extension source: a file, a directory with an `index.ts` or `index.js`, or a Pi package directory whose `package.json` lists `pi.extensions`. The row also carries the extension's flag values. Row order is Pi's load order, which is also its handler dispatch order.
- The bridge does not scan `~/.pi` or `.pi`, install packages, or decide project trust. A Pi package's skills, prompt templates, and themes are not loaded.

### Loading and execution

- The bridge has its own loader and event dispatcher. `@earendil-works/pi-coding-agent` is not a dependency.
- `jiti` imports the source, so TypeScript loads in a built installation. The loader resolves the imports Pi supplies to extensions: `typebox` and `@earendil-works/pi-ai` to the bridge's own dependencies, `@earendil-works/pi-coding-agent` to a module of the bridge that implements the helpers that need no Pi runtime (`defineTool`, the tool-event type guards, the truncation helpers, `withFileMutationQueue`, `getAgentDir`), and `@earendil-works/pi-tui` to the optional peer dependency when the deployment installed it. An extension that imports a module the loader cannot resolve fails to load with an error naming the module.
- Extension code runs in the Host process with the process's full authority, as mods do.
- Every Session with an in-process Agent gets its own runtime: the module is evaluated once per row, and its factory runs once per Session, as Pi re-runs factories for each Session. State an extension keeps at module scope is shared by all Sessions of the Host process; Pi also keeps one module instance across the Sessions of a process, but runs one Session at a time. A subagent's Session gets a separate runtime in Pi's `print` mode with `hasUI: false`, so a tool call a subagent makes passes the same extension handlers as the root's.

### Serving the API

| Pi API | DSH mechanism |
|---|---|
| `session_start`, `session_shutdown` | `agent/created` (awaited before the first turn), `agent/disposed` |
| `input` (after inbox admission; see row 7), `before_agent_start` | `system-prompt/assemble` and `agent/pre-step`: claimed user messages are transformed or dropped, a returned `systemPrompt` replaces the assembled prompt for that turn, and returned messages join the step |
| `tool_call` | `tools/pre-execute`: `block` becomes a denial; a handler that throws denies the call |
| `tool_result` | `tools/post-execute`: replaced content is installed as the result's content |
| `agent_before_settle` | `agent/turn-stopping`: returned custom entries are recorded, and a returned message with `continue` is steered into the turn |
| `agent_start`, `agent_end`, `agent_settled`, `turn_start`, `turn_end`, `message_start`, `message_end`, `tool_execution_start`, `tool_execution_end`, `model_select`, `session_info_changed`, `session_compact` | Session events and `agent/status`, delivered in order as notifications |
| `registerTool`, `ctx.executeTool` | Agent-scoped `ctx.tools` registrations; nested calls run the full tool pipeline; built-in names follow the translation below |
| `registerCommand`, `getCommands` | Agent-scoped `ctx.commands` |
| `sendUserMessage`, `sendMessage` | `agent.followup()`, `agent.steer()`, `agent.inject()` |
| `appendEntry`, `setLabel`, tool `details`, `ctx.sessionManager` | Ignorable Session records and `tool/result` metadata, read back as Pi entries |
| `getActiveTools`, `setActiveTools`, `getAllTools` | `ctx.tools.schemas()`; `setActiveTools` applies a scoped `ctx.tools.restrict()` to global tools and adds or removes the bridge's own Agent-scoped registrations, because a restriction does not hide scoped tools |
| `setModel`, `getThinkingLevel`, `setThinkingLevel` | An `agent/request` override |
| `exec` | `ctx.subprocess`, argv without a shell |
| `ctx.ui.select`, `confirm`, `input`, `editor` | `ctx.userQuestions` |
| `ctx.ui.notify`, `setStatus`, `setWidget`, `setTitle`, `setEditorText` | A Remote stream the Web package renders |
| `registerFlag`, `getFlag`, `events` | Row configuration; an in-process event bus per Session runtime |

All Pi handlers for one Session run through one ordered queue. A notification never overtakes an earlier one, and an awaited hook such as `tool_call` runs after every notification queued before it, which keeps the order Pi's awaited dispatch gives handlers.

The Web and Desktop GUI appear to extensions as Pi's `rpc` mode with `hasUI: true`; headless, SDK, and ACP Sessions appear as `print` mode. Extensions already handle both: terminal-only calls such as `ctx.ui.custom()` return what Pi's `rpc` mode returns.

### Built-in tool calls as Pi sees them

DSH and Pi share the names `bash`, `read`, `edit`, `write`, and `grep`, but not their arguments, and Pi's `find` is DSH's `glob`. A Pi safety extension reads `event.input.path` or `event.input.command`. The bridge therefore presents each call of these six tools to handlers with Pi's name and Pi's argument names, translated from the DSH call. Other tools pass through unchanged. A test loads the registered DSH tool schemas and fails when a mapped parameter is renamed or removed, or when a tool gains a parameter the table has not classified.

The opposite direction uses the same table. `getActiveTools()` and `getAllTools()` report Pi names for the six tools and DSH names for every other tool, and `setActiveTools()` accepts the same names. `ctx.executeTool()` given a Pi name translates the arguments into the DSH call; an `edit` call with more than one entry in `edits` is refused, because one DSH `edit` call makes one replacement. An extension tool registered under a Pi built-in name replaces the corresponding DSH tool for that Agent, as it replaces Pi's own tool (`find` replaces `glob`).

### Unserved features

- An event DSH cannot raise is accepted at registration, never raised, and named in a warning when the extension loads.
- A `pi` or `ctx` member DSH cannot serve throws an error naming the member.
- Where Pi fails closed, the bridge does too. A `tool_call` handler that edits `event.input` gets the call denied with a reason, because the logged call would otherwise differ from the executed one.

### Extension state

Pi extensions rebuild their state on `session_start` from what they wrote earlier. The bridge keeps that state in the Session log so that it follows resume and fork:

- `appendEntry` and `setLabel` write ignorable records whose type starts with `plugin:`. A restricted core operation, callable only from experimental packages, appends them. They are not `SessionEventMap` members, so the persistence catalog and its type history are unchanged. A build without the bridge retains and skips them when it reads the current format, as the [ignorable events decision](../../implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md) requires. A later format edge carries them on a best-effort basis: it keeps them under their names where it can and otherwise states which it drops, while the alpha historical edges refuse every unknown event ([decision](../../implemented/architecture/2026-08-31-alpha-historical-unknown-event-refusal.md)).
- A tool's `details` is stored as the `tool/result` metadata the tool's output declaration projects.
- `sendMessage` content is logged as an ordinary user-sourced message with the extension's content unchanged. A companion ignorable record carries `customType`, `display`, and `details`.

### Core mechanisms narrower than Pi's

Ranked by how much of Pi's API each blocks, with the GitHub issue that tracks each. Rows 1 and 3 follow from DSH rules: a request is derived from the Session log, and the log is linear. The other rows are missing extension points.

| # | Mechanism | Pi API blocked | DSH today | Issue |
|---|---|---|---|---|
| 1 | Per-request rewrite of model input | `context`, `context_with_system`, `before_provider_request`, `prepareLoadout` hidden declarations | The loop derives each request from the log and freezes it; `llm/stream` listeners read it. A rewrite needs an awaited hook and a core event that every log reader applies to that request. | #5661 |
| 2 | Tool-argument rewrite | `tool_call` editing `event.input` | `PreToolDecision` excludes input rewriting ([proposal](2026-06-30-pre-tool-input-rewrite.md)). | #5662 |
| 3 | Session tree and assistant-message replacement | `navigateTree`, `session_before_tree`, `session_tree`, `message_end` replacement | The log is linear, a fork creates a new Session, and an `assistant/message` cannot replace another. | #5663 |
| 4 | Awaited step-end and pre-commit hooks | `turn_end` entries and `continue`, `message_end` | `step/end` and `assistant/message` are committed events; a Session-event listener cannot append. | #5664 |
| 5 | Tool progress and result replacement | `onUpdate`, `tool_execution_update`, `tool_result` turning an error into a success, tool `usage` | `ToolRunContext` has no progress channel, and `tools/post-execute` cannot replace the value of a failed result. | #5665 |
| 6 | Per-tool exposure | `codemode`, `deferred`, and `hidden` exposure | Presentation is chosen per Agent, and a tool the model cannot see refuses execution. | #5666 |
| 7 | Input admission | `input` before the prompt is stored | A prompt is durable in the inbox before `agent/pre-step`; a swallowed prompt leaves a turn without a step. | #5667 |
| 8 | Logged model call by a plugin | `ctx.modelRegistry.complete`, `stream`, `streamSimple` | No Session event records a plugin's own model request, which also blocks `$.model.complete` for mods. | #5668 |
| 9 | Plugin-owned durable records | `appendEntry` | `Session.append()` accepts declared event types only. The restricted `plugin:` records close this for experimental packages. | #5669 |
| 10 | Compaction customization | `session_before_compact` | One `CompactionEngine` owns summarization, and `/compact` takes no instructions. | #5670 |
| 11 | Lifecycle reasons | `session_start` reasons `new`, `fork`, and `reload`; `session_shutdown` reasons | `agent/created` reports `startup` or `resume`; `SessionStartSource` also declares `clear` and `compact`, which nothing emits yet; `agent/disposed` carries no reason. | #5671 |
| 12 | Host-plugin display in the GUI | `ctx.ui.notify`, `setStatus`, `setWidget` | No shared mechanism; each bridge ships its own Client package. | #5672 |
| 13 | Command capabilities | Argument completion; `newSession`, `fork`, and `switchSession` moving the user to another Session | `ctx.commands` takes unstructured text and has no Client-side effects. | #5673 |
| 14 | Provider request hooks | `before_provider_headers`, `after_provider_response`, `provider_stream_event` | Headers, responses, and raw stream events stay inside each adapter. | #5674 |
| 15 | Fault isolation | An extension bug stops one Pi process | An uncaught exception in the Host disposes the application for every Session. | #5675 |

Terminal rendering (`ctx.ui.custom`, custom editors, renderers, shortcuts) is outside this list: DSH's GUI is not a terminal, and Pi's own `rpc` mode does not serve these either.

## Alternatives considered

**Depend on `@earendil-works/pi-coding-agent` and reuse its loader and runner.** It would reproduce Pi's handler ordering and error rules exactly and supply every helper extensions import. It was rejected because the exercise is to carry Pi's API on DSH mechanisms, not to embed Pi's harness: the runner is constructed over Pi's `SessionManager` and `ModelRegistry`, the package brings Pi's whole dependency closure, and its built-in tool factories would run Pi's own file and shell implementations outside DSH's filesystem and sandbox policy.

**A wrapper module per extension, like `defineMod`.** A Pi extension is already a default-exported factory with no manifest to replace, so a wrapper adds a step for every extension and prevents loading a published Pi package directory.

**Discover Pi's own locations automatically.** Loading `~/.pi/agent/extensions` and project `.pi/extensions` executes code a DSH user did not compose, which needs a project-trust decision DSH does not have. The mods bridge removed its directory loader for the same composition reason. Discovery can be a later opt-in layer.

**Run extensions in a separate process per Session.** An uncaught extension error would then reach the Host as an event. Every awaited hook would become an inter-process round trip, and Pi's edit-in-place event objects would have to be reproduced by sending changes back. Deferred until real extensions show the isolation is needed.

**Evaluate each extension module once per Session.** Concurrent Sessions would then not share module-scope state. Rejected because Pi keeps one module instance across the Sessions of a process, so an extension may rely on module state surviving a Session switch, and per-Session evaluation repeats the transpilation for every Session and subagent.

**Run extensions for root Sessions only.** It needs an explicit filter, since `agent/created` fires for every Agent, and it lets a subagent's tool calls bypass a Pi safety extension.

**Pass DSH tool names and arguments to handlers unchanged.** Pi's own `protected-paths` example reads `event.input.path`; with DSH's `file_path` it throws, and a handler written slightly differently would allow the write.

**Declare `pi/*` Session events and a `pi-extension` message source.** Correct attribution, but each is a required-on-read persistence type: the catalog and type history change, and a build without the bridge refuses the Session.

**Keep extension state in a storage domain outside the log.** State would not follow a fork, and `ctx.sessionManager.getBranch()` would not show what the extension wrote.

**Raise `context` and `before_provider_request` without logging their effect.** The model would see input that the Session log cannot reconstruct.

**Refuse to load an extension that subscribes to an unserved event.** Most extensions use several features; the mods bridge already warns and keeps the rest working.

**Build a shared GUI notification mechanism first.** It would also serve the mods bridge, but it is a core addition; the Web package of this bridge renders its own stream until that exists.

## Acceptance criteria

- Pi's MIT-licensed example extensions are committed unchanged as fixtures, and only those a test exercises. Through a real agent loop with a mock model: a permission extension denies a tool call and the model sees the reason; an extension tool is called by the model and its `details` survive a resumed Session; an extension command runs; an extension replaces the system prompt for a turn; `appendEntry` state is rebuilt on `session_start` after resume.
- A subagent's tool call reaches the handlers of its own runtime.
- The tool translation test fails when a mapped DSH tool parameter changes.
- A Loader composition test boots the bridge from a cordis.yml, and a disposal test shows every registration removed when the bridge unloads.
- A recorded-Session snapshot covers an extension-denied tool call and an extension tool call.
- `docs/subsystems/pi-extensions.md` lists every event and member with its status and every behavioral difference.
- The new packages' `src/` have 100% coverage, and `doc-sync` passes.

## Risks

- Extension code has the Host's full authority, and one uncaught error stops every Session. Mount only extensions you would run as a plugin.
- Fidelity rests on the bridge's reading of Pi 1.0.0 dispatch rules, checked against Pi's examples but not executed on Pi's code. A later Pi release can change an event or helper the bridge serves.
- An extension that imports a helper the bridge does not implement fails to load, even if it would have used that helper on one code path only.
- A future Session format edge that cannot carry plugin records loses extension state for Sessions written before it.
- Extensions that keep per-Session state at module scope mix the state of concurrent Sessions, including subagents.
- A message an extension sends is attributed to the user everywhere outside the Web package that reads the companion record.
