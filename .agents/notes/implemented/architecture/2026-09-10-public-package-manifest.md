# Agent Note: Public package manifest fields

Status: implemented

English | [中文](2026-09-10-public-package-manifest.zh.md)

## Problem

Plugin authors need npm identity, runtime requirements, and DSH declarations from one public import. Internal image-packaging, Session catalog, and generated proxy metadata do not define extension points for community plugins. Exposing those fields together makes internal mechanisms appear available to external authors.

## Decision

[`DshPackageManifest`](../../../../packages/util/package-manifest/src/types.ts) describes the package.json fields DSH uses, with required `name` and `version`. Its optional `dsh` member uses `DshManifest` for public composition and author metadata. The type is a selected npm field set, not a complete package.json schema. App-boot adapts it with `Partial` for local profiles, which need no published identity.

Runtime requirements live at top-level `engines`: `dsh`, `node`, and `npm` are optional version strings, and other engine names are allowed. `dsh.manifestVersion` identifies declaration format `1`. Format and DSH compatibility declarations are not enforced by current installers or loaders.

The image packer owns `configTrees`, the workspace catalog generator owns Session migration declarations, and app-boot owns generated module-fallback metadata. Their existing on-disk keys remain readable by those internal tools, but the public manifest types do not expose them. This scope refines the [shared declaration ownership decision](2026-09-05-package-manifest-types.md), whose package placement and dependency rules remain active.

Each consumer owns JSON parsing, field validation, default resolution, and adaptation to runtime data. Interfaces do not validate parsed JSON. A helper belongs in the shared package only when multiple consumers need the same validation or normalization; getters that repeat property access add no shared policy.

## Alternatives considered

**Keep internal metadata in the public declaration.** A workspace-only migration catalog and an experimental image packer cannot offer public plugin behavior merely because their metadata is discoverable.

**Put DSH compatibility under `dsh.engines`.** [VS Code](https://code.visualstudio.com/api/references/extension-manifest) places its host requirement in top-level `engines.vscode`. Top-level `engines.dsh` gives authors one location for runtime requirements; DSH still owns enforcement of its custom key.

**Use peer dependencies as the sole host requirement.** Peer dependencies constrain installed npm packages, including the CLI package `@deepseek-ai/dsh`. They do not identify the currently running DSH process when plugins live in a separate profile project.

**Parse every domain through one mandatory parser.** Existing readers consume different subsets and own different errors and defaults. Combining them would make a client reader validate unrelated profile declarations. The public types remain independent of filesystem access and parsing policy.

## Consequences

External authors gain a complete package-level declaration and a smaller DSH author API. Consumers of removed internal types must use their owning implementations. The packer and repository catalog no longer depend on the public declaration package; app-boot retains a production dependency because its published profile type references it.

Compiler and built NodeNext import checks verify required package identity, partial profiles, top-level engine declarations, and the absence of internal fields from the public API. Existing profile, packer, and Session catalog tests retain coverage of their accepted files and malformed declarations. No Session format, plugin loading rule, or model-visible behavior changes.
