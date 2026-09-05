---
description: "Human slash-command registry for interactive UIs: plugin-owned commands that run directly against an agent without creating a model message, for users and maintainers composing or extending command surfaces."
kind: "package-reference"
---

# @deepseek-ai/dsh-commands

English | [中文](README.zh.md)

## Summary

`dsh-commands` lets a user type `/command [input]` in an interactive Harness UI and run it directly against the receiving agent without creating a model message. Plugins register commands with a name, description, optional input hint and attachment-acceptance flag, and an abortable handler; interactive adapters discover and dispatch them per agent. A command-producing plugin mounted under an agent's context can register an exact agent-scoped command that shadows the global one of the same name. Each command run is recorded in the session log, and its result is rendered by the adapter, never entering model history. Slash commands ship with the `dsh` CLI and the Web client.

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

Compose this service when an interactive UI should let users drive agent-side behavior with slash commands instead of model prompts. UI-less demo spines and ACP automation provide no command adapter and do not need it.

### Registering a command

A plugin registers a command with `ctx.commands.register()`: a lowercase name, a description shown in discovery, an optional `input` hint, and a handler that runs against the receiving agent.

```text
ctx.commands.register({
  name: 'plan',
  description: 'Enter plan mode',
  input: { hint: '<message>' },
  handler: ({ agent, rawInput }) => {
    // Runs directly against the agent; no model message is created.
    return { kind: 'success', text: 'plan mode selected' }
  },
})
```

The handler returns `success` or `error` plus optional UI text that the adapter renders. `recordInput` defaults to true; a command whose own authoritative domain event already carries the payload sets it to false so the session log does not duplicate the input. Registering the same name twice in one scope throws.

### Command syntax

A command line starts with a slash at byte zero, a lowercase name containing letters, digits, `_` or `-`, and then either end-of-input or whitespace. Everything after the name — including separator whitespace — is the command's `rawInput`, and the command owns its own grammar for it. Lines that are not syntactically a command, or that name an unknown command, are rejected by the adapter instead of becoming a model prompt.

### Agent-scoped commands

A plain registration is global. A command-producing plugin mounted beneath an agent's own context declares its `commands` injection and registers an exact agent-scoped command, which shadows the global definition of the same name for that agent only.

### Attachments

A command may declare `input.attachments` to accept composer images and generic files. The executor enforces the declaration: attachments sent to a non-declaring command, an absent attachment store, an unknown Session-scoped file-upload receipt, or an over-limit image batch each settle as an error before the handler runs. Images cross the command wire as base64 input; generic files cite receipts from their completed background uploads, so command submission never reads their bytes again. Admitted `ImageBlock`s and `FileBlock`s reach the handler as one frozen `invocation.attachments` array in the user's selection order, and the handler owns their model-visible use.

### Dispatching from an adapter

An interactive adapter calls `execute(agent, line, attachments, signal)` with the exact receiving agent, the full command line, and the submission's ordered attachments. It returns the settled `CommandExecution` — the normalized result plus its lifecycle `commandId` — or `undefined` for invalid syntax or an unknown name. `list(agent)` and `find(agent, name)` serve discovery after agent-scoped shadowing.

### Cancellation

The caller's abort signal stops the registry from awaiting a handler; a handler that ignores the signal may continue its own external side effects after the caller stops waiting. A cancelled or thrown handler settles as a `command/done` error in the log.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The observable behavior is covered in [Use this package](#use-this-package); this section explains how the registry is built and where its contracts live.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `CommandRuntime` service: registration, scoping, dispatch, lifecycle events |
| [`src/types.ts`](src/types.ts) | Command definition, descriptor, execution, and result types |
| [`src/brand.ts`](src/brand.ts) | `CommandId` brand for lifecycle pairing ids |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion pairing `command/run` with `command/done` per session log |

### Lifecycle events

`execute()` mints a `commandId`, appends `command/run` before the handler runs, and appends `command/done` at settlement with the outcome kind and verbatim text; the exact payload fields live in [`src/index.ts`](src/index.ts). A successful result may name an earlier non-command authoritative domain event through `sourceEventSeq`; a thrown or aborted handler settles as `kind: 'error'`. Both events are direct standalone log-only appends: no turn wraps them, and persistence drains them at ordinary checkpoints and teardown. Admission misses (invalid syntax or unknown name) log nothing.

### Scoping

Registrations live in global and agent-scoped layers merged per agent via `ScopedLayers`. The child-injection shape — a command-producing plugin mounted beneath `agent.ctx` declares its own `commands` injection — preserves agent scope without making the core agent loop depend on a UI service. Duplicate names within one layer fail during registration, and registration or removal notifies every `commands/change` observer so live adapters can refresh discovery; observer failures are logged and cannot veto the mutation or starve later observers.

### Attachment admission

Attachment enforcement happens in the executor: images are committed through `admitEncodedImages`, files are resolved through the single Session-aware receipt provider, and the executor restores their original mixed order before calling the handler. Validation rejection starts no attachment writes. An image-storage failure can leave unreachable content-addressed objects for deferred collection, but publishes no model-visible message. Cancellation is honored before the handler runs. Command errors leave the dispatching composer's draft and attachment cards intact.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared command vocabulary to the design evidence and adjacent surfaces.

- [Commands subsystem reference](../../../docs/subsystems/commands.md) — registry semantics, input metadata, and the `ctx.commands` cordis surface.
- [Command registration Agent Note](../../../.agents/notes/implemented/feature/2026-07-19-plugin-command-registration.md) — the boundary and dispatch contract behind this service.
- [Interaction group map](../README.md) — adjacent approval, permission, and question packages.
- [Plan mode package](../../plan/plan-mode/README.md) — a shipped command producer that drives model-visible work.

-----

<a id="model-experience"></a>
## Model Experience

### Direct human commands

#### What the model sees

The registry itself submits nothing. Known slash commands execute in the UI command plane, and their `CommandResult` text is not submitted as a user message. Unknown slash-command input is rejected by shipped adapters instead of becoming a model prompt. A command producer may explicitly use the receiving `Agent`; for example, [`dsh-plan-mode`](../../plan/plan-mode/README.md#model-and-human-interactions) submits the optional message and ordered attachments in `/plan [message]` after selecting plan mode. The executor only admits attachments into durable objects; the declaring producer decides whether and how they become model-visible message content.

#### Token effect

Command discovery, execution, and UI output add no model tokens. Explicit agent work scheduled by a command producer has the same token effect as the corresponding agent input.

#### KV Cache effect

Registry metadata, command input, and direct output never enter a model request and do not affect its cache. A mutated domain owns any later cache effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the registry does not offer. They are current package constraints, not a UI backlog.

- **Only unstructured text input** — forms, completion schemas, and typed arguments remain command-owned parsing concerns.
- **Cooperative side-effect cancellation** — dispatch stops awaiting on abort; handlers must honor the signal to stop work that has already escaped into external systems.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
