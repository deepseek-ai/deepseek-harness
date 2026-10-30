# Agent Note: Office skills in every deployment with one Office Kit package

Status: implemented

English | [中文](2026-10-26-cross-deployment-office-kit.zh.md)

## Problem

Office skills were mounted only by Desktop and the Python SDK, so ordinary `dsh web` users could not create or inspect Office documents with the same guidance. Each deployment located LibreOffice Kit differently: the conversion provider, the skills, and the Desktop shell each held their own lookup, and an absent Kit made the conversion row fail to load. A Python SDK executable without its downloaded Office sidecar, or a source checkout without native engines, is a deployment that lacks Kit, not a misconfigured composition; failing the row hid the provider and the skills even though most of their behavior did not need Kit.

## Decision

The [Web bundle](../../../../packages/bundle/web-app/cordis.patch.yml) and the [SDK bundle](../../../../packages/bundle/sdk-app/cordis.patch.yml) mount [`skill-office`](../../../../packages/skill/skill-office/README.md) in Desktop, ordinary `dsh web`, and the SDK. This supersedes the mounting decision of [progressive Office skills](2026-09-27-progressive-office-skills.md); its skill structure and shell execution remain current.

The bundled Python environment ([`tool-workspace-dependencies`](../../../../packages/skill/tool-workspace-dependencies/README.md)) mounts only in Desktop and in the SDK when a primary runtime is available. `skill-office` declares `pythonEnvironment: 'workspace-dependencies' | 'user'` explicitly; each bundle row selects the value for its deployment. The default is `'workspace-dependencies'` because older SDK patches replace the complete `config` of the `skill-office` row; such a patch omits the new key and keeps the bundled-environment instructions it was written for.

[`@deepseek-ai/dsh-office-kit`](../../../../packages/document/office-kit/README.md) owns Kit location and the shared conversion service. Its `/locate` entry accepts only explicit arguments: the consumer's own `import.meta.resolve` lookup configured `node` and `cli` paths, and an optional automatic-discovery `root`. Automatic CLI and native engine paths share ASAR-unpacked mapping. The Desktop shell sets `DSH_BUNDLED_RUNTIME_ROOT` to the dsh runtime directory only for production runtimes, including ASAR and copied release trees; the Web bundle passes it as `kitRoot` and leaves CLI discovery to the Host. With a root, the resolver rejects paths outside the physical runtime after realpath, preventing lookup from selecting the Electron shell's own Kit. Development explicitly clears the inherited variable and, like Web, leaves discovery unrestricted because workspace dependency links resolve outside the disposable runtime. It reads no environment variables; deployment-specific paths reach it through `cordis.yml` expressions in each bundle. The entry imports only Node built-in modules as values, so `skill-office` depends on it without loading Cordis services, Schemastery, or Kit.

An absent Kit degrades instead of failing a load. The conversion service registers and rejects conversions with code `unavailable`, retaining only a successful Kit import and reporting each distinct failure once. Operation skills state that Kit is not available and log the lookup failure once. A configured `node` or `cli` path that is not an absolute existing file still fails the skill load, because that value comes from the composition.

`office-to-pdf` became `office-kit` so that later Kit consumers, such as CLI paths for further deployments and native rendering (PR #5374), take Kit from one package. LibreOffice Kit dependencies declare one exact version in every manifest, so the converter, CLI, and packaged engine come from the same Kit release.

## Alternatives considered

**Keep Office skills out of ordinary Web.** This keeps ordinary Web free of Office guidance it might not execute, but leaves Web users without document authoring that needs only Python libraries. Skills now direct the model to the user's Python when no bundled environment exists.

**Default `pythonEnvironment` to `'user'`.** This matches ordinary Web, but an older SDK patch that replaces the row's `config` would silently switch Desktop-like SDK deployments to the user's Python.

**Read deployment environment variables inside the locator.** This removes the `cordis.yml` expressions, but hides deployment configuration inside a library and makes source, Web, Desktop, and SDK behavior depend on ambient variables. Bundles already own deployment-specific expressions.

**Fail the conversion row when Kit is absent.** This reports the absence at load, which the misconfiguration rule prefers, but the absence belongs to the deployment rather than the configuration, and it disables preview rendering paths and dependent skills that do not need Kit.

**Keep a separate locator package.** A package without Cordis dependencies isolates `skill-office` from the service, but duplicates release, dependency-policy, and documentation configuration for one closely coupled component. The `/locate` subpath provides the same import isolation.

## Consequences

Ordinary Web and SDK sessions without a bundled environment list the seven Office skills, which adds their summaries to the first context. Deployments without Kit see `unavailable` previews and skills that report the missing Kit instead of failing at startup; a later Kit installation takes effect for conversion without reloading the provider. External compositions migrate from the `office-to-pdf` row, `ctx.officeToPdf`, and the `officeToPdf/*` Remote methods through the [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-alpha.2/office-kit-package/guide.md).

Processes launched from the Desktop built-in terminal inherit `DSH_BUNDLED_PRIMARY_RUNTIME`, so the SDK uses its bundled environment. Production children also inherit `DSH_BUNDLED_RUNTIME_ROOT`, but only the Desktop profile uses it. The shell does not publish a Kit CLI variable; child applications resolve their own Kit unless explicitly configured by their launcher.

Verification covers the `/locate` import restriction, Kit lookup and engine resolution, conversion retry after a missing or unloadable Kit, deduplicated warnings, operation skills with an absent Kit, recorded Web and SDK sessions that list the Office skills, and Office profile end-to-end tests.
