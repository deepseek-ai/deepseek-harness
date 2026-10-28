---
kind: upgrade-guide
description: "Windows ACL callers use derived per-directory SIDs instead of supplying one shared write SID."
---

# Windows ACL directory identities

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-sandbox-windows-acl` replaces `workspaceWriteSid` with `directoryWriteSid`. `AclSandbox` derives a separate identity for each canonical writable directory: its constructor no longer accepts `writeSid`, and its `writeSid` property is replaced by the readonly `writeSids` array. The private temp SID remains separate. Users of the standard `dsh` profiles need no configuration changes.

## Migration

1. In direct `AclSandbox` callers, remove the `writeSid` option. Continue passing `writableDirs`, `mode`, and the explicit `tempDir`; retain `tempWriteSid` when temp writes are enabled. Read `writeSids` when inspecting the derived identities.
2. Replace `workspaceWriteSid(path)` imports with `directoryWriteSid(path)` when materializing grants outside `AclSandbox`. Give each canonical directory only its own SID; do not grant one SID across several directories.
3. For caller-managed runner invocations, repeat `--write-sid` once per canonical directory, matching the deduplicated workspace-then-extra-root order, and retain `--temp-write-sid`. Agentless invocations omit both kinds of SID flag.
4. Compile the caller and check on Windows that a new process can write its permitted directories and cannot write a directory omitted from its policy. Existing processes keep their launch permissions.
