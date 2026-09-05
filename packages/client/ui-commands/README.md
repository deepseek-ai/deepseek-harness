---
description: "Client command API for the Web GUI: the / command source, three dispatch kinds, the per-session command directory, and popupSelect registration for business packages; for users and maintainers of slash commands."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-commands

English | [中文](README.zh.md)

## Summary

Typing a `/` command in the composer opens the matching surface — a registered popup, a host command's input, or a direct execution — and a command line is never silently downgraded to a plain prompt. Business packages contribute command surfaces through `ctx.commandUi`, registering a popupSelect spec (`/model`, `/permission`) or decorating an existing host command with a picker while the host keeps its catalog row and argument claim. Space and Enter resolve the line against the session's directory: a host descriptor with `input` is `leadingInput`, a registered `CommandUiSpec` is `popupSelect`, and everything else is `execute`.

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

Mount this plugin alongside `ui-input-trigger` and `ui-conversation`; the `/` source then appears in the trigger menu, and business packages register their command surfaces through `ctx.commandUi`. Typing `/model` opens the registered popup; a host command with an argument claim opens its input or executes directly.

### Kinds and decorations

A contribution is a client-owned command — a host-name collision fails loud. A decoration adds a bare-invocation popup to an EXISTING host command: the host command keeps its catalog row, its argument claim, and its lifecycle logging, and a decorated name with no host row in the session's directory never fires. Menu queries fuzzy-match ordered, case-insensitive subsequences of command names; prefixes rank first.

### Attachment-carrying submissions

When the composer submits with images or generic files, only a host command declaring `input.attachments` proceeds. Every other command route throws the localized `attachmentsUnsupported` refusal, rendered as a transient toast while the draft and attachment cards stay in place. Handler errors preserve the same draft state for retry.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/client/contract.ts` is the fixed business contract: `CommandUiContract.register(name, spec)` and `decorate(name, spec)` are everything a business package consumes. `CommandDirectory` is the one wire-derived cache, keyed by session: ordinary sessions fetch through `command.list({sessionId})`, entries are soft-invalidated by the forwarded `commands/change` owner event and hard-invalidated by `connection/reset`, and epoch-guarded so a superseded pull can never overwrite a newer one. `matchSpace` answers synchronously from this cache only; `matchEnter` strong-waits it on the SubmitAttempt signal and rejects on warmup failure. After `command.execute` returns a matched result, the browser emits a local `command/executed` acknowledgment; other clients receive the durable command nodes through the Host event stream but never this acknowledgment. `PopupSelectController` is the headless shell state; `PopupSelectView` self-registers into `conversation.input.overlay` with per-session resolution. Decision record: the [web command surfaces note](../../../.agents/notes/implemented/architecture/2026-07-25-web-command-surfaces-and-assembly.md); the [fuzzy discovery note](../../../.agents/notes/implemented/feature/2026-08-04-web-slash-command-fuzzy-discovery.md) covers menu ranking.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the command surface is not enough. They move from the command API to the trigger pipeline and the host command registry.

- [ui-input-trigger](../ui-input-trigger/README.md) — the pipeline the `/` source registers into.
- [ui-conversation](../ui-conversation/README.md) — declares the input overlay slot and owns the composer.
- [Web command surfaces and assembly](../../../.agents/notes/implemented/architecture/2026-07-25-web-command-surfaces-and-assembly.md) — the design decision behind the command surfaces.
- [Web slash-command fuzzy discovery](../../../.agents/notes/implemented/feature/2026-08-04-web-slash-command-fuzzy-discovery.md) — the menu ranking rationale.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the host `command.execute` RPC the dispatch paths trigger: each command handler's host package owns any model-visible effect (the `/plan` handler flips plan mode, whose owning package injects its policy section), while the command line, the detached result, and every menu and notice rendering stay client-side and never enter the session log.

#### KV Cache effect

None directly; this package neither assembles nor sends a provider request. Command handlers it triggers may change what the owning host packages contribute to the next request's system prompt — a section appearing or disappearing replaces earlier request tokens and invalidates the provider prefix from that point — but that effect is owned and documented by each command's host package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current command surface. They are current package constraints, not a general command-line comparison or a task backlog.

- **Detached-result notices fall back to the console off-session** — the fire-and-forget paths route results to the triggering session's composer via `SessionInput.notify`; after session teardown the console line is the only remaining surface.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. A browser-side source over the wire command directory — it emits no cordis events and owns no cross-plugin mutable state; dispatch and cache behavior are asserted by this package's specs.
