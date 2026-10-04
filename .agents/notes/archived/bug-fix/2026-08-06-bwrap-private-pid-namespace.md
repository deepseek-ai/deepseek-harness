# Agent Note: isolate bwrap from the host PID namespace

Status: implemented
Archived: 2026-09-30

English | [中文](2026-08-06-bwrap-private-pid-namespace.zh.md)

## Problem

The bwrap backend mounted a fresh `/proc` while retaining the host PID namespace. A confined command could therefore see host processes and follow procfs magic links such as `/proc/<pid>/root`, `/proc/<pid>/fd`, or `/proc/<pid>/cwd` into a host process's mount view. When access controls allowed following one of those links, the path escaped the profile's read-only host-root bind and `workspace-write` allow-list. Host ptrace restrictions sometimes blocked the path, but those deployment-dependent permissions were not a confinement boundary.

The original [sandbox decision](../feature/2026-07-06-sandbox.md) deliberately left process visibility unchanged because `SandboxMode` promises file effects rather than general process isolation. Procfs magic links make host process visibility part of the file-effect boundary for bwrap, so that choice cannot preserve the promised modes.

## Decision

Every bwrap profile uses `--unshare-pid` and mounts `/proc` for that private namespace. The confined command can observe and control its descendants, while host processes and their procfs magic links are absent. Bubblewrap supplies the namespace's PID 1 process to reap descendants.

The functional bwrap probe uses the same profile builder as real wraps. A host that cannot create the PID namespace therefore rejects bwrap during selection and falls back to Landlock instead of accepting a weaker probe and failing later.

This is a bwrap backend invariant, not a new `SandboxMode` promise. Landlock and Seatbelt continue to leave process visibility unchanged, and no backend restricts network access.

## Alternatives considered

- **Mask selected procfs links while retaining host process visibility.** Per-process entries are dynamic, and covering only `root` would leave equivalent crossings through `fd`, `cwd`, `exe`, and future magic links. A blocklist cannot establish the boundary.
- **Rely on ptrace and procfs ownership checks.** Their behavior depends on kernel settings, container configuration, process credentials, and dumpability. Same-user processes can be reachable, so these checks are defense in depth rather than the profile's authority.
- **Remove `/proc` entirely.** Ordinary process tooling and descendant management expect procfs. A private PID namespace with matching procfs preserves those mechanics without exposing host processes.

## Verification

Profile unit tests pin PID unsharing in both confined modes. Real-bwrap tests verify that both modes report a PID-namespace identity different from the harness's, reject a write through `/proc/1/root`, leave the host target absent, and still allow the command to observe, terminate, and wait for its own descendant.

## Consequences

- bwrap-confined commands no longer inspect or signal host processes, including same-user processes.
- `read-only` and `workspace-write` no longer depend on host procfs access policy to prevent mount-profile escapes.
- Hosts without usable PID namespaces select the next supported Linux backend through the existing fail-closed ladder.
- The changed guarantee is kernel confinement rather than model-visible output, protocol, or transcript text, so the real-backend e2e is the assembled acceptance path and no snapshot changes.
