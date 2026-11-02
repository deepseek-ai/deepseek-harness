# Agent Note: Session permissions for Forge Git queries

Status: implemented

English | [中文](2026-10-28-forge-git-session-permissions.zh.md)

## Problem

The [Forge panel](../feature/2026-10-09-forge-panel.md) forces read-only confinement even when a Session grants full access. On hosts without a usable sandbox, its checkout and local changes remain unavailable while the Session's shell works. Background queries also reach repository-configured executable helpers through working-tree comparisons.

## Decision

Git inspection uses the Session's resolved sandbox mode and subprocess provider. Full access requires no sandbox backend; confined modes retain their enforcement and never retry unconfined. The Session remains the authority for filesystem permissions, including workspace-write access. Query commands do not request repository mutations.

Local patches and statistics apply command-local Git configuration to disable clean/process filters without changing user configuration. Environment entries preserve subsection names containing equals signs. Existing hook, fsmonitor, external-diff, textconv, optional-lock, and lazy-fetch restrictions remain; submodule queries show commit changes without scanning internal dirty files. Configuration read failure stops the comparison; the changes view reports the filter configuration failure separately from oversized diffs and offers a retry. These restrictions follow the informational-diff approach in Codex while retaining DSH's execution-world and cancellation ownership.

## Alternatives considered

**Force read-only for every query.** This makes an explicitly unconfined Session depend on an unavailable backend. Using the Session mode keeps tool and panel permission behavior consistent.

**Retry without confinement after failure.** This would silently grant authority that a restricted Session does not have.

**Run configured content converters.** They can execute programs and write files during automatic refresh. Disabling them trades converted-content equivalence for predictable query behavior.

## Consequences

Operating-system write protection follows the Session mode rather than a separate panel policy. With clean/process filters disabled, comparisons still apply Git's built-in newline, ident, and encoding conversions: materialized LFS and other filtered files can appear changed even when ordinary Git considers them clean. Pointer-only checkouts compare normally. Uncommitted submodule contents are omitted. The original Forge note remains active for panel ownership and worktree lifecycle; this note supersedes only its unconditional read-only policy.

Filter overrides require Git 2.31 or newer; older Git can ignore them and execute configured helpers under Session permissions. Enumeration and diff run in separate processes, so a concurrently added driver can escape the overrides. These restrictions limit incidental helper execution; the Session sandbox determines the permissions of every process that runs.

Real-repository tests cover permission modes, unavailable confinement, unchanged index/configuration, configured helper markers, submodule commits, filtered bytes, and failed filter enumeration. The Web replay covers permission changes through the picker and the resulting checkout and local-change view.
