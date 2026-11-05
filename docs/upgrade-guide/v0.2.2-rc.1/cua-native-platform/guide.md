---
kind: upgrade-guide
description: "Custom native CUA helpers must tag permission responses with their platform, and provider integrations must remove CuaBackend.description."
---

# Native CUA platform interfaces

English | [中文](guide.zh.md)

## Change

Native CUA `permissionStatus` and `requestPermission` responses require a `platform` discriminator. macOS responses use `darwin` and retain their permission and process fields. Windows responses use `win32` with `sessionLocked`, `captureAvailable`, `elevated` and `helper`. Untagged responses from a custom `helperPath` are rejected. The model-facing `getCapabilities.platform` names remain unchanged.

The exported `CuaBackend` no longer accepts `description`. The shared executor owns the operation tool description; providers still supply platform instructions through `guidance`.

The object API now reads initial AX state silently in `getApp` and `getWindow`. Selecting an application or window no longer automatically prints its AX tree.

## Migration

1. If using the bundled native helper, upgrade the CUA packages together. No profile edit is needed.
2. If setting `helperPath`, rebuild that helper against the current protocol. Add `platform: "darwin"` to macOS permission responses, or implement the Windows response fields in [`CuaSystemPermissionState`](../../../../packages/experimental/cua/src/access-types.ts).
3. In custom provider integrations, remove `description` from the object passed to `installCua`. Pass the provider’s `capabilities`, `guidance`, and `permissionParameters` to the shared executor.
4. If a script relies on selection to print the AX tree, explicitly call `await app.getAccessibilityTree()` or `await window.getAccessibilityTree()` afterward. Selection still initializes element IDs.
5. Restart the provider and open Computer Use details. Confirm that status queries succeed and show the platform's access controls; rebuild custom TypeScript consumers to check the updated interface.
