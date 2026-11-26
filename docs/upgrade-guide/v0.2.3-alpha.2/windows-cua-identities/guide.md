---
kind: upgrade-guide
description: "Windows Computer Use shares application consent between selections that report a common AUMID or executable path, without changing application IDs."
---

# Windows application permissions

English | [中文](guide.zh.md)

## Change

Windows Computer Use retains its window AUMID, package process AUMID and executable-path rules for `cua.listApps()`, `cua.findApps()` and `cua.getApp()` IDs, and the `windows-aumid` authorization-key algorithm is unchanged. `getApp` additionally reports [permission attributes](../../../../packages/experimental/cua-windows/README.md#permission-attributes): AUMIDs, including Shell-resolved ones, and executable paths. A saved decision applies to any selection sharing one attribute value, so Feishu's Start menu entry, launcher and runtime share one grant through `com.electron.Feishu`.

Saved application records gain an optional `attributes` field. Grants saved separately for applications that now share an attribute appear as one entry after a selection connects them; revoking that entry removes access for all of them. Windows application approvals support **Always allow**; existing session grants remain session-scoped until the user explicitly chooses it. Shared consent does not change launch targets or window association. macOS identity rules are unchanged.

## Migration

1. Restart DSH with the updated Windows helper and all files from its build output. Restart every Host using the same profile.
2. Discover applications with `cua.listApps()` or `cua.findApps()` and pass the returned ID unchanged to `cua.getApp()`. Choose **Always allow** only if you want cross-conversation access.
3. Verify that selecting the same application, or its launcher, in a new conversation reuses that saved decision. Review entries on the Computer Use plugin page; revoke any connected entry you no longer want.
