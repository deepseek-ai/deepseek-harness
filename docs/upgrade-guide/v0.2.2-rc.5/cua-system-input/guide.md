---
kind: upgrade-guide
description: "CUA system input replaces the system-pointer option and approval setting."
---

# CUA system input

English | [中文](guide.zh.md)

## Change

CUA replaces `useSystemPointer` with `useSystemInput`, the `systemPointer` capability with `systemInput`, and `requireSystemPointerApproval` with `requireSystemInputApproval`. macOS supports the option on `mouseMove`, `toggleMouse`, `click`, `drag`, `pressKey`, and `sendKeyEvent`. Explicit system clicks and drags send keyboard modifier down and up events as well as mouse events. Omitted or false retains the default input route. Windows does not expose this capability yet.

System-input approval now covers keyboard and mouse operations. Errors use `SYSTEM_INPUT_*` and `SYSTEM_INPUT_APPROVAL_*` instead of `MOUSE_CONTROL_*` and `MOUSE_APPROVAL_*`.

## Migration

1. Replace `useSystemPointer` with `useSystemInput` in CUA programs and raw requests. Keep matching options on directional down and up calls. Pass keyboard options as the third argument of `pressKey(key, modifiers, options)` or `sendKeyEvent(key, direction, options)`.
2. Rename `requireSystemPointerApproval` in profile or home patches to `requireSystemInputApproval`, and update capability checks to `systemInput`. Update error-code handling to the new prefixes.
3. Rebuild or upgrade the macOS helper with the Host. Confirm `cua.getCapabilities().systemInput` before selecting system input, activate and observe the target, then verify a modified click or keystroke and inspect its result. `typeText`, `paste`, `scroll`, and AX methods do not accept this option.
