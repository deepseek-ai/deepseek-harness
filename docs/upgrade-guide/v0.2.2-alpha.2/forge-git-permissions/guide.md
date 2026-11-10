---
kind: upgrade-guide
description: "Forge Git queries use Session permissions and disable configured diff helpers."
---
# Forge Git query permissions and content conversion

English | [中文](guide.zh.md)

## Change

Forge Git queries use the Session's sandbox mode instead of forcing `read-only`. `danger-full-access` works without a sandbox backend; `workspace-write` permits writes within its configured roots. A confined mode still refuses execution when its backend is unavailable.

On Git 2.31 or newer, local diffs and statistics disable enumerated clean/process filters for each command. Git's built-in newline, ident, and encoding conversions still apply. Materialized LFS files and other filtered files can appear changed when ordinary Git considers them clean. The panel does not request LFS downloads. Older Git or concurrently added filters can still execute helpers under Session permissions. Submodule commit changes remain visible, but internal uncommitted changes are omitted.

Filter configuration read failures, including truncated output, report `forgePanel/filter-config-failed` before any comparison and offer a retry. They are separate from `forgePanel/diff-too-large`.

## Migration

1. Keep a Session in `read-only` when its Git queries require operating-system-enforced write protection. Use the existing permission picker to select the intended Session mode; no configuration keys change.
2. For repositories that require content conversion or submodule working-tree inspection, use an explicit Git command under the intended Session permissions to inspect those changes. The panel's local comparison bypasses clean/process filters on supported Git versions.
3. On a host without a sandbox backend, select Full access and refresh the Forge panel. Its checkout and ordinary local changes should load; switching to a confined mode must still report the unavailable backend.
