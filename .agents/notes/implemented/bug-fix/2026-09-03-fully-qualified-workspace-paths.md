# Agent Note: Fully qualified Workspace paths

Status: implemented

English | [中文](2026-09-03-fully-qualified-workspace-paths.zh.md)

## Problem

Workspace path identity must name one directory independently of process state. POSIX relative paths, Windows drive-relative paths such as `C:work`, and Windows root-relative paths such as `\\work` can resolve against the Host cwd or the current directory retained for a drive. Passing those spellings to `realpath` can therefore register a different directory when host state changes. Filesystem roots also have an empty basename, which can create an empty default Workspace title.

Windows drive roots need separate handling in browser-safe relative-path joins. Removing the trailing separator from `C:\\` produces `C:`, which changes an absolute path into a drive-relative path.

## Decision

`WorkspaceRegistry.create()` and `resolveByPath()` reject paths that are not fully qualified before calling `realpath`. POSIX requires an absolute path. Windows requires `win32.isAbsolute(path)` plus a parsed root that is neither `\\` nor `/`; this accepts drive-qualified and UNC paths while rejecting current-drive-root and drive-relative spellings without maintaining a second path grammar.

Canonical paths remain the registry identity. A default title uses the final path segment, or `node:path`'s parsed root when that segment is empty. This refines the display rule owned by [same-basename Workspace adoption](2026-07-31-same-basename-workspace-adoption.md) without making titles unique.

The browser-safe `resolveWorkspacePath()` removes trailing separators only after choosing the separator from the Workspace spelling. Backslash drive and UNC paths keep `\\`; forward-slash drive paths keep `/`; joining a drive root always retains the separator after the colon.

## Alternatives considered

**Resolve relative paths against the Host cwd.** Rejected because Workspace identity would depend on process state that callers do not supply and remote clients cannot observe.

**Resolve relative paths against another stored Workspace.** Rejected because create and lookup requests do not identify such an anchor, and guessing one would make the same path spelling address different records.

**Maintain a regular expression for drive and UNC syntax.** Rejected because `node:path.win32` already parses roots and absolute paths; a second grammar can diverge on separator variants and UNC roots.

**Use an empty title for filesystem roots.** Rejected because the title is the primary Workspace label. The root spelling is short, stable, and already distinguishes drive and UNC roots.

## Consequences

Callers must submit fully qualified Workspace paths. Invalid path spellings fail before filesystem access, while nonexistent fully qualified paths still return the original filesystem error. Windows drive and UNC roots remain valid identities and have non-empty default titles; an UNC share root uses the share name as its final segment.

Workspace-relative joins preserve the separator style already present in the Workspace root. Unit tests cover POSIX roots, drive roots, UNC roots, rejected drive-relative and current-drive-root paths, and both Windows separator styles.
