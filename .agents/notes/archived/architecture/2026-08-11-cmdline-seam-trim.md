# Agent Note: Trim the command-line seams to existing interfaces

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-11-cmdline-seam-trim.zh.md)

## Problem

The app-owned command line ([note](2026-08-06-app-owned-command-line.md)) shipped with three seams that were wider than their consumers needed: a vendored in-memory row-activation state machine (`Entry.enableRuntime` plus `enableRow` exported from `dsh-cmdline`, a command-line package owning a Loader concept) whose only purpose was the `--dev` conditional reload row, a vendored `EntryConfigResolver` protocol symbol whose only implementer was Include, and a launcher that still recognized the `headless-runner` row to pick SIGTERM exit codes, gate user-patch watching, and provide a `headlessIo` seam duplicating `ctx.appExit`.

## Decision

Express all three with interfaces that already exist:

- **No conditional dev row.** The reload chain stops being conditional: `dsh-web-app` mounts the `client-hmr` row unconditionally and `--dev` is deleted, along with the web runtime's `mode` config, the mode-forked prompt contract, and the `DSH_WEB_MODE` bash variable. Without a rebuild watcher (`pnpm run dev:web`) rewriting client bundles, the chain polls unchanged files and stays idle, so the always-on row costs one stat-poll interval and an SSE route. `Entry.enableRuntime`, its two state fields, and `enableRow` are deleted with nothing replacing them.
- **Tree-carrier config.** Include declares the existing `EntryGroup.key` marker instead of implementing `EntryConfigResolver`; the Loader hook keeps every tree carrier's config literal. Include's own `path` loses `!!js` support — no configuration ever used it, and the pinning test now asserts the literal tree-carrier contract instead.
- **Launcher app-knowledge.** The launcher recognizes no app row. SIGTERM is a supervisor's ordinary stop request and exits 0 on every surface (SIGINT stays 130); the launcher cannot know whether the app considered its work complete, and the previous 143 depended on naming the headless row. Every boot watches its user patch layers — a one-shot surface exits through bounded shutdown, which disposes the watchers before the loop drains. The headless runner exits through `ctx.appExit` like any other app; its output streams are a package-internal `internals` test seam, and `ctx.headlessIo` is deleted.

## Alternatives considered

- **Keeping `enableRuntime` but moving `enableRow` out of `dsh-cmdline`**: relocation fixes the package boundary but keeps the vendored state machine whose semantics (survives reapplication, rollback on failure) must be re-derived at every upstream sync.
- **`entry.update({ disabled: null })`**: mutates the entry's serialized options, so the next include reapplication restores `disabled: true` and unmounts the row mid-session.
- **SIGTERM 143 for one-shot surfaces via an app-registered signal handler**: the launcher's own handler races it for the exit code; winning that race needs a new launcher interface, which is the cost this change removes.
- **Keeping `--dev` with the row created at runtime**: an interim state of this change; it still needed a mode fork in the prompt contract, a `DSH_WEB_MODE` variable, and creation-versus-user-row arbitration, all to avoid an idle poll whose cost is negligible.

## Consequences

- A deployment that supervises `dsh --profile headless` with SIGTERM now observes exit 0 instead of 143; the caller sent the signal and sees no answer on stdout.
- The reload chain runs in every `dsh web` process; a deployment that must not expose `/plugins/events` disables the `client-hmr` row in its patch layer.
- One-shot runs mount the config-watch rows they previously skipped, costing a few milliseconds of startup.
- The vendored Loader/Include divergence shrinks by one protocol symbol and one state machine, and `rescope-vendor:check` passes again (the modification log's rescope entry is restored to the position its exact-edit anchor requires).
