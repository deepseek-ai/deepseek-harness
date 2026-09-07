# Agent Note: Package manifest declaration ownership

Status: implemented

English | [中文](2026-09-05-package-manifest-types.zh.md)

## Problem

External packages need Harness manifest types without depending on boot or client implementations. Keeping declarations beside individual readers obscures the complete configuration API and lets overlapping fields diverge.

## Decision

[`@deepseek-ai/dsh-package-manifest`](../../../../packages/util/package-manifest/README.md) owns `DshManifest` and its member declarations in one type-only file. The package belongs to the existing utility group and exports no runtime values. Author declarations and launcher-generated module fallback metadata are explicitly distinguished.

Readers import the shared declarations directly. Boot retains profile loading, raw JSON checks, defaults, and resolved runtime data. Client modules retain their normalized boot graph. The image packer resolves declared paths into directories. The Session catalog generator derives a read-only validated entry with a resolved import path; raw inputs and discovery rules remain local.

App-boot declares a production dependency because its published declarations reference the shared types. Client modules, the private packer, and root scripts use development dependencies because their published APIs do not expose these types. Every package consumer has a TypeScript project reference. External authors import from the utility package; app-boot provides no compatibility re-exports.

## Alternatives considered

**Keep declarations in individual readers.** External authors would depend on runtime implementations, and a partial profile-only definition would omit existing client and build fields.

**Create a separate types group.** The existing utility group accommodates a type-only library without another package category. Runtime service and event declarations stay with their owners.

**Unify the JSON parsers.** Sharing declarations does not require changing validation, errors, defaults, or parsed results; those remain owned by each reader.

## Consequences

Authors gain one public import path at the cost of a published package and explicit dependency edges. Existing app-boot manifest type imports must use the new package. The [profile composition design](2026-08-05-profile-plugin-bundles.md) continues to own runtime semantics; type extraction does not change configuration acceptance or model-visible behavior.

Compiler and packaged NodeNext consumer checks cover public imports. Existing profile, client, image configuration, and Session catalog tests cover reader behavior; documentation checks cover the utility classification and generated package catalogs. Optional declaration fields still require deliberate consumer updates when added.
