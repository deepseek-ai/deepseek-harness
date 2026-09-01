---
description: "Workspace-directory picking seam for the web GUI host: the service contract, capability vocabulary, and error codes the native and browse backends implement."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-picker

English | [中文](README.zh.md)

## Summary

The web GUI host lets an operator choose a workspace directory through one contract: a single service whose one method reports which interaction the composed backend provides. Backends differ in interaction shape, not just mechanism — the native backend opens an OS chooser on the host display, while the browse backend serves listing and creation primitives for an in-app browser that also works for remote clients. Consumers switch on the reported capability kind; a new backend extends the capability vocabulary without editing this package. This seam is GUI-host only and never reaches the agent loop; the backends and the wire mapping live beside it.

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

Mount exactly one directory-picker backend and let the workspace flow drive it: the seam itself is only the service contract, so a composition without a backend has no way to pick a directory.

### Choosing a backend

The [native backend](../directory-picker-native/README.md) is the right choice when the operator sits at the host's display: `directoryPicker/pick` opens one OS chooser and returns the chosen absolute path, or `null` on cancel. The [browse backend](../directory-picker-browse/README.md) works everywhere — it lists one directory level and creates child directories from the browser, so remote clients that cannot reach an OS dialog still pick a workspace. When the host situation varies between boots, compose the [adaptive chooser](../directory-picker-auto/README.md), which resolves the situation once at boot and mounts the matching backend.

### The capability contract

`capability()` returns a discriminated union describing how an operator selects a directory: `{ kind: 'native', pick(signal) }` for the OS chooser, or `{ kind: 'browse', list(path?), createDirectory(path, name) }` for the in-app browser. Consumers switch on `kind`; a capability kind no composition implements means the UI hides the picking affordance rather than failing. Browse failures throw the typed `DirectoryPickerError` with a closed code set — `directory-unreadable`, `directory-exists`, or `directory-create-failed` — each carrying the subject path, which the picking Remote controller maps onto wire failure codes.

### What rows carry

`DirectoryEntry` rows expose the absolute `path` and a host-owned `hidden` flag (dot-prefixed on POSIX) so display policy stays client-side; clients never join path segments themselves. `DirectoryListing.crumbs` is the ancestor chain from the filesystem root to the listed directory — every crumb is a jump target, and the root crumb is labeled by its full path.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The seam is built on one separation: the interaction shape a backend provides is a contract, not an implementation detail. `DirectoryPicker` is an abstract Cordis service with a single `capability()` method; a backend subclass registers as `ctx.directoryPicker`, and loading a second implementation throws the standard duplicate-service error. The capability object must be stable for the service lifetime because consumers may capture it across calls.

### The merge-extensible vocabulary

`DirectoryPickerCapabilities` is a merge-extensible map keyed by capability kind, and `DirectoryPickerCapability` derives the union from it. A new backend declaration-merges its shape here (the entry's `kind` literal must equal its key) instead of editing this package. Each backend package also ships a browser entrypoint that registers the matching interaction in ui-workspace's directory-flow slots, so one composition row selects both the host capability and the client flow.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service Definition: abstract `DirectoryPicker`, capability vocabulary, typed error, Context merge |

### Failure vocabulary

`DirectoryPickerError` carries a closed `DirectoryPickerErrorCode` plus the absolute subject path, so consumers map business codes without string matching. The seam Agent Note records the design rationale, the separation from `ctx.fs`, and the policy decisions.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the seam contract is not enough: the decision record first, then the two backends and the adaptive chooser that compose it.

- [Directory-picker capability seam decision](../../../.agents/notes/implemented/architecture/2026-07-28-directory-picker-capability-seam.md) — design rationale, the `ctx.fs` separation, and the policy decisions.
- [Native backend](../directory-picker-native/README.md) — the OS-chooser interaction and its platform tooling.
- [Browse backend](../directory-picker-browse/README.md) — the in-app listing and creation interaction for remote clients.
- [Adaptive chooser](../directory-picker-auto/README.md) — boot-time resolution between the two backends.
- [Workspace subsystem](../../../docs/subsystems/workspace.md) — the workspace records the picked directory feeds.

-----

<a id="model-experience"></a>
## Model Experience

None, as the GUI-host picking seam registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the seam contract leaves a decision to a future consumer. They are current package constraints, not a task backlog.

- **No multi-root support** — the browse contract exposes one ancestry chain per listing; per-deployment root scoping (and Windows drive-root enumeration above a drive) waits for a consumer that needs it, per the DirectoryPicker Agent Note.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This stateless Service Definition owns the capability vocabulary, while backends and the Remote controller own observations.
