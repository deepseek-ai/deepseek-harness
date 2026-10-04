# Agent Note: Plugin-owned human command registration

Status: implemented
Archived: 2026-09-30

English | [中文](2026-07-19-plugin-command-registration.zh.md)

## Problem

The TUI owns slash commands. Keeping command names, help text, autocomplete, dispatch, and cancellation inside the adapter makes every new command a TUI edit and prevents optional plugins from contributing commands. Treating slash input as an ordinary model prompt is also unsafe: a user-visible direct action can unexpectedly consume tokens or let the model reinterpret an unknown command.

A shared mechanism must remain a UI concern rather than a model tool or agent-loop branch. It also needs exact per-agent visibility, HMR-safe removal, direct result rendering, and request-scoped cancellation without automatically adding command text or output to model history.

## Decision

`@deepseek-ai/dsh-commands` in `packages/interaction/commands/` is the product command registry. `dsh-base` mounts it for consuming front ends; the [automation-only ACP app](../simplification/2026-07-23-acp-automation-only-protocol.md) and standalone `sdk-minimal` tree omit it. UI surfaces inject the service, while command producers depend only on the registry and any domain they operate.

### Registry contract

A `CommandDefinition` contains a lowercase name without `/`, a non-empty description, an optional unstructured-input hint, and an abortable handler. Registration validates and detaches the metadata, freezes the effective definition, and returns the exact Cordis effect disposer. Duplicate names fail within one layer. Every consumer sees every effective definition; a command plugin that cannot operate in a deployment omits its registration there instead of encoding consumer identities in the shared domain.

`list(agent)` returns immutable name-sorted descriptors after scoped shadowing. `find(agent, name)` resolves the effective definition. `execute(agent, line, signal)` parses and runs a known definition, returning a detached `success` or `error` result; invalid syntax and unknown names return `undefined` so the adapter owns its direct error text.

`parseCommand(line)` requires `/` at byte zero, a lowercase ASCII name containing letters, digits, `_`, or `-`, then whitespace or end-of-input. It preserves the complete adapter-delivered suffix as `rawInput`, including separator whitespace. Command-specific plugins own every further grammar decision.

### Scope and lifecycle

An unscoped registration is global. A command-injected plugin mounted beneath an agent context inherits that agent's scope key and lifetime, so its definition shadows a same-named global only for that exact agent. The child declares its own `commands` injection because `agent.ctx` intentionally inherits the core agent-loop dependency API; adding a UI service to the loop merely to enable scoped registration would invert the dependency graph.

Registration and removal emit the unfiltered, non-vetoing `commands/change` registry notification. Adapters recompute each live agent's effective view rather than trying to infer which sessions a change affects. The registry contains and logs each observer failure independently, so a broken UI refresh cannot roll back another plugin's mutation or starve a later observer. Cordis ownership removes definitions when their producer, UI instance, or agent scope unloads, so HMR cannot leave stale discovery entries or handlers.

### Direct dispatch and cancellation

Commands run in a human-only command plane. The registry does not turn their input into `user/message`, their output does not become a session event, and neither is sent to the model implicitly. A handler receives the exact target agent, raw input, and request-owned `AbortSignal`; a producer may explicitly schedule separate model-visible work through that agent and then owns its logging and lifecycle contract. The registry stops awaiting an uncooperative handler when the signal aborts; the handler remains responsible for stopping external side effects already started.

Expected handler failures return `CommandResult.error`. Thrown or malformed results remain adapter-visible command failures, not model messages. This boundary deliberately separates UI output from durable domain mutation: a goal command may change `ctx.goals`, for example, but the goal service owns that persisted state.

### TUI mapping

The TUI registers its built-in slash commands as agent-scoped command definitions instead of switching on strings. Its autocomplete and help view read the live catalog, so plugin commands appear and disappear with their effects. Any submitted line beginning with `/` stays in the command plane; unknown input produces a terminal warning rather than falling through to `Agent.steer()`.

Each submitted command owns an `AbortController`. TUI disposal aborts outstanding dispatches, removes the local definitions, and waits for the command-producing fiber before completing teardown.

## Testing

The registry suite covers syntax boundaries, immutable normalization, runtime metadata validation, deterministic sorting, global and scoped shadowing, duplicate rejection, exact disposal, contained change-notification failures, direct invocation, expected and malformed results, synchronous and asynchronous failure, and every abort timing edge at per-file 100% statement, branch, function, and line coverage.

TUI tests exercise all migrated built-ins, live plugin discovery, help/autocomplete refresh, direct results, unknown-command rejection, raw-input delivery, definition removal, startup rollback, and disposal cancellation. Keyless terminal snapshots pin the rendered help, error, and command-result shapes.

## Alternatives considered

- **Keep adapter-local switches** — rejected because optional plugins cannot contribute discovery and behavior without editing the TUI.
- **Represent human commands as model tools** — rejected because discovery and direct invocation are human UI behavior; routing through the model adds latency, token cost, and reinterpretation.
- **Put the registry in the mandatory agent core** — rejected because UI-less entry points do not consume it, while UI profiles can compose it explicitly.
- **Make `dsh-agent-loop` inject commands** — rejected because the loop does not execute or discover human commands. Agent-scoped producers declare the UI dependency in a child plugin instead.
- **Attach adapter masks to each definition** — rejected because support is a composition fact, not command-domain state. Every composed adapter exposes a registered command; an incompatible plugin omits registration in that deployment.
- **Send unknown slash input to the model** — rejected because typoed or unavailable direct actions must fail predictably rather than change execution planes.
- **Persist generic command input and output** — rejected because adapter notices are not model-visible state. A handler that changes durable behavior calls the owning domain API, which records its own events.

## Consequences

- Command producers are ordinary removable plugins, and TUI consumes their validated catalog and dispatch contract.
- Agent-specific definitions retain existing flat scope and shadow semantics without a core-to-UI dependency.
- Unknown slash input and command output are deterministic UI behavior with zero direct model tokens.
- Direct command cancellation is isolated from model-turn cancellation.

## Known limitations and deferred work

- Input metadata is limited to an unstructured text hint. Typed forms, argument schemas, and completion providers remain command-owned or require a later registry or consumer extension.
- Generic command output is live-only and is not reconstructed after TUI restart.
- Registry cancellation stops awaiting immediately, but external work stops only when a handler cooperates with its signal.
- The ACP automation server, headless CLI, and JSON-RPC SDK entry points do not expose the command plane; only TUI consumes it.
