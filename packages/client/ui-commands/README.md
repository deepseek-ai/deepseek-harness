---
description: "Client command API for the Web GUI: the / command source, three dispatch kinds, the per-session command directory, and popupSelect and action registration for business packages; for users and maintainers of slash commands."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-commands

English | [中文](README.zh.md)

## Summary

Typing a `/` command opens a registered popup, a client action, a host command's input, or direct execution; a command line is never silently downgraded to a plain prompt. Business packages register popupSelect specs (`/model`, `/permission`) or actions through `ctx.commandUi`, or decorate existing host commands with either kind while preserving their catalog rows and argument claims. Space and Enter resolve the line against the session's directory: a host descriptor with `input` is `leadingInput`, a registered `CommandUiSpec` is `popupSelect` or `action`, and everything else is `execute`.

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

Mount this plugin alongside `ui-input-trigger` and `ui-conversation`; the `/` source then appears in the trigger menu, and business packages register their command surfaces through `ctx.commandUi`. Typing `/model` opens the registered popup; a host command with an argument claim opens its input or executes directly. The composer's `+` button and a typed `/` open the same menu: an Add section (File, Goal, Plan, Feedback) and a Commands section (Compact, Permission, Model, Export) in usage order, each row with a glyph, a localized title and description, and the command name as an alias where the localized title differs from it.

### Kinds and decorations

A contribution is a client-owned command; a host-name collision fails loudly. Its UI is a popupSelect spec or an action: a callback a bare invocation runs after the trigger token is consumed, without submitting a message. Business packages own their actions and availability; the composer registers File through this same API. A decoration adds a bare-invocation popup or action to an existing host command while preserving its catalog row, argument claim, and lifecycle logging; it never fires without a matching host row. Menu queries fuzzy-match ordered, case-insensitive subsequences of command names and titles, with prefixes first and no section headings.

### Built-in row faces

First-party command definitions carry stable `definitionId` values. The client selects their localized titles, descriptions, icons, and input spellings by identity; changing a Host description cannot change that selection. Same-name overrides without the matching identity keep their own copy and receive no first-party aliases. Chinese and English spellings resolve through the same effective Session catalog in every locale, preserving the typed spelling in the draft and submitting the registered Host name. Contributions supply their own `label`, `description`, and `icon`, read on every candidate pass. Empty-query section order follows names, with unlisted rows closing Commands.

### Attachment-carrying submissions

When the composer submits with images or generic files, only a host command declaring `input.attachments` proceeds. Every other command route throws the localized `attachmentsUnsupported` refusal, rendered as a transient toast while the draft and attachment cards stay in place. Handler errors preserve the same draft state for retry.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/client/contract.ts` defines contribution and decoration registration, plus `dismiss(name)`, which closes that command's open popups and confirmations: dismissal aborts pending option loads, prevents their late results from reopening the popup, and preserves composer drafts. `CommandDirectory` owns the per-session wire cache and resolves typed commands through `resolution.ts`; that module owns first-party identity matching and localized input spellings. `matchSpace` reads the ready cache synchronously, while `matchEnter` waits for readiness and rejects on warmup failure or cancellation. Forwarded catalog and connection events invalidate the cache. After a matched Host execution, this browser emits `command/executed`; other clients observe only the durable command events. `PopupSelectController` owns popup state, and `PopupSelectView` occupies the input overlay. `presentation.ts` owns row labels, icons, and sections; its helpers and the resolution helpers stay internal to the plugin.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the command surface is not enough. They move from the command API to the trigger pipeline and the host command registry.

- [ui-input-trigger](../ui-input-trigger/README.md) — the pipeline the `/` source registers into.
- [ui-conversation](../ui-conversation/README.md) — declares the input overlay slot and owns the composer.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the host `command.execute` RPC they trigger, each command handler's host package owns any model-visible effect (the `/plan` handler flips plan mode, whose owning package injects its policy section), while the command line, the detached result, and every menu and notice rendering stay client-side and never enter the session log.

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

**Runtime invariant:** No companion is published. This browser-side source uses the wire command directory; it emits no Cordis events and owns no cross-plugin mutable state. Its dispatch and cache behavior are asserted by this package's specs.
