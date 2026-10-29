---
kind: upgrade-guide
description: "Windows ACL callers use derived per-directory SIDs instead of supplying one shared write SID."
---

# Windows ACL directory identities

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-sandbox-windows-acl` replaces `workspaceWriteSid` with `directoryWriteSid`. `AclSandbox` derives a separate identity for each canonical writable directory: its constructor no longer accepts `writeSid`, and its `writeSid` property is replaced by the readonly `writeSids` array. The private temp SID remains separate. `writableDirs` is now readonly and contains canonical, deduplicated paths. Windows accepts valid additional writable directories, and `@deepseek-ai/dsh-sandbox` removes `SandboxUnsupportedPolicyError` and its `SANDBOX_UNSUPPORTED_POLICY` code. Users of the standard `dsh` profiles need no configuration changes.

## Migration

1. In direct `AclSandbox` callers, remove the `writeSid` option. Continue passing `writableDirs`, `mode`, and the explicit `tempDir`; retain `tempWriteSid` when temp writes are enabled. Read `writeSids` when inspecting the derived identities. Do not mutate `writableDirs`; construct a new instance for a different directory list. Compare its entries with canonical paths rather than the original input spellings.
2. Replace `workspaceWriteSid(path)` imports with `directoryWriteSid(path)` when materializing grants outside `AclSandbox`. Give each canonical directory only its own SID; do not grant one SID across several directories.
3. For caller-managed runner invocations, repeat `--write-sid` once per canonical directory, matching the deduplicated workspace-then-extra-root order, and retain `--temp-write-sid`. Agentless invocations omit both kinds of SID flag.
4. Remove imports and catches for `SandboxUnsupportedPolicyError` and checks for `SANDBOX_UNSUPPORTED_POLICY`; Windows supports valid extra directories instead of rejecting that policy.
5. Compile the caller and check on Windows that a new process can write its permitted directories and cannot write a directory omitted from its policy. Existing processes keep their launch permissions.
