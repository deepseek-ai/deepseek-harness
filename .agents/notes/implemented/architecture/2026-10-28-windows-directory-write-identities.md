# Agent Note: Windows per-directory write identities

Status: implemented

English | [中文](2026-10-28-windows-directory-write-identities.zh.md)

## Problem

[Session-scoped writable roots](2026-10-26-session-writable-directory-effects.md) let independent plugins add directories to an execution's policy. A SID derived from the complete directory set requires additional standing ACEs and tree propagation on unchanged directories whenever that combination changes.

## Decision

Each canonical writable directory has one deterministic SID, granted only to that directory. Each new execution carries the SIDs for all its permitted directories. The provider caches grants by directory and rechecks their ACEs before execution so directory recreation does not invalidate the cache. Shared directories reuse the same standing grant across Sessions and permission combinations; a Session without the directory's SID receives no authority from that grant.

`AclSandbox` derives identities from canonical, deduplicated paths instead of accepting a caller-selected SID for an arbitrary list. Every parsed SID has an allocation owner, including partial initialization failures. Private temp capabilities remain separate per live Session/workspace pair; the token default DACL still prefers the private temp SID. Running processes retain their launch tokens when later executions change their permitted roots.

Directory grants compare supplied and physical paths with Node’s host-specific `path.relative`, while SID derivation retains the physical spelling. This accepts ordinary Windows casing differences without adding a component-walking implementation. The comparison assumes case-insensitive Windows paths; legacy 8.3 aliases remain unsupported. This deliberately favors the common path syntax over exhaustive filesystem-identity handling.

## Alternatives considered

**One SID per complete directory set.** Sorted, deduplicated JSON encoding gives an unambiguous identity and separates differently authorized executions. It also adds another ACE to every unchanged directory for each new combination and repeats tree propagation. Per-directory identities provide the same future-execution semantics with independent reuse.

**One workspace SID extended to extra directories.** This accumulates authority for processes that already hold the workspace SID and for other Sessions using that workspace. Adding a directory must select another existing directory capability, not expand a shared capability's meaning.

## Consequences

Existing workspace-only SID values remain stable. Standing directory ACL edits outlive executions, while token membership controls new execution authority. Native Windows regressions cover multiple directory capabilities, omitted-directory denial, separate temp grants, and one explicit SID grant per directory; portable tests cover token contents, allocation cleanup, cache reuse, and failed grant retries. The [Windows ACL decision](../feature/2026-08-08-windows-acl-restricted-token-sandbox.md) retains the restricted-token mechanism and hard-link limitations; this decision replaces its single-workspace identity model.
