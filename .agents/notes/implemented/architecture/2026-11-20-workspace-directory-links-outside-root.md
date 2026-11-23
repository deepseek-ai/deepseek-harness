# Agent Note: List and watch directories through links that leave the workspace root

Status: implemented

English | [中文](2026-11-20-workspace-directory-links-outside-root.zh.md)

## Problem

`list` and `changes` judged a directory only by its resolved target: `ctx.fs.contains(root, target)` had to hold. A directory link in the workspace that resolves outside the root therefore appeared in its parent's listing as a directory and failed with `workspace-file/outside-workspace` when opened. The files under it stayed readable: `read`, `readBytes`, and `stat` follow the Session filesystem backend's read authority, which the [workspace file read authority](2026-09-09-workspace-file-read-authority.md) does not limit to the workspace. The refusal withheld only the names under the link, and the reader had to ask the Agent for a link to each file.

## Decision

A directory passes the workspace check of `list` and `changes` in either of two ways: its resolved target is inside the workspace root, or the path the filesystem backend resolved descends from the root by child names. `workspaceDescent` in [`src/descent.ts`](../../../../packages/api/workspace-files/src/descent.ts) decides the second from two spellings the backend returns as `FsTarget.displayPath`, one for the root and one for the directory: each is absolute, has a home prefix expanded, and follows no link. The directory qualifies when its spelling is the root's spelling followed by child names. A `..` segment, a spelling above or beside the root, another Windows drive, and a root spelling that is not absolute do not qualify. A `..` segment is refused because after a link it names the parent of the link's target, and the workspace check cannot tell whether any link in the workspace names that directory.

A listing names a directory inside the root by its resolved position, and a directory outside the root by its child names below the root. An absolute directory outside the root, the home directory the backend expands from `~`, and a `..` traversal that resolves outside the root remain `workspace-file/outside-workspace`. Search does not follow links, and the file methods are unchanged.

This supersedes two earlier choices. The [Workspace Files service](2026-09-05-workspace-files-service.md) and the [workspace file read authority](2026-09-09-workspace-file-read-authority.md) had `list` and `changes` judge a directory by resolved containment alone, and the [archived directory link listing note](../../archived/bug-fix/2026-09-18-windows-directory-junction-listing.md) refused a link that resolves outside the workspace.

## Alternatives considered

**Keep resolved containment as the only check.** Rejected: the Session backend already serves the content of those files to the same caller, so the refusal withheld only directory entry names, while the tree presented a directory it could not open.

**Remove the workspace check from `list` and `changes`.** Rejected: a caller could then enumerate any Host directory by absolute path. Under the chosen rule, reaching a directory outside the root requires a link placed in the workspace.

**Require a separate grant for each outside target.** Rejected: the backend's read authority already covers the target, so a second approval would restrict browsing more than reading.

**Judge the request string.** Rejected: the backend reads the same string by its own rules. It expands a leading `~` to the Host user's home directory and applies its platform's drive and UNC rules, so a check that parsed the string separately accepted `~`, and a path on another drive under a root spelled `//server/share`, with no link in the workspace. The backend's unresolved spelling already carries those rules.

**Resolve each ancestor of the path until one equals the root.** Rejected: it costs one backend resolution per path segment on every listing, and each is a round trip on a remote backend. Comparing the two spellings that `list` and `changes` already hold costs none.

## Consequences

The Sidebar file tree expands a directory link that resolves outside the workspace, lists the directories below it, and refreshes them from watches. A link to a broad directory, such as the filesystem root, shows that directory's entry names to the Session's owner, whose file reads already reach it. Every `workspaceFiles` method stays owner-only in Liveshare. Link cycles are not detected: `list` and a directory watch each cover one level, so a link that leads back to an ancestor lists again at each level until the platform refuses the path.

A path spelled against a root other than `WorkspaceFileScope.workspaceRoot`, such as the canonical spelling of a Session directory that is itself reached through a link, passes only by resolved containment, so a link resolving outside the workspace stays refused for that spelling; under a Windows root the spellings compare exactly, so another letter case is refused the same way. The check relies on `displayPath` being the absolute spelling the backend resolved the target from, which the local backend returns and the SSH backend relays from the remote host; a backend that returns a workspace-relative path or a URI keeps such a link refused. Search results omit entries below directory links.
