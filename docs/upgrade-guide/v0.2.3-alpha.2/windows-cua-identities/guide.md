---
kind: upgrade-guide
description: "Windows Computer Use maps listed launcher and runtime paths to one application ID, changing the authorization key for matching paths."
---

# Windows application permissions

English | [中文](guide.zh.md)

## Change

Windows Computer Use retains its window AUMID, package process AUMID and executable-path fallback rules. The [known application aliases](../../../../packages/experimental/cua-windows/README.md#known-application-aliases) map specific Feishu and GitHub Desktop launcher and runtime paths to the application's Start menu ID. Matching path selections and windows without an AUMID share that ID across listed versions and installations. Other executable paths remain separate; explicit path selection does not look up an AUMID.

The `windows-aumid` authorization-key algorithm is unchanged. A grant saved under a matching executable-path identity does not automatically migrate to the shared application ID. Windows application approvals support **Always allow**; existing session grants remain session-scoped until the user explicitly chooses it. Display names and icons do not determine permission scope. macOS identity rules are unchanged.

## Migration

1. Restart DSH with the updated Windows helper and all files from its build output. Restart every Host using the same profile.
2. Discover applications with `cua.listApps()` or `cua.findApps()` and pass the returned ID unchanged to `cua.getApp()`. If a path now matches a listed alias, confirm its new approval request and choose **Always allow** only if you want cross-conversation access.
3. Verify that selecting the same application in a new conversation reuses that saved decision. Remove obsolete entries on the Computer Use plugin page; revoking the current application entry removes access for all copies sharing its ID.
