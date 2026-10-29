---
kind: upgrade-guide
description: "The fs-observation-policy row ships disabled, so write, edit, and apply_patch no longer require a prior read, and dsh-base plus the Web standard preset gain apply_patch."
---

# Filesystem mutations no longer require a prior read by default

English | [中文](guide.zh.md)

## Change

In 0.2.2-alpha.2, `dsh-base` mounted `@deepseek-ai/dsh-fs-observation-policy`, so in every shipped profile `write` refused to overwrite a file the model had not read, `edit` refused an unread or externally changed file, and the model's guidance named the policy. The `fs-observation-policy` row now ships `disabled: true`: `write` overwrites, `edit` replaces literal text, and the new `apply_patch` applies hunks on context match alone, each unconditionally. The `write` and `edit` guidance still asks for a prior read but no longer cites the policy. Review capture, sandbox confinement, and `fs/observed` events are unchanged.

The `dsh-base` `tool-fs` row (headless, SDK, and ACP) and the Web `standard` preset now list `apply_patch` (`applyPatch: true`); the Web `ptc` and `cordis` presets keep `applyPatch: false`.

Affected: every shipped profile (`headless`, `web`, `sdk`, `sdk-minimal`, `acp`), profile patches that override the `fs-observation-policy` or `tool-fs` rows by id, and recorded expectations that include an `FS_NOT_OBSERVED` or `FS_STALE_VERSION` refusal.

## Migration

1. To keep read-before-write behavior, add to the profile's `cordis.patch.yml` (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`):

   ```yaml
   - id: fs-observation-policy
     disabled: false
   ```

   A profile patch that already carries this row with `disabled: false` needs no change; one that set `disabled: true` to opt out can drop that override.
2. To run without `apply_patch`, add `- {id: tool-fs, config: {applyPatch: false}}` to the profile's `cordis.patch.yml` for `headless`, `sdk`, and `acp`; for the Web `standard` preset, edit it from the Agent presets settings page or set `applyPatch: false` on its `tool-fs` row in `packages/bundle/web-app/presets/standard.patch.yml`.
3. Confirm with `dsh --profile <profile> --dump-config`: the `fs-observation-policy` row shows the intended `disabled` value, and the `tool-fs` rows show the intended `applyPatch` value. In a session, an `edit` of a file that was not read succeeds with the row disabled and fails with `FS_NOT_OBSERVED` with it enabled.
