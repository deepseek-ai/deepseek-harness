# Agent Note: Windows sandbox delete confinement: mandatory integrity plus an ambient-delete deny

Status: implemented

English | [中文](2026-09-19-windows-acl-mandatory-integrity-confinement.zh.md)

## Problem

The [restricted-token rung](2026-08-08-windows-acl-restricted-token-sandbox.md) confines writes by intersecting the requested access mask with restricting SIDs. That intersection covers only the access check against the object's OWN security descriptor: Windows also authorizes a write or a delete from the PARENT directory's `FILE_DELETE_CHILD` right, which no restricting SID has to co-sign. `cmd /c del` and `[System.IO.File]::Delete` — anything reaching `DeleteFileW` — therefore deleted files outside the workspace in BOTH confined modes (issue #4581), while plain writes from the same child were denied.

## Decision

Every grant now applies three edits in one `SetNamedSecurityInfoW` call, and the restricted token is lowered to match:

1. the capability-SID allow ACE (`GRANT_MASK`, `OI|CI`) — the write authority, unchanged;
2. a DENY ACE for the world SID on `FILE_DELETE_CHILD` with `CONTAINER_INHERIT_ACE` — the capability ACE's DELETE bit becomes the only delete authority inside a granted root;
3. a Low integrity mandatory label (`S-1-16-4096`, `SYSTEM_MANDATORY_LABEL_NO_WRITE_UP`, `OI|CI`) — and `SetTokenInformation(TokenIntegrityLevel)` lowers the confined token to the same level.

Each piece is load-bearing. The label is what reaches the parent-`FILE_DELETE_CHILD` route at all: the kernel evaluates the mandatory policy inside the access check whichever right supplied the authority, so a Medium object outside the granted roots is delete-proof as well as write-proof. The deny is what keeps one granted root out of ANOTHER's reach: every granted root carries the Low label, so the integrity check alone would still pass between them. The container-only inheritance on the deny is what keeps the ambient ACL usable: `0x40` is a member of `FILE_ALL_ACCESS`, so a file-level copy would refuse every `GENERIC_ALL`/`FullControl` open inside the root — measured against a real runner before the flag was narrowed.

The label is STANDING on workspace roots, like the capability ACE and for the same reason: revoking it per session would re-propagate the whole tree on every provision and would race with concurrent sessions. `revokeWrite` clears it only when no other capability grant remains on the directory, so two grants on one directory stay independently revocable. The idempotent skip requires the exact ACE, the exact deny, AND the exact label, so a root granted by an earlier build picks the deny up on its next provision.

## Alternatives considered

### Why not make the label revocable per session?

It removes the externality below, but pays the eager full-tree propagation on every provision (tens of seconds on large workspaces) that the deterministic per-workspace SID exists to avoid, and a concurrent session or a crashed one leaves the label oscillating.

### Why not Untrusted integrity for read-only mode?

Measured on this host: an Untrusted (`S-1-16-0`) token cannot start `pwsh` at all — DLL initialization fails (`0x8007045A`, `BCrypt.dll`) — so the read-only mode would have no usable shell.

### Why not deny `FILE_DELETE_CHILD` with `OI|CI`?

It also lands the deny on every FILE inside the granted root (observed through `icacls`: `Everyone:(I)(DENY)(DC)`), and `0x40` is part of `FILE_ALL_ACCESS`, so `CreateFileW(GENERIC_ALL)` on those files returns `ERROR_ACCESS_DENIED` for the user, Administrators, SYSTEM, and the DSH host alike. Narrowing the flag removes that class; a FullControl open of a DIRECTORY inside a granted root stays denied, which is the irreducible cost of denying a right that is a member of the full-access mask.

### Why not drop the confinement layer and document the escape?

The escape is the report: `cmd /c del` deleting outside the workspace is exactly what the sandbox promises not to allow, and no read-side or ACL-only change closes it — the restricting-SID intersection cannot reach the parent route by construction.

### Why not give each workspace its own integrity level?

Mandatory integrity control has five fixed levels (Untrusted, Low, Medium, High, System); they cannot be derived per workspace the way `S-1-4-x-y` capability SIDs are.

## Consequences

Bought: deletes confined through every authority Windows accepts AND confined to the granted root that owns them; the previously documented Everyone-write boundary closed; writes, reads, and process visibility otherwise unchanged; fail-closed errors on every Win32 call. Cost, all recorded in the package README: the standing Low label widens the workspace tree for ANY other process running at Low integrity as the same user and outlives DSH (the price of having a write boundary at all at this integrity level); a granted directory must now also grant `WRITE_OWNER` for its label (a Full-control workspace has it, a Modify-only one fails loudly); a FullControl open of a directory inside a granted root is denied; a tree another AppContainer tool has ACL'd with a package SID is unreadable to the Low child; FAT-class targets stay unverified. The [restricted-token rung note](2026-08-08-windows-acl-restricted-token-sandbox.md) remains the owner of the rung's token lists, runner contract, and grant lifecycle; this note owns only the delete route and the integrity layer that closes it.

## Testing

`runner.spec.ts` pins the behavior against a real runner and a real restricted token: the delete escape is denied in both modes through `cmd`, .NET, `Remove-Item`, and libuv while the file survives on disk; one session cannot delete inside another granted root; NUL stays writable in both modes; a `GENERIC_ALL` open of a file inside a granted root succeeds while the same open of a directory is denied; revoking one of two grants on a directory leaves the surviving grant usable. `acl.spec.ts` pins the real DACL/label lifecycle, that the deny inherits to containers only, and the shared-label revocation rule; `token-failure-paths.spec.ts` pins the exact `TokenIntegrityLevel` payload; the failure-path suites cover every new allocation and early exit, including the label ACL and descriptor releases.

## Related

- [Windows sandbox rung: raw ACL restricted tokens](2026-08-08-windows-acl-restricted-token-sandbox.md) — the rung this change extends (kept active; this note supersedes only its delete-route boundary).
- [Sandbox decision](2026-07-06-sandbox.md) — the platform chains and the `partial` enforcement vocabulary.
