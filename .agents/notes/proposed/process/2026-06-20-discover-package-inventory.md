# Agent Note: Discover package inventories instead of maintaining static lists

Status: proposed

English | [中文](2026-06-20-discover-package-inventory.zh.md)

## Problem

Package and gate inventories are repeated across TypeScript project references, package docs, and CI prose. Most restate package layout, manifest data, or aggregate command contents. Each new package therefore creates avoidable synchronization points.

The [package hierarchy](../../archived/architecture/2026-06-20-package-hierarchy.md) already removed several of these by hand: `scripts/publint-all.ts` now derives its list from the `packages/<group>/<pkg>` layout, and the two `tsconfig` `paths` maps collapsed to one `@deepseek-ai/dsh-*` wildcard — since reverted to one explicit alias per package, generated and gated, because resolving a wildcard's candidates in order dominated source-launch boot ([explicit workspace path aliases](../../archived/process/2026-08-27-explicit-workspace-path-aliases.md)). What remains is the inventory that cannot be globbed away — chiefly the aggregate configs' (`tsconfig.host.json`, `tsconfig.client.json`) project `references`, which TypeScript requires as explicit arrays (no wildcard form).

Static lists are appropriate when they encode policy; they are needless friction when they duplicate manifest data or layout facts that already exist in `package.json`, workspace globs, or the package hierarchy.

## Proposal

Make the remaining package/gate inventories discoverable. A single canonical source — the `packages/<group>/<pkg>` hierarchy plus package manifests — should drive the aggregates' `references`, the module graph, and any other full-package list, with a generate-and-verify step (the existing `gen-module-graph` / `gen-cordis-catalog` pattern: a generator writes the artifact, a `--check` mode in `hygiene`/`doc-sync` fails on a stale committed copy). Module graph generation already reads package manifests. `doc-sync` should be the one command that defines and prints its sub-gates, with docs linking to that command rather than restating a second list.

The hierarchy does not need to encode every fact about a package, but it should encode the broad maintenance policy: core/product packages, integrations, capability seams, and support/test/example packages should not all require a hand-maintained exception list before scripts can tell them apart.

## Acceptance criteria

- Aggregate-config project `references` are generated from the hierarchy (a generator emits them; a `--check` gate fails when the committed copy is stale), rather than hand-maintained.
- Adding a package does not require editing a static package list for any gate.
- Docs describe the source of truth rather than repeating generated inventories.
- CI invokes the aggregate commands and lets those commands own their sub-gate lists.

## Risks

Discovery scripts can become too clever. The implementation should stay boring: read manifests, filter on explicit fields, print the resolved list, and fail loud. The payoff is removing manual inventory drift, not inventing a build system.

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
