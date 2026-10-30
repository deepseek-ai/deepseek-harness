---
description: "Resolve LibreOffice Kit engine manifests from the consumer's installation, including native ASAR paths."
kind: "package-library"
---

# @deepseek-ai/dsh-office-engine-resolver

English | [中文](README.zh.md)

## Summary

Resolve engine packages for the LibreOffice Kit installation your application actually uses. Native engines inside an ASAR archive resolve to their adjacent unpacked paths; WASM retains its logical path. The [Office-to-PDF provider](../office-to-pdf/README.md) uses this callback without installing module hooks or loading Electron.

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

Use this library as a dependency of a Node consumer that supplies Kit's `resolveEnginePackage` option. The consumer owns its Kit dependency; this package does not depend on Kit and has no `cordis.yml` configuration.

```ts
import { createEnginePackageResolver } from '@deepseek-ai/dsh-office-engine-resolver'

const options = {
  resolveEnginePackage: createEnginePackageResolver(import.meta.resolve('@deepseek-ai/libreoffice-kit')),
}
```

Pass `options` to Kit's `createConverter` or `discoverRuntime`, or as `options` in the editor's `openDocument` request. Resolve the Kit entry in the consuming module: anchoring at this library could select a different installation. The factory also accepts an absolute entry path or a file `URL`; each callback retains its own resolver.

A successful callback returns an absolute engine `package.json` path. An absent package preserves Node's original `MODULE_NOT_FOUND`, allowing Kit's native-to-WASM fallback. If a package directory exists, including a dangling symlink, but its manifest cannot resolve, the callback throws an incomplete-installation error with the Node error as `cause`; reinstall that package. Other resolution and filesystem inspection errors propagate unchanged. Kit owns validation of the returned manifest and required assets.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [factory](src/index.ts) creates a Node resolver from the supplied Kit entry and resolves engine manifests relative to it. Native paths replace only the first `.asar` archive segment with `.asar.unpacked`, regardless of whether the process runs in Electron. Already-unpacked paths and paths outside an archive remain unchanged. `@deepseek-ai/libreoffice-kit-wasm` always keeps Node's logical path for archive-aware filesystem access.

The callback only resolves paths and inspects failed installations. It does not load engine code, register services, mutate module resolution, or retain module-level state. [Desktop packaging](../../../apps/desktop/packaging/README.md#runtime-file-selection) owns the unpacked files.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Office-to-PDF provider](../office-to-pdf/README.md) — converter configuration and request ownership.
- [Document conversion](../../../docs/subsystems/office-to-pdf.md) — shared Host conversion operation.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package resolves engine manifests without constructing model input or registering tools.

#### KV Cache effect

None; resolution does not construct or modify model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The caller must supply the entry of the Kit installation it uses; the resolver does not discover or install Kit or engines.
- Mapping a native path does not verify that the unpacked copy exists. Kit rejects missing manifests or assets instead of treating them as an absent native package.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
