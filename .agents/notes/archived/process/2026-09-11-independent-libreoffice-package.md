# Agent Note: Independent precompiled LibreOffice package

Status: implemented
Archived: 2026-09-11

English | [中文](2026-09-11-independent-libreoffice-package.zh.md)

## Problem

Compiling LibreOffice inside ordinary DSH builds would require every contributor and CI job to acquire its toolchain and repeat a large native build. Desktop also needs immutable engine resources that can travel with its offline installation material.

## Decision

The [engine package](../../../../native/libreoffice-wasm/package.json) has its own version and an asset-only manifest export. Its source directory stays outside the main pnpm workspace. Installation has no lifecycle hook, and packaging verifies an existing successful build without compiling. The [release workflow](../../../../.github/workflows/libreoffice-wasm-release.yml) compiles only on explicit dispatch; publication requires a matching engine version tag and the protected npm environment.

Each tarball contains the engine manifest and assets, corresponding source pins, patches, full source diff, and the built distribution's license and notices. Packaging rejects mismatched build receipts, modified assets, unlisted engine files, missing notices, and bundled fonts. A failure never triggers compilation automatically.

The [local preview decision](../architecture/2026-09-10-local-office-preview.md) continues to own conversion and explicit artifact configuration. This change establishes release machinery; it does not add an unpublished engine dependency to DSH. The existing [Desktop package set](../../../../apps/desktop/scripts/prepare-package-set.ts) remains the intended carrier for a future fixed-version dependency and its offline seed.

## Alternatives considered

**Compile during ordinary builds or package installation.** This puts engine toolchain availability and compilation cost on every consumer, even when the engine version has not changed.

**Extract a general Node conversion library.** Font handling, Worker ownership, and the conversion API can remain with the provider. Moving them is unnecessary to distribute precompiled assets or isolate compilation from DSH CI.

**Link the engine source as a workspace dependency.** Workspace linking would replace a published precompiled package with a source directory that lacks its engine files.

## Consequences

The engine can be compiled and versioned independently of DSH. The package exposes files rather than a conversion API; the provider retains runtime ownership. Ordinary builds remain free of LibreOffice compilation, as checked by the [packaging tests](../../../../scripts/libreoffice-package.spec.ts).

Initial publication and fixed-version consumer integration remain incomplete. A source tree that differs from its recorded recipe cannot produce a release tarball. Real-engine conversion, installation from the packed package, and Desktop offline seed qualification must accompany the first consumed engine release.
