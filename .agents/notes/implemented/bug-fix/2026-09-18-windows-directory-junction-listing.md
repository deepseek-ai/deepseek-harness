# Agent Note: List directory links in the workspace file tree

Status: implemented

English | [中文](2026-09-18-windows-directory-junction-listing.zh.md)

## Problem

Windows profile directories such as `Documents\My Music` are directory junctions: reparse points that `lstat` reports as symlinks rather than directories. The `list` endpoint gated on `lstat` before resolving, so it refused every final link with `workspace-file/not-directory`, while its own listing reported those same children as `directory` because `listDir` resolves each child. The file tree therefore listed the junctions and refused to open them, and the Sidebar reported `My Music`, `My Pictures`, and `My Videos` as not a directory.

## Decision

`list` follows a final link and judges what it resolves to. The resolved target must pass workspace containment and must stat as a directory, so a directory link inside the workspace lists through its target, and the returned workspace path names that target. A link resolving outside the workspace is `workspace-file/outside-workspace`; a link to a non-directory, or one whose target is gone, is `workspace-file/not-directory` with kind `symlink`.

`read`, `readBytes`, `readAll`, `readRelated`, and `stat` keep their `lstat` gate that refuses a final symlink, so no read path follows a link. The [Workspace Files service](../architecture/2026-09-05-workspace-files-service.md) keeps ownership of the service; its earlier rule that `list` rejects a final symlink is superseded here.

## Alternatives considered

**Drop the `lstat` gate for every method.** Rejected: reading through a link is a separate exposure decision, and the file methods' no-follow rule is a trust rule the report asked to keep.

**Special-case Windows junctions.** Rejected: `fs-local` already reports a junction as a `symlink` path entry, and the resolve-then-contain rule is identical for a junction and a POSIX directory symlink.

**Keep the gate and report a linked directory from the parent listing only.** Rejected: the listing already reports the resolved type, so the endpoint contradicted itself and a reader could not open what the parent presented as a directory.

## Consequences

A directory link inside the workspace now lists like its target, and the Windows profile junctions expand in the Sidebar. A link resolving outside the workspace reports `outside-workspace` instead of `not-directory`, which names the actual reason. Read access is unchanged. Tests cover a directory link inside the workspace, a link resolving outside it, and a link whose target is deleted; the spec creates a junction with `symlink(target, path, 'junction')` on Windows and a directory symlink elsewhere, so one spec runs on both.
