---
description: "Shared TypeScript declarations for package identity, runtime requirements, and DSH plugin metadata."
kind: "package-library"
---

# @deepseek-ai/dsh-package-manifest

English | [中文](README.zh.md)

## Summary

Use `DshPackageManifest` for package metadata, `DshManifest` for the public fields under `dsh`, and member types such as `DshClientManifest` for one domain. Each reader owns JSON parsing, validation, and default resolution.

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
import type { DshClientManifest, DshPackageManifest } from '@deepseek-ai/dsh-package-manifest'

const client: DshClientManifest = { platform: 'web' }
const manifest: DshPackageManifest = {
  name: 'example-dsh-plugin',
  version: '1.0.0',
  engines: { node: '>=24', dsh: '0.1.5-alpha.1' },
  dsh: {
    manifestVersion: 1,
    bundle: { patch: './cordis.patch.yml' },
    client,
  },
}
```

`DshPackageManifest` describes the package.json fields used by DSH, with required `name` and `version`; it is not an exhaustive npm schema. Local profile readers use `Partial<DshPackageManifest>` because profiles need no published version. `DshManifest` describes only public author fields under `dsh`. TypeScript checks the example and erases `import type`; these interfaces do not parse JSON or write a file.

The following metadata fields are optional. Omitting them leaves the format version or compatible host versions undeclared; readers do not infer defaults.

| Field | Meaning |
|---|---|
| `dsh.manifestVersion` | Manifest format identifier; the declared format is `1`, independent of the npm package version and Session format version. |
| `engines.dsh` | Author-declared compatible DSH versions as a SemVer range, including exact prerelease versions. This field sits beside `engines.node` and `engines.npm`; an engines object may omit `dsh`. |

Public composition declarations are defined in [`src/types.ts`](src/types.ts). Internal `configTrees`, `sessionFormatMigration`, and generated `moduleFallback` metadata remain owned by their image-packer, catalog, and launcher readers; the public types do not expose them.

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
- [Public package metadata](../../../.agents/notes/implemented/architecture/2026-09-10-public-package-manifest.md) — field placement and reader ownership.

<a id="model-experience"></a>
## Model Experience

None, as this package only exports types.

#### KV Cache effect

Type declarations add no model input, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Static typing only.** Consumers read and validate the JSON fields they use, then adapt the shared declarations to their runtime data. The package supplies no parser, getter helpers, file checks, or defaults.
- **Compatibility is declarative.** Current installers and loaders do not enforce `dsh.manifestVersion` or `engines.dsh`; declaring a range does not reject incompatible hosts or validate SemVer syntax.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
