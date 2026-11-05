# Agent Note: Windows additional directory grants stay in file tools

Status: implemented

English | [中文](2026-10-29-windows-file-tool-directory-grants.zh.md)

## Problem

Memory plugins need session-specific writes to directories such as `~/.dsh/memory`. Extending Windows process access through ACLs requires managing persistent filesystem grants and token identities for changing directory combinations, increasing reliance on a backend with existing enforcement limitations.

## Decision

On Windows, the [session directory effects](2026-10-26-session-writable-directory-effects.md) authorize extra directories only through the harness filesystem checks used by `write` and `edit`. The process provider ignores extra roots and retains its workspace and private-temp permissions. The ACL package, runner arguments, and workspace SID remain unchanged. POSIX process backends continue to honor extra roots.

Windows process support for extra roots is deferred until a better sandbox backend can enforce it without extending the ACL customization. Model context explicitly distinguishes file-tool grants from Windows process permissions.

## Alternatives considered

**One SID per directory or directory set.** These designs could select process authority for each execution, but require more ACL mutation, identity management, and lifecycle handling. The capability does not justify expanding this mechanism.

**Reject processes whenever extra grants exist.** This prevents unrelated PowerShell and workspace operations from running when a memory plugin registers a directory, even if the command never accesses it.

## Consequences

A Windows memory plugin can use `write` and `edit` for its registered directory while ordinary workspace commands continue to work. A shell command or PTC program cannot use that extra grant. This deliberately accepts different capabilities across file tools and process tools; registration and disposal remain session-scoped, and existing processes retain their launch-time permissions.
