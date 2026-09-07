# Agent Note: Adaptive default for the directory-picker interaction

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-29-directory-picker-adaptive-default.zh.md)

## Problem

The [directory-picker seam](../architecture/2026-07-28-directory-picker-capability-seam.md) made the interaction a `cordis.yml` swap point, but the shipped composition still had to pin one backend: `-browse` everywhere meant a local operator never got the OS chooser, `-native` everywhere breaks every remote deployment. The right default depends on facts only the running host knows — where the server binds, whether the process was launched over SSH, whether a display session exists — so no static row is correct for all deployments.

## Decision

A third sibling package, **`dsh-host-directory-picker-auto`**: a node-half-only *chooser* that owns no picking code and no UI. Its `apply` samples the host facts exactly once at boot — bind host from the injected `httpServer` (a new `host` getter mirrors the existing `port`), `SSH_CONNECTION`/`SSH_TTY`, platform, `DISPLAY`/`WAYLAND_DISPLAY`, and a `PATH` probe for a Linux chooser binary (zenity/kdialog) — resolves them through one exported pure function, and mounts the chosen dual-face backend with `ctx.loader.create({name})` into the Loader's **in-memory root tree**; the effect's disposer removes the entry and joins the backend fiber's teardown (`remove()` alone only starts it), so unloading the chooser settles only after the backend quiesced. `native` requires every attended-and-servable signal: loopback bind ∧ no SSH markers ∧ a display session the native backend can drive — assumed on darwin/win32, requiring `DISPLAY`/`WAYLAND_DISPLAY` plus a chooser binary on linux, and never true elsewhere (the native backend supports exactly darwin/win32/linux). Anything ambiguous resolves to `browse`, which works everywhere. `apps/cli` now mounts `-auto` as its `directory-picker` row; composing `-native` or `-browse` directly remains the pin.

Why entry-level mounting is the load-bearing mechanism: the client module table (`dsh-client-modules`) reconciles **Loader entries** reactively over `internal/plugin`, so a backend mounted as a real entry gets its browser half discovered exactly as a config-row's would be — the seam's one-row-swaps-both-faces invariant survives adaptivity with zero duplicated client code. The dev HMR row (`AppCLIEntry`) is the mechanism precedent. Root-tree targeting matters: the root tree's `write()` is a no-op, so the resolved row can never be persisted back into `cordis.yml` (the Include subtree *does* write).

## Alternatives considered

- **Boot-glue resolution in `AppCLIEntry`** (ship both rows with static `disabled`, patch `disabled` from a `--directory-picker=auto|native|browse` flag). Works — `PatchOptions` patches metadata, and the modules scan skips disabled rows — but leaves the decision app-private where every future composition re-implements it; the chooser plugin gives any `cordis.yml` the same one-row adaptivity. Reintroduce the flag only when a deployment needs to *force* a backend without editing its yml.
- **One merged plugin branching per call** (client tries `pick`, falls back to the browse dialog on `directory-picker-unavailable`). Rejected: the client would need both flows in one bundle — the bundle-purity gate forbids cross-plugin value imports and jscpd forbids copying the dialog — and per-call probing pays a doomed RPC on every open of a browse host.
- **Resurrecting the wire advertisement** so both client flows mount and branch on the host's kind. Rejected: reverses the seam note's deletion for no consumer the chooser doesn't already serve, and collides with the `single` directory-flow holes.
- **Per-connection adaptivity** (native for a loopback browser, browse for a remote one, same server). Deferred: needs a per-client capability, the advertisement above, and both flows mounted; no shipped deployment serves both operator shapes at once.

## Consequences

- The shipped web GUI adapts out of the box: attended local host → OS chooser; SSH launch, all-interfaces bind, headless host, unsupported platform, or Linux without a chooser binary → in-app browser. Detection infers operator location from launch context, which no launch-side signal can prove: a detached tmux session loses `SSH_*`; a non-Aqua darwin process still counts as displayed; and the `ssh -L` shape (a workstation-local launch later reached through a forwarded port, arriving from `127.0.0.1`) resolves `native` and opens the chooser on the unattended workstation — per-connection adaptivity could not fix that last case either. A wrong `native` choice degrades to the backend's existing retryable failure dialog; deployments in these shapes compose `-browse` directly.
- The chooser mounts backends by runtime string (`BACKEND_PACKAGES`, exported), which yml-row scanning cannot see; `verify-cordis-config` therefore requires every composition mounting `-auto` to declare both backends as dependencies, so keyless Linux CI (which only ever resolves `browse`) cannot hide a dropped `-native` dependency. The shipped-tree web e2e/snapshot lane (`apps/web/tests/scaffold.ts`) pins `-browse` by disable+insert patch — its goldens are interaction-specific and must not depend on the host running the suite.
- One resolution per boot keeps the seam's capability-stability contract; per-connection shapes remain out of scope until a deployment demands them.
- Mounting the chooser **and** a backend row together fails loud (duplicate `directoryPicker` service; duplicate flow in the `single` holes).
- The host typecheck aggregate now references the two backend projects (declarations only, node entries carry no client merge) so the chooser's REAL-composition test can mount them — the mirror of the client aggregate's `webserver` reference.
