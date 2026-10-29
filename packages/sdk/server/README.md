---
description: "The stdio JSON-RPC serving plugin for deployments that let out-of-process SDK clients open sessions and drive agents in a DeepSeek Harness runtime."
kind: "package-reference"
---

# @deepseek-ai/dsh-sdk-jsonrpc-server

English | [中文](README.zh.md)

## Summary

`dsh-sdk-jsonrpc-server` serves the SDK wire protocol over stdio so out-of-process clients can drive harness agents: it opens one session per `sessionId`, queues user prompts, and streams every session event and agent status transition back to the client. Mount it as the `jsonrpc` plugin in a Loader composition; the surrounding tree supplies everything else — agents, model adapters, persistence, and tools. Stdout carries only JSON-RPC frames, so a deployment must not compose a stdout logger. It answers `shutdown` by disposing the root runtime and exiting 0; the app bin owns EOF and signal exits.

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

Mount this plugin when a runtime must serve SDK clients: add it to a `cordis.yml` that composes the agent service, boot the runtime, and clients connect over stdio. The common path is explicit — the plugin needs the `agents` service; every other capability comes from the surrounding tree.

Set `initialize.approvalRequests` to `true` to send internal approvals as server-to-client `approval/request` calls. The bridge handles SDK-owned Agents and their live in-process descendants, following `agents.isOwnedBy()` runtime ownership rather than persisted `parentSession` lineage; unrelated Agents and clients that omit the flag continue through the composed answerer chain. The approval service still applies `never` policy before dispatch and records the ask/decision audit pair. The bridge accepts only `allowed-once`, `rejected`, or `cancelled`; an invalid response, client error, or transport loss yields the service's fail-closed `unavailable` outcome. Request cancellation abandons the pending wire waiter; shutdown abandons all such waiters before draining Agents. Late replies cannot grant an abandoned operation. See the [protocol](../protocol/README.md) for the payload and the [Python example](../../../python/sdk/README.md#client-approvals) for client handling.

`session/resume` accepts a persisted `{ sessionId }` after initialization and returns `{}` once its Agent is ready. It loads history through `agents.resume()`, repairs an interrupted final turn, and preserves the stored origin and effective directory while recording the initialized model route as the Session selection. An omitted effort preserves an explicit saved effort only for that same route. It sends no new input. Missing, unreadable, incompatible, or occupied sessions reject without creating a replacement. Prompts for an identity currently being restored wait for that restoration; shutdown drains pending restoration and releases its Agent. Historical events are retained in the log rather than streamed again as new notifications. A model selection recorded during resume emits a new `session.event` notification before the resume response.

The plugin publishes the `sdkSessionActivation` readiness marker once its reminder activation handler is installed; an SDK composition injects this marker into Schedule instead of the Web Session controller. Scheduled delivery uses this same SDK Session owner. Due startup reminders wait for successful SDK initialization, then resume with its provider, model, reasoning effort, and output limit. The client can resume a reminder-restored Session once; concurrent reminder and client restoration share one handle. Shutdown releases reminders waiting for initialization and drains accepted restorations.

<a id="command-input"></a>

The supported commands below are existing Desktop native operations that can execute without a GUI. `/permission <preset>` uses that native path; the Desktop `/model` picker uses a separate model-selection API.

`session/query` is the wire entry used by high-level SDK `run()` for strings and content-block arrays. Ordinary inputs retain their blocks and use the existing prompt queue. The full SDK recognizes bare `/compact`, `/permission <preset>` with a non-blank preset, `/plan [off|message]`, and `/goal [objective|clear|edit objective|pause|resume]` identified by their official definition IDs. Bare `/permission` or `/权限`, `/compact extra`, and all other input including `/model` remain ordinary prompts. A missing command also preserves the prompt path; a selected handler's failure never falls back. An unknown preset is a native command error. Encoded image blocks accompany recognized commands through native attachment admission. `session/prompt` remains the low-level queued-input entry without native slash-command routing.

Host and Desktop adapters share `dsh-commands/builtin` for definition identity and English/Chinese aliases. The aliases `/压缩`, `/权限`, `/计划`, and `/目标` follow their official definitions after renaming; execution uses the current registered name. Exact names take precedence, but an unrelated same-name definition is not an SDK builtin and remains an ordinary prompt. Other builtin capabilities remain outside the SDK command set.

The first text block supplies the complete command line; encoded images may precede or follow it. When that line matches a supported command, it must be the only text block and every other block must be an encoded image. Additional text blocks, durable image references, and other content types reject with a JSON-RPC error before execution or enqueue, without prompt fallback. Ordinary prompts preserve all block content and ordering. Empty arrays and arrays containing only blank text are rejected; image-only input is allowed.

Recognized commands execute through the receiving Agent's native command registry. Handlers validate command arguments and attachments. Compaction owns its auxiliary model request, history replacement and checkpoint, and refuses a busy Agent. Permission changes retain their native state and notification behavior. Shutdown cancels pending commands and drains SDK command waiters before releasing Agents. Timeout is not rollback; clients must not retry automatically. See the [protocol](../protocol/README.md) for results and errors.

Permission commands change only the receiving Session. Later queries and restored Sessions retain its persisted permission facts; other Sessions keep their own state and new Sessions use the configured defaults. Neither the caller's launch configuration nor saved user defaults are rewritten. Model selection is not an SDK slash command; its resume override remains the separate behavior described above.

Without attachments, `/plan` and `/plan off` change only native plan state. `/plan` with images or a body submits through native steer, with images before the trimmed body; `/plan off` with images returns an error without changing state. High-level `run()` waits for submitted model activity, review and approved continuation, including input queued behind an earlier cancellation. The native response acknowledges handler settlement; the matching `session.query.completed` notification ends high-level activity. User-question answers preserve approval and feedback; `{ cancelled: true }` becomes native `ASK_CANCELLED`, ending the turn without leaving plan mode.

`/goal` delegates grammar to the [native goal command](../../goal/command-goal/README.md). High-level `run()` waits across automatic rounds after creation or resume, until goal termination and closing activity, including reference input queued during compaction. Completion returns `completed`, pause or clear returns `aborted`, and blocking or nonterminal loss of activation reports failure. The first durable goal termination is retained while closing activity finishes; later clear or resume operations do not replace it. The completion notification carries the final assistant text, or an empty string when none is emitted; goal status remains in the finish reason and events. State-only controls return native handler text without waiting for unrelated activity. Low-level `session/wait` can still return between rounds. Restoration preserves goal state and waits for `/goal resume` to re-arm execution. Goal commands do not change permissions or SDK launch settings.

Creation and edit accept images as reference material before the next round; show, pause, resume, and clear reject attachments without changing goal state. Compact and permission commands also reject attachments. Handler refusals never fall back to ordinary prompts; an image may already be stored before the handler refuses, as on Desktop. These SDK inputs accept raster images, not general file uploads or client-supplied attachment references.

`session/working-directory/get` accepts `{ sessionId }`; `session/working-directory/set` accepts `{ sessionId, path }`. Both return `{ cwd }` and create an unknown Session without starting a model turn. Reads recover missing directories through the working-directory service; changes preserve origin metadata and permissions, and reach the model through logged user context.

### Wiring

The plugin creates one agent per `sessionId` on first use. A registered model adapter wins the route; an unowned `deepseek-official` route mounts the DeepSeek adapter, and any other unowned provider fails initialization. The selected adapter resolves the exact model and optional reasoning effort before initialization succeeds.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxTokensAsSuccess` | `false` | Report max-token turn/subagent termination as a successful SDK result |

The profile composition owns each root agent's tools. `input`, `output`, and `exit` are runtime-only transport hooks for tests; production uses process stdio and `process.exit`. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-sdk-jsonrpc-server) is the exhaustive source for every accepted field.

### stdout is the protocol

Stdout carries only JSON-RPC frames, so clients can parse every byte; diagnostics belong on stderr. Keep stdout loggers out of the composed tree.

### What SDK clients can do

`initialize` is the runtime-readiness boundary: when the server is mounted by a Loader composition, it waits for the current plugin tree to settle before replying, so async sibling capabilities such as initial MCP tool discovery are visible to the first prompt. The handshake returns the wire-stable identity `deepseek-harness-sdk-runtime`. The server validates the provider/model route and optional non-empty `reasoningEffort` through the selected adapter before it stores them; omission stores no effort, so the model retains its own default. An optional positive `maxTokens` becomes the request output cap of each SDK-created agent and its in-process descendants, while omission applies the selected adapter or provider route default. JSON-RPC requests may dispatch concurrently, so `session/prompt` rejects until one `initialize` has completed successfully; clients must await the handshake before sending prompts. An accepted prompt queues one identified user message and immediately returns `{ messageId }`; the server then streams every durable fact as `session.event` and every whole-agent lifecycle transition as `session.status`. It does not assign an assistant message or `turn/end` to a prompt, and independent requests may enqueue more work on the same session. Persistence roots and persona come from the surrounding composition.

`session/wait` observes an existing SDK-owned session through managed descendant completion and any resulting root turns. It rejects unknown or retired roots, never creates a session, and responds after the root stays idle across the descendant check. Idle children with parked inbox messages remain resident but do not delay this response; later waking input can resume them. Session notifications emitted before completion precede the response on the stdio transport. A live Agent failure remains associated with that exact session until a later committed `turn/end` accounts for the outcome; otherwise the wait rejects, including when the failure preceded the wait request. Errors already represented by a terminal remain in Session events, and later successful activity clears an earlier live failure.

<a id="native-user-questions"></a>
### Native user questions

An initialized client advertising `capabilities.userQuestions` handles questions for this server's exact owned root Agents. The server forwards the shared `user-questions/request` event as a `user-question/ask` RPC and validates the answer before a tool or approval consumes it. Foreign Agents and clients without that capability retain their existing native answerers. Tool cancellation and server shutdown abort pending requests and notify the host; connection failure returns an error. The [protocol](../protocol/README.md#native-user-questions) defines the wire shapes and failure codes.

### Shutdown and exit

The plugin answers `shutdown`, flushes the response, disposes the root context so SDK-owned agents, subscriptions, and persistence reach quiescence, then exits 0. EOF and signal exits belong to the app bin, which also disposes the root context. Unloading only this plugin stops serving without exiting the process.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the serving plugin; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The plugin is a thin presentation adapter: [`HarnessSdkJsonRpcServer`](src/server.ts) owns the protocol methods and notifications, while the transport and the named wire types come from `dsh-sdk-protocol`, shared with the client SDKs. It subscribes to session, agent, and subagent lifecycle events and forwards them as wire notifications. `subagent.started` requires `origin: subagent` and a direct creator id; ordinary forks, including historical ones with a parent id, produce no such notification; subagent completions are forwarded only when the service-snapshotted lifecycle `local` flag is true — provider names, child ids, and durable lineage never establish locality.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, stdio wiring, request dispatch, shared shutdown/exit task |
| [`src/user-questions.ts`](src/user-questions.ts) | Native question adapter: host forwarding, answer validation, cancellation |
| [`src/server.ts`](src/server.ts) | `HarnessSdkJsonRpcServer`: protocol methods, per-session agent creation, lifecycle subscriptions, teardown |

### Request flow

Each protocol method validates its inputs and resolves the owning state before acting — `initialize` stores the SDK route, `session/prompt` resolves the live agent+session pair and queues the message, and `shutdown` flushes the response, then disposes the root context to quiescence before exiting 0 — and a shared exit task guarantees that racing `shutdown` requests never dispose or exit twice. The dispatch lives in [src/index.ts](src/index.ts) and [src/server.ts](src/server.ts).

### Teardown

`server.shutdown()` closes descendant admission below its exact root Agents and drains their managed descendants child-first before releasing the root handles and adapter. It removes its subscriptions while unrelated parent trees and the surrounding context stay running when just this plugin is unloaded. A descendant drain failure is reported after the remaining root and adapter teardown completes. Protocol `shutdown` instead disposes the root fiber so persistence and the whole runtime reach quiescence before the process exits.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the plugin contract is not enough. They move from the wire protocol to the clients and the runnable application.

- [SDK wire protocol](../protocol/README.md) — the methods and payload shapes this plugin serves.
- [TypeScript SDK client](../client/README.md) — the client that drives this plugin.
- [SDK application bundle](../../bundle/sdk-app/README.md) — the `dsh --profile sdk` application that boots this plugin.
- [Python SDK](../../../python/README.md) — the Python client that drives the same server.
- [SDK runtime distribution decision](../../../.agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md) — why the packaged runtime serves a closed plugin tree.

-----

<a id="model-experience"></a>
## Model Experience

### SDK user message

#### What the model sees

Ordinary `session/query` input and accepted `session/prompt` content enter a user message with their original block order. Ordinary input enters the prompt queue without reapplying permission defaults. Inline `SdkEncodedImageBlock` values are validated and committed through the composition's attachment store first, so the session log retains content-addressed image references rather than base64 bytes. This package adds no system-prompt prose or tool schema; those come from the other plugins in the composition.

#### Token effect

Data-dependent user-message tokens enter retained session history and are resent on later turns until another package compacts them. The JSON-RPC frames, session notifications, and server bookkeeping add zero model-context tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Manual compaction

#### What the model sees

The command line and result stay outside model messages. The existing [compact command](../../compaction/command-compact/README.md#model-experience) issues the auxiliary summary request and replaces selected history with its logged checkpoint. It adds no ordinary turn.

#### Token effect

The compaction owner pays the summary request cost and reduces later history tokens; SDK framing adds none.

#### KV Cache effect

The replaced history changes the reusable prefix according to the native compactor. The SDK adds no separate invalidation.

### Session permission changes

#### What the model sees

The command text and result stay outside model messages. The [permission preset owner](../../interaction/permission-presets/README.md#model-experience) updates the runtime-context user snapshot and may inject an approval-policy notice. A notice in a running turn can cause another step; the default presets do not change system text or tool schemas.

#### Token effect

Native policy snapshots and notices add their normal history tokens; SDK framing adds none.

#### KV Cache effect

The native context updates append after retained history without rewriting the system prefix.

### Plan commands

#### What the model sees

The native [plan-mode](../../plan/plan-mode/README.md#model-experience) guidance applies without changing permission state. A command body becomes an ordinary user message through steer; bare commands and command result text stay outside model history. The exit tool is admitted on first entry and remains declared after exit. Approval, feedback, and dismissal retain their native tool results and next-step behavior.

#### Token effect

Plan guidance, its exit-tool declaration, submitted plan Markdown, and review results have their native token costs.

#### KV Cache effect

Native system and tool updates determine prefix reuse; the SDK adds no extra plan prompt or invalidation.

### Goal commands

#### What the model sees

The native [goal driver](../../goal/goal-round-driver/README.md#model-experience) admits logged `<goal_round>` user messages. Goal tools retain their state and completion policy, including the `<goal_complete>` or `<goal_blocked>` closing context. Command text and results stay outside model history.

#### Token effect

Each admitted round and closing step has its native model cost; SDK routing adds no model input.

#### KV Cache effect

Goal-round messages and tool results append to retained history under the native driver.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the plugin needs special operational care. They are current package constraints, not a comparison with other serving approaches or a task backlog.

- **The wire has no per-session close or prompt-cancel method** — SDK-created agents remain live until process shutdown.
- **There is no per-prompt result** — `MessageId` identifies inbox admission only; clients that own an automation interval must define and observe that interval themselves.
- **stdout purity is deployment-enforced** — a surrounding config can still load a stdout logger and corrupt the JSON-RPC channel; this plugin does not inspect or veto sibling loggers.
- **Automatic adapter mounting is DeepSeek-specific** — `initialize` can reuse any pre-registered model adapter, but its only fallback mounts the DeepSeek adapter.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the code. The single-executable runtime distribution pairs this plugin with the packaged `jsonrpc-demo` bin; keep the shutdown/exit contract consistent with the app bin, which owns EOF and signal exits. No other unresolved design questions are recorded.

</details>
