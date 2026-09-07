# Agent Note: Copy-only preset authoring, and the way into a preset's files

Status: implemented

English | [中文](2026-08-08-copy-only-preset-authoring.zh.md)

## Problem

The agent-preset settings page carried a web YAML editor: `agentPreset.write` accepted arbitrary composition text, the page held a textarea with no completion, highlighting, or diff, and the shape check leaned on the Loader's own `entryListSchema` — whose dialect includes `!!js`, so "shape-checked text" was still arbitrary code on the next mount. Weak as an editor, wide as a capability, and the source of the editor-vs-roster races the section had to defend against.

## Decision

Authoring is a host-side copy, and files are the editor. `agentPreset.write` became `agentPreset.copy { from, agentPreset, name? }`: two ids the host resolves against its own roots plus an optional display name, whole-directory `cp` (symlinks dereferenced, modes re-tightened to owner-only with owner-execute kept), metadata rewritten to keep the source's description but never its name or `order`. The page becomes: read-only viewer over shipped compositions, copy dialog as the only create entry (no blank "new preset" — writing YAML from nothing is not a thing people do), delete for custom rows, and a location action that leads to the files — `settings/openAgentPresetDirectory { agentPreset }` resolves the directory host-side and opens it natively, or answers `{ opened: false, path }` for the row to show as text where the deployment has no desktop (`hasDocument` on `list`; `settings/canOpenAgentPresetDirectory` gates the row, and Settings Controller's `nativeOpen` pins server behavior where platform detection would mislead).

## Consequences

- No composition text and no path crosses the browser wire in either authoring direction; the `entryListSchema`/`!!js` concern dissolves with `assertComposition` itself (deleted). The authoring operations are `read`/`copy`/`openDocument`/`remove` — none accepts a filesystem target, and Connection authenticates them with the complete Host API.
- With the editor gone, hand-editing `agent.cordis.yml` is the ONLY composition edit, so the standing-mount layer grew stamp-keyed generations: `ensureStanding` compares the file's mtime+size and starts the next generation for later sessions ([standing-mounts note](../../archived/architecture/2026-08-08-per-preset-standing-mounts.md), updated in place). Without this, an edited file would serve stale compositions until process restart.
- A copy is a full snapshot that drifts from an upgraded shipped source — accepted; the preset layer has no patch semantics (that is the bundle layer's `cordis.patch.yml`), and the shipped set itself pays the same cost (`cordis`/`code` are full copies of `standard`) for one-file readability.
- `read` dropped `writable` (no editor to gate) and builtin directories are never opened (`openDocument` refuses non-`user` trust like `remove`): the install is overwritten by upgrades, and pointing an editor into it invites edits an upgrade silently discards.

## Load-bearing details

- **Copy target refusal is two checks on purpose.** The roster check refuses any id a root supplies — a user directory named like a shipped preset would be shadowed, so "create" would land a file nothing ever lists; the disk check (`PresetExistsError` before `cp` with `errorOnExist` as the race backstop) refuses a directory occupying the name without being a preset, which discovery cannot see.
- **The revealed path is response-direction disclosure, browser-authenticated.** The invariant "no browser payload can select an arbitrary filesystem target" is about the request direction; showing the resolved directory to the authenticated browser is the fallback the plan requires. It never rides `list`.
- **The e2e lane pins `nativeOpen: false`** (`agent-preset-authoring.overlay.yml`) — both so goldens render the same branch on macOS dev and headless Linux CI, and so test runs never pop a real file manager. The revealed directory is tokenized as `{{presetRoot}}` by the lane itself, since `normalizeAria` only knows the workspace cwd.

## Alternatives considered

Keeping write with a better editor (CodeMirror etc.): still arbitrary capability over the wire, still the race source, and still a worse editor than the user's own. Patch-semantics copies ("standard plus this diff"): no such layer exists below the bundle plane, and the repo's own shipped presets chose full copies deliberately. Browser-side `session/openWorkspacePath` with a returned path: breaks the README's no-arbitrary-target invariant the moment the path is a request parameter.
