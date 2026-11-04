# Agent Note: One Office Kit package across deployments

Status: implemented

English | [中文](2026-10-26-cross-deployment-office-kit.zh.md)

## Problem

Each deployment located LibreOffice Kit differently: the conversion provider, the skills, and the Desktop shell each held their own lookup, and an absent Kit made the conversion row fail to load. A Python SDK executable without its downloaded Office sidecar, or a source checkout without native engines, is a deployment that lacks Kit, not a misconfigured composition; failing the row hid the provider and the skills even though most of their behavior did not need Kit.

## Decision

The [Web bundle](../../../../packages/bundle/web-app/cordis.patch.yml) mounts [`skill-office`](../../../../packages/skill/skill-office/README.md) only in Desktop, and the [SDK bundle](../../../../packages/bundle/sdk-app/cordis.patch.yml) only with a primary runtime, following the mounting decision of [progressive Office skills](2026-09-27-progressive-office-skills.md).

The bundled Python environment ([`tool-workspace-dependencies`](../../../../packages/skill/tool-workspace-dependencies/README.md)) mounts only in Desktop and in the SDK when a primary runtime is available. `skill-office` declares `pythonEnvironment: 'workspace-dependencies' | 'user'` explicitly; a Desktop profile launched without a primary runtime selects `'user'`. The default is `'workspace-dependencies'` because older SDK patches replace the complete `config` of the `skill-office` row; such a patch omits the new key and keeps the bundled-environment instructions it was written for.

[`@deepseek-ai/dsh-office-kit`](../../../../packages/document/office-kit/README.md) owns Kit location and the shared conversion service. Kit location is an internal implementation of the provider and is not exported: the provider passes its own `import.meta.resolve` lookup, and native engine paths use ASAR-unpacked mapping. Location reads no environment variables. The [on-demand Office tools](2026-10-31-native-office-tool.md) run Kit operations inside the Host, so no deployment publishes Kit CLI paths or Office executable variables.

An absent Kit degrades instead of failing a load. The conversion service registers and rejects conversions with code `unavailable`, retaining only a successful Kit import and reporting each distinct failure once; the `office_render`, `office_convert`, and `office_recalculate` tools stay registered and return that message when called.

`office-to-pdf` became `office-kit` so that later Kit consumers, such as native rendering (PR #5374) and the `tool-office` package, take Kit from one package. LibreOffice Kit dependencies declare one exact version in every manifest, so the converter and packaged engine come from the same Kit release.

## Alternatives considered

**Default `pythonEnvironment` to `'user'`.** This matches a Desktop launch without a primary runtime, but an older SDK patch that replaces the row's `config` would silently switch SDK deployments with a primary runtime to the user's Python.

**Read deployment environment variables inside the locator.** This removes the `cordis.yml` expressions, but hides deployment configuration inside a library and makes source, Web, Desktop, and SDK behavior depend on ambient variables. Bundles already own deployment-specific expressions.

**Fail the conversion row when Kit is absent.** This reports the absence at load, which the misconfiguration rule prefers, but the absence belongs to the deployment rather than the configuration, and it disables preview rendering paths and dependent skills that do not need Kit.

**Keep a separate locator package.** A package without Cordis dependencies isolates `skill-office` from the service, but duplicates release, dependency-policy, and documentation configuration for one closely coupled component. No consumer outside the provider needs to locate Kit, so the location logic stays inside the provider.

## Consequences

Deployments without Kit see `unavailable` previews and `office_*` tools that report the missing Kit instead of failing at startup; skill loading does not check for Kit; a later Kit installation takes effect for conversion without reloading the provider. External compositions migrate from the `office-to-pdf` row, `ctx.officeToPdf`, and the `officeToPdf/*` Remote methods to the `office-kit` package through the [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-alpha.3/office-kit-package/guide.md).

Processes launched from the Desktop built-in terminal inherit `DSH_PRIMARY_RUNTIME`, so the SDK uses its bundled environment. The shell publishes no Kit location; child applications resolve their own Kit.

Verification covers Kit lookup from the provider's Kit entry ([kit-lookup.spec.ts](../../../../packages/document/office-kit/tests/kit-lookup.spec.ts)), engine resolution and ASAR-unpacked path mapping ([engine-package.spec.ts](../../../../packages/document/office-kit/tests/engine-package.spec.ts)), independent engine resolution per Kit installation ([anchors.spec.ts](../../../../packages/document/office-kit/tests/anchors.spec.ts)), conversion retry after a missing or unloadable Kit, deduplicated warnings, the `office_*` tools' `unavailable` results with an absent Kit, and Office profile end-to-end tests.
