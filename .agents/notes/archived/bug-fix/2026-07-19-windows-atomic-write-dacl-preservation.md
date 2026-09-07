# Agent Note: Preserve Windows DACLs during atomic file replacement

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-19-windows-atomic-write-dacl-preservation.zh.md)

## Problem

Atomic writes protect POSIX staging directories with `0o700` and temp files with `0o600`, but Windows mode bits expose only a synthetic read-only view of the actual DACL. Creating staging under the target's parent and relying on inheritance is sufficient for a new file, but not for replacing an existing file whose explicit or protected DACL is narrower than its parent: content is written under the broader parent DACL, and rename carries that staging descriptor onto the replacement.

## Decision

`dsh-fs-local` reads an existing target's DACL with `GetFileSecurityW`, applies it to the empty temp file with inheritance protected before writing content, and publishes the closed temp with `ReplaceFileW`. The protected staging descriptor prevents the temp directory's inherited entries from broadening access; `ReplaceFileW` preserves the original target access policy and other replacement metadata. Its ACL merge may reserialize auto-inheritance state or duplicate equivalent ACEs, so self-relative descriptor buffers are not a stable equality contract. New Windows files have no prior descriptor to preserve and continue to inherit the destination directory's DACL; their staging directory therefore lives beside the target. POSIX keeps the owner-only staging modes and preserves an existing target mode.

Native Windows coverage protects a target DACL, inspects the written staging file, and compares the final replacement's ordered, de-duplicated ACE policy. Host-independent binding tests cover Win32 error translation and every native call boundary. Mode-bit assertions remain POSIX-only; new-file DACL inheritance is an operating-system contract rather than a machine-specific account allowlist.

## Alternatives considered

**Rely on directory inheritance for replacements.** Rejected because a target may carry a narrower explicit or protected DACL than its parent, so inheritance neither protects staged content nor preserves the target access policy.

**Use `ReplaceFileW` without protecting the temp.** Rejected because it repairs the final descriptor only after the content has already been written under the staging file's inherited DACL.

**Install an owner-only DACL for every write.** Rejected because it would discard deliberate project sharing. Copying the target DACL preserves the deployment's existing access policy instead of inventing one.

**Assert inherited accounts with `Get-Acl` or `icacls`.** Rejected because such a test verifies machine policy rather than package behavior, and localized well-known account names make the output unstable across hosts.

**Skip the existing `chmod` calls on Windows.** Rejected because Node maps these writable modes to benign no-ops; platform guards add branches without changing DACL behavior.

## Consequences

Replacing a Windows file now requires permission to read the target DACL and set the temp DACL; failure is loud before content is written. The package carries Koffi for the narrow Win32 calls, loaded only on Windows replacement paths. A new Windows file inherits broad directory access when the directory is broad by design, while POSIX temp content stays owner-only; a read-only Windows target still fails publication before synthetic mode replay could matter.
