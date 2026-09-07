# Agent Note: fix the pwsh terminal overlay duplicate-loader collision

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-12-fix-pwsh-terminal-overlay-dup.zh.md)

## Problem

`apps/web/tests/pwsh-terminal.e2e.ts` fails on every platform with `TypeError: duplicate loader entry id: tool-pwsh`, thrown from `vendor/loader/src/config/group.ts:64` while applying the web composition. The failing seed lane boots the full shipped bundle plus a test overlay, so the E2E never reaches its rendering assertion and every `check:ci:snapshot`/`test:web` run reports a red web test even though the feature under test is unrelated to the change under review.

The web E2E scaffold applies an `extraOverlayPath` after the shipped Web surface and base patches. `pwsh-terminal.overlay.yml` used an `insert` block to add a `tool-pwsh` row:

```yaml
- insert:
    - id: pwsh-local
      name: '@deepseek-ai/dsh-pwsh-local'
    - id: tool-pwsh
      name: '@deepseek-ai/dsh-tool-pwsh'
```

`insert` is correct only while `tool-pwsh` is absent from the composition. The id exists because `86b6979bdc` (refactor(bundle): fold the Windows shell platform layer into the base rows) moved both shell stacks into the base bundle with inverted platform gates — `packages/bundle/base/cordis.patch.yml` declares `tool-pwsh` with `disabled: !!js process.platform !== 'win32'`, so the row is present in the composition on every platform. Later, `42fc7c5ffb` (refactor(preset): gate tool-pwsh by platform alongside tool-bash) added a web-app patch row that disables `tool-pwsh` for surfaces that use presets; a patch row cannot introduce an id, so it is not the source of the collision. The overlay's `insert` delivers a second row with the same id in the same loader group, and the loader rejects the pair at boot.

## Decision

Replace the overlay's `insert` of `tool-pwsh` with a top-level id-targeted override:

```yaml
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: false
```

The effective `tool-pwsh` state is a three-layer stack: the base row gates `disabled` on `process.platform !== 'win32'`, the web-app overlay sets `disabled: true` unconditionally for preset surfaces, and this lane's override clears it back to `disabled: false` regardless of platform. An `id`-targeted top-level override replaces the composed row; only an `insert` would collide.

The lane also now disables `pwsh-sandbox` by id, symmetric with the existing `bash-sandbox` disable: the base gates `pwsh-sandbox` with `disabled: !!js process.platform !== 'win32'`, so on Windows it would otherwise mount beside the inserted `pwsh-local` and both would register the same executor service. Disabling it keeps `pwsh-local` the lone executor on every platform.

The overlay header comment was updated to describe the full selection and the `tool-pwsh` inline comment now names the base row as the source of the id.

## Alternatives considered

**Keep the `insert` and change the web composition instead.** Rejected, because the shipped web composition should keep the host `tool-pwsh` row disabled for every surface that uses presets; the overlay is the lane that deliberately needs it, so the by-id enable belongs there. The base row itself cannot be removed either: it is the platform-gated shell-stack declaration shared by every bundle.

**Enable `tool-pwsh` in the `insert` block.** Not possible: an `insert` of an id that already exists is the very duplicate being fixed. The row must be targeted by id, which is the top-level override form, not `insert`.

**Patch `tool-pwsh` by id without setting `disabled: false`.** Insufficient: the web-app overlay sets `disabled: true` unconditionally, and the base row's platform gate only applies where the web-app override is absent, so an override that only restates `name` leaves the row disabled and the lane renders no terminal card. The `disabled: false` is required.

**Only disable `bash-sandbox` and rely on the platform gate to keep `pwsh-sandbox` off.** Rejected: that holds on POSIX but breaks on Windows, where the base row leaves `pwsh-sandbox` enabled and it would collide with the inserted `pwsh-local` on the shared executor service. The lane's `pwsh-sandbox` disable keeps one executor on every platform.

## Verification

Reverting the fix (restoring the `insert` of `tool-pwsh`) reproduces the exact `duplicate loader entry id: tool-pwsh` boot failure, confirming the override is load-bearing. With the fix in place `pwsh-terminal.e2e.ts` passes 2/2 on the same head — this exercises the POSIX seam, where the seeded pwsh call renders through the enabled `tool-pwsh` and the inserted `pwsh-local`. The seed lane requires a usable `pwsh`, so it skips on hosts without one; a `pwsh` binary is present on this machine and the test ran. The Windows path (base `pwsh-sandbox` mounted beside the inserted `pwsh-local`) is not exercised by any CI lane, whose `test:web` runs only on Linux; the overlay disables `pwsh-sandbox` to keep that path composable if it ever runs on a Windows dev machine.

## Consequences

The web E2E seed lane that exercises PowerShell boot now composes instead of colliding, so `check:ci:snapshot` and `test:web` stop failing on the duplicate independently of the change under test. The pattern is general: a `--patch`/`extraOverlayPath` overlay must probe whether a row already exists in the bundle it augments before choosing `insert` over an id-targeted override; `insert` of an id that the base or shipped Web surface already declares is a boot-time duplicate.
