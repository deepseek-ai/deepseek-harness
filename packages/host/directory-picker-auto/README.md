---
description: "Adaptive chooser of the directory-picker seam: resolves the web GUI host's situation once at boot and mounts the matching native or browse backend."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-picker-auto

English | [中文](README.zh.md)

## Summary

`dsh-host-directory-picker-auto` picks the right directory-picking interaction for every boot: it resolves the host's situation once at boot and mounts the matching backend — [native](../directory-picker-native/README.md) or [browse](../directory-picker-browse/README.md) — together with its browser half, as real Loader entries in the in-memory root tree. The resolution is one pure boot-time sample: `native` requires a loopback-only bind, a non-SSH launch, and a servable display session; anything ambiguous resolves to `browse`, which works everywhere. Pinning an interaction means composing that backend directly. The mounted capability stays stable for the service lifetime, as the seam requires.

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

Compose this plugin instead of a concrete backend when the same composition must serve hosts that differ: local workstation sessions where a native chooser works, and remote or headless sessions where only the in-app browser works. The chooser inspects the host once at boot and mounts the matching interaction.

### How the choice is made

`native` requires every signal that the operator can see the host display and the native backend can serve it: a loopback-only bind (read from the injected `webServer`; an all-interfaces bind admits remote browsers no OS chooser can reach), no SSH launch (`SSH_CONNECTION`/`SSH_TTY` unset or blank), and a servable display session — assumed on darwin and win32; on linux, `DISPLAY`/`WAYLAND_DISPLAY` plus a zenity or kdialog binary on `PATH`; never on any other platform. Anything ambiguous resolves to `browse`, which works everywhere.

### What you get

The resolved interaction arrives as an ordinary Loader entry: the backend registers `ctx.directoryPicker`, and its browser half is discovered by the client module table exactly as a config row's would be, so the seam's one-row-swaps-both-faces invariant holds. Unloading the chooser removes the entry, unloading both faces with it. The sample happens exactly once per boot, so the mounted capability stays stable for the service lifetime.

### Pinning an interaction

Pinning is not a config field here: compose the `-native` or `-browse` row directly instead of this one — that is the seam's documented swap point. Mounting the chooser and a backend row together fails loud (duplicate `directoryPicker` service, duplicate client flow in the `single` holes).

### Observable failures

A wrong `native` choice degrades to the backend's existing retryable failure dialog rather than a broken composition; composing `-browse` directly selects the safe interaction for deployments whose situation the probe cannot prove.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The chooser is a pure decision plus a mount: `resolveDirectoryPickerBackend` samples host facts once at boot and returns a backend kind, and `apply` mounts the matching backend and surface packages as real Loader entries in the in-memory root tree — never persisted to a config file, because the root tree's `write()` is a no-op. The effect's disposer removes both entries and joins their fibers' teardown, so unloading returns only after both faces of the mounted interaction quiesced.

### The resolution table

| Condition | Backend |
|---|---|
| Bind host is not `127.0.0.1` | `browse` |
| `SSH_CONNECTION` or `SSH_TTY` present | `browse` |
| darwin or win32 | `native` |
| linux with a chooser binary and a display | `native` |
| anything else | `browse` |

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `BACKEND_PACKAGES`/`SURFACE_PACKAGES` maps, `apply` mount and unmount |
| [`src/resolve.ts`](src/resolve.ts) | `resolveDirectoryPickerBackend` — the pure boot-time decision |
| [`src/probe.ts`](src/probe.ts) | Host probes: `hasLinuxChooserBinary`, `canExecute` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the chooser's contract is not enough: the seam definition first, then the two backends it mounts.

- [Directory-picker seam](../directory-picker/README.md) — the capability contract the chooser composes.
- [Directory-picker capability seam decision](../../../.agents/notes/archived/architecture/2026-07-28-directory-picker-capability-seam.md) — why backends differ in interaction shape.
- [Native backend](../directory-picker-native/README.md) — the interaction mounted for a local operator.
- [Browse backend](../directory-picker-browse/README.md) — the interaction mounted everywhere else.

-----

<a id="model-experience"></a>
## Model Experience

None, as the GUI-host picking chooser only mounts a backend row and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the boot-time sample can misjudge the host. They are current package constraints, not a task backlog.

- **Detection infers operator location from launch context, which no launch-side signal can prove** — a tmux session detached from its SSH launch loses the `SSH_*` markers; a Darwin process outside an Aqua session still counts as displayed; and a workstation-local launch later reached through `ssh -L` arrives from `127.0.0.1`, resolves `native`, and opens the chooser on the unattended workstation. A wrong `native` choice degrades to the backend's existing retryable failure dialog, and composing `-browse` directly selects the safe interaction for such deployments.
- **The Linux chooser probe reads `PATH` only** — a zenity/kdialog reachable some other way (shell alias, non-PATH install) still resolves `browse`; installing either binary on `PATH` restores `native` eligibility at the next boot.
- **Boot-time only** — one resolution serves every client of the boot; per-connection adaptivity (native for a local browser, browse for a remote one, same server) would need a per-client capability and the wire advertisement the seam does not carry, and waits for a deployment that serves both at once.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The sole effect is one boot-time Loader-entry mount owned by the plugin fiber; the store is authoritative.
