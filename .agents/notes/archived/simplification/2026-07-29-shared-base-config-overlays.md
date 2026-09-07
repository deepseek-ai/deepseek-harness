# Agent Note: One shared base config with per-surface overlays

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-29-shared-base-config-overlays.zh.md)

## Problem

`dsh` shipped two full config trees that were 43 rows the same. `apps/cli/cordis.yml` composed the web surface as 74 flat rows, while the TUI booted `examples/tui-agent/cordis.yml`, whose single `@deepseek-ai/dsh-tui-demo` row mounted twelve plugins and re-declared their configuration as its own twenty-key pass-through `Config`.

Neither file was what its location claimed. `examples/tui-agent` was not an example: `apps/cli/src/tui.ts` hardcoded it as the product's default config, and it owned the TUI PTY smoke, the eight terminal snapshot scenarios, and the PTY harness the `cordis-agent` leaf imported. `dsh-tui-demo` was not a demo either — it was the application, mounted by the shipped binary from `packages/examples/`.

The duplication was the load-bearing problem. Of the 43 shared rows, 38 were byte-identical and 5 differed for a defensible per-surface reason, so every capability change had to be made twice and could silently drift. The bundle also inverted a default: `composeTuiApp` read `config.goals ?? {}`, so the shipped TUI mounted goals, `tool-goal`, `goal-round-driver`, and `/goal` although no config key requested them.

## Decision

One shared base, one overlay per surface, composed as sibling patch lists.

`apps/cli/config/base.cordis.yml` holds the 43 rows both surfaces mount. `apps/cli/config/tui.cordis.yml` and `apps/cli/config/web.cordis.yml` are **patch lists**, not trees: each states the handful of rows whose value is surface-specific and inserts its own rows. The launcher includes the base once and applies every overlay as a sibling patch list at **one** include level, because include patches never cross an include boundary — stacking overlays as nested includes would silently stop reaching base rows.

Precedence is list order, last write winning per row: base, then the surface overlay, then either a `--config` overlay or the personal `~/.dsh/config.yaml`, then the launcher's own flag and profile patches.

`--config <path>` applies an overlay **instead of** the personal overlay, so a test tree never inherits the user's provider and model. `--config-replace <path>` boots a file as the entire tree, bypassing base, surface overlay, and personal overlay alike. Both flags survive the `/resume` execve handoff, or resuming would silently change the agent.

A patch replaces its target row's whole `config` rather than merging. Therefore, a row whose value differs per surface lives in the overlays, never in the base, so no row is patched by three layers at once. Session identity cannot ride a config key at all — it moved to `dsh-agent-loop`'s `CONFIGURED_AGENT_IDENTITIES_KEY`, as the launcher-owned identity record documented.

The TUI tests live in `apps/cli/tests/`, the Cordis-toolset e2e in `packages/extensions/tool-cordis/tests/`, and the supported PTC mode demo runs `dsh --profile headless` with `DSH_TOOLS_MODE=ptc`.

## Alternatives considered

**Leave both trees flat and duplicated.** Rejected: 43 rows maintained twice is the defect, and a gate asserting they stay identical would freeze the duplication rather than remove it.

**Nest the overlays as includes (`ptc` → `tui` → `base`).** Rejected after testing the Loader: patches do not cross an include boundary, so the outer file's patches are dropped with only a warning. A three-level chain left `tools` unpatchable, and a base behind one include made every personal patch a silent no-op.

**Put the union of all rows in the base and have each overlay disable what it does not want.** Rejected: the base stops meaning "shared", and each surface carries rows it exists only to switch off.

**Keep the per-surface rows in the base and let overlays patch them.** Adopted only for the five rows that must exist in both trees, because a patch cannot create a row. Their base entries carry the plugin name and the config both surfaces share; each overlay states the rest.

## Consequences

An overlay or `--config` tree that named `@deepseek-ai/dsh-tui-demo`, or patched the `tui-agent` row, no longer resolves. Overlays now patch the row that owns each key: the model route on `agent-loop`, the persona on `system-prompt`, presentation on `tui`.

A patch whose `id` matches no row stays a no-op rather than an error. That is deliberate: one personal overlay is shared across surfaces, and `insert` rows match nothing by design, so a row that exists only under `web` must not fail the TUI's boot.

`dsh web` gains `--config`, threaded into `AppCLIEntry` as an extra overlay. Web keeps sandboxed Bash and filesystem providers plus approval, permission presets, directory picking, and browser permission UI; the overlay disables the shared local providers because patches can disable rows but cannot delete them. The TUI query index uses a unique process-local temporary database because the SQLite backend requires one writer owner. It is a disposable derived index rebuilt by each process; `/resume` lists the underlying corpus directly and does not depend on index reuse. `AppCLIEntry` reads both the base and its surface overlay when recovering row defaults for its own patch merge, since a flag override must preserve the overlay's other fields on the same row.

## Verification

Composition is checked by booting each tree through the real Loader and inspecting settled entries, not by reading YAML; both surfaces settle with zero unloaded rows, and Web starts its `httpServer` with sandboxed Bash and filesystem providers. PTC mode remains covered by the ACP overlay and programmatic TUI snapshots rather than a separate shipped TUI application.

All eight terminal snapshot scenarios replay byte-identically after moving, and the 14-case PTY smoke passes, including two cases that assert a personal overlay reaches an **inserted** row — the behavior the vendored `plugin-include` fix enables ([`vendor/README.md`](../../../../vendor/README.md) local modification 8, covered by `packages/boot/app-boot/tests/config-reload.spec.ts`).

Flattening surfaced three latent defects, each fixed here: the TUI captured the optional `sessionQuery` service once at construction and so could permanently disable `/resume` when it won the mount race; the shipped session-store root silently reverted to a project-local `./.sessions`; and `--config-replace` was dropped by the resume handoff.
