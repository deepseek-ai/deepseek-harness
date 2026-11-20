---
kind: upgrade-guide
description: Explicit CUA input on macOS and Windows persists across programs and turns, with system reminders after successful programs.
---
# CUA reports held input after programs

English | [中文](guide.zh.md)

## Change

On macOS and Windows, explicit `sendKeyEvent('down')` and `toggleMouse('down')` remain held across programs and turns until an explicit `up`. Normal completion does not release them. After a successful `run_code` or `cua_run_code`, a system reminder lists any remaining keys and mouse buttons, their application or window and actual input mode. Program failure, user stop, environment reset and disposal request release in reverse dispatch order. On disconnect the helper attempts a final release. Windows silently discards the disconnected owner’s records if that attempt fails or times out. Complete `pressKey`, `typeText`, `click` and `drag` actions keep their operation-local cleanup. DSH and MCP both preserve input after successful programs. A client pause between completed MCP calls is not observable by the server and can leave input held. On Windows, cleanup sends an up for each input the helper still holds. If you also hold the same key or button, that up may interrupt your press. A focus change sends the up to the desktop without reactivating the original window.

## Migration

1. Pair explicit downs with ups when input should stop. Read the reminder before continuing; no reminder is added when no input remains held.
2. Upgrade the platform package and helper together. A custom `helperPath` must accept `getHeldInputs({})` and `releaseHeldInputs({})` on the same connection that dispatched the input.
3. Verify that one successful program can hold a key, receive its reminder, and release it in a later program. When a program fails or is cancelled during execution, it waits for cleanup. If the program succeeds but a post-execute policy rejects the output, the tool returns the policy error and CUA finishes cleanup independently. If the model is thinking when DSH stops or fails, the Agent can finish before native release is confirmed. Subsequent CUA calls wait for the outcome. If cleanup cannot be confirmed, CUA disables further operations for that task; inspect the desktop manually before starting another task.
