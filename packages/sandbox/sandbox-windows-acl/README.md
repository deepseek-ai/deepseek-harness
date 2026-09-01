---
description: "The Windows write-restriction sandbox backend for users and maintainers choosing, configuring, or debugging restricted-token process confinement on Windows."
kind: "package-library"
---

# @deepseek-ai/dsh-sandbox-windows-acl

English | [中文](README.zh.md)

## Summary

`dsh-sandbox-windows-acl` confines Windows processes by write restriction: a child runs under a restricted token whose write access is limited to the workspace and a private temp directory, so `workspace-write` allows those writes and `read-only` allows none. It ships as the win32 rung of `dsh-sandbox-local`: mounting the local provider on Windows gives every confined bash or pwsh call this backend automatically. It can also be embedded directly through the `AclSandbox` API to spawn confined children with captured stdio. Every Win32 call is checked and failures throw, so a child is never spawned unrestricted. Enforcement is partial by design — the restricted token must retain Everyone for process initialization, and NTFS hard links can alias one file object across paths — so the backend reports `partial` and callers that need the absolute boundary can surface it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

On Windows, mounting the local sandbox provider makes this backend the runner behind `ctx.sandbox` — no extra configuration. Embed the `AclSandbox` API directly when you spawn confined children outside the harness.

### When to choose it

Choose it for Windows compositions that confine subprocess file effects under `read-only` or `workspace-write`. Choose a different mechanism when the child must also be read-confined or network-restricted: `WRITE_RESTRICTED` intersects write accesses only, so pair this backend with a read-side policy or an AppContainer capability token for stronger confinement.

### Direct API

`AclSandbox` spawns a confined child with captured stdio (or inherited stdio for runner-style use). It requires an explicit private temp directory, or `tempDir: null` to disable temp writes — the ambient temp root is never an implicit grant.

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AclSandbox, tempWriteSid, workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl'

const workspaceRoot = process.cwd()
const tempDir = mkdtempSync(join(tmpdir(), 'dsh-'))

// mode selects the token's restricting-SID list (see Modes below) and must
// match the grant shape. workspace-write requires distinct workspace and
// private-temp identities; pass tempDir: null to disable temp writes.
const sandbox = new AclSandbox({
  writableDirs: [workspaceRoot],
  tempDir,
  writeSid: workspaceWriteSid(workspaceRoot),
  tempWriteSid: tempWriteSid(tempDir),
  mode: 'workspace-write',
})
await sandbox.init() // throws on ANY Win32 failure — never spawns unrestricted

const child = sandbox.spawn({ command: 'pwsh', args: ['-NoProfile', '-Command', '...'], cwd: workspaceRoot })
const { stdout, stderr, exitCode } = await child.wait()

sandbox.dispose() // revokes the revocable (temp) grant, keeps the standing workspace ACE; reports every cleanup failure
rmSync(tempDir, { recursive: true, force: true })
```

The workspace ACEs are granted standing — `dispose()` leaves them, because they are the cross-instance reuse cache — while the distinct temp SID is granted revocably. The server-side counterpart is the `AclWriteGrant` class: `add(path, standing)` per directory, and `dispose()` revokes the revocable paths and frees the SID.

### What confinement gives you

Under `workspace-write`, the child may write into the workspace and its private temp directory; other ACL-addressable writes are denied except the documented Everyone and hard-link boundaries. Under `read-only`, no explicit write grants exist, so writes are denied with the same documented ambient boundaries.

Temp isolation is per live session/workspace pair: sessions sharing a workspace share its write authority but cannot write one another's temp directories. A fresh provider always chooses a new temp path and SID, so crash residue cannot block or authorize a resumed session.

### Failures and recovery

`init()` throws on any Win32 failure — the child is never spawned unrestricted. A runner that fails before executing the command prints `windows-acl-run: <detail>` to stderr and exits 127, which the seam's runner-failure rules classify as a broken sandbox rather than a denial. Cleanup is best-effort by design: `dispose()` attempts every temp revocation and aggregates failures into an `AggregateError`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the restricted-token mechanism, the token lists, the runner contract, and the verified boundaries; the observable behavior is fully covered in [Use this package](#use-this-package).

### Mechanism

The caller's token is duplicated into a `WRITE_RESTRICTED` token whose restricting SIDs carry separate workspace and private-temp capabilities. Windows performs the access check twice — once against the normal SIDs, once against the restricting SIDs — and grants write-class access only where both checks pass. The workspace SID is derived deterministically from the canonical workspace path (`workspaceWriteSid`), so the workspace-root ACE materializes once per workspace per machine and every later session, call, or restart hits the exact-ACE skip. Each live session/workspace pair instead receives a random private temp directory and a SID derived from that path (`tempWriteSid`), so sessions share the intended workspace authority without inheriting one another's temp authority. Every policy-specific Win32 call and every process primitive from [`dsh-win32-process`](../../subprocess/win32-process/README.md) is checked; failures throw `Win32Error` carrying the API name, exact code, system text, and failing context — fail-closed by construction.

### Modes and token lists

`workspace-write` (logon SID, Everyone, workspace SID, temp SID) grants the workspace and the session's private temp subdirectory separate Write grants; `read-only` (logon SID, Everyone — no write SID) grants none. The keep-alive group (logon SID + Everyone) is present in both modes: without it, early DLL initialization dies with `0xC0000142` and CNG crashes pwsh with `0xE0434352`. The write SID stays out of the read-only list on purpose: the standing workspace grant from an earlier workspace-write period remains inert because the write-restricted pass-2 check grants only what the restricting list carries, while the standing ACE keeps a re-upgrade free of re-propagation.

NUL writes are ambient, not granted: the device DACL grants Everyone read+write+execute (`0x1201BF`), so openers whose mask fits it (cmd `> NUL`, node `\\.\NUL`) can write it in both modes. `Set-Content NUL` fails in both modes (a PowerShell/.NET-layer effect, not the device DACL), while PowerShell's `> $null` redirection keeps working.

Authenticated Users is absent from both lists — the WMI namespace security check fails (`0x80041003`), so CIM cmdlets and `Get-ComputerInfo` are unavailable in every confined mode, and the C:\-root tree-creation escape is closed. INTERACTIVE/LOCAL are absent too: the host's Public tree grants write to INTERACTIVE, so Public writes are denied.

### The confinement runner

The seam-facing shape is the runner entry (`./runner`): an argv-prefix wrapper `dsh-sandbox-local` spawns in place of the caller's command, with the same architecture as bwrap/landlock-run/sandbox-exec. The runner creates the restricted token, spawns the wrapped argv under it with the caller's stdio passed straight through, wraps the child in a `KILL_ON_JOB_CLOSE` job, mirrors the child's exit code, and revokes its self-managed temp grant on exit. Every runner-side failure prints `windows-acl-run: <detail>` to stderr and exits 127 — the seam's runner-failure rules match that signature.

```sh
node runner.js --workspace <dir> --temp <dir> --mode <read-only|workspace-write> [--write-sid <S-1-4-…> --temp-write-sid <S-1-4-…>] -- <argv...>
```

The seam materializes the deterministic workspace SID's ACE standing (once per workspace per server lifetime — the reuse cache), then creates a random private temp directory and a distinct revocable SID for each live session/workspace pair, passing both as the required `--write-sid`/`--temp-write-sid` pair; the runner verifies each against its owning path and neither grants nor revokes (`manageDacls: false`). A fork receives a different temp capability, and a fresh provider gives even the same resumed session a new path and SID, so crash residue is inert litter. Without the pair, `--temp` names a root: an agentless workspace-write runner creates a random private child, self-manages its temp SID, rewrites TMP/TEMP, and removes the child on exit. Re-granting the standing workspace ACE after a restart is idempotent: `grantWrite` reads the current DACL and skips the re-propagation when the exact ACE already stands. A workspace equal to or containing the temp root is rejected before any grant.

### Verified boundaries

- **Everyone grants remain ambient write authority** — Everyone must stay in both restricting lists (removing it breaks early DLL initialization and CNG); an external NTFS object whose DACL grants Everyone a requested write right clears both checks and stays writable under both modes.
- **Hard links are file-object aliases, not path aliases** — an inheritable workspace ACE propagated onto an existing hard link changes the one underlying file security descriptor, so the same object is writable through an external alias; rejecting multiply-linked files is not viable for ordinary pnpm installations.
- **Writes are restricted; reads, network, and process visibility are not** — `WRITE_RESTRICTED` intersects write accesses only, so a confined child can read any caller-readable file and open sockets; `read-only` therefore needs a read-side policy to be expressed.
- **Console isolation is unavailable** — children created with `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` die during DLL initialization with `STATUS_DLL_INIT_FAILED` (`0xC0000142`); children share the host console, and pipe-based stdio redirection is unaffected.
- **ACL grants are standing directory mutations** — workspace ACEs stand by design (the reuse cache, never revoked); temp ACEs are revoked by `dispose()`; manual `icacls` cleanup cannot revoke them on this platform (`ERROR_NONE_MAPPED`, 1332), so revoke through this module.
- **Granted directories must be caller-owned** — the owner's implicit `WRITE_DAC` is what lets the sandbox edit the DACL without elevation.
- **The ambient temp root is never granted implicitly** — direct callers must supply an existing private `tempDir` plus its distinct `tempWriteSid`, or disable temp writes with `tempDir: null`; the actual temp directory must be disjoint from every writable root.
- **The confined child's temp capability is private per live session/workspace pair** — the runner rewrites TMP/TEMP to that private directory before the spawn; two tokens sharing the same workspace SID cannot write one another's temp directories.
- **`whoami` and token-inspection cmdlets fail under the restricted token** — `GetTokenInformation` on the duplicate is partially unavailable to the child, which is diagnostic noise rather than an operational failure.

### Header verification and source map

The sandbox-owned SID, ACL, token, file, and lock declarations are checked against Windows headers by [`verify/abi-probe.cpp`](verify/abi-probe.cpp). The shared process, stdio, and Job ABI is owned and verified by [`@deepseek-ai/dsh-win32-process`](../../subprocess/win32-process/README.md#header-verification).

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `AclSandbox`: restricted-token policy, DACL grants, fail-closed spawn and dispose |
| [`src/runner.ts`](src/runner.ts) | The runner entry over shared Win32 process primitives |
| [`src/grant.ts`](src/grant.ts) | `AclWriteGrant`: server-side grant materialization and revocation |
| [`src/token.ts`](src/token.ts) + [`src/acl.ts`](src/acl.ts) | Win32 token and DACL primitives behind the sandbox |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Start with the subsystem reference for the shared vocabulary, then the provider that mounts this rung, its consumers, and the design decision.

- [Process sandbox subsystem](../../../docs/subsystems/sandbox.md) — modes, per-call policy, and enforcement semantics.
- [Local sandbox backends](../sandbox-local/README.md) — the provider that mounts this backend as the win32 rung.
- [Sandbox seam package](../sandbox/README.md) — the service contract this backend implements.
- [Win32 process library](../../subprocess/win32-process/README.md) — shared restricted-process, stdio, Job, wait, and handle-cleanup primitives.
- [Bash sandbox executor](../../shell/bash-sandbox/README.md) and [pwsh sandbox executor](../../shell/pwsh-sandbox/README.md) — the confined executors that consume it.
- [Windows ACL restricted-token sandbox decision](../../../.agents/notes/implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.md) — why raw ACL restricted tokens over mxc and AppContainer.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through [`dsh-bash-sandbox`](../../shell/bash-sandbox/README.md), [`dsh-pwsh-sandbox`](../../shell/pwsh-sandbox/README.md), and their tools, which render this backend's partial-enforcement and denial facts (the confined stderr the tool layer classifies through `denialSignatures`) while the [`dsh-sandbox`](../sandbox/README.md) seam owns the `SANDBOX_UNAVAILABLE` text and `sandbox-local` owns runner selection.

#### KV Cache effect

None directly; the denial surface belongs to the tool layer.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the backend is a poor fit or needs special operational care. They are current package constraints, not a general Windows comparison or a task backlog.

- **One write allowlist per workspace** — the write SID is the unit of the allowlist and IS the workspace identity; reusing one sandbox instance across two workspaces widens both grants to both roots. Create one instance per workspace root — the seam does exactly this, keyed by the workspace path.
- **Cleanup is best-effort by design** — `dispose()` attempts every temp revocation and aggregates failures into an `AggregateError`; a cleanup failure can leave the random directory and its temp-SID-only ACE behind. Once the process exits no future token carries that SID, so the residue is inert until OS temp hygiene or manual removal reclaims it.
- **Standing workspace ACEs are invisible residue** — renaming a workspace derives a new SID; the old ACEs on the old path stay (inert, write-SID-only), and a future cleanup command may reap them.
- **NULL-DACL directories are not identity-preserving under grant+revoke** — a directory with a NULL DACL means "everyone full control"; `grantWrite` builds the new ACL from that null, and the revoke round-trip leaves an empty (deny-all) DACL rather than the original NULL DACL. Real workspace and temp directories carry real DACLs, so this stays a documented edge.
- **Piped stdio capture is impossible for confined grandchildren** — libuv's pipe stdio uses named pipes, whose client-end open requests write access no restricting SID is granted (the Win32 layer's default SD template, not the token default DACL), so `spawn(..., { stdio: 'pipe' })` inside a confined process fails with EPERM; inherited and ignored stdio spawns work, and anonymous pipes (PowerShell pipelines) work because the restricted token's default DACL carries a full-access restricting-SID ACE.
- **Grant materialization is an eager full-tree propagation** — `SetNamedSecurityInfoW` on a directory with inheritable ACEs walks every descendant immediately (tens of seconds on large workspace trees); the per-workspace identity pays it once per workspace per machine, and the exact-ACE skip makes every later provision cheap.
- **Read-side confinement and network policy are out of scope** — `WRITE_RESTRICTED` intersects write accesses only; pair this backend with a read-side policy for stronger confinement.
- **Wide-directory and FAT-volume warnings are deferred; FAT-class targets stay writable** — the UI-side warnings are not implemented, a FAT volume as a grant root fails loudly, and a FAT-class target outside the granted roots has no security descriptors so it stays writable under both confined modes; FAT is treated as legacy residue.
- **PowerShell language mode differs by confined mode** — under `read-only`, PowerShell cannot create its AppLocker probe files in temp and conservatively starts in ConstrainedLanguage (`Add-Type`, non-core .NET static calls, COM, and reflection fail); the shipped `workspace-write` path lets the probe complete, so pwsh stays in FullLanguage unless host-wide WDAC/AppLocker policy says otherwise, while a direct `AclSandbox` with `tempDir: null` has no such guarantee. This split is PowerShell startup behavior, not part of the ACL write boundary.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: undecided directions and open questions. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: warnings and cleanup surfaces

The warn-only posture for unusually wide directories and FAT-class volumes is documented in the limitations above but not implemented, and a cleanup command that reaps standing workspace ACEs from renamed workspaces is undecided. Both are open directions, not shipped behavior.

</details>

**Runtime invariant:** No companion is published. This package exposes no independent event sequence or mutable data relation beyond the fail-closed contracts it enforces at each Win32 call boundary.
