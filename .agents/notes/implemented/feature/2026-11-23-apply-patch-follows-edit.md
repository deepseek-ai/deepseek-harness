# Agent Note: Apply patch follows edit

Status: implemented

English | [中文](2026-11-23-apply-patch-follows-edit.zh.md)

## Problem

[Shipped filesystem mutation defaults](2026-10-29-shipped-fs-mutation-defaults.md) enabled `apply_patch` by stating `applyPatch: true` on the `dsh-base` `tool-fs` row and the Web `standard` preset, while the `ptc` and `cordis` presets and the PTC overlay stated `false` and the `tool-fs` schema defaulted to `false`. Agent presets list complete plugin declarations with no shared parent, so every shipped default had to be repeated on each row, and the shipped coding presets offered different file-editing tools for the same workspace.

## Decision

- `tool-fs` resolves an unset `applyPatch` to the resolved `edit` value in an explicit `resolveConfig` step ([`src/index.ts`](../../../../packages/fs/tool-fs/src/index.ts)); an explicit `true` or `false` wins, and the schema carries no `applyPatch` default.
- The `dsh-base` `tool-fs` row (headless, SDK, and ACP), the Web and Desktop `standard`, `ptc`, and `cordis` presets, and the shipped [PTC overlay](../../../../apps/cli/config/examples/ptc.yml) state no `applyPatch`, so each offers `apply_patch` beside `edit`: a JSON tool under native execution and a `run_code` binding under PTC. The Web `minimal` preset and `sdk-minimal` set `edit: false` and omit it. The SDK and Desktop `standard` and `ptc` tool sets stay equal.
- The fixed-budget compaction scenarios keep pinning `applyPatch: false`, because their thresholds were tuned to the recorded tool set.

## Alternatives considered

**State `applyPatch: true` on each shipped row.** Every preset and the base row would repeat the value, and a new composition that enables `edit` would have to remember it; deriving the default inside `tool-fs` decides it in one place.

**Keep `apply_patch` off in the PTC and `cordis` presets.** The PTC compositions were evaluated without the tool, but keeping it off leaves the shipped coding presets with different file-editing tools for the same workspace. Under PTC the tool is a `run_code` binding rather than a JSON schema, so it adds little to each request. Unlike the base and `standard` defaults, enabling it in these presets rests on that consistency, not on a separate benchmark run.

## Consequences

Every `tool-fs` row that keeps `edit` and states no `applyPatch` registers `apply_patch`, including rows in third-party profiles, presets, and plugins; the [upgrade guide](../../../../docs/upgrade-guide/v0.2.3-alpha.2/apply-patch-default-on/guide.md) names the one-key opt-out. `dsh --dump-config` renders only stated keys, so the derived value is visible in model requests, not in the dump. Recorded expectations whose `tool-fs` rows enable `edit` without `applyPatch` carry the tool's guidance and schema.

## Testing

`tool-fs` registration tests cover the derived default and both explicit overrides. `web-agent-presets.e2e.ts` asserts `apply_patch` in the `cordis` tool set and in the `ptc` `run_code` bindings; the keyless SDK smoke checks the native tool and the PTC overlay binding; `desktop-tools.expected.e2e.ts` compares the SDK profile's first model request, tool schemas included, with the Desktop `standard` preset's.
