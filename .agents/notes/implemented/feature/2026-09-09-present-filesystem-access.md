# Agent Note: Present follows Session filesystem access

Status: implemented

English | [中文](2026-09-09-present-filesystem-access.zh.md)

## Problem

Generated files commonly live outside the workspace, especially in `/tmp`. Workspace containment rejects files that the Session filesystem and Sidebar already allow. A provider process path may also name a remote file rather than a file on the serving Host.

## Decision

`present` accepts existing regular files accessible through its composed `ctx.fs`, with relative paths resolved against the Session working directory. There is no workspace containment check or special temporary-directory allowlist. Missing files, directories, final symbolic links, and provider failures reject the declaration. A sandbox's private temporary files remain unavailable when the filesystem provider cannot see them.

Native actions use the viewed Session header returned with the declaration to form the `workspaceFiles.stat` scope: its cwd, or the deployment workspace root when absent. The same composed filesystem serves Sidebar previews and native validation without activating an Agent, including for child Sessions. The resulting canonical process path must map from a Host path back to the same process path through that filesystem. Absent or different mappings produce 422 and a localized Sidebar-preview suggestion. This conservatively supports Host paths that share their canonical process spelling; providers with only a nonidentity Host mapping can still serve previews. A same-named local file never substitutes for an unmapped provider file.

This replaces the workspace-only access rule in the [source-file delivery decision](2026-09-08-present-workspace-source-files.md). That note continues to own content-free declarations, Session events, and editing current sources. The request still selects only saved Session/event/file coordinates, never an arbitrary browser-supplied path.

## Alternatives considered

A `/tmp` allowlist excludes other readable output locations and duplicates filesystem policy. Treating every provider process path as a Host path can open an unrelated local file. Adding a generic inverse path-mapping API or copying remote files expands provider and retention responsibilities beyond source-file delivery.

## Consequences

Workspace files, accessible temporary files, Downloads, and files in another project use the same declaration rules. Native opening requires both a serving desktop and a verified Host path. Metadata checks do not make a desktop application's later path lookup atomic.

Focused tests cover external absolute and relative paths, final symbolic links, missing files, Session lookup failures, absent and mismatched Host mappings, and localized native-unavailable state. Existing recorded Web scenarios retain declaration, preview, native action, and content-free export coverage.
