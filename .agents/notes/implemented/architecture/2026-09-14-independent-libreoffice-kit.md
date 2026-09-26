# Agent Note: Independent LibreOffice kit ownership

Status: implemented

English | [中文](2026-09-14-independent-libreoffice-kit.zh.md)

## Problem

LibreOffice compilation, source patches, platform qualification, and large binary releases have a different maintenance cycle from Harness plugins. Keeping them in the application workspace expands routine CI and couples engine repairs to monorepo package rules.

## Decision

The `deepseek-harness/libreoffice-kit` repository owns the reusable `@deepseek-ai/libreoffice-kit` Node API, its Worker, font handling, engine selection, build recipes, patches, tests, and releases. The API has no Cordis dependency. Harness owns the adapter from its `OfficeToPdf` service to this API, Session authorization, conversion lifetime, transport, Web UI, and application packaging.

Kit releases run independently of Harness releases. The kit repository qualifies and publishes the Node API and engine npm packages at a shared version, starting at `0.0.1`. Harness consumes an exact npm version and commits its dependency resolution in `pnpm-lock.yaml`; Harness releases neither build nor publish kit packages.

The upstream API declares platform engines as optional dependencies. The [platform engine decision](2026-09-15-platform-office-engines.md) supersedes the original required-WASM fallback policy. Desktop installs the kit as an external npm dependency. Python sidecars keep the Worker, selected engine, and their dependency closure on the real filesystem, outside the executable’s virtual filesystem. Conversion requires neither downloads nor GitHub credentials.

The kit repository owns engine qualification and corresponding source materials. MPL-2.0 declarations, source availability, and redistribution notices accompany the API and engines; Harness retains these materials when packaging them. The notices check accepts the exact API, WASM, macOS ARM64/x64, and Windows ARM64/x64 package identities only at MPL-2.0; unrelated packages and changed license terms still reject.

## Alternatives considered

**Co-locate the public API and Core build in Harness.** This synchronizes source changes but makes application maintenance own long engine builds and special package rules. The Cordis provider is the application integration point; the reusable conversion API belongs with its engine tests.

**Prepare GitHub Release archives before installation.** This requires separate authentication, hashes, decompression, workspace overrides, and distribution repacking. Published npm packages use the application's ordinary dependency installation and platform selection.

## Consequences

Changing the kit requires qualifying a release in its own repository and updating the Harness dependency versions and lockfile. A missing required npm package fails installation; Harness does not compile an engine to recover. Native and WASM conversion smokes validate the installed packages, while Desktop and Python checks cover application packaging.
