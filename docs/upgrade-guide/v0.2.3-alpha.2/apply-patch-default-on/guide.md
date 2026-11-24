---
kind: upgrade-guide
description: "tool-fs.applyPatch now defaults to the edit value, so every tool-fs row that keeps edit and states no applyPatch offers apply_patch."
---

# `apply_patch` follows `edit` by default

English | [中文](guide.zh.md)

## Change

In 0.2.3-alpha.2, `tool-fs.applyPatch` defaulted to `false`, the shipped `tool-fs` rows that set it stated `applyPatch: false`, and the [PTC overlay](../../../../apps/cli/config/examples/ptc.yml) set the same, so no default composition offered `apply_patch`. An unset `applyPatch` now takes the resolved `edit` value, and the shipped rows state no `applyPatch`: the model sees `apply_patch` and its guidance beside `edit`, as a JSON tool under native execution and as a `run_code` binding under PTC.

Affected: the `headless`, `sdk`, and `acp` profiles with or without the PTC overlay, Web and Desktop sessions under the `standard`, `ptc`, or `cordis` preset, any profile patch, preset, or plugin that mounts `tool-fs` with `edit` enabled and no `applyPatch`, and recorded expectations that capture those tool sets. The Web `minimal` preset and `sdk-minimal` set `edit: false` and keep the tool off.

## Migration

1. To run without `apply_patch`, set `applyPatch: false` on the `tool-fs` row: add `- {id: tool-fs, config: {applyPatch: false}}` to the profile's `cordis.patch.yml` (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`) for `headless`, `sdk`, and `acp`; for a Web or Desktop preset, edit its `tool-fs` row from the Agent presets settings page; for a custom preset or plugin, add the key to its `tool-fs` declaration.
2. A row that disables `edit` but needs `apply_patch` sets `applyPatch: true`.
3. Confirm with `dsh --profile <profile> --dump-config` that each `tool-fs` row shows the intended `edit` value and any `applyPatch` you wrote; the dump omits the derived value, so check that the model request lists `apply_patch` only where expected.
