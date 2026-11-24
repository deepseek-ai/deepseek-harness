---
description: "Save active profile configuration and apply it through Loader."
kind: "package-reference"
---

# @deepseek-ai/dsh-config-editor

English | [中文](README.zh.md)

## Summary

Save plugin configuration in the active profile’s patch and apply it immediately. Callers can also add a row, remove a row that the patch added, and replace the config of a row that is switched off or failed. Writes serialize with profile changes and HMR. A running plugin validates the complete candidate before the file changes, and higher-layer overrides leave the file unchanged. When a written row does not start, the file gets its prior content back.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount this service in a profile application with Loader and `profileContext`. It has no configuration fields.

```yaml
- id: config-editor
  name: '@deepseek-ai/dsh-config-editor'
```

Use [settings](../../settings/settings/README.md) for forms restricted to live fields. Callers that edit complete configuration can use `ctx.configEditor.edit()`; ordinary fields retain Loader’s normal lifecycle.

Callers that manage rows have three more operations. `insert()` appends a row to the profile patch and starts it. `remove()` deletes a row that the profile patch inserted, together with the patch’s overrides of that row; `configuration()` marks such a row as `inserted`, and `remove()` refuses every other row. `editRow()` replaces a row’s config as `edit()` does and also accepts a row that is switched off or failed: that row stores the config as given, and its plugin validates it at the next start.

A row that `insert()` or `editRow()` writes must be active afterwards unless it is switched off. When the row fails to start or waits for a service, the call rejects with the activation diagnostic, and the file gets its prior content back.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [editor](src/index.ts) reconciles external changes before deriving a candidate, locks the profile manifest alongside other profile operations, and atomically replaces the profile patch. A config edit replaces the row’s config override. An insertion goes to the end of the file: into the last patch item when that item inserts top-level rows, and into a new insert item otherwise, so that no existing profile patch item applies to the new row. The editor preserves YAML comments and `!!js` expressions outside replaced values; the comment above a deleted top-level patch item, which for the first item is the file header, stays in the file. A failed reconciliation restores the prior document and reloads the prior patches, and the caller receives the rejection of its own write.

Configuration reads share one composition for entries without profile config overrides. Overridden entries are composed separately with only their own override removed; profile inserts and other entries' overrides remain effective. Returned configs are detached, and compositions are not cached between reads.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Profile loading](../app-boot/README.md) — patch composition.
- [HMR](../hmr/README.md) — reload coordination.
- [Settings](../../settings/settings/README.md) — schema-derived forms.

<a id="model-experience"></a>
## Model Experience

Indirectly, through configuration values consumed by model-facing plugins.

#### KV Cache effect

Consumers that change request prefixes determine cache effects.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Edits target the active profile patch. Home patches and command-line overlays are read for precedence but are not write targets.
- A complete config override preserves ordinary fields but pins their current raw values at the profile layer.
- Only uniquely addressed entries owned by the profile’s root Include are editable.
- `remove()` accepts only a row that an `insert` item of the profile patch lists directly. A row inside an inserted group, and a row that a bundle or a higher layer adds, cannot be removed. Removing an inserted group leaves the profile patch items that target its nested rows or insert rows into it; those items no longer apply.
- `insert()` and `editRow()` cannot store a config for a row that waits for a service, because a written row that is switched on must be active afterwards.
- After a rejected write, the editor reconciles the prior patches. When that reconciliation is rejected too, the editor logs its rejection as a warning, the rows it names stay inactive, and the caller receives only the rejection of its own write.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
