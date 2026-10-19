# Agent Note: Canonicalize each sandbox workspace once

Status: proposed

English | [中文](2026-10-18-single-workspace-canonicalization.zh.md)

## Problem

[`LocalSandboxProvider.confine()`](../../../../packages/sandbox/sandbox-local/src/index.ts) canonicalizes `workspaceRoot` and copies the policy before dispatch. POSIX profile builders call [`workspaceWritableRoots()`](../../../../packages/sandbox/sandbox/src/roots.ts), which resolves that workspace again. The common preprocessing also runs for POSIX read-only policies that grant no workspace writes.

## Proposal

Remove the common policy copy. Keep canonicalization in shared POSIX root derivation; canonicalize once inside `windowsAclRunnerArgv()`, reusing that value for argv, SID derivation, and ACL grants. Preserve per-call extra-root validation and each backend's temporary-directory rules.

## Alternatives considered

**Keep common preprocessing.** It supplies every backend with one physical workspace identity, but POSIX repeats the filesystem work. Explicit Windows normalization preserves the [Windows ACL decision](../../implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.md).

## Acceptance criteria

Direct profile builders and `runnerCommand` retain canonical roots. Windows argv, SID, and grant keys agree. Existing alias-rejection and read-only checks pass; a focused trace confirms removal of the duplicate workspace lookup.

## Risks

Incomplete relocation can split Windows grant identity. Do not cache extra roots: enforcement must recheck a directory replaced by a symlink.
