# Agent Note: One editor family in general-purpose presets

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-10-default-presets-single-editor.zh.md)

## Problem

The `standard`, `code`, and `cordis` presets exposed both the `read`/`write`/`edit` filesystem tools and `str_replace_editor`. The two interfaces overlap for ordinary file inspection and editing, so every request carried an additional tool schema without adding a distinct default capability. The `minimal` preset has a different composition contract: its exact two-tool roster intentionally includes `str_replace_editor` beside persistent `bash`.

## Decision

The `standard`, `code`, and `cordis` preset configurations mount `dsh-tool-fs` and `dsh-tool-fs-search`, but do not mount `dsh-tool-str-replace-editor`. PTC mode therefore omits `str_replace_editor` from both its registry and generated SDK. The `minimal` preset continues to mount `dsh-tool-str-replace-editor`, and deployments or user-authored presets may still mount the plugin explicitly.

This decision narrows the preset roster rather than removing the tool package or its Python runtime support. The earlier [shared-roster decision](../feature/2026-07-31-even-out-shipped-tool-rosters.md) continues to own why surface-neutral tools live in preset composition; this note owns the editor exception.

## Alternatives considered

**Keep both editing interfaces in the general-purpose presets.** Rejected because the overlapping model-visible schemas increase tool choice without supplying a separate default operation.

**Remove `str_replace_editor` from every shipped composition.** Rejected because the `minimal` preset intentionally exposes that schema as one of its two tools, and explicit deployments remain valid consumers of the standalone plugin.

## Consequences

General-purpose agents use `read`, `write`, and `edit` for filesystem mutations, while the minimal agent retains `str_replace_editor`. Preset composition tests pin its absence from the standard roster, the Cordis roster, and the PTC mode SDK, while the minimal assertions continue to pin its presence.
