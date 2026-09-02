# Agent Note: Standard ACP v1 automation controls

Status: implemented

English | [中文](2026-08-22-standard-acp-automation-controls.zh.md)

> This note supersedes only the prompt-only protocol inventory in [ACP as an automation-only protocol](../simplification/2026-07-23-acp-automation-only-protocol.md). That decision's prohibition on ACP becoming a second product UI remains authoritative.

## Problem

The automation-only ACP bridge could create a fresh session, submit one prompt at a time, cancel it, receive committed assistant messages, and answer one-shot permission requests. A generic external automation controller still needed private process knowledge to discover models, attach MCP servers, find durable sessions after restart, resume them, close one session independently, and observe reasoning, tool, or context-pressure progress. Reproducing those controls in an integration-specific runtime would make ACP nominally interoperable while leaving DSH automation dependent on a private side protocol.

The stable ACP v1 protocol already defines the required control vocabulary. Adding private `_meta`, custom methods, use-case-specific environment handling, or presentation projections would fragment that vocabulary and revive the UI coupling removed by the automation-only decision.

## Decision

`@deepseek-ai/dsh-acp` implements the complete standard ACP v1 automation subset needed by a generic controller: `session/new`, `session/list`, `session/resume`, `session/close`, `session/prompt`, `session/cancel`, `session/set_config_option`, JSON-RPC `$/cancel_request`, `session/update`, and `session/request_permission`. It uses `@agentclientprotocol/sdk` 1.4's app/context interface on both sides of every in-repository connection.

Capabilities omit unsupported methods and features. DSH adds no custom method, capability flag, or `_meta`, and assigns no private meaning to client metadata. `session/load`, `session/delete`, `session/fork`, additional directories, SSE and ACP-transport MCP, modes, commands, plans, terminals, client filesystem operations, and elicitation remain unsupported. Session controls and semantic updates are protocol data for automation; they do not make ACP a human UI.

## Per-session ownership

One `AcpSession` module owns each published Agent handle, selected model state, request MCP mounts, single prompt slot, ordered update chain, and memoized close operation. Global event listeners only identify the exact Agent or Session and delegate to that module. The module associates the admission snapshot with the identified message in memory until inbox claim, then pins it to the admitted turn. Image capability checks, prompt variables, request headers, and every model step therefore use one provider/model/reasoning tuple, while the ordinary durable user source remains unchanged. A concurrent configuration change affects the next ACP turn.

Explicit `session/close`, connection loss, and plugin disposal call the same close operation. It cancels admission and Agent work before waiting, drains committed updates and continuable descendants, flushes persistence, and releases the Agent scope and its MCP clients. Close retains event routing until the drain completes. Failure reporting waits for all owned session teardowns, and other frontends' Agents and descendants remain untouched.

## Persistent session controls

Complete ACP lifecycle support requires session persistence. `session/list` reads materialized top-level headers, excludes active and descendant sessions, filters by canonical physical `cwd`, sorts by creation time and id, and returns bounded pages using opaque keyset cursors. Summaries deliberately omit titles and presentation metadata.

`session/new` explicitly asks persistence to materialize the live session header without inventing a session event, so even an empty session can be closed, listed, and resumed. Other frontends retain the persistence seam's lazy default and leave abandoned empty sessions unmaterialized. `session/resume` rejects active ids and non-top-level or unknown persisted ids, verifies the requested canonical `cwd` before Agent composition, restores the durable session without replaying it to the client, and mounts the MCP declarations supplied by that request. `session/close` leaves the durable log available for a later process.

Persistence deliberately treats `create(meta)` as a live registration: the shipped JSONL provider creates no artifact until the first event append. That default removes abandoned empty sessions, but ACP cannot inherit it because `session/new` publishes a session identity before any prompt and the process may stop after the success response without receiving `session/close`. The bridge materializes only after Agent and MCP composition succeeds and before returning `session/new`; failed composition remains residue-free, while every returned id survives restart.

The bridge materializes through the ordinary durability barrier: `ctx.sessions.flush(session)` reaches the session's write handle, whose `flush` writes header-only materialization when nothing has been appended. JSONL writes one header frame; an out-of-tree provider must materialize equivalent header state atomically or reject the operation. Repeat calls are idempotent. Making `create` eager would change every frontend's abandoned-session behavior, appending a synthetic event would invent a sequence and replay fact solely to trigger storage, and waiting until close would make durability race process loss.

## Standard configuration options

The advisory LLM catalog now serves another automation consumer without becoming request validation. ACP exposes a provider-grouped `model` select whose opaque values retain the provider/model pair, plus a dependent `reasoning_effort` select from the resolved exact model. A model with efforts but no adapter-configured default includes `Provider default`, which preserves omission and lets the provider choose. New, resume, and set responses return the complete state. Adapter topology events emit `config_option_update`; per-session mutations serialize in receive order. The configured ACP provider/model remains the initial selection, and unlisted configured routes are synthesized into the returned choices instead of being rejected.

## Standard MCP mapping

`session/new` and `session/resume` accept standard stdio and Streamable HTTP MCP declarations. Stdio uses the session `cwd`; HTTP uses the declared URL and headers; both retain `dsh-mcp-client` timeout and reconnect defaults. Names, commands, URLs, environment entries, headers, and duplicate normalized namespaces are validated before Agent publication. Initial connection or discovery failure rolls the unpublished Agent back.

MCP namespace reservations follow the nearest DSH registration scope rather than the process root. Independent Agent scopes may use the same server name, while duplicate names inside one Agent still fail. Scoped disposal releases tools, transports, and reservations.

ACP clients are trusted controllers: a stdio declaration authorizes process execution and an HTTP declaration authorizes requests with its headers. DSH does not add per-server private cwd or timeout fields. Ordinary DSH tool policy still governs calls after tools are mounted.

## Semantic update projection

Only committed durable facts reach `session/update`. Assistant text/images become `agent_message_chunk`; reasoning becomes `agent_thought_chunk`; tool calls/results become generic `tool_call` and `tool_call_update`; known measured context pressure and capacity become `usage_update`; adapter topology changes become `config_option_update`. Durable message ids and tool-call ids preserve correlation. The canonical DSH tool name is the standard tool-call title.

The per-session chain serializes all updates and drains before prompt completion. A tool-call notification drains before a permission request refers to it. Raw model deltas, retry attempts, cards, terminal state, diffs, locations, plans, titles, todos, and unsupported content stay off the wire.

`session/cancel` and `$/cancel_request` enter the same prompt-owned cancellation path. Correlated endings map only to standard stop reasons and JSON-RPC errors; a model output limit reports `max_tokens`. ACP returns no additional DSH result structure.

## Alternatives considered

**Add a private controller extension.** Rejected because standard ACP v1 already carries the required lifecycle, configuration, MCP, cancellation, permission, and semantic-update concepts. A private extension would make generic SDK clients incomplete.

**Restore the former editor projection.** Rejected because plans, terminals, diffs, cards, navigation, and human elicitation are presentation responsibilities. Semantic tool and reasoning facts are useful automation telemetry without importing presentation modules.

**Implement every ACP session method.** Rejected. List, resume, and close complete the durable automation lifecycle. Load/replay, delete, and fork introduce separate transcript, destructive-storage, and lineage semantics that this use case does not require.

**Use unstable provider methods for model discovery.** Rejected because standard session configuration options express the choice and remain scoped to the session.

**Copy every DSH runtime field to ACP metadata.** Rejected because exact token breakdowns, private result statuses, programmatic display names, and per-MCP tunables have no stable ACP v1 equivalent.

## Verification

Focused tests cover exact capability advertisement without private metadata; model/reasoning choices, invalid and concurrent mutation, topology updates, and image-route pinning; stdio/HTTP MCP setup, declaration rollback, scope isolation, resume, and disposal; list pagination, canonical workspace checks, active conflicts, close/resume, and restart recovery; message/thought/tool/usage order and ids; tool-before-permission order; standard stop reasons; request and session cancellation; and connection-loss teardown.

A generic keyless conformance test boots the real ACP demo twice and uses only the public ACP SDK to select a model and reasoning effort, attach an MCP server, execute a tool turn, observe standard updates, close, restart, list, resume, and cancel. It contains no integration-specific names, dependencies, metadata, or environment behavior.

## Consequences

External automation projects can use DSH through stable ACP v1 instead of maintaining a DSH-specific runtime protocol. The bridge is a larger control surface but remains smaller than a UI: it owns lifecycle and semantic interoperability, while human presentation and interaction stay in product clients.

Persistent lifecycle and request MCP mounting make session creation stricter. Misconfiguration and initial MCP failure reject before publication, and close waits for real quiescence and persistence. This cost is the ownership proof required to avoid partial Agents, leaked tools, or orphaned processes.
