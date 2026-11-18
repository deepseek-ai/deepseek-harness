---
kind: upgrade-guide
description: macOS CUA explicit key and mouse downs now remain held across program executions within a turn.
---
# macOS CUA input holds last for one turn

English | [中文](guide.zh.md)

## Change

macOS `sendKeyEvent('down')` holds a key across `run_code` and `cua_run_code` calls in the same turn. Returning or throwing from a program no longer releases it while the turn continues. Explicit `up` releases it immediately at the original recipient. Window-directed and system `toggleMouse('down')` join the same lifecycle. At turn completion, failure or user cancellation, cleanup releases all remaining keys and mouse buttons in reverse dispatch order and waits for native acknowledgement. Complete `pressKey`, `typeText`, `click` and `drag` operations keep their operation-local cleanup. Windows retains its current behavior.

## Migration

1. If a program requires release before it returns, send an explicit `up` in its `finally` block. Otherwise a later program in the same turn can release the held input.
2. Upgrade the macOS package and helper together. A custom `helperPath` must point to a rebuilt helper implementing the new private turn input protocol.
3. Verify a down in one program remains held until an up in a later program, or until the turn ends. If cleanup cannot be confirmed, CUA disables input for that task. Check the desktop before starting a new task.
