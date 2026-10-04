# Agent Note: ACP as an automation-only protocol

Status: implemented

English | [中文](2026-07-23-acp-automation-only-protocol.zh.md)

> The automation-only boundary remains current. [Standard ACP v1 automation controls](../../../../packages/acp/acp/README.md) supersedes only this note's prompt-only method, configuration, MCP, update, and lifecycle inventory; it does not restore ACP as a UI.

## Problem

The ACP bridge had become a second interactive product UI. It translated durable events into editor cards, terminal metadata, diffs, plans, titles, reasoning, commands, modes, model and permission pickers, session navigation, and human elicitation. Those responsibilities duplicated the TUI and the Web client while coupling an automation transport to UI services, persistence queries, presentation policy, and editor-specific conventions.

ACP still has one useful role: another agent or automated controller can start a harness process, create an isolated session, send text or a narrowly supported inline image, receive the committed text/image answer, cancel work, and answer a permission request. The out-of-process ACP subagent backend depends on that standard protocol boundary.

The snapshot suite complicates removal. Most ACP scenarios exercise the assembled agent backend rather than ACP presentation, so deleting the suite with the editor bridge would discard broad keyless behavioral coverage.

## Decision

`@deepseek-ai/dsh-acp` is an automation transport under [`packages/acp/acp`](../../../../packages/acp/acp/README.md), outside the `ui` package group. Its public protocol contains standard automation controls rather than presentation: persistent session creation/list/resume/close, one in-flight prompt per session, model configuration, stdio/HTTP MCP mounting, committed semantic updates, cancellation, concurrent sessions, and one-shot permission requests. Prompts preserve text and supported raster images in wire order, while resource links flatten to bracketed textual references; the bridge still rejects additional directories, audio, embedded resources, malformed or empty prompts, unknown sessions, and overlapping prompts.

Image capability is truthful rather than structural: `initialize` advertises it only when a durable attachment store exists and the configured exact provider/model resolves with explicit image input. Each prompt snapshots its exact route before asynchronous admission, strictly decodes every image block, and delegates the complete batch to `AttachmentStore.saveImages()` before publishing the user event. That same snapshot drives the admitted turn even if the next-turn configuration changes concurrently. Cancellation reserves and aborts the admission slot before any asynchronous work, waits for already-started writes to quiesce before the prompt settles, and never publishes a late message; before the prompt enters the Agent inbox it neither cancels nor waits for unrelated Agent work. A completed content-addressed write may remain unreachable because destructive rollback is not valid for a deduplicated store. Caller-correctable image-policy failures map to invalid parameters, while route lookup, storage corruption, and persistence failures remain internal faults.

The bridge emits only committed semantic facts. A per-session promise chain preserves reasoning, assistant block, tool lifecycle, configuration, and usage-update order while assistant image references are asynchronously re-read and integrity-verified for ACP base64 delivery; a missing or corrupt object fails prompt delivery instead of becoming a placeholder. Raw chunks, todos, plans, titles, retry markers, terminal metadata, diffs, locations, and presentation projections remain off the ACP wire. Standard model and reasoning options, list/resume/close, and stdio/HTTP MCP are automation controls; session load/delete/fork, commands, modes, plan review, terminals, client filesystem operations, and human elicitation remain unsupported.

One-shot `session/request_permission` remains. It is a machine policy channel for bridge-owned agents, not a human approval UI: the answerer accepts only an exact agent object in the bridge's live session map, delegates foreign or call-less requests, and maps failed RPCs to the fail-closed unavailable outcome. The client chooses allow once, reject once, or cancel, and the bridge never turns that response into a durable grant. Asking policy stays in the approval seam and its producers; [`dsh-subagent-acp`](../../../../packages/subagent/subagent-acp/README.md) uses this channel programmatically.

The app composition contains the mandatory agent core, persistence, checkpoint policy, derived session query, and ACP transport. The ACP bridge reads persistence directly for standard resumable summaries; it does not expose command, session-reference, plan-mode, permission-picker, or user-question presentation surfaces.

The transport programs interface-level agent, session, and approval services rather than the concrete agent loop. Tool execution stays inside the harness; ACP never delegates shell execution to an editor. stdout carries framed JSON-RPC only, so the app mounts no stdout logger and the bridge does not monkey-patch process output.

Disconnect and plugin disposal share one memoized quiescence boundary. Both successful and failed transport closure cancel prompt admission and agents, drain ordered output, settle pending prompts as cancelled, dispose every bridge-owned agent, and await loop and session cleanup. A create that loses the close race disposes its unpublished handle.

## Snapshot boundary

The ACP snapshot suite still boots the assembled ACP example and retains scenarios that pin backend behavior. Only scenarios driven through deleted UI methods leave the suite. Standard resume restores a persisted Agent without replaying transcript UI, while semantic-checkpoint recovery coverage may still use the headless SDK example when that protocol is the subject.

Protocol and lifecycle tests pin stop-reason codecs, version negotiation, truthful image capability, fresh-session creation, ordered text/image admission, resource-link flattening, all-member validation before writes, absence of inline base64 in durable events, rejection of empty or unsupported prompts, exact-agent permission ownership, multi-session isolation, prompt settlement after ordered output, verified assistant-image delivery, cancellation during admission without a late followup or cancellation of unrelated Agent work, exclusion of unrelated pre-inbox failures, failed transport closure, ACP-only reload cleanup, and teardown quiescence. An assembled keyless snapshot sends a real inline PNG through the runnable ACP example and pins only its durable reference in the session log. Built and real-stdio smokes reject stray stdout. The `session/new` branch that loses a real stdio close race remains coverage-exempt because the in-memory transport cannot reproduce that ordering; it disposes the unpublished handle, while the surrounding disposal tests pin the no-orphan invariant.

## Alternatives considered

**Keep ACP as an editor UI until Web reaches parity.** Rejected because it leaves two interactive contracts to evolve and keeps editor conventions in the automation boundary.

**Keep the earlier editor bridge behind disciplined service boundaries.** Rejected even though that bridge correctly used interface services, tool-owned render intents, approval and user-questions answerers, harness-owned execution, and a stdout-pure composition. Its terminal cards were capability-gated, display-only Zed `_meta` projections with a text fallback rather than ACP `terminal/create`, so shell execution never left the harness. The projection derived each display terminal id from the stable per-call id to prevent collisions and recovered exit code or signal from the rendered status markers because the pure result presenter received content blocks rather than a structured exit; marker round-trip tests and an explicit no-capability `console` fallback test pinned both contracts. Those boundaries were coherent but could not make editor cards, session navigation, configuration pickers, and human elicitation belong in an automation protocol.

**Replace ACP with a private subagent RPC.** Rejected because ACP already supplies a typed, interoperable process protocol and is used by the out-of-process subagent backend.

**Remove machine permission requests with the other interaction features.** Rejected because an automated parent must answer a child agent's one-shot policy decision; this is control flow between agents, not presentation.

**Delete the ACP snapshot suite or migrate every scenario in this change.** Rejected because most scenarios test the backend and remain valuable, while a full harness migration is an independent testing change. Only scenarios whose driver was a deleted UI method leave this suite.

**Advertise image support whenever the ACP SDK has an image block.** Rejected because protocol vocabulary does not prove this deployment can persist bytes or that the configured exact route accepts visual input. Unknown capability is false at initialization; prompt admission rechecks the live route.

**Flatten inline and assistant images to markers or persist ACP base64 in session events.** Rejected because markers silently lose model/user intent and base64 makes durable logs the binary store. ACP translates between its wire block and the existing durable `ImageBlock` reference at the transport boundary.

**Create a generic RichContent service for ACP, MCP, and Web.** Rejected because core `ContentBlock` plus the attachment seam already own the shared contract. Each front door keeps only protocol parsing, capability proof, and lifecycle orchestration; shared batch limits and image validation stay in `AttachmentStore.saveImages()`.

## Consequences

ACP has a narrow contract suitable for agents and automation, while TUI and Web own human interaction and presentation. The package has fewer injected services, dependencies, protocol branches, and lifecycle states, and it no longer claims compatibility as a general editor entry point.

Automation clients receive committed message, reasoning, generic tool, configuration, and usage facts rather than token deltas or structured tool UI. Standard list/resume/close and session configuration cover automation lifecycle without adding navigation, transcript replay, titles, or other human presentation.

Backend snapshot coverage therefore remains transport-coupled to ACP even though that transport is incidental to the behavior under test.
