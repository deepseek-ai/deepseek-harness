# Agent Note: Broken presets are roster rows, not gaps

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-09-broken-preset-roster-rows.zh.md)

## Problem

With files as the only composition editor, hand-edit damage had two failure shapes and both were silent until the worst moment. A preset whose `agent.cordis.yml` no longer parsed listed as a perfectly ordinary row — selectable, copyable, settable as the default — and failed only when the next session tried to mount it; set as default, every new session failed to start. A directory whose composition file was deleted outright vanished from the roster while still occupying its id on disk: `copy` refused the name with "delete the existing preset first" and `remove` answered "not found" — two contradictory errors with no way out short of hand-deleting the directory.

## Decision

Discovery owns health, and a damaged directory is a **roster row carrying a `broken` reason**, never a gap. `scanRoot` treats every directory whose name is a usable preset id as a preset slot: composition missing → broken ("still occupies the id; delete it or restore the file"), composition unreadable/unparsable/not-a-list-of-named-rows → broken with the parser's first line. The shape check parses with the loader's own `entryListSchema` (the `!!js` dialect), so health can never call broken what the loader would accept; directories whose names fail `PRESET_ID` are skipped outright, because no copy could ever collide with them. `broken` rides `AgentPreset`, the `agentPreset.list` wire entry, and the UI row. Mounting paths (`mount`/`recompose`/`standingKeyFor`) refuse a broken preset up front via `resolveMountable` with the discovery-reported reason; `resolve` still answers (delete/read/report need the row), and `copy`'s roster check now sees ghosts, which turns the "already exists" refusal actionable — the broken card to delete is on the same page.

Surfaces split by their job: the management section renders broken rows as marked cards (red border, Broken badge, verbatim reason, body and duplicate disabled, location/delete kept on custom rows — the files are the fix, delete is the ghost's way out; shipped broken rows lose the viewer too; the reason itself has since moved off the card face onto the badge, see the note above), while both pickers (General row, new-session chip) drop broken presets entirely via `presetOptions` — they choose the NEXT session's composition, and offering one that cannot compose only defers the failure.

## Consequences

- The ghost dead end is gone end to end: the directory lists broken, its delete clears it, and the freed id is immediately claimable (covered by unit, component, and e2e tests).
- A default that later breaks still fails the session start loudly — the pickers hide broken rows, but nothing rewrites a stored default; `resolveMountable`'s early refusal is the same message every unloadable shape gets, instead of loader-dependent errors.
- Health runs on every `list()`: one read+parse per preset per roster read, accepted for the same reason unmemoized discovery was — rosters are small and freshness is the contract.
- Copying broken is refused in the UI only (disabled with reason); the host keeps `copy` shape-agnostic. A broken source yields an equally broken, equally visible copy — no capability is gained, and the host-side refusal would have needed its own error vocabulary for no journey that survives the disabled button.

## Load-bearing details

- **`PRESET_ID` moved to `types.ts`** so discovery and authoring share one containment vocabulary; authoring re-exports it unchanged.
- **The reason is one line.** js-yaml appends a multi-line code-frame snippet; the roster card is not a terminal, so `compositionProblem` keeps the first line.
- **Two mount.spec races were left untouched deliberately**: `ensureStanding` is still reachable with a preset resolved just before deletion (the private-path tests), and its stamp/unstampable semantics are unchanged — the health check happens before, in the public route.
- **Creator-mode guidance rides the same PR**: the `cordis` preset's persona forbids editing the shipped install (corrupting `cordis` would disable the mode itself) and points authoring at `${DSH_HOME:-$HOME/.dsh}/.agent-presets/<id>/`; its skill teaches `preset.yml` metadata, the copy-first workflow, and the one-escalation sandbox reality (the preset root lies outside the session workspace). Verified live: asked to edit the shipped `cordis` composition directly, the composed agent refuses citing both rules and offers the copy path; asked for a real preset, it lands it under `$DSH_HOME` and batches writes into one escalation. The verification half of that guidance — that the agent cannot start sessions, so the settings page's red marking is the user's check — is superseded by [the authoring agent mount-validates its own composition](2026-08-11-preset-authoring-agent-validates-its-own-composition.md): the shape check below is not validation, and `standingKeyFor` gives the agent the real one. The health decision in this note is unchanged.

## Alternatives considered

Hiding broken presets but refusing the id at copy time with a better message: still no way to clear the ghost from any surface. Validating deep (resolving every row's module at list time): the mount already owns that failure with rollback, and per-row imports on every roster read would be neither cheap nor more actionable. Partly superseded — [preset health resolves the rows it can prove will start](../architecture/2026-08-26-preset-health-resolves-rows.md) now RESOLVES each such row without importing it, which is cheap enough to run on every read; the mount still owns the failures resolution cannot see. Blocking `settings` writes naming a broken default: the settings domain is generic and the roster is a live directory — a name absent or broken now may be valid by the next session, and the mount's loud failure is the enforcement that owns the moment.
