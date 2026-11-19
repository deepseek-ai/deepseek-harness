---
kind: upgrade-guide
description: Explicit macOS CUA input persists across programs and turns, with system reminders after successful programs.
---
# CUA reports held input after programs

English | [中文](guide.zh.md)

## Change

macOS explicit `sendKeyEvent('down')` and `toggleMouse('down')` remain held across programs and turns until an explicit `up`. Normal completion does not release them. After a successful `run_code` or `cua_run_code`, a system reminder lists any remaining keys and mouse buttons, their application or window and actual input mode. Program failure, user stop, connection closure, environment reset and disposal release owned input in reverse dispatch order. Complete `pressKey`, `typeText`, `click` and `drag` actions keep their operation-local cleanup. DSH and MCP use the same behavior. Windows reporting and unified cleanup remain unimplemented.

## Migration

1. Pair explicit downs with ups when input should stop. Read the reminder before continuing; no reminder is added when no input remains held.
2. Upgrade the macOS package and helper together. A custom `helperPath` must implement the task-owned `getHeldInputs` and `releaseHeldInputs` private operations.
3. Verify that one successful program can hold a key, receive its reminder, and release it in a later program. Program failure and cancellation must release it before they finish. If cleanup cannot be confirmed, CUA disables further operations for that task; inspect the desktop manually before starting another task.
