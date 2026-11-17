---
kind: upgrade-guide
description: "Standalone native CUA compositions must explicitly select global tool registration."
---

# CUA defaults to PTC session scopes

English | [中文](guide.zh.md)

## Change

The native CUA provider defaults `agentPreset` to `ptc`. It registers tools for existing and new PTC Agents, including when a saved application-grants configuration omits the new field. Custom compositions without an Agent preset registry no longer receive global CUA tools by default.

## Migration

1. For the standard Computer Use switch, keep the default; existing application grants remain usable.
2. For a standalone composition that needs global tools, add `agentPreset: false` under the native CUA entry’s `config` in its profile patch or overlay. Preserve its other fields, including `allowedApps` and `helperPath`.
3. Restart or let HMR apply the edit, then confirm that the intended Agent exposes `cua` in native mode or through the PTC SDK.
