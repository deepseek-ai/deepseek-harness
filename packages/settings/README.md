---
description: "Schema-derived forms for live plugin configuration."
kind: "package-group"
---

# settings/ — plugin configuration forms

English | [中文](README.zh.md)

## Summary

Edit live plugin configuration through forms derived from each plugin’s Config schema. The active profile patch stores edits, and Loader applies them. Plugins read their own volatile references.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

The package README owns the form behavior; the settings reference documents its types.

| Package | Purpose | ctx key |
|---|---|---|
| [`settings`](settings/README.md) | Config projection and revisioned form edits | `settings` |

<a id="related-documentation"></a>
## Related documentation

- [Settings reference](../../docs/subsystems/settings.md) — descriptors and edits.
- [Configuration editor](../boot/config-editor/README.md) — profile persistence.
- [Volatile configuration](../../vendor/loader/README.md) — updates without remounting.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
