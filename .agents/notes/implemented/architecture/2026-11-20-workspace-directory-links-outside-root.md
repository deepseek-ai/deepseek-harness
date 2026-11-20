# Agent Note: List and watch directories through links that leave the workspace root

Status: implemented

English | [中文](2026-11-20-workspace-directory-links-outside-root.zh.md)

## Problem

`list` and `changes` judged a directory only by its resolved target: `ctx.fs.contains(root, target)` had to hold. A directory link in the workspace that resolves outside the root therefore appeared in its parent's listing as a directory and failed with `workspace-file/outside-workspace` when opened. The files under it stayed readable: `read`, `readBytes`, and `stat` follow the Session filesystem backend's read authority, which the [workspace file read authority](2026-09-09-workspace-file-read-authority.md) does not limit to the workspace. The refusal withheld only the names under the link, and the reader had to ask the Agent for a link to each file.

## Decision

A directory passes the workspace check of `list` and `changes` in either of two ways: its resolved target is inside the workspace root, or its requested path descends from the root by child names. `workspaceDescent` in [`src/descent.ts`](../../../../packages/api/workspace-files/src/descent.ts) decides the second: it judges the path as written, without resolving links, and returns nothing for a path with a `..` segment, an absolute path beside or above the root, or a path on another Windows drive. A `..` segment is refused because after a link it names the parent of the link's target, a directory that no link in the workspace names.

A listing names a directory inside the root by its resolved position, and a directory outside the root by the requested path. An absolute directory outside the root and a `..` traversal that resolves outside it remain `workspace-file/outside-workspace`. Search does not follow links, and the file methods are unchanged.

This supersedes two earlier choices. The [Workspace Files service](2026-09-05-workspace-files-service.md) and the [workspace file read authority](2026-09-09-workspace-file-read-authority.md) had `list` and `changes` judge a directory by resolved containment alone, and the [archived directory link listing note](../../archived/bug-fix/2026-09-18-windows-directory-junction-listing.md) refused a link that resolves outside the workspace.

## Alternatives considered

**Keep resolved containment as the only check.** Rejected: the Session backend already serves the content of those files to the same caller, so the refusal withheld only directory entry names, while the tree presented a directory it could not open.

**Remove the workspace check from `list` and `changes`.** Rejected: a caller could then enumerate any Host directory by absolute path. Under the chosen rule, reaching a directory outside the root requires a link placed in the workspace.

**Require a separate grant for each outside target.** Rejected: the backend's read authority already covers the target, so a second approval would restrict browsing more than reading.

**Resolve each ancestor of the path until one equals the root.** Rejected: it costs one backend resolution per path segment on every listing, and each is a round trip on a remote backend. Comparing the written path with `WorkspaceFileScope.workspaceRoot` costs none.

## Consequences

The Sidebar file tree expands a directory link that resolves outside the workspace, lists the directories below it, and refreshes them from watches. A link to a broad directory, such as the filesystem root, shows that directory's entry names to the Session's owner, whose file reads already reach it. Every `workspaceFiles` method stays owner-only in Liveshare.

A path spelled against a root other than `WorkspaceFileScope.workspaceRoot`, such as the canonical spelling of a Session directory that is itself reached through a link, passes only by resolved containment, so a link resolving outside the workspace stays refused for that spelling. Search results omit entries below directory links.
