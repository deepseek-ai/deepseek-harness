# Agent Note: The shipped preset root is the plugin's own

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-20-plugin-owned-shipped-preset-root.zh.md)

## Problem

`composeProfile` delivered the shipped agent-preset root by pushing a boot-time overlay whose `config` spread the composed roster row and then hard-set `roots` to the shipped root alone. Because an id-targeted patch replaces the whole `config` value, the overlay squashed every root the profile's `cordis.patch.yml` (or the home layer, or a `--patch` overlay) had configured: a deployment pointing `agent-presets` at a shared preset directory booted with only the shipped root plus the roster's writable home root, and every custom preset vanished from the Web picker. `dsh --dump-config` composes only the file-backed layers, so the dump showed the configured roots intact while the boot dropped them. The overlay also froze the row's boot-time `config` above every live reload, so no `cordis.patch.yml` edit to the row took effect until restart. Externally reported with an accurate root cause in discussion #3636.

Under the whole-`config`-replacement patch semantics, any "must survive user layers" value needs enforcement after composition — and review rejected keeping that enforcement in the launcher: `apps/cli` special-casing one plugin's row id, config keys, and precedence is coupling the composition machinery should not carry.

## Decision

The shipped presets are the plugin's own. The four built-in compositions moved from `apps/cli/config/agent-presets/` into `packages/preset/agent-presets/presets/`, listed in the package's `files`, and `dsh-agent-presets` resolves `SHIPPED_PRESET_ROOT` relative to its own module — the Loader imports the plugin by package name at runtime, so the directory exists on disk in both the source and installed layouts, the same mechanism that lets the `cordis` preset carry its skills inside its directory. `resolvedRoots` becomes shipped root (`system` trust) unless `includeShippedRoot` is false, then `config.roots` in order, then the derived writable home root unless `includeUserRoot` is false — prepended, so the shipped set always mounts and wins a duplicate id.

This completes the [per-session preset roster](../architecture/2026-08-03-per-session-agent-presets.md) direction that #2278 started for the writable root: both non-configured roots are now the package's, the launcher composes patch layers with no plugin knowledge, and the squash, the reload freeze, and the dump divergence stop being possible rather than being corrected. The always-load guarantee no longer rides patch ordering: `includeShippedRoot` defaults true in the schema, so a user layer replacing the row's whole `config` keeps the shipped set, and only an explicit `false` — as deliberate as disabling the row — drops it. The compositions bind to the host's agent-plane services, not to the Web surface: no preset row names a client or web plugin, and a host lacking an injected service leaves that row waiting exactly as under any other root.

## Testing

`shipped-root.spec.ts` covers the plugin ownership directly: a bare roster lists the four shipped presets `system`-trusted and carrying no reason other than unresolved rows (proving the moved files resolve from the package). Health has since grown a module-resolution pass — [preset health resolves the rows it can prove will start](../architecture/2026-08-26-preset-health-resolves-rows.md) — and a fixture base is not the install a shipped row's packages sit in, so the assertion names the reason it tolerates rather than requiring none, the shipped root precedes configured roots and the derived user root with a fixture directory claiming a shipped id shadowed, and `includeShippedRoot: false` mounts the roster without the set. Existing suites that pin exact rosters opt out, which the option's documentation names as its second purpose. The Web composition e2e boots the real bundles with no roots anywhere in config and asserts the shipped four plus a configured shared root's preset, shipped-id shadowing, and a configured-root preset composing an agent; running it against the built `lib/` verifies the bundled layout resolves the directory too. Gate scripts (`verify-cordis-config`, `verify-runtime-closure`) scan the new location.

## Alternatives considered

**Keep the launcher patch but derive it per composition, prepending instead of replacing.** The first merged-nowhere iteration of this fix: correct on the squash, the reload freeze, and the dump (which gained the derived layer as a labeled dump layer), with the reporter's overlay-prepend shape as its core. Superseded in review because every variant keeps `apps/cli` special-casing the roster row; the coupling, not the mechanics, was the objection.

**Have the bundle declare the shipped root itself (`!!js` package-relative path).** Removes the launcher coupling but hangs the always-load guarantee back on patch ordering: a user layer replacing the row's `config` drops the bundle's entry — the reported bug's shape again.

**Provide the root out of band (a launcher-provided context value the plugin prepends).** The launcher still has to know to provide a preset fact; the special case survives in a different channel.

## Consequences

`config.roots` is purely deployment-added directories; the dump shows exactly that, and the shipped root is documented plugin behavior surfaced at runtime through `agentPresets.roots`. `apps/cli` ships no `config/` directory and its `files` entry is gone. Any composition that mounts the roster — and any embedder of the package — gets the shipped set by default and turns it off with one config line; embedders wanting bare machinery set `includeShippedRoot: false`. The presets' bare plugin names still resolve through the boot's flat installation fallback, unchanged by the move.
