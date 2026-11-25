---
kind: upgrade-guide
description: "Windows Computer Use resolves additional desktop AUMIDs, so saved executable-path selectors may now identify an application shared across copies."
---

# Windows application permissions

English | [中文](guide.zh.md)

## Change

Windows Computer Use supplements explicit window and package AUMIDs with Windows Shell application resolution. Desktop windows previously identified by an executable path can now share the Start menu application's AUMID, including launcher-based installations. Versions and copies with the same AUMID share consent regardless of location or signature, like macOS applications with the same bundle identifier. Applications without an AUMID still use their canonical executable path.

Existing AUMID authorization keys remain unchanged. A grant saved under an executable-path identity does not automatically authorize a newly resolved AUMID. Session grants remain session-scoped. Display names and icons do not determine permission scope.

## Migration

1. Restart DSH with the updated Windows helper and all files from its build output. Restart every Host using the same profile.
2. Discover applications with `cua.listApps()` or `cua.findApps()` and pass the returned ID unchanged to `cua.getApp()`. If an application now resolves to an AUMID, confirm its approval request and choose **Always allow** only if you want cross-conversation access.
3. Verify that selecting the same application in a new conversation reuses that saved decision. Remove obsolete entries on the Computer Use plugin page; revoking the current application entry removes access for all copies sharing its ID.
