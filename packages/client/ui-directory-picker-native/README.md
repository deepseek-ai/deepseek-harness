---
description: "Native directory-picker surface: the browser half that drives the host OS chooser for workspace-directory flows; for users and maintainers choosing a picking interaction."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-directory-picker-native

English | [中文](README.zh.md)

## Summary

This package provides the native directory-picking surface for the Web GUI: when a workspace flow asks for a directory, a renderless browser occupant opens the operating system's own chooser on the machine running the Host and reports the single outcome — a picked path, a cancellation, or a failure. It fills the two directory-flow slots declared by `ui-workspace`, composing the client side of the native picking interaction in one cordis.yml row. Choose it when the browser runs on the same machine as the Host; in-process and remote-browser deployments need the [`-browse`](../ui-directory-picker-browse/README.md) surface instead.

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

Mount this plugin alongside `ui-workspace` and the host backend [`dsh-host-directory-picker-native`](../../host/directory-picker-native/README.md); one cordis.yml row then composes the whole native picking interaction. When a workspace add or picker flow opens a directory request, the user sees the operating system's folder dialog; the picked path is adopted by the workspace flow, and cancelling closes the dialog.

### When to choose it

Choose this surface when the browser runs on the same machine as the Host, so an OS dialog can open there. Choose the [`-browse`](../ui-directory-picker-browse/README.md) surface when the browser is remote or in-process and no local chooser exists. The two surfaces fill the same slots, so switching is a composition change, not a code change.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Both slot registrations install as one transactional effect through nested `ctx.slots.inject()` calls, because either declaring entry may activate later or replace its declaration. The occupant arms once per rising `open` edge, so re-renders never launch a second chooser; settlements ride a ref so the answer reaches the owner's latest handlers. An unmount (HMR replacing the occupant) discards the settlement wholesale: the wire carries no per-request abort, so the host-side chooser survives until answered and its answer lands nowhere. The node half is an empty `apply` that keeps the plugin on the host roster.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the picking surface is not enough. They move from the browser half to the host backend and the slots it fills.

- [dsh-host-directory-picker-native](../../host/directory-picker-native/README.md) — the OS chooser backend this surface drives.
- [ui-workspace](../ui-workspace/README.md) — declares the directory-flow slots and owns the picking conversation.
- [ui-directory-picker-browse](../ui-directory-picker-browse/README.md) — the in-app browsing alternative for remote and in-process deployments.
- [Web client architecture](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the directory chooser is browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the native chooser fits. They are current package constraints, not a general picker comparison or a task backlog.

- **No cancellation of an open chooser** — the wire has no per-request abort, so a chooser already on the host display cannot be closed from the browser; a discarded settlement is ignored.
- **Local Host carriers only** — an OS dialog opens on the machine running the Host, so in-process and remote-browser deployments need the `-browse` composition instead. Platform failures surface through the owner's retryable folder dialog.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The plugin registers a renderless flow occupant into two workspace holes as one transactional effect, whose disposal the HMR-safety spec proves, and it retains no state between picks.
