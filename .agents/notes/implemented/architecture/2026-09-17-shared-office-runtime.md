# Agent Note: Shared Office runtime for Desktop and SDK

Status: implemented

English | [中文](2026-09-17-shared-office-runtime.zh.md)

## Problem

SDK deployments need the same Office authoring libraries as Desktop while keeping interpreter payloads in read-only container image layers. A Desktop-owned query and builder require downstream carriers to duplicate dependency locks and path conventions.

## Decision

[`tool-workspace-dependencies`](../../../../packages/skill/tool-workspace-dependencies/README.md) owns manifest validation, interpreter paths, installation and the model query. It stays in the skill group beside its Office workflow consumer: the payload supplies those workflows, while the package exposes no workspace entity service. Desktop imports this package and retains copy-on-first-use installation. The packaged SDK profile enables the query and Office skills from its carrier default; `DSH_PRIMARY_RUNTIME` overrides that path, including an empty-string opt-out. It reads the payload in place. The common base and `sdk-minimal` do not enable Office implicitly.

The [shared build entry](../../../../scripts/primary-runtime/prepare.ts) owns the download lock, extraction and native smoke checks for Desktop targets and GNU/Linux x64/ARM64. Desktop supplies output paths and its release version, requires Node.js and pnpm, and applies its signing-specific subprocess environment. Other carriers choose their output directory and may build a Python-only payload. The existing `desktopVersion` manifest field retains its name and records the carrier release; `payloadDigest` distinguishes locked inputs and component selection.

The [Desktop primary-runtime decision](../feature/2026-09-14-desktop-primary-runtime.md) continues to own Desktop installation and platform signing. This decision replaces only its Desktop-only builder and query placement; both records remain active.

`runtime.json` stores Python, Node.js and pnpm versions at the top level and all Python distribution versions in `pythonPackages`. Build metadata does not single out numpy or pandas. The shared parser accepts legacy `components` files without rewriting them, retains their consistency checks, and returns only the canonical flat fields. Mixed formats are rejected. The build digest includes the assembly format so changed manifest bytes invalidate payload reuse.

The Python runtime wheel carries target-native CPython and Office libraries plus external skills in a sibling `<platform>-<arch>/` resource directory. Short platform directory names leave room for Python extension and dependency DLL paths after installation on Windows. Bundling supplies defaults; the skill registry still lets project, custom and user skills override same-name bundled entries, and profile patches can disable or replace Office skills without replacing Python. This retains configurable workflows while eliminating a separate environment installation step. Real filesystem resources let Python load native extensions and skills invoke their shared checker without startup extraction. The wheel grows by the compressed payload size; public-index size limits remain enforced by the release workflow.

## Alternatives considered

**Keep implementation in Desktop.** This leaves SDK and container builders depending on application packaging and signing code despite needing only interpreters, Office resources and a query.

**Enable Office in the common base.** A base deployment has no guaranteed bundled interpreter or resources. Explicit SDK carrier configuration makes that requirement observable without changing unrelated profiles.

**Always copy to the Harness home.** Copying duplicates image-layer content, requires a writable destination and cannot serve the intended immutable carrier deployment.

**One component field per Python library.** This duplicates the distribution map and requires schema changes for each library. A complete map records the locked package set independently of the interpreter and package-manager fields.

## Consequences

Successful tool preparation is shared by concurrent calls for one plugin lifetime. Failed preparation is retryable; disposal removes registration and waits for outstanding filesystem work. Copy mode verifies a staged replacement and restores the preceding installation after a failed publication. In-place mode performs no payload writes. Paths are absolute, and runtime metadata and declared entries are checked before results are returned.

SDK configuration changes require restart. Missing Office resources produce a startup warning and leave the optional skill provider inactive; runtime metadata and interpreter availability are validated on the first tool call. musl builds remain outside the lock. Cross-target assembly verifies archive hashes but requires execution on the target host; the Linux artifact CI lane owns native Linux checks. Unit coverage pins manifest, installation and lifecycle behavior; SDK profile tests observe optional tools, skill discovery and results, and the recorded workspace-dependencies scenario pins model-visible validation errors.
