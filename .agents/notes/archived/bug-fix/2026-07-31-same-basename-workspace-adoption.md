# Agent Note: Same-basename Workspace adoption

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-31-same-basename-workspace-adoption.zh.md)

## Problem

A Workspace is identified by its stable id and canonical directory path, while its title is mutable display metadata. The registry nevertheless rejected a new canonical path when its directory-derived title matched another Workspace. Common directory layouts such as `/a/xx` and `/b/xx` therefore could not coexist in the Web UI, even though the [domain design](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) already permits duplicate titles and every client operation addresses a Workspace by id.

## Decision

`ctx.workspaceRegistry.create(path, title?)` treats canonical path as the only uniqueness key. Repeating the same path remains idempotent and preserves the registered title. Different canonical paths create different Workspace records and may share a title; when no title is supplied, each record derives its title from the final path segment, falling back to the root spelling when that segment is empty. The [fully qualified Workspace path decision](2026-09-03-fully-qualified-workspace-paths.md) owns path admission and the title fallback.

The Host's `workspace.create({ path })` adoption route inherits that rule. The Workspace manager, picker, grouping tree, selection, rename, deletion, and Session creation continue to use `WorkspaceId`, so equal labels neither merge records nor redirect an operation. The sidebar hover card exposes each canonical path when the labels need disambiguation.

Explicit naming remains stricter. `workspace.rename` continues to reject a title already registered, as described by [manual Workspace naming](../feature/2026-07-25-session-list-browsing-and-manual-order.md). This prevents a user from deliberately introducing another ambiguous label while accepting collisions imposed by existing directory names. The path-adoption rule supersedes only the title-conflict clauses in the [Workspace product flow](../feature/2026-07-25-workspace-ui-product-flow.md) and [native directory picker](../feature/2026-07-27-native-workspace-directory-picker.md).

The durable schema does not change: Workspace records already store id, path, and title independently, bootstrap can derive equal basenames, and startup validates duplicate paths rather than titles.

## Verification

Workspace registry and Host API tests create two real directories under different parents with the same final segment and assert distinct ids, paths, and durable order. The picker component renders equal labels as separate id-keyed entries. The keyless Web browser scenario adopts both directories through the composed directory flow and observes two registered and rendered Workspaces.

## Alternatives considered

**Keep title uniqueness and reject the second directory.** A display label would remain an accidental identity key and ordinary multi-root layouts would stay impossible to register.

**Suffix colliding titles automatically.** A generated label such as `xx (2)` would no longer be the directory-derived title, would need stable allocation rules across deletion and reload, and would add state solely to conceal an identity mistake.

**Use the full path as every Workspace title.** This removes the collision but makes the primary navigation label unnecessarily long. The full path remains available in the hover detail while the concise basename stays useful.

**Permit collisions from the explicit rename operation too.** The registry supports that state, but rename intentionally asks the user to choose a display name. Retaining its conflict response preserves the existing naming guard without blocking filesystem-selected paths.

## Consequences

Two Workspace rows may carry the same visible title. They remain independently selectable and actionable because ids own identity; users can inspect the path or rename either row to disambiguate it. An explicit rename cannot select another row's current title, including a title that arose from same-basename adoption. No storage migration or compatibility path is required.
