# Agent Note: Loader interpolates the entry `disabled` field

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-11-loader-entry-disabled-interpolation.zh.md)

## Problem

The Windows platform layer (then a separate `windows.cordis.patch.yml` beside the base patch, since folded into the base rows — see Decision) disabled `tool-bash` on win32, but the shipped presets each mount a `tool-bash` row. Preset rows compose last, so the same-id row re-enabled the tool on Windows — the session had both `tool-bash` (PowerShell-backed) and `tool-pwsh`, silently, because no spec pinned the composed preset layer. Entry metadata had no conditional mechanism: `!!js` interpolates only under plugin `config`, and [postmortem 0002](../../../../docs/postmortem/0002-js-expression-disabled-filesystem-tools.md) documents that `disabled: !!js ...` stays a truthy expression object, disabling the row everywhere.

## Decision

The Loader interpolates the entry `disabled` field (`vendor/loader/src/config/entry.ts`): a `!!js` expression evaluates against the loader context at every mount decision. `disabled` is the only interpolated metadata field; `id`, `name`, `group`, and `inject` stay static. The raw node stays in the options, so write-back keeps the `!!js` form. The shipped presets (standard, code, cordis) declare the shell tool rows themselves and gate them by platform — `tool-bash` with `disabled: !!js process.platform === 'win32'` and its `tool-pwsh` twin with the inverted expression — so the preset layer exposes exactly one shell tool per host; the web-app overlay disables the host rows of both tools, letting each session's preset decide. `verify-cordis-config` now allows expressions in `disabled` only.

The mechanism completes the platform-layer fold: the base bundle's `cordis.patch.yml` gates both shell stacks on its own rows — `bash-sandbox`/`tool-bash` carry `disabled: !!js process.platform === 'win32'`, and their twins `pwsh-sandbox`/`tool-pwsh` mount only on win32 with the inverted expression. The launcher's separate Windows platform layer (`windows.cordis.patch.yml` plus `apps/cli/src/windows-shell.ts` and its injection into boot, live recomposition, and config dumps) is deleted — the layer existed only because entry metadata was static, and with `disabled` interpolated the condition lives on the row it governs.

## Alternatives considered

**A declarative `platform` field on the row.** Static and gate-checkable, but a second composition mechanism beside `!!js`, while platform is only one deployment condition.

**Preset-level platform overlays.** Rejected: the condition belongs on the row it governs — the same principle folds the launcher's separate Windows platform layer into the base rows.

## Consequences

A row can gate itself on platform or environment; a bad expression fails loud at boot. Every other metadata field remains literal and the gate keeps rejecting expressions there — the postmortem-0002 hazard is closed for `disabled` by evaluation, not prohibition. The Windows shell swap moved from a launcher-injected patch layer to the base bundle's own rows: win32 mounts the confined pwsh stack, POSIX carries the pwsh rows disabled, and one shared patch file serves both rosters — the [Windows pwsh default](../feature/2026-08-01-windows-pwsh-default.md) note's layer mechanism is superseded. The shell TOOL rows follow the same one-plane rule as every other preset-declared row: the web-app overlay disables the host `tool-bash`/`tool-pwsh` rows and the presets declare both with inverted platform gates, so a preset can drop or replace the shell tool per session on either host. The `minimal` preset's missing win32 PTY stack is a preset-metadata follow-up.
