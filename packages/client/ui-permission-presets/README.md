---
description: "Permission preset surfaces for the Web GUI: the General settings default row and the /permission picker for the current session; for users and maintainers of permission policy."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-permission-presets

English | [中文](README.zh.md)

## Summary

Choose permission presets for the current Web session or future sessions. General settings changes only the future default; the composer and `/permission` pickers switch the current session. Default Web offers Read Only, Workspace Write, and Full access. Explicitly loading the experimental Auto integration adds Auto review with an `EXP` badge to current-session pickers. Visible Full access and Auto selections require their own risk acknowledgement; a complete `/permission <preset>` command executes directly. The host confirms each change through the Session projection.

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

Mount this plugin alongside the settings, commands, and conversation packages. General settings receives the future-default row; the composer receives the `conversation.input.permission` control, and bare `/permission` opens the slash picker. Current-session controls require both the Session projection and a complete catalog snapshot. A permission-less composition exposes neither current-session controls nor the Settings row.

### The picker

A pick submits the `/permission <preset>` command line. The argument-bearing form (`/permission <preset>` typed directly) still switches directly; the decoration replaces only the bare invocation. The built-in labels are `Read Only`, `Workspace Write`, `Full access`, and `Auto review` in English and `仅可查看`, `工作区内修改`, `完全权限`, and `Auto review` in Chinese. Explicit host labels remain unchanged, unknown kebab-case names render in title case, and `auto` carries an `EXP` badge plus an experimental-risk confirmation. `custom` is display state, never a target.

When the live catalog withdraws a preset, the composer closes its pending confirmation and shows the Session's current value instead of an unavailable optimistic pick. Every catalog invalidation — the payload-free notification or a connection-generation change — closes an open slash picker or its confirmation without consuming the draft, while publishing the result of a read the picker waits for leaves it open with its failure and retry state; reopening reads the current catalog. A submitted command remains busy until its response settles.

### The Settings row

The row derives its options from the host's dynamic `defaultPreset` enum, uses the same localized built-in labels as the current-session picker, and writes one settings mutation. Current-session-only contributions such as `auto` are absent. The value applies only when a later session is created; changing it never switches or rewrites the current session.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The General row reads the explicitly exposed `permission` Settings descriptor through `ctx.configForms` and writes one `settings.mutate` path operation with the descriptor revision; its observable rides the slot system's `hooks` compartment, so the renderer owns React hook binding, and a push invalidation refetches the descriptor. The value is read only when a later session is created. The current-session surface is a popupSelect decoration hung on the host `/permission` command (`ctx.commandUi.decorate`): the host command keeps its slash-menu row, argument-bearing form, and durable lifecycle logging, while the decoration replaces only the bare invocation with the picker. One process-scoped directory subscribes to the payload-free catalog notification before its first Remote read and publishes only the latest complete success for the active connection generation. A winning failure or connection reset clears the old snapshot, which hides the composer seat until a later existing trigger retries, while the slash picker stays available and shows the failure with its retry; stale-generation and disposed settlements are ignored. Its public observables are `{ value }` and `invalidations`, one tick per catalog notification or connection-generation change; failures remain internal to imperative loading. Both the slash popup and composer seat consume that shared catalog, while the Session `permissions` projection supplies only `currentValue`. Full access and Auto review each carry localized confirmation copy; Auto also carries the badge rendered by the shared popup shell.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the permission surface is not enough. They move from the browser surfaces to the host policy and the command shell.

- [dsh-permission-presets](../../interaction/permission-presets/README.md) — the host-side permission preset policy these surfaces write.
- [ui-commands](../ui-commands/README.md) — the popupSelect shell the `/permission` decoration registers into.
- [ui-conversation](../ui-conversation/README.md) — the composer seat that joins this shared catalog with the Session's current value.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the permission facts its two surfaces write: the Settings row causes a future session to start with whole-value knob events, while the `/permission` picker appends the selected current-session preset. Sandbox and approval consumers resolve their own knob events; selecting `auto` additionally activates the host Auto integration's independent per-call reviewer.

#### KV Cache effect

No direct invalidation; the knob consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current permission surfaces. They are current package constraints, not a general policy comparison or a task backlog.

- **The Settings row is Web-only** — non-Web clients may still switch the current session through `/permission`, but do not receive this browser contribution.
- **Auto review is current-session-only** — the General-settings row intentionally omits it, and only visible picker selection receives the experimental confirmation; an explicitly typed `/permission auto` is already explicit consent.
- **Preset descriptions come from the host** — localized built-in labels may therefore appear beside a description written in another language.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The command and slot contribution lifecycles are proven by the HMR-safety spec, while the browser-only Settings controller owns no host events or cross-plugin mutable state.
