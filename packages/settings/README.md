---
description: "Package map for the user-settings capability family: the ctx.settings service that resolves per-namespace configuration, and the YAML/JSON file provider that stores it."
kind: "package-group"
---

# settings/ — user-editable configuration

English | [中文](README.zh.md)

## Summary

The `settings/` group makes plugin configuration user-editable: a plugin registers a named namespace with a schema, and users override values in one document without touching `cordis.yml`. User overrides win over the deployment's own configuration and schema defaults, and changes apply live. Two packages cover the capability: `settings/` provides the settings service, and `settings-file/` stores every namespace in one YAML or JSON document users can edit. Settings are optional: without a provider mounted, configuration stays exactly as composed.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Two packages cover the capability; each child README owns the full contract, and the subsystem reference owns the exhaustive service surface.

| Package | Role | ctx key |
|---|---|---|
| [`settings/`](settings/README.md) | Settings service: register namespaces and read or change their values | `ctx.settings` |
| [`settings-file/`](settings-file/README.md) | Stores settings in one local YAML/JSON file and publishes external edits live | registers `ctx.settings` |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference for the shared vocabulary, then the capability-seam split this family follows.

- [Settings subsystem reference](../../docs/subsystems/settings.md) — namespaces, layered resolution, descriptors, change commits, and the generated Cordis surface.
- [Capability seams](../../docs/capability-seams.md) — the Service Definition / Service Provider / Consumer split this family follows.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
