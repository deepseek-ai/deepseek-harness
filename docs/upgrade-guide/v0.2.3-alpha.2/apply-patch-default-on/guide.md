---
kind: upgrade-guide
description: "The dsh-base tool-fs row, the PTC overlay, and the Web standard, ptc, and cordis presets enable apply_patch, so default model requests carry its schema or run_code binding and its guidance."
---

# `apply_patch` is enabled in every shipped composition

English | [中文](guide.zh.md)

## Change

In 0.2.3-alpha.2, every shipped `tool-fs` row set `applyPatch: false`, and the [PTC overlay](../../../../apps/cli/config/examples/ptc.yml) set the same on the base row, so no default composition offered `apply_patch`. The `dsh-base` `tool-fs` row (headless, SDK, and ACP) and the Web and Desktop `standard`, `ptc`, and `cordis` presets now set `applyPatch: true`, and the PTC overlay no longer overrides the `tool-fs` row: the model sees `apply_patch` and its guidance beside `edit`, as a JSON tool under native execution and as a `run_code` binding under PTC.

Affected: the `headless`, `sdk`, and `acp` profiles with or without the PTC overlay, Web and Desktop sessions under the `standard`, `ptc`, or `cordis` preset, and recorded expectations that capture the default tool set. `sdk-minimal` keeps its text tools off.

## Migration

1. To run without `apply_patch`, add `- {id: tool-fs, config: {applyPatch: false}}` to the profile's `cordis.patch.yml` (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`) for `headless`, `sdk`, and `acp`; for a Web or Desktop preset, set `applyPatch: false` on its `tool-fs` row from the Agent presets settings page.
2. Confirm with `dsh --profile <profile> --dump-config`: the `tool-fs` rows show the intended `applyPatch` value.
