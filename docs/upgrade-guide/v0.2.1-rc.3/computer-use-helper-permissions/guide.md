---
kind: upgrade-guide
description: "Computer Use needs permission for its own helper application instead of the terminal that launches DSH."
---

# Authorize the Computer Use helper

English | [中文](guide.zh.md)

## Change

macOS Computer Use runs as `DSH Computer Use.app`, launched through LaunchServices. Accessibility and Screen Recording grants for a terminal or Desktop launcher do not grant access to this helper. Source preparation builds and signs the application; installed packages require the prepared application and its `current.json` receipt. A custom `helperPath` pointing at a bare native binary is no longer a supported native launch path.

## Migration

1. Computer Use now installs on demand. In **Plugins → Add plugin**, install `@deepseek-ai/dsh-cua-bundle` and enable it; profiles that previously selected the shipped copy need this installation. Restart DSH if requested. In the Computer Use plugin page, grant Accessibility and Screen Recording access to `DSH Computer Use.app` when macOS requests it.
2. Remove an obsolete `helperPath` override or `DSH_CUA_HELPER` value to use automatic preparation. For a custom build, point it to the executable at `DSH Computer Use.app/Contents/MacOS/dsh-cua-native` inside the complete application bundle.
3. Confirm that the permission page identifies `DSH Computer Use.app` and both permissions are allowed before resuming native application tasks. Target-application consent remains required.
4. If a terminal or Desktop launcher was granted these permissions only for Computer Use, revoke those obsolete grants in System Settings. Authorizing the helper does not revoke other applications’ existing permissions; programs the model runs still follow their launcher’s system permissions and the DSH sandbox policy.

Source builds use ad-hoc signing and may need authorization again after code changes. Release packagers must preserve a stable Developer ID signing identity and notarize their distribution. See the [native build instructions](../../../../packages/experimental/cua-macos/native/README.md#build-and-service).
