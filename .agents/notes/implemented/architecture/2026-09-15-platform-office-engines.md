# Agent Note: One Office engine per platform

Status: implemented

English | [中文](2026-09-15-platform-office-engines.zh.md)

## Problem

Installing WASM beside a usable native engine adds a second LibreOffice payload to application downloads and installed resources. The original fallback policy in [independent kit ownership](2026-09-14-independent-libreoffice-kit.md) requires that extra payload even on fixed-platform Desktop and Python distributions.

## Decision

Harness selects one engine from the installed kit API’s `optionalDependencies`. A declared `@deepseek-ai/libreoffice-kit-${platform}-${arch}` requires that native package; other targets require the shared WASM package. The supported native target set belongs to the kit release, not an operating-system branch in Harness. A missing declared native package is an incomplete installation and never selects WASM. The provider has no direct WASM dependency.

Python sidecar assembly copies only the selected engine and its dependency closure. Wheel packaging and runtime lookup select from the same kit manifest; the relocated conversion smoke checks the selected backend. Desktop filters its npm installation to that engine before signing and integrity sealing. Engine compilation, resolver compatibility, npm platform metadata, qualification, and publication remain in the kit repository.

## Alternatives considered

**Keep WASM beside every native engine.** This tolerates a missing optional native package but increases every distribution with native support. Fixed-platform distributions require their declared native engine to be present and tested instead.

**Remove WASM on every platform.** Targets without a released native engine still need conversion. The shared WASM package serves those targets without introducing a new native release target.

**Make the Python Office sidecar optional.** The runtime carries the shared `dsh` CLI and its Web profile as well as the default SDK profile. Requiring the target engine gives the installed wheel a complete shipped profile set and reports an incomplete payload before launch. SDK and headless users also pay the engine download and installed-size cost.

## Consequences

Distributions with a declared native target omit WASM assets. Other targets retain WASM resource and font requirements. The pinned kit declares macOS/Windows ARM64 and x64 native packages, so current Linux distributions select WASM; a kit release can add a native Linux target without changing Harness’s selection rule. This does not expand Harness’s supported release platforms. Harness sidecar, wheel, and runtime-resolution tests cover both declared native targets and WASM selection, including missing native packages. New package bytes require kit qualification and matching dependency integrity records before publication.

A new engine package identity also requires updates to `LIBREOFFICE_PACKAGES` in `scripts/gen-third-party-notices.ts`, any applicable `minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml`, and the package list in the [kit ownership note](2026-09-14-independent-libreoffice-kit.md). The license allowlist remains explicit.

The [public Python release workflow](../../../../.github/workflows/python-release.yml) rejects any wheel at or above 100,000,000 bytes. Selecting one engine reduces payload size but does not establish that a runtime wheel meets this limit; npm engine publication and local conversion are separate from wheel upload eligibility.
