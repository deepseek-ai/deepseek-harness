---
kind: upgrade-guide
description: "Custom native CUA helpers must tag permission responses with their platform, and provider integrations must remove CuaBackend.description."
---

# Native CUA platform interfaces

English | [中文](guide.zh.md)

## Change

Native CUA `permissionStatus` and `requestPermission` responses require a `platform` discriminator. macOS responses use `darwin` and retain their permission and process fields. Windows responses use `win32` with `sessionLocked`, `captureAvailable`, `elevated` and `helper`. Untagged responses from a custom `helperPath` are rejected. The model-facing `getCapabilities.platform` names remain unchanged.

The exported `CuaBackend` no longer accepts `description`. The shared executor owns the operation tool description; providers still supply platform instructions through `guidance`.

## Migration

1. If using the bundled native helper, upgrade the CUA packages together. No profile edit is needed.
2. If setting `helperPath`, rebuild that helper against the current protocol. Add `platform: "darwin"` to macOS permission responses, or implement the Windows response fields in [`CuaSystemPermissionState`](../../../../packages/experimental/cua/src/access-types.ts).
3. In custom provider integrations, remove `description` from the object passed to `installCua`. Keep platform instructions in `guidance`.
4. Restart the provider and open Computer Use details. Confirm that status queries succeed and show the platform's access controls; rebuild custom TypeScript consumers to check the updated interface.
