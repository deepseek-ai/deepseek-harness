---
description: "Shared TypeScript declarations for package.json.dsh metadata, usable by boot, client, build, and external packages."
kind: "package-library"
---

# @deepseek-ai/dsh-package-manifest

English | [中文](README.zh.md)

## Summary

Use `DshManifest` to type a package's Harness metadata, or a member type such as `DshClientManifest` for one declaration. Boot, client, build, and external packages import the same types; each reader owns JSON validation and default resolution.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Import from the package root. Use a development dependency when only checking your own source; use a production dependency if your published declarations reference these types.

```ts
import type { DshClientManifest, DshManifest } from '@deepseek-ai/dsh-package-manifest'

const client: DshClientManifest = { platform: 'web' }
const dsh: DshManifest = {
  bundle: { patch: './cordis.patch.yml' },
  client,
}
```

`DshManifest` describes `bundle`, `profile`, `client`, `configTrees`, `sessionFormatMigration`, and `moduleFallback`, not the surrounding npm manifest. `moduleFallback` is launcher-generated metadata and is not an author configuration entry. TypeScript checks this object and erases `import type` during compilation; JSON files cannot import types, and this example does not write a `package.json`. See [`src/types.ts`](src/types.ts) for the declarations.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package root only re-exports declarations from [`src/types.ts`](src/types.ts). No runtime invariant companion is published because the package has no runtime state or independently observable relationships.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Profile launcher](../../boot/app-boot/README.md#profiles) — manifest loading and composition.
- [Declaration ownership](../../../.agents/notes/implemented/architecture/2026-09-05-package-manifest-types.md) — scope and dependency rationale.

<a id="model-experience"></a>
## Model Experience

None, as this package only exports types.

#### KV Cache effect

Type declarations add no model input, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Static typing only.** These declarations do not validate JSON, check file existence, or supply defaults. `configTrees` serves the experimental image packer, and `sessionFormatMigration` is discovered only for workspace migration packages; declaring them does not register external plugin behavior.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
