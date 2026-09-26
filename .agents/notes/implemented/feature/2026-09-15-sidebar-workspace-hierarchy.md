# Agent Note: Sidebar Workspace Hierarchy

Status: implemented

English | [中文](2026-09-15-sidebar-workspace-hierarchy.zh.md)

## Problem

A flat Workspace list makes related projects hard to browse when many directories share one parent. Treating that parent as the owner of every descendant Session would conflict with the Workspace requirement that a member Session's canonical working directory equals the registered path.

## Decision

The sidebar defaults to sibling Workspace sections. Selecting **Workspace Tree** in **View options → Group by** derives a recursive hierarchy from registered Workspace paths. The selected mode persists in the existing browser-local viewing store. Each Workspace appears under its nearest strict ancestor; path equality never creates a self-parent. Comparison respects directory separators and Host case spelling, without resolving symlink aliases. Siblings retain their Host order.

Adding a directory registers a normal Workspace and opens its Session directly. Parent Workspaces retain their own Sessions and standard row actions, with child Workspaces preceding their own Sessions. The existing browser-local expansion state controls both child Workspaces and the parent's Session rows; ancestors default to expanded when no explicit preference exists. Explicit collapse also hides the current Session, while ancestor folder icons identify its containing subtree. All rows have equal-width fills and hit targets, with content indentation per level. Workspace drag stays among siblings; descendant drop targets delegate to the nearest compatible ancestor, and unchanged sibling positions do not write Host order. Search navigation expands every ancestor.

## Alternatives considered

**Tree grouping by default:** this hides projects under ancestors even when users want to browse every Workspace directly. An explicit viewing mode preserves the default layout without adding a confirmation to directory adoption.

**Recursive Workspace membership:** this changes the working-directory invariant and makes a Session eligible for multiple accounts. Display nesting needs neither change.

**Separate parent-folder records and an add-time choice:** this duplicates directories already represented by Workspaces and adds a confirmation to ordinary addition. Deriving hierarchy from the registry preserves one add flow and lets every directory own Sessions.

**Automatic directory discovery:** this could show unregistered projects, but requires filesystem listing, refresh, and adoption behavior. The sidebar consumes the current Workspace list only.

## Consequences

Users can collapse related projects without changing Session ownership. Deleting an ancestor preserves child registrations; the independent [Workspace deletion semantics](2026-07-27-workspace-registration-deletion.md) still govern the deleted Workspace's own Sessions. That decision remains active. Browser-local collapse preferences do not synchronize, and registered path spelling after separator normalization determines nesting.

Pure path tests cover strict ancestry, segment boundaries, POSIX backslashes, and Windows separators. Component and browser scenarios exercise default sibling grouping, tree-mode selection and restoration, direct addition, later registrations, independent parent Sessions, collapse restoration, search revelation, sibling sorting through descendant targets, parent-subtree moves, collapsed-current hints, and equal-width rows.
